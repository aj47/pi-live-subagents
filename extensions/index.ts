import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SubagentManager, type SubagentSnapshot } from "./manager.ts";
import { SubagentPanel, widgetLines } from "./ui.ts";

const SubagentParams = Type.Object({
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

export default function (pi: ExtensionAPI) {
	const manager = new SubagentManager();
	let uiCtx: ExtensionContext | undefined;
	let panelOpen = false;

	const refreshWidget = (ctx?: ExtensionContext) => {
		const target = ctx ?? uiCtx;
		if (!target?.hasUI) return;
		const agents = manager.list();
		target.ui.setWidget("subagents", agents.length ? widgetLines(agents, target.ui.theme) : undefined);
		const live = agents.filter((agent) => agent.status !== "stopped" && agent.status !== "error").length;
		target.ui.setStatus("subagents", live ? `${live} subagent${live === 1 ? "" : "s"}` : undefined);
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
		refreshWidget(ctx);
	});

	pi.on("session_shutdown", async () => {
		await manager.stopAll();
		uiCtx?.ui.setWidget("subagents", undefined);
		uiCtx?.ui.setStatus("subagents", undefined);
		uiCtx = undefined;
	});

	pi.registerShortcut("alt+s", {
		description: "Open subagent overview",
		handler: async (ctx) => {
			await openPanel(ctx);
		},
	});

	pi.registerCommand("subagents", {
		description: "Open the subagent overview, or /subagents logs <name>",
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
		name: "subagent",
		label: "Subagent",
		description:
			"Spawn named child pi agents the parent can watch. Children talk over the existing intercom tool. Actions: spawn, list, prompt, stop, logs.",
		promptSnippet: "Spawn, list, prompt, stop, or read logs for child pi agents",
		promptGuidelines: [
			"Use subagent to spawn named child pi sessions. They stay alive after spawn and talk through the existing intercom tool.",
			'After spawning, tell children to use intercom({ action: "list" }) and send/ask/reply to the parent or siblings by name.',
			"Use /subagents or Alt+S for the overview UI; Enter opens an individual child's logs.",
		],
		parameters: SubagentParams,
		renderCall(args, theme) {
			const label = args.name ? `${args.action} ${args.name}` : args.action;
			return new Text(theme.fg("toolTitle", `subagent ${label}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { spawned?: SubagentSnapshot; agents?: SubagentSnapshot[] } | undefined;
			const spawned = details?.spawned;
			const text = spawned
				? `${spawned.name} ${spawned.status}`
				: (result.content.find((part) => part.type === "text" && "text" in part)?.text ?? "ok");
			return new Text(theme.fg(result.isError ? "error" : "toolOutput", text.split("\n")[0] ?? "ok"), 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				if (!pi.getSessionName()) pi.setSessionName("parent");
				const parentName = pi.getSessionName() || "parent";
				const parentSessionId = ctx.sessionManager.getSessionId();
				const cwd = params.cwd?.trim() || ctx.cwd;

				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Cancelled" }], details: { agents: manager.list() } };
				}

				if (params.action === "list") {
					const agents = manager.list();
					return {
						content: [
							{
								type: "text",
								text: agents.length ? agents.map(formatSnapshot).join("\n") : "No subagents.",
							},
						],
						details: { agents },
					};
				}

				if (params.action === "logs") {
					if (!params.name) {
						return {
							content: [{ type: "text", text: "logs needs name" }],
							details: { agents: manager.list() },
							isError: true,
						};
					}
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
					if (!params.name) {
						return {
							content: [{ type: "text", text: "stop needs name" }],
							details: { agents: manager.list() },
							isError: true,
						};
					}
					await manager.stop(params.name);
					return {
						content: [{ type: "text", text: `Stopped ${params.name}` }],
						details: { agents: manager.list() },
					};
				}

				if (params.action === "prompt") {
					if (!params.name || !params.task?.trim()) {
						return {
							content: [{ type: "text", text: "prompt needs name and task" }],
							details: { agents: manager.list() },
							isError: true,
						};
					}
					await manager.prompt(params.name, params.task.trim());
					return {
						content: [{ type: "text", text: `Prompted ${params.name}` }],
						details: { agents: manager.list() },
					};
				}

				onUpdate?.({ content: [{ type: "text", text: "Spawning subagent..." }], details: { agents: manager.list() } });
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const agent = await manager.spawn({
					name: params.name,
					task: params.task,
					cwd,
					parentName,
					parentSessionId,
					model,
					thinkingLevel: ctx.thinkingLevel,
				});
				refreshWidget(ctx);
				if (ctx.hasUI) ctx.ui.notify(`Spawned ${agent.name}`, "info");
				return {
					content: [
						{
							type: "text",
							text: [
								`Spawned ${agent.name} [${agent.status}]`,
								agent.sessionId ? `session ${agent.sessionId}` : "",
								`Talk over intercom: intercom({ action: "send", to: "${agent.name}", message: "..." })`,
								"Open /subagents or press Alt+S for the overview; Enter a row for that child's logs.",
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					details: { agents: manager.list(), spawned: agent },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: message }],
					details: { agents: manager.list() },
					isError: true,
				};
			}
		},
	});
}
