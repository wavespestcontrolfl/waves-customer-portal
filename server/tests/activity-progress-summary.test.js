// Unit tests for buildActivityProgress — the cumulative knockdown-progress
// summary (TYPED_PROGRESS_SUMMARY, dark). Pins the honesty rules: knockdown
// indicators only, 2+ visits, and ONLY when today improved on the recorded
// baseline — flat/worse visits render nothing (the trend sentence owns those).

const { buildActivityProgress } = require('../services/service-report/activity-scores-store');

const HISTORY = [
  { serviceRecordId: 'v1', serviceDate: '2026-06-12', score: 4, levelWord: 'High activity', isCurrent: false },
  { serviceRecordId: 'v2', serviceDate: '2026-06-26', score: 3, levelWord: 'Moderate activity', isCurrent: false },
  { serviceRecordId: 'v3', serviceDate: '2026-07-10', score: 1, levelWord: 'Very low activity', isCurrent: true },
];

describe('buildActivityProgress', () => {
  beforeEach(() => { process.env.TYPED_PROGRESS_SUMMARY = 'true'; });
  afterEach(() => { delete process.env.TYPED_PROGRESS_SUMMARY; });

  it('summarizes an improved bed bug protocol from the baseline visit', () => {
    const out = buildActivityProgress({ indicatorKey: 'bed_bug_activity', history: HISTORY, currentScore: 1 });
    expect(out).toEqual({
      baselineScore: 4,
      baselineLevelWord: 'High activity',
      baselineDate: '2026-06-12',
      currentScore: 1,
      visits: 3,
    });
  });

  it('covers the shared roach indicator (knockdowns + generic cockroach)', () => {
    expect(buildActivityProgress({ indicatorKey: 'roach_activity', history: HISTORY, currentScore: 1 })).not.toBeNull();
  });

  it('renders nothing for non-knockdown indicators', () => {
    expect(buildActivityProgress({ indicatorKey: 'rodent_activity', history: HISTORY, currentScore: 1 })).toBeNull();
    expect(buildActivityProgress({ indicatorKey: 'flea_activity', history: HISTORY, currentScore: 1 })).toBeNull();
  });

  it('renders nothing when the gate is off', () => {
    delete process.env.TYPED_PROGRESS_SUMMARY;
    expect(buildActivityProgress({ indicatorKey: 'bed_bug_activity', history: HISTORY, currentScore: 1 })).toBeNull();
  });

  it('renders nothing on a first visit or single-point history', () => {
    expect(buildActivityProgress({ indicatorKey: 'bed_bug_activity', history: [HISTORY[2]], currentScore: 1 })).toBeNull();
    // baseline slot occupied by the current visit itself (no prior rows)
    expect(buildActivityProgress({
      indicatorKey: 'bed_bug_activity',
      history: [{ ...HISTORY[2] }, { serviceRecordId: 'x', serviceDate: '2026-07-11', score: 0, isCurrent: false }],
      currentScore: 1,
    })).toBeNull();
  });

  it('renders nothing when activity is flat or worse than the baseline', () => {
    expect(buildActivityProgress({ indicatorKey: 'bed_bug_activity', history: HISTORY, currentScore: 4 })).toBeNull();
    expect(buildActivityProgress({ indicatorKey: 'bed_bug_activity', history: HISTORY, currentScore: 5 })).toBeNull();
  });

  it('falls back to scoreLevelWord when the baseline row has no level word', () => {
    const bare = [{ ...HISTORY[0], levelWord: null }, HISTORY[2]];
    const out = buildActivityProgress({ indicatorKey: 'bed_bug_activity', history: bare, currentScore: 1 });
    expect(out.baselineLevelWord).toBe('High activity');
  });
});
