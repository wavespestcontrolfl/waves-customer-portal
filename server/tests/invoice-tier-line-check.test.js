/**
 * invoice-tier-line-check.js: the nightly check for a WaveGuard tier saving an invoice would leave out. The invoice
 * decision (completion-pricing.js acceptedVisitBreakdown) is mocked, with the estimate row and the schedule line it
 * matched. The invoice's own line pricing (acceptedPricing) and staff-discount reader stay the real ones: this suite
 * proves the witness (the estimate's own engine line record and the records that must agree with it), the question the
 * check asks of that pricing, and which visits it reads. completion-pricing.postgres.test.js runs the check on the real
 * decision. Synthetic estimates in the saved engine shape (memory saved-estimate-tier-shape-trap); no real figures.
 */
jest.mock('../services/completion-pricing', () => {
  const actual = jest.requireActual('../services/completion-pricing');
  return { ...actual, acceptedVisitBreakdown: jest.fn(), acceptedPricing: jest.fn(actual.acceptedPricing) };
});
// The annual-prepay verdict a billing prediction passes: no after-visit prepay year, no stamp to validate (null).
jest.mock('../services/annual-prepay-renewals', () => ({
  deferredPrepayHoldCustomerIds: jest.fn(async () => new Set()), annualCoverageVerdictForPrediction: jest.fn(async () => null),
}));
// The real billing rules; the schedule's first-application verdict is watched (a visit here has no scheduled date, so the
// real verdict reads it as not covered).
jest.mock('../services/billing-lane', () => {
  const actual = jest.requireActual('../services/billing-lane');
  return { ...actual, siblingCoverageForSchedule: jest.fn(actual.siblingCoverageForSchedule) };
});
// The real module, one reader overridden: estimate-public (recurringServiceKey) reads other gates when it loads.
jest.mock('../config/feature-gates', () => ({ ...jest.requireActual('../config/feature-gates'), invoiceEstimateDiscountLinesLive: jest.fn(() => true) }));

const { acceptedVisitBreakdown, acceptedPricing } = require('../services/completion-pricing');
const AnnualPrepay = require('../services/annual-prepay-renewals');
const { siblingCoverageForSchedule } = require('../services/billing-lane');
const { invoiceEstimateDiscountLinesLive } = require('../config/feature-gates');
const { recurringServiceKey } = require('../routes/estimate-public');
const { tierSavingsLeftOffInvoices, _private: { engineTierRecord, pricingRecords } } = require('../services/invoice-tier-line-check');

const TODAY = '2026-06-15';

// A visit's billing facts (billingFacts' query): a customer with no lane, plan, Auto Pay or payer, and no invoice of the
// visit's own yet, so completion invoices the visit at its own price.
const selfPay = (extra = {}) => ({ autopay_active: false, payer_billed: false, is_callback: false, own_invoice: false,
  billing_mode: null, waveguard_tier: null, monthly_rate: null, per_application_fee: null, ...extra });
// A knex stand-in for the visit query (it returns `visits`) and the billing-facts query (it returns `facts`). The check
// reads nothing else itself.
function fakeDb(visits = [], facts = visits.map((row) => ({ id: row.id, ...selfPay() }))) {
  const chain = {};
  for (const m of ['join', 'leftJoin', 'where', 'whereNull', 'whereIn', 'whereRaw', 'orderBy']) chain[m] = jest.fn(() => chain);
  chain.select = jest.fn(async () => visits);
  const conn = jest.fn(() => chain);
  conn.raw = jest.fn(async () => ({ rows: facts }));
  return conn;
}

const waveguard = (amount, tier = 'gold') => ({ appliedDiscounts: [{ type: 'waveguard', tier, amount }] });
// $100 a visit, 4 visits, Gold 15%: $400 list, $340 net, $85 a visit.
const pestItem = (extra = {}) => ({ service: 'pest_control', perApp: 100, visitsPerYear: 4, annual: 400, annualBeforeDiscount: 400,
  annualAfterDiscount: 340, discount: waveguard(0.15), ...extra });
// $140 a visit, 9 visits, 20%: $1,260 list, $1,008 net, $112 a visit.
const lawnItem = (extra = {}) => ({ service: 'lawn_care', perApp: 140, visitsPerYear: 9, annual: 1260, annualBeforeDiscount: 1260,
  annualAfterDiscount: 1008, discount: waveguard(0.2), ...extra });
// A plan's one-time first-visit fee: no annual. It maps to the plan's key.
const firstVisitFee = { service: 'pest_initial_roach', price: 49, priceBeforeDiscount: 49, priceAfterDiscount: 49, discount: { appliedDiscounts: [] } };
const gold = { tier: 'Gold', waveGuardTier: 'Gold' };
const estimate = ({ lineItems = [pestItem()], tier = 'Gold', recurring = gold, data } = {}) => ({
  id: 'e1', waveguard_tier: tier, estimate_data: JSON.stringify(data || { engineResult: { lineItems }, result: { recurring } }) });
