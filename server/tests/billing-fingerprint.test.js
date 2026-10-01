/**
 * Codex round-48/49 P1 (PR #5331): the billing fingerprint the send paths take BEFORE their full billing recheck and re-read at the
 * provider boundary on the handoff connection.
 */
jest.mock('../models/db', () => jest.fn());
const { billingFingerprint, billingUnchangedProviderPreSendCheck, BILLING_FINGERPRINT_SQL } = require('../services/billing-fingerprint');

describe('billingFingerprint', () => {
  test('one content hash over every row the recheck reads: payments, invoices, plans, payer assignments', () => {
    expect(BILLING_FINGERPRINT_SQL).toMatch(/md5\(concat_ws/);
    for (const t of ['FROM payments WHERE customer_id = ?', 'FROM invoices WHERE customer_id = ?', 'FROM payment_plans WHERE customer_id = ?',
      'FROM scheduled_services WHERE customer_id = ? AND payer_id IS NOT NULL', 'FROM customers WHERE id = ?']) expect(BILLING_FINGERPRINT_SQL).toContain(t);
    // the columns a status / amount / ownership / Zelle answer depends on
    for (const c of ['status', 'amount', 'refund_status', 'refund_amount', 'superseded_by_payment_id', 'metadata', 'credit_applied', 'payer_statement_id', 'scheduled_send_error']) {
      expect(BILLING_FINGERPRINT_SQL).toContain(c);
    }
  });
  test('reads through the given connection; null on no customer, a failed read, or no row', async () => {
    const dbh = { raw: jest.fn(async () => ({ rows: [{ fingerprint: 'abc' }] })) };
    expect(await billingFingerprint('c1', dbh)).toBe('abc');
    expect(dbh.raw).toHaveBeenCalledWith(BILLING_FINGERPRINT_SQL, ['c1', 'c1', 'c1', 'c1', 'c1']);
    expect(await billingFingerprint(null, dbh)).toBeNull();
    expect(await billingFingerprint('c1', { raw: async () => { throw new Error('down'); } })).toBeNull();
    expect(await billingFingerprint('c1', { raw: async () => ({ rows: [] }) })).toBeNull();
  });
});

describe('billingUnchangedProviderPreSendCheck', () => {
  const dbiWith = (fp) => ({ raw: async () => ({ rows: [{ fingerprint: fp }] }) });
  test('unchanged => ok; changed / unreadable / never taken => retryable refusal; repeatable after the marker', async () => {
    const check = billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: 'abc' });
    expect(check.afterMarker).toBe(check);
    await expect(check({ dbi: dbiWith('abc') })).resolves.toEqual({ ok: true });
    await expect(check({ dbi: dbiWith('xyz') })).resolves.toMatchObject({ ok: false, code: 'BILLING_CHANGED_AT_BOUNDARY', retryable: true });
    await expect(check({ dbi: { raw: async () => { throw new Error('down'); } } })).resolves.toMatchObject({ ok: false, retryable: true });
    await expect(billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: null })({ dbi: dbiWith('abc') })).resolves.toMatchObject({ ok: false, retryable: true });
  });
});
