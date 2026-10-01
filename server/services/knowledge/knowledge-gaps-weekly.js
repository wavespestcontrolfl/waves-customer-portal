'use strict';

// Weekly knowledge-gaps email (owner 2026-10-01: "send me a weekly email").
// Lists the questions the knowledge base could not fully answer last week —
// the to-do list for new knowledge entries (sourced from UF/IFAS fact
// sheets, labels and our own protocols). Every week, even a quiet one, so
// the owner sees it working.
//
// Source: knowledge_queries rows with coverage 'none' or 'partial'. WikiQA
// records coverage on every answer (texting assistant, lead agent, tech
// field Q&A, admin Q&A, content agents) and the Intelligence Bar logs a
// knowledge search that found nothing at all.
//
// Cron: Monday 8:43am ET in scheduler.js, inside runExclusive, then hourly
// at :43 through Tuesday as catch-up ticks — the once-per-week stamp makes
// them no-ops after a successful send, and a failed send or a deploy over
// 8:43 is retried the same week.
// Kill: KNOWLEDGE_GAPS_WEEKLY=off. Recipient: KNOWLEDGE_GAPS_EMAIL
// (internal inboxes only, default contact@).

const sendgrid = require('../sendgrid-mail');
const logger = require('../logger');
const db = require('../../models/db');
const { isInternalEmailRecipient } = require('../../utils/internal-email-recipients');
const { etWeekStart, addETDaysAtWallClock, parseETDateTime } = require('../../utils/datetime-et');

const OPS_KEY = 'knowledge-gaps-weekly';
const WINDOW_DAYS = 7;
const TOP_N = 10;
const QUESTION_MAX = 140;

const recipient = () => process.env.KNOWLEDGE_GAPS_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const killed = () => ['off', 'false', '0'].includes(String(process.env.KNOWLEDGE_GAPS_WEEKLY || '').trim().toLowerCase());

// Plain names for who asked.
const SOURCE_LABELS = {
  ai_assistant: 'texting assistant',
  lead_agent: 'lead agent',
  tech_field: 'tech Q&A',
  admin_manual: 'admin Q&A',
  intelligence_bar: 'Intelligence Bar',
  content_agent: 'blog writer',
  brief_driven_agent: 'blog writer',
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
function questionKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
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

// Pure: the week's gap rows (+ unrated count) → subject + plain-text body.
function composeGapsEmail({ rows: allRows = [], unrated = 0 } = {}, now = new Date()) {
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

  const unratedLine = unrated
    ? `${unrated} answer${unrated === 1 ? '' : 's'} had no coverage rating, so whether ${unrated === 1 ? 'it' : 'they'} fully answered is unknown.`
    : null;

  if (!ranked.length) {
    return {
      subject: 'Knowledge gaps: none recorded this week',
      text: ['No knowledge gaps were recorded last week.', ...(unratedLine ? [unratedLine] : [])].join('\n'),
      gaps: 0,
    };
  }

  const lines = ranked.slice(0, TOP_N).map((g, i) => {
    const times = g.count > 1 ? ` — asked ${g.count}×` : '';
    const how = g.none === g.count ? 'not answered' : (g.none ? 'not or only partly answered' : 'only partly answered');
    return `${i + 1}. "${clip(g.question, QUESTION_MAX)}"${times}\n   ${how} · ${[...g.sources].join(', ')}`;
  });

  const bySource = new Map();
  for (const r of rows) bySource.set(sourceLabel(r.asked_by), (bySource.get(sourceLabel(r.asked_by)) || 0) + 1);
  const sourceLine = [...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', ');

  const { start, end } = reportWindow(now);
  const fmt = (d) => d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
  const text = [
    `${total} question${total === 1 ? '' : 's'} the knowledge base couldn't fully answer (${fmt(start)} – ${fmt(end)}).`,
    '',
    `Top ${Math.min(TOP_N, ranked.length)}:`,
    ...lines,
    ...(ranked.length > TOP_N ? [`…and ${ranked.length - TOP_N} more.`] : []),
    '',
    `Asked by: ${sourceLine}.`,
    ...(unratedLine ? [unratedLine] : []),
    'Each one is a candidate knowledge entry, written from UF/IFAS fact sheets, product labels or our protocols.',
  ].join('\n');

  return { subject: `Knowledge gaps: ${total} question${total === 1 ? '' : 's'} this week`, text, gaps: total };
}

// Durable weekly guard: a stamp at or after this report's end tick means this
// week's email already went out (deploy-overlap ticks can't double-send).
// A read failure sends anyway (a rare double beats a silently skipped week).
async function sentThisWeek(now = new Date()) {
  try {
    const row = await db('ops_email_send_state').where({ email_key: OPS_KEY }).first('last_sent_at');
    return Boolean(row?.last_sent_at && new Date(row.last_sent_at).getTime() >= reportWindow(now).end.getTime());
  } catch (err) {
    logger.warn(`[knowledge-gaps-weekly] send-marker read failed (${err.code || err.name || 'error'}) — proceeding without the guard`);
    return false;
  }
}

async function stampSent() {
  try {
    const now = new Date();
    await db('ops_email_send_state')
      .insert({ email_key: OPS_KEY, last_sent_at: now, updated_at: now })
      .onConflict('email_key')
      .merge({ last_sent_at: now, updated_at: now });
  } catch (err) {
    logger.warn(`[knowledge-gaps-weekly] send-marker write failed (${err.code || err.name || 'error'}) — next tick may re-send`);
  }
}

async function runKnowledgeGapsWeekly(opts = {}) {
  const now = opts.now || new Date();
  if (killed()) return { skipped: 'disabled' };
  const to = recipient();
  // FAIL CLOSED: owner/internal inboxes only.
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[knowledge-gaps-weekly] recipient is not an internal address — set a valid KNOWLEDGE_GAPS_EMAIL');
    return { skipped: 'recipient' };
  }
  const mailer = opts.sendgrid || sendgrid;
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) return { skipped: 'unconfigured' };
  if (await (opts.sentThisWeek || sentThisWeek)(now)) return { skipped: 'recent_send' };

  let week;
  try {
    week = await (opts.loadWeek || loadWeek)(now);
  } catch (err) {
    logger.error(`[knowledge-gaps-weekly] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }
  const composed = composeGapsEmail(week, now);

  let result;
  try {
    result = await mailer.sendOne({
      to,
      fromEmail: fromEmail(),
      fromName: FROM_NAME,
      subject: composed.subject,
      text: composed.text,
      categories: ['ops', OPS_KEY],
      suppressErrorLog: true,
    });
  } catch (err) {
    logger.error(`[knowledge-gaps-weekly] send failed (${err.code || err.name || 'error'})`);
    return { sent: false, error: true, gaps: composed.gaps };
  }
  if (result?.ok === false) {
    logger.error(`[knowledge-gaps-weekly] send reported not ok (${result.error || 'unknown'})`);
    return { sent: false, error: true, gaps: composed.gaps };
  }
  await (opts.stampSent || stampSent)();
  logger.info(`[knowledge-gaps-weekly] sent: ${composed.subject}`);
  return { sent: true, gaps: composed.gaps };
}

module.exports = {
  runKnowledgeGapsWeekly,
  _private: { composeGapsEmail, reportWindow, questionKey, sourceLabel, loadWeek, sentThisWeek, OPS_KEY },
};
