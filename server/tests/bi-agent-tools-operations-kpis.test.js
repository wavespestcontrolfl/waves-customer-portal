/**
 * get_operations_snapshot's "kpis" — last 7 days vs a rolling 30-day
 * baseline vs the owner's kpi_targets, using the SAME accessor paths
 * (SNAPSHOT_METRICS) and tone rule (shared/kpi-targets.cjs) the dashboard
 * tiles use. Everything else the tool returns is exercised elsewhere; this
 * file only pins the kpis/kpiWindow addition and its failure modes.
 */

// A single generic knex-chain fake: every intermediate call (where,
// whereNull, whereIn, count, select) returns the same chain; `.first()`
// resolves the primed value, and the chain is itself thenable so
// `await db('kpi_targets').select(...)` (no .first()) resolves too —
// get_operations_snapshot's other queries always call .first() explicitly,
// so the two shapes never collide.
let scheduledServicesRow = { total: '10', completed: '8', count: '2' };
let kpiTargetRows = [];
let kpiTargetsShouldThrow = false;

function makeChain(resolveValue) {
  const chain = {
    where: () => chain,
    whereNull: () => chain,
    whereIn: () => chain,
    count: () => chain,
    select: () => chain,
    first: () => Promise.resolve(resolveValue),
    then: (resolve, reject) => Promise.resolve(resolveValue).then(resolve, reject),
  };
  return chain;
}

const mockDb = jest.fn((table) => {
  if (table === 'kpi_targets') {
    if (kpiTargetsShouldThrow) return { select: () => Promise.reject(new Error('kpi_targets unavailable')) };
    return makeChain(kpiTargetRows);
  }
  if (table === 'scheduled_services') return makeChain(scheduledServicesRow);
  return makeChain(null);
});
mockDb.raw = (sql) => sql;

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/forecast-analyzer', () => ({ analyzeTomorrow: async () => ({ needsReschedule: [] }) }));

const mockComputeCoreKpis = jest.fn();
jest.mock('../routes/admin-dashboard', () => ({ computeCoreKpis: (...a) => mockComputeCoreKpis(...a) }));

const { executeBITool } = require('../services/bi-agent-tools');
const { etDateString, addETDays } = require('../utils/datetime-et');

// Windows now end YESTERDAY (ET), not today (Codex P1, bi-agent-tools.js:121)
// — computed the same way the fix does, never a hardcoded literal (a
// near-today literal goes stale the day the ET calendar passes it).
const yesterday = etDateString(addETDays(new Date(), -1));
const last7From = etDateString(addETDays(new Date(), -7));
const last30From = etDateString(addETDays(new Date(), -30));

// Only the paths get_operations_snapshot's kpis actually read.
function kpiSet({ completion = 80, callback = 3, response = 64, conversion = 22, stops = 4.2, rpmh = 90, margin = 38, arDays = 34, retention = 88, collection = 65, issuedCount = 20 } = {}) {
  return {
    service: { completionRate: completion, callbackRate: callback },
    sales: { avgResponseMin: response, conversion },
    financial: { stopsPerHour: stops, rpmh, grossMarginWeighted: margin },
    ar: { days: arDays },
    retention: { pct: retention },
    billing: { collectionRate: collection, issuedCount },
  };
}

