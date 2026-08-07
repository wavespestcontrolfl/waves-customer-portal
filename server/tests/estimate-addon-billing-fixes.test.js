jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: {},
}));

const { storedManualDiscountForReplay } = require('../services/estimate-manual-discount-replay');
const {
  extractEngineInputs,
  netManualDiscountIntoFrequencyRow,
  pricingBundleLacksManualDiscountNetting,
  estimateTotalsReflectManualDiscount,
} = require('../routes/estimate-public');
const { classifyAddOnAcceptContext } = require('../services/estimate-converter');
// The scalar-returning wrapper was removed with the plan-rate ledger
// (#3245 — production calls classifyAddOnAcceptContext directly); these
// behavioral assertions consume the context's addOnBase.
const addOnPreservedMonthlyRateBase = async (args) => (await classifyAddOnAcceptContext(args)).addOnBase;

// ── shared fixtures ─────────────────────────────────────────────────────────

// The 2026-08-05 T&S add-on shape (account b5f6e627): admin-editor estimate whose assembled
// manualDiscount object never round-tripped into the stored inputs — the
// discount lives only at summary level while `inputs` carries raw form
// fields. Account ids only; no customer PII (repo P0).
const STORED_PERCENT_DISCOUNT = {
  source: 'catalog_preset',
  presetId: 'preset-1',
  presetKey: 'waveguard_member',
  catalogName: 'WaveGuard Member Discount',
  catalogCategory: 'manual_recurring_estimate_discount',
  type: 'PERCENT',
  value: 15,
  label: 'WaveGuard Member Discount',
  amount: 62.64,
  recurringAmount: 62.64,
  internalReason: 'audit-only text that must never replay',
  eligibility: { requiresWaveGuardTier: 'Bronze' },
  eligibilityConfirmed: false,
  stack: 'tier',
};

const ADMIN_EDITOR_EST_DATA = {
  inputs: {
    manualDiscountType: 'PERCENT',
    manualDiscountValue: '15',
    manualDiscountLabel: 'WaveGuard Member Discount',
  },
  summary: { manualDiscount: STORED_PERCENT_DISCOUNT },
  result: { recurring: { services: [] } },
};

// ── storedManualDiscountForReplay ───────────────────────────────────────────

