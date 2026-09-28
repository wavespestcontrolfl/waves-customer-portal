/**
 * Owner ruling 2026-09-27: "For recurring it should be the first event for
 * the year." A recurring identity — any series (daily/weekly/monthly/custom/
 * seasonal/annual recurrence, or event_type recurring_series/ongoing) — is
 * newsletter-eligible ONLY for its first occurrence of the ET calendar year,
 * proven by prior-year continuity, series-debut evidence, or (annual only)
 * simply not having run yet this year. An identity already featured in the
 * SAME calendar year is never eligible again that year (replaces the old
 * 300-day annual-only cooldown). Non-recurring one-time events are
 * unaffected. See event-freshness.js and newsletter-event-selection.js.
 */

const {
  isEligibleForFreshDigest,
  isEditoriallyNewEvent,
  isRecurringIdentityEvent,
  etYearOf,
} = require('../services/event-freshness');
const {
  filterRepeatedDateIdentities,
  filterPreviouslyFeaturedIdentities,
  identityOccurrenceCount,
  isPreviouslyFeaturedIdentity,
  assessFlagshipEventSelection,
} = require('../services/newsletter-event-selection');

const REFERENCE = new Date('2026-07-20T12:00:00Z'); // Monday, mid-2026

function weeklyEvent(id, overrides = {}) {
  return {
    id,
    title: 'Riverside Farmers Market',
    description: 'Fresh produce, local vendors, and live music every Saturday.',
    admin_status: 'approved',
    event_url: `https://events.example/${id}`,
    event_type: 'recurring_series',
    recurrence_type: 'weekly',
    freshness_status: 'stale_recurring',
    times_featured: 0,
    last_featured_at: null,
    merged_into: null,
    ...overrides,
  };
}

