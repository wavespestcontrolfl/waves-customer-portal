jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-stages', () => ({ whereLiveCustomer: jest.fn() }));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(),
}));
jest.mock('../utils/portal-url', () => ({
  portalUrl: jest.fn((path) => `https://portal.test${path}`),
}));
jest.mock('../utils/datetime-et', () => ({
  addETDays: jest.fn((d) => d),
  etDateString: jest.fn(() => '2026-08-11'), // frozen min effective date
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));

const db = require('../models/db');
const { getInvoiceEmailRecipients } = require('../services/customer-contact');
const { sendTemplate } = require('../services/email-template-library');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { previewPriceChange, createAndSendBatch } = require('../services/price-change-notices');

let customerRows;
let noticeInserts;
let noticeUpdates;
let activityInserts;
let customersUpdateCalls;

function customersQuery() {
  const q = {
    modify: jest.fn((fn) => { fn(q); return q; }),
    where: jest.fn(() => q),
    whereRaw: jest.fn(() => q),
    whereNull: jest.fn(() => q),
    orWhere: jest.fn(() => q),
    select: jest.fn(() => q),
    orderBy: jest.fn(() => q),
    update: jest.fn((...args) => { customersUpdateCalls.push(args); return Promise.resolve(1); }),
    then: (resolve, reject) => Promise.resolve(customerRows).then(resolve, reject),
  };
  return q;
}

function noticesQuery() {
  const q = {
    insert: jest.fn((row) => {
      noticeInserts.push(row);
      return { returning: jest.fn(async () => [{ id: `n-${noticeInserts.length}`, batch_id: row.batch_id }]) };
    }),
    where: jest.fn(() => q),
    update: jest.fn(async (patch) => { noticeUpdates.push(patch); return 1; }),
  };
  return q;
}

function prefsQuery() {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
  return q;
}

function activityQuery() {
  return { insert: jest.fn(async (row) => { activityInserts.push(row); return [1]; }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  customerRows = [];
  noticeInserts = [];
  noticeUpdates = [];
  activityInserts = [];
  customersUpdateCalls = [];
  db.mockImplementation((table) => {
    if (table === 'customers') return customersQuery();
    if (table === 'price_change_notices') return noticesQuery();
    if (table === 'notification_prefs') return prefsQuery();
    if (table === 'activity_log') return activityQuery();
    throw new Error(`unexpected table ${table}`);
  });
  getInvoiceEmailRecipients.mockImplementation((customer) => [
    { email: customer.email, name: customer.first_name },
  ]);
  sendTemplate.mockResolvedValue({ sent: true });
  renderSmsTemplate.mockResolvedValue('rendered sms body');
  sendCustomerMessage.mockResolvedValue({ sent: true });
});

const CUSTOMER = {
  id: 'c-1',
  first_name: 'Pat',
  last_name: 'Lee',
  email: 'pat@example.com',
  phone: '+19415550001',
  monthly_rate: '49',
};

const GOOD_ARGS = {
  increase: { type: 'amount', value: 3 },
  effectiveDate: '2026-08-15',
  expectedCount: 1,
  actorId: 'admin-1',
};

describe('previewPriceChange', () => {
  it('computes current → new per customer and flags reachability', async () => {
    customerRows = [CUSTOMER, { ...CUSTOMER, id: 'c-2', email: '', phone: '', monthly_rate: '100' }];
    const out = await previewPriceChange({ increase: { type: 'percent', value: 5 } });
    expect(out.count).toBe(2);
    expect(out.rows[0]).toMatchObject({ current: '$49', next: '$51.45', hasEmail: true, hasPhone: true });
    expect(out.rows[1]).toMatchObject({ current: '$100', next: '$105', hasEmail: false, hasPhone: false });
    expect(out.invalidCount).toBe(0);
  });

  it('counts customers a negative adjustment would take to $0 or below', async () => {
    customerRows = [{ ...CUSTOMER, monthly_rate: '20' }];
    const out = await previewPriceChange({ increase: { type: 'amount', value: -25 } });
    expect(out.invalidCount).toBe(1);
  });

  it('rejects zero, out-of-range, and malformed adjustments', async () => {
    await expect(previewPriceChange({ increase: { type: 'amount', value: 0 } })).rejects.toThrow(/non-zero/);
    await expect(previewPriceChange({ increase: { type: 'percent', value: 150 } })).rejects.toThrow(/between/);
    await expect(previewPriceChange({ increase: { type: 'visits', value: 5 } })).rejects.toThrow(/percent or amount/);
    await expect(previewPriceChange({ increase: { type: 'amount', value: 3 }, locationId: 'tampa' })).rejects.toThrow(/known location/);
  });
});

describe('createAndSendBatch policy gates', () => {
  it('enforces the 30-day advance-notice policy', async () => {
    customerRows = [CUSTOMER];
    await expect(createAndSendBatch({ ...GOOD_ARGS, effectiveDate: '2026-08-10' }))
      .rejects.toThrow(/at least 30 days/);
    expect(noticeInserts).toHaveLength(0);
  });

  it('accepts the exact minimum date', async () => {
    customerRows = [CUSTOMER];
    const out = await createAndSendBatch({ ...GOOD_ARGS, effectiveDate: '2026-08-11' });
    expect(out.created).toBe(1);
  });

  it('refuses on count drift without sending', async () => {
    customerRows = [CUSTOMER, { ...CUSTOMER, id: 'c-2' }];
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedCount: 1 });
    expect(out).toMatchObject({ ok: false, reason: 'count_drift', count: 2 });
    expect(noticeInserts).toHaveLength(0);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('refuses when any customer would land at $0 or below', async () => {
    customerRows = [{ ...CUSTOMER, monthly_rate: '2' }];
    const out = await createAndSendBatch({ ...GOOD_ARGS, increase: { type: 'amount', value: -2 } });
    expect(out).toMatchObject({ ok: false, reason: 'invalid_amounts' });
    expect(noticeInserts).toHaveLength(0);
  });
});

describe('createAndSendBatch delivery', () => {
  it('creates a tokened notice row and sends both legs with the notice URL', async () => {
    customerRows = [CUSTOMER];
    const out = await createAndSendBatch(GOOD_ARGS);
    expect(out).toMatchObject({ ok: true, created: 1, emailed: 1, texted: 1, unreachable: 0, failed: 0 });

    expect(noticeInserts).toHaveLength(1);
    const row = noticeInserts[0];
    expect(row.notice_token).toMatch(/^[a-f0-9]{32}$/);
    expect(row).toMatchObject({ current_amount_cents: 4900, new_amount_cents: 5200, status: 'draft' });

    const emailArgs = sendTemplate.mock.calls[0][0];
    expect(emailArgs.templateKey).toBe('billing.price_change_notice');
    expect(emailArgs.idempotencyKey).toBe(`price_change:${row.batch_id}:c-1`);
    expect(emailArgs.payload.price_change_url).toBe(`https://portal.test/price-change/${row.notice_token}`);
    expect(emailArgs.payload).toMatchObject({ current_price: '$49', new_price: '$52' });

    const smsArgs = sendCustomerMessage.mock.calls[0][0];
    expect(smsArgs).toMatchObject({ purpose: 'billing', customerId: 'c-1', hasEmailLeg: true });

    expect(noticeUpdates[0]).toMatchObject({ email_sent: true, sms_sent: true, status: 'sent' });
    expect(activityInserts).toHaveLength(1);
    expect(activityInserts[0].action).toBe('price_change_batch_sent');
  });

  it('never modifies monthly_rate — notices only', async () => {
    customerRows = [CUSTOMER];
    await createAndSendBatch(GOOD_ARGS);
    expect(customersUpdateCalls).toHaveLength(0);
  });

  it('does not declare an email leg to the SMS gate when the email did not send', async () => {
    customerRows = [{ ...CUSTOMER, email: '' }];
    getInvoiceEmailRecipients.mockReturnValue([]);
    await createAndSendBatch(GOOD_ARGS);
    expect(sendCustomerMessage.mock.calls[0][0].hasEmailLeg).toBe(false);
  });

  it('counts customers with neither leg delivered as unreachable, still keeping the notice row', async () => {
    customerRows = [{ ...CUSTOMER, email: '', phone: '' }];
    getInvoiceEmailRecipients.mockReturnValue([]);
    const out = await createAndSendBatch(GOOD_ARGS);
    expect(out).toMatchObject({ ok: true, created: 1, emailed: 0, texted: 0, unreachable: 1 });
    expect(noticeUpdates[0]).toMatchObject({ email_sent: false, sms_sent: false, status: 'sent' });
  });

  it('reports ok:false when a send throws, without losing the rest of the batch', async () => {
    customerRows = [CUSTOMER, { ...CUSTOMER, id: 'c-2', email: 'two@example.com' }];
    let call = 0;
    db.mockImplementation((table) => {
      if (table === 'customers') return customersQuery();
      if (table === 'price_change_notices') {
        call += 1;
        if (call === 1) {
          return { insert: jest.fn(() => { throw new Error('insert boom'); }) };
        }
        return noticesQuery();
      }
      if (table === 'notification_prefs') return prefsQuery();
      if (table === 'activity_log') return activityQuery();
      throw new Error(`unexpected table ${table}`);
    });
    const out = await createAndSendBatch({ ...GOOD_ARGS, expectedCount: 2 });
    expect(out).toMatchObject({ ok: false, created: 1, failed: 1 });
    expect(activityInserts).toHaveLength(1);
  });
});
