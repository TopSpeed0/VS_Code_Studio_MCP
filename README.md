# VS Code Studio MCP

VS Code MCP servers + worker agent for the Hermes Overmind hybrid architecture.

## What's here

| File | Purpose |
|------|---------|
| `mcp/telegram-tg.js` | MCP server — Telegram bot tools (`tg_send`, `tg_ask`, `tg_typing`) |
| `mcp/vscode-queue.js` | MCP server — Hermes queue bridge (`queue_poll`, `queue_done`, `queue_error`) |
| `.vscode/mcp.json` | VS Code MCP config — wires both servers into Copilot agent |
| `.github/agents/vscode-worker.agent.md` | VS Code worker agent loop instructions |

## Architecture

```
User (Telegram) ──► Bot A (Hermes)  ──► .vscode-queue.json ──► vscode-worker
                                                                     │
User (Telegram) ──► Bot B (VS_Code) ─────────────────────────────────┘
                                         vscode-worker manages both inputs
```

- **Dual-input loop:** accepts tasks from Hermes queue AND direct Telegram messages via dedicated VS Code bot
- **Own bot token:** `VS_Code` entry in `.telegram-config → tokens` (loaded via `TELEGRAM_WORKER_NAME=VS_Code` env var)
- **Heartbeat:** writes `.vscode-worker.heartbeat` after each task — Hermes checks liveness before delegating

## Setup

1. Clone this repo into your workspace
2. Copy `.telegram-config.example` → `.telegram-config` and fill in your tokens
3. Open in VS Code — MCP servers auto-start from `.vscode/mcp.json`
4. In Copilot chat: `@vscode-worker start worker`

## Config

`.telegram-config` (gitignored — create locally, see `.telegram-config.example`):
```json
{
  "chat_id": "YOUR_NUMERIC_CHAT_ID",
  "tokens": [
    { "name": "VS_Code", "key": "YOUR_VSCODE_BOT_TOKEN" }
  ]
}
```

## Part of the Hermes multi-worker ecosystem

| Repo | Worker | Queue |
|------|--------|-------|
| [Copilot-CLI-Telegram-MCP](https://github.com/TopSpeed0/Copilot-CLI-Telegram-MCP) | Copilot CLI daemon | `.copilot-queue.json` |
| [ClaudeCodeTelgMCP](https://github.com/TopSpeed0/ClaudeCodeTelgMCP) | Claude Code daemon | `.claude-queue.json` |
| **VS_Code_Studio_MCP** (this repo) | VS Code worker | `.vscode-queue.json` |
