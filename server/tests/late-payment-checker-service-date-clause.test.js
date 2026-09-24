// Audit repro r1-timezone-1: late-payment reminder formats a pg DATE column
// (deserialized as local midnight; Railway runs TZ=UTC -> UTC midnight) in
// America/New_York, which yields the PREVIOUS calendar day.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (templateKey) => `sms body for ${templateKey}`),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/pay123'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/invoice-followups', () => ({
  hasActiveSequence: jest.fn(async () => false),
  isDunningStopped: jest.fn(async () => false),
}));
jest.mock('../services/workflows/balance-reminder', () => ({
  sendLatePaymentEmail: jest.fn(async () => ({ ok: true })),
}));

const db = require('../models/db');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const BalanceReminder = require('../services/workflows/balance-reminder');
const LatePaymentChecker = require('../services/late-payment-checker');

function chain({ result = [], first } = {}) {
  const q = {};
  q.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; });
  for (const m of ['whereIn', 'whereNull', 'whereRaw', 'whereNot', 'orWhereNot', 'orWhereNull', 'andWhere', 'limit']) q[m] = jest.fn(() => q);
  q.orWhere = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; });
  q.first = jest.fn(async () => first);
  q.insert = jest.fn(async () => undefined);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) {
      if (table === 'payment_plans') return chain({ first: undefined });
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
}

describe('audit r1-timezone-1: late-payment service_date clause', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-06T14:00:00.000Z'));
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());

  test('renders the stored calendar day (2026-09-22) in the service_date_clause', async () => {
    const invoice = {
      id: 'inv-1', customer_id: 'cust-1', token: 'token-1', invoice_number: 'WPC-2026-1042',
      status: 'sent', title: 'Quarterly Pest Control', total: '129.00',
      // pg DATE -> postgres-date getDate() -> new Date(y, m, d) in process TZ.
      // On Railway (TZ=UTC) that is exactly UTC midnight:
      service_date: new Date(Date.UTC(2026, 8, 22)),
      due_date: new Date(Date.UTC(2026, 8, 22)),
      created_at: '2026-09-22T12:00:00.000Z',
    };
    const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };
    setDbQueues({
      invoices: [
        chain({ result: [invoice] }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
      ],
      activity_log: [chain({ first: null }), chain()],
      customers: [chain({ first: customer })],
    });

    await LatePaymentChecker.checkAndNotify();

    expect(renderSmsTemplate).toHaveBeenCalled();
    const vars = renderSmsTemplate.mock.calls[0][1];
    const emailArgs = BalanceReminder.sendLatePaymentEmail.mock.calls[0]?.[0];
     
    console.log('rendered service_date_clause:', JSON.stringify(vars.service_date_clause), '| email serviceDateClause:', JSON.stringify(emailArgs?.serviceDateClause));
    expect(vars.service_date_clause).toBe(' completed on Sep 22, 2026');
  });
});
