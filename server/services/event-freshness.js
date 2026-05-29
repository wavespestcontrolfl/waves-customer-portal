/**
 * Event freshness engine — classification, eligibility, and scoring
 * for the newsletter content engine's freshness-first editorial policy.
 *
 * Three exported functions:
 *   classifyFreshness(event) — derive freshness_status + score from event_type
 *   isEligibleForFreshDigest(event) — hard gate: can this event appear?
 *   scoreFreshEvent(event) — rank eligible events for the weekly lineup
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

// ── classifyFreshness ────────────────────────────────────────────────

/**
 * Derive freshness_status and freshness_score from an event's type
 * and tracking fields. Pure function — no DB calls.
 *
 * @param {{ event_type: string, recurrence_type?: string, times_featured?: number, start_at?: string|Date, end_at?: string|Date }} event
 * @returns {{ freshness_status: string, freshness_score: number }}
 */
function classifyFreshness(event) {
  const { event_type, times_featured = 0 } = event;

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

  if (event_type === 'recurring_series') {
    if (times_featured <= 2) {
      const score = 90 - (times_featured * 10);
      return { freshness_status: 'fresh_series_launch', freshness_score: score };
    }
    return { freshness_status: 'stale_recurring', freshness_score: FRESHNESS_SCORES.stale_recurring };
  }

  if (event_type === 'ongoing') {
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
function isEligibleForFreshDigest(event) {
  if (event.admin_status === 'rejected') return false;
  // A row merged into another event is permanently ineligible, regardless of
  // any later admin_status change — keeps a merge durable (a re-approved
  // duplicate must never re-enter a newsletter after calendars were repointed
  // to the survivor). Callers must select merged_into for this to fire; the
  // digest/approved queries also enforce it at the SQL level.
  if (event.merged_into) return false;
  if (!event.event_url) return false;

  // Hard reject on terminal freshness states regardless of event_type
  if (event.freshness_status === 'expired') return false;
  if (event.freshness_status === 'stale_recurring') return false;

  if (event.start_at) {
    const startDate = new Date(event.start_at);
    const nowET = parseETDateTime(`${etDateString()}T00:00:00`);
    if (startDate < nowET) return false;
  } else {
    return false;
  }

  if (event.event_type === 'one_time') return true;
  if (event.event_type === 'annual') return true;
  if (event.event_type === 'special_edition') return true;

  if (event.event_type === 'limited_run') {
    return isOpeningWeek(event) || isClosingWeek(event);
  }

  if (event.event_type === 'recurring_series') {
    return (event.times_featured || 0) <= 2;
  }

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

  // Freshness (35%)
  score += (event.freshness_score ?? 50) * 0.35;

  // Date relevance (20%) — events this weekend score highest
  score += dateRelevanceScore(event.start_at) * 0.20;

  // Geo relevance (15%) — core Waves service area scores higher
  score += geoRelevanceScore(event.region_zone) * 0.15;

  // Source trust (15%) — lower priority_tier number = more trusted
  score += sourceTrustScore(event.source_priority_tier) * 0.15;

  // Audience fit (10%) — family-friendly and free events get a boost
  score += audienceFitScore(event) * 0.10;

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
  if (daysOut <= 3) return 100;  // This weekend
  if (daysOut <= 7) return 80;   // This week
  if (daysOut <= 14) return 50;  // Next week
  return 20;
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

function etDayDistance(timestamp) {
  const eventET = etParts(new Date(timestamp));
  const nowET = etParts();
  const eventDay = Date.UTC(eventET.year, eventET.month - 1, eventET.day);
  const nowDay = Date.UTC(nowET.year, nowET.month - 1, nowET.day);
  return (eventDay - nowDay) / (1000 * 60 * 60 * 24);
}

function isOpeningWeek(event) {
  if (!event.start_at) return false;
  const days = etDayDistance(event.start_at);
  return days >= -1 && days <= 7;
}

function isClosingWeek(event) {
  if (!event.end_at) return false;
  const days = etDayDistance(event.end_at);
  return days >= 0 && days <= 7;
}

// ── Newsletter Thursday helpers ──────────────────────────────────────

function getCurrentNewsletterThursday() {
  const now = new Date();
  const nowET = etParts(now);
  const daysBack = (nowET.dayOfWeek - 4 + 7) % 7; // 0 on Thu, 1 Fri, ... 6 Wed
  return etDateString(addETDays(now, -daysBack)); // YYYY-MM-DD of most recent Thursday
}

function getNewsletterWeekOf(date) {
  const d = date instanceof Date ? date : parseETDateTime(
    typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date
  );
  const et = etParts(d);
  const daysBack = (et.dayOfWeek - 4 + 7) % 7;
  return etDateString(addETDays(d, -daysBack));
}

function defaultTargetSendAt(weekOf) {
  return parseETDateTime(`${weekOf}T08:00:00`); // Thursday 8 AM ET
}

/**
 * Stable signed-int4 Postgres advisory-lock key for a newsletter week, derived
 * from the YYYY-MM-DD week string. Shared by the Thursday autopilot and the
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
  classifyFreshness,
  isEligibleForFreshDigest,
  scoreFreshEvent,
  isOpeningWeek,
  isClosingWeek,
  getCurrentNewsletterThursday,
  getNewsletterWeekOf,
  defaultTargetSendAt,
  weekLockKey,
};
