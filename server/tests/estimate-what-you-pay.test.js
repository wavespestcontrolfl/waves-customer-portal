/**
 * "What you pay and when" payload (owner 2026-11-23): /data's `whatYouPay` is built from the functions the
 * accept path mints the first invoice with, and is null whenever any of them cannot resolve.
 * Synthetic estimates only.
 */
const { whatYouPayForData } = require('../routes/estimate-public');

const row = (service, label, perApp, visits) => ({
  service, label, displayPrice: perApp, perTreatment: perApp, visitsPerYear: visits, monthly: (perApp * visits) / 12,
});
const recurringRow = (service, name) => ({ service, name, label: name });

const estimateRow = (extra = {}) => ({
  id: 1, token: 'a'.repeat(24), status: 'sent', show_one_time_option: false, expires_at: new Date(Date.now() + 86400000), ...extra,
});
const dataFor = (services, extra = {}) => ({
  result: { recurring: { services } },
  ...extra,
});
const pestSection = { key: 'pest_control', label: 'Pest Control', isRecurring: true, defaultFrequencyKey: 'quarterly', frequencies: [{ key: 'quarterly' }] };
const lawnSection = { key: 'lawn_care', label: 'Lawn Care', isRecurring: true, defaultFrequencyKey: 'standard', frequencies: [{ key: 'standard' }] };

const pestOnly = () => ({
  estimate: estimateRow(),
  estData: dataFor([recurringRow('pest_control', 'Pest Control')]),
  pricingBundle: {
    services: [pestSection],
    frequencies: [{ key: 'quarterly', monthly: 33, annual: 396, visitsPerYear: 4, perServiceTreatments: [row('pest_control', 'Pest Control', 99, 4)] }],
    oneTimeBreakdown: { total: 99, items: [{ service: 'waveguard_setup', amount: 99 }] },
    firstVisitFees: [{ service: 'waveguard_setup', amount: 99, waivedWithPrepay: true }],
  },
});
const bundle = () => ({
  estimate: estimateRow(),
  estData: dataFor([recurringRow('pest_control', 'Pest Control'), recurringRow('lawn_care', 'Lawn Care')]),
  pricingBundle: {
    services: [pestSection, lawnSection],
    frequencies: [{
      key: 'quarterly', monthly: 91.5, annual: 1098, visitsPerYear: 4,
      perServiceTreatments: [row('pest_control', 'Pest Control', 99, 4), row('lawn_care', 'Lawn Care', 78, 9)],
    }],
    oneTimeBreakdown: { total: 0, items: [] },
  },
});
const lawnOnly = () => ({
  estimate: estimateRow(),
  estData: dataFor([recurringRow('lawn_care', 'Lawn Care')]),
  pricingBundle: {
    services: [lawnSection],
    frequencies: [{ key: 'standard', monthly: 58.5, annual: 702, visitsPerYear: 9, perServiceTreatments: [row('lawn_care', 'Lawn Care', 78, 9)] }],
    oneTimeBreakdown: { total: 0, items: [] },
  },
});

