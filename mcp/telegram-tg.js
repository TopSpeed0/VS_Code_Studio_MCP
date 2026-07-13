#!/usr/bin/env node
// telegram-tg.js — Zero-dependency Telegram MCP server (stdio).
// Exposes these tools to the agent:
//   tg_send   — one-way notification (optionally attach a file via file_path)
//   tg_ask    — send a question and block until the user replies (optional
//               inline-keyboard quick replies via choices[])
//   tg_edit   — edit a previously sent message in place (progress updates)
//   tg_react  — put an emoji reaction on a message (lightweight acknowledge)
//   tg_typing — show typing indicator
//
// Config resolution (first match wins):
//   1. Env vars TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
//   2. JSON file at <workspace>/.telegram-config with TELEGRAM_WORKER_NAME env var:
//        { "chat_id": "...", "tokens": [{ "name": "VS_Code", "key": "..." }] }
//        Set TELEGRAM_WORKER_NAME=VS_Code → uses that token entry
//
// Protocol: JSON-RPC 2.0 over stdio (MCP 2024-11-05).
// All non-protocol output (errors, debug) goes to stderr — never stdout.

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

// ---------- Config ----------
function loadConfig() {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const envChat  = process.env.TELEGRAM_CHAT_ID;
  if (envToken && envChat) {
    return { bot_token: envToken, chat_id: envChat };
  }
  const cfgPath = path.join(process.cwd(), '.telegram-config');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(
      `No Telegram config. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars, ` +
      `or create ${cfgPath} with {"bot_token":"...", "chat_id":"..."}.`
    );
  }
  const raw = fs.readFileSync(cfgPath, 'utf-8');
  const cfg = JSON.parse(raw);
  // If TELEGRAM_WORKER_NAME is set, use the named token from the tokens[] array
  // e.g. TELEGRAM_WORKER_NAME=VS_Code → uses cfg.tokens[{name:"VS_Code"}].key
  const workerName = process.env.TELEGRAM_WORKER_NAME;
  if (workerName && Array.isArray(cfg.tokens)) {
    const entry = cfg.tokens.find(t => t.name === workerName);
    if (entry && entry.key) {
      return { bot_token: entry.key, chat_id: cfg.chat_id };
    }
    process.stderr.write(`[telegram-tg] WARNING: TELEGRAM_WORKER_NAME="${workerName}" not found in tokens[]. Cannot start.\n`);
    throw new Error(`Token "${workerName}" not found in .telegram-config tokens[].`);
  }
  // No TELEGRAM_WORKER_NAME set — require explicit env vars
  throw new Error(
    `Set TELEGRAM_WORKER_NAME env var to pick a token from .telegram-config tokens[], ` +
    `or set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars directly.`
  );
}

let config;
try {
  config = loadConfig();
} catch (e) {
  process.stderr.write(`[telegram-tg] ${e.message}\n`);
  process.exit(1);
}

// Persistent state for update offset (so replies aren't double-consumed).
const stateFile = path.join(process.cwd(), '.telegram-state.json');
let updateOffset = 0;
try {
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  updateOffset = s.updateOffset || 0;
} catch (_) { /* first run */ }

function saveState() {
  try { fs.writeFileSync(stateFile, JSON.stringify({ updateOffset })); } catch (_) {}
}

// ---------- Unified queue watch ----------
// The worker loop must wait on BOTH the Hermes queue file AND Telegram in a
// SINGLE blocking call. If it instead ran queue_poll + tg_ask as a parallel
// batch, the batch would only return once BOTH finished — so the slower poll
// gates the faster one (a Telegram message could sit up to the full timeout
// before being seen). By having tg_ask (silent, watch_queue) also check this
// file each loop, one long-lived call catches a queue task or a Telegram
// message with low latency — no batch-gating, and the loop survives for the
// whole timeout on a single agent turn.
const queuePath = path.join(process.cwd(), '.vscode-queue.json');
function claimPendingQueueTask() {
  try {
    if (!fs.existsSync(queuePath)) return null;
    const raw = fs.readFileSync(queuePath, 'utf-8').trim();
    if (!raw) return null;
    const task = JSON.parse(raw);
    if (task && task.status === 'pending') {
      task.status = 'working';
      task.updated = new Date().toISOString();
      fs.writeFileSync(queuePath, JSON.stringify(task, null, 2) + '\n', { mode: 0o600 });
      return task;
    }
  } catch (_) { /* ignore malformed / mid-write file */ }
  return null;
}

