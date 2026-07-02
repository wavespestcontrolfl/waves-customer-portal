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

const BOOKABLE_SERVICE_COLUMNS = [
  'id',
  'service_key',
  'name',
  'short_name',
  'billing_type',
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
// Pest Control — strip the phrase so it can't trip the German-roach cleanout
// rule, which is a $350 two-treatment program.
const PALMETTO_BUG_RE = /\bpalmetto\s+bugs?\b/gi;
const ROACH_RE = /\b(?:german\s+)?(?:cock)?roach(?:es)?\b/i;

// Deterministic transcript-keyword rules, tried only after the model's own
// exact catalog pick. Each maps to a service_key that must exist in the
// loaded catalog (missing/inactive keys are simply skipped), so a rule can
// never book a service the catalog doesn't offer.
const KEYWORD_SERVICE_RULES = [
  {
    serviceKey: 'cockroach_control',
    matches: (text) => ROACH_RE.test(String(text || '').replace(PALMETTO_BUG_RE, ' ')),
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
  const n = typeof value === 'string' ? Number(value.replace(/[^0-9.]/g, '')) : Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_QUOTED_CALL_PRICE || n > MAX_QUOTED_CALL_PRICE) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Price for a call booking. The price the agent quoted and the caller accepted
 * on the call wins; the catalog list price backstops it. Catalog fallback is
 * one_time services only — a recurring service's base_price is a per-visit
 * subscription rate whose billing runs through the recurring machinery, not a
 * price this booking should assert on its own.
 */
function resolveCallBookingPrice({ quotedPrice, catalogRow } = {}) {
  const quoted = sanitizeQuotedCallPrice(quotedPrice);
  if (quoted !== null) return { price: quoted, source: 'transcript' };
  const base = Number(catalogRow?.base_price);
  if (catalogRow && catalogRow.billing_type === 'one_time' && Number.isFinite(base) && base > 0) {
    return { price: Math.round(base * 100) / 100, source: 'catalog' };
  }
  return { price: null, source: null };
}

/**
 * Follow-up visit plan when the call specifically discussed one (a mention or
 * an agreed follow-up date). Date comes from the transcript when a valid
 * future date was stated, else parent date + the service's catalog interval
 * (default 14 days). Returns { scheduledDate, windowStart } or null.
 */
function resolveCallFollowUpPlan({ extracted = {}, catalogRow = null, parentDate, parentWindowStart } = {}) {
  const mentioned = extracted.follow_up_visit_mentioned === true || !!extracted.follow_up_date_time;
  if (!mentioned) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(parentDate || ''))) return null;

  let scheduledDate = null;
  let windowStart = null;
  const raw = String(extracted.follow_up_date_time || '').trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (m && m[1] > parentDate) {
    scheduledDate = m[1];
    windowStart = m[2] || null;
  }

  if (!scheduledDate) {
    const configured = Number(catalogRow?.follow_up_interval_days);
    const days = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FOLLOW_UP_INTERVAL_DAYS;
    // Pin to noon so a UTC server can't roll the ET calendar date when adding days.
    const base = new Date(`${parentDate}T12:00:00`);
    if (Number.isNaN(base.getTime())) return null;
    base.setDate(base.getDate() + days);
    scheduledDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(base);
  }

  return { scheduledDate, windowStart: windowStart || parentWindowStart || '09:00' };
}

module.exports = {
  loadBookableCallServices,
  resolveCallBookingCatalogService,
  resolveCallBookingPrice,
  resolveCallFollowUpPlan,
  sanitizeQuotedCallPrice,
  DEFAULT_FOLLOW_UP_INTERVAL_DAYS,
};
