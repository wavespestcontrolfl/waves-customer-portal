/**
 * Catalog-anchored resolution for phone-call auto-bookings.
 *
 * The AI call pipeline historically booked appointments from raw LLM text:
 * a coarse service label, no service_id, no price, no duration, and no
 * follow-up visit. These helpers anchor every call booking to the `services`
 * catalog so the facts (price, duration, follow-up interval) come from data,
 * not from the model:
 *
 *   - loadBookableCallServices(conn): the active, booking-enabled catalog.
 *   - resolveCallBookingCatalogService(): extraction/transcript -> catalog row.
 *   - resolveCallBookingPrice(): transcript-quoted price first (what the agent
 *     and caller actually agreed to), catalog list price as fallback.
 *   - resolveCallFollowUpPlan(): a second linked visit when the call
 *     specifically discussed a follow-up treatment.
 *
 * Every function fails open to the legacy behavior (null / empty list) so a
 * catalog problem can never block an otherwise-valid booking.
 */

const logger = require('./logger');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

const BOOKABLE_SERVICE_COLUMNS = [
  'id',
  'service_key',
  'name',
  'short_name',
  'billing_type',
  'pricing_type',
  'base_price',
  'default_duration_minutes',
  'requires_follow_up',
  'follow_up_interval_days',
];

// Quoted prices outside these bounds are treated as extraction noise ("3.50",
// a phone number fragment, a lot size) rather than an agreed service price.
const MIN_QUOTED_CALL_PRICE = 20;
const MAX_QUOTED_CALL_PRICE = 20000;

const DEFAULT_FOLLOW_UP_INTERVAL_DAYS = 14;

