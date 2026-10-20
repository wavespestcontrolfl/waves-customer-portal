'use strict';

/**
 * Day-only agreement shadow sweep (GATE_DAY_AGREEMENT_SHADOW, owner 2026-10-20, PR 1 of 2).
 *
 * When a call or a text thread agrees a DAY for a visit (or the move of one)
 * and no clock time, nothing is booked and the customer waits. The proposed
 * agent picks the time on that day itself. This PR is the SHADOW half only:
 * it books nothing, moves nothing and texts no one. Every 10 minutes it
 *
 *   1. finds sources not judged yet:
 *        - CALLS: two-party calls (not voicemail, not spam, not a voice-agent
 *          sandbox call) whose pipeline verdict landed in the last 3 hours and
 *          whose valid V2 extraction has scheduling.status requested,
 *          reschedule_requested, ambiguous or offered;
 *        - TEXT THREADS: a phone whose latest inbound text is under 3 hours
 *          old, carries a day word, and has had no message either way for 30
 *          minutes (staff had time to act);
 *   2. asks ONE model call per source (TEXT_POLICIES.highStakes through
 *      dispatchWithFallback, lane day_agreement) what the office should do at
 *      each agreement moment (prompts/day-agreement-v1.js);
 *   3. applies the deterministic rules (day-agreement-rules.js), picks the
 *      first slot the route-aware time picker (scheduling/find-time.js) would
 *      take on the agreed day, and
 *   4. records the verdict and its reason in day_agreement_decisions.
 *
 * A week of rows is scored against what staff did
 * (scripts/day-agreement-shadow-report.js). The act step (book or move, then
 * the confirmation text) is a later PR and is NOT built here.
 *
 * Privacy: nothing stored or logged holds a transcript or a message. Logs
 * carry counts and error codes only (knex errors carry bindings, so an error
 * message is never logged).
 */

const Ajv = require('ajv/dist/2020');
const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { isEnabled } = require('../config/feature-gates');
const { dispatchWithFallback } = require('./llm/call');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { isRealConversation, parseExtraction } = require('./call-held-visits');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { scrubPans } = require('../utils/pan-scrub');
const { etDateString, etParts, addETDays, parseETDateTime } = require('../utils/datetime-et');
const prompts = require('./prompts/day-agreement-v1');
const rules = require('./day-agreement-rules');

const HOUR_MS = 3600 * 1000;
const RECENT_MS = 3 * HOUR_MS;
const QUIET_MS = 30 * 60 * 1000;
const THREAD_DAYS = 14;
const THREAD_MESSAGES = 50;
const MESSAGE_CHARS = 600;
// A longer call is skipped, never judged on a cut transcript: a later
// withdrawal or change would be invisible (pre-push audit P1).
const TRANSCRIPT_CHARS = 30000;
const DELIVERED_STATUSES = ['sent', 'delivered', 'read'];
const CALL_SCAN_LIMIT = 100;
// Per tick, per source kind: the rest wait for the next tick (still inside the 3 hour window).
const BATCH = { call: 4, sms: 4 };
const SCHEDULING_STATUSES = new Set(['requested', 'reschedule_requested', 'ambiguous', 'offered']);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SLOT_TOP_N = 500;

const validateShape = new Ajv({ strict: false, allErrors: true }).compile(prompts.SCHEMA);

// ---- time helpers ------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

