/**
 * Intelligence Bar tools — call-research corpus (voice-of-customer).
 *
 * Read-only search + aggregation over call_research_chunks: verbatim
 * PII-redacted quotes mined nightly from call transcripts, tagged with the
 * fixed research taxonomy. v1 deliberately returns NO customer names and
 * NO customer_id — call_log_id is the only linkage surfaced, so this
 * module stays out of the PII tool set.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { parseETDateTime, addETDays, etDateString } = require('../../utils/datetime-et');
const { RESEARCH_TAGS } = require('../call-research-taxonomy');

// Topic aggregation counts in JS over a bounded scan (corpus is thousands
// of rows, not millions) — keeps jsonb explosion out of the SQL layer.
const TOPIC_SCAN_CAP = 5000;

const CALL_RESEARCH_TOOLS = [
  {
    name: 'search_call_research',
    description: `Voice-of-customer research corpus: verbatim (PII-redacted) quotes mined nightly from call transcripts, each tagged ${RESEARCH_TAGS.join(' / ')}. mode=search returns matching quotes (full-text query optional — omit it to browse by tag/date filters); mode=aggregate returns grouped counts by tag, topic, or month. Quotes are anonymized — no customer names or ids ever appear.
Use for: "what do customers actually say about german roaches?", "list every capability question from June", "top objections this quarter", "which competitors come up on calls?"`,
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['search', 'aggregate'],
          description: 'search = return quotes (default); aggregate = grouped counts',
        },
        query: {
          type: 'string',
          description: 'Full-text search over quote + context (websearch syntax: quoted phrases, OR, -exclusions). Optional — omit to filter by tag/date only. In aggregate mode it narrows what gets counted.',
        },
        tags: {
          type: 'array',
          items: { type: 'string', enum: RESEARCH_TAGS },
          description: 'Filter to these research tags',
        },
        date_from: {
          type: 'string',
          format: 'date',
          description: 'Earliest call date, ET (YYYY-MM-DD)',
        },
        date_to: {
          type: 'string',
          format: 'date',
          description: 'Latest call date inclusive, ET (YYYY-MM-DD)',
        },
        service: {
          type: 'string',
          description: 'Filter by mentioned service (case-insensitive substring of the catalog service name)',
        },
        group_by: {
          type: 'string',
          enum: ['tag', 'topic', 'month'],
          description: 'aggregate mode only — grouping dimension (default tag)',
        },
        limit: {
          type: 'number',
          description: 'Max quotes in search mode (default 20, cap 50)',
        },
      },
    },
  },
];

function parseTopics(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

// Shared filter set for both modes. ET day boundaries via datetime-et so a
// "June" window doesn't leak evening calls across the UTC date line.
function baseQuery(input) {
  let q = db('call_research_chunks');
  if (Array.isArray(input.tags) && input.tags.length) {
    q = q.whereIn('tag', input.tags.filter((t) => RESEARCH_TAGS.includes(t)));
  }
  if (input.date_from) {
    q = q.where('occurred_at', '>=', parseETDateTime(`${input.date_from}T00:00:00`));
  }
  if (input.date_to) {
    q = q.where('occurred_at', '<', addETDays(parseETDateTime(`${input.date_to}T00:00:00`), 1));
  }
  if (input.service) {
    q = q.where('service_mentioned', 'ilike', `%${input.service}%`);
  }
  return q;
}

function withFtsFilter(builder, query) {
  if (!query) return builder;
  return builder.whereRaw("search_vector @@ websearch_to_tsquery('english', ?)", [query]);
}

const SEARCH_COLUMNS = ['call_log_id', 'speaker', 'quote', 'context', 'tag', 'topics', 'service_mentioned', 'occurred_at'];

function shapeRow(r) {
  return {
    quote: r.quote,
    context: r.context,
    speaker: r.speaker,
    tag: r.tag,
    topics: parseTopics(r.topics),
    service_mentioned: r.service_mentioned,
    call_date: r.occurred_at ? etDateString(new Date(r.occurred_at)) : null,
    call_log_id: r.call_log_id,
  };
}

async function searchChunks(input) {
  const limit = Math.min(input.limit || 20, 50);
  const q = (input.query || '').trim();
  let rows = [];
  let searchMethod = 'recent';

  if (q) {
    searchMethod = 'fts';
    try {
      rows = await baseQuery(input)
        .whereRaw("search_vector @@ websearch_to_tsquery('english', ?)", [q])
        .select(...SEARCH_COLUMNS, db.raw("ts_rank(search_vector, websearch_to_tsquery('english', ?)) as rank", [q]))
        .orderByRaw('rank DESC, occurred_at DESC')
        .limit(limit);
    } catch (err) {
      logger.warn(`[intelligence-bar:call-research] FTS failed, falling back to ILIKE: ${err.message}`);
    }
    if (!rows.length) {
      searchMethod = 'ilike';
      const term = `%${q.toLowerCase()}%`;
      rows = await baseQuery(input)
        .where(function () {
          this.where('quote', 'ilike', term).orWhere('context', 'ilike', term);
        })
        .orderBy('occurred_at', 'desc')
        .limit(limit)
        .select(...SEARCH_COLUMNS);
    }
  } else {
    rows = await baseQuery(input)
      .orderBy('occurred_at', 'desc')
      .limit(limit)
      .select(...SEARCH_COLUMNS);
  }

  return {
    results: rows.map(shapeRow),
    total: rows.length,
    searchMethod,
    search_params: {
      query: q || null,
      tags: input.tags || null,
      date_from: input.date_from || null,
      date_to: input.date_to || null,
      service: input.service || null,
    },
    note: 'Verbatim caller/agent speech, PII-redacted at mine time. call_log_id links to the source call for staff follow-up; customer identity is never exposed here.',
  };
}

async function aggregateChunks(input) {
  const groupBy = input.group_by || 'tag';
  const q = (input.query || '').trim();
  const params = {
    query: q || null,
    tags: input.tags || null,
    date_from: input.date_from || null,
    date_to: input.date_to || null,
    service: input.service || null,
  };

  if (groupBy === 'topic') {
    const rows = await withFtsFilter(baseQuery(input), q)
      .select('topics')
      .limit(TOPIC_SCAN_CAP);
    const counts = {};
    for (const row of rows) {
      for (const topic of parseTopics(row.topics)) {
        if (typeof topic === 'string' && topic.trim()) {
          const key = topic.trim().toLowerCase();
          counts[key] = (counts[key] || 0) + 1;
        }
      }
    }
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([topic, count]) => ({ topic, count }));
    return {
      group_by: 'topic',
      counts: top,
      chunks_scanned: rows.length,
      truncated: rows.length >= TOPIC_SCAN_CAP,
      search_params: params,
      note: 'Topics are free-text strings from extraction, lowercased for counting. Narrow with tags/dates if truncated.',
    };
  }

  if (groupBy === 'month') {
    const rows = await withFtsFilter(baseQuery(input), q)
      .select(db.raw("to_char(occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM') as month"), db.raw('COUNT(*) as count'))
      .groupByRaw("to_char(occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM')")
      .orderByRaw('month');
    return {
      group_by: 'month',
      counts: rows.map((r) => ({ month: r.month, count: parseInt(r.count) })),
      search_params: params,
    };
  }

  const rows = await withFtsFilter(baseQuery(input), q)
    .select('tag', db.raw('COUNT(*) as count'))
    .groupBy('tag')
    .orderByRaw('COUNT(*) DESC');
  return {
    group_by: 'tag',
    counts: rows.map((r) => ({ tag: r.tag, count: parseInt(r.count) })),
    search_params: params,
  };
}

async function searchCallResearch(input = {}) {
  if (input.mode === 'aggregate') return aggregateChunks(input);
  return searchChunks(input);
}

async function executeCallResearchTool(toolName, input) {
  try {
    switch (toolName) {
      case 'search_call_research': return await searchCallResearch(input || {});
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:call-research] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { CALL_RESEARCH_TOOLS, executeCallResearchTool };
