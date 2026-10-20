// GATE_ESTIMATE_MONTHLY_AVERAGE (owner 2026-10-20): the shared builder and the
// server decision of whether the average may be shown. No database.
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
const mockGate = { on: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => (gate === 'estimateMonthlyAverage' ? mockGate.on : false)),
}));

const shared = require('../../shared/estimate-monthly-average.cjs');
const { monthlyAverageFor } = require('../services/estimate-monthly-average');

const { buildMonthlyAverage, emailParts } = shared;
const sumCents = (model) => model.services.reduce((a, s) => a + Math.round(s.monthly * 100), 0);

beforeEach(() => { mockGate.on = true; });

describe('buildMonthlyAverage', () => {
  test('single service: pest $94 x 4 a year averages $31.33 a month', () => {
    const model = buildMonthlyAverage({ services: [{ key: 'pest', label: 'Pest Control', perApplication: 94, visits: 4 }], planMonthly: 31.33 });
    expect(model.multi).toBe(false);
    expect(model.services[0]).toMatchObject({ perApplication: 94, visits: 4, monthly: 31.33 });
    expect(model.planMonthly).toBe(31.33);
    expect(model.credit).toBeNull();
    expect(model.bundlePct).toBe(0);
  });

  test('multi service (owner example): lines add up to the stored monthly total', () => {
    const model = buildMonthlyAverage({
      services: [
        { key: 'lawn', label: 'Lawn Care — 9 applications/yr', perApplication: 56.4, visits: 9 },
        { key: 'pest', label: 'Pest Control — 4 applications/yr', perApplication: 90, visits: 4 },
      ],
      planMonthly: 72.3,
      bundleDiscountPct: 0.1,
    });
    expect(model.services.map((s) => s.monthly)).toEqual([42.3, 30]);
    expect(model.planMonthly).toBe(72.3);
    expect(sumCents(model)).toBe(7230);
    expect(model.bundlePct).toBe(10);
    expect(shared.planLabel(model)).toBe('Your plan averages (10% bundle savings included)');
  });

  test('rounding remainder: three services that do not divide evenly still sum to the plan to the cent', () => {
    // raw averages 35.4975 + 11.0567 + 43.7775 = 90.3317, stored total 90.33:
    // each rounds to 3550 + 1106 + 4378 = 9034 cents, one cent over.
    const services = [
      { key: 'a', label: 'Lawn Care', perApplication: 47.33, visits: 9 },
      { key: 'b', label: 'Pest Control', perApplication: 33.17, visits: 4 },
      { key: 'c', label: 'Tree & Shrub', perApplication: 58.37, visits: 9 },
    ];
    const model = buildMonthlyAverage({ services, planMonthly: 90.33, bundleDiscountPct: 0.15 });
    expect(sumCents(model)).toBe(9033);
    expect(model.planMonthly).toBe(90.33);
    // The cent comes off the LARGEST line only.
    expect(model.services.map((s) => s.monthly)).toEqual([35.5, 11.06, 43.77]);
  });

  test('rounding remainder: a stored total one cent ABOVE the rounded lines adds the cent to the largest line', () => {
    const model = buildMonthlyAverage({
      services: [
        { key: 'a', label: 'A', perApplication: 10, visits: 4 },
        { key: 'b', label: 'B', perApplication: 10, visits: 4 },
        { key: 'c', label: 'C', perApplication: 10, visits: 4 },
      ],
      planMonthly: 10.01,
    });
    // raw 3.3333 each (9.99 rounded) against a stored 10.01: two cents to move.
    expect(sumCents(model)).toBe(1001);
    expect(model.services.map((s) => Math.round(s.monthly * 100)).sort()).toEqual([333, 334, 334]);
  });

  test('a declared plan credit explains a gap and prints as its own negative line', () => {
    const model = buildMonthlyAverage({
      services: [
        { key: 'a', label: 'Lawn Care', perApplication: 62.67, visits: 9 },
        { key: 'b', label: 'Pest Control', perApplication: 100, visits: 4 },
      ],
      planMonthly: 75,
      credit: { label: 'Referral Credit', monthly: 5.34 },
    });
    expect(model.credit).toEqual({ label: 'Referral Credit', monthly: 5.33 });
    expect(sumCents(model) - Math.round(model.credit.monthly * 100)).toBe(7500);
  });

  test('withheld (null) when the figures do not describe one plan', () => {
    const two = [
      { key: 'a', perApplication: 56.4, visits: 9 },
      { key: 'b', perApplication: 90, visits: 4 },
    ];
    expect(buildMonthlyAverage({ services: two, planMonthly: 60 })).toBeNull(); // undeclared gap
    expect(buildMonthlyAverage({ services: two, planMonthly: 99 })).toBeNull(); // plan pays more than the services
    expect(buildMonthlyAverage({ services: two, planMonthly: 60, credit: { monthly: 3 } })).toBeNull(); // credit does not explain it
    expect(buildMonthlyAverage({ services: two, planMonthly: 0 })).toBeNull();
    expect(buildMonthlyAverage({ services: [{ perApplication: 94, visits: 0 }], planMonthly: 31.33 })).toBeNull();
    expect(buildMonthlyAverage({ services: [], planMonthly: 31.33 })).toBeNull();
  });
});

