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
 *   2. asks ONE model call per source (TEXT_POLICIES.deepAnalysis (the DEEP judge tier) through
 *      dispatchWithFallback, lane day_agreement) what the office should do at
 *      each agreement moment (prompts/day-agreement-v1.js);
 *   3. applies the deterministic rules (day-agreement-rules.js), picks the
 *      first slot the route-aware time picker (scheduling/find-time.js) would
 *      take on the agreed day, and
 *   4. records the verdict and its reason in day_agreement_decisions.
 *
 * A week of rows is scored against what staff did by a read-only query. The act
 * step (book or move, then the confirmation text) is a later PR and is NOT
 * built here.
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
const { loadBookableCallServices, isGenericCallCatalogRow } = require('./call-booking-catalog');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { excludeRecruitingSmsLog } = require('../utils/recruiting-thread-scope');
const { scrubPans } = require('../utils/pan-scrub');
const { etDateString, etParts, addETDays, parseETDateTime, windowDurationMinutes } = require('../utils/datetime-et');
const prompts = require('./prompts/day-agreement-v1');
const rules = require('./day-agreement-rules');
const { refreshCustomerBookingWindowConfig, currentDayEndMinutes, bookingWindowConfigKnown } = require('./scheduling/customer-windows');

const HOUR_MS = 3600 * 1000;
const RECENT_MS = 3 * HOUR_MS;
const QUIET_MS = 30 * 60 * 1000;
const THREAD_DAYS = 14;
const THREAD_MESSAGES = 50;
// A longer text skips the thread, like a long call (pre-push audit P1).
const MESSAGE_CHARS = 2000;
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

