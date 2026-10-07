# pi-subagents

A basic pi extension that spawns named child pi agents the parent can watch.

Children stay alive after spawn, stream into a parent overview UI, and talk to each other through the existing [pi-intercom](https://github.com/nicobailon/pi-intercom) tool.

## Install

```sh
pi install git:github.com/aj47/pi-subagents
```

Then restart pi or run `/reload`.

Children use intercom to talk. Install that too if you do not already have it:

```sh
pi install npm:pi-intercom
```

## What you get

- `subagent` tool: spawn, list, prompt, stop, logs
- `/subagents` command and `Alt+S` shortcut for the overview overlay
- Enter / `l` opens an individual child's live logs
- Footer widget shows live child names and status
- Children are started as `pi --mode rpc --name <name>` so they show up on intercom

## Tool

```ts
subagent({ action: "spawn", name: "berry", task: "Join prod and harvest berries." })
subagent({ action: "list" })
subagent({ action: "prompt", name: "berry", task: "Keep harvesting." })
subagent({ action: "logs", name: "berry", count: 40 })
subagent({ action: "stop", name: "berry" })
```

If the parent session has no `/name`, the first spawn names it `parent` so children can address it.

## UI

| Key | Action |
| --- | --- |
| `Alt+S` or `/subagents` | Open overview |
| `↑` `↓` / `j` `k` | Select a child |
| Enter / `l` | Open that child's logs |
| `g` / `G` | Jump to top / end of logs |
| Esc | Back, then close |

`/subagents berry` or `/subagents logs berry` jumps straight into that log.

## How children talk

After spawn, children can:

```ts
intercom({ action: "list" })
intercom({ action: "send", to: "parent", message: "Joined at (25,25)" })
intercom({ action: "ask", to: "berry", message: "How many harvests?" })
intercom({ action: "reply", message: "3 so far" })
```

Nested `subagent` is disabled on children (`--exclude-tools subagent`).

## Notes

- Max 8 live children
- Parent shutdown / process exit stops remaining children
- Child dialogs (`select`, `confirm`, `input`, `editor`) are auto-cancelled so RPC children do not hang waiting for a TUI
- This is a small first version: spawn, visibility, logs, intercom. No planner/worker chain, no supervisor bridge.

## Local development

The live copy used while building this lived in `~/.pi/agent/extensions/subagents/`. After cloning this repo you can either install it with `pi install /absolute/path/to/pi-subagents` or keep using the global extension directory.
