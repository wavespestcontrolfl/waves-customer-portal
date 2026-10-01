/**
 * Codex P1 (2026-09-27), newsletter-event-selection.js:466 "Honor verified
 * first-of-year eligibility during final validation":
 *
 * filterRepeatedDateIdentities (planning) never even consults
 * repeatedTitles for a recurring identity — once isRecurringIdentityEvent is
 * true, the branch returns (or drops) purely on isFirstOccurrenceOfYear, so
 * a continuity-proven weekly/monthly first occurrence is admitted
 * regardless of how many later-dated siblings of the same series exist in
 * the pool (which, for a real recurring series, there always are).
 *
 * assessFlagshipEventSelection (final proof/send validation) used to apply
 * the repeated-title rejection unconditionally except for a star or a
 * series debut — so a locked event planning had already admitted as a
 * verified recurring first-of-year occurrence failed final validation the
 * instant its later sibling(s) showed up in the reloaded ±90-day pool,
 * which for a weekly series is every time. Fixed via the shared
 * `isRecurringFirstOfYearExempt` predicate, applied identically in both
 * functions.
 *
 * These tests run the FULL planning → validation path against the SAME
 * pools (a mocked pool, no live DB) to prove the two stages now agree.
 */

const {
  filterRepeatedDateIdentities,
  assessFlagshipEventSelection,
  isRecurringFirstOfYearExempt,
} = require('../services/newsletter-event-selection');

const REFERENCE = new Date('2026-07-20T12:00:00Z'); // Monday — issue Tuesday is 2026-07-21

function weeklyTrivia(id, overrides = {}) {
  return {
    id,
    title: 'Weekly Trivia Night',
    description: 'Trivia every Tuesday night.',
    admin_status: 'approved',
    event_url: `https://events.example/trivia/${id}`,
    event_type: 'recurring_series',
    recurrence_type: 'weekly',
    freshness_status: 'stale_recurring', // classifyFreshness's own label — no pool access, can't know continuity
    times_featured: 0,
    last_featured_at: null,
    merged_into: null,
    venue_name: 'The Blind Tiger',
    city: 'sarasota',
    ...overrides,
  };
}

describe('planning and final validation agree on a continuity-proven recurring first-of-year occurrence', () => {
  const priorYear = weeklyTrivia('prior-2025', { start_at: '2025-01-08T23:00:00Z' });
  const candidate = weeklyTrivia('33333333-3333-4333-8333-333333333333', { start_at: '2026-07-21T22:00:00Z' });
  const laterSibling = weeklyTrivia('later-2026', { start_at: '2026-07-28T22:00:00Z' });

  // The routine ±90-day pool used for repeatedDateTitleKeys: candidate and
  // laterSibling share a normalized title on TWO distinct dates in it, which
  // is exactly what marks "Weekly Trivia Night" as a repeated title.
  const issueIdentityPool = [candidate, laterSibling];
  // The full-calendar-year pool used for continuity / first-of-year proof.
  const yearIdentityPool = [priorYear, candidate, laterSibling];

  test('planning (filterRepeatedDateIdentities) admits the first occurrence and drops the later sibling, bypassing repeatedTitles entirely for the recurring branch', async () => {
    const planned = await filterRepeatedDateIdentities([candidate, laterSibling], {
      reference: REFERENCE,
      identityPool: issueIdentityPool,
      yearPool: yearIdentityPool,
    });
    expect(planned.map((row) => row.id)).toEqual([candidate.id]);
    expect(planned[0].__recurringFirstOfYear).toBe(true);
  });

  test('final validation (assessFlagshipEventSelection) agrees: the SAME locked candidate is not rejected by the same-issue repeated-title check', () => {
    const send = { newsletter_type: 'local-weekly-fresh-events', event_ids: [candidate.id] };
    // Final validation reloads the RAW row (no __recurringFirstOfYear marker
    // — that marker is only ever stamped by the planning filters themselves)
    // against the same two pools planning used.
    const result = assessFlagshipEventSelection(
      send, [candidate], REFERENCE, [], issueIdentityPool, yearIdentityPool,
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.events.map((row) => row.id)).toEqual([candidate.id]);
  });

  test('isRecurringFirstOfYearExempt is the exact boolean both stages key off', () => {
    expect(isRecurringFirstOfYearExempt(true, true)).toBe(true);
    expect(isRecurringFirstOfYearExempt(true, false)).toBe(false);
    expect(isRecurringFirstOfYearExempt(false, true)).toBe(false);
    expect(isRecurringFirstOfYearExempt(false, false)).toBe(false);
  });
});

describe('the repeated-title rejection still applies to a genuinely non-recurring identity', () => {
  // Guards against the fix over-widening: a plain one-time event mislabeled
  // with a repeated title (not proven recurring) must still be rejected by
  // BOTH planning and final validation, exactly as before this change.
  const oneTimeA = {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'Downtown Night Market',
    admin_status: 'approved',
    event_url: 'https://events.example/market-a',
    event_type: 'one_time',
    recurrence_type: 'none',
    freshness_status: 'fresh_one_time',
    times_featured: 0,
    last_featured_at: null,
    merged_into: null,
    venue_name: 'Main Street',
    city: 'venice',
    start_at: '2026-07-21T22:00:00Z',
  };
  const oneTimeB = { ...oneTimeA, id: '55555555-5555-4555-8555-555555555555', start_at: '2026-07-28T22:00:00Z' };
  const pool = [oneTimeA, oneTimeB];

  test('planning drops the earlier one-time row too — it is not a recurring identity, so no exemption applies', async () => {
    const planned = await filterRepeatedDateIdentities([oneTimeA, oneTimeB], {
      reference: REFERENCE, identityPool: pool, yearPool: pool,
    });
    expect(planned).toEqual([]);
  });

  test('final validation rejects a locked one-time row with a same-issue repeated title', () => {
    const send = { newsletter_type: 'local-weekly-fresh-events', event_ids: [oneTimeA.id] };
    const result = assessFlagshipEventSelection(send, [oneTimeA], REFERENCE, [], pool, pool);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/no longer eligible/);
  });
});
