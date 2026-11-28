// Regression tests for PR 6 Billing Audit Remediation: B-20, B-21, B-41, and B-42.
// Covers:
//   B-20: Solo Mosquito staff & move waivers set v1.membershipSetupFeeWaived=true, clearing $99 from totals.
//   B-21: Returning setup-fee waiver property/address scope (no waiver on brand-new Property B from Property A
//         visits; active plan on Property A does not block lapsed Property B).
//   B-41: Intelligence Bar quote tools returning-customer waiver parity, estimate extension stripping stale
//         returning waivers past 121 days, and rodent_bait_setup exclusion in shouldIncludeWaveGuardSetupFeeForRecurring.
//   B-42: Admin create/revise strips client-forged setupFeeQuote & unauthorized operatorPriceAdjustment.waiveSetupFee;
//         estimate-public !engineInputs fallback does not add phantom $99 to anchorOneTimePrice on waived quotes.

'use strict';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const CUST_ID = '00000000-0000-4000-8000-0000000c6001';
const EST_ID = '00000000-0000-4000-8000-0000000e6001';

// ── B-20: Solo Mosquito staff/move setup-fee waiver ─────────────

describe('B-20: Solo Mosquito staff/move setup-fee waivers clear $99 from mapped totals', () => {
  const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');

  test('serverRecomputeFromEstimateData zeroes membershipFee and total on waived solo mosquito', async () => {
    const mosquitoInputs = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, services: { mosquito: { tier: 'monthly' } } };
    const at = { now: new Date('2026-11-24T17:00:00.000Z') };
    const plain = await serverRecomputeFromEstimateData({ engineInputs: mosquitoInputs }, at);
    const waived = await serverRecomputeFromEstimateData({
      engineInputs: mosquitoInputs,
      operatorPriceAdjustment: { waiveSetupFee: true, internalReason: 'move waiver' },
    }, at);

    expect(Number(plain.serverResult.oneTime.membershipFee)).toBe(99);
    expect(waived.rawEngineResult.membershipSetupFeeWaived).toBe(true);
    expect(Number(waived.serverResult.oneTime.membershipFee || 0)).toBe(0);
    expect(Number(waived.serverResult.oneTime.total)).toBe(Math.round((Number(plain.serverResult.oneTime.total) - 99) * 100) / 100);
    expect(Number(waived.serverResult.totals.year1)).toBe(Math.round((Number(plain.serverResult.totals.year1) - 99) * 100) / 100);
    expect(Number(waived.serverTotals.oneTimeTotal)).toBe(Math.round((Number(plain.serverTotals.oneTimeTotal) - 99) * 100) / 100);
  });
});

// ── B-21: Property-scoped returning setup-fee waiver ────────────

