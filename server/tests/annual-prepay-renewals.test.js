jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(),
}));

const db = require('../models/db');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { _private } = AnnualPrepayRenewals;

describe('annual prepay renewal helpers', () => {
  test('keeps PostgreSQL DATE objects on their calendar day', () => {
    expect(_private.dateOnly(new Date('2026-05-14T00:00:00.000Z'))).toBe('2026-05-14');
  });

  test('adds calendar months while preserving valid end-of-month dates', () => {
    expect(_private.addMonthsSameDay('2024-01-31', 1)).toBe('2024-02-29');
    expect(_private.addMonthsSameDay('2025-01-31', 1)).toBe('2025-02-28');
    expect(_private.addMonthsSameDay('2026-05-14', 12)).toBe('2027-05-14');
  });

  test('maps supported customer notice offsets to term columns', () => {
    expect(_private.noticeColumnForDaysOut(30)).toBe('notice_30_sent_at');
    expect(_private.noticeColumnForDaysOut('15')).toBe('notice_15_sent_at');
    expect(_private.noticeColumnForDaysOut(7)).toBe('notice_7_sent_at');
    expect(_private.noticeColumnForDaysOut(10)).toBeNull();
    expect(_private.noticeClaimColumnForDaysOut(30)).toBe('notice_30_claimed_at');
    expect(_private.noticeClaimColumnForDaysOut(15)).toBe('notice_15_claimed_at');
    expect(_private.noticeClaimColumnForDaysOut(10)).toBeNull();
  });

  test('keeps draft prepay invoices payment pending until collected', () => {
    expect(_private.invoiceTermStatus({ status: 'draft', paid_at: null })).toBe('payment_pending');
    expect(_private.invoiceTermStatus({ status: 'sent', paid_at: null })).toBe('payment_pending');
    expect(_private.invoiceTermStatus({ status: 'paid', paid_at: null })).toBe('active');
    expect(_private.invoiceTermStatus({ status: 'viewed', paid_at: new Date('2026-05-14T12:00:00Z') })).toBe('active');
    expect(_private.invoiceTermStatus({ status: 'void', paid_at: null })).toBe('cancelled');
    expect(_private.invoiceTermStatus({ status: 'refunded', paid_at: new Date('2026-05-14T12:00:00Z') })).toBe('cancelled');
  });

  test('calculates whole-day distances from date-only strings', () => {
    expect(_private.daysUntil('2026-05-14', '2026-05-14')).toBe(0);
    expect(_private.daysUntil('2026-05-14', '2026-06-13')).toBe(30);
    expect(_private.daysUntil('2026-05-14', '2026-05-07')).toBe(-7);
  });

  test('alerts when either term end or final scheduled service is inside the renewal window', () => {
    expect(_private.shouldAlertTerm({
      term_end: '2026-06-13',
      last_scheduled_service_date: null,
    }, '2026-05-14', 30)).toBe(true);

    expect(_private.shouldAlertTerm({
      term_end: '2026-08-15',
      last_scheduled_service_date: '2026-06-01',
    }, '2026-05-14', 30)).toBe(true);
  });

  test('does not treat an early-term scheduled service as the final-service renewal trigger', () => {
    expect(_private.shouldAlertTerm({
      term_end: '2027-05-14',
      last_scheduled_service_date: '2026-06-01',
    }, '2026-05-14', 30)).toBe(false);
  });

  test('does not alert once the last service is beyond the grace window and term end is far away', () => {
    expect(_private.shouldAlertTerm({
      term_end: '2026-12-31',
      last_scheduled_service_date: '2026-04-29',
    }, '2026-05-14', 30)).toBe(false);
  });

  test('finds refunded invoice from payment metadata aliases before querying invoices', async () => {
    const conn = jest.fn();
    await expect(_private.findInvoiceIdForRefundedPayment({
      metadata: JSON.stringify({ invoice_id: 'invoice-meta' }),
    }, conn)).resolves.toBe('invoice-meta');
    await expect(_private.findInvoiceIdForRefundedPayment({
      metadata: { waves_invoice_id: 'invoice-waves' },
    }, conn)).resolves.toBe('invoice-waves');
    expect(conn).not.toHaveBeenCalled();
  });

  test('falls back to invoice lookup by Stripe charge when payment metadata is missing', async () => {
    const lookups = [];
    const conn = jest.fn(() => ({
      where(criteria) {
        lookups.push(criteria);
        return {
          first: jest.fn().mockResolvedValue(criteria.stripe_charge_id === 'ch_123' ? { id: 'invoice-charge' } : null),
        };
      },
    }));

    await expect(_private.findInvoiceIdForRefundedPayment({
      stripe_payment_intent_id: 'pi_missing',
      stripe_charge_id: 'ch_123',
    }, conn)).resolves.toBe('invoice-charge');
    expect(lookups).toEqual([
      { stripe_payment_intent_id: 'pi_missing' },
      { stripe_charge_id: 'ch_123' },
    ]);
  });

  test('renewal decisions claim only open undecided terms', async () => {
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    const chain = {
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'term-1', status: 'cancelled', renewal_decision: 'cancel' }]),
    };
    db.mockReturnValue(chain);

    await expect(AnnualPrepayRenewals.recordDecision({
      termId: 'term-1',
      action: 'cancel',
      adminUserId: 'admin-1',
    })).resolves.toEqual(expect.objectContaining({ id: 'term-1' }));

    expect(chain.where).toHaveBeenCalledWith({ id: 'term-1' });
    expect(chain.whereIn).toHaveBeenCalledWith('status', ['active', 'renewal_pending']);
    expect(chain.whereNull).toHaveBeenCalledWith('renewal_decision');
  });
});