describe('recurring identities: first occurrence of the ET calendar year only', () => {
  test('weekly series: first occurrence of the year, proven by prior-year continuity, is eligible', async () => {
    const priorYear = weeklyEvent('prior-2025', { start_at: '2025-08-02T14:00:00Z' });
    const first = weeklyEvent('first-2026', { start_at: '2026-01-10T14:00:00Z' });
    const second = weeklyEvent('second-2026', { start_at: '2026-01-17T14:00:00Z' });

    const rows = await filterRepeatedDateIdentities([first, second], {
      reference: REFERENCE,
      identityPool: [priorYear, first, second],
      yearPool: [priorYear, first, second],
    });

    // Test 2 (second occurrence excluded) is asserted in the SAME run —
    // both the continuity carve-out and the once-per-year exclusion are two
    // sides of the same pool-based check.
    expect(rows.map((row) => row.id)).toEqual(['first-2026']);
    // Continuity (not debut wording) proved it — isEligibleForFreshDigest's
    // routine hard-block only recognizes debut evidence on its own, so the
    // filter stamps the pool-verified marker it also accepts.
    expect(rows[0].__recurringFirstOfYear).toBe(true);
    // isEligibleForFreshDigest's own future-dated check needs a reference
    // before the occurrence — REFERENCE (July) is only for the pool-based
    // identity comparisons above, which don't care about past/future.
    expect(isEligibleForFreshDigest(rows[0], new Date('2026-01-05T12:00:00Z'))).toBe(true);
  });

  test('weekly series with no prior-year history and no debut evidence is excluded (fail closed)', async () => {
    const onlyOccurrence = weeklyEvent('only-2026', { start_at: '2026-03-07T14:00:00Z' });
    const laterSibling = weeklyEvent('later-2026', { start_at: '2026-03-14T14:00:00Z' });

    const rows = await filterRepeatedDateIdentities([onlyOccurrence], {
      reference: REFERENCE,
      identityPool: [onlyOccurrence, laterSibling],
      yearPool: [onlyOccurrence, laterSibling],
    });

    expect(rows).toEqual([]);
  });

  test('series-debut evidence makes the first occurrence eligible once, even with no prior-year history', async () => {
    const debut = weeklyEvent('debut-2026', {
      title: 'Riverside Night Market',
      description: 'Grand opening of our new weekly night market!',
      freshness_status: 'fresh_series_launch',
      start_at: '2026-05-02T22:00:00Z',
    });
    const laterOccurrence = {
      ...debut,
      id: 'later-debut-2026',
      start_at: '2026-05-09T22:00:00Z',
    };

    const rows = await filterRepeatedDateIdentities([debut, laterOccurrence], {
      reference: REFERENCE,
      identityPool: [debut, laterOccurrence],
      yearPool: [debut, laterOccurrence],
    });

    expect(rows.map((row) => row.id)).toEqual(['debut-2026']);
    // Debut evidence is already recognized by the existing mechanism — no
    // marker needed, object identity is preserved.
    expect(rows[0]).toBe(debut);
  });

  test('recurrence_type "unknown" is treated as recurring only once it actually repeats — only the first occurrence of the year survives', async () => {
    const unknownFirst = {
      id: 'unknown-first',
      title: 'Community Trivia Night',
      description: 'Test your knowledge downtown.',
      admin_status: 'approved',
      event_url: 'https://events.example/unknown-first',
      event_type: 'one_time',
      recurrence_type: 'unknown',
      freshness_status: 'fresh_one_time',
      times_featured: 0,
      last_featured_at: null,
      merged_into: null,
      start_at: '2026-04-04T22:00:00Z',
    };
    const unknownSecond = { ...unknownFirst, id: 'unknown-second', start_at: '2026-04-11T22:00:00Z' };
    const unknownPriorYear = { ...unknownFirst, id: 'unknown-prior-2025', start_at: '2025-04-05T22:00:00Z' };

    expect(isRecurringIdentityEvent(unknownFirst, { occurrenceCount: 1 })).toBe(false);
    expect(isRecurringIdentityEvent(unknownFirst, { occurrenceCount: 2 })).toBe(true);

    const rows = await filterRepeatedDateIdentities([unknownFirst, unknownSecond], {
      reference: REFERENCE,
      identityPool: [unknownFirst, unknownSecond, unknownPriorYear],
      yearPool: [unknownFirst, unknownSecond, unknownPriorYear],
    });

    expect(rows.map((row) => row.id)).toEqual(['unknown-first']);
  });

  test('a one-time, non-recurring event is unaffected by the calendar-year rule', async () => {
    const oneTime = {
      id: 'one-time-1',
      title: 'Downtown Chalk Festival',
      admin_status: 'approved',
      event_url: 'https://events.example/chalk-festival',
      event_type: 'one_time',
      recurrence_type: 'none',
      freshness_status: 'fresh_one_time',
      times_featured: 0,
      last_featured_at: null,
      merged_into: null,
      start_at: '2026-10-03T14:00:00Z',
    };

    expect(isRecurringIdentityEvent(oneTime)).toBe(false);
    const rows = await filterRepeatedDateIdentities([oneTime], {
      reference: REFERENCE,
      identityPool: [oneTime],
      yearPool: [oneTime],
    });
    expect(rows).toEqual([oneTime]);
    expect(isEligibleForFreshDigest(oneTime, REFERENCE)).toBe(true);
  });

  test('ET Jan 1 boundary: 2027-01-01T03:00:00Z is still 2026 in ET', () => {
    expect(etYearOf('2027-01-01T03:00:00Z')).toBe(2026);
    expect(etYearOf('2027-01-01T05:30:00Z')).toBe(2027); // 12:30 AM ET, genuinely 2027
  });

  test('ET year boundary groups a UTC-early-Jan event with the prior ET year, not calendar 2027', async () => {
    const decemberOccurrence = weeklyEvent('dec-2026', { start_at: '2026-12-05T14:00:00Z' }); // Dec 5 2026, 9am ET
    // 2027-01-01T03:00:00Z is Dec 31 2026, 10pm ET — the SAME ET year as
    // decemberOccurrence, even though its raw UTC stamp already reads 2027.
    const boundaryOccurrence = weeklyEvent('boundary', { start_at: '2027-01-01T03:00:00Z' });

    const rows = await filterRepeatedDateIdentities([boundaryOccurrence], {
      reference: REFERENCE,
      identityPool: [decemberOccurrence, boundaryOccurrence],
      yearPool: [decemberOccurrence, boundaryOccurrence],
    });

    // boundaryOccurrence has an earlier-same-ET-year sibling, so it is NOT
    // first of the (ET) year.
    expect(rows).toEqual([]);
  });
});