describe('storedManualDiscountForReplay', () => {
  test('reconstructs identity + math inputs from the stored summary, never audit or computed fields', () => {
    const out = storedManualDiscountForReplay(ADMIN_EDITOR_EST_DATA);
    expect(out).toEqual(expect.objectContaining({
      type: 'PERCENT',
      value: 15,
      label: 'WaveGuard Member Discount',
      presetId: 'preset-1',
      presetKey: 'waveguard_member',
      eligibilityConfirmed: false,
    }));
    expect(out.internalReason).toBeUndefined();
    expect(out.amount).toBeUndefined();
    expect(out.recurringAmount).toBeUndefined();
  });

  test('falls back through result.manualDiscount and engineResult roots', () => {
    expect(storedManualDiscountForReplay({
      result: { manualDiscount: { type: 'FIXED', value: 50, label: 'Promo', oneTimeAmount: 0 } },
    })).toEqual(expect.objectContaining({ type: 'FIXED', value: 50 }));
    expect(storedManualDiscountForReplay({
      engineResult: { totals: { manualDiscount: { type: 'PERCENT', value: 10 } } },
    })).toEqual(expect.objectContaining({ type: 'PERCENT', value: 10 }));
  });

  test('returns null for absent, zero-value, or unsupported-type discounts', () => {
    expect(storedManualDiscountForReplay({})).toBeNull();
    expect(storedManualDiscountForReplay({ summary: { manualDiscount: { type: 'PERCENT', value: 0 } } })).toBeNull();
    expect(storedManualDiscountForReplay({ summary: { manualDiscount: { type: 'NONE', value: 15 } } })).toBeNull();
  });

  test('floor-breach approval is derived from the persisted evidence shapes (codex r3)', () => {
    // Engine OUTPUT stores approval at floorBreach.acknowledged.
    expect(storedManualDiscountForReplay({
      summary: { manualDiscount: { type: 'PERCENT', value: 20, floorBreach: { acknowledged: true } } },
    })).toEqual(expect.objectContaining({ floorBreachAcknowledged: true }));
    // pricingMetadata mirror counts too.
    expect(storedManualDiscountForReplay({
      result: {
        manualDiscount: { type: 'PERCENT', value: 20 },
        pricingMetadata: { manualDiscountFloorBreach: { acknowledged: true } },
      },
    })).toEqual(expect.objectContaining({ floorBreachAcknowledged: true }));
    // No breach evidence stays false.
    expect(storedManualDiscountForReplay({
      summary: { manualDiscount: { type: 'PERCENT', value: 20, floorBreach: null } },
    })).toEqual(expect.objectContaining({ floorBreachAcknowledged: false }));
  });

  test('FIXED discounts replay only with a proven-zero one-time allocation', () => {
    // Zero slice: allocation is replay-stable -> inject, carrying the anchor.
    const zeroSlice = storedManualDiscountForReplay({
      summary: { manualDiscount: { type: 'FIXED', value: 50, oneTimeAmount: 0 } },
    });
    expect(zeroSlice).toEqual(expect.objectContaining({ type: 'FIXED', value: 50, oneTimeAmount: 0 }));
    // Nonzero slice: each per-cadence replay would reallocate the credit
    // while acceptance bills the persisted one-time total -> never inject.
    expect(storedManualDiscountForReplay({
      summary: { manualDiscount: { type: 'FIXED', value: 100, oneTimeAmount: 40 } },
    })).toBeNull();
    // Unknown allocation (older objects without the field) stays out too.
    expect(storedManualDiscountForReplay({
      summary: { manualDiscount: { type: 'FIXED', value: 100 } },
    })).toBeNull();
    // Coercible-to-zero values are NOT a proven zero (codex r2): null and
    // '' both Number() to 0 but record an unknown allocation.
    expect(storedManualDiscountForReplay({
      summary: { manualDiscount: { type: 'FIXED', value: 100, oneTimeAmount: null } },
    })).toBeNull();
    expect(storedManualDiscountForReplay({
      summary: { manualDiscount: { type: 'FIXED', value: 100, oneTimeAmount: '' } },
    })).toBeNull();
    // PERCENT is per-bucket by definition -> always replay-stable.
    expect(storedManualDiscountForReplay({
      summary: { manualDiscount: { type: 'PERCENT', value: 15, oneTimeAmount: 12 } },
    })).toEqual(expect.objectContaining({ type: 'PERCENT', value: 15 }));
  });
});

// ── extractEngineInputs replay injection ────────────────────────────────────

describe('extractEngineInputs manual-discount replay', () => {
  test('injects the stored summary discount when the inputs carry none', () => {
    const out = extractEngineInputs(ADMIN_EDITOR_EST_DATA);
    expect(out.manualDiscount).toEqual(expect.objectContaining({ type: 'PERCENT', value: 15 }));
    expect(out.manualDiscount.internalReason).toBeUndefined();
  });

  test('an explicit manualDiscount already in the stored inputs wins', () => {
    const out = extractEngineInputs({
      ...ADMIN_EDITOR_EST_DATA,
      inputs: { ...ADMIN_EDITOR_EST_DATA.inputs, manualDiscount: { type: 'FIXED', value: 25, label: 'Stored' } },
    });
    expect(out.manualDiscount).toEqual(expect.objectContaining({ type: 'FIXED', value: 25 }));
  });

  test('operatorPriceAdjustment keeps precedence over the summary reconstruction', () => {
    const out = extractEngineInputs({
      ...ADMIN_EDITOR_EST_DATA,
      operatorPriceAdjustment: { type: 'FIXED', value: 40, label: 'Agent adj' },
    });
    expect(out.manualDiscount).toEqual(expect.objectContaining({
      source: 'agent_operator', type: 'FIXED', value: 40,
    }));
  });

  test('no discount anywhere → nothing injected', () => {
    const out = extractEngineInputs({ inputs: { turfSf: 5000 } });
    expect(out.manualDiscount).toBeUndefined();
  });
});

// ── netManualDiscountIntoFrequencyRow ───────────────────────────────────────

