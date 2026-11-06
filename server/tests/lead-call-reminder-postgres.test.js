/**
 * The lead call-back reminder against live Postgres, the SQL as the sweep runs it (GATE_LEAD_CALL_REMINDER): an open
 * "Missed call request" or night call-back bell one business hour old, with nobody reaching the lead since, is stamped
 * once and sends one banner; the next sweep sends nothing. A person's text or Gmail send after the bell, a young bell,
 * an old bell, a closed bell and another kind of lead bell send nothing, and a row changed since it was read is not
 * stamped. The rules themselves are covered by lead-call-reminder.test.js.
 */
const crypto = require('crypto');

jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: false, push: { sent: 1 } })) }));

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

// The first test opens the first connection; on a loaded machine that alone can pass jest's 5 s default.
jest.setTimeout(60000);

const MIN = 60 * 1000;
// 3:00 PM ET on a weekday, inside the 8 AM to 8 PM send hours (EST, UTC-5). Every row's time is set from it.
const NOW = new Date('2026-11-05T15:00:00-05:00');

maybeDescribe('lead call-back reminder (live Postgres)', () => {
  let db;
  let reminder;
  let relevance;
  let triggerNotification;
  const made = { notifications: [], sms_log: [], emails: [], leads: [], customers: [] };
  const BIZ = '+15555559300';
  let n = 0;
  let phoneN = 9300;
  const sid = (prefix) => `${prefix}${String(Date.now()).slice(-8)}${String((n += 1)).padStart(6, '0')}`;
  const mins = (m) => new Date(NOW.getTime() + m * MIN);

  beforeAll(() => {
    db = require('../models/db');
    reminder = require('../services/lead-call-reminder');
    relevance = require('../services/admin-alert-relevance');
    ({ triggerNotification } = require('../services/notification-triggers'));
  });
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_LEAD_CALL_REMINDER = 'true';
  });
  afterEach(() => { delete process.env.GATE_LEAD_CALL_REMINDER; });
  afterAll(async () => {
    for (const table of ['notifications', 'sms_log', 'emails', 'leads', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
    await db.destroy();
  }, 120000);

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };
  const customerWith = () => insert('customers', { first_name: 'Lead', last_name: 'Sample', phone: `+1555555${phoneN += 1}`, email: `lead${phoneN}-${Date.now()}@example.invalid` });
  const leadFor = (customer, over = {}) => insert('leads', { customer_id: customer.id, phone: customer.phone, first_name: 'Lead', last_name: 'Sample', status: 'new', ...over });
  // The bell lead-call-reply-ring.js raiseMissedBell writes (category lead, doneWhen lead_contacted, a key per ring).
  const bell = ({ lead, customer, at, key = `lead-call-reply-missed:${crypto.randomUUID()}`, over = {} }) => insert('notifications', {
    recipient_type: 'admin', category: 'lead', title: 'Leads — call Lead Sample back',
    body: 'Missed call request: Lead replied CALL to our lead text and nobody pressed 1.', link: `/admin/leads?lead=${lead.id}`,
    created_at: at,
    metadata: JSON.stringify({ dedupeKey: key, leadId: lead.id, customerId: customer.id, area: 'Leads', severity: 'needs-you', subject: { type: 'lead', id: lead.id }, doneWhen: 'lead_contacted', who: 'person' }),
    ...over,
  });
  const staffText = (customer, at, over = {}) => insert('sms_log', { direction: 'outbound', from_phone: BIZ, to_phone: customer.phone, customer_id: customer.id,
    message_body: 'Hi, this is Waves returning your call request.', message_type: 'manual', status: 'delivered', twilio_sid: sid('SMO'), metadata: JSON.stringify({ human_authored: true }), created_at: at, ...over });
  // A Gmail send by a person (label SENT, not INBOX) to the customer's own address, in a thread of its own.
  const sentEmail = (customer, at) => insert('emails', {
    gmail_id: sid('GM'), gmail_thread_id: sid('TH'), from_address: 'office@example.invalid', to_address: `Lead Sample <${customer.email}>`,
    cc_address: '', bcc_address: '', subject: 'Your call request', label_ids: JSON.stringify(['SENT']), received_at: at,
  });
  const get = (id) => db('notifications').where({ id }).first();
  const metaOf = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {});
  const bannersFor = (id) => triggerNotification.mock.calls.filter(([key, payload]) => key === 'lead_call_reminder' && payload.alertRowId === id);
  const run = async (now = NOW) => {
    const result = await reminder.runLeadCallReminder({ now });
    await Promise.all(result.sends || []);
    return result;
  };
  const leadAndCustomer = async () => {
    const customer = await customerWith();
    return { customer, lead: await leadFor(customer) };
  };

  test('an open bell one business hour old that nobody answered is stamped once and sends one banner; the next sweep sends nothing', async () => {
    const { customer, lead } = await leadAndCustomer();
    const row = await bell({ lead, customer, at: mins(-90) });
    await run();
    const stored = await get(row.id);
    expect(metaOf(stored).leadCallReminderAt).toBe(NOW.toISOString());
    // The row is not rewritten: same words, same time, still unread and open.
    expect([stored.title, stored.body, stored.read_at, stored.done_at]).toEqual([row.title, row.body, null, null]);
    expect(new Date(stored.created_at).getTime()).toBe(new Date(row.created_at).getTime());
    expect(bannersFor(row.id)).toHaveLength(1);
    expect(bannersFor(row.id)[0][1]).toMatchObject({ alertTitle: row.title, alertBody: row.body, alertLink: row.link, customerId: customer.id });
    expect(await bannersFor(row.id)[0][2].beforePush()).toBe(true);
    await run(mins(20));
    expect(bannersFor(row.id)).toHaveLength(1);
  });

  test('the night call-back bell is covered; a person\'s text after the bell, or an automated text, is judged by the witnesses', async () => {
    const night = await leadAndCustomer();
    const nightRow = await bell({ ...night, at: mins(-70), key: `lead-call-text-followup:${crypto.randomUUID()}` });
    const texted = await leadAndCustomer();
    const textedRow = await bell({ ...texted, at: mins(-80) });
    await staffText(texted.customer, mins(-60));
    const automated = await leadAndCustomer();
    const automatedRow = await bell({ ...automated, at: mins(-80) });
    // A reminder the system sent on its own: no person wrote it, so it reaches nobody.
    await staffText(automated.customer, mins(-60), { message_type: 'appointment_reminder', metadata: JSON.stringify({}) });
    await run();
    expect(bannersFor(nightRow.id)).toHaveLength(1);
    expect(bannersFor(textedRow.id)).toHaveLength(0);
    expect(metaOf(await get(textedRow.id)).leadCallReminderAt).toBeUndefined();
    expect(bannersFor(automatedRow.id)).toHaveLength(1);
  });

  test('a person\'s Gmail send to the lead\'s customer after the bell is contact (the real witness loader); one before the bell is not', async () => {
    const emailed = await leadAndCustomer();
    const emailedRow = await bell({ ...emailed, at: mins(-80) });
    await sentEmail(emailed.customer, mins(-50));
    const early = await leadAndCustomer();
    const earlyRow = await bell({ ...early, at: mins(-80) });
    await sentEmail(early.customer, mins(-100));
    await run();
    expect(bannersFor(emailedRow.id)).toHaveLength(0);
    expect(metaOf(await get(emailedRow.id)).leadCallReminderAt).toBeUndefined();
    expect(bannersFor(earlyRow.id)).toHaveLength(1);
  });

  test('a young bell, an old bell, a closed bell, a closed lead and another kind of lead bell send nothing', async () => {
    const a = await leadAndCustomer();
    const young = await bell({ ...a, at: mins(-30) });
    const b = await leadAndCustomer();
    const old = await bell({ ...b, at: mins(-25 * 60) });
    const c = await leadAndCustomer();
    const closed = await bell({ ...c, at: mins(-90), over: { done_at: mins(-10) } });
    const d = await leadAndCustomer();
    await db('leads').where({ id: d.lead.id }).update({ status: 'lost' });
    const lost = await bell({ ...d, at: mins(-90) });
    const e = await leadAndCustomer();
    const other = await bell({ ...e, at: mins(-90), key: `sms-lead:${crypto.randomUUID()}` });
    await run();
    for (const row of [young, old, closed, lost, other]) {
      expect(bannersFor(row.id)).toHaveLength(0);
      expect(metaOf(await get(row.id)).leadCallReminderAt).toBeUndefined();
    }
  });

  test('the fence: a row whose metadata changed since it was read, or that closed, is not stamped', async () => {
    const { customer, lead } = await leadAndCustomer();
    const row = await bell({ lead, customer, at: mins(-90) });
    const { stampReminder } = reminder.__private;
    expect(await stampReminder({ row, meta: { ...metaOf(row), rungAt: mins(-5).toISOString() } }, NOW)).toBe(false);
    await db('notifications').where({ id: row.id }).update({ done_at: mins(-1) });
    expect(await stampReminder({ row, meta: metaOf(row) }, NOW)).toBe(false);
    expect(metaOf(await get(row.id)).leadCallReminderAt).toBeUndefined();
  });

  test('the alert-relevance sweep runs the pass and reports it', async () => {
    const { customer, lead } = await leadAndCustomer();
    const row = await bell({ lead, customer, at: mins(-100) });
    const result = await relevance.runAdminAlertRelevanceSweep({ now: NOW });
    expect(result.leadCallReminders).toBeGreaterThanOrEqual(1);
    expect(metaOf(await get(row.id)).leadCallReminderAt).toBe(NOW.toISOString());
  });
});
