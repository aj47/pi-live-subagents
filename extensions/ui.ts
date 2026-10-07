import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { LogLine, SubagentManager, SubagentSnapshot, SubagentStatus } from "./manager.ts";

type View = { kind: "overview" } | { kind: "logs"; name: string; offset: number };

function statusColor(theme: Theme, status: SubagentStatus): (text: string) => string {
	if (status === "running" || status === "starting") return (text) => theme.fg("accent", text);
	if (status === "idle") return (text) => theme.fg("success", text);
	if (status === "error") return (text) => theme.fg("error", text);
	if (status === "stopping") return (text) => theme.fg("warning", text);
	return (text) => theme.fg("dim", text);
}

function logColor(theme: Theme, kind: LogLine["kind"]): (text: string) => string {
	if (kind === "error") return (text) => theme.fg("error", text);
	if (kind === "tool") return (text) => theme.fg("toolTitle", text);
	if (kind === "status" || kind === "system") return (text) => theme.fg("muted", text);
	return (text) => theme.fg("text", text);
}

function clock(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function pad(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return truncateToWidth(text, width);
	return text + " ".repeat(width - vis);
}

export class SubagentPanel {
	private manager: SubagentManager;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private tui: TUI;
	private done: () => void;
	private view: View = { kind: "overview" };
	private selected = 0;
	private unsubscribe: () => void;

	constructor(opts: {
		manager: SubagentManager;
		theme: Theme;
		keybindings: KeybindingsManager;
		tui: TUI;
		done: () => void;
		initialName?: string;
	}) {
		this.manager = opts.manager;
		this.theme = opts.theme;
		this.keybindings = opts.keybindings;
		this.tui = opts.tui;
		this.done = opts.done;
		if (opts.initialName && this.manager.get(opts.initialName)) {
			this.view = { kind: "logs", name: opts.initialName, offset: 0 };
		}
		this.unsubscribe = this.manager.subscribe(() => this.tui.requestRender());
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
			if (this.view.kind === "logs") {
				this.view = { kind: "overview" };
				this.tui.requestRender();
				return;
			}
			this.done();
			return;
		}

		if (this.view.kind === "overview") {
			const agents = this.manager.list();
			if (agents.length === 0) return;
			if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "up") || matchesKey(data, "k")) {
				this.selected = (this.selected + agents.length - 1) % agents.length;
				this.tui.requestRender();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "down") || matchesKey(data, "j")) {
				this.selected = (this.selected + 1) % agents.length;
				this.tui.requestRender();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "return") || matchesKey(data, "l")) {
				const agent = agents[this.selected];
				if (agent) this.view = { kind: "logs", name: agent.name, offset: 0 };
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.view.offset += 1;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.view.offset = Math.max(0, this.view.offset - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "g")) {
			const logs = this.manager.logs(this.view.name);
			this.view.offset = Math.max(0, logs.length - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "G") || matchesKey(data, "shift+g")) {
			this.view.offset = 0;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		return this.view.kind === "overview" ? this.renderOverview(width) : this.renderLogs(width);
	}

	private box(width: number, title: string, body: string[], footer: string): string[] {
		const inner = Math.max(20, Math.min(width, 100) - 2);
		const border = (text: string) => this.theme.fg("accent", text);
		const row = (content: string) => {
			const clipped = pad(content, inner);
			return `${border("│")}${clipped}${border("│")}`;
		};
		const lines = [
			border(`╭${"─".repeat(inner)}╮`),
			row(` ${this.theme.bold(title)}`),
			border(`├${"─".repeat(inner)}┤`),
			...body.map(row),
			border(`├${"─".repeat(inner)}┤`),
			row(` ${this.theme.fg("dim", footer)}`),
			border(`╰${"─".repeat(inner)}╯`),
		];
		return lines;
	}

	private renderOverview(width: number): string[] {
		const agents = this.manager.list();
		if (this.selected >= agents.length) this.selected = Math.max(0, agents.length - 1);
		const body: string[] = [];
		if (agents.length === 0) {
			body.push(` ${this.theme.fg("dim", "No subagents yet. Ask the parent to spawn some.")}`);
		} else {
			for (let i = 0; i < agents.length; i++) {
				const agent = agents[i]!;
				const selected = i === this.selected;
				const color = statusColor(this.theme, agent.status);
				const marker = selected ? this.theme.fg("accent", "▶") : " ";
				const name = selected ? this.theme.bold(pad(agent.name, 16)) : pad(agent.name, 16);
				const status = color(pad(agent.status, 8));
				const preview = this.theme.fg("dim", oneLineLocal(agent.currentTool ? `${agent.currentTool} · ${agent.lastLine}` : agent.lastLine, 48));
				const line = ` ${marker} ${name} ${status} ${preview}`;
				body.push(selected ? this.theme.bg("selectedBg", pad(line, Math.max(20, Math.min(width, 100) - 2))) : line);
			}
		}
		return this.box(
			width,
			"Live subagents",
			body,
			"↑↓ select  Enter logs  Esc close  · intercom if installed, else prompt/logs",
		);
	}

	private renderLogs(width: number): string[] {
		if (this.view.kind !== "logs") return this.renderOverview(width);
		const agent = this.manager.get(this.view.name)?.snapshot();
		const logs = this.manager.get(this.view.name)?.logs ?? [];
		const inner = Math.max(20, Math.min(width, 100) - 2);
		const headerHeight = 6;
		const maxBody = Math.max(8, Math.min(18, (this.tui.terminal?.rows ?? 24) - headerHeight));
		const maxOffset = Math.max(0, logs.length - maxBody);
		if (this.view.kind === "logs") this.view.offset = Math.min(this.view.offset, maxOffset);
		const offset = this.view.kind === "logs" ? this.view.offset : 0;
		const start = Math.max(0, logs.length - maxBody - offset);
		const slice = logs.slice(start, start + maxBody);
		const status = agent ? statusColor(this.theme, agent.status)(agent.status) : "gone";
		const title = `${this.view.name}  ${status}${agent?.sessionId ? `  ${agent.sessionId.slice(0, 8)}` : ""}`;
		const body =
			slice.length === 0
				? [` ${this.theme.fg("dim", "No log lines yet.")}`]
				: slice.map((line) => {
						const color = logColor(this.theme, line.kind);
						return ` ${this.theme.fg("dim", clock(line.t))} ${color(truncateToWidth(line.text, inner - 10))}`;
					});
		if (agent?.streaming) {
			body.push(` ${this.theme.fg("accent", "…")} ${this.theme.fg("muted", truncateToWidth(agent.streaming, inner - 4))}`);
		}
		return this.box(width, title, body, "↑↓ scroll  g/G top/end  Esc back");
	}
}

function oneLineLocal(text: string, max: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, Math.max(0, max - 1))}…`;
}

export function widgetLines(agents: SubagentSnapshot[], theme: Theme): string[] {
	if (agents.length === 0) return [];
	const parts = agents.map((agent) => {
		const color = statusColor(theme, agent.status);
		return `${agent.name} ${color(agent.status)}`;
	});
	return [`live subagents  ${parts.join("  ·  ")}`];
}