describe('annual identities: eligible only once per ET calendar year (replaces the 300-day cooldown)', () => {
  const annualEvent = (overrides = {}) => ({
    admin_status: 'approved',
    event_url: 'https://events.example/founders-day',
    event_type: 'annual',
    recurrence_type: 'annual',
    freshness_status: 'fresh_annual',
    times_featured: 0,
    last_featured_at: null,
    merged_into: null,
    start_at: '2026-09-12T14:00:00Z',
    title: 'Founders Day Parade',
    ...overrides,
  });

  test('not yet featured this year is eligible', () => {
    expect(isEligibleForFreshDigest(annualEvent(), REFERENCE)).toBe(true);
  });

  test('already featured this calendar year is excluded', () => {
    expect(isEligibleForFreshDigest(annualEvent({
      times_featured: 1,
      last_featured_at: '2026-03-01T12:00:00Z', // same ET year (2026) as the Sept occurrence
    }), REFERENCE)).toBe(false);
  });

  test('featured last year is eligible again', () => {
    expect(isEligibleForFreshDigest(annualEvent({
      times_featured: 1,
      last_featured_at: '2025-09-13T12:00:00Z',
    }), REFERENCE)).toBe(true);
    expect(isEditoriallyNewEvent(annualEvent({
      times_featured: 1,
      last_featured_at: '2025-12-31T23:59:59Z', // still 2025 in ET
    }), REFERENCE)).toBe(true);
  });

  test('cross-row identity history applies the same calendar-year rule as the own-row check', () => {
    const currentYearOccurrence = annualEvent({ id: 'row-2' });
    const priorRowSameYear = {
      id: 'row-1', title: 'Founders Day Parade', times_featured: 1, last_featured_at: '2026-03-01T12:00:00Z',
    };
    const priorRowLastYear = {
      id: 'row-1', title: 'Founders Day Parade', times_featured: 1, last_featured_at: '2025-09-13T12:00:00Z',
    };

    expect(isPreviouslyFeaturedIdentity(currentYearOccurrence, [priorRowSameYear], REFERENCE)).toBe(true);
    expect(isPreviouslyFeaturedIdentity(currentYearOccurrence, [priorRowLastYear], REFERENCE)).toBe(false);
  });
});

