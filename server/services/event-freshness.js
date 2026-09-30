/**
 * Event freshness engine — classification, eligibility, and scoring
 * for the newsletter content engine's freshness-first editorial policy.
 *
 * Core exported functions:
 *   classifyFreshness(event) — derive freshness_status + score from event_type
 *   isEligibleForFreshDigest(event) — hard gate: can this event appear?
 *   scoreFreshEvent(event) — rank eligible events for the weekly lineup
 *   isRoutineRecurringEvent(event) — reject routine/repeated programming
 *   isRecurringIdentityEvent(event) — broader "this identity recurs" test
 *     (daily/weekly/monthly/custom/seasonal/annual recurrence, recurring_series/
 *     ongoing event types, or an unknown-recurrence identity with ≥2 tracked
 *     occurrences) used by the calendar-year first-occurrence rule below.
 *
 * Owner ruling 2026-09-27: "For recurring it should be the first event for
 * the year." Any recurring identity — including annual/seasonal and an
 * unknown-recurrence identity that repeats, not only the daily/weekly/
 * monthly/custom/recurring_series/ongoing "routine" set below — is
 * newsletter-eligible ONLY for its first occurrence of the ET calendar year,
 * and only once we can actually prove it is first (prior-year continuity,
 * series-debut evidence, or — annual only — simply not having run yet this
 * year). This replaces the old 300-day annual-refresh cooldown; see
 * isEditoriallyNewEvent, isPreviouslyFeaturedIdentity, and
 * newsletter-event-selection.js's isFirstOccurrenceOfYear / loadYearIdentityPool
 * for the full mechanism. Fails closed: a recurring identity that cannot
 * prove it is first is excluded, never guessed into eligibility.
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

// Routine programming (open-ended daily/weekly/monthly/custom recurrence, or
// event_type recurring_series/ongoing) is intentionally outside the weekend
// guide's editorial contract by default — with ONE owner carve-out
// (2026-07-17): the DEBUT of a recurring series is news exactly once.
// "Weekly yoga in the park" never earns a slot, but "grand opening of the
// weekly night market" can — and only until it has been featured. This hard
// block is a SUBSET of the broader calendar-year first-occurrence rule
// (owner ruling 2026-09-27, see module header): annual and seasonal
// recurrence, which are NOT in this routine list, get their first-of-year
// eligibility from that rule directly rather than from a hard block here.
const ROUTINE_EVENT_TYPES = Object.freeze(['recurring_series', 'ongoing']);
const ROUTINE_RECURRENCE_TYPES = Object.freeze(['daily', 'weekly', 'monthly', 'custom']);
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

// ROUTINE_TEXT_PATTERNS in PostgreSQL regex syntax (\\b becomes \\y).
const SQL_ROUTINE_TEXT_PATTERNS = ROUTINE_TEXT_PATTERNS.map((pattern) => pattern.source.replace(/\\b/g, '\\y'));

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

/** event_type OR recurrence_type says "annual" — the two fields disagree on
 * old/manually-edited rows often enough that every annual check reads both. */
function isAnnualEvent(event = {}) {
  return event.event_type === 'annual' || event.recurrence_type === 'annual';
}

// Once-a-year recurrence (owner ruling 2026-09-27: first occurrence of the ET
// calendar year only). An 'unknown' event_type carrying one of these is
// classified by its recurrence instead, the same way an 'unknown' type with a
// routine recurrence is a routine series.
const YEARLY_RECURRENCE_TYPES = Object.freeze(['annual', 'seasonal']);

function isYearlyByRecurrenceOnly(event = {}) {
  return String(event.event_type || '').toLowerCase() === 'unknown'
    && YEARLY_RECURRENCE_TYPES.includes(String(event.recurrence_type || '').toLowerCase());
}

