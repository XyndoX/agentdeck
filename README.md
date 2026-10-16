<p align="center">
  <img src="assets/logo.svg" width="140" alt="agentdeck logo: three connected agent nodes in a rounded frame">
</p>

<h1 align="center">agentdeck</h1>

<p align="center">
  <em>Watch your Claude agents work together, live, in a side pane.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Claude%20Code-mod-a882ff?style=flat-square" alt="Claude Code mod">
  <img src="https://img.shields.io/badge/dependencies-0-a9c6cc?style=flat-square" alt="Zero dependencies">
  <img src="https://img.shields.io/github/license/XyndoX/agentdeck?style=flat-square&color=3ee6b4" alt="MIT license">
</p>

---

agentdeck is a Claude Code mod: a side pane, like [repograph](https://github.com/XyndoX/repograph), that shows how your agents work together. The main agent and its subagents are painted as a live graph. Packets run along the links of the agents that are working, each node is colored by the work it is doing right now, and the ring around it shows what kind of work it has done. Next to the graph you get the agents as rows, a live tool feed, every Claude Code session running on the machine, and your routines.

## Tabs

| Tab | Shows |
|---|---|
| **Agents** (`1`) | The agent graph (pixels, with terminal-text labels), a detail line for the selected agent, one row per agent with its current tool call and how long it has run, and the live feed of tool calls. |
| **Sessions** (`2`) | Every live Claude Code session (interactive and `--bg`): busy or idle, working/total agents, current tool, and a 10-minute sparkline colored by kind of work. Enter (or two clicks) shows that session's agents. |
| **Routines** (`3`) | Claude cloud routines (`r` loads them through RemoteTrigger), this session's loops and crons, background jobs, scheduled tasks, and your own launchd jobs with schedule and last exit code. |

Colors by kind of work: search · crawl (WebFetch, browser navigation) · edit · read · build · test · git · shell · computer use (clicks, screenshots, simulators) · agents · mcp.

## Install

```text
claude plugin marketplace add XyndoX/agentdeck
claude plugin install agentdeck@agentdeck --scope user
```

Then, in a session:

```
/tui fullscreen
/agentdeck            # or /agentdeck sessions, /agentdeck routines
```

Click the pane to give it the keys: `1` `2` `3` tabs, `↑↓` select an agent or session, `enter` open a session, `esc` back to this session, `r` reload routines. Click a node in the graph to select an agent.

### Requirements

- Claude Code ≥ 2.1.287 (mods), with `/tui fullscreen`
- A terminal with the kitty graphics protocol for the graph (Ghostty, kitty, WezTerm, cmux). Elsewhere you still get the labels, rows and the other tabs.
- Node ≥ 22 on `PATH` (for the collector)

## How it works

- `collector/feed.mjs` is a small node process that the mod starts while the pane is open. It reads only what Claude Code already writes: `~/.claude/sessions` (live sessions), the session transcripts and their `subagents/` transcripts (incrementally, from the last 4 MiB), `~/.claude/jobs`, `~/.claude/scheduled-tasks`, and `~/Library/LaunchAgents` + `launchctl`. It prints one JSON snapshot per second when something changed. A subagent is linked to the agent whose Agent call started it.
- `hooks/flow.ts` lays out and paints the graph into RGBA pixels (the painter is repograph's), which goes to the terminal as an `Image`. `hooks/deck.ts` turns the snapshot into colored text rows.
- Loops come from `CronList`. Cloud routines come from `RemoteTrigger`, and only when you press `r`, so you get no permission prompt you didn't ask for. Nothing leaves your machine.

## Develop

```text
claude --plugin-dir .
claude plugin validate .
claude plugin test .                    # layout, rows, the pane end to end
node --test tests/collect.test.mjs      # the collector
node collector/feed.mjs <session-id>    # the raw feed
```

## License

MIT
