const {
  acceptanceServiceLists,
  withSupplementedRecurringServices,
  foamFrequenciesFromEngineResult,
} = require('../routes/estimate-public.js');
const { _internals: { durationForService } } = require('../services/estimate-slot-availability.js');

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
});
