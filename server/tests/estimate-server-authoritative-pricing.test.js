/**
 * Decision #2 — server is authoritative on the persisted/billed price.
 *
 * Covers: recompute corrects an inflated client preview, the embedded blob is
 * overwritten to agree with the columns, drift is recorded, the fail-open path
 * is loud (CLIENT_FALLBACK + logger.error), quote-required estimates are exempt,
 * and a real end-to-end recompute through the actual engine.
 */
jest.mock('../models/db', () => jest.fn());

const {
  createOrReuseAdminEstimate,
  serverRecomputeFromEstimateData,
  resolveServerAuthoritativePricing,
  compareClientToServer,
} = require('../services/admin-estimate-persistence');
const logger = require('../services/logger');
const { clearAllEstimatePricingCache } = require('../services/estimate-pricing-cache');

// Minimal mock transaction that captures the inserted estimate row.
function makeDatabase() {
  const inserts = [];
  let stored = null;
  const trx = (table) => ({
    where() {
      return { forUpdate() { return this; }, first: async () => null };
    },
    insert(row) {
      inserts.push({ table, row });
      if (table === 'estimates') {
        stored = { id: 'estimate-new', status: 'draft', ...row };
        return { returning: async () => [stored] };
      }
      return Promise.resolve([row]);
    },
  });
  return { database: { transaction: async (cb) => cb(trx) }, inserts, getInsert: () => inserts.find((i) => i.table === 'estimates') };
}

// Engine input shape accepted by generateEstimate (mirrors lawn-pricing-followup baseInput).
function baseInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    services: {},
    paymentMethod: 'card',
    ...overrides,
  };
}

const NOW = () => new Date('2026-05-28T08:00:00Z');

function baseBody(overrides = {}) {
  return {
    address: '123 Palm Ave',
    customerName: 'Van Lee',
    customerPhone: '(941) 555-0101',
    customerEmail: 'van@example.com',
    leadId: null,
    customerId: null,
    estimateData: {},
    monthlyTotal: 0,
    annualTotal: 0,
    onetimeTotal: 0,
    waveguardTier: 'Bronze',
    notes: '',
    satelliteUrl: null,
    showOneTimeOption: false,
    billByInvoice: false,
    ...overrides,
  };
}

// A server result in the legacy shape deriveTotalsFromEstimateData understands.
function serverResultMonthly(monthly, annual) {
  return {
    recurring: { grandTotal: monthly, monthlyTotal: monthly, annualTotal: annual, services: [{ service: 'lawn_care', name: 'Lawn Care', mo: monthly }] },
    oneTime: { total: 0 },
    totals: { year2: annual, year2mo: monthly },
  };
}

describe('compareClientToServer', () => {
  it('flags drift on a meaningful annual delta and ignores sub-cent monthly rounding', () => {
    const drift = compareClientToServer({ annualTotal: 1376, monthlyTotal: 114.67, onetimeTotal: 0 }, { annualTotal: 828, monthlyTotal: 69, onetimeTotal: 0 }, NOW);
    expect(drift.hasDrift).toBe(true);
    expect(drift.annualDelta).toBe(-548);
    expect(drift.pctAnnual).toBeCloseTo(-0.3983, 4);
    expect(drift.computedAt).toBe('2026-05-28T08:00:00.000Z');
  });
  it('reports no drift when totals match', () => {
    const drift = compareClientToServer({ annualTotal: 828, monthlyTotal: 69, onetimeTotal: 0 }, { annualTotal: 828, monthlyTotal: 69, onetimeTotal: 0 }, NOW);
    expect(drift.hasDrift).toBe(false);
    expect(drift.annualDelta).toBe(0);
  });
});

describe('serverRecomputeFromEstimateData', () => {
  it('returns NO_INPUTS when there is nothing replayable', async () => {
    expect(await serverRecomputeFromEstimateData({})).toEqual({ recomputed: false, reason: 'NO_INPUTS' });
    expect(await serverRecomputeFromEstimateData(null)).toEqual({ recomputed: false, reason: 'NO_INPUTS' });
  });

  it('replays engineRequest through the injected adapter + engine', async () => {
    const translateV2CallToV1Input = jest.fn(() => baseInput({ services: { lawn: { track: 'st_augustine', lawnFreq: 9 } } }));
    const generateEstimate = jest.fn(() => ({ lineItems: [{ service: 'lawn_care', monthly: 69, annual: 828 }] }));
    const mapV1ToLegacyShape = jest.fn(() => serverResultMonthly(69, 828));
    const res = await serverRecomputeFromEstimateData(
      { engineRequest: { profile: { lotSqFt: 10000 }, selectedServices: ['LAWN'], options: { grassType: 'st_augustine', lawnFreq: 9 } } },
      { translateV2CallToV1Input, generateEstimate, mapV1ToLegacyShape, needsSync: () => false },
    );
    expect(translateV2CallToV1Input).toHaveBeenCalled();
    expect(res.recomputed).toBe(true);
    expect(res.source).toBe('ENGINE_REQUEST');
    expect(res.serverTotals).toMatchObject({ monthlyTotal: 69, annualTotal: 828, onetimeTotal: 0 });
  });

  it('returns ENGINE_ERROR (not throw) when the engine throws', async () => {
    const res = await serverRecomputeFromEstimateData(
      { engineInputs: baseInput({ services: { lawn: { track: 'st_augustine', lawnFreq: 9 } } }) },
      { generateEstimate: () => { throw new Error('boom'); }, needsSync: () => false },
    );
    expect(res.recomputed).toBe(false);
    expect(res.reason).toBe('ENGINE_ERROR');
    expect(res.error.message).toBe('boom');
  });
});

