// The Mark accepted consumer notice catch-up (GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_RECONCILE) through PostgreSQL: which
// office accepts the daily run re-sends the FDACS-13692 for (the 21-day window and its one-hour grace, the send's
// go-live floor, a delivery since the accept, the office bell, a customer's own accept, a deleted customer), that the
// re-send is the accept-time send (a signed notice or an estimate with no termite line sends nothing; an open notice is
// resent, not duplicated), and that a notice it re-sent is not sent again by the next run. Every write runs in a
// transaction that is rolled back. Synthetic data only. Skips without DATABASE_URL (CI runs it against the migrated
// database).
const SKIP = !process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The provider edge. The fake writes the email_sent event the real delivery writes, dated at the run's clock.
jest.mock('../services/document-contract-delivery', () => ({ deliverDocumentRequestChannels: (...args) => mockDeliver(...args) }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn().mockResolvedValue({ id: 'alert-1' }),
}));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { CONSUMER_NOTICE_TEMPLATE_KEY } = require('../services/consumer-notices');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const { MANUAL_ACCEPT_SOURCE, reconcileManualAcceptConsumerNotices } = require('../services/estimate-consumer-notice');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
let mockDeliver;
let techId;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A clock no other suite's rows reach, so the counts below are this suite's alone. Far past the send's go-live, so
// the 21-day window alone decides.
const NOW = new Date('2099-01-15T15:00:00Z');
const TERMITE = { result: { recurring: { services: [{ service: 'termite_bait', name: 'Termite Bait Stations' }] }, oneTime: { items: [] } } };
const PEST = { result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control' }] }, oneTime: { items: [] } } };
const GATES = ['GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND', 'GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_RECONCILE'];

describeDb('Mark accepted consumer notice catch-up (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    mockPg = database;
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    for (const gate of GATES) process.env[gate] = 'true';
    raiseAdminAlert.mockClear();
    mockDeliver = jest.fn(async (contractId) => {
      const row = await mockPg('customer_contracts').where({ id: contractId }).first('customer_id');
      await mockPg('customer_contract_events').insert({ contract_id: contractId, customer_id: row.customer_id, event_type: 'email_sent', created_at: NOW });
      return { ok: true, deliveries: [{ channel: 'email', ok: true }, { channel: 'sms', ok: true }] };
    });
    [techId] = (await mockPg('technicians').insert({ name: 'Fixture Office' }).returning('id')).map((r) => r.id);
  });
  afterEach(async () => {
    const trx = mockPg;
    mockPg = database;
    await trx.rollback();
    for (const gate of GATES) delete process.env[gate];
  });
  afterAll(async () => { if (database) await database.destroy(); });

  // ---- fixtures ----
  const customer = async (extra = {}) => (await mockPg('customers').insert({
    first_name: 'Pat', last_name: `Fixture${randomUUID().slice(0, 8)}`, email: `fixture-${randomUUID().slice(0, 8)}@example.com`,
    phone: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, ...extra,
  }).returning('id'))[0].id;
  const accepted = async (customerId, acceptedAt, { lockedBy = 'manual_accept', data = TERMITE } = {}) => (await mockPg('estimates').insert({
    customer_id: customerId, status: 'accepted', price_locked_by: lockedBy, accepted_at: acceptedAt,
    estimate_data: JSON.stringify(data), created_by_technician_id: techId,
  }).returning('id'))[0].id;
  const notice = async (customerId, extra = {}) => (await mockPg('customer_contracts').insert({
    customer_id: customerId, title: 'Florida consumer notice', contract_type: 'document_template',
    document_template_key: CONSUMER_NOTICE_TEMPLATE_KEY, status: 'sent', ...extra,
  }).returning('id'))[0].id;
  const contractEvent = (contractId, customerId, eventType, at) => mockPg('customer_contract_events')
    .insert({ contract_id: contractId, customer_id: customerId, event_type: eventType, created_at: at });
  const sentTo = async () => {
    const ids = mockDeliver.mock.calls.map(([contractId]) => contractId);
    return (await mockPg('customer_contracts').whereIn('id', ids).select('customer_id')).map((r) => r.customer_id).sort();
  };

  test('re-sends only the office accepts whose notice never went out, then not again', async () => {
    const lost = await customer();
    await accepted(lost, new Date(NOW - 3 * HOUR));

    // Delivered before the accept only: the accept's resend of the open notice is what was lost.
    const resend = await customer();
    const openNotice = await notice(resend);
    await contractEvent(openNotice, resend, 'email_sent', new Date(NOW - 5 * DAY));
    await accepted(resend, new Date(NOW - 3 * HOUR));

    const deliveredSince = await customer();
    await contractEvent(await notice(deliveredSince), deliveredSince, 'sms_sent', new Date(NOW - 2 * HOUR));
    await accepted(deliveredSince, new Date(NOW - 3 * HOUR));

    const officeTold = await customer();
    const toldEstimate = await accepted(officeTold, new Date(NOW - 3 * HOUR));
    await mockPg('notifications').insert({
      recipient_type: 'admin', category: 'estimate', title: 'Estimates — send the customer the Florida consumer notice',
      metadata: JSON.stringify({ dedupeKey: `manual-accept-consumer-notice:${toldEstimate}` }),
    });

    const customerAccept = await customer();
    await accepted(customerAccept, new Date(NOW - 3 * HOUR), { lockedBy: 'customer_accept' });
    const tooNew = await customer();
    await accepted(tooNew, new Date(NOW - 20 * MINUTE));
    const tooOld = await customer();
    await accepted(tooOld, new Date(NOW - 22 * DAY));
    const deleted = await customer({ deleted_at: new Date(NOW - DAY) });
    await accepted(deleted, new Date(NOW - 3 * HOUR));

    // Selected, and the send itself decides nothing goes out.
    const signed = await customer();
    await notice(signed, { status: 'signed', signed_at: new Date(Date.now() - 2 * DAY) });
    await accepted(signed, new Date(NOW - 3 * HOUR));
    const noTermite = await customer();
    await accepted(noTermite, new Date(NOW - 3 * HOUR), { data: PEST });

    expect(await reconcileManualAcceptConsumerNotices({ now: NOW })).toEqual({ checked: 4, sent: 2, skipped: 2, failed: 0 });
    expect(await sentTo()).toEqual([lost, resend].sort());
    // The open notice is resent, not duplicated; the lost one is issued as the accept would have issued it.
    expect(mockDeliver.mock.calls.map(([contractId]) => contractId)).toContain(openNotice);
    const issued = await mockPg('customer_contracts').where({ customer_id: lost, document_template_key: CONSUMER_NOTICE_TEMPLATE_KEY }).select('document_variables_snapshot');
    expect(issued).toHaveLength(1);
    expect(issued[0].document_variables_snapshot.estimate.source).toBe(MANUAL_ACCEPT_SOURCE);
    expect(raiseAdminAlert).not.toHaveBeenCalled();

    // The next run sees both deliveries and sends nothing.
    mockDeliver.mockClear();
    expect(await reconcileManualAcceptConsumerNotices({ now: NOW })).toEqual({ checked: 2, sent: 0, skipped: 2, failed: 0 });
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  test('never reaches an office accept from before the send went live', async () => {
    const early = new Date('2026-10-30T15:00:00Z');
    const before = await customer();
    await accepted(before, new Date('2026-10-25T15:00:00Z'));
    const after = await customer();
    await accepted(after, new Date('2026-10-27T15:00:00Z'));

    await reconcileManualAcceptConsumerNotices({ now: early });
    // Other suites' rows can share this window, so only this test's customers are compared.
    const reached = (await sentTo()).filter((id) => [before, after].includes(id));
    expect(reached).toEqual([after]);
  });

  test('sends at most `limit` a run, newest accept first', async () => {
    const older = await customer();
    await accepted(older, new Date(NOW - 5 * HOUR));
    const newer = await customer();
    await accepted(newer, new Date(NOW - 2 * HOUR));

    expect(await reconcileManualAcceptConsumerNotices({ now: NOW, limit: 1 })).toEqual({ checked: 1, sent: 1, skipped: 0, failed: 0 });
    expect(await sentTo()).toEqual([newer]);
  });

  test.each(GATES)('does nothing while %s is off', async (gate) => {
    await accepted(await customer(), new Date(NOW - 3 * HOUR));
    delete process.env[gate];
    expect(await reconcileManualAcceptConsumerNotices({ now: NOW })).toEqual({ skipped: 'gate_off' });
    expect(mockDeliver).not.toHaveBeenCalled();
  });
});
