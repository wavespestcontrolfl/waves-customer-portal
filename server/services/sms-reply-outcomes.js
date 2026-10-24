/**
 * Reply outcome signals (GATE_SMS_REPLY_OUTCOMES, default OFF; owner "do all" 2026-10-24).
 *
 * The SMS AI is judged by an LLM judge. This sweep adds the customer's side:
 * what did the person DO after each Waves reply to their text? One
 * sms_reply_outcomes row per reply, written once the longest window below has
 * closed (a reply is read SETTLE_HOURS after it was sent; the settle time is
 * derived from the windows, so it can never be set shorter than the opt-out
 * window and silently lose that signal).
 *
 * Signals (all deterministic; no model call, no message text stored):
 *  - confused:       a customer text within CONFUSION_WINDOW_MINUTES that reads like
 *                    confusion ("?", "huh", "what do you mean") or repeats the question
 *                    the reply answered (same words, Jaccard >= REPEAT_JACCARD).
 *  - opted_out:      a STOP-type text within OPTOUT_WINDOW_HOURS (the existing opt-out
 *                    detector, opt-out-detector.js).
 *  - called_back:    an inbound call from the same number within CALL_WINDOW_MINUTES.
 *  - positive_close: the FIRST text or tapback after the reply, within
 *                    POSITIVE_WINDOW_MINUTES, is a thanks / ok / thumbs-up (the existing
 *                    courtesy detector isCourtesyOnly in sms-intent.js, awaitingAnswer
 *                    false: a thumbs-up after a question still counts as engagement).
 *  - silent:         none of the above and no text, tapback or call at all.
 *
 * "Reply" = an outbound of REPLY_TYPES (staff manual, approved or edited AI
 * draft, auto-sent AI reply, AI gratitude reply) that has a customer text from
 * the same number in the REPLY_WINDOW_HOURS before it. Any other outbound of
 * those types is recorded as not_a_reply so the sweep never picks it twice.
 * AI replies carry the draft id and prompt_version, so the summary can compare
 * prompt versions by customer behavior.
 *
 * MEASUREMENT ONLY: this file never sends, changes or holds a message, and
 * writes only sms_reply_outcomes. Phones match on the full digits with or
 * without the leading 1 (US/Canada only), never on the last 10 digits alone.
 * Logs carry counts and error codes only.
 */

const db = require('../models/db');
const logger = require('./logger');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { detectSmsOptCommand } = require('./messaging/opt-out-detector');
const { isCourtesyOnly, isSmsReaction, isAffirmativeSmsReaction } = require('./sms-intent');

const CONFUSION_WINDOW_MINUTES = 30;
const CALL_WINDOW_MINUTES = 60;
const POSITIVE_WINDOW_MINUTES = 240;
const OPTOUT_WINDOW_HOURS = 72;
// Longest window above: a row is written when every signal can be read.
const SETTLE_HOURS = Math.max(
  OPTOUT_WINDOW_HOURS,
  CONFUSION_WINDOW_MINUTES / 60,
  CALL_WINDOW_MINUTES / 60,
  POSITIVE_WINDOW_MINUTES / 60,
);
const REPLY_WINDOW_HOURS = 24;
const LOOKBACK_DAYS = 30;
const DEFAULT_LIMIT = 200;
const MAX_INBOUND_ROWS = 100;
const REPEAT_JACCARD = 0.7;
const REPEAT_MIN_TOKENS = 3;
const MIN_SAMPLE = 20;

// Outbound sms_log.message_type values that answer a customer text.
const REPLY_TYPES = ['manual', 'ai_approved', 'ai_revised', 'ai_autosent', 'ai_gratitude'];
const SENT_STATUSES = ['queued', 'sent', 'delivered'];
// Customer-facing inbound texts (twilio-webhook.js messageType) and tapbacks.
const TEXT_TYPES = ['inbound', 'domain_lead', 'van_lead'];
const REACTION_TYPE = 'sms_reaction';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (value) => (typeof value === 'string' && UUID_RE.test(value) ? value : null);

