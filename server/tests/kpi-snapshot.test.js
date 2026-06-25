// Mock the route module so computeCoreKpis returns a fixed KPI object — the
// snapshot service must never actually hit the DB-backed dashboard handler here.
jest.mock('../routes/admin-dashboard', () => ({ computeCoreKpis: jest.fn() }));

const { computeCoreKpis } = require('../routes/admin-dashboard');
const { recordKpiSnapshot, SNAPSHOT_METRICS } = require('../services/kpi-snapshot');

// Fake Knex: kpi_snapshots upserts (insert → onConflict → merge) are captured
// into an array, one entry per metric row written.
function makeFakeDb({ capture } = {}) {
  capture.rows = [];
  const snapshots = {
    insert(row) { this._row = row; return this; },
    onConflict(cols) { this._conflict = cols; return this; },
    merge() { capture.rows.push({ row: this._row, conflict: this._conflict }); return Promise.resolve(); },
  };
  const db = (table) => {
    expect(String(table)).toBe('kpi_snapshots');
    // fresh builder per call so _row/_conflict don't leak across metrics
    return Object.assign(Object.create(snapshots), {});
  };
  return db;
}

// A KPI object shaped exactly like /core-kpis res.json, with one metric (ar.days)
// deliberately null to prove "unavailable" is stored as null, not 0.
function fixedKpis() {
  return {
    period: 'mtd',
    service: { completionRate: 92, callbackRate: 3.4 },
    quality: { csatAvg: '8.7', csatResponses: 12, nps: 70 },
    financial: {
      revPerJob: 245.5, rpmh: 110, grossMargin: 64, grossMarginWeighted: 64, grossMarginAvg: 66,
      stopsPerHour: 2.3, utilization: 78,
    },
    sales: { conversion: 41.2, avgResponseMin: 9 },
    ar: { days: null }, // unavailable this day → must persist as null
    billing: { collectionRate: 88.5, autopayPct: 73.1 },
    retention: { pct: 96.4, lost: 2 },
    momentum: { customers: { net: 5 }, mrr: { net: 412.5 } },
  };
}

describe('recordKpiSnapshot', () => {
  beforeEach(() => {
    computeCoreKpis.mockReset();
    computeCoreKpis.mockResolvedValue(fixedKpis());
  });

  test('upserts one row per metric, keyed on (snapshot_date, metric)', async () => {
    const capture = {};
    const db = makeFakeDb({ capture });
    const out = await recordKpiSnapshot('2026-06-24', db);

    expect(computeCoreKpis).toHaveBeenCalledWith('mtd');
    // One row per SNAPSHOT_METRICS entry.
    expect(capture.rows).toHaveLength(SNAPSHOT_METRICS.length);
    expect(out).toEqual({ snapshot_date: '2026-06-24', metrics: SNAPSHOT_METRICS.length });

    for (const { row, conflict } of capture.rows) {
      expect(row.snapshot_date).toBe('2026-06-24');
      expect(conflict).toEqual(['snapshot_date', 'metric']);
      expect(row.captured_at).toBeInstanceOf(Date);
    }
  });

  test('stores the right metric keys with numeric values; csat parsed from string', async () => {
    const capture = {};
    const db = makeFakeDb({ capture });
    await recordKpiSnapshot('2026-06-24', db);

    const byMetric = Object.fromEntries(capture.rows.map(({ row }) => [row.metric, row.value]));
    // Every expected key is present.
    expect(Object.keys(byMetric).sort()).toEqual(SNAPSHOT_METRICS.map(([m]) => m).sort());
    // Spot-check numeric coercion across the nested paths.
    expect(byMetric.completion_rate).toBe(92);
    expect(byMetric.callback_rate).toBe(3.4);
    expect(byMetric.tech_utilization).toBe(78);
    expect(byMetric.stops_per_hour).toBe(2.3);
    expect(byMetric.revenue_per_job).toBe(245.5);
    expect(byMetric.revenue_per_man_hour).toBe(110);
    expect(byMetric.gross_margin).toBe(64);
    expect(byMetric.lead_conversion).toBe(41.2);
    expect(byMetric.response_speed_min).toBe(9);
    expect(byMetric.csat_avg).toBe(8.7); // parsed from the "8.7" toFixed string
    expect(byMetric.retention_pct).toBe(96.4);
    expect(byMetric.collection_rate).toBe(88.5);
    expect(byMetric.autopay_pct).toBe(73.1);
    expect(byMetric.net_customers).toBe(5);
    expect(byMetric.net_mrr).toBe(412.5);
  });

  test('an unavailable metric is stored as null, not 0', async () => {
    const capture = {};
    const db = makeFakeDb({ capture });
    await recordKpiSnapshot('2026-06-24', db);

    const arRow = capture.rows.find(({ row }) => row.metric === 'ar_days');
    expect(arRow).toBeDefined();
    expect(arRow.row.value).toBeNull();
  });
});