function etStamp(date) {
  const p = etParts(date);
  return `${DAY_NAMES[p.dayOfWeek]} ${etDateString(date)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

// The model's `at` (YYYY-MM-DDTHH:MM, Eastern) into a Date, or null.
function parseAt(text) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(String(text || ''));
  if (!m || !rules.validDay(m[1])) return null;
  const date = parseETDateTime(`${m[1]}T${m[2]}:${m[3]}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const digitsOf = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

// ---- candidates --------------------------------------------------------------------------

// Calls whose pipeline verdict landed in the window and that no row covers yet.
// Every judged source has a '#0' row (see the migration), so one equality on
// the unique index says "already judged".
function callCandidatesQuery(conn, now) {
  return conn('call_log as c')
    .modify((q) => whereNotSandboxCall(q, 'c.source'))
    .where('c.processed_at', '>=', new Date(now.getTime() - RECENT_MS))
    .where('c.v2_extraction_status', 'valid')
    .whereNotNull('c.ai_extraction_enriched')
    .whereNotNull('c.transcription')
    .whereRaw("COALESCE(c.processing_status, '') NOT IN ('voicemail', 'spam', 'processing')")
    .whereRaw("NOT EXISTS (SELECT 1 FROM day_agreement_decisions d WHERE d.source_key = 'call:' || c.id::text || '#0')")
    .orderBy('c.processed_at', 'asc')
    .limit(CALL_SCAN_LIMIT)
    .select('c.id', 'c.customer_id', 'c.created_at', 'c.processing_status', 'c.answered_by', 'c.ai_extraction_enriched',
      conn.raw('left(c.transcription, ?) AS transcription', [TRANSCRIPT_CHARS + 1]));
}

async function loadCallCandidates(conn, now) {
  const rows = await callCandidatesQuery(conn, now);
  return rows.filter((row) => {
    const extraction = parseExtraction(row.ai_extraction_enriched);
    return extraction && SCHEDULING_STATUSES.has(extraction.scheduling?.status) && isRealConversation(row, extraction);
  }).slice(0, BATCH.call);
}

const LAST10_SQL = "right(regexp_replace(%I, '\\D', '', 'g'), 10)";
const last10 = (column) => LAST10_SQL.replace('%I', column);

// Phones whose LATEST inbound text is in the window, has a day word, and whose
// thread has been quiet (no text either way) for QUIET_MS. The inner query
// keeps the latest inbound text per phone; the day word and quiet tests judge
// that one text, so an older text never stands in for a newer one.
function smsCandidatesSql() {
  return `
    SELECT l.id, l.customer_id, l.created_at, l.digits
    FROM (
      SELECT DISTINCT ON (${last10('from_phone')})
        id, customer_id, created_at, message_body, ${last10('from_phone')} AS digits
      FROM sms_log
      WHERE direction = 'inbound' AND created_at >= ? AND message_body IS NOT NULL
      ORDER BY ${last10('from_phone')}, created_at DESC, id DESC
    ) l
    WHERE length(l.digits) = 10
      AND l.message_body ~* ?
      AND NOT EXISTS (SELECT 1 FROM day_agreement_decisions d WHERE d.source_key = 'sms:' || l.digits || ':' || l.id::text || '#0')
      AND NOT EXISTS (
        SELECT 1 FROM sms_log m
        WHERE m.created_at > ? AND (${last10('m.from_phone')} = l.digits OR ${last10('m.to_phone')} = l.digits)
      )
    ORDER BY l.created_at ASC
    LIMIT ?`;
}

function smsCandidatesQuery(conn, now) {
  return conn.raw(smsCandidatesSql(), [
    new Date(now.getTime() - RECENT_MS), rules.DAY_WORD_PATTERN, new Date(now.getTime() - QUIET_MS), BATCH.sms,
  ]);
}

async function loadSmsCandidates(conn, now) {
  const result = await smsCandidatesQuery(conn, now);
  return result.rows || [];
}

// ---- context for the model ---------------------------------------------------------------

async function visitLines(conn, customerId, referenceAt, now) {
  const since = etDateString(addETDays(now, -30));
  const rows = await conn('scheduled_services')
    .where('customer_id', customerId)
    .where('created_at', '<=', referenceAt)
    .where('scheduled_date', '>=', since)
    .whereNotIn('status', rules.DEAD_STATUSES)
    .orderBy('scheduled_date', 'asc')
    .limit(40)
    .select('status', 'service_type', 'window_start', conn.raw("to_char(scheduled_date, 'YYYY-MM-DD') AS d"));
  return rows.map((r) => `${r.d} ${r.window_start ? String(r.window_start).slice(0, 5) : 'no time set'} ${r.service_type || 'service'} (${r.status})`);
}

function messageLine(row) {
  const body = scrubPans(String(row.message_body || '')).replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CHARS);
  if (!body) return null;
  const who = row.direction === 'inbound' ? 'CUSTOMER' : `WAVES${row.message_type ? ` (${row.message_type})` : ''}`;
  return `[${etStamp(new Date(row.created_at))}] ${who}: ${body}`;
}

