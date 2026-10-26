// Real PostgreSQL transactions (rolled back): the office reminder before a new
// construction termite warranty renews. Names and addresses are synthetic.
// The exact marker line CI's DB-gated step greps for (.github/workflows/tests.yml); any other gate form never runs there.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
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
const { runWarrantyRenewalReminder, COMMERCIAL_AGREEMENT_KEY, _private: { alertKey, alertSpec, isoFromUs, liveKeys } } = require('../services/warranty-renewal-reminder');
const { composeAdminAlert } = require('../services/admin-alert-compose');

describe('warranty renewal reminder (pure)', () => {
  test('reads the signed MM/DD/YYYY date and composes a rule-clean office notification', () => {
    expect(isoFromUs('10/01/2027')).toBe('2027-10-01');
    expect(isoFromUs('02/30/2027')).toBeNull();
    expect(isoFromUs('13/45/2027')).toBeNull();
    expect(isoFromUs('2027-10-01')).toBeNull();
    const spec = alertSpec({ id: 'c1', customer_id: 'cust-1', day: '2027-10-01', first_name: 'Pat', last_name: 'Owner', company_name: null });
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe('Customers — send Pat Owner the termite renewal notice');
    expect(composed.why).toMatch(/renews Oct 1.*notice about 30 days before\.$/);
    expect(composed.metadata).toMatchObject({ severity: 'needs-you', doneWhen: 'renewal_notice_sent', subject: { type: 'customer', id: 'cust-1' } });
    expect(alertKey('c1', '2027-10-01')).toBe('warranty-renewal:c1:2027-10-01');
  });

  test('the commercial agreement composes its own rule-clean notification under its own key', () => {
    const spec = alertSpec({ id: 'c2', customer_id: 'cust-2', document_template_key: COMMERCIAL_AGREEMENT_KEY, day: '2027-11-15', first_name: null, last_name: null, company_name: 'Harbor Dental' });
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe('Customers — send Harbor Dental the agreement renewal notice');
    expect(composed.why).toMatch(/^Commercial agreement renews Nov 15.*30 days before\.$/);
    expect(composed.metadata).toMatchObject({ severity: 'needs-you', doneWhen: 'renewal_notice_sent', subject: { type: 'customer', id: 'cust-2' } });
    expect(alertKey('c2', '2027-11-15', COMMERCIAL_AGREEMENT_KEY)).toBe('agreement-renewal:c2:2027-11-15');
  });

  test('the commercial lane is dark by default and joins the warranty lane only with the gate on', () => {
    delete process.env.GATE_AGREEMENT_RENEWAL_REMINDER;
    expect(liveKeys()).toEqual([NEW_CONSTRUCTION_WARRANTY_KEY]);
    process.env.GATE_AGREEMENT_RENEWAL_REMINDER = 'true';
    expect(liveKeys()).toEqual([NEW_CONSTRUCTION_WARRANTY_KEY, COMMERCIAL_AGREEMENT_KEY]);
    delete process.env.GATE_AGREEMENT_RENEWAL_REMINDER;
  });
});

