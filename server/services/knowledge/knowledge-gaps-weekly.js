'use strict';

// Weekly knowledge-gaps admin notification (owner 2026-10-01: "send me a
// weekly email"; owner 2026-11-26: "shouldn't these all be admin
// notifications now"). One Content row a week listing the questions the
// knowledge base could not fully answer — the to-do list for new knowledge
// entries (sourced from UF/IFAS fact sheets, labels and our own protocols).
// Exception-based: a week with no gaps writes nothing. The old email also
// went out on a quiet week "so the owner sees it working"; that is
// reassurance, not a signal anyone acts on, and the cron still records its
// run in job_health, so the bell stays quiet instead.
//
// Source: knowledge_queries rows with coverage 'none' or 'partial'. WikiQA
// records coverage on every answer (texting assistant, lead agent, tech
// field Q&A, admin Q&A, content agents). Intelligence Bar searches are not
// logged automatically (their queries can carry customer names, addresses
// and phones); an empty search offers the operator an "add to knowledge
// gaps" button, and only rows they tap land here (asked_by
// 'intelligence_bar', coverage 'none'). The questions go in the row's
// `detail` redacted like every bell body, never in the headline.
//
// Cron: Monday 8:43am ET in scheduler.js, inside runExclusive, then hourly
// at :43 through Tuesday as catch-up ticks. The row's dedupeKey names the
// report week, so the catch-up ticks dedupe onto it (a person's Done stays
// done), and a failed write or a deploy over 8:43 is retried the same week.
// Kill: KNOWLEDGE_GAPS_WEEKLY=off.

const logger = require('../logger');
const db = require('../../models/db');
const { raiseAdminAlert, breaksAlertRules } = require('../admin-alert-compose');
const { redactedWords, whyWithQuote, shortDateET } = require('../admin-alert-names');
const { etWeekStart, etDateString, addETDaysAtWallClock, parseETDateTime } = require('../../utils/datetime-et');

const DEDUPE_PREFIX = 'knowledge-gaps-weekly';
const WINDOW_DAYS = 7;
const TOP_N = 10;
const QUESTION_MAX = 140;
const DETAIL_MAX_CHARS = 2000;

const killed = () => ['off', 'false', '0'].includes(String(process.env.KNOWLEDGE_GAPS_WEEKLY || '').trim().toLowerCase());

// Plain names for who asked.
const SOURCE_LABELS = {
  ai_assistant: 'texting assistant',
  lead_agent: 'lead agent',
  tech_field: 'tech Q&A',
  admin_manual: 'admin Q&A',
  content_agent: 'blog writer',
  brief_driven_agent: 'blog writer',
  intelligence_bar: 'Intelligence Bar',
};
const sourceLabel = (s) => SOURCE_LABELS[s] || String(s || 'unknown').replace(/_/g, ' ');

// One fixed week ending at the most recent Monday 8:43 ET tick at or before
// `now`, so consecutive reports meet exactly whenever a run starts.
function reportWindow(now) {
  let end = parseETDateTime(`${etWeekStart(now)}T08:43:00`);
  if (end.getTime() > now.getTime()) end = addETDaysAtWallClock(end, -WINDOW_DAYS);
  return { start: addETDaysAtWallClock(end, -WINDOW_DAYS), end };
}