// The last THREAD_MESSAGES texts between Waves and this phone, oldest first.
async function threadLines(conn, customerId, digits, now) {
  const rows = await excludeUnresolvedSendReservations(conn('sms_log'))
    .where('customer_id', customerId)
    .where('created_at', '>=', new Date(now.getTime() - THREAD_DAYS * 24 * HOUR_MS))
    .whereNotNull('message_body')
    // A Waves text counts only once it went out: a scheduled or failed row was
    // never seen by the customer, so it is no staff word (pre-push audit P1).
    .where((q) => q.where('direction', 'inbound').orWhereIn('status', DELIVERED_STATUSES))
    .orderBy('created_at', 'desc').orderBy('id', 'desc')
    .limit(200)
    .select('direction', 'from_phone', 'to_phone', 'message_type', 'message_body', 'created_at');
  return rows
    .filter((r) => digitsOf(r.direction === 'inbound' ? r.from_phone : r.to_phone) === digits)
    .slice(0, THREAD_MESSAGES).reverse().map(messageLine).filter(Boolean);
}

function callSource(row) {
  const transcript = scrubPans(String(row.transcription || '')).split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    kind: 'call', key: `call:${row.id}`, callLogId: row.id, phoneDigits: null,
    customerId: row.customer_id || null, agreedAt: new Date(row.created_at), lines: transcript,
    truncated: String(row.transcription || '').length > TRANSCRIPT_CHARS,
    label: `This is a phone call that started ${etStamp(new Date(row.created_at))} (Eastern time). The speaker labels may be swapped: use the content.`,
  };
}

async function smsSource(conn, row, now) {
  return {
    kind: 'sms', key: `sms:${row.digits}:${row.id}`, callLogId: null, phoneDigits: row.digits,
    customerId: row.customer_id || null, agreedAt: new Date(row.created_at),
    lines: row.customer_id ? await threadLines(conn, row.customer_id, row.digits, now) : [],
    label: 'This is a text thread, oldest first. Times are Eastern. CUSTOMER lines are texts from the customer; WAVES lines are texts from Waves, with the automated message type in brackets.',
  };
}

// ---- the model ---------------------------------------------------------------------------

// An answer is usable only if it matches the schema and every act:true object
// has a known kind and a real day. A rejection fails that leg, so the backup
// model gets a turn.
function validateAnswer(result) {
  if (!validateShape(result?.json)) return 'schema_invalid';
  return rules.unusableReason(result.json.agreements);
}

async function judge(parts, deps) {
  const dispatch = deps.dispatch || dispatchWithFallback;
  const result = await dispatch(MODELS.TEXT_POLICIES.highStakes, {
    system: parts.system, text: parts.text, jsonMode: true, jsonSchema: prompts.SCHEMA,
    maxTokens: 3000, laneId: 'day_agreement', promptVersion: prompts.VERSION,
  }, { validate: validateAnswer });
  if (result?.ok) return { ok: true, agreements: result.json.agreements, model: String(result.model || '').slice(0, 80) };
  // A validator rejection on every leg is a deterministic bad answer: record it.
  // Anything else (a provider outage) is transient: record nothing, retry next tick.
  // Only when EVERY leg failed on a validator rejection: a mix (one bad answer, one
  // timeout or 529) stays retryable.
  const failures = result?.failures || [];
  const unusable = failures.length > 0 && failures.every((f) => f.validator === true);
  return { ok: false, transient: !unusable, reason: result?.reason || 'error' };
}

// ---- facts and the time picker -----------------------------------------------------------

async function visitFacts(conn, customerId, days) {
  const wanted = days.filter((d) => rules.validDay(d));
  if (!wanted.length) return [];
  return conn('scheduled_services')
    .where('customer_id', customerId)
    .whereIn('scheduled_date', wanted)
    .select('id', 'status', 'created_at', 'updated_at', 'estimated_duration_minutes', 'service_type', 'lat', 'lng',
      conn.raw("to_char(scheduled_date, 'YYYY-MM-DD') AS d"));
}

