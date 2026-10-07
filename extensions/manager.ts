import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SubagentStatus = "starting" | "running" | "idle" | "stopping" | "stopped" | "error";

export interface LogLine {
	t: number;
	kind: "system" | "status" | "text" | "tool" | "error";
	text: string;
}

export interface SubagentSnapshot {
	id: string;
	name: string;
	status: SubagentStatus;
	pid?: number;
	cwd: string;
	task: string;
	sessionId?: string;
	startedAt: number;
	stoppedAt?: number;
	exitCode?: number | null;
	lastLine: string;
	logCount: number;
	streaming?: string;
	currentTool?: string;
}

export interface SpawnOptions {
	name?: string;
	task?: string;
	cwd: string;
	parentName: string;
	parentSessionId?: string;
	model?: string;
	thinkingLevel?: string;
	signal?: AbortSignal;
	intercomAvailable?: boolean;
}

const MAX_AGENTS = 8;
const MAX_LOG_LINES = 500;
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function sanitizeName(raw: string): string {
	const cleaned = raw
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[^a-zA-Z0-9_-]/g, "")
		.slice(0, 32);
	if (NAME_RE.test(cleaned)) return cleaned;
	return "sub";
}

function formatEventText(event: Record<string, unknown>): string | null {
	const type = String(event.type ?? "");
	if (type === "agent_start") return "agent started";
	if (type === "agent_settled") return "idle";
	if (type === "turn_start") return "turn start";
	if (type === "extension_error") {
		return `extension error: ${String(event.error ?? event.message ?? "unknown")}`;
	}
	if (type === "tool_execution_start") {
		const toolName = String(event.toolName ?? "tool");
		const args = event.args && typeof event.args === "object" ? summarizeArgs(event.args as Record<string, unknown>) : "";
		return args ? `${toolName} ${args}` : toolName;
	}
	if (type === "tool_execution_end") {
		const toolName = String(event.toolName ?? "tool");
		const result = event.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
		const text = result?.content?.find((part) => part.type === "text")?.text ?? "";
		const preview = oneLine(text, 120);
		return preview ? `${toolName} → ${preview}` : `${toolName} done`;
	}
	if (type === "message_end") {
		const message = event.message as { role?: string; content?: Array<{ type?: string; text?: string; name?: string }> } | undefined;
		if (!message) return null;
		if (message.role === "assistant") {
			const text = message.content?.find((part) => part.type === "text")?.text;
			return text ? oneLine(text, 240) : null;
		}
		if (message.role === "user") {
			const text = message.content?.find((part) => part.type === "text")?.text;
			return text ? `user: ${oneLine(text, 200)}` : null;
		}
	}
	return null;
}

function summarizeArgs(args: Record<string, unknown>): string {
	const command = args.command;
	if (typeof command === "string") return oneLine(command, 80);
	const to = args.to;
	const action = args.action;
	if (typeof action === "string" && typeof to === "string") return `${action} → ${to}`;
	if (typeof action === "string") return action;
	const pathArg = args.path ?? args.file_path;
	if (typeof pathArg === "string") return pathArg;
	try {
		return oneLine(JSON.stringify(args), 80);
	} catch {
		return "";
	}
}