describe('whatYouPayForData', () => {
  test('pest only: one line, the $99 setup fee, first visit total = application + fee', () => {
    const out = whatYouPayForData(pestOnly());
    expect(out).toEqual({
      selection: { frequency: 'quarterly', serviceCadences: null },
      lines: [{ key: 'pest_control', label: 'Pest Control', perApplication: 99, applicationsPerYear: 4 }],
      setupFee: expect.any(Number),
      setupWaivedWithPrepay: expect.any(Boolean),
      firstVisitTotal: 99 + out.setupFee,
    });
    expect(out.setupFee).toBeGreaterThan(0);
  });

  test('bundle: each service itemised, $177 first visit, no setup fee', () => {
    const out = whatYouPayForData(bundle());
    expect(out.lines).toEqual([
      { key: 'pest_control', label: 'Pest Control', perApplication: 99, applicationsPerYear: 4 },
      { key: 'lawn_care', label: 'Lawn Care', perApplication: 78, applicationsPerYear: 9 },
    ]);
    expect(out.setupFee).toBeNull();
    expect(out.setupWaivedWithPrepay).toBe(false);
    expect(out.firstVisitTotal).toBe(177);
  });

  test('lawn only: no setup fee', () => {
    const out = whatYouPayForData(lawnOnly());
    expect(out.lines).toHaveLength(1);
    expect(out.setupFee).toBeNull();
    expect(out.firstVisitTotal).toBe(78);
  });

  test('legacy split plan: the accept sees lawn too, the displayed frequency prices pest only: null', () => {
    const input = pestOnly();
    input.estData = dataFor([recurringRow('pest_control', 'Pest Control'), recurringRow('lawn_care', 'Lawn Care')]);
    expect(whatYouPayForData(input)).toBeNull();
  });

  test('partially priced bundle (a service row with no price): null, never a same-day-total fallback', () => {
    const input = bundle();
    input.pricingBundle.frequencies[0].perServiceTreatments[1] = { service: 'lawn_care', label: 'Lawn Care', visitsPerYear: 9 };
    input.pricingBundle.frequencies[0].sameDayTreatmentTotal = 177;
    expect(whatYouPayForData(input)).toBeNull();
  });

  test('a row price the accept path ignores (priceAfterDiscount only): null', () => {
    const input = bundle();
    input.pricingBundle.frequencies[0].perServiceTreatments[1] = { service: 'lawn_care', label: 'Lawn Care', visitsPerYear: 9, priceAfterDiscount: 78 };
    input.pricingBundle.frequencies[0].sameDayTreatmentTotal = 177;
    expect(whatYouPayForData(input)).toBeNull();
  });

  test('an unreadable visit count on a line: null', () => {
    const input = lawnOnly();
    delete input.pricingBundle.frequencies[0].perServiceTreatments[0].visitsPerYear;
    expect(whatYouPayForData(input)).toBeNull();
  });

  test('a preference credit that moves a line off its displayed price: null (the lines would not match the bill)', () => {
    const input = pestOnly();
    input.estData.preferences = { interior_spray: false };
    expect(whatYouPayForData(input)).toBeNull();
  });

  test.each([
    ['a live plan credit', (i) => { i.pricingBundle.frequencies[0].manualDiscount = { amount: 12, recurringAmount: 12, type: 'FIXED' }; }],
    ['a bait-station setup row beside the plan', (i) => { i.pricingBundle.oneTimeBreakdown = { total: 150, items: [{ service: 'rodent_bait_setup', amount: 150 }] }; }],
    ['another first-visit fee', (i) => { i.pricingBundle.firstVisitFees.push({ service: 'pest_initial_roach', amount: 150 }); }],
    ['invoice billing', (i) => { i.invoiceMode = true; }],
    ['a site-confirmation hold', (i) => { i.siteConfirmationHold = true; }],
    ['a monthly-billed account', (i) => { i.monthlyBilled = true; }],
    ['a quote-required estimate', (i) => { i.quoteRequired = true; }],
    ['an accepted estimate', (i) => { i.estimate.status = 'accepted'; }],
    ['a frozen restart quote', (i) => { i.estimate.source = 'plan_restart'; }],
  ])('%s: null', (_label, mutate) => {
    const input = pestOnly();
    mutate(input);
    expect(whatYouPayForData(input)).toBeNull();
  });

  test('a one-time option: the alternate one-time row does not hide the box', () => {
    const input = pestOnly();
    input.estimate.show_one_time_option = true;
    input.pricingBundle.oneTimeBreakdown = { total: 348, items: [{ service: 'one_time_pest', amount: 249 }, { service: 'waveguard_setup', amount: 99 }] };
    expect(whatYouPayForData(input)).not.toBeNull();
  });

  test('per-line amounts that do not add up to the first invoice amount to the cent: null', () => {
    // Two rows at $10.004: the invoice sums the unrounded rows to $20.01, the printed lines sum to $20.00.
    const input = bundle();
    const f = input.pricingBundle.frequencies[0];
    f.perServiceTreatments = [row('pest_control', 'Pest Control', 10.004, 4), row('lawn_care', 'Lawn Care', 10.004, 9)];
    expect(whatYouPayForData(input)).toBeNull();
  });
});