async function coordinates(conn, customerId, fromVisit) {
  const customer = await conn('customers').where({ id: customerId }).first('latitude', 'longitude');
  const lat = parseFloat(customer?.latitude ?? fromVisit?.lat);
  const lng = parseFloat(customer?.longitude ?? fromVisit?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

// Offer/commit parity (AGENTS.md booking conflict-check class): without
// capacity routing, find-time reads a technician's own route only, so a visit
// with no technician is invisible to it. The estimate picker's collision guard
// (filterCollidingSlots) checks every live row of the day, tech-blind, plus the
// zone and travel-gap rules; the shadow uses the same guard so it never records
// a window the reserve gate would refuse. Under capacity routing the route
// already holds unassigned blockers and the guard is not applied (it would
// drop every slot that is not an arrival-window slot). The visit being moved is
// excluded from the check.
async function dropCollidingSlots(slots, { day, where, fromVisit }, deps) {
  const { capacityEnabled } = require('./scheduling/policy');
  if (capacityEnabled()) return slots;
  const filterColliding = deps.filterColliding || require('./estimate-slot-availability').filterCollidingSlots;
  const shaped = slots.map((slot) => ({
    slot, date: slot.date, techId: slot.technician?.id || null, windowStart: slot.start_time, windowEnd: slot.end_time,
  }));
  const kept = new Set(await filterColliding(shaped, {
    dateFrom: day, dateTo: day, coords: where, excludeServiceIds: fromVisit ? [fromVisit.id] : [],
  }));
  return shaped.filter((s) => kept.has(s)).map((s) => s.slot);
}

// The first slot the picker would take on the agreed day, honoring the daypart
// and whole-hour starts. { slot } or { reason }.
async function pickSlot(conn, { customerId, day, daypart, fromVisit }, deps) {
  const where = await coordinates(conn, customerId, fromVisit);
  if (!where) return { reason: 'no_coordinates' };
  const findSlots = deps.findSlots || require('./scheduling/find-time').findAvailableSlots;
  const result = await findSlots({
    lat: where.lat, lng: where.lng,
    durationMinutes: Number(fromVisit?.estimated_duration_minutes) || 60,
    serviceType: fromVisit?.service_type || undefined,
    dateFrom: day, dateTo: day, topN: SLOT_TOP_N,
    includeWeekends: true, slotStepMinutes: 60, everyStepStart: true, providerTravel: false,
    excludeServiceIds: fromVisit ? [fromVisit.id] : [],
  });
  const offered = result && !result.error && Array.isArray(result.slots) ? result.slots : [];
  const free = offered.length ? await dropCollidingSlots(offered, { day, where, fromVisit }, deps) : [];
  const slot = rules.chooseSlot(free, daypart);
  return slot ? { slot } : { reason: 'no_slot' };
}

// ---- one moment into one row -------------------------------------------------------------

function baseRow(src, index) {
  return {
    source_kind: src.kind, source_key: `${src.key}#${index}`, call_log_id: src.callLogId, phone_digits: src.phoneDigits,
    customer_id: src.customerId, agreed_at: src.agreedAt, judged: null, verdict: 'skip', skip_reason: null,
    target_date: null, from_visit_id: null, chosen_window_start: null, chosen_technician_id: null,
    model: null, prompt_version: prompts.VERSION,
  };
}

const skipRow = (src, index, reason, extra = {}) => ({ ...baseRow(src, index), skip_reason: reason, ...extra });

async function decideMoment(conn, src, index, agreement, ctx) {
  const a = rules.normalizeAgreement(agreement);
  const agreedAt = src.kind === 'call' ? src.agreedAt : (parseAt(a.at) || src.agreedAt);
  const known = { model: ctx.model, judged: JSON.stringify(a), agreed_at: agreedAt };
  const dayVisits = a.act ? await visitFacts(conn, src.customerId, [a.day, a.from_day]) : [];
  const decision = rules.decideAgreement({
    agreement: a, kind: src.kind, customerId: src.customerId, todayET: ctx.todayET, agreedAt, now: ctx.now,
    visitsOnDay: dayVisits.filter((v) => v.d === a.day),
    visitsOnFromDay: dayVisits.filter((v) => v.d === a.from_day),
  });
  const target = rules.validDay(a.day) ? { target_date: a.day } : {};
  if (!decision.pass) return skipRow(src, index, decision.reason, { ...known, ...target });
  const fromVisit = decision.fromVisitId ? dayVisits.find((v) => v.id === decision.fromVisitId) : null;
  let picked;
  try {
    picked = await pickSlot(conn, { customerId: src.customerId, day: a.day, daypart: a.daypart, fromVisit }, ctx.deps);
  } catch (err) {
    logger.error(`[day-agreement] slot lookup failed (${err.code || err.name || 'error'})`);
    picked = { reason: 'slot_lookup_failed' };
  }
  const withVisit = { ...known, ...target, from_visit_id: decision.fromVisitId };
  if (!picked.slot) return skipRow(src, index, picked.reason, withVisit);
  return {
    ...baseRow(src, index), ...withVisit, verdict: decision.kind === 'move' ? 'would_move' : 'would_book',
    chosen_window_start: picked.slot.start_time, chosen_technician_id: picked.slot.technician?.id || null,
  };
}

// All the rows for one source: a skip without a model call when it has no
// customer or no text, otherwise one row for each moment the model listed.
async function processSource(conn, src, ctx) {
  if (!src.customerId) return { rows: [skipRow(src, 0, 'no_customer')] };
  if (!src.lines.length) return { rows: [skipRow(src, 0, 'no_text')] };
  if (src.truncated) return { rows: [skipRow(src, 0, 'transcript_too_long')] };
  const lines = await visitLines(conn, src.customerId, src.agreedAt, ctx.now);
  const parts = prompts.buildDayAgreementPrompt({
    sourceLabel: src.label, todayET: ctx.todayET, weekdayET: WEEKDAYS[etParts(ctx.now).dayOfWeek], visits: lines, lines: src.lines,
  });
  const judged = await judge(parts, ctx.deps);
  if (!judged.ok) return judged.transient ? { transient: true } : { rows: [skipRow(src, 0, 'judge_unusable')] };
  const rows = [];
  for (const [index, agreement] of judged.agreements.entries()) {
    rows.push(await decideMoment(conn, src, index, agreement, { ...ctx, model: judged.model }));
  }
  return { rows };
}

async function record(conn, rows) {
  if (rows.length) await conn('day_agreement_decisions').insert(rows).onConflict('source_key').ignore();
}

// ---- the sweep ---------------------------------------------------------------------------

async function sweepKind(conn, sources, ctx, tally) {
  for (const src of sources) {
    try {
      const outcome = await processSource(conn, src, ctx);
      if (outcome.transient) { tally.transient += 1; return false; }
      await record(conn, outcome.rows);
      tally.judged += 1;
      for (const row of outcome.rows) tally[row.verdict] += 1;
    } catch (err) {
      tally.errors += 1;
      logger.error(`[day-agreement] source failed (${err.code || err.name || 'error'})`);
    }
  }
  return true;
}

/**
 * One sweep. Dark behind GATE_DAY_AGREEMENT_SHADOW (the scheduler also checks
 * it before taking the lock). Returns counts only.
 */
async function runDayAgreementShadow({ conn = db, now = new Date(), deps = {} } = {}) {
  if (!isEnabled('dayAgreementShadow')) return { skipped: 'gate_off' };
  const ctx = { now, todayET: etDateString(now), deps };
  const tally = {
    judged: 0, would_book: 0, would_move: 0, skip: 0, errors: 0, transient: 0,
  };
  const calls = (await loadCallCandidates(conn, now)).map(callSource);
  const keepGoing = await sweepKind(conn, calls, ctx, tally);
  if (keepGoing) {
    const texts = await Promise.all((await loadSmsCandidates(conn, now)).map((row) => smsSource(conn, row, now)));
    await sweepKind(conn, texts, ctx, tally);
  }
  return tally;
}

module.exports = {
  runDayAgreementShadow,
  _internals: {
    callCandidatesQuery,
    smsCandidatesQuery,
    smsCandidatesSql,
    loadCallCandidates,
    loadSmsCandidates,
    validateAnswer,
    judge,
    pickSlot,
    dropCollidingSlots,
    processSource,
    decideMoment,
    callSource,
    messageLine,
    parseAt,
    BATCH,
  },
};
