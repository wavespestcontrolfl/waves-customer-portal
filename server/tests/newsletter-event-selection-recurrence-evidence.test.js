/**
 * Two Codex P2 findings (2026-09-27) on newsletter-event-selection.js:
 *
 * 1. (line 75) "Preserve repeat evidence through feature-history checks":
 *    for recurrence_type='unknown', isPreviouslyFeaturedIdentity and
 *    isEligibleForFreshDigest called isRecurringIdentityEvent WITHOUT
 *    occurrenceCount, so a repeated-unknown identity featured last year was
 *    treated as one-time and blocked FOREVER instead of getting the
 *    calendar-year refresh a genuinely recurring identity earns.
 *
 * 2. (line 242) "Exclude merged copies from occurrence ordering": the year
 *    identity pool includes merged-away rows; if pickSurvivor (event-dedup.js)
 *    keeps the LATER of two same-day cross-source duplicates, the earlier
 *    merged loser was counted as a distinct "earlier this year" occurrence
 *    and wrongly excluded its own survivor from being first-of-year.
 */

const {
  isPreviouslyFeaturedIdentity,
  filterPreviouslyFeaturedIdentities,
  identityOccurrenceCount,
  isFirstOccurrenceOfYear,
  isMergedAwaySibling,
} = require('../services/newsletter-event-selection');
const { isRecurringIdentityEvent, isEligibleForFreshDigest } = require('../services/event-freshness');

const REFERENCE = new Date('2026-07-20T12:00:00Z');

describe('P2 #75: recurrence_type=unknown feature history needs pool-derived occurrenceCount', () => {
  const priorFeatured = {
    id: 'prior', title: 'Community Trivia Night', times_featured: 1, last_featured_at: '2025-04-05T22:00:00Z',
  };
  const candidate = {
    id: 'this-year',
    title: 'Community Trivia Night',
    recurrence_type: 'unknown',
    event_type: 'one_time',
    start_at: '2026-04-04T22:00:00Z',
  };

  test('isRecurringIdentityEvent itself defaults an unknown-recurrence row to one-time without occurrenceCount (the root cause)', () => {
    expect(isRecurringIdentityEvent(candidate)).toBe(false);
    expect(isRecurringIdentityEvent(candidate, { occurrenceCount: 2 })).toBe(true);
  });

  test('without pool evidence, isPreviouslyFeaturedIdentity blocks the identity forever (fails closed toward NOT granting the recurring refresh)', () => {
    expect(isPreviouslyFeaturedIdentity(candidate, [priorFeatured], REFERENCE)).toBe(true);
  });

  test('with pool-derived occurrenceCount (this identity genuinely repeated), the SAME identity is correctly re-admitted after a new ET year', () => {
    // This is the fix: passing real occurrence evidence changes the verdict
    // from "blocked forever" to "eligible again" — exactly the calendar-year
    // refresh a recurring identity is supposed to get (owner ruling
    // 2026-09-27), which recurrence_type='unknown' alone could never prove.
    expect(isPreviouslyFeaturedIdentity(candidate, [priorFeatured], REFERENCE, { occurrenceCount: 2 })).toBe(false);
  });

  test('filterPreviouslyFeaturedIdentities computes occurrenceCount from the year pool and re-admits the identity end to end', async () => {
    const query = {
      select: jest.fn(),
      where: jest.fn(),
      then: (resolve, reject) => Promise.resolve([priorFeatured]).then(resolve, reject),
    };
    query.select.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const knex = jest.fn(() => query);

    // A second occurrence of the SAME identity elsewhere in the year pool is
    // what proves it actually repeats (recurrence_type='unknown' carries no
    // metadata of its own).
    const secondOccurrence2026 = { id: 'sib', title: 'Community Trivia Night', start_at: '2026-04-11T22:00:00Z' };

    const rows = await filterPreviouslyFeaturedIdentities([candidate], {
      knex,
      reference: REFERENCE,
      yearPool: [candidate, secondOccurrence2026, priorFeatured],
    });
    expect(rows).toEqual([candidate]);
  });

  test('filterPreviouslyFeaturedIdentities correctly keeps blocking a GENUINE one-time identity (no false positive from the fix)', async () => {
    // Distinct venues so isSameSeriesSibling correctly treats these as
    // unrelated same-titled events, not the SAME recurring identity — two
    // different one-time "Downtown Chalk Festival" happenings, one per year,
    // are not evidence of a recurring series.
    const trulyOneTime = {
      id: 'one-time', title: 'Downtown Chalk Festival', recurrence_type: 'unknown', event_type: 'one_time', start_at: '2026-08-01T22:00:00Z', venue_name: 'Main Street Plaza',
    };
    const priorOneTime = {
      id: 'prior-one-time', title: 'Downtown Chalk Festival', times_featured: 1, last_featured_at: '2025-08-01T22:00:00Z', venue_name: 'City Hall Lawn',
    };
    const query = {
      select: jest.fn(),
      where: jest.fn(),
      then: (resolve, reject) => Promise.resolve([priorOneTime]).then(resolve, reject),
    };
    query.select.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const knex = jest.fn(() => query);

    // No second occurrence anywhere in the pool — occurrenceCount stays 1,
    // isRecurringIdentityEvent stays false, and the one-time block still
    // applies forever.
    const rows = await filterPreviouslyFeaturedIdentities([trulyOneTime], {
      knex, reference: REFERENCE, yearPool: [trulyOneTime, priorOneTime],
    });
    expect(rows).toEqual([]);
  });
});