// The saved rows the mapper writes from those lines (v1-legacy-mapper.js svcAdd).
const pestRow = { service: 'pest_control', name: 'Pest Control', perTreatment: 100, visitsPerYear: 4, annualAfterDiscount: 340 };
const lawnRow = { service: 'lawn_care', name: 'Lawn Care', perTreatment: 140, visitsPerYear: 9, annualAfterDiscount: 1008 };
// The schedule line the invoice matched (admin-customers.js scheduleLinesFromEstimate), with its saved row.
const scheduleLine = (sourceLine = pestRow, extra = {}) => ({ source: 'recurring', cadence: 'quarterly', perApplicationPrice: 85,
  serviceKey: 'pest_control_quarterly', sourceLineKey: 'recurring:0', sourceLine, ...extra });
const visit = (extra = {}) => ({ id: 'v1', source_estimate_id: 'e1', service_type: 'Quarterly Pest Control Service', estimated_price: '85.00', ...extra });
const unnamed = (extra = {}) => ({ breakdown: null, reason: 'discount_unnamed', estimate: estimate(), line: scheduleLine(), ...extra });
const findingsFor = async (actual, row = visit()) => {
  acceptedVisitBreakdown.mockResolvedValue(actual);
  return (await tierSavingsLeftOffInvoices(fakeDb([row]), { today: TODAY })).findings;
};
const findingsOn = (records, extra = {}) => findingsFor(unnamed({ estimate: estimate(records), ...extra }));
const pricedWith = () => acceptedPricing.mock.calls.map(([, context]) => context.estimateTier);

beforeEach(() => {
  jest.clearAllMocks();
  invoiceEstimateDiscountLinesLive.mockReturnValue(true);
  AnnualPrepay.annualCoverageVerdictForPrediction.mockResolvedValue(null);
});

