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

// The dispute-hold read is not what this suite exercises (its db is a queue of
// canned chains): no active hold. The hold behavior has its own suites.
jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  dueInvoiceHeldByDisputeHold: jest.fn(async () => ({ held: false })),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/collections/contact-policy', () => ({
  evaluate: jest.fn(),
}));

const ContactPolicy = require('../services/collections/contact-policy');
const { collectionsChannelPermitted, collectionsChannelVerdict } = require('../services/collections/rail-guard');
const CollectionHold = require('../services/collections/collection-hold');

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
    expect(ContactPolicy.evaluate.mock.calls[0][1]).not.toHaveProperty('database');
  });

  test('forwards an explicitly held database without changing the default call', async () => {
    const heldDatabase = jest.fn();
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: ['inv-1'], denialReasons: [] });
    await expect(collectionsChannelPermitted({
      ...BASE, invoiceId: 'inv-1', database: heldDatabase,
    })).resolves.toBe(true);
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({ database: heldDatabase }));
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

  test('a frozen aggregate requires every quoted invoice in one policy verdict', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: ['inv-2'], denialReasons: [] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceIds: ['inv-1', 'inv-2'], detail: true }))
      .resolves.toEqual({ allowed: false, durable: false });
    expect(ContactPolicy.evaluate).toHaveBeenCalledTimes(1);
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: ['inv-1', 'inv-2'], denialReasons: [] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceIds: ['inv-1', 'inv-2'] })).resolves.toBe(true);
    await expect(collectionsChannelPermitted({ ...BASE, invoiceIds: [] })).resolves.toBe(true);
  });

  test('invoiceId null skips membership — aggregate rails need only the channel allow', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: [], denialReasons: [] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: null })).resolves.toBe(true);
  });

  test('offLedgerBalanceCents is passed through to the policy (the previsit dues-only path)', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: [], denialReasons: [] });
    await collectionsChannelPermitted({ ...BASE, purpose: 'balance_reminder', invoiceId: null, offLedgerBalanceCents: 12800 });
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({ offLedgerBalanceCents: 12800 }));
  });

  test('evaluate() rejecting is a denial, never a bypass', async () => {
    ContactPolicy.evaluate.mockRejectedValue(new Error('db down'));
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1' })).resolves.toBe(false);
  });
});

// r8: the verdict-returning consult for aggregate rails.
describe('collectionsChannelVerdict', () => {
  const { collectionsChannelVerdict } = require('../services/collections/rail-guard');

  test('gate off: permitted with a NULL eligible set (no filtering) and no consult', async () => {
    const v = await collectionsChannelVerdict({ customerId: 'cust-1', channel: 'sms', purpose: 'balance_reminder' });
    expect(v).toEqual({ permitted: true, eligibleInvoiceIds: null });
    expect(ContactPolicy.evaluate).not.toHaveBeenCalled();
  });

  test('gate on: allowed and denied verdicts both surface the eligible set', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const heldDatabase = jest.fn();
    ContactPolicy.evaluate.mockResolvedValueOnce({ allowed: true, eligibleInvoiceIds: ['inv-1'], denialReasons: [] });
    expect(await collectionsChannelVerdict({
      customerId: 'cust-1', channel: 'sms', purpose: 'balance_reminder', database: heldDatabase,
    }))
      .toEqual({ permitted: true, eligibleInvoiceIds: ['inv-1'] });
    expect(ContactPolicy.evaluate.mock.calls[0][1]).toEqual(expect.objectContaining({ database: heldDatabase }));
    ContactPolicy.evaluate.mockResolvedValueOnce({ allowed: false, eligibleInvoiceIds: ['inv-1'], denialReasons: ['contact_within_24h'] });
    expect(await collectionsChannelVerdict({ customerId: 'cust-1', channel: 'sms', purpose: 'balance_reminder' }))
      .toEqual({ permitted: false, eligibleInvoiceIds: ['inv-1'] });
  });

  test('gate on: preserves incomplete balance evidence without changing channel permission', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValueOnce({
      allowed: true,
      eligibleInvoiceIds: ['inv-1'],
      denialReasons: [],
      balanceIncomplete: 'payer resolve failed',
    });
    expect(await collectionsChannelVerdict({
      customerId: 'cust-1', channel: 'sms', purpose: 'balance_reminder',
    })).toEqual({
      permitted: true,
      eligibleInvoiceIds: ['inv-1'],
      balanceIncomplete: 'payer resolve failed',
    });
  });

  test('gate on: a consult failure denies with an EMPTY set (nothing quotable)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockRejectedValueOnce(new Error('db down'));
    expect(await collectionsChannelVerdict({ customerId: 'cust-1', channel: 'sms', purpose: 'balance_reminder' }))
      .toEqual({
        permitted: false,
        eligibleInvoiceIds: [],
        balanceIncomplete: 'policy evaluation failed',
      });
  });
});

