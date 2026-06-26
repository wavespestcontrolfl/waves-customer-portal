const {
  acceptanceServiceLists,
  withSupplementedRecurringServices,
  foamFrequenciesFromEngineResult,
  buildPricingBundle,
  shapeFromV1,
} = require('../routes/estimate-public.js');
const { _internals: { durationForService } } = require('../services/estimate-slot-availability.js');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine.js');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper.js');
const { priceRecurringFoam } = require('../services/pricing-engine/service-pricing.js');

// The compact line-item shape public-quote.js / lead-estimate-automation.js
// persist: name + frequency survive, but cadence and estimatedDurationMinutes are
// dropped, and `annual` is the authoritative sold total alongside a rounded
// `monthly`. The frequency/booking helpers must recover cadence, keep the sold
// annual to the cent, and size the slot from the tier duration.
function compactFoamEngineResult({ name, frequency, annual, monthly }) {
  return {
    summary: { monthlyTotal: monthly, annualTotal: annual },
    lineItems: [
      { service: 'foam_recurring', name, annual, monthly, price: annual / frequency, total: annual, perApp: annual / frequency, frequency },
    ],
    waveGuard: null,
  };
}

// Regression for the engine-invocation accept path. Quote-wizard (public-quote.js)
// and IB agent-draft (estimate-tools.js) estimates persist their priced lines ONLY
// under estData.engineResult.lineItems — there is no v1-mapped
// result.recurring.services row. The accept path must source recurring services
// from engineResult (not just result/top-level), or a foam-only engine-backed
// quote accepts with monthly_total locked while EstimateConverter receives no
// recurring service to schedule, seed follow-ups, or invoice.
function engineBackedFoamEstData() {
  return {
    engineInputs: { services: { foamRecurring: { cadence: 'quarterly', points: 10 } } },
    engineResult: {
      summary: { monthlyTotal: 92.33, annualTotal: 1108 },
      lineItems: [
        {
          service: 'foam_recurring',
          name: 'Recurring Foam Treatment (Quarterly)',
          annual: 1108,
          monthly: 92.33,
          price: 277,
          total: 1108,
          perApp: 277,
          frequency: 4,
        },
      ],
      waveGuard: null,
    },
    agentDraft: true,
  };
}

describe('engine-backed recurring foam survives the accept service-list build', () => {
  test('acceptanceServiceLists surfaces foam_recurring from engineResult', () => {
    const { recurringSvcList } = acceptanceServiceLists(engineBackedFoamEstData());
    const foam = recurringSvcList.find((s) => (s.service || s.key) === 'foam_recurring');
    expect(foam).toBeTruthy();
    expect(Number(foam.monthly || foam.mo)).toBeGreaterThan(0);
    expect(Number(foam.annual)).toBe(1108);
    // cadence is inferred from the line name on accept
    expect(String(foam.name || '')).toMatch(/quarterly/i);
  });

  test('withSupplementedRecurringServices writes foam into recurring.services and keeps the engine wrapper', () => {
    const out = withSupplementedRecurringServices(engineBackedFoamEstData());
    const services = out?.recurring?.services || [];
    expect(services.some((s) => (s.service || s.key) === 'foam_recurring')).toBe(true);
    // engineInputs/engineResult must survive so downstream pricing can replay the engine
    expect(out.engineInputs).toBeTruthy();
    expect(out.engineResult).toBeTruthy();
  });

  test('the v1-mapped result.recurring.services path is unaffected', () => {
    const v1 = {
      result: {
        recurring: {
          services: [
            {
              service: 'foam_recurring',
              name: 'Recurring Foam Treatment (Bimonthly)',
              monthly: 87.5,
              annual: 1050,
              cadence: 'bimonthly',
              discountable: false,
            },
          ],
        },
      },
    };
    const { recurringSvcList } = acceptanceServiceLists(v1);
    expect(recurringSvcList.some((s) => (s.service || s.key) === 'foam_recurring')).toBe(true);
  });
});