// Whole message is a bare "what?" / "?" / "huh".
const BARE_CONFUSION_RE = /^[\s.!]*(?:\?+|what|wut|sorry|pardon|huh|hm+|wdym)[\s?!.]*$/i;
const CONFUSION_PHRASE_RE = /(?:^|[^a-z])(?:huh|what\s+do\s+you\s+mean|what\s+does\s+that\s+mean|what\s+was\s+that|i\s+(?:do\s*n'?t|dont)\s+(?:understand|get\s+it|follow)|not\s+sure\s+what\s+you\s+mean|confused|come\s+again|say\s+that\s+again|(?:can|could)\s+you\s+(?:say|explain|repeat|clarify)\s+(?:that|it))(?:[^a-z]|$)/i;
const CONFUSION_MAX_CHARS = 120;

const normalizeText = (body) => String(body || '').replace(/[‘’]/g, "'").trim();

function tokenSet(body) {
  return new Set(normalizeText(body).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// 'confusion_phrase' | 'repeat' | null for one customer text that followed a reply.
function confusionReason(body, priorQuestionBody) {
  const text = normalizeText(body);
  if (!text || text.length > CONFUSION_MAX_CHARS * 4) return null;
  if (text.length <= CONFUSION_MAX_CHARS && (BARE_CONFUSION_RE.test(text) || CONFUSION_PHRASE_RE.test(text))) {
    return 'confusion_phrase';
  }
  if (priorQuestionBody) {
    const a = tokenSet(text);
    const b = tokenSet(priorQuestionBody);
    if (a.size >= REPEAT_MIN_TOKENS && b.size >= REPEAT_MIN_TOKENS && jaccard(a, b) >= REPEAT_JACCARD) return 'repeat';
  }
  return null;
}

function nanpDigits(phone) {
  const text = typeof phone === 'string' ? phone.trim() : '';
  const digits = text.replace(/\D/g, '');
  if (/^1\d{10}$/.test(digits)) return { full: digits, ten: digits.slice(1), prefixed: text.startsWith('+') };
  if (/^\d{10}$/.test(digits) && !text.startsWith('+')) return { full: `1${digits}`, ten: digits, prefixed: false };
  return null;
}

const DIGITS_SQL = (column) => `regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g')`;
// Same number, US/Canada only: the full 11 digits, or 10 digits when the stored
// value has no '+'. The RIGHT(...,10) term lets the last-10 expression index serve the scan.
function whereSamePhone(query, column, phone) {
  return query
    .whereRaw(`RIGHT(${DIGITS_SQL(column)}, 10) = ?`, [phone.ten])
    .whereRaw(
      `(${DIGITS_SQL(column)} = ? OR (${DIGITS_SQL(column)} = ? AND COALESCE(${column}, '') NOT LIKE '+%'))`,
      [phone.full, phone.ten],
    );
}

async function resolveDrafts(replies, dbh) {
  const byReply = new Map();
  const decisionIds = new Set();
  for (const reply of replies) {
    const meta = reply.metadata && typeof reply.metadata === 'object' ? reply.metadata : {};
    const entry = { draftId: asUuid(meta.draft_id), decisionId: asUuid(meta.agent_decision_id) };
    byReply.set(reply.id, entry);
    if (!entry.draftId && entry.decisionId) decisionIds.add(entry.decisionId);
  }
  if (decisionIds.size) {
    const decisions = await dbh('agent_decisions')
      .whereIn('id', [...decisionIds]).where({ entity_type: 'message_draft' }).select('id', 'entity_id');
    const draftByDecision = new Map(decisions.map((d) => [d.id, d.entity_id]));
    for (const entry of byReply.values()) {
      if (!entry.draftId && entry.decisionId) entry.draftId = draftByDecision.get(entry.decisionId) || null;
    }
  }
  const draftIds = [...new Set([...byReply.values()].map((e) => e.draftId).filter(Boolean))];
  const versions = new Map();
  if (draftIds.length) {
    const drafts = await dbh('message_drafts').whereIn('id', draftIds).select('id', 'prompt_version');
    for (const d of drafts) versions.set(d.id, d.prompt_version || null);
  }
  const out = new Map();
  for (const [replyId, entry] of byReply) {
    out.set(replyId, { draftId: entry.draftId, promptVersion: entry.draftId ? (versions.get(entry.draftId) ?? null) : null });
  }
  return out;
}

async function readReplyCandidates({ dbh, now, limit, lookbackDays }) {
  const newest = new Date(now.getTime() - SETTLE_HOURS * 3600 * 1000);
  const oldest = new Date(now.getTime() - lookbackDays * 86400 * 1000);
  const toDigits = DIGITS_SQL('s.to_phone');
  return excludeUnresolvedSendReservations(dbh('sms_log as s'), 's')
    .where('s.direction', 'outbound')
    .whereIn('s.message_type', REPLY_TYPES)
    .whereIn('s.status', SENT_STATUSES)
    .where('s.created_at', '>=', oldest)
    .where('s.created_at', '<=', newest)
    // US/Canada numbers only; the exact match is rebuilt in nanpDigits.
    .whereRaw(`(${toDigits} ~ '^1[0-9]{10}$' OR (${toDigits} ~ '^[0-9]{10}$' AND COALESCE(s.to_phone, '') NOT LIKE '+%'))`)
    .whereNotExists(function alreadyMeasured() {
      this.select(dbh.raw('1')).from('sms_reply_outcomes as o').whereRaw('o.reply_sms_log_id = s.id');
    })
    .orderBy('s.created_at', 'asc')
    .limit(limit)
    .select('s.id', 's.customer_id', 's.to_phone', 's.message_type', 's.created_at', 's.metadata');
}

// The customer text this reply answered: newest customer-facing inbound from the
// same number in the REPLY_WINDOW_HOURS before the reply.
async function readAnsweredText({ dbh, reply, phone }) {
  const since = new Date(new Date(reply.created_at).getTime() - REPLY_WINDOW_HOURS * 3600 * 1000);
  const query = excludeUnresolvedSendReservations(dbh('sms_log'))
    .where({ direction: 'inbound' })
    .whereIn('message_type', TEXT_TYPES)
    .where('created_at', '>=', since)
    .where('created_at', '<', reply.created_at);
  return whereSamePhone(query, 'from_phone', phone)
    .orderBy('created_at', 'desc')
    .first('id', 'message_body');
}

async function readFollowUps({ dbh, reply, phone }) {
  const start = new Date(reply.created_at);
  const end = new Date(start.getTime() + OPTOUT_WINDOW_HOURS * 3600 * 1000);
  const query = excludeUnresolvedSendReservations(dbh('sms_log'))
    .where({ direction: 'inbound' })
    .where('created_at', '>', start)
    .where('created_at', '<=', end)
    .whereRaw("COALESCE(message_type, '') NOT LIKE 'job\\_%'")
    .whereRaw("COALESCE(message_type, 'inbound') NOT IN ('help_request', 'opt_in')");
  return whereSamePhone(query, 'from_phone', phone)
    .orderBy('created_at', 'asc')
    .limit(MAX_INBOUND_ROWS)
    .select('id', 'message_type', 'message_body', 'created_at');
}

async function readCallBack({ dbh, reply, phone }) {
  const start = new Date(reply.created_at);
  const end = new Date(start.getTime() + CALL_WINDOW_MINUTES * 60 * 1000);
  const query = dbh('call_log')
    .where({ direction: 'inbound' })
    .where('created_at', '>', start)
    .where('created_at', '<=', end);
  return Boolean(await whereSamePhone(query, 'from_phone', phone).first('id'));
}

// A tapback ("Liked “…”"): the webhook stores one on a conversational question as an ordinary
// 'inbound' row, and only a quiet one as 'sms_reaction', so the body decides, not the type.
const isReactionRow = (row) => (row.message_type || 'inbound') === REACTION_TYPE || isSmsReaction(row.message_body);

// The first text or tapback after the reply is a thanks / ok / thumbs-up / like, inside the window.
function isPositiveClose(first, windowEnd) {
  if (!first || new Date(first.created_at).getTime() > windowEnd) return false;
  if (!isReactionRow(first)) return isCourtesyOnly(first.message_body, { awaitingAnswer: false });
  return isAffirmativeSmsReaction(first.message_body) && !/^\s*removed\b/i.test(first.message_body || '');
}

// Pure: the signals for one reply from its follow-up rows.
function classifyFollowUps({ replyAt, followUps, answeredBody, calledBack }) {
  const start = new Date(replyAt).getTime();
  const confusionEnd = start + CONFUSION_WINDOW_MINUTES * 60 * 1000;
  const positiveEnd = start + POSITIVE_WINDOW_MINUTES * 60 * 1000;
  let optedOut = false;
  let confused = false;
  let confusionWhy = null;
  let first = null;
  for (const row of followUps) {
    const type = row.message_type || 'inbound';
    const at = new Date(row.created_at).getTime();
    if (type === 'opt_out' || detectSmsOptCommand(row.message_body).action === 'opt_out') {
      optedOut = true;
      continue;
    }
    const reaction = isReactionRow(row);
    const isText = TEXT_TYPES.includes(type) && !reaction;
    if (!isText && !reaction) continue;
    if (!first) first = row;
    if (isText && at <= confusionEnd && !confused) {
      const why = confusionReason(row.message_body, answeredBody);
      if (why) { confused = true; confusionWhy = why; }
    }
  }
  const positiveClose = isPositiveClose(first, positiveEnd);
  return {
    confused,
    confusion_reason: confusionWhy,
    opted_out: optedOut,
    called_back: Boolean(calledBack),
    positive_close: positiveClose,
    silent: !first && !optedOut && !calledBack,
    first_inbound_at: first ? new Date(first.created_at) : null,
    first_inbound_seconds: first ? Math.round((new Date(first.created_at).getTime() - start) / 1000) : null,
  };
}

async function measureReply({ dbh, reply, draft, now }) {
  const phone = nanpDigits(reply.to_phone);
  const base = {
    reply_sms_log_id: reply.id,
    customer_id: reply.customer_id || null,
    phone_last10: phone ? phone.ten : String(reply.to_phone || '').replace(/\D/g, '').slice(-10).padStart(10, '0'),
    reply_source: reply.message_type,
    reply_at: reply.created_at,
    draft_id: draft?.draftId || null,
    prompt_version: draft?.promptVersion ? String(draft.promptVersion).slice(0, 60) : null,
    computed_at: now,
  };
  const answered = phone ? await readAnsweredText({ dbh, reply, phone }) : null;
  if (!answered) return { ...base, status: 'not_a_reply', replied_to_sms_log_id: null };
  const followUps = await readFollowUps({ dbh, reply, phone });
  const calledBack = await readCallBack({ dbh, reply, phone });
  const signals = classifyFollowUps({ replyAt: reply.created_at, followUps, answeredBody: answered.message_body, calledBack });
  return { ...base, status: 'computed', replied_to_sms_log_id: answered.id, ...signals };
}

/**
 * One bounded batch. Idempotent: a reply already measured is skipped by the
 * query and by the unique key. Returns counts only.
 */
async function sweepReplyOutcomes({ now = new Date(), limit = DEFAULT_LIMIT, lookbackDays = LOOKBACK_DAYS, dbh = db } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('smsReplyOutcomes')) return { skipped: 'gate_off' };

  const replies = await readReplyCandidates({ dbh, now, limit, lookbackDays });
  const drafts = replies.length ? await resolveDrafts(replies, dbh) : new Map();
  const result = { considered: replies.length, computed: 0, not_a_reply: 0, failed: 0 };
  for (const reply of replies) {
    try {
      const row = await measureReply({ dbh, reply, draft: drafts.get(reply.id), now });
      await dbh('sms_reply_outcomes').insert(row).onConflict('reply_sms_log_id').ignore();
      result[row.status] += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn(`[sms-reply-outcomes] reply not measured (code ${err?.code || err?.name || 'unknown'})`);
    }
  }
  if (result.considered) {
    logger.info(`[sms-reply-outcomes] considered=${result.considered} computed=${result.computed} not_a_reply=${result.not_a_reply} failed=${result.failed}`);
  }
  return result;
}

const rate = (n, d) => (d ? Math.round((10000 * n) / d) / 10000 : null);

function rollup(label, rows) {
  const total = rows.reduce((s, r) => s + Number(r.total || 0), 0);
  const sum = (key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);
  const confused = sum('confused');
  const optedOut = sum('opted_out');
  const calledBack = sum('called_back');
  const positive = sum('positive_close');
  const silent = sum('silent');
  return {
    ...label,
    count: total,
    confusion_rate: rate(confused, total),
    opt_out_rate: rate(optedOut, total),
    call_back_rate: rate(calledBack, total),
    positive_close_rate: rate(positive, total),
    silent_rate: rate(silent, total),
    inconclusive: total < MIN_SAMPLE,
  };
}

/**
 * Read-only summary of computed outcomes for replies sent in [since, until):
 * per prompt_version, per reply source, and per pair. Rates are shares of the
 * count; a group under MIN_SAMPLE replies is flagged inconclusive. Replies
 * with no AI draft behind them group under prompt_version '(none)'.
 */
async function summarizeReplyOutcomes({ dbh = db, now = new Date(), since = null, until = null, days = LOOKBACK_DAYS } = {}) {
  const to = until ? new Date(until) : now;
  const from = since ? new Date(since) : new Date(to.getTime() - days * 86400 * 1000);
  const cells = await dbh('sms_reply_outcomes')
    .where({ status: 'computed' })
    .where('reply_at', '>=', from)
    .where('reply_at', '<', to)
    .groupByRaw("COALESCE(prompt_version, '(none)'), reply_source")
    .select(dbh.raw("COALESCE(prompt_version, '(none)') AS prompt_version"), 'reply_source')
    .count('id as total')
    .select(dbh.raw('COUNT(*) FILTER (WHERE confused) AS confused'))
    .select(dbh.raw('COUNT(*) FILTER (WHERE opted_out) AS opted_out'))
    .select(dbh.raw('COUNT(*) FILTER (WHERE called_back) AS called_back'))
    .select(dbh.raw('COUNT(*) FILTER (WHERE positive_close) AS positive_close'))
    .select(dbh.raw('COUNT(*) FILTER (WHERE silent) AS silent'));
  const group = (key) => [...new Set(cells.map((c) => c[key]))].sort()
    .map((value) => rollup({ [key]: value }, cells.filter((c) => c[key] === value)));
  return {
    since: from.toISOString(),
    until: to.toISOString(),
    overall: rollup({}, cells),
    by_prompt_version: group('prompt_version'),
    by_reply_source: group('reply_source'),
    by_prompt_version_and_source: cells
      .map((c) => rollup({ prompt_version: c.prompt_version, reply_source: c.reply_source }, [c]))
      .sort((a, b) => `${a.prompt_version}/${a.reply_source}`.localeCompare(`${b.prompt_version}/${b.reply_source}`)),
  };
}

module.exports = {
  sweepReplyOutcomes,
  summarizeReplyOutcomes,
  classifyFollowUps,
  confusionReason,
  REPLY_TYPES,
  SETTLE_HOURS,
  MIN_SAMPLE,
  _private: { nanpDigits, rollup },
};