describe('P2 #75 companion: isEligibleForFreshDigest reads the __recurrenceOccurrenceCount pool marker', () => {
  // A featured-featured-history-free version of the same scenario, exercised
  // directly against isEligibleForFreshDigest (event-freshness.js) — the
  // pure, pool-less function that needs a caller (filterRepeatedDateIdentities
  // / assessFlagshipEventSelection) to stamp this marker before calling in.
  const featuredLastYear = (overrides = {}) => ({
    id: 'this-year',
    title: 'Community Trivia Night',
    recurrence_type: 'unknown',
    event_type: 'one_time',
    admin_status: 'approved',
    event_url: 'https://events.example/trivia',
    freshness_status: 'fresh_one_time',
    start_at: '2026-04-04T22:00:00Z',
    times_featured: 1,
    last_featured_at: '2025-04-05T22:00:00Z',
    merged_into: null,
    ...overrides,
  });

  // isEligibleForFreshDigest also hard-requires the event to be future-dated
  // relative to its reference — use a reference just before the fixture's
  // April 4 2026 start_at (the module-level REFERENCE above is July 2026,
  // fine for the pool-only tests but "past" for this one).
  const BEFORE_START = new Date('2026-03-01T12:00:00Z');

  test('without the marker, a repeated-unknown identity featured last year is blocked forever (same root cause as isEditoriallyNewEvent)', () => {
    expect(isEligibleForFreshDigest(featuredLastYear(), BEFORE_START)).toBe(false);
  });

  test('with the pool-verified __recurrenceOccurrenceCount marker, the SAME row correctly gets the calendar-year refresh', () => {
    expect(isEligibleForFreshDigest(featuredLastYear({ __recurrenceOccurrenceCount: 2 }), BEFORE_START)).toBe(true);
  });
});

describe('P2 #242: a merged-away duplicate must not count as a separate occurrence', () => {
  // Mirrors event-dedup.js's pickSurvivor keeping the LATER of a same-day,
  // cross-source pair within the 30-minute dedup tolerance (event-duplicates.js).
  const survivor = { id: 'b', title: 'Riverside Trivia', start_at: '2026-04-04T20:15:00Z' };
  const mergedLoser = {
    id: 'a', title: 'Riverside Trivia', start_at: '2026-04-04T20:00:00Z', merged_into: 'b',
  };

  test('isMergedAwaySibling identifies a merged loser', () => {
    expect(isMergedAwaySibling(mergedLoser)).toBe(true);
    expect(isMergedAwaySibling(survivor)).toBe(false);
  });

  test('identityOccurrenceCount excludes the merged loser from the count', () => {
    expect(identityOccurrenceCount(survivor, [survivor, mergedLoser])).toBe(1);
    // A genuinely separate (unmerged) second occurrence still counts.
    const realSecond = { id: 'c', title: 'Riverside Trivia', start_at: '2026-04-11T20:15:00Z' };
    expect(identityOccurrenceCount(survivor, [survivor, mergedLoser, realSecond])).toBe(2);
  });

  test('isFirstOccurrenceOfYear is not fooled by a same-day merged duplicate whose start_at reads earlier than its own survivor', () => {
    const priorYear = { id: 'prior', title: 'Riverside Trivia', start_at: '2025-04-05T20:15:00Z' };
    const pool = [priorYear, survivor, mergedLoser];
    // Before this fix: mergedLoser.start_at (20:00) < survivor.start_at
    // (20:15), same ET year -> hasEarlierThisYear would wrongly be true,
    // excluding the survivor from ever being first-of-year even though it's
    // proven by real prior-year continuity.
    expect(isFirstOccurrenceOfYear(survivor, pool, REFERENCE)).toBe(true);
  });

  test('a GENUINE earlier occurrence (unmerged) still correctly excludes first-of-year — the fix only ignores merged rows', () => {
    const genuineEarlier = { id: 'd', title: 'Riverside Trivia', start_at: '2026-01-10T20:15:00Z' };
    const pool = [genuineEarlier, survivor];
    expect(isFirstOccurrenceOfYear(survivor, pool, REFERENCE)).toBe(false);
  });
});