/**
 * Broader than isRoutineRecurringEvent: true for ANY identity the owner's
 * 2026-09-27 ruling treats as recurring — the routine daily/weekly/monthly/
 * custom/recurring_series/ongoing set, annual, seasonal recurrence, or an
 * unknown-recurrence identity that has actually repeated. recurrence_type
 * 'unknown' has no reliable metadata of its own, so callers who can see the
 * identity's occurrence history pass `occurrenceCount` (this row plus every
 * matching sibling found); without it, an unknown-recurrence row is treated
 * as one-time (fails closed toward NOT granting the once-per-year carve-out
 * rather than guessing it recurs).
 */
function isRecurringIdentityEvent(event = {}, { occurrenceCount = null } = {}) {
  if (isRoutineRecurringEvent(event)) return true;
  if (isAnnualEvent(event)) return true;
  if (String(event.recurrence_type || '').toLowerCase() === 'seasonal') return true;
  if (String(event.recurrence_type || '').toLowerCase() === 'unknown') {
    return Number(occurrenceCount) >= 2;
  }
  return false;
}

/** ET calendar year for a date-like value, falling back to reference's ET year
 * when the value is missing/unparseable. */
function etYearOf(value, reference = new Date()) {
  const parsed = value ? new Date(value) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return etParts(parsed).year;
  return etParts(reference).year;
}

// A weekly issue ships Tuesday 6 AM ET and lists events through the following
// Monday night; 8 days covers that window plus a delayed send.
const FEATURED_ISSUE_LOOKAHEAD_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Hard editorial-newness gate. A one-time (non-recurring) identity may
 * appear only once, ever. A RECURRING identity (owner ruling 2026-09-27:
 * "for recurring it should be the first event for the year") may return
 * once a NEW ET calendar year starts from its last feature — replacing the
 * old 300-day annual-only cooldown. A missing/unparseable last_featured_at
 * fails closed (blocked): we can't prove which year it ran.
 *
 * `recurring` (Codex P2, 2026-09-27): when a caller has already established
 * that this identity recurs from evidence isRecurringIdentityEvent can't see
 * on `event` alone — newsletter-event-selection.js's isPreviouslyFeaturedIdentity
 * checks EITHER the current row's or the prior featured row's metadata, since
 * a re-scrape can normalize the same identity's event_type/recurrence_type
 * differently — pass that verdict through explicitly instead of letting this
 * function re-derive it from `event` only, which would silently fall back to
 * "one-time" and block the identity forever.
 */
