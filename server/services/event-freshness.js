/**
 * Event freshness engine — classification, eligibility, and scoring
 * for the newsletter content engine's freshness-first editorial policy.
 *
 * Core exported functions:
 *   classifyFreshness(event) — derive freshness_status + score from event_type
 *   isEligibleForFreshDigest(event) — hard gate: can this event appear?
 *   scoreFreshEvent(event) — rank eligible events for the weekly lineup
 *   isRoutineRecurringEvent(event) — reject routine/repeated programming
 *
 * Plus helpers:
 *   cityToZone(city) — map a city name to a newsletter coverage zone
 *   FRESHNESS_SCORES — reference table for base scores by event type
 *
 * All date comparisons use America/New_York via server/utils/datetime-et.js
 * because Railway runs UTC and newsletter editorial windows are ET.
 */

const { etParts, parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');

// ── City → Zone mapping ──────────────────────────────────────────────
// Matches the zones defined in server/config/newsletter-types.js

const CITY_ZONE_MAP = {
  'north port': 'south_sarasota',
  'wellen park': 'south_sarasota',
  'venice': 'south_sarasota',
  'nokomis': 'south_sarasota',
  'osprey': 'south_sarasota',
  'englewood': 'south_sarasota',

  'sarasota': 'sarasota',
  'siesta key': 'sarasota',
  'longboat key': 'sarasota',

  'bradenton': 'manatee',
  'palmetto': 'manatee',
  'anna maria': 'manatee',
  'lakewood ranch': 'manatee',
  'parrish': 'manatee',
  'ellenton': 'manatee',
  'cortez': 'manatee',

  'st petersburg': 'pinellas',
  'st pete': 'pinellas',
  'clearwater': 'pinellas',
  'gulfport': 'pinellas',
  'dunedin': 'pinellas',
  'safety harbor': 'pinellas',

  'tampa': 'tampa',
  'ybor city': 'tampa',
  'hyde park': 'tampa',
  'brandon': 'tampa',
  'riverview': 'tampa',

  'port charlotte': 'south_sarasota',
  'punta gorda': 'south_sarasota',
};

function cityToZone(city) {
  if (!city) return null;
  // Normalize hyphenated slugs ("north-port", "lakewood-ranch", "st-petersburg")
  // to the space-separated keys CITY_ZONE_MAP uses. The scrape handler stores
  // kebab-case city slugs and the RSS/iCal coverage_geo fallback is seeded
  // kebab-case too, so without this every multi-word city returns null →
  // region_zone stays NULL → geoRelevanceScore defaults to 40 (out-of-area),
  // systematically demoting exactly the hyperlocal events the digest should lead with.
  const normalized = city.trim().toLowerCase().replace(/-/g, ' ');
  return CITY_ZONE_MAP[normalized] || null;
}

// ── Freshness base scores ────────────────────────────────────────────

const FRESHNESS_SCORES = {
  fresh_one_time: 100,
  fresh_annual: 95,
  fresh_series_launch: 90,
  fresh_special_edition: 70,
  fresh_limited_run_opening: 80,
  fresh_limited_run_closing: 70,
  stale_recurring: 10,
  expired: 0,
  needs_review: 40,
};

// Routine programming is intentionally outside the weekend guide's editorial
// contract. Annual events and finite seasonal runs can still be genuinely new;
// open-ended daily/weekly/monthly/custom recurrence cannot — with ONE owner
// carve-out (2026-07-17): the DEBUT of a recurring series is news exactly
// once. "Weekly yoga in the park" never earns a slot, but "grand opening of
// the weekly night market" can — and only until it has been featured.
const ROUTINE_EVENT_TYPES = Object.freeze(['recurring_series', 'ongoing']);
const ROUTINE_RECURRENCE_TYPES = Object.freeze(['daily', 'weekly', 'monthly', 'custom']);
const ANNUAL_REFRESH_DAYS = 300;
const FLAGSHIP_SEND_HOUR_ET = 6;
const FLAGSHIP_SEND_TOLERANCE_MINUTES = 15;

// Metadata from the normalizer is the primary gate. These deliberately narrow
// text patterns catch common source rows that were mislabeled as one_time — for
// example "Weekly Yoga Class" or "Yoga every Tuesday" — without rejecting a
// one-off yoga workshop merely because its title contains the word "yoga".
const ROUTINE_TEXT_PATTERNS = [
  /\b(?:every|each)\s+(?:day|weekday|week|month|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)s?\b/i,
  /\b(?:daily|weekly|monthly|recurring|ongoing)\s+(?:class(?:es)?|session(?:s)?|series|meetup(?:s)?|market(?:s)?|yoga|pilates|fitness|trivia|karaoke|night(?:s)?|event(?:s)?)\b/i,
];

function isRoutineRecurringEvent(event = {}) {
  const eventType = String(event.event_type || '').toLowerCase();
  const recurrenceType = String(event.recurrence_type || '').toLowerCase();
  if (ROUTINE_EVENT_TYPES.includes(eventType)) return true;
  if (ROUTINE_RECURRENCE_TYPES.includes(recurrenceType)) return true;

  const text = `${event.title || ''} ${event.description || ''}`;
  return ROUTINE_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

// The series-debut carve-out needs explicit evidence in the listing itself —
// deliberately narrow so an ordinary recurring session can't sneak in on a
// vague word. Bare "launch"/"new" are excluded on purpose (boat launches,
// "new menu"). Debut evidence only counts on a never-featured row: once the
// series has appeared in an issue, its future occurrences are routine again.
const SERIES_DEBUT_TEXT_PATTERNS = [
  /\b(?:grand opening|opening (?:day|night|weekend)|inaugural|first[-\s]ever|debut|kick[-\s]?off|season (?:opener|premiere)|(?:series|season) launch|launch party)\b/i,
];

function isSeriesDebutEvent(event = {}) {
  const timesFeatured = Math.max(0, Number(event.times_featured) || 0);
  if (timesFeatured > 0 || event.last_featured_at) return false;
  const text = `${event.title || ''} ${event.description || ''}`;
  return SERIES_DEBUT_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Hard editorial-newness gate. A normal event may appear only once. Annual
 * occurrences can return after a 300-day cooldown, but only when a trustworthy
 * last_featured_at timestamp proves the prior appearance is old enough.
 */
function isEditoriallyNewEvent(event = {}, reference = new Date()) {
  const timesFeatured = Math.max(0, Number(event.times_featured) || 0);
  const hasFeaturedAt = Boolean(event.last_featured_at);
  if (timesFeatured === 0 && !hasFeaturedAt) return true;

  const isAnnual = event.event_type === 'annual' || event.recurrence_type === 'annual';
  if (!isAnnual || !hasFeaturedAt) return false;

  const lastFeatured = new Date(event.last_featured_at);
  if (Number.isNaN(lastFeatured.getTime())) return false;
  return -etDayDistance(lastFeatured, reference) >= ANNUAL_REFRESH_DAYS;
}

function canonicalEventUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}`.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeDigestTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|presents?|featuring|feat|with|at|in)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digestTitleSimilarity(left, right) {
  const leftTokens = new Set(normalizeDigestTitle(left).split(' ').filter(Boolean));
  const rightTokens = new Set(normalizeDigestTitle(right).split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function digestEventDate(event) {
  if (!event?.start_at) return '';
  const value = new Date(event.start_at);
  return Number.isNaN(value.getTime()) ? '' : etDateString(value);
}

/**
 * Reject the whole normalized-title identity when the candidate pool contains
 * occurrences on multiple ET dates. Keeping merely the best row would still
 * turn an unlabelled weekly scrape/RSS series into a seemingly one-time pick.
 * Same-day duplicates remain available for the normal rank-preserving dedupe.
 */
function excludeRepeatedDateIdentities(events) {
  const rows = Array.isArray(events) ? events : [];
  const datesByTitle = new Map();
  for (const event of rows) {
    const titleKey = normalizeDigestTitle(event?.title);
    const dateKey = digestEventDate(event);
    if (!titleKey || !dateKey) continue;
    const dates = datesByTitle.get(titleKey) || new Set();
    dates.add(dateKey);
    datesByTitle.set(titleKey, dates);
  }
  const repeatedTitles = new Set(
    [...datesByTitle.entries()].filter(([, dates]) => dates.size > 1).map(([title]) => title),
  );
  return rows.filter((event) => !repeatedTitles.has(normalizeDigestTitle(event?.title)));
}

/** Preserve input order (normally score order) while removing duplicate rows. */
function dedupeDigestEvents(events) {
  const seenTitles = new Set();
  return (Array.isArray(events) ? events : []).filter((event) => {
    const titleKey = normalizeDigestTitle(event?.title);
    if (titleKey && seenTitles.has(titleKey)) return false;
    if (titleKey) seenTitles.add(titleKey);
    return true;
  });
}

/**
 * Add the metadata-level recurrence exclusions to a Knex query. Callers still
 * run isEligibleForFreshDigest after fetching so the text backstop and all
 * other hard gates apply too.
 */
function excludeRoutineRecurringFromQuery(query, alias = 'e') {
  const col = (name) => alias ? `${alias}.${name}` : name;
  // Grouped so the carve-out ORs against BOTH metadata exclusions without
  // leaking past any other conditions the caller has chained. A row survives
  // either by having non-routine metadata, or by carrying the normalizer's
  // fresh_series_launch classification (the debut carve-out — the JS gate
  // still re-verifies debut evidence + never-featured after fetch).
  return query.where(function routineRecurringExclusion() {
    this.where(function nonRoutineMetadata() {
      this.whereNotIn(col('event_type'), ROUTINE_EVENT_TYPES)
        .whereNotIn(col('recurrence_type'), ROUTINE_RECURRENCE_TYPES);
    }).orWhere(col('freshness_status'), 'fresh_series_launch');
  });
}

// ── classifyFreshness ────────────────────────────────────────────────

/**
 * Derive freshness_status and freshness_score from an event's type
 * and tracking fields. Pure function — no DB calls.
 *
 * @param {{ event_type: string, recurrence_type?: string, times_featured?: number, start_at?: string|Date, end_at?: string|Date }} event
 * @returns {{ freshness_status: string, freshness_score: number }}
 */
function classifyFreshness(event) {
  const { event_type } = event;

  // Recurrence wins over a conflicting event_type. This protects against old
  // or manually-edited rows such as event_type=one_time + recurrence=weekly.
  // Exception: a never-featured series DEBUT is genuinely new once.
  if (isRoutineRecurringEvent(event)) {
    if (isSeriesDebutEvent(event)) {
      return { freshness_status: 'fresh_series_launch', freshness_score: FRESHNESS_SCORES.fresh_series_launch };
    }
    return { freshness_status: 'stale_recurring', freshness_score: FRESHNESS_SCORES.stale_recurring };
  }

  if (event_type === 'one_time') {
    return { freshness_status: 'fresh_one_time', freshness_score: FRESHNESS_SCORES.fresh_one_time };
  }

  if (event_type === 'annual') {
    return { freshness_status: 'fresh_annual', freshness_score: FRESHNESS_SCORES.fresh_annual };
  }

  if (event_type === 'special_edition') {
    return { freshness_status: 'fresh_special_edition', freshness_score: FRESHNESS_SCORES.fresh_special_edition };
  }

  if (event_type === 'limited_run') {
    if (isOpeningWeek(event)) {
      return { freshness_status: 'fresh_limited_run_opening', freshness_score: FRESHNESS_SCORES.fresh_limited_run_opening };
    }
    if (isClosingWeek(event)) {
      return { freshness_status: 'fresh_limited_run_closing', freshness_score: FRESHNESS_SCORES.fresh_limited_run_closing };
    }
    return { freshness_status: 'stale_recurring', freshness_score: 30 };
  }

  // Kept as explicit fallbacks for rows with unusual casing/shape. In normal
  // operation isRoutineRecurringEvent catches both before the fresh branches.
  if (event_type === 'recurring_series' || event_type === 'ongoing') {
    return { freshness_status: 'stale_recurring', freshness_score: FRESHNESS_SCORES.stale_recurring };
  }

  return { freshness_status: 'needs_review', freshness_score: FRESHNESS_SCORES.needs_review };
}

// ── isEligibleForFreshDigest ─────────────────────────────────────────

/**
 * Hard gate: can this event appear in the weekly fresh events digest?
 * Returns false for rejected, expired, past, stale recurring events.
 *
 * @param {{ admin_status: string, start_at?: string|Date, event_url?: string, event_type: string, freshness_status: string, times_featured?: number }} event
 * @returns {boolean}
 */
function isEligibleForFreshDigest(event, reference = new Date()) {
  if (event.admin_status === 'rejected') return false;
  // A row merged into another event is permanently ineligible, regardless of
  // any later admin_status change — keeps a merge durable (a re-approved
  // duplicate must never re-enter a newsletter after calendars were repointed
  // to the survivor). Callers must select merged_into for this to fire; the
  // digest/approved queries also enforce it at the SQL level.
  if (event.merged_into) return false;
  if (!event.event_url) return false;
  // Series-debut carve-out: a routine-recurring row passes only while its
  // stored classification says fresh_series_launch AND the debut evidence
  // still holds on a never-featured row. The first feature bumps
  // times_featured, so the allowance is single-shot by construction.
  const isSeriesDebut = event.freshness_status === 'fresh_series_launch' && isSeriesDebutEvent(event);
  if (isRoutineRecurringEvent(event) && !isSeriesDebut) return false;
  // Admin 'featured' = deliberately starred for the upcoming issue. It
  // overrides the once-only newness rejection — covering rows whose counters
  // were advanced by the retired click-increment behavior, and any event the
  // operator explicitly re-stars. The star is consumed on ship
  // (markEventsFeatured demotes featured → approved), so it can't re-admit
  // the same event issue after issue. Every other hard gate still applies.
  if (!isEditoriallyNewEvent(event, reference) && event.admin_status !== 'featured') return false;

  // Hard reject on terminal freshness states regardless of event_type
  if (event.freshness_status === 'expired') return false;
  if (event.freshness_status === 'stale_recurring') return false;

  if (event.start_at) {
    const startDate = new Date(event.start_at);
    const nowET = parseETDateTime(`${etDateString(reference)}T00:00:00`);
    if (startDate < nowET) return false;
  } else {
    return false;
  }

  if (event.event_type === 'one_time') return true;
  if (event.event_type === 'annual') return true;
  if (event.event_type === 'special_edition') return true;

  if (event.event_type === 'limited_run') {
    return isOpeningWeek(event, reference) || isClosingWeek(event, reference);
  }

  // Routine-recurring types reach here only through the debut carve-out.
  if (isSeriesDebut) return true;

  // Reject needs_review and unknown — require explicit classification before digest
  if (event.freshness_status === 'needs_review') return false;
  if (event.event_type === 'unknown') return false;

  return false;
}

// ── scoreFreshEvent ──────────────────────────────────────────────────

/**
 * Rank eligible events for the weekly lineup. Higher = more newsletter-worthy.
 *
 * @param {{ freshness_score?: number, start_at?: string|Date, region_zone?: string, source_priority_tier?: number, family_friendly?: boolean, is_free?: boolean, categories?: string[] }} event
 * @returns {number} 0-100
 */
function scoreFreshEvent(event) {
  let score = 0;

  // Freshness classification (30%)
  score += (event.freshness_score ?? 50) * 0.30;

  // Date relevance (20%) — events this weekend score highest
  score += dateRelevanceScore(event.start_at) * 0.20;

  // Editorial novelty (20%) — recently discovered, never-featured events lead;
  // recently shipped events sink. Old annual occurrences can recover over time.
  score += editorialNoveltyScore(event) * 0.20;

  // Geo relevance (10%) — core Waves service area scores higher
  score += geoRelevanceScore(event.region_zone) * 0.10;

  // Source trust (10%) — lower priority_tier number = more trusted
  score += sourceTrustScore(event.source_priority_tier) * 0.10;

  // Audience fit (5%) — family-friendly and free events get a boost
  score += audienceFitScore(event) * 0.05;

  // Category diversity (5%) — flat bonus, refined in Phase 3
  score += 50 * 0.05;

  return Math.round(Math.min(100, Math.max(0, score)));
}

// ── Scoring helpers ──────────────────────────────────────────────────

function dateRelevanceScore(startAt) {
  if (!startAt) return 30;
  const eventET = etParts(new Date(startAt));
  const nowET = etParts();
  const eventDay = Date.UTC(eventET.year, eventET.month - 1, eventET.day);
  const nowDay = Date.UTC(nowET.year, nowET.month - 1, nowET.day);
  const daysOut = (eventDay - nowDay) / (1000 * 60 * 60 * 24);
  if (daysOut < 0) return 0;
  // Friday–Sunday inside the active window are the point of a Tuesday guide.
  if ([5, 6, 0].includes(eventET.dayOfWeek) && daysOut <= 7) return 100;
  if (daysOut <= 3) return 85;
  if (daysOut <= 7) return 70;
  if (daysOut <= 14) return 50;  // Next week
  return 20;
}

function editorialNoveltyScore(event) {
  const now = new Date();
  const timesFeatured = Math.max(0, Number(event.times_featured) || 0);

  if (event.last_featured_at) {
    const daysSinceFeatured = -etDayDistance(event.last_featured_at, now);
    if (daysSinceFeatured <= 14) return 0;
    if (daysSinceFeatured <= 45) return 15;
    if (daysSinceFeatured <= 120) return 35;
    // Annual/seasonal rows are often revived in place by upstream feeds. Once
    // enough time has passed, treat the new occurrence as editorially novel.
    if (event.event_type === 'annual' || event.recurrence_type === 'annual') return 85;
    return 50;
  }

  if (timesFeatured > 0) return timesFeatured === 1 ? 25 : 10;
  if (!event.pulled_at) return 65;

  const daysSincePull = -etDayDistance(event.pulled_at, now);
  if (daysSincePull <= 3) return 100;
  if (daysSincePull <= 7) return 90;
  if (daysSincePull <= 14) return 80;
  if (daysSincePull <= 30) return 65;
  return 50;
}

function geoRelevanceScore(regionZone) {
  const scores = {
    manatee: 100,
    sarasota: 100,
    south_sarasota: 90,
    pinellas: 60,
    tampa: 50,
  };
  return scores[regionZone] || 40;
}

function sourceTrustScore(priorityTier) {
  if (!priorityTier) return 50;
  const scores = { 1: 100, 2: 80, 3: 60, 4: 40, 5: 20, 6: 10 };
  return scores[priorityTier] || 50;
}

function audienceFitScore(event) {
  let score = 50;
  if (event.family_friendly) score += 20;
  if (event.is_free) score += 15;
  return Math.min(100, score);
}

// ── Time window helpers ──────────────────────────────────────────────

function etDayDistance(timestamp, reference = new Date()) {
  const eventET = etParts(new Date(timestamp));
  const nowET = etParts(reference);
  const eventDay = Date.UTC(eventET.year, eventET.month - 1, eventET.day);
  const nowDay = Date.UTC(nowET.year, nowET.month - 1, nowET.day);
  return (eventDay - nowDay) / (1000 * 60 * 60 * 24);
}

function isOpeningWeek(event, reference = new Date()) {
  if (!event.start_at) return false;
  const days = etDayDistance(event.start_at, reference);
  return days >= -1 && days <= 7;
}

function isClosingWeek(event, reference = new Date()) {
  if (!event.end_at) return false;
  const days = etDayDistance(event.end_at, reference);
  return days >= 0 && days <= 7;
}

// ── Newsletter Tuesday helpers ───────────────────────────────────────

function getCurrentNewsletterTuesday(now = new Date()) {
  const nowET = etParts(now);
  const daysBack = (nowET.dayOfWeek - 2 + 7) % 7; // 0 on Tue, 1 Wed, ... 6 Mon
  return etDateString(addETDays(now, -daysBack)); // most recent Tuesday
}

function getNextNewsletterTuesday(now = new Date()) {
  const nowET = etParts(now);
  const daysForward = (2 - nowET.dayOfWeek + 7) % 7;
  return etDateString(addETDays(now, daysForward));
}

// Monday's draft belongs to tomorrow's issue. Tuesday through Sunday belong to
// the most recent Tuesday, whose Tue–Mon event window contains the upcoming
// weekend readers are planning for.
function getActiveNewsletterTuesday(now = new Date()) {
  return etParts(now).dayOfWeek === 1
    ? getNextNewsletterTuesday(now)
    : getCurrentNewsletterTuesday(now);
}

function getNewsletterWeekOf(date) {
  const d = date instanceof Date ? date : parseETDateTime(
    typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date
  );
  const et = etParts(d);
  const daysBack = (et.dayOfWeek - 2 + 7) % 7;
  return etDateString(addETDays(d, -daysBack));
}

function defaultTargetSendAt(weekOf) {
  return parseETDateTime(`${weekOf}T06:00:00`); // Tuesday 6 AM ET
}

function calendarDateString(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '';
  // PostgreSQL DATE values are represented at local midnight by node-pg.
  // Preserve those calendar parts rather than converting through UTC.
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function isFlagshipTargetForWeek(date, weekOf) {
  const key = calendarDateString(weekOf);
  if (!key || !isFlagshipScheduledTime(date)) return false;
  const value = date instanceof Date ? date : new Date(date);
  return value.getTime() === defaultTargetSendAt(key).getTime();
}

function getNewsletterDraftWindowStart(weekOf) {
  const issueTuesday = parseETDateTime(`${weekOf}T12:00:00`);
  return parseETDateTime(`${etDateString(addETDays(issueTuesday, -1))}T00:00:00`);
}

function isFlagshipScheduledTime(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return false;
  const et = etParts(value);
  return et.dayOfWeek === 2
    && et.hour === FLAGSHIP_SEND_HOUR_ET
    && et.minute === 0
    && et.second === 0
    && value.getUTCMilliseconds() === 0;
}

function isFlagshipDeliveryWindow(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return false;
  const et = etParts(value);
  return et.dayOfWeek === 2
    && et.hour === FLAGSHIP_SEND_HOUR_ET
    && et.minute >= 0
    && et.minute < FLAGSHIP_SEND_TOLERANCE_MINUTES;
}

function isCurrentFlagshipTarget(date, reference = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (!isFlagshipScheduledTime(value)) return false;
  return value.getTime() === defaultTargetSendAt(getActiveNewsletterTuesday(reference)).getTime();
}

/**
 * Stable signed-int4 Postgres advisory-lock key for a newsletter week, derived
 * from the YYYY-MM-DD week string. Shared by the Monday flagship autopilot and the
 * draft-from-plan route so both serialize on the SAME key and cannot each
 * create a draft for the week. (The previous key hashed only the first 4 bytes
 * of an ISO timestamp — i.e. the year digits — so it collapsed to one key per
 * calendar year.) FNV-1a → unsigned → mod 2^31-1.
 */
function weekLockKey(weekOf) {
  const s = `nl-week:${String(weekOf || '')}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483647;
}

module.exports = {
  cityToZone,
  CITY_ZONE_MAP,
  FRESHNESS_SCORES,
  ROUTINE_EVENT_TYPES,
  ROUTINE_RECURRENCE_TYPES,
  ANNUAL_REFRESH_DAYS,
  FLAGSHIP_SEND_HOUR_ET,
  FLAGSHIP_SEND_TOLERANCE_MINUTES,
  isRoutineRecurringEvent,
  isSeriesDebutEvent,
  isEditoriallyNewEvent,
  canonicalEventUrl,
  normalizeDigestTitle,
  digestTitleSimilarity,
  excludeRepeatedDateIdentities,
  dedupeDigestEvents,
  excludeRoutineRecurringFromQuery,
  classifyFreshness,
  isEligibleForFreshDigest,
  scoreFreshEvent,
  editorialNoveltyScore,
  isOpeningWeek,
  isClosingWeek,
  getCurrentNewsletterTuesday,
  getNextNewsletterTuesday,
  getActiveNewsletterTuesday,
  getNewsletterWeekOf,
  defaultTargetSendAt,
  isFlagshipTargetForWeek,
  getNewsletterDraftWindowStart,
  isFlagshipScheduledTime,
  isFlagshipDeliveryWindow,
  isCurrentFlagshipTarget,
  weekLockKey,
};