describe('tierSavingsLeftOffInvoices', () => {
  test('a saving the invoice leaves unnamed, which its own pricing names with the engine\'s tier and rate, is a finding', async () => {
    const conn = fakeDb([visit()]);
    acceptedVisitBreakdown.mockResolvedValue(unnamed());
    expect(await tierSavingsLeftOffInvoices(conn, { today: TODAY })).toEqual({
      checked: 1, notJudged: 0, findings: [{ visitId: 'v1', estimateId: 'e1', serviceKey: 'pest_control', lineKey: 'recurring:0', tier: 'gold' }],
    });
    expect(acceptedVisitBreakdown.mock.calls).toEqual([[visit(), { database: conn }]]);
    // The invoice's own discount context (estimateDiscountContext), with only its tier reading replaced.
    // The context carries the engine's lines too, which the invoice reads for a row that saved only its net.
    expect(acceptedPricing.mock.calls).toEqual([[scheduleLine(), { manualName: null, tierDiscounted: true, estimateTier: { tier: 'gold', amount: 0.15 },
      engineLineItems: [pestItem()] }]]);
    jest.clearAllMocks();
    expect(await findingsOn({ tier: null, recurring: {} })).toHaveLength(1);
    expect(acceptedPricing.mock.calls[0][1]).toEqual({ manualName: null, tierDiscounted: false, estimateTier: { tier: 'gold', amount: 0.15 },
      engineLineItems: [pestItem()] });
  });

  // The invoice's own row rules keep one line on purpose; given the engine's tier and rate, its pricing still does.
  test('a row the invoice keeps on one line by its own rules is not a finding, even with the engine\'s tier and rate', async () => {
    const keeps = [
      { ...pestRow, serviceSpecificDiscounts: [{ amount: 5 }] }, // a service credit shares the saving
      { ...pestRow, manualFinalAnnual: 339.96 }, // staff moved the row's own price
      { ...pestRow, excludeFromPctDiscount: true }, // the row is out of percentage discounts
      { ...pestRow, discount: { effectiveDiscount: 0.1 } }, // the row recorded another rate
      { ...pestRow, priceAfterDiscount: 84.99 }, // the row's own net is not the billed net
      { ...pestRow, annualAfterDiscount: 352 }, // the row's saved annual is not the tier's
    ];
    for (const row of keeps) expect(await findingsFor(unnamed({ line: scheduleLine(row) }))).toEqual([]);
    expect(acceptedPricing).toHaveBeenCalledTimes(keeps.length);
    expect(await findingsFor(unnamed())).toHaveLength(1);
  });

  // completion-pricing.js estimateDiscountContext and savedEstimateTier name no tier for these estimates on purpose.
  test('an estimate the invoice names no tier for by design is not a finding: staff discount on recurring work, nested block', async () => {
    const withData = (extra, recurring = gold) => findingsOn({ data: { engineResult: { lineItems: [pestItem()] }, result: { recurring }, ...extra } });
    expect(await withData({ summary: { manualDiscount: { amount: 5, recurringAmount: 5, label: 'Courtesy' } } })).toEqual([]);
    expect(await withData({}, { ...gold, manualDiscount: { amount: 5 } })).toEqual([]);
    expect(await withData({ engineResult: { lineItems: [pestItem()], summary: { manualDiscount: { amount: 5 } } } })).toEqual([]);
    expect(await withData({}, { ...gold, results: undefined })).toHaveLength(1);
    const nested = { result: { recurring: gold, results: { recurring: { services: [{ service: 'pest_control' }] } } } };
    expect(await findingsOn({ data: { ...nested, engineResult: { lineItems: [pestItem()] } } })).toEqual([]);
    expect(acceptedPricing).toHaveBeenCalledTimes(1);
    // A staff discount saved as one-time only does not reach recurring work.
    expect(await withData({ summary: { manualDiscount: { amount: 5, recurringAmount: 0, label: 'Courtesy' } } })).toHaveLength(1);
  });

  // Pre-push audit P1s (rounds 6 to 9, and 11): a row whose own tier record names no tier prints a bare "WaveGuard" line. The
  // check judges the row the invoice prints (breakdown.discounts) in the place of the tier row of its own pricing (the
  // row that carries the rate). Judging a name needs no rate and no staff rule.
  test('a printed breakdown of a line with a tier share must name the tier the records agree on; a bare label is a finding', async () => {
    const real = jest.requireActual('../services/completion-pricing');
    const tierless = { ...pestRow, discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.15 }] } };
    // The breakdown the decision prints for the line: its own pricing's rows, every one named (acceptedVisitBreakdown).
    const printed = (row, extra = {}, est = estimate({ recurring: { ...gold, discount: 0.15 } })) => {
      const line = scheduleLine(row, extra);
      const quote = real.acceptedPricing(line, real.estimateDiscountContext(est));
      if (!quote.discounts.every((d) => d.named)) throw new Error('the invoice prints no breakdown for this line');
      return { breakdown: { base: quote.base, amount: quote.amount, discounts: quote.discounts.map(({ name, dollars }) => ({ name, dollars })) },
        estimate: est, line };
    };
    const names = (actual) => actual.breakdown.discounts.map((d) => d.name);
    const finding = [{ visitId: 'v1', estimateId: 'e1', serviceKey: 'pest_control', lineKey: 'recurring:0', tier: 'gold' }];
    expect(names(printed(pestRow))).toEqual(['WaveGuard Gold']);
    expect(await findingsFor(printed(pestRow))).toEqual([]);
    expect(names(printed(tierless))).toEqual(['WaveGuard']);
    expect(await findingsFor(printed(tierless))).toEqual(finding);
    // The rows the invoice prints are what is judged: a tier line left out or renamed is a finding (round 8).
    const withRows = (discounts) => ({ ...printed(pestRow), breakdown: { ...printed(pestRow).breakdown, discounts } });
    expect(await findingsFor(withRows([]))).toEqual(finding);
    // A fault in the invoice's own label code that drops the tier prints this row. The check's names are its own (round
    // 11), so it is still a finding.
    expect(await findingsFor(withRows([{ name: 'WaveGuard', dollars: 15 }]))).toEqual(finding);
    expect(await findingsFor(withRows([{ name: 'WaveGuard Silver', dollars: 15 }]))).toEqual(finding);
    expect(await findingsFor(withRows([{ name: 'WaveGuard Gold', dollars: 14 }]))).toEqual(finding);
    // Records that name another tier, or no tier at all, name none: no finding. The matched row's own record counts.
    expect(await findingsFor(printed(tierless, {}, estimate({ tier: 'Silver' })))).toEqual([]);
    const tierlessEngine = [pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.15 }] } })];
    expect(await findingsFor(printed(tierless, {}, estimate({ tier: null, recurring: {}, lineItems: tierlessEngine })))).toEqual([]);
    const silverRow = printed({ ...pestRow, discount: waveguard(0.15, 'silver') });
    expect(names(silverRow)).toEqual(['WaveGuard Silver']);
    expect(await findingsFor(silverRow)).toEqual([]);
    // A staff discount beside the tier line changes nothing (round 7).
    const staff = (label) => estimate({ data: { engineResult: { lineItems: [pestItem()] }, result: { recurring: gold },
      summary: { manualDiscount: { amount: 5, recurringAmount: 5, label } } } });
    const bareWithStaff = printed(tierless, { perApplicationPrice: 80 }, staff('Military Discount'));
    expect(names(bareWithStaff)).toEqual(['WaveGuard', 'Military Discount']);
    expect(await findingsFor(bareWithStaff)).toEqual(finding);
    const namedWithStaff = printed(pestItem(), { perApplicationPrice: 80 }, staff('Military Discount'));
    expect(names(namedWithStaff)).toEqual(['WaveGuard Gold', 'Military Discount']);
    expect(await findingsFor(namedWithStaff)).toEqual([]);
    // The tier row's own label is judged, not any row's (round 9): a staff row named "WaveGuard Gold" beside a bare tier
    // row is a finding, even at the same dollars.
    const goldStaffLabel = printed(tierless, { perApplicationPrice: 70 }, staff('WaveGuard Gold'));
    expect(goldStaffLabel.breakdown.discounts).toEqual([{ name: 'WaveGuard', dollars: 15 }, { name: 'WaveGuard Gold', dollars: 15 }]);
    expect(await findingsFor(goldStaffLabel)).toEqual(finding);
    // A staff label that starts with "WaveGuard" is not a tier share: the line is asked the unnamed-saving question.
    const loyalty = printed({ ...pestRow, discount: { appliedDiscounts: [] } }, {}, staff('WaveGuard Loyalty'));
    expect(names(loyalty)).toEqual(['WaveGuard Loyalty']);
    expect(await findingsFor(loyalty)).toEqual([]);
    // An estimate with no engine lines and no saved rate still names its tier (round 7).
    expect(await findingsFor(printed(tierless, {}, estimate({ data: { result: { recurring: { ...gold, services: [tierless] } } } })))).toEqual(finding);
    // The legacy nested block's tier counts too: another tier there names none.
    const nested = (tier) => estimate({ data: { engineResult: { lineItems: [pestItem()] },
      result: { recurring: gold, results: { recurring: { tier, services: [pestRow] } } } } });
    expect(await findingsFor(printed(tierless, {}, nested('Silver')))).toEqual([]);
    expect(await findingsFor(printed(tierless, {}, nested('Gold')))).toEqual(finding);
  });

  // Pre-push audit P1 (rounds 10 and 11): an engine result saved whole keeps a rated line's net only as `annual`, so the
  // reader gives the line no per-visit price and the invoice cannot price it (reason no_breakdown). The engine's own
  // record of the line holds the net: priced by the reader's own derivation, it must be the visit's price.
  test('a line the reader could not price is read from the engine\'s own record, at the visit\'s price', async () => {
    // The row the reader keeps from the engine line (estimate-public.js recurringServicesWithSupplements): the list price
    // a visit, the net only as `annual`, and the engine's own discount record.
    const rawRow = { service: 'pest_control', name: 'Pest Control', mo: 28.33, monthly: 28.33, annual: 340, perTreatment: 100,
      visitsPerYear: 4, discount: waveguard(0.15) };
    const whole = (lineItems = [pestItem()]) => estimate({ data: { result: { lineItems, recurring: gold } } });
    const unpriced = (extra = {}) => ({ breakdown: null, reason: 'no_breakdown', estimate: whole(),
      line: scheduleLine(rawRow, { perApplicationPrice: null }), ...extra });
    const finding = [{ visitId: 'v1', estimateId: 'e1', serviceKey: 'pest_control', lineKey: 'recurring:0', tier: 'gold' }];
    expect(await findingsFor(unpriced())).toEqual(finding);
    // Priced at the engine's own net a visit ($340 / 4), in the invoice's own context with the engine's tier and rate.
    expect(acceptedPricing.mock.calls).toEqual([[scheduleLine(rawRow, { perApplicationPrice: 85 }),
      expect.objectContaining({ estimateTier: { tier: 'gold', amount: 0.15 } })]]);
    // A visit whose price moved off the engine's net keeps one line by design.
    expect(await findingsFor(unpriced(), visit({ estimated_price: '84.99' }))).toEqual([]);
    // A line the reader priced is not repriced: its own price is above its list, so the invoice keeps one line.
    expect(await findingsFor(unpriced({ line: scheduleLine(rawRow, { perApplicationPrice: 110 }) }))).toEqual([]);
    // With no engine record of the line, nothing proves the net: no engine lines, or two of the service.
    expect(await findingsFor(unpriced({ estimate: estimate({ data: { result: { recurring: { ...gold, discount: 0.15, services: [rawRow] } } } }) })))
      .toEqual([]);
    expect(await findingsFor(unpriced({ estimate: whole([pestItem(), pestItem({ perApp: 120 })]) }))).toEqual([]);
    // The engine's record must name the tier as its only discount, and the estimate's records must agree with it.
    expect(await findingsFor(unpriced({ estimate: whole([pestItem({ discount: { appliedDiscounts: [] } })]) }))).toEqual([]);
    expect(await findingsFor(unpriced({ estimate: { ...whole(), waveguard_tier: 'Silver' } }))).toEqual([]);
    // An engine record that names no tier (round 12): the invoice's pricing at the engine's net prints a bare "WaveGuard"
    // tier row, at the tier's rate. The estimate's other records name Gold, so the visit is a finding.
    const tierless = { appliedDiscounts: [{ type: 'waveguard', amount: 0.15 }] };
    const bare = unpriced({ estimate: whole([pestItem({ discount: tierless })]),
      line: scheduleLine({ ...rawRow, discount: tierless }, { perApplicationPrice: null }) });
    expect(await findingsFor(bare)).toEqual(finding);
    // A row whose own record names another tier disputes the estimate's records: no finding.
    expect(await findingsFor(unpriced({ line: scheduleLine({ ...rawRow, discount: waveguard(0.15, 'silver') }, { perApplicationPrice: null }) })))
      .toEqual([]);
    // A row whose own record claims another rate for the tier disputes the engine's record (round 13): the invoice's
    // pricing takes the row's 20% Gold and caps it at the $15 saving, but the engine priced Gold at 15%. No finding.
    const twenty = scheduleLine({ ...rawRow, discount: waveguard(0.2) }, { perApplicationPrice: 85 });
    expect(jest.requireActual('../services/completion-pricing').acceptedPricing(twenty, {}).discounts)
      .toEqual([{ name: 'WaveGuard Gold', percent: 20, dollars: 15, named: true }]);
    expect(await findingsFor(unpriced({ line: { ...twenty, perApplicationPrice: null } }))).toEqual([]);
  });

  // Pre-push audit P1: a lawn row that saved only its net shows no saving to the invoice unless its tier reading recovers
  // the engine's list price. When that reading misses (here the estimate's column and block name no tier), the engine's
  // record is the witness, and the invoice's own pricing of the line with that tier names it: a finding.
  test('a net-only row the invoice prints as one line, whose engine record names the tier, is a finding', async () => {
    const netOnly = { service: 'lawn_care', name: 'Lawn Care', perTreatment: 112, annual: 1008, annualAfterDiscount: 1008, visitsPerYear: 9,
      discount: { effectiveDiscount: 0.2, appliedDiscountPercent: 0.2 } };
    const lawnLine = scheduleLine(netOnly, { serviceKey: 'lawn_care', cadence: 'every_6_weeks', perApplicationPrice: 112 });
    const missed = (lineItems) => ({ breakdown: null, reason: 'no_discount', estimate: estimate({ lineItems, tier: null, recurring: {} }), line: lawnLine });
    const lawnVisit = visit({ service_type: 'Lawn Care', estimated_price: '112.00' });
    expect(await findingsFor(missed([lawnItem()]), lawnVisit)).toEqual([
      { visitId: 'v1', estimateId: 'e1', serviceKey: 'lawn_care', lineKey: 'recurring:0', tier: 'gold' }]);
    // The engine's figures disagree with the row's (another net annual): the line keeps one line by design.
    expect(await findingsFor(missed([lawnItem({ annualAfterDiscount: 1007.91 })]), lawnVisit)).toEqual([]);
  });

  test.each(['no_discount', 'price_changed', 'not_priced', 'own_price_or_discount', 'prepaid', 'line_unmatched', 'line_ambiguous'])(
    'a visit that keeps one line for %s is not read', async (reason) => {
      expect(await findingsFor({ breakdown: null, reason })).toEqual([]);
      expect(acceptedPricing).not.toHaveBeenCalled();
    },
  );

  // Pre-push audit P1 (twice): the invoice matches a visit to its line by service id or key; the visit's label is
  // display text, and a row saved without a service field takes the key the schedule matched it to.
  test('the saved row the invoice matched names the service, else the key it was matched to', async () => {
    const both = estimate({ lineItems: [pestItem(), lawnItem()] });
    const keyFor = async (actual, row = visit()) => (await findingsFor(actual, row)).map((f) => f.serviceKey);
    expect(await keyFor(unnamed({ estimate: both }), visit({ service_type: 'Home Protection Plan' }))).toEqual(['pest_control']);
    expect(await keyFor(unnamed({ estimate: both }), visit({ service_type: 'Lawn Care' }))).toEqual(['pest_control']);
    expect(await keyFor(unnamed({ estimate: both, line: scheduleLine(lawnRow, { serviceKey: 'lawn_care', perApplicationPrice: 112 }) })))
      .toEqual(['lawn_care']);
    const plan = { serviceKey: 'pest_control', name: 'Home Protection Plan', perTreatment: 100, visitsPerYear: 4, annualAfterDiscount: 340 };
    expect(recurringServiceKey(plan)).toBe('home_protection_plan');
    expect(await keyFor(unnamed({ line: scheduleLine(plan) }))).toEqual(['pest_control']);
    expect(await keyFor(unnamed({ line: scheduleLine(plan, { serviceKey: null }) }))).toEqual([]);
    expect(await keyFor(unnamed({ line: null }))).toEqual([]);
  });

  // Pre-push audit P1: a plan's one-time first-visit fee maps to the plan's key; only recurring lines are read.
  test('a one-time engine line with the plan\'s key does not hide the plan\'s line', async () => {
    expect(recurringServiceKey(firstVisitFee)).toBe('pest_control');
    expect(await findingsOn({ lineItems: [pestItem(), firstVisitFee] })).toHaveLength(1);
    expect(await findingsOn({ lineItems: [pestItem(), pestItem({ perApp: 120 })] })).toEqual([]);
  });

  // Pre-push audit P1: the engine lines come from the saved result the estimate's lines come from.
  test('the engine lines are the ones of the result the estimate\'s lines come from', async () => {
    expect(await findingsOn({ data: { result: { lineItems: [pestItem()], recurring: gold } } })).toHaveLength(1);
    // Its own lines win over an older engine result kept beside it (Silver there, which the Gold column disputes).
    const older = { lineItems: [pestItem({ discount: waveguard(0.1, 'silver'), annualAfterDiscount: 360 })] };
    expect(await findingsOn({ data: { result: { lineItems: [pestItem()], recurring: gold }, engineResult: older } })).toHaveLength(1);
    expect(await findingsOn({ data: { result: { recurring: gold }, engineResult: older } })).toEqual([]);
  });

  test('the engine line must hold the tier as its only discount, at one rate', async () => {
    const cases = [
      [pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.15 }, { type: 'manual', amount: 0.05 }] } })],
      [pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.1 }, { type: 'waveguard', amount: 0.15 }] } })],
      [pestItem({ discount: waveguard(1.5) })],
      [pestItem({ discount: { appliedDiscounts: [] } })],
      [pestItem({ discount: {} })],
      [lawnItem()],
      [],
    ];
    for (const lineItems of cases) expect(await findingsOn({ lineItems })).toEqual([]);
    expect(await findingsFor(unnamed({ estimate: null }))).toEqual([]);
    expect(acceptedPricing).not.toHaveBeenCalled();
  });

  // Pre-push audit P1: an empty tier column does not hide the engine's tier; records that disagree name no saving.
  test('the tier comes from the estimate\'s records: the engine\'s, the column and the saved block must not disagree', async () => {
    const tierFor = async (records) => (await findingsOn(records)).map((f) => f.tier);
    expect(await tierFor({ tier: null })).toEqual(['gold']);
    expect(await tierFor({ tier: null, recurring: {} })).toEqual(['gold']);
    expect(await tierFor({ lineItems: [pestItem({ discount: { appliedDiscounts: [{ type: 'waveguard', amount: 0.15 }] } })] })).toEqual(['gold']);
    expect(await tierFor({ tier: 'Silver' })).toEqual([]);
    expect(await tierFor({ tier: null, recurring: { tier: 'Silver' } })).toEqual([]);
    expect(await tierFor({ tier: 'Bronze', recurring: { tier: 'Bronze' }, lineItems: [pestItem({ discount: waveguard(0.15, 'bronze') })] })).toEqual([]);
  });

  // Pre-push audit P1 (round 5): the admin estimate tool saves the mapped result only (EstimateToolViewV2.jsx: inputs,
  // result, summary, the tier column), with no engine line items. The witness is then the tier and rate it saved.
  test('an estimate saved with no engine lines is read with the tier and the rate it saved', async () => {
    const admin = (recurring, extra = {}, tier = 'Gold') => findingsOn({ tier, data: { inputs: {},
      result: { recurring: { services: [pestRow], ...recurring } }, summary: { manualDiscount: null, serviceSpecificDiscounts: [] }, ...extra } });
    expect(await admin({ ...gold, discount: 0.15 })).toEqual([{ visitId: 'v1', estimateId: 'e1', serviceKey: 'pest_control', lineKey: 'recurring:0', tier: 'gold' }]);
    expect(pricedWith()).toEqual([{ tier: 'gold', amount: 0.15 }]);
    expect(await admin(gold, { sendSnapshot: { tierDiscounts: { Gold: 0.15 } } })).toHaveLength(1);
    expect(await admin({ waveGuardTier: 'Gold', discount: 0.15 }, {}, null)).toHaveLength(1);
    // No saved rate, a saved 0, or a rate that did not price the row: nothing proves the saving. With no rate the
    // invoice's pricing is not asked.
    jest.clearAllMocks();
    expect(await admin(gold)).toEqual([]);
    expect(acceptedPricing).not.toHaveBeenCalled();
    expect(await admin({ ...gold, discount: 0 })).toEqual([]);
    expect(await admin({ ...gold, discount: 0.1 })).toEqual([]);
    // Records that disagree, no tier named, a staff discount on recurring work.
    expect(await admin({ tier: 'Silver', discount: 0.15 })).toEqual([]);
    expect(await admin({ discount: 0.15 }, {}, null)).toEqual([]);
    expect(await admin({ ...gold, discount: 0.15 }, { summary: { manualDiscount: { amount: 5, recurringAmount: 5, label: 'Courtesy' } } })).toEqual([]);
    // An estimate that saved engine lines, none of them this service's, has no witness.
    expect(await findingsOn({ lineItems: [lawnItem()], recurring: { ...gold, discount: 0.15 } })).toEqual([]);
  });

  // Pre-push audit P1: a saved 0 is a rate, and the invoice reads the send snapshot first.
  test('the rate the estimate saved for its tier, as the invoice reads it, must be the engine line\'s rate', async () => {
    const withData = (extra, recurring = gold) => findingsOn({ data: { engineResult: { lineItems: [pestItem()] }, result: { recurring }, ...extra } });
    const snapshot = (tierDiscounts) => ({ sendSnapshot: { tierDiscounts } });
    expect(await withData({}, { ...gold, discount: 0.15 })).toHaveLength(1);
    expect(await withData({}, { ...gold, discount: 0.1 })).toEqual([]);
    expect(await withData({}, { ...gold, discount: 0 })).toEqual([]);
    expect(await withData(snapshot({ Gold: 0.15 }))).toHaveLength(1);
    expect(await withData(snapshot({ Gold: 0.1 }))).toEqual([]);
    expect(await withData(snapshot({ Gold: 0 }))).toEqual([]);
    expect(await withData(snapshot({ gold: 0 }))).toEqual([]);
    // The snapshot wins over the block's rate; a block that names no tier saved no rate for it.
    expect(await withData(snapshot({ Gold: 0.15 }), { ...gold, discount: 0 })).toHaveLength(1);
    expect(await withData(snapshot({ Gold: 0 }), { ...gold, discount: 0.15 })).toEqual([]);
    expect(await withData({}, { discount: 0.1 })).toHaveLength(1);
    // The invoice's pricing gets the engine line's own rate, and that rate must price the row.
    jest.clearAllMocks();
    expect(await findingsOn({ lineItems: [pestItem({ discount: waveguard(0.1) })] })).toEqual([]);
    expect(pricedWith()).toEqual([{ tier: 'gold', amount: 0.1 }]);
  });

  test('gate off: every invoice keeps one line by design, so no visit is read', async () => {
    invoiceEstimateDiscountLinesLive.mockReturnValue(false);
    const conn = fakeDb([visit()]);
    expect(await tierSavingsLeftOffInvoices(conn, { today: TODAY })).toEqual({ checked: 0, notJudged: 0, findings: [] });
    expect(conn).not.toHaveBeenCalled();
    expect(acceptedVisitBreakdown).not.toHaveBeenCalled();
  });

  test('a visit the invoice decision cannot read fails the run: a check that did not run proves nothing', async () => {
    acceptedVisitBreakdown.mockRejectedValue(new Error('read failed'));
    await expect(tierSavingsLeftOffInvoices(fakeDb([visit()]), { today: TODAY })).rejects.toThrow('read failed');
    acceptedVisitBreakdown.mockReset();
    acceptedVisitBreakdown.mockResolvedValueOnce(unnamed()).mockRejectedValueOnce(new Error('second read failed'));
    await expect(tierSavingsLeftOffInvoices(fakeDb([visit(), visit({ id: 'v2' })]), { today: TODAY })).rejects.toThrow('second read failed');
  });

  test('only a new bill of the visit at its own price is judged: what completion bills, by the shared prediction', async () => {
    const judged = async (facts, row = visit()) => {
      jest.clearAllMocks();
      acceptedVisitBreakdown.mockResolvedValue(unnamed());
      const result = await tierSavingsLeftOffInvoices(fakeDb([row], [{ id: row.id, ...selfPay(facts) }]), { today: TODAY });
      return { checked: result.checked, notJudged: result.notJudged, read: acceptedVisitBreakdown.mock.calls.length, findings: result.findings.length };
    };
    const yes = { checked: 1, notJudged: 0, read: 1, findings: 1 };
    const no = { checked: 0, notJudged: 1, read: 0, findings: 0 };
    expect(await judged({})).toEqual(yes);
    // A per-application plan on Auto Pay is charged the visit's own price.
    const perApp = { billing_mode: 'per_application', waveguard_tier: 'Gold', autopay_active: true };
    expect(await judged(perApp, visit({ is_recurring: true }))).toEqual(yes);
    // Dues cover a member's plan visit: on Auto Pay, and without it (the month's dues count as paid). A member's
    // one-off priced visit still bills its own price.
    const member = { billing_mode: 'monthly_membership', waveguard_tier: 'Gold', monthly_rate: '49.00' };
    expect(await judged({ ...member, autopay_active: true }, visit({ is_recurring: true }))).toEqual(no);
    expect(await judged(member, visit({ is_recurring: true }))).toEqual(no);
    expect(await judged({ ...member, autopay_active: true }, visit({ is_recurring: false }))).toEqual(yes);
    // A payer's invoice, a callback of a per-application plan, a prepaid visit, an invoice made already: not judged.
    expect(await judged({ payer_billed: true })).toEqual(no);
    expect(await judged({ ...perApp, is_callback: true })).toEqual(no);
    expect(await judged({}, visit({ prepaid_amount: '85.00', prepaid_method: 'cash' }))).toEqual(no);
    expect(await judged({ own_invoice: true })).toEqual(no);
    // A bill at another amount than the visit's own price prints one net line by design (part of it prepaid).
    expect(await judged({}, visit({ prepaid_amount: '20.00', prepaid_method: 'cash' }))).toEqual(no);
    // An annual prepay: a stamped visit of the annual lane (no verdict: the stamp stands), and a covering verdict in any
    // lane, a stamped visit of a per-application plan too. A verdict that it does not cover leaves the bill judged.
    const stamped = visit({ prepaid_method: 'annual_prepay_invoice' });
    expect(await judged({ billing_mode: 'annual_prepay' }, stamped)).toEqual(no);
    AnnualPrepay.annualCoverageVerdictForPrediction.mockResolvedValue(true);
    expect(await judged(perApp, stamped)).toEqual(no);
    expect(await judged({})).toEqual(no);
    AnnualPrepay.annualCoverageVerdictForPrediction.mockResolvedValue(false);
    expect(await judged({ billing_mode: 'annual_prepay' }, stamped)).toEqual(yes);
    // An invoice made for another visit: the estimate's combined first-application invoice, by the schedule's own
    // verdict, to collect or settled; a visit held for review is not a new bill either.
    for (const state of ['collect_on_combined_invoice', 'settled', 'review']) {
      siblingCoverageForSchedule.mockResolvedValueOnce({ coverage: { state, reason: state === 'review' ? 'terminal_invoice' : null } });
      expect(await judged({})).toEqual(no);
    }
    expect(siblingCoverageForSchedule.mock.calls[0][0]).toEqual({ svc: visit(), dbConn: expect.any(Function) });
    // Asked only of a visit that completion would bill: a covered member's visit never reaches it.
    jest.clearAllMocks();
    await judged({ ...member, autopay_active: true }, visit({ is_recurring: true }));
    expect(siblingCoverageForSchedule).not.toHaveBeenCalled();
    // A lookup that failed fails the run: a check that did not run proves nothing.
    jest.clearAllMocks();
    siblingCoverageForSchedule.mockResolvedValueOnce({ coverage: { state: 'review', reason: 'lookup_failed' } });
    await expect(tierSavingsLeftOffInvoices(fakeDb([visit()]), { today: TODAY })).rejects.toThrow('first-application invoice lookup failed for visit v1');
    // A visit with no facts row (deleted after the visit query) has nothing to judge.
    jest.clearAllMocks();
    AnnualPrepay.annualCoverageVerdictForPrediction.mockResolvedValue(null);
    expect(await tierSavingsLeftOffInvoices(fakeDb([visit()], []), { today: TODAY })).toEqual({ checked: 0, notJudged: 1, findings: [] });
  });

  test('the billing facts: one query for all visits, Auto Pay on the Eastern day; the annual verdict as a prediction reads it', async () => {
    const rows = [visit({ customer_id: 'c1' }), visit({ id: 'v2', customer_id: 'c2' })];
    const conn = fakeDb(rows);
    acceptedVisitBreakdown.mockResolvedValue(unnamed());
    const deferred = new Set(['c2']);
    AnnualPrepay.deferredPrepayHoldCustomerIds.mockResolvedValue(deferred);
    expect((await tierSavingsLeftOffInvoices(conn, { today: TODAY })).checked).toBe(2);
    expect(conn.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = conn.raw.mock.calls[0];
    // Its own invoices only, linked by the visit or its service record; the first-application stamp is the schedule
    // verdict's to read (billing-rule-home-ratchet).
    expect(sql).toContain('COALESCE(i.scheduled_service_id, sr2.scheduled_service_id) = ss.id');
    expect(sql).not.toContain('first_application_invoice_id');
    expect(sql).toContain('JOIN customers c ON c.id = ss.customer_id');
    // A refunded invoice of its own still holds the visit; only a void or canceled one bills nothing.
    expect(bindings).toEqual([TODAY, ['void', 'canceled', 'cancelled'], ['v1', 'v2']]);
    expect(AnnualPrepay.deferredPrepayHoldCustomerIds).toHaveBeenCalledWith(conn, ['c1', 'c2']);
    expect(AnnualPrepay.annualCoverageVerdictForPrediction.mock.calls).toEqual([
      [rows[0], conn, { deferredCustomerIds: deferred }], [rows[1], conn, { deferredCustomerIds: deferred }]]);
    // Auto Pay is read on the Eastern day of `today`, in daylight and in standard time.
    jest.clearAllMocks();
    const winter = fakeDb([visit()]);
    await tierSavingsLeftOffInvoices(winter, { today: '2026-01-15' });
    expect(winter.raw.mock.calls[0][1][0]).toBe('2026-01-15');
  });

  test('the visit query reads today through 90 days ahead by default', async () => {
    const conn = fakeDb();
    await tierSavingsLeftOffInvoices(conn, { today: TODAY });
    const chain = conn.mock.results[0].value;
    expect(conn).toHaveBeenCalledWith('scheduled_services as s');
    expect(chain.whereRaw).toHaveBeenCalledWith('s.scheduled_date >= ?::date AND s.scheduled_date < ?::date + ?::int', [TODAY, TODAY, 90]);
  });
});

