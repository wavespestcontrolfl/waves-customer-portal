/**
 * Cancellation save: a step held by the 8 AM–8 PM send window is queued on
 * the scheduled-SMS rail with the line its replay will send from (the
 * customer's home line under GATE_HOME_LINE) — not the main-line placeholder
 * the old read of the nonexistent customers.location_id produced.
 */
const inserts = [];
jest.mock('../models/db', () => jest.fn((table) => {
  const q = {
    where: () => q,
    first: async () => (table === 'customers'
      ? { id: 'cust-1', first_name: 'Test', last_name: 'Customer', phone: '+15551234567' }
      : null),
    insert: (row) => {
      inserts.push({ table, row });
      return table === 'sms_sequences' ? { returning: async () => [{ id: 'seq-1' }] } : Promise.resolve([1]);
    },
  };
  return q;
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'We are sorry to see you go.') }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({
    sent: false, code: 'QUIET_HOURS_HOLD', deferred: true, nextAllowedAt: '2026-10-03T12:00:00Z',
  })),
}));
const mockDerive = jest.fn(async () => '+19412972817');
jest.mock('../services/twilio', () => ({
  deriveOutboundNumber: (...args) => mockDerive(...args),
  sendSMS: jest.fn(async () => ({ success: true })),
}));

const cancellationSave = require('../services/workflows/cancellation-save');

describe('cancellation save: quiet-hours queue row', () => {
  beforeEach(() => { jest.useFakeTimers(); inserts.length = 0; });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('the queued step carries the customer\'s home line', async () => {
    await cancellationSave.initiate('cust-1', 'price');
    const queued = inserts.find((i) => i.table === 'sms_log');
    expect(queued).toBeTruthy();
    expect(mockDerive).toHaveBeenCalledWith({ customerId: 'cust-1' });
    expect(queued.row).toMatchObject({
      customer_id: 'cust-1', status: 'scheduled', message_type: 'cancellation_save', from_phone: '+19412972817',
    });
  });
});
