---
name: pi-live-subagents
description: Spawn named live child pi agents the parent can watch. Use for parallel play or peer sessions that talk over intercom. Not the nicobailon pi-subagents orchestrator.
---

# Live Subagents

Use the `live_subagent` tool to spawn named child `pi` processes. They stay alive after spawn. The parent can list them, send follow-up prompts, read logs, and stop them. Humans can open `/live-subagents` or press Alt+Shift+S for an overview; Enter opens one child's logs.

This is not `npm:pi-subagents`. Do not use `live_subagent` for scout/worker/reviewer workflows.

Children talk with the existing `intercom` tool. After spawning, tell them to `intercom({ action: "list" })` and send/ask/reply to the parent or siblings by name.

## Spawn

```ts
live_subagent({
  action: "spawn",
  name: "berry",
  task: "Do this job. Report progress to parent over intercom."
})
```

If `name` is omitted, children are named `sub-1`, `sub-2`, ...

## Coordinate

```ts
intercom({ action: "send", to: "berry", message: "Keep going. Ping parent every few steps." })
live_subagent({ action: "list" })
live_subagent({ action: "logs", name: "berry" })
live_subagent({ action: "prompt", name: "berry", task: "Stop and summarize." })
live_subagent({ action: "stop", name: "berry" })
```

Do not spawn nested live subagents from a child. Prefer intercom over asking the user.
