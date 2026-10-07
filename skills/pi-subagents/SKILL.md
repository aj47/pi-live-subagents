---
name: pi-subagents
description: Spawn named child pi agents the parent can watch. Use for parallel play, research, or worker sessions that talk over intercom.
---

# Pi Subagents

Use the `subagent` tool to spawn named child `pi` processes. They stay alive after spawn. The parent can list them, send follow-up prompts, read logs, and stop them. Humans can open `/subagents` or press Alt+S for an overview; Enter opens one child's logs.

Children talk with the existing `intercom` tool. After spawning, tell them to `intercom({ action: "list" })` and send/ask/reply to the parent or siblings by name.

## Spawn

```ts
subagent({
  action: "spawn",
  name: "berry",
  task: "Do this job. Report progress to parent over intercom."
})
```

If `name` is omitted, children are named `sub-1`, `sub-2`, ...

## Coordinate

```ts
intercom({ action: "send", to: "berry", message: "Keep going. Ping parent every few steps." })
subagent({ action: "list" })
subagent({ action: "logs", name: "berry" })
subagent({ action: "prompt", name: "berry", task: "Stop and summarize." })
subagent({ action: "stop", name: "berry" })
```

Do not spawn nested subagents from a child. Prefer intercom over asking the user.
