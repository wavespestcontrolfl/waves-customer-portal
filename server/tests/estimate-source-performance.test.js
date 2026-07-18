/**
 * Estimate performance by source (learning-loop conversion report).
 *
 * Pins: created_at-cohort funnel with send-latency medians, winloss-style
 * resolved-only win rates (resolution-date trim in JS, out-of-window rows
 * dropped), edit-stat aggregation from the learning-event ledger, unknown
 * sources folding into 'other', and zero-activity sources dropping out.
 */

let mockQueues;

jest.mock('../models/db', () => {
  const passthroughBuilder = (rows) => {
    const builder = {
      where: () => builder,
      whereIn: () => builder,
      whereNull: () => builder,
      orWhere: () => builder,
      select: async () => rows,
    };
    return builder;
  };
  const mock = jest.fn((table) => {
    const queue = mockQueues[table];
    if (!queue || !queue.length) throw new Error(`no queued rows for table ${table}`);
    return passthroughBuilder(queue.shift());
  });
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { sourcePerformance, _private } = require('../services/estimate-source-performance');

const NOW = Date.now();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const hoursAfter = (iso, h) => new Date(new Date(iso).getTime() + h * 3600000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  mockQueues = {};
});

describe('sourcePerformance', () => {
  test('funnel, win rate, latency, and edit stats aggregate per source', async () => {
    const created = daysAgo(10);
    mockQueues.estimates = [
      // Cohort query: drafted/sent + latency.
      [
        { id: 'a', source: 'estimator_engine', status: 'sent', created_at: created, sent_at: hoursAfter(created, 2) },
        { id: 'b', source: 'estimator_engine', status: 'draft', created_at: created, sent_at: null },
        // Resent later: sent_at was overwritten to +50h, but the customer's
        // first view at +3h bounds the real first delivery.
        { id: 'a2', source: 'estimator_engine', status: 'viewed', created_at: created, sent_at: hoursAfter(created, 50), viewed_at: hoursAfter(created, 3) },
        // Superseded send: acceptance won the in-flight claim, sent_at
        // stayed NULL — delivery evidence is the acceptance itself.
        { id: 'a3', source: 'estimator_engine', status: 'accepted', created_at: created, sent_at: null, accepted_at: hoursAfter(created, 1) },
        { id: 'c', source: null, status: 'sent', created_at: created, sent_at: hoursAfter(created, 6) },
        { id: 'd', source: 'mystery_pipe', status: 'draft', created_at: created, sent_at: null },
      ],
      // Resolved query: win/loss.
      [
        { id: 'e', source: 'estimator_engine', status: 'accepted', accepted_at: daysAgo(3), created_at: daysAgo(9) },
        { id: 'f', source: 'estimator_engine', status: 'declined', declined_at: daysAgo(2), updated_at: daysAgo(2), created_at: daysAgo(9) },
        { id: 'g', source: 'manual', status: 'accepted', accepted_at: daysAgo(4), created_at: daysAgo(9) },
        // Resolved OUTSIDE the window — superset prefilter let it through,
        // the JS resolution-date trim must drop it.
        { id: 'h', source: 'manual', status: 'declined', declined_at: daysAgo(120), updated_at: daysAgo(120), created_at: daysAgo(150) },
      ],
    ];
    mockQueues.estimate_learning_events = [
      [
        { source: 'estimator_engine', sent_unedited: true, edit_summary: { reviseCount: 0 } },
        { source: 'estimator_engine', sent_unedited: false, edit_summary: { reviseCount: 2, totalsChanged: { monthly_total: { from: 79, to: 95 } }, servicesAdded: ['mosquito'] } },
        // Pre-ledger sentinel: edit history unknowable — must not count in
        // events, the sent-as-is rate, or any changed-counter.
        { source: 'estimator_engine', sent_unedited: null, edit_summary: { reviseCount: null, baselineCapture: 'pre_ledger' } },
      ],
    ];

    const report = await sourcePerformance({ days: 90 });
    const engine = report.sources.find((s) => s.source === 'estimator_engine');
    expect(engine.drafted).toBe(4);
    expect(engine.sent).toBe(3);
    // Latency samples: 2h (clean), 3h (first view beats the resent
    // sent_at), 1h (acceptance on the superseded path) — median 2.
    expect(engine.sendLatencyHoursMedian).toBe(2);
    expect(engine.resolved).toBe(2);
    expect(engine.won).toBe(1);
    expect(engine.winRatePct).toBe(50);
    expect(engine.edits.events).toBe(2);
    expect(engine.edits.sentUneditedPct).toBe(50);
    expect(engine.edits.avgReviseCount).toBe(1);
    expect(engine.edits.totalsChanged).toBe(1);
    expect(engine.edits.servicesChanged).toBe(1);
    expect(engine.edits.unknown).toBe(1);

    const manual = report.sources.find((s) => s.source === 'manual');
    // Null source folds into manual; the out-of-window decline dropped.
    expect(manual.drafted).toBe(1);
    expect(manual.resolved).toBe(1);
    expect(manual.winRatePct).toBe(100);

    const other = report.sources.find((s) => s.source === 'other');
    expect(other.drafted).toBe(1);

    // Sources with no activity at all don't clutter the payload.
    expect(report.sources.find((s) => s.source === 'sms_intake')).toBeUndefined();
    expect(report.drafted).toBe(6);
    expect(report.resolved).toBe(3);
  });

  test('empty window returns an empty source list', async () => {
    mockQueues.estimates = [[], []];
    mockQueues.estimate_learning_events = [[]];
    const report = await sourcePerformance({ days: 30 });
    expect(report.sources).toEqual([]);
    expect(report.drafted).toBe(0);
  });
});

describe('_private helpers', () => {
  test('sourceKey folds unknowns into other and null into manual', () => {
    expect(_private.sourceKey(null)).toBe('manual');
    expect(_private.sourceKey('estimator_engine')).toBe('estimator_engine');
    // Every source value the codebase writes keeps its own bucket.
    expect(_private.sourceKey('quote_wizard')).toBe('quote_wizard');
    expect(_private.sourceKey('lead_agent')).toBe('lead_agent');
    expect(_private.sourceKey('who_knows')).toBe('other');
  });

  test('median handles even counts and empty input', () => {
    expect(_private.median([])).toBeNull();
    expect(_private.median([1, 3])).toBe(2);
    expect(_private.median([1, 2, 10])).toBe(2);
  });
});