describe('netManualDiscountIntoFrequencyRow', () => {
  const manual = { type: 'PERCENT', value: 15, amount: 62.64, recurringAmount: 62.64 };
  const manualWithMonthly = { ...manual, monthlyAmount: 5.22 };

  test('nets monthly/annual/perTreatment with the row-scoped slice and attaches it', () => {
    const row = netManualDiscountIntoFrequencyRow(
      { key: 'monthly', monthly: 32.87, annual: 394.4, perTreatment: 65.73, visitsPerYear: 6 },
      manual,
      manualWithMonthly,
    );
    // 15% of the row's own 394.40 base = 59.16/yr → 4.93/mo → 9.86/visit.
    expect(row.annual).toBe(335.24);
    expect(row.monthly).toBe(27.94);
    expect(row.perTreatment).toBe(55.87);
    expect(row.manualDiscount).toEqual(expect.objectContaining({ amount: 59.16 }));
  });

  test('a row with nothing billable keeps the display-only metadata attach', () => {
    const row = netManualDiscountIntoFrequencyRow({ key: 'q', quoteRequired: true }, manual, manualWithMonthly);
    expect(row.manualDiscount).toBe(manualWithMonthly);
    expect(row.monthly).toBeUndefined();
  });

  test('fixed discounts respect the recurring/one-time split and the row cap', () => {
    const fixed = { type: 'FIXED', value: 100, amount: 100, oneTimeAmount: 40 };
    const row = netManualDiscountIntoFrequencyRow(
      { key: 'quarterly', monthly: 30, annual: 360 },
      fixed,
      { ...fixed, monthlyAmount: 5 },
    );
    // Recurring slice = 100 − 40 = 60, under the 360 base → annual 300.
    expect(row.annual).toBe(300);
    expect(row.manualDiscount).toEqual(expect.objectContaining({ amount: 60 }));
  });
});

// ── pricingBundleLacksManualDiscountNetting ─────────────────────────────────

describe('estimateTotalsReflectManualDiscount', () => {
  const blob = { result: { totals: { year2: 354.96 } } };

  test('false when the persisted annual disagrees with the blob discounted figure (degraded state)', () => {
    expect(estimateTotalsReflectManualDiscount(blob, { annual_total: '394.40' })).toBe(false);
  });

  test('true when the persisted annual equals the blob discounted figure (already-netted world)', () => {
    expect(estimateTotalsReflectManualDiscount(blob, { annual_total: 354.96 })).toBe(true);
    expect(estimateTotalsReflectManualDiscount(blob, { annual_total: 354.97 })).toBe(true);
  });

  test('null without reference evidence', () => {
    expect(estimateTotalsReflectManualDiscount({}, { annual_total: 394.4 })).toBeNull();
    expect(estimateTotalsReflectManualDiscount(blob, {})).toBeNull();
  });

  test('a SQL NULL persisted annual is missing evidence, never zero (codex r3)', () => {
    expect(estimateTotalsReflectManualDiscount(blob, { annual_total: null })).toBeNull();
  });

  test('a stored ZERO post-discount annual is valid evidence (codex r2)', () => {
    const fullDiscountBlob = { result: { totals: { year2: 0 } } };
    // Degraded columns still carry the undiscounted positive annual -> mismatch.
    expect(estimateTotalsReflectManualDiscount(fullDiscountBlob, { annual_total: 394.4 })).toBe(false);
    // Fully discounted columns agree with the zero reference.
    expect(estimateTotalsReflectManualDiscount(fullDiscountBlob, { annual_total: 0 })).toBe(true);
  });
});

