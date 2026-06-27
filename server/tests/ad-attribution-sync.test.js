const {
  syncCustomerAdAttribution,
  projectedLtv12moGP,
  pickPrimaryAttributionRow,
  buildAttributionPatch,
} = require('../services/ad-attribution-sync');

// ---------------------------------------------------------------------------
// Pure helpers (carry the correctness weight)
// ---------------------------------------------------------------------------
describe('projectedLtv12moGP', () => {
  test('recurring with realized margin: rate × realized-margin × 12', () => {
    // 240/400 = 0.6 margin; 100 × 0.6 × 12 = 720
    expect(projectedLtv12moGP({ monthlyRate: 100, realizedRevenue: 400, realizedGrossProfit: 240 })).toBe(720);
  });

  test('recurring with no realized revenue falls back to the target margin', () => {
    expect(projectedLtv12moGP({ monthlyRate: 100, realizedRevenue: 0, realizedGrossProfit: 0, targetMarginPct: 55 })).toBe(660);
  });

  test('recurring with no realized revenue and no target uses the 55% default', () => {
    expect(projectedLtv12moGP({ monthlyRate: 100, realizedRevenue: 0 })).toBe(660);
  });

  test('non-recurring (no monthly rate) → null', () => {
    expect(projectedLtv12moGP({ monthlyRate: 0, realizedRevenue: 400, realizedGrossProfit: 240 })).toBeNull();
    expect(projectedLtv12moGP({})).toBeNull();
  });
});

describe('pickPrimaryAttributionRow', () => {
  test('picks the first-touch (earliest lead_date) advanceable row', () => {
    const rows = [
      { id: 'b', funnel_stage: 'lead', lead_date: '2026-02-01' },
      { id: 'a', funnel_stage: 'booked', lead_date: '2026-01-10' },
    ];
    expect(pickPrimaryAttributionRow(rows).id).toBe('a');
  });

  test('breaks lead_date ties by created_at', () => {
    const rows = [
      { id: 'late', funnel_stage: 'lead', lead_date: '2026-01-10', created_at: '2026-01-10T12:00' },
      { id: 'early', funnel_stage: 'lead', lead_date: '2026-01-10', created_at: '2026-01-10T09:00' },
    ];
    expect(pickPrimaryAttributionRow(rows).id).toBe('early');
  });

  test('excludes lost rows', () => {
    const rows = [
      { id: 'lost', funnel_stage: 'lost', lead_date: '2026-01-01' },
      { id: 'live', funnel_stage: 'lead', lead_date: '2026-02-01' },
    ];
    expect(pickPrimaryAttributionRow(rows).id).toBe('live');
  });

  test('returns null when no rows are advanceable (all lost)', () => {
    expect(pickPrimaryAttributionRow([{ id: 'x', funnel_stage: 'lost' }])).toBeNull();
    expect(pickPrimaryAttributionRow([])).toBeNull();
  });
});