// "Palmetto bug" callers are American-roach one-offs handled under General
// Pest Control — strip the phrase (in all its wordings: palmetto bug/roach/
// cockroach) so it can't trip the German-roach cleanout rule, which is a
// $350 two-treatment program.
const PALMETTO_BUG_RE = /\bpalmetto\s+(?:bugs?|(?:cock)?roach(?:es)?)\b/gi;
const ROACH_RE = /\b(?:german\s+)?(?:cock)?roach(?:es)?\b/i;
// A roach mention only counts as booking intent when it's affirmative:
// "not roaches, just ants" and "last time it was roaches" describe what the
// visit is NOT for, and must not force the cockroach service (and its catalog
// price) onto a booking for something else. Strip negated mentions (negation
// word + up to two fillers, e.g. "haven't seen any roaches") and
// historical-context mentions within the same clause, then test what's left —
// one surviving affirmative mention is enough.
const NEGATED_ROACH_RE = /\b(?:no|not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|don['’]?t|doesn['’]?t|didn['’]?t|haven['’]?t|hasn['’]?t|never|without)\s+(?:\w+\s+){0,2}?(?:german\s+)?(?:cock)?roach(?:es)?\b/gi;
// Historical context can sit on either side of the mention: "last time it was
// roaches" AND "we had roaches last time" — strip both orders.
const HISTORICAL_ROACH_RE = /\b(?:last\s+(?:time|visit|year)|previous(?:ly)?|in\s+the\s+past|used\s+to)\b[^.!?\n]{0,40}?\b(?:german\s+)?(?:cock)?roach(?:es)?\b/gi;
const ROACH_HISTORICAL_RE = /\b(?:german\s+)?(?:cock)?roach(?:es)?\b[^.!?\n]{0,40}?\b(?:last\s+(?:time|visit|year)|previous(?:ly)?|in\s+the\s+past|ago)\b/gi;

function hasAffirmativeRoachMention(text) {
  const cleaned = String(text || '')
    .replace(PALMETTO_BUG_RE, ' ')
    .replace(NEGATED_ROACH_RE, ' ')
    .replace(HISTORICAL_ROACH_RE, ' ')
    .replace(ROACH_HISTORICAL_RE, ' ');
  return ROACH_RE.test(cleaned);
}

// Deterministic transcript-keyword rules, tried only after the model's own
// exact catalog pick. Each maps to a service_key that must exist in the
// loaded catalog (missing/inactive keys are simply skipped), so a rule can
// never book a service the catalog doesn't offer.
const KEYWORD_SERVICE_RULES = [
  {
    serviceKey: 'cockroach_control',
    matches: hasAffirmativeRoachMention,
  },
];

async function loadBookableCallServices(conn) {
  try {
    const rows = await conn('services')
      .where({ is_active: true, booking_enabled: true })
      .select(BOOKABLE_SERVICE_COLUMNS);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    logger.warn(`[call-booking-catalog] Failed to load bookable services (falling back to legacy labels): ${err.message}`);
    return [];
  }
}

function normalizeServiceText(value) {
  return String(value || '').trim().toLowerCase();
}

function findServiceByName(services, value) {
  const text = normalizeServiceText(value);
  if (!text) return null;
  return services.find((s) => (
    normalizeServiceText(s.name) === text
    || normalizeServiceText(s.short_name) === text
    || normalizeServiceText(s.service_key) === text
  )) || null;
}

/**
 * Resolve the specific catalog service for a call booking.
 * Priority: the model's explicit catalog pick (specific_service_name, then
 * matched_service / requested_service when they name a catalog entry exactly),
 * then deterministic keyword rules over the extraction + transcript.
 * Returns a catalog row or null (null -> legacy coarse service label).
 */
function resolveCallBookingCatalogService({ extracted = {}, transcription = '', services = [] } = {}) {
  if (!Array.isArray(services) || services.length === 0) return null;

  const byModelPick = findServiceByName(services, extracted.specific_service_name)
    || findServiceByName(services, extracted.matched_service)
    || findServiceByName(services, extracted.requested_service);
  if (byModelPick) return byModelPick;

  const haystack = [
    extracted.requested_service,
    extracted.pain_points,
    extracted.call_summary,
    transcription,
  ].filter(Boolean).join(' ');
  if (!haystack) return null;

  for (const rule of KEYWORD_SERVICE_RULES) {
    if (!rule.matches(haystack)) continue;
    const row = services.find((s) => s.service_key === rule.serviceKey);
    if (row) return row;
  }
  return null;
}

function sanitizeQuotedCallPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  let n;
  if (typeof value === 'number') {
    n = value;
  } else {
    // Exactly one numeric amount ("$350", "1,350.50"). Multi-amount strings
    // ("50 to 60") are ranges, not an agreed price — digit-stripping would
    // inflate them into 5060.
    const tokens = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
    if (tokens.length !== 1) return null;
    n = Number(tokens[0]);
  }
  if (!Number.isFinite(n)) return null;
  if (n < MIN_QUOTED_CALL_PRICE || n > MAX_QUOTED_CALL_PRICE) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Price for a call booking. Billable prices are one_time-catalog-anchored
 * only:
 *   - A recurring service's rate (quoted or listed) is subscription billing
 *     that runs through the recurring machinery — stamping it as
 *     estimated_price would bill the visit outside that machinery.
 *   - A quote with no catalog match has an unknown billing type; fail open
 *     to the legacy no-price shape.
 *   - The catalog list price backstops a missing quote only when the row is
 *     pricing_type='fixed' — a variable-priced one_time service (termite
 *     liquid, exclusion, …) needs sizing/quote-specific pricing, so its
 *     base_price must never become the invoice amount on its own.
 * A transcript quote on a one_time row wins over the list price: it IS the
 * job-specific price the agent and caller agreed to.
 */
function resolveCallBookingPrice({ quotedPrice, catalogRow } = {}) {
  if (!catalogRow || catalogRow.billing_type !== 'one_time') {
    return { price: null, source: null };
  }
  const quoted = sanitizeQuotedCallPrice(quotedPrice);
  if (quoted !== null) return { price: quoted, source: 'transcript' };
  const base = Number(catalogRow.base_price);
  if (catalogRow.pricing_type === 'fixed' && Number.isFinite(base) && base > 0) {
    return { price: Math.round(base * 100) / 100, source: 'catalog' };
  }
  return { price: null, source: null };
}

/**
 * Whether the booking should flag create_invoice_on_complete. A priced
 * one-time booking must bill at completion: without the flag the completion
 * auto-invoice skips priced, self-pay, non-WaveGuard visits
 * (GATE_AUTOINVOICE_PRICED_VISITS defaults off) and the job closes
 * uninvoiced. Only for a one_time catalog row — a recurring service's visits
 * bill through the recurring machinery, and a coarse legacy label's billing
 * type is unknown, so flagging either risks double-billing.
 */
function callBookingInvoiceOnComplete({ price, catalogRow } = {}) {
  return price != null && catalogRow?.billing_type === 'one_time';
}

// Real-calendar check: "2026-13-40" matches a date-shaped regex but must not
// reach a scheduled_services insert — a rejected child INSERT inside the
// booking transaction would roll back the confirmed primary appointment.
function isValidCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, mo, d] = String(value).split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isValidWindowTime(value) {
  const m = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

/**
 * Follow-up visit plan when the call specifically discussed one (a mention or
 * an agreed follow-up date). Date comes from the transcript when a valid
 * future date was stated, else parent date + the service's catalog interval
 * (default 14 days). Returns { scheduledDate, windowStart } or null.
 */
function resolveCallFollowUpPlan({ extracted = {}, catalogRow = null, parentDate, parentWindowStart } = {}) {
  if (!isValidCalendarDate(parentDate)) return null;

  // A stated date only counts as a mention signal when it parses as a real
  // calendar date AND falls after the initial visit: the V1 normalizer merely
  // trims follow_up_date_time, so the model can emit "two weeks"/"none"
  // garbage, or copy confirmed_start_at into the field — the primary visit's
  // own date is not evidence of a second visit, and without this guard it
  // would book a default-interval follow-up nobody discussed.
  const raw = String(extracted.follow_up_date_time || '').trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  const statedFutureDate = !!(m && isValidCalendarDate(m[1]) && m[1] > parentDate);
  const mentioned = extracted.follow_up_visit_mentioned === true || statedFutureDate;
  if (!mentioned) return null;

  let scheduledDate = null;
  let windowStart = null;
  if (statedFutureDate) {
    scheduledDate = m[1];
    windowStart = m[2] && isValidWindowTime(m[2]) ? m[2] : null;
  }

  if (!scheduledDate) {
    const configured = Number(catalogRow?.follow_up_interval_days);
    const days = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FOLLOW_UP_INTERVAL_DAYS;
    // parentDate is an ET wall-clock calendar date; the server runs UTC, so
    // day math goes through the ET helpers (noon anchor clears DST seams).
    const base = parseETDateTime(`${parentDate}T12:00`);
    if (Number.isNaN(base.getTime())) return null;
    scheduledDate = etDateString(addETDays(base, days));
  }

  const finalWindowStart = windowStart || parentWindowStart || '09:00';
  return { scheduledDate, windowStart: isValidWindowTime(finalWindowStart) ? finalWindowStart : '09:00' };
}

module.exports = {
  loadBookableCallServices,
  resolveCallBookingCatalogService,
  resolveCallBookingPrice,
  resolveCallFollowUpPlan,
  callBookingInvoiceOnComplete,
  sanitizeQuotedCallPrice,
  DEFAULT_FOLLOW_UP_INTERVAL_DAYS,
};
