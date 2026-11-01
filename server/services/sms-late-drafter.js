/**
 * SMS late drafter: the texting AI's shadow drafter, run a few minutes late from the owner's Mac.
 *
 * Production keeps the live drafter off (GATE_SMS_SHADOW_DRAFTS) because each draft is a paid
 * model call. A scheduled Mac job calls draftPendingInbound() about every ten minutes instead, on
 * the owner's Max plan. It drafts the SAME silent shadow reply the webhook would have drafted
 * (same filter, same triage intent, same draftShadowReply, same prompt version, facts block and
 * status 'shadow'), so the nightly judge, the sealed-exam freezer and graduation read these rows
 * exactly like live ones. Nothing here sends, surfaces or notifies anything.
 *
 * What keeps a late draft honest:
 *   - asOf: the drafter reads the customer's messages only up to the inbound's own created_at
 *     (see ContextAggregator.getContextForCustomer), so the reply staff sent in between never
 *     reaches the prompt. Booking, invoice and visit state still reads as of the run.
 *   - liveEta:false: no GPS + Distance Matrix lookup.
 *   - the egress guard (late-draft-egress-guard.js): while drafting, the global fetch refuses any
 *     host that is not a model provider, so no other paid call can happen from a branch nobody
 *     read. Refusals come back as blockedExternal (host: count).
 *   - the silence guard: the run refuses unless, in THIS process, suggest mode, auto-send and the
 *     unanswered-reply stamp all read off. The drafter publishes a staff card or sends when the
 *     first two are on, and stamps a draft for the third. smsSuggestMode defaults ON outside
 *     production (feature-gates.js), so the job must run with NODE_ENV=production.
 *   - GATE_SMS_MAC_DRAFTS: strict opt-in kill switch, read on every call and again before each
 *     draft.
 *   - dedup: a text that already has ANY message_drafts row is never drafted again (so turning
 *     the live drafter back on cannot double up), and a Postgres advisory lock stops two
 *     overlapping runs picking the same text.
 *
 * Logs carry ids and codes only: never message text, names, phone numbers or error messages (a
 * knex error message can hold bound values).
 */

const db = require('../models/db');
const logger = require('./logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { isSmsReaction, hasSchedulingIntent } = require('./sms-intent');
const { PREHANDLED_INBOUND_TYPES } = require('./sms-shadow-backfill');
const { runWithoutPaidCalls } = require('./late-draft-egress-guard');

// What draftShadowReply is told about where the draft came from.
const SOURCE = 'mac_late';
// pg advisory lock key for "a late-draft run is in progress".
const RUN_LOCK_KEY = 641070301;
const MAX_LIMIT = 50;
// Candidates fetched per run beyond `limit`, so rows that fail a JS-side filter do not starve the
// batch. Bounded: the window is an hour and ineligible rows are rare.
const CANDIDATE_OVERFETCH = 5;

function gates() {
  return require('../config/feature-gates');
}

/**
 * Why a run must not draft, or null. Reads the gates in THIS process at call time. The drafter
 * turns a draft into a staff card when suggest mode is on, sends it when auto-send is on, and
 * stamps it for the unanswered-reply sweep when that is live; a late draft must do none of these.
 */
function silenceRefusal() {
  const g = gates();
  if (g.isEnabled('smsSuggestMode')) return 'suggest_mode_on';
  if (g.isEnabled('smsAutoSend')) return 'auto_send_on';
  if (require('./sms-unanswered-reply').unansweredReplyLive()) return 'unanswered_reply_on';
  // The live webhook drafter and this one never run together: with live drafting on (GATE_SMS_SHADOW_DRAFTS,
  // which the Mac job reads from production), a live draft still generating could race a late one for the same
  // text, and message_drafts has no unique key on sms_log_id. The Mac fills in only while live drafting is off.
  if (g.isEnabled('smsShadowDrafts')) return 'live_drafting_on';
  return null;
}

// The AI assistant line (twilio-webhook.js ~374). findByNumber reports it as a 'location' line,
// but its traffic is already AI-handled, so the live drafter skips it.
function isAiNumber(to) {
  const digits = String(to || '').replace(/\D/g, '');
  return digits === '18559260203' || digits === '8559260203';
}

function mediaCount(metadata) {
  let meta = metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }
  return Array.isArray(meta?.media) ? meta.media.length : 0;
}

// The webhook's own sender match (twilio-webhook.js findSingleCustomerByPhone): one active
// customer for the phone, shared-phone rules included. Lazy: it pulls the whole route module.
function defaultFindCustomer(phone) {
  return require('../routes/twilio-webhook')._internals.findSingleCustomerByPhone(phone);
}