jest.setTimeout(30000);
postgres('warranty renewal reminder (PostgreSQL)', () => {
  let database;
  let trx;

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
  const commercial = async (customerId, { status = 'signed', signedAt = '2027-01-15T15:00:00Z', startDate = 'Set when we schedule your first visit', renewalDate = null, sentAt = null } = {}) => {
    const [row] = await trx('customer_contracts').insert({
      customer_id: customerId,
      contract_type: 'document_template',
      title: 'Commercial Pest Service Agreement',
      status,
      signed_at: status === 'signed' ? signedAt : null,
      document_template_key: COMMERCIAL_AGREEMENT_KEY,
      document_variables_snapshot: JSON.stringify({ estimate: { id: 'est-1', source: 'commercial_proposal_sign' }, agreement: { start_date: startDate } }),
      renewal_date: renewalDate,
      auto_renewal_notice_required: Boolean(renewalDate),
      auto_renewal_notice_sent_at: sentAt,
    }).returning(['id']);
    return row.id;
  };
  const visit = (customerId, scheduledDate, status = 'confirmed') => trx('scheduled_services').insert({
    customer_id: customerId, scheduled_date: scheduledDate, status, service_type: 'Commercial Pest Control',
  });

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
    delete process.env.GATE_AGREEMENT_RENEWAL_REMINDER;
    trx = await database.transaction();
    mockConnection = trx;
  });
  afterEach(async () => {
    delete process.env.GATE_AGREEMENT_RENEWAL_REMINDER;
    await trx.rollback();
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

  test('gate off: a signed commercial agreement is left alone (no date filled, no bell)', async () => {
    const id = await commercial(await customer());
    const result = await runWarrantyRenewalReminder({ conn: trx, today: '2027-12-20' });
    expect(result).toMatchObject({ filled: 0, raised: 0 });
    expect((await read(id)).day).toBeNull();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('gate on: the term anchors on the first visit on or after signing + 12 months (180 days with no visit: the signing day), and reminds 45 days out', async () => {
    process.env.GATE_AGREEMENT_RENEWAL_REMINDER = 'true';
    const withVisit = await customer();
    await visit(withVisit, '2027-01-10', 'completed'); // before signing: not the anchor
    await visit(withVisit, '2027-02-03', 'cancelled'); // cancelled: not the anchor
    await visit(withVisit, '2027-02-20'); // the first real visit after signing
    await visit(withVisit, '2027-03-20');
    const anchored = await commercial(withVisit);
    const noVisit = await customer();
    const bySigning = await commercial(noVisit, { signedAt: '2027-01-31T20:00:00Z' });
    const open = await commercial(await customer(), { status: 'viewed' });

    // No visit yet 121 days after signing: the date waits (the first visit may still be booked), quietly.
    const early = await runWarrantyRenewalReminder({ conn: trx, today: '2027-06-01' });
    expect(early).toMatchObject({ filled: 1, raised: 0 });
    expect(await read(anchored)).toMatchObject({ day: '2028-02-20', auto_renewal_notice_required: true });
    expect((await read(bySigning)).day).toBeNull();
    expect((await read(open)).day).toBeNull();

    // 182 days after signing with still no visit, the signing day anchors.
    const later = await runWarrantyRenewalReminder({ conn: trx, today: '2027-08-01' });
    expect(later).toMatchObject({ filled: 1, raised: 0 });
    expect(await read(bySigning)).toMatchObject({ day: '2028-01-31', auto_renewal_notice_required: true });

    const due = await runWarrantyRenewalReminder({ conn: trx, today: '2028-01-08' });
    expect(due).toMatchObject({ filled: 0, raised: 2 });
    const calls = NotificationService.notifyAdmin.mock.calls;
    expect(calls.map(([, headline]) => headline)).toEqual(expect.arrayContaining([
      'Customers — send Sample Owner the agreement renewal notice',
    ]));
    expect(calls.map(([, , , opts]) => opts.dedupeKey)).toEqual(expect.arrayContaining([
      alertKey(anchored, '2028-02-20', COMMERCIAL_AGREEMENT_KEY), alertKey(bySigning, '2028-01-31', COMMERCIAL_AGREEMENT_KEY),
    ]));
    expect(calls.every(([, , why]) => /Commercial agreement renews .*30 days before\.$/.test(why))).toBe(true);
  });

  test('gate on: a start date staff typed at issue anchors the term ahead of any visit; the proposal placeholder waits for the visit', async () => {
    process.env.GATE_AGREEMENT_RENEWAL_REMINDER = 'true';
    const owner = await customer();
    await visit(owner, '2027-02-20');
    const isoTyped = await commercial(owner, { startDate: '2027-03-01' });
    const usTyped = await commercial(await customer(), { startDate: '03/15/2027' });
    const notADate = await commercial(await customer(), { startDate: '2027-02-30' });
    const result = await runWarrantyRenewalReminder({ conn: trx, today: '2027-06-01' });
    expect(result).toMatchObject({ filled: 2, raised: 0 });
    expect((await read(isoTyped)).day).toBe('2028-03-01');
    expect((await read(usTyped)).day).toBe('2028-03-15');
    // Not a real date: read like the placeholder, so it waits for a first visit.
    expect((await read(notADate)).day).toBeNull();
  });

  test('gate on: a notice marked sent or a cancelled agreement closes its reminder, and a passed term rolls a year', async () => {
    process.env.GATE_AGREEMENT_RENEWAL_REMINDER = 'true';
    const sent = await commercial(await customer(), { renewalDate: '2028-02-20', sentAt: new Date('2028-01-10T15:00:00Z') });
    const cancelled = await commercial(await customer(), { status: 'cancelled', renewalDate: '2028-02-20' });
    const passed = await commercial(await customer(), { renewalDate: '2027-11-01', sentAt: new Date('2027-09-20T15:00:00Z') });
    const result = await runWarrantyRenewalReminder({ conn: trx, today: '2028-01-12' });
    expect(result).toMatchObject({ rolled: 1, raised: 0 });
    expect(await read(passed)).toMatchObject({ day: '2028-11-01', auto_renewal_notice_sent_at: null });
    const closedKeys = closeAdminAlertKeys.mock.calls.flatMap(([, keys]) => keys);
    expect(closedKeys).toEqual(expect.arrayContaining([
      alertKey(sent, '2028-02-20', COMMERCIAL_AGREEMENT_KEY), alertKey(cancelled, '2028-02-20', COMMERCIAL_AGREEMENT_KEY), alertKey(passed, '2027-11-01', COMMERCIAL_AGREEMENT_KEY),
    ]));
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});