describe('pricingBundleLacksManualDiscountNetting', () => {
  // Degraded shape: discount stored, blob totals discounted, persisted
  // columns undiscounted.
  const discountEstData = {
    summary: { manualDiscount: { ...STORED_PERCENT_DISCOUNT } },
    result: { totals: { year2: 354.96 } },
  };
  const degradedEstimate = { annual_total: 394.4 };
  const nettedEstimate = { annual_total: 354.96 };

  test('true only with unmarked rows AND totals evidence of the degraded state', () => {
    expect(pricingBundleLacksManualDiscountNetting(
      { frequencies: [{ key: 'monthly', monthly: 32.87 }] },
      discountEstData,
      degradedEstimate,
    )).toBe(true);
  });

  test('a legacy already-netted snapshot (columns match the discounted blob totals) is preserved', () => {
    expect(pricingBundleLacksManualDiscountNetting(
      { frequencies: [{ key: 'monthly', monthly: 29.58 }] },
      discountEstData,
      nettedEstimate,
    )).toBe(false);
  });

  test('evidence-less shapes are preserved (no reference totals in the blob)', () => {
    expect(pricingBundleLacksManualDiscountNetting(
      { frequencies: [{ key: 'monthly', monthly: 32.87 }] },
      { summary: { manualDiscount: { ...STORED_PERCENT_DISCOUNT } } },
      degradedEstimate,
    )).toBe(false);
  });

  test('markers do NOT rescue a bundle whose totals mismatch (metadata-only legacy back-fill, codex r3)', () => {
    // The previous back-fill attached bare manualDiscount metadata to rows
    // it never netted — on proven-mismatched totals a marker proves nothing.
    expect(pricingBundleLacksManualDiscountNetting(
      {
        frequencies: [
          { key: 'monthly', monthly: 32.87, manualDiscount: { amount: 62.64 } },
        ],
      },
      discountEstData,
      degradedEstimate,
    )).toBe(true);
  });

  test('marked rows are preserved when the persisted totals reflect the discount', () => {
    expect(pricingBundleLacksManualDiscountNetting(
      {
        frequencies: [
          { key: 'monthly', monthly: 27.94, manualDiscount: { amount: 59.16 } },
          { key: 'quarterly', monthly: 30, manualDiscountSuppressed: true },
        ],
      },
      discountEstData,
      nettedEstimate,
    )).toBe(false);
  });

  test('zero-total trivial match: positive rows against zero persisted totals recompute (codex r4 P0)', () => {
    const fullDiscountEstData = {
      summary: { manualDiscount: { ...STORED_PERCENT_DISCOUNT } },
      result: { totals: { year2: 0 } },
    };
    // Legacy positive metadata-only snapshot on a fully discounted estimate.
    expect(pricingBundleLacksManualDiscountNetting(
      { frequencies: [{ key: 'monthly', monthly: 32.87, manualDiscount: { amount: 62.64 } }] },
      fullDiscountEstData,
      { annual_total: 0 },
    )).toBe(true);
    // Rows genuinely netted to zero pass.
    expect(pricingBundleLacksManualDiscountNetting(
      { frequencies: [{ key: 'monthly', monthly: 0, annual: 0, manualDiscount: { amount: 417.6 } }] },
      fullDiscountEstData,
      { annual_total: 0 },
    )).toBe(false);
  });

  test('false for undiscounted estimates and empty bundles', () => {
    expect(pricingBundleLacksManualDiscountNetting(
      { frequencies: [{ key: 'monthly', monthly: 32.87 }] },
      {},
      degradedEstimate,
    )).toBe(false);
    expect(pricingBundleLacksManualDiscountNetting({ frequencies: [] }, discountEstData, degradedEstimate)).toBe(false);
  });
});

// ── addOnPreservedMonthlyRateBase (converter, defect a) ─────────────────────

// Chainable fake knex connection (pattern from
// estimate-existing-appt-customer-wide.test.js): thenable builder resolving
// the queued row list, with the nested where-builder the query composes.
// Records every clause (codex r5: no-op wheres cannot exercise the
// predicates) so tests can assert WHAT the query filtered on, mirroring the
// estimate-existing-appt-customer-wide fake.
function makeFakeConn(rows, { throwOnQuery = false } = {}) {
  const queries = [];
  const conn = () => {
    if (throwOnQuery) throw new Error('db unavailable');
    const rec = { clauses: [] };
    queries.push(rec);
    const q = {};
    const record = (method) => (...args) => {
      rec.clauses.push([method, args]);
      if (typeof args[0] === 'function') args[0](nestedBuilder(rec));
      return q;
    };
    ['whereIn', 'whereNotIn', 'where', 'andWhere', 'whereNull', 'orderBy', 'leftJoin', 'select'].forEach((m) => {
      q[m] = record(m);
    });
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return q;
  };
  // The lookup is savepoint-confined (codex r1 P2) — mirror knex's
  // trx.transaction(fn) shape by handing the callback the same conn.
  conn.transaction = async (fn) => fn(conn);
  conn.queries = queries;
  return conn;
}