describe('detail verdict', () => {
  test('gate off permits with no durable denial', async () => {
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', detail: true }))
      .resolves.toEqual({ allowed: true, durable: false });
  });

  test.each([
    [['flag_do_not_email'], true],
    [['suppression_unsubscribe'], true],
    [['commercial_customer'], true],
    [['contact_within_24h'], false],
    [['balance_read_incomplete'], false],
    [['contact_within_24h', 'flag_do_not_email'], true],
  ])('denial %j is durable: %p', async (denialReasons, durable) => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValueOnce({ allowed: false, denialReasons, eligibleInvoiceIds: ['inv-1'] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', detail: true }))
      .resolves.toEqual({ allowed: false, durable });
  });

  test('an ineligible invoice and a failed consult are transient denials', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValueOnce({ allowed: true, denialReasons: [], eligibleInvoiceIds: ['inv-2'] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', detail: true }))
      .resolves.toEqual({ allowed: false, durable: false });
    ContactPolicy.evaluate.mockRejectedValueOnce(new Error('db down'));
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', detail: true }))
      .resolves.toEqual({ allowed: false, durable: false });
  });

  test.each(['payer resolve failed', 'dunning-stop check failed'])('preserves incomplete reason %s in the detailed verdict', async (reason) => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, denialReasons: [],
      eligibleInvoiceIds: ['inv-1'], balanceIncomplete: reason });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', detail: true }))
      .resolves.toEqual({ allowed: true, durable: false, balanceIncomplete: reason });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1' })).resolves.toBe(true);
  });
});

describe('collections dispute hold (owner ruling 2026-09-30)', () => {
  const held = () => CollectionHold.dueInvoiceHeldByDisputeHold.mockResolvedValue({ held: true, reason: 'hold' });
  afterEach(() => CollectionHold.dueInvoiceHeldByDisputeHold.mockResolvedValue({ held: false }));

  test('an automated rail waits on an active dispute hold, gate off or on, as a non-durable denial', async () => {
    held();
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1' })).resolves.toBe(false);
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', detail: true })).resolves.toEqual({ allowed: false, durable: false, hold: true });
    await expect(collectionsChannelVerdict({ ...BASE })).resolves.toMatchObject({ permitted: false, hold: true });
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1' })).resolves.toBe(false);
    expect(ContactPolicy.evaluate).not.toHaveBeenCalled();
  });

  test('the operator "send now" exemption skips ONLY the hold wait (gate off permits; gate on still asks the policy)', async () => {
    held();
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', holdExempt: 'operator' })).resolves.toBe(true);
    expect(CollectionHold.dueInvoiceHeldByDisputeHold).not.toHaveBeenCalled();
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: ['inv-1'], denialReasons: [] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', holdExempt: 'operator' })).resolves.toBe(true);
    expect(ContactPolicy.evaluate).toHaveBeenCalledTimes(1);
    ContactPolicy.evaluate.mockResolvedValue({ allowed: false, eligibleInvoiceIds: [], denialReasons: ['flag_do_not_collect'] });
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', holdExempt: 'operator' })).resolves.toBe(false);
  });

  test('"operator" and "customer" exempt; any other value still waits', async () => {
    held();
    // A send the customer asked for themselves (the voice "text me the link" tool) is not automated
    // follow-up, so the hold does not stop it; the policy verdict is still consulted.
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', holdExempt: 'customer' })).resolves.toBe(true);
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', holdExempt: 'operator' })).resolves.toBe(true);
    for (const value of ['system', 'admin', true, '', 'Customer']) {
      await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', holdExempt: value })).resolves.toBe(false);
    }
  });

  test('a trusted exemption tells the policy to ignore ONLY the dispute hold (ignoreDisputeHold); an automated consult never does (round 11 P2)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, eligibleInvoiceIds: ['inv-1'], denialReasons: [] });
    for (const holdExempt of ['customer', 'operator']) {
      ContactPolicy.evaluate.mockClear();
      await collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', holdExempt });
      expect(ContactPolicy.evaluate.mock.calls[0][1]).toMatchObject({ ignoreDisputeHold: true });
      ContactPolicy.evaluate.mockClear();
      await collectionsChannelVerdict({ ...BASE, holdExempt });
      expect(ContactPolicy.evaluate.mock.calls[0][1]).toMatchObject({ ignoreDisputeHold: true });
    }
    for (const holdExempt of [null, undefined, 'system', true, 'Customer']) {
      ContactPolicy.evaluate.mockClear();
      await collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', holdExempt });
      expect(ContactPolicy.evaluate.mock.calls[0]?.[1] || {}).not.toHaveProperty('ignoreDisputeHold');
    }
  });

  test('the customer exemption does not lift a policy denial', async () => {
    held();
    ContactPolicy.evaluate.mockResolvedValue({ allowed: false, eligibleInvoiceIds: [], denialReasons: ['flag_do_not_collect'] });
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    await expect(collectionsChannelPermitted({ ...BASE, invoiceId: 'inv-1', holdExempt: 'customer' })).resolves.toBe(false);
  });
});

describe('invoice-followups passes the operator exemption for "send now" only', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/invoice-followups.js'), 'utf8');

  test('the ladder consult forwards holdExempt "operator" only for an operator-initiated touch (automated touches wait)', () => {
    expect(src).toMatch(/collectionsChannelPermitted\(row\.customer_id, row\.invoice_id, channel, ownLedgerIds, true, mdPending, operatorInitiated \? 'operator' : null\)/);
    expect(src).toMatch(/\.\.\.\(holdExempt \? \{ holdExempt \} : \{\}\)/);
    // the operator flag is set by sendNextTouchNow's caller and threads fireStep -> fireTouch
    expect(src).toMatch(/await fireStep\(row, \{ operatorInitiated \}\)/);
    expect(src).toMatch(/await fireTouch\(row, \{ operatorInitiated(, claimStamp)? \}\)/);
  });
});
