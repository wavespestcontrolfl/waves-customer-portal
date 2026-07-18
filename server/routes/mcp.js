/**
 * MCP read-only knowledge tools (lane C of the knowledge-retrieval scope).
 *
 * A minimal, stateless Model Context Protocol server over streamable HTTP
 * (single JSON responses — no SSE stream, no sessions) exposing the
 * knowledge index to MCP clients (Claude Code sessions, agents). Tools are
 * deliberately thin, READ-ONLY, and LLM-free (the Cerebras pattern): they
 * run one retrieval primitive each and return raw evidence rows — the
 * calling agent does the orchestration. The one model call is the query
 * embedding (pennies; degrades to FTS-only without OPENAI_API_KEY).
 *
 * Auth: machine-to-machine service token (MCP_SERVICE_TOKEN via
 * `Authorization: Bearer` or `X-MCP-Token`), constant-time compare, behind
 * GATE_MCP_READ_TOOLS. Fails closed exactly like hermes-auth: 403 gate off,
 * 503 unconfigured, 401 mismatch. No customer-PII tools live here — the
 * write surface stays IB-only behind write-gates.
 *
 * Hand-rolled JSON-RPC on purpose: three methods (initialize, tools/list,
 * tools/call) don't justify an SDK dependency.
 */

const express = require('express');
const { isEnabled } = require('../config/feature-gates');
const { safeEqual } = require('../middleware/hermes-auth');
const db = require('../models/db');
const logger = require('../services/logger');
const { embedQuery } = require('../services/llm/embed');
const { rrfFuse, applyRecencyDecay } = require('../services/knowledge-index/hybrid-search');
const { toVectorLiteral } = require('../services/knowledge-index/ingest');

const router = express.Router();

const PROTOCOL_VERSION = '2025-03-26';
const MAX_BATCH = 20;
const CHUNK_FETCH_LIMIT = 100;
const MIN_VECTOR_SIMILARITY = 0.30;
const KNOWN_SOURCES = ['wiki', 'kb', 'service', 'protocol', 'lawn_module', 'jurisdiction', 'product_label', 'prep_guide', 'ops_rule', 'resolution'];

function mcpAuth(req, res, next) {
  if (!isEnabled('mcpReadTools')) return res.status(403).json({ error: 'mcp read tools disabled' });
  const expected = process.env.MCP_SERVICE_TOKEN;
  if (!expected) return res.status(503).json({ error: 'mcp not configured' });
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-mcp-token'] || '');
  if (!safeEqual(provided, expected)) return res.status(401).json({ error: 'invalid token' });
  return next();
}

// ── Retrieval primitives ────────────────────────────────────────────

async function searchIndex(query, { sources = null, limit = 10 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { results: [], usedVector: false };
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 25) : 10;
  const sourceFilter = Array.isArray(sources) && sources.length
    ? sources.filter((s) => KNOWN_SOURCES.includes(s))
    : null;

  const applySources = (qb) => (sourceFilter ? qb.whereIn('source', sourceFilter) : qb);
  const key = (r) => `${r.source}:${r.source_id}`;

  const ftsRows = await applySources(
    db('knowledge_embeddings')
      .whereRaw("search_vector @@ websearch_to_tsquery('english', ?)", [q]),
  )
    .select('source', 'source_id', 'title', 'content', 'metadata',
      db.raw("ts_rank(search_vector, websearch_to_tsquery('english', ?)) as rank", [q]))
    .orderBy('rank', 'desc')
    .limit(CHUNK_FETCH_LIMIT);
  const ftsList = ftsRows.map((r) => ({ key: key(r), source: r.source, sourceId: r.source_id, title: r.title, snippet: r.content, metadata: r.metadata }));

  let vectorList = [];
  let usedVector = false;
  const embedded = await embedQuery(q);
  if (embedded.ok) {
    usedVector = true;
    const literal = toVectorLiteral(embedded.vector);
    const rows = await applySources(
      db('knowledge_embeddings')
        .whereNotNull('embedding')
        .whereRaw('1 - (embedding <=> ?::vector) >= ?', [literal, MIN_VECTOR_SIMILARITY]),
    )
      .select('source', 'source_id', 'title', 'content', 'metadata')
      .orderByRaw('embedding <=> ?::vector', [literal])
      .limit(CHUNK_FETCH_LIMIT);
    vectorList = rows.map((r) => ({ key: key(r), source: r.source, sourceId: r.source_id, title: r.title, snippet: r.content, metadata: r.metadata }));
  }

  // Decay observational hits, then re-rank — mirrors hybridKnowledgeSearch:
  // a stale resolution must drop below fresher docs it out-fused.
  const fused = rrfFuse([vectorList, ftsList])
    .map((d) => ({ ...d, score: applyRecencyDecay(d) }))
    .sort((a, b) => b.score - a.score);
  return {
    usedVector,
    results: fused.slice(0, cap).map((d) => ({
      source: d.source,
      sourceId: d.sourceId,
      title: d.title,
      snippet: d.snippet ? String(d.snippet).slice(0, 500) : null,
      score: Number(d.score.toFixed(5)),
    })),
  };
}

