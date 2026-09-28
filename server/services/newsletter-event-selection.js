/**
 * Final flagship event-selection gate.
 *
 * Draft creation filters events, but stored drafts can outlive policy changes
 * or carry manually supplied ids. Proofing and delivery therefore re-load the
 * locked rows and fail closed before any external mail or send-state claim.
 *
 * Owner ruling 2026-09-27: "For recurring it should be the first event for
 * the year." Any recurring identity — daily/weekly/monthly/custom/seasonal/
 * annual recurrence, event_type recurring_series/ongoing, or an
 * unknown-recurrence identity that actually repeats — is eligible only for
 * its first occurrence of the ET calendar year, proven by prior-year
 * continuity, series-debut evidence, or (annual only) simply not having run
 * yet this year. isFirstOccurrenceOfYear / loadYearIdentityPool implement
 * this against a full-calendar-year identity pool (unlike the ±90-day
 * loadRoutineIdentityPool below), and both filterRepeatedDateIdentities and
 * assessFlagshipEventSelection apply it, so every consumer of either
 * function picks it up automatically. isPreviouslyFeaturedIdentity and
 * event-freshness.js's isEditoriallyNewEvent carry the companion rule: an
 * identity already featured in the SAME calendar year is never eligible
 * again that year (this replaced the old 300-day annual-only cooldown).
 */

const db = require('../models/db');
const { FLAGSHIP_TYPE_KEY, isFlagshipType } = require('../config/newsletter-types');
const {
  isEligibleForFreshDigest,
  isEditoriallyNewEvent,
  isSeriesDebutEvent,
  isAnnualEvent,
  isRecurringIdentityEvent,
  isRoutineRecurringEvent,
  etYearOf,
  normalizeDigestTitle,
  excludeRepeatedDateIdentities,
  dedupeDigestEvents,
  getActiveNewsletterTuesday,
  FEATURED_ISSUE_LOOKAHEAD_MS,
} = require('./event-freshness');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTINE_IDENTITY_HORIZON_DAYS = 90;

