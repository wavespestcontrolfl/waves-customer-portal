/**
 * Intelligence Bar recall — search the operator's own past IB conversations
 * (W-RECALL, owner-ratified 2026-08-31: RAW — the stored verbatim turns are
 * searched, never summaries).
 *
 * Read-only. Admin-only and ACTOR-BOUND: every query is scoped to the
 * calling admin's own threads (ib_threads.admin_actor_id); the actor id
 * comes from the route's authenticated request, never from tool input.
 * Without an actor the tool returns nothing (fail closed).
 *
 * Matches are joined to the pending-action receipts the matched
 * conversation produced (ib_pending_actions.thread_id, stamped by /query
 * when the exchange is persisted) so "what did I approve about X" answers
 * from the audit trail, not from what the model said at the time.
 *
 * Content carries taint markers and may embed customer PII — the tool is
 * registered in PII_TOOL_NAMES so params/results are redacted from logs.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { threadsEnabled } = require('./threads');
const { isToolFailure } = require('./outcomes');

const DEFAULT_DAYS = 90;
const MAX_DAYS = 400; // retention is 365 — nothing older exists
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const PAIR_PREVIEW_CHARS = 400;

const HISTORY_TOOLS = [
  {
    name: 'search_ib_history',
    description: `Search YOUR OWN past Intelligence Bar conversations (verbatim, full-text) and return the matching exchanges with any pending-action receipts (proposed/confirmed/cancelled/expired) those conversations produced.
Use for: "what did I decide about the acct-1042 reschedule last week?", "did I approve the acct-2077 refund?", "find the conversation where I asked about mosquito pricing", "what did the bar tell me about the duplex on the Tuesday route?"
Results are the operator's own threads only. Supports quoted phrases and -exclusions (web-search syntax).`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or a quoted phrase to find in past conversations' },
        days: { type: 'integer', description: `Look back this many days (default ${DEFAULT_DAYS}, max ${MAX_DAYS})` },
        limit: { type: 'integer', description: `Max matching turns (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
        context: { type: 'string', description: 'Optional: only threads started from this IB context (e.g. schedule, customers, estimates)' },
      },
      required: ['query'],
    },
    _contracts: {
      tables: ['ib_thread_turns', 'ib_threads', 'ib_pending_actions'],
      columns: {
        ib_thread_turns: ['id', 'thread_id', 'seq', 'role', 'content', 'created_at'],
        ib_threads: ['id', 'admin_actor_id', 'title', 'context', 'last_active_at'],
        ib_pending_actions: ['id', 'thread_id', 'thread_turn_seq', 'requested_by', 'tool_name', 'summary', 'status', 'result', 'created_at', 'consumed_at', 'expires_at'],
      },
      reason: 'Full-text search uses to_tsvector/websearch_to_tsquery/ts_headline in raw fragments.',
    },
  },
];

async function executeHistoryTool(toolName, input, actionContext = {}) {
  try {
    switch (toolName) {
      case 'search_ib_history': return await searchIbHistory(input || {}, actionContext);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    // Never log err itself: knex attaches the SQL bindings, and the query
    // text is operator-typed (may name a customer). Code is enough.
    logger.error(`[intelligence-bar:history] Tool ${toolName} failed (code=${err?.code || 'unknown'})`);
    return { error: 'History search failed' };
  }
}

function clampInt(v, dflt, min, max) {
  const n = Math.floor(Number(v));
  return Math.min(Math.max(Number.isFinite(n) ? n : dflt, min), max);
}

async function searchIbHistory(input, actionContext) {
  // Same kill switch as the thread endpoints: unset GATE_IB_THREADS and
  // previously persisted conversations become unreachable here too.
  if (!threadsEnabled()) {
    return { error: 'Conversation history is not enabled', results: [] };
  }
  const actorId = actionContext?.actorId ? String(actionContext.actorId) : null;
  if (!actorId) {
    return { error: 'Operator identity required — history is searchable only by its owner', results: [] };
  }
  const query = String(input.query || '').trim().slice(0, 200);
  if (!query) return { error: 'query is required', results: [] };
  const days = clampInt(input.days, DEFAULT_DAYS, 1, MAX_DAYS);
  const limit = clampInt(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const contextFilter = input.context ? String(input.context).trim().slice(0, 40) : null;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const base = () => {
    const q = db('ib_thread_turns as tt')
      .join('ib_threads as t', 't.id', 'tt.thread_id')
      .where('t.admin_actor_id', actorId)
      .where('tt.created_at', '>=', since);
    if (contextFilter) q.where('t.context', contextFilter);
    return q;
  };

  // A term that appears in BOTH halves of an exchange (identifiers usually
  // do) matches two turns; over-fetch so exchange-level dedupe below still
  // yields `limit` DISTINCT exchanges instead of duplicates eating the
  // budget.
  const fetchLimit = limit * 2;
  const TSQ = "websearch_to_tsquery('english', ?)";
  let rows = await base()
    .whereRaw(`to_tsvector('english', tt.content) @@ ${TSQ}`, [query])
    .orderByRaw(`ts_rank(to_tsvector('english', tt.content), ${TSQ}) DESC, tt.created_at DESC`, [query])
    .limit(fetchLimit)
    .select(
      'tt.id', 'tt.thread_id', 'tt.seq', 'tt.role', 'tt.created_at',
      't.title', 't.context', 't.last_active_at',
      db.raw(`ts_headline('english', tt.content, ${TSQ}, 'MaxWords=45, MinWords=15, MaxFragments=2, FragmentDelimiter= … ') as snippet`, [query]),
    );
  let mode = 'full_text';

  // Stopword-only or very short queries produce an empty tsquery; fall back
  // to a plain substring match so "the 5pm one" still finds something.
  if (rows.length === 0) {
    rows = await base()
      .where('tt.content', 'ilike', `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
      .orderBy('tt.created_at', 'desc')
      .limit(fetchLimit)
      .select('tt.id', 'tt.thread_id', 'tt.seq', 'tt.role', 'tt.created_at', 't.title', 't.context', 't.last_active_at',
        db.raw('substr(tt.content, 1, 300) as snippet'));
    mode = rows.length ? 'substring' : 'full_text';
  }

  // One result per exchange: keep the best-ranked half, drop its twin.
  const seenExchange = new Set();
  rows = rows.filter((r) => {
    const key = `${r.thread_id}:${r.role === 'assistant' ? r.seq : r.seq + 1}`;
    if (seenExchange.has(key)) return false;
    seenExchange.add(key);
    return true;
  }).slice(0, limit);

  if (rows.length === 0) {
    return { query, days_searched: days, mode, total: 0, results: [], receipts: [] };
  }

  // The other half of each matched exchange (user↔assistant), so a hit on
  // the operator's question also shows what the bar answered, and vice
  // versa.
  const pairKeys = rows.map((r) => ({ thread_id: r.thread_id, seq: r.role === 'user' ? r.seq + 1 : r.seq - 1 }));
  const pairRows = await db('ib_thread_turns')
    .where((qb) => {
      for (const k of pairKeys) qb.orWhere((inner) => inner.where('thread_id', k.thread_id).where('seq', k.seq));
    })
    .select('thread_id', 'seq', 'role', 'content');
  const pairMap = new Map(pairRows.map((p) => [`${p.thread_id}:${p.seq}`, p]));

  const threadIds = [...new Set(rows.map((r) => r.thread_id))];
  const receipts = await db('ib_pending_actions')
    .whereIn('thread_id', threadIds)
    .where('requested_by', actorId)
    .orderBy('created_at', 'desc')
    .select('id', 'thread_id', 'thread_turn_seq', 'tool_name', 'summary', 'status', 'result', 'created_at', 'consumed_at', 'expires_at');

  const results = rows.map((r) => {
    // The exchange = (user seq, assistant seq); receipts are stamped with
    // the assistant seq, so attribute only the ones from THIS exchange.
    const assistantSeq = r.role === 'assistant' ? r.seq : r.seq + 1;
    const pair = pairMap.get(`${r.thread_id}:${r.role === 'user' ? r.seq + 1 : r.seq - 1}`);
    return {
      thread_id: r.thread_id,
      thread_title: r.title,
      context: r.context,
      thread_last_active_at: r.last_active_at,
      turn_seq: r.seq,
      role: r.role,
      at: r.created_at,
      snippet: r.snippet,
      ...(pair ? {
        paired_turn: {
          role: pair.role,
          content: String(pair.content).slice(0, PAIR_PREVIEW_CHARS),
          truncated: String(pair.content).length > PAIR_PREVIEW_CHARS,
        },
      } : {}),
      receipts: receipts
        .filter((x) => x.thread_id === r.thread_id && x.thread_turn_seq === assistantSeq)
        .map((x) => ({
          id: x.id, tool: x.tool_name, summary: x.summary, status: effectiveStatus(x),
          outcome: receiptOutcome(x),
          proposed_at: x.created_at, resolved_at: x.consumed_at, expires_at: x.expires_at,
        })),
    };
  });

  return {
    query,
    days_searched: days,
    mode,
    total: results.length,
    results,
    note: 'Receipts are the audit trail of pending actions proposed by that exact exchange. Trust `outcome`, not `status`: executed = the operator confirmed AND the run recorded success; failed = confirmed but the run recorded an error; unknown = confirmed but no result was recorded; never_ran = pending, expired, or cancelled.',
  };
}

// Expiry is enforced only at confirm time (expires_at check), so a proposal
// the operator never touched stays `pending` in the table forever. Report
// the effective state so "did that expire?" answers honestly.
function effectiveStatus(row) {
  if (row.status === 'pending' && row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return 'expired';
  }
  return row.status;
}

// `status = confirmed` is set when the operator clicks Confirm, BEFORE the
// action executes; a failed run keeps status confirmed with the error in
// `result`. Never report a confirmed action as done without the result.
function receiptOutcome(row) {
  if (row.status !== 'confirmed') return 'never_ran';
  let result = row.result;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { return 'unknown'; }
  }
  if (result === null || result === undefined) return 'unknown';
  // Write tools signal a non-run three ways: { error }, { failed: true },
  // or { success: false, blocked: true } (e.g. duplicate-blocked estimate
  // drafts) — none of those wrote anything.
  if (isToolFailure(result)) {
    return 'failed';
  }
  return 'executed';
}

module.exports = { HISTORY_TOOLS, executeHistoryTool };
