// GATE_MONEY_NOTICE_CATCHUP, autopay pre-charge reminders (owner 2026-11-06,
// "jobs 1-6"): the 9:00 run used to match a phone customer only 3 days before
// the charge, so a lost tick charged that customer with no advance text. With
// the gate on, a phone customer also matches 2 and 1 days before the charge;
// the customer-wide 25-day cooldown keeps it to one reminder per charge. Gate
// off, the selection is exactly the old one (no-phone customers alone retry).
//
// The db mock evaluates the real `eligibleBillingDay` where-callback against
// each fake customer row, so the test reads the selection the query builds.
let mockCustomers = [];
const mockCooldown = jest.fn(async () => false);

function mockClauseRecorder() {
  // OR-groups of AND-ed row tests, the way knex chains where/orWhere.
  const groups = [[]];
  const api = {
    where(col, val) {
      if (typeof col === 'function') {
        const sub = mockClauseRecorder();
        col.call(sub.api, sub.api);
        groups[groups.length - 1].push(sub.test);
      } else {
        groups[groups.length - 1].push((row) => row[col] === val);
      }
      return api;
    },
    orWhere(fn) {
      groups.push([]);
      return api.where(fn);
    },
    whereRaw(sql) {
      if (sql !== "COALESCE(phone, '') = ''") throw new Error(`unexpected raw clause in test: ${sql}`);
      groups[groups.length - 1].push((row) => !row.phone);
      return api;
    },
    whereIn(col, values) {
      groups[groups.length - 1].push((row) => values.includes(row[col]));
      return api;
    },
  };
  return { api, test: (row) => groups.some((group) => group.every((fn) => fn(row))) };
}

jest.mock('../models/db', () => jest.fn((table) => {
  const b = {};
  let selector = () => true;
  for (const m of ['whereRaw', 'whereNull', 'select', 'orderBy']) b[m] = () => b;
  b.where = (arg) => {
    if (typeof arg === 'function' && arg.name === 'eligibleBillingDay') {
      const recorder = mockClauseRecorder();
      arg.call(recorder.api, recorder.api);
      selector = recorder.test;
    }
    return b;
  };
  const rows = () => (table === 'customers' ? mockCustomers.filter((row) => selector(row)) : []);
  b.first = () => Promise.resolve(null);
  b.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
  return b;
}));
jest.mock('../services/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('../services/autopay-log', () => ({
  logAutopay: jest.fn(async () => {}),
  eventExistsRecently: (...args) => mockCooldown(...args),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => 'Hello! Your auto-pay processes soon.'),
}));
jest.mock('../services/payment-lifecycle-email', () => ({}));
jest.mock('../services/autopay-eligibility', () => ({ isPaused: jest.fn(() => false) }));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { logAutopay } = require('../services/autopay-log');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendPreChargeReminders } = require('../services/autopay-notifications');
const { etParts, etDateString, addETDays } = require('../utils/datetime-et');

const chargeIn = (days) => addETDays(new Date(), days);
const dayOfCharge = (days) => Number(etParts(chargeIn(days)).day);
const phoneCustomer = (days) => ({
  id: `cust-${days}`, first_name: 'Pat', phone: '+19415550101', monthly_rate: '89.00',
  waveguard_tier: 'Gold', billing_mode: 'monthly_membership', autopay_paused_until: null,
  billing_day: dayOfCharge(days),
});
const chargeLabel = (days) => chargeIn(days).toLocaleDateString('en-US', {
  month: 'long', day: 'numeric', timeZone: 'America/New_York',
});

const savedGate = process.env.GATE_MONEY_NOTICE_CATCHUP;
beforeEach(() => {
  jest.clearAllMocks();
  mockCooldown.mockImplementation(async () => false);
  mockCustomers = [];
  delete process.env.GATE_MONEY_NOTICE_CATCHUP;
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_MONEY_NOTICE_CATCHUP;
  else process.env.GATE_MONEY_NOTICE_CATCHUP = savedGate;
});

describe('gate off: exactly the old selection', () => {
  test.each([2, 1])('a phone customer charged in %s day(s) gets no reminder', async (days) => {
    mockCustomers = [phoneCustomer(days)];
    expect(await sendPreChargeReminders()).toMatchObject({ sent: 0, total: 0 });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a phone customer charged in 3 days gets the one text, with no event key added', async () => {
    mockCustomers = [phoneCustomer(3)];
    expect(await sendPreChargeReminders()).toMatchObject({ sent: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toEqual({
      original_message_type: 'autopay_pre_charge', billing_mode_at_send: 'monthly_membership',
    });
  });

  test('a no-phone customer still retries 2 days before the charge (unchanged)', async () => {
    mockCustomers = [{ ...phoneCustomer(2), phone: null }];
    // No explicit App/Email choice: selected, then skipped without a send.
    expect(await sendPreChargeReminders()).toMatchObject({ total: 1, sent: 0, skipped: 1 });
  });
});

describe('gate on: a phone customer catches up 2 and 1 days before the charge', () => {
  beforeEach(() => { process.env.GATE_MONEY_NOTICE_CATCHUP = 'true'; });

  test.each([2, 1])('charged in %s day(s), never reminded: one text that names that charge date', async (days) => {
    mockCustomers = [phoneCustomer(days)];
    expect(await sendPreChargeReminders()).toMatchObject({ sent: 1, skipped: 0 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const input = sendCustomerMessage.mock.calls[0][0];
    expect(input).toMatchObject({ to: '+19415550101', channel: 'sms', customerId: `cust-${days}` });
    // Same per-charge event key the no-phone legs use, so a retry day dedupes.
    expect(input.metadata.notificationEventKey).toBe(`autopay-pre-charge:cust-${days}:${etDateString(chargeIn(days))}`);
    expect(renderSmsTemplate).toHaveBeenCalledWith('autopay_pre_charge',
      expect.objectContaining({ charge_date: chargeLabel(days) }), expect.any(Object));
    expect(logAutopay).toHaveBeenCalledWith(`cust-${days}`, 'pre_charge_reminder_sent',
      expect.objectContaining({ details: { charge_date: etDateString(chargeIn(days)) } }));
  });

  test('the 25-day cooldown blocks a repeat: a customer reminded at T+3 gets nothing at T+2', async () => {
    mockCustomers = [phoneCustomer(2)];
    mockCooldown.mockImplementation(async () => true);
    expect(await sendPreChargeReminders()).toMatchObject({ sent: 0, skipped: 1 });
    expect(mockCooldown).toHaveBeenCalledWith('cust-2', 'pre_charge_reminder_sent', 25);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a charge 4 days out, or today, is never matched', async () => {
    mockCustomers = [phoneCustomer(4), phoneCustomer(0)].filter((c) => ![1, 2, 3].map(dayOfCharge).includes(c.billing_day));
    expect(await sendPreChargeReminders()).toMatchObject({ total: 0 });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the T+3 customer is unchanged apart from the event key', async () => {
    mockCustomers = [phoneCustomer(3)];
    expect(await sendPreChargeReminders()).toMatchObject({ sent: 1 });
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toEqual({
      original_message_type: 'autopay_pre_charge', billing_mode_at_send: 'monthly_membership',
      notificationEventKey: `autopay-pre-charge:cust-3:${etDateString(chargeIn(3))}`,
    });
  });
});
