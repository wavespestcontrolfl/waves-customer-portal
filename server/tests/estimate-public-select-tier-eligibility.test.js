process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

/**
 * PUT /api/estimates/:token/select-tier eligibility ceiling (validation audit
 * SEC-001, 2026-09-02).
 *
 * The route applies a FLAT tier percentage to the stored recurring base. Before
 * this guard the ceiling applied only to estimates carrying a service-opt-out
 * record, so any token holder could persist Platinum on a one-service quote —
 * 20% off the row totals that every no-replay accept and the converter bill
 * from. The ceiling is the tier the ENGINE wrote for the current mix (opt-out
 * stamp, else stored result / raw engineResult tier, else the qualifying-row
 * count of the stored recurring rows) — never the row's own waveguard_tier.
 * Downgrades stay allowed.
 */

// ── Minimal in-memory knex fake ──────────────────────────────────────────
// Just enough for the select-tier write: eq filters, null / not-in
// predicates, first/update. raw / whereRaw / modify are inert — fixtures keep
// updated_at null so the route's ms-truncated CAS predicate is not added.
jest.mock('../models/db', () => {
  const state = { tables: {} };
  const makeBuilder = (table) => {
    const ctx = { eq: [], nulls: [], notIn: [] };
    const rows = () => (state.tables[table] = state.tables[table] || []);
    const matches = (row) => ctx.eq.every((f) => Object.entries(f).every(([k, v]) => String(row[k]) === String(v)))
      && ctx.nulls.every((c) => row[c] == null)
      && ctx.notIn.every(([c, arr]) => !arr.includes(row[c]));
    const matched = () => rows().filter(matches);
    const b = {};
    b.where = (arg, ...rest) => {
      if (typeof arg === 'function') { arg.call(b, b); return b; }
      if (typeof arg === 'object' && arg !== null && !arg.__raw) { ctx.eq.push(arg); return b; }
      if (typeof arg === 'string') ctx.eq.push({ [arg]: rest[rest.length - 1] });
      return b;
    };
    b.andWhere = b.where;
    b.whereRaw = () => b;
    b.andWhereRaw = () => b;
    b.orWhere = () => b;
    b.orWhereNull = () => b;
    b.whereIn = () => b;
    b.whereNot = () => b;
    b.whereNotNull = () => b;
    b.whereNull = (c) => { ctx.nulls.push(c); return b; };
    b.whereNotIn = (c, arr) => { ctx.notIn.push([c, arr]); return b; };
    b.modify = (fn) => { fn(b); return b; };
    b.select = () => b;
    b.orderBy = () => b;
    b.limit = () => b;
    b.forUpdate = () => b;
    b.leftJoin = () => b;
    b.first = async () => { const r = matched()[0]; return r ? { ...r } : undefined; };
    b.update = (obj) => { const hits = matched(); hits.forEach((r) => Object.assign(r, obj)); return Promise.resolve(hits.length); };
    b.insert = async (row) => [{ id: `${table}-${rows().length + 1}`, ...row }];
    b.pluck = async () => [];
    b.del = async () => 0;
    b.count = () => ({ first: async () => ({ count: matched().length }) });
    b.then = (res, rej) => Promise.resolve(matched().map((r) => ({ ...r }))).then(res, rej);
    return b;
  };
  const dbFn = (table) => makeBuilder(table);
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql, bindings) => ({ __raw: sql, bindings });
  dbFn.schema = { hasColumn: async () => false };
  dbFn.transaction = async (cb) => cb(dbFn);
  dbFn.__state = state;
  return dbFn;
});
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
  notifyCustomer: jest.fn(async () => ({})),
}));

const express = require('express');
const db = require('../models/db');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { selectTierCeiling, applyMembershipRepriceToEstimate } = require('../routes/estimate-public');
const { serviceOptOutEngineTierReference } = require('../services/estimate-service-opt-out');