describe('emailParts', () => {
  test('single service with a plan credit: the email average is the plan monthly, not the pre-credit line', () => {
    // $94 x 4 = $31.33 a month before a $10 credit; the plan pays $21.33.
    const model = buildMonthlyAverage({
      services: [{ key: 'pest', label: 'Pest Control', perApplication: 94, visits: 4 }],
      planMonthly: 21.33,
      credit: { label: 'Referral Credit', monthly: 10 },
    });
    expect(model.showPlan).toBe(true);
    expect(model.services[0].monthly).toBe(31.33);
    expect(model.planMonthly).toBe(21.33);
    const parts = emailParts(model);
    expect(parts.priceLine).toBe('$94.00 per application · about $21.33 a month');
    expect(parts.note).toContain('referral credit included');
    expect(parts.priceLine).not.toContain('31.33');
  });

  test('single service keeps the per-application price first', () => {
    const model = buildMonthlyAverage({ services: [{ key: 'pest', label: 'Pest Control', perApplication: 94, visits: 4 }], planMonthly: 31.33 });
    expect(emailParts(model)).toEqual({
      priceLine: '$94.00 per application · about $31.33 a month',
      note: 'Averaged over the year. You pay after each application.',
    });
  });

  test('multi service names the plan, the bundle savings and the one-time setup', () => {
    const model = buildMonthlyAverage({
      services: [
        { key: 'lawn', label: 'Lawn Care — 9 applications/yr', perApplication: 56.4, visits: 9 },
        { key: 'pest', label: 'Pest Control — 4 applications/yr', perApplication: 90, visits: 4 },
      ],
      planMonthly: 72.3,
      bundleDiscountPct: 0.1,
    });
    expect(emailParts(model, { amount: 99, setup: true })).toEqual({
      priceLine: 'Priced per application · plan averages about $72.30 a month',
      note: 'Averaged over the year, bundle savings included. You pay after each application. One-time setup $99.00, not in the average.',
    });
    expect(emailParts(model, { amount: 99, setup: false }).note).toContain('One-time charges $99.00, not in the average.');
  });

  test('never states "$X/mo" as a price', () => {
    const model = buildMonthlyAverage({ services: [{ key: 'pest', label: 'Pest Control', perApplication: 94, visits: 4 }], planMonthly: 31.33 });
    const parts = emailParts(model);
    expect(`${parts.priceLine} ${parts.note}`).not.toMatch(/\/\s?mo|\/month/i);
  });
});

