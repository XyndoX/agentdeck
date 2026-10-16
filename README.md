<p align="center">
  <img src="assets/logo.svg" width="140" alt="agentdeck logo: three connected agent nodes in a rounded frame">
</p>

<h1 align="center">agentdeck</h1>

<p align="center">
  <em>A live AI-agent dashboard, rendered as real pixels in a Claude Code pane.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Claude%20Code-mod-a882ff?style=flat-square" alt="Claude Code mod">
  <img src="https://img.shields.io/badge/npm%20dependencies-0-a9c6cc?style=flat-square" alt="Zero npm dependencies">
  <img src="https://img.shields.io/github/license/XyndoX/agentdeck?style=flat-square&color=3ee6b4" alt="MIT license">
</p>

---

agentdeck is a Claude Code mod. It opens a side pane with a full graphical dashboard of what your agents are doing. You see how the main agent and its subagents work together, which tools they are running right now, every Claude Code session running on the machine, and all your routines. It is drawn as an image in the terminal (kitty graphics protocol), not as ASCII.

## What you see

| Tab | Shows |
|---|---|
| **Session** (`1`) | The agent flow: main agent and subagents as a live tree, each with its model, status, current tool call and work mix. Below it a 5-minute swimlane timeline per agent, a live activity feed, the work mix, and the files touched. |
| **Global** (`2`) | Every live Claude Code session on the machine (interactive and `--bg`): busy or idle, working agents, current tool, and a 10-minute activity sparkline. Click a card to open that session. |
| **Routines** (`3`) | Claude cloud routines (`/schedule`), session loops and crons (`/loop`, CronCreate), background jobs, scheduled tasks, and your own launchd jobs with schedule and last exit code. |

Tool calls are colored by the kind of work they do: **search**, **crawl** (WebFetch, browser navigation), **edit**, **read**, **build**, **test**, **git**, **shell**, **computer** use (clicks, screenshots, simulators), **agents**, and **mcp**.

## Install

```text
claude plugin marketplace add XyndoX/agentdeck
claude plugin install agentdeck@agentdeck --scope user
```

Or from inside Claude Code: `/plugin marketplace add XyndoX/agentdeck`, then `/plugin install agentdeck@agentdeck`. Then:

```
/tui fullscreen
/agentdeck
```

Click the pane to use it. Clicks, the scroll wheel and keys go to the dashboard. Keys: `1` `2` `3` switch tabs, `tab` cycles, `esc` goes back to this session.

### Requirements

- Claude Code ≥ 2.1.287 (mods), with `/tui fullscreen`
- A terminal with the kitty graphics protocol: **Ghostty**, **kitty**, **WezTerm** (not inside tmux)
- **Node ≥ 22** on `PATH`
- **Google Chrome** (or Chromium, Edge, Brave). Set `AGENTDECK_CHROME` to use another binary.

If the picture looks stretched, tune the cell aspect: `/agentdeck aspect 2.2` (height ÷ width of one terminal cell, default 2.1).

## How it works

```
Claude Code session ──(mod: /agentdeck)──▶ pane ◀── PNG frames ──┐
        │ clicks · keys · wheel                                   │
        ▼                                                         │
  agentdeck daemon (node, 127.0.0.1:47821) ── headless Chrome ────┘
        │ reads
        ▼
  ~/.claude/sessions · projects/*/<session>.jsonl · subagents/ · jobs/ · scheduled-tasks/
  ~/Library/LaunchAgents · launchctl
```

- The **daemon** (`daemon/server.mjs`) is started by the first session that opens a deck and shared by every other one. It serves the dashboard page and renders one headless Chrome tab per open pane. When the page changes, it takes a 2× screenshot and tells the pane, at most 8 frames a second. When the last pane closes, it exits after two minutes. Chrome runs over `--remote-debugging-pipe`, so it exits with the daemon.
- The **collector** (`daemon/collect.mjs`) only reads what Claude Code already writes: the live session registry, the transcripts and the subagent transcripts. It reads them incrementally, starting from the last 4 MiB. Subagents are linked to the agent whose Agent call started them.
- The **mod** (`hooks/register.tsx`) opens the pane, asks the daemon for a view at the pane's pixel size, draws each frame as an `Image`, and forwards input. Session crons come from `CronList`. Cloud routines come from `RemoteTrigger`, but only when you press *refresh* on the Routines tab, so you get no permission prompts you didn't ask for.

Nothing is sent anywhere. The daemon listens on `127.0.0.1` only.

## Develop

```text
claude --plugin-dir .            # a session with the mod loaded from this folder
claude plugin validate .
claude plugin test .             # the mod: view, frames, input
node --test tests/collect.test.mjs   # the collector
AGENTDECK_PORT=47899 node daemon/server.mjs   # the daemon on its own; open http://127.0.0.1:47899/?view=x
```

## License

MIT