let server;
let base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/estimates', require('../routes/estimate-public'));
  app.use((err, req, res, next) => {  
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const PROPERTY = { homeSqFt: 2000, lotSqFt: 8000, lawnSqFt: 4500, propertyType: 'single_family' };
const LAWN = { track: 'st_augustine', tier: 'standard' };

function engineEstimateData(services) {
  const engineInputs = { ...PROPERTY, services };
  const raw = generateEstimate(engineInputs);
  return { raw, estimateData: { result: mapV1ToLegacyShape(raw), engineResult: raw, engineInputs } };
}

let seq = 0;
function estimateRow(estimateData, overrides = {}) {
  seq += 1;
  return {
    id: `est-tier-${seq}`,
    token: `tok-tier-${seq}-x0123456789abcdef`,
    status: 'sent',
    customer_id: null,
    customer_name: 'Pat Tester',
    customer_phone: '(941) 555-0123',
    customer_email: 'pat@example.com',
    address: '123 Palm Ave, Bradenton, FL',
    monthly_total: 0,
    annual_total: 0,
    onetime_total: 0,
    waveguard_tier: 'Bronze',
    show_one_time_option: false,
    bill_by_invoice: false,
    expires_at: null,
    price_locked_at: null,
    archived_at: null,
    updated_at: null,
    estimate_data: JSON.stringify(estimateData),
    ...overrides,
  };
}

function seed(row) {
  db.__state.tables = { estimates: [row], customers: [], call_log: [], leads: [] };
  return () => db.__state.tables.estimates[0];
}

async function selectTier(token, selectedTier) {
  const res = await fetch(`${base}/api/estimates/${token}/select-tier`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedTier }),
  });
  return { status: res.status, data: await res.json() };
}

describe('selectTierCeiling', () => {
  test('the opt-out commit stamp outranks the stored result tier', () => {
    expect(selectTierCeiling({
      serviceOptOut: { engineTier: 'Silver' },
      result: { recurring: { waveGuardTier: 'Gold', services: [] } },
    })).toBe('Silver');
  });

  test('stored result tier, then the raw engine shapes (engine casing normalized)', () => {
    expect(selectTierCeiling({ result: { recurring: { waveGuardTier: 'Gold' } } })).toBe('Gold');
    expect(selectTierCeiling({ engineResult: { waveGuard: { tier: 'platinum' } } })).toBe('Platinum');
    // Raw engine output stored under result / at the root — an existing
    // member's prior services are folded into that tier, so the row-count
    // fallback must never run for these shapes.
    expect(selectTierCeiling({ result: { waveGuard: { tier: 'gold' }, lineItems: [{ service: 'pest_control' }] } })).toBe('Gold');
    expect(selectTierCeiling({ waveGuard: { tier: 'silver' }, lineItems: [{ service: 'pest_control' }] })).toBe('Silver');
    expect(serviceOptOutEngineTierReference({ result: { waveGuard: { tier: 'gold' } } })).toBe('gold');
    expect(serviceOptOutEngineTierReference({ waveGuard: { tier: 'silver' } })).toBe('silver');
  });

  test('legacy top-level mapped blobs and engineResult.recurring carry the engine tier too', () => {
    // estimate-public resolves `estData.result || estData`: the mapped result
    // can sit at the root of estimate_data with its tier beside the rows.
    expect(selectTierCeiling({ recurring: { waveGuardTier: 'Gold', services: [{ service: 'pest_control', mo: 37.33 }] } })).toBe('Gold');
    expect(selectTierCeiling({ recurring: { tier: 'silver', services: [{ service: 'pest_control', mo: 37.33 }] } })).toBe('Silver');
    expect(selectTierCeiling({ engineResult: { recurring: { tier: 'platinum' } } })).toBe('Platinum');
    expect(serviceOptOutEngineTierReference({ recurring: { tier: 'silver' } })).toBe('silver');
    expect(serviceOptOutEngineTierReference({ engineResult: { recurring: { waveGuardTier: 'Gold' } } })).toBe('Gold');
    // Blank strings are not evidence — the chain keeps looking.
    expect(serviceOptOutEngineTierReference({ recurring: { waveGuardTier: '' }, engineResult: { waveGuard: { tier: 'gold' } } })).toBe('gold');
  });

  test('no engine-written tier in any carrier fails closed to Bronze whatever the rows say', () => {
    const rows = (services) => ({ result: { recurring: { services } } });
    const pest = { name: 'Pest Control', service: 'pest_control', mo: 37.33 };
    const lawn = { name: 'Lawn Care', service: 'lawn_care', mo: 38 };
    // Two live qualifiers, but no engine tier — deriving Silver here would
    // re-run today's policy over a quote priced under yesterday's.
    expect(selectTierCeiling(rows([pest, lawn]))).toBe('Bronze');
    // Row flags are not evidence: synthesized rows carry them for every
    // recurring line (palm included), and a stamped legacy rodent row was
    // priced under the pre-2026-08-29 no-tier posture.
    expect(selectTierCeiling(rows([pest, lawn, { name: 'Palm Injection', service: 'palm_injection', mo: 14.58, countsTowardWaveGuardTier: true }]))).toBe('Bronze');
    expect(selectTierCeiling(rows([pest, { name: 'Rodent Bait Stations', service: 'rodent_bait', mo: 29.67, perApplicationBilled: true, stations: 6 }]))).toBe('Bronze');
    expect(selectTierCeiling({ engineResult: { lineItems: [{ service: 'pest_control' }, { service: 'lawn_care' }] } })).toBe('Bronze');
  });

  test('no recurring evidence at all fails closed to Bronze', () => {
    expect(selectTierCeiling({})).toBe('Bronze');
    expect(selectTierCeiling(null)).toBe('Bronze');
    expect(selectTierCeiling({ result: { oneTime: { items: [{ name: 'WDO Inspection', price: 250 }] } } })).toBe('Bronze');
  });

  test('the engine tier the route trusts is the one the opt-out gate reads', () => {
    const data = engineEstimateData({ pest: { frequency: 'quarterly' }, lawn: LAWN, mosquito: { tier: 'seasonal' } }).estimateData;
    expect(serviceOptOutEngineTierReference(data)).toBe('Gold');
    expect(selectTierCeiling(data)).toBe('Gold');
    expect(serviceOptOutEngineTierReference({})).toBeNull();
  });
});

