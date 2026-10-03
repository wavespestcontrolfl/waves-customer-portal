'use strict';

/**
 * Annual rate review — RANKING backend (plan
 * ~/.claude/plans/annual-rate-review-2026-09-30.md, build step 2; the
 * 09-30 conversation-time correction applies).
 *
 * What it does: once a month (scheduler.js, 1st at 6:20 AM ET) — or on an
 * admin's recompute — it ranks every ACTIVE RECURRING PLAN LINE whose
 * anniversary falls in the batch window into rate_review_snapshots:
 *
 *   plan line   = real customer × service line × cadence with ≥1 open future
 *                 recurring visit (the prod pre-read's definition, 2026-09-30)
 *   anniversary = the line's start date — see resolveAnniversary() for the
 *                 first-visit / estimate-accept / member_since choice
 *   current     = what the lane actually bills (per_application: median of
 *                 the open visits' estimated_price → per_application_fee;
 *                 monthly_membership: ledger family slice → monthly_rate;
 *                 annual_prepay: live term's prepay_amount ÷ covered visits)
 *   list        = today's price for the same property + services: an engine
 *                 replay of the customer's accepted estimate inputs (strip
 *                 quote-time discounts; tier re-derived by the engine) when a
 *                 size input exists, else the line+cadence MODE of current
 *                 rates across the book ('cadence_mode')
 *   $/hour      = paid revenue ÷ TREATMENT hours over the last 12 months.
 *                 Prod has NO treatment-start stamp (read-only check
 *                 2026-09-30: actual_start_time, check_in_time,
 *                 service_records.started_at and the on_site history row are
 *                 all written at the arrival instant by
 *                 service-duration-capture.js; job clocks have 0 rows), so
 *                 the base is pricing-reality-check's wall-clock ladder and
 *                 the conversation control is service_records.
 *                 customer_interaction: 'not_home_full_access' = pure
 *                 treatment time; 'tech_home_spoke_with_them' = wall minus
 *                 the LINE ALLOWANCE (median home wall − median not-home
 *                 wall over the book's last 12 months, floor 0, cap 25,
 *                 computed at build time and stored on the batch), floored at
 *                 10; null = wall, lower confidence. ≤0 or >240 wall minutes
 *                 are unusable. An account with ≥ min_usable_visits of its
 *                 own not-home visits gets $/hr from those alone
 *                 (rph_from_not_home). Trimmed median per line (drop the
 *                 longest once ≥4 usable); ≥ min_usable_visits before $/hr
 *                 counts at all.
 *   band        = A well priced (≥ list AND $/hr ≥ line median) → $0 ·
 *                 B within ±tolerance of list → pass-through % ·
 *                 C under list ≤ band_c_max → to list ·
 *                 D under list beyond that → capped step.
 *                 $/hr moves an account ONE band (bottom-quartile A→B / B→C;
 *                 top-quartile C→B) and never sets D by itself. Whole dollars,
 *                 never a cut, cap = min(cap_pct, cap_cents), < min_delta →
 *                 no_change.
 *   exceptions  = deterministic hold-outs (status 'exception', flags[]):
 *                 tenure under the lock, prepay mid-term, reviewed within 12
 *                 months, manual rate edit, retention offer / plan hold,
 *                 callback or cancellation case or complaint in the window,
 *                 past due, hand-picked tier, commercial, termite, multi-
 *                 property, per_visit / NULL lane, facts unavailable.
 *
 * What it never does: write a rate (no customers / scheduled_services /
 * customer_plan_rates / pricing tables are touched), send a customer
 * anything, or run with GATE_RATE_REVIEW off. The one send is the ACT:/OK:
 * ops email to contact@ (deliverOpsDigest seam, same as turf-variance).
 * Customer names appear only in that owner email — logs carry ids.
 *
 * Conversation time (owner 2026-09-30): "$/hr uses TREATMENT minutes, not
 * wall-clock". No conversation-minutes field exists on completions yet;
 * conversationMinutesFor() is the hook — the Fast Complete lane will add
 * capture (voice phrase or 0/5/10/20+ chip) and, once a completion carries
 * a real value, this module subtracts THAT instead of the line allowance
 * (see CONVERSATION_MINUTES_KEYS).
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, etMonthStart, addETDays, validCalendarDate } = require('../utils/datetime-et');
const { addMonthsSameDay } = require('../utils/date-only');
const { sanitizeClientIdentityFields } = require('./estimate-client-identity-fields');
const { rateReviewLive, isEnabled } = require('../config/feature-gates');
const { resolveActualMinutes } = require('./pricing-reality-check');
const { INVOICE_UNCOLLECTIBLE_STATUSES } = require('./invoice-helpers');
const { normalizePropertyType } = require('./pricing-engine/commercial-helpers');
const { hasAuthoritativeZeroPrice, resolveBillingLane } = require('./billing-lane');
const { COUNTING_SOURCE_STATUSES } = require('./recurring-series-cancel-reseed');

const SNAPSHOTS = 'rate_review_snapshots';
const BATCHES = 'rate_review_batches';
const CONFIG = 'rate_review_config';
const BATCH_KEY_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

const DEFAULT_CONFIG = Object.freeze({
  pass_through_pct: 3.5,
  band_b_tolerance_pct: 5,
  band_c_max_pct: 10,
  cap_pct: 12,
  cap_cents: 1500,
  min_delta_cents: 300,
  min_usable_visits: 3,
  lock_months: 12,
  exception_callback_days: 60,
  exception_manual_edit_months: 6,
});

const LINE_KEYS = ['pest_control', 'lawn_care', 'tree_shrub', 'mosquito', 'termite', 'rodent'];
const CADENCE_VISITS = Object.freeze({ monthly: 12, bimonthly: 6, quarterly: 4, every_6_weeks: 9, semiannual: 2 });
// Engine line-item service keys per plan line (commercial_* keys are
// deliberately absent — commercial accounts are an exception, not priced).
const ENGINE_SERVICE_KEYS = Object.freeze({
  pest_control: ['pest_control'],
  lawn_care: ['lawn_care'],
  tree_shrub: ['tree_shrub', 'palm_injection'], // ordered: a palm-only series (catalog category tree_shrub) prices as palm_injection alone
  mosquito: ['mosquito'],
  termite: ['termite_bait'],
  rodent: ['rodent_bait'],
});
// Rider line items that the LEDGER folds into the same family slice
// (LEDGER_FAMILIES_FOR_LINE below). A monthly-billed line's current rate
// sums them, so its list rate sums the engine's matching items too; a
// per-application line reads the visit's own stamp, so its list stays the
// primary item alone.
const ENGINE_RIDER_KEYS = Object.freeze({
  tree_shrub: ['palm_injection'],
});
// customer_plan_rates.family_key vocabulary per ranking line (plan-rate-
// ledger.js: rodent bait is `rodent_bait`, termite bait `termite_bait`, a palm
// rider `palm_injection` beside `tree_shrub`). A line's slice is the SUM of
// the ledger rows that belong to it.
const LEDGER_FAMILIES_FOR_LINE = Object.freeze({
  pest_control: ['pest_control'],
  lawn_care: ['lawn_care'],
  tree_shrub: ['tree_shrub', 'palm_injection'],
  mosquito: ['mosquito'],
  termite: ['termite_bait', 'termite'],
  rodent: ['rodent_bait', 'rodent'],
});
const KNOWN_LEDGER_FAMILIES = new Set(Object.values(LEDGER_FAMILIES_FOR_LINE).flat());
// A granted retention offer and an active plan hold are scoped to ONE plan
// family (retention_offers / plan_holds family_key — the ledger's
// vocabulary, which LEDGER_FAMILIES_FOR_LINE maps this line to): a lawn
// offer never holds the pest review (the invoice rails apply an offer to
// its own family only, visit-completion-payment.js). A failed read or an
// unrecognised family key holds every line — fail closed.
function familySignalTouchesLine(families, familyKey) {
  if (families === 'error' || !Array.isArray(families)) return true;
  const lineFamilies = LEDGER_FAMILIES_FOR_LINE[familyKey] || [familyKey];
  return families.some((f) => lineFamilies.includes(f) || !KNOWN_LEDGER_FAMILIES.has(f));
}
// reservice-scheduler's open-callback lane keys per family (facts.js
// openCallbackLanes); families with no re-service lane are never held by one.
const CALLBACK_LANE_FOR_FAMILY = Object.freeze({ pest_control: 'pest', lawn_care: 'lawn' });
const MAX_USABLE_MINUTES = 240;
// A home visit's wall clock minus the allowance never reads below this —
// an allowance is a line average, not this visit's conversation.
const MIN_TREATMENT_MINUTES = 10;
const MAX_ALLOWANCE_MINUTES = 25;
// Both sides of a line's home/not-home split need this many usable visits
// before the difference of medians is an allowance (else the pooled
// all-lines allowance, else 0).
const MIN_ALLOWANCE_SAMPLE = 3;
const INTERACTION_HOME = 'tech_home_spoke_with_them';
const INTERACTION_NOT_HOME = 'not_home_full_access';
const LOOKBACK_DAYS = 365;
const MIN_MODE_SAMPLE = 3;
// Quartiles over fewer accounts than this say nothing — no $/hr nudge.
const MIN_LINE_RPH_SAMPLE = 4;
// Snapshot statuses that mean "this line was reviewed" for the 12-month rule.
const REVIEWED_STATUSES = ['green', 'approved', 'sent', 'applied'];
const SENT_STATUSES = ['sent', 'applied'];
// A line whose LATEST snapshot ended in one of these comes back in every
// following batch (carried_forward) until it goes green/approved or its
// review date is more than CARRY_FORWARD_MAX_DAYS_PAST days behind the
// build — a past-due or recent-callback hold returns next month, not next
// year. Product rule (owner lens default), overridable.
const CARRY_FORWARD_STATUSES = ['exception', 'skipped'];
const CARRY_FORWARD_MAX_DAYS_PAST = 90;
// The review window: anniversaries 35–65 days out from the build date, so
// the 30-day written notice always fits before the anniversary application
// (a build on the 1st for "next month" left 28 days in February). It
// crosses month boundaries; batch_key stays the build month.
const REVIEW_WINDOW_FROM_DAYS = 35;
const REVIEW_WINDOW_TO_DAYS = 65;
// Turf bases the engine itself treats as heuristic (estimator-engine/
// draft-builder.js HEURISTIC_TURF_BASES) — local mirror for the fallback
// predicate only; the canonical helpers are required lazily below.
const HEURISTIC_TURF_BASES = new Set(['lotFallback', 'plausibleMaxTurfCap', 'legacyHardscapeEstimate', 'countyPrior', 'commercialLotFallback', 'commercialDefault']);
// Field names a completion may one day carry for conversation minutes —
// read off service_records.structured_notes (the Fast Complete lane owns
// the capture; see the module header). TODO(fast-complete): wire the real
// field here once it ships; until then conversationMinutesFor() is null and
// the line allowance applies.
const CONVERSATION_MINUTES_KEYS = ['conversationMinutes', 'conversation_minutes'];

// ── small pure helpers ──────────────────────────────────────────────────

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positive(value) {
  const n = finite(value);
  return n != null && n > 0 ? n : null;
}

function toCents(value) {
  const n = finite(value);
  return n == null ? null : Math.round(n * 100);
}

function roundToWholeDollars(cents) {
  return Math.round(cents / 100) * 100;
}

function floorToWholeDollars(cents) {
  return Math.floor(cents / 100) * 100;
}

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Trimmed median (owner 2026-09-30): once there are ≥4 usable visits the
// single LONGEST one is dropped before the median, so one long day — a
// first visit, an unusually chatty stop — cannot drag the whole year.
function trimmedMedian(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const kept = v.length >= 4 ? v.slice(0, -1) : v;
  return median(kept);
}

function quartiles(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { q1: null, median: null, q3: null, n: 0 };
  const at = (p) => {
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  return { q1: at(0.25), median: at(0.5), q3: at(0.75), n: v.length };
}

// Most frequent whole-dollar value; ties resolve to the LOWER value (the
// customer-favourable side: a lower list puts more accounts in band A).
function modeCents(values) {
  const counts = new Map();
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) continue;
    const key = roundToWholeDollars(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  for (const [value, count] of counts) {
    if (!best || count > best.count || (count === best.count && value < best.value)) best = { value, count };
  }
  return best;
}

// A PostgreSQL DATE column (scheduled_date, member_since, term dates,
// tier_protected_until, window_from/to). pg hydrates DATE at the HOST's
// local midnight (pg-types parseDate does new Date(y, m, d)) — on Railway
// that is UTC midnight, which etDateString would read as the evening
// before. Local getters give the calendar date back in any host zone
// (same rule as service-report/time-format.js dateOnlyStamp).
function dateColumn(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return m ? m[1] : null;
}

// An instant (timestamptz, ISO string) → its ET calendar day.
function etDay(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  try { return etDateString(d); } catch { return null; }
}

function ymdParts(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return { y, m, d };
}

function ymdToUtcMs(ymd) {
  const { y, m, d } = ymdParts(ymd);
  return Date.UTC(y, m - 1, d);
}

// Whole calendar months from `from` to `to`. The start day is clamped to the
// target month's length, so a line started Feb 29 is 12 months old on the
// Feb 28 it is observed (anniversaryInWindow) in a common year, and Jan 31
// → Feb 28 is one month.
function monthsBetween(fromYmd, toYmd) {
  const a = ymdParts(fromYmd);
  const b = ymdParts(toYmd);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  const lastDayOfTargetMonth = new Date(Date.UTC(b.y, b.m, 0)).getUTCDate();
  if (b.d < Math.min(a.d, lastDayOfTargetMonth)) months -= 1;
  return Math.max(0, months);
}

// ET-calendar date N months before `now`, as YYYY-MM-DD (day clamped by
// Date.UTC overflow rules — the 31st minus one month lands on the 1st of
// the following month, which is the stricter side for a lookback).
// ET-calendar date N months before `now`, clamped to the target month's
// length (Mar 31 − 6 months = Sep 30, never Oct 1) — utils/date-only.js's
// calendar-exact helper with a negative offset.
function monthsAgoYmd(now, months) {
  return addMonthsSameDay(etDateString(now), -months);
}

// `anchor` = the build date the window counts from. The monthly job anchors
// on the FIRST of the build month whatever day its tick runs (a day-2
// retry after a failed day-1 build must cover the same Dec 6 – Jan 5, not
// Dec 7 – Jan 6 — anniversaries would otherwise fall through, and carry-
// forward only reads earlier batches); an ad-hoc build anchors on today.
function reviewWindowFor(now, { anchor = null } = {}) {
  const base = anchor ? new Date(`${anchor}T12:00:00Z`) : now;
  return { from: etDateString(addETDays(base, REVIEW_WINDOW_FROM_DAYS)), to: etDateString(addETDays(base, REVIEW_WINDOW_TO_DAYS)) };
}

// N ET calendar days before `now` — addETDays walks the ET calendar, so a
// window that crosses a DST transition never lands a day early (fixed
// 24-hour subtraction did, just after midnight EDT).
function daysAgoYmd(now, days) {
  return etDateString(addETDays(now, -days));
}

// The anniversary's occurrence inside [from, to] (YYYY-MM-DD), or null when
// its month-day falls outside the window. The occurrence is placed in each
// window year (a window can straddle a year end); a window of a year or
// more holds an occurrence for every anniversary (the catch-up batch). That
// occurrence is the REVIEW DATE: tenure for the 12-month lock is measured
// at it, not at build time — a line started 2025-12-05 is exactly 12 months
// old on 2026-12-05, which is what the December batch (built November 1)
// reviews.
function anniversaryInWindow(anniversaryYmd, fromYmd, toYmd) {
  if (!anniversaryYmd) return null;
  if (!anniversaryYmd) return null;
  const from = ymdParts(fromYmd);
  const to = ymdParts(toYmd);
  const a = ymdParts(anniversaryYmd);
  const years = [];
  for (let year = from.y; year <= to.y; year += 1) years.push(year);
  for (const year of years) {
    // Feb 29 anniversaries observe Feb 28 in a common year.
    const lastDay = new Date(Date.UTC(year, a.m, 0)).getUTCDate();
    const occurrence = `${year}-${String(a.m).padStart(2, '0')}-${String(Math.min(a.d, lastDay)).padStart(2, '0')}`;
    if (occurrence >= fromYmd && occurrence <= toYmd) return occurrence;
  }
  return null;
}

// ── cadence → visits per year ───────────────────────────────────────────

// Applications per year: the cadence table, except a seasonal program
// (mosquito Feb–Oct) whose catalog count is the truth (9, not 12).
function visitsPerYearFor(cadence, catalogVisitsPerYear) {
  if (cadence === 'seasonal') return positive(catalogVisitsPerYear) || null;
  return CADENCE_VISITS[cadence] || positive(catalogVisitsPerYear) || null;
}

// ── treatment minutes ───────────────────────────────────────────────────

// TODO(fast-complete): conversation minutes are not captured anywhere yet.
// When the completion form records them (structured_notes key, see
// CONVERSATION_MINUTES_KEYS), this returns the value and it is subtracted
// INSTEAD of the line allowance. Until then: null (no field).
function conversationMinutesFor(row) {
  const notes = parseJson(row.service_record_structured_notes);
  if (!notes || typeof notes !== 'object') return null;
  for (const key of CONVERSATION_MINUTES_KEYS) {
    const n = finite(notes[key]);
    if (n != null && n >= 0) return n;
  }
  return null;
}

function interactionFor(row) {
  const value = String(row.customer_interaction || '').toLowerCase();
  if (value === INTERACTION_HOME) return 'home';
  if (value === INTERACTION_NOT_HOME) return 'not_home';
  return 'unknown';
}

// Wall-clock on-site minutes from pricing-reality-check's ladder (persisted
// admin corrections → grouped allocation → time entries → actual_start/end
// → check_in/out → arrived_at/completed_at → …). Prod check 2026-09-30:
// every start stamp equals arrived_at and every end stamp equals
// completed_at, so there is nothing to prefer over the ladder — the
// conversation control is the interaction flag, below. Null when the visit
// has no usable span (≤ 0, or longer than 4 hours).
function wallMinutesFor(row) {
  const minutes = resolveActualMinutes(row);
  if (minutes == null || !(minutes > 0) || minutes > MAX_USABLE_MINUTES) return null;
  return minutes;
}

// Treatment minutes for one visit:
//   captured conversation minutes (future field) → wall − captured;
//   not home, full access                        → wall (pure treatment);
//   tech spoke with the customer                 → wall − line allowance;
//   no interaction value                         → wall, lower confidence.
// A subtraction never reads below MIN_TREATMENT_MINUTES.
function treatmentMinutesFor(row, allowanceMinutes = 0) {
  const wall = wallMinutesFor(row);
  if (wall == null) return null;
  const interaction = interactionFor(row);
  const captured = conversationMinutesFor(row);
  if (captured != null) {
    return { wall, treatment: Math.max(wall - captured, MIN_TREATMENT_MINUTES), interaction, adjustment: 'captured', subtracted: captured };
  }
  if (interaction === 'not_home') return { wall, treatment: wall, interaction, adjustment: 'none', subtracted: 0 };
  if (interaction === 'home') {
    const allowance = Math.max(0, finite(allowanceMinutes) || 0);
    return { wall, treatment: Math.max(wall - allowance, MIN_TREATMENT_MINUTES), interaction, adjustment: 'allowance', subtracted: allowance };
  }
  return { wall, treatment: wall, interaction, adjustment: 'none', subtracted: 0, lowConfidence: true };
}

// Per-line conversation allowance = median wall minutes of home visits −
// median wall minutes of not-home visits (floor 0, cap 25). Computed over
// the book's completed recurring visits of the last 12 months at build time
// and stored on the batch row. A line with too few visits on either side
// takes the pooled all-lines allowance; with nothing pooled either, 0.
function computeLineAllowances(visitRows, { minSample = MIN_ALLOWANCE_SAMPLE } = {}) {
  const byLine = new Map();
  const pooled = { home: [], not_home: [] };
  for (const row of visitRows || []) {
    if (row.composite_visit) continue; // add-on work inside the stop — not this line's wall clock
    const wall = wallMinutesFor(row);
    if (wall == null) continue;
    const interaction = interactionFor(row);
    if (interaction === 'unknown') continue;
    const line = row.line || 'other';
    if (!byLine.has(line)) byLine.set(line, { home: [], not_home: [] });
    byLine.get(line)[interaction].push(wall);
    pooled[interaction].push(wall);
  }
  const resolve = (sides) => {
    if (sides.home.length < minSample || sides.not_home.length < minSample) return null;
    const homeMedian = median(sides.home);
    const notHomeMedian = median(sides.not_home);
    const raw = homeMedian - notHomeMedian;
    const allowance = Math.round(Math.min(Math.max(raw, 0), MAX_ALLOWANCE_MINUTES) * 100) / 100;
    return { allowance_minutes: allowance, home_median: homeMedian, not_home_median: notHomeMedian, home_n: sides.home.length, not_home_n: sides.not_home.length };
  };
  const pooledResolved = resolve(pooled);
  const allowances = {};
  for (const line of new Set([...LINE_KEYS, ...byLine.keys()])) {
    const own = byLine.has(line) ? resolve(byLine.get(line)) : null;
    if (own) allowances[line] = { ...own, source: 'line' };
    else if (pooledResolved) allowances[line] = { ...pooledResolved, source: 'pooled' };
    else allowances[line] = { allowance_minutes: 0, home_median: null, not_home_median: null, home_n: byLine.get(line)?.home.length || 0, not_home_n: byLine.get(line)?.not_home.length || 0, source: 'none' };
  }
  return allowances;
}

function allowanceFor(allowances, line) {
  const entry = allowances && (allowances[line] || allowances.other);
  return entry ? finite(entry.allowance_minutes) || 0 : 0;
}

// Settled revenue for one visit: its paid invoice (net of refunds), else —
// for a prepay-covered visit — the covering term's SETTLED amount (its
// prepay invoice paid and collectible, net of refunds on the linked
// payments) spread over the covered visits. A term whose invoice is unpaid,
// reversed, or missing (settlement unknown) yields no revenue: the stamped
// prepaid_amount / original prepay_amount are what was CHARGED, not what
// settled (clearPrepaidStampsForTerm keeps completed visits' stamps after a
// refund), so they are never used here.
function visitRevenueCents(row, { termVisitsFallback = null } = {}) {
  const paid = positive(row.paid_revenue);
  if (paid != null) return Math.round(paid * 100);
  if (row.annual_prepay_term_id) {
    const settled = positive(row.term_settled_amount);
    // a term from before coverage_visit_count existed (nullable) infers its
    // count the way resolveCurrentRate does — the line's cadence / catalog count
    const visits = positive(row.term_visit_count) || positive(termVisitsFallback);
    if (settled != null && visits != null) return Math.round((settled / visits) * 100);
  }
  return null;
}

function revenuePerHour(paired) {
  // Same trim as the median: the single longest paired visit is dropped
  // once ≥4 are usable, so the ratio and the median describe the same set.
  const kept = paired.length >= 4 ? [...paired].sort((a, b) => a.treatment - b.treatment).slice(0, -1) : paired;
  const totalMinutes = kept.reduce((sum, u) => sum + u.treatment, 0);
  const totalRevenue = kept.reduce((sum, u) => sum + u.revenueCents, 0);
  return totalMinutes > 0 ? Math.round(totalRevenue / (totalMinutes / 60)) : null;
}

// Per-line duration + revenue stats over the completed non-callback
// recurring visits of the last 12 months. Revenue per hour pairs each
// usable visit with its settled revenue (paid invoice, or the prepay term's
// per-visit share). An account with ≥ min_usable_visits paired NOT-HOME
// visits gets $/hr from those alone (pure treatment time, no allowance
// guesswork); otherwise every paired visit counts with the allowance
// applied to the home ones.
// `duesRevenueCents`: for a monthly-billed line, the SETTLED dues of the
// lookback attributed to each completed application (duesPerVisitCents) —
// monthly members pay at account level, so their visits carry no invoice of
// their own. Used only for a visit with no paired revenue; flagged
// rph_from_dues.
function lineDurationStats(visitRows, { config = DEFAULT_CONFIG, allowanceMinutes = 0, duesRevenueCents = null, termVisitsFallback = null } = {}) {
  const usable = [];
  let duesAttributed = 0;
  let compositeVisits = 0;
  for (const row of visitRows || []) {
    // A composite visit (add-ons performed in the same stop) is no evidence
    // for the line: the invoice's primary and add-on lines could be split,
    // the minutes cannot — attributing the application's money to the whole
    // stop's clock would understate $/hr exactly where it decides a band.
    // Excluded from both, counted for the owner (composite_visits_excluded).
    if (row.composite_visit) { compositeVisits += 1; continue; }
    const t = treatmentMinutesFor(row, allowanceMinutes);
    if (!t) continue;
    let revenueCents = visitRevenueCents(row, { termVisitsFallback });
    if (revenueCents == null && duesRevenueCents > 0) { revenueCents = duesRevenueCents; duesAttributed += 1; }
    usable.push({ ...t, revenueCents });
  }
  const minutes = usable.map((u) => u.treatment);
  const treatmentMinutesMedian = trimmedMedian(minutes);
  const paired = usable.filter((u) => u.revenueCents != null);
  const pairedNotHome = paired.filter((u) => u.interaction === 'not_home');
  let revenuePerHourCents = null;
  let rphFromNotHome = false;
  if (pairedNotHome.length >= config.min_usable_visits) {
    revenuePerHourCents = revenuePerHour(pairedNotHome);
    rphFromNotHome = revenuePerHourCents != null;
  } else if (usable.length >= config.min_usable_visits && paired.length >= config.min_usable_visits) {
    revenuePerHourCents = revenuePerHour(paired);
  }
  const homeVisits = usable.filter((u) => u.interaction === 'home').length;
  const notHomeVisits = usable.filter((u) => u.interaction === 'not_home').length;
  return {
    usableVisits: usable.length,
    homeVisits,
    notHomeVisits,
    unknownInteractionVisits: usable.length - homeVisits - notHomeVisits,
    allowanceMinutesApplied: usable.some((u) => u.adjustment === 'allowance') ? Math.max(0, finite(allowanceMinutes) || 0) : null,
    capturedConversationVisits: usable.filter((u) => u.adjustment === 'captured').length,
    duesAttributedVisits: revenuePerHourCents != null ? duesAttributed : 0,
    compositeVisits,
    treatmentMinutesMedian,
    revenuePerHourCents,
    rphFromNotHome,
  };
}

// ── band math ───────────────────────────────────────────────────────────

function gapPct(currentCents, listCents) {
  if (!(listCents > 0) || !(currentCents > 0)) return null;
  return ((listCents - currentCents) / listCents) * 100;
}

function baseBandForGap(gap, config) {
  if (gap <= 0) return 'A';
  if (gap <= config.band_b_tolerance_pct) return 'B';
  if (gap <= config.band_c_max_pct) return 'C';
  return 'D';
}

// One-band revenue-per-hour nudge. `lineRph` = { q1, median, q3, n } over
// the line's accounts with a usable $/hr. Never produces D.
function nudgeBand(band, rph, lineRph, usableVisits, config, flags) {
  if (rph == null || !lineRph || lineRph.n < MIN_LINE_RPH_SAMPLE || usableVisits < config.min_usable_visits) return band;
  if (band === 'A' && lineRph.median != null && rph < lineRph.median) {
    flags.push('rph_below_line_median');
    return 'B';
  }
  if (band === 'B' && lineRph.q1 != null && rph <= lineRph.q1) {
    flags.push('rph_bottom_quartile');
    return 'C';
  }
  if (band === 'C' && lineRph.q3 != null && rph >= lineRph.q3) {
    flags.push('rph_top_quartile');
    return 'B';
  }
  return band;
}

// Whole dollars per application, never a cut, capped at the smaller of
// cap_pct and cap_cents, and nothing under min_delta.
function classifyBand({ currentCents, listCents, rph = null, lineRph = null, usableVisits = 0, config = DEFAULT_CONFIG }) {
  const flags = [];
  const gap = gapPct(currentCents, listCents);
  if (gap == null) {
    return { band: null, gapPct: null, proposedCents: currentCents || 0, deltaCents: 0, noChange: true, flags: ['no_list_rate'] };
  }
  let band = baseBandForGap(gap, config);
  band = nudgeBand(band, rph, lineRph, usableVisits, config, flags);

  let target;
  if (band === 'A') target = currentCents;
  else if (band === 'B') target = roundToWholeDollars(currentCents * (1 + config.pass_through_pct / 100));
  else if (band === 'C') target = roundToWholeDollars(listCents);
  else target = floorToWholeDollars(currentCents + Math.min(currentCents * (config.cap_pct / 100), config.cap_cents));
  // A downward-performance nudge (B → C on bottom-quartile $/hr) asks for
  // MORE than the pass-through, never less: list can sit under current +
  // pass-through when the gap is small, so the B proposal is the floor.
  if (band === 'C' && flags.includes('rph_bottom_quartile')) target = Math.max(target, roundToWholeDollars(currentCents * (1 + config.pass_through_pct / 100)));

  const capCents = Math.min(currentCents * (config.cap_pct / 100), config.cap_cents);
  const capped = Math.min(target, floorToWholeDollars(currentCents + capCents));
  if (capped < target || band === 'D') flags.push('capped');
  let proposed = Math.max(capped, currentCents); // never a cut
  let delta = proposed - currentCents;
  let noChange = false;
  if (delta < config.min_delta_cents) {
    if (delta > 0) flags.push('below_min_delta');
    proposed = currentCents;
    delta = 0;
    noChange = true;
  }
  return { band, gapPct: Math.round(gap * 1000) / 1000, proposedCents: proposed, deltaCents: delta, noChange, flags };
}

// ── exception rules (pure; takes already-loaded facts) ──────────────────

// ── exception rules — one row per hold flag, in reporting order ─────────
// `f` is the account's cancellation facts (null when the loader failed).
const EXCEPTION_RULES = Object.freeze([
  ['no_anniversary', (l) => !l.anniversaryDate],
  ['tenure_under_lock', (l, c) => !!l.anniversaryDate && l.tenureMonths != null && l.tenureMonths < c.lock_months],
  ['prepay_mid_term', (l) => !!l.prepayMidTerm],
  ['prepay_term_missing', (l) => !!l.prepayTermMissing],
  ['prepay_term_ambiguous', (l) => !!l.prepayTermAmbiguous],
  ['rate_unattributed', (l) => !!l.rateUnattributed],
  ['cadence_conflict', (l) => !!l.cadenceConflict],
  ['reviewed_within_12mo', (l) => !!l.reviewedWithin12mo],
  ['manual_rate_edit_recent', (l) => !!l.manualRateEditRecent],
  ['retention_offer_active', (l) => !!l.retentionOfferActive],
  ['plan_hold_active', (l) => !!l.planHoldActive],
  ['callback_recent', (l) => !!l.callbackRecent],
  ['cancellation_case_recent', (l) => !!l.cancellationCaseRecent],
  ['complaint_open', (l, c, f) => !!(f && f.openComplaint)],
  ['past_due', (l, c, f) => !!(f && f.accountCurrent === false)],
  ['hand_picked_tier', (l) => !!l.handPickedTier],
  ['commercial', (l) => !!l.commercial],
  ['termite_program', (l, c, f) => l.familyKey === 'termite' || !!(f && f.termiteRental)],
  ['multi_property', (l, c, f) => !!(f && f.multiProperty)],
  // per_visit and one_time are explicit per-visit lanes (billing-lane.js); a
  // recurring series on either, or on the legacy NULL lane, is cleanup first.
  ['lane_cleanup', (l) => l.billingLane === 'per_visit' || l.billingLane === 'one_time' || l.billingLane == null],
  ['list_low_confidence', (l) => !!l.listLowConfidence],
  ['list_bundle_incomplete', (l) => !!l.listBundleIncomplete],
  ['multi_program_line', (l) => !!l.multiProgramLine],
  ['unsupported_family', (l) => l.familyKey === 'other'],
  ['facts_unavailable', (l, c, f) => !f],
  ['facts_degraded', (l, c, f) => !!(f && f.moneyFactsDegraded)],
]);
// every hold flag a snapshot can carry (no_current_rate is assigned by the
// band math, not a rule)
const EXCEPTION_FLAGS = Object.freeze([...EXCEPTION_RULES.map(([flag]) => flag), 'no_current_rate']);

// Informational flags (never a hold), in reporting order. A flag given as a
// function names itself from the line (engine_sync_failed / engine_replay_failed).
const INFO_FLAG_RULES = Object.freeze([
  ['list_from_cadence_mode', (l) => l.listRateSource === 'cadence_mode'],
  ['list_cadence_mismatch', (l) => !!l.listCadenceMismatch],
  ['anniversary_predates_portal', (l) => !!l.anniversaryConflict],
  // imported account, only program, no loaded history: dated by membership
  ['anniversary_from_membership', (l) => l.anniversarySource === 'member_since_import'],
  ['stamped_zero_free', (l) => !!l.stampedZeroFree],
  ['carried_forward', (l) => !!l.carriedFrom],
  // a legacy NULL billing_mode resolved through the canonical lane rule
  // (billing-lane.js) — the lane itself decides any hold
  ['lane_inferred', (l) => !!l.laneInferred],
  ['composite_discount_withheld', (l) => !!l.compositeWithheld],
  [(l) => l.engineUnavailable, (l) => !!l.engineUnavailable],
  ['rph_from_not_home_visits', (l) => !!l.rphFromNotHome],
  ['interaction_unknown', (l) => l.unknownInteractionVisits > 0],
  ['conversation_minutes_captured', (l) => l.capturedConversationVisits > 0],
  ['rph_from_dues', (l) => l.duesAttributedVisits > 0],
  ['composite_visits_excluded', (l) => l.compositeVisits > 0],
]);

function informationalFlags(line) {
  return INFO_FLAG_RULES.filter(([, applies]) => applies(line)).map(([flag]) => (typeof flag === 'function' ? flag(line) : flag));
}

function evaluateExceptions(line, config = DEFAULT_CONFIG) {
  const facts = line.facts || null;
  return EXCEPTION_RULES.filter(([, applies]) => applies(line, config, facts)).map(([flag]) => flag);
}

// ── snapshot assembly (pure) ────────────────────────────────────────────

// Band math per rate unit. Monthly dues are a cadence's annual price spread
// over 12 months; the bands, the $ cap and the minimum are PER APPLICATION,
// so a monthly line is normalized to the per-application equivalent
// (monthly × 12 ÷ visits), classified there, and the whole-dollar
// per-application proposal is spread back over 12.
function classifyLine(line, config) {
  const current = line.currentRateCents || 0;
  const vpy = line.visitsPerYear || 0;
  if (current <= 0) return { band: null, gapPct: null, proposedCents: 0, deltaCents: 0, noChange: true, flags: ['no_current_rate'] };
  // No annual visit count (a legacy/custom cadence with no catalog count):
  // a proposal with no annual impact is not actionable — skipped, never
  // green with annual_delta_cents 0.
  if (!(vpy > 0)) return { band: null, gapPct: null, proposedCents: current, deltaCents: 0, noChange: true, flags: ['no_visits_per_year'] };
  const evidence = { rph: line.revenuePerHourCents, lineRph: line.lineRph, usableVisits: line.usableVisits, config };
  if (line.rateUnit !== 'month') return classifyBand({ currentCents: current, listCents: line.listRateCents, ...evidence });
  const perAppCurrent = Math.round((current * 12) / vpy);
  const perAppList = line.listRateCents != null ? Math.round((line.listRateCents * 12) / vpy) : null;
  const perApp = classifyBand({ currentCents: perAppCurrent, listCents: perAppList, ...evidence });
  const proposedMonthly = perApp.noChange ? current : Math.round((perApp.proposedCents * vpy) / 12);
  return { ...perApp, proposedCents: proposedMonthly, deltaCents: proposedMonthly - current, perApplication: { current: perAppCurrent, list: perAppList, proposed: perApp.proposedCents, delta: perApp.deltaCents } };
}

// Column defaults applied in one pass (a `??` per column was a decision each).
const SNAPSHOT_ROW_DEFAULTS = Object.freeze({
  visits_per_year: null, billing_lane: null, anniversary_date: null, anniversary_source: null, review_date: null, tenure_months: null,
  current_rate_source: 'none', rate_unit: 'application', list_rate_cents: null, list_rate_source: 'none',
  usable_visits: 0, home_visits: 0, not_home_visits: 0, allowance_minutes_applied: null, treatment_minutes_median: null, revenue_per_hour_cents: null,
});

function computeSnapshot(line, config = DEFAULT_CONFIG) {
  const exceptions = evaluateExceptions(line, config);
  const classified = classifyLine(line, config);
  const flags = [...new Set([...exceptions, ...informationalFlags(line), ...classified.flags])];
  const current = line.currentRateCents || 0;
  let status = 'green';
  if (current <= 0 || (classified.band == null && !exceptions.length)) status = 'skipped';
  else if (exceptions.length) status = 'exception';
  else if (classified.noChange) status = 'no_change';
  const row = {
    batch_key: line.batchKey,
    customer_id: line.customerId,
    family_key: line.familyKey,
    cadence: line.cadence,
    visits_per_year: line.visitsPerYear,
    billing_lane: line.billingLane,
    anniversary_date: line.anniversaryDate,
    anniversary_source: line.anniversarySource,
    review_date: line.reviewDate,
    tenure_months: line.tenureMonths,
    current_rate_cents: current,
    current_rate_source: line.currentRateSource,
    rate_unit: line.rateUnit,
    list_rate_cents: line.listRateCents,
    list_rate_source: line.listRateSource,
    gap_pct: classified.gapPct,
    usable_visits: line.usableVisits,
    home_visits: line.homeVisits,
    not_home_visits: line.notHomeVisits,
    allowance_minutes_applied: line.allowanceMinutesApplied,
    rph_from_not_home: !!line.rphFromNotHome,
    treatment_minutes_median: line.treatmentMinutesMedian,
    revenue_per_hour_cents: line.revenuePerHourCents,
    band: classified.band,
    proposed_rate_cents: classified.proposedCents,
    delta_cents: classified.deltaCents,
    annual_delta_cents: Math.round(classified.deltaCents * (line.rateUnit === 'month' ? 12 : (line.visitsPerYear || 0))),
    flags,
    status,
  };
  for (const [column, fallback] of Object.entries(SNAPSHOT_ROW_DEFAULTS)) if (row[column] == null) row[column] = fallback;
  return row;
}

// ── anniversary ─────────────────────────────────────────────────────────

// The line's start date. Portal-sold line (its visits link an accepted
// estimate): first completed recurring visit, else the accept date — the
// 12-month lock runs from the first application the customer paid for.
// Imported line (no accepted estimate in the portal, a completed visit on
// record): the EARLIER of
// customers.member_since and the first completed visit — the portal went
// live April 2026, so for an imported account the first visit here is a
// lower bound on tenure, not the start (member_since is real back to 2024;
// prod pre-read 2026-09-30). A member_since more than 90 days before a
// portal-sold line's start is surfaced as `anniversary_predates_portal`
// (informational flag, never a hold).
// firstCompletedVisit and memberSince are DATE columns; acceptedAt is an
// instant (estimates.accepted_at) read on the ET calendar.
// A no-estimate line backdates to member_since only when it was already
// running when the account reached the portal: its first completed visit
// falls within one visit interval (+30 days' grace) of the ACCOUNT's
// earliest completed visit here — an import brings the account and its
// running programs in together, and a quarterly or semiannual program's
// first visit can trail the account's by its own interval. A program first
// seen later was added since, whatever the admin booked it without, and
// starts at its first visit.
const IMPORT_PRESENCE_DAYS = 90;
// An account whose membership predates its portal record by this much came
// in by import (the April 2026 load created 657 accounts with member_since
// back to 2024-05); an account opened in the portal has member_since on or
// about its created_at.
const IMPORTED_ACCOUNT_LEAD_DAYS = 30;
function presenceWindowFor(visitsPerYear) {
  return visitsPerYear > 0 ? Math.round(365 / visitsPerYear) + 30 : IMPORT_PRESENCE_DAYS;
}
function isImportedAccount(member, accountCreatedDay) {
  return !!(member && accountCreatedDay) && (ymdToUtcMs(accountCreatedDay) - ymdToUtcMs(member)) / DAY_MS >= IMPORTED_ACCOUNT_LEAD_DAYS;
}
function resolveAnniversary({ firstCompletedVisit, acceptedAt, memberSince, accountFirstVisit = null, presenceWindowDays = IMPORT_PRESENCE_DAYS, accountCreatedAt = null, onlyActiveFamily = false, accountHasActivity = false }) {
  const firstVisit = dateColumn(firstCompletedVisit);
  const accepted = etDay(acceptedAt);
  const member = dateColumn(memberSince);
  const accountFirst = dateColumn(accountFirstVisit);
  const presentAtImport = !accountFirst || !firstVisit || (ymdToUtcMs(firstVisit) - ymdToUtcMs(accountFirst)) / DAY_MS <= presenceWindowDays;
  let date = null;
  let source = null;
  if (accepted) {
    if (firstVisit) { date = firstVisit; source = 'first_visit'; } else { date = accepted; source = 'estimate_accept'; }
  } else if (member && firstVisit) {
    if (member <= firstVisit && presentAtImport) { date = member; source = 'member_since'; } else { date = firstVisit; source = 'first_visit'; }
  } else if (firstVisit) { date = firstVisit; source = 'first_visit'; }
  // No accepted estimate and no completed visit yet: the line's age is
  // unknown — never the account's membership (an admin-booked program can
  // be days old) — and the row is held (no_anniversary) until its first
  // application dates it. One exception (owner ruling 2026-10-02, Fix B):
  // an IMPORTED account (membership ≥ 30 days older than its portal
  // record) whose ONLY active program this is came in with that program —
  // its history simply was not loaded — so member_since dates the line.
  // A second program on the account (counted on the underlying plan lines
  // and service keys, not the consolidated family — tree/shrub + palm is
  // two programs in one entry), or any portal activity on the account
  // (loadAccountActivity: an accepted estimate, a completed visit of any
  // kind, a recurring add-on program), takes the rules above.
  else if (member && !accountFirst && onlyActiveFamily && !accountHasActivity && isImportedAccount(member, etDay(accountCreatedAt))) { date = member; source = 'member_since_import'; }
  let conflict = false;
  if (date && member && source !== 'member_since') {
    conflict = (ymdToUtcMs(date) - ymdToUtcMs(member)) / DAY_MS > 90;
  }
  return { date, source, conflict };
}

// ── engine replay (list rate) ───────────────────────────────────────────

// The V2 admin estimator's request → v1 engine input translator lives on a
// route module; required lazily (service → route load-order cycle, same as
// admin-estimate-persistence.js#serverRecomputeFromEstimateData).
let translateV2CallToV1InputCached;
function lazyTranslateV2() {
  if (translateV2CallToV1InputCached === undefined) {
    try {
      translateV2CallToV1InputCached = require('../routes/property-lookup-v2').translateV2CallToV1Input || null;
    } catch {
      translateV2CallToV1InputCached = null;
    }
  }
  return translateV2CallToV1InputCached;
}

// The engine input an accepted estimate was priced from, in the canonical
// order admin-estimate-persistence.js replays it: the admin V2
// engineRequest (profile / selectedServices / options, translated), then a
// stored engineInputs, then the public wizard's `inputs` — which IS the
// engine shape there, but is the UI form on an admin V2 save, so it only
// counts when it carries a services map. Returns null when nothing can be
// replayed (→ cadence mode or skipped).
const isObject = (value) => !!value && typeof value === 'object';

function engineInputsFromEstimate(estimate, deps = {}) {
  const data = parseJson(estimate && estimate.estimate_data);
  if (!isObject(data)) return null;
  const req = data.engineRequest;
  if (isObject(req) && isObject(req.profile)) {
    const translate = deps.translateV2CallToV1Input !== undefined ? deps.translateV2CallToV1Input : lazyTranslateV2();
    if (typeof translate === 'function') {
      try {
        const v1 = translate(req.profile, Array.isArray(req.selectedServices) ? req.selectedServices : [], req.options || {});
        if (isObject(v1)) return v1;
      } catch (err) {
        logger.warn(`[rate-review] engineRequest translation failed for estimate ${estimate.id}: ${err.message}`);
      }
    }
  }
  if (isObject(data.engineInputs)) return data.engineInputs;
  if (isObject(data.inputs) && isObject(data.inputs.services)) return data.inputs;
  return null;
}

function hasSizeInput(inputs, line) {
  if (!inputs) return false;
  if (line === 'pest_control' || line === 'termite' || line === 'rodent') {
    return !!(positive(inputs.homeSqFt) || positive(inputs.footprintSqFt) || positive(inputs.footprint) || positive(inputs.livingAreaSqFt));
  }
  if (line === 'lawn_care') {
    return !!(positive(inputs.lawnSqFt) || positive(inputs.measuredTurfSf) || positive(inputs.estimatedTurfSf) || positive(inputs.lotSqFt));
  }
  if (line === 'mosquito') return !!(positive(inputs.lotSqFt) || positive(inputs.mosquitoTreatableSqFt));
  if (line === 'tree_shrub') return !!(positive(inputs.bedArea) || positive(inputs.estimatedBedAreaSf) || positive(inputs.lotSqFt) || positive(inputs.palmCount));
  return false;
}

// Engine `services.<key>` entries → ranking family, and the engine's
// qualifying-service keys per family (priorQualifyingServices vocabulary).
const ENGINE_INPUT_SERVICE_FAMILY = Object.freeze({
  pest: 'pest_control', lawn: 'lawn_care', treeShrub: 'tree_shrub', palmInjection: 'tree_shrub', palm: 'tree_shrub', mosquito: 'mosquito',
  termite: 'termite', termiteBait: 'termite', termite_bait: 'termite', rodent: 'rodent', rodentBait: 'rodent', rodent_bait: 'rodent',
});
// Within the tree_shrub family the engine prices two PROGRAMS under
// different input keys — `treeShrub` (the bed program) and `palmInjection`
// / `palm` (estimate-engine.js: services.palmInjection || services.palm).
// The current-bundle reconciliation works per program, never per family: a
// saved program survives only while an active line still carries it,
// judged by the line's catalog service keys (palm_injection* = palm,
// anything else = tree/shrub), so a cancelled tree/shrub program cannot
// keep its qualifying discount on the strength of a surviving palm rider.
const ENGINE_INPUT_SERVICE_PROGRAM = Object.freeze({ ...ENGINE_INPUT_SERVICE_FAMILY, palmInjection: 'palm', palm: 'palm' });
function isPalmServiceKey(key) {
  return /palm/.test(String(key || '').toLowerCase());
}
// The programs an active plan line carries. A tree_shrub line without
// catalog keys is of unknown composition: it keeps whatever was sold.
function linePrograms(line) {
  if (!line || !line.familyKey) return [];
  if (line.familyKey !== 'tree_shrub') return [line.familyKey];
  const keys = Array.isArray(line.serviceKeys) ? line.serviceKeys : [];
  if (!keys.length) return ['tree_shrub', 'palm'];
  const out = [];
  if (keys.some((k) => !isPalmServiceKey(k))) out.push('tree_shrub');
  if (keys.some(isPalmServiceKey)) out.push('palm');
  return out;
}
// The engine services a line's own programs price as — the whole-account
// dues fallback (customers.monthly_rate; no ledger slice names the
// components) compares against every program the line carries.
const PROGRAM_ENGINE_KEY = Object.freeze({ tree_shrub: 'tree_shrub', palm: 'palm_injection' });
function engineKeysForLine(familyKey, serviceKeys) {
  return linePrograms({ familyKey, serviceKeys }).map((program) => PROGRAM_ENGINE_KEY[program] || program);
}
// The program a line's QUALIFYING key (qualifyingKeyForLine) stands for —
// for a tree_shrub line that is the bed program; palm qualifies for nothing.
function qualifyingProgramForLine(line) {
  return line && line.familyKey ? line.familyKey : null;
}
const QUALIFYING_KEY_FOR_FAMILY = Object.freeze({
  pest_control: 'pest_control', lawn_care: 'lawn_care', tree_shrub: 'tree_shrub', mosquito: 'mosquito', termite: 'termite_bait', rodent: 'rodent_bait',
});
// The engine qualifying key an ACTIVE plan line contributes as a prior
// service — from its catalog service keys, not its family: a palm-only
// tree_shrub line (palm_injection*) qualifies for nothing.
// A tree_shrub family whose open visits carry BOTH programs (bed keys and
// palm_injection* keys) on one cadence: a per-application median across
// their distinct prices is a blend, and the replay prices one primary item
// (riders join monthly figures only) — held (multi_program_line). The
// monthly ledger slice sums both programs and its replay must then price
// every component (list_bundle_incomplete), so it is not held here.
function isMultiProgramLine(familyKey, serviceKeys) {
  if (familyKey !== 'tree_shrub') return false;
  const keys = (Array.isArray(serviceKeys) ? serviceKeys : []).map((k) => String(k || '').toLowerCase());
  return keys.some(isPalmServiceKey) && keys.some((k) => !isPalmServiceKey(k));
}

function qualifyingKeyForLine(line) {
  const keys = (line && Array.isArray(line.serviceKeys) ? line.serviceKeys : []).map((k) => String(k || '').toLowerCase());
  if (line.familyKey === 'tree_shrub') {
    if (keys.length && keys.every(isPalmServiceKey)) return null; // standalone palm program
    return 'tree_shrub';
  }
  return QUALIFYING_KEY_FOR_FAMILY[line.familyKey] || null;
}

const PEST_FREQUENCY_FOR_CADENCE = Object.freeze({ quarterly: 'quarterly', bimonthly: 'bimonthly', monthly: 'monthly' });
const LAWN_TIER_FOR_CADENCE = Object.freeze({ every_6_weeks: 'enhanced', monthly: 'premium', bimonthly: 'standard' });
const MOSQUITO_TIER_FOR_CADENCE = Object.freeze({ seasonal: 'seasonal', monthly: 'monthly' });
// Re-keying a saved service to the line's own cadence: the engine prices
// pest by `frequency`, lawn by `tier` + `lawnFreq`, mosquito by `tier`.
const CADENCE_REKEY = Object.freeze({
  pest_control: { service: 'pest', keyFor: (cadence) => PEST_FREQUENCY_FOR_CADENCE[cadence], apply: (svc, key) => ({ ...svc, frequency: key }) },
  lawn_care: {
    service: 'lawn',
    keyFor: (cadence) => LAWN_TIER_FOR_CADENCE[cadence],
    apply: (svc, key, cadence, clean) => { delete clean.lawnFreq; return { ...svc, tier: key, lawnFreq: CADENCE_VISITS[cadence] }; },
  },
  mosquito: { service: 'mosquito', keyFor: (cadence) => MOSQUITO_TIER_FOR_CADENCE[cadence], apply: (svc, key) => ({ ...svc, tier: key }) },
});

// Quote-time concessions come off so the replay prices TODAY'S LIST for the
// same property, services and (engine-derived) tier — at the cadence the
// line actually runs on (pest frequency / lawn tier), which can differ from
// the cadence the estimate was sold at.
// Saved-estimate replay pins that would reprice the quote AS SOLD rather
// than at today's list: the retired pest curve (services.pest.version),
// frozen floors/minimums, legacy rodent posture, termite knob snapshots.
const REPLAY_PIN_KEYS = ['manualDiscount', 'serviceSpecificDiscounts', 'serviceSpecificCredits', 'pestProgramFloorArmed', 'pestProgramFloorPerVisit',
  'lawnProgramMinimumMonthly', 'useLawnCostFloor', 'commercialFloorsArmedServices', 'rodentWaveguardPostureReplay', 'termitePricingKnobs'];
const REPLAY_PIN_SERVICE_KEYS = Object.freeze({ pest: ['version', 'pricingVersion'], lawn: ['programMinimumMonthly', 'useLawnCostFloor'] });

// `activeFamilies`: the customer's plan lines TODAY, as
// { familyKey, serviceKeys } (a bare family string is read as a line whose
// catalog keys are unknown). The engine derives the WaveGuard tier from the
// services it prices plus priorQualifyingServices, so the replay's bundle
// is reconciled to the current plan — a program the customer has since
// cancelled comes out of the estimate's services, one added since (on
// another estimate) goes in as a prior qualifying service — and the list
// carries today's tier, not the one the old quote was sold at. The prior
// key is derived from the line's SERVICE keys, never its family alone: a
// palm-only program sits in the tree_shrub family but does not qualify
// (estimate-engine.js counts palm_injection toward no tier), so it adds
// nothing — a pest + palm account stays Bronze, as the engine prices it.
// `savedPriorQualifying`: the SERVER-stamped prior-qualifying services on
// estimate_data (admin-estimate-persistence writes the top-level key only
// when it repriced at the server) — restored for the ORIGINAL-mix replay
// so an add-on estimate legitimately sold at Silver (the customer already
// had another program) replays at Silver, not Bronze. Never the client-
// posted copy inside the inputs, which the sanitizer strips.
function listReplayInputs(inputs, { familyKey, cadence, activeFamilies, savedPriorQualifying } = {}) {
  // The shared client-identity sanitizer first (estimate-client-identity-
  // fields.js: every server-owned replay stamp — treeShrubPricingKnobs,
  // palmAnnualRounding, catalogPricing, the identity flags …), the same
  // pass admin-estimate-persistence runs before an authoritative recompute;
  // the local pin list below covers the service-level pins it does not.
  const clean = sanitizeClientIdentityFields(JSON.parse(JSON.stringify(inputs)));
  for (const key of REPLAY_PIN_KEYS) delete clean[key];
  const services = isObject(clean.services) ? clean.services : null;
  for (const [service, keys] of Object.entries(REPLAY_PIN_SERVICE_KEYS)) {
    if (!services || !isObject(services[service])) continue;
    for (const key of keys) delete services[service][key];
  }
  if (!Array.isArray(activeFamilies) && Array.isArray(savedPriorQualifying) && savedPriorQualifying.length) {
    clean.priorQualifyingServices = savedPriorQualifying.map(String);
    clean.recurringCustomer = true;
  }
  if (Array.isArray(activeFamilies) && services) reconcileToActivePrograms(clean, services, activeFamilies);
  const rekey = CADENCE_REKEY[familyKey];
  const cadenceKey = rekey && rekey.keyFor(cadence);
  if (cadenceKey && services && services[rekey.service]) services[rekey.service] = rekey.apply(services[rekey.service], cadenceKey, cadence, clean);
  return clean;
}

// The current-bundle reconciliation (see listReplayInputs): a saved program
// survives only while an active line still carries it; every other active
// program the engine counts toward the tier goes in as a prior — a bed
// program added after a pest + palm quote included.
function reconcileToActivePrograms(clean, services, activeFamilies) {
  const lines = activeFamilies.map((f) => (typeof f === 'string' ? { familyKey: f, serviceKeys: [] } : f));
  const activePrograms = new Set(lines.flatMap(linePrograms));
  const present = new Set(); // programs the surviving saved services price inside the bundle
  for (const [service, value] of Object.entries(services)) {
    const program = ENGINE_INPUT_SERVICE_PROGRAM[service];
    if (!program || !value) continue; // one-time / commercial / unknown keys are left as saved
    if (activePrograms.has(program)) present.add(program);
    else delete services[service]; // cancelled since the quote
  }
  const priors = [...new Set(lines.filter((l) => !present.has(qualifyingProgramForLine(l))).map(qualifyingKeyForLine).filter(Boolean))];
  clean.priorQualifyingServices = priors;
  if (priors.length) clean.recurringCustomer = true;
}

// The engine's own review-gating predicates (estimator-engine/draft-builder
// lineRequiresReview + lineHasHeuristicTurf, the pair estimate-proposal-
// generate.js's rowIsReviewGated composes), required lazily; the local
// mirror below is the fallback if that module cannot load here.
let reviewPredicatesCached;
function engineReviewPredicates() {
  if (reviewPredicatesCached === undefined) {
    try {
      const { lineRequiresReview, lineHasHeuristicTurf } = require('./estimator-engine/draft-builder');
      reviewPredicatesCached = typeof lineRequiresReview === 'function' && typeof lineHasHeuristicTurf === 'function' ? { lineRequiresReview, lineHasHeuristicTurf } : null;
    } catch {
      reviewPredicatesCached = null;
    }
  }
  return reviewPredicatesCached || {
    lineRequiresReview: (line = {}) => !!(line.quoteRequired || line.requiresManualReview || line.requiresMeasurement || line.customQuoteFlag || line.requiresCustomQuote
      || (Array.isArray(line.manualReviewReasons) && line.manualReviewReasons.length)),
    lineHasHeuristicTurf: (line = {}) => String(line.turfConfidence || '').toLowerCase() === 'low' || (line.turfBasis != null && HEURISTIC_TURF_BASES.has(line.turfBasis)),
  };
}

// An engine line that needs a human (manual review, measurement, custom
// quote, heuristic turf, LOW pricing confidence) is not a list price.
// The engine's WaveGuard tier as a comparable key (null when absent).
const tierKey = (tier) => (tier ? String(tier).toLowerCase() : null);
function engineTier(result) {
  return tierKey(result && result.waveGuard && result.waveGuard.tier);
}

function engineItemLowConfidence(item) {
  const { lineRequiresReview, lineHasHeuristicTurf } = engineReviewPredicates();
  return lineRequiresReview(item) || lineHasHeuristicTurf(item) || String(item.pricingConfidence || '').toUpperCase() === 'LOW';
}

// Engine items carry their annual application count under the persisted
// aliases the converter's canonical resolver recognises (estimate-converter
// visitsPerYearForRecurringService: visitsPerYear / appsPerYear / visits /
// apps / treatmentsPerYear — pest and tree & shrub say visitsPerYear, palm
// says appsPerYear, mosquito says visits); lawn's `frequency` is the one
// field outside that vocabulary. The local list is the fallback if the
// converter cannot load here — the same aliases, so never a different count.
let visitCountResolverCached;
function visitCountResolver() {
  if (visitCountResolverCached === undefined) {
    try {
      const { visitsPerYearForRecurringService } = require('./estimate-converter');
      visitCountResolverCached = typeof visitsPerYearForRecurringService === 'function' ? visitsPerYearForRecurringService : null;
    } catch {
      visitCountResolverCached = null;
    }
  }
  return visitCountResolverCached || ((item) => positive(item.visitsPerYear) ?? positive(item.appsPerYear) ?? positive(item.visits) ?? positive(item.apps) ?? positive(item.treatmentsPerYear) ?? null);
}
function engineItemVisits(item) {
  return positive(visitCountResolver()(item || {})) ?? positive(item.frequency);
}

// `expectedVisits`: the line's own applications per year (seasonal mosquito
// = 9, not the 12 its monthly pattern suggests); falls back to the cadence
// table when the caller has none.
// `riderAllow`: the ledger family keys the current monthly slice actually
// sums (ledgerSliceForLine(...).family_keys) — a rider priced on the saved
// estimate but cancelled since has no slice and must not inflate the list.
function listRateFromEngineResult(result, line, cadence, { includeRiders, expectedVisits, riderAllow } = {}) {
  const keys = ENGINE_SERVICE_KEYS[line] || [];
  const items = result && Array.isArray(result.lineItems) ? result.lineItems : [];
  const tier = engineTier(result);
  // First key present wins (tree_shrub before palm_injection); a standalone
  // palm program is then the primary, never a rider of a missing line.
  const item = keys.map((k) => items.find((i) => i.service === k)).find(Boolean);
  if (!item) return null;
  // Every ledger component that is one of this line's engine programs must
  // be priced in the replay, as the primary or a rider. A monthly Tree &
  // Shrub slice carrying palm injections sold on a SEPARATE estimate
  // replays the bed program alone (reconciliation adds the other program
  // as tier context, never as a priced service): that one-program list is
  // no comparison for the combined ledger rate — held (list_bundle_incomplete).
  if (includeRiders && Array.isArray(riderAllow)) {
    const missing = riderAllow.filter((k) => keys.includes(k) && !items.some((i) => i.service === k));
    if (missing.length) return { bundleIncomplete: true, missingServices: missing, tier };
  }
  if (engineItemLowConfidence(item)) return { lowConfidence: true, tier };
  const annual = positive(item.annualAfterDiscount ?? item.annual);
  const visits = engineItemVisits(item);
  if (!annual || !visits) return null;
  const expected = positive(expectedVisits) || CADENCE_VISITS[cadence];
  const cadenceMismatch = !!(expected && Math.round(visits) !== Math.round(expected));
  // Riders (a palm program beside Tree & Shrub) join the MONTHLY figure only,
  // mirroring the ledger slice the monthly current rate was read from.
  const riderKeys = includeRiders
    ? (ENGINE_RIDER_KEYS[line] || []).filter((k) => k !== item.service && (!Array.isArray(riderAllow) || riderAllow.includes(k)))
    : [];
  const riders = items.filter((i) => riderKeys.includes(i.service));
  // A rider the current slice carries is part of the compared bundle: one
  // that needs a human holds the whole line, never a silent drop that
  // compares a rider-inclusive current rate against a rider-free list.
  if (riders.some((i) => engineItemLowConfidence(i))) return { lowConfidence: true, tier };
  const riderAnnual = riders.reduce((sum, r) => sum + (positive(r.annualAfterDiscount ?? r.annual) || 0), 0);
  return {
    perAppCents: Math.round((annual / visits) * 100),
    monthlyCents: Math.round(((annual + riderAnnual) / 12) * 100),
    riderServices: riders.map((r) => r.service),
    cadenceMismatch,
    tier,
  };
}

// One authoritative refresh of the engine's DB-backed constants per batch,
// UNCONDITIONALLY — the process-local needsSync() interval can report
// "fresh" on a pod whose constants another pod's pricing edit just made
// stale. false (the bridge never rejects) = no engine list for the batch.
async function syncPricingConstants(deps = {}) {
  const engine = deps.pricingEngine || require('./pricing-engine');
  if (typeof engine.syncConstantsFromDB !== 'function') return true;
  try {
    const synced = await engine.syncConstantsFromDB();
    if (synced === false) logger.warn('[rate-review] pricing constants did not sync — no engine list rates this batch');
    return synced !== false;
  } catch (err) {
    logger.warn(`[rate-review] pricing constants sync threw — no engine list rates this batch: ${err.message}`);
    return false;
  }
}

// How rodent counted toward the tier THEN (a legacy rodent bait plan
// qualified for nothing; a new-model row froze its WaveGuard flags): the
// sold-mix replay — the hand-picked-tier evidence — derives the two pins
// from the SAVED RESULT (estimate_data.result / engineResult) with the
// signal readers the authoritative recompute and the public replay use
// (rodent-bait-legacy-replay.js; admin-estimate-persistence.js), falling
// back to a stamp the extracted inputs may still carry, so a Bronze that
// was the engine's own doing replays Bronze. The current-list replay prices
// today's rules and lets the sanitizer strip them.
const SOLD_POSTURE_KEYS = ['rodentBaitLegacyReplay', 'rodentWaveguardPostureReplay'];
function soldPosturePins(data, inputs) {
  let signals = null;
  try { signals = require('./rodent-bait-legacy-replay'); } catch { signals = null; }
  const stamped = (key) => (isObject(inputs[key]) ? inputs[key] : null);
  return {
    rodentBaitLegacyReplay: (signals && signals.rodentBaitLegacyReplaySignal(data || {})) || stamped('rodentBaitLegacyReplay'),
    rodentWaveguardPostureReplay: (signals && signals.rodentWaveguardPostureReplaySignal(data || {})) || stamped('rodentWaveguardPostureReplay'),
  };
}

async function replayEstimate(estimate, { familyKey, cadence, activeFamilies, soldMix = false }, deps) {
  const inputs = engineInputsFromEstimate(estimate, deps);
  if (!inputs) return null;
  if (deps.engineSynced === false) return { unavailable: 'engine_sync_failed' };
  const engine = deps.pricingEngine || require('./pricing-engine');
  const data = parseJson(estimate.estimate_data);
  const savedPriorQualifying = data && Array.isArray(data.priorQualifyingServices) ? data.priorQualifyingServices : null;
  try {
    const replayInputs = listReplayInputs(inputs, { familyKey, cadence, activeFamilies, savedPriorQualifying });
    if (soldMix) {
      const pins = soldPosturePins(data, inputs);
      for (const key of SOLD_POSTURE_KEYS) if (pins[key]) replayInputs[key] = pins[key];
    }
    return { inputs, result: engine.generateEstimate(replayInputs) };
  } catch (err) {
    logger.warn(`[rate-review] engine replay failed for estimate ${estimate.id}: ${err.message}`);
    return { unavailable: 'engine_replay_failed' };
  }
}

// ── data loaders ────────────────────────────────────────────────────────

// The admin-editable knobs. A MISSING row defaults (the seed migration
// guarantees one); a read that FAILS propagates — a batch ranked, persisted
// and emailed on DEFAULT_CONFIG while the owner's edited caps were
// unreadable would be a valid-looking batch under the wrong rules.
async function loadConfig(dbh = db) {
  const row = await dbh(CONFIG).where({ id: 1 }).first();
  const config = { ...DEFAULT_CONFIG };
  if (row) {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const n = finite(row[key]);
      if (n != null && n >= 0) config[key] = n;
    }
  }
  return config;
}

// The scheduled row's FROZEN service_category_snapshot first (a later
// catalog re-categorization must not move a booked series between
// families); the live catalog only when the row carries no snapshot.
const LINE_SQL = `CASE COALESCE(s.service_category_snapshot, sv.category,
    CASE WHEN s.service_type ILIKE '%mosquito%' THEN 'mosquito'
         WHEN s.service_type ILIKE '%termite%' OR s.service_type ILIKE '%wdo%' THEN 'termite'
         WHEN s.service_type ILIKE '%rodent%' OR s.service_type ILIKE '%trap%' THEN 'rodent'
         WHEN s.service_type ILIKE '%lawn%' THEN 'lawn_care'
         WHEN s.service_type ILIKE '%tree%' OR s.service_type ILIKE '%shrub%' OR s.service_type ILIKE '%palm%' THEN 'tree_shrub'
         WHEN s.service_type ILIKE '%pest%' THEN 'pest_control' END)
  WHEN 'pest_control' THEN 'pest_control' WHEN 'lawn_care' THEN 'lawn_care' WHEN 'tree_shrub' THEN 'tree_shrub'
  WHEN 'mosquito' THEN 'mosquito' WHEN 'termite' THEN 'termite' WHEN 'rodent' THEN 'rodent' ELSE 'other' END`;

const CADENCE_SQL = `CASE WHEN sv.frequency LIKE 'seasonal%' OR s.recurring_pattern LIKE 'seasonal%' THEN 'seasonal'
  WHEN s.recurring_pattern IN ('monthly','monthly_nth_weekday') THEN 'monthly'
  WHEN s.recurring_pattern IN ('bimonthly','bi-monthly') THEN 'bimonthly'
  WHEN s.recurring_pattern = 'quarterly' THEN 'quarterly'
  WHEN s.recurring_pattern = 'semiannual' THEN 'semiannual'
  WHEN s.recurring_pattern = 'every_6_weeks' OR (s.recurring_pattern = 'custom' AND s.recurring_interval_days = 42) THEN 'every_6_weeks'
  WHEN s.recurring_pattern = 'custom' AND s.recurring_interval_days BETWEEN 26 AND 35 THEN 'monthly'
  WHEN s.recurring_pattern = 'custom' AND s.recurring_interval_days BETWEEN 56 AND 65 THEN 'bimonthly'
  WHEN s.recurring_pattern = 'custom' AND s.recurring_interval_days BETWEEN 84 AND 98 THEN 'quarterly'
  WHEN s.recurring_pattern = 'custom' AND s.recurring_interval_days BETWEEN 175 AND 190 THEN 'semiannual'
  WHEN (s.recurring_pattern = 'custom' OR s.recurring_pattern IS NULL) AND s.recurring_interval_days IS NULL AND sv.frequency = 'bimonthly' THEN 'bimonthly'
  WHEN (s.recurring_pattern = 'custom' OR s.recurring_pattern IS NULL) AND s.recurring_interval_days IS NULL AND sv.frequency IN ('monthly','quarterly','every_6_weeks','semiannual') THEN sv.frequency
  ELSE 'other' END`;

// SQL mirror of recurring-series-cancel-reseed.js#isPlanSeriesRow — the
// purchased-plan row predicate: the recurring root or a child (explicitly
// recurring, or a legacy null-flagged child of a root), never an explicit
// booster (is_recurring = false + parent), a free re-service callback or an
// included follow-up. One rule for the book and the history loaders.
const PLAN_ROW_SQL = `((s.is_recurring = true OR (s.is_recurring IS NULL AND s.recurring_parent_id IS NOT NULL))
  AND COALESCE(s.is_callback, false) = false AND COALESCE(s.followup_included, false) = false)`;
// The rows that DATE a line (its anniversary): every completed application
// of the family that is not an explicit booster, a callback or an included
// follow-up — the recurring flag is not required. Prod read 2026-10-02: 14
// completed "Quarterly Pest Control Service" / "Bi-Monthly Tree & Shrub"
// rows (7 imported pre-April history, 7 admin-booked since) carry
// is_recurring = false with no parent, so the October batch held 12 of its
// 25 no_anniversary lines although the work was done. A customer's first
// paid application dates the line whether or not the booking was flagged
// recurring; revenue and $/hr keep PLAN_ROW_SQL (loadCompletedVisitRows).
// IS FALSE, not = false: a legacy child (is_recurring NULL + parent) must
// stay in — `NOT (NULL AND true)` is NULL and WHERE would drop it.
const DATING_ROW_SQL = `(NOT (s.is_recurring IS FALSE AND s.recurring_parent_id IS NOT NULL)
  AND COALESCE(s.is_callback, false) = false AND COALESCE(s.followup_included, false) = false)`;
// Live upcoming rows = the same statuses the plan-count reconciler counts
// (isCountingSourceStatus: NULL or COUNTING_SOURCE_STATUSES) — a
// 'rescheduled' placeholder is not an application on the books.
const LIVE_STATUS_SQL = `(s.status IS NULL OR s.status IN (${COUNTING_SOURCE_STATUSES.map((st) => `'${st}'`).join(', ')}))`;

// Every active recurring plan line in the book: real, live customer × line
// × cadence with ≥1 upcoming purchased-plan row (PLAN_ROW_SQL ×
// LIVE_STATUS_SQL; the pre-read definition narrowed to the canonical
// plan-row predicate).
async function loadActivePlanLines(dbh, { today }) {
  const { rows } = await dbh.raw(`
    WITH ov AS (
      SELECT s.id, s.customer_id, s.scheduled_date, s.estimated_price, s.primary_line_price, s.annual_prepay_term_id, s.source_estimate_id,
        -- what the RECURRING APPLICATION costs on this visit, never the appointment total
        -- (estimate-membership-context.js rowServicePrice, codex #3359): a row without add-ons
        -- is its estimated_price; a composite row (scheduled_service_addons) is its
        -- primary_line_price net of its own line discount, or NOTHING when an appointment-level
        -- discount spans the primary and the add-ons with no recorded apportionment
        CASE
          WHEN ${COMBINED_CATALOG_SQL} THEN NULL
          WHEN NOT EXISTS (SELECT 1 FROM scheduled_service_addons a WHERE a.scheduled_service_id = s.id)
            THEN CASE WHEN s.estimated_price > 0 THEN s.estimated_price END
          WHEN COALESCE(s.discount_dollars, 0) > 0 OR s.discount_type IS NOT NULL OR s.discount_id IS NOT NULL THEN NULL
          WHEN s.primary_line_price - COALESCE(s.line_discount_dollars, 0) > 0 THEN s.primary_line_price - COALESCE(s.line_discount_dollars, 0)
          ELSE NULL
        END AS service_price,
        COALESCE(s.service_key_snapshot, sv.service_key) AS skey, sv.visits_per_year AS cat_vpy,
        ${LINE_SQL} AS line, ${CADENCE_SQL} AS cadence
      FROM scheduled_services s
      LEFT JOIN services sv ON sv.id = s.service_id
      JOIN customers c ON c.id = s.customer_id
      WHERE s.scheduled_date >= ?
        AND ${LIVE_STATUS_SQL}
        AND ${PLAN_ROW_SQL}
        AND c.deleted_at IS NULL
        AND c.active = true
        AND c.pipeline_stage IN ('active_customer', 'won', 'at_risk')
    )
    SELECT customer_id, line AS family_key, cadence,
      count(*)::int AS open_visits,
      min(scheduled_date) AS next_visit,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY service_price) FILTER (WHERE service_price > 0) AS median_price,
      count(service_price) FILTER (WHERE service_price > 0)::int AS priced_visits,
      count(*) FILTER (WHERE service_price IS NULL AND estimated_price > 0)::int AS withheld_visits,
      count(*) FILTER (WHERE estimated_price = 0)::int AS zero_priced_visits,
      count(*) FILTER (WHERE estimated_price = 0 AND primary_line_price > 0)::int AS zero_with_base_visits,
      bool_or(annual_prepay_term_id IS NOT NULL) AS prepay_linked,
      array_remove(array_agg(DISTINCT annual_prepay_term_id), NULL) AS prepay_term_ids,
      max(cat_vpy)::int AS catalog_vpy,
      array_remove(array_agg(DISTINCT source_estimate_id), NULL) AS source_estimate_ids,
      array_remove(array_agg(DISTINCT skey), NULL) AS service_keys
    FROM ov
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `, [today]);
  return rows;
}

async function loadCustomers(dbh, customerIds) {
  if (!customerIds.length) return new Map();
  const rows = await dbh('customers')
    .whereIn('id', customerIds)
    .select('id', 'first_name', 'last_name', 'member_since', 'created_at', 'billing_mode', 'per_application_fee', 'monthly_rate',
      'waveguard_tier', 'waveguard_tier_source', 'property_type', 'tier_protected_until', 'city', 'property_sqft');
  return new Map(rows.map((r) => [r.id, r]));
}

// Completed non-callback visit dates per (customer, line), oldest first
// (first_visit = the oldest; completed_dates = all of them, so a line
// restarted on a new estimate after a cancellation can take the first visit
// of the CURRENT series, not of the family's whole history). DATING_ROW_SQL,
// not PLAN_ROW_SQL: an application booked without the recurring flag still
// dates the line.
async function loadFirstCompletedVisits(dbh, customerIds) {
  if (!customerIds.length) return new Map();
  const { rows } = await dbh.raw(`
    SELECT s.customer_id, ${LINE_SQL} AS line, min(s.scheduled_date) AS first_visit, count(*)::int AS completed_visits,
      array_agg(s.scheduled_date ORDER BY s.scheduled_date) AS completed_dates
    FROM scheduled_services s
    LEFT JOIN services sv ON sv.id = s.service_id
    WHERE s.customer_id = ANY(?::uuid[])
      AND s.status = 'completed'
      AND ${DATING_ROW_SQL}
      AND ${LINE_SQL} <> 'other'
    GROUP BY 1, 2
  `, [customerIds]);
  const map = new Map();
  for (const row of rows) map.set(`${row.customer_id}|${row.line}`, row);
  return map;
}

// The first completed visit of the line's CURRENT series: for a portal-sold
// line, the first completion on or after the earliest accept date among the
// estimates its open visits link (a cancelled-and-restarted family keeps its
// old completions in the history); otherwise the oldest completion.
function firstCompletedVisitFor(first, acceptedAt) {
  if (!first) return null;
  const dates = (Array.isArray(first.completed_dates) ? first.completed_dates : []).map(dateColumn).filter(Boolean).sort();
  const acceptDay = etDay(acceptedAt);
  if (acceptDay && dates.length) return dates.find((d) => d >= acceptDay) || null;
  return dates[0] || dateColumn(first.first_visit) || null;
}

// The latest snapshot per (customer, line) from EARLIER batches — the
// carry-forward source (see CARRY_FORWARD_STATUSES).
async function loadLatestSnapshots(dbh, customerIds, { batchKey }) {
  if (!customerIds.length) return new Map();
  const rows = await dbh(SNAPSHOTS)
    .whereIn('customer_id', customerIds)
    .where('batch_key', '<', batchKey)
    .orderBy([{ column: 'batch_key', order: 'desc' }, { column: 'computed_at', order: 'desc' }])
    .select('customer_id', 'family_key', 'status', 'review_date', 'batch_key', 'computed_at', 'flags');
  const map = new Map();
  for (const row of rows) {
    const key = `${row.customer_id}|${row.family_key}`;
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

// Completed non-callback recurring visits of the last 12 months with every
// duration source pricing-reality-check reads, plus the settled revenue —
// the paid invoice total NET of any refund recorded on its payments (a
// partially refunded invoice stays 'paid'; the refund lives on the payment,
// linked the way invoice.js links them: Stripe intent / charge id, or the
// payment's metadata invoice_id — there is no payments.invoice_id). A
// combined setup/initial + first-application invoice contributes its
// application lines only; a pure setup invoice contributes nothing.
// The retired combined catalog identities — one scheduled row that performed
// TWO programs (estimate-converter.js RETIRED_COMBINED_CATALOG_KEYS /
// comboRouteFamiliesFromCatalogKey: pest + termite bait, lawn + tree & shrub)
// with no addon row and no per-program split of its price or its minutes.
// Historical rows survive their retirement inside the lookback: composite
// in the completed-visit evidence, withheld in the current-rate decomposition.
const RETIRED_COMBINED_CATALOG_KEYS = Object.freeze(['pest_termite_bait_quarterly', 'lawn_tree_shrub_combo']);
const COMBINED_CATALOG_SQL = `COALESCE(s.service_key_snapshot, sv.service_key) IN (${RETIRED_COMBINED_CATALOG_KEYS.map((k) => `'${k}'`).join(', ')})`;

// A partial refund's refund_amount carries the prorated card surcharge
// returned with it (stripe.js _refundPayment → payments.refunded_surcharge_cents)
// while invoices.total never held the surcharge: the BASE refund is what
// comes off revenue. The dues payment rail nets the surcharge out of the
// charge the same way (payments.surcharge_amount_cents).
const REFUND_BASE_SQL = 'GREATEST(COALESCE(p.refund_amount, 0) - COALESCE(p.refunded_surcharge_cents, 0) / 100.0, 0)';

// The deposit paid at acceptance and applied to an invoice is part of what
// the customer paid for the application: invoices.total is the REMAINING
// balance after the credit, and the credit survives only as the negative
// `deposit_credit` line item (invoice.js create — there is no column).
// Consideration = total + that credit; a fully deposit-funded application
// (total 0) still pairs its revenue.
function depositCreditSql(alias) {
  return `COALESCE((
            SELECT -sum(NULLIF(regexp_replace(dc ->> 'amount', '[^0-9.-]', '', 'g'), '')::numeric)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(COALESCE(${alias}.line_items::jsonb, 'null'::jsonb)) = 'array' THEN ${alias}.line_items::jsonb ELSE '[]'::jsonb END) dc
            WHERE dc ->> 'category' = 'deposit_credit'
          ), 0)`;
}

async function loadCompletedVisitRows(dbh, customerIds, { sinceYmd }) {
  if (!customerIds.length) return [];
  const notSettled = INVOICE_UNCOLLECTIBLE_STATUSES.filter((st) => st !== 'paid' && st !== 'prepaid');
  const { rows } = await dbh.raw(`
    WITH te AS (
      SELECT job_id, sum(duration_minutes) AS time_entry_minutes, min(clock_in) AS time_entry_clock_in, max(clock_out) AS time_entry_clock_out
      FROM time_entries
      WHERE entry_type = 'job' AND status IN ('completed', 'edited') AND job_id IS NOT NULL
      GROUP BY job_id
    ), sr AS (
      SELECT DISTINCT ON (scheduled_service_id) scheduled_service_id, id AS service_record_id,
        started_at AS service_record_started_at, ended_at AS service_record_ended_at,
        structured_notes AS service_record_structured_notes, customer_interaction
      FROM service_records
      WHERE scheduled_service_id IS NOT NULL
      ORDER BY scheduled_service_id, created_at DESC
    )
    SELECT s.id, s.customer_id, s.scheduled_date, ${LINE_SQL} AS line, ${CADENCE_SQL} AS cadence,
      s.service_time_minutes, s.actual_duration_minutes, s.actual_start_time, s.actual_end_time,
      s.check_in_time, s.check_out_time, s.arrived_at, s.completed_at,
      s.annual_prepay_term_id,
      -- a visit that also performed add-ons (scheduled_service_addons): its minutes and its money
      -- cover more than one program, with no per-line split of either — no evidence for this line
      (EXISTS (SELECT 1 FROM scheduled_service_addons a WHERE a.scheduled_service_id = s.id) OR ${COMBINED_CATALOG_SQL}) AS composite_visit,
      apt.coverage_visit_count AS term_visit_count,
      -- the term's COVERAGE money (prepay_amount — the invoice total may also carry a setup line), capped by what settled net of refunds
      (SELECT LEAST(apt.prepay_amount, pi.total - COALESCE((
          SELECT sum(${REFUND_BASE_SQL}) FROM payments p
          WHERE COALESCE(p.refund_amount, 0) > 0
            AND ((p.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id = pi.stripe_payment_intent_id)
              OR (p.stripe_charge_id IS NOT NULL AND p.stripe_charge_id = pi.stripe_charge_id)
              OR p.metadata::jsonb ->> 'invoice_id' = pi.id::text)
        ), 0) + ${depositCreditSql('pi')})
        FROM invoices pi
        WHERE pi.id = apt.prepay_invoice_id AND pi.archived_at IS NULL
          AND (pi.paid_at IS NOT NULL OR pi.status IN ('paid', 'prepaid'))
          AND pi.status NOT IN (${notSettled.map(() => '?').join(', ')})
      ) AS term_settled_amount,
      te.time_entry_minutes, te.time_entry_clock_in, te.time_entry_clock_out,
      sr.service_record_started_at, sr.service_record_ended_at, sr.service_record_structured_notes, sr.customer_interaction,
      (SELECT sum(LEAST(
          i.total - COALESCE((
            SELECT sum(${REFUND_BASE_SQL}) FROM payments p
            WHERE COALESCE(p.refund_amount, 0) > 0
              AND ((p.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id = i.stripe_payment_intent_id)
                OR (p.stripe_charge_id IS NOT NULL AND p.stripe_charge_id = i.stripe_charge_id)
                OR p.metadata::jsonb ->> 'invoice_id' = i.id::text)
          ), 0) + ${depositCreditSql('i')},
          -- a combined setup/initial + application invoice contributes its APPLICATION lines only
          CASE WHEN (COALESCE(i.title, '') ILIKE '%setup%' OR COALESCE(i.title, '') ILIKE '%initial%'
                     OR COALESCE(i.line_items::text, '') ILIKE '%setup%' OR COALESCE(i.line_items::text, '') ILIKE '%initial%')
               THEN CASE WHEN jsonb_typeof(COALESCE(i.line_items::jsonb, 'null'::jsonb)) = 'array'
                         THEN (SELECT COALESCE(sum(NULLIF(regexp_replace(li ->> 'amount', '[^0-9.-]', '', 'g'), '')::numeric), 0)
                               FROM jsonb_array_elements(i.line_items::jsonb) li
                               WHERE NOT (COALESCE(li ->> 'name', li ->> 'description', '') ILIKE '%setup%'
                                          OR COALESCE(li ->> 'name', li ->> 'description', '') ILIKE '%initial%')
                                 AND COALESCE(li ->> 'category', '') <> 'deposit_credit')
                         ELSE 0 END
               ELSE i.total + ${depositCreditSql('i')} END
        ) * COALESCE(share.fraction, 1))
        FROM invoices i
        -- an invoice shared by several visits — a completion-packet invoice (visit-completion-
        -- invoice.js: ONE invoice under billed[0].member.id, every billed member linked through
        -- visit_completion_packet_items.invoice_id) or a combined first-application invoice
        -- (estimate-converter.js stampCombinedFirstApplicationInvoiceCoverage: the anchor AND each
        -- covered sibling carry its id in first_application_invoice_id) — credits each member its
        -- own share of the settled total, pro rata by the members' visit prices (estimated_price,
        -- else the primary_line_price a folded sibling carries); a member with no price makes the
        -- split unknowable and the whole invoice contributes nothing — never its total to the anchor
        LEFT JOIN LATERAL (
          SELECT CASE
              WHEN count(*) FILTER (WHERE COALESCE(m.estimated_price, m.primary_line_price) > 0) < count(*) THEN 0
              WHEN sum(COALESCE(m.estimated_price, m.primary_line_price)) > 0
                THEN COALESCE(s.estimated_price, s.primary_line_price, 0) / sum(COALESCE(m.estimated_price, m.primary_line_price))
              ELSE 0 END AS fraction
          FROM (
            SELECT pm.scheduled_service_id AS id FROM visit_completion_packet_items pm WHERE pm.invoice_id = i.id
            UNION
            SELECT b.id FROM scheduled_services b WHERE b.first_application_invoice_id = i.id
          ) mem
          JOIN scheduled_services m ON m.id = mem.id
          HAVING count(*) > 1
        ) share ON true
        WHERE (i.scheduled_service_id = s.id
               -- an invoice linked only through its service record (invoice.js linkedScheduledServiceId)
               OR (i.service_record_id IS NOT NULL AND i.service_record_id = sr.service_record_id)
               OR s.first_application_invoice_id = i.id
               OR EXISTS (SELECT 1 FROM visit_completion_packet_items pm2 WHERE pm2.invoice_id = i.id AND pm2.scheduled_service_id = s.id))
          AND i.archived_at IS NULL AND i.annual_prepay_term_id IS NULL
          AND (i.paid_at IS NOT NULL OR i.status IN ('paid', 'prepaid'))
          AND i.status NOT IN (${notSettled.map(() => '?').join(', ')})
      ) AS paid_revenue
    FROM scheduled_services s
    LEFT JOIN services sv ON sv.id = s.service_id
    LEFT JOIN te ON te.job_id = s.id
    LEFT JOIN sr ON sr.scheduled_service_id = s.id
    LEFT JOIN annual_prepay_terms apt ON apt.id = s.annual_prepay_term_id
    WHERE s.customer_id = ANY(?::uuid[])
      AND s.status = 'completed'
      AND ${PLAN_ROW_SQL}
      AND s.scheduled_date >= ?
  `, [...notSettled, ...notSettled, customerIds, sinceYmd]);
  return rows;
}

// Settled membership dues per customer over the lookback — the monthly
// lane's revenue (facts.js posture: both rails carry chargeMonthly's
// "WaveGuard Monthly" marker and can double-count one payment, so the
// LARGER rail counts, never the sum). Both rails are NET of refunds: a
// partially refunded dues payment stays 'paid' with the refund on
// refund_amount, and a dues invoice is netted by the refunds on the
// payments linked to it (invoice.js's linkage: Stripe intent / charge id,
// metadata invoice_id) — netting one rail alone would let the other's
// gross figure win the GREATEST.
async function loadSettledDues(dbh, customerIds, { sinceYmd }) {
  if (!customerIds.length) return new Map();
  const notSettled = INVOICE_UNCOLLECTIBLE_STATUSES.filter((st) => st !== 'paid' && st !== 'prepaid');
  const { rows } = await dbh.raw(`
    WITH inv AS (
      SELECT i.customer_id, sum(i.total) - COALESCE(sum((
          SELECT sum(${REFUND_BASE_SQL}) FROM payments p
          WHERE COALESCE(p.refund_amount, 0) > 0
            AND ((p.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id = i.stripe_payment_intent_id)
              OR (p.stripe_charge_id IS NOT NULL AND p.stripe_charge_id = i.stripe_charge_id)
              OR p.metadata::jsonb ->> 'invoice_id' = i.id::text)
        )), 0) AS amount
      FROM invoices i
      WHERE i.customer_id = ANY(?::uuid[]) AND i.archived_at IS NULL
        AND (i.paid_at IS NOT NULL OR i.status IN ('paid', 'prepaid'))
        AND i.status NOT IN (${notSettled.map(() => '?').join(', ')})
        AND i.title ILIKE '%WaveGuard Monthly%'
        AND (COALESCE(i.paid_at, i.created_at) AT TIME ZONE 'America/New_York')::date >= ?
      GROUP BY i.customer_id
    ), pay AS (
      SELECT customer_id, sum(amount - COALESCE(surcharge_amount_cents, 0) / 100.0 - GREATEST(COALESCE(refund_amount, 0) - COALESCE(refunded_surcharge_cents, 0) / 100.0, 0)) AS amount FROM payments
      WHERE customer_id = ANY(?::uuid[]) AND status = 'paid'
        AND (description ILIKE '%WaveGuard Monthly%' OR metadata->>'type' = 'monthly_autopay')
        AND (created_at AT TIME ZONE 'America/New_York')::date >= ?
      GROUP BY customer_id
    )
    SELECT COALESCE(inv.customer_id, pay.customer_id) AS customer_id,
      GREATEST(COALESCE(inv.amount, 0), COALESCE(pay.amount, 0)) AS settled
    FROM inv FULL OUTER JOIN pay ON pay.customer_id = inv.customer_id
  `, [customerIds, ...notSettled, sinceYmd, customerIds, sinceYmd]);
  return new Map(rows.map((r) => [r.customer_id, Math.round((finite(r.settled) || 0) * 100)]));
}

// A monthly-billed line's settled dues per application over the lookback:
// the customer's settled dues × this family's share of the ledger (1 on a
// single-line account) ÷ the line's completed visits in the window. Null
// when nothing settled or nothing was completed — revenue/hour then stays
// unavailable rather than invented from today's rate.
function duesPerVisitCents({ settledCents, ledger, customerId, familyKey, accountLines, completedVisits }) {
  if (!(settledCents > 0) || !(completedVisits > 0)) return null;
  let share = null;
  const own = ledgerSliceForLine(ledger, customerId, familyKey);
  if (own) {
    let total = 0;
    for (const [key, row] of ledger) if (key.startsWith(`${customerId}|`)) total += finite(row.monthly_rate) || 0;
    share = total > 0 ? own.monthly_rate / total : null;
  } else if (accountLines === 1) {
    share = 1;
  }
  if (share == null || !(share > 0)) return null;
  return Math.round((settledCents * share) / completedVisits);
}

async function loadEstimates(dbh, estimateIds) {
  if (!estimateIds.length) return new Map();
  const rows = await dbh('estimates')
    .whereIn('id', estimateIds)
    .where({ status: 'accepted' })
    .select('id', 'customer_id', 'accepted_at', 'waveguard_tier', 'estimate_data');
  return new Map(rows.map((r) => [r.id, r]));
}

// Customers with ANY portal activity that says the account did not simply
// arrive by import with one running program — the one gate the import
// exception in resolveAnniversary reads (Codex #5668 r1–r2 found a new
// signal each round when these were judged piecemeal):
//   • an accepted estimate on the account, by status OR timestamp (a legacy
//     row can be status accepted with accepted_at NULL), linked or not;
//   • a completed scheduled_services row of ANY kind — any family, an
//     inspection, a specialty visit (the per-line dating map filters these;
//     the account gate must not);
//   • a live upcoming row carrying a recurring add-on program
//     (ADDON_LINE_IS_PLAN_SQL): a second program the plan-line count
//     cannot see.
async function loadAccountActivity(dbh, customerIds, { today }) {
  if (!customerIds.length) return new Set();
  const { ADDON_LINE_IS_PLAN_SQL } = require('./service-library');
  const { rows } = await dbh.raw(`
    SELECT c.id AS customer_id,
      (EXISTS (SELECT 1 FROM estimates e WHERE e.customer_id = c.id AND (e.accepted_at IS NOT NULL OR e.status = 'accepted'))
       OR EXISTS (SELECT 1 FROM scheduled_services s WHERE s.customer_id = c.id AND s.status = 'completed')
       OR EXISTS (SELECT 1 FROM scheduled_services s JOIN scheduled_service_addons ON scheduled_service_addons.scheduled_service_id = s.id
                  WHERE s.customer_id = c.id AND ${LIVE_STATUS_SQL} AND s.scheduled_date >= ? AND ${ADDON_LINE_IS_PLAN_SQL})
      ) AS account_activity
    FROM customers c WHERE c.id = ANY(?::uuid[])
  `, [today, customerIds]);
  const ids = new Set(customerIds.map(String));
  return new Set(rows.filter((r) => r.account_activity === true).map((r) => String(r.customer_id)).filter((id) => ids.has(id)));
}

async function loadLiveTerms(dbh, customerIds, { today }) {
  if (!customerIds.length) return new Map();
  const { coveredTermsAsOf } = require('./annual-prepay-renewals');
  const rows = await coveredTermsAsOf(dbh, today)
    .whereIn('t.customer_id', customerIds)
    .select('t.id', 't.customer_id', 't.prepay_amount', 't.coverage_visit_count', 't.coverage_service_type', 't.coverage_cadence', 't.term_start', 't.term_end', 't.status', 't.monthly_rate');
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.customer_id)) map.set(row.customer_id, []);
    map.get(row.customer_id).push(row);
  }
  return map;
}

async function loadLedgerSlices(dbh, customerIds) {
  if (!customerIds.length) return new Map();
  const rows = await dbh('customer_plan_rates').whereIn('customer_id', customerIds).select('customer_id', 'family_key', 'monthly_rate');
  const map = new Map();
  for (const row of rows) map.set(`${row.customer_id}|${row.family_key}`, row);
  return map;
}

// The ledger slice for a ranking line: the sum of the customer's rows under
// that line's ledger family keys (null when none).
function ledgerSliceForLine(ledger, customerId, familyKey) {
  const keys = LEDGER_FAMILIES_FOR_LINE[familyKey] || [familyKey];
  const rows = keys.map((k) => ledger.get(`${customerId}|${k}`)).filter(Boolean);
  if (!rows.length) return null;
  const monthly = rows.reduce((sum, r) => sum + (finite(r.monthly_rate) || 0), 0);
  return { monthly_rate: Math.round(monthly * 100) / 100, family_keys: rows.map((r) => r.family_key) };
}

// 'YYYY-MM' minus N months.
function monthKeyMinus(batchKey, months) {
  const [y, m] = batchKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// "Reviewed within 12 months" is judged on BATCH MONTHS, exclusive at the
// boundary: a line reviewed in the 2026-12 batch is held out of 2027-01 …
// 2027-11 and eligible again in 2027-12 — one review per 12 months at the
// anniversary, never a lifetime hold because last year's batch sits exactly
// 12 months back. Only earlier batches count: a rebuild of this batch, or a
// later batch that was built first, never holds a line out.
async function loadPriorReviews(dbh, customerIds, { batchKey }) {
  if (!customerIds.length) return new Set();
  const cutoffKey = monthKeyMinus(batchKey, 12);
  const rows = await dbh(SNAPSHOTS)
    .whereIn('customer_id', customerIds)
    .whereIn('status', REVIEWED_STATUSES)
    .where('batch_key', '>', cutoffKey)
    .where('batch_key', '<', batchKey) // only EARLIER batches review a line; a later batch already built never does
    .select('customer_id', 'family_key');
  return new Set(rows.map((r) => `${r.customer_id}|${r.family_key}`));
}

// Customer-level exception signals this module reads itself (the rest come
// from cancellation-resolution/facts.js). Each leg fails CLOSED: a query
// error reads as the signal being present.
async function loadExceptionSignals(dbh, customerId, { now, config }) {
  const sinceYmd = daysAgoYmd(now, config.exception_callback_days);
  const leg = async (fn) => { try { return await fn(); } catch (err) { logger.warn(`[rate-review] signal read failed for customer ${customerId}: ${err.message}`); return 'error'; } };
  const [callbacks, cases, offers, holds] = await Promise.all([
    leg(() => dbh.raw(`
      SELECT ${LINE_SQL} AS line, count(*)::int AS n
      FROM scheduled_services s LEFT JOIN services sv ON sv.id = s.service_id
      WHERE s.customer_id = ? AND s.is_callback = true
        AND s.status NOT IN ('cancelled', 'canceled', 'skipped', 'no_show')
        AND s.scheduled_date >= ?
      GROUP BY 1
    `, [customerId, sinceYmd]).then((r) => r.rows)),
    leg(() => dbh('cancellation_cases')
      .where({ customer_id: customerId })
      .where(function recentOrOpen() {
        this.where('status', 'open').orWhereRaw("(created_at AT TIME ZONE 'America/New_York')::date >= ?", [sinceYmd]);
      })
      .select('scope')),
    leg(() => dbh('retention_offers')
      .where({ customer_id: customerId, status: 'granted' })
      .where(function notExpired() { this.whereNull('expires_at').orWhere('expires_at', '>', now); })
      .select('family_key')),
    leg(() => dbh('plan_holds').where({ customer_id: customerId, status: 'active' }).select('family_key')),
  ]);
  return {
    callbackLines: callbacks === 'error' ? 'error' : callbacks.map((r) => r.line),
    // each case names the families it covers (cancellation_cases.scope; [] = the whole account)
    cancellationCaseScopes: cases === 'error' ? 'error' : cases.map((c) => parseJson(c.scope) || []),
    retentionOfferFamilies: offers === 'error' ? 'error' : offers.map((o) => o.family_key),
    planHoldFamilies: holds === 'error' ? 'error' : holds.map((h) => h.family_key),
  };
}

async function loadFacts(dbh, customerId, { now }) {
  try {
    const { loadCancellationFacts } = require('./cancellation-resolution/facts');
    return await loadCancellationFacts(customerId, { now, dbh });
  } catch (err) {
    logger.warn(`[rate-review] facts unavailable for customer ${customerId}: ${err.message}`);
    return null;
  }
}

function isCommercialCustomer(customer, serviceKeys = []) {
  const tier = String(customer.waveguard_tier || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (tier === 'commercial') return true;
  if (normalizePropertyType(customer.property_type) === 'commercial') return true;
  return (serviceKeys || []).some((k) => /^commercial_/.test(String(k || '')));
}

// ── current rate per lane ───────────────────────────────────────────────

// The plan family a prepay term's coverage_service_type text names.
function familyOfCoverage(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/mosquito/.test(t)) return 'mosquito';
  if (/termite|wdo/.test(t)) return 'termite';
  if (/rodent|trap/.test(t)) return 'rodent';
  if (/lawn/.test(t)) return 'lawn_care';
  if (/tree|shrub|palm/.test(t)) return 'tree_shrub';
  if (/pest/.test(t)) return 'pest_control';
  return null;
}

// The live prepay term that covers THIS line: the term the line's own
// visits link, else the one live term whose coverage names the family.
// Two candidates = ambiguous (held, never guessed).
function matchPrepayTerm(terms, planLine, familyKey) {
  const live = (terms || []).filter((t) => positive(t.prepay_amount));
  const linkedIds = new Set((planLine.prepay_term_ids || []).map(String));
  const linked = live.filter((t) => linkedIds.has(String(t.id)));
  if (linked.length === 1) return { term: linked[0], ambiguous: false };
  if (linked.length > 1) return { term: null, ambiguous: true };
  const byFamily = live.filter((t) => familyOfCoverage(t.coverage_service_type) === familyKey);
  if (byFamily.length === 1) return { term: byFamily[0], ambiguous: false };
  if (byFamily.length > 1) return { term: null, ambiguous: true };
  // Terms whose coverage names no family: on a single-line account one such
  // term can only mean this line; otherwise they are unresolved and hold
  // the line. Terms clearly labeled for ANOTHER family never do.
  const unlabeled = live.filter((t) => !familyOfCoverage(t.coverage_service_type));
  if (unlabeled.length === 1 && planLine.account_lines === 1) return { term: unlabeled[0], ambiguous: false };
  return { term: null, ambiguous: unlabeled.length > 0 };
}

// `lane` comes from billing-lane.js#resolveBillingLane — the canonical
// reader: an explicit billing_mode wins; a legacy NULL infers
// monthly_membership for a real WaveGuard tier with dues, else per_visit.
function resolveCurrentRate({ customer, planLine, liveTerms, ledgerSlice }) {
  const lane = resolveBillingLane(customer).mode;
  const prepayLinked = !!planLine.prepay_linked;
  const visitMedianCents = toCents(planLine.median_price);
  const feeCents = toCents(customer.per_application_fee);
  // A line whose open visits are all stamped exactly $0 bills nothing when
  // that zero is authoritative (billing-lane.js hasAuthoritativeZeroPrice:
  // GATE_STAMPED_ZERO_FREE on, or a positive primary_line_price base) — it
  // is a free line, never a fee-fallback candidate for an increase.
  // … and only when EVERY open visit is stamped $0: one discounted-to-zero
  // visit beside NULL-priced ones (which bill the per-application fee,
  // completionInvoiceAmount) is not a free line.
  // … and every zero visit carries the authority ITSELF (counted per visit,
  // never bool_or over the line): with the gate off, a $0 visit without a
  // primary_line_price base bills the fee.
  const zeroVisits = planLine.zero_priced_visits || 0;
  const authoritativeZero = !(visitMedianCents > 0) && zeroVisits > 0 && zeroVisits === planLine.open_visits
    && hasAuthoritativeZeroPrice(0, planLine.zero_with_base_visits === zeroVisits ? 1 : null);
  const fromVisits = () => {
    if (visitMedianCents > 0) return { cents: visitMedianCents, source: 'visit_median', unit: 'application' };
    if (authoritativeZero) return { cents: 0, source: 'stamped_zero', unit: 'application', stampedZeroFree: true };
    // Every priced open visit is composite with an appointment-level discount
    // (rowServicePrice withholds: the application's share of that net is
    // unrecorded) — held as rate_unattributed, never priced off the account fee.
    if ((planLine.withheld_visits || 0) > 0) return { cents: 0, source: 'none', unit: 'application', rateUnattributed: true, compositeWithheld: true };
    if (feeCents > 0) return { cents: feeCents, source: 'per_application_fee', unit: 'application' };
    return { cents: 0, source: 'none', unit: 'application' };
  };

  // The term authority wins over the scalar (facts.js posture): a live term
  // covering this line means it is prepaid mid-term and reprices at renewal
  // only — whatever billing_mode says and whether or not the open visits
  // carry the term id. Resolved BEFORE the lane branch.
  const { term, ambiguous } = matchPrepayTerm(liveTerms, planLine, planLine.family_key);
  if (term) {
    const visits = positive(term.coverage_visit_count) || visitsPerYearFor(planLine.cadence, planLine.catalog_vpy);
    const cents = visits ? Math.round((Number(term.prepay_amount) / visits) * 100) : null;
    if (cents) return { cents, source: 'prepay_term', unit: 'application', prepayMidTerm: true, prepayTermId: term.id };
    return { ...fromVisits(), prepayMidTerm: true, prepayTermId: term.id };
  }
  const prepayLane = lane === 'annual_prepay' || prepayLinked;
  if (prepayLane || ambiguous) {
    // Prepay by scalar or visit link but no resolvable live term — or live
    // terms that could belong to more than one line: held, priced off the
    // visits so the owner still sees numbers.
    return { ...fromVisits(), prepayTermMissing: prepayLane, prepayTermAmbiguous: ambiguous };
  }
  if (lane === 'monthly_membership') {
    if (isEnabled('planRateLedger') && ledgerSlice && positive(ledgerSlice.monthly_rate)) {
      return { cents: toCents(ledgerSlice.monthly_rate), source: 'ledger_slice', unit: 'month' };
    }
    // customers.monthly_rate is the WHOLE account's dues. It can stand in for
    // a family slice only when the account has exactly one plan line; a
    // multi-line account without attribution cannot be priced per line.
    if (positive(customer.monthly_rate) && (planLine.account_lines || 1) === 1) {
      return { cents: toCents(customer.monthly_rate), source: 'monthly_rate', unit: 'month' };
    }
    return { cents: 0, source: 'none', unit: 'month', rateUnattributed: positive(customer.monthly_rate) != null };
  }
  // per_application, per_visit and the legacy NULL lane all bill the visit's
  // own stamp first (completionInvoiceAmount precedence); per_visit / NULL
  // are flagged lane_cleanup by the exception rules.
  return fromVisits();
}

// ── batch build ─────────────────────────────────────────────────────────

// Snapshot identity is (batch, customer, family): a family with open visits
// at TWO cadences (a cadence change that left old-cadence visits open) keeps
// the cadence carrying the most open visits (tie → the sooner next visit)
// and is flagged cadence_conflict — a hold-out, never a guess. Every line
// also learns how many plan lines its account has (monthly fallback and
// prepay matching need it).
function consolidatePlanLines(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const key = `${row.customer_id}|${row.family_key}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  const lines = [];
  for (const group of byKey.values()) {
    const sorted = [...group].sort((a, b) => (b.open_visits - a.open_visits) || String(dateColumn(a.next_visit) || '').localeCompare(String(dateColumn(b.next_visit) || '')));
    const [primary, ...others] = sorted;
    lines.push({
      ...primary,
      cadence_conflict: others.length > 0,
      other_cadences: others.map((o) => o.cadence),
      source_estimate_ids: [...new Set(sorted.flatMap((r) => r.source_estimate_ids || []))],
      prepay_term_ids: [...new Set(sorted.flatMap((r) => r.prepay_term_ids || []))],
      service_keys: [...new Set(sorted.flatMap((r) => r.service_keys || []))],
      prepay_linked: sorted.some((r) => r.prepay_linked),
      zero_priced_visits: sorted.reduce((n, r) => n + (Number(r.zero_priced_visits) || 0), 0),
      zero_with_base_visits: sorted.reduce((n, r) => n + (Number(r.zero_with_base_visits) || 0), 0),
    });
  }
  const linesPerCustomer = new Map();
  for (const line of lines) linesPerCustomer.set(line.customer_id, (linesPerCustomer.get(line.customer_id) || 0) + 1);
  for (const line of lines) line.account_lines = linesPerCustomer.get(line.customer_id);
  return lines;
}

function isBatchKey(value) {
  const m = BATCH_KEY_RE.exec(String(value || ''));
  if (!m) return false;
  const month = Number(String(value).slice(5, 7));
  return month >= 1 && month <= 12;
}

function assertBatchKey(batchKey) {
  if (!isBatchKey(batchKey)) {
    const err = new Error('batchKey must be YYYY-MM with a real month');
    err.status = 400;
    throw err;
  }
}

function assertYmd(value, name) {
  if (value == null) return; // optional
  if (!DATE_RE.test(String(value || '')) || !validCalendarDate(String(value))) {
    const err = new Error(`${name} must be a real calendar date, YYYY-MM-DD`);
    err.status = 400;
    throw err;
  }
}

async function batchHasSentRows(dbh, batchKey) {
  const row = await dbh(SNAPSHOTS).where({ batch_key: batchKey }).whereIn('status', SENT_STATUSES).count({ n: '*' }).first();
  return Number(row && row.n) > 0;
}

// A row whose notice row exists (the apply lane's scheduleNoticeRows wrote
// notice_id) is never deleted by a rebuild either: the FK would orphan its
// draft (SET NULL) and the rebuilt row could never be re-linked
// (notice_event_collision). Retire the drafts first
// (DELETE /api/admin/rate-review/batches/:key/schedule).
async function batchHasScheduledRows(dbh, batchKey) {
  const row = await dbh(SNAPSHOTS).where({ batch_key: batchKey }).whereNotNull('notice_id').count({ n: '*' }).first();
  return Number(row && row.n) > 0;
}

// Every writer on a batch (a build — for its whole recompute —, a row edit,
// an approval, and the apply lane's scheduleNoticeRows / retireDraftNotices
// in services/rate-review-apply.js) takes this transaction-scoped advisory
// lock first, so they serialize even before the batch row exists (a FOR
// UPDATE on a row that is not there locks nothing — two first builds could
// both pass the refusal check), and a draft cannot land between the
// rebuild's refusal check and its DELETE.
async function lockBatch(conn, batchKey) {
  await conn.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`rate_review_batch:${batchKey}`]);
}

// A rebuild discards every undecided row. Once the owner approved rows (or
// the comms lane sent them, or the apply lane drafted their notices) the
// batch is a decision, not a draft — refused, with the reason the route and
// the screen can name.
async function batchRebuildRefusal(dbh, batchKey) {
  if (await batchHasSentRows(dbh, batchKey)) return 'batch_has_sent_rows';
  if (await batchHasScheduledRows(dbh, batchKey)) return 'batch_has_scheduled_rows';
  const row = await dbh(SNAPSHOTS).where({ batch_key: batchKey }).whereIn('status', ['approved']).count({ n: '*' }).first();
  return Number(row && row.n) > 0 ? 'batch_has_approved_rows' : null;
}

// Flags a row carries only because the owner acted on it from the screen.
const OWNER_DECISION_FLAGS = ['admin_edited', 'admin_skipped', 'exception_included'];

// Whether the owner has decided anything on this batch: an approved (or
// since sent) row, or a row edited, skipped or included from the screen.
// Such a batch is never recomputed by the tick's own retry (updateRow /
// approveBatch own those rows).
const DECIDED_STATUSES = ['approved', ...SENT_STATUSES];
async function batchOwnerDecisions(dbh, batchKey) {
  const rows = await dbh(SNAPSHOTS).where({ batch_key: batchKey }).select('status', 'flags');
  const decided = rows.some((r) => DECIDED_STATUSES.includes(r.status) || (parseJson(r.flags) || []).some((flag) => OWNER_DECISION_FLAGS.includes(flag)));
  return { decided, rows: rows.length };
}

async function batchRowsForDigest(dbh, batchKey) {
  return dbh(SNAPSHOTS).where({ batch_key: batchKey }).select('id', 'proposed_rate_cents', 'status');
}

// The build's write: ONE short transaction under the batch advisory lock —
// the lock updateRow and approveBatch take — that judges the refusal and
// the rows' digest again before replacing them. An edit or approval that
// landed since the ranking read the rows changes the digest, and the
// rebuild refuses (batch_changed) rather than discard the owner's decision;
// the build is simply run again. Nothing in here reads the pool: with a
// two-connection pool and the build lease holding one, a pool read inside
// this transaction would wait on itself.
async function commitBatchRows(dbh, { batchKey, expectedDigest, rows, computedAt, batch, preserveOwnerDecisions = false }) {
  const run = async (conn) => {
    await lockBatch(conn, batchKey);
    const refusal = await batchRebuildRefusal(conn, batchKey);
    if (refusal) return { refused: refusal };
    // The tick's retry never replaces a decision of the owner's — judged
    // HERE, under the lock: the monthly lease does not serialize updateRow,
    // so a row edited between the tick's pre-check and the ranking's digest
    // capture is already in that digest and would pass the check below.
    if (preserveOwnerDecisions && (await batchOwnerDecisions(conn, batchKey)).decided) return { refused: 'batch_has_owner_decisions' };
    if (batchDigest(await batchRowsForDigest(conn, batchKey)) !== expectedDigest) return { refused: 'batch_changed' };
    // Literal table names on every WRITER (insert / merge / update): the
    // status-integrity scan in tests/annual-prepay-term-states.test.js fails
    // closed on a mutation chain behind a dynamic table expression. Reads
    // keep the constants.
    await conn('rate_review_batches')
      .insert({ batch_key: batchKey, ...batch, computed_at: computedAt, updated_at: computedAt, email_sent_at: null, email_subject: null })
      .onConflict('batch_key').merge(['window_from', 'window_to', 'allowances', 'config', 'line_rph', 'book_lines', 'computed_at', 'updated_at', 'email_sent_at', 'email_subject']);
    await conn(SNAPSHOTS).where({ batch_key: batchKey }).whereNotIn('status', SENT_STATUSES).delete();
    if (rows.length) {
      await conn('rate_review_snapshots').insert(rows.map((row) => ({ ...row, flags: JSON.stringify(row.flags), computed_at: computedAt, updated_at: computedAt })));
    }
    return { refused: null };
  };
  return dbh.isTransaction ? run(dbh) : dbh.transaction(run);
}

// ── batch stages ────────────────────────────────────────────────────────

// Stage 1 — every input the book needs (parallel where independent).
async function loadBookInputs(dbh, { today, sinceYmd }) {
  const planLines = consolidatePlanLines(await loadActivePlanLines(dbh, { today }));
  const customerIds = [...new Set(planLines.map((p) => p.customer_id))];
  const [customers, firstVisits, completedRows, liveTerms, ledger] = await Promise.all([
    loadCustomers(dbh, customerIds),
    loadFirstCompletedVisits(dbh, customerIds),
    loadCompletedVisitRows(dbh, customerIds, { sinceYmd }),
    loadLiveTerms(dbh, customerIds, { today }),
    loadLedgerSlices(dbh, customerIds),
  ]);
  const monthlyIds = [...customers.values()].filter((c) => resolveBillingLane(c).mode === 'monthly_membership').map((c) => c.id);
  const settledDues = await loadSettledDues(dbh, monthlyIds, { sinceYmd });
  const estimateIds = [...new Set(planLines.flatMap((p) => p.source_estimate_ids || []))];
  const estimates = await loadEstimates(dbh, estimateIds);
  const activeAccounts = await loadAccountActivity(dbh, customerIds, { today });
  const visitsByLine = new Map();
  for (const row of completedRows) {
    const key = `${row.customer_id}|${row.line}`;
    if (!visitsByLine.has(key)) visitsByLine.set(key, []);
    visitsByLine.get(key).push(row);
  }
  // Conversation allowances per line, from the whole book's completed
  // visits — stored on the batch row so every snapshot is reproducible.
  const allowances = computeLineAllowances(completedRows);
  return { planLines, customerIds, customers, firstVisits, visitsByLine, liveTerms, ledger, settledDues, estimates, allowances, activeAccounts };
}

// Stage 2 — one book entry per plan line: current rate per lane, duration /
// revenue stats, list rate by engine replay (newest estimate first).
// get-or-compute on the per-batch replay cache
async function memo(cache, key, compute) {
  if (!cache.has(key)) cache.set(key, await compute());
  return cache.get(key);
}

// Stage 2b — the engine replay for one line. The NEWEST applicable
// estimate that replays at the line's own cadence gives today's list; a
// result whose cadence still does not match the line (a family the replay
// cannot re-cadence) is NOT a list rate — discarded (list_cadence_mismatch),
// and the row falls to the cadence mode or is skipped. Hand-picked-tier
// evidence (tierMoved) compares the estimate's SAVED tier with a replay of
// the mix it was sold with (no reconciliation) — a tier that moved because
// the customer later added or dropped a program is the engine's own doing,
// not a manual pick.
async function replayListForLine(candidates, { familyKey, cadence, activeFamilies, visitsPerYear, monthly, includeRiders, riderAllow, replayCache, deps }) {
  const out = { list: { cents: null, source: 'none', cadenceMismatch: false, engineTier: null }, engineUnavailable: null, listLowConfidence: false, listBundleIncomplete: false };
  const bundleKey = activeFamilies.map((l) => `${l.familyKey}:${l.serviceKeys.join('+')}`).join(',');
  for (const estimate of candidates) {
    if (!hasSizeInput(engineInputsFromEstimate(estimate, deps), familyKey)) continue;
    const replay = await memo(replayCache, `${estimate.id}|${familyKey}|${cadence}|${bundleKey}`, () => replayEstimate(estimate, { familyKey, cadence, activeFamilies }, deps));
    if (!replay) continue;
    if (replay.unavailable) { out.engineUnavailable = replay.unavailable; continue; }
    const rate = listRateFromEngineResult(replay.result, familyKey, cadence, { includeRiders, riderAllow, expectedVisits: visitsPerYear });
    if (!rate) continue;
    if (rate.lowConfidence) { out.listLowConfidence = true; continue; }
    if (rate.bundleIncomplete) { out.listBundleIncomplete = true; continue; }
    const original = await memo(replayCache, `${estimate.id}|original`, () => replayEstimate(estimate, { familyKey: null, cadence: null, activeFamilies: null, soldMix: true }, deps));
    const originalTier = engineTier(original && original.result);
    const estimateTier = tierKey(estimate.waveguard_tier);
    const tierMoved = !!(originalTier && estimateTier && originalTier !== estimateTier);
    if (rate.cadenceMismatch) {
      out.list = { cents: null, source: 'none', cadenceMismatch: true, engineTier: rate.tier, originalTier, estimateTier, tierMoved };
      continue;
    }
    out.list = { cents: monthly ? rate.monthlyCents : rate.perAppCents, source: 'engine', cadenceMismatch: false, engineTier: rate.tier, originalTier, estimateTier, tierMoved };
    break;
  }
  return out;
}

async function assembleBookEntry(inputs, planLine, { config, replayCache, deps }) {
  const { customers, firstVisits, visitsByLine, liveTerms, ledger, settledDues, estimates, allowances, planLines } = inputs;
  const customer = customers.get(planLine.customer_id);
  if (!customer) return null;
  const { family_key: familyKey, cadence } = planLine;
  const serviceKeys = planLine.service_keys || [];
  const ledgerSlice = ledgerSliceForLine(ledger, customer.id, familyKey);
  const current = resolveCurrentRate({ customer, planLine, liveTerms: liveTerms.get(customer.id), ledgerSlice });
  const monthly = current.unit === 'month';
  const visitsPerYear = visitsPerYearFor(cadence, planLine.catalog_vpy);
  const lineVisits = visitsByLine.get(`${customer.id}|${familyKey}`) || [];
  const stats = lineDurationStats(lineVisits, {
    config,
    allowanceMinutes: allowanceFor(allowances, familyKey),
    termVisitsFallback: visitsPerYear,
    duesRevenueCents: monthly
      ? duesPerVisitCents({ settledCents: settledDues.get(customer.id) || 0, ledger, customerId: customer.id, familyKey, accountLines: planLine.account_lines, completedVisits: lineVisits.length })
      : null,
  });
  // Earliest acceptance anchors the anniversary; the NEWEST applicable
  // estimate is replayed first for today's list (updated size / inputs).
  const linkedEstimates = (planLine.source_estimate_ids || []).map((id) => estimates.get(id)).filter(Boolean)
    .sort((a, b) => new Date(a.accepted_at || 0) - new Date(b.accepted_at || 0));
  const acceptedAt = linkedEstimates.length ? linkedEstimates[0].accepted_at : null;
  // the customer's plan lines TODAY, for the current-bundle reconciliation
  const activeFamilies = planLines.filter((p) => p.customer_id === customer.id)
    .map((p) => ({ familyKey: p.family_key, serviceKeys: p.service_keys || [] }))
    .sort((a, b) => a.familyKey.localeCompare(b.familyKey));
  // Dues price the family's whole bundle (the ledger slice's components, or
  // every program the line carries when customers.monthly_rate stood in):
  // the replay must price each of them (list_bundle_incomplete otherwise).
  const bundledDues = monthly && ['ledger_slice', 'monthly_rate'].includes(current.source);
  const replayed = await replayListForLine([...linkedEstimates].reverse(), {
    familyKey, cadence, activeFamilies, visitsPerYear, monthly,
    includeRiders: bundledDues,
    riderAllow: current.source === 'ledger_slice' && ledgerSlice ? ledgerSlice.family_keys : engineKeysForLine(familyKey, serviceKeys),
    replayCache, deps,
  });
  return {
    planLine, customer, familyKey, cadence, visitsPerYear, current, stats,
    first: firstVisits.get(`${customer.id}|${familyKey}`) || null,
    acceptedAt,
    ...replayed,
    multiProgram: !monthly && isMultiProgramLine(familyKey, serviceKeys),
    serviceKeys,
  };
}

// Stage 3 — references across the whole book: revenue/hour quartiles per
// family and the cadence-mode list rate per family × cadence.
// Only an ORDINARY, attributable line is a reference for the others: a
// per_application account priced off its visits / fee, one program per
// row, one cadence. Prepaid lines (discounted term pricing), per_visit /
// one_time / NULL lanes (cleanup), multi-program rows (a blended median),
// cadence conflicts, unclassified families and commercial accounts
// (contract pricing) establish neither another line's list rate nor the
// revenue-per-hour quartiles that nudge it — the same population for both.
function isOrdinaryReference(entry) {
  return entry.current.cents > 0 && entry.current.unit === 'application' && entry.familyKey !== 'other'
    && ['visit_median', 'per_application_fee'].includes(entry.current.source) && !entry.current.prepayMidTerm
    && !entry.multiProgram && !entry.planLine.cadence_conflict
    && !isCommercialCustomer(entry.customer, entry.serviceKeys)
    && resolveBillingLane(entry.customer).mode === 'per_application';
}

function computeLineReferences(book) {
  const modeByGroup = new Map();
  const rphByFamily = new Map();
  for (const entry of book) {
    if (!isOrdinaryReference(entry)) continue;
    const key = `${entry.familyKey}|${entry.cadence}`;
    if (!modeByGroup.has(key)) modeByGroup.set(key, []);
    modeByGroup.get(key).push(entry.current.cents);
    if (entry.stats.revenuePerHourCents == null) continue;
    if (!rphByFamily.has(entry.familyKey)) rphByFamily.set(entry.familyKey, []);
    rphByFamily.get(entry.familyKey).push(entry.stats.revenuePerHourCents);
  }
  const lineRphStats = new Map([...rphByFamily].map(([family, values]) => [family, quartiles(values)]));
  const cadenceModes = new Map();
  for (const [key, values] of modeByGroup) {
    const mode = values.length >= MIN_MODE_SAMPLE ? modeCents(values) : null;
    if (mode) cadenceModes.set(key, mode.value);
  }
  const lineRphJson = Object.fromEntries([...lineRphStats].map(([family, q]) => [family, q]));
  return { lineRphStats, cadenceModes, lineRphJson };
}

// Stage 4 — which entries this batch reviews: an anniversary occurrence in
// the window (the review date), or a carry-forward — the line's latest
// snapshot from an earlier batch ended exception/skipped and its review
// date is at most CARRY_FORWARD_MAX_DAYS_PAST days behind the build and not
// beyond the window. A line with no anniversary at all is listed (flag
// no_anniversary).
// The account's earliest completed visit in the portal, per customer —
// over the COMPLETE completed history (loadFirstCompletedVisits: every
// family, cancelled programs included), never just the active book: a
// cancelled pest program's April visits still date the account's arrival.
function accountFirstVisits(firstVisits, book) {
  const accountFirst = new Map();
  const rows = firstVisits ? [...firstVisits.values()] : book.map((entry) => ({ customer_id: entry.customer.id, first_visit: entry.first && entry.first.first_visit }));
  for (const row of rows) {
    const day = dateColumn(row.first_visit);
    if (day && (!accountFirst.has(row.customer_id) || day < accountFirst.get(row.customer_id))) accountFirst.set(row.customer_id, day);
  }
  return accountFirst;
}

// The occurrence of a line's anniversary this batch reviews: the one inside
// the window, or — for a line an earlier batch (within 90 days) held or
// skipped — that batch's review date, carried forward. A line with no
// anniversary at all is listed (it is held as no_anniversary) unless the
// owner skipped it: that skip holds until the line has an anniversary, when
// the rules below take over. Null = not in this batch.
function reviewOccurrence(entry, latest, { from, to, carryFloor }) {
  // An owner's skip (admin_skipped: Include unticked / Skip this cycle) is a
  // decision for that cycle, not a hold to carry — the line returns at its
  // next anniversary (or a catch-up build), as the screen says. Consecutive
  // windows share their boundary day, so the occurrence the owner skipped is
  // not listed again by the next window either.
  const latestFlags = latest ? (parseJson(latest.flags) || []) : [];
  const ownerSkipped = latestFlags.includes('admin_skipped');
  if (!entry.anniversary.date) return ownerSkipped ? null : { reviewDate: null, carriedFrom: null };
  const inWindow = anniversaryInWindow(entry.anniversary.date, from, to);
  if (inWindow) return ownerSkipped && dateColumn(latest.review_date) === inWindow ? null : { reviewDate: inWindow, carriedFrom: null };
  if (!latest || !CARRY_FORWARD_STATUSES.includes(latest.status) || ownerSkipped) return null;
  // An earlier batch listed the line undated (no_anniversary, review_date
  // NULL). Now that it has a date, that carry has nothing to anchor: the
  // line is reviewed at its anniversary's next occurrence, never at the old
  // batch's computed_at (the apply would trust that as the review date).
  if (latestFlags.includes('no_anniversary') && !dateColumn(latest.review_date)) return null;
  const anchor = dateColumn(latest.review_date) || etDay(latest.computed_at);
  if (!anchor || anchor < carryFloor || anchor > to) return null;
  return { reviewDate: anchor, carriedFrom: latest.batch_key };
}

function selectReviewEntries(book, { from, to, now, latestByLine, firstVisits = null, activeAccounts = new Set() }) {
  const carryFloor = daysAgoYmd(now, CARRY_FORWARD_MAX_DAYS_PAST);
  const accountFirst = accountFirstVisits(firstVisits, book);
  // active PROGRAMS per account: plan lines (account_lines) and, within a
  // consolidated family entry, its service keys — one program means exactly
  // one plan line carrying at most one service key
  const onlyProgramFor = (entry) => Number(entry.planLine && entry.planLine.account_lines) === 1 && (entry.serviceKeys || []).length <= 1;
  const selected = [];
  for (const entry of book) {
    entry.anniversary = resolveAnniversary({
      firstCompletedVisit: firstCompletedVisitFor(entry.first, entry.acceptedAt),
      acceptedAt: entry.acceptedAt,
      // member_since is a DATE; the created_at fallback is an instant.
      memberSince: dateColumn(entry.customer.member_since) || etDay(entry.customer.created_at),
      accountFirstVisit: accountFirst.get(entry.customer.id) || null,
      presenceWindowDays: presenceWindowFor(entry.visitsPerYear),
      accountCreatedAt: entry.customer.created_at,
      onlyActiveFamily: onlyProgramFor(entry),
      accountHasActivity: !!entry.acceptedAt || activeAccounts.has(String(entry.customer.id)),
    });
    const occurrence = reviewOccurrence(entry, latestByLine.get(`${entry.customer.id}|${entry.familyKey}`), { from, to, carryFloor });
    if (!occurrence) continue;
    entry.reviewDate = occurrence.reviewDate;
    entry.carriedFrom = occurrence.carriedFrom;
    // Tenure is measured AT the review date (the anniversary's occurrence in
    // the window, or the carried-forward one), never at build time.
    entry.tenureMonths = entry.anniversary.date && entry.reviewDate ? monthsBetween(entry.anniversary.date, entry.reviewDate) : null;
    selected.push(entry);
  }
  return selected;
}

// Stage 5 — per-customer facts for the selected entries only (facts.js
// fans out ~24 queries per customer; sequential on purpose).
// The facts and signal reads recover from a failed statement (degraded
// evidence holds the line), so they never run on the build transaction:
// PostgreSQL aborts a transaction at its first failed statement and ignores
// everything after it until the rollback, which would turn one degraded
// read into a failed build. They read the committed state on the pool; the
// batch lock, and the prior-review read (which does not recover), stay on
// the transaction.
async function loadReviewFacts(dbh, selected, { now, config, batchKey }) {
  const windowCustomerIds = [...new Set(selected.map((e) => e.customer.id))];
  const priorReviews = await loadPriorReviews(dbh, windowCustomerIds, { batchKey });
  const recoverable = dbh.isTransaction ? db : dbh;
  const factsByCustomer = new Map();
  const signalsByCustomer = new Map();
  for (const customerId of windowCustomerIds) {
    factsByCustomer.set(customerId, await loadFacts(recoverable, customerId, { now }));
    signalsByCustomer.set(customerId, await loadExceptionSignals(recoverable, customerId, { now, config }));
  }
  return { priorReviews, factsByCustomer, signalsByCustomer };
}

// Stage 6 — the snapshot row for one selected entry.
// A failed signal read holds every line (fail closed) — the loader's own
// shape, so one default replaces a per-field 'error' fallback.
const SIGNALS_UNAVAILABLE = Object.freeze({ callbackLines: 'error', cancellationCaseScopes: 'error', retentionOfferFamilies: 'error', planHoldFamilies: 'error' });

// A cancellation case holds the families it names (cancellation_cases.scope;
// [] = the whole account): a lawn-only case holds the lawn review, not pest.
function cancellationCaseTouchesLine(scopes, familyKey) {
  if (scopes === 'error' || !Array.isArray(scopes)) return true;
  return scopes.some((scope) => !Array.isArray(scope) || scope.length === 0 || familySignalTouchesLine(scope, familyKey));
}

// Completed / recent callbacks (loadExceptionSignals callbackLines, by line;
// 'other' = unclassified) and open re-service callbacks (facts
// openCallbackLanes: 'pest' | 'lawn' | 'unknown') hold only the family they
// belong to; a failed read or an unknown lane holds every family.
function callbackHoldsFamily(callbackLines, openLanes, familyKey) {
  if (callbackLines === 'error' || openLanes.includes('unknown')) return true;
  const familyLane = CALLBACK_LANE_FOR_FAMILY[familyKey] || null;
  return callbackLines.some((line) => line === familyKey || line === 'other') || (familyLane != null && openLanes.includes(familyLane));
}

function rankEntry(entry, { refs, reviewFacts, batchKey, today, config, manualEditCutoff }) {
  const { customer, familyKey, cadence, current, stats, list } = entry;
  const { priorReviews, factsByCustomer, signalsByCustomer } = reviewFacts;
  const facts = factsByCustomer.get(customer.id) || null;
  const signals = signalsByCustomer.get(customer.id) || SIGNALS_UNAVAILABLE;
  // No replayable estimate → the book's per-application mode for this
  // family × cadence; a monthly-billed line takes it spread over 12 months
  // (mode × visits ÷ 12) so the two units compare like for like.
  let listCents = list.cents;
  const mode = listCents == null ? refs.cadenceModes.get(`${familyKey}|${cadence}`) : null;
  if (mode) listCents = current.unit === 'month' ? (entry.visitsPerYear > 0 ? Math.round((mode * entry.visitsPerYear) / 12) : null) : mode;
  const listSource = listCents == null ? 'none' : (mode ? 'cadence_mode' : list.source);
  // Hand-picked tier (owner ruling 2026-09-01: call-the-office, permanent):
  // the provenance column says manual, or the accepted estimate carries a
  // tier the engine does not derive from its own inputs (list.tierMoved,
  // replayListForLine). The customer's live tier is deliberately NOT
  // compared — a multi-plan customer's older single-line estimate replays
  // at a lower tier than the account now has.
  const handPickedTier = String(customer.waveguard_tier_source || '').toLowerCase() === 'manual' || (list.source === 'engine' && !!list.tierMoved);
  const manualAt = facts ? etDay(facts.manualPriceOverrideAt) : null;
  const tierProtected = !!(customer.tier_protected_until && dateColumn(customer.tier_protected_until) >= today);
  const openLanes = Array.isArray(facts && facts.openCallbackLanes) ? facts.openCallbackLanes : [];
  const lane = resolveBillingLane(customer);
  const line = {
    batchKey,
    customerId: customer.id,
    familyKey,
    cadence,
    visitsPerYear: entry.visitsPerYear,
    billingLane: lane.mode,
    laneInferred: lane.source === 'inferred',
    anniversaryDate: entry.anniversary.date,
    anniversarySource: entry.anniversary.source,
    anniversaryConflict: entry.anniversary.conflict,
    reviewDate: entry.reviewDate,
    tenureMonths: entry.tenureMonths,
    carriedFrom: entry.carriedFrom,
    engineUnavailable: entry.engineUnavailable,
    listLowConfidence: entry.listLowConfidence,
    listBundleIncomplete: entry.listBundleIncomplete,
    multiProgramLine: !!entry.multiProgram,
    currentRateCents: current.cents,
    currentRateSource: current.source,
    stampedZeroFree: !!current.stampedZeroFree,
    rateUnit: current.unit,
    listRateCents: listCents,
    listRateSource: listSource,
    listCadenceMismatch: list.cadenceMismatch,
    ...stats,
    lineRph: refs.lineRphStats.get(familyKey) || null,
    prepayMidTerm: !!current.prepayMidTerm,
    prepayTermMissing: !!current.prepayTermMissing,
    prepayTermAmbiguous: !!current.prepayTermAmbiguous,
    rateUnattributed: !!current.rateUnattributed,
    compositeWithheld: !!current.compositeWithheld,
    cadenceConflict: !!entry.planLine.cadence_conflict,
    reviewedWithin12mo: priorReviews.has(`${customer.id}|${familyKey}`),
    manualRateEditRecent: !!(manualAt && manualAt >= manualEditCutoff),
    retentionOfferActive: familySignalTouchesLine(signals.retentionOfferFamilies, familyKey),
    planHoldActive: familySignalTouchesLine(signals.planHoldFamilies, familyKey) || tierProtected,
    callbackRecent: callbackHoldsFamily(signals.callbackLines, openLanes, familyKey),
    cancellationCaseRecent: cancellationCaseTouchesLine(signals.cancellationCaseScopes, familyKey),
    handPickedTier,
    commercial: isCommercialCustomer(customer, entry.serviceKeys),
    facts,
  };
  return computeSnapshot(line, config);
}

// The window a build uses: explicit from/to win; otherwise an EXISTING
// batch keeps the window it was built with (a recompute must never drop
// rows by sliding the window to today), and a new batch takes the standing
// review window (35–65 days out) counted from `windowAnchor` when the
// caller names one (the monthly job: the first of the build month) or from
// the build date. An allowed rebuild of a batch whose digest already went
// out resets the one-email marker (digestReset): the rankings the owner
// read are stale, so the next delivery (the day 1–7 tick, or the admin
// build route right away) sends the updated digest instead of
// 'already_emailed' forever.
function assertWindowOrder(from, to) {
  if (from > to) { const err = new Error('anniversaryFrom must not be after anniversaryTo'); err.status = 400; throw err; }
}

function resolveBatchWindow({ existing, anniversaryFrom, anniversaryTo, now, windowAnchor }) {
  const stored = existing ? { from: dateColumn(existing.window_from), to: dateColumn(existing.window_to) } : null;
  const defaults = !(anniversaryFrom && anniversaryTo) && stored && stored.from && stored.to ? stored : reviewWindowFor(now, { anchor: windowAnchor });
  const from = anniversaryFrom || defaults.from;
  const to = anniversaryTo || defaults.to;
  assertWindowOrder(from, to);
  return { from, to, digestReset: !!(existing && existing.email_sent_at) };
}

async function buildBatch({ batchKey, anniversaryFrom, anniversaryTo, windowAnchor = null, trx = null, now = new Date(), deps = {}, preserveOwnerDecisions = false } = {}) {
  if (!rateReviewLive()) return { ok: false, reason: 'gate_off' };
  assertBatchKey(batchKey);
  assertYmd(anniversaryFrom, 'anniversaryFrom');
  assertYmd(anniversaryTo, 'anniversaryTo');
  if (anniversaryFrom && anniversaryTo) assertWindowOrder(anniversaryFrom, anniversaryTo); // before any read

  const dbh = trx || db;
  // A decided batch is never recomputed: refused before any ranking query,
  // and judged again under the batch lock right before the rows are replaced.
  const refusal = await batchRebuildRefusal(dbh, batchKey);
  if (refusal) return { ok: false, reason: refusal, batchKey };

  const existing = await dbh(BATCHES).where({ batch_key: batchKey }).first('window_from', 'window_to', 'email_sent_at');
  const { from, to, digestReset } = resolveBatchWindow({ existing, anniversaryFrom, anniversaryTo, now, windowAnchor });
  // The rows as they stand when the ranking starts. The ranking runs on the
  // pool and pins no connection for its duration (a two-connection pool with
  // the build lease holding one would otherwise wait on itself); an edit or
  // approval that lands while it runs changes this digest, and the write
  // refuses rather than replace rows the owner just decided.
  const before = batchDigest(await batchRowsForDigest(dbh, batchKey));

  const today = etDateString(now);
  const config = await loadConfig(dbh);
  const inputs = await loadBookInputs(dbh, { today, sinceYmd: daysAgoYmd(now, LOOKBACK_DAYS) });
  const { planLines, allowances } = inputs;
  const engineSynced = await syncPricingConstants(deps);
  const replayCache = new Map();
  const book = [];
  for (const planLine of planLines) {
    const entry = await assembleBookEntry(inputs, planLine, { config, replayCache, deps: { ...deps, engineSynced } });
    if (entry) book.push(entry);
  }
  const refs = computeLineReferences(book);
  const { lineRphStats } = refs;
  const latestByLine = await loadLatestSnapshots(dbh, inputs.customerIds, { batchKey });
  const selected = selectReviewEntries(book, { from, to, now, latestByLine, firstVisits: inputs.firstVisits, activeAccounts: inputs.activeAccounts || new Set() });
  const reviewFacts = await loadReviewFacts(dbh, selected, { now, config, batchKey });
  const manualEditCutoff = monthsAgoYmd(now, config.exception_manual_edit_months);
  const rows = selected.map((entry) => rankEntry(entry, { refs, reviewFacts, batchKey, today, config, manualEditCutoff }));

  const computedAt = now;
  const lineRphJson = Object.fromEntries([...lineRphStats].map(([family, q]) => [family, q]));
  const landed = await commitBatchRows(dbh, {
    batchKey, expectedDigest: before, rows, computedAt, preserveOwnerDecisions,
    batch: { window_from: from, window_to: to, allowances: JSON.stringify(allowances), config: JSON.stringify(config), line_rph: JSON.stringify(lineRphJson), book_lines: book.length },
  });
  if (landed.refused) return { ok: false, reason: landed.refused, batchKey };

  const summary = summarizeRows(rows);
  logger.info(`[rate-review] batch ${batchKey} built: ${rows.length} rows (${summary.green} green, ${summary.exception} exceptions, ${summary.no_change} no-change, ${summary.skipped} skipped) from ${book.length} active plan lines`);
  return { ok: true, batchKey, window: { from, to }, rows: rows.length, summary, config, allowances, lineRph: lineRphJson, digestReset };
}

// ── summaries / reads ───────────────────────────────────────────────────

function summarizeRows(rows) {
  const summary = { rows: rows.length, green: 0, no_change: 0, exception: 0, skipped: 0, approved: 0, sent: 0, applied: 0, proposed_annual_delta_cents: 0, green_annual_delta_cents: 0 };
  for (const row of rows) {
    if (summary[row.status] != null) summary[row.status] += 1;
    const annual = Number(row.annual_delta_cents) || 0;
    if (['green', 'approved', 'sent', 'applied'].includes(row.status)) summary.green_annual_delta_cents += annual;
    if (row.status !== 'skipped') summary.proposed_annual_delta_cents += annual;
  }
  return summary;
}

async function summarizeBatch(batchKey, dbh = db) {
  assertBatchKey(batchKey);
  const rows = await dbh(SNAPSHOTS).where({ batch_key: batchKey }).select('status', 'annual_delta_cents');
  return { batchKey, ...summarizeRows(rows) };
}

// The batch row and its rows come from ONE snapshot: under read committed a
// rebuild landing between the two reads would pair the old window/config
// with freshly ranked rows, and the screen would derive review dates from
// the old window. A REPEATABLE READ transaction when called on the pool;
// inside a caller's transaction, that caller's own snapshot.
async function getBatch(batchKey, dbh = db) {
  assertBatchKey(batchKey);
  const read = async (conn) => {
    const batch = await conn(BATCHES).where({ batch_key: batchKey }).first();
    const rows = await conn(`${SNAPSHOTS} as r`)
      .leftJoin('customers as c', 'c.id', 'r.customer_id')
      .where('r.batch_key', batchKey)
      .orderByRaw("CASE r.status WHEN 'green' THEN 0 WHEN 'exception' THEN 1 WHEN 'no_change' THEN 2 ELSE 3 END")
      .orderBy('r.annual_delta_cents', 'desc')
      .select('r.*', 'c.first_name', 'c.last_name', 'c.city');
    return { batch, rows };
  };
  const { batch, rows } = dbh.isTransaction ? await read(dbh) : await dbh.transaction(read, { isolationLevel: 'repeatable read' });
  const shaped = rows.map(shapeSnapshotRow);
  return {
    batchKey,
    batch: batch ? { ...batch, allowances: parseJson(batch.allowances) || {}, config: parseJson(batch.config) || {}, line_rph: parseJson(batch.line_rph) || {} } : null,
    rows: shaped,
    summary: summarizeRows(shaped),
    approvalDigest: batchDigest(shaped),
  };
}

// The admin screen's row: flags parsed, the customer's display name, and
// the DATE columns as calendar days (never an instant the browser would
// shift a day). `review_date` is the anniversary's occurrence the ranking
// stored for this batch (the day the review is about and the notice counts
// back from); a row from before the column falls back to the start date.
function shapeSnapshotRow(r) {
  const anniversary = dateColumn(r.anniversary_date);
  return { ...r, anniversary_date: anniversary, review_date: dateColumn(r.review_date) || anniversary, flags: parseJson(r.flags) || [], customer_name: [r.first_name, r.last_name].filter(Boolean).join(' ') };
}

// The config a batch was ranked with (frozen on rate_review_batches.config)
// — an edit on that batch is judged by the same minimum the ranking used,
// never by a setting changed since. The live row (read BEFORE the edit's
// transaction — never a best-effort statement inside it) only fills a key
// the frozen copy lacks. Pure: no query.
function configForBatch(batchRow, liveConfig) {
  const frozen = batchRow ? parseJson(batchRow.config) : null;
  const config = { ...liveConfig };
  if (!frozen || typeof frozen !== 'object') return config;
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const n = finite(frozen[key]);
    if (n != null && n >= 0) config[key] = n;
  }
  return config;
}

// ── admin edits (Pricing hub → Rate review) ──────────────────────────────
//
// What the screen may change on a snapshot row before the batch is sent: the
// proposed amount (whole dollars, never below the current rate) and whether
// the row is in the batch (green ↔ skipped). An exception row joins only
// with an explicit includeException. Approval stamps green rows 'approved'
// against a digest of the whole batch, so the decision is taken on exactly
// the list the owner saw. None of this sends anything or writes a rate.

const LOCKED_STATUSES = ['approved', 'sent', 'applied'];
const EDITABLE_STATUSES = ['green', 'no_change', 'skipped', 'exception'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COST_BLOCK_CHARS = 4000;
// A proposed amount above this multiple of the current rate is a typo
// ($1,170 for $117), not a review — the bands never move an account that far.
const MAX_PROPOSED_MULTIPLE = 2;

// Stable fingerprint of what the owner approves (`approvalDigest` on the
// batch read — distinct from the batch's owner DIGEST email): every row's
// id, proposed cents and status, order-independent. The approve route
// refuses when the batch moved under the screen (expectedDigest ≠ this).
function batchDigest(rows) {
  const lines = rows.map((r) => `${r.id}:${Number(r.proposed_rate_cents) || 0}:${r.status}`).sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

async function configEditorNames(dbh, ids) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Map();
  try {
    const rows = await dbh('technicians').whereIn('id', wanted).select('id', 'name');
    return new Map(rows.map((r) => [r.id, r.name || null]));
  } catch (err) {
    logger.warn(`[rate-review] config editor lookup failed: ${err.message}`);
    return new Map();
  }
}

// The knobs (loadConfig's numeric view) plus the cost block and who last
// edited — what the admin screen's Settings disclosure and cost-block
// status read.
async function readConfig(dbh = db) {
  const config = await loadConfig(dbh);
  let row = null;
  try {
    row = await dbh(CONFIG).where({ id: 1 }).first();
  } catch (err) {
    logger.warn(`[rate-review] config row read failed: ${err.message}`);
  }
  const names = await configEditorNames(dbh, row ? [row.updated_by, row.cost_block_set_by] : []);
  return {
    ...config,
    cost_block: row && row.cost_block ? String(row.cost_block) : '',
    cost_block_set_at: (row && row.cost_block_set_at) || null,
    cost_block_set_by: (row && row.cost_block_set_by) || null,
    cost_block_set_by_name: row ? names.get(row.cost_block_set_by) || null : null,
    updated_at: (row && row.updated_at) || null,
    updated_by: (row && row.updated_by) || null,
    updated_by_name: row ? names.get(row.updated_by) || null : null,
  };
}

// Every editable setting with its bounds — the one loop below validates
// them all. Percentages keep three decimals; cents and counts are whole
// numbers; the cost block is the owner's plain text.
const CONFIG_RULES = Object.freeze({
  pass_through_pct: { kind: 'number', min: 0, max: 100 },
  band_b_tolerance_pct: { kind: 'number', min: 0, max: 100 },
  band_c_max_pct: { kind: 'number', min: 0, max: 100 },
  cap_pct: { kind: 'number', min: 0, max: 100 },
  cap_cents: { kind: 'integer', min: 0, max: 100000 }, // $1,000 per application
  // A minimum of zero would make an unchanged rate a "change" (delta 0 ≥ 0)
  // and let a band-A row be approved as a notice: at least one cent.
  min_delta_cents: { kind: 'integer', min: 1, max: 100000 },
  // at least one: a zero floor would let the ranking prefer an EMPTY not-home
  // sample over the account's populated home visits (lineDurationStats)
  min_usable_visits: { kind: 'integer', min: 1, max: 100 },
  lock_months: { kind: 'integer', min: 0, max: 120 },
  exception_callback_days: { kind: 'integer', min: 0, max: 3650 },
  exception_manual_edit_months: { kind: 'integer', min: 0, max: 120 },
  cost_block: { kind: 'text', max: MAX_COST_BLOCK_CHARS },
});

// One setting against its rule: the cleaned value, or the message.
function checkSetting(key, rule, raw) {
  if (rule.kind === 'text') {
    if (raw != null && typeof raw !== 'string') return { error: `${key} must be text` };
    const text = String(raw || '').replace(/\r\n/g, '\n').trim();
    return text.length > rule.max ? { error: `${key} must be at most ${rule.max} characters` } : { value: text };
  }
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(n)) return { error: `${key} must be a number` };
  if (rule.kind === 'integer' && !Number.isInteger(n)) return { error: `${key} must be a whole number` };
  if (n < rule.min) return { error: `${key} must be at least ${rule.min}` };
  if (n > rule.max) return { error: `${key} must be at most ${rule.max}` };
  return { value: rule.kind === 'integer' ? n : Math.round(n * 1000) / 1000 };
}

function validateConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { errors: ['Settings must be an object'], clean: {} };
  const errors = [];
  const clean = {};
  for (const [key, raw] of Object.entries(patch)) {
    const checked = CONFIG_RULES[key] ? checkSetting(key, CONFIG_RULES[key], raw) : { error: `${key} is not a rate review setting` };
    if (checked.error) errors.push(checked.error);
    else clean[key] = checked.value;
  }
  return { errors, clean };
}

function auditLog() {
  return require('./audit-log');
}

// PUT /config. Partial: only the keys sent change. Every change lands in one
// audit_log row (critical — a lost audit on a pricing knob fails the save).
// The cost block is the owner's own paragraph: stored verbatim (trimmed),
// never generated, with who set it and when for the screen's status line.
async function updateConfig({ patch, actorId = null, dbh = db } = {}) {
  const { errors, clean } = validateConfigPatch(patch);
  if (errors.length) return { ok: false, reason: 'invalid', errors };
  if (!Object.keys(clean).length) return { ok: false, reason: 'invalid', errors: ['Nothing to change'] };
  // The write transaction holds the write and its audit row only. The
  // display read (readConfig: the row plus best-effort editor names) runs
  // AFTER the commit on the pool — a failed best-effort statement inside the
  // transaction would leave it aborted and roll the valid save back.
  const outcome = await dbh.transaction(async (trx) => {
    const existing = await trx(CONFIG).where({ id: 1 }).forUpdate().first();
    const numericBefore = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const n = existing ? finite(existing[key]) : null;
      numericBefore[key] = n != null && n >= 0 ? n : DEFAULT_CONFIG[key];
    }
    const merged = { ...numericBefore };
    for (const key of Object.keys(DEFAULT_CONFIG)) if (clean[key] != null) merged[key] = clean[key];
    if (merged.band_b_tolerance_pct > merged.band_c_max_pct) {
      return { ok: false, reason: 'invalid', errors: ['Band B tolerance must not exceed the band C maximum'] };
    }
    const now = new Date();
    const changed = {};
    const update = {};
    for (const [key, value] of Object.entries(clean)) {
      if (key === 'cost_block') {
        const before = existing && existing.cost_block ? String(existing.cost_block) : '';
        if (before === value) continue;
        update.cost_block = value || null;
        update.cost_block_set_at = value ? now : null;
        update.cost_block_set_by = value ? actorId : null;
        changed.cost_block = { from_chars: before.length, to_chars: value.length };
      } else {
        if (numericBefore[key] === value) continue;
        update[key] = value;
        changed[key] = { from: numericBefore[key], to: value };
      }
    }
    if (!Object.keys(changed).length) return { ok: true, changed };
    update.updated_at = now;
    update.updated_by = actorId;
    // literal table names on every writer — see the note in buildBatch
    if (existing) await trx('rate_review_config').where({ id: 1 }).update(update);
    else await trx('rate_review_config').insert({ id: 1, ...DEFAULT_CONFIG, ...update, created_at: now });
    await auditLog().recordAuditEvent({
      actor_type: 'technician',
      actor_id: actorId,
      action: 'rate_review.config.update',
      resource_type: 'rate_review_config',
      resource_id: null,
      metadata: { changed },
      critical: true,
      trx,
    });
    return { ok: true, changed };
  });
  if (!outcome.ok) return outcome;
  return { ...outcome, config: await readConfig(dbh) };
}

// Per-application amounts are whole dollars (the plan's rule); a monthly
// line's dues are a whole-dollar per-application amount spread over 12, so
// they legitimately carry cents.
function validateProposedCents(raw, currentCents, { wholeDollars = true } = {}) {
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isInteger(n) || n < 0) return { error: 'proposed_rate_cents must be a whole number of cents', reason: 'proposed_invalid' };
  if (wholeDollars && n % 100 !== 0) return { error: 'Proposed amounts are whole dollars', reason: 'proposed_not_whole_dollars' };
  if (n < currentCents) return { error: 'A proposed amount is never below the current rate', reason: 'proposed_below_current' };
  if (currentCents > 0 && n > currentCents * MAX_PROPOSED_MULTIPLE) return { error: `A proposed amount above ${MAX_PROPOSED_MULTIPLE}× the current rate is refused — check the figure`, reason: 'proposed_too_high' };
  return { cents: n };
}

function rowEditRefusal(row, { includeException, status }) {
  if (!row) return { ok: false, reason: 'row_not_found', error: 'Row not found' };
  if (LOCKED_STATUSES.includes(row.status)) return { ok: false, reason: 'row_locked', error: `This row is already ${row.status} and can no longer be edited.` };
  if (!EDITABLE_STATUSES.includes(row.status)) return { ok: false, reason: 'row_locked', error: `A ${row.status} row cannot be edited.` };
  if (row.status === 'exception' && includeException !== true) return { ok: false, reason: 'row_is_exception', error: 'This row is an exception — include it explicitly to change it.' };
  if (row.status === 'exception' && status == null) return { ok: false, reason: 'status_required', error: 'Say whether the exception joins the batch (green) or is skipped this cycle.' };
  if (!(Number(row.current_rate_cents) > 0)) return { ok: false, reason: 'row_locked', error: 'A row with no current rate cannot be edited.' };
  return null;
}

// The row after an edit — the proposal, its deltas, the status and the flags
// that record how it got there — as one pure rule (the Include and Proposed
// controls on the screen rely on exactly this).
function nextRowState(row, { proposed, status, config }) {
  const current = Number(row.current_rate_cents);
  const monthly = row.rate_unit === 'month';
  const vpy = Number(row.visits_per_year) || 0;
  const delta = proposed - current;
  // A notice needs a real increase: strictly positive AND at least the
  // minimum (which a stored config could, in principle, carry as 0). A
  // monthly line's dues are a whole-dollar per-application amount spread
  // over 12, so the minimum is spread the same way, rounded DOWN — an
  // already-ranked boundary proposal (33¢ a month for $1 per application
  // on a quarterly line) stays green across an Include toggle.
  const minDelta = monthly && vpy > 0 ? Math.floor((config.min_delta_cents * vpy) / 12) : config.min_delta_cents;
  // A per-application line with no visit count (a custom cadence) cannot
  // price a change per year — the ranking's own no_visits_per_year hold.
  const priceable = monthly || vpy > 0;
  const isChange = priceable && delta > 0 && delta >= minDelta;
  // A status-less amount edit keeps the row in or out of the batch as it was.
  const out = status === 'skipped' || (status == null && row.status === 'skipped');
  const flags = new Set(parseJson(row.flags) || []);
  if (proposed !== Number(row.proposed_rate_cents)) flags.add('admin_edited');
  // Included despite a hold: the row the ranking held (status exception), or
  // one it held that the owner skipped and now includes (status skipped, the
  // hold flags still on it) — the marker outlives a skip/include cycle, so a
  // retry's rebuild can never read the inclusion as untouched.
  const held = row.status === 'exception' || [...flags].some((flag) => EXCEPTION_FLAGS.includes(flag));
  if (held && !out) flags.add('exception_included');
  if (!priceable) flags.add('no_visits_per_year');
  // An owner's skip is a decision for this cycle, never a carry-forward hold
  // (selectReviewEntries leaves an admin_skipped line out of the next batch).
  if (out) flags.add('admin_skipped'); else flags.delete('admin_skipped');
  return {
    proposed_rate_cents: proposed,
    delta_cents: delta,
    annual_delta_cents: Math.round(delta * (monthly ? 12 : vpy)),
    status: out ? 'skipped' : (isChange ? 'green' : 'no_change'),
    flags: [...flags],
  };
}

// PUT /batches/:key/rows/:id. Recomputes delta, annual delta and status
// from the (possibly new) proposed amount; the row's band and list rate are
// the ranking's and never change here. Refused once the batch has a sent
// row, on a locked (approved/sent/applied) row, and on an exception row
// without includeException — an exception leaves its hold only by the
// owner's explicit choice, and then must say green or skipped.
async function updateRow({ batchKey, rowId, proposedRateCents, status, includeException = false, actorId = null, dbh = db } = {}) {
  assertBatchKey(batchKey);
  if (!UUID_RE.test(String(rowId || ''))) return { ok: false, reason: 'row_not_found', error: 'Row not found' };
  if (status != null && !['green', 'skipped'].includes(status)) return { ok: false, reason: 'status_invalid', error: 'status must be green or skipped' };
  if (proposedRateCents == null && status == null) return { ok: false, reason: 'nothing_to_change', error: 'Send a proposed amount or a status' };
  // The live config is read on the pool, outside the transaction below: a
  // failed best-effort read inside it would leave the transaction aborted
  // and roll the row update and its audit back.
  const liveConfig = await loadConfig(dbh);
  return dbh.transaction(async (trx) => {
    // The writers' shared lock (a rebuild takes it to judge and replace the
    // rows), so an edit and a recompute's write never interleave.
    await lockBatch(trx, batchKey);
    const batchRow = await trx(BATCHES).where({ batch_key: batchKey }).first();
    if (await batchHasSentRows(trx, batchKey)) return { ok: false, reason: 'batch_has_sent_rows', error: 'This batch already has rows that were sent to customers — it can no longer be edited.' };
    const row = await trx(SNAPSHOTS).where({ id: rowId, batch_key: batchKey }).forUpdate().first();
    const refusal = rowEditRefusal(row, { includeException, status });
    if (refusal) return refusal;
    const checked = proposedRateCents == null
      ? { cents: Number(row.proposed_rate_cents) }
      : validateProposedCents(proposedRateCents, Number(row.current_rate_cents), { wholeDollars: row.rate_unit !== 'month' });
    if (checked.error) return { ok: false, reason: checked.reason, error: checked.error };
    // A line without a visit count cannot price a change per year (the
    // ranking holds it at no change): an amount above the current rate is
    // refused rather than approved as a green row worth $0 a year.
    if (row.rate_unit !== 'month' && !(Number(row.visits_per_year) > 0) && checked.cents > Number(row.current_rate_cents)) {
      return { ok: false, reason: 'no_visits_per_year', error: 'This line has no visit count, so a change cannot be priced per year — it stays at no change until its cadence is known.' };
    }
    const next = nextRowState(row, { proposed: checked.cents, status, config: configForBatch(batchRow, liveConfig) });

    const now = new Date();
    // literal table name on the writer — see the note in buildBatch
    await trx('rate_review_snapshots').where({ id: row.id }).update({ ...next, flags: JSON.stringify(next.flags), updated_at: now });
    await auditLog().recordAuditEvent({
      actor_type: 'technician',
      actor_id: actorId,
      action: 'rate_review.row.update',
      resource_type: 'rate_review_snapshot',
      resource_id: row.id,
      metadata: {
        batch_key: batchKey,
        from: { proposed_rate_cents: Number(row.proposed_rate_cents), status: row.status },
        to: { proposed_rate_cents: next.proposed_rate_cents, status: next.status },
        include_exception: row.status === 'exception',
      },
      critical: true,
      trx,
    });
    const updated = await trx(`${SNAPSHOTS} as r`).leftJoin('customers as c', 'c.id', 'r.customer_id').where('r.id', row.id).select('r.*', 'c.first_name', 'c.last_name', 'c.city').first();
    const batchRows = await trx(SNAPSHOTS).where({ batch_key: batchKey }).select('id', 'proposed_rate_cents', 'status', 'annual_delta_cents');
    return { ok: true, row: shapeSnapshotRow(updated), summary: summarizeRows(batchRows), approvalDigest: batchDigest(batchRows) };
  });
}

// POST /batches/:key/approve. Marks every green row 'approved' and stamps
// who/when on the rows and the batch, against expectedDigest. NO sending
// here: the comms lane reads 'approved' rows. Exceptions, skipped and
// no-change rows are untouched.
async function approveBatch({ batchKey, expectedDigest, actorId = null, dbh = db } = {}) {
  assertBatchKey(batchKey);
  if (typeof expectedDigest !== 'string' || !expectedDigest.trim()) return { ok: false, reason: 'digest_required', error: 'expectedDigest is required' };
  return dbh.transaction(async (trx) => {
    await lockBatch(trx, batchKey); // the writers' shared lock (see updateRow)
    const rows = await trx(SNAPSHOTS).where({ batch_key: batchKey }).forUpdate().select('id', 'proposed_rate_cents', 'status', 'annual_delta_cents');
    if (!rows.length) return { ok: false, reason: 'batch_not_found', error: 'Batch not found' };
    if (rows.some((r) => SENT_STATUSES.includes(r.status))) return { ok: false, reason: 'batch_has_sent_rows', error: 'This batch already has rows that were sent to customers.' };
    const digest = batchDigest(rows);
    if (digest !== expectedDigest.trim()) return { ok: false, reason: 'digest_mismatch', error: 'The batch changed since this screen loaded — review it again before approving.', approvalDigest: digest };
    const green = rows.filter((r) => r.status === 'green');
    if (!green.length) return { ok: false, reason: 'nothing_to_approve', error: 'No green rows to approve.', approvalDigest: digest };
    const now = new Date();
    const annualDeltaCents = green.reduce((sum, r) => sum + (Number(r.annual_delta_cents) || 0), 0);
    // literal table names on the writers — see the note in buildBatch
    await trx('rate_review_snapshots').whereIn('id', green.map((r) => r.id)).update({ status: 'approved', approved_at: now, approved_by: actorId, updated_at: now });
    await trx('rate_review_batches').where({ batch_key: batchKey }).update({ approved_at: now, approved_by: actorId, approval_digest: digest, updated_at: now });
    await auditLog().recordAuditEvent({
      actor_type: 'technician',
      actor_id: actorId,
      action: 'rate_review.batch.approve',
      resource_type: 'rate_review_batch',
      resource_id: null,
      metadata: { batch_key: batchKey, digest, approved: green.length, annual_delta_cents: annualDeltaCents },
      critical: true,
      trx,
    });
    const after = rows.map((r) => (r.status === 'green' ? { ...r, status: 'approved' } : r));
    return { ok: true, approved: green.length, annual_delta_cents: annualDeltaCents, approved_at: now, approvalDigest: batchDigest(after), summary: summarizeRows(after) };
  });
}

async function listBatches(dbh = db) {
  const batches = await dbh(BATCHES).select('*').orderBy('batch_key', 'desc');
  const statusRows = await dbh(SNAPSHOTS)
    .select('batch_key', 'status')
    .count({ n: '*' })
    .sum({ annual_delta_cents: 'annual_delta_cents' })
    .groupBy('batch_key', 'status');
  const byKey = new Map();
  for (const r of statusRows) {
    if (!byKey.has(r.batch_key)) byKey.set(r.batch_key, { statuses: {}, rows: 0, proposed_annual_delta_cents: 0, green_annual_delta_cents: 0 });
    const agg = byKey.get(r.batch_key);
    agg.statuses[r.status] = Number(r.n);
    agg.rows += Number(r.n);
    const annual = Number(r.annual_delta_cents) || 0;
    if (r.status !== 'skipped') agg.proposed_annual_delta_cents += annual;
    if (REVIEWED_STATUSES.includes(r.status)) agg.green_annual_delta_cents += annual;
  }
  return batches.map((b) => ({
    batch_key: b.batch_key,
    window_from: dateColumn(b.window_from),
    window_to: dateColumn(b.window_to),
    computed_at: b.computed_at,
    email_sent_at: b.email_sent_at,
    book_lines: b.book_lines,
    allowances: parseJson(b.allowances) || {},
    ...(byKey.get(b.batch_key) || { statuses: {}, rows: 0, proposed_annual_delta_cents: 0, green_annual_delta_cents: 0 }),
  }));
}

// ── monthly job + ops email ─────────────────────────────────────────────

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dollars(cents) {
  const n = (Number(cents) || 0) / 100;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function monthLabel(batchKey) {
  const [y, m] = batchKey.split('-').map(Number);
  return `${MONTH_NAMES[m - 1] || batchKey} ${y}`;
}

const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

// One email per batch. Names are fine here (owner's inbox); ids never
// leave the row. ACT: when there is anything to decide (green or
// exception), OK: when the batch holds nothing to act on.
function windowLabel(batch) {
  const from = batch && dateColumn(batch.window_from);
  const to = batch && dateColumn(batch.window_to);
  if (!from || !to) return null;
  const fmt = (ymd) => { const { m, d } = ymdParts(ymd); return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}`; };
  return `anniversaries ${fmt(from)} – ${fmt(to)}`;
}

function composeBatchEmail({ batchKey, rows, summary, batch = null }) {
  const window = windowLabel(batch);
  const label = window ? `${monthLabel(batchKey)} batch (${window})` : `${monthLabel(batchKey)} batch`;
  const decide = summary.green + summary.exception;
  const sumAnnual = (list) => list.reduce((total, r) => total + (Number(r.annual_delta_cents) || 0), 0);
  const green = rows.filter((r) => r.status === 'green');
  const approved = rows.filter((r) => r.status === 'approved');
  const sentRows = rows.filter((r) => SENT_STATUSES.includes(r.status));
  // Pending proposals (green) and decisions already taken (approved) are
  // separate money: the subject and the "if all approved" figure are green
  // only; approved rows carry their own total and section.
  const greenDollars = dollars(sumAnnual(green));
  const approvedDollars = dollars(sumAnnual(approved));
  const approvedNote = approved.length ? `, ${approved.length} approved (+${approvedDollars}/yr, waiting to send)` : '';
  const subject = decide > 0
    ? `ACT: Rate review — ${label} · ${summary.green} green · ${summary.exception} exception${summary.exception === 1 ? '' : 's'} · +${greenDollars}/yr`
    : `OK: Rate review — ${label}: nothing to decide (${approved.length ? `${approved.length} approved, ` : ''}${summary.no_change} no-change, ${summary.skipped} skipped)`;
  const link = `${adminPortalUrl()}/admin/pricing-logic?area=rate-review&batch=${batchKey}`;
  const unitFor = (row) => (row.rate_unit === 'month' ? '/mo' : '/application');
  const describe = (row) => {
    const name = row.customer_name || row.customer_id;
    const move = row.delta_cents > 0
      ? `${dollars(row.current_rate_cents)} → ${dollars(row.proposed_rate_cents)}${unitFor(row)} (+${dollars(row.delta_cents)}, +${dollars(row.annual_delta_cents)}/yr)`
      : `${dollars(row.current_rate_cents)}${unitFor(row)} (no change)`;
    const list = row.list_rate_cents != null ? ` · list ${dollars(row.list_rate_cents)} (${row.list_rate_source})` : ' · no list rate';
    const rph = row.revenue_per_hour_cents != null
      ? ` · ${dollars(row.revenue_per_hour_cents)}/hr on ${row.rph_from_not_home ? `${row.not_home_visits} not-home` : row.usable_visits} visits`
      : '';
    const flags = row.flags && row.flags.length ? ` · ${row.flags.join(', ')}` : '';
    return `${name} — ${row.family_key.replace(/_/g, ' ')} ${row.cadence.replace(/_/g, ' ')} · band ${row.band || '—'} · ${move}${list}${rph}${flags}`;
  };
  const section = (title, list) => (list.length ? [`${title} (${list.length})`, ...list.map((r) => `- ${describe(r)}`), ''] : []);
  const exceptions = rows.filter((r) => r.status === 'exception');
  const noChange = rows.filter((r) => r.status === 'no_change');
  const skipped = rows.filter((r) => r.status === 'skipped');
  const standing = sentRows.length
    ? 'The sent rows are already with their customers; nothing else has gone out and no other rate has changed.'
    : 'Nothing has been sent to a customer and no rate has changed; this is the ranking only.';
  const carried = rows.filter((r) => Array.isArray(r.flags) && r.flags.includes('carried_forward')).length;
  const intro = `Rate review ${label}: ${summary.rows} plan line${summary.rows === 1 ? '' : 's'} with an anniversary in the window${carried ? ` (${carried} carried forward from an earlier batch)` : ''} — ${summary.green} green (+${greenDollars}/yr if all approved)${approvedNote}, ${summary.exception} held out as exceptions, ${summary.no_change} no change, ${summary.skipped} skipped. ${standing}`;
  const text = [intro, '', ...section('GREEN — proposed increases', green), ...section('APPROVED — waiting to send', approved), ...section('EXCEPTIONS — held out, your call', exceptions), ...section('NO CHANGE', noChange), ...section('SKIPPED — could not be priced', skipped), ...section('SENT — notices out', sentRows), `Review: ${link}`].join('\n');
  const htmlSection = (title, list) => (list.length
    ? `<p><strong>${esc(title)} (${list.length})</strong></p><ul style="margin:0 0 12px 18px;padding:0;">${list.map((r) => `<li style="margin:0 0 6px 0;">${esc(describe(r))}</li>`).join('')}</ul>`
    : '');
  const html = [
    `<p>${esc(intro)}</p>`,
    htmlSection('GREEN — proposed increases', green),
    htmlSection('APPROVED — waiting to send', approved),
    htmlSection('EXCEPTIONS — held out, your call', exceptions),
    htmlSection('NO CHANGE', noChange),
    htmlSection('SKIPPED — could not be priced', skipped),
    htmlSection('SENT — notices out', sentRows),
    `<p><a href="${esc(link)}">Open the rate review batch</a></p>`,
  ].join('\n');
  const approvedHeadline = approved.length ? `, ${approved.length} approved` : '';
  const headline = decide > 0 ? `Rate review — ${monthLabel(batchKey)}: ${summary.green} green, ${summary.exception} exceptions${approvedHeadline}` : `Rate review — ${monthLabel(batchKey)}: nothing to decide${approvedHeadline}`;
  const summaryLine = decide > 0
    ? `+${greenDollars}/yr proposed across ${summary.green} accounts; ${summary.exception} need a look.${approved.length ? ` ${approved.length} approved (+${approvedDollars}/yr) wait to send.` : ''}`
    : `${summary.rows} lines ranked, none need a decision.${approved.length ? ` ${approved.length} approved (+${approvedDollars}/yr) wait to send.` : ''}`;
  const itemKeys = rows.map((r) => `${r.customer_id}:${r.family_key}:${r.status}`);
  return { subject, text, html, headline, summary: summaryLine, link: `/admin/pricing-logic?area=rate-review&batch=${batchKey}`, itemKeys, decide };
}

// One email per batch: the marker lives on the batch row itself.
async function alreadyEmailed(dbh, batchKey) {
  const row = await dbh(BATCHES).where({ batch_key: batchKey }).first('email_sent_at');
  return !!(row && row.email_sent_at);
}

// The stamp names the batch VERSION the digest described (computed_at, set
// by buildBatch and replaced on every rebuild): a rebuild that lands
// between composing and stamping updates no row, email_sent_at stays
// null, and the next delivery (the day 1–7 tick, or the admin route) sends
// the rebuilt rankings — the owner is never told a batch is delivered when
// the digest described an older one. The admin build also runs under the
// tick's own lock (routes/admin-rate-review.js), so the two entry points
// never interleave in the first place.
async function stampEmailed(dbh, batchKey, subject, computedAt) {
  // literal table name — see the writer note in buildBatch
  const stamped = await dbh('rate_review_batches')
    .where({ batch_key: batchKey })
    .where('computed_at', computedAt)
    .update({ email_sent_at: new Date(), email_subject: subject, updated_at: new Date() });
  return Number(stamped) > 0;
}

// The one-email marker, for callers outside this module (the admin digest route).
function batchEmailed(batchKey, dbh = db) {
  return alreadyEmailed(dbh, batchKey);
}

async function sendBatchEmail({ batchKey, dbh = db, mailer = null }) {
  const sendgrid = mailer || require('./sendgrid-mail');
  const { deliverOpsDigest } = require('./ops-digest');
  const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');
  const batch = await getBatch(batchKey, dbh);
  if (!batch.batch || !batch.batch.computed_at) return { sent: false, skipped: 'no_batch' };
  const version = batch.batch.computed_at;
  const composed = composeBatchEmail(batch);
  if (typeof sendgrid.isConfigured === 'function' && !sendgrid.isConfigured()) {
    logger.warn('[rate-review] mailer not configured — skipping batch email');
    return { sent: false, skipped: 'unconfigured', subject: composed.subject };
  }
  // FAIL CLOSED: owner/internal inboxes only — the body names customers.
  const to = process.env.RATE_REVIEW_DIGEST_EMAIL || 'contact@wavespestcontrol.com';
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[rate-review] recipient is not an internal address — skipping batch email; set a valid RATE_REVIEW_DIGEST_EMAIL');
    return { sent: false, skipped: 'recipient', subject: composed.subject };
  }
  const delivered = await deliverOpsDigest({
    key: 'rate-review',
    subject: composed.subject,
    html: composed.html,
    text: composed.text,
    headline: composed.headline,
    summary: composed.summary,
    count: batch.summary.rows,
    itemKeys: composed.itemKeys,
    link: composed.link,
    sendEmail: () => sendgrid.sendOne({
      to,
      fromEmail: process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com',
      fromName: process.env.SENDGRID_FROM_NAME || 'Waves Pest Control',
      subject: composed.subject,
      html: composed.html,
      text: composed.text,
      categories: ['ops', 'rate-review'],
      suppressErrorLog: true,
    }),
  });
  const stamped = await stampEmailed(dbh, batchKey, composed.subject, version);
  if (!stamped) logger.warn(`[rate-review] digest for ${batchKey} described a version the batch no longer has — not stamped; the rebuilt rankings go out on the next delivery`);
  // deliverOpsDigest records an in-app bell row and skips the email when the
  // ops digests run in-app; the screen tells the owner which one happened.
  const channel = delivered && delivered.channel === 'in_app' ? 'in_app' : 'email';
  return { sent: true, stamped, channel, subject: composed.subject, rows: batch.summary.rows };
}

// Scheduler entry (1st of the month): build the batch for anniversaries in
// the FOLLOWING month and email it once. Gate read first — off = return
// before any query. A batch with sent rows is never rebuilt.
// The tick's batch. No explicit window: buildBatch keeps an EXISTING batch's
// stored window; a NEW batch (a day-1 build, or a retry after a day-1 build
// that failed before persisting) is anchored on the first of the build
// month, so every tick of the month covers the same anniversaries. A retry
// (the digest did not go out) rebuilds the unsent batch only while it
// carries no decision of the owner's: once a row was edited, skipped,
// included or approved from the screen, the batch stands and only the
// delivery is retried — judged before the ranking (its cost is skipped) and
// again under the commit lock (a decision can land while it runs).
// A rebuild refused under the commit lock for a decision of the owner's — an
// edit, skip or inclusion (batch_has_owner_decisions), or an approval or a
// send that landed while the ranking ran — leaves the batch standing: the
// tick delivers it as it is.
const STANDING_REFUSALS = ['batch_has_owner_decisions', 'batch_has_approved_rows', 'batch_has_sent_rows'];
async function tickBatch(dbh, batchKey, { now, deps }) {
  const standing = await batchOwnerDecisions(dbh, batchKey);
  if (standing.decided) return { ok: true, batchKey, rows: standing.rows, rebuilt: false };
  const built = await buildBatch({ batchKey, windowAnchor: `${batchKey}-01`, now, deps, preserveOwnerDecisions: true });
  if (built.ok || !STANDING_REFUSALS.includes(built.reason)) return { ...built, rebuilt: true };
  const decided = await batchOwnerDecisions(dbh, batchKey);
  return { ok: true, batchKey, rows: decided.rows, rebuilt: false };
}

async function runMonthlyRateReview({ now = new Date(), dbh = db, mailer = null, deps = {} } = {}) {
  if (!rateReviewLive()) return { skipped: 'gate_off' };
  // batch_key = the BUILD month. A batch already emailed is finished for
  // the month — a retried tick must not rebuild it (and slide its window).
  const batchKey = etMonthStart(now, 0).slice(0, 7);
  if (await alreadyEmailed(dbh, batchKey)) return { skipped: 'already_emailed', batchKey, emailed: false };
  const built = await tickBatch(dbh, batchKey, { now, deps });
  if (!built.ok) {
    logger.warn(`[rate-review] monthly build skipped for ${batchKey}: ${built.reason}`);
    return { skipped: built.reason, batchKey };
  }
  if (!built.rebuilt) logger.info(`[rate-review] ${batchKey} carries owner decisions — delivery retried without a rebuild`);
  // The batch is persisted either way. A delivery failure is RE-THROWN so
  // runExclusive records the job as failed (job_health) instead of a quiet
  // success with email_sent_at still null; the tick runs on days 1–7 and is
  // idempotent (an emailed batch is skipped above, an unsent one rebuilds
  // inside its stored window), so the digest is retried the next morning.
  let email;
  try {
    email = await sendBatchEmail({ batchKey, dbh, mailer });
  } catch (err) {
    // The provider's message can carry its raw response body (which can hold
    // email addresses — PII never goes to logs): log and re-throw a status-
    // only error, so the scheduler's generic catch prints nothing else.
    const status = Number.isInteger(err && err.status) ? err.status : 'network';
    logger.error(`[rate-review] batch email failed for ${batchKey} (status ${status}) — batch persisted, delivery will retry`);
    const sanitized = new Error(`rate review digest delivery failed for ${batchKey} (status ${status})`);
    sanitized.status = err && err.status;
    sanitized.code = 'RATE_REVIEW_DIGEST_DELIVERY_FAILED';
    throw sanitized;
  }
  // A digest the tick could not deliver (mailer unconfigured, recipient not
  // an internal address) is a FAILED tick too — never a healthy job_health
  // row for a month nobody was told about; the day 1–7 ticks retry, the
  // batch stays persisted. Manual callers (the admin route) see the skip.
  if (!email.sent) {
    logger.error(`[rate-review] digest for ${batchKey} not delivered (${email.skipped}) — batch persisted, delivery will retry`);
    const undelivered = new Error(`rate review digest not delivered for ${batchKey} (${email.skipped})`);
    undelivered.code = 'RATE_REVIEW_DIGEST_NOT_DELIVERED';
    undelivered.skipped = email.skipped;
    throw undelivered;
  }
  return { ...built, emailed: true, email };
}

module.exports = {
  DEFAULT_CONFIG,
  EXCEPTION_FLAGS,
  // The plan-line classification (line, cadence, recurring) and the
  // anniversary / coverage helpers, shared with the apply lane
  // (services/rate-review-apply.js) so a notice targets exactly the visits
  // this ranking priced.
  PLAN_LINE_SQL: { LINE_SQL, CADENCE_SQL, PLAN_ROW_SQL, DATING_ROW_SQL },
  lockBatch,
  LEDGER_FAMILIES_FOR_LINE,
  anniversaryInWindow,
  familyOfCoverage,
  matchPrepayTerm,
  visitsPerYearFor,
  buildBatch,
  summarizeBatch,
  getBatch,
  listBatches,
  loadConfig,
  readConfig,
  updateConfig,
  updateRow,
  approveBatch,
  batchDigest,
  runMonthlyRateReview,
  sendBatchEmail,
  batchEmailed,
  composeBatchEmail,
  _private: {
    loadReviewFacts,
    batchOwnerDecisions,
    commitBatchRows,
    batchRowsForDigest,
    soldPosturePins,
    COMBINED_CATALOG_SQL,
    RETIRED_COMBINED_CATALOG_KEYS,
    accountFirstVisits,
    presenceWindowFor,
    IMPORT_PRESENCE_DAYS,
    SOLD_POSTURE_KEYS,
    computeLineReferences,
    isOrdinaryReference,
    cancellationCaseTouchesLine,
    engineKeysForLine,
    replayEstimate,
    REFUND_BASE_SQL,
    engineItemVisits,
    depositCreditSql,
    familySignalTouchesLine,
    isMultiProgramLine,
    trimmedMedian, median, quartiles, modeCents, monthsBetween, monthsAgoYmd, monthKeyMinus, anniversaryInWindow, reviewWindowFor, dateColumn, etDay,
    isBatchKey, assertBatchKey, assertYmd, firstCompletedVisitFor, selectReviewEntries, loadLatestSnapshots, engineItemLowConfidence, windowLabel, syncPricingConstants, daysAgoYmd, qualifyingKeyForLine,
    PLAN_ROW_SQL, DATING_ROW_SQL, LIVE_STATUS_SQL, isImportedAccount, IMPORTED_ACCOUNT_LEAD_DAYS, informationalFlags, loadAccountActivity, reviewOccurrence,
    CARRY_FORWARD_STATUSES, CARRY_FORWARD_MAX_DAYS_PAST, REVIEW_WINDOW_FROM_DAYS, REVIEW_WINDOW_TO_DAYS, CALLBACK_LANE_FOR_FAMILY,
    visitsPerYearFor,
    conversationMinutesFor, interactionFor, wallMinutesFor, treatmentMinutesFor, computeLineAllowances, allowanceFor, lineDurationStats, visitRevenueCents,
    gapPct, classifyBand, nudgeBand, evaluateExceptions, computeSnapshot, summarizeRows, validateConfigPatch, validateProposedCents, nextRowState,
    resolveAnniversary, resolveCurrentRate, matchPrepayTerm, familyOfCoverage, consolidatePlanLines, hasSizeInput, listReplayInputs, listRateFromEngineResult, isCommercialCustomer, engineInputsFromEstimate,
    loadActivePlanLines, loadFirstCompletedVisits, loadCompletedVisitRows, loadExceptionSignals, loadPriorReviews, loadLedgerSlices, ledgerSliceForLine, loadEstimates, loadCustomers,
    loadSettledDues, duesPerVisitCents,
    LEDGER_FAMILIES_FOR_LINE,
    MAX_USABLE_MINUTES, MIN_TREATMENT_MINUTES, MAX_ALLOWANCE_MINUTES, MIN_LINE_RPH_SAMPLE, CADENCE_VISITS, CONVERSATION_MINUTES_KEYS, INTERACTION_HOME, INTERACTION_NOT_HOME,
  },
};
