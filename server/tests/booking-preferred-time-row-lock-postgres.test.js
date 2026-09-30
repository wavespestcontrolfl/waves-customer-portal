/**
 * The preferred-time submit and the abandoned-booking recovery worker meet on
 * ONE thing — the booking_intents ROW — proven against real PostgreSQL row
 * locks (skipped without DATABASE_URL, like the other *-postgres suites).
 *
 *   - worker first: SELECT ... FOR UPDATE held across the send; the submit's
 *     suppression UPDATE waits for it (the send counts as already happened);
 *   - submit first: the worker's FOR UPDATE waits for the submit's commit, then
 *     re-reads the row as suppressed and sends nothing;
 *   - one intent row per SESSION: a visitor who corrected phone A -> B is still
 *     found (the lock is on the row, not on a phone key);
 *   - the lead + its funnel row commit or roll back together, and the
 *     suppression rolls back with them (fail closed, nothing half-written);
 *   - a refresh of an open lead that staff closed in the meantime becomes a NEW
 *     lead instead of writing onto the closed one.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/experimentation/growthbook', () => ({ assignBookingRecoveryExperiment: jest.fn() }));
jest.mock('../services/lead-source-resolver', () => ({ resolveLeadSource: jest.fn(async () => ({ leadSourceId: null })) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({})) }));
const mockStamp = jest.fn();
jest.mock('../services/lead-funnel-bridge', () => ({ stampLeadFunnelRow: (...a) => mockStamp(...a) }));

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('preferred-time submit vs recovery worker on PostgreSQL (intent row lock)', () => {
  const schema = `pt_rowlock_${randomUUID().replaceAll('-', '')}`;
  let database;
  let recordPreferredTimeRequest;
  let withLockedRecoveryIntent;

  const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
  const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const settled = (p) => { const s = { done: false }; p.then(() => { s.done = true; }, () => { s.done = true; }); return s; };

  const value = (extra = {}) => ({
    firstName: 'Pat', lastName: 'Sample', phone: '9415550100', email: null, addressLine1: null, city: null, state: null, zip: null,
    preferredDate: '2099-01-05', secondDate: null, timeOfDay: 'morning', note: null, sessionId: null, attribution: null, ...extra,
  });
  const intent = async (over = {}) => {
    const id = randomUUID();
    await database('booking_intents').insert({ id, phone: '+19415550100', session_id: null, ...over });
    return { id, phone: '+19415550100', ...over };
  };
  const intentRow = (id) => database('booking_intents').where({ id }).first();

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 8 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`CREATE TABLE ??.booking_intents (
      id uuid PRIMARY KEY, session_id text, phone text NOT NULL, suppressed boolean DEFAULT false,
      converted_at timestamptz, captured_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`, [schema]);
    await database.raw(`CREATE TABLE ??.leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_name text, last_name text, phone text, email text, address text, city text, zip text,
      lead_type text, service_interest text, first_contact_at timestamptz, first_contact_channel text, status text, is_residential boolean,
      transcript_summary text, extracted_data jsonb, lead_source_id uuid, gclid text, wbraid text, gbraid text, fbclid text, fbc text, fbp text,
      converted_at timestamptz, deleted_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`, [schema]);
    await database.raw('CREATE TABLE ??.funnel_rows (lead_id uuid PRIMARY KEY)', [schema]);
    ({ recordPreferredTimeRequest } = require('../services/booking-preferred-time'));
    ({ _internals: { withLockedRecoveryIntent } } = require('../services/booking-abandon-recovery'));
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });
  beforeEach(async () => {
    await database('leads').del();
    await database('booking_intents').del();
    await database('funnel_rows').del();
    mockStamp.mockReset();
    mockStamp.mockImplementation(async (handle, lead) => { await handle('funnel_rows').insert({ lead_id: lead.id }); return lead.id; });
  });

  test('worker first: the submit waits for the send to finish, then suppresses (the send counts as already happened)', async () => {
    const it = await intent();
    const sendGate = gate();
    const sends = [];
    const worker = withLockedRecoveryIntent(database, it, async () => { sends.push('send'); await sendGate.p; return { sent: true }; });
    await tick();
    expect(sends).toEqual(['send']);
    const submit = recordPreferredTimeRequest(database, value(), { notify: false });
    const submitState = settled(submit);
    await tick();
    expect(submitState.done).toBe(false); // parked on the intent row
    sendGate.open();
    expect((await worker).skipped).toBeNull();
    await submit;
    expect((await intentRow(it.id)).suppressed).toBe(true);
    expect(await database('leads').count('* as n').first()).toMatchObject({ n: '1' });
  });

  test('submit first: the worker waits for the commit, re-reads the row suppressed, and never sends', async () => {
    const it = await intent();
    const slow = gate();
    // The submit is mid-transaction (intent already suppressed-but-uncommitted, lead written) while its funnel stamp is slow.
    mockStamp.mockImplementation(async (handle, lead) => { await slow.p; await handle('funnel_rows').insert({ lead_id: lead.id }); });
    const submit = recordPreferredTimeRequest(database, value(), { notify: false });
    await tick();
    let sent = false;
    const worker = withLockedRecoveryIntent(database, it, async () => { sent = true; return { sent: true }; });
    const workerState = settled(worker);
    await tick();
    expect(workerState.done).toBe(false); // parked on the row lock
    slow.open();
    await submit;
    const out = await worker;
    expect(out).toEqual({ skipped: 'closed' });
    expect(sent).toBe(false);
  });

  test('phone corrected A -> B in one session: the submit under phone B suppresses the SAME session row the worker holds', async () => {
    const it = await intent({ phone: '+19415550199', session_id: 'sess-1' }); // worker read phone A
    const sendGate = gate();
    const worker = withLockedRecoveryIntent(database, { ...it, phone: '+19415550199' }, async () => { await sendGate.p; return { sent: true }; });
    await tick();
    const submit = recordPreferredTimeRequest(database, value({ phone: '9415550100', sessionId: 'sess-1' }), { notify: false });
    const submitState = settled(submit);
    await tick();
    expect(submitState.done).toBe(false); // serialized on the row even though the phones differ
    sendGate.open();
    await worker;
    await submit;
    expect((await intentRow(it.id)).suppressed).toBe(true);
  });

  test('funnel-row failure rolls the whole submit back: no lead, and the intent is NOT suppressed', async () => {
    const it = await intent();
    mockStamp.mockRejectedValue(new Error('funnel insert failed'));
    await expect(recordPreferredTimeRequest(database, value(), { notify: false })).rejects.toThrow('funnel insert failed');
    expect(await database('leads').count('* as n').first()).toMatchObject({ n: '0' });
    expect((await intentRow(it.id)).suppressed).toBe(false);
  });

  test('lead and its funnel row commit together', async () => {
    const out = await recordPreferredTimeRequest(database, value(), { notify: false });
    expect(out.created).toBe(true);
    expect(await database('funnel_rows').where({ lead_id: out.leadId }).first()).toBeTruthy();
  });

  test('a refresh whose target staff closed since the lookup becomes a NEW lead; the closed one is untouched', async () => {
    const first = await recordPreferredTimeRequest(database, value({ firstName: 'Original' }), { notify: false });
    const staff = await database.transaction(async (trx) => {
      await trx('leads').where({ id: first.leadId }).update({ status: 'lost' });
      const second = recordPreferredTimeRequest(database, value({ firstName: 'Refreshed' }), { notify: false });
      const state = settled(second);
      await tick(300);
      expect(state.done).toBe(false); // its UPDATE is parked on the row staff is closing
      return { second };
    });
    const out = await staff.second;
    expect(out.created).toBe(true);
    expect(out.leadId).not.toBe(first.leadId);
    const closed = await database('leads').where({ id: first.leadId }).first();
    expect(closed).toMatchObject({ status: 'lost', first_name: 'Original' });
    expect(await database('leads').count('* as n').first()).toMatchObject({ n: '2' });
  });
});