describe('membership reconcile refreshes the opt-out stamp the ceiling reads (pre-push codex P0)', () => {
  test('a lapsed member cannot re-select the old member tier after the reconcile reprice', () => {
    // Sent as a Gold member with an opt-out commit stamped Gold; the plan
    // lapsed and the reconcile repriced the mix at the non-member tier.
    const estimate = { id: 'est-lapsed', waveguard_tier: 'Gold', monthly_total: 90, annual_total: 1080, onetime_total: 0 };
    const estData = {
      result: { recurring: { waveGuardTier: 'Gold', services: [{ service: 'pest_control', mo: 90 }] } },
      serviceOptOut: { engineTier: 'Gold', events: [] },
      membershipLapsedRequote: true,
    };
    const reprice = {
      recomputed: true,
      serverResult: { recurring: { waveGuardTier: 'Bronze', services: [{ service: 'pest_control', mo: 112 }] } },
      serverTotals: { monthlyTotal: 112, annualTotal: 1344, onetimeTotal: 0 },
    };
    applyMembershipRepriceToEstimate(estimate, estData, reprice);
    expect(estimate.waveguard_tier).toBe('Bronze');
    expect(estimate.monthly_total).toBe(112);
    expect(estData.membershipLapsedRequote).toBeUndefined();
    expect(estData.serviceOptOut.engineTier).toBe('Bronze');
    expect(serviceOptOutEngineTierReference(estData)).toBe('Bronze');
    expect(selectTierCeiling(estData)).toBe('Bronze');
  });

  test('a blob without an opt-out record gains no stamp', () => {
    const estimate = { waveguard_tier: 'Silver' };
    const estData = { result: { recurring: { waveGuardTier: 'Silver' } } };
    applyMembershipRepriceToEstimate(estimate, estData, {
      recomputed: true,
      serverResult: { recurring: { waveGuardTier: 'Bronze' } },
      serverTotals: { monthlyTotal: 50, annualTotal: 600, onetimeTotal: 0 },
    });
    expect(estData.serviceOptOut).toBeUndefined();
    expect(selectTierCeiling(estData)).toBe('Bronze');
  });
});

