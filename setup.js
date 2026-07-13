#!/usr/bin/env node
// setup.js — One-shot interactive installer for telegram-vscode-mcp.
// Zero dependencies. Run: `node setup.js` or `npm run setup`.
//
// What it does:
//   1. Asks for your Telegram bot token (with format validation).
//   2. Validates the token by calling getMe.
//   3. Detects your chat ID automatically (asks you to send a message
//      to the bot), or accepts a manual numeric chat_id.
//   4. Writes .telegram-config (gitignored, mode 0600).
//   5. Sends a confirmation message to your Telegram.
//   6. Prints next steps.

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, '.telegram-config');

// Auto-respawn with --use-system-ca if not already set.
// This trusts the OS certificate store (Windows/macOS), which corporate TLS
// proxies (e.g. Zscaler, Netskope, BlueCoat) inject their root into.
// Requires Node 22.10+. On older Node, fall through and let normal errors surface.
if (!process.env.__TGMCP_SYSCA && !process.execArgv.includes('--use-system-ca')) {
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  const nodeMinor = parseInt(process.versions.node.split('.')[1], 10);
  const supportsFlag = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 10);
  if (supportsFlag) {
    const r = spawnSync(process.execPath, ['--use-system-ca', __filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, __TGMCP_SYSCA: '1' },
    });
    process.exit(r.status == null ? 1 : r.status);
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

function tg(token, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) return reject(new Error(parsed.description || data));
          resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function log(msg) { process.stdout.write(msg + '\n'); }
function ok(msg)  { log(`\x1b[32m✓\x1b[0m ${msg}`); }
function info(m)  { log(`\x1b[36mℹ\x1b[0m ${m}`); }
function warn(m)  { log(`\x1b[33m!\x1b[0m ${m}`); }
function err(m)   { log(`\x1b[31m✗\x1b[0m ${m}`); }

async function main() {
  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('  telegram-vscode-mcp — Interactive Setup');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('');

  if (fs.existsSync(CONFIG_PATH)) {
    warn(`.telegram-config already exists at ${CONFIG_PATH}`);
    const overwrite = (await ask('Overwrite? [y/N] ')).toLowerCase();
    if (overwrite !== 'y' && overwrite !== 'yes') {
      info('Aborted. Existing config preserved.');
      rl.close();
      return;
    }
  }

  log('');
  info('Step 1/3 — Telegram Bot Token');
  info('Get one from @BotFather: https://t.me/BotFather  →  /newbot');
  let token = '';
  let me = null;
  while (!me) {
    token = await ask('Paste your bot token: ');
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
      err('That does not look like a bot token (expected "<digits>:<long-string>"). Try again.');
      continue;
    }
    try {
      me = await tg(token, 'getMe');
      ok(`Bot verified: @${me.username} (${me.first_name})`);
    } catch (e) {
      err(`Token rejected by Telegram: ${e.message}`);
      if (/local issuer certificate|self.signed|CERT_|unable to verify/i.test(e.message)) {
        log('');
        warn('Looks like a TLS/certificate issue (often a corporate proxy).');
        warn('Try one of these and re-run setup:');
        warn('  1. Upgrade Node to 22.10+ (this script auto-uses the OS cert store on 22.10+).');
        warn('  2. Set NODE_EXTRA_CA_CERTS to your proxy root cert (PEM):');
        warn('       PowerShell: $env:NODE_EXTRA_CA_CERTS="C:\\path\\to\\corp-root.pem"');
        warn('       bash:       export NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem');
        warn('  3. Last resort (NOT for shared machines):');
        warn('       $env:NODE_TLS_REJECT_UNAUTHORIZED="0"   # disables ALL TLS verification');
        log('');
      }
      me = null;
    }
  }

  log('');
  info('Step 2/3 — Your Telegram Chat ID');
  info(`Option A: Open https://t.me/${me.username}, click START, then send any message (e.g. "hi").`);
  info('Option B: Enter a numeric chat ID manually.');
  log('');

  let chatId = '';
  const mode = (await ask('Auto-detect by reading recent messages? [Y/n] ')).toLowerCase();
  if (mode === 'n' || mode === 'no') {
    while (!/^-?\d+$/.test(chatId)) {
      chatId = await ask('Numeric chat ID: ');
      if (!/^-?\d+$/.test(chatId)) err('Must be an integer.');
    }
  } else {
    info(`Send any message to @${me.username} now, then press Enter here.`);
    await ask('');
    try {
      const updates = await tg(token, 'getUpdates', { offset: -10, timeout: 0 });
      const candidates = [];
      const seen = new Set();
      for (const u of updates) {
        const m = u.message || u.edited_message || u.channel_post;
        if (!m || !m.chat) continue;
        const key = String(m.chat.id);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          id: m.chat.id,
          type: m.chat.type,
          title: m.chat.title
            || `${m.chat.first_name || ''} ${m.chat.last_name || ''}`.trim()
            || m.chat.username
            || '(unknown)',
        });
      }
      if (candidates.length === 0) {
        warn('No recent messages found. Make sure you clicked START and sent a message to the bot.');
        info('Falling back to manual entry.');
        while (!/^-?\d+$/.test(chatId)) {
          chatId = await ask('Numeric chat ID: ');
          if (!/^-?\d+$/.test(chatId)) err('Must be an integer.');
        }
      } else if (candidates.length === 1) {
        chatId = String(candidates[0].id);
        ok(`Detected chat: ${candidates[0].title} (${candidates[0].type}, id=${chatId})`);
      } else {
        log('Multiple chats found:');
        candidates.forEach((c, i) => log(`  [${i + 1}] ${c.title} (${c.type}, id=${c.id})`));
        let pick = -1;
        while (pick < 1 || pick > candidates.length) {
          const ans = await ask(`Pick [1-${candidates.length}]: `);
          pick = parseInt(ans, 10);
        }
        chatId = String(candidates[pick - 1].id);
        ok(`Selected: ${candidates[pick - 1].title} (id=${chatId})`);
      }
    } catch (e) {
      err(`getUpdates failed: ${e.message}`);
      warn('If you see "Conflict: terminated by other getUpdates request",');
      warn('another process is already polling this bot. Stop it and re-run setup.');
      while (!/^-?\d+$/.test(chatId)) {
        chatId = await ask('Numeric chat ID (manual): ');
        if (!/^-?\d+$/.test(chatId)) err('Must be an integer.');
      }
    }
  }

  log('');
  info('Step 3/3 — Writing config');
  const cfg = {
    chat_id: chatId,
    tokens: [{ name: 'VS_Code', key: token }]
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  ok(`Wrote ${CONFIG_PATH}`);

  log('');
  info('Sending a confirmation message to your Telegram...');
  try {
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: '<b>✅ telegram-vscode-mcp setup complete.</b>\n\nReply to this chat once you start the autopilot loop in VS Code.',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    ok('Message sent. Check your Telegram.');
  } catch (e) {
    err(`Failed to send confirmation: ${e.message}`);
  }

  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('  Next steps');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('');
  log('  1. Open this folder in VS Code (or merge .vscode/mcp.json');
  log('     into your existing workspace).');
  log('  2. Reload the window. Run command: "MCP: List Servers"');
  log('     and confirm "telegram-tg" is running.');
  log('  3. Open Copilot Chat -> switch to Agent mode -> type:');
  log('     @telegram-autopilot start autopilot');
  log('');
  log('  Reply "stop" from Telegram to exit the loop.');
  log('');

  rl.close();
}

main().catch((e) => {
  err(`Setup failed: ${e.message}`);
  rl.close();
  process.exit(1);
});
