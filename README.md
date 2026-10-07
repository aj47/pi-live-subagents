# pi-live-subagents

Spawn named child pi sessions the parent can watch.

Children stay alive after spawn, stream into a parent overview UI, and talk to each other through the existing [pi-intercom](https://github.com/nicobailon/pi-intercom) tool.

This is **not** [`npm:pi-subagents`](https://www.npmjs.com/package/pi-subagents) (nicobailon). That package is a delegation orchestrator. This one is a small live-session manager.

## How this is different from `npm:pi-subagents`

| | this package | nicobailon/`pi-subagents` |
| --- | --- | --- |
| Job | Keep a handful of named peers alive so you can watch them play, talk, or work in parallel | Delegate a task, get a result back (scout / worker / reviewer / oracle) |
| Lifetime | Children stay running until you stop them or the parent session ends | Foreground runs finish and return; background runs are jobs with status/artifacts |
| Communication | Existing `intercom` send/ask/reply between parent and siblings | Native `contact_supervisor` / result delivery; intercom is optional bridge plumbing |
| UI | `/live-subagents` overlay: overview + per-child logs | Fleet view, live cards, missions, doctor, workflows |
| Tools / commands | `live_subagent`, `/live-subagents`, `Alt+Shift+S` | `subagent`, `/subagents`, `/subagents-fleet`, prompt workflows |
| Agents | None. You pass a name and a task | Builtin scout, worker, reviewer, oracle, delegate, … |
| Scope | Max 8 live RPC children in the parent process | Worktrees, acceptance gates, depth limits, scheduled missions |

Use this when you want **long-lived named peers** (for example three agents playing a game, or two sessions pairing over intercom).

Use `npm:pi-subagents` when you want **delegation**: “run a reviewer on this diff”, “scout then implement”, review loops, worktrees.

The two packages can coexist because the tool and command names are different. Do not install this as `pi-subagents`.

## Install

```sh
pi install git:github.com/aj47/pi-live-subagents
```

Then restart pi or run `/reload`.

Children talk over intercom. Install that too if you do not already have it:

```sh
pi install npm:pi-intercom
```

Optional: `/name parent` in the parent session so children have a stable intercom target. If you skip that, they `list` and address the parent by session id.

## What you get

- `live_subagent` tool: spawn, list, prompt, stop, logs
- `/live-subagents` command and `Alt+Shift+S` for the overview overlay
- Enter / `l` opens an individual child's live logs
- Footer widget shows live child names and status
- Children start as `pi --mode rpc --name <name>` so they show up on intercom
- Nested `live_subagent` / `subagent` is disabled on children

## Tool

```ts
live_subagent({ action: "spawn", name: "berry", task: "Join prod and harvest berries." })
live_subagent({ action: "list" })
live_subagent({ action: "prompt", name: "berry", task: "Keep harvesting." })
live_subagent({ action: "logs", name: "berry", count: 40 })
live_subagent({ action: "stop", name: "berry" })
```

## UI

| Key | Action |
| --- | --- |
| `Alt+Shift+S` or `/live-subagents` | Open overview |
| `↑` `↓` / `j` `k` | Select a child |
| Enter / `l` | Open that child's logs |
| `g` / `G` | Jump to top / end of logs |
| Esc | Back, then close |

`/live-subagents berry` or `/live-subagents logs berry` jumps straight into that log.

## How children talk

After spawn:

```ts
intercom({ action: "list" })
intercom({ action: "send", to: "parent", message: "Joined at (25,25)" })
intercom({ action: "ask", to: "berry", message: "How many harvests?" })
intercom({ action: "reply", message: "3 so far" })
```

## Lifecycle

- Max 8 live children
- Children are session-scoped: parent `session_shutdown` (quit, reload, new, fork) stops them
- Esc during spawn aborts and kills the child
- Child dialogs (`select`, `confirm`, `input`, `editor`) are auto-cancelled so RPC children do not hang waiting for a TUI; `notify` lines show up in that child's log

## Local development

```sh
pi install /absolute/path/to/pi-live-subagents
```

Or copy `extensions/` to `~/.pi/agent/extensions/live-subagents/`.