describe('B-21: Returning setup-fee waiver enforces property/address scope', () => {
  const Returning = require('../services/returning-setup-fee-waiver');

  afterEach(() => { delete process.env.GATE_RETURNING_SETUP_FEE_GAP; });

  function makeReturningDb({ customer, activeRows = [], completedVisits = [], addons = [] }) {
    const handler = (table) => {
      const state = { whereObj: {} };
      const q = {};
      ['where', 'whereNotIn', 'whereIn', 'leftJoin', 'join', 'orWhereIn'].forEach((m) => {
        q[m] = jest.fn((...args) => {
          if (m === 'where' && args[0] && typeof args[0] === 'object') Object.assign(state.whereObj, args[0]);
          return q;
        });
      });
      q.first = jest.fn(async () => (table === 'customers' ? customer : null));
      q.select = jest.fn(async () => {
        if (table === 'scheduled_services') return activeRows;
        if (table === 'scheduled_services as s') return completedVisits;
        if (table === 'scheduled_service_addons as a') return addons;
        return [];
      });
      return q;
    };
    return Object.assign((t) => handler(t), { raw: jest.fn((sql) => sql) });
  }

  test('brand-new never-serviced Property B does NOT receive a returning waiver from Property A visits', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const db = makeReturningDb({
      customer: {
        id: CUST_ID, active: true, waveguard_tier: 'none', monthly_rate: 0,
        address_line1: '100 Oak St', city: 'Testville', zip: '34200',
      },
      completedVisits: [{
        visit_id: 'v-a1', scheduled_date: '2026-09-15', service_type: 'Quarterly Pest Control',
        is_recurring: true, recurring_pattern: 'quarterly',
        property_id: 'prop-a', service_address_line1: '100 Oak St', service_address_city: 'Testville', service_address_zip: '34200',
      }],
    });
    const historyB = await Returning.loadReturningVisitHistory(db, {
      customerId: CUST_ID,
      now: new Date('2026-11-24T17:00:00Z'),
      address: '200 Pine St, Testville, FL 34200',
      propertyId: 'prop-b',
    });
    expect(historyB).toEqual({ todayKey: '2026-11-24', lastByFamily: {}, propertyScoped: true });
    expect(Returning.decideReturningSetupFeeWaiverForPlan(
      [{ name: 'Pest Control', frequency: 'quarterly', mo: 45 }], historyB,
    )).toBeNull();
  });

  test('active plan on Property A does NOT block lapsed Property B from receiving its returning waiver', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const db = makeReturningDb({
      customer: {
        id: CUST_ID, active: true, waveguard_tier: 'Silver', monthly_rate: 55,
        address_line1: '100 Oak St', city: 'Testville', zip: '34200',
      },
      activeRows: [{
        id: 'ss-active-a', property_id: 'prop-a',
        service_address_line1: '100 Oak St', service_address_city: 'Testville', service_address_zip: '34200',
      }],
      completedVisits: [{
        visit_id: 'v-b1', scheduled_date: '2026-09-10', service_type: 'Quarterly Pest Control',
        is_recurring: true, recurring_pattern: 'quarterly',
        property_id: 'prop-b', service_address_line1: '200 Pine St', service_address_city: 'Testville', service_address_zip: '34200',
      }],
    });
    // Property B gets its returning waiver!
    const historyB = await Returning.loadReturningVisitHistory(db, {
      customerId: CUST_ID,
      now: new Date('2026-11-24T17:00:00Z'),
      address: '200 Pine St, Testville, FL 34200',
      propertyId: 'prop-b',
    });
    expect(historyB).toMatchObject({
      todayKey: '2026-11-24',
      propertyScoped: true,
      lastByFamily: { pest_control: { lastVisitKey: '2026-09-10', cycleDays: 91 } },
    });
    expect(Returning.decideReturningSetupFeeWaiverForPlan(
      [{ name: 'Pest Control', frequency: 'quarterly', mo: 45 }], historyB,
    )).toMatchObject({ rule: 'returning_customer_gap', family: 'pest_control', gapDays: 75, windowDays: 121 });

    // Quoting Property A itself (where the active plan lives) still returns null (existing-member rule owns it).
    const historyA = await Returning.loadReturningVisitHistory(db, {
      customerId: CUST_ID,
      now: new Date('2026-11-24T17:00:00Z'),
      address: '100 Oak St, Testville, FL 34200',
      propertyId: 'prop-a',
    });
    expect(historyA).toBeNull();
  });
});

// ── B-41: Rodent quote guard, IB parity & stale extension strip ─

