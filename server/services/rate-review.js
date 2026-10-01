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

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, etParts, etMonthStart, etMonthEnd } = require('../utils/datetime-et');
const { rateReviewLive, isEnabled } = require('../config/feature-gates');
const { resolveActualMinutes } = require('./pricing-reality-check');
const { INVOICE_UNCOLLECTIBLE_STATUSES } = require('./invoice-helpers');
const { normalizePropertyType } = require('./pricing-engine/commercial-helpers');
const { hasAuthoritativeZeroPrice } = require('./billing-lane');

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
  tree_shrub: ['tree_shrub'],
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

function monthsBetween(fromYmd, toYmd) {
  const a = ymdParts(fromYmd);
  const b = ymdParts(toYmd);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months -= 1;
  return Math.max(0, months);
}

// ET-calendar date N months before `now`, as YYYY-MM-DD (day clamped by
// Date.UTC overflow rules — the 31st minus one month lands on the 1st of
// the following month, which is the stricter side for a lookback).
function monthsAgoYmd(now, months) {
  const { year, month, day } = etParts(now);
  const d = new Date(Date.UTC(year, month - 1 - months, day));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function daysAgoYmd(now, days) {
  return etDateString(new Date(now.getTime() - days * DAY_MS));
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

function visitsPerYearFor(cadence, catalogVisitsPerYear) {
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

function visitRevenueCents(row) {
  const paid = positive(row.paid_revenue);
  if (paid != null) return Math.round(paid * 100);
  if (row.annual_prepay_term_id) {
    const prepaid = positive(row.prepaid_amount);
    if (prepaid != null) return Math.round(prepaid * 100);
    const term = positive(row.term_prepay_amount);
    const visits = positive(row.term_visit_count);
    if (term != null && visits != null) return Math.round((term / visits) * 100);
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
// `duesRevenueCents`: for a monthly-billed line, the family's settled dues
// attributed to each application (slice × 12 ÷ visits per year) — monthly
// members pay at account level, so their visits carry no invoice of their
// own. Used only for a visit with no paired revenue; flagged rph_from_dues.
function lineDurationStats(visitRows, { config = DEFAULT_CONFIG, allowanceMinutes = 0, duesRevenueCents = null } = {}) {
  const usable = [];
  let duesAttributed = 0;
  for (const row of visitRows || []) {
    const t = treatmentMinutesFor(row, allowanceMinutes);
    if (!t) continue;
    let revenueCents = visitRevenueCents(row);
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

const EXCEPTION_FLAGS = Object.freeze([
  'tenure_under_lock', 'prepay_mid_term', 'prepay_term_missing', 'reviewed_within_12mo', 'manual_rate_edit_recent',
  'retention_offer_active', 'plan_hold_active', 'callback_recent', 'cancellation_case_recent', 'complaint_open',
  'past_due', 'hand_picked_tier', 'commercial', 'termite_program', 'multi_property', 'lane_cleanup', 'cadence_conflict',
  'prepay_term_ambiguous', 'rate_unattributed', 'facts_unavailable', 'facts_degraded', 'no_anniversary', 'no_current_rate',
]);

function evaluateExceptions(line, config = DEFAULT_CONFIG) {
  const flags = [];
  const f = line.facts || null;
  if (!line.anniversaryDate) flags.push('no_anniversary');
  else if (line.tenureMonths != null && line.tenureMonths < config.lock_months) flags.push('tenure_under_lock');
  if (line.prepayMidTerm) flags.push('prepay_mid_term');
  if (line.prepayTermMissing) flags.push('prepay_term_missing');
  if (line.prepayTermAmbiguous) flags.push('prepay_term_ambiguous');
  if (line.rateUnattributed) flags.push('rate_unattributed');
  if (line.cadenceConflict) flags.push('cadence_conflict');
  if (line.reviewedWithin12mo) flags.push('reviewed_within_12mo');
  if (line.manualRateEditRecent) flags.push('manual_rate_edit_recent');
  if (line.retentionOfferActive) flags.push('retention_offer_active');
  if (line.planHoldActive) flags.push('plan_hold_active');
  if (line.callbackRecent) flags.push('callback_recent');
  if (line.cancellationCaseRecent) flags.push('cancellation_case_recent');
  if (f && f.openComplaint) flags.push('complaint_open');
  if (f && f.accountCurrent === false) flags.push('past_due');
  if (line.handPickedTier) flags.push('hand_picked_tier');
  if (line.commercial) flags.push('commercial');
  if (line.familyKey === 'termite' || (f && f.termiteRental)) flags.push('termite_program');
  if (f && f.multiProperty) flags.push('multi_property');
  if (line.billingLane === 'per_visit' || line.billingLane == null) flags.push('lane_cleanup');
  if (!f) flags.push('facts_unavailable');
  else if (f.moneyFactsDegraded) flags.push('facts_degraded');
  return flags;
}

// ── snapshot assembly (pure) ────────────────────────────────────────────

function computeSnapshot(line, config = DEFAULT_CONFIG) {
  const exceptions = evaluateExceptions(line, config);
  const flags = [...exceptions];
  if (line.listRateSource === 'cadence_mode') flags.push('list_from_cadence_mode');
  if (line.listCadenceMismatch) flags.push('list_cadence_mismatch');
  if (line.anniversaryConflict) flags.push('anniversary_predates_portal');
  if (line.stampedZeroFree) flags.push('stamped_zero_free');
  if (line.rphFromNotHome) flags.push('rph_from_not_home_visits');
  if (line.unknownInteractionVisits > 0) flags.push('interaction_unknown');
  if (line.capturedConversationVisits > 0) flags.push('conversation_minutes_captured');
  if (line.duesAttributedVisits > 0) flags.push('rph_from_dues');

  const current = line.currentRateCents || 0;
  const monthlyUnit = line.rateUnit === 'month';
  const vpy = line.visitsPerYear || 0;
  let classified;
  if (current <= 0) {
    classified = { band: null, gapPct: null, proposedCents: 0, deltaCents: 0, noChange: true, flags: ['no_current_rate'] };
  } else if (!monthlyUnit) {
    classified = classifyBand({ currentCents: current, listCents: line.listRateCents, rph: line.revenuePerHourCents, lineRph: line.lineRph, usableVisits: line.usableVisits, config });
  } else if (vpy > 0) {
    // Monthly dues are a cadence's annual price spread over 12 months; the
    // bands, the $ cap and the minimum are PER APPLICATION. Normalize to the
    // per-application equivalent (monthly × 12 ÷ visits), classify there,
    // then spread the whole-dollar per-application proposal back over 12.
    const perAppCurrent = Math.round((current * 12) / vpy);
    const perAppList = line.listRateCents != null ? Math.round((line.listRateCents * 12) / vpy) : null;
    const perApp = classifyBand({ currentCents: perAppCurrent, listCents: perAppList, rph: line.revenuePerHourCents, lineRph: line.lineRph, usableVisits: line.usableVisits, config });
    const proposedMonthly = perApp.noChange ? current : Math.round((perApp.proposedCents * vpy) / 12);
    classified = { ...perApp, proposedCents: proposedMonthly, deltaCents: proposedMonthly - current, perApplication: { current: perAppCurrent, list: perAppList, proposed: perApp.proposedCents, delta: perApp.deltaCents } };
  } else {
    classified = { band: null, gapPct: null, proposedCents: current, deltaCents: 0, noChange: true, flags: ['no_visits_per_year'] };
  }
  for (const flag of classified.flags) if (!flags.includes(flag)) flags.push(flag);

  const unitMultiplier = monthlyUnit ? 12 : vpy;
  let status;
  if (current <= 0 || (classified.band == null && !exceptions.length)) status = 'skipped';
  else if (exceptions.length) status = 'exception';
  else if (classified.noChange) status = 'no_change';
  else status = 'green';

  return {
    batch_key: line.batchKey,
    customer_id: line.customerId,
    family_key: line.familyKey,
    cadence: line.cadence,
    visits_per_year: line.visitsPerYear ?? null,
    billing_lane: line.billingLane ?? null,
    anniversary_date: line.anniversaryDate ?? null,
    anniversary_source: line.anniversarySource ?? null,
    tenure_months: line.tenureMonths ?? null,
    current_rate_cents: current,
    current_rate_source: line.currentRateSource || 'none',
    rate_unit: line.rateUnit || 'application',
    list_rate_cents: line.listRateCents ?? null,
    list_rate_source: line.listRateSource || 'none',
    gap_pct: classified.gapPct,
    usable_visits: line.usableVisits || 0,
    home_visits: line.homeVisits || 0,
    not_home_visits: line.notHomeVisits || 0,
    allowance_minutes_applied: line.allowanceMinutesApplied ?? null,
    rph_from_not_home: !!line.rphFromNotHome,
    treatment_minutes_median: line.treatmentMinutesMedian ?? null,
    revenue_per_hour_cents: line.revenuePerHourCents ?? null,
    band: classified.band,
    proposed_rate_cents: classified.proposedCents,
    delta_cents: classified.deltaCents,
    annual_delta_cents: Math.round(classified.deltaCents * unitMultiplier),
    flags,
    status,
  };
}

// ── anniversary ─────────────────────────────────────────────────────────

// The line's start date. Portal-sold line (its visits link an accepted
// estimate): first completed recurring visit, else the accept date — the
// 12-month lock runs from the first application the customer paid for.
// Imported line (no accepted estimate in the portal): the EARLIER of
// customers.member_since and the first completed visit — the portal went
// live April 2026, so for an imported account the first visit here is a
// lower bound on tenure, not the start (member_since is real back to 2024;
// prod pre-read 2026-09-30). A member_since more than 90 days before a
// portal-sold line's start is surfaced as `anniversary_predates_portal`
// (informational flag, never a hold).
// firstCompletedVisit and memberSince are DATE columns; acceptedAt is an
// instant (estimates.accepted_at) read on the ET calendar.
function resolveAnniversary({ firstCompletedVisit, acceptedAt, memberSince }) {
  const firstVisit = dateColumn(firstCompletedVisit);
  const accepted = etDay(acceptedAt);
  const member = dateColumn(memberSince);
  let date = null;
  let source = null;
  if (accepted) {
    if (firstVisit) { date = firstVisit; source = 'first_visit'; } else { date = accepted; source = 'estimate_accept'; }
  } else if (member && firstVisit) {
    if (member <= firstVisit) { date = member; source = 'member_since'; } else { date = firstVisit; source = 'first_visit'; }
  } else if (member) { date = member; source = 'member_since'; } else if (firstVisit) { date = firstVisit; source = 'first_visit'; }
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
    } catch (_) {
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
function engineInputsFromEstimate(estimate, deps = {}) {
  const data = parseJson(estimate && estimate.estimate_data);
  if (!data || typeof data !== 'object') return null;
  const req = data.engineRequest;
  if (req && typeof req === 'object' && req.profile && typeof req.profile === 'object') {
    const translate = deps.translateV2CallToV1Input !== undefined ? deps.translateV2CallToV1Input : lazyTranslateV2();
    if (typeof translate === 'function') {
      try {
        const v1 = translate(req.profile, Array.isArray(req.selectedServices) ? req.selectedServices : [], req.options || {});
        if (v1 && typeof v1 === 'object') return v1;
      } catch (err) {
        logger.warn(`[rate-review] engineRequest translation failed for estimate ${estimate.id}: ${err.message}`);
      }
    }
  }
  if (data.engineInputs && typeof data.engineInputs === 'object') return data.engineInputs;
  if (data.inputs && typeof data.inputs === 'object' && data.inputs.services && typeof data.inputs.services === 'object') return data.inputs;
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

const PEST_FREQUENCY_FOR_CADENCE = Object.freeze({ quarterly: 'quarterly', bimonthly: 'bimonthly', monthly: 'monthly' });
const LAWN_TIER_FOR_CADENCE = Object.freeze({ every_6_weeks: 'enhanced', monthly: 'premium', bimonthly: 'standard' });

// Quote-time concessions come off so the replay prices TODAY'S LIST for the
// same property, services and (engine-derived) tier — at the cadence the
// line actually runs on (pest frequency / lawn tier), which can differ from
// the cadence the estimate was sold at.
function listReplayInputs(inputs, { familyKey = null, cadence = null } = {}) {
  const clean = JSON.parse(JSON.stringify(inputs));
  for (const key of ['manualDiscount', 'serviceSpecificDiscounts', 'serviceSpecificCredits']) delete clean[key];
  if (familyKey === 'pest_control' && clean.services && clean.services.pest && PEST_FREQUENCY_FOR_CADENCE[cadence]) {
    clean.services.pest = { ...clean.services.pest, frequency: PEST_FREQUENCY_FOR_CADENCE[cadence] };
  }
  if (familyKey === 'lawn_care' && clean.services && clean.services.lawn && LAWN_TIER_FOR_CADENCE[cadence]) {
    clean.services.lawn = { ...clean.services.lawn, tier: LAWN_TIER_FOR_CADENCE[cadence], lawnFreq: CADENCE_VISITS[cadence] };
    delete clean.lawnFreq;
  }
  return clean;
}

function listRateFromEngineResult(result, line, cadence, { includeRiders = false } = {}) {
  const keys = ENGINE_SERVICE_KEYS[line] || [];
  const items = result && Array.isArray(result.lineItems) ? result.lineItems : [];
  const item = items.find((i) => keys.includes(i.service));
  if (!item || item.quoteRequired || item.requiresCustomQuote || item.requiresMeasurement) return null;
  const annual = positive(item.annualAfterDiscount ?? item.annual);
  const visits = positive(item.visitsPerYear) ?? positive(item.frequency);
  if (!annual || !visits) return null;
  const expected = CADENCE_VISITS[cadence];
  const cadenceMismatch = !!(expected && Math.round(visits) !== expected);
  // Riders (a palm program beside Tree & Shrub) join the MONTHLY figure only,
  // mirroring the ledger slice the monthly current rate was read from.
  const riderKeys = includeRiders ? (ENGINE_RIDER_KEYS[line] || []) : [];
  const riders = items.filter((i) => riderKeys.includes(i.service) && !i.quoteRequired && !i.requiresCustomQuote && !i.requiresMeasurement);
  const riderAnnual = riders.reduce((sum, r) => sum + (positive(r.annualAfterDiscount ?? r.annual) || 0), 0);
  return {
    perAppCents: Math.round((annual / visits) * 100),
    monthlyCents: Math.round(((annual + riderAnnual) / 12) * 100),
    riderServices: riders.map((r) => r.service),
    cadenceMismatch,
    tier: result.waveGuard && result.waveGuard.tier ? String(result.waveGuard.tier).toLowerCase() : null,
  };
}

async function replayEstimate(estimate, { familyKey, cadence }, deps) {
  const inputs = engineInputsFromEstimate(estimate, deps);
  if (!inputs) return null;
  const engine = deps.pricingEngine || require('./pricing-engine');
  try {
    if (typeof engine.needsSync === 'function' && engine.needsSync() && typeof engine.syncConstantsFromDB === 'function') {
      await engine.syncConstantsFromDB();
    }
    return { inputs, result: engine.generateEstimate(listReplayInputs(inputs, { familyKey, cadence })) };
  } catch (err) {
    logger.warn(`[rate-review] engine replay failed for estimate ${estimate.id}: ${err.message}`);
    return null;
  }
}

// ── data loaders ────────────────────────────────────────────────────────

async function loadConfig(dbh = db) {
  let row = null;
  try {
    row = await dbh(CONFIG).where({ id: 1 }).first();
  } catch (err) {
    logger.warn(`[rate-review] config read failed, using defaults: ${err.message}`);
  }
  const config = { ...DEFAULT_CONFIG };
  if (row) {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const n = finite(row[key]);
      if (n != null && n >= 0) config[key] = n;
    }
  }
  return config;
}

const LINE_SQL = `CASE COALESCE(sv.category, s.service_category_snapshot,
    CASE WHEN s.service_type ILIKE '%mosquito%' THEN 'mosquito'
         WHEN s.service_type ILIKE '%termite%' OR s.service_type ILIKE '%wdo%' THEN 'termite'
         WHEN s.service_type ILIKE '%rodent%' OR s.service_type ILIKE '%trap%' THEN 'rodent'
         WHEN s.service_type ILIKE '%lawn%' THEN 'lawn_care'
         WHEN s.service_type ILIKE '%tree%' OR s.service_type ILIKE '%shrub%' OR s.service_type ILIKE '%palm%' THEN 'tree_shrub'
         WHEN s.service_type ILIKE '%pest%' THEN 'pest_control' END)
  WHEN 'pest_control' THEN 'pest_control' WHEN 'lawn_care' THEN 'lawn_care' WHEN 'tree_shrub' THEN 'tree_shrub'
  WHEN 'mosquito' THEN 'mosquito' WHEN 'termite' THEN 'termite' WHEN 'rodent' THEN 'rodent' ELSE 'other' END`;

const CADENCE_SQL = `CASE WHEN s.recurring_pattern IN ('monthly','monthly_nth_weekday') THEN 'monthly'
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

const RECURRING_SQL = '(COALESCE(s.is_recurring, false) OR s.recurring_parent_id IS NOT NULL)';

// Every active recurring plan line in the book: real customer × line ×
// cadence with ≥1 open future recurring visit (pre-read definition).
async function loadActivePlanLines(dbh, { today }) {
  const { rows } = await dbh.raw(`
    WITH ov AS (
      SELECT s.id, s.customer_id, s.scheduled_date, s.estimated_price, s.primary_line_price, s.annual_prepay_term_id, s.source_estimate_id,
        COALESCE(s.service_key_snapshot, sv.service_key) AS skey, sv.visits_per_year AS cat_vpy,
        ${LINE_SQL} AS line, ${CADENCE_SQL} AS cadence
      FROM scheduled_services s
      LEFT JOIN services sv ON sv.id = s.service_id
      JOIN customers c ON c.id = s.customer_id
      WHERE s.scheduled_date >= ?
        AND s.status IN ('pending', 'confirmed', 'rescheduled')
        AND ${RECURRING_SQL}
        AND c.deleted_at IS NULL
        AND c.pipeline_stage IN ('active_customer', 'won', 'at_risk')
    )
    SELECT customer_id, line AS family_key, cadence,
      count(*)::int AS open_visits,
      min(scheduled_date) AS next_visit,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY estimated_price) FILTER (WHERE estimated_price > 0) AS median_price,
      count(estimated_price) FILTER (WHERE estimated_price > 0)::int AS priced_visits,
      count(*) FILTER (WHERE estimated_price = 0)::int AS zero_priced_visits,
      bool_or(estimated_price = 0 AND primary_line_price > 0) AS zero_with_base,
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

// First completed non-callback recurring visit per (customer, line).
async function loadFirstCompletedVisits(dbh, customerIds) {
  if (!customerIds.length) return new Map();
  const { rows } = await dbh.raw(`
    SELECT s.customer_id, ${LINE_SQL} AS line, min(s.scheduled_date) AS first_visit, count(*)::int AS completed_visits
    FROM scheduled_services s
    LEFT JOIN services sv ON sv.id = s.service_id
    WHERE s.customer_id = ANY(?::uuid[])
      AND s.status = 'completed'
      AND COALESCE(s.is_callback, false) = false
      AND ${RECURRING_SQL}
    GROUP BY 1, 2
  `, [customerIds]);
  const map = new Map();
  for (const row of rows) map.set(`${row.customer_id}|${row.line}`, row);
  return map;
}

// Completed non-callback recurring visits of the last 12 months with every
// duration source pricing-reality-check reads, plus the settled revenue.
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
      SELECT DISTINCT ON (scheduled_service_id) scheduled_service_id,
        started_at AS service_record_started_at, ended_at AS service_record_ended_at,
        structured_notes AS service_record_structured_notes, customer_interaction
      FROM service_records
      WHERE scheduled_service_id IS NOT NULL
      ORDER BY scheduled_service_id, created_at DESC
    )
    SELECT s.id, s.customer_id, s.scheduled_date, ${LINE_SQL} AS line, ${CADENCE_SQL} AS cadence,
      s.service_time_minutes, s.actual_duration_minutes, s.actual_start_time, s.actual_end_time,
      s.check_in_time, s.check_out_time, s.arrived_at, s.completed_at,
      s.annual_prepay_term_id, s.prepaid_amount,
      apt.prepay_amount AS term_prepay_amount, apt.coverage_visit_count AS term_visit_count,
      te.time_entry_minutes, te.time_entry_clock_in, te.time_entry_clock_out,
      sr.service_record_started_at, sr.service_record_ended_at, sr.service_record_structured_notes, sr.customer_interaction,
      (SELECT sum(i.total) FROM invoices i
        WHERE i.scheduled_service_id = s.id AND i.archived_at IS NULL AND i.annual_prepay_term_id IS NULL
          AND (i.paid_at IS NOT NULL OR i.status IN ('paid', 'prepaid'))
          AND i.status NOT IN (${notSettled.map(() => '?').join(', ')})
          AND NOT (COALESCE(i.title, '') ILIKE '%setup%' OR COALESCE(i.title, '') ILIKE '%initial%'
                   OR COALESCE(i.line_items::text, '') ILIKE '%setup%' OR COALESCE(i.line_items::text, '') ILIKE '%initial%')
      ) AS paid_revenue
    FROM scheduled_services s
    LEFT JOIN services sv ON sv.id = s.service_id
    LEFT JOIN te ON te.job_id = s.id
    LEFT JOIN sr ON sr.scheduled_service_id = s.id
    LEFT JOIN annual_prepay_terms apt ON apt.id = s.annual_prepay_term_id
    WHERE s.customer_id = ANY(?::uuid[])
      AND s.status = 'completed'
      AND COALESCE(s.is_callback, false) = false
      AND ${RECURRING_SQL}
      AND s.scheduled_date >= ?
  `, [...notSettled, customerIds, sinceYmd]);
  return rows;
}

async function loadEstimates(dbh, estimateIds) {
  if (!estimateIds.length) return new Map();
  const rows = await dbh('estimates')
    .whereIn('id', estimateIds)
    .where({ status: 'accepted' })
    .select('id', 'customer_id', 'accepted_at', 'waveguard_tier', 'estimate_data');
  return new Map(rows.map((r) => [r.id, r]));
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
      .count({ n: '*' }).first()),
    leg(() => dbh('retention_offers')
      .where({ customer_id: customerId, status: 'granted' })
      .where(function notExpired() { this.whereNull('expires_at').orWhere('expires_at', '>', now); })
      .count({ n: '*' }).first()),
    leg(() => dbh('plan_holds').where({ customer_id: customerId, status: 'active' }).select('family_key')),
  ]);
  return {
    callbackLines: callbacks === 'error' ? 'error' : callbacks.map((r) => r.line),
    cancellationCaseRecent: cases === 'error' ? true : Number(cases && cases.n) > 0,
    retentionOfferActive: offers === 'error' ? true : Number(offers && offers.n) > 0,
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

function resolveCurrentRate({ customer, planLine, liveTerms, ledgerSlice }) {
  const lane = customer.billing_mode || null;
  const prepayLinked = !!planLine.prepay_linked;
  const visitMedianCents = toCents(planLine.median_price);
  const feeCents = toCents(customer.per_application_fee);
  // A line whose open visits are all stamped exactly $0 bills nothing when
  // that zero is authoritative (billing-lane.js hasAuthoritativeZeroPrice:
  // GATE_STAMPED_ZERO_FREE on, or a positive primary_line_price base) — it
  // is a free line, never a fee-fallback candidate for an increase.
  const authoritativeZero = !(visitMedianCents > 0) && (planLine.zero_priced_visits || 0) > 0
    && hasAuthoritativeZeroPrice(0, planLine.zero_with_base ? 1 : null);
  const fromVisits = () => {
    if (visitMedianCents > 0) return { cents: visitMedianCents, source: 'visit_median', unit: 'application' };
    if (authoritativeZero) return { cents: 0, source: 'stamped_zero', unit: 'application', stampedZeroFree: true };
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
  if (lane === 'annual_prepay' || prepayLinked || ambiguous) {
    // Prepay by scalar or visit link but no resolvable live term — or live
    // terms that could belong to more than one line: held, priced off the
    // visits so the owner still sees numbers.
    const fallback = fromVisits();
    return { ...fallback, prepayTermMissing: lane === 'annual_prepay' || prepayLinked, prepayTermAmbiguous: ambiguous };
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
      zero_with_base: sorted.some((r) => r.zero_with_base),
    });
  }
  const linesPerCustomer = new Map();
  for (const line of lines) linesPerCustomer.set(line.customer_id, (linesPerCustomer.get(line.customer_id) || 0) + 1);
  for (const line of lines) line.account_lines = linesPerCustomer.get(line.customer_id);
  return lines;
}

function assertBatchKey(batchKey) {
  if (!BATCH_KEY_RE.test(String(batchKey || ''))) {
    const err = new Error('batchKey must be YYYY-MM');
    err.status = 400;
    throw err;
  }
}

function assertYmd(value, name) {
  if (!DATE_RE.test(String(value || ''))) {
    const err = new Error(`${name} must be YYYY-MM-DD`);
    err.status = 400;
    throw err;
  }
}

async function batchHasSentRows(dbh, batchKey) {
  const row = await dbh(SNAPSHOTS).where({ batch_key: batchKey }).whereIn('status', SENT_STATUSES).count({ n: '*' }).first();
  return Number(row && row.n) > 0;
}

async function buildBatch({ batchKey, anniversaryFrom, anniversaryTo, trx = null, now = new Date(), deps = {} } = {}) {
  if (!rateReviewLive()) return { ok: false, reason: 'gate_off' };
  assertBatchKey(batchKey);
  const from = anniversaryFrom || `${batchKey}-01`;
  const to = anniversaryTo || etMonthEnd(new Date(`${batchKey}-15T12:00:00Z`), 0);
  assertYmd(from, 'anniversaryFrom');
  assertYmd(to, 'anniversaryTo');
  if (from > to) { const err = new Error('anniversaryFrom must not be after anniversaryTo'); err.status = 400; throw err; }

  const dbh = trx || db;
  if (await batchHasSentRows(dbh, batchKey)) return { ok: false, reason: 'batch_has_sent_rows', batchKey };

  const today = etDateString(now);
  const config = await loadConfig(dbh);
  const planLines = consolidatePlanLines(await loadActivePlanLines(dbh, { today }));
  const customerIds = [...new Set(planLines.map((p) => p.customer_id))];
  const [customers, firstVisits, completedRows, liveTerms, ledger] = await Promise.all([
    loadCustomers(dbh, customerIds),
    loadFirstCompletedVisits(dbh, customerIds),
    loadCompletedVisitRows(dbh, customerIds, { sinceYmd: daysAgoYmd(now, LOOKBACK_DAYS) }),
    loadLiveTerms(dbh, customerIds, { today }),
    loadLedgerSlices(dbh, customerIds),
  ]);
  const estimateIds = [...new Set(planLines.flatMap((p) => p.source_estimate_ids || []))];
  const estimates = await loadEstimates(dbh, estimateIds);

  // Pass 1 — every line in the book: current rate, duration stats, list by
  // engine replay where the line links an accepted estimate with a size.
  const visitsByLine = new Map();
  for (const row of completedRows) {
    const key = `${row.customer_id}|${row.line}`;
    if (!visitsByLine.has(key)) visitsByLine.set(key, []);
    visitsByLine.get(key).push(row);
  }
  // Conversation allowances per line, from the whole book's completed
  // visits — stored on the batch row so every snapshot is reproducible.
  const allowances = computeLineAllowances(completedRows);
  const replayCache = new Map();
  const book = [];
  for (const planLine of planLines) {
    const customer = customers.get(planLine.customer_id);
    if (!customer) continue;
    const familyKey = planLine.family_key;
    const cadence = planLine.cadence;
    const current = resolveCurrentRate({ customer, planLine, liveTerms: liveTerms.get(customer.id), ledgerSlice: ledgerSliceForLine(ledger, customer.id, familyKey) });
    const visitsPerYear = visitsPerYearFor(cadence, planLine.catalog_vpy);
    const stats = lineDurationStats(visitsByLine.get(`${customer.id}|${familyKey}`) || [], {
      config,
      allowanceMinutes: allowanceFor(allowances, familyKey),
      duesRevenueCents: current.unit === 'month' && current.cents > 0 && visitsPerYear > 0 ? Math.round((current.cents * 12) / visitsPerYear) : null,
    });
    const first = firstVisits.get(`${customer.id}|${familyKey}`) || null;

    const linkedEstimates = (planLine.source_estimate_ids || []).map((id) => estimates.get(id)).filter(Boolean)
      .sort((a, b) => new Date(a.accepted_at || 0) - new Date(b.accepted_at || 0));
    const acceptedAt = linkedEstimates.length ? linkedEstimates[0].accepted_at : null;

    // Engine replay at the line's own cadence. A result whose cadence still
    // does not match the line (a family the replay cannot re-cadence) is NOT
    // a list rate — it is discarded (list_cadence_mismatch), and the row
    // falls to the cadence mode or is skipped.
    let list = { cents: null, source: 'none', cadenceMismatch: false, engineTier: null };
    for (const estimate of linkedEstimates) {
      const inputs = engineInputsFromEstimate(estimate, deps);
      if (!hasSizeInput(inputs, familyKey)) continue;
      const cacheKey = `${estimate.id}|${familyKey}|${cadence}`;
      if (!replayCache.has(cacheKey)) replayCache.set(cacheKey, await replayEstimate(estimate, { familyKey, cadence }, deps));
      const replay = replayCache.get(cacheKey);
      const rate = replay ? listRateFromEngineResult(replay.result, familyKey, cadence, { includeRiders: current.unit === 'month' }) : null;
      if (!rate) continue;
      const estimateTier = estimate.waveguard_tier ? String(estimate.waveguard_tier).toLowerCase() : null;
      if (rate.cadenceMismatch) {
        list = { cents: null, source: 'none', cadenceMismatch: true, engineTier: rate.tier, estimateTier };
        continue;
      }
      list = { cents: current.unit === 'month' ? rate.monthlyCents : rate.perAppCents, source: 'engine', cadenceMismatch: false, engineTier: rate.tier, estimateTier };
      break;
    }

    book.push({
      planLine, customer, familyKey, cadence,
      visitsPerYear,
      current, stats, first, acceptedAt, list,
      serviceKeys: planLine.service_keys || [],
    });
  }

  // Line-level references across the whole book: cadence-mode list rates
  // and revenue-per-hour quartiles per family.
  const modeByGroup = new Map();
  const rphByFamily = new Map();
  for (const entry of book) {
    if (entry.current.cents > 0 && entry.current.unit === 'application') {
      const key = `${entry.familyKey}|${entry.cadence}`;
      if (!modeByGroup.has(key)) modeByGroup.set(key, []);
      modeByGroup.get(key).push(entry.current.cents);
    }
    if (entry.stats.revenuePerHourCents != null) {
      if (!rphByFamily.has(entry.familyKey)) rphByFamily.set(entry.familyKey, []);
      rphByFamily.get(entry.familyKey).push(entry.stats.revenuePerHourCents);
    }
  }
  const lineRphStats = new Map([...rphByFamily].map(([family, values]) => [family, quartiles(values)]));
  const cadenceModes = new Map();
  for (const [key, values] of modeByGroup) {
    const mode = values.length >= MIN_MODE_SAMPLE ? modeCents(values) : null;
    if (mode) cadenceModes.set(key, mode.value);
  }

  // Pass 2 — only lines whose anniversary falls in the window get the
  // (expensive) per-customer facts and a snapshot row.
  const inWindow = [];
  for (const entry of book) {
    const anniversary = resolveAnniversary({
      firstCompletedVisit: entry.first && entry.first.first_visit,
      acceptedAt: entry.acceptedAt,
      // member_since is a DATE; the created_at fallback is an instant.
      memberSince: dateColumn(entry.customer.member_since) || etDay(entry.customer.created_at),
    });
    entry.anniversary = anniversary;
    // The review date = this line's anniversary occurrence in the window; a
    // line with no anniversary at all is listed (flag no_anniversary).
    entry.reviewDate = anniversary.date ? anniversaryInWindow(anniversary.date, from, to) : null;
    if (!anniversary.date || entry.reviewDate) inWindow.push(entry);
  }
  const windowCustomerIds = [...new Set(inWindow.map((e) => e.customer.id))];
  const priorReviews = await loadPriorReviews(dbh, windowCustomerIds, { batchKey });
  const factsByCustomer = new Map();
  const signalsByCustomer = new Map();
  for (const customerId of windowCustomerIds) {
    // Sequential on purpose: facts.js fans out ~24 queries per customer.
    factsByCustomer.set(customerId, await loadFacts(dbh, customerId, { now }));
    signalsByCustomer.set(customerId, await loadExceptionSignals(dbh, customerId, { now, config }));
  }

  const manualEditCutoff = monthsAgoYmd(now, config.exception_manual_edit_months);
  const rows = [];
  for (const entry of inWindow) {
    const { customer, familyKey, cadence, current, stats, list } = entry;
    const facts = factsByCustomer.get(customer.id) || null;
    const signals = signalsByCustomer.get(customer.id) || null;
    // No replayable estimate → the book's per-application mode for this
    // family × cadence; a monthly-billed line takes it spread over 12 months
    // (mode × visits ÷ 12) so the two units compare like for like.
    let listCents = list.cents;
    let listSource = list.source;
    if (listCents == null) {
      const mode = cadenceModes.get(`${familyKey}|${cadence}`);
      if (mode && current.unit === 'application') { listCents = mode; listSource = 'cadence_mode'; }
      else if (mode && current.unit === 'month' && entry.visitsPerYear > 0) { listCents = Math.round((mode * entry.visitsPerYear) / 12); listSource = 'cadence_mode'; }
    }
    if (listCents == null) listSource = 'none';
    // Hand-picked tier (owner ruling 2026-09-01: call-the-office, permanent):
    // the provenance column says manual, or the accepted estimate carries a
    // tier the engine does not derive from its own inputs. The customer's
    // live tier is deliberately NOT compared — a multi-plan customer's older
    // single-line estimate replays at a lower tier than the account now has.
    const tierSource = String(customer.waveguard_tier_source || '').toLowerCase();
    const handPickedTier = tierSource === 'manual'
      || !!(list.source === 'engine' && list.engineTier && list.estimateTier && list.engineTier !== list.estimateTier);
    const manualAt = facts && facts.manualPriceOverrideAt ? etDay(facts.manualPriceOverrideAt) : null;
    const tierProtected = customer.tier_protected_until && dateColumn(customer.tier_protected_until) >= today;
    const callbackLines = signals ? signals.callbackLines : 'error';
    const callbackRecent = callbackLines === 'error'
      || callbackLines.some((line) => line === familyKey || line === 'other')
      || !!(facts && Array.isArray(facts.openCallbackLanes) && facts.openCallbackLanes.length);
    const holdFamilies = signals ? signals.planHoldFamilies : 'error';
    const planHoldActive = holdFamilies === 'error' || holdFamilies.length > 0 || !!tierProtected;

    const line = {
      batchKey,
      customerId: customer.id,
      familyKey,
      cadence,
      visitsPerYear: entry.visitsPerYear,
      billingLane: customer.billing_mode || null,
      anniversaryDate: entry.anniversary.date,
      anniversarySource: entry.anniversary.source,
      anniversaryConflict: entry.anniversary.conflict,
      tenureMonths: entry.anniversary.date && entry.reviewDate ? monthsBetween(entry.anniversary.date, entry.reviewDate) : null,
      currentRateCents: current.cents,
      currentRateSource: current.source,
      stampedZeroFree: !!current.stampedZeroFree,
      rateUnit: current.unit,
      listRateCents: listCents,
      listRateSource: listSource,
      listCadenceMismatch: list.cadenceMismatch,
      usableVisits: stats.usableVisits,
      homeVisits: stats.homeVisits,
      notHomeVisits: stats.notHomeVisits,
      unknownInteractionVisits: stats.unknownInteractionVisits,
      allowanceMinutesApplied: stats.allowanceMinutesApplied,
      capturedConversationVisits: stats.capturedConversationVisits,
      duesAttributedVisits: stats.duesAttributedVisits,
      rphFromNotHome: stats.rphFromNotHome,
      treatmentMinutesMedian: stats.treatmentMinutesMedian,
      revenuePerHourCents: stats.revenuePerHourCents,
      lineRph: lineRphStats.get(familyKey) || null,
      prepayMidTerm: !!current.prepayMidTerm,
      prepayTermMissing: !!current.prepayTermMissing,
      prepayTermAmbiguous: !!current.prepayTermAmbiguous,
      rateUnattributed: !!current.rateUnattributed,
      cadenceConflict: !!entry.planLine.cadence_conflict,
      reviewedWithin12mo: priorReviews.has(`${customer.id}|${familyKey}`),
      manualRateEditRecent: !!(manualAt && manualAt >= manualEditCutoff),
      retentionOfferActive: !signals || signals.retentionOfferActive,
      planHoldActive,
      callbackRecent,
      cancellationCaseRecent: !signals || signals.cancellationCaseRecent,
      handPickedTier,
      commercial: isCommercialCustomer(customer, entry.serviceKeys),
      facts,
    };
    rows.push(computeSnapshot(line, config));
  }

  const computedAt = now;
  const lineRphJson = Object.fromEntries([...lineRphStats].map(([family, q]) => [family, q]));
  const write = async (conn) => {
    await conn(BATCHES).insert({
      batch_key: batchKey, window_from: from, window_to: to,
      allowances: JSON.stringify(allowances), config: JSON.stringify(config), line_rph: JSON.stringify(lineRphJson),
      book_lines: book.length, computed_at: computedAt, updated_at: computedAt,
    }).onConflict('batch_key').merge(['window_from', 'window_to', 'allowances', 'config', 'line_rph', 'book_lines', 'computed_at', 'updated_at']);
    await conn(SNAPSHOTS).where({ batch_key: batchKey }).whereNotIn('status', SENT_STATUSES).delete();
    if (rows.length) {
      await conn(SNAPSHOTS).insert(rows.map((row) => ({ ...row, flags: JSON.stringify(row.flags), computed_at: computedAt, updated_at: computedAt })));
    }
  };
  if (trx) await write(trx); else await db.transaction(write);

  const summary = summarizeRows(rows);
  logger.info(`[rate-review] batch ${batchKey} built: ${rows.length} rows (${summary.green} green, ${summary.exception} exceptions, ${summary.no_change} no-change, ${summary.skipped} skipped) from ${book.length} active plan lines`);
  return { ok: true, batchKey, window: { from, to }, rows: rows.length, summary, config, allowances, lineRph: lineRphJson };
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

async function getBatch(batchKey, dbh = db) {
  assertBatchKey(batchKey);
  const rows = await dbh(`${SNAPSHOTS} as r`)
    .leftJoin('customers as c', 'c.id', 'r.customer_id')
    .where('r.batch_key', batchKey)
    .orderByRaw("CASE r.status WHEN 'green' THEN 0 WHEN 'exception' THEN 1 WHEN 'no_change' THEN 2 ELSE 3 END")
    .orderBy('r.annual_delta_cents', 'desc')
    .select('r.*', 'c.first_name', 'c.last_name', 'c.city');
  const shaped = rows.map((r) => ({ ...r, flags: parseJson(r.flags) || [], customer_name: [r.first_name, r.last_name].filter(Boolean).join(' ') }));
  const batch = await dbh(BATCHES).where({ batch_key: batchKey }).first();
  return {
    batchKey,
    batch: batch ? { ...batch, allowances: parseJson(batch.allowances) || {}, config: parseJson(batch.config) || {}, line_rph: parseJson(batch.line_rph) || {} } : null,
    rows: shaped,
    summary: summarizeRows(shaped),
  };
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
function composeBatchEmail({ batchKey, rows, summary }) {
  const label = monthLabel(batchKey);
  const decide = summary.green + summary.exception;
  const greenDollars = dollars(summary.green_annual_delta_cents);
  const subject = decide > 0
    ? `ACT: Rate review — ${label} batch · ${summary.green} green · ${summary.exception} exception${summary.exception === 1 ? '' : 's'} · +${greenDollars}/yr`
    : `OK: Rate review — ${label}: nothing to decide (${summary.no_change} no-change, ${summary.skipped} skipped)`;
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
  const green = rows.filter((r) => r.status === 'green');
  const exceptions = rows.filter((r) => r.status === 'exception');
  const noChange = rows.filter((r) => r.status === 'no_change');
  const skipped = rows.filter((r) => r.status === 'skipped');
  const intro = `Rate review batch ${label}: ${summary.rows} plan line${summary.rows === 1 ? '' : 's'} with an anniversary in the window — ${summary.green} green (+${greenDollars}/yr if all approved), ${summary.exception} held out as exceptions, ${summary.no_change} no change, ${summary.skipped} skipped. Nothing has been sent to a customer and no rate has changed; this is the ranking only.`;
  const text = [intro, '', ...section('GREEN — proposed increases', green), ...section('EXCEPTIONS — held out, your call', exceptions), ...section('NO CHANGE', noChange), ...section('SKIPPED — could not be priced', skipped), `Review: ${link}`].join('\n');
  const htmlSection = (title, list) => (list.length
    ? `<p><strong>${esc(title)} (${list.length})</strong></p><ul style="margin:0 0 12px 18px;padding:0;">${list.map((r) => `<li style="margin:0 0 6px 0;">${esc(describe(r))}</li>`).join('')}</ul>`
    : '');
  const html = [
    `<p>${esc(intro)}</p>`,
    htmlSection('GREEN — proposed increases', green),
    htmlSection('EXCEPTIONS — held out, your call', exceptions),
    htmlSection('NO CHANGE', noChange),
    htmlSection('SKIPPED — could not be priced', skipped),
    `<p><a href="${esc(link)}">Open the rate review batch</a></p>`,
  ].join('\n');
  const headline = decide > 0 ? `Rate review — ${label}: ${summary.green} green, ${summary.exception} exceptions` : `Rate review — ${label}: nothing to decide`;
  const summaryLine = decide > 0 ? `+${greenDollars}/yr proposed across ${summary.green} accounts; ${summary.exception} need a look.` : `${summary.rows} lines ranked, none need a decision.`;
  const itemKeys = rows.map((r) => `${r.customer_id}:${r.family_key}:${r.status}`);
  return { subject, text, html, headline, summary: summaryLine, link: `/admin/pricing-logic?area=rate-review&batch=${batchKey}`, itemKeys, decide };
}

// One email per batch: the marker lives on the batch row itself.
async function alreadyEmailed(dbh, batchKey) {
  const row = await dbh(BATCHES).where({ batch_key: batchKey }).first('email_sent_at');
  return !!(row && row.email_sent_at);
}

async function stampEmailed(dbh, batchKey, subject) {
  await dbh(BATCHES).where({ batch_key: batchKey }).update({ email_sent_at: new Date(), email_subject: subject, updated_at: new Date() });
}

async function sendBatchEmail({ batchKey, dbh = db, mailer = null }) {
  const sendgrid = mailer || require('./sendgrid-mail');
  const { deliverOpsDigest } = require('./ops-digest');
  const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');
  const batch = await getBatch(batchKey, dbh);
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
  await deliverOpsDigest({
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
  await stampEmailed(dbh, batchKey, composed.subject);
  return { sent: true, subject: composed.subject, rows: batch.summary.rows };
}

// Scheduler entry (1st of the month): build the batch for anniversaries in
// the FOLLOWING month and email it once. Gate read first — off = return
// before any query. A batch with sent rows is never rebuilt.
async function runMonthlyRateReview({ now = new Date(), dbh = db, mailer = null, deps = {} } = {}) {
  if (!rateReviewLive()) return { skipped: 'gate_off' };
  const from = etMonthStart(now, 1);
  const to = etMonthEnd(now, 1);
  const batchKey = from.slice(0, 7);
  const built = await buildBatch({ batchKey, anniversaryFrom: from, anniversaryTo: to, now, deps });
  if (!built.ok) {
    logger.warn(`[rate-review] monthly build skipped for ${batchKey}: ${built.reason}`);
    return { skipped: built.reason, batchKey };
  }
  if (await alreadyEmailed(dbh, batchKey)) return { ...built, emailed: false, skipped: 'already_emailed' };
  let email;
  try {
    email = await sendBatchEmail({ batchKey, dbh, mailer });
  } catch (err) {
    logger.error(`[rate-review] batch email failed for ${batchKey} (status ${Number.isInteger(err && err.status) ? err.status : 'network'})`);
    return { ...built, emailed: false, error: true };
  }
  return { ...built, emailed: !!email.sent, email };
}

module.exports = {
  DEFAULT_CONFIG,
  EXCEPTION_FLAGS,
  buildBatch,
  summarizeBatch,
  getBatch,
  listBatches,
  loadConfig,
  runMonthlyRateReview,
  sendBatchEmail,
  composeBatchEmail,
  _private: {
    trimmedMedian, median, quartiles, modeCents, monthsBetween, monthKeyMinus, anniversaryInWindow, dateColumn, etDay,
    visitsPerYearFor,
    conversationMinutesFor, interactionFor, wallMinutesFor, treatmentMinutesFor, computeLineAllowances, allowanceFor, lineDurationStats, visitRevenueCents,
    gapPct, classifyBand, nudgeBand, evaluateExceptions, computeSnapshot, summarizeRows,
    resolveAnniversary, resolveCurrentRate, matchPrepayTerm, familyOfCoverage, consolidatePlanLines, hasSizeInput, listReplayInputs, listRateFromEngineResult, isCommercialCustomer, engineInputsFromEstimate,
    loadActivePlanLines, loadFirstCompletedVisits, loadCompletedVisitRows, loadExceptionSignals, loadPriorReviews, loadLedgerSlices, ledgerSliceForLine, loadEstimates, loadCustomers,
    LEDGER_FAMILIES_FOR_LINE,
    MAX_USABLE_MINUTES, MIN_TREATMENT_MINUTES, MAX_ALLOWANCE_MINUTES, MIN_LINE_RPH_SAMPLE, CADENCE_VISITS, CONVERSATION_MINUTES_KEYS, INTERACTION_HOME, INTERACTION_NOT_HOME,
  },
};
