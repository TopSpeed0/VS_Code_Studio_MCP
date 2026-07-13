#!/usr/bin/env node
// vscode-queue.js — MCP server that bridges Hermes → VS Code Copilot.
//
// Hermes writes tasks to .vscode-queue.json via its native file tools.
// This MCP server exposes tools to VS Code Copilot so it can:
//   queue_poll   — block until a pending task appears (like tg_ask but for the queue)
//   queue_done   — mark the current task as done with a result
//   queue_error  — mark the current task as failed with an error message
//
// Protocol: JSON-RPC 2.0 over stdio (MCP 2024-11-05).
// Zero dependencies — pure Node.js.

'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const QUEUE_PATH = path.join(process.cwd(), '.vscode-queue.json');
const POLL_INTERVAL_MS = 500;
const MAX_TIMEOUT_S = 7200; // 2 hours max

// ---------- Queue file helpers ----------

function readQueue() {
  try {
    if (!fs.existsSync(QUEUE_PATH)) return null;
    const raw = fs.readFileSync(QUEUE_PATH, 'utf-8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeQueue(task) {
  task.updated = new Date().toISOString();
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(task, null, 2) + '\n', { mode: 0o600 });
}

// ---------- JSON-RPC helpers ----------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ---------- MCP tool definitions ----------

const TOOLS = [
  {
    name: 'queue_poll',
    description:
      'Block until a task from Hermes appears in the queue. Returns the task ' +
      'description. If no task arrives within timeoutSeconds, returns a timeout ' +
      'message. Once a task is picked up, its status changes to "working".',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutSeconds: {
          type: 'number',
          description: 'Max seconds to wait for a task (default 1800, max 7200).',
        },
      },
    },
  },
  {
    name: 'queue_done',
    description:
      'Mark the current task as completed. Hermes will read the result from the ' +
      'queue file and send it to Telegram.',
    inputSchema: {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          description: 'Summary of what was done — this goes back to Hermes and then to Telegram.',
        },
      },
      required: ['result'],
    },
  },
  {
    name: 'queue_error',
    description:
      'Mark the current task as failed. Hermes will read the error and report it.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Error description.',
        },
      },
      required: ['message'],
    },
  },
];

// ---------- Tool handlers ----------

async function handleQueuePoll(args) {
  const timeout = Math.min(Math.max((args.timeoutSeconds || 1800), 1), MAX_TIMEOUT_S);
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    const task = readQueue();
    if (task && task.status === 'pending') {
      // Claim it
      task.status = 'working';
      writeQueue(task);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              id: task.id,
              task: task.task,
              context: task.context || null,
              created: task.created,
            }),
          },
        ],
      };
    }
    // Sleep before next poll
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return {
    content: [{ type: 'text', text: '{"timeout": true, "message": "No task arrived within the timeout period."}' }],
  };
}

function handleQueueDone(args) {
  const task = readQueue();
  if (!task || (task.status !== 'working' && task.status !== 'pending')) {
    return {
      content: [{ type: 'text', text: '{"error": "No active task to complete."}' }],
    };
  }
  task.status = 'done';
  task.result = args.result || '(no result provided)';
  writeQueue(task);
  return {
    content: [{ type: 'text', text: `{"ok": true, "id": "${task.id}", "status": "done"}` }],
  };
}

function handleQueueError(args) {
  const task = readQueue();
  if (!task || (task.status !== 'working' && task.status !== 'pending')) {
    return {
      content: [{ type: 'text', text: '{"error": "No active task to mark as failed."}' }],
    };
  }
  task.status = 'error';
  task.result = args.message || '(no error message provided)';
  writeQueue(task);
  return {
    content: [{ type: 'text', text: `{"ok": true, "id": "${task.id}", "status": "error"}` }],
  };
}

// ---------- MCP message handler ----------

async function handleMessage(msg) {
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'vscode-queue', version: '1.0.0' },
      capabilities: { tools: {} },
    });
    return;
  }

  if (msg.method === 'notifications/initialized') return; // no-op

  if (msg.method === 'tools/list') {
    reply(msg.id, { tools: TOOLS });
    return;
  }

  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    try {
      let result;
      switch (name) {
        case 'queue_poll':  result = await handleQueuePoll(args); break;
        case 'queue_done':  result = handleQueueDone(args); break;
        case 'queue_error': result = handleQueueError(args); break;
        default:
          error(msg.id, -32601, `Unknown tool: ${name}`);
          return;
      }
      reply(msg.id, result);
    } catch (e) {
      error(msg.id, -32603, `Tool error: ${e.message}`);
    }
    return;
  }

  // Unknown method
  if (msg.id != null) {
    error(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// ---------- stdio transport ----------

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (e) {
    process.stderr.write(`[vscode-queue] bad JSON: ${e.message}\n`);
    return;
  }
  handleMessage(msg).catch((e) => {
    process.stderr.write(`[vscode-queue] handler error: ${e.message}\n`);
    if (msg && msg.id != null) error(msg.id, -32603, e.message);
  });
});

process.stdin.on('end', () => process.exit(0));
process.stderr.write('[vscode-queue] MCP server started — waiting for tasks from Hermes.\n');