describe('monthlyAverageFor (server decision)', () => {
  const perApp = (description, amount, visitsPerYear, extra = {}) => ({
    description, quantity: 1, unitPrice: amount, amount, frequency: 'per_application', visitsPerYear, taxable: false, ...extra,
  });
  const proposalOf = (lineItems, extra = {}) => ({ enabled: false, synthesized: true, buildings: [{ name: 'x', lineItems }], programs: [], correctiveWork: [], ...extra });
  const estimateOf = (monthly, extra = {}) => ({ id: 'e1', category: 'RESIDENTIAL', monthly_total: monthly, estimate_data: {}, ...extra });
  const pest = proposalOf([perApp('Pest Control — 4 applications/yr', 94, 4)]);

  test('single service, gate on', () => {
    const result = monthlyAverageFor({ estimate: estimateOf(31.33), proposal: pest, bundle: null });
    expect(result.model.services[0].monthly).toBe(31.33);
    expect(result.inputs).toEqual({ planMonthly: 31.33, credit: null, bundleDiscountPct: 0, oneTime: null });
  });

  test('gate off: nothing, for every plan shape', () => {
    mockGate.on = false;
    expect(monthlyAverageFor({ estimate: estimateOf(31.33), proposal: pest })).toBeNull();
  });

  test('multi service with bundle discount and one-time setup (setup stays out of the average)', () => {
    const proposal = proposalOf([
      perApp('Lawn Care — 9 applications/yr', 56.4, 9),
      perApp('Pest Control — 4 applications/yr', 90, 4),
      { description: 'WaveGuard setup', quantity: 1, unitPrice: 99, amount: 99, frequency: 'one_time', taxable: false },
    ]);
    const result = monthlyAverageFor({
      estimate: estimateOf(72.3), proposal, bundle: { combinedRecurring: { waveGuardDiscountPct: 0.1 }, firstVisitFees: [{ service: 'waveguard_setup', amount: 99 }] },
    });
    expect(result.model.planMonthly).toBe(72.3);
    expect(result.inputs.oneTime).toEqual({ amount: 99, setup: true });
    expect(result.inputs.bundleDiscountPct).toBe(0.1);
  });

  test('unchanged plans: commercial, authored proposal, quote-required, flat-monthly, one-time only, stale total', () => {
    expect(monthlyAverageFor({ estimate: estimateOf(31.33, { category: 'COMMERCIAL' }), proposal: pest })).toBeNull();
    expect(monthlyAverageFor({ estimate: estimateOf(31.33), proposal: { ...pest, enabled: true } })).toBeNull();
    expect(monthlyAverageFor({ estimate: estimateOf(31.33), proposal: pest, bundle: { quoteRequired: true } })).toBeNull();
    expect(monthlyAverageFor({ estimate: estimateOf(31.33, { estimate_data: JSON.stringify({ quoteRequired: true }) }), proposal: pest })).toBeNull();
    const flat = proposalOf([{ description: 'Recurring service plan', quantity: 1, unitPrice: 55, amount: 55, frequency: 'monthly', taxable: false }]);
    expect(monthlyAverageFor({ estimate: estimateOf(55), proposal: flat })).toBeNull();
    const oneTimeOnly = proposalOf([{ description: 'One-time service', quantity: 1, unitPrice: 250, amount: 250, frequency: 'one_time', taxable: false }]);
    expect(monthlyAverageFor({ estimate: estimateOf(0), proposal: oneTimeOnly })).toBeNull();
    // A stored total that does not match the lines (stale columns) withholds the average.
    expect(monthlyAverageFor({ estimate: estimateOf(40), proposal: pest })).toBeNull();
  });

  test('the credit comes from the SELECTED service-cadence combo: top-level suppressed, combo grants it', () => {
    const lines = [
      perApp('Lawn Care — 9 applications/yr', 56.4, 9),
      perApp('Pest Control — 4 applications/yr', 90, 4),
    ];
    const combo = {
      key: 'quarterly:standard', annual: 747.6, monthly: 62.3,
      perServiceTreatments: [
        { label: 'Lawn Care', service: 'lawn_care', displayPrice: 56.4, visitsPerYear: 9 },
        { label: 'Pest Control', service: 'pest_control', displayPrice: 90, visitsPerYear: 4 },
      ],
      manualDiscount: { label: 'Referral Credit', recurringAmount: 120 },
    };
    const bundle = {
      combinedRecurring: { waveGuardDiscountPct: 0.1 },
      manualDiscountSuppressed: true,
      frequencies: [],
      serviceCadenceCombos: [combo],
    };
    // Frozen path: the candidate is resolved from the send snapshot, the way the document's lines were.
    const frozen = (b) => estimateOf(62.3, { annual_total: 747.6, estimate_data: { sendSnapshot: { pricingBundle: b } } });
    const result = monthlyAverageFor({ estimate: frozen(bundle), proposal: proposalOf(lines), bundle });
    expect(result.model.credit).toEqual({ label: 'Referral Credit', monthly: 10 });
    expect(result.model.planMonthly).toBe(62.3);
    // A combo that suppresses its credit gets none, even though the bundle root declares one.
    const suppressed = { ...bundle, manualDiscountSuppressed: false, manualDiscount: { label: 'Root', recurringAmount: 120 }, serviceCadenceCombos: [{ ...combo, manualDiscount: undefined, manualDiscountSuppressed: true }] };
    expect(monthlyAverageFor({ estimate: frozen(suppressed), proposal: proposalOf(lines), bundle: suppressed })).toBeNull();
  });

  test('a wizard draft carrying the commercial marker is commercial even with category RESIDENTIAL', () => {
    const marked = estimateOf(31.33, { estimate_data: { commercialEstimatedPricing: true } });
    expect(marked.category).toBe('RESIDENTIAL');
    expect(monthlyAverageFor({ estimate: marked, proposal: pest })).toBeNull();
    const asString = estimateOf(31.33, { estimate_data: JSON.stringify({ commercialEstimatedPricing: true }) });
    expect(monthlyAverageFor({ estimate: asString, proposal: pest })).toBeNull();
    const row = estimateOf(31.33, { estimate_data: { engineResult: { lineItems: [{ service: 'commercial_pest', estimatedPricing: true, annual: 376 }] } } });
    expect(monthlyAverageFor({ estimate: row, proposal: pest })).toBeNull();
  });

  describe('one-time charges beside the plan are decided by identity, never by wording', () => {
    const cleanout = { description: 'Initial Pest Cleanout', quantity: 1, unitPrice: 250, amount: 250, frequency: 'one_time', taxable: false };
    const setup = { description: 'WaveGuard setup', quantity: 1, unitPrice: 99, amount: 99, frequency: 'one_time', taxable: false };
    const roach = { description: 'Initial German Roach Knockdown', quantity: 1, unitPrice: 75, amount: 75, frequency: 'one_time', taxable: false };
    const flea = { description: 'Flea Treatment', quantity: 1, unitPrice: 150, amount: 150, frequency: 'one_time', taxable: false };
    const plan = perApp('Pest Control — 4 applications/yr', 94, 4);
    const feeSetup = { service: 'waveguard_setup', amount: 99 };
    const feeRoach = { service: 'pest_initial_roach', amount: 75 };
    const run = (lines, estimateExtra, bundle) => monthlyAverageFor({ estimate: estimateOf(31.33, estimateExtra), proposal: proposalOf([plan, ...lines]), bundle });

    test('either/or option offered: "Initial Pest Cleanout" is the alternative, not a charge beside the plan', () => {
      expect(run([cleanout], { show_one_time_option: true }, {}).inputs.oneTime).toBeNull();
      expect(run([cleanout], { show_one_time_option: true }, { firstVisitFees: [] }).inputs.oneTime).toBeNull();
    });

    test('either/or option offered: only the bundle\'s real first-visit fees count, whatever the lines say', () => {
      expect(run([setup, cleanout], { show_one_time_option: true }, { firstVisitFees: [feeSetup] }).inputs.oneTime).toEqual({ amount: 99, setup: true });
      // Without a fee list the lone setupFee is the source (the page's feeList rule).
      expect(run([setup, cleanout], { show_one_time_option: true }, { setupFee: feeSetup }).inputs.oneTime).toEqual({ amount: 99, setup: true });
      expect(run([setup, cleanout], { show_one_time_option: true }, { firstVisitFees: [feeSetup, feeRoach] }).inputs.oneTime).toEqual({ amount: 174, setup: false });
    });

    test('no one-time option: every positive one-time line counts; "setup" only when it is the WaveGuard setup fee', () => {
      expect(run([setup], {}, { firstVisitFees: [feeSetup] }).inputs.oneTime).toEqual({ amount: 99, setup: true });
      // A breakdown row can carry the same setup charge.
      expect(run([setup], {}, { oneTimeBreakdown: { items: [{ kind: 'charge', service: 'waveguard_setup', amount: 99 }] } }).inputs.oneTime).toEqual({ amount: 99, setup: true });
      // Setup + roach first-visit fee: "One-time charges".
      expect(run([setup, roach], {}, { firstVisitFees: [feeSetup, feeRoach] }).inputs.oneTime).toEqual({ amount: 174, setup: false });
      // An additive flea row beside setup.
      const withFlea = run([setup, flea], {}, { firstVisitFees: [feeSetup] });
      expect(withFlea.inputs.oneTime).toEqual({ amount: 249, setup: false });
      expect(emailParts(withFlea.model, withFlea.inputs.oneTime).note).toContain('One-time charges $249.00, not in the average.');
      // A setup-sounding line with no setup identity is not setup ("Initial ..." wording proves nothing).
      expect(run([cleanout], {}, {}).inputs.oneTime).toEqual({ amount: 250, setup: false });
    });
  });

  test('a declared bundle credit explains a gap between the lines and the stored total', () => {
    const proposal = proposalOf([
      perApp('Lawn Care — 9 applications/yr', 56.4, 9),
      perApp('Pest Control — 4 applications/yr', 90, 4),
    ]);
    const result = monthlyAverageFor({
      estimate: estimateOf(62.3),
      proposal,
      bundle: { combinedRecurring: { waveGuardDiscountPct: 0.1 }, manualDiscount: { label: 'Referral Credit', recurringAmount: 120 } },
    });
    expect(result.model.credit).toEqual({ label: 'Referral Credit', monthly: 10 });
    expect(result.model.planMonthly).toBe(62.3);
  });
});