describe('pricingRecords', () => {
  test('the result the lines come from, its block, and its own engine lines, else the engine result beside it', () => {
    const own = pestItem(); const beside = lawnItem();
    expect(pricingRecords({ result: { recurring: gold, lineItems: [own] }, engineResult: { lineItems: [beside] } }))
      .toEqual({ block: gold, lineItems: [own] });
    expect(pricingRecords({ result: { recurring: gold }, engineResult: { lineItems: [beside] } })).toEqual({ block: gold, lineItems: [beside] });
    expect(pricingRecords({ engineResult: { recurring: gold, lineItems: [beside] } })).toEqual({ block: gold, lineItems: [beside] });
    expect(pricingRecords({})).toEqual({ block: {}, lineItems: [] });
  });
});

describe('engineTierRecord', () => {
  test('the tier and rate of the one recurring engine line of the service', () => {
    expect(engineTierRecord([pestItem(), firstVisitFee], 'pest_control')).toEqual({ rate: 0.15, tier: 'gold' });
    expect(engineTierRecord([lawnItem({ discount: waveguard(0.2, 'platinum') })], 'lawn_care')).toEqual({ rate: 0.2, tier: 'platinum' });
    const shrub = { service: 'tree_shrub', visitsPerYear: 6, annualBeforeDiscount: 600, annualAfterDiscount: 540, discount: waveguard(0.1, 'silver') };
    expect(engineTierRecord([shrub], 'tree_shrub')).toEqual({ rate: 0.1, tier: 'silver' });
  });

  test('no recurring line of the service, or two of them, name no record', () => {
    expect(engineTierRecord([firstVisitFee], 'pest_control')).toBeNull();
    expect(engineTierRecord([pestItem(), pestItem({ perApp: 120 })], 'pest_control')).toBeNull();
    expect(engineTierRecord([pestItem({ annual: undefined, annualBeforeDiscount: undefined, annualAfterDiscount: undefined })], 'pest_control')).toBeNull();
    expect(engineTierRecord([], 'pest_control')).toBeNull();
  });
});