describe('resolveServerAuthoritativePricing', () => {
  it('exempts quote-required estimates (authority null, recompute not called)', async () => {
    const recompute = jest.fn();
    const out = await resolveServerAuthoritativePricing({
      estimateData: {}, clientPreview: { monthlyTotal: 0, annualTotal: 0, onetimeTotal: 0 }, quoteRequired: true, now: NOW, recompute,
    });
    expect(recompute).not.toHaveBeenCalled();
    expect(out.audit.pricing_authority).toBeNull();
  });

  it('fails open LOUDLY on engine error', async () => {
    const errSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const estimateData = { result: { recurring: { grandTotal: 114.67 } } };
    const out = await resolveServerAuthoritativePricing({
      estimateData,
      clientPreview: { monthlyTotal: 114.67, annualTotal: 1376, onetimeTotal: 0 },
      quoteRequired: false,
      now: NOW,
      recompute: async () => ({ recomputed: false, reason: 'ENGINE_ERROR', error: new Error('engine down') }),
    });
    expect(out.audit.pricing_authority).toBe('CLIENT_FALLBACK');
    expect(out.totals).toEqual({ monthlyTotal: 114.67, annualTotal: 1376, onetimeTotal: 0 });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('CLIENT_FALLBACK reason=ENGINE_ERROR'));
    errSpy.mockRestore();
  });
});

describe('createOrReuseAdminEstimate — server authoritative on save', () => {
  beforeEach(() => clearAllEstimatePricingCache());

  it('persists the SERVER price over an inflated client preview, with drift + blob agreement', async () => {
    const { database, getInsert } = makeDatabase();
    const recompute = async () => ({
      recomputed: true,
      source: 'ENGINE_REQUEST',
      serverResult: serverResultMonthly(69, 828),
      serverTotals: { monthlyTotal: 69, annualTotal: 828, onetimeTotal: 0 },
    });
    await createOrReuseAdminEstimate({
      database,
      now: NOW,
      recompute,
      body: baseBody({
        // Client previewed the inflated market-table number.
        monthlyTotal: 114.67,
        annualTotal: 1376.04,
        estimateData: { inputs: {}, result: { recurring: { grandTotal: 114.67, monthlyTotal: 114.67, annualTotal: 1376, services: [{ service: 'lawn_care', mo: 114.67 }] }, oneTime: { total: 0 } }, engineRequest: { profile: {}, selectedServices: ['LAWN'], options: {} } },
      }),
    });
    const row = getInsert().row;
    expect(row.pricing_authority).toBe('SERVER');
    expect(row.monthly_total).toBe(69);
    expect(row.annual_total).toBe(828);
    expect(row.server_computed_price).toBe(828); // annual is the source of truth
    expect(row.client_preview_price).toBe(1376); // derived from the client's estimate_data, not body.annualTotal
    expect(row.pricing_drift).toMatchObject({ hasDrift: true, annualDelta: expect.any(Number) });
    // Blob/column agreement: the embedded result was overwritten to the server result.
    const persisted = JSON.parse(row.estimate_data);
    expect(persisted.result.recurring.grandTotal).toBe(69);
  });

  it('fails open to CLIENT_FALLBACK and still saves when recompute errors', async () => {
    const errSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const { database, getInsert } = makeDatabase();
    await createOrReuseAdminEstimate({
      database,
      now: NOW,
      recompute: async () => ({ recomputed: false, reason: 'ENGINE_ERROR', error: new Error('boom') }),
      body: baseBody({
        monthlyTotal: 90,
        annualTotal: 1080,
        estimateData: { inputs: {}, result: { recurring: { grandTotal: 90, monthlyTotal: 90, annualTotal: 1080, services: [{ service: 'lawn_care', mo: 90 }] }, oneTime: { total: 0 } } },
      }),
    });
    const row = getInsert().row;
    expect(row.pricing_authority).toBe('CLIENT_FALLBACK');
    expect(row.monthly_total).toBe(90); // client preview retained
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('end-to-end through the REAL engine via engineInputs', async () => {
    const { database, getInsert } = makeDatabase();
    const engineInputs = baseInput({ measuredTurfSf: 4250, services: { lawn: { track: 'st_augustine', lawnFreq: 9 } } });
    // Inject needsSync:false so we exercise the real engine without a DB sync.
    const recompute = (ed) => serverRecomputeFromEstimateData(ed, { needsSync: () => false });
    const expected = await recompute({ engineInputs });
    expect(expected.recomputed).toBe(true);
    expect(expected.serverTotals.monthlyTotal).toBeGreaterThan(0);

    await createOrReuseAdminEstimate({
      database,
      now: NOW,
      recompute,
      body: baseBody({
        monthlyTotal: 999, // absurd client number; must be overridden by the engine
        annualTotal: 11988,
        estimateData: { inputs: {}, result: { recurring: { grandTotal: 999 } }, engineInputs },
      }),
    });
    const row = getInsert().row;
    expect(row.pricing_authority).toBe('SERVER');
    expect(row.monthly_total).toBe(expected.serverTotals.monthlyTotal);
    expect(row.monthly_total).not.toBe(999);
    expect(row.server_computed_price).toBe(expected.serverTotals.annualTotal);
  });
});
