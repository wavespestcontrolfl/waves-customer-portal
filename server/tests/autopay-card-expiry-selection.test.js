// sendCardExpiryWarnings current-method selection (codex #3495 r17): the
// scan must warn ONLY about the method charge() would use — never replaced
// non-default cards or bank rows with populated legacy expiry fields.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/autopay-log', () => ({
  logAutopay: jest.fn(async () => {}),
  eventExistsRecently: jest.fn(async () => false),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => 'warning body'),
}));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendPaymentMethodExpiring: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  getActivelyCoveredCustomerIds: jest.fn(async () => new Set()),
}));
jest.mock('../services/autopay-eligibility', () => {
  const actual = jest.requireActual('../services/autopay-eligibility');
  return {
    ...actual,
    getChargeableAutopayMethod: jest.fn(),
    isPaused: jest.fn(() => false),
  };
});

const db = require('../models/db');
const { getChargeableAutopayMethod } = require('../services/autopay-eligibility');
const { getActivelyCoveredCustomerIds } = require('../services/annual-prepay-renewals');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { sendCardExpiryWarnings } = require('../services/autopay-notifications');

function thenable(rows) {
  const q = {};
  ['where', 'whereNull', 'whereNotNull', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.select = jest.fn(async () => rows);
  q.first = jest.fn(async () => rows[0] || null);
  return q;
}

function wireDb(queues) {
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
}

const CUSTOMER = { id: 'c1', first_name: 'Pat', phone: '+19415550100', ach_status: null, autopay_payment_method_id: 'pm-ptr' };

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['setTimeout', 'setInterval', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-08-26T15:00:00Z'));
});
afterAll(() => jest.useRealTimers());
beforeEach(() => jest.clearAllMocks());

describe('sendCardExpiryWarnings — current-method selection', () => {
  test('chargeable current CARD expiring within the window warns on THAT card only', async () => {
    getChargeableAutopayMethod.mockResolvedValueOnce({ id: 'pm-cur', method_type: null });
    wireDb({
      customers: [thenable([CUSTOMER])],
      payment_methods: [
        thenable([{ id: 'pm-cur', method_type: null, card_brand: 'Visa', last_four: '4242', exp_month: '9', exp_year: '26' }]),
      ],
    });
    const res = await sendCardExpiryWarnings();
    expect(res.sent).toBe(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('chargeable current card NOT expiring soon → no warning even if a replaced card is in the window', async () => {
    // The replaced non-default card never enters the selection at all — the
    // walk returns the current card, whose expiry is far out.
    getChargeableAutopayMethod.mockResolvedValueOnce({ id: 'pm-cur', method_type: null });
    wireDb({
      customers: [thenable([CUSTOMER])],
      payment_methods: [
        thenable([{ id: 'pm-cur', method_type: null, card_brand: 'Visa', last_four: '4242', exp_month: '12', exp_year: '2031' }]),
      ],
    });
    const res = await sendCardExpiryWarnings();
    expect(res.sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('chargeable current method is a BANK → no card notice (ACH customers are not texted about cards)', async () => {
    getChargeableAutopayMethod.mockResolvedValueOnce({ id: 'pm-bank', method_type: 'us_bank_account' });
    wireDb({ customers: [thenable([CUSTOMER])] });
    const res = await sendCardExpiryWarnings();
    expect(res.sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('nothing chargeable → warns on the expired pointer card charge() would have wanted', async () => {
    getChargeableAutopayMethod.mockResolvedValueOnce(false);
    wireDb({
      customers: [thenable([CUSTOMER])],
      payment_methods: [
        thenable([
          { id: 'pm-old', method_type: null, is_default: false, card_brand: 'Amex', last_four: '0005', exp_month: '1', exp_year: '2026' },
          { id: 'pm-ptr', method_type: null, is_default: true, card_brand: 'Visa', last_four: '4242', exp_month: '7', exp_year: '2026' },
        ]),
      ],
    });
    const res = await sendCardExpiryWarnings();
    expect(res.sent).toBe(1);
    const body = require('../services/sms-template-renderer').renderSmsTemplate.mock.calls[0];
    expect(body[1]).toMatchObject({ last_four: '4242' });
    expect(body[0]).toBe('autopay_card_expired');
  });

  test('nothing chargeable and only bank rows → no card notice', async () => {
    getChargeableAutopayMethod.mockResolvedValueOnce(false);
    wireDb({
      customers: [thenable([CUSTOMER])],
      payment_methods: [
        thenable([{ id: 'pm-b', method_type: 'ach', is_default: true, exp_month: '5', exp_year: '2026' }]),
      ],
    });
    const res = await sendCardExpiryWarnings();
    expect(res.sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('sendCardExpiryWarnings — prepay-covered customers', () => {
  test('a customer still covered at the 60-day horizon is skipped entirely (no walk, no SMS)', async () => {
    getActivelyCoveredCustomerIds.mockResolvedValueOnce(new Set([CUSTOMER.id]));
    wireDb({ customers: [thenable([CUSTOMER])] });
    const res = await sendCardExpiryWarnings();
    expect(res.sent).toBe(0);
    expect(getChargeableAutopayMethod).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const [asOf] = getActivelyCoveredCustomerIds.mock.calls[0];
    expect(asOf).toBe('2026-10-25'); // ET today (2026-08-26) + 60 days
  });

  test('coverage lookup failure fails toward the warning', async () => {
    getActivelyCoveredCustomerIds.mockRejectedValueOnce(new Error('boom'));
    getChargeableAutopayMethod.mockResolvedValueOnce({ id: 'pm-cur', method_type: null });
    wireDb({
      customers: [thenable([CUSTOMER])],
      payment_methods: [
        thenable([{ id: 'pm-cur', method_type: null, card_brand: 'Visa', last_four: '4242', exp_month: '9', exp_year: '26' }]),
      ],
    });
    const res = await sendCardExpiryWarnings();
    expect(res.sent).toBe(1);
  });
});