describe('PUT /:token/select-tier — eligibility ceiling on every estimate', () => {
  test('a Bronze single-service estimate cannot self-assign Platinum; the row is untouched', async () => {
    const { raw, estimateData } = engineEstimateData({ pest: { frequency: 'quarterly' } });
    expect(raw.waveGuard.tier).toBe('bronze');
    const read = seed(estimateRow(estimateData, {
      monthly_total: raw.summary.recurringMonthlyAfterDiscount,
      annual_total: raw.summary.recurringAnnualAfterDiscount,
    }));
    const before = { ...read() };

    const r = await selectTier(before.token, 'Platinum');
    expect(r.status).toBe(400);
    expect(r.data).toEqual({ error: 'tier_not_available_for_current_services', maxTier: 'Bronze' });
    expect(read().waveguard_tier).toBe('Bronze');
    expect(read().monthly_total).toBe(before.monthly_total);
    expect(read().annual_total).toBe(before.annual_total);
  });

  test('re-selecting the earned tier is still a 200 (no discount granted)', async () => {
    const { raw, estimateData } = engineEstimateData({ pest: { frequency: 'quarterly' } });
    const read = seed(estimateRow(estimateData, {
      monthly_total: raw.summary.recurringMonthlyAfterDiscount,
      annual_total: raw.summary.recurringAnnualAfterDiscount,
    }));
    const r = await selectTier(read().token, 'Bronze');
    expect(r.status).toBe(200);
    expect(r.data.tier).toBe('Bronze');
    expect(r.data.monthlyTotal).toBeCloseTo(raw.summary.recurringMonthlyAfterDiscount, 2);
    expect(read().waveguard_tier).toBe('Bronze');
  });

  test('a Gold three-service estimate may step down to Silver but not up to Platinum', async () => {
    const { raw, estimateData } = engineEstimateData({ pest: { frequency: 'quarterly' }, lawn: LAWN, mosquito: { tier: 'seasonal' } });
    expect(raw.waveGuard.tier).toBe('gold');
    const read = seed(estimateRow(estimateData, {
      waveguard_tier: 'Gold',
      monthly_total: raw.summary.recurringMonthlyAfterDiscount,
      annual_total: raw.summary.recurringAnnualAfterDiscount,
    }));

    const up = await selectTier(read().token, 'Platinum');
    expect(up.status).toBe(400);
    expect(up.data.maxTier).toBe('Gold');
    expect(read().waveguard_tier).toBe('Gold');

    const down = await selectTier(read().token, 'Silver');
    expect(down.status).toBe(200);
    expect(down.data.tier).toBe('Silver');
    expect(read().waveguard_tier).toBe('Silver');
    // Silver collects MORE than Gold on the same base: the downgrade never lowers the row.
    expect(down.data.monthlyTotal).toBeGreaterThan(raw.summary.recurringMonthlyAfterDiscount);
  });

  test('a dip written by this route never becomes a new ceiling (row tier is ignored)', async () => {
    const { raw, estimateData } = engineEstimateData({ pest: { frequency: 'quarterly' }, lawn: LAWN, mosquito: { tier: 'seasonal' } });
    const read = seed(estimateRow(estimateData, {
      waveguard_tier: 'Bronze', // customer previously dipped to Bronze via this route
      monthly_total: raw.summary.recurringMonthlyAfterDiscount,
      annual_total: raw.summary.recurringAnnualAfterDiscount,
    }));
    const backToGold = await selectTier(read().token, 'Gold');
    expect(backToGold.status).toBe(200);
    expect(read().waveguard_tier).toBe('Gold');
  });

  test('an opt-out commit stamp caps the ceiling below the stored result tier (existing behaviour kept)', async () => {
    const { raw, estimateData } = engineEstimateData({ pest: { frequency: 'quarterly' }, lawn: LAWN, mosquito: { tier: 'seasonal' } });
    const read = seed(estimateRow({ ...estimateData, serviceOptOut: { engineTier: 'Silver' } }, {
      waveguard_tier: 'Silver',
      monthly_total: raw.summary.recurringMonthlyAfterDiscount,
      annual_total: raw.summary.recurringAnnualAfterDiscount,
    }));
    const r = await selectTier(read().token, 'Gold');
    expect(r.status).toBe(400);
    expect(r.data.maxTier).toBe('Silver');
    const ok = await selectTier(read().token, 'Silver');
    expect(ok.status).toBe(200);
  });

  test('a legacy blob with no engine tier and no recurring rows refuses every upgrade', async () => {
    const read = seed(estimateRow({ result: { recurring: { services: [] }, oneTime: { items: [] } } }, {
      monthly_total: 0, annual_total: 0,
    }));
    const r = await selectTier(read().token, 'Silver');
    expect(r.status).toBe(400);
    expect(r.data.maxTier).toBe('Bronze');
  });

  test('accepted / price-locked rows are refused before any ceiling math', async () => {
    const { raw, estimateData } = engineEstimateData({ pest: { frequency: 'quarterly' } });
    const read = seed(estimateRow(estimateData, { status: 'accepted', price_locked_at: new Date(), monthly_total: raw.summary.recurringMonthlyAfterDiscount }));
    const r = await selectTier(read().token, 'Bronze');
    expect(r.status).toBe(400);
    expect(r.data.error).toBe('Estimate is no longer active');
  });
});
