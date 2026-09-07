jest.mock('../models/db', () => Object.assign(jest.fn(), { transaction: jest.fn() }));
jest.mock('../services/pricing-engine', () => ({ ...jest.requireActual('../services/pricing-engine'), needsSync: () => false, syncConstantsFromDB: jest.fn(async () => {}) }));
jest.mock('../services/admin-estimate-persistence', () => ({
  estimateExpiresAt: now => new Date(now().getTime() + 14 * 86400000),
}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn().mockResolvedValue(1) }));
jest.mock('../routes/admin-estimates', () => ({
  _internals: { assertAutoSendPricingAuthority: jest.fn(), assertEstimateSendable: jest.fn() },
  buildEstimateSendSnapshot: jest.fn(),
}));

const db = require('../models/db');
const delivery = require('../routes/admin-estimates');
const { recordAuditEvent } = require('../services/audit-log');
const { publishWebsiteQuote } = require('../services/website-quote-publication');

let rows;
let locks;
let args;
let snapshot;

// Models query predicates and rollback for unit coverage. This does not claim
// to verify PostgreSQL columns, locking, or transaction behavior.
function query(table) {
  const filters = [];
  const matching = () => (rows[table] || []).filter(row => filters.every(test => test(row)));
  const builder = {
    select() { return builder; },
    where(values, value) { if (typeof values === 'string') values = { [values]: value }; filters.push(row => Object.entries(values).every(([key, value]) => row[key] === value)); return builder; },
    whereNull(key) { filters.push(row => row[key] == null); return builder; },
    whereNotIn(key, values) { filters.push(row => row[key] != null && !values.includes(row[key])); return builder; },
    forUpdate() { locks.push(table); return builder; },
    async first() { return matching()[0]; },
    async update(patch) { const found = matching(); found.forEach(row => Object.assign(row, patch)); return found.length; },
  };
  return builder;
}

beforeEach(() => {
  jest.clearAllMocks();
  locks = [];
  const engineInput = { property: { homeSqFt: 2000 }, services: { pest: { frequency: 'quarterly' } } };
  args = {
    estimateId: 'estimate-fixture', leadId: 'lead-fixture', engineInput,
    engineResult: { lineItems: [{ service: 'pest_control', pricingConfidence: 'high' }] },
    totals: { monthly_total: 33, annual_total: 396, onetime_total: 0 },
  };
  rows = {
    estimates: [{
      id: args.estimateId, customer_id: 'customer-fixture', source: 'quote_wizard', status: 'draft',
      pricing_authority: 'SERVER', ...args.totals,
      estimate_data: { lead_id: args.leadId, engineInput, setupFeeQuote: { kind: 'waveguard_membership', amount: 99 } },
    }],
    customers: [{ id: 'customer-fixture', active: true, pipeline_stage: 'new_lead', waveguard_tier: null, monthly_rate: 0 }],
  };
  snapshot = {
    ...rows.estimates[0].estimate_data,
    sendSnapshot: { pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 33, annual: 396 }], anchorOneTimePrice: 149, setupFee: { amount: 99 } } },
  };
  delivery.buildEstimateSendSnapshot.mockImplementation(async () => structuredClone(snapshot));
  delivery._internals.assertEstimateSendable.mockImplementation(() => {});
  recordAuditEvent.mockResolvedValue(1);
  db.mockImplementation(query);
  db.transaction.mockImplementation(async work => {
    const previous = structuredClone(rows);
    try { return await work(query); } catch (error) { rows = previous; throw error; }
  });
});

test('publishes the current verified quote once, freezing the canonical snapshot', async () => {
  const result = await publishWebsiteQuote(args);
  expect(result.token).toMatch(/^[a-f0-9]{32}$/);
  expect(rows.estimates[0]).toMatchObject({ status: 'sent', token: result.token });
  expect(JSON.parse(rows.estimates[0].estimate_data).sendSnapshot).toEqual(snapshot.sendSnapshot);
  expect(JSON.parse(rows.estimates[0].estimate_data).noEngagementAutomation).toBe(true);
  expect(locks).toEqual(['estimates', 'customers']);
  expect(delivery._internals.assertEstimateSendable).toHaveBeenCalledTimes(1);
  expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'website_quote_published', critical: true, trx: query }));
  expect(await publishWebsiteQuote(args)).toBeNull();
});