// 'YYYY-MM-DDTHH:MM' in Eastern time: the form of the agreement time the model returns.
function etMinuteKey(date) {
  const p = etParts(date);
  return `${etDateString(date)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

function etStamp(date) {
  const p = etParts(date);
  return `${DAY_NAMES[p.dayOfWeek]} ${etDateString(date)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

// The model's `at` (YYYY-MM-DDTHH:MM, Eastern) into a Date, or null. The whole
// string must be a real wall clock (hour 00-23, minute 00-59, optional seconds):
// parseETDateTime would roll "12:60" or "24:00" into another time instead.
function parseAt(text) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(text || '').trim());
  if (!m || !rules.validDay(m[1])) return null;
  const date = parseETDateTime(`${m[1]}T${m[2]}:${m[3]}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const digitsOf = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

// ---- candidates --------------------------------------------------------------------------

// Calls whose pipeline verdict landed in the window and that no row covers yet.
// Every judged source has a '#0' row (see the migration), so one equality on
// the unique index says "already judged".
// The extraction may be stored as a JSON string inside the jsonb column.
const EXTRACTION_SQL = "(CASE WHEN jsonb_typeof(c.ai_extraction_enriched::jsonb) = 'string' THEN (c.ai_extraction_enriched::jsonb #>> '{}')::jsonb ELSE c.ai_extraction_enriched::jsonb END)";

function callCandidatesQuery(conn, now) {
  return conn('call_log as c')
    .modify((q) => whereNotSandboxCall(q, 'c.source'))
    .where('c.processed_at', '>=', new Date(now.getTime() - RECENT_MS))
    .where('c.v2_extraction_status', 'valid')
    .whereNotNull('c.ai_extraction_enriched')
    .whereNotNull('c.transcription')
    .whereRaw("COALESCE(c.processing_status, '') NOT IN ('voicemail', 'spam', 'processing')")
    // Scheduling status and the non-conversation tests (isRealConversation's own
    // reads: voicemail, spam verdict) run in SQL, before the scan limit, so
    // ineligible calls never crowd eligible ones out (pre-push audit P1). The JS
    // check below stays as the second look.
    .whereRaw(`${EXTRACTION_SQL} -> 'scheduling' ->> 'status' IN (${[...SCHEDULING_STATUSES].map(() => '?').join(', ')})`, [...SCHEDULING_STATUSES])
    .whereRaw("COALESCE(c.answered_by, '') <> 'voicemail'")
    .whereRaw(`COALESCE(${EXTRACTION_SQL} -> 'meta' ->> 'is_voicemail', '') <> 'true'`)
    .whereRaw(`COALESCE(NULLIF(${EXTRACTION_SQL} -> 'spam_verdict' ->> 'spam_kind', ''), 'not_spam') = 'not_spam'`)
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
// thread has been quiet for QUIET_MS. Quiet counts only what the thread itself
// counts: an inbound text, or a Waves text that went out. A scheduled, reserved
// or failed row never reached the customer and is no activity (the same
// delivered-and-reservation filter threadLines uses). The inner query keeps the
// latest inbound text per phone; the day word and quiet tests judge that one
// text, so an older text never stands in for a newer one.
// A push-only delivery (an app notification, not a text) is no text to or from
// the customer's phone: the same predicate twilio-webhook.js uses.
const notPushSql = (table) => `COALESCE(${table}.from_phone, '') <> 'push' AND COALESCE(${table}.metadata->>'channel', '') <> 'push'`;

function quietProbe(conn, since) {
  const probe = conn('sms_log as m').select(conn.raw('1'))
    .where('m.created_at', '>', since)
    .where((q) => q.where('m.direction', 'inbound').orWhereIn('m.status', DELIVERED_STATUSES))
    .whereRaw(notPushSql('m'))
    .modify((q) => excludeRecruitingSmsLog(q, 'm.message_type'))
    .whereRaw(`(${last10('m.from_phone')} = l.digits OR ${last10('m.to_phone')} = l.digits)`);
  return excludeUnresolvedSendReservations(probe, 'm');
}

// The latest inbound text per phone in the window, recruiting applicants' texts
// (job_* message types) left out: they belong to Recruiting, never to a customer visit.
// `digits` narrows it to one phone (the recheck before a model call).
function latestInboundPerPhone(conn, since, digits = null) {
  // Inbound only, so a send reservation can never match; the shared helper is
  // applied anyway, as every sms_log reader does (sms-log general-reader guard).
  const latest = excludeUnresolvedSendReservations(conn('sms_log'))
    .select(conn.raw(`DISTINCT ON (${last10('from_phone')}) id, customer_id, created_at, message_body, ${last10('from_phone')} AS digits`))
    .where('direction', 'inbound').where('created_at', '>=', since).whereNotNull('message_body')
    .modify((q) => excludeRecruitingSmsLog(q, 'message_type'));
  return (digits ? latest.whereRaw(`${last10('from_phone')} = ?`, [digits]) : latest)
    .orderByRaw(`${last10('from_phone')}, created_at DESC, id DESC`);
}

// A delivered Waves text with a day word sent to this phone in the 3 hours before
// the latest inbound: the offer ("Wednesday morning?") that a day-less "yes that
// works" accepts. Same delivered, push and recruiting rules as the thread.
function offerProbe(conn) {
  const probe = conn('sms_log as w').select(conn.raw('1'))
    .where('w.direction', 'outbound')
    .whereIn('w.status', DELIVERED_STATUSES)
    .whereRaw(notPushSql('w'))
    .modify((q) => excludeRecruitingSmsLog(q, 'w.message_type'))
    .whereRaw(`${last10('w.to_phone')} = l.digits`)
    .whereRaw(`w.created_at < l.created_at AND w.created_at >= l.created_at - interval '${RECENT_MS / HOUR_MS} hours'`)
    .whereRaw('w.message_body ~* ?', [rules.DAY_WORD_PATTERN]);
  return excludeUnresolvedSendReservations(probe, 'w');
}

// What makes the latest inbound text per phone (`l`) a candidate: a real phone, a day
// word in the text itself or in a delivered Waves offer just before it, not judged
// yet, and a thread quiet for QUIET_MS. One definition for the scan and the recheck.
function smsEligibility(conn, now) {
  return {
    sql: `length(l.digits) = 10
      AND (l.message_body ~* ? OR EXISTS (?))
      AND NOT EXISTS (SELECT 1 FROM day_agreement_decisions d WHERE d.source_key = 'sms:' || l.digits || ':' || l.id::text || '#0')
      AND NOT EXISTS (?)`,
    bindings: [rules.DAY_WORD_PATTERN, offerProbe(conn), quietProbe(conn, new Date(now.getTime() - QUIET_MS))],
  };
}

function smsCandidatesQuery(conn, now) {
  const eligible = smsEligibility(conn, now);
  return conn.raw(`
    SELECT l.id, l.customer_id, l.created_at, l.digits
    FROM (?) l
    WHERE ${eligible.sql}
    ORDER BY l.created_at ASC
    LIMIT ?`, [latestInboundPerPhone(conn, new Date(now.getTime() - RECENT_MS)), ...eligible.bindings, BATCH.sms]);
}

// Is this candidate still the latest inbound text for its phone, still quiet, still
// a day-agreement candidate? Asked right before its model call, because earlier
// sources in the same tick can take minutes.
async function smsStillCandidate(conn, src, now) {
  const id = src.key.split(':')[2];
  const eligible = smsEligibility(conn, now);
  const result = await conn.raw(`
    SELECT 1 FROM (?) l
    WHERE l.id = ? AND l.digits = ? AND ${eligible.sql}
    LIMIT 1`, [latestInboundPerPhone(conn, new Date(now.getTime() - RECENT_MS), src.phoneDigits), id, src.phoneDigits, ...eligible.bindings]);
  return (result.rows || []).length > 0;
}

async function loadSmsCandidates(conn, now) {
  const result = await smsCandidatesQuery(conn, now);
  return result.rows || [];
}

// ---- context for the model ---------------------------------------------------------------

// The customer's visits as they stood at the agreement. A visit changed after that
// moment may show a post-agreement state (a window staff set afterwards), so it is
// left out and counted: { lines, omitted }.
async function visitLines(conn, customerId, referenceAt, now) {
  const since = etDateString(addETDays(now, -30));
  const rows = await conn('scheduled_services')
    .where('customer_id', customerId)
    .where('created_at', '<=', referenceAt)
    .where('scheduled_date', '>=', since)
    .whereNotIn('status', rules.DEAD_STATUSES)
    .orderBy('scheduled_date', 'asc')
    .limit(40)
    .select('status', 'service_type', 'window_start', 'updated_at', conn.raw("to_char(scheduled_date, 'YYYY-MM-DD') AS d"));
  const shown = rows.filter((r) => !(new Date(r.updated_at).getTime() > referenceAt.getTime()));
  return {
    lines: shown.map((r) => `${r.d} ${r.window_start ? String(r.window_start).slice(0, 5) : 'no time set'} ${r.service_type || 'service'} (${r.status})`),
    omitted: rows.length - shown.length,
  };
}

function messageLine(row) {
  const body = scrubPans(String(row.message_body || '')).replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CHARS);
  if (!body) return null;
  const who = row.direction === 'inbound' ? 'CUSTOMER' : `WAVES${row.message_type ? ` (${row.message_type})` : ''}`;
  return `[${etStamp(new Date(row.created_at))}] ${who}: ${body}`;
}

// The last THREAD_MESSAGES texts between Waves and this phone, oldest first.
async function threadLines(conn, customerId, digits, now) {
  const rows = await excludeUnresolvedSendReservations(excludeRecruitingSmsLog(conn('sms_log')))
    .where('customer_id', customerId)
    .whereRaw(notPushSql('sms_log'))
    .where('created_at', '>=', new Date(now.getTime() - THREAD_DAYS * 24 * HOUR_MS))
    .whereNotNull('message_body')
    // A Waves text counts only once it went out: a scheduled or failed row was
    // never seen by the customer, so it is no staff word (pre-push audit P1).
    .where((q) => q.where('direction', 'inbound').orWhereIn('status', DELIVERED_STATUSES))
    // This phone only, in SQL before the limit, so another number on the same
    // customer never crowds the thread out (Codex #6350 r8).
    .whereRaw(`(${last10('from_phone')} = ? OR ${last10('to_phone')} = ?)`, [digits, digits])
    .orderBy('created_at', 'desc').orderBy('id', 'desc')
    .limit(THREAD_MESSAGES * 2)
    .select('direction', 'from_phone', 'to_phone', 'message_type', 'message_body', 'created_at');
  const thread = rows
    .filter((r) => digitsOf(r.direction === 'inbound' ? r.from_phone : r.to_phone) === digits)
    .slice(0, THREAD_MESSAGES).reverse();
  const kept = thread.filter((r) => messageLine(r));
  return {
    lines: kept.map(messageLine),
    // The minute of every message the model reads: an SMS agreement time must be one of these.
    stamps: new Set(kept.map((r) => etMinuteKey(new Date(r.created_at)))),
    truncated: thread.some((r) => String(r.message_body || '').replace(/\s+/g, ' ').trim().length > MESSAGE_CHARS),
  };
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
  const thread = row.customer_id ? await threadLines(conn, row.customer_id, row.digits, now) : { lines: [], stamps: new Set(), truncated: false };
  return {
    kind: 'sms', key: `sms:${row.digits}:${row.id}`, callLogId: null, phoneDigits: row.digits,
    customerId: row.customer_id || null, agreedAt: new Date(row.created_at),
    lines: thread.lines, stamps: thread.stamps, truncated: thread.truncated,
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
  const result = await dispatch(MODELS.TEXT_POLICIES.deepAnalysis, {
    system: parts.system, text: parts.text, jsonMode: true, jsonSchema: prompts.SCHEMA,
    // The documented DEEP output floor: MODEL_DEEP may point at a thinking model that
    // spends thinking from the same budget.
    maxTokens: 4096, laneId: 'day_agreement', promptVersion: prompts.VERSION,
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
    .select('id', 'status', 'created_at', 'updated_at', 'estimated_duration_minutes', 'window_start', 'window_end', 'service_type', 'lat', 'lng',
      conn.raw("to_char(scheduled_date, 'YYYY-MM-DD') AS d"));
}

// Where the visit will be: a move uses the moved visit's own pin (its service
// address can differ from the customer's), the customer's pin only when the
// visit has none; a new visit has the customer's pin.
// A customer with several active service properties has no single pin: the
// conversation names no property, so a NEW visit for them is not placed (a move
// is placed by the moved visit's own pin).
async function hasSeveralProperties(conn, customerId) {
  const ids = await conn('customer_properties').where({ customer_id: customerId, active: true }).limit(2).pluck('id');
  return ids.length > 1;
}

async function coordinates(conn, customerId, fromVisit) {
  const pin = (lat, lng) => {
    const point = { lat: parseFloat(lat), lng: parseFloat(lng) };
    return Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : null;
  };
  const own = pin(fromVisit?.lat, fromVisit?.lng);
  if (own) return own;
  const customer = await conn('customers').where({ id: customerId }).first('latitude', 'longitude');
  return pin(customer?.latitude, customer?.longitude);
}

// Offer/commit parity (AGENTS.md booking conflict-check class): without
// capacity routing, find-time reads a technician's own route only, so a visit
// with no technician is invisible to it. The estimate picker's collision guard
// (filterCollidingSlots) checks every live row of the day, tech-blind, plus the
// zone and travel-gap rules; the shadow uses the same guard so it never records
// a window the reserve gate would refuse. Under capacity routing the route
// already holds unassigned blockers and the guard is not applied (it would
// drop every slot that is not an arrival-window slot); the customer-window
// admission (09:00 grid, close, lunch) is then applied by find-time itself,
// because pickSlot asks for customerFacing slots. The visit being moved is
// excluded from the check.
async function dropCollidingSlots(slots, {
  day, where, fromVisit, serviceName = null,
}, deps) {
  const { capacityEnabled } = require('./scheduling/policy');
  if (capacityEnabled()) return slots;
  const filterColliding = deps.filterColliding || require('./estimate-slot-availability').filterCollidingSlots;
  const shaped = slots.map((slot) => ({
    slot, date: slot.date, techId: slot.technician?.id || null, windowStart: slot.start_time, windowEnd: slot.end_time,
  }));
  const kept = new Set(await filterColliding(shaped, {
    dateFrom: day, dateTo: day, coords: where, excludeServiceIds: fromVisit ? [fromVisit.id] : [],
    // A technician switched off for this kind of work is not offered (the estimate picker's rule).
    ...(serviceName ? { serviceMix: { services: [serviceName] } } : {}),
  }));
  return shaped.filter((s) => kept.has(s)).map((s) => s.slot);
}

// The one catalog service an agreed new visit is for. The prompt lists the
// bookable catalog names and the model copies ONE exactly, so only an exact
// match of a name, short name or key counts: no keyword rules, which take the
// first match and would turn "cockroach control and rodent trapping" into one
// service (pre-push audit P1). A generic row (the anything-appointment, the
// assessment) is no settled service either: null, so the sweep never asks the
// picker about work it cannot name.
function resolveNewVisitService(catalog, serviceText) {
  const text = String(serviceText || '').trim().toLowerCase();
  if (!text) return null;
  const norm = (v) => String(v || '').trim().toLowerCase();
  const hits = catalog.filter((row) => [row.name, row.short_name, row.service_key].some((v) => v && norm(v) === text));
  return hits.length === 1 && !isGenericCallCatalogRow(hits[0]) ? hits[0] : null;
}

// Name and length of the visit the picker is asked about: the moved visit's own
// service and length, or the resolved catalog service and its default length.
function visitIdentity({ fromVisit, service }) {
  // A move keeps its stored window length, as the reschedule path derives it (Codex #6350 r12).
  if (fromVisit) return { name: fromVisit.service_type || null, minutes: windowDurationMinutes(fromVisit.window_start, fromVisit.window_end, fromVisit.estimated_duration_minutes) || 60 };
  return { name: service?.name || null, minutes: Number(service?.default_duration_minutes) || 60 };
}

// The first slot the picker would take on the agreed day, honoring the daypart
// and whole-hour starts. { slot } or { reason }. The service identity goes to
// find-time the way the other new-booking callers pass it (serviceType and
// serviceTypes), so capacity routing drops technicians switched off for that
// kind of work; the collision guard applies the same rule outside capacity mode.
async function pickSlot(conn, {
  customerId, day, daypart, fromVisit, service = null,
}, deps) {
  const identity = visitIdentity({ fromVisit, service });
  if (!identity.name) return { reason: 'service_unresolved' };
  const where = await coordinates(conn, customerId, fromVisit);
  if (!where) return { reason: 'no_coordinates' };
  const findSlots = deps.findSlots || require('./scheduling/find-time').findAvailableSlots;
  // The customer day end (booking_config.day_end, 18:00 unless reconfigured), as
  // /book and the estimate picker pass it: find-time's own default close is 17:00,
  // which would drop every 17:00 start in legacy mode.
  // An unread booking_config is no close to guess: the source is retried (Codex #6350 r12).
  await refreshCustomerBookingWindowConfig(conn);
  if (!bookingWindowConfigKnown()) throw Object.assign(new Error('booking_config_unknown'), { code: 'booking_config_unknown' });
  const result = await findSlots({
    lat: where.lat, lng: where.lng,
    durationMinutes: identity.minutes,
    serviceType: identity.name, serviceTypes: [identity.name],
    dateFrom: day, dateTo: day, topN: SLOT_TOP_N,
    includeWeekends: true, slotStepMinutes: 60, everyStepStart: true, providerTravel: false,
    // The customer-window admission every customer-facing caller asks for (find-time
    // applies it in capacity mode); the agent will confirm the window to the customer.
    customerFacing: true,
    dayEndHour: currentDayEndMinutes() / 60,
    // An unreadable closure calendar throws (retryable) instead of failing open (Codex #6350 r12).
    strictBlackout: true,
    excludeServiceIds: fromVisit ? [fromVisit.id] : [],
  });
  const offered = result && !result.error && Array.isArray(result.slots) ? result.slots : [];
  const free = offered.length ? await dropCollidingSlots(offered, { day, where, fromVisit, serviceName: identity.name }, deps) : [];
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

// Where the agreed visit would go: { slot } or { reason }. A move is placed by its
// own visit; a new visit needs one pinned property and ONE catalog service, and the
// picker is asked only once both are settled.
async function placeVisit(conn, src, { a, fromVisit, catalog }, deps) {
  if (!fromVisit && await hasSeveralProperties(conn, src.customerId)) return { reason: 'property_ambiguous' };
  const service = fromVisit ? null : resolveNewVisitService(catalog, a.service);
  if (!fromVisit && !service) return { reason: 'service_unresolved' };
  // A picker or collision-query failure propagates, like a catalog failure: the
  // source stays unjudged and the next tick retries it (Codex #6350 r8).
  return pickSlot(conn, { customerId: src.customerId, day: a.day, daypart: a.daypart, fromVisit, service }, deps);
}

// Why a text action cannot be judged from this source, or null. Its time must be
// a shown message's minute (grounded), and not before this source's own inbound:
// an earlier moment was judged when its own text was the latest, and the visits
// shown now are as of the newer text (Codex #6350 r10 + r11).
function smsMomentSkip(src, parsedAt) {
  if (!src.stamps?.has(etMinuteKey(parsedAt))) return 'at_ungrounded';
  if (Math.floor(parsedAt.getTime() / 60000) < Math.floor(src.agreedAt.getTime() / 60000)) return 'earlier_moment';
  return null;
}

async function decideMoment(conn, src, index, agreement, ctx) {
  const a = rules.normalizeAgreement(agreement);
  const parsedAt = src.kind === 'call' ? src.agreedAt : parseAt(a.at);
  const agreedAt = parsedAt || src.agreedAt;
  const known = { model: ctx.model, judged: JSON.stringify(a), agreed_at: agreedAt };
  // A text agreement is only as old as the message that completed it. With no
  // readable time the staleness and staff-acted rules cannot be trusted, so an
  // action is never judged against the latest inbound time instead.
  if (a.act && !parsedAt) return skipRow(src, index, 'at_unreadable', { ...known, ...(rules.validDay(a.day) ? { target_date: a.day } : {}) });
  // ...and it must be the minute of a message the model was shown: a time that
  // matches none is a guess, not the moment the day was agreed.
  const smsSkip = a.act && src.kind === 'sms' ? smsMomentSkip(src, parsedAt) : null;
  if (smsSkip) return skipRow(src, index, smsSkip, { ...known, ...(rules.validDay(a.day) ? { target_date: a.day } : {}) });
  const dayVisits = a.act ? await visitFacts(conn, src.customerId, [a.day, a.from_day]) : [];
  const decision = rules.decideAgreement({
    agreement: a, kind: src.kind, customerId: src.customerId, todayET: ctx.todayET, agreedAt, now: ctx.now,
    visitsOnDay: dayVisits.filter((v) => v.d === a.day),
    visitsOnFromDay: dayVisits.filter((v) => v.d === a.from_day),
  });
  const target = rules.validDay(a.day) ? { target_date: a.day } : {};
  if (!decision.pass) return skipRow(src, index, decision.reason, { ...known, ...target });
  const fromVisit = decision.fromVisitId ? dayVisits.find((v) => v.id === decision.fromVisitId) : null;
  const picked = await placeVisit(conn, src, { a, fromVisit, catalog: ctx.catalog }, ctx.deps);
  const withVisit = { ...known, ...target, from_visit_id: decision.fromVisitId };
  if (!picked.slot) return skipRow(src, index, picked.reason, withVisit);
  return {
    ...baseRow(src, index), ...withVisit, verdict: decision.kind === 'move' ? 'would_move' : 'would_book',
    chosen_window_start: picked.slot.start_time, chosen_technician_id: picked.slot.technician?.id || null,
  };
}

// All the rows for one source: a skip without a model call when it has no
// customer or no text, otherwise one row for each moment the model listed.
// A customer can start a model judgment at most CUSTOMER_QUOTA times a day,
// calls and texts together: each new call or inbound text is a new source, so
// without a ceiling a linked phone could keep paying for deep-model calls
// (Codex security review, #6350 r6 + r7). Every source that reaches the model
// has a customer, and every judged source writes a '#0' row, so those rows
// are the count; rate-limited rows judged nothing and do not count.
const CUSTOMER_QUOTA = 4;
async function customerOverQuota(conn, customerId, now) {
  const row = await conn('day_agreement_decisions')
    .where('customer_id', customerId)
    .where('source_key', 'like', '%#0')
    // Only a source the model judged counts (a model is stamped on its rows, or
    // every model answer was unusable); pre-model skips judged nothing (Codex #6350 r8).
    .where((q) => q.whereNotNull('model').orWhere('skip_reason', 'judge_unusable'))
    .where('created_at', '>=', new Date(now.getTime() - 24 * HOUR_MS))
    .count({ n: '*' }).first();
  return Number(row?.n || 0) >= CUSTOMER_QUOTA;
}

// The clock at this moment: the sweep's `now` plus the time the sweep has run.
const clockOf = (ctx) => new Date(ctx.now.getTime() + (Date.now() - ctx.startedAt));

// A text candidate was chosen at the start of the tick; earlier sources can take
// minutes. Reload its thread and confirm it is still the latest inbound text, still
// quiet and still a candidate; else leave it unjudged (no row) for a later tick.
async function refreshSmsSource(conn, src, ctx) {
  const now = clockOf(ctx);
  if (!(await smsStillCandidate(conn, src, now))) return false;
  if (src.customerId) {
    const thread = await threadLines(conn, src.customerId, src.phoneDigits, now);
    Object.assign(src, { lines: thread.lines, stamps: thread.stamps, truncated: thread.truncated });
  }
  return true;
}

async function processSource(conn, src, ctx) {
  if (src.kind === 'sms' && !(await refreshSmsSource(conn, src, ctx))) return { leave: true };
  if (!src.customerId) return { rows: [skipRow(src, 0, 'no_customer')] };
  if (!src.lines.length) return { rows: [skipRow(src, 0, 'no_text')] };
  if (src.truncated) return { rows: [skipRow(src, 0, src.kind === 'call' ? 'transcript_too_long' : 'message_too_long')] };
  if (await customerOverQuota(conn, src.customerId, ctx.now)) return { rows: [skipRow(src, 0, 'judge_rate_limited')] };
  const visits = await visitLines(conn, src.customerId, src.agreedAt, ctx.now);
  // A failed read throws (the source stays unjudged and is retried next tick); the
  // legacy empty list would record every agreement as service_unresolved for good.
  const catalog = await loadBookableCallServices(conn, { strict: true });
  if (!catalog.length) throw Object.assign(new Error('catalog_empty'), { code: 'catalog_empty' });
  const parts = prompts.buildDayAgreementPrompt({
    sourceLabel: src.label, todayET: ctx.todayET, weekdayET: WEEKDAYS[etParts(ctx.now).dayOfWeek], visits: visits.lines, omittedVisits: visits.omitted, lines: src.lines,
    services: catalog.filter((row) => !isGenericCallCatalogRow(row)).map((row) => row.name),
  });
  const judged = await judge(parts, ctx.deps);
  if (!judged.ok) return judged.transient ? { transient: true } : { rows: [skipRow(src, 0, 'judge_unusable')] };
  const rows = [];
  // An agreement the model repeated is recorded once (Codex #6350 r11).
  const seen = new Set();
  const unique = judged.agreements.filter((ag) => {
    const n = rules.normalizeAgreement(ag);
    const key = JSON.stringify([n.at, n.act, n.kind, n.day, n.from_day, n.daypart, n.service]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const [index, agreement] of unique.entries()) {
    rows.push(await decideMoment(conn, src, index, agreement, { ...ctx, catalog, model: judged.model }));
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
      if (outcome.leave) { tally.left = (tally.left || 0) + 1; continue; }
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
  const ctx = {
    now, todayET: etDateString(now), deps, startedAt: Date.now(),
  };
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
    smsStillCandidate,
    visitLines,
    etMinuteKey,
    loadCallCandidates,
    loadSmsCandidates,
    validateAnswer,
    judge,
    pickSlot,
    visitIdentity,
    resolveNewVisitService,
    hasSeveralProperties,
    dropCollidingSlots,
    processSource,
    decideMoment,
    callSource,
    messageLine,
    parseAt,
    BATCH,
  },
};
