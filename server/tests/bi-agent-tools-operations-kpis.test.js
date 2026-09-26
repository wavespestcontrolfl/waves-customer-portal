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
jest.mock('../services/forecast-analyzer', () => ({ analyzeTomorrow: async () => ({ needsReschedule: [] }) }), { virtual: true });

const mockComputeCoreKpis = jest.fn();
jest.mock('../routes/admin-dashboard', () => ({ computeCoreKpis: (...a) => mockComputeCoreKpis(...a) }));

const { executeBITool } = require('../services/bi-agent-tools');

// Only the paths get_operations_snapshot's kpis actually read.
function kpiSet({ completion = 80, callback = 3, response = 64, conversion = 22, stops = 4.2, rpmh = 90, margin = 38, arDays = 34, retention = 88, collection = 65 } = {}) {
  return {
    service: { completionRate: completion, callbackRate: callback },
    sales: { avgResponseMin: response, conversion },
    financial: { stopsPerHour: stops, rpmh, grossMarginWeighted: margin },
    ar: { days: arDays },
    retention: { pct: retention },
    billing: { collectionRate: collection },
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

    expect(mockComputeCoreKpis).toHaveBeenCalledWith('last_7');
    expect(mockComputeCoreKpis).toHaveBeenCalledWith('last_30');
    expect(result.kpiWindow).toEqual({
      last7: 'rolling 7 days ending today (ET)',
      baseline: 'rolling 30 days ending today (ET)',
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
});
