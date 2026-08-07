/**
 * /api/public/a2a — anonymous, READ-ONLY A2A (Agent2Agent protocol)
 * endpoint: the service behind the hub's /.well-known/agent-card.json.
 *
 * A deliberately minimal conforming A2A server: `message/send` returns ONE
 * deterministic informational Message (who Waves is, where the
 * machine-readable surfaces live, how to request a quote) — no tasks, no
 * streaming, no push notifications, no conversation state, and NO
 * generative LLM calls by construction (an anonymous surface must never
 * spend model tokens or emit un-reviewed copy; the reply is a static
 * compliance-reviewed template). Agents wanting real data are pointed at
 * the public MCP server (/api/public/mcp) and the published pricing/quote
 * surfaces.
 *
 * Guards mirror /api/public/mcp exactly (see AGENTS.md public-route
 * allowlist): GATE_A2A_PUBLIC (404 dark until deliberately flipped),
 * per-client rate limit via the shared /64-collapsing key, 64kb body cap
 * mounted ahead of the global parsers, GET → 405. No customer-PII tools
 * and no write behavior may be added here.
 */

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');
const { isEnabled } = require('../config/feature-gates');
const logger = require('../services/logger');
const { createBodyErrorHandler, rpcResult, rpcError } = require('../services/mcp-rpc');

const router = express.Router();

const HUB_URL = 'https://www.wavespestcontrol.com';
const PORTAL_URL = 'https://portal.wavespestcontrol.com';

// A2A-specific JSON-RPC error code (spec: UnsupportedOperationError) for
// methods the protocol defines but this informational server does not offer.
const A2A_UNSUPPORTED = -32004;
const UNSUPPORTED_METHODS = new Set([
  'message/stream', 'tasks/get', 'tasks/cancel', 'tasks/resubscribe',
  'tasks/pushNotificationConfig/set', 'tasks/pushNotificationConfig/get',
  'tasks/pushNotificationConfig/list', 'tasks/pushNotificationConfig/delete',
]);

// The one reply this agent ever sends. Static and compliance-reviewed —
// edits here are customer/agent-facing copy and follow the content rules
// (no safety/re-entry claims, company name "Waves Pest Control").
const INFO_TEXT = [
  'Waves Pest Control is a family-owned, FDACS-licensed (JB351547) pest control and lawn care company serving Manatee, Sarasota, and Charlotte counties in Southwest Florida. Phone: (941) 297-5749.',
  '',
  'This A2A endpoint is informational only — it does not hold conversations or take actions. For structured data, connect an MCP client to the public Waves MCP server:',
  `- MCP server (streamable HTTP, no auth): ${PORTAL_URL}/api/public/mcp`,
  `- Server card: ${HUB_URL}/.well-known/mcp/server-card.json`,
  `- Published price ranges: ${HUB_URL}/pricing.md (JSON: ${PORTAL_URL}/api/public/pricing-ranges)`,
  `- Site guide for agents: ${HUB_URL}/llms.txt`,
  '',
  "To request an exact per-property quote, call the MCP tool how_to_request_quote for the current HTTP contract — it requires the customer's contact details and consent.",
  `Humans can get a quote at ${HUB_URL}/pest-control-quote/ or by calling (941) 297-5749.`,
].join('\n');

function publicA2aGate(req, res, next) {
  if (!isEnabled('a2aPublic')) return res.status(404).json({ error: 'not found' });
  return next();
}

const publicA2aLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: unauthenticatedAuthLimitKey,
  message: { error: 'rate limit exceeded — try again later' },
});

function infoMessage() {
  return {
    kind: 'message',
    role: 'agent',
    messageId: crypto.randomUUID(),
    parts: [{ kind: 'text', text: INFO_TEXT }],
  };
}

// A2A JSON-RPC ids must be strings or integers — booleans, objects, arrays,
// and fractional numbers break client response correlation.
function isValidRpcId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id));
}

// Minimal MessageSendParams validation: params.message must be an object
// with a string role and a non-empty parts array. Malformed input gets
// -32602 so conformance checks can tell a rejected request from an
// accepted one.
function isValidMessageSendParams(params) {
  const m = params && typeof params === 'object' ? params.message : null;
  return Boolean(m && typeof m === 'object' && !Array.isArray(m)
    && typeof m.role === 'string' && Array.isArray(m.parts) && m.parts.length > 0);
}

function handleA2aRpc(message) {
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message && !Array.isArray(message) && isValidRpcId(message.id) ? message.id : null, -32600, 'invalid request');
  }
  const { id, method, params } = message;
  // A2A has no notification methods — every request must carry a valid id.
  if (!isValidRpcId(id)) {
    return rpcError(null, -32600, 'invalid request: id must be a string or integer');
  }
  if (method === 'message/send') {
    if (!isValidMessageSendParams(params)) {
      return rpcError(id, -32602, 'invalid params: message/send requires params.message with role and non-empty parts');
    }
    return rpcResult(id, infoMessage());
  }
  if (UNSUPPORTED_METHODS.has(method)) {
    return rpcError(id, A2A_UNSUPPORTED, `unsupported operation: ${method} (informational agent — message/send only)`);
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

router.post('/', publicA2aGate, (req, res) => {
  try {
    return res.json(handleA2aRpc(req.body));
  } catch (err) {
    logger.error(`[public-a2a] rpc failed: ${err.message}`);
    return res.status(200).json(rpcError(req.body?.id ?? null, -32603, 'internal error'));
  }
});

// No SSE / streaming transport.
router.get('/', publicA2aGate, (req, res) => res.status(405).json({ error: 'streaming not supported; POST JSON-RPC' }));

const publicA2aBodyErrorHandler = createBodyErrorHandler({ limitLabel: '64kb' });
const publicA2aPreParsers = [publicA2aGate, publicA2aLimiter, express.json({ limit: '64kb' }), publicA2aBodyErrorHandler];

module.exports = router;
module.exports.publicA2aPreParsers = publicA2aPreParsers;
module.exports.handleA2aRpc = handleA2aRpc;
module.exports.INFO_TEXT = INFO_TEXT;