// Inbound texts in the window that the SQL-expressible part of the webhook filter would have
// drafted and that have no draft yet, oldest first. PREHANDLED_INBOUND_TYPES are the flows the
// webhook finishes before the drafter (opt keywords, reactions, consumed reschedule and lead
// replies); an enforced spam verdict also returns before it.
// The staffed location lines the live drafter samples, as last-10 digits, minus the AI line: the SQL half
// of eligibility()'s line check (same source list as sms-shadow-backfill). Applied before the page limit
// so a burst of texts to other lines can never fill every page and starve location-line texts. An empty
// list matches nothing (fails closed).
function draftableLineLast10s() {
  return Object.values(TWILIO_NUMBERS.locations || {})
    .map((l) => l && l.number)
    .filter((n) => n && !isAiNumber(n) && TWILIO_NUMBERS.findByNumber(n)?.type === 'location')
    .map((n) => String(n).replace(/\D/g, '').slice(-10))
    .filter((d) => d.length === 10);
}

function candidateQuery(dbi, { windowStart, cutoff, fetchLimit }) {
  return dbi('sms_log as s')
    .where('s.direction', 'inbound')
    .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(s.to_phone, ''), '[^0-9]', '', 'g'), 10) = ANY(?)", [draftableLineLast10s()])
    .whereNotNull('s.customer_id')
    .where('s.created_at', '>=', windowStart)
    .where('s.created_at', '<=', cutoff)
    .whereRaw("COALESCE(s.message_type, '') <> ALL(?)", [PREHANDLED_INBOUND_TYPES])
    .whereRaw("NULLIF(TRIM(s.message_body), '') IS NOT NULL")
    .whereRaw("COALESCE(s.metadata->'spam_verdict'->>'enforced', 'false') != 'true'")
    .whereNotExists(function alreadyDrafted() {
      this.select(dbi.raw('1')).from('message_drafts as md').whereRaw('md.sms_log_id = s.id');
    })
    .orderBy('s.created_at', 'asc')
    .orderBy('s.id', 'asc')
    .limit(fetchLimit)
    .select('s.id', 's.customer_id', 's.message_body', 's.from_phone', 's.to_phone', 's.created_at', 's.metadata');
}

async function hasDraft(dbi, smsLogId) {
  const row = await dbi('message_drafts').where({ sms_log_id: smsLogId }).first('id');
  return Boolean(row);
}

/**
 * The rest of the webhook's drafter filter, on one candidate: { customer } to draft, or
 * { skip: code }. Body and customer are required, a reaction, the AI line and any line that is
 * not a staffed location line are out (twilio-webhook.js ~1456).
 */
async function eligibility(row, findCustomer) {
  const body = String(row.message_body || '');
  if (!body.trim()) return { skip: 'no_body' };
  if (isSmsReaction(body)) return { skip: 'reaction' };
  if (isAiNumber(row.to_phone)) return { skip: 'ai_number' };
  const config = TWILIO_NUMBERS.findByNumber(row.to_phone);
  if (!config || config.type !== 'location') return { skip: 'not_location_line' };
  const customer = await findCustomer(row.from_phone);
  if (!customer) return { skip: 'no_customer' };
  if (String(customer.id) !== String(row.customer_id)) return { skip: 'customer_changed' };
  return { customer };
}

// One draft, same call the webhook makes (twilio-webhook.js ~1465) plus the late-draft overrides.
async function draftOne(row, customer) {
  const { classifyCustomerSmsTriageIntent } = require('./estimate-conversion-agent');
  const body = String(row.message_body);
  const triage = classifyCustomerSmsTriageIntent(body, { customer });
  return require('./sms-shadow-drafter').draftShadowReply({
    inboundMessage: body,
    fromPhone: row.from_phone,
    customer,
    smsLogId: row.id,
    intent: triage,
    schedulingIntent: hasSchedulingIntent(body),
    source: SOURCE,
    hasMedia: mediaCount(row.metadata) > 0,
    asOf: new Date(row.created_at),
    liveEta: false,
  });
}