// ---------- Telegram API helper ----------
function tgApi(method, params, { httpTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${config.bot_token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            reject(new Error(`Telegram ${method} failed: ${parsed.description || data}`));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error(`Telegram ${method} parse error: ${e.message} (raw: ${data.slice(0, 200)})`));
        }
      });
    });
    req.on('error', reject);
    if (httpTimeoutMs) {
      req.setTimeout(httpTimeoutMs, () => req.destroy(new Error(`Telegram ${method} HTTP timeout after ${httpTimeoutMs}ms`)));
    }
    req.write(body);
    req.end();
  });
}

// ---------- Multipart file upload helper ----------
// Telegram file-sending endpoints (sendDocument/sendPhoto/...) need
// multipart/form-data, not JSON. Node's built-in https can do this with no deps.
function tgApiMultipart(method, fields, fileField, filePath, { httpTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let fileBuf;
    try {
      fileBuf = fs.readFileSync(filePath);
    } catch (e) {
      return reject(new Error(`Cannot read file "${filePath}": ${e.message}`));
    }
    const filename = path.basename(filePath);
    const boundary = '----telegramTgBoundary' + Date.now() + Math.random().toString(16).slice(2);
    const pre = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      pre.push(`--${boundary}\r\n`);
      pre.push(`Content-Disposition: form-data; name="${k}"\r\n\r\n`);
      pre.push(`${v}\r\n`);
    }
    pre.push(`--${boundary}\r\n`);
    pre.push(`Content-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\n`);
    pre.push('Content-Type: application/octet-stream\r\n\r\n');
    const head = Buffer.from(pre.join(''), 'utf-8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const body = Buffer.concat([head, fileBuf, tail]);
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${config.bot_token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            reject(new Error(`Telegram ${method} failed: ${parsed.description || data}`));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error(`Telegram ${method} parse error: ${e.message} (raw: ${data.slice(0, 200)})`));
        }
      });
    });
    req.on('error', reject);
    if (httpTimeoutMs) {
      req.setTimeout(httpTimeoutMs, () => req.destroy(new Error(`Telegram ${method} HTTP timeout after ${httpTimeoutMs}ms`)));
    }
    req.write(body);
    req.end();
  });
}

// Pick the right Telegram method + form field based on file extension.
function pickFileMethod(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return { method: 'sendPhoto', field: 'photo' };
  if (ext === '.ogg') return { method: 'sendVoice', field: 'voice' };
  if (['.mp4', '.mov'].includes(ext)) return { method: 'sendVideo', field: 'video' };
  if (['.mp3', '.m4a', '.wav', '.flac'].includes(ext)) return { method: 'sendAudio', field: 'audio' };
  return { method: 'sendDocument', field: 'document' };
}

// Tracks the most recent inbound message id so tg_react can default to it.
let lastReceivedMessageId = null;

// ---------- Tool implementations ----------
// Accepted parse_mode values per Telegram Bot API.
const PARSE_MODES = new Set(['HTML', 'MarkdownV2', 'Markdown']);

function normalizeParseMode(parseMode) {
  if (!parseMode) return undefined;
  const pm = String(parseMode).trim();
  if (!PARSE_MODES.has(pm)) {
    throw new Error(`Invalid parse_mode "${pm}". Use one of: HTML, MarkdownV2, Markdown.`);
  }
  return pm;
}