function nestedBuilder(rec) {
  const b = {};
  ['where', 'orWhere', 'whereNull', 'orWhereNull', 'whereNot', 'orWhereNot'].forEach((m) => {
    b[m] = (...args) => {
      rec.clauses.push([`nested.${m}`, args]);
      if (typeof args[0] === 'function') args[0](nestedBuilder(rec));
      return b;
    };
  });
  return b;
}

function allClauses(conn) {
  return conn.queries.flatMap((rec) => rec.clauses);
}

const TS_ADDON_ESTIMATE = { id: 'est-addon', customer_id: 'cust-1' };
const TS_ADDON_EST_DATA = {
  result: {
    recurring: {
      services: [{
        name: 'Bi-Monthly Tree & Shrub Care Service',
        service: 'tree_shrub',
        frequency: 'bimonthly',
        selected: true,
        isSelected: true,
        mo: 32.87,
        visitsPerYear: 6,
      }],
    },
  },
};
const LIVE_CUSTOMER = {
  id: 'cust-1',
  pipeline_stage: 'active_customer',
  monthly_rate: '31.81',
};
const PEST_PLAN_ROW = {
  service_type: 'Quarterly Pest Control Service',
  is_callback: false,
  catalog_service_key: null,
  catalog_service_name: null,
};
const TS_PLAN_ROW = {
  service_type: 'Bi-Monthly Tree & Shrub Care Service',
  is_callback: false,
  catalog_service_key: null,
  catalog_service_name: null,
};