// Same question asked twice = same key: case, punctuation and spacing ignored.
// Letters and digits of any script count, so a question in another language
// is listed, not dropped as empty.
function questionKey(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

// The week's gaps, plus how many answers carry no coverage rating (the model
// left the tag off, or the row predates the column) — those are unknown,
// never counted as answered.
async function loadWeek(now = new Date()) {
  const { start, end } = reportWindow(now);
  const inWeek = (q) => q.where('created_at', '>=', start).where('created_at', '<', end);
  const rows = await inWeek(db('knowledge_queries'))
    .whereIn('coverage', ['none', 'partial'])
    .select('query', 'asked_by', 'coverage', 'created_at');
  const unrated = await inWeek(db('knowledge_queries')).whereNull('coverage').count('* as n').first();
  return { rows, unrated: Number(unrated?.n || 0) };
}

// Pure: the week's gap rows (+ unrated count) → the alert spec and its detail text, or null when the
// week had no gap (a quiet week writes nothing).
function composeGapsAlert({ rows: allRows = [], unrated = 0 } = {}, now = new Date()) {
  // A question with no words (punctuation only) is not a gap anyone can fill.
  const rows = allRows.filter((r) => questionKey(r.query));
  const groups = new Map();
  for (const r of rows) {
    const key = questionKey(r.query);
    const g = groups.get(key) || { question: r.query, count: 0, none: 0, sources: new Set(), last: 0 };
    g.count += 1;
    if (r.coverage === 'none') g.none += 1;
    g.sources.add(sourceLabel(r.asked_by));
    g.last = Math.max(g.last, new Date(r.created_at || 0).getTime());
    groups.set(key, g);
  }
  // Most asked first; ties: more "not answered at all", then most recent.
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count || b.none - a.none || b.last - a.last);
  const total = ranked.reduce((n, g) => n + g.count, 0);
  if (!ranked.length) return null;

  const lines = ranked.slice(0, TOP_N).map((g, i) => {
    const times = g.count > 1 ? ` — asked ${g.count}×` : '';
    const how = g.none === g.count ? 'not answered' : (g.none ? 'not or only partly answered' : 'only partly answered');
    return `${i + 1}. "${clip(redactedWords(g.question), QUESTION_MAX)}"${times}\n   ${how} · ${[...g.sources].join(', ')}`;
  });

  const bySource = new Map();
  for (const r of rows) bySource.set(sourceLabel(r.asked_by), (bySource.get(sourceLabel(r.asked_by)) || 0) + 1);
  const sourceLine = [...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', ');

  const unratedLine = unrated
    ? `${unrated} answer${unrated === 1 ? '' : 's'} had no coverage rating, so whether ${unrated === 1 ? 'it' : 'they'} fully answered is unknown.`
    : null;

  const { start, end } = reportWindow(now);
  const detail = [
    `${total} question${total === 1 ? '' : 's'} the knowledge base couldn't fully answer (${shortDateET(start)} – ${shortDateET(end)}).`,
    '',
    `Top ${Math.min(TOP_N, ranked.length)}:`,
    ...lines,
    ...(ranked.length > TOP_N ? [`…and ${ranked.length - TOP_N} more.`] : []),
    '',
    `Asked by: ${sourceLine}.`,
    ...(unratedLine ? [unratedLine] : []),
    'Each one is a candidate knowledge entry, written from UF/IFAS fact sheets, product labels or our protocols.',
  ].join('\n').slice(0, DETAIL_MAX_CHARS);

  // The most asked question leads the why when its words pass the copy rules; else a plain line.
  const quoted = whyWithQuote({ lead: 'Most asked: ', quote: redactedWords(ranked[0].question) });
  const plainWhy = `The knowledge base could not fully answer ${total === 1 ? 'a question' : `${total} questions`} last week.`;
  const why = ranked[0].question && !breaksAlertRules(quoted) ? quoted : plainWhy;

  return {
    spec: {
      area: 'Content',
      action: `fill ${total} knowledge gap${total === 1 ? '' : 's'} from last week`,
      why,
      severity: 'needs-you',
      link: '/admin/knowledge',
      subject: { type: 'check', id: DEDUPE_PREFIX },
      doneWhen: 'gaps_reviewed',
      who: 'either',
    },
    detail,
    gaps: total,
  };
}

async function runKnowledgeGapsWeekly(opts = {}) {
  const now = opts.now || new Date();
  if (killed()) return { skipped: 'disabled' };

  let week;
  try {
    week = await (opts.loadWeek || loadWeek)(now);
  } catch (err) {
    logger.error(`[knowledge-gaps-weekly] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }
  const composed = composeGapsAlert(week, now);
  if (!composed) return { skipped: 'nothing_found', gaps: 0 };

  try {
    const result = await (opts.raiseAlert || raiseAlert)(composed, reportWindow(now).end);
    // raiseAdminAlert passes the writer's null (a failed write) through without throwing; every real outcome
    // (written, deduped onto this week's row, deliberately suppressed) carries deduped or suppressed.
    if (!result || (typeof result.deduped !== 'boolean' && result.suppressed !== true)) {
      logger.error('[knowledge-gaps-weekly] alert write failed (no row written)');
      return { raised: false, error: true, gaps: composed.gaps };
    }
  } catch (err) {
    logger.error(`[knowledge-gaps-weekly] alert failed (${err.code || err.name || 'error'})`);
    return { raised: false, error: true, gaps: composed.gaps };
  }
  logger.info(`[knowledge-gaps-weekly] raised: ${composed.gaps} gap(s)`);
  return { raised: true, gaps: composed.gaps };
}

// One row per report week: the key names the week, so a catch-up tick finds this week's row and dedupes.
function raiseAlert({ spec, detail }, weekEnd) {
  return raiseAdminAlert('knowledge', spec, {
    dedupeKey: `${DEDUPE_PREFIX}:${etDateString(weekEnd)}`,
    // Under GATE_ADMIN_BELL_POLICY the 'knowledge' category is denied unless the call site tags it.
    bell: true,
    detail,
  });
}

// Gaps saved from the Intelligence Bar are questions with no answer: they
// belong in the weekly alert, not in the recent Q&A lists (admin-knowledge.js,
// knowledge.js). Apply to a knowledge_queries query to leave them out.
function withoutSavedGaps(q) {
  return q.where((w) => w.whereNull('asked_by').orWhereNot('asked_by', 'intelligence_bar'));
}

module.exports = {
  questionKey,
  withoutSavedGaps,
  runKnowledgeGapsWeekly,
  _private: { composeGapsAlert, reportWindow, questionKey, sourceLabel, loadWeek },
};
