const { selectedTermiteAnnualPlanRows } = require('../services/estimate-termite-program-rows');
const { estimateOfferVersion, annualPlanOfferFingerprint, annualPlanHasDeliveredOffer, annualPlanPublicReplayBlocked } = require('../services/estimate-offer-version');

const PLAN_LINE = { service: 'termite_bait', plan: 'annual_protection', stations: 15 };
const QUARTERLY_LINE = { ...PLAN_LINE, plan: 'quarterly' };
const row = (data = { result: { lineItems: [PLAN_LINE] } }) => ({
  id: 'synthetic-annual', status: 'draft', token: 'synthetic-token', pricing_authority: 'SERVER',
  monthly_total: 0, annual_total: 299, onetime_total: 450, estimate_data: data,
});
const delivered = () => {
  const estimate = row();
  estimate.status = 'sent';
  estimate.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z',
    annualPlanOfferFingerprint: annualPlanOfferFingerprint(estimate) };
  return estimate;
};
const blocked = annualPlanPublicReplayBlocked;
const prior = [process.env.GATE_TERMITE_ANNUAL_PLAN, process.env.GATE_CANCEL_FLOW_V2];
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_TERMITE_ANNUAL_PLAN = process.env.GATE_CANCEL_FLOW_V2 = 'false';
});
afterAll(() => {
  ['GATE_TERMITE_ANNUAL_PLAN', 'GATE_CANCEL_FLOW_V2'].forEach((key, index) => {
    if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index];
  });
});

test.each([
  [{ result: { lineItems: [PLAN_LINE] } }, 1],
  [{ engineResult: { lineItems: [PLAN_LINE] } }, 1],
  [{ result: { results: { tmBait: { plan: 'annual_protection' } } } }, 1],
  [{ result: { oneTime: { items: [{ service: 'termite_bait_installation', kind: 'setup' }] } } }, 1],
  [{ result: { oneTime: { items: [{ service: 'termite_bait_installation' }] } } }, 0],
  [{ result: { results: { tmBait: { plan: 'quarterly' } } }, engineResult: { lineItems: [PLAN_LINE] } }, 0],
  [{ result: { lineItems: [QUARTERLY_LINE] } }, 0],
  [{ result: { lineItems: 'junk' } }, 0], [null, 0],
])('stored shape %j selects %s annual rows', (data, count) => {
  expect(selectedTermiteAnnualPlanRows(data)).toHaveLength(count);
  expect(blocked(row(data))).toBe(Boolean(count));
});

test.each([[false, false], [false, true], [true, false], [true, true]])(
  'annual=%s cancellation=%s distinguish fresh and issued offers', (annual, cancel) => {
    process.env.GATE_TERMITE_ANNUAL_PLAN = String(annual);
    process.env.GATE_CANCEL_FLOW_V2 = String(cancel);
    expect(blocked(row())).toBe(!(annual && cancel));
    expect(blocked(delivered())).toBe(false);
  },
);

test.each([
  ['notes', 'changed'], ['customer_id', 'other'], ['property_id', 'other'], ['estimate_group_id', 'other'],
  ['customer_phone', '9415550101'], ['customer_email', 'other@example.test'], ['customer_name', 'Other'],
  ['address', 'Other synthetic property'], ['show_one_time_option', true], ['bill_by_invoice', true],
  ['annual_total', 399], ['waveguard_tier', 'Gold'], ['service_interest', 'termite'], ['category', 'COMMERCIAL'], ['source', 'plan_restart'],
])('a changed %s cannot reuse delivery authority', (key, value) => {
  const estimate = delivered(); estimate[key] = value;
  expect(blocked(estimate)).toBe(true);
});

test('pricing changes and quarterly or suppressed handoffs cannot issue the annual offer', () => {
  const estimate = delivered();
  estimate.estimate_data.result.lineItems = [{ ...PLAN_LINE, annual: 399 }];
  expect(blocked(estimate)).toBe(true);
  delete estimate.estimate_data.deliveryState.annualPlanOfferFingerprint;
  expect(blocked(estimate)).toBe(true);
  delete estimate.estimate_data.deliveryState;
  estimate.sent_at = '2026-01-01T12:00:00Z';
  estimate.estimate_data = JSON.stringify(estimate.estimate_data);
  expect(blocked(estimate)).toBe(true);
});

test('operational metadata and database representations preserve the issued offer', () => {
  const estimate = delivered(); const fingerprint = annualPlanOfferFingerprint(estimate);
  for (const estimatorEngine of [{ delivering_at: 'now', delivering_token: 'claim' }, {}]) {
    estimate.estimate_data.estimatorEngine = estimatorEngine;
    expect(annualPlanOfferFingerprint(estimate)).toBe(fingerprint);
  }
  Object.assign(estimate.estimate_data, { viewedMonthlyTotal: 299, followupOwnershipFrom: 'sibling',
    leadServiceHandoffAttempt: { at: 'now', parkId: 'synthetic-park' },
    groupLinkViewableThrough: '2099-01-01T00:00:00Z', automation: { autoSend: { at: 'now' } } });
  estimate.annual_total = '299.00';
  estimate.estimate_data.result.lineItems = [{ stations: 15, plan: 'annual_protection', service: 'termite_bait' }];
  expect(blocked(estimate)).toBe(false);
  expect(annualPlanOfferFingerprint(estimate)).toBe(fingerprint);
});

test.each([
  { results: { tmBait: { plan: 'annual_protection', annual: 299 } } },
  { result: { results: { tmBait: { plan: 'annual_protection', annual: 299 } } } },
  { lineItems: [PLAN_LINE] },
  { result: { lineItems: [PLAN_LINE] } },
  { engineResult: { lineItems: [PLAN_LINE] } },
  { oneTime: { items: [{ service: 'termite_bait_installation', kind: 'setup' }] } },
])('every selected persisted shape can carry its exact witness: %j', (data) => {
  const estimate = row(data);
  const fingerprint = annualPlanOfferFingerprint(estimate);
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  estimate.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
  estimate.estimate_data = JSON.stringify(estimate.estimate_data);
  expect(annualPlanHasDeliveredOffer(estimate)).toBe(true);
  expect(blocked(estimate)).toBe(false);
  estimate.notes = 'changed scope';
  expect(annualPlanHasDeliveredOffer(estimate)).toBe(false);
});

test('extracting the reviewed-send hash preserves existing scheduled review versions', () => {
  const crypto = require('crypto');
  const estimate = row();
  const fields = ['customer_id', 'property_id', 'estimate_group_id', 'customer_name', 'customer_phone', 'customer_email', 'address', 'notes', 'monthly_total', 'annual_total', 'onetime_total', 'show_one_time_option', 'bill_by_invoice'];
  const legacy = crypto.createHash('sha256').update(JSON.stringify([fields.map((key) => estimate[key]), estimate.estimate_data])).digest('hex');
  expect(estimateOfferVersion(estimate)).toBe(legacy);
});

test.each(['accepted', 'declined'])('terminal %s remains readable without a witness', (status) => {
  expect(blocked({ ...row(), status })).toBe(false);
});
