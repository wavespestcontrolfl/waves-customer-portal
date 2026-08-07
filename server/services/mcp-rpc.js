/**
 * Shared MCP JSON-RPC plumbing — one implementation of the stateless
 * single-response wire protocol (initialize / ping / tools/list /
 * tools/call, notifications, batches) used by BOTH MCP routes:
 *
 *   - /api/mcp        (routes/mcp.js — machine-auth knowledge tools)
 *   - /api/public/mcp (routes/public-mcp.js — anonymous public tools)
 *
 * Extracted from routes/mcp.js verbatim so the two servers cannot drift
 * into two divergent parsers of one syntax. Behavior is pinned by
 * tests/mcp-route.test.js (existing surface) and tests/public-mcp.test.js.
 */

const logger = require('./logger');

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function createMcpRpc({ tools, serverInfo, protocolVersion, logPrefix = 'mcp' }) {
  async function executeTool(name, args = {}) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { error: `unknown tool: ${name}` };
    try {
      return await tool.execute(args || {});
    } catch (err) {
      logger.error(`[${logPrefix}] tool ${name} failed: ${err.message}`);
      return { error: 'tool execution failed' };
    }
  }

  async function handleRpc(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id ?? null, -32600, 'invalid request');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    // JSON-RPC: notifications execute but are never answered.
    const respond = (result) => (isNotification ? null : rpcResult(id, result));

    switch (method) {
      case 'initialize':
        return respond({
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo,
        });
      case 'ping':
        return respond({});
      case 'tools/list':
        return respond({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const result = await executeTool(params?.name, params?.arguments);
        return respond({
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: Boolean(result && result.error),
        });
      }
      default:
        if (isNotification) return null; // notifications/initialized etc. — accepted silently
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  }

  function createPostHandler({ maxBatch, maxBatchToolCalls }) {
    return async (req, res) => {
      const body = req.body;
      try {
        if (Array.isArray(body)) {
          if (body.length === 0) {
            return res.status(200).json(rpcError(null, -32600, 'empty batch'));
          }
          if (body.length > maxBatch) {
            return res.status(200).json(rpcError(null, -32600, `batch too large (max ${maxBatch})`));
          }
          const toolCalls = body.filter((m) => m && m.method === 'tools/call').length;
          if (toolCalls > maxBatchToolCalls) {
            return res.status(200).json(rpcError(null, -32600, `too many tools/call in batch (max ${maxBatchToolCalls})`));
          }
          // Sequential on purpose: one request must not run tools in parallel
          // and multiply DB load past what a single call costs.
          const responses = [];
          for (const message of body) {
            const response = await handleRpc(message);
            if (response) responses.push(response);
          }
          return responses.length ? res.json(responses) : res.status(202).end();
        }
        const response = await handleRpc(body);
        return response ? res.json(response) : res.status(202).end();
      } catch (err) {
        logger.error(`[${logPrefix}] rpc failed: ${err.message}`);
        return res.status(200).json(rpcError(body?.id ?? null, -32603, 'internal error'));
      }
    };
  }

  return { executeTool, handleRpc, createPostHandler };
}

// Turns body-parser failures into JSON-RPC shapes. Mounted after the capped
// express.json() in each route's pre-parser chain.
function createBodyErrorHandler({ limitLabel }) {
  return (err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json(rpcError(null, -32600, `payload too large (max ${limitLabel})`));
    }
    if (err && err.status === 400) {
      return res.status(200).json(rpcError(null, -32700, 'parse error'));
    }
    return next(err);
  };
}

module.exports = { createMcpRpc, createBodyErrorHandler, rpcResult, rpcError };
