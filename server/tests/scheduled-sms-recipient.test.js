/**
 * Scheduled-SMS recipient resolution.
 *
 * Rows queued with refresh_customer_phone (deposit-receipt quiet-hold
 * retries) must re-read the customer's CURRENT phone at send time — the cron
 * asserts phone_matches_customer for customer rows, and that trust can't ride
 * a number frozen hours earlier that the customer may have since changed.
 */

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  logGateStatus: jest.fn(),
}));

const db = require('../models/db');
const { resolveScheduledRecipient, scheduledDepositReceiptAllowed } = require('../services/scheduler');

function mockCustomerLookup(row) {
  db.mockImplementation((table) => {
    if (table !== 'customers') throw new Error(`unexpected table: ${table}`);
    return { where: () => ({ first: async () => row }) };
  });
}

function mockPrefsLookup(row) {
  db.mockImplementation((table) => {
    if (table !== 'notification_prefs') throw new Error(`unexpected table: ${table}`);
    return { where: () => ({ first: async () => row }) };
  });
}

describe('resolveScheduledRecipient', () => {
  afterEach(() => db.mockReset());

  test('refreshes to the customer\'s current phone when flagged', async () => {
    mockCustomerLookup({ phone: '(941) 555-0222' });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: 'cust-1' },
      { refresh_customer_phone: true },
    )).resolves.toBe('(941) 555-0222');
  });

  test('keeps the queued number without the flag — ordinary scheduled sends are untouched', async () => {
    db.mockImplementation(() => { throw new Error('must not query'); });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: 'cust-1' },
      {},
    )).resolves.toBe('(941) 555-0100');
  });

  test('keeps the queued number for lead rows even if flagged', async () => {
    db.mockImplementation(() => { throw new Error('must not query'); });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: null },
      { refresh_customer_phone: true },
    )).resolves.toBe('(941) 555-0100');
  });

  test('returns null when the current phone cannot be verified — never the frozen snapshot', async () => {
    // The snapshot is exactly the staleness the flag exists to prevent —
    // sending to it under phone_matches_customer trust would be wrong, so
    // the cron retries the row instead.
    mockCustomerLookup({ phone: '   ' });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: 'cust-1' },
      { refresh_customer_phone: true },
    )).resolves.toBeNull();

    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: 'cust-1' },
      { refresh_customer_phone: true },
    )).resolves.toBeNull();
  });
});

describe('scheduledDepositReceiptAllowed', () => {
  afterEach(() => db.mockReset());

  const receiptRow = { customer_id: 'cust-1', message_type: 'deposit_receipt' };

  test('blocks the replay when the customer switched to email-only receipts', async () => {
    mockPrefsLookup({ payment_receipt_channel: 'email' });
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(false);
  });

  test('allows sms and both channels, and defaults to sms when prefs are missing', async () => {
    mockPrefsLookup({ payment_receipt_channel: 'sms' });
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(true);
    mockPrefsLookup({ payment_receipt_channel: 'both' });
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(true);
    mockPrefsLookup(null);
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(true);
  });

  test('ignores lead rows and non-receipt message types — no prefs query', async () => {
    db.mockImplementation(() => { throw new Error('must not query'); });
    await expect(scheduledDepositReceiptAllowed({ customer_id: null, message_type: 'deposit_receipt' })).resolves.toBe(true);
    await expect(scheduledDepositReceiptAllowed({ customer_id: 'cust-1', message_type: 'review_request' })).resolves.toBe(true);
  });

  test('fails open on a lookup error — matches the immediate path default', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(true);
  });
});
