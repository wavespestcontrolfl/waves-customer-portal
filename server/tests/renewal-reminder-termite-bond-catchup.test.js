// GATE_MONEY_NOTICE_CATCHUP, termite bond renewal texts (owner 2026-11-06, "jobs 1-6"):
// the 10:12 run matched `DATE(termite_renewal_date) = today + N` for N = 30/15/7, so a
// lost tick dropped that day's notice. Gate on, each rung also matches a renewal date
// whose notice day passed at most 1 day ago (the texts state the time left in relative
// words, so a later send would state it wrong); the existing 35-day 'renewal' text
// cooldown keeps it to one text. Gate off, the match is the exact day (BETWEEN d AND d).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/annual-prepay-renewals', () => ({}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const renewalReminder = require('../services/workflows/renewal-reminder');

// Tuesday 2026-11-10 10:12 AM EST (15:12 UTC): the tick.
const NOW = new Date('2026-11-10T15:12:00Z');
const plus = (n) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let customers = [];
let recentRenewalText = null;
let rungWindows = [];

function installDb() {
  db.mockImplementation((table) => {
    if (table === 'customers') {
      let range = null;
      const q = {
        whereNotNull: () => q,
        whereNull: () => q,
        whereRaw: (sql, bindings) => {
          expect(sql).toBe('DATE(termite_renewal_date) BETWEEN ? AND ?');
          range = bindings;
          rungWindows.push(bindings);
          return q;
        },
        select: () => q,
        then: (resolve, reject) => Promise.resolve(customers.filter(
          (c) => c.termite_renewal_date >= range[0] && c.termite_renewal_date <= range[1],
        )).then(resolve, reject),
      };
      return q;
    }
    if (table === 'sms_log') {
      const q = { where: () => q, first: async () => recentRenewalText };
      return q;
    }
    if (table === 'customer_interactions') return { insert: async () => [] };
    throw new Error(`unexpected table in test: ${table}`);
  });
  db.raw = jest.fn((sql) => sql);
}

const savedGate = process.env.GATE_MONEY_NOTICE_CATCHUP;
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  delete process.env.GATE_MONEY_NOTICE_CATCHUP;
  customers = [];
  recentRenewalText = null;
  rungWindows = [];
  installDb();
  renderSmsTemplate.mockResolvedValue('Hi there, your termite bond renewal is coming up.');
  sendCustomerMessage.mockResolvedValue({ sent: true });
});
afterEach(() => jest.useRealTimers());
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_MONEY_NOTICE_CATCHUP;
  else process.env.GATE_MONEY_NOTICE_CATCHUP = savedGate;
});

const bondCustomer = (renewalDate) => ({ id: 'cust-1', first_name: 'Pat', phone: '+19415550101', location_id: 'loc-1', termite_renewal_date: renewalDate });

test('gate off: each rung matches its exact day only (the old `= d` match)', async () => {
  await renewalReminder.checkAndSend();
  expect(rungWindows).toEqual([[plus(30), plus(30)], [plus(15), plus(15)], [plus(7), plus(7)]]);
});

test('gate off: a renewal whose 30-day text day was yesterday gets nothing', async () => {
  customers = [bondCustomer(plus(29))];
  await expect(renewalReminder.checkAndSend()).resolves.toEqual({ sent: 0 });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('gate on: windows reach 1 day back and never touch the next rung\'s window', async () => {
  process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
  await renewalReminder.checkAndSend();
  expect(rungWindows).toEqual([[plus(29), plus(30)], [plus(14), plus(15)], [plus(6), plus(7)]]);
  for (let i = 0; i + 1 < rungWindows.length; i++) expect(rungWindows[i + 1][1] < rungWindows[i][0]).toBe(true);
});

test.each([[29, 30], [14, 15], [6, 7]])(
  'gate on: renewal %s days out (its %s-day text missed) gets one text with that rung\'s wording', async (daysOut, rung) => {
    process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
    customers = [bondCustomer(plus(daysOut))];
    await expect(renewalReminder.checkAndSend()).resolves.toEqual({ sent: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({ days_out: rung, original_message_type: 'renewal' });
  },
);

test.each([28, 26, 16, 13, 11, 8, 5, 3])('gate on: renewal %s days out is outside every window: no text', async (daysOut) => {
  process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
  customers = [bondCustomer(plus(daysOut))];
  await expect(renewalReminder.checkAndSend()).resolves.toEqual({ sent: 0 });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('gate on: the 35-day renewal-text cooldown blocks a repeat inside the late window', async () => {
  process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
  customers = [bondCustomer(plus(29))];
  recentRenewalText = { id: 'sms-1' };
  await expect(renewalReminder.checkAndSend()).resolves.toEqual({ sent: 0 });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});
