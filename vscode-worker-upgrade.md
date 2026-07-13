# VS Code Worker — Upgrade Plan

**Date:** 2026-07-14  
**Status:** ✅ Complete — all 6 steps done  
**Goal:** Make vscode-worker a first-class worker — own bot token, accepts commands from both Hermes and the user directly.

---

## Current State

```
User (Telegram) ──► Hermes ──► .vscode-queue.json ──► vscode-worker (VS Code)
                                                              │
                                                         queue_done()
                                                              │
                                                    Hermes relays to Telegram
```

**Problems:**
1. Uses Hermes's bot token — can't send messages if Hermes is stopped
2. User can't talk to vscode-worker directly — must go through Hermes first
3. No way for user to say "hey VS Code, do this" without Hermes in the loop
4. Hermes can't know if VS Code is actually open and the worker is running

---

## Target State

```
User (Telegram) ──► Bot A (Hermes)  ──► .vscode-queue.json ──► vscode-worker
                                                                      │
User (Telegram) ──► Bot B (vscode)  ─────────────────────────────────┘
                                         vscode-worker manages both inputs
                                         and replies via its own bot
```

**vscode-worker becomes a hybrid loop:**
- Listens to its own Telegram bot (like telegram-autopilot does)
- AND polls `.vscode-queue.json` (like it does today)
- First input that arrives wins — process it, then loop back

---

## What Needs to Change

### 1. New Bot Token (infrastructure — user does this)
- Create a second Telegram bot via @BotFather
- Name suggestion: something like `YB_VSCode_bot`
- Same chat_id (your Telegram user ID) — just a different bot

### 2. `.telegram-config` — add vscode worker section
```json
{
  "vscode_worker": {
    "bot_token": "BOT_TOKEN_HERE",
    "chat_id": "YOUR_CHAT_ID",
    "queue_path": ".vscode-queue.json",
    "timeout_seconds": 1800
  }
}
```

### 3. `vscode-worker.agent.md` — upgraded loop logic

**New loop (pseudocode):**
```
1. Poll BOTH sources in parallel:
   a. tg_ask(question="", timeoutSeconds=60)   ← direct Telegram
   b. queue_poll(timeoutSeconds=60)             ← from Hermes

2. First one to return a real task wins.
   - If from Telegram → reply via tg_send (own bot)
   - If from queue → reply via queue_done (Hermes relays)

3. Before any work → tg_typing (via own bot)

4. Do the work (same as today — files, terminal, search, MCPs)

5. Send result to whoever asked:
   - Direct task → tg_send to user via own bot
   - Queue task  → queue_done so Hermes relays

6. Loop back to step 1.
```

### 4. Hermes memory update — queue routing

When Hermes decides to delegate to vscode-worker, it should first check if
the worker is "alive" before writing to the queue. Current problem: Hermes
writes to the queue even when VS Code is closed — task sits forever.

**Liveness check options (pick one):**
- A. vscode-worker writes a heartbeat file every 60s → Hermes checks mtime
- B. vscode-worker sends `tg_send("🟢 VS Code worker ready")` on startup → Hermes
     sets a flag in memory
- C. Queue has a `worker_alive` boolean that vscode-worker toggles

Recommendation: **Option A** — simplest, no coordination needed.

Heartbeat file: `.vscode-worker.heartbeat` (JSON with `{ "ts": epoch, "pid": N }`)

---

## Scenarios After Upgrade

| Scenario | Who handles |
|----------|-------------|
| Hermes running, VS Code open | Hermes decides: delegate heavy tasks to vscode-worker |
| Hermes running, VS Code closed | Hermes handles everything directly |
| VS Code open, Hermes stopped | User talks directly to vscode bot → vscode-worker executes |
| Both running | Either path works; vscode-worker handles direct + queue tasks |

---

## Implementation Order

1. ✅ **User:** Create second bot via @BotFather, note the token
2. ✅ **Config:** Add `VS_Code` token to `.telegram-config → tokens`
3. ✅ **Agent:** Rewrite `vscode-worker.agent.md` with dual-input loop + own bot + heartbeat
4. ✅ **Gitignore:** Added `.vscode-worker.heartbeat` to `.gitignore`
5. ✅ **Hermes routing:** Liveness check added to `.hermes.md` — reads `.vscode-worker.heartbeat`, if missing or ts >5min → tells user instead of writing task
6. ✅ **Hermes memory:** Updated `vscode-copilot-worker-hybrid` skill — vscode-worker is active again, has own bot token + heartbeat

---

## What Stays the Same

- `.vscode-queue.json` format — no breaking changes
- queue_done / queue_error interface — Hermes still reads results
- telegram-autopilot — completely separate, not affected
- Copilot CLI daemon — not affected
- Claude Code daemon — not affected

---

## Open Questions

1. Does VS Code support two MCP tools simultaneously? (`telegram-tg` + `vscode-queue`)
   → Probably yes (both are tool namespaces), needs testing.

2. Should the vscode bot send "🟢 VS Code online" on startup?
   → Nice to have, not blocking.

3. Token storage — where to store the second bot token securely?
   → Same approach as current: `.telegram-config` (gitignored).