function parseLockedEventIds(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function isPreviouslyFeaturedIdentity(event, featuredHistory, reference, {
  occurrenceCount = null, identityRecurring = false, firstOfYear = null, provenFirstOfYear = null,
} = {}) {
  return (Array.isArray(featuredHistory) ? featuredHistory : []).some((prior) => {
    if (String(prior.id) === String(event.id)) return false;
    const hasHistory = Number(prior.times_featured) > 0 || Boolean(prior.last_featured_at);
    if (!hasHistory) return false;

    const sameTitle = normalizeDigestTitle(prior.title)
      && normalizeDigestTitle(prior.title) === normalizeDigestTitle(event.title);
    // A roundup article URL can legitimately back many distinct events. Only
    // canonical title identity carries feature history across ingestion rows.
    if (!sameTitle) return false;

    // Recurring identities (owner ruling 2026-09-27: "for recurring it
    // should be the first event for the year") can return once a NEW ET
    // calendar year starts — replacing the old 300-day annual-only cooldown.
    // A one-time identity stays blocked forever once featured. `prior` may
    // carry different event_type/recurrence_type metadata than the current
    // ingestion row (a re-scrape can normalize it differently), so either
    // side calling itself recurring is enough to grant the calendar-year
    // re-check. `occurrenceCount` (pool-derived, same identity-level value
    // for `event` and `prior` since sameTitle already established they're
    // the same identity) is what lets a repeated recurrence_type='unknown'
    // identity qualify here at all — without it, isRecurringIdentityEvent
    // defaults an 'unknown' row to one-time, which would otherwise block a
    // genuinely recurring identity FOREVER after its first feature instead
    // of granting the calendar-year refresh (Codex P2, 2026-09-27).
    const eventRecurring = isRecurringIdentityEvent(event, { occurrenceCount });
    const priorRecurring = isRecurringIdentityEvent(prior, { occurrenceCount });
    // identityRecurring: the pool-verified verdict (identityIsRecurring) from
    // the caller, for when neither this row nor the featured one is labeled
    // recurring but another sibling of the identity is.
    if (identityRecurring || eventRecurring || priorRecurring) {
      // Codex P2, 2026-09-27 (second pass): pass the ALREADY-ESTABLISHED
      // recurring verdict through explicitly rather than letting
      // isEditoriallyNewEvent re-derive it from `event`'s own metadata alone.
      // When `prior` is the side that proved recurring (e.g. a re-scrape
      // normalized the current row to recurrence_type='one_time' while the
      // historical row is 'recurring_series'), re-deriving from `event` only
      // would say "not recurring" and permanently block the identity instead
      // of granting the calendar-year refresh this branch just qualified it
      // for.
      // The refresh is for this ET year's FIRST occurrence only, whichever
      // side proved recurrence: callers pass whether an earlier same-year
      // occurrence exists in the year pool (the featured prior row is the
      // earlier-year evidence itself).
      if (firstOfYear === false) return true;
      // No earlier date this year is not yet proof this is the year's FIRST
      // (Codex P2, round 22): the rule fails closed without continuity. The
      // proof is the pool's own isFirstOccurrenceOfYear verdict, this
      // featured row having shipped in the ET year just before, or an annual
      // identity (one a year by nature). A row featured two years back says
      // nothing about this year's earlier dates.
      if (provenFirstOfYear !== true && !isAnnualEvent(event) && !isAnnualEvent(prior)
        && !shippedInPriorEtYear(prior, etYearOf(event.start_at, reference), reference)) return true;
      return !isEditoriallyNewEvent({
        ...event,
        times_featured: Math.max(1, Number(prior.times_featured) || 0),
        last_featured_at: prior.last_featured_at,
        last_featured_occurrence_at: prior.last_featured_occurrence_at ?? null,
      }, reference, { occurrenceCount, recurring: true });
    }
    return true;
  });
}

async function loadFeaturedIdentityHistory(knex = db) {
  return knex('events_raw')
    .select(
      'id', 'title', 'event_url', 'event_type', 'recurrence_type',
      'times_featured', 'last_featured_at', 'last_featured_occurrence_at',
    )
    .where((query) => query.where('times_featured', '>', 0).orWhereNotNull('last_featured_at'));
}

/**
 * Remove logical events already featured on a different ingestion row.
 * `yearPool` lets a caller that already loaded the full-calendar-year
 * identity pool (loadYearIdentityPool) share it instead of paying for a
 * second DB round trip; otherwise this loads its own through
 * loadSharedYearPool, like filterRepeatedDateIdentities.
 */
async function filterPreviouslyFeaturedIdentities(events, { knex = db, reference = new Date(), yearPool = null } = {}) {
  const rows = Array.isArray(events) ? events : [];
  if (!rows.length) return [];
  const history = await loadFeaturedIdentityHistory(knex);
  const calendarYearPool = yearPool || await loadSharedYearPool(knex, rows, reference);
  // A starred row bypasses cross-row identity history — the operator is
  // deliberately re-featuring an identity that shipped before, and the star
  // is consumed on ship. (A DEBUT gets no such bypass here: prior shipped
  // history for the same identity is proof it isn't a debut.)
  return rows.filter((event) => {
    if (event.admin_status === 'featured') return true;
    const occurrenceCount = identityOccurrenceCount(event, calendarYearPool);
    const identityRecurring = event.__identityRecurring === true
      || identityIsRecurring(event, calendarYearPool, occurrenceCount);
    const firstOfYear = !hasEarlierOccurrenceThisYear(event, calendarYearPool, reference);
    const provenFirstOfYear = isFirstOccurrenceOfYear(event, calendarYearPool, reference);
    return !isPreviouslyFeaturedIdentity(event, history, reference, {
      occurrenceCount, identityRecurring, firstOfYear, provenFirstOfYear,
    });
  });
}

function repeatedDateTitleKeys(events) {
  const rows = Array.isArray(events) ? events : [];
  const survivingTitles = new Set(
    excludeRepeatedDateIdentities(rows).map((event) => normalizeDigestTitle(event?.title)).filter(Boolean),
  );
  return new Set(
    rows.map((event) => normalizeDigestTitle(event?.title))
      .filter((title) => title && !survivingTitles.has(title)),
  );
}

async function loadRoutineIdentityPool(knex = db, reference = new Date()) {
  const issueTuesday = getActiveNewsletterTuesday(reference);
  const issueStart = parseETDateTime(`${issueTuesday}T00:00:00`);
  // Both bounds are anchored to whichever of (issue Tuesday, reference)
  // reaches further — on a Monday run the issue Tuesday is TOMORROW, so an
  // issue-only lower bound would start a day late and hide an earlier
  // sibling in the Monday-to-Tuesday slice (Codex P2, mirror of the
  // upper-bound fix below).
  const issueLower = parseETDateTime(
    `${etDateString(addETDays(issueStart, -ROUTINE_IDENTITY_HORIZON_DAYS))}T00:00:00`,
  );
  const referenceLower = parseETDateTime(
    `${etDateString(addETDays(reference, -ROUTINE_IDENTITY_HORIZON_DAYS))}T00:00:00`,
  );
  const horizonStart = referenceLower < issueLower ? referenceLower : issueLower;
  // The pool must reach at least as far as curation's own candidate
  // horizon (reference + 90 days). Anchored only to the issue Tuesday it
  // ends 1–5 days short on Wed–Sun runs, and a daily/custom debut series
  // whose siblings all sit in that uncovered tail would make EVERY row
  // look like the first occurrence (Codex P2, 2026-07-28).
  const issueEnd = parseETDateTime(
    `${etDateString(addETDays(issueStart, ROUTINE_IDENTITY_HORIZON_DAYS))}T23:59:59`,
  );
  const referenceEnd = parseETDateTime(
    `${etDateString(addETDays(reference, ROUTINE_IDENTITY_HORIZON_DAYS))}T23:59:59`,
  );
  const horizonEnd = referenceEnd > issueEnd ? referenceEnd : issueEnd;
  return knex('events_raw')
    .select('id', 'title', 'start_at', 'venue_name', 'city')
    .whereNull('merged_into')
    .where('start_at', '>=', horizonStart)
    .where('start_at', '<=', horizonEnd);
}

const normalizeSeriesContext = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Same normalized title does not always mean same series — two venues can
 * both run a "Trivia Night" launch. When BOTH rows carry a venue (or,
 * failing that, both carry a city) and those disagree, they are distinct
 * series and neither constrains the other's debut. When the context is
 * missing on either side we assume same series — fail closed, the
 * conservative reading for a debut claim.
 */
function isSameSeriesSibling(event, sibling) {
  if (normalizeDigestTitle(sibling?.title) !== normalizeDigestTitle(event?.title)) return false;
  const eventVenue = normalizeSeriesContext(event?.venue_name);
  const siblingVenue = normalizeSeriesContext(sibling?.venue_name);
  if (eventVenue && siblingVenue) return eventVenue === siblingVenue;
  const eventCity = normalizeSeriesContext(event?.city);
  const siblingCity = normalizeSeriesContext(sibling?.city);
  if (eventCity && siblingCity) return eventCity === siblingCity;
  return true;
}

/**
 * A series DEBUT is the FIRST occurrence — nothing else. When ingestion
 * fans a recurring series into many occurrence rows and each inherits
 * the debut text (so freshness_status = fresh_series_launch on all of
 * them), only the earliest-starting row in the ±90-day identity pool may
 * use the debut carve-out; occurrences 2..n of "weekly trivia (grand
 * opening!)" are routine again (owner spec 2026-07-28 — the carve-out
 * was letting every sibling through). Missing dates fail closed: a row
 * that can't prove it is first isn't a debut.
 */
function isFirstOccurrenceInPool(event, pool) {
  const title = normalizeDigestTitle(event?.title);
  if (!title) return true;
  const start = event?.start_at ? new Date(event.start_at).getTime() : NaN;
  if (Number.isNaN(start)) return false;
  return !(Array.isArray(pool) ? pool : []).some((sibling) => {
    if (String(sibling?.id) === String(event?.id)) return false;
    if (!isSameSeriesSibling(event, sibling)) return false;
    const siblingStart = sibling?.start_at ? new Date(sibling.start_at).getTime() : NaN;
    return !Number.isNaN(siblingStart) && siblingStart < start;
  });
}

// id -> row per pool array, so the survivor lookup below stays O(1).
const poolIdIndex = new WeakMap();
function poolRowById(pool, id) {
  if (!Array.isArray(pool)) return null;
  let index = poolIdIndex.get(pool);
  if (!index) {
    index = new Map(pool.filter(Boolean).map((row) => [String(row.id), row]));
    poolIdIndex.set(pool, index);
  }
  return index.get(String(id)) || null;
}

/**
 * True when `sibling` is a cross-source duplicate merged into a survivor
 * on the SAME ET day: the same happening, never independent evidence of a
 * distinct occurrence. event-dedup.js's pickSurvivor can keep either row of
 * a same-day, ≤30-minute-drift cross-source pair (event-duplicates.js's
 * tolerant matching), so a merged loser's start_at can land a few minutes
 * EARLIER than its own survivor's — counting it would disqualify the
 * survivor from being first-of-year (Codex P2, 2026-09-27).
 *
 * A merged row whose survivor now sits on a DIFFERENT day still counts
 * (Codex P2, round 20): a stable-ID feed can advance the survivor in place
 * to a later occurrence, leaving the merged loser as the only record of the
 * earlier one. `pool` must hold the survivor for the same-day comparison;
 * a survivor on the same day is in the same year, so any year pool that
 * holds the sibling holds it too, and a survivor absent from `pool` is on
 * another day. Mirrored in SQL by buildRoutineFirstOfYearAdmission.
 */
function isMergedAwaySibling(sibling, pool) {
  if (!sibling?.merged_into) return false;
  const survivor = poolRowById(pool, sibling.merged_into);
  return Boolean(survivor) && occurrenceDayKey(survivor) === occurrenceDayKey(sibling);
}

/**
 * Every occurrence of `event`'s identity found in `pool` (isSameSeriesSibling
 * — normalized title plus venue/city context), `event` itself included.
 * A recurrence_type='unknown' row has no reliable metadata of its own, so
 * isRecurringIdentityEvent needs this count to tell an actually-repeating
 * identity (the same Tuesday trivia night, week after week) from a genuine
 * one-off that merely lacks a recurrence label. Merged-away rows are
 * excluded — see isMergedAwaySibling.
 */
// Distinct occurrences, keyed by ET calendar day — not ingestion rows. Two
// unmerged feeds listing the same one-time event on the same day are ONE
// occurrence; otherwise a recurrence_type='unknown' one-time event would read
// as recurring and be dropped for lacking continuity before digest dedup runs.
//
// The SINGLE canonical definition of "which ET calendar day does this row's
// occurrence fall on" — every JS consumer that needs to compare or count
// occurrences (identityOccurrenceCount, isFirstOccurrenceOfYear's siblings
// filter) goes through this, so "same day" can never drift between them.
// The SQL mirror is buildRoutineFirstOfYearAdmission in event-freshness.js
// (`(start_at AT TIME ZONE 'America/New_York')::date`), which cannot share
// this JS function directly but implements the identical rule.
function occurrenceDayKey(row) {
  const t = row?.start_at ? new Date(row.start_at) : null;
  return t && !Number.isNaN(t.getTime()) ? etDateString(t) : `id:${row?.id}`;
}

function identityOccurrenceCount(event, pool) {
  const occurrences = new Set([occurrenceDayKey(event)]);
  for (const sibling of (Array.isArray(pool) ? pool : [])) {
    if (!sibling || String(sibling.id) === String(event?.id)) continue;
    if (isSameSeriesSibling(event, sibling) && !isMergedAwaySibling(sibling, pool)) {
      occurrences.add(occurrenceDayKey(sibling));
    }
  }
  return occurrences.size;
}

/**
 * Owner ruling 2026-09-27: "For recurring it should be the first event for
 * the year." An occurrence of a recurring identity is first-of-year only
 * when BOTH:
 *   (a) no other occurrence of the identity in `pool` starts earlier in the
 *       SAME ET calendar year, and
 *   (b) that is actually provable — prior-year continuity (a sibling in
 *       `pool` from the year before), explicit series-debut evidence, or —
 *       annual only, one occurrence per year by nature — simply not yet
 *       having proof it ran this year (the separate already-featured-this-
 *       year check in isEditoriallyNewEvent / isPreviouslyFeaturedIdentity
 *       covers the rest of that case).
 * Fails closed on every branch: a recurring identity that can't prove it is
 * first is excluded, never guessed into eligibility. `pool` must include
 * expired/rejected rows (they are still occurrence evidence) — see
 * loadYearIdentityPool — but a row MERGED into another identity is excluded
 * from the sibling comparison (isMergedAwaySibling): it's a cross-source
 * duplicate of whichever row survived the merge, not independent evidence of
 * a distinct occurrence date (Codex P2 — see isMergedAwaySibling).
 */
/**
 * Part (a) of the first-of-year rule on its own: a live same-identity sibling
 * falls on an EARLIER ET calendar day of the same ET year. The featured-history
 * gate uses it directly, because there the featured prior row is itself the
 * earlier-year evidence (part b).
 */
function hasEarlierOccurrenceThisYear(event, pool, reference = new Date()) {
  if (!event?.start_at) return false;
  const eventYear = etYearOf(event.start_at, reference);
  const eventDayKey = occurrenceDayKey(event);
  return (Array.isArray(pool) ? pool : []).some((sibling) => {
    if (!sibling || String(sibling.id) === String(event?.id)) return false;
    if (!isSameSeriesSibling(event, sibling) || isMergedAwaySibling(sibling, pool)) return false;
    if (!sibling.start_at || etYearOf(sibling.start_at, reference) !== eventYear) return false;
    const siblingDayKey = occurrenceDayKey(sibling);
    return siblingDayKey !== eventDayKey && siblingDayKey < eventDayKey;
  });
}

/**
 * Legacy continuity evidence for a row (or sibling) featured BEFORE
 * last_featured_occurrence_at existed (migration 20260928110000 — NULL on
 * every such row). last_featured_at is only the SEND time, and an issue
 * covers events up to FEATURED_ISSUE_LOOKAHEAD_MS after it ships, so the
 * featured occurrence's real date could fall anywhere in
 * [last_featured_at, last_featured_at + lookahead]. When that WHOLE window
 * still falls in the prior ET year, the occurrence certainly shipped last
 * year — genuine continuity. When the window crosses into the current ET
 * year (a send in the last FEATURED_ISSUE_LOOKAHEAD_MS of December), which
 * year it actually shipped in is ambiguous, so this fails closed and does
 * NOT count as continuity (Codex round 12, 2026-09-28).
 */
function hasLegacyContinuityEvidence(row, eventYear, reference = new Date()) {
  if (!row?.last_featured_at || row.last_featured_occurrence_at) return false;
  const lastFeatured = new Date(row.last_featured_at);
  if (Number.isNaN(lastFeatured.getTime())) return false;
  const lookaheadEnd = new Date(lastFeatured.getTime() + FEATURED_ISSUE_LOOKAHEAD_MS);
  return etYearOf(lastFeatured, reference) === eventYear - 1
    && etYearOf(lookaheadEnd, reference) === eventYear - 1;
}

/** A row's own feature history shows it shipped in the ET year just before
 * `eventYear`: its stamped occurrence, or legacy send-time evidence. */
function shippedInPriorEtYear(row, eventYear, reference = new Date()) {
  const stamped = row?.last_featured_occurrence_at;
  return (Boolean(stamped) && etYearOf(stamped, reference) === eventYear - 1)
    || hasLegacyContinuityEvidence(row, eventYear, reference);
}

function isFirstOccurrenceOfYear(event, pool, reference = new Date()) {
  if (!event?.start_at) return false;
  const start = new Date(event.start_at).getTime();
  if (Number.isNaN(start)) return false;
  const eventYear = etYearOf(event.start_at, reference);

  // Continuity evidence reads merged-away siblings too: a duplicate merged
  // into another source's survivor still carries the shipped-occurrence stamp
  // and its own past date. Merged rows are excluded only from occurrence
  // ordering (part a, hasEarlierOccurrenceThisYear).
  const evidenceSiblings = (Array.isArray(pool) ? pool : []).filter((sibling) => (
    sibling && String(sibling.id) !== String(event?.id)
      && isSameSeriesSibling(event, sibling)
  ));

  // Compare ET CALENDAR DAYS, not exact timestamps (Codex P2, 2026-09-27,
  // re-raised): two same-identity rows on the SAME ET day but a few minutes
  // apart (a showtime rounding difference, or two feeds reporting the same
  // occurrence at slightly different clock times) are the SAME occurrence —
  // neither is "earlier" than the other. A plain millisecond comparison
  // wrongly disqualified whichever of the pair happened to sort later, even
  // though it never actually lost to a genuinely distinct earlier occurrence.
  if (hasEarlierOccurrenceThisYear(event, pool, reference)) return false; // (a)

  // Continuity evidence: a same-identity row dated last ET year, or a shipped
  // occurrence stamped last year (last_featured_occurrence_at) on this row or
  // a sibling. The stamp matters because RSS/iCal feeds advance the same
  // GUID/UID row in place, leaving no separate prior-year row behind.
  //
  // Preserve continuity for pre-migration featured rows: last_featured_occurrence_at
  // is NULL on every row featured before migration 20260928110000, so a
  // recurring RSS/iCal row featured before that deploy and later advanced in
  // place into this year has no sibling and no occurrence stamp of its own —
  // hasLegacyContinuityEvidence recovers that evidence from last_featured_at
  // (fails closed on an ambiguous late-December send).
  const hasPriorYearOccurrence = shippedInPriorEtYear(event, eventYear, reference)
    || evidenceSiblings.some((sibling) => (Boolean(sibling.start_at) && etYearOf(sibling.start_at, reference) === eventYear - 1)
      || shippedInPriorEtYear(sibling, eventYear, reference));
  if (hasPriorYearOccurrence) return true; // (b) continuity

  if (event.freshness_status === 'fresh_series_launch' && isSeriesDebutEvent(event)) return true; // (b) debut

  if (isAnnualEvent(event)) return true; // (b) annual — one per year by nature

  return false; // fail closed: can't prove it, so it isn't
}

/**
 * Broad pool for the calendar-year first-occurrence rule. Unlike
 * loadRoutineIdentityPool this (1) spans full ET calendar years — "did it
 * run last year", "is anything else this identity earlier THIS year" both
 * need whole-year visibility, not a rolling ±90-day window — and (2)
 * INCLUDES merged/rejected/expired rows: a duplicate merged into this same
 * identity, or a listing that later expired, is still real evidence the
 * identity occurred on that date. Identity matching (isSameSeriesSibling,
 * keyed on each row's OWN stored title/venue/city) naturally excludes a row
 * that was actually merged into an unrelated identity, since that row's own
 * fields — never the merge target's — are what get compared.
 */
async function loadYearIdentityPool(knex, events, reference = new Date()) {
  const rows = Array.isArray(events) ? events : [];
  const years = [etYearOf(reference, reference)];
  for (const event of rows) {
    if (event?.start_at) years.push(etYearOf(event.start_at, reference));
  }
  const minYear = Math.min(...years) - 1; // the prior year, for continuity
  const maxYear = Math.max(...years);
  return knex('events_raw')
    // Recurrence metadata rides along: identityIsRecurring reads a sibling's
    // event_type / recurrence_type / description to inherit last year's
    // recurring label.
    .select('id', 'title', 'start_at', 'venue_name', 'city', 'merged_into',
      'event_type', 'recurrence_type', 'description', 'last_featured_occurrence_at', 'last_featured_at')
    .where('start_at', '>=', parseETDateTime(`${minYear}-01-01T00:00:00`))
    .where('start_at', '<=', parseETDateTime(`${maxYear}-12-31T23:59:59`));
}

/** Cheap, over-inclusive check for whether any row in a batch could possibly
 * need the calendar-year pool, so a batch of plain one-time events never
 * pays for (or, in tests, unexpectedly triggers) the extra DB round trip. */
/**
 * Whether an identity is recurring: the row's own metadata, pool-derived
 * repeat evidence, OR any live same-identity row in the year pool labeled
 * recurring. A re-scrape can normalize this year's rows as one_time while
 * last year's rows said weekly/annual; planning and final validation both
 * call this, so they agree on it.
 */
function identityIsRecurring(event, pool, occurrenceCount) {
  if (isRecurringIdentityEvent(event, { occurrenceCount })) return true;
  return (Array.isArray(pool) ? pool : []).some((sibling) => (
    sibling
    && String(sibling.id) !== String(event?.id)
    && isSameSeriesSibling(event, sibling)
    && !isMergedAwaySibling(sibling, pool)
    && isRecurringIdentityEvent(sibling, { occurrenceCount })
  ));
}

/**
 * Load the calendar-year identity pool ONCE for a batch of candidate rows,
 * for every eligibility filter in that batch's pipeline to share instead of
 * each loading (and paying for) its own copy. Every batch-level caller —
 * event-curation.js's runCurationEligibilityPipeline, newsletter-autopilot.js's
 * buildDigestPlan, newsletter-draft.js's draft-loading query, and the admin
 * planner/approved-ids routes — calls this once and threads the result into
 * filterRepeatedDateIdentities / filterPreviouslyFeaturedIdentities /
 * assessFlagshipEventSelection via their `yearPool` option (Codex P2,
 * 2026-09-27: "Reuse the calendar-year pool across eligibility filters").
 * Returns `[]` (no DB round trip) only for an empty batch.
 */
async function loadSharedYearPool(knex, rows, reference = new Date()) {
  // Always loaded for a non-empty batch: a row labeled one_time can still be
  // a recurring identity through last year's rows (identityIsRecurring).
  return Array.isArray(rows) && rows.length ? loadYearIdentityPool(knex, rows, reference) : [];
}

/**
 * The ONE recurrence-policy stage shared by planning (filterRepeatedDateIdentities)
 * and final send validation (assessFlagshipEventSelection), so the two can
 * never re-derive a different verdict for the same event (Codex round 12,
 * 2026-09-28 — the two re-deriving the same decisions independently is what
 * kept letting a structural finding reappear).
 *
 * `debut`: when the caller already has pool-position-verified debut evidence
 * (assessFlagshipEventSelection's issue-window pool — a stricter check than
 * the plain classification test below, since it also confirms this row is
 * the earliest in that pool), pass it through and it's used as-is. Otherwise
 * this derives the plain (unpositioned) debut-evidence check — the same one
 * isFirstOccurrenceOfYear's own continuity check and the starred-row
 * carve-out use.
 *
 * Returns the pool-verified markers exactly as planning stamps them today:
 * `__recurrenceOccurrenceCount` always rides along (isEligibleForFreshDigest
 * needs it to recognize a repeated recurrence_type='unknown' identity as
 * recurring at all); `__identityRecurring` only when the identity is
 * recurring; `__recurringFirstOfYear` only for a continuity-proven ROUTINE
 * row that isn't debut-proven (a verified debut needs no continuity marker —
 * its own classification already clears isEligibleForFreshDigest's routine
 * hard block).
 */
function evaluateRecurrence(event, { yearPool = [], reference = new Date(), debut = null } = {}) {
  const occurrenceCount = identityOccurrenceCount(event, yearPool);
  const isRecurringIdentity = identityIsRecurring(event, yearPool, occurrenceCount);
  const firstOfYear = isRecurringIdentity ? isFirstOccurrenceOfYear(event, yearPool, reference) : true;
  const isDebut = debut != null
    ? Boolean(debut)
    : (event?.freshness_status === 'fresh_series_launch' && isSeriesDebutEvent(event));

  const markers = {
    __recurrenceOccurrenceCount: occurrenceCount,
    ...(isRecurringIdentity ? { __identityRecurring: true } : {}),
    ...(isRecurringIdentity && firstOfYear && !isDebut && isRoutineRecurringEvent(event)
      ? { __recurringFirstOfYear: true } : {}),
  };

  return { occurrenceCount, isRecurringIdentity, firstOfYear, debut: isDebut, markers };
}

/**
 * The ONE predicate that exempts a recurring identity from the same-issue
 * repeated-title rejection, shared verbatim by the planning filter
 * (filterRepeatedDateIdentities, below — reaching this branch never even
 * consults repeatedTitles) and the final proof/send gate
 * (assessFlagshipEventSelection). A recurring identity that has proven it is
 * first-of-year is, by construction, going to have OTHER dated siblings of
 * the same normalized title somewhere in the pool (that's what "recurring"
 * means) — repeatedDateTitleKeys has no way to tell those apart from a
 * mislabeled one-off repeated by ingestion error, so recurring identities
 * are exempted from it entirely and rely on isFirstOccurrenceOfYear /
 * isPreviouslyFeaturedIdentity instead.
 *
 * Codex P1, 2026-09-27: assessFlagshipEventSelection used to apply the
 * repeated-title rejection unconditionally (except for a star or a debut),
 * so a continuity-proven (non-debut) weekly/monthly first-of-year
 * occurrence — admitted by planning — failed final validation the moment
 * any later sibling of the same series existed anywhere in the reloaded
 * ±90-day pool, which for an actual weekly series is always.
 */
function isRecurringFirstOfYearExempt(isRecurringIdentity, firstOfYear) {
  return Boolean(isRecurringIdentity && firstOfYear);
}

/**
 * DB-backed routine-identity gate shared by planning and final validation.
 * The bounded ±90-day horizon catches next week's sibling and a prior-only
 * sibling (including a rejected row, which is still recurrence evidence)
 * even when only this week's occurrence was selected into the draft.
 */
async function filterRepeatedDateIdentities(
  events,
  { knex = db, reference = new Date(), identityPool = null, yearPool = identityPool } = {},
) {
  const rows = Array.isArray(events) ? events : [];
  if (!rows.length) return [];
  const pool = identityPool || await loadRoutineIdentityPool(knex, reference);
  const repeatedTitles = repeatedDateTitleKeys(pool);
  const calendarYearPool = yearPool || await loadSharedYearPool(knex, rows, reference);

  return rows.map((event) => {
    // Two carve-outs survive the repeated-title exclusion: an operator STAR
    // (deliberate editorial override, consumed on ship) and the single-use
    // series DEBUT — whose own later occurrences share its normalized title
    // in the ±90-day pool, which is exactly what this filter keys on; an
    // inaugural weekly market would otherwise never reach the digest. The
    // debut carve-out applies ONLY to the series' first occurrence in the
    // pool. Both remain subject to every row-level gate
    // (isEligibleForFreshDigest).
    // Owner ruling 2026-09-27: ANY recurring identity — including the
    // annual/seasonal/unknown-with-repeats types the routine list above
    // never covered — is eligible only for its first occurrence of the ET
    // calendar year. evaluateRecurrence is the ONE stage that decides this,
    // shared with assessFlagshipEventSelection so the two can't diverge.
    const rec = evaluateRecurrence(event, { yearPool: calendarYearPool, reference });

    if (event?.admin_status === 'featured') {
      // The star bypasses this filter's drops, but still carries the same
      // verified recurrence evidence final validation computes, so the
      // downstream isEligibleForFreshDigest check judges a starred
      // continuity-proven series exactly as validation will.
      return rec.isRecurringIdentity ? { ...event, ...rec.markers } : event;
    }

    if (rec.isRecurringIdentity) {
      // Reaching here already proves isRecurringFirstOfYearExempt(true, firstOfYear)
      // decides this branch's fate — spelled out via the shared predicate so
      // this stays provably the same rule assessFlagshipEventSelection uses,
      // not a parallel re-implementation.
      if (!isRecurringFirstOfYearExempt(rec.isRecurringIdentity, rec.firstOfYear)) return null;
      // Debut evidence alone already proves recurring-ness (isRoutineRecurring
      // Event's own metadata check) — no marker needed, and object identity
      // is preserved unchanged, same as the plain debut carve-out below.
      if (rec.debut) return event;
      // Continuity (routine) or annual/seasonal/unknown-with-repeats: stamp
      // the pool-verified markers isEligibleForFreshDigest also accepts.
      return { ...event, ...rec.markers };
    }

    if (event?.freshness_status === 'fresh_series_launch' && isSeriesDebutEvent(event)
        && isFirstOccurrenceInPool(event, pool)) return event;
    if (repeatedTitles.has(normalizeDigestTitle(event?.title))) return null;
    return event;
  }).filter(Boolean);
}

/**
 * Whether one locked event, already resolved to its recurrence verdict
 * (`rec`, from evaluateRecurrence) and its issue-window facts (`ctx`), still
 * clears every final-validation gate. Split out of assessFlagshipEventSelection's
 * loop body purely to keep that loop's own complexity low — same checks, same
 * order, same short-circuiting.
 */
function isLockedEventStillEligible(event, rec, ctx) {
  const {
    approved, inIssueWindow, starred, debut, repeatedTitles, featuredHistory, reference, yearIdentityPool,
    eligibilityCheckEvent,
  } = ctx;

  if (!approved || !inIssueWindow) return false;

  // Codex P1, 2026-09-27: a verified recurring first-of-year occurrence is
  // exempt from the repeated-title rejection here exactly as it is in
  // filterRepeatedDateIdentities (isRecurringFirstOfYearExempt) — without
  // this, a continuity-proven weekly/monthly row that planning already
  // admitted fails final validation the instant a later sibling of the
  // same series exists anywhere in the reloaded pool, which for a real
  // recurring series is always.
  if (!starred && !debut && !isRecurringFirstOfYearExempt(rec.isRecurringIdentity, rec.firstOfYear)
      && repeatedTitles.has(normalizeDigestTitle(event.title))) return false;

  if (!starred && rec.isRecurringIdentity && !rec.firstOfYear) return false;

  if (!isEligibleForFreshDigest(eligibilityCheckEvent, reference)) return false;

  if (!starred && isPreviouslyFeaturedIdentity(event, featuredHistory, reference, {
    occurrenceCount: rec.occurrenceCount,
    identityRecurring: rec.isRecurringIdentity,
    firstOfYear: !hasEarlierOccurrenceThisYear(event, yearIdentityPool, reference),
    provenFirstOfYear: isFirstOccurrenceOfYear(event, yearIdentityPool, reference),
  })) return false;

  return true;
}

/**
 * Resolve one locked event's issue-window facts, recurrence verdict, and
 * final eligibility in one place — the per-event work
 * assessFlagshipEventSelection's loop used to do inline, split out purely to
 * keep that loop's own complexity low (same checks, same order).
 */
function resolveLockedEventEligibility(event, {
  windowStart, windowEnd, issueIdentityPool, yearIdentityPool, reference, featuredHistory, repeatedTitles,
}) {
  const start = event.start_at ? new Date(event.start_at) : null;
  const inIssueWindow = start && !Number.isNaN(start.getTime())
    && start >= windowStart && start <= windowEnd;
  const approved = ['approved', 'featured'].includes(event.admin_status);
  // Same carve-outs as the planning filters, or the final proof/send gate
  // would reject a lineup planning deliberately admitted: a STAR bypasses
  // the repeated-title and identity-history checks; a series DEBUT bypasses
  // repeated-title only (prior shipped history disproves debut). This debut
  // check is pool-POSITION-verified (isFirstOccurrenceInPool against the
  // issue window pool) — stricter than evaluateRecurrence's own plain
  // classification check — since final validation is the last line of
  // defense; passed into evaluateRecurrence so its markers agree.
  const starred = event.admin_status === 'featured';
  const debut = event.freshness_status === 'fresh_series_launch' && isSeriesDebutEvent(event)
    && isFirstOccurrenceInPool(event, issueIdentityPool);

  // Owner ruling 2026-09-27: any recurring identity — including the
  // annual/seasonal/unknown-with-repeats types the repeated-title check
  // above never covered — is eligible only for its first occurrence of the
  // ET calendar year. evaluateRecurrence is the ONE stage that decides this,
  // shared with filterRepeatedDateIdentities so the two can't diverge.
  const rec = evaluateRecurrence(event, { yearPool: yearIdentityPool, reference, debut });
  const eligibilityCheckEvent = { ...event, ...rec.markers };

  return isLockedEventStillEligible(event, rec, {
    approved, inIssueWindow, starred, debut, repeatedTitles, featuredHistory, reference, yearIdentityPool,
    eligibilityCheckEvent,
  });
}

function assessFlagshipEventSelection(
  send,
  rows,
  reference = new Date(),
  featuredHistory = [],
  issueIdentityPool = rows,
  yearIdentityPool = issueIdentityPool,
) {
  if (!isFlagshipType(send?.newsletter_type)) {
    return { valid: true, errors: [], events: [], flagship: false };
  }

  const ids = parseLockedEventIds(send.event_ids);
  const errors = [];
  if (!ids.length) {
    return { valid: false, errors: ['Flagship draft has no locked event ids.'], events: [], flagship: true };
  }
  if (ids.some((id) => !UUID_RE.test(id))) {
    return { valid: false, errors: ['Flagship draft contains an invalid locked event id.'], events: [], flagship: true };
  }
  if (new Set(ids).size !== ids.length) errors.push('Flagship draft repeats a locked event id.');

  const byId = new Map((Array.isArray(rows) ? rows : []).map((row) => [String(row.id), row]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  if (ordered.length !== new Set(ids).size) errors.push('One or more locked events no longer exist.');

  const issueTuesday = getActiveNewsletterTuesday(reference);
  const windowStart = parseETDateTime(`${issueTuesday}T00:00:00`);
  const windowEnd = parseETDateTime(`${etDateString(addETDays(windowStart, 6))}T23:59:59`);
  const repeatedTitles = repeatedDateTitleKeys(issueIdentityPool);
  const eligible = [];
  for (const event of ordered) {
    const eligibleEvent = resolveLockedEventEligibility(event, {
      windowStart, windowEnd, issueIdentityPool, yearIdentityPool, reference, featuredHistory, repeatedTitles,
    });
    if (!eligibleEvent) {
      errors.push(`Locked event is no longer eligible: ${event.title || event.id}.`);
      continue;
    }
    eligible.push(event);
  }

  if (dedupeDigestEvents(eligible).length !== eligible.length) {
    errors.push('Flagship draft contains duplicate event identities.');
  }

  return { valid: errors.length === 0, errors, events: eligible, flagship: true };
}

/**
 * Pre-engine sends have newsletter_type=NULL. A legacy row linked from the
 * flagship calendar is still a flagship and must not bypass cadence/lineup
 * gates merely because its type predates the registry. Undefined is kept
 * distinct for old test fixtures and unsaved objects; only persisted NULL
 * rows with a calendar relationship are promoted.
 */
async function isFlagshipSend(send, { knex = db } = {}) {
  if (isFlagshipType(send?.newsletter_type)) return true;
  if (send?.newsletter_type !== null || !send?.id) return false;
  const linked = await knex('newsletter_calendar').where({ send_id: send.id }).first('id');
  return Boolean(linked);
}

async function validateFlagshipEventSelection(send, { knex = db, reference = new Date() } = {}) {
  const flagship = await isFlagshipSend(send, { knex });
  if (!flagship) return { valid: true, errors: [], events: [], flagship: false };
  const typedSend = isFlagshipType(send?.newsletter_type)
    ? send
    : { ...send, newsletter_type: FLAGSHIP_TYPE_KEY };
  const ids = parseLockedEventIds(send.event_ids);
  if (!ids.length || ids.some((id) => !UUID_RE.test(id))) {
    return assessFlagshipEventSelection(typedSend, [], reference);
  }

  const rows = await knex('events_raw')
    .select(
      'id', 'title', 'description', 'admin_status', 'start_at', 'end_at',
      'event_url', 'event_type', 'recurrence_type', 'freshness_status',
      'times_featured', 'last_featured_at', 'last_featured_occurrence_at', 'pulled_at', 'merged_into',
      // Series context for isSameSeriesSibling — without these the final
      // gate compares a context-free locked row against the context-rich
      // pool and rejects a lineup planning accepted.
      'venue_name', 'city',
    )
    .whereIn('id', [...new Set(ids)]);
  const featuredHistory = await loadFeaturedIdentityHistory(knex);
  const routineIdentityPool = await loadRoutineIdentityPool(knex, reference);
  const yearIdentityPool = await loadSharedYearPool(knex, rows, reference);
  return assessFlagshipEventSelection(
    typedSend, rows, reference, featuredHistory, routineIdentityPool, yearIdentityPool,
  );
}

module.exports = {
  parseLockedEventIds,
  occurrenceDayKey,
  isSameSeriesSibling,
  isFirstOccurrenceInPool,
  isMergedAwaySibling,
  isRecurringFirstOfYearExempt,
  identityOccurrenceCount,
  identityIsRecurring,
  hasEarlierOccurrenceThisYear,
  hasLegacyContinuityEvidence,
  isFirstOccurrenceOfYear,
  evaluateRecurrence,
  loadYearIdentityPool,
  loadSharedYearPool,
  isPreviouslyFeaturedIdentity,
  loadFeaturedIdentityHistory,
  filterPreviouslyFeaturedIdentities,
  repeatedDateTitleKeys,
  loadRoutineIdentityPool,
  filterRepeatedDateIdentities,
  assessFlagshipEventSelection,
  isFlagshipSend,
  validateFlagshipEventSelection,
};