describe('get_operations_snapshot — kpis (last7 vs last30 vs targets)', () => {
  beforeEach(() => {
    scheduledServicesRow = { total: '10', completed: '8', count: '2' };
    kpiTargetRows = [];
    kpiTargetsShouldThrow = false;
    mockComputeCoreKpis.mockReset();
  });

  it('returns every metric with last7/last30 wired from the two computeCoreKpis calls', async () => {
    mockComputeCoreKpis.mockImplementation(async (period) => (
      period === 'last_7' ? kpiSet({ response: 64, completion: 80 }) : kpiSet({ response: 55, completion: 75 })
    ));

    const result = await executeBITool('get_operations_snapshot', {});

    // Both windows end YESTERDAY (ET) — never today — so a Monday-morning run
    // never counts Monday's not-yet-done appointments as an incomplete.
    expect(mockComputeCoreKpis).toHaveBeenCalledWith('last_7', { from: last7From, to: yesterday });
    expect(mockComputeCoreKpis).toHaveBeenCalledWith('last_30', { from: last30From, to: yesterday });
    expect(result.kpiWindow).toEqual({
      last7: '7 days ending yesterday (ET)',
      baseline: '30 days ending yesterday (ET)',
      current: 'a live snapshot as of today (ET) — no 30-day baseline (e.g. AR days)',
      cohort: 'customers who joined before the 7- / 30-day window began, counted as still active if they are active today (ET) (e.g. retention)',
    });

    const byMetric = Object.fromEntries(result.kpis.map((k) => [k.metric, k]));
    expect(Object.keys(byMetric).sort()).toEqual([
      'ar_days', 'callback_rate', 'collection_rate', 'completion_rate', 'gross_margin',
      'lead_conversion', 'response_speed_min', 'retention_pct', 'revenue_per_man_hour', 'stops_per_hour',
    ].sort());
    expect(byMetric.response_speed_min).toMatchObject({ last7: 64, last30: 55, target: 60, lowerIsBetter: true });
    expect(byMetric.completion_rate).toMatchObject({ last7: 80, last30: 75, target: 85, lowerIsBetter: false });
  });

  it('a kpi_targets store row beats DEFAULT_KPI_TARGETS for both the target and the tone', async () => {
    mockComputeCoreKpis.mockResolvedValue(kpiSet({ response: 64 }));
    // Default target for response_speed_min is 60 (lowerIsBetter) — 64 would
    // be 'warn'. The store overrides to a looser 70, which 64 now meets.
    kpiTargetRows = [{ metric: 'response_speed_min', target: '70', amber_band_pct: '10', lower_is_better: true }];

    const result = await executeBITool('get_operations_snapshot', {});
    const resp = result.kpis.find((k) => k.metric === 'response_speed_min');
    expect(resp.target).toBe(70);
    expect(resp.tone).toBe('good');
  });

  it('tone follows the shared kpiTargetTone rule: good / warn / bad', async () => {
    // response_speed_min: target 60, lowerIsBetter, amber band 10% => band=6.
    mockComputeCoreKpis.mockImplementation(async () => kpiSet({ response: 64 })); // miss by 4, within band => warn
    let result = await executeBITool('get_operations_snapshot', {});
    expect(result.kpis.find((k) => k.metric === 'response_speed_min').tone).toBe('warn');

    mockComputeCoreKpis.mockImplementation(async () => kpiSet({ response: 80 })); // miss by 20, beyond band => bad
    result = await executeBITool('get_operations_snapshot', {});
    expect(result.kpis.find((k) => k.metric === 'response_speed_min').tone).toBe('bad');

    mockComputeCoreKpis.mockImplementation(async () => kpiSet({ response: 50 })); // meets => good
    result = await executeBITool('get_operations_snapshot', {});
    expect(result.kpis.find((k) => k.metric === 'response_speed_min').tone).toBe('good');
  });

  it('a metric with no default and no store row (stops_per_hour) has a null target and tone', async () => {
    mockComputeCoreKpis.mockResolvedValue(kpiSet());
    const result = await executeBITool('get_operations_snapshot', {});
    const stops = result.kpis.find((k) => k.metric === 'stops_per_hour');
    expect(stops.target).toBeNull();
    expect(stops.tone).toBeNull();
    expect(stops.last7).toBe(4.2);
  });

  it('a failed kpi_targets read falls back to the default targets, as the dashboard does — never throws', async () => {
    mockComputeCoreKpis.mockResolvedValue(kpiSet({ response: 64 }));
    kpiTargetsShouldThrow = true;

    const result = await executeBITool('get_operations_snapshot', {});
    // The dashboard renders DEFAULT_KPI_TARGETS when its kpi-targets fetch
    // fails; the briefing must grade the same value the same way.
    const resp = result.kpis.find((k) => k.metric === 'response_speed_min');
    expect(resp).toMatchObject({ last7: 64, target: 60, lowerIsBetter: true, tone: 'warn' });
    const stops = result.kpis.find((k) => k.metric === 'stops_per_hour');
    expect(stops.tone).toBeNull(); // no default, no store row
  });

  it('a computeCoreKpis failure degrades to an all-null kpis array rather than failing the whole snapshot', async () => {
    mockComputeCoreKpis.mockRejectedValue(new Error('dashboard query failed'));
    const result = await executeBITool('get_operations_snapshot', {});
    expect(result.completionRate).toBeDefined(); // the rest of the snapshot still returns
    expect(result.kpis).toHaveLength(10);
    result.kpis.forEach((k) => {
      expect(k.last7).toBeNull();
      expect(k.last30).toBeNull();
      expect(k.tone).toBeNull();
    });
  });

  describe('window classification (rolling vs current vs cohort)', () => {
    it("ar_days is 'current' — last30 is null even though the underlying value differs by period", async () => {
      // ar.days has no period filter in computeCoreKpis at all (it's a live
      // snapshot over ALL currently-unpaid invoices), but this mock still
      // varies it by period to prove the tool itself nulls last30 for a
      // 'current' metric rather than merely passing through equal values.
      mockComputeCoreKpis.mockImplementation(async (period) => (
        period === 'last_7' ? kpiSet({ arDays: 34 }) : kpiSet({ arDays: 99 })
      ));
      const result = await executeBITool('get_operations_snapshot', {});
      const ar = result.kpis.find((k) => k.metric === 'ar_days');
      expect(ar.window).toBe('current');
      expect(ar.last7).toBe(34);
      expect(ar.last30).toBeNull();
    });

    it('a rolling metric (response_speed_min) keeps both last7 and last30', async () => {
      mockComputeCoreKpis.mockImplementation(async (period) => (
        period === 'last_7' ? kpiSet({ response: 64 }) : kpiSet({ response: 55 })
      ));
      const result = await executeBITool('get_operations_snapshot', {});
      const resp = result.kpis.find((k) => k.metric === 'response_speed_min');
      expect(resp.window).toBe('rolling');
      expect(resp.last7).toBe(64);
      expect(resp.last30).toBe(55);
    });

    it("retention_pct is 'cohort' — both values kept, and kpiWindow never words it as ending yesterday", async () => {
      mockComputeCoreKpis.mockImplementation(async (period) => (
        period === 'last_7' ? kpiSet({ retention: 97 }) : kpiSet({ retention: 95 })
      ));
      const result = await executeBITool('get_operations_snapshot', {});
      const ret = result.kpis.find((k) => k.metric === 'retention_pct');
      expect(ret.window).toBe('cohort');
      expect(ret.last7).toBe(97);
      expect(ret.last30).toBe(95);
      expect(result.kpiWindow.cohort).toMatch(/active today/);
      expect(result.kpiWindow.cohort).not.toMatch(/ending yesterday/);
    });
  });

  describe('opsLine — deterministic "Ops 7d: ..." SMS line', () => {
    // A "good" baseline for every targeted metric (stops_per_hour has no
    // target either way) so each scenario only has to override the metric(s)
    // it's testing.
    const GOOD = {
      completion: 90, callback: 3, response: 50, conversion: 25,
      rpmh: 130, margin: 45, arDays: 20, retention: 90, collection: 75,
    };

    it('ranks two off-target metrics bad-before-warn', async () => {
      // response_speed_min: target 60 (lowerIsBetter), 90 misses by 30 vs a
      // band of 6 => bad. completion_rate: target 85, 80 misses by 5 vs a
      // band of 8.5 => warn.
      mockComputeCoreKpis.mockResolvedValue(kpiSet({ ...GOOD, response: 90, completion: 80 }));
      const result = await executeBITool('get_operations_snapshot', {});
      expect(result.opsLine).toBe('Ops 7d: resp 90m (tgt 60m), completion 80% (tgt 85%)');
    });

    it('is "Ops 7d: all on target" when every targeted metric meets its target', async () => {
      mockComputeCoreKpis.mockResolvedValue(kpiSet(GOOD));
      const result = await executeBITool('get_operations_snapshot', {});
      expect(result.opsLine).toBe('Ops 7d: all on target');
    });

    it('is "Ops 7d: KPIs unavailable" on a computeCoreKpis failure — never "all on target"', async () => {
      mockComputeCoreKpis.mockRejectedValue(new Error('dashboard query failed'));
      const result = await executeBITool('get_operations_snapshot', {});
      expect(result.opsLine).toBe('Ops 7d: KPIs unavailable');
    });

    it('flags a null targeted metric as "; n/a: ..." and narrows the claim to "rest on target"', async () => {
      // Every other targeted metric is at its good value; ar_days alone came
      // back null (e.g. its query threw while the rest of computeCoreKpis
      // succeeded — a partial failure, not a total one).
      mockComputeCoreKpis.mockResolvedValue(kpiSet({ ...GOOD, arDays: null }));
      const result = await executeBITool('get_operations_snapshot', {});
      expect(result.opsLine).toBe('Ops 7d: rest on target; n/a: AR days');
    });

    it('lists only the worst 4 when more than 4 metrics are off target', async () => {
      // bad (desc relative miss): ar_days (2.0), response_speed_min (1.5),
      // collection_rate (1.0); warn (desc relative miss): gross_margin (0.1)
      // ahead of retention_pct (0.0824) and completion_rate (0.0588) — both
      // excluded by the top-4 cutoff. callback_rate, lead_conversion, rpmh
      // stay at GOOD; stops_per_hour has no target.
      mockComputeCoreKpis.mockResolvedValue(kpiSet({
        completion: 80, callback: GOOD.callback, response: 150, conversion: GOOD.conversion,
        rpmh: GOOD.rpmh, margin: 36, arDays: 90, retention: 78, collection: 0,
      }));
      const result = await executeBITool('get_operations_snapshot', {});
      expect(result.opsLine).toBe(
        'Ops 7d: AR days 90d (tgt 30d), resp 150m (tgt 60m), collections 0% (tgt 70%), margin 36% (tgt 40%)'
      );
    });
  });

  describe('collection_rate small-sample fade (Codex P2, bi-agent-tools.js:111)', () => {
    // Mirrors the dashboard tile's own guard: client/src/pages/admin/dashboard/
    // KpiTile.jsx MIN_CONFIDENT_N = 5, fed by CashSection.jsx's
    // `n={kpis.billing?.issuedCount}`.
    const GOOD = {
      completion: 90, callback: 3, response: 50, conversion: 25,
      rpmh: 130, margin: 45, arDays: 20, retention: 90,
    };

    it('1-4 issued invoices: tone is null, the row is marked lowSample, and it never appears in opsLine even far off target', async () => {
      // collection_rate at 0% against a 70% target would otherwise be the
      // single worst outlier in the whole set — it must still be silently
      // withheld, not merely de-prioritized.
      mockComputeCoreKpis.mockResolvedValue(kpiSet({ ...GOOD, collection: 0, issuedCount: 3 }));
      const result = await executeBITool('get_operations_snapshot', {});

      const collection = result.kpis.find((k) => k.metric === 'collection_rate');
      expect(collection).toMatchObject({ n: 3, lowSample: true, tone: null });

      // Every other targeted metric is at GOOD, so with collection_rate
      // correctly withheld the line reads "all on target" — not a collections
      // miss, and not an "; n/a: ..." mention either (that bucket is for a
      // real computation failure, not a too-small sample).
      expect(result.opsLine).toBe('Ops 7d: all on target');
      expect(result.opsLine).not.toMatch(/collections/);
    });

    it('5+ issued invoices: collection_rate is graded exactly as before', async () => {
      mockComputeCoreKpis.mockResolvedValue(kpiSet({ ...GOOD, collection: 0, issuedCount: 5 }));
      const result = await executeBITool('get_operations_snapshot', {});

      const collection = result.kpis.find((k) => k.metric === 'collection_rate');
      expect(collection).toMatchObject({ n: 5, lowSample: false, tone: 'bad' });
      expect(result.opsLine).toMatch(/collections 0% \(tgt 70%\)/);
    });
  });
});