function isEditoriallyNewEvent(event = {}, reference = new Date(), { occurrenceCount = null, recurring = null } = {}) {
  const timesFeatured = Math.max(0, Number(event.times_featured) || 0);
  const hasFeaturedAt = Boolean(event.last_featured_at);
  if (timesFeatured === 0 && !hasFeaturedAt) return true;

  const isRecurring = recurring != null ? Boolean(recurring) : isRecurringIdentityEvent(event, { occurrenceCount });
  if (!isRecurring || !hasFeaturedAt) return false;

  const lastFeatured = new Date(event.last_featured_at);
  if (Number.isNaN(lastFeatured.getTime())) return false;
  // Same fallback etYearOf uses: no parseable start_at reads as `reference`.
  const parsedStart = event.start_at ? new Date(event.start_at) : null;
  const start = parsedStart && !Number.isNaN(parsedStart.getTime()) ? parsedStart : new Date(reference);

  // Preferred: the shipped occurrence's own date (last_featured_occurrence_at,
  // stamped at send). New only in a later ET year than that occurrence.
  const featuredOccurrence = event.last_featured_occurrence_at ? new Date(event.last_featured_occurrence_at) : null;
  if (featuredOccurrence && !Number.isNaN(featuredOccurrence.getTime())) {
    return etYearOf(featuredOccurrence, reference) < etYearOf(start, reference);
  }

  // Rows featured before that column existed: last_featured_at is the SEND time, not the featured occurrence's date: an
  // issue covers events up to FEATURED_ISSUE_LOOKAHEAD_MS after it ships. An
  // occurrence inside that window may be the very one that shipped (a
  // January 2 event featured December 29), so it never re-qualifies through
  // the year refresh. Only a later occurrence in a newer ET year does.
  if (start.getTime() <= lastFeatured.getTime() + FEATURED_ISSUE_LOOKAHEAD_MS) return false;
  return etYearOf(lastFeatured, reference) < etYearOf(start, reference);
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
  return rows.filter((event) => {
    if (!repeatedTitles.has(normalizeDigestTitle(event?.title))) return true;
    // A repeated title is ROUTINE-recurrence evidence (a weekly class listed
    // per-date) — but a genuine multi-day festival, annual event, or limited
    // run also emits one row per date under one name. Those types carry
    // their own gates (annual cooldown, opening/closing windows), so they
    // survive here; dedupeDigestEvents collapses the identity to a single
    // row in any final lineup.
    const type = String(event?.event_type || '').toLowerCase();
    return type === 'annual' || type === 'limited_run';
  });
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

// SQL-side approximation of the JS identity match (normalizeDigestTitle +
// isSameSeriesSibling) used by buildRoutineFirstOfYearAdmission below.
// Deliberately looser than the JS normalizer (no stopword strip) — a false
// MATCH here would wrongly re-exclude a genuine first-of-year row (unsafe),
// while a false NON-match only means the row falls through to the JS gate's
// full check (always safe), so this only needs to avoid over-matching.
// SQL mirror of normalizeDigestTitle: & to "and", punctuation to spaces,
// filler words dropped, whitespace collapsed and trimmed. (`presents{0,1}`,
// not `presents?`: knex reads a bare `?` in raw SQL as a binding.)
const sqlNormalizedTitle = (colRef) => `btrim(regexp_replace(regexp_replace(regexp_replace(replace(lower(${colRef}), '&', ' and '), '[^a-z0-9]+', ' ', 'g'), '\\y(the|a|an|presents{0,1}|featuring|feat|with|at|in)\\y', ' ', 'g'), '\\s+', ' ', 'g'))`;
const sqlEtYear = (colRef) => `date_part('year', (${colRef} AT TIME ZONE 'America/New_York'))`;
// ET calendar day (not timestamp) — the SQL mirror of
// newsletter-event-selection.js's occurrenceDayKey, the single JS definition
// of "which day does this occurrence fall on". Comparing DAYS rather than
// exact instants (Codex P2, 2026-09-27, re-raised) matters because two
// same-identity rows on the SAME ET day but a few minutes apart (a showtime
// rounding difference, or two feeds reporting the same occurrence at
// slightly different clock times) are the SAME occurrence, not one "earlier"
// than the other — a plain `start_at <` comparison wrongly disqualified
// whichever of the pair happened to sort later.
const sqlEtDay = (colRef) => `(${colRef} AT TIME ZONE 'America/New_York')::date`;

/**
 * Raw NOT EXISTS clause: true when no OTHER row in events_raw shares this
 * row's identity (normalized title + venue, or title + city when venue is
 * blank on either side — mirrors newsletter-event-selection.js's
 * isSameSeriesSibling) with a start_at falling on a strictly EARLIER ET
 * CALENDAR DAY in the SAME ET calendar year (see sqlEtDay above — not an
 * earlier exact timestamp). A row merged into a survivor on its own ET day
 * never counts (a merged duplicate a few minutes earlier than its survivor is
 * the same happening); one whose survivor was since advanced to another day
 * does, exactly as newsletter-event-selection.js's isMergedAwaySibling. Correlated against `alias` (the caller's own query alias),
 * so it can only be used once that alias is actually in scope.
 */
function buildRoutineFirstOfYearAdmission(alias) {
  const outer = (name) => `${alias}.${name}`;
  const sib = (name) => `routine_sibling.${name}`;
  return `NOT EXISTS (
    SELECT 1 FROM events_raw AS routine_sibling
    WHERE ${sib('id')} != ${outer('id')}
      AND (${sib('merged_into')} IS NULL OR NOT EXISTS (
        SELECT 1 FROM events_raw AS routine_survivor
        WHERE routine_survivor.id = ${sib('merged_into')}
          AND ${sqlEtDay('routine_survivor.start_at')} = ${sqlEtDay(sib('start_at'))}
      ))
      AND ${sqlEtDay(sib('start_at'))} < ${sqlEtDay(outer('start_at'))}
      AND ${sqlEtYear(sib('start_at'))} = ${sqlEtYear(outer('start_at'))}
      AND ${sqlNormalizedTitle(sib('title'))} = ${sqlNormalizedTitle(outer('title'))}
      AND (
        (${contextPresent(sib('venue_name'))} AND ${contextPresent(outer('venue_name'))}
          AND ${sqlSeriesContext(sib('venue_name'))} = ${sqlSeriesContext(outer('venue_name'))})
        OR (
          (NOT ${contextPresent(sib('venue_name'))} OR NOT ${contextPresent(outer('venue_name'))})
          AND ${contextPresent(sib('city'))} AND ${contextPresent(outer('city'))}
          AND ${sqlSeriesContext(sib('city'))} = ${sqlSeriesContext(outer('city'))}
        )
        OR (
          -- No venue pair and no city pair to compare: same title alone is
          -- the same series, exactly as isSameSeriesSibling falls through.
          (NOT ${contextPresent(sib('venue_name'))} OR NOT ${contextPresent(outer('venue_name'))})
          AND (NOT ${contextPresent(sib('city'))} OR NOT ${contextPresent(outer('city'))})
        )
      )
  )`;
}

// SQL mirror of newsletter-event-selection.js's normalizeSeriesContext, used
// for venue and city alike: lowercase, punctuation to spaces, trimmed, so
// "lakewood-ranch" matches "Lakewood Ranch".
function sqlSeriesContext(column) {
  return `btrim(regexp_replace(lower(${column}), '[^a-z0-9]+', ' ', 'g'))`;
}

// Present only when it normalizes to non-empty text ('' and whitespace are
// missing), NULL-safe.
function contextPresent(column) {
  return `(COALESCE(${sqlSeriesContext(column)}, '') <> '')`;
}

/**
 * Add the metadata-level recurrence exclusions to a Knex query. Callers still
 * run isEligibleForFreshDigest after fetching so the text backstop and all
 * other hard gates apply too.
 *
 * Owner ruling 2026-09-27 (Codex P1): a recurring identity is
 * newsletter-eligible for its first occurrence of the ET calendar year (see
 * this module's header and newsletter-event-selection.js's
 * isFirstOccurrenceOfYear / loadYearIdentityPool). This gate used to drop
 * EVERY routine row outright unless it also carried the normalizer's
 * fresh_series_launch classification, so a normal weekly/monthly series with
 * genuine prior-year continuity could never reach the JS first-of-year check
 * at all — every consumer of this shared gate (buildCurationCandidateQuery,
 * the rescore pass, buildDigestPlan, the admin planner, draft loading) was
 * affected identically. A third carve-out admits a routine row when SQL can't
 * find an earlier-this-(ET)-year sibling of the same identity; the JS gate
 * re-verifies with the real pool afterward (merged-row handling, prior-year
 * continuity, debut evidence, star overrides), so this only needs to avoid
 * FALSE matches (which would wrongly re-exclude a genuine first-of-year row)
 * — a missed match here just costs the JS gate doing the full check instead
 * of the row being pre-filtered, which is always safe.
 */
function excludeRoutineRecurringFromQuery(query, alias = 'e') {
  const col = (name) => alias ? `${alias}.${name}` : name;
  // Grouped so the carve-out ORs against all three conditions without
  // leaking past any other conditions the caller has chained.
  return query.where(function routineRecurringExclusion() {
    // A stale NON-routine row (e.g. a limited_run between its opening and
    // closing weeks) never qualifies: the JS gate would reject it and leave
    // curated_at NULL, so admitting it here would let such rows fill the
    // capped, start-ordered curation query every run. stale_recurring is
    // re-admitted only for routine series, through the first-of-year branch.
    this.where(function nonRoutineMetadata() {
      this.whereNotIn(col('event_type'), ROUTINE_EVENT_TYPES)
        .whereNotIn(col('recurrence_type'), ROUTINE_RECURRENCE_TYPES)
        .whereNot(col('freshness_status'), 'stale_recurring');
    }).orWhere(col('freshness_status'), 'fresh_series_launch');

    // Only meaningful once the row is aliased into the query (every real
    // caller passes the default 'e') — an unaliased query has no stable
    // identifier to correlate the subquery against, so it falls back to the
    // pre-existing two-branch gate rather than guess at one.
    if (alias) {
      // Only routine series use the first-of-year admission; any other row
      // was already decided by the metadata branch above.
      this.orWhere(function routineFirstOfYear() {
        this.where(function routineMetadata() {
          this.whereIn(col('event_type'), ROUTINE_EVENT_TYPES)
            .orWhereIn(col('recurrence_type'), ROUTINE_RECURRENCE_TYPES);
          // Same text evidence isRoutineRecurringEvent uses ("Weekly Yoga",
          // "every Tuesday"), so a series labeled only by its wording still
          // reaches the first-of-year check.
          for (const pattern of SQL_ROUTINE_TEXT_PATTERNS) {
            this.orWhereRaw(
              `(COALESCE(${col('title')}, '') || ' ' || COALESCE(${col('description')}, '')) ~* ?`,
              [pattern],
            );
          }
        }).whereRaw(buildRoutineFirstOfYearAdmission(alias));
      });
    }
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

  if (event_type === 'annual' || isYearlyByRecurrenceOnly(event)) {
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
/**
 * Stage 1: absolute hard rejects — none of these are ever bypassed by a star,
 * a debut, or the first-of-year carve-out. Pure functions of the row itself;
 * order among them doesn't matter since every branch here only ever returns
 * `true` (reject) and none depends on another's result.
 */
function isHardRejectedForFreshDigest(event) {
  if (event.admin_status === 'rejected') return true;
  // A row merged into another event is permanently ineligible, regardless of
  // any later admin_status change — keeps a merge durable (a re-approved
  // duplicate must never re-enter a newsletter after calendars were repointed
  // to the survivor). Callers must select merged_into for this to fire; the
  // digest/approved queries also enforce it at the SQL level.
  if (event.merged_into) return true;
  if (!event.event_url) return true;
  if (event.freshness_status === 'expired') return true;
  // An operator's needs_review blocks every path, including the debut and
  // first-of-year carve-outs below — checked unconditionally, before either
  // carve-out is even computed.
  if (event.freshness_status === 'needs_review') return true;
  return false;
}

/**
 * Stage 2: recurrence / editorial-newness. Resolves the series-debut and
 * pool-verified first-of-year carve-outs, the star's newness-only bypass, and
 * the stale_recurring hard block — everything that decides whether this
 * IDENTITY is allowed to be new again, as opposed to stage 3's plain
 * date/type checks. Returns `rejected` plus the resolved `isSeriesDebut` flag
 * stage 3 also needs (a continuity-proven, non-debut-worded routine row still
 * carries classifyFreshness's stored 'stale_recurring'/no-type-match
 * classification, so stage 3 needs the same override to admit it).
 */
function evaluateFreshDigestNewness(event, reference) {
  // Series-debut carve-out: a routine-recurring row passes only while its
  // stored classification says fresh_series_launch AND the debut evidence
  // still holds on a never-featured row. The first feature bumps
  // times_featured, so the allowance is single-shot by construction. The
  // SECOND carve-out, `__recurringFirstOfYear`, is a pool-verified marker
  // stamped ONLY by newsletter-event-selection.js's filterRepeatedDateIdentities
  // / assessFlagshipEventSelection (never present on a raw DB row) once they
  // have proven a routine identity is genuinely first this ET calendar year
  // via prior-year continuity — evidence this pure, pool-less function has no
  // way to check on its own (owner ruling 2026-09-27).
  const isSeriesDebut = (event.freshness_status === 'fresh_series_launch' && isSeriesDebutEvent(event))
    || event.__recurringFirstOfYear === true;
  if (isRoutineRecurringEvent(event) && !isSeriesDebut) return { rejected: true, isSeriesDebut };

  // Admin 'featured' = deliberately starred for the upcoming issue. It
  // overrides the once-only newness rejection — covering rows whose counters
  // were advanced by the retired click-increment behavior, and any event the
  // operator explicitly re-stars. The star is consumed on ship
  // (markEventsFeatured demotes featured → approved), so it can't re-admit
  // the same event issue after issue. Every other hard gate still applies —
  // the star bypasses NEWNESS only.
  //
  // __recurrenceOccurrenceCount is the same pool-verified marker pattern as
  // __recurringFirstOfYear above: this pure, pool-less function has no way to
  // count a recurrence_type='unknown' identity's occurrences on its own, so
  // a pool-having caller (filterRepeatedDateIdentities / assessFlagship-
  // EventSelection) stamps it before calling in. Without it, isRecurring-
  // IdentityEvent's own default (occurrenceCount=null) treats an
  // actually-repeating 'unknown' identity as one-time — which permanently
  // blocks it here once featured, instead of granting the calendar-year
  // refresh a genuinely recurring identity gets (Codex P2, 2026-09-27).
  const occurrenceCount = event.__recurrenceOccurrenceCount ?? null;
  // __identityRecurring: the pool-verified identity verdict (identityIsRecurring),
  // which covers a row re-labeled one_time whose earlier rows were weekly.
  const recurring = event.__identityRecurring === true ? true : null;
  if (!isEditoriallyNewEvent(event, reference, { occurrenceCount, recurring }) && event.admin_status !== 'featured') {
    return { rejected: true, isSeriesDebut };
  }

  // Hard reject on terminal freshness states regardless of event_type. A
  // continuity-proven (non-debut) routine row still carries the stored
  // 'stale_recurring' classification from classifyFreshness (which has no
  // pool access and can't know about continuity) — isSeriesDebut is the
  // pool-verified override for that one case.
  if (event.freshness_status === 'stale_recurring' && !isSeriesDebut) return { rejected: true, isSeriesDebut };

  return { rejected: false, isSeriesDebut };
}

/** Stage 3: plain date/type eligibility, once newness has already cleared. */
function isFreshDigestDateTypeEligible(event, reference, isSeriesDebut) {
  if (event.start_at) {
    const startDate = new Date(event.start_at);
    const nowET = parseETDateTime(`${etDateString(reference)}T00:00:00`);
    if (startDate < nowET) return false;
  } else {
    return false;
  }

  if (event.event_type === 'one_time') return true;
  if (event.event_type === 'annual') return true;
  // Stage 2 already held this identity to its first occurrence of the year.
  if (isYearlyByRecurrenceOnly(event)) return true;
  if (event.event_type === 'special_edition') return true;

  if (event.event_type === 'limited_run') {
    return isOpeningWeek(event, reference) || isClosingWeek(event, reference);
  }

  // Routine-recurring types reach here only through the debut carve-out.
  if (isSeriesDebut) return true;

  // Reject unknown — require explicit classification before digest
  if (event.event_type === 'unknown') return false;

  return false;
}

function isEligibleForFreshDigest(event, reference = new Date()) {
  if (isHardRejectedForFreshDigest(event)) return false;

  const newness = evaluateFreshDigestNewness(event, reference);
  if (newness.rejected) return false;

  return isFreshDigestDateTypeEligible(event, reference, newness.isSeriesDebut);
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
  YEARLY_RECURRENCE_TYPES,
  FLAGSHIP_SEND_HOUR_ET,
  FLAGSHIP_SEND_TOLERANCE_MINUTES,
  FEATURED_ISSUE_LOOKAHEAD_MS,
  isRoutineRecurringEvent,
  isSeriesDebutEvent,
  isAnnualEvent,
  isYearlyByRecurrenceOnly,
  isRecurringIdentityEvent,
  etYearOf,
  isEditoriallyNewEvent,
  canonicalEventUrl,
  normalizeDigestTitle,
  digestTitleSimilarity,
  excludeRepeatedDateIdentities,
  dedupeDigestEvents,
  excludeRoutineRecurringFromQuery,
  buildRoutineFirstOfYearAdmission,
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