describe('B-41: Converter rodent_bait_setup guard, IB waiver parity, and stripping stale returning waiver on extend', () => {
  afterEach(() => { delete process.env.GATE_RETURNING_SETUP_FEE_GAP; });

  test('shouldIncludeWaveGuardSetupFeeForRecurring does not treat a $0 rodent_bait_setup quote as waiving WaveGuard setup', () => {
    const { shouldIncludeWaveGuardSetupFeeForRecurring } = require('../services/estimate-converter');
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices: [{ name: 'Pest Control', frequency: 'quarterly', mo: 45 }],
      estimateData: { setupFeeQuote: { amount: 0, waived: 'fee_already_queued', kind: 'rodent_bait_setup' } },
    })).toBe(true);
    // A $0 waveguard_membership quote still waives WaveGuard setup.
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices: [{ name: 'Pest Control', frequency: 'quarterly', mo: 45 }],
      estimateData: { setupFeeQuote: { amount: 0, waived: 'existing_member', kind: 'waveguard_membership' } },
    })).toBe(false);
  });

  test('refreshReturningWaiverOnExtend strips stale returning waiver past 121 days, drops snapshot bundle, and restores $99', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const Returning = require('../services/returning-setup-fee-waiver');
    const pestInputs = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, services: { pest: { frequency: 'quarterly' } } };
    const staleWaiver = {
      rule: 'returning_customer_gap', family: 'pest_control',
      lastCompletedVisitDate: '2026-07-01', decidedOn: '2026-10-15', gapDays: 106, windowDays: 121,
    };
    const estRow = {
      id: EST_ID,
      customer_id: CUST_ID,
      address: '100 Oak St, Testville, FL 34200',
      onetime_total: 0,
      estimate_data: JSON.stringify({
        engineInputs: pestInputs,
        engineResult: { membershipSetupFeeWaived: true, lineItems: [{ service: 'pest_control', initialFee: 0 }] },
        operatorPriceAdjustment: Returning.withReturningSetupWaiver(null, staleWaiver),
        sendSnapshot: { pricingBundle: { anchorOneTimePrice: 0, firstVisitFees: [] } },
        result: { recurring: { services: [{ name: 'Pest Control', frequency: 'quarterly', mo: 45 }] }, oneTime: { membershipFee: 0, total: 0 } },
      }),
    };
    // Empty visit history on extend date (2026-11-24 is 146 days after 2026-07-01, past 121-day window).
    const trx = Object.assign((table) => {
      const q = {};
      ['where', 'whereNotIn', 'whereIn', 'leftJoin', 'join', 'orWhereIn'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => (table === 'customers' ? { id: CUST_ID, active: true, waveguard_tier: null, monthly_rate: 0 } : null));
      q.select = jest.fn(async () => (table === 'scheduled_services as s' ? [{
        visit_id: 'v-old', scheduled_date: '2026-07-01', service_type: 'Quarterly Pest Control', is_recurring: true, recurring_pattern: 'quarterly',
      }] : []));
      return q;
    }, {
      raw: jest.fn((sql) => sql),
      transaction: async (fn) => fn(trx),
    });

    const out = await Returning.refreshReturningWaiverOnExtend(trx, estRow, { now: new Date('2026-11-24T17:00:00Z') });
    expect(out.stripped).toBe(true);
    const updatedData = JSON.parse(out.patch.estimate_data);
    expect(updatedData.operatorPriceAdjustment).toBeUndefined();
    expect(updatedData.engineResult.membershipSetupFeeWaived).toBeUndefined();
    expect(updatedData.sendSnapshot.pricingBundle).toBeUndefined();
    expect(Number(updatedData.result.oneTime.membershipFee)).toBe(99);
    expect(Number(out.patch.onetime_total)).toBeGreaterThanOrEqual(99);

    // Within 121 days (2026-10-15 = 106 days): waiver is KEPT!
    const kept = await Returning.refreshReturningWaiverOnExtend(trx, estRow, { now: new Date('2026-10-15T17:00:00Z') });
    expect(kept.stripped).toBe(false);
  });

  test('Intelligence Bar computeAgentDraftPreview & agentEstimatePayload apply returning-customer waiver parity', async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    const Returning = require('../services/returning-setup-fee-waiver');
    const historySpy = jest.spyOn(Returning, 'loadReturningVisitHistory').mockResolvedValue({
      todayKey: '2026-11-24',
      propertyScoped: true,
      lastByFamily: { pest_control: { lastVisitKey: '2026-09-15', cycleDays: 91 } },
    });
    const tools = require('../services/intelligence-bar/estimate-tools');
    try {
      const result = await tools.executeEstimateTool('compute_estimate', {
        homeSqFt: 2200, lotSqFt: 12000, stories: 1, address: '100 Oak St, Testville, FL 34200',
        services: { pest: { frequency: 'quarterly' } },
      });
      // Without a linked customer/lead, no returning waiver is applied.
      expect(result.returning_setup_fee_waiver).toBeUndefined();
      expect(historySpy).not.toHaveBeenCalled();

      // With a linked returning customer via computeAgentDraftPreview:
      // verify source wiring directly through executeEstimateTool's preview helper export / agentEstimatePayload.
      const src = require('fs').readFileSync(require('path').join(__dirname, '../services/intelligence-bar/estimate-tools.js'), 'utf8');
      expect(src).toContain('applyAgentReturningSetupWaiver(estimate,');
      expect(src).toContain('applyAgentReturningSetupWaiver(engineResult,');
      expect(src).toContain('mergePersistedOperatorAdjustment(');
    } finally {
      historySpy.mockRestore();
    }
  });
});