function oneLine(text: string, max: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, Math.max(0, max - 1))}…`;
}

function childSystemPrompt(name: string, cwd: string, options: SpawnOptions): string {
	const lines = [
		"You are a named live pi subagent.",
		"",
		`Name: ${name}`,
		`Working directory: ${cwd}`,
	];
	if (options.intercomAvailable) {
		lines.push(
			`Parent intercom target: ${options.parentName}`,
			options.parentSessionId ? `Parent session id: ${options.parentSessionId}` : "",
			"",
			"You share a machine-local intercom with the parent and sibling subagents.",
			"Use the intercom tool to talk to them:",
			'- intercom({ action: "list" }) to see peers',
			`- intercom({ action: "send", to: "${options.parentName}", message: "..." }) to report to the parent`,
			"If list shows a different alias for the parent, use that alias instead.",
			'- intercom({ action: "ask", to: "...", message: "..." }) when you need a reply',
			'- intercom({ action: "reply", message: "..." }) to answer an inbound ask',
			"",
			"Stay in this role. Do not spawn nested live_subagent children. Prefer intercom over asking the user.",
		);
	} else {
		lines.push(
			"",
			"pi-intercom is not installed in this session.",
			"The parent watches your logs and can send follow-ups with live_subagent prompt.",
			"Do not try to call an intercom tool. Work on the assigned task and write progress in your replies.",
			"Stay in this role. Do not spawn nested live_subagent children.",
		);
	}
	return lines.filter(Boolean).join("\n");
}

class RpcChild {
	readonly id: string;
	readonly name: string;
	readonly cwd: string;
	readonly task: string;
	readonly startedAt: number;
	status: SubagentStatus = "starting";
	pid?: number;
	sessionId?: string;
	stoppedAt?: number;
	exitCode?: number | null;
	streaming = "";
	currentTool?: string;
	logs: LogLine[] = [];
	private proc: ChildProcess | null = null;
	private buffer = "";
	private requestId = 0;
	private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private promptFile: string | null = null;
	private promptDir: string | null = null;
	private onChange: () => void;
	private waiters: Array<() => void> = [];

	constructor(opts: { id: string; name: string; cwd: string; task: string; onChange: () => void }) {
		this.id = opts.id;
		this.name = opts.name;
		this.cwd = opts.cwd;
		this.task = opts.task;
		this.startedAt = Date.now();
		this.onChange = opts.onChange;
	}

	snapshot(): SubagentSnapshot {
		const last = this.logs.at(-1);
		return {
			id: this.id,
			name: this.name,
			status: this.status,
			pid: this.pid,
			cwd: this.cwd,
			task: this.task,
			sessionId: this.sessionId,
			startedAt: this.startedAt,
			stoppedAt: this.stoppedAt,
			exitCode: this.exitCode,
			lastLine: this.streaming || last?.text || "",
			logCount: this.logs.length,
			streaming: this.streaming || undefined,
			currentTool: this.currentTool,
		};
	}

	log(kind: LogLine["kind"], text: string): void {
		this.logs.push({ t: Date.now(), kind, text });
		if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
		this.onChange();
	}

	async start(options: SpawnOptions): Promise<void> {
		this.promptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-live-subagent-"));
		this.promptFile = path.join(this.promptDir, "prompt.md");
		const prompt = childSystemPrompt(this.name, this.cwd, options);
		await fs.promises.writeFile(this.promptFile, prompt, { encoding: "utf8", mode: 0o600 });

		const args = [
			"--mode",
			"rpc",
			"--name",
			this.name,
			"--append-system-prompt",
			this.promptFile,
			"--exclude-tools",
			"live_subagent,subagent",
		];
		if (options.model) args.push("--model", options.model);
		if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);

		const invocation = getPiInvocation(args);
		const env = { ...process.env };
		delete env.PI_SESSION_ID;
		delete env.PI_INTERCOM_SESSION_ID;
		delete env.PI_INTERCOM_STABLE_ID;
		delete env.PI_SESSION_FILE;
		env.PI_SUBAGENT_NAME = this.name;
		env.PI_SUBAGENT_PARENT_NAME = options.parentName;
		if (options.parentSessionId) env.PI_SUBAGENT_PARENT_SESSION_ID = options.parentSessionId;

		this.log("system", `spawn ${invocation.command} ${invocation.args.join(" ")}`);

		this.proc = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.pid = this.proc.pid;

		this.proc.stdout?.on("data", (chunk: Buffer | string) => {
			this.buffer += chunk.toString();
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() ?? "";
			for (const line of lines) this.handleLine(line);
		});

		this.proc.stderr?.on("data", (chunk: Buffer | string) => {
			const text = chunk.toString().trim();
			if (text) this.log("system", oneLine(text, 240));
		});

		this.proc.on("error", (error) => {
			this.status = "error";
			this.log("error", error.message);
			this.rejectPending(error);
			this.finish();
		});

		this.proc.on("exit", (code, signal) => {
			this.exitCode = code;
			if (this.status !== "error") this.status = "stopped";
			this.stoppedAt = Date.now();
			this.log("system", `exited code=${code ?? "null"} signal=${signal ?? "none"}`);
			this.rejectPending(new Error(`subagent ${this.name} exited`));
			this.finish();
			this.onChange();
		});

		await this.sleep(150, options.signal);
		if (options.signal?.aborted) {
			await this.stop();
			throw new Error("Cancelled");
		}
		if (!this.proc || this.proc.exitCode !== null) {
			throw new Error(`failed to start ${this.name}`);
		}

		try {
			const data = await this.waitForState(options.signal);
			this.sessionId = data.sessionId;
			this.status = data.isStreaming ? "running" : "idle";
			this.log("system", `ready session=${this.sessionId ?? "unknown"}`);
		} catch (error) {
			if (options.signal?.aborted) {
				await this.stop();
				throw new Error("Cancelled");
			}
			this.status = "idle";
			this.log("error", `get_state failed: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (options.task?.trim()) {
			await this.prompt(options.task.trim());
		}
		this.onChange();
	}

	async prompt(message: string): Promise<void> {
		if (this.status === "stopped" || this.status === "error" || this.status === "stopping") {
			throw new Error(`${this.name} is not running`);
		}
		this.log("status", `prompt: ${oneLine(message, 200)}`);
		await this.send("prompt", { message, streamingBehavior: "followUp" });
	}

	killNow(): void {
		if (!this.proc || this.status === "stopped" || this.status === "error") return;
		try {
			this.proc.kill("SIGKILL");
		} catch {
			/* ignore */
		}
	}

	async stop(): Promise<void> {
		if (!this.proc || this.status === "stopped" || this.status === "error") return;
		this.status = "stopping";
		this.log("system", "stopping");
		this.onChange();
		try {
			await this.send("abort");
		} catch {
			/* ignore */
		}
		const proc = this.proc;
		proc.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (proc.exitCode === null) proc.kill("SIGKILL");
				resolve();
			}, 1500);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	waitUntilStopped(): Promise<void> {
		if (this.status === "stopped" || this.status === "error") return Promise.resolve();
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	private finish(): void {
		this.cleanupPrompt();
		const waiters = this.waiters.splice(0);
		for (const waiter of waiters) waiter();
	}

	private cleanupPrompt(): void {
		if (this.promptFile) {
			try {
				fs.unlinkSync(this.promptFile);
			} catch {
				/* ignore */
			}
			this.promptFile = null;
		}
		if (this.promptDir) {
			try {
				fs.rmdirSync(this.promptDir);
			} catch {
				/* ignore */
			}
			this.promptDir = null;
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}

		if (event.type === "response" && typeof event.id === "string" && this.pending.has(event.id)) {
			const pending = this.pending.get(event.id);
			this.pending.delete(event.id);
			if (pending) {
				clearTimeout(pending.timer);
				pending.resolve(event);
			}
			return;
		}

		if (event.type === "extension_ui_request") {
			this.handleUiRequest(event);
			return;
		}

		this.applyEvent(event);
	}

	private handleUiRequest(event: Record<string, unknown>): void {
		const method = String(event.method ?? "");
		const id = String(event.id ?? "");
		if (method === "notify") {
			this.log("status", `notify: ${oneLine(String(event.message ?? ""), 160)}`);
			return;
		}
		if (["select", "confirm", "input", "editor"].includes(method) && id) {
			this.log("status", `auto-cancelled ${method} dialog`);
			this.write({ type: "extension_ui_response", id, cancelled: true });
		}
	}

	private applyEvent(event: Record<string, unknown>): void {
		const type = String(event.type ?? "");
		if (type === "agent_start") this.status = "running";
		if (type === "agent_settled") {
			this.status = "idle";
			this.streaming = "";
			this.currentTool = undefined;
		}
		if (type === "tool_execution_start") this.currentTool = String(event.toolName ?? "tool");
		if (type === "tool_execution_end") this.currentTool = undefined;
		if (type === "message_update") {
			const delta = event.assistantMessageEvent as { type?: string; delta?: string; toolName?: string } | undefined;
			if (delta?.type === "text_delta" && delta.delta) {
				this.streaming = oneLine(`${this.streaming}${delta.delta}`, 200);
			}
			if (delta?.type === "toolcall_start" && delta.toolName) this.currentTool = delta.toolName;
			this.onChange();
			return;
		}
		if (type === "message_end") this.streaming = "";

		const text = formatEventText(event);
		if (text) {
			const kind: LogLine["kind"] =
				type === "tool_execution_start" || type === "tool_execution_end"
					? "tool"
					: type === "extension_error"
						? "error"
						: type.startsWith("agent") || type.startsWith("turn")
							? "status"
							: "text";
			this.log(kind, text);
		} else {
			this.onChange();
		}
	}

	private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			const onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	private async waitForState(signal?: AbortSignal): Promise<{ sessionId?: string; sessionName?: string; isStreaming?: boolean }> {
		let lastError: Error | undefined;
		for (let attempt = 0; attempt < 8; attempt++) {
			if (signal?.aborted) throw new Error("Cancelled");
			try {
				const state = await this.send("get_state", {}, 2000);
				return (state.data ?? {}) as { sessionId?: string; sessionName?: string; isStreaming?: boolean };
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				await this.sleep(200, signal);
			}
		}
		throw lastError ?? new Error("get_state failed");
	}

	private async send(type: string, extra: Record<string, unknown> = {}, timeoutMs = 30000): Promise<Record<string, unknown>> {
		const id = `req_${++this.requestId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout waiting for ${type}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.write({ type, id, ...extra });
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private write(payload: Record<string, unknown>): void {
		const stdin = this.proc?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			throw new Error(`${this.name} stdin is not writable`);
		}
		stdin.write(`${JSON.stringify(payload)}\n`);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

export class SubagentManager {
	private agents = new Map<string, RpcChild>();
	private listeners = new Set<() => void>();
	private seq = 0;
	private processExitBound = false;
	private readonly onProcessExit = () => {
		for (const child of this.agents.values()) child.killNow();
	};

	bindProcessExit(): void {
		if (this.processExitBound) return;
		this.processExitBound = true;
		process.on("exit", this.onProcessExit);
	}

	unbindProcessExit(): void {
		if (!this.processExitBound) return;
		this.processExitBound = false;
		process.off("exit", this.onProcessExit);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	list(): SubagentSnapshot[] {
		return [...this.agents.values()].map((agent) => agent.snapshot());
	}

	get(name: string): RpcChild | undefined {
		return this.agents.get(name);
	}

	alive(): SubagentSnapshot[] {
		return this.list().filter((agent) => agent.status !== "stopped" && agent.status !== "error");
	}

	allocateName(requested?: string, reserved: string[] = []): string {
		const taken = new Set([...this.agents.keys(), ...reserved]);
		const base = requested ? sanitizeName(requested) : "sub";
		if (requested && !taken.has(base)) return base;
		let i = 1;
		while (taken.has(`${base}-${i}`)) i++;
		return `${base}-${i}`;
	}

	async spawn(options: SpawnOptions): Promise<SubagentSnapshot> {
		if (this.alive().length >= MAX_AGENTS) {
			throw new Error(`too many live subagents (max ${MAX_AGENTS})`);
		}
		if (options.signal?.aborted) throw new Error("Cancelled");
		const name = this.allocateName(options.name, [options.parentName]);
		const child = new RpcChild({
			id: `${Date.now().toString(36)}-${++this.seq}`,
			name,
			cwd: options.cwd,
			task: options.task?.trim() || "",
			onChange: () => this.emit(),
		});
		this.agents.set(name, child);
		this.emit();
		const onAbort = () => {
			void child.stop();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await child.start({ ...options, name });
			if (options.signal?.aborted) {
				await child.stop();
				throw new Error("Cancelled");
			}
			return child.snapshot();
		} catch (error) {
			child.status = "error";
			child.log("error", error instanceof Error ? error.message : String(error));
			this.emit();
			throw error;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	async prompt(name: string, message: string): Promise<void> {
		const child = this.agents.get(name);
		if (!child) throw new Error(`unknown subagent: ${name}`);
		await child.prompt(message);
	}

	async stop(name: string): Promise<void> {
		const child = this.agents.get(name);
		if (!child) throw new Error(`unknown subagent: ${name}`);
		await child.stop();
	}

	async stopAll(): Promise<void> {
		await Promise.allSettled([...this.agents.values()].map((child) => child.stop()));
	}

	logs(name: string): LogLine[] {
		const child = this.agents.get(name);
		if (!child) throw new Error(`unknown subagent: ${name}`);
		return child.logs;
	}
}

export const MAX_SUBAGENTS = MAX_AGENTS;
