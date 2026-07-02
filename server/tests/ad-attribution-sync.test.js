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

  test('sorts chronologically when lead_date is a JS Date (pg DATE), not by weekday text', () => {
    // String(Date) would put "Wed Apr 01" before "Mon Feb..." etc.; must be chronological.
    const rows = [
      { id: 'apr', funnel_stage: 'lead', lead_date: new Date('2026-04-01') },
      { id: 'feb', funnel_stage: 'lead', lead_date: new Date('2026-02-15') },
    ];
    expect(pickPrimaryAttributionRow(rows).id).toBe('feb');
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
        forUpdate: () => ({ first: () => Promise.resolve(null) }), // row lock no-op
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
  // job_costs: .columnInfo(); .join(ss).where('jc.customer_id',id).where('ss.status','completed')
  //   [.where('jc.service_date','>=',since)] .first(...)
  const jc = () => {
    const b = {
      columnInfo: () => Promise.resolve(
        state.jcCols === undefined ? { scheduled_service_id: 1, service_date: 1, revenue: 1, gross_profit: 1 } : state.jcCols,
      ),
      join: () => b,
      where: (a, op, val) => { if (a === 'jc.service_date') captured.jcSince = val; return b; },
      first: () => Promise.resolve(state.agg || { revenue: 0, gross_profit: 0, visits: 0 }),
    };
    return b;
  };
  const cust = () => ({ where: () => ({ first: () => Promise.resolve(state.customer || null) }) });
  const fin = () => ({ orderBy: () => ({ first: () => Promise.resolve(state.financials || null) }) });
  const db = (table) => {
    const t = String(table);
    if (t === 'ad_service_attribution') return asa();
    if (t.startsWith('job_costs')) return jc(); // matches 'job_costs' and 'job_costs as jc'
    if (t === 'customers') return cust();
    if (t === 'company_financials') return fin();
    throw new Error(`unexpected table ${t}`);
  };
  db.raw = (sql) => ({ sql });
  db.transaction = (cb) => cb(db); // run the callback with this same fake as the trx
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
      funnel_stage: 'lead', // demoted so it stops counting as a completion
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

// ---------------------------------------------------------------------------
// sweepPendingAdAttribution — daily backstop. Candidates = customers with a
// funnel row, NO completed funnel row, and at least one completed visit.
// ---------------------------------------------------------------------------
const { sweepPendingAdAttribution } = require('../services/ad-attribution-sync');

// Wraps makeDb: intercepts the sweep's candidate query on
// 'ad_service_attribution as asa' and delegates every other table (including
// the inner per-customer sync) to the plain makeDb fake.
function makeSweepDb(state) {
  const inner = makeDb(state);
  const db = (table) => {
    if (String(table) === 'ad_service_attribution as asa') {
      const b = {
        whereNotNull: () => b,
        where: () => b,
        whereNotExists: () => b,
        whereExists: () => b,
        distinct: () => b,
        limit: (n) => { state.captured.limit = n; return b; },
        pluck: () => Promise.resolve(state.candidates || []),
      };
      return b;
    }
    return inner(table);
  };
  db.raw = inner.raw;
  db.transaction = (cb) => cb(db);
  state.captured = state.captured || {};
  return db;
}

describe('sweepPendingAdAttribution', () => {
  test('advances a stuck customer with completed costed visits', async () => {
    const state = {
      captured: {},
      candidates: ['c1'],
      asaCols: { completed_revenue: 1 },
      asaRows: [{ id: 'a1', customer_id: 'c1', funnel_stage: 'lead', lead_date: '2026-06-01' }],
      agg: { revenue: 214, gross_profit: 120, visits: 1 },
      customer: { id: 'c1', monthly_rate: 0 },
      financials: { target_gross_margin_pct: 55 },
    };
    const res = await sweepPendingAdAttribution(makeSweepDb(state));
    expect(res).toMatchObject({ candidates: 1, advanced: 1, skipped: 0 });
    expect(state.captured.update.where).toEqual({ id: 'a1' });
    expect(state.captured.update.patch.funnel_stage).toBe('completed');
  });

  test('counts a no-op sync (no completed visits since lead) as skipped, not advanced', async () => {
    const state = {
      captured: {},
      candidates: ['c1'],
      asaCols: { completed_revenue: 1 },
      asaRows: [{ id: 'a1', customer_id: 'c1', funnel_stage: 'lead', lead_date: '2026-06-01' }],
      agg: { revenue: 0, gross_profit: 0, visits: 0 },
      financials: { target_gross_margin_pct: 55 },
    };
    const res = await sweepPendingAdAttribution(makeSweepDb(state));
    expect(res).toMatchObject({ candidates: 1, advanced: 0, skipped: 1 });
    expect(state.captured.update).toBeUndefined(); // nothing written
  });

  test('no candidates → zeros without touching sync', async () => {
    const state = { captured: {}, candidates: [], asaCols: { completed_revenue: 1 } };
    const res = await sweepPendingAdAttribution(makeSweepDb(state));
    expect(res).toEqual({ candidates: 0, advanced: 0, skipped: 0 });
  });

  test('missing completed_revenue column → safe zeros (env without the migration)', async () => {
    const state = { captured: {}, candidates: ['c1'], asaCols: {} };
    const res = await sweepPendingAdAttribution(makeSweepDb(state));
    expect(res).toEqual({ candidates: 0, advanced: 0, skipped: 0 });
  });

  test('passes the batch limit through to the candidate query', async () => {
    const state = { captured: {}, candidates: [], asaCols: { completed_revenue: 1 } };
    await sweepPendingAdAttribution(makeSweepDb(state), { limit: 50 });
    expect(state.captured.limit).toBe(50);
  });
});

// PR #2257 P2: a late/backfilled EARLIER first-touch row must re-take primary
// from a previously-synced completed row — the sweep must hand sync those
// customers (predicate guarded by wiring test below; behavior via sync).
describe('sweepPendingAdAttribution re-pick (stale completed primary)', () => {
  test('candidate with a completed row + earlier backfilled row → primary re-picked, stale cleared', async () => {
    const state = {
      captured: {},
      candidates: ['c1'],
      asaCols: { completed_revenue: 1, gross_profit: 1 },
      asaRows: [
        { id: 'stale', customer_id: 'c1', funnel_stage: 'completed', lead_date: '2026-06-20', completed_revenue: 300 },
        { id: 'backfilled', customer_id: 'c1', funnel_stage: 'lead', lead_date: '2026-05-01' },
      ],
      agg: { revenue: 300, gross_profit: 150, visits: 2 },
      customer: { id: 'c1', monthly_rate: 0 },
      financials: { target_gross_margin_pct: 55 },
      clearedCount: 1,
    };
    const res = await sweepPendingAdAttribution(makeSweepDb(state));
    expect(res.advanced).toBe(1);
    expect(state.captured.update.where).toEqual({ id: 'backfilled' }); // earlier first-touch wins
    expect(state.captured.clear.ids).toEqual(['stale']);               // old primary demoted
  });

  test('candidate-query predicate includes the stale-primary re-pick branch', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/ad-attribution-sync.js'), 'utf8');
    expect(src).toMatch(/orWhereExists\(function backfilledEarlierFirstTouch/);
    expect(src).toMatch(/pend\.lead_date < \(SELECT MIN\(done2\.lead_date\)/);
    expect(src).toMatch(/whereNotIn\('pend\.funnel_stage', \['completed', 'lost'\]\)/);
  });
});
