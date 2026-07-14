// Unit tests for buildActivityProgress — the cumulative knockdown-progress
// summary (TYPED_PROGRESS_SUMMARY, dark). Pins the honesty rules: knockdown
// indicators only, 2+ visits, an explicitly-loaded TRUE first-visit baseline
// (the chart history truncates at HISTORY_LIMIT — codex P2), and ONLY when
// today improved on that baseline. Flat/worse visits render nothing.

const { buildActivityProgress } = require('../services/service-report/activity-scores-store');

const HISTORY = [
  { serviceRecordId: 'v1', serviceDate: '2026-06-12', score: 4, levelWord: 'High activity', isCurrent: false },
  { serviceRecordId: 'v2', serviceDate: '2026-06-26', score: 3, levelWord: 'Moderate activity', isCurrent: false },
  { serviceRecordId: 'v3', serviceDate: '2026-07-10', score: 1, levelWord: 'Very low activity', isCurrent: true },
];
const BASELINE = { serviceRecordId: 'v1', serviceDate: '2026-06-12', score: 4, levelWord: 'High activity' };

describe('buildActivityProgress', () => {
  beforeEach(() => { process.env.TYPED_PROGRESS_SUMMARY = 'true'; });
  afterEach(() => { delete process.env.TYPED_PROGRESS_SUMMARY; });

  it('summarizes an improved bed bug protocol from the true first visit', () => {
    const out = buildActivityProgress({
      indicatorKey: 'bed_bug_activity', history: HISTORY, currentScore: 1, currentRecordId: 'v3', baseline: BASELINE,
    });
    expect(out).toEqual({
      baselineScore: 4,
      baselineLevelWord: 'High activity',
      baselineDate: '2026-06-12',
      currentScore: 1,
      visits: 3,
    });
  });

  it('uses the explicit baseline, not history[0], on truncated long programs', () => {
    // Simulates > HISTORY_LIMIT visits: the chart history starts mid-program
    // at score 3, but the customer's TRUE first visit (loaded separately)
    // was a 5 — "at your first visit" must state the 5.
    const truncated = [
      { serviceRecordId: 'v9', serviceDate: '2026-05-01', score: 3, levelWord: 'Moderate activity', isCurrent: false },
      { serviceRecordId: 'v10', serviceDate: '2026-07-10', score: 1, levelWord: 'Very low activity', isCurrent: true },
    ];
    const out = buildActivityProgress({
      indicatorKey: 'bed_bug_activity',
      history: truncated,
      currentScore: 1,
      currentRecordId: 'v10',
      baseline: { serviceRecordId: 'v1', serviceDate: '2026-01-15', score: 5, levelWord: 'Severe activity' },
    });
    expect(out.baselineScore).toBe(5);
    expect(out.baselineDate).toBe('2026-01-15');
  });

  it('suppresses the chip when no baseline could be loaded (never guesses)', () => {
    expect(buildActivityProgress({
      indicatorKey: 'bed_bug_activity', history: HISTORY, currentScore: 1, currentRecordId: 'v3', baseline: null,
    })).toBeNull();
  });

  it('suppresses when the earliest row IS this report (first visit)', () => {
    expect(buildActivityProgress({
      indicatorKey: 'bed_bug_activity',
      history: HISTORY,
      currentScore: 4,
      currentRecordId: 'v1',
      baseline: BASELINE,
    })).toBeNull();
  });

  it('covers the shared roach indicator (knockdowns + generic cockroach)', () => {
    expect(buildActivityProgress({
      indicatorKey: 'roach_activity', history: HISTORY, currentScore: 1, currentRecordId: 'v3', baseline: BASELINE,
    })).not.toBeNull();
  });

  it('renders nothing for non-knockdown indicators', () => {
    for (const indicatorKey of ['rodent_activity', 'flea_activity']) {
      expect(buildActivityProgress({
        indicatorKey, history: HISTORY, currentScore: 1, currentRecordId: 'v3', baseline: BASELINE,
      })).toBeNull();
    }
  });

  it('renders nothing when the gate is off', () => {
    delete process.env.TYPED_PROGRESS_SUMMARY;
    expect(buildActivityProgress({
      indicatorKey: 'bed_bug_activity', history: HISTORY, currentScore: 1, currentRecordId: 'v3', baseline: BASELINE,
    })).toBeNull();
  });

  it('renders nothing on a single-point history', () => {
    expect(buildActivityProgress({
      indicatorKey: 'bed_bug_activity', history: [HISTORY[2]], currentScore: 1, currentRecordId: 'v3', baseline: BASELINE,
    })).toBeNull();
  });

  it('renders nothing when activity is flat or worse than the baseline', () => {
    for (const currentScore of [4, 5]) {
      expect(buildActivityProgress({
        indicatorKey: 'bed_bug_activity', history: HISTORY, currentScore, currentRecordId: 'v3', baseline: BASELINE,
      })).toBeNull();
    }
  });

  it('falls back to scoreLevelWord when the baseline row has no level word', () => {
    const out = buildActivityProgress({
      indicatorKey: 'bed_bug_activity',
      history: HISTORY,
      currentScore: 1,
      currentRecordId: 'v3',
      baseline: { ...BASELINE, levelWord: null },
    });
    expect(out.baselineLevelWord).toBe('High activity');
  });
});
