// Real PostgreSQL transactions (rolled back): the office reminder before a new
// construction termite warranty renews. Names and addresses are synthetic.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: jest.fn(async (_conn, keys) => keys.length) }));

const { randomUUID } = require('node:crypto');
const NotificationService = require('../services/notification-service');
const { closeAdminAlertKeys } = require('../services/admin-alert-episodes');
const { NEW_CONSTRUCTION_WARRANTY_KEY } = require('../services/new-construction-warranty');
const { runWarrantyRenewalReminder, _private: { alertKey, alertSpec, isoFromUs } } = require('../services/warranty-renewal-reminder');
const { composeAdminAlert } = require('../services/admin-alert-compose');

describe('warranty renewal reminder (pure)', () => {
  const OLD = process.env.GATE_WARRANTY_RENEWAL_REMINDER;
  afterEach(() => { if (OLD === undefined) delete process.env.GATE_WARRANTY_RENEWAL_REMINDER; else process.env.GATE_WARRANTY_RENEWAL_REMINDER = OLD; });

  test('off: the job returns before any query', async () => {
    delete process.env.GATE_WARRANTY_RENEWAL_REMINDER;
    const conn = jest.fn(() => { throw new Error('must not query'); });
    await expect(runWarrantyRenewalReminder({ conn, today: '2027-08-20' })).resolves.toEqual({ skipped: 'gated' });
    expect(conn).not.toHaveBeenCalled();
  });

  test('reads the signed MM/DD/YYYY date and composes a rule-clean office notification', () => {
    expect(isoFromUs('10/01/2027')).toBe('2027-10-01');
    expect(isoFromUs('02/30/2027')).toBeNull();
    expect(isoFromUs('2027-10-01')).toBeNull();
    const spec = alertSpec({ id: 'c1', customer_id: 'cust-1', day: '2027-10-01', first_name: 'Pat', last_name: 'Owner', company_name: null });
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe('Customers — send Pat Owner the termite renewal notice');
    expect(composed.why).toMatch(/renews Oct 1.*notice about 30 days before\.$/);
    expect(composed.metadata).toMatchObject({ severity: 'needs-you', doneWhen: 'renewal_notice_sent', subject: { type: 'customer', id: 'cust-1' } });
    expect(alertKey('c1', '2027-10-01')).toBe('warranty-renewal:c1:2027-10-01');
  });
});

jest.setTimeout(30000);
postgres('warranty renewal reminder (PostgreSQL)', () => {
  let database;
  let trx;
  const OLD = process.env.GATE_WARRANTY_RENEWAL_REMINDER;

  const customer = async () => {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Sample', last_name: 'Owner', phone: '+19415550142', email: `${id}@example.invalid` });
    return id;
  };
  const warranty = async (customerId, { status = 'signed', renewalDue = '10/01/2027', renewalDate = null, sentAt = null } = {}) => {
    const [row] = await trx('customer_contracts').insert({
      customer_id: customerId,
      contract_type: 'document_template',
      title: 'New Construction Termite Warranty',
      status,
      document_template_key: NEW_CONSTRUCTION_WARRANTY_KEY,
      document_variables_snapshot: JSON.stringify({ warranty: { number: 'NCW-TEST', renewal_due: renewalDue } }),
      renewal_date: renewalDate,
      auto_renewal_notice_required: Boolean(renewalDate),
      auto_renewal_notice_sent_at: sentAt,
    }).returning(['id']);
    return row.id;
  };
  const read = (id) => trx('customer_contracts').where({ id })
    .first(trx.raw("to_char(renewal_date, 'YYYY-MM-DD') as day"), 'auto_renewal_notice_required', 'auto_renewal_notice_sent_at');

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_WARRANTY_RENEWAL_REMINDER = 'true';
    trx = await database.transaction();
    mockConnection = trx;
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD === undefined) delete process.env.GATE_WARRANTY_RENEWAL_REMINDER; else process.env.GATE_WARRANTY_RENEWAL_REMINDER = OLD;
  });
  afterAll(async () => { await database?.destroy(); });

  test('fills the renewal date from the signed text and reminds once, 45 days out', async () => {
    const owner = await customer();
    const id = await warranty(owner);
    const draft = await warranty(await customer(), { status: 'draft' });

    const early = await runWarrantyRenewalReminder({ conn: trx, today: '2027-08-01' });
    expect(early).toMatchObject({ filled: 1, raised: 0 });
    expect(await read(id)).toMatchObject({ day: '2027-10-01', auto_renewal_notice_required: true });
    expect((await read(draft)).day).toBeNull();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();

    const due = await runWarrantyRenewalReminder({ conn: trx, today: '2027-08-17' });
    expect(due).toMatchObject({ filled: 0, raised: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('customer');
    expect(headline).toBe('Customers — send Sample Owner the termite renewal notice');
    expect(why).toMatch(/renews Oct 1/);
    expect(opts).toMatchObject({ bell: true, dedupeKey: alertKey(id, '2027-10-01'), link: `/admin/customers?customerId=${owner}` });
  });

  test('a notice marked sent or a cancelled warranty closes the reminder and raises no new one', async () => {
    const sent = await warranty(await customer(), { renewalDate: '2027-10-01', sentAt: new Date('2027-08-20T15:00:00Z') });
    const cancelled = await warranty(await customer(), { status: 'cancelled', renewalDate: '2027-10-01' });
    const result = await runWarrantyRenewalReminder({ conn: trx, today: '2027-08-25' });
    expect(result.raised).toBe(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    const closedKeys = closeAdminAlertKeys.mock.calls.flatMap(([, keys]) => keys);
    expect(closedKeys).toEqual(expect.arrayContaining([alertKey(sent, '2027-10-01'), alertKey(cancelled, '2027-10-01')]));
  });

  test('a passed renewal date moves to next year, clears "notice sent" and closes last year\'s reminder', async () => {
    const id = await warranty(await customer(), { renewalDate: '2027-10-01', sentAt: new Date('2027-08-20T15:00:00Z') });
    const leap = await warranty(await customer(), { renewalDate: '2028-02-29' });
    const result = await runWarrantyRenewalReminder({ conn: trx, today: '2029-03-05' });
    expect(result.rolled).toBe(2);
    expect(await read(id)).toMatchObject({ day: '2029-10-01', auto_renewal_notice_sent_at: null });
    expect((await read(leap)).day).toBe('2030-02-28');
    const closedKeys = closeAdminAlertKeys.mock.calls.flatMap(([, keys]) => keys);
    expect(closedKeys).toEqual(expect.arrayContaining([alertKey(id, '2027-10-01'), alertKey(leap, '2028-02-29')]));
  });

  test('an anniversary that falls today is kept, and a warranty cancelled after its date still closes its reminder', async () => {
    const today = await warranty(await customer(), { renewalDate: '2027-10-01' });
    const ended = await warranty(await customer(), { status: 'cancelled', renewalDate: '2027-10-01' });
    const result = await runWarrantyRenewalReminder({ conn: trx, today: '2029-10-01' });
    expect((await read(today)).day).toBe('2029-10-01');
    expect((await read(ended)).day).toBe('2027-10-01');
    expect(result.raised).toBe(1);
    const closedKeys = closeAdminAlertKeys.mock.calls.flatMap(([, keys]) => keys);
    expect(closedKeys).toEqual(expect.arrayContaining([alertKey(today, '2027-10-01'), alertKey(ended, '2027-10-01')]));
  });
});
