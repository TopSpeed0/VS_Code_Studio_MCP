# Hermes Capabilities Reference — Inspiration for VS Code Worker

This document describes how Hermes (the Overmind) implements Telegram features
that the VS Code worker currently doesn't have. Use this as a reference when
extending `telegram-tg.js` or the worker loop.

You know your own capabilities better than Hermes does — this is input, not a spec.

---

## 1. Media / File Attachments

**What Hermes does:**
Uses Telegram's `sendDocument`, `sendPhoto`, `sendAudio`, `sendVoice` endpoints
instead of `sendMessage`. Detects file type by extension:

| Extension | Telegram method | Renders as |
|-----------|----------------|------------|
| `.png` `.jpg` `.webp` | `sendPhoto` | Inline photo |
| `.ogg` | `sendVoice` | Voice bubble (playable) |
| `.mp4` | `sendVideo` | Inline video player |
| anything else | `sendDocument` | File attachment |

**How it sends:**
Multipart form-data (`multipart/form-data`) POST — not JSON.
Node's built-in `https` can do this without dependencies.

```js
// Rough shape — multipart POST to Telegram
const boundary = '----HermesBoundary' + Date.now();
// body = boundary + chat_id field + document field (file stream)
// Content-Type: multipart/form-data; boundary=...
```

**Potential `tg_send` extension:**
Add an optional `file_path` parameter. If present → read file → pick method by extension → multipart POST.

---

## 2. Multi-Target / Thread Support

**What Hermes does:**
`sendMessage` accepts `message_thread_id` for Telegram Topics (supergroups with topics enabled).
Also supports sending to different `chat_id` values per call.

**Current `telegram-tg.js` limitation:**
`chat_id` is fixed at startup from `.telegram-config`. Can't target a different chat or thread per call.

**Potential extension:**
Add optional `chat_id` and `thread_id` parameters to `tg_send` / `tg_ask`:
```json
{ "text": "...", "chat_id": "-1001234567890", "thread_id": 42 }
```
Fall back to config values if not provided.

---

## 3. Inline Keyboards / Quick Replies

**What Hermes supports:**
Telegram's `reply_markup` → `InlineKeyboardMarkup` — sends buttons under a message.
User clicks a button → Telegram fires a `callback_query` update (not a message).

**How to receive callbacks:**
`getUpdates` with `allowed_updates: ['message', 'callback_query']`
Then handle `u.callback_query` in addition to `u.message`.

**Potential `tg_ask` extension:**
Add optional `choices: string[]` parameter. If provided:
- Build `inline_keyboard` from choices
- Poll for `callback_query` instead of text message
- Return `callback_query.data` as the reply

This would let the worker present the user with buttons instead of free-text input.

---

## 4. Message Editing

**What Hermes can do:**
`editMessageText` — update a previously sent message in place.
Useful for progress updates: send "⏳ Starting..." then edit to "✅ Done."

```js
// Send initial
const msg = await tgApi('sendMessage', { chat_id, text: '⏳ Working...' });
// Later, edit in place
await tgApi('editMessageText', {
  chat_id,
  message_id: msg.message_id,
  text: '✅ Done!'
});
```

**Potential `tg_send` extension:**
Return `message_id` from `tg_send`. Add a `tg_edit(message_id, text)` tool.
Worker calls `tg_send` at start → gets ID → calls `tg_edit` on completion.

---

## 5. Reactions / Read Receipts

**What Telegram supports (Bot API 7.0+):**
`setMessageReaction` — put an emoji reaction on a message.
Useful as a lightweight "acknowledged" signal without sending a reply.

```js
await tgApi('setMessageReaction', {
  chat_id,
  message_id: userMessage.message_id,
  reaction: [{ type: 'emoji', emoji: '👀' }]
});
```

**Potential use:**
When worker picks up a task from direct Telegram → react with 👀 immediately
(acknowledges receipt), then reply with result when done.

---

## Notes

- All Telegram Bot API endpoints: `https://api.telegram.org/bot<TOKEN>/<method>`
- `telegram-tg.js` already has a working `tgApi()` helper — all extensions above
  just need new method names and payload shapes
- The MCP schema is in `TOOLS` array — add new tools there with input schemas
- `vscode-queue.js` doesn't need changes for any of these (queue protocol stays the same)
