#!/usr/bin/env node
// READ-ONLY: stdio ↔ HTTP bridge for the portal's MCP knowledge server
// (`/api/mcp`). Lets any stdio-transport MCP client talk to the read-only
// knowledge tools. Claude Code registration:
//
//   claude mcp add waves-knowledge \
//     --env MCP_SERVICE_TOKEN=<token> \
//     -- node ops/agents/mcp-stdio.js
//
// Reads newline-delimited JSON-RPC on stdin, forwards each message to
// WAVES_MCP_URL (default https://portal.wavespestcontrol.com/api/mcp) with
// MCP_SERVICE_TOKEN as the bearer credential, and writes each response to
// stdout. Notifications (HTTP 202, empty body) produce no output, per the
// stdio transport contract. The endpoint itself is read-only and gated
// (GATE_MCP_READ_TOOLS) — this wrapper adds no capability beyond it.

const MCP_URL = process.env.WAVES_MCP_URL || 'https://portal.wavespestcontrol.com/api/mcp';
const TOKEN = process.env.MCP_SERVICE_TOKEN;
const REQUEST_TIMEOUT_MS = 30000;

if (!TOKEN) {
  console.error('MCP_SERVICE_TOKEN is not set — the portal endpoint 503s/401s without it.');
  process.exit(1);
}

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function forward(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return write(rpcError(null, -32700, 'parse error'));
  }
  const id = Array.isArray(message) ? null : message?.id ?? null;
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 202) return null; // notification accepted — nothing to emit
    const body = await res.text();
    if (!res.ok) {
      return write(rpcError(id, -32000, `portal mcp ${res.status}: ${body.slice(0, 200)}`));
    }
    return write(JSON.parse(body));
  } catch (err) {
    return write(rpcError(id, -32603, `bridge failure: ${err.message}`));
  }
}

// Process messages strictly in arrival order — MCP clients assume ordered
// responses on stdio.
let buffer = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) queue = queue.then(() => forward(line));
  }
});
// Natural shutdown once the queue drains — process.exit() here could
// truncate a final response still buffered in stdout.
process.stdin.on('end', () => queue.then(() => { process.exitCode = 0; }));
