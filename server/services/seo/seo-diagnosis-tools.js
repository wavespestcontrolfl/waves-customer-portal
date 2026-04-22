/**
 * SEO Diagnosis Agent — tool definitions + executors.
 *
 * All seven tools per the spec are declared here with their full JSON schema
 * so the agent runner (Phase 2) can register them with Anthropic's managed-
 * agents API. Two are wired for real data in this PR; the rest return a
 * structured not-implemented-yet payload so callers can plan without the
 * executor blowing up. Phase 2 fills them in.
 *
 *   IMPLEMENTED:
 *     fetch_gsc_data         — reads gsc_performance_daily + gsc_queries
 *     classify_query_intent  — Claude FAST classify (transactional / informational / commercial)
 *
 *   STUBBED (Phase 2):
 *     detect_cannibalization
 *     find_striking_distance
 *     diff_page_vs_top_result
 *     verify_service_area_coverage
 *     check_hub_spoke_links
 *
 * Also exposes `fetch_rubric` so the agent pulls the YAML rubric at run
 * time instead of embedding it in the system prompt. Rubric lives at
 * docs/seo/waves-seo-rubric.yaml and is versioned there.
 */

const fs = require('fs');
const path = require('path');
const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const RUBRIC_PATH = path.resolve(__dirname, '../../../docs/seo/waves-seo-rubric.yaml');

