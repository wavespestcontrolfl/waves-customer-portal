/**
 * /api/public/mcp — anonymous, READ-ONLY public MCP server for AI agents.
 *
 * The agent-facing discovery surface behind the hub's Level-4 agent-readiness
 * cards (/.well-known/mcp/server-card.json on wavespestcontrol.com points
 * here). Stateless single-response JSON-RPC over HTTP — same wire protocol
 * as /api/mcp, via the shared services/mcp-rpc.js plumbing — but a disjoint,
 * deliberately public tool registry:
 *
 *   - NO auth by design (the audience is anonymous third-party AI agents);
 *     the surface is guarded by GATE_MCP_PUBLIC (404 when off — dark until
 *     deliberately flipped), a per-IP rate limit, a 64kb body cap, and the
 *     same batch caps as /api/mcp.
 *   - Tools are READ-ONLY, side-effect-free, and expose ONLY data that is
 *     already public elsewhere: the customer-visible service catalog, the
 *     agent-readable pricing ranges (same producer as
 *     /api/public/pricing-ranges and /pricing.md), the service-area list
 *     (same table as /api/public/service-areas), and the documented HTTP
 *     contract of the existing public quote endpoint.
 *   - NO customer-PII tools and NO write tools may be added here. Exact
 *     per-property quotes deliberately stay on POST
 *     /api/public/quote/calculate with its four-field contact gate — the
 *     `how_to_request_quote` tool documents that contract instead of
 *     wrapping it, so lead capture keeps every existing guard (honeypot,
 *     rate limits, contact gate) and this surface stays pure-read.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { isEnabled } = require('../config/feature-gates');
const db = require('../models/db');
const logger = require('../services/logger');
const { createMcpRpc, createBodyErrorHandler } = require('../services/mcp-rpc');
const { getPublicPricingRangesResult } = require('./public-pricing-ranges');
const { PUBLIC_QUOTE_SERVICE_KEYS } = require('./public-quote');

const router = express.Router();

const PROTOCOL_VERSION = '2025-03-26';
const MAX_BATCH = 20;
const MAX_BATCH_TOOL_CALLS = 5;

const HUB_URL = 'https://www.wavespestcontrol.com';
const PORTAL_URL = 'https://portal.wavespestcontrol.com';
const COMPANY_PHONE = '(941) 297-5749';

// Dark ship: the route 404s (indistinguishable from not existing) until
// GATE_MCP_PUBLIC is deliberately flipped in an environment. 404 — not the
// machine-auth route's 403 — because an anonymous public surface should be
// invisible while dark (same idiom as the GrowthBook exposure intake).
function publicMcpGate(req, res, next) {
  if (!isEnabled('mcpPublic')) return res.status(404).json({ error: 'not found' });
  return next();
}

// Per-IP budget for anonymous agents. Tools are cheap reads (catalog rows,
// memoized pricing payload), so this bounds abuse without starving a real
// agent session; the batch caps below bound per-request fan-out.
const publicMcpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit exceeded — try again later' },
});

// ── Tools ───────────────────────────────────────────────────────────

// Catalog column discipline mirrors /api/mcp's get_service: descriptive
// fields only — base_price / price_range_* stay excluded; published price
// data flows through get_pricing_ranges (the engine-derived ranges feed).
const SERVICE_COLUMNS = ['service_key', 'name', 'short_name', 'description', 'category', 'subcategory', 'billing_type', 'frequency', 'visits_per_year'];

async function listServices() {
  const rows = await db('services')
    .where({ is_active: true, is_archived: false, customer_visible: true })
    .orderBy('category')
    .orderBy('name')
    .select(SERVICE_COLUMNS);
  return { services: rows };
}

async function getService(serviceKey) {
  const row = await db('services')
    .where({
      service_key: String(serviceKey || ''), is_active: true, is_archived: false, customer_visible: true,
    })
    .first(SERVICE_COLUMNS);
  return row || { error: 'service not found' };
}

async function getPricingRanges() {
  const result = await getPublicPricingRangesResult();
  if (!result.ok) return { error: result.error };
  return result.payload;
}

async function getServiceAreas() {
  const rows = await db('service_areas')
    .where({ active: true })
    .orderBy('display_order', 'asc')
    .select('city', 'county', 'is_primary');
  return { serviceAreas: rows, note: 'Southwest Florida — Manatee, Sarasota, and Charlotte counties.' };
}

function howToRequestQuote() {
  return {
    summary: 'Price RANGES are public (get_pricing_ranges). An EXACT per-property quote requires the customer\'s contact details and is produced by the public quote endpoint below — there is no anonymous exact-quote path.',
    quoteApi: {
      endpoint: `${PORTAL_URL}/api/public/quote/calculate`,
      method: 'POST',
      contentType: 'application/json',
      requiredFields: {
        firstName: 'string', lastName: 'string', email: 'string', phone: 'string (10-digit US)', address: 'string (street address; include city and zip when known)',
        services: `object — at least one of these keys set true: ${PUBLIC_QUOTE_SERVICE_KEYS.join(', ')}`,
      },
      optionalFields: {
        city: 'string', zip: 'string', homeSqFt: 'number', lotSqFt: 'number', stories: 'number (1-3)', propertyType: "string (e.g. 'Single Family')",
      },
      responseSummary: 'JSON with monthly_total, annual_total, variance_low/high, confidence, and per-service recurring_lines. Some properties (notably commercial) return a manual-review outcome instead of an instant price.',
      rateLimit: '10 requests per hour per IP',
      sideEffects: 'Submitting creates a quote request (lead) with Waves Pest Control; Waves may follow up using the contact details provided. Only submit on behalf of a real customer, with that customer\'s knowledge and consent.',
    },
    webAlternatives: {
      quotePage: `${HUB_URL}/pest-control-quote/`,
      bookOnline: `${HUB_URL}/book/`,
      phone: COMPANY_PHONE,
    },
  };
}

const PUBLIC_MCP_TOOLS = [
  {
    name: 'list_services',
    description: 'List the customer-visible Waves Pest Control service catalog (pest, lawn, mosquito, termite, rodent, WDO inspection, tree & shrub, specialty). Descriptive fields only — use get_pricing_ranges for published price ranges.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => listServices(),
  },
  {
    name: 'get_service',
    description: 'Fetch one customer-visible catalog service by service_key (name, description, category, frequency, visits per year).',
    inputSchema: {
      type: 'object',
      properties: { service_key: { type: 'string' } },
      required: ['service_key'],
    },
    execute: (args) => getService(args.service_key),
  },
  {
    name: 'get_pricing_ranges',
    description: 'Published price ranges (low/high per service, engine-derived, refreshed from live pricing configuration). The same data as https://www.wavespestcontrol.com/pricing.md. Exact per-property quotes require customer contact details — see how_to_request_quote.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => getPricingRanges(),
  },
  {
    name: 'get_service_areas',
    description: 'List the Southwest Florida cities and counties Waves Pest Control serves.',
    inputSchema: { type: 'object', properties: {} },
    execute: () => getServiceAreas(),
  },
  {
    name: 'how_to_request_quote',
    description: 'How to get an EXACT quote for a specific property: the HTTP contract of the public quote endpoint (required contact fields, accepted service keys, response shape, side effects) plus human-facing alternatives (quote page, online booking, phone).',
    inputSchema: { type: 'object', properties: {} },
    execute: () => howToRequestQuote(),
  },
];

// ── JSON-RPC wiring (shared plumbing — services/mcp-rpc.js) ─────────

const rpc = createMcpRpc({
  tools: PUBLIC_MCP_TOOLS,
  serverInfo: { name: 'waves-public', version: '1.0.0' },
  protocolVersion: PROTOCOL_VERSION,
  logPrefix: 'public-mcp',
});

// Gate + limiter run here too so the router stays dark and bounded even if
// mounted without the pre-chain (same defense-in-depth as /api/mcp's auth).
router.post('/', publicMcpGate, publicMcpLimiter, rpc.createPostHandler({ maxBatch: MAX_BATCH, maxBatchToolCalls: MAX_BATCH_TOOL_CALLS }));

// Stateless server: no SSE stream to offer.
router.get('/', publicMcpGate, (req, res) => res.status(405).json({ error: 'streaming not supported; POST JSON-RPC' }));

// Mounted by server/index.js AHEAD of the global body parsers: gate first
// (a dark or rate-limited caller must not force any parse work), then a
// small capped parse.
const publicMcpBodyErrorHandler = createBodyErrorHandler({ limitLabel: '64kb' });
const publicMcpPreParsers = [publicMcpGate, publicMcpLimiter, express.json({ limit: '64kb' }), publicMcpBodyErrorHandler];

module.exports = router;
module.exports.publicMcpPreParsers = publicMcpPreParsers;
module.exports.PUBLIC_MCP_TOOLS = PUBLIC_MCP_TOOLS;
module.exports.executePublicMcpTool = rpc.executeTool;
module.exports.handlePublicRpc = rpc.handleRpc;