describe('buildAttributionPatch', () => {
  const realized = { revenue: 400, grossProfit: 240, visits: 4 };

  test('writes funnel/revenue/profit/margin/LTV; recurring true', () => {
    const patch = buildAttributionPatch({
      realized, isRecurring: true, monthlyRate: 100, targetMarginPct: 55,
      asaCols: { gross_margin_pct: 1, projected_ltv_12mo: 1 }, now: 'T',
    });
    expect(patch).toMatchObject({
      funnel_stage: 'completed',
      completed_revenue: 400,
      gross_profit: 240,
      gross_margin_pct: 60,
      projected_ltv_12mo: 720,
      is_recurring: true,
    });
  });

  test('omits optional columns the table does not have', () => {
    const patch = buildAttributionPatch({ realized, isRecurring: true, monthlyRate: 100, asaCols: {}, now: 'T' });
    expect(patch).not.toHaveProperty('gross_margin_pct');
    expect(patch).not.toHaveProperty('projected_ltv_12mo');
    expect(patch.completed_revenue).toBe(400);
  });

  test('not recurring (caller-classified): is_recurring false and no projected LTV even with a stale rate', () => {
    const patch = buildAttributionPatch({
      realized, isRecurring: false, monthlyRate: 50, asaCols: { projected_ltv_12mo: 1 }, now: 'T',
    });
    expect(patch.is_recurring).toBe(false);
    expect(patch.projected_ltv_12mo).toBeNull();
  });

  test('recurring tier-only member (no monthly rate): recurring true but projected LTV null', () => {
    const patch = buildAttributionPatch({
      realized, isRecurring: true, monthlyRate: 0, asaCols: { projected_ltv_12mo: 1 }, now: 'T',
    });
    expect(patch.is_recurring).toBe(true);
    expect(patch.projected_ltv_12mo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Orchestration (fake knex)
// ---------------------------------------------------------------------------
function makeDb(state) {
  const captured = (state.captured = state.captured || {});
  const asa = () => ({
    columnInfo: () => Promise.resolve(state.asaCols || {}),
    where: (cond) => {
      const b = {
        update: (patch) => { captured.update = { where: cond, patch }; return Promise.resolve(1); },
        then: (res, rej) => Promise.resolve(state.asaRows || []).then(res, rej),
      };
      return b;
    },
    // non-primary clear chain: .whereIn('id', ids).whereNotNull('completed_revenue').update(clear)
    whereIn: (col, ids) => ({
      whereNotNull: () => ({
        update: (patch) => { captured.clear = { ids, patch }; return Promise.resolve(state.clearedCount ?? 0); },
      }),
    }),
  });
  // job_costs: .columnInfo(); .where({customer_id}).where('service_date','>=',since).first(...)
  const jc = () => {
    const b = {
      columnInfo: () => Promise.resolve(state.jcCols === undefined ? { service_date: 1, revenue: 1, gross_profit: 1 } : state.jcCols),
      where: (a, op, val) => { if (a === 'service_date') captured.jcSince = val; return b; },
      first: () => Promise.resolve(state.agg || { revenue: 0, gross_profit: 0, visits: 0 }),
    };
    return b;
  };
  const cust = () => ({ where: () => ({ first: () => Promise.resolve(state.customer || null) }) });
  const fin = () => ({ orderBy: () => ({ first: () => Promise.resolve(state.financials || null) }) });
  const db = (table) => {
    const t = String(table);
    if (t === 'ad_service_attribution') return asa();
    if (t === 'job_costs') return jc();
    if (t === 'customers') return cust();
    if (t === 'company_financials') return fin();
    throw new Error(`unexpected table ${t}`);
  };
  db.raw = (sql) => ({ sql });
  return db;
}

describe('syncCustomerAdAttribution', () => {
  test('writes realized totals to the primary row and advances it to completed', async () => {
    const state = {
      asaCols: { completed_revenue: 1, gross_profit: 1, gross_margin_pct: 1, projected_ltv_12mo: 1 },
      asaRows: [{ id: 'a1', customer_id: 'c1', funnel_stage: 'lead', lead_date: '2026-01-10' }],
      agg: { revenue: 400, gross_profit: 240, visits: 4 },
      customer: { id: 'c1', monthly_rate: 100 },
      financials: { target_gross_margin_pct: 55 },
    };
    const db = makeDb(state);
    const res = await syncCustomerAdAttribution('c1', db);

    expect(res.updated).toBe(1);
    expect(state.captured.update.where).toEqual({ id: 'a1' });
    expect(state.captured.jcSince).toBe('2026-01-10'); // revenue scoped to on/after the lead
    expect(state.captured.update.patch).toMatchObject({
      funnel_stage: 'completed',
      completed_revenue: 400,
      gross_profit: 240,
      gross_margin_pct: 60,
      projected_ltv_12mo: 720, // 100 × 0.6 × 12
      is_recurring: true,
    });
  });

  test('credits the first-touch row and CLEARS stale totals from a non-primary row', async () => {
    const state = {
      asaCols: { completed_revenue: 1, gross_profit: 1, gross_margin_pct: 1, projected_ltv_12mo: 1 },
      asaRows: [
        // a previously-synced row that is no longer first-touch
        { id: 'old', customer_id: 'c1', funnel_stage: 'completed', lead_date: '2026-03-01', completed_revenue: 300 },
        // a later-inserted EARLIER-dated row (e.g. backdated call lead) → new primary
        { id: 'new', customer_id: 'c1', funnel_stage: 'lead', lead_date: '2026-01-05' },
      ],
      agg: { revenue: 400, gross_profit: 240, visits: 4 },
      customer: { id: 'c1', monthly_rate: 100 },
      financials: { target_gross_margin_pct: 55 },
      clearedCount: 1,
    };
    const res = await syncCustomerAdAttribution('c1', makeDb(state));
    expect(res.primaryId).toBe('new'); // earliest lead_date wins
    expect(state.captured.update.where).toEqual({ id: 'new' });
    expect(state.captured.clear.ids).toEqual(['old']);
    expect(state.captured.clear.patch).toMatchObject({
      completed_revenue: null, gross_profit: null, gross_margin_pct: null, projected_ltv_12mo: null,
    });
  });

  test('classifies a tier-only member (monthly_rate 0) as recurring; no projected LTV without a rate', async () => {
    const state = {
      asaCols: { completed_revenue: 1, projected_ltv_12mo: 1 },
      asaRows: [{ id: 'a1', customer_id: 'c1', funnel_stage: 'lead', lead_date: '2026-01-10' }],
      agg: { revenue: 400, gross_profit: 240, visits: 4 },
      customer: { id: 'c1', waveguard_tier: 'Gold', monthly_rate: 0 },
    };
    await syncCustomerAdAttribution('c1', makeDb(state));
    expect(state.captured.update.patch.is_recurring).toBe(true);
    expect(state.captured.update.patch.projected_ltv_12mo).toBeNull();
  });

  test('a one-time customer with a stale monthly_rate is NOT credited recurring LTV', async () => {
    const state = {
      asaCols: { completed_revenue: 1, projected_ltv_12mo: 1 },
      asaRows: [{ id: 'a1', customer_id: 'c1', funnel_stage: 'lead', lead_date: '2026-01-10' }],
      agg: { revenue: 400, gross_profit: 240, visits: 4 },
      customer: { id: 'c1', waveguard_tier: 'One-Time', monthly_rate: 50 },
    };
    await syncCustomerAdAttribution('c1', makeDb(state));
    expect(state.captured.update.patch.is_recurring).toBe(false);
    expect(state.captured.update.patch.projected_ltv_12mo).toBeNull();
  });

  test('no-ops with a reason when the customer has no attribution row', async () => {
    const db = makeDb({ asaCols: { completed_revenue: 1 }, asaRows: [] });
    expect(await syncCustomerAdAttribution('c1', db)).toEqual({ updated: 0, reason: 'no_attribution' });
  });

  test('no-ops when the customer has an attribution row but no completed costed visit', async () => {
    const state = {
      asaCols: { completed_revenue: 1 },
      asaRows: [{ id: 'a1', customer_id: 'c1', funnel_stage: 'lead' }],
      srCols: { revenue: 1, gross_profit: 1, status: 1 },
      agg: { revenue: 0, gross_profit: 0, visits: 0 },
    };
    const res = await syncCustomerAdAttribution('c1', makeDb(state));
    expect(res).toEqual({ updated: 0, reason: 'no_completed_visits' });
    expect(state.captured.update).toBeUndefined(); // nothing written
  });

  test('no-ops when the attribution columns are absent', async () => {
    const db = makeDb({ asaCols: {} });
    expect(await syncCustomerAdAttribution('c1', db)).toEqual({ updated: 0, reason: 'cols_absent' });
  });

  test('no-ops when the only row is lost (not resurrected)', async () => {
    const db = makeDb({
      asaCols: { completed_revenue: 1 },
      asaRows: [{ id: 'a1', customer_id: 'c1', funnel_stage: 'lost' }],
    });
    expect(await syncCustomerAdAttribution('c1', db)).toEqual({ updated: 0, reason: 'no_advanceable_rows' });
  });
});
