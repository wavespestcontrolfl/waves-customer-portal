// The delayed lead fallback (sent after the Lead Response agent, up to a
// minute after the form) re-checks at the provider boundary that the
// customer still exists and still has the phone the webhook captured.
// A refusal is a not-sent block, which releases the first-touch claim.

let mockCustomerRow = null;
jest.mock('../models/db', () => jest.fn(() => {
  const chain = {
    where: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    first: jest.fn(async () => mockCustomerRow),
  };
  return chain;
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { recipientStillCurrent } = require('../services/lead-auto-reply');

describe('recipientStillCurrent', () => {
  test('same customer, same phone → ok', async () => {
    mockCustomerRow = { phone: '(941) 555-1234' };
    await expect(recipientStillCurrent('cust-1', '9415551234')).resolves.toEqual({ ok: true });
  });

  test('phone corrected by staff in the meantime → refused', async () => {
    mockCustomerRow = { phone: '+19415559999' };
    await expect(recipientStillCurrent('cust-1', '9415551234')).resolves.toMatchObject({ ok: false, code: 'LEAD_SUBJECT_CHANGED' });
  });

  test('customer deleted in the meantime → refused', async () => {
    mockCustomerRow = undefined;
    await expect(recipientStillCurrent('cust-1', '9415551234')).resolves.toMatchObject({ ok: false, code: 'LEAD_SUBJECT_CHANGED' });
  });
});