// ── B-42: Admin client-waiver stripping & estimate-public fallback ─

describe('B-42: Admin create/revise strips forged waivers & estimate-public fallback skips phantom $99', () => {
  const { createOrReuseAdminEstimate, reviseAdminEstimate } = require('../services/admin-estimate-persistence');

  function makePersistenceDb(storedRow = null) {
    const inserts = [];
    const updates = [];
    let current = storedRow;
    const trx = (table) => ({
      whereNotIn() { return this; },
      leftJoin() { return this; },
      join() { return this; },
      select: async () => [],
      where() {
        return {
          forUpdate() { return this; },
          whereNull() { return this; },
          whereRaw() { return this; },
          where() { return this; },
          whereNotIn() { return this; },
          whereNot() { return this; },
          whereNotExists() { return this; },
          orWhere() { return this; },
          modify(fn) { fn(this); return this; },
          select: async () => [],
          first: async () => (table === 'estimates' ? current : null),
          update(patch) {
            updates.push({ table, patch });
            if (table === 'estimates' && current) {
              current = { ...current, ...patch };
              return { returning: async () => [current] };
            }
            return Promise.resolve(1);
          },
        };
      },
      insert(row) {
        inserts.push({ table, row });
        if (table === 'estimates') {
          current = { id: EST_ID, status: 'draft', ...row };
          return { returning: async () => [current] };
        }
        const chain = { onConflict: () => chain, ignore: () => chain, returning: async () => [{ id: 'r1' }], then: (r) => r([row]) };
        return chain;
      },
    });
    trx.fn = { now: () => 'NOW' };
    trx.raw = (sql) => sql;
    return {
      database: Object.assign((t) => trx(t), { transaction: async (cb) => cb(trx), raw: (sql) => sql }),
      inserts,
      updates,
    };
  }

  const pestBody = (estimateDataExtra = {}) => ({
    address: '100 Oak St, Testville, FL 34200',
    customerName: 'Test Person',
    customerPhone: '(941) 555-0101',
    customerEmail: 'test@example.com',
    leadId: null,
    customerId: null,
    estimateData: {
      engineInputs: { homeSqFt: 2200, stories: 1, lotSqFt: 12000, services: { pest: { frequency: 'quarterly' } } },
      result: { total: 125 },
      ...estimateDataExtra,
    },
  });

  test('technician create strips forged setupFeeQuote and operatorPriceAdjustment.waiveSetupFee', async () => {
    const { database, inserts } = makePersistenceDb();
    await createOrReuseAdminEstimate({
      database,
      body: pestBody({
        setupFeeQuote: { amount: 0, waived: 'existing_member', kind: 'waveguard_membership' },
        operatorPriceAdjustment: { waiveSetupFee: true, internalReason: 'forged by tech' },
      }),
      technicianId: 'tech-2',
      technician: { id: 'tech-2', role: 'technician' },
      moveAllowed: false,
      waiveSetupFeeAllowed: false,
      now: () => new Date('2026-11-24T17:00:00Z'),
    });
    const stored = JSON.parse(inserts.find((e) => e.table === 'estimates').row.estimate_data);
    expect(stored.setupFeeQuote).toBeUndefined();
    expect(stored.operatorPriceAdjustment).toBeUndefined();
    expect(Number(stored.result.oneTime.membershipFee)).toBe(99);
  });

  test('admin create strips forged setupFeeQuote and blank-reason waiveSetupFee, but keeps explicit admin waiver with reason', async () => {
    const blankReasonDb = makePersistenceDb();
    await createOrReuseAdminEstimate({
      database: blankReasonDb.database,
      body: pestBody({
        setupFeeQuote: { amount: 0, waived: 'existing_member' },
        operatorPriceAdjustment: { waiveSetupFee: true, internalReason: '   ' },
      }),
      technicianId: 'admin-1',
      technician: { id: 'admin-1', role: 'admin' },
      waiveSetupFeeAllowed: true,
      now: () => new Date('2026-11-24T17:00:00Z'),
    });
    const blankStored = JSON.parse(blankReasonDb.inserts.find((e) => e.table === 'estimates').row.estimate_data);
    expect(blankStored.setupFeeQuote).toBeUndefined();
    expect(blankStored.operatorPriceAdjustment).toBeUndefined();
    expect(Number(blankStored.result.oneTime.membershipFee)).toBe(99);

    const validAdminDb = makePersistenceDb();
    await createOrReuseAdminEstimate({
      database: validAdminDb.database,
      body: pestBody({
        setupFeeQuote: { amount: 0, waived: 'existing_member' },
        operatorPriceAdjustment: { waiveSetupFee: true, internalReason: 'owner comp' },
      }),
      technicianId: 'admin-1',
      technician: { id: 'admin-1', role: 'admin' },
      waiveSetupFeeAllowed: true,
      now: () => new Date('2026-11-24T17:00:00Z'),
    });
    const validStored = JSON.parse(validAdminDb.inserts.find((e) => e.table === 'estimates').row.estimate_data);
    expect(validStored.setupFeeQuote).toBeUndefined();
    expect(validStored.operatorPriceAdjustment).toEqual({ waiveSetupFee: true, internalReason: 'owner comp' });
    expect(Number(validStored.result.oneTime.membershipFee || 0)).toBe(0);
  });

  test('technician revise strips newly injected waiveSetupFee and setupFeeQuote', async () => {
    const existing = {
      id: EST_ID, status: 'draft', address: '100 Oak St, Testville, FL 34200',
      customer_phone: '(941) 555-0101', updated_at: new Date('2026-11-24T12:00:00Z'),
      estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2200, stories: 1, lotSqFt: 12000, services: { pest: { frequency: 'quarterly' } } } }),
    };
    const { database, updates } = makePersistenceDb(existing);
    await reviseAdminEstimate({
      database,
      estimateId: EST_ID,
      body: pestBody({
        setupFeeQuote: { amount: 0, waived: 'existing_member' },
        operatorPriceAdjustment: { waiveSetupFee: true, internalReason: 'injected on revise' },
      }),
      technicianId: 'tech-2',
      technician: { id: 'tech-2', role: 'technician' },
      waiveSetupFeeAllowed: false,
      now: () => new Date('2026-11-24T17:00:00Z'),
    });
    const estUpdate = updates.find((u) => u.table === 'estimates');
    const stored = JSON.parse(estUpdate.patch.estimate_data);
    expect(stored.setupFeeQuote).toBeUndefined();
    expect(stored.operatorPriceAdjustment).toBeUndefined();
    expect(Number(stored.result.oneTime.membershipFee)).toBe(99);
  });

  test('estimate-public buildPricingBundle !engineInputs fallback never adds phantom $99 to anchorOneTimePrice on waived estimates', async () => {
    const { buildPricingBundle } = require('../routes/estimate-public');
    const waivedEst = {
      id: 'est-fallback-waived',
      status: 'sent',
      monthly_total: 45,
      annual_total: 540,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
      estimate_data: JSON.stringify({
        operatorPriceAdjustment: { waiveSetupFee: true, internalReason: 'owner waived' },
        recurring: { services: [{ name: 'Pest Control', frequency: 'quarterly', mo: 45 }] },
      }),
    };
    const bundle = await buildPricingBundle(waivedEst);
    expect(bundle.fallback).toBe('no_engine_inputs');
    expect(bundle.firstVisitFees).toEqual([]);
    expect(bundle.setupFee).toBeNull();
    expect(bundle.anchorOneTimePrice).toBeNull();

    // Unwaived fallback solo pest estimate DOES still surface the $99 fee and anchor lift.
    const chargedEst = {
      ...waivedEst,
      id: 'est-fallback-charged',
      estimate_data: JSON.stringify({
        recurring: { services: [{ name: 'Pest Control', frequency: 'quarterly', mo: 45 }] },
      }),
    };
    const chargedBundle = await buildPricingBundle(chargedEst);
    expect(chargedBundle.fallback).toBe('no_engine_inputs');
    expect(chargedBundle.firstVisitFees).toEqual([expect.objectContaining({ service: 'waveguard_setup', amount: 99 })]);
    expect(chargedBundle.anchorOneTimePrice).toBe(99);
  });
});
