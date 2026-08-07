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
// A single batch may fan out to at most this many tools/call executions —
// each search can spend an embedding call, so the batch must not multiply
// the per-request budget the /api limiter assumes.
const MAX_BATCH_TOOL_CALLS = 5;
// Query-embedding budget: well inside the stdio bridge's 30s request
// timeout, so a slow embeddings API degrades to FTS-only instead of the
// bridge aborting the whole search.
const EMBED_TIMEOUT_MS = 8000;
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
  const embedded = await embedQuery(q, { timeoutMs: EMBED_TIMEOUT_MS });
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
  // Active catalog only — mirrors the knowledge-index service connector, so
  // a known key can't resurface retired/archived service guidance here.
  const row = await db('services')
    .where({ service_key: String(serviceKey || ''), is_active: true, is_archived: false })
    .first('service_key', 'name', 'short_name', 'description', 'category', 'subcategory', 'billing_type', 'frequency', 'visits_per_year');
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

// ── JSON-RPC plumbing (shared with /api/public/mcp — services/mcp-rpc.js) ──

const { createMcpRpc, createBodyErrorHandler } = require('../services/mcp-rpc');

const rpc = createMcpRpc({
  tools: MCP_TOOLS,
  serverInfo: { name: 'waves-knowledge', version: '1.0.0' },
  protocolVersion: PROTOCOL_VERSION,
  logPrefix: 'mcp',
});
const executeMcpTool = rpc.executeTool;
const handleRpc = rpc.handleRpc;

// Body parsing: server/index.js mounts mcpPreParsers (below) on /api/mcp
// BEFORE the legacy 50 MB global parsers — auth runs first, then a small
// capped parse, so unauthenticated callers can't force large JSON parse
// work (same pattern as staff auth). mcpAuth also runs here so the router
// stays fail-closed even if mounted without the pre-chain.
router.post('/', mcpAuth, rpc.createPostHandler({ maxBatch: MAX_BATCH, maxBatchToolCalls: MAX_BATCH_TOOL_CALLS }));

// Stateless server: no SSE stream to offer.
router.get('/', mcpAuth, (req, res) => res.status(405).json({ error: 'streaming not supported; POST JSON-RPC' }));

// Mounted by server/index.js on /api/mcp AHEAD of the 50 MB global body
// parsers: authenticate first, then parse with a small cap. The trailing
// error handler turns parser failures into JSON-RPC shapes (auth has
// already passed by the time they can fire).
const mcpBodyErrorHandler = createBodyErrorHandler({ limitLabel: '256kb' });
const mcpPreParsers = [mcpAuth, express.json({ limit: '256kb' }), mcpBodyErrorHandler];

module.exports = router;
module.exports.executeMcpTool = executeMcpTool;
module.exports.handleRpc = handleRpc;
module.exports.MCP_TOOLS = MCP_TOOLS;
module.exports.mcpPreParsers = mcpPreParsers;
