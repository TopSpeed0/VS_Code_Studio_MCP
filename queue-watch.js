#!/usr/bin/env node
// queue-watch.js — Zero-dependency queue watcher for the Hermes ↔ VS Code hybrid.
//
// Polls .vscode-queue.json every POLL_INTERVAL_MS and sends a Telegram notification
// when the task status changes to "done" or "error". Also detects a dead/missing
// worker and alerts you to restart it. Then exits.
//
// Usage:
//   node queue-watch.js
//   node queue-watch.js --interval 5000     (poll every 5s, default: 10s)
//   node queue-watch.js --timeout 120000    (dead-worker alert after 2min, default: 120s)
//   node queue-watch.js --queue /path/to/.vscode-queue.json
//
// Config (same as telegram-tg.js — first match wins):
//   1. Env vars: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   2. File: .telegram-config in cwd

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ---------- Args ----------
const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const QUEUE_FILE         = get('--queue')    || path.join(process.cwd(), '.vscode-queue.json');
const POLL_INTERVAL_MS   = parseInt(get('--interval') || '10000', 10);
const DEAD_WORKER_MS     = parseInt(get('--timeout')  || '120000', 10);

// ---------- Config ----------
function loadConfig() {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return { bot_token: process.env.TELEGRAM_BOT_TOKEN, chat_id: process.env.TELEGRAM_CHAT_ID };
  }
  const cfgPath = path.join(process.cwd(), '.telegram-config');
  if (!fs.existsSync(cfgPath)) {
    throw new Error('No Telegram config. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID or create .telegram-config');
  }
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

// ---------- Telegram ----------
function tgSend(cfg, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: cfg.chat_id, text, parse_mode: 'HTML' });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${cfg.bot_token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------- Queue ----------
function readQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); }
  catch { return null; }
}

// ---------- Format message ----------
function formatDone(q) {
  return `✅ <b>Task done</b> [${q.id}]\n\n${q.result || '(no result)'}`;
}
function formatError(q) {
  return `❌ <b>Task error</b> [${q.id}]\n\n${q.error || '(no error message)'}`;
}
function formatDeadWorker(q) {
  return (
    `⚠️ <b>Worker not responding</b> — task <code>${q.id}</code> has been pending for ` +
    `${Math.round(DEAD_WORKER_MS / 60000)} minute(s).\n\n` +
    `Open VS Code → Copilot Chat → type:\n` +
    `<code>@vscode-worker start worker</code>\n\n` +
    `The worker will pick up the existing task automatically.`
  );
}

// ---------- Main ----------
async function main() {
  let cfg;
  try { cfg = loadConfig(); }
  catch (e) { console.error(e.message); process.exit(1); }

  const initial      = readQueue();
  const watchId      = initial?.id || null;
  const startedAt    = Date.now();
  let   deadAlertSent = false;

  console.log(`👀 Watching : ${QUEUE_FILE}`);
  console.log(`📋 Task ID  : ${watchId || '(waiting for task)'}`);
  console.log(`⏱  Interval : ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`⏰ Dead alert: after ${DEAD_WORKER_MS / 1000}s of pending`);
  console.log('Press Ctrl+C to stop.\n');

  const interval = setInterval(async () => {
    const q = readQueue();
    if (!q) return;

    // Only react to the task we started watching
    if (watchId && q.id !== watchId) return;

    const elapsed = Date.now() - startedAt;

    if (q.status === 'done') {
      clearInterval(interval);
      console.log(`[${new Date().toISOString()}] ✅ Done — notifying...`);
      await tgSend(cfg, formatDone(q)).catch(e => console.error('Telegram error:', e.message));
      process.exit(0);
    }

    if (q.status === 'error') {
      clearInterval(interval);
      console.log(`[${new Date().toISOString()}] ❌ Error — notifying...`);
      await tgSend(cfg, formatError(q)).catch(e => console.error('Telegram error:', e.message));
      process.exit(0);
    }

    // Dead worker detection — pending too long
    if (q.status === 'pending' && elapsed >= DEAD_WORKER_MS && !deadAlertSent) {
      deadAlertSent = true;
      console.log(`[${new Date().toISOString()}] ⚠️ Dead worker detected — alerting...`);
      await tgSend(cfg, formatDeadWorker(q)).catch(e => console.error('Telegram error:', e.message));
      clearInterval(interval);
      process.exit(0);
    }

    console.log(`[${new Date().toISOString()}] status: ${q.status} (${Math.round(elapsed / 1000)}s elapsed)`);
  }, POLL_INTERVAL_MS);
}

main();