describe('operator star override still bypasses the calendar-year rule', () => {
  const SEPTEMBER_REFERENCE = new Date('2026-09-08T12:00:00Z'); // Tuesday — issue window 09-08..09-14

  test('a starred locked event bypasses both the own-row and the cross-identity first-of-year checks', () => {
    const earlierSibling = {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Founders Day Parade',
      start_at: '2026-03-01T14:00:00Z',
    };
    const starredEvent = {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Founders Day Parade',
      admin_status: 'featured',
      start_at: '2026-09-12T14:00:00Z',
      end_at: null,
      event_url: 'https://events.example/founders-day',
      event_type: 'annual',
      recurrence_type: 'annual',
      freshness_status: 'fresh_annual',
      times_featured: 1,
      last_featured_at: '2026-03-01T10:00:00Z', // same ET year — would normally block re-eligibility
      merged_into: null,
    };
    const send = { newsletter_type: 'local-weekly-fresh-events', event_ids: [starredEvent.id] };

    const starred = assessFlagshipEventSelection(
      send, [starredEvent], SEPTEMBER_REFERENCE, [], [earlierSibling, starredEvent],
    );
    expect(starred.valid).toBe(true);

    const approvedInstead = { ...starredEvent, admin_status: 'approved' };
    const unstarred = assessFlagshipEventSelection(
      send, [approvedInstead], SEPTEMBER_REFERENCE, [], [earlierSibling, approvedInstead],
    );
    expect(unstarred.valid).toBe(false);
  });

  test('a starred routine (weekly) row still cannot bypass the pre-existing routine hard block — the star was never a debut substitute', () => {
    // Unchanged from before this rule: the star bypasses the once-only /
    // identity-history newness gates, never the routine-recurrence hard
    // block, which requires debut evidence (or, now, the pool-verified
    // continuity marker) on its own.
    expect(isEligibleForFreshDigest({
      admin_status: 'featured',
      event_url: 'https://events.example/weekly-yoga',
      event_type: 'recurring_series',
      recurrence_type: 'weekly',
      freshness_status: 'stale_recurring',
      times_featured: 0,
      last_featured_at: null,
      merged_into: null,
      start_at: '2026-07-25T22:00:00Z',
      title: 'Weekly Yoga',
    }, REFERENCE)).toBe(false);
  });

  test('a starred continuity-proven first occurrence keeps the verified first-of-year marker', async () => {
    const priorYear = weeklyEvent('prior-2025', { start_at: '2025-08-02T14:00:00Z' });
    const starred = weeklyEvent('first-2026', { start_at: '2026-01-10T14:00:00Z', admin_status: 'featured' });
    const second = weeklyEvent('second-2026', { start_at: '2026-01-17T14:00:00Z' });

    const rows = await filterRepeatedDateIdentities([starred], {
      reference: REFERENCE,
      identityPool: [priorYear, starred, second],
      yearPool: [priorYear, starred, second],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].__recurringFirstOfYear).toBe(true);
  });

  test('two feeds listing the same one-time event on the same day count as one occurrence', async () => {
    const oneTime = (id, sourceId) => ({
      id,
      title: 'Harvest Moon Lantern Walk',
      admin_status: 'approved',
      event_url: `https://events.example/${id}`,
      event_type: 'one_time',
      recurrence_type: 'unknown',
      freshness_status: 'fresh_one_time',
      venue_name: 'Bayfront Park',
      city: 'Sarasota',
      source_id: sourceId,
      start_at: '2026-10-17T23:00:00Z',
      times_featured: 0,
      last_featured_at: null,
      merged_into: null,
    });
    const a = oneTime('feed-a', 's1');
    const b = oneTime('feed-b', 's2');

    expect(identityOccurrenceCount(a, [a, b])).toBe(1);
    const rows = await filterRepeatedDateIdentities([a], {
      reference: REFERENCE,
      identityPool: [a],
      yearPool: [a, b],
    });
    expect(rows.map((row) => row.id)).toEqual(['feed-a']);
  });

  test('a January occurrence featured in a late-December issue never re-qualifies through the year refresh', () => {
    const annual = {
      id: 'jan-2027',
      title: 'New Year Polar Plunge',
      event_type: 'one_time',
      recurrence_type: 'annual',
      start_at: '2027-01-02T15:00:00Z',
      times_featured: 1,
      last_featured_at: '2026-12-29T11:00:00Z',
    };
    expect(isEditoriallyNewEvent(annual, new Date('2026-12-30T12:00:00Z'))).toBe(false);
    expect(isPreviouslyFeaturedIdentity(
      { ...annual, id: 'jan-2027-other-feed', times_featured: 0, last_featured_at: null },
      [annual],
      new Date('2026-12-30T12:00:00Z'),
    )).toBe(true);
  });

  test('the next year\'s occurrence of that annual event is new again', () => {
    const nextYear = {
      id: 'jan-2028',
      title: 'New Year Polar Plunge',
      event_type: 'one_time',
      recurrence_type: 'annual',
      start_at: '2028-01-01T15:00:00Z',
      times_featured: 1,
      last_featured_at: '2026-12-29T11:00:00Z',
    };
    expect(isEditoriallyNewEvent(nextYear, new Date('2027-12-20T12:00:00Z'))).toBe(true);
  });

  test('rows re-labeled one_time are still held to first-of-year when last year\'s rows were weekly', async () => {
    const priorYearWeekly = weeklyEvent('prior-2025', { start_at: '2025-08-02T14:00:00Z' });
    const relabeled = (id, start) => weeklyEvent(id, {
      start_at: start, event_type: 'one_time', recurrence_type: 'none', freshness_status: 'fresh_one_time',
    });
    const march = relabeled('march-2026', '2026-03-07T15:00:00Z');
    const june = relabeled('june-2026', '2026-06-06T14:00:00Z');

    const rows = await filterRepeatedDateIdentities([march, june], {
      reference: REFERENCE,
      identityPool: [june],
      yearPool: [priorYearWeekly, march, june],
    });
    expect(rows.map((row) => row.id)).toEqual(['march-2026']);
  });

  test('the pool-verified recurring verdict carries into the row-local newness check', () => {
    const relabeled = weeklyEvent('first-2026', {
      start_at: '2026-08-08T14:00:00Z', // after REFERENCE, so only newness decides
      event_type: 'one_time',
      recurrence_type: 'none',
      freshness_status: 'fresh_one_time',
      title: 'Riverside Harvest Market',
      description: 'Produce and crafts.',
      times_featured: 1,
      last_featured_at: '2025-08-01T10:00:00Z',
    });
    expect(isEligibleForFreshDigest(relabeled, REFERENCE)).toBe(false);
    expect(isEligibleForFreshDigest({ ...relabeled, __identityRecurring: true }, REFERENCE)).toBe(true);
  });

  test('history check honors the pool verdict when only a third sibling is labeled monthly', async () => {
    const oneTime = { event_type: 'one_time', recurrence_type: 'none', freshness_status: 'fresh_one_time', title: 'Riverside Harvest Market', description: 'Produce and crafts.' };
    const monthlySibling = weeklyEvent('prior-2025-monthly', { ...oneTime, recurrence_type: 'monthly', start_at: '2025-06-07T14:00:00Z' });
    const featuredLastYear = weeklyEvent('prior-2025-featured', {
      ...oneTime, start_at: '2025-08-02T14:00:00Z', times_featured: 1, last_featured_at: '2025-07-29T10:00:00Z',
    });
    const candidate = weeklyEvent('first-2026', { ...oneTime, start_at: '2026-08-08T14:00:00Z' });
    const pool = [monthlySibling, featuredLastYear, candidate];

    const history = { select: () => history, where: async () => [featuredLastYear] };
    const knex = () => history;
    const rows = await filterPreviouslyFeaturedIdentities([candidate], { knex, reference: REFERENCE, yearPool: pool });
    expect(rows.map((r) => r.id)).toEqual(['first-2026']);
  });

  test('needs_review blocks a verified first-of-year occurrence in planning and at send', async () => {
    const priorYear = weeklyEvent('prior-2025', { start_at: '2025-08-02T14:00:00Z' });
    const flagged = weeklyEvent('first-2026', { start_at: '2026-08-08T14:00:00Z', freshness_status: 'needs_review' });
    const later = weeklyEvent('second-2026', { start_at: '2026-08-15T14:00:00Z' });

    const planned = await filterRepeatedDateIdentities([flagged], {
      reference: REFERENCE, identityPool: [priorYear, flagged, later], yearPool: [priorYear, flagged, later],
    });
    expect(planned).toHaveLength(1);
    expect(planned[0].__recurringFirstOfYear).toBe(true);
    expect(isEligibleForFreshDigest(planned[0], REFERENCE)).toBe(false);
  });

  test('a row advanced in place to a later January date is not new when its January occurrence already shipped', () => {
    const advanced = {
      id: 'jan-row',
      title: 'New Year Polar Plunge',
      event_type: 'one_time',
      recurrence_type: 'annual',
      start_at: '2027-01-20T15:00:00Z',
      times_featured: 1,
      last_featured_at: '2026-12-29T11:00:00Z',
      last_featured_occurrence_at: '2027-01-02T15:00:00Z',
    };
    expect(isEditoriallyNewEvent(advanced, new Date('2027-01-10T12:00:00Z'))).toBe(false);
    expect(isEditoriallyNewEvent({ ...advanced, start_at: '2028-01-08T15:00:00Z' }, new Date('2027-12-20T12:00:00Z'))).toBe(true);
  });

  test('history inherited from an old recurring row still requires this year\'s first occurrence', async () => {
    const oneTime = { event_type: 'one_time', recurrence_type: 'none', freshness_status: 'fresh_one_time', title: 'Riverside Harvest Market', description: 'Produce and crafts.' };
    const featured2024 = weeklyEvent('featured-2024', {
      ...oneTime, recurrence_type: 'weekly', start_at: '2024-08-03T14:00:00Z', times_featured: 1, last_featured_at: '2024-07-30T10:00:00Z',
    });
    const march = weeklyEvent('march-2026', { ...oneTime, start_at: '2026-03-07T15:00:00Z' });
    const june = weeklyEvent('june-2026', { ...oneTime, start_at: '2026-08-08T14:00:00Z' });

    const history = { select: () => history, where: async () => [featured2024] };
    const knex = () => history;
    const rows = await filterPreviouslyFeaturedIdentities([june], { knex, reference: REFERENCE, yearPool: [march, june] });
    expect(rows).toEqual([]);
  });

  test('a feed row advanced in place counts its stamped prior-year shipped occurrence as continuity', async () => {
    const advanced = weeklyEvent('same-row', {
      start_at: '2026-01-10T14:00:00Z',
      times_featured: 1,
      last_featured_at: '2025-08-01T10:00:00Z',
      last_featured_occurrence_at: '2025-08-02T14:00:00Z',
    });
    const rows = await filterRepeatedDateIdentities([advanced], {
      reference: REFERENCE, identityPool: [advanced], yearPool: [advanced],
    });
    expect(rows.map((r) => r.id)).toEqual(['same-row']);
    expect(rows[0].__recurringFirstOfYear).toBe(true);
  });
});