test.each([
  ['source', 'staff'], ['status', 'accepted'], ['status', 'scheduled'],
  ['archived_at', new Date()], ['price_locked_at', new Date()], ['pricing_authority', 'CLIENT_FALLBACK'],
])('does not publish a changed %s', async (key, value) => {
  rows.estimates[0][key] = value;
  expect(await publishWebsiteQuote(args)).toBeNull();
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

test.each(['active_customer', 'won', 'at_risk', 'churned', 'past_customer', 'dormant', null])('does not use new-customer terms for stage %s', async stage => {
  rows.customers[0].pipeline_stage = stage;
  expect(await publishWebsiteQuote(args)).toBeNull();
});

test('rejects a member even when the CRM still labels them a lead', async () => {
  rows.customers[0].waveguard_tier = 'Silver';
  expect(await publishWebsiteQuote(args)).toBeNull();
});

test.each(['scheduled_services', 'service_records'])('rejects a lead-stage account with %s history', async table => {
  rows[table] = [{ id: 'service-fixture', customer_id: 'customer-fixture' }];
  expect(await publishWebsiteQuote(args)).toBeNull();
  expect(rows.estimates[0].status).toBe('draft');
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

test('does not confuse another account’s service history with this prospect', async () => {
  rows.scheduled_services = [{ id: 'service-fixture', customer_id: 'another-customer' }];
  expect(await publishWebsiteQuote(args)).toEqual({ token: expect.any(String) });
});

test.each([
  { requiresManualReview: true }, { pricingConfidence: 'LOW' }, { turfConfidence: 'low' }, { turfBasis: 'lotFallback' },
])('keeps uncertain measurements out of immediate booking: %j', async flags => {
  Object.assign(args.engineResult.lineItems[0], flags);
  expect(await publishWebsiteQuote(args)).toBeNull();
  expect(db.transaction).not.toHaveBeenCalled();
});

test.each(['lead_id', 'engineInput', 'setupFeeQuote'])('rejects drift or uncertainty in %s', async key => {
  rows.estimates[0].estimate_data[key] = key === 'setupFeeQuote' ? { amount: 99, unverified: 'membership_undetermined' } : 'changed';
  expect(await publishWebsiteQuote(args)).toBeNull();
});

test('refuses even one cent of drift between the quote and frozen booking price', async () => {
  snapshot.sendSnapshot.pricingBundle.frequencies[0].annual = 396.01;
  expect(await publishWebsiteQuote(args)).toBeNull();
  expect(rows.estimates[0].status).toBe('draft');
});

test('validates one-time dollars instead of treating a missing recurring total as agreement', async () => {
  args.totals = { monthly_total: 0, annual_total: 0, onetime_total: 149 };
  Object.assign(rows.estimates[0], args.totals);
  snapshot.sendSnapshot.pricingBundle.anchorOneTimePrice = 149.01;
  expect(await publishWebsiteQuote(args)).toBeNull();
  snapshot.sendSnapshot.pricingBundle.anchorOneTimePrice = 149;
  expect(await publishWebsiteQuote(args)).toMatchObject({ token: expect.any(String) });
});

test('does not publish when the existing send guard refuses the estimate', async () => {
  delivery._internals.assertEstimateSendable.mockImplementation(() => { throw new Error('review required'); });
  await expect(publishWebsiteQuote(args)).rejects.toThrow('review required');
  expect(rows.estimates[0].status).toBe('draft');
});

test('audit failure rolls back publication', async () => {
  recordAuditEvent.mockRejectedValue(new Error('audit unavailable'));
  await expect(publishWebsiteQuote(args)).rejects.toThrow('audit unavailable');
  expect(rows.estimates[0].status).toBe('draft');
});

test.each([98.99, 99.01, null])('refuses a changed or missing membership fee: %s', async amount => {
  snapshot.sendSnapshot.pricingBundle.setupFee = amount == null ? null : { amount };
  expect(await publishWebsiteQuote(args)).toBeNull();
  expect(rows.estimates[0].status).toBe('draft');
});

test.each([
  [{ pest: { frequency: 'quarterly' } }, 'Pest Control', 99],
  [{ lawn: { track: 'st_augustine', lawnFreq: 9 } }, 'Lawn Care', 0],
  [{ oneTimePest: { urgency: 'NONE', afterHours: false } }, 'One-Time Pest Treatment', 0],
  [{ pest: { frequency: 'quarterly' }, lawn: { track: 'st_augustine', lawnFreq: 9 } }, 'Pest Control + Lawn Care', 0],
])('freezes the actual engine quote through the canonical send snapshot: %s', async (services, serviceInterest, fee) => {
  const { generateEstimate } = require('../services/pricing-engine');
  const engineInput = {
    homeSqFt: 2000, lotSqFt: 10000, stories: 1, propertyType: 'single_family',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    services, measuredTurfSf: 4250, paymentMethod: 'card',
  };
  const engineResult = generateEstimate(engineInput);
  const totals = {
    monthly_total: engineResult.summary.recurringMonthlyAfterDiscount,
    annual_total: engineResult.summary.recurringAnnualAfterDiscount,
    onetime_total: engineResult.summary.oneTimeTotal,
  };
  Object.assign(rows.estimates[0], totals, {
    service_interest: serviceInterest,
    estimate_data: {
      lead_id: args.leadId, engineInput, engineResult,
      setupFeeQuote: { kind: 'waveguard_membership', amount: fee },
    },
  });
  const actualDelivery = jest.requireActual('../routes/admin-estimates');
  delivery.buildEstimateSendSnapshot.mockImplementation(actualDelivery.buildEstimateSendSnapshot);
  delivery._internals.assertEstimateSendable.mockImplementation(actualDelivery._internals.assertEstimateSendable);
  const result = await publishWebsiteQuote({ ...args, engineInput, engineResult, totals });
  expect(result).toEqual({ token: expect.any(String) });
  const stored = JSON.parse(rows.estimates[0].estimate_data);
  expect(stored.engineInputs).toEqual(engineInput);
  expect(stored.engineInput).toBeUndefined();
  expect(stored.engineResult.pricingMetadata).toEqual(engineResult.pricingMetadata);
  const bundle = stored.sendSnapshot.pricingBundle;
  if (totals.annual_total > 0) {
    expect(bundle.frequencies).toEqual(expect.arrayContaining([expect.objectContaining({ annual: totals.annual_total })]));
  } else {
    expect(bundle.anchorOneTimePrice).toBe(totals.onetime_total);
  }
});
