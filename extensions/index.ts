import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SubagentManager, type SubagentSnapshot } from "./manager.ts";
import { SubagentPanel, widgetLines } from "./ui.ts";

const LiveSubagentParams = Type.Object({
	action: StringEnum(["spawn", "list", "prompt", "stop", "logs"] as const, {
		description: "spawn a child, list children, send a prompt, stop one, or read logs",
	}),
	name: Type.Optional(Type.String({ description: "Intercom session name for the child (spawn/prompt/stop/logs)" })),
	task: Type.Optional(Type.String({ description: "Initial task for spawn, or follow-up prompt" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for spawn; defaults to the parent cwd" })),
	count: Type.Optional(Type.Number({ description: "How many log lines to return (logs). Default 40." })),
});

function formatSnapshot(agent: SubagentSnapshot): string {
	const bits = [`${agent.name} [${agent.status}]`];
	if (agent.sessionId) bits.push(`id=${agent.sessionId.slice(0, 8)}`);
	if (agent.currentTool) bits.push(`tool=${agent.currentTool}`);
	if (agent.lastLine) bits.push(agent.lastLine);
	return bits.join("  ");
}

function resolveCwd(raw: string | undefined, base: string): string {
	const trimmed = (raw ?? "").trim().replace(/^@/, "");
	if (!trimmed) return base;
	return resolve(base, trimmed);
}

function parentIntercomName(pi: ExtensionAPI, sessionId: string): string {
	const named = pi.getSessionName()?.trim();
	if (named) return named;
	return sessionId;
}

function hasIntercom(pi: ExtensionAPI): boolean {
	return pi.getAllTools().some((tool) => tool.name === "intercom");
}

export default function (pi: ExtensionAPI) {
	const manager = new SubagentManager();
	let uiCtx: ExtensionContext | undefined;
	let panelOpen = false;

	const refreshWidget = (ctx?: ExtensionContext) => {
		const target = ctx ?? uiCtx;
		if (!target?.hasUI) return;
		const agents = manager.list();
		target.ui.setWidget("live-subagents", agents.length ? widgetLines(agents, target.ui.theme) : undefined);
		const live = agents.filter((agent) => agent.status !== "stopped" && agent.status !== "error").length;
		target.ui.setStatus("live-subagents", live ? `${live} live subagent${live === 1 ? "" : "s"}` : undefined);
	};

	const openPanel = async (ctx: ExtensionContext, initialName?: string) => {
		if (!ctx.hasUI || ctx.mode !== "tui" || panelOpen) return;
		panelOpen = true;
		let panel: SubagentPanel | undefined;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => {
					panel = new SubagentPanel({
						manager,
						theme,
						keybindings,
						tui,
						done: () => done(),
						initialName,
					});
					return panel;
				},
				{
					overlay: true,
					overlayOptions: { anchor: "right-center", width: "56%", minWidth: 52, maxHeight: "80%", margin: 1 },
				},
			);
		} finally {
			panel?.dispose();
			panelOpen = false;
		}
	};

	manager.subscribe(() => refreshWidget());

	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		manager.bindProcessExit();
		refreshWidget(ctx);
	});

	pi.on("session_shutdown", async () => {
		manager.unbindProcessExit();
		await manager.stopAll();
		uiCtx?.ui.setWidget("live-subagents", undefined);
		uiCtx?.ui.setStatus("live-subagents", undefined);
		uiCtx = undefined;
	});

	pi.registerShortcut("alt+shift+s", {
		description: "Open live subagent overview",
		handler: async (ctx) => {
			await openPanel(ctx);
		},
	});

	pi.registerCommand("live-subagents", {
		description: "Open the live subagent overview, or /live-subagents logs <name>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "logs" && parts[1]) {
				await openPanel(ctx, parts[1]);
				return;
			}
			if (parts[0] && manager.get(parts[0])) {
				await openPanel(ctx, parts[0]);
				return;
			}
			await openPanel(ctx);
		},
	});

	pi.registerTool({
		name: "live_subagent",
		label: "Live Subagent",
		description:
			"Spawn named child pi agents the parent can watch. Children stay alive. If pi-intercom is installed they talk over intercom; otherwise use prompt/logs. Actions: spawn, list, prompt, stop, logs. Not the nicobailon pi-subagents orchestrator.",
		promptSnippet: "Spawn, list, prompt, stop, or read logs for live child pi agents",
		promptGuidelines: [
			"Use live_subagent to spawn named child pi sessions that stay alive after spawn.",
			"If the intercom tool is available, tell children to intercom({ action: \"list\" }) and send/ask/reply to the parent or siblings by name.",
			"If intercom is missing, coordinate with live_subagent prompt and live_subagent logs. Mention pi install npm:pi-intercom once if sibling chat would help.",
			"Use /live-subagents or Alt+Shift+S for the overview UI; Enter opens an individual child's logs.",
			"Do not use live_subagent for scout/worker/reviewer workflows; that is npm:pi-subagents.",
		],
		parameters: LiveSubagentParams,
		renderCall(args, theme) {
			const label = args.name ? `${args.action} ${args.name}` : args.action;
			return new Text(theme.fg("toolTitle", `live_subagent ${label}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { spawned?: SubagentSnapshot; agents?: SubagentSnapshot[] } | undefined;
			const spawned = details?.spawned;
			const text = spawned
				? `${spawned.name} ${spawned.status}`
				: (result.content.find((part) => part.type === "text" && "text" in part)?.text ?? "ok");
			return new Text(theme.fg("toolOutput", text.split("\n")[0] ?? "ok"), 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId();
			const parentName = parentIntercomName(pi, parentSessionId);
			const cwd = resolveCwd(params.cwd, ctx.cwd);
			const intercomAvailable = hasIntercom(pi);

			if (signal?.aborted) throw new Error("Cancelled");

			if (params.action === "list") {
				const agents = manager.list();
				return {
					content: [
						{
							type: "text",
							text: agents.length ? agents.map(formatSnapshot).join("\n") : "No live subagents.",
						},
					],
					details: { agents },
				};
			}

			if (params.action === "logs") {
				if (!params.name) throw new Error("logs needs name");
				const lines = manager.logs(params.name);
				const count = Math.max(1, Math.min(params.count ?? 40, 200));
				const slice = lines.slice(-count);
				return {
					content: [
						{
							type: "text",
							text: slice.length
								? slice.map((line) => `[${new Date(line.t).toISOString()}] ${line.kind}: ${line.text}`).join("\n")
								: `(no logs for ${params.name})`,
						},
					],
					details: { agents: manager.list(), name: params.name },
				};
			}

			if (params.action === "stop") {
				if (!params.name) throw new Error("stop needs name");
				await manager.stop(params.name);
				return {
					content: [{ type: "text", text: `Stopped ${params.name}` }],
					details: { agents: manager.list() },
				};
			}

			if (params.action === "prompt") {
				if (!params.name || !params.task?.trim()) throw new Error("prompt needs name and task");
				await manager.prompt(params.name, params.task.trim());
				return {
					content: [{ type: "text", text: `Prompted ${params.name}` }],
					details: { agents: manager.list() },
				};
			}

			onUpdate?.({ content: [{ type: "text", text: "Spawning live subagent..." }], details: { agents: manager.list() } });
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const agent = await manager.spawn({
				name: params.name,
				task: params.task,
				cwd,
				parentName,
				parentSessionId,
				model,
				thinkingLevel: ctx.thinkingLevel,
				signal,
				intercomAvailable,
			});
			refreshWidget(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(
					intercomAvailable ? `Spawned ${agent.name}` : `Spawned ${agent.name} (no intercom; use prompt/logs)`,
					intercomAvailable ? "info" : "warning",
				);
			}
			const talk = intercomAvailable
				? [
						`Talk over intercom: intercom({ action: "send", to: "${agent.name}", message: "..." })`,
						pi.getSessionName()
							? `Children can address this session as "${parentName}".`
							: `This session is unnamed. Children should intercom({ action: "list" }) and target the parent by session id ${parentSessionId.slice(0, 8)}.`,
				  ]
				: [
						"pi-intercom is not installed, so children cannot message each other.",
						`Steer this child with live_subagent({ action: "prompt", name: "${agent.name}", task: "..." }) and read live_subagent({ action: "logs", name: "${agent.name}" }).`,
						"For sibling chat, also run: pi install npm:pi-intercom",
				  ];
			return {
				content: [
					{
						type: "text",
						text: [
							`Spawned ${agent.name} [${agent.status}]`,
							agent.sessionId ? `session ${agent.sessionId}` : "",
							...talk,
							"Open /live-subagents or press Alt+Shift+S for the overview; Enter a row for that child's logs.",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { agents: manager.list(), spawned: agent, intercomAvailable },
			};
		},
	});
}
