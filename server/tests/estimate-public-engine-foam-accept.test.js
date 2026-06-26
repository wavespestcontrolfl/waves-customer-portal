const {
  acceptanceServiceLists,
  withSupplementedRecurringServices,
} = require('../routes/estimate-public.js');

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
