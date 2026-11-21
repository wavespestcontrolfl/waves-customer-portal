const {
  readSinglePaymentRefunds,
  projectSinglePaymentRefund,
  verifySettledCardCharge,
} = require('../services/settled-card-refunds');

const chargeId = 'ch_original';
const paymentIntentId = 'pi_original';
const identity = { chargeId, paymentIntentId };
const refund = (id, amount) => ({ id, amount, charge: chargeId, payment_intent: paymentIntentId, status: 'succeeded' });
const charge = {
  id: chargeId, payment_intent: paymentIntentId, amount: 10000, paid: true, captured: true, status: 'succeeded',
  payment_method_details: { type: 'card' }, amount_refunded: 5000, refunded: false,
};
function provider(liveCharge = charge) {
  return {
    charges: { retrieve: jest.fn().mockResolvedValue(liveCharge) },
    refunds: { list: jest.fn().mockResolvedValue({ data: [refund('re_b', 1000), refund('re_a', 4000)], has_more: false }) },
  };
}

test.each([
  ['an authorization', { captured: false, amount_captured: 0 }],
  ['an ACH charge', { payment_method_details: { type: 'us_bank_account' } }],
  ['a replacement charge', { id: 'ch_replacement' }],
  ['a partial capture smaller than the recorded payment', { amount_captured: 6000 }],
])('the original payment amount cannot be refunded against %s', async (_description, changes) => {
  await expect(verifySettledCardCharge(provider({ ...charge, ...changes }), { ...identity, expectedAmountCents: 10000 }))
    .rejects.toThrow(/charge|amount/);
});

test('a replay uses every page and preserves a failure committed after the Stripe read', async () => {
  const stripe = provider();
  stripe.refunds.list
    .mockResolvedValueOnce({ data: [refund('re_b', 1000)], has_more: true })
    .mockResolvedValueOnce({ data: [refund('re_a', 4000)], has_more: false });
  const snapshot = await readSinglePaymentRefunds(stripe, identity);
  expect(stripe.refunds.list).toHaveBeenLastCalledWith({ charge: chargeId, limit: 100, starting_after: 're_b' });
  const payment = { amount: '100.00', stripe_charge_id: chargeId, metadata: {} };
  expect(projectSinglePaymentRefund(payment, snapshot, 're_b').metadata.stamped_refund_ids).toEqual(['re_a', 're_b']);
  payment.metadata.failed_refund_ids = ['re_a'];
  expect(() => projectSinglePaymentRefund(payment, snapshot, 're_b')).toThrow(/failed refund re_a/);
});

test('a legacy stamped ID must be removed by its own failure before an equal-dollar replacement counts', async () => {
  const snapshot = await readSinglePaymentRefunds(provider(), identity);
  const payment = { amount: 100, refund_amount: 50, stripe_refund_id: 're_bounced_before_ids', metadata: '{}' };
  expect(() => projectSinglePaymentRefund(payment, snapshot, 're_b')).toThrow(/re_bounced_before_ids/);
});

test('a stale provider total or repeated refund page cannot overwrite the ledger', async () => {
  const stripe = provider({ ...charge, amount_refunded: 4000 });
  await expect(readSinglePaymentRefunds(stripe, identity)).rejects.toThrow(/disagree/);
  stripe.refunds.list.mockResolvedValueOnce({ data: [refund('re_b', 1000)], has_more: true });
  await expect(readSinglePaymentRefunds(stripe, identity)).rejects.toThrow(/duplicate/);
});
