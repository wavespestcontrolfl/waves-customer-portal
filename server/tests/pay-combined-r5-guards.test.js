/**
 * Codex #3427 r5 guards:
 *  - stopSequence fails CLOSED when the combined-PI release can't be
 *    verified or executed (the browser can confirm a combined PI directly,
 *    so a swallowed cancel failure would let a "stopped" invoice charge);
 *  - payout-reconciliation balance transactions attribute a combined
 *    charge through the anchor payment row and expose the full allocation
 *    instead of crediting an arbitrary share.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockRetrievePaymentIntent = jest.fn();
const mockCancelPaymentIntent = jest.fn();
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: (...args) => mockRetrievePaymentIntent(...args),
  cancelPaymentIntent: (...args) => mockCancelPaymentIntent(...args),
}));

const mockClearStamps = jest.fn(async () => 0);
jest.mock('../services/pay-combined', () => {
  const actual = jest.requireActual('../services/pay-combined');
  return {
    ...actual,
    clearPaymentIntentStamps: (...args) => mockClearStamps(...args),
  };
});

const db = require('../models/db');
const FollowUps = require('../services/invoice-followups');

const ANCHOR_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const SIBLING_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

function combinedPi(status = 'requires_payment_method') {
  return {
    id: 'pi_combined_1',
    status,
    next_action: null,
    metadata: {
      waves_invoice_id: ANCHOR_ID,
      combined_allocation: `${ANCHOR_ID}:10530,${SIBLING_ID}:4455`,
    },
  };
}

describe('stopSequence combined-PI release (fail closed)', () => {
  let sequenceUpdate;

  beforeEach(() => {
    jest.clearAllMocks();
    sequenceUpdate = jest.fn(async () => 1);
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = {};
        q.where = jest.fn(() => q);
        q.first = jest.fn(async () => ({
          id: SIBLING_ID,
          customer_id: 'cust-1',
          stripe_payment_intent_id: 'pi_combined_1',
          invoice_number: 'WPC-2026-0316',
        }));
        return q;
      }
      if (table === 'invoice_followup_sequences') {
        const q = {};
        q.where = jest.fn(() => q);
        // stopSequence reads the prior row FOR UPDATE before the stop
        // (admin-stop/pause preservation, Codex #3493 r3/r8); no row → the
        // stop writes its own reason, same payload these tests assert.
        q.forUpdate = jest.fn(() => q);
        q.first = jest.fn(async () => undefined);
        q.update = sequenceUpdate;
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    });
    db.fn = { now: jest.fn(() => 'NOW()') };
    // stopSequence now runs in one transaction holding the
    // pay.combined.customer advisory lock (codex #3427 r10).
    db.raw = jest.fn(async () => ({}));
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  test('cancel failure rejects the stop and leaves the sequence running', async () => {
    mockRetrievePaymentIntent.mockResolvedValue(combinedPi());
    mockCancelPaymentIntent.mockRejectedValue(new Error('stripe unavailable'));
    await expect(FollowUps.stopSequence(SIBLING_ID, { reason: 'admin' }))
      .rejects.toThrow(/dunning NOT stopped/);
    expect(sequenceUpdate).not.toHaveBeenCalled();
  });

  test('unreadable PI rejects the stop (could be a combined session)', async () => {
    mockRetrievePaymentIntent.mockRejectedValue(new Error('timeout'));
    await expect(FollowUps.stopSequence(SIBLING_ID, { reason: 'admin' }))
      .rejects.toThrow(/Could not verify/);
    expect(sequenceUpdate).not.toHaveBeenCalled();
    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
  });

  test('successful release then stops the sequence and clears stamps', async () => {
    mockRetrievePaymentIntent.mockResolvedValue(combinedPi());
    mockCancelPaymentIntent.mockResolvedValue({ id: 'pi_combined_1', status: 'canceled' });
    await FollowUps.stopSequence(SIBLING_ID, { reason: 'admin' });
    expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_combined_1');
    expect(mockClearStamps).toHaveBeenCalled();
    expect(sequenceUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }));
  });

  test('in-flight combined PI is never canceled but the stop proceeds', async () => {
    mockRetrievePaymentIntent.mockResolvedValue(combinedPi('processing'));
    await FollowUps.stopSequence(SIBLING_ID, { reason: 'admin' });
    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    expect(sequenceUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }));
  });
});

describe('payout reconciliation combined-charge attribution', () => {
  const { _txnRowFromStripe } = require('../services/stripe-banking');

  const paymentRow = (id, invoiceId, amount, { anchor = false } = {}) => ({
    id,
    customer_id: 'cust-1',
    amount,
    stripe_charge_id: 'ch_combined_1',
    stripe_payment_intent_id: 'pi_combined_1',
    metadata: JSON.stringify({
      invoice_id: invoiceId,
      combined_payment: true,
      combined_anchor_invoice_id: ANCHOR_ID,
      ...(anchor ? {} : {}),
    }),
  });

  const txn = {
    id: 'txn_1',
    type: 'charge',
    reporting_category: 'charge',
    source: 'ch_combined_1',
    amount: 14985,
    fee: 465,
    net: 14520,
    description: 'Combined balance payment',
    available_on: 1755300000,
    created: 1755200000,
  };

  test('anchors on the anchor payment row and exposes every share', () => {
    const sibling = paymentRow('pay-sibling', SIBLING_ID, 44.55);
    const anchor = paymentRow('pay-anchor', ANCHOR_ID, 105.30, { anchor: true });
    const maps = {
      // sibling FIRST — last-write-wins would have picked it before r5
      paymentsBySource: new Map([['ch_combined_1', [sibling, anchor]]]),
      customersById: new Map([['cust-1', { id: 'cust-1', first_name: 'Gavin', last_name: 'D' }]]),
    };
    const row = _txnRowFromStripe(txn, maps, null);
    expect(row.payment_id).toBe('pay-anchor');
    expect(row.customer_id).toBe('cust-1');
    // no single invoice owns the whole balance transaction
    expect(row.invoice_id).toBeNull();
    expect(row.description).toContain('combined:');
    expect(row.description).toContain(ANCHOR_ID);
    expect(row.description).toContain(SIBLING_ID);
    expect(row.description).toContain('$44.55');
    expect(row.description).toContain('$105.30');
  });

  test('single NON-combined payments keep the original one-to-one attribution', () => {
    const single = {
      id: 'pay-only',
      customer_id: 'cust-1',
      amount: 105.30,
      stripe_charge_id: 'ch_combined_1',
      stripe_payment_intent_id: 'pi_combined_1',
      metadata: JSON.stringify({ invoice_id: ANCHOR_ID }),
    };
    const maps = {
      paymentsBySource: new Map([['ch_combined_1', [single]]]),
      customersById: new Map(),
    };
    const row = _txnRowFromStripe(txn, maps, 'po_1');
    expect(row.payment_id).toBe('pay-only');
    expect(row.invoice_id).toBe(ANCHOR_ID);
    expect(row.description).toBe('Combined balance payment');
    expect(row.payout_id).toBe('po_1');
  });

  test('a LONE combined row (residual sibling) is still treated as combined (codex r13)', () => {
    // The sibling's share parked as a residual — only the anchor row was
    // recorded. The whole txn amount must not be attributed to it.
    const anchorOnly = paymentRow('pay-anchor', ANCHOR_ID, 105.30);
    const maps = {
      paymentsBySource: new Map([['ch_combined_1', [anchorOnly]]]),
      customersById: new Map(),
    };
    const row = _txnRowFromStripe(txn, maps, null);
    expect(row.payment_id).toBe('pay-anchor');
    expect(row.invoice_id).toBeNull();
    expect(row.description).toContain('combined:');
    expect(row.description).toContain('allocation may be incomplete');
  });
});