describe('addOnPreservedMonthlyRateBase', () => {
  test('cross-family add-on for a live recurring customer returns the existing rate to sum', async () => {
    const base = await addOnPreservedMonthlyRateBase({
      database: makeFakeConn([PEST_PLAN_ROW]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: LIVE_CUSTOMER,
    });
    expect(base).toBe(31.81);
  });

  test('same-family accept (re-quote) keeps replace semantics', async () => {
    const base = await addOnPreservedMonthlyRateBase({
      database: makeFakeConn([TS_PLAN_ROW]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: LIVE_CUSTOMER,
    });
    expect(base).toBe(0);
  });

  test('a multi-plan customer whose plans include the estimate family stays replace', async () => {
    const base = await addOnPreservedMonthlyRateBase({
      database: makeFakeConn([PEST_PLAN_ROW, TS_PLAN_ROW]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: LIVE_CUSTOMER,
    });
    expect(base).toBe(0);
  });

  test('non-live stages, missing rates, and rate-less rows never sum', async () => {
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([PEST_PLAN_ROW]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: { ...LIVE_CUSTOMER, pipeline_stage: 'churned' },
    })).resolves.toBe(0);
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([PEST_PLAN_ROW]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: { ...LIVE_CUSTOMER, monthly_rate: null },
    })).resolves.toBe(0);
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([PEST_PLAN_ROW]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: { ...LIVE_CUSTOMER, monthly_rate: 0 },
    })).resolves.toBe(0);
  });

  test('no other future plan rows (or callbacks only) → replace', async () => {
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: LIVE_CUSTOMER,
    })).resolves.toBe(0);
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([{ ...PEST_PLAN_ROW, is_callback: true }]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: LIVE_CUSTOMER,
    })).resolves.toBe(0);
  });

  test('classification failure fails safe to replace', async () => {
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([], { throwOnQuery: true }),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: LIVE_CUSTOMER,
    })).resolves.toBe(0);
  });

  test('a mixed estimate that re-prices an existing family stays replace (full family union, codex r2)', async () => {
    // The adoption helper narrows a mixed estimate to its PRIMARY family
    // (pest) — the overlap test must see EVERY recurring family, or an
    // active T&S customer accepting pest+T&S would get the old rate summed
    // onto a total that already includes T&S.
    const mixedEstData = {
      result: {
        recurring: {
          services: [
            { name: 'Quarterly Pest Control Service', service: 'pest_control', selected: true, isSelected: true, mo: 45 },
            { name: 'Bi-Monthly Tree & Shrub Care Service', service: 'tree_shrub', selected: true, isSelected: true, mo: 32.87 },
          ],
        },
      },
    };
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([TS_PLAN_ROW]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: mixedEstData,
      customer: LIVE_CUSTOMER,
    })).resolves.toBe(0);
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([PEST_PLAN_ROW]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: mixedEstData,
      customer: LIVE_CUSTOMER,
    })).resolves.toBe(0);
    // A mosquito-only customer is genuinely disjoint from pest+T&S -> sum.
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([{
        service_type: 'Monthly Mosquito Control',
        is_callback: false,
        catalog_service_key: null,
        catalog_service_name: null,
      }]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: mixedEstData,
      customer: LIVE_CUSTOMER,
    })).resolves.toBe(31.81);
  });

  test('an unclassifiable existing plan row fails CLOSED to replace (codex r3)', async () => {
    // A generic/legacy row with no resolvable family cannot prove it is a
    // different family — summing on top of it could double-bill.
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([{
        service_type: 'Service',
        is_callback: false,
        catalog_service_key: null,
        catalog_service_name: null,
      }]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: LIVE_CUSTOMER,
    })).resolves.toBe(0);
  });

  test('an in-progress (en_route/on_site) plan row still counts as the existing plan (codex r3)', async () => {
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([{ ...PEST_PLAN_ROW, status: 'on_site' }]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: LIVE_CUSTOMER,
    })).resolves.toBe(31.81);
  });

  test('supplemental companion lines (scalar rodent bait) join the overlap union (codex r4)', async () => {
    // Server-priced shape stores rodent bait as recurring.rodentBaitMo, not
    // a service row; a rodent-only add-on for a pest member must still SUM,
    // and a rodent-carrying customer must overlap the estimate.
    const rodentScalarEstData = {
      result: {
        recurring: {
          services: [],
          rodentBaitMo: 24,
        },
      },
    };
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([PEST_PLAN_ROW]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: rodentScalarEstData,
      customer: LIVE_CUSTOMER,
    })).resolves.toBe(31.81);
    await expect(addOnPreservedMonthlyRateBase({
      database: makeFakeConn([{
        service_type: 'Rodent Bait Stations',
        is_callback: false,
        catalog_service_key: null,
        catalog_service_name: null,
      }]),
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: rodentScalarEstData,
      customer: LIVE_CUSTOMER,
    })).resolves.toBe(0);
  });

  test('an adopted billed-plan row re-enters BY ID and forces replace on a same-family re-quote (codex r4/r5)', async () => {
    // The adopted row carries this estimate's source_estimate_id, so the
    // linked-row exclusion would hide it — the id re-admission puts its own
    // family evidence back on the table.
    const conn = makeFakeConn([TS_PLAN_ROW]);
    await expect(addOnPreservedMonthlyRateBase({
      database: conn,
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: LIVE_CUSTOMER,
      adoptedExistingAppointmentId: 'ss-adopted',
    })).resolves.toBe(0);
    // The query really re-admits the adopted id.
    expect(allClauses(conn)).toContainEqual(['nested.orWhere', ['scheduled_services.id', 'ss-adopted']]);
  });

  test('the plan-row query uses active-coverage semantics: TERMINAL_STATUSES exclusion, no date cutoff (codex r5)', async () => {
    const { TERMINAL_STATUSES } = require('../services/waveguard-existing-services');
    const conn = makeFakeConn([PEST_PLAN_ROW]);
    await expect(addOnPreservedMonthlyRateBase({
      database: conn,
      estimateId: 'est-addon',
      estimate: TS_ADDON_ESTIMATE,
      estimateData: TS_ADDON_EST_DATA,
      customer: LIVE_CUSTOMER,
    })).resolves.toBe(31.81);
    const clauses = allClauses(conn);
    // Same terminal-status set as loadActiveRecurringServiceRows.
    expect(clauses).toContainEqual(['whereNotIn', ['scheduled_services.status', TERMINAL_STATUSES]]);
    // No future-only cutoff — an overdue en_route/on_site visit is still
    // the customer's plan.
    expect(clauses.some(([, args]) => String(args?.[0] ?? '').includes('scheduled_date'))).toBe(false);
    // Billed-plan evidence only.
    expect(clauses).toContainEqual(['where', ['scheduled_services.is_recurring', true]]);
  });
});
