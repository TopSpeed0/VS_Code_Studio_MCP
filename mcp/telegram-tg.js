#!/usr/bin/env node
// telegram-tg.js — Zero-dependency Telegram MCP server (stdio).
// Exposes three tools to the agent:
//   tg_send   — one-way notification
//   tg_ask    — send a question and block until the user replies on Telegram
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

async function tgSend(text, parseMode) {
  const payload = {
    chat_id: config.chat_id,
    text,
    disable_web_page_preview: true,
  };
  const pm = normalizeParseMode(parseMode);
  if (pm) payload.parse_mode = pm;
  const msg = await tgApi('sendMessage', payload);
  return `Sent (message_id=${msg.message_id}${pm ? `, parse_mode=${pm}` : ''}).`;
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

async function tgAsk(question, timeoutSeconds, parseMode) {
  const timeoutMs = Math.max(5, Math.min(36000, Number(timeoutSeconds) || 300)) * 1000;
  const pm = normalizeParseMode(parseMode);
  const silent = !question || !question.trim();

  // Drain pending updates so we never pick up an old, unrelated message.
  try {
    const drain = await tgApi('getUpdates', { offset: -1, timeout: 0 }, { httpTimeoutMs: 5000 });
    if (drain.length) {
      updateOffset = drain[drain.length - 1].update_id + 1;
      saveState();
    }
  } catch (e) {
    process.stderr.write(`[telegram-tg] drain warning: ${e.message}\n`);
  }

  let questionMessageId = null;
  let sentDate = Math.floor(Date.now() / 1000);

  if (!silent) {
    // Send the question.
    const trailer = '';
    const sendPayload = {
      chat_id: config.chat_id,
      text: pm ? `${question}${trailer}` : `❓ ${question}${trailer}`,
    };
    if (pm) sendPayload.parse_mode = pm;
    const sent = await tgApi('sendMessage', sendPayload);
    questionMessageId = sent.message_id;
    sentDate = sent.date;
  }

  // Long-poll for a reply.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingSec = Math.max(1, Math.min(50, Math.floor((deadline - Date.now()) / 1000)));
    let updates;
    try {
      updates = await tgApi('getUpdates', {
        offset: updateOffset,
        timeout: remainingSec,
        allowed_updates: ['message'],
      }, { httpTimeoutMs: (remainingSec + 10) * 1000 });
    } catch (e) {
      process.stderr.write(`[telegram-tg] getUpdates: ${e.message} — retrying\n`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    for (const u of updates) {
      updateOffset = u.update_id + 1;
      saveState();
      const m = u.message;
      if (!m) continue;
      if (String(m.chat.id) !== String(config.chat_id)) continue;
      // Accept any message from the configured chat after our question was sent.
      // (Date check guards against clock-skew weirdness.)
      if (m.date && m.date * 1000 < sentDate * 1000 - 5000) continue;
      const text = m.text || m.caption || '(non-text message)';
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
    description: 'Send a one-way notification to the operator via Telegram. Use when the agent needs human attention (e.g., a VS Code approval is pending, a long task finished, an error needs eyes). Fire-and-forget — does not wait for a reply. Pass parse_mode:"HTML" to use rich formatting.',
    inputSchema: {
      type: 'object',
      properties: {
        text:       { type: 'string', description: 'Notification text. If parse_mode is set, callers must escape per Telegram rules.' },
        parse_mode: PARSE_MODE_SCHEMA,
      },
      required: ['text'],
    },
  },
  {
    name: 'tg_ask',
    description: 'Ask the operator a question via Telegram and BLOCK until they reply. Returns the reply text. Use for confirmations, choices, or clarifications when the agent is uncertain. Pass parse_mode:"HTML" to render bold/code/links in the question. If question is empty or omitted, silently waits for the next message without sending anything (useful for autopilot loops after the initial Ready).',
    inputSchema: {
      type: 'object',
      properties: {
        question:       { type: 'string', description: 'The question to send. If empty or omitted, silently polls for the next message without sending anything.' },
        timeoutSeconds: { type: 'number', description: 'Max seconds to wait for a reply (default 300, max 36000).' },
        parse_mode:     PARSE_MODE_SCHEMA,
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
        if (!args.text) throw new Error('tg_send requires "text".');
        text = await tgSend(String(args.text), args.parse_mode);
      } else if (name === 'tg_ask') {
        text = await tgAsk(args.question ? String(args.question) : '', args.timeoutSeconds, args.parse_mode);
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