// ───────────────────────────────────────────────────────────────
// TOOL DEFINITIONS — matches Anthropic tool-use schema shape
// ───────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'fetch_rubric',
    description: 'Load the Waves SEO rubric YAML — the scoring function the agent should use. Returns the raw YAML text and the version number. Call this first on every run so the agent always has the latest rules.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'fetch_gsc_data',
    description: 'Pull the last N days of Google Search Console data across all tracked Waves domains. Returns aggregate metrics + top queries + top pages. Use for trend analysis and identifying striking-distance queries.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'How many days of history to pull (default 28, max 90).' },
        domain: { type: 'string', description: 'Optional: restrict to a single domain. Omit to pull all tracked domains.' },
        min_impressions: { type: 'number', description: 'Filter out low-volume noise (default 20).' },
      },
    },
  },
  {
    name: 'classify_query_intent',
    description: 'Classify a search query as transactional, informational, or commercial-investigation. Uses the rubric\'s intent_routing signals. Call on a batch of up to 50 queries at once.',
    input_schema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Queries to classify (up to 50 per call).',
        },
      },
      required: ['queries'],
    },
  },
  {
    name: 'detect_cannibalization',
    description: 'Flag queries where two or more Waves-owned domains are competing for the same term. Returns an array of { query, domains, recommended_primary } — the primary is inferred from domain_roles in the rubric.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number' },
        min_impressions: { type: 'number' },
      },
    },
  },
  {
    name: 'find_striking_distance',
    description: 'Find queries currently ranking in positions 8–20 (page 1 bottom + page 2) — the "one fix from page 1" opportunities. Returns ranked list with estimated traffic if moved to position 1–3.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number' },
        min_impressions: { type: 'number' },
        position_range: {
          type: 'array',
          items: { type: 'number' },
          description: '[min, max] position range (default [8, 20]).',
        },
      },
    },
  },
  {
    name: 'diff_page_vs_top_result',
    description: 'For a given query + Waves URL, fetch the current top-ranking competitor and diff title / H1 / schema / word count / heading structure. Returns a list of concrete differences ordered by impact.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        waves_url: { type: 'string' },
      },
      required: ['query', 'waves_url'],
    },
  },
  {
    name: 'verify_service_area_coverage',
    description: 'Cross-check the portal service_areas table against what Astro actually has built and indexed. Returns missing pages — one of the highest-ROI fix types per the rubric.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'check_hub_spoke_links',
    description: 'Audit the internal link graph across all 15 Waves domains. Flags hub pages missing a link to their owning spoke, spokes missing an uplink, and orphaned pages. Returns an action list.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

// ───────────────────────────────────────────────────────────────
// EXECUTORS — 2 real, rest stubbed with a standard shape so the
// agent session can still run end-to-end.
// ───────────────────────────────────────────────────────────────

function notYetImplemented(toolName) {
  return {
    implemented: false,
    tool: toolName,
    message: `${toolName} is stubbed in Phase 1. Wires in Phase 2. Return empty results and continue.`,
    results: [],
  };
}

async function fetchRubric() {
  try {
    const yaml = fs.readFileSync(RUBRIC_PATH, 'utf8');
    const versionMatch = yaml.match(/^version:\s*(\d+)/m);
    return {
      implemented: true,
      tool: 'fetch_rubric',
      version: versionMatch ? parseInt(versionMatch[1], 10) : null,
      yaml,
    };
  } catch (e) {
    return {
      implemented: true,
      tool: 'fetch_rubric',
      error: `Rubric load failed: ${e.message}. Expected at docs/seo/waves-seo-rubric.yaml`,
    };
  }
}

async function fetchGscData({ days_back = 28, domain, min_impressions = 20 } = {}) {
  const cutoff = new Date(Date.now() - Math.min(days_back, 90) * 86400000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  try {
    // Aggregate daily metrics
    const dailyQ = db('gsc_performance_daily')
      .where('date', '>=', cutoffStr)
      .where('device', 'all')
      .select('date')
      .sum({ clicks: 'clicks', impressions: 'impressions' })
      .avg({ ctr: 'ctr', position: 'position' })
      .groupBy('date')
      .orderBy('date', 'asc');
    const daily = await dailyQ;

    // Top queries
    let topQueriesQ = db('gsc_queries')
      .where('date', '>=', cutoffStr)
      .where('impressions', '>=', min_impressions);
    if (domain) topQueriesQ = topQueriesQ.where('domain', domain);
    const topQueries = await topQueriesQ
      .select('query', 'domain')
      .sum({ clicks: 'clicks', impressions: 'impressions' })
      .avg({ ctr: 'ctr', position: 'position' })
      .groupBy('query', 'domain')
      .orderBy('impressions', 'desc')
      .limit(100);

    // Top pages
    let topPagesQ = db('gsc_pages')
      .where('date', '>=', cutoffStr)
      .where('impressions', '>=', min_impressions);
    if (domain) topPagesQ = topPagesQ.where('domain', domain);
    const topPages = await topPagesQ
      .select('page', 'domain')
      .sum({ clicks: 'clicks', impressions: 'impressions' })
      .avg({ ctr: 'ctr', position: 'position' })
      .groupBy('page', 'domain')
      .orderBy('impressions', 'desc')
      .limit(50);

    return {
      implemented: true,
      tool: 'fetch_gsc_data',
      period: { start: cutoffStr, end: new Date().toISOString().slice(0, 10) },
      daily_count: daily.length,
      total_clicks: daily.reduce((s, d) => s + Number(d.clicks || 0), 0),
      total_impressions: daily.reduce((s, d) => s + Number(d.impressions || 0), 0),
      top_queries: topQueries.map((q) => ({
        query: q.query,
        domain: q.domain,
        clicks: Number(q.clicks),
        impressions: Number(q.impressions),
        ctr: Number(q.ctr),
        position: Number(q.position),
      })),
      top_pages: topPages.map((p) => ({
        page: p.page,
        domain: p.domain,
        clicks: Number(p.clicks),
        impressions: Number(p.impressions),
        ctr: Number(p.ctr),
        position: Number(p.position),
      })),
    };
  } catch (e) {
    logger.warn(`[seo-diagnosis] fetch_gsc_data failed: ${e.message}`);
    return {
      implemented: true,
      tool: 'fetch_gsc_data',
      error: e.message,
      hint: 'Tables gsc_performance_daily / gsc_queries / gsc_pages may be empty. Check /admin/seo?tab=advisor Sync Health card.',
    };
  }
}

async function classifyQueryIntent({ queries = [] } = {}) {
  if (!Array.isArray(queries) || queries.length === 0) {
    return { implemented: true, tool: 'classify_query_intent', classifications: [] };
  }
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    // Deterministic fallback using the rubric's signal keywords so the
    // agent run is still useful in dev envs without the Claude key.
    return {
      implemented: true,
      tool: 'classify_query_intent',
      fallback: 'keyword-rules',
      classifications: queries.slice(0, 50).map((q) => ({
        query: q,
        intent: keywordClassify(q),
        confidence: 0.6,
      })),
    };
  }

  const batch = queries.slice(0, 50);
  const prompt =
    'Classify each search query by intent. Respond with a single line per query in the format:\n' +
    '<query>\\t<intent>\\t<confidence 0-1>\\n\n' +
    'intent must be one of: transactional | informational | commercial-investigation\n' +
    '- transactional: user wants to hire/buy now (price, cost, near me, quote, book, emergency)\n' +
    '- informational: user wants to learn (how to, why, what is, identify, diy)\n' +
    '- commercial-investigation: user is researching options (best, vs, reviews, compare)\n\n' +
    'Queries:\n' + batch.map((q) => `- ${q}`).join('\n');

  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: MODELS.FAST,
      max_tokens: Math.min(2048, batch.length * 20),
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0]?.text || '';
    const parsed = text.split('\n').map((line) => {
      const m = line.trim().match(/^(.+?)\t(transactional|informational|commercial-investigation)\t(\d+(?:\.\d+)?)/);
      if (!m) return null;
      return { query: m[1].trim(), intent: m[2], confidence: Math.min(1, Number(m[3])) };
    }).filter(Boolean);
    return {
      implemented: true,
      tool: 'classify_query_intent',
      classifications: parsed,
    };
  } catch (e) {
    logger.warn(`[seo-diagnosis] classify_query_intent Claude failed, falling back to keywords: ${e.message}`);
    return {
      implemented: true,
      tool: 'classify_query_intent',
      fallback: 'keyword-rules',
      error: e.message,
      classifications: batch.map((q) => ({
        query: q,
        intent: keywordClassify(q),
        confidence: 0.5,
      })),
    };
  }
}

