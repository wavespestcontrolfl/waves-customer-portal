// Monthly-rate edits from the Intelligence Bar (owner 2026-10-06): the bar
// offered to set a pest customer's whole bill to a lawn price. A rate edit on a
// customer who has a bill must name the service that changes; the card lists
// every line; a total below the other lines is refused.
const mockCustomer = jest.fn();
const mockComponents = jest.fn();

jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where: () => ({ first: (...a) => mockCustomer(...a) }) }));
  return db;
});
jest.mock('../services/plan-rate-ledger', () => {
  const actual = jest.requireActual('../services/plan-rate-ledger');
  return { ...actual, loadComponents: (...a) => mockComponents(...a) };
});

const { rateChangeProposal, ledgerPin } = require('../services/intelligence-bar/rate-change');

const CUSTOMER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  mockCustomer.mockResolvedValue({ monthly_rate: '41.33', billing_mode: 'monthly_membership' });
  mockComponents.mockResolvedValue([{ family_key: 'pest_control', monthly_rate: '41.33' }]);
});

test('no service named on a customer with a bill: refused, and the refusal lists the bill', async () => {
  const r = await rateChangeProposal(CUSTOMER, 60.33, undefined);
  expect(r.code).toBe('rate_family_required');
  expect(r.error).toContain('Pest control $41.33');
  expect(r.error).toContain('whole monthly bill');
});

test('"lawn" adds a lawn line beside pest; the card gets both lines and the pin', async () => {
  const r = await rateChangeProposal(CUSTOMER, 102.66, 'lawn');
  expect(r.family).toBe('lawn_care');
  expect(r.pin).toBe(ledgerPin([{ family_key: 'pest_control', monthly_rate: '41.33' }], '41.33'));
  expect(r.display).toEqual({
    billing_mode: 'monthly_membership',
    replaces_whole_bill: false,
    lines: [
      { label: 'Pest control', before: 41.33, after: 41.33 },
      { label: 'Lawn care', before: 0, after: 61.33 },
    ],
    total_before: 41.33,
    total_after: 102.66,
  });
});

test('a lawn price given as the whole total is refused as below the pest line', async () => {
  const r = await rateChangeProposal(CUSTOMER, 30, 'lawn');
  expect(r.code).toBe('rate_below_other_lines');
  expect(r.error).toContain('Pest control $41.33');
});

test('an existing line key is accepted as-is; whole_bill shows the line that drops off', async () => {
  expect((await rateChangeProposal(CUSTOMER, 45, 'pest_control')).family).toBe('pest_control');
  const whole = await rateChangeProposal(CUSTOMER, 60.33, 'whole_bill');
  expect(whole.display.replaces_whole_bill).toBe(true);
  expect(whole.display.lines).toEqual([
    { label: 'Pest control', before: 41.33, after: 0 },
    { label: 'Earlier rate (not split by service)', before: 0, after: 60.33 },
  ]);
});

test('an unknown or per-application service is refused; an unchanged rate is pinned with nothing to show', async () => {
  expect((await rateChangeProposal(CUSTOMER, 50, 'xyz unknown thing')).code).toBe('rate_family_unknown');
  expect((await rateChangeProposal(CUSTOMER, 60, 'rodent bait')).code).toBe('rate_family_unknown');
  expect(await rateChangeProposal(CUSTOMER, 41.33, undefined)).toEqual({
    family: 'unchanged', pin: ledgerPin([{ family_key: 'pest_control', monthly_rate: '41.33' }], '41.33'), display: null,
  });
});

test('a first rate on a customer with no bill needs no service name', async () => {
  mockCustomer.mockResolvedValue({ monthly_rate: '0', billing_mode: null });
  mockComponents.mockResolvedValue([]);
  const r = await rateChangeProposal(CUSTOMER, 55, undefined);
  expect(r.family).toBe('whole_bill');
  expect(r.display.total_after).toBe(55);
});

test('a service on hold (zero ledger row) blocks its own line and a whole-bill reset', async () => {
  mockComponents.mockResolvedValue([
    { family_key: 'pest_control', monthly_rate: '41.33' },
    { family_key: 'mosquito', monthly_rate: '0' },
  ]);
  expect((await rateChangeProposal(CUSTOMER, 70, 'mosquito')).code).toBe('rate_family_on_hold');
  expect((await rateChangeProposal(CUSTOMER, 70, 'whole_bill')).code).toBe('rate_family_on_hold');
  expect((await rateChangeProposal(CUSTOMER, 102.66, 'lawn')).family).toBe('lawn_care');
});