async function getService(serviceKey) {
  const row = await db('services')
    .where({ service_key: String(serviceKey || '') })
    .first('service_key', 'name', 'short_name', 'description', 'category', 'subcategory', 'billing_type', 'frequency', 'visits_per_year', 'is_active', 'is_archived');
  return row || { error: 'service not found' };
}

function getProtocol(protocolKey) {
   
  const protocols = require('../config/protocols.json');
  const node = String(protocolKey || '').split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), protocols);
  if (!node || !Array.isArray(node.visits)) return { error: 'protocol not found', availableExamples: ['pest', 'termite', 'lawn.st_augustine', 'tree_shrub'] };
  return node;
}

async function listSources() {
  const rows = await db('knowledge_embeddings')
    .select('source')
    .count('id as chunks')
    .max('updated_at as last_updated')
    .groupBy('source')
    .orderBy('source');
  return { sources: rows.map((r) => ({ source: r.source, chunks: parseInt(r.chunks, 10), lastUpdated: r.last_updated })) };
}

// ── Tool registry ───────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: 'search_knowledge',
    description: 'Hybrid (semantic + full-text) search over the Waves knowledge index: agronomic wiki, curated KB, services, protocols, product-label compliance summaries, county fertilizer rules, prep guides, ops rules, and past-resolution memory. Returns raw evidence rows.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up' },
        sources: { type: 'array', items: { type: 'string', enum: KNOWN_SOURCES }, description: 'Optional source filter' },
        limit: { type: 'number', description: 'Max documents (default 10, cap 25)' },
      },
      required: ['query'],
    },
    execute: (args) => searchIndex(args.query, { sources: args.sources, limit: args.limit || 10 }),
  },
  {
    name: 'search_resolutions',
    description: 'Search ONLY the past-resolution memory (PII-redacted distillations of how Waves actually handled previous calls and visits). Answers "how did we handle X before".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The situation to look up' },
        limit: { type: 'number', description: 'Max documents (default 10, cap 25)' },
      },
      required: ['query'],
    },
    execute: (args) => searchIndex(args.query, { sources: ['resolution'], limit: args.limit || 10 }),
  },
  {
    name: 'get_service',
    description: 'Fetch one catalog service by service_key (name, description, category, frequency).',
    inputSchema: {
      type: 'object',
      properties: { service_key: { type: 'string' } },
      required: ['service_key'],
    },
    execute: (args) => getService(args.service_key),
  },
  {
    name: 'get_protocol',
    description: "Fetch one treatment protocol from the static protocol config by dotted key (e.g. 'pest', 'termite', 'lawn.st_augustine').",
    inputSchema: {
      type: 'object',
      properties: { protocol_key: { type: 'string' } },
      required: ['protocol_key'],
    },
    execute: (args) => getProtocol(args.protocol_key),
  },
  {
    name: 'list_sources',
    description: 'List the knowledge-index corpora with chunk counts and last-updated timestamps.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => listSources(),
  },
];

async function executeMcpTool(name, args = {}) {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `unknown tool: ${name}` };
  try {
    return await tool.execute(args || {});
  } catch (err) {
    logger.error(`[mcp] tool ${name} failed: ${err.message}`);
    return { error: 'tool execution failed' };
  }
}

// ── JSON-RPC plumbing ───────────────────────────────────────────────

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

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
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'waves-knowledge', version: '1.0.0' },
      });
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const result = await executeMcpTool(params?.name, params?.arguments);
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

// Body parsing: the app-level express.json (server/index.js) has already
// parsed req.body by the time this router runs — do not add a second parser.
router.post('/', mcpAuth, async (req, res) => {
  const body = req.body;
  try {
    if (Array.isArray(body)) {
      if (body.length === 0) {
        return res.status(200).json(rpcError(null, -32600, 'empty batch'));
      }
      if (body.length > MAX_BATCH) {
        return res.status(200).json(rpcError(null, -32600, `batch too large (max ${MAX_BATCH})`));
      }
      const responses = (await Promise.all(body.map(handleRpc))).filter(Boolean);
      return responses.length ? res.json(responses) : res.status(202).end();
    }
    const response = await handleRpc(body);
    return response ? res.json(response) : res.status(202).end();
  } catch (err) {
    logger.error(`[mcp] rpc failed: ${err.message}`);
    return res.status(200).json(rpcError(body?.id ?? null, -32603, 'internal error'));
  }
});

// Stateless server: no SSE stream to offer.
router.get('/', mcpAuth, (req, res) => res.status(405).json({ error: 'streaming not supported; POST JSON-RPC' }));

module.exports = router;
module.exports.executeMcpTool = executeMcpTool;
module.exports.handleRpc = handleRpc;
module.exports.MCP_TOOLS = MCP_TOOLS;