// A self-sustaining "typing..." keeper. A single sendChatAction only lasts ~5s,
// so after a message is caught the indicator would fade while the agent is still
// generating its reply. The keeper pulses every 4s from the moment a message is
// received until the next outbound message is sent, so the operator sees a solid
// "typing..." the whole time. It auto-stops itself after a safety cap so it can
// never leak if a reply is never sent.
let typingKeeperTimer = null;
function startTypingKeeper() {
  stopTypingKeeper();
  const pulse = () => {
    tgApi('sendChatAction', { chat_id: config.chat_id, action: 'typing' }).catch(() => {});
  };
  pulse();
  let elapsed = 0;
  typingKeeperTimer = setInterval(() => {
    elapsed += 4000;
    if (elapsed >= 120000) { stopTypingKeeper(); return; } // 2-min safety cap
    pulse();
  }, 4000);
  if (typingKeeperTimer.unref) typingKeeperTimer.unref();
}
function stopTypingKeeper() {
  if (typingKeeperTimer) {
    clearInterval(typingKeeperTimer);
    typingKeeperTimer = null;
  }
}

async function tgSend(text, parseMode, opts = {}) {
  // Any outbound message ends the "typing..." state.
  stopTypingKeeper();
  const chatId = opts.chat_id || config.chat_id;
  const pm = normalizeParseMode(parseMode);

  // File attachment path: pick method by extension and multipart-upload.
  if (opts.file_path) {
    const { method, field } = pickFileMethod(opts.file_path);
    const fields = { chat_id: chatId };
    if (opts.thread_id != null) fields.message_thread_id = opts.thread_id;
    if (text) fields.caption = text;
    if (pm) fields.parse_mode = pm;
    const msg = await tgApiMultipart(method, fields, field, opts.file_path, { httpTimeoutMs: 120000 });
    return `Sent file via ${method} (message_id=${msg.message_id}).`;
  }

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (opts.thread_id != null) payload.message_thread_id = opts.thread_id;
  if (pm) payload.parse_mode = pm;
  const msg = await tgApi('sendMessage', payload);
  return `Sent (message_id=${msg.message_id}${pm ? `, parse_mode=${pm}` : ''}).`;
}

// Edit a previously sent message in place — great for progress updates
// ("⏳ Working..." → "✅ Done") without spamming the chat with new messages.
async function tgEdit(messageId, text, parseMode, opts = {}) {
  if (messageId == null) throw new Error('tg_edit requires "message_id".');
  const chatId = opts.chat_id || config.chat_id;
  const pm = normalizeParseMode(parseMode);
  const payload = {
    chat_id: chatId,
    message_id: Number(messageId),
    text,
    disable_web_page_preview: true,
  };
  if (pm) payload.parse_mode = pm;
  const msg = await tgApi('editMessageText', payload);
  return `Edited message_id=${msg.message_id}.`;
}

// Put an emoji reaction on a message — a lightweight "acknowledged" signal
// without sending a whole reply. Defaults to the last inbound message + 👀.
async function tgReact(messageId, emoji, opts = {}) {
  const chatId = opts.chat_id || config.chat_id;
  const id = messageId != null ? Number(messageId) : lastReceivedMessageId;
  if (id == null) {
    throw new Error('tg_react: no message_id given and no message received yet this session.');
  }
  const e = emoji && String(emoji).trim() ? String(emoji).trim() : '👀';
  await tgApi('setMessageReaction', {
    chat_id: chatId,
    message_id: id,
    reaction: [{ type: 'emoji', emoji: e }],
  });
  return `Reacted ${e} to message_id=${id}.`;
}

// sendChatAction:'typing' shows "... is typing" in the chat for ~5s.
// We refresh every 4s so the indicator stays solid for the requested duration.
// Valid actions: typing, upload_photo, record_video, upload_video, record_voice,
// upload_voice, upload_document, choose_sticker, find_location, record_video_note,
// upload_video_note. Default: typing.
async function tgTyping(seconds, action) {
  const total = Math.max(1, Math.min(60, Number(seconds) || 5));
  const act = action && String(action).trim() ? String(action).trim() : 'typing';
  const deadline = Date.now() + total * 1000;
  let pulses = 0;
  while (Date.now() < deadline) {
    await tgApi('sendChatAction', { chat_id: config.chat_id, action: act });
    pulses++;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(4000, remaining)));
  }
  return `Sent ${pulses} "${act}" pulse${pulses === 1 ? '' : 's'} over ${total}s.`;
}

