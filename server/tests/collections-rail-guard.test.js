/**
 * collections/rail-guard.js — the shared per-channel policy consult every
 * wired balance rail rides (balance-reminder workflow legs, previsit rail).
 *
 * Pins: gate off/unset ⇒ permitted WITHOUT loading or consulting the policy
 * module (the byte-identical-dark contract); gate on ⇒ verdict channel must
 * allow; a target invoice must be in the eligible set (a sibling-invoice
 * allow is not permission); invoiceId null skips membership (aggregate
 * rails); evaluate() rejecting is a denial (fail closed at the guard too).
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/collections/contact-policy', () => ({
  evaluate: jest.fn(),
}));

const ContactPolicy = require('../services/collections/contact-policy');
const { collectionsChannelPermitted } = require('../services/collections/rail-guard');

const BASE = { customerId: 'cust-1', channel: 'sms', purpose: 'late_payment' };

afterEach(() => {
  delete process.env.GATE_COLLECTIONS_POLICY;
  jest.clearAllMocks();
});

describe('gate off', () => {
  test.each([undefined, '', 'false', 'TRUE', '1'])(
    'GATE_COLLECTIONS_POLICY=%p permits without consulting the policy',
    async (value) => {
      if (value === undefined) delete process.env.GATE_COLLECTIONS_POLICY;
      else process.env.GATE_COLLECTIONS_POLICY = value;
      await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1' })).resolves.toBe(true);
      expect(ContactPolicy.evaluate).not.toHaveBeenCalled();
    },
  );
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_COLLECTIONS_POLICY = 'true'; });

  test('allowed verdict with the target invoice eligible permits', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: ['inv-1', 'inv-2'], denialReasons: [] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1' })).resolves.toBe(true);
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({ channel: 'sms', purpose: 'late_payment' }));
  });

  test('denied verdict blocks even for an eligible invoice', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: false, eligibleInvoiceIds: ['inv-1'], denialReasons: ['contact_within_24h'] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1' })).resolves.toBe(false);
  });

  test('an allowed verdict about a SIBLING invoice is not permission for the target', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: ['inv-2'], denialReasons: [] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1' })).resolves.toBe(false);
  });

  test('numeric/string invoice id mismatch still matches (String-normalized membership)', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: [41], denialReasons: [] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: '41' })).resolves.toBe(true);
  });

  test('invoiceId null skips membership — aggregate rails need only the channel allow', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: [], denialReasons: [] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: null })).resolves.toBe(true);
  });

  test('aggregateDuesCents is passed through to the policy (the previsit dues-only path)', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: [], denialReasons: [] });
    await collectionsChannelPermitted({ ...BASE, purpose: 'balance_reminder', invoiceId: null, aggregateDuesCents: 12800 });
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({ aggregateDuesCents: 12800 }));
  });

  test('evaluate() rejecting is a denial, never a bypass', async () => {
    ContactPolicy.evaluate.mockRejectedValue(new Error('db down'));
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1' })).resolves.toBe(false);
  });
});
