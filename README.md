# VS Code Studio MCP

<p align="center">
  <b>VS Code Copilot worker — dual-input loop: Hermes queue + direct Telegram bot</b>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.10-339933?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/MCP-2024--11--05-8A2BE2" alt="MCP">
  <img src="https://img.shields.io/badge/Telegram-Bot%20API-26A5E4?logo=telegram&logoColor=white" alt="Telegram">
  <img src="https://img.shields.io/badge/VS%20Code-Copilot%20Agent-007ACC?logo=visualstudiocode&logoColor=white" alt="VS Code">
  <img src="https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-lightgrey" alt="Platform">
</p>

---

MCP servers + agent loop that turns VS Code Copilot into a **standalone worker** inside the [Hermes Overmind](https://github.com/TopSpeed0/AI-MCP-telegram-agents) multi-worker architecture.

The worker accepts tasks from **two sources simultaneously** — no mode switching, no restarts:

| Source | How it works |
|--------|-------------|
| **Hermes queue** | Hermes writes a task to `.vscode-queue.json` → worker picks it up, executes, writes result back |
| **Direct Telegram** | User messages the VS Code bot directly → worker responds via its own bot |

---

## Architecture

```
User (Telegram)
    │
    ├──► Bot A (Hermes Overmind) ──► .vscode-queue.json ──┐
    │                                                      ▼
    └──► Bot B (VS_Code bot) ──────────────────► [ vscode-worker ]
                                                      │
                                          edits files, runs terminal,
                                          searches code, calls MCPs
                                              │
                                    replies via own bot / queue_done
```

- **Own bot token** — VS Code worker has its own Telegram bot (`VS_Code` entry in `.telegram-config → tokens`). Hermes and the worker never fight over `getUpdates`.
- **Heartbeat** — worker writes `.vscode-worker.heartbeat` after each task. Hermes checks it before delegating — if stale >5min, Hermes tells you the worker is down instead of silently queuing.
- **Skill-first** — before any domain task (NetApp, VMware, DNS, Outlook...) the worker reads the matching `SKILL.md` from `~/.claude/skills/`. See `.github/copilot-instructions.md`.

---

## What's in this repo

| Path | Purpose |
|------|---------|
| `mcp/telegram-tg.js` | MCP server — Telegram tools: `tg_send`, `tg_ask`, `tg_typing`, `tg_edit`, `tg_react` |
| `mcp/vscode-queue.js` | MCP server — Hermes queue bridge: `queue_poll`, `queue_done`, `queue_error`, `watch_queue` |
| `.vscode/mcp.json` | VS Code MCP config — wires both servers, sets `TELEGRAM_WORKER_NAME=VS_Code` |
| `.github/agents/vscode-worker.agent.md` | Worker agent loop — dual-input, heartbeat, skill discipline |
| `.github/copilot-instructions.md` | Copilot workspace rules — skill-first approach, domain→skill mapping |
| `setup.js` | Interactive setup wizard — bot token → chat ID → writes `.telegram-config` |
| `setup-hybrid.js` | Hybrid setup — configures Hermes gateway + Copilot integration |
| `queue-watch.js` | Standalone queue watcher — fallback notifier when Hermes isn't running |
| `docs/hermes-capabilities-reference.md` | Inspiration doc — Hermes Telegram features the worker can adopt |

---

## Requirements

- **Node.js 22.10+** (uses `--use-system-ca`, no `npm install` needed)
- **VS Code** with GitHub Copilot Chat (Agent mode)
- A **Telegram bot** created via [@BotFather](https://t.me/BotFather)
- Your numeric **Telegram chat ID**

> **Corporate TLS proxy?** Both setup and MCP servers use `--use-system-ca` — trusts the OS cert store automatically. No extra config needed.

---

## Quick Start

```bash
git clone https://github.com/TopSpeed0/VS_Code_Studio_MCP.git
cd VS_Code_Studio_MCP
node setup.js
```

The setup wizard will:
1. Ask for your **bot token** (validates via Telegram `getMe`)
2. Auto-detect your **chat ID** — send any message to the bot, it reads it back
3. Write `.telegram-config` (gitignored, mode `0600`)
4. Send a confirmation message to your Telegram

Then:
1. Open this folder in VS Code
2. Reload window — MCP servers auto-start from `.vscode/mcp.json`
3. Open Copilot Chat → Agent mode → type:

```
@vscode-worker start worker
```

You'll receive **🟢 VS Code worker ready.** in Telegram from your VS Code bot.

---

## Manual config

Copy the example and fill in your values:

```bash
cp .telegram-config.example .telegram-config
```

`.telegram-config` format:
```json
{
  "chat_id": "YOUR_NUMERIC_CHAT_ID",
  "tokens": [
    { "name": "VS_Code", "key": "YOUR_VSCODE_BOT_TOKEN" }
  ]
}
```

> `TELEGRAM_WORKER_NAME=VS_Code` is already set in `.vscode/mcp.json` — the MCP server picks the right token automatically.

---

## MCP Tools

### `telegram-tg` server

| Tool | Description |
|------|-------------|
| `tg_send(text, parse_mode?)` | Fire-and-forget notification via VS Code bot |
| `tg_ask(question?, timeoutSeconds?, parse_mode?)` | Send a question and **block until reply**. Empty question = silent poll (used in the worker loop) |
| `tg_typing(seconds?, action?)` | Show "typing…" indicator |
| `tg_edit(message_id, text, parse_mode?)` | Edit a previously sent message in place |
| `tg_react(message_id, emoji)` | Put an emoji reaction on a message (e.g. 👀 = acknowledged) |

### `vscode-queue` server

| Tool | Description |
|------|-------------|
| `queue_poll(timeoutSeconds?)` | Block until Hermes writes a pending task. Returns `{ id, task, context }` |
| `queue_done(result)` | Mark task complete — Hermes relays result to Telegram |
| `queue_error(message)` | Mark task failed |
| `watch_queue(timeoutSeconds?)` | Poll queue AND Telegram simultaneously — first to arrive wins |

---

## Worker Loop

The `@vscode-worker` agent runs a **dual-input loop** indefinitely:

```
1. watch_queue(60s)  ←── polls queue + Telegram in one call
2. Task from queue   → execute → queue_done → loop
   Task from Telegram → execute → tg_send → loop
3. tg_react(👀) on receipt, tg_typing before work, heartbeat after done
4. Destructive tasks → tg_ask for confirmation first
5. send "⏳ Still working…" every 2min for long tasks
```

Send `stop` from Telegram to exit the loop cleanly.

---

## Hybrid mode with Hermes

This worker is part of the [Hermes Overmind](https://github.com/TopSpeed0/AI-MCP-telegram-agents) ecosystem:

| Repo | Worker | Queue file |
|------|--------|-----------|
| [AI-MCP-telegram-agents](https://github.com/TopSpeed0/AI-MCP-telegram-agents) | Hermes Overmind | — (owns Telegram) |
| [Copilot-CLI-Telegram-MCP](https://github.com/TopSpeed0/Copilot-CLI-Telegram-MCP) | Copilot CLI daemon | `.copilot-queue.json` |
| [ClaudeCodeTelgMCP](https://github.com/TopSpeed0/ClaudeCodeTelgMCP) | Claude Code daemon | `.claude-queue.json` |
| **VS_Code_Studio_MCP** (this repo) | VS Code worker | `.vscode-queue.json` |

Each worker is **independent** — its own repo, its own bot token, its own queue. No shared state, no conflicts.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Token "VS_Code" not found in .telegram-config tokens[]` | `.telegram-config` missing or wrong format. Run `node setup.js` |
| Worker starts but doesn't respond | Another process is polling the same bot token. Create a separate bot for the worker |
| Hermes says "worker is not running" | `.vscode-worker.heartbeat` is stale or missing — start `@vscode-worker` in VS Code first |
| `unable to get local issuer certificate` | Corporate proxy. Already handled via `--use-system-ca` (Node 22.10+). On older Node: `NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem` |
| `Conflict: terminated by other getUpdates request` | Two processes polling the same bot. Stop one |

---

## Security

- Bot token = full control of your bot. **Never commit it.** `.gitignore` already excludes `.telegram-config`.
- Worker has full VS Code tool access (terminal, file edits). Treat the Telegram chat like a remote shell.
- Destructive tasks always require `tg_ask` confirmation before execution.

---

## License

[MIT](LICENSE)