async function tgAsk(question, timeoutSeconds, parseMode, opts = {}) {
  const timeoutMs = Math.max(5, Math.min(36000, Number(timeoutSeconds) || 300)) * 1000;
  const pm = normalizeParseMode(parseMode);
  const silent = !question || !question.trim();
  const chatId = opts.chat_id || config.chat_id;
  const choices = Array.isArray(opts.choices) && opts.choices.length ? opts.choices.map(String) : null;
  // When watching the queue (worker loop), also poll the Hermes queue file each
  // iteration. Only meaningful for silent polls — an interactive question waits
  // for a human reply, not a queue task.
  const watchQueue = silent && !!opts.watch_queue;

  // Drain pending updates ONLY for interactive questions, so a stale, unrelated
  // message isn't mistaken for the reply. For silent polls (the worker loop),
  // NEVER drain: doing so discards messages that arrived in the gap between
  // polls. The persisted updateOffset already prevents re-consuming old
  // messages, so every buffered message is caught on the next long-poll.
  if (!silent) {
    try {
      const drain = await tgApi('getUpdates', { offset: -1, timeout: 0 }, { httpTimeoutMs: 5000 });
      if (drain.length) {
        updateOffset = drain[drain.length - 1].update_id + 1;
        saveState();
      }
    } catch (e) {
      process.stderr.write(`[telegram-tg] drain warning: ${e.message}\n`);
    }
  }

  let questionMessageId = null;
  let sentDate = Math.floor(Date.now() / 1000);

  if (!silent) {
    // Sending a question is an outbound message — end any active typing state.
    stopTypingKeeper();
    // Send the question.
    const trailer = '';
    const sendPayload = {
      chat_id: chatId,
      text: pm ? `${question}${trailer}` : `❓ ${question}${trailer}`,
    };
    if (pm) sendPayload.parse_mode = pm;
    if (opts.thread_id != null) sendPayload.message_thread_id = opts.thread_id;
    // Inline-keyboard quick replies: one tappable button per choice.
    // callback_data is the choice index (Telegram caps callback_data at 64 bytes).
    if (choices) {
      sendPayload.reply_markup = {
        inline_keyboard: choices.map((c, i) => [{ text: c, callback_data: String(i) }]),
      };
    }
    const sent = await tgApi('sendMessage', sendPayload);
    questionMessageId = sent.message_id;
    sentDate = sent.date;
  }

  // Long-poll for a reply. When we offered buttons, also listen for the
  // callback_query that fires when the operator taps one.
  const allowedUpdates = choices ? ['message', 'callback_query'] : ['message'];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Check the Hermes queue first each iteration. If a task is waiting, claim
    // it and return a JSON marker the worker recognizes ("__queue_task__").
    if (watchQueue) {
      const task = claimPendingQueueTask();
      if (task) {
        startTypingKeeper();
        return JSON.stringify({
          __queue_task__: true,
          id: task.id,
          task: task.task,
          context: task.context || null,
          created: task.created || null,
        });
      }
    }
    // When watching the queue, keep each getUpdates window short (~8s) so the
    // queue file is re-checked frequently. Telegram messages still return
    // instantly — getUpdates long-poll wakes the moment one arrives. When not
    // watching the queue, use the full 50s window for efficiency.
    const windowCap = watchQueue ? 8 : 50;
    const remainingSec = Math.max(1, Math.min(windowCap, Math.floor((deadline - Date.now()) / 1000)));
    let updates;
    try {
      updates = await tgApi('getUpdates', {
        offset: updateOffset,
        timeout: remainingSec,
        allowed_updates: allowedUpdates,
      }, { httpTimeoutMs: (remainingSec + 10) * 1000 });
    } catch (e) {
      process.stderr.write(`[telegram-tg] getUpdates: ${e.message} — retrying\n`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    for (const u of updates) {
      updateOffset = u.update_id + 1;
      saveState();

      // A tapped inline-keyboard button arrives as a callback_query.
      if (u.callback_query) {
        const cq = u.callback_query;
        if (cq.message && String(cq.message.chat.id) !== String(chatId)) continue;
        // Answer it so Telegram clears the button's loading spinner.
        tgApi('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
        if (cq.message) lastReceivedMessageId = cq.message.message_id;
        startTypingKeeper();
        const idx = Number(cq.data);
        return choices && Number.isInteger(idx) && choices[idx] != null ? choices[idx] : String(cq.data);
      }

      const m = u.message;
      if (!m) continue;
      if (String(m.chat.id) !== String(chatId)) continue;
      // Accept any message from the configured chat after our question was sent.
      // (Date check guards against clock-skew weirdness.)
      if (m.date && m.date * 1000 < sentDate * 1000 - 5000) continue;
      lastReceivedMessageId = m.message_id;
      const text = m.text || m.caption || '(non-text message)';
      // Start a self-sustaining typing indicator the instant a message is
      // caught, so the operator sees a solid "typing..." while the agent
      // formulates its reply. It auto-stops when the next message is sent
      // (via tgSend) or after a 2-minute safety cap.
      startTypingKeeper();
      return text;
    }
  }
  throw new Error(`No Telegram reply within ${timeoutMs / 1000}s${questionMessageId ? ` (question message_id=${questionMessageId})` : ' (silent poll)'}. Timed out.`);
}

// ---------- MCP stdio JSON-RPC plumbing ----------
const PARSE_MODE_SCHEMA = {
  type: 'string',
  enum: ['HTML', 'MarkdownV2', 'Markdown'],
  description: 'Optional Telegram parse mode. Omit for plain text (default). Recommended: "HTML" — escape <, >, & in dynamic content and use <b>bold</b>, <i>italic</i>, <code>mono</code>, <pre>block</pre>, <a href="url">link</a>. "MarkdownV2" requires escaping many chars (_*[]()~`>#+-=|{}.!) and is more error-prone. Avoid Markdown literals like **bold** without setting parse_mode — they render as literal asterisks.',
};

const TOOLS = [
  {
    name: 'tg_send',
    description: 'Send a one-way notification to the operator via Telegram. Use when the agent needs human attention (e.g., a VS Code approval is pending, a long task finished, an error needs eyes). Fire-and-forget — does not wait for a reply. Pass parse_mode:"HTML" to use rich formatting. Pass file_path to attach an image/video/audio/document (rendered inline by type). Returns the sent message_id (usable with tg_edit / tg_react).',
    inputSchema: {
      type: 'object',
      properties: {
        text:       { type: 'string', description: 'Notification text. When file_path is set this becomes the file caption. If parse_mode is set, callers must escape per Telegram rules.' },
        parse_mode: PARSE_MODE_SCHEMA,
        file_path:  { type: 'string', description: 'Optional absolute path to a file to attach. Type is auto-detected: .png/.jpg/.webp/.gif → photo, .mp4/.mov → video, .ogg → voice, .mp3/.m4a/.wav → audio, anything else → document.' },
        chat_id:    { type: 'string', description: 'Optional target chat id. Defaults to the configured operator chat.' },
        thread_id:  { type: 'number', description: 'Optional Telegram Topic (message_thread_id) to post into, for supergroups with topics enabled.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'tg_ask',
    description: 'Ask the operator a question via Telegram and BLOCK until they reply. Returns the reply text. Use for confirmations, choices, or clarifications when the agent is uncertain. Pass parse_mode:"HTML" to render bold/code/links in the question. Pass choices:[...] to show tappable quick-reply buttons instead of free text — the tapped choice is returned. If question is empty or omitted, silently waits for the next message without sending anything (useful for autopilot loops after the initial Ready).',
    inputSchema: {
      type: 'object',
      properties: {
        question:       { type: 'string', description: 'The question to send. If empty or omitted, silently polls for the next message without sending anything.' },
        timeoutSeconds: { type: 'number', description: 'Max seconds to wait for a reply (default 300, max 36000). For the worker loop use a large value (e.g. 3600) with watch_queue:true so one call covers a long window on a single turn.' },
        parse_mode:     PARSE_MODE_SCHEMA,
        choices:        { type: 'array', items: { type: 'string' }, description: 'Optional list of quick-reply options. Renders as inline-keyboard buttons; the tapped option text is returned. Operator can still type a free-text reply instead.' },
        chat_id:        { type: 'string', description: 'Optional target chat id. Defaults to the configured operator chat.' },
        thread_id:      { type: 'number', description: 'Optional Telegram Topic (message_thread_id) to post the question into.' },
        watch_queue:    { type: 'boolean', description: 'When true (silent poll only), ALSO watches the Hermes queue file each iteration. Returns a JSON string {"__queue_task__":true,id,task,context} if a task appears, or the Telegram message text if the operator writes first. Lets the worker wait on BOTH sources in ONE long-lived call — no parallel-batch gating. Use with a large timeoutSeconds.' },
      },
    },
  },
  {
    name: 'tg_edit',
    description: 'Edit a previously sent message in place. Use for progress updates: tg_send "⏳ Working..." → capture the message_id → tg_edit it to "✅ Done". Keeps the chat clean instead of posting a new message each step.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'The message_id returned by a prior tg_send.' },
        text:       { type: 'string', description: 'The new text for the message.' },
        parse_mode: PARSE_MODE_SCHEMA,
        chat_id:    { type: 'string', description: 'Optional chat id if the message is not in the default operator chat.' },
      },
      required: ['message_id', 'text'],
    },
  },
  {
    name: 'tg_react',
    description: 'Put an emoji reaction on a message — a lightweight "acknowledged" signal without sending a reply. Great for reacting 👀 the instant a task is picked up. Defaults to the most recent inbound message and the 👀 emoji if not specified.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'Message to react to. Defaults to the last message received this session.' },
        emoji:      { type: 'string', description: 'Reaction emoji (default 👀). Must be one Telegram supports, e.g. 👍 ❤️ 🔥 👀 ✅ 🎉 👏 🙏.' },
        chat_id:    { type: 'string', description: 'Optional chat id if not the default operator chat.' },
      },
    },
  },
  {
    name: 'tg_typing',
    description: 'Show a "typing..." indicator in the operator\'s Telegram chat. Use this before starting work that will take a few seconds so the operator sees the agent is busy. Blocks for the requested duration, refreshing the indicator every 4s. Call it again to extend.',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How long to keep the indicator visible (1-60, default 5).' },
        action:  { type: 'string', enum: ['typing', 'upload_photo', 'record_video', 'upload_video', 'record_voice', 'upload_voice', 'upload_document', 'choose_sticker', 'find_location', 'record_video_note', 'upload_video_note'], description: 'Telegram chat action. Default "typing". Use "upload_document" when you\'re about to send a long report.' },
      },
    },
  },
];

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result)   { write({ jsonrpc: '2.0', id, result }); }
function err(id, message, code = -32000) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'telegram-tg', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return; // notifications don't get responses
  }
  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      let text;
      if (name === 'tg_send') {
        if (!args.text && !args.file_path) throw new Error('tg_send requires "text" or "file_path".');
        text = await tgSend(args.text ? String(args.text) : '', args.parse_mode, {
          file_path: args.file_path,
          chat_id: args.chat_id,
          thread_id: args.thread_id,
        });
      } else if (name === 'tg_ask') {
        text = await tgAsk(args.question ? String(args.question) : '', args.timeoutSeconds, args.parse_mode, {
          choices: args.choices,
          chat_id: args.chat_id,
          thread_id: args.thread_id,
          watch_queue: args.watch_queue,
        });
      } else if (name === 'tg_edit') {
        text = await tgEdit(args.message_id, String(args.text), args.parse_mode, { chat_id: args.chat_id });
      } else if (name === 'tg_react') {
        text = await tgReact(args.message_id, args.emoji, { chat_id: args.chat_id });
      } else if (name === 'tg_typing') {
        text = await tgTyping(args.seconds, args.action);
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      return ok(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true });
    }
  }
  if (method === 'ping') {
    return ok(id, {});
  }
  err(id, `Method not found: ${method}`, -32601);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try { req = JSON.parse(trimmed); }
  catch (e) {
    process.stderr.write(`[telegram-tg] bad JSON: ${e.message}\n`);
    return;
  }
  handle(req).catch((e) => {
    process.stderr.write(`[telegram-tg] handler crash: ${e.stack || e.message}\n`);
    if (req && req.id != null) err(req.id, e.message);
  });
});

process.stderr.write(`[telegram-tg] ready (chat_id=${config.chat_id})\n`);
