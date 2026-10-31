// What is left of the balance reminder after the retired legacy senders were
// deleted (GATE_BALANCE_REMINDER_LEGACY_OFF): the internal owner heads-up for
// a balance 30+ days overdue with service today or tomorrow, the balance read
// and the pay link rule. The old pre-visit tiers and the account late check
// are gone; the pre-visit balance reminder and the invoice follow-up ladder
// own the customer texts.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({ success: true })) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn(async () => 'body') }));
jest.mock('../services/invoice-followups', () => ({
  hasActiveSequence: jest.fn(async () => false),
  isDunningStopped: jest.fn(async () => false),
}));
jest.mock('../services/stripe', () => ({
  isInvoiceAwaitingMicrodepositVerification: jest.fn(async () => false),
}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const logger = require('../services/logger');
const TwilioService = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const InvoiceFollowUps = require('../services/invoice-followups');
const StripeService = require('../services/stripe');
const BalanceReminder = require('../services/workflows/balance-reminder');
const { etDateString, addETDays } = require('../utils/datetime-et');

function chain({ result = [], first } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNotNull', 'whereNull', 'leftJoin', 'orderBy', 'orderByRaw', 'select']
    .forEach((method) => { q[method] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

// db(table) serves the next canned chain queued for that table.
function setDb(queues) {
  const byTable = new Map(Object.entries(queues).map(([t, list]) => [t, [...list]]));
  db.mockImplementation((table) => {
    const queue = byTable.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.length === 1 ? queue[0] : queue.shift();
  });
}

const TODAY = () => etDateString();
const TOMORROW = () => etDateString(addETDays(new Date(), 1));

function visit(overrides = {}) {
  return {
    id: 'visit-1', cust_id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan',
    scheduled_date: TOMORROW(), ...overrides,
  };
}

function balance(overrides = {}) {
  return {
    totalBalance: 129, daysOverdue: 31, oldestInvoiceId: 'inv-1', invoiceIds: ['inv-1'],
    ...overrides,
  };
}

function armSweep({ visits = [visit()], bal = balance(), planFirst = null, invoiceRows = [] } = {}) {
  const plan = chain({ first: planFirst });
  const invoices = chain({ result: invoiceRows });
  setDb({ scheduled_services: [chain({ result: visits })], payment_plans: [plan], invoices: [invoices] });
  return jest.spyOn(BalanceReminder, 'getCustomerBalance').mockResolvedValue(bal);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  InvoiceFollowUps.hasActiveSequence.mockReset().mockResolvedValue(false);
  InvoiceFollowUps.isDunningStopped.mockReset().mockResolvedValue(false);
  StripeService.isInvoiceAwaitingMicrodepositVerification.mockReset().mockResolvedValue(false);
});

describe('the retired legacy senders are gone', () => {
  test('dailyCheck and latePaymentCheck no longer exist', () => {
    expect(BalanceReminder.dailyCheck).toBeUndefined();
    expect(BalanceReminder.latePaymentCheck).toBeUndefined();
    expect(BalanceReminder.sendReminder).toBeUndefined();
    expect(BalanceReminder.sendLatePaymentEmail).toBeUndefined();
  });

  test('the 11:00 cron runs the owner heads-up and nothing else from this module', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(src).toMatch(/runExclusive\('balance-reminders'[\s\S]{0,200}imminentOverdueOwnerAlertSweep\(\)/);
    expect(src).not.toMatch(/balanceReminder\.(dailyCheck|latePaymentCheck)/);
  });
});

describe('imminentOverdueOwnerAlertSweep (the kept 30-days-overdue owner heads-up)', () => {
  test('texts the owner for a balance 30+ days overdue with service tomorrow', async () => {
    armSweep();
    await BalanceReminder.imminentOverdueOwnerAlertSweep();
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    const [to, body, opts] = TwilioService.sendSMS.mock.calls[0];
    expect(to).toBe(process.env.ADAM_PHONE || '+19415993489');
    expect(body).toBe('💰 Overdue: Taylor Morgan — $129.00 (31 days). Service tomorrow.');
    expect(opts).toEqual({ messageType: 'internal_alert' });
  });

  test('says "today" for a visit today', async () => {
    armSweep({ visits: [visit({ scheduled_date: TODAY() })] });
    await BalanceReminder.imminentOverdueOwnerAlertSweep();
    expect(TwilioService.sendSMS.mock.calls[0][1]).toMatch(/Service today\.$/);
  });

  test.each([
    ['under 30 days overdue', balance({ daysOverdue: 29 })],
    ['no balance', null],
    ['a zero balance', balance({ totalBalance: 0 })],
    ['no unpaid invoice behind the balance', balance({ oldestInvoiceId: null })],
  ])('sends nothing for %s', async (_label, bal) => {
    armSweep({ bal });
    await BalanceReminder.imminentOverdueOwnerAlertSweep();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('sends nothing for a visit outside today and tomorrow', async () => {
    armSweep({ visits: [visit({ scheduled_date: etDateString(addETDays(new Date(), 3)) })] });
    await BalanceReminder.imminentOverdueOwnerAlertSweep();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('one alert per customer per visit day, however many visits that day', async () => {
    const read = armSweep({ visits: [visit(), visit({ id: 'visit-2' })] });
    await BalanceReminder.imminentOverdueOwnerAlertSweep();
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('never texts a customer', async () => {
    armSweep();
    await BalanceReminder.imminentOverdueOwnerAlertSweep();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  describe('account-level dunning stops', () => {
    const invoiceIds = ['inv-1', 'inv-2', 'inv-3'];
    const bal = () => balance({ invoiceIds: ['inv-2', 'inv-3'] });

    test.each(['sequence', 'dunning', 'plan', 'microdeposit'].flatMap((stop) =>
      invoiceIds.map((id) => [stop, id])))('%s on %s sends nothing', async (stop, stoppedId) => {
      armSweep({
        bal: bal(),
        planFirst: stop === 'plan' ? { id: 'plan-1' } : null,
        invoiceRows: invoiceIds.map((id) => ({ id, stripe_payment_intent_id: `pi-${id}` })),
      });
      if (stop === 'sequence') InvoiceFollowUps.hasActiveSequence.mockImplementation(async (id) => id === stoppedId);
      if (stop === 'dunning') InvoiceFollowUps.isDunningStopped.mockImplementation(async (id) => id === stoppedId);
      if (stop === 'microdeposit') {
        StripeService.isInvoiceAwaitingMicrodepositVerification.mockImplementation(async (row) => row.id === stoppedId);
      }
      await BalanceReminder.imminentOverdueOwnerAlertSweep();
      expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    });

    test.each(['sequence', 'dunning', 'stripe'])('%s read error warns and sends nothing (fails closed)', async (readError) => {
      armSweep({
        bal: bal(),
        invoiceRows: invoiceIds.map((id) => ({ id, stripe_payment_intent_id: `pi-${id}` })),
      });
      const error = new Error('stop state unavailable');
      if (readError === 'sequence') InvoiceFollowUps.hasActiveSequence.mockRejectedValue(error);
      if (readError === 'dunning') InvoiceFollowUps.isDunningStopped.mockRejectedValue(error);
      if (readError === 'stripe') StripeService.isInvoiceAwaitingMicrodepositVerification.mockRejectedValue(error);
      await BalanceReminder.imminentOverdueOwnerAlertSweep();
      expect(TwilioService.sendSMS).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('dunning-stop check failed'));
    });

    test('no stop: the alert goes out after every invoice behind the balance was checked', async () => {
      armSweep({
        bal: bal(),
        invoiceRows: invoiceIds.map((id) => ({ id, stripe_payment_intent_id: `pi-${id}` })),
      });
      await BalanceReminder.imminentOverdueOwnerAlertSweep();
      expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
      for (const id of invoiceIds) {
        expect(InvoiceFollowUps.hasActiveSequence).toHaveBeenCalledWith(id);
        expect(InvoiceFollowUps.isDunningStopped).toHaveBeenCalledWith(id);
      }
    });
  });

  test('one failing customer is logged and does not stop the rest', async () => {
    const read = armSweep({ visits: [visit(), visit({ id: 'visit-2', cust_id: 'cust-2', first_name: 'Sam', last_name: 'Lee' })] });
    read.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(balance());
    await BalanceReminder.imminentOverdueOwnerAlertSweep();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    expect(TwilioService.sendSMS.mock.calls[0][1]).toContain('Sam Lee');
  });
});

describe('getCustomerBalance pay link', () => {
  test('a tokenless oldest invoice gets no pay link, never /pay/<customer id>', async () => {
    const lastWeek = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
    setDb({
      payments: [chain({ result: [{ id: 'pay-1', customer_id: 'cust-1', amount: '129.00', status: 'failed', payment_date: lastWeek }] })],
      invoices: [
        chain({ result: [] }), // payer-billed invoice-id lookup (none)
        chain({ first: { id: 'inv-1', customer_id: 'cust-1', token: null, status: 'sent' } }),
      ],
    });
    const result = await BalanceReminder.getCustomerBalance('cust-1');
    expect(result).toEqual(expect.objectContaining({ oldestInvoiceId: 'inv-1', oldestInvoiceUrl: null }));
  });
});
