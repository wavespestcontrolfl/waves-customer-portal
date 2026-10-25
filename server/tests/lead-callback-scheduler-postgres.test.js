// CI's DB-gated pass runs this against PostgreSQL: the booked-call
// scheduler (services/lead-callback-scheduler.js) — the 15-minute reminder,
// the ring at the booked time, one ring at a time, the late hand-off, and the
// 8 AM no-answer bell. The ring itself (placeRing), the text send and the
// bell write are mocked; each bell spec passes the real notification rule.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({ withSmsConsentLock: (conn, _keys, work) => conn.transaction(work) }));
jest.mock('../services/admin-alert-compose', () => ({ ...jest.requireActual('../services/admin-alert-compose'), raiseAdminAlert: jest.fn(async () => ({ id: 'n1' })) }));
const mockPlaceRing = jest.fn();
jest.mock('../services/lead-call-reply-ring', () => ({
  ...jest.requireActual('../services/lead-call-reply-ring'),
  placeRing: (...args) => mockPlaceRing(...args),
}));

const { isEnabled } = require('../config/feature-gates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');
const { runLeadCallbackTick, _test } = require('../services/lead-callback-scheduler');

const bellSpecs = () => raiseAdminAlert.mock.calls.map(([, spec]) => { composeAdminAlert(spec); return spec; });
const REAL_SEND = { sent: true, providerMessageId: 'SM_real_sid', deliveryOutcome: 'accepted' };
// 9:55 AM EDT Oct 21, 2026; the slot is 10:00 AM.
const SLOT = new Date('2026-10-21T14:00:00Z');
const BEFORE = new Date('2026-10-21T13:50:00Z');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('lead callback scheduler on PostgreSQL', () => {
  let database;
  const schema = `lead_cb_sched_${randomUUID().replaceAll('-', '')}`;
  const tables = ['customers', 'leads', 'call_log', 'lead_callback_requests'];

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    const t = `"${schema}".lead_callback_requests`;
    await database.raw(`ALTER TABLE ${t} ALTER COLUMN id SET DEFAULT gen_random_uuid(), ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN updated_at SET DEFAULT now()`);
    mockConn = database;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockImplementation(() => true);
    sendCustomerMessage.mockResolvedValue(REAL_SEND);
    mockPlaceRing.mockResolvedValue({ rang: true, reason: 'rang', callLogId: randomUUID() });
  });
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  async function booked({ phone = '+19415550100', at = SLOT, state = 'scheduled', extra = {} } = {}) {
    const customer = { id: randomUUID(), first_name: 'Pat', last_name: 'Sample', phone, pipeline_stage: 'new_lead' };
    await database('customers').insert(customer);
    const [row] = await database('lead_callback_requests').insert({
      customer_id: customer.id, lead_id: randomUUID(), phone, kind: 'call_request', state,
      send_outcome: 'sent', target_date: '2026-10-21', scheduled_for: state === 'scheduled' ? at : null, ...extra,
    }).returning('*');
    return { customer, row };
  }
  const rowNow = async (id) => database('lead_callback_requests').where({ id }).first();

  test('15 minutes before: one owner bell and one lead reminder, never twice', async () => {
    const { row } = await booked();
    await runLeadCallbackTick({ now: BEFORE });
    await runLeadCallbackTick({ now: new Date(BEFORE.getTime() + 60000) });
    expect(bellSpecs()).toHaveLength(1);
    expect(bellSpecs()[0]).toMatchObject({ action: 'call Pat Sample at 10:00 AM', why: 'Booked call in 15 minutes; your cell rings at 10:00 AM with press 1.' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].body).toBe("Hi Pat, Adam from Waves here. I'll call you in about 15 minutes.");
    expect((await rowNow(row.id)).reminded_at).not.toBeNull();
  });

  test('an 8:00 slot reminds the owner at 7:50 but never texts the lead before 8 AM', async () => {
    await booked({ at: new Date('2026-10-21T12:00:00Z') });
    await runLeadCallbackTick({ now: new Date('2026-10-21T11:50:00Z') });
    expect(bellSpecs()).toHaveLength(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('at the booked time the press-1 ring goes once and the row closes', async () => {
    const { row } = await booked();
    const callLogId = randomUUID();
    mockPlaceRing.mockResolvedValueOnce({ rang: true, reason: 'rang', callLogId });
    await runLeadCallbackTick({ now: new Date(SLOT.getTime() + 30000) });
    await runLeadCallbackTick({ now: new Date(SLOT.getTime() + 90000) });
    expect(mockPlaceRing).toHaveBeenCalledTimes(1);
    expect(mockPlaceRing.mock.calls[0][0]).toMatchObject({ fromPhone: '+19415550100' });
    expect(await rowNow(row.id)).toMatchObject({ state: 'done', ring_call_log_id: callLogId });
  });

  test('one ring at a time: a live lead ring makes the next one wait a tick', async () => {
    const { row } = await booked();
    await database('call_log').insert({ id: randomUUID(), source: 'lead-call-reply-ring', direction: 'outbound', status: 'ringing', to_phone: '+19415550199', from_phone: '+19412975749', created_at: SLOT });
    await runLeadCallbackTick({ now: new Date(SLOT.getTime() + 30000) });
    expect(mockPlaceRing).not.toHaveBeenCalled();
    expect((await rowNow(row.id)).ring_claimed_at).toBeNull();
  });

  test('a ring more than 30 minutes late goes to the owner instead', async () => {
    const { row } = await booked();
    await runLeadCallbackTick({ now: new Date(SLOT.getTime() + 31 * 60000) });
    expect(mockPlaceRing).not.toHaveBeenCalled();
    expect((await rowNow(row.id)).state).toBe('needs_owner');
    expect(bellSpecs().map((s) => s.why)).toContain('Booked for 10:00 AM; the ring did not start in time.');
  });

  test('8 AM: an unanswered night question raises one bell; before 8 nothing', async () => {
    const { row } = await booked({ state: 'asked' });
    await runLeadCallbackTick({ now: new Date('2026-10-21T11:30:00Z') });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    await runLeadCallbackTick({ now: new Date('2026-10-21T12:05:00Z') });
    await runLeadCallbackTick({ now: new Date('2026-10-21T12:06:00Z') });
    expect(bellSpecs()).toEqual([expect.objectContaining({ action: 'call Pat Sample back', why: 'Asked for a call after hours and never sent a time.' })]);
    expect((await rowNow(row.id)).state).toBe('needs_owner');
  });

  test('a lead who became a customer is not rung', async () => {
    const { customer } = await booked();
    await expect(_test.bookedRingBlocker({ customer: { ...customer, pipeline_stage: 'active_customer' }, digits: '9415550100', now: SLOT }, database))
      .resolves.toBe('existing_customer');
  });

  test('gate off: nothing is read', async () => {
    isEnabled.mockImplementation(() => false);
    await expect(runLeadCallbackTick({ now: SLOT })).resolves.toEqual({ skipped: 'gate_off' });
  });
});
