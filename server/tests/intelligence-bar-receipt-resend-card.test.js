/**
 * The resend_receipt confirmation card shows every disclosure the preview makes — including a queued
 * automatic receipt and the visit closeout — not just the headline fields.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { confirmationDisplayParams } = require('../routes/admin-intelligence-bar');

const base = {
  preview: true,
  invoice_number: 'WPC-2026-0900',
  customer_name: 'Pat Tester',
  amount: '129.00',
  paid_date: '2026-10-01',
  receipt_status: 'No receipt is recorded as sent yet',
  channels: 'email and text',
  recipients: 'email to p***@example.com',
};

describe('resend_receipt card', () => {
  test('the headline fields, and nothing optional when the preview has none', () => {
    const card = confirmationDisplayParams('resend_receipt', { invoice_id: 'x' }, base);
    expect(card).toEqual({
      invoice: 'WPC-2026-0900', customer: 'Pat Tester', amount: '$129.00 paid on 2026-10-01',
      receipt: 'No receipt is recorded as sent yet', send_by: 'email and text', to: 'email to p***@example.com',
    });
  });

  test('a queued automatic receipt, the memo and the visit closeout all reach the card', () => {
    const card = confirmationDisplayParams('resend_receipt', { invoice_id: 'x' }, {
      ...base,
      memo: 'Thanks',
      visit_closeout: 'Also completes the linked visit — Pest Control on 2026-09-30',
      automatic_receipt: 'An automatic receipt is queued for this invoice. If this send does not deliver the email, it goes back in the queue and will try again on its own; a delivered email closes it.',
    });
    expect(card).toMatchObject({
      memo: 'Thanks',
      visit: 'Also completes the linked visit — Pest Control on 2026-09-30',
      automatic_receipt: expect.stringMatching(/automatic receipt is queued/),
    });
  });
});