describe('reviewedAverageStale (reviewed and scheduled sends)', () => {
  const { reviewedAverageStale, averageText } = require('../services/estimate-monthly-average');
  const parts = { priceLine: '$94.00 per application · about $31.33 a month', note: 'Averaged over the year. You pay after each application.' };
  const reviewed = (email) => ({ sms: null, email });

  test('the recorded copy is the price row and the context sentence', () => {
    expect(averageText(parts)).toBe(`${parts.priceLine}\n${parts.note}`);
    expect(averageText(null)).toBeNull();
  });

  test('gate off with nothing recorded: not stale, and nothing is read', async () => {
    mockGate.on = false;
    const loadRow = jest.fn();
    expect(await reviewedAverageStale(reviewed({ provider: 'sendgrid' }), loadRow)).toBe(false);
    expect(loadRow).not.toHaveBeenCalled();
  });

  test('a recorded average with the gate now off is stale; an SMTP or absent review never is', async () => {
    mockGate.on = false;
    const loadRow = jest.fn(async () => ({}));
    expect(await reviewedAverageStale(reviewed({ provider: 'sendgrid', monthlyAverage: averageText(parts) }), loadRow)).toBe(true);
    expect(await reviewedAverageStale(reviewed({ provider: 'smtp', monthlyAverage: averageText(parts) }), loadRow)).toBe(false);
    expect(await reviewedAverageStale(null, loadRow)).toBe(false);
    expect(await reviewedAverageStale(reviewed(null), loadRow)).toBe(false);
  });
});