describe('engine-backed foam frequency recovers cadence / annual / duration from the compact row', () => {
  test('cadence is derived from visit count + name when the cadence field is missing', () => {
    // Bimonthly: 6 visits/yr, name carries "(Bimonthly)", no cadence field.
    const [bimonthly] = foamFrequenciesFromEngineResult(
      compactFoamEngineResult({ name: 'Recurring Foam Treatment (Bimonthly)', frequency: 6, annual: 1572, monthly: 131 }),
    );
    expect(bimonthly.key).toBe('bimonthly');
    expect(bimonthly.label).toBe('Bimonthly');
    expect(bimonthly.billingFrequencyKey).toBe('monthly');
    expect(bimonthly.visitsPerYear).toBe(6);

    // Monthly: 12 visits/yr — must NOT be misread as quarterly.
    const [monthly] = foamFrequenciesFromEngineResult(
      compactFoamEngineResult({ name: 'Recurring Foam Treatment (Monthly)', frequency: 12, annual: 2952, monthly: 246 }),
    );
    expect(monthly.key).toBe('monthly');
    expect(monthly.visitsPerYear).toBe(12);
  });

  test('the authoritative sold annual is preserved to the cent (no monthly*12 drift)', () => {
    // Engine persists annual:1108 with rounded monthly:92.33 (92.33*12 = 1107.96).
    const [q] = foamFrequenciesFromEngineResult(
      compactFoamEngineResult({ name: 'Recurring Foam Treatment (Quarterly)', frequency: 4, annual: 1108, monthly: 92.33 }),
    );
    expect(q.key).toBe('quarterly');
    expect(q.annual).toBe(1108); // not 1107.96
    expect(q.perTreatment).toBe(277); // 1108 / 4
  });

  test('booking slot duration uses the foam tier minutes carried on the row, not the 90-min default', () => {
    // 20-pt foam → 180 min. With the source now carrying estimatedDurationMinutes,
    // durationForService sizes the slot from it (clamped to the 15-min grid).
    expect(durationForService({ service: 'foam_recurring', estimatedDurationMinutes: 180 })).toBe(180);
    expect(durationForService({ service: 'foam_recurring', estimatedDurationMinutes: 120 })).toBe(120);
    // Thin row with no duration still degrades to the foam default (not 45).
    expect(durationForService({ service: 'foam_recurring' })).toBe(90);
  });

  test('a foam row labeled only by name is still classified as foam for slot sizing', () => {
    // Engine-backed rows can reach slot sizing with just a display label (no
    // mapped service key). serviceKeyFor must classify them as foam_recurring so
    // the carried tier duration is used instead of the generic window.
    expect(durationForService({ name: 'Recurring Foam Treatment', estimatedDurationMinutes: 180 })).toBe(180);
    expect(durationForService({ service: 'FoamRecurring', estimatedDurationMinutes: 120 })).toBe(120);
    // One-time "Drill-and-Foam Termite" still classifies as termite (not foam).
    expect(durationForService({ name: 'Drill-and-Foam Termite' })).toBe(45);
  });
});

describe('recurring foam cadence-key normalization', () => {
  test('priceRecurringFoam treats bi_monthly as the 6-visit bimonthly plan', () => {
    const bi = priceRecurringFoam(10, { cadence: 'bi_monthly' });
    expect(bi.cadence).toBe('bimonthly');
    expect(bi.visitsPerYear).toBe(6);
    // not silently downgraded to the 4-visit quarterly multiplier
    const q = priceRecurringFoam(10, { cadence: 'quarterly' });
    expect(bi.perVisit).toBeLessThan(q.perVisit);
  });

  test('foamFrequenciesFromEngineResult normalizes a bi_monthly row cadence', () => {
    const [f] = foamFrequenciesFromEngineResult({
      lineItems: [{ service: 'foam_recurring', name: 'Recurring Foam Treatment', cadence: 'bi_monthly', monthly: 131, annual: 1572 }],
    });
    expect(f.key).toBe('bimonthly');
    expect(f.visitsPerYear).toBe(6);
  });
});

