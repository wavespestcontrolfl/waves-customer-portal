/**
 * Series-debut carve-out (owner directive 2026-07-17): recurring events are
 * outside the weekend guide's editorial contract — EXCEPT the debut of a
 * recurring series, which is news exactly once. "Weekly yoga in the park"
 * never earns a slot; "grand opening of the weekly night market" can, and
 * only until it has been featured.
 */

const {
  classifyFreshness,
  isEligibleForFreshDigest,
  isSeriesDebutEvent,
  isRoutineRecurringEvent,
} = require('../services/event-freshness');

const REFERENCE = new Date('2026-07-14T10:00:00-04:00'); // Tuesday ET

function recurringEvent(overrides = {}) {
  return {
    admin_status: 'approved',
    event_url: 'https://events.example/night-market',
    event_type: 'recurring_series',
    recurrence_type: 'weekly',
    freshness_status: 'stale_recurring',
    times_featured: 0,
    last_featured_at: null,
    merged_into: null,
    start_at: '2026-07-18T22:00:00Z', // upcoming Saturday
    title: 'Downtown Night Market',
    description: 'Vendors every Saturday.',
    ...overrides,
  };
}

describe('isSeriesDebutEvent', () => {
  test('requires explicit debut evidence on a never-featured row', () => {
    expect(isSeriesDebutEvent(recurringEvent())).toBe(false);
    expect(isSeriesDebutEvent(recurringEvent({
      title: 'Grand Opening: Downtown Night Market',
    }))).toBe(true);
    expect(isSeriesDebutEvent(recurringEvent({
      description: 'The inaugural session of a new weekly market series.',
    }))).toBe(true);
  });

  test('closes permanently after the first feature', () => {
    expect(isSeriesDebutEvent(recurringEvent({
      title: 'Grand Opening: Downtown Night Market',
      times_featured: 1,
    }))).toBe(false);
    expect(isSeriesDebutEvent(recurringEvent({
      title: 'Grand Opening: Downtown Night Market',
      last_featured_at: '2026-07-07T10:00:00Z',
    }))).toBe(false);
  });

  test('vague words are not debut evidence (boat launch, new menu)', () => {
    expect(isSeriesDebutEvent(recurringEvent({
      title: 'Sunset Paddle at the Public Boat Launch',
    }))).toBe(false);
    expect(isSeriesDebutEvent(recurringEvent({
      description: 'Come try the new menu every Friday.',
    }))).toBe(false);
  });
});

describe('classifyFreshness series debut', () => {
  test('never-featured debut of a recurring series classifies fresh_series_launch (90)', () => {
    expect(classifyFreshness(recurringEvent({
      title: 'Grand Opening: Downtown Night Market',
    }))).toEqual({ freshness_status: 'fresh_series_launch', freshness_score: 90 });
  });

  test('ordinary recurring programming stays stale_recurring', () => {
    expect(classifyFreshness(recurringEvent())).toEqual({
      freshness_status: 'stale_recurring',
      freshness_score: 10,
    });
    // Re-normalization after the debut was featured demotes it again.
    expect(classifyFreshness(recurringEvent({
      title: 'Grand Opening: Downtown Night Market',
      times_featured: 1,
    }))).toEqual({ freshness_status: 'stale_recurring', freshness_score: 10 });
  });

  test('text backstop still catches mislabeled routine listings', () => {
    expect(classifyFreshness({
      event_type: 'one_time',
      recurrence_type: 'none',
      title: 'Yoga every Tuesday',
      description: '',
      times_featured: 0,
      start_at: '2026-07-21T14:00:00Z',
    }).freshness_status).toBe('stale_recurring');
  });
});

describe('isEligibleForFreshDigest series debut', () => {
  test('debut with the fresh_series_launch classification is eligible once', () => {
    const debut = recurringEvent({
      title: 'Grand Opening: Downtown Night Market',
      freshness_status: 'fresh_series_launch',
    });
    expect(isRoutineRecurringEvent(debut)).toBe(true);
    expect(isEligibleForFreshDigest(debut, REFERENCE)).toBe(true);
  });

  test('the same series is ineligible after being featured', () => {
    expect(isEligibleForFreshDigest(recurringEvent({
      title: 'Grand Opening: Downtown Night Market',
      freshness_status: 'fresh_series_launch',
      times_featured: 1,
      last_featured_at: '2026-07-07T10:00:00Z',
    }), REFERENCE)).toBe(false);
  });

  test('a stale classification cannot ride the carve-out even with debut text', () => {
    expect(isEligibleForFreshDigest(recurringEvent({
      title: 'Grand Opening: Downtown Night Market',
      freshness_status: 'stale_recurring',
    }), REFERENCE)).toBe(false);
  });

  test('routine recurring without debut evidence stays excluded', () => {
    expect(isEligibleForFreshDigest(recurringEvent({
      freshness_status: 'fresh_series_launch', // even a mis-set status is not enough
    }), REFERENCE)).toBe(false);
  });
});