function keywordClassify(query) {
  const q = (query || '').toLowerCase();
  if (/\b(price|cost|near me|quote|book|appointment|emergency|hire)\b/.test(q)) return 'transactional';
  if (/\b(how to|why|what is|identify|diy|when does|symptoms|get rid|kill)\b/.test(q)) return 'informational';
  if (/\b(best|vs|versus|reviews|compare|top\s+\d)\b/.test(q)) return 'commercial-investigation';
  return 'informational';
}

const EXECUTORS = {
  fetch_rubric: fetchRubric,
  fetch_gsc_data: fetchGscData,
  classify_query_intent: classifyQueryIntent,
  detect_cannibalization: async () => notYetImplemented('detect_cannibalization'),
  find_striking_distance: async () => notYetImplemented('find_striking_distance'),
  diff_page_vs_top_result: async () => notYetImplemented('diff_page_vs_top_result'),
  verify_service_area_coverage: async () => notYetImplemented('verify_service_area_coverage'),
  check_hub_spoke_links: async () => notYetImplemented('check_hub_spoke_links'),
};

async function executeSeoDiagnosisTool(toolName, input = {}) {
  const fn = EXECUTORS[toolName];
  if (!fn) throw new Error(`Unknown SEO diagnosis tool: ${toolName}`);
  return fn(input);
}

module.exports = {
  TOOLS,
  executeSeoDiagnosisTool,
  // exported for tests / direct admin endpoint
  _fetchRubric: fetchRubric,
  _fetchGscData: fetchGscData,
  _classifyQueryIntent: classifyQueryIntent,
};