describe('engine-backed foam pricing-bundle frequency selection', () => {
  test('foam-only recurring estimate is priced by the foam-specific frequency', async () => {
    const bundle = await buildPricingBundle({
      id: 1, status: 'sent', monthly_total: 92.33, annual_total: 1108,
      estimate_data: JSON.stringify({ engineInputs: { services: { foamRecurring: { cadence: 'bimonthly', points: 10 } } } }),
    });
    const f = (bundle.frequencies || [])[0] || {};
    expect(f.serviceCategory).toBe('foam_recurring');
    expect(f.billingFrequencyKey).toBe('monthly');
  });

  test('foam + another recurring service keeps full-summary pricing (does not drop the other service)', async () => {
    const bundle = await buildPricingBundle({
      id: 2, status: 'sent', monthly_total: 200, annual_total: 2400,
      estimate_data: JSON.stringify({
        engineInputs: { homeSqFt: 2000, lotSqFt: 8000, services: { foamRecurring: { cadence: 'quarterly', points: 10 }, treeShrub: {} } },
      }),
    });
    const f = (bundle.frequencies || [])[0] || {};
    // NOT the foam-only frequency — full-summary entry covering both services.
    expect(f.serviceCategory).not.toBe('foam_recurring');
    const treatmentServices = (f.perServiceTreatments || []).map((t) => t.service);
    expect(treatmentServices).toContain('foam_recurring');
    expect(treatmentServices).toContain('tree_shrub');
    // annual reflects the mix, not the ~1108 foam-only total.
    expect(f.annual).toBeGreaterThan(1108);
  });

  test('foam keeps its own cadence in a mixed plan whose top-level frequency is the generic ladder row', async () => {
    const bundle = await buildPricingBundle({
      id: 4, status: 'sent', monthly_total: 200, annual_total: 2400,
      estimate_data: JSON.stringify({
        engineInputs: { homeSqFt: 2000, lotSqFt: 8000, services: { foamRecurring: { cadence: 'bimonthly', points: 10 }, treeShrub: {} } },
      }),
    });
    const f = (bundle.frequencies || [])[0] || {};
    const foamRow = (f.perServiceTreatments || []).find((t) => t.service === 'foam_recurring');
    expect(foamRow).toBeTruthy();
    expect(foamRow.cadence).toBe('bimonthly');
    expect(foamRow.visitsPerYear).toBe(6);
  });
});

describe('engineInputs-only foam estimate is schedulable on accept (no stored result/engineResult)', () => {
  const inputsOnly = () => ({ engineInputs: { services: { foamRecurring: { cadence: 'quarterly', points: 10 } } } });

  test('withSupplementedRecurringServices replays the engine and supplements the foam row (wrapper kept)', () => {
    const out = withSupplementedRecurringServices(inputsOnly());
    expect((out.recurring?.services || []).some((s) => s.service === 'foam_recurring')).toBe(true);
    expect(out.engineInputs).toBeTruthy(); // engine wrapper preserved for downstream pricing
  });

  test('acceptanceServiceLists (on the supplemented data) yields the foam recurring row', () => {
    const supplemented = withSupplementedRecurringServices(inputsOnly());
    const { recurringSvcList } = acceptanceServiceLists(supplemented);
    expect(recurringSvcList.some((s) => (s.service || s.key) === 'foam_recurring')).toBe(true);
  });
});

describe('shapeFromV1 keeps foam cent-exact in a mixed (pest + foam) bundle', () => {
  test('mixed annual uses the foam line’s exact annual, not monthly×12', () => {
    const v1 = {
      discount: 0,
      manualDiscount: null,
      services: [
        { name: 'Pest Control', service: 'pest_control', mo: 50, ann: 600, perTreatment: 150, visitsPerYear: 4 },
        { name: 'Recurring Foam (Quarterly)', service: 'foam_recurring', mo: 92.33, annual: 1108, perTreatment: 277, visitsPerYear: 4 },
      ],
    };
    const pestTier = { mo: 50, ann: 600, apps: 4, pa: 150, label: 'Quarterly' };
    const f = shapeFromV1(v1, { key: 'quarterly', label: 'Quarterly' }, pestTier, {});
    expect(f.annual).toBe(1708); // 600 pest + 1108 foam (not 600 + 1107.96)
    expect(f.monthly).toBe(142.33); // monthly stays mo-based
  });
});

describe('mapV1ToLegacyShape carries the foam annual total', () => {
  test('admin/V2 mapped foam row includes the engine annual (cent-exact lock)', () => {
    const mapped = mapV1ToLegacyShape(
      generateEstimate({ services: { foamRecurring: { cadence: 'quarterly', points: 10 } } }),
    );
    const foam = (mapped.recurring?.services || []).find((s) => s.service === 'foam_recurring');
    expect(foam).toBeTruthy();
    expect(foam.annual).toBe(1108); // not omitted → helper won't fall back to 92.33×12
  });
});