function errorCode(err) {
  return [err?.name || 'Error', err?.code].filter(Boolean).join(' ');
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

// Gate and silence checks, repeated before every draft: a flag flipped mid-run stops the run.
function runRefusal() {
  if (!gates().smsMacDraftsLive()) return 'gate_off';
  return silenceRefusal();
}

async function processRow(row, { dbi, findCustomer }, result) {
  const verdict = await eligibility(row, findCustomer);
  if (verdict.skip) {
    result.skipped += 1;
    bump(result.skippedReasons, verdict.skip);
    return;
  }
  // A draft may have landed since the candidate query (a slow live draft, an overlapping run).
  if (await hasDraft(dbi, row.id)) {
    result.skipped += 1;
    bump(result.skippedReasons, 'already_drafted');
    return;
  }
  const draftId = await draftOne(row, verdict.customer);
  if (draftId) {
    result.drafted += 1;
    logger.info(`[sms-late] drafted sms_log=${row.id} draft=${draftId}`);
  } else {
    result.failed += 1;
    logger.warn(`[sms-late] no draft stored for sms_log=${row.id}`);
  }
}

async function draftBatch(rows, ctx, limit, result) {
  for (const row of rows) {
    if (result.drafted + result.failed >= limit) break;
    const refusal = runRefusal();
    if (refusal) {
      result.stopped = refusal;
      logger.warn(`[sms-late] run stopped: ${refusal}`);
      break;
    }
    try {
      await processRow(row, ctx, result);
    } catch (err) {
      result.failed += 1;
      logger.warn(`[sms-late] draft threw for sms_log=${row.id}: ${errorCode(err)}`);
    }
  }
}

// Session-level advisory lock on a dedicated connection, so two overlapping runs (a slow tick and
// the next one) never pick the same text. A handle without a pool (tests) runs unlocked. A lock
// error skips the run; the next tick retries.
async function withRunLock(dbi, fn) {
  const client = dbi && dbi.client;
  if (!client || typeof client.acquireConnection !== 'function') return fn();
  let conn;
  try {
    conn = await client.acquireConnection();
    const res = await conn.query('SELECT pg_try_advisory_lock($1) AS ok', [RUN_LOCK_KEY]);
    if (!res.rows[0]?.ok) {
      client.releaseConnection(conn);
      return { skipped: 'locked' };
    }
  } catch (err) {
    logger.warn(`[sms-late] run lock unavailable: ${errorCode(err)}`);
    if (conn) { try { client.releaseConnection(conn); } catch { /* connection already gone */ } }
    return { skipped: 'lock_error' };
  }
  try {
    return await fn();
  } finally {
    await conn.query('SELECT pg_advisory_unlock($1)', [RUN_LOCK_KEY]).catch(() => {});
    client.releaseConnection(conn);
  }
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Draft the pending inbound texts. Returns:
 *   { skipped: 'gate_off' }            GATE_SMS_MAC_DRAFTS is off (nothing else ran)
 *   { refused: '<reason>' }            suggest mode, auto-send or the unanswered stamp reads on here
 *   { skipped: 'locked' | 'lock_error' } another run holds the lock
 *   { drafted, skipped, failed, examined, skippedReasons, stopped?, blockedExternal? }
 * `skipped` is a count here (rows that failed the webhook's filter); `failed` counts drafts that
 * stored nothing or threw. Oldest text first, at most `limit` drafted or failed per call.
 *
 * windowMinutes  how far back a text may have arrived
 * minAgeSeconds  a text must be at least this old (the live drafter, if on, gets first go)
 * dbi / findCustomer  injection points for tests
 */
async function draftPendingInbound({
  windowMinutes = 60, minAgeSeconds = 60, limit = 10, dbi = db, findCustomer = defaultFindCustomer, now = new Date(),
} = {}) {
  if (!gates().smsMacDraftsLive()) return { skipped: 'gate_off' };
  const refused = silenceRefusal();
  if (refused) {
    logger.warn(`[sms-late] refused: ${refused}`);
    return { refused };
  }
  const max = clampInt(limit, 10, 1, MAX_LIMIT);
  const windowStart = new Date(now.getTime() - clampInt(windowMinutes, 60, 1, 24 * 60) * 60 * 1000);
  const cutoff = new Date(now.getTime() - clampInt(minAgeSeconds, 60, 0, 3600) * 1000);

  return withRunLock(dbi, async () => {
    const rows = await candidateQuery(dbi, { windowStart, cutoff, fetchLimit: Math.min(max * CANDIDATE_OVERFETCH, 100) });
    const result = { drafted: 0, skipped: 0, failed: 0, examined: rows.length, skippedReasons: {} };
    const { blocked } = await runWithoutPaidCalls(() => draftBatch(rows, { dbi, findCustomer }, max, result));
    if (Object.keys(blocked).length) {
      result.blockedExternal = blocked;
      logger.warn(`[sms-late] external calls refused: ${Object.entries(blocked).map(([h, n]) => `${h}=${n}`).join(',')}`);
    }
    return result;
  });
}

module.exports = {
  draftPendingInbound,
  silenceRefusal,
  isAiNumber,
  SOURCE,
  _internals: { candidateQuery, eligibility, draftableLineLast10s, RUN_LOCK_KEY },
};
