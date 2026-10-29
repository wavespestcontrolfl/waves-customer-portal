/**
 * IB schedule_sms against real PostgreSQL (committed rows, cleaned up): the card, the confirmed card through the shared
 * writer (services/scheduled-sms-queue.js scheduleCustomerSms, which the Communications page route also calls), the
 * row it writes (the page's own shape), a double Confirm that queues ONE text (sequential and concurrent), a phone change
 * that lands while Confirm waits on the writer's lock (refused, nothing written), and that list_queued_messages lists the
 * row and cancel_queued_message cancels it. No provider is reachable: nothing here sends. Synthetic names only.
 */
const { randomUUID } = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('IB schedule_sms (real PG)', () => {
  let db;
  let executeScheduleSmsTool;
  let executeCommsTool;
  let scheduleCustomerSms;
  let TWILIO_NUMBERS;
  const created = { customers: [], technicians: [], decisions: [] };
  const sendDate = () => require('../utils/datetime-et').etDateString(require('../utils/datetime-et').addETDays(new Date(), 3));

  beforeAll(() => {
    // Real rows are written: only a dedicated QA database (or CI's), never anything else.
    const url = new URL(process.env.DATABASE_URL);
    const ok = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)
      || (process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test');
    if (!ok) throw new Error('A dedicated waves_qa_<32 hex> database is required');
    process.env.GATE_IB_SCHEDULE_SMS = 'true';
    process.env.GATE_IB_PLATFORM = 'true';
    db = require('../models/db');
    ({ executeScheduleSmsTool } = require('../services/intelligence-bar/schedule-sms-tools'));
    ({ executeCommsTool } = require('../services/intelligence-bar/comms-tools'));
    ({ scheduleCustomerSms } = require('../services/scheduled-sms-queue'));
    TWILIO_NUMBERS = require('../config/twilio-numbers');
  });

  afterAll(async () => {
    delete process.env.GATE_IB_SCHEDULE_SMS;
    delete process.env.GATE_IB_PLATFORM;
    if (!db) return;
    for (const id of created.customers) {
      await db('sms_log').where({ customer_id: id }).del();
      await db('customers').where({ id }).del();
    }
    if (created.decisions.length) await db('agent_decisions').whereIn('id', created.decisions).del();
    if (created.technicians.length) await db('technicians').whereIn('id', created.technicians).del();
    await db.destroy();
  });

  async function admin() {
    const id = randomUUID();
    await db('technicians').insert({ id, name: `Synthetic Admin ${id.slice(0, 4)}`, role: 'admin', active: true, auth_token_version: 1, email: `admin.${id.slice(0, 8)}@example.invalid` });
    created.technicians.push(id);
    return { isAdmin: true, technicianId: id };
  }

  async function customer(over = {}) {
    const id = randomUUID();
    const phone = over.phone || `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;
    await db('customers').insert({ id, first_name: 'Fixture', last_name: 'Scheduled', phone, email: `${id}@example.invalid`, property_type: 'residential', ...over });
    created.customers.push(id);
    return { id, phone };
  }

  // A pending house-voice suggestion on the customer's thread: the inbound text and the decision that answers it.
  async function pendingSuggestion(c) {
    const inbound = await db('sms_log').insert({ customer_id: c.id, direction: 'inbound', from_phone: c.phone, to_phone: TWILIO_NUMBERS.getOutboundNumber(), message_body: 'Synthetic customer question', status: 'received', message_type: 'manual' }).returning('id');
    const id = randomUUID();
    await db('agent_decisions').insert({ id, workflow: 'sms_house_voice_suggest', agent_name: 'synthetic', decision_version: 'v1', status: 'pending_review', entity_type: 'sms_log', entity_id: String(inbound[0].id || inbound[0]), sms_log_id: inbound[0].id || inbound[0], customer_id: c.id, suggested_message: 'Synthetic suggested reply' });
    created.decisions.push(id);
    return id;
  }
  const decisionStatus = async (id) => (await db('agent_decisions').where({ id }).first('status')).status;

  const rowsFor = (customerId) => db('sms_log').where({ customer_id: customerId, direction: 'outbound' }).select('*');
  const input = (customerId, over = {}) => ({ customer_id: customerId, message: 'Hi, this is a synthetic scheduled text.', send_date: sendDate(), send_time: '10:00', ...over });
  const confirm = (ctx, inputs, card) => executeScheduleSmsTool('schedule_sms', { ...inputs, confirmed: true, _verified_schedule_sms_version: card._version }, ctx);

  test('the card, then Confirm queues one text in the page\'s own row shape', async () => {
    const ctx = await admin();
    const c = await customer();
    const card = await executeScheduleSmsTool('schedule_sms', input(c.id), ctx);
    expect(card.preview).toBe(true);
    expect(await rowsFor(c.id)).toHaveLength(0); // the card writes nothing
    const done = await confirm(ctx, input(c.id), card);
    expect(done).toMatchObject({ success: true, state: 'scheduled', sent_to_customer: false });
    const rows = await rowsFor(c.id);
    expect(rows).toHaveLength(1);
    const meta = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
    expect(rows[0]).toMatchObject({
      status: 'scheduled', message_type: 'manual', direction: 'outbound', to_phone: c.phone, from_phone: TWILIO_NUMBERS.getOutboundNumber(),
      admin_user_id: ctx.technicianId, message_body: 'Hi, this is a synthetic scheduled text.',
    });
    expect(new Date(rows[0].scheduled_for).toISOString()).toBe(card.send_at);
    expect(meta).toEqual({ human_authored: true });
  });

  test('the bar\'s row has the same shape as a row the page route\'s writer queues', async () => {
    const ctx = await admin();
    const c = await customer();
    const viaBar = await executeScheduleSmsTool('schedule_sms', input(c.id), ctx);
    await confirm(ctx, input(c.id), viaBar);
    const page = await scheduleCustomerSms({ to: c.phone, body: 'Page text.', scheduledFor: `${sendDate()}T11:00`, customerId: c.id }, { techRole: 'admin', technicianId: ctx.technicianId }, {});
    expect(page.status).toBe(200);
    const rows = await rowsFor(c.id);
    expect(rows).toHaveLength(2);
    const pick = (r) => ({ status: r.status, message_type: r.message_type, direction: r.direction, admin_user_id: r.admin_user_id, from_phone: r.from_phone, to_phone: r.to_phone, customer_id: r.customer_id, metadata: r.metadata });
    expect(pick(rows[0])).toEqual(pick(rows[1]));
  });

  test('a double Confirm queues ONE text: one after the other, and two at once', async () => {
    const ctx = await admin();
    const c = await customer();
    const inputs = input(c.id);
    const card = await executeScheduleSmsTool('schedule_sms', inputs, ctx);
    const first = await confirm(ctx, inputs, card);
    const second = await confirm(ctx, inputs, card);
    expect(first.success).toBe(true);
    expect(second).toMatchObject({ success: true, already_queued: true, message_id: first.message_id });
    expect(await rowsFor(c.id)).toHaveLength(1);

    const c2 = await customer();
    const inputs2 = input(c2.id, { message: 'Concurrent confirm text.' });
    const card2 = await executeScheduleSmsTool('schedule_sms', inputs2, ctx);
    const [a, b] = await Promise.all([confirm(ctx, inputs2, card2), confirm(ctx, inputs2, card2)]);
    expect([a.success, b.success]).toEqual([true, true]);
    expect([a, b].filter((r) => r.already_queued === true)).toHaveLength(1);
    expect(a.message_id).toBe(b.message_id);
    expect(await rowsFor(c2.id)).toHaveLength(1);
  });

  test('a phone change that lands while Confirm waits on the writer\'s lock refuses with preview_changed and queues nothing', async () => {
    const ctx = await admin();
    const c = await customer();
    const inputs = input(c.id);
    const card = await executeScheduleSmsTool('schedule_sms', inputs, ctx);
    // An open edit holds the customer row: Confirm re-derives from the committed row (old phone), reaches the writer,
    // and its lock-time read of the customer waits for the edit to commit, then sees the new number.
    const edit = await db.transaction();
    await edit('customers').where({ id: c.id }).update({ phone: '+12025550999' });
    const pending = confirm(ctx, inputs, card);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await edit.commit();
    const result = await pending;
    // The refusal is the writer's lock-time read (its own wording), not the earlier re-derivation's.
    expect(result).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true, error: expect.stringMatching(/phone number changed after the card was shown/) });
    expect(await rowsFor(c.id)).toHaveLength(0);
  });

  test('a phone change after the card and before Confirm refuses with preview_changed', async () => {
    const ctx = await admin();
    const c = await customer();
    const inputs = input(c.id);
    const card = await executeScheduleSmsTool('schedule_sms', inputs, ctx);
    await db('customers').where({ id: c.id }).update({ phone: '+12025550998' });
    expect(await confirm(ctx, inputs, card)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(await rowsFor(c.id)).toHaveLength(0);
  });

  test('a suggested reply waiting on the thread: no card, and nothing is parked or queued', async () => {
    const ctx = await admin();
    const c = await customer();
    const decision = await pendingSuggestion(c);
    expect(await executeScheduleSmsTool('schedule_sms', input(c.id), ctx)).toMatchObject({ code: 'suggestion_pending' });
    expect(await rowsFor(c.id)).toHaveLength(0);
    expect(await decisionStatus(decision)).toBe('pending_review');
  });

  test('a suggestion that arrives after the card: Confirm refuses inside the lock, queues nothing and parks nothing', async () => {
    const ctx = await admin();
    const c = await customer();
    const inputs = input(c.id);
    const card = await executeScheduleSmsTool('schedule_sms', inputs, ctx);
    expect(card.preview).toBe(true);
    const decision = await pendingSuggestion(c);
    const result = await confirm(ctx, inputs, card);
    // Re-derived at Confirm before the writer runs: refused as a changed card, nothing written.
    expect(result).toMatchObject({ code: 'suggestion_pending', preview_changed: true, error: expect.stringMatching(/suggested reply waiting/) });
    expect(await rowsFor(c.id)).toHaveLength(0);
    expect(await decisionStatus(decision)).toBe('pending_review');
  });

  test('a suggestion that lands while Confirm waits on the thread lock is still refused', async () => {
    const ctx = await admin();
    const c = await customer();
    const inputs = input(c.id);
    const card = await executeScheduleSmsTool('schedule_sms', inputs, ctx);
    // The drafter's publish holds the same thread lock the writer takes: Confirm waits, then sees the suggestion.
    const { lockSuggestThread } = require('../services/sms-suggest-mode');
    const publish = await db.transaction();
    await lockSuggestThread(publish, c.phone.replace(/\D/g, '').slice(-10));
    const pending = confirm(ctx, inputs, card);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const inbound = await publish('sms_log').insert({ customer_id: c.id, direction: 'inbound', from_phone: c.phone, to_phone: TWILIO_NUMBERS.getOutboundNumber(), message_body: 'Synthetic question', status: 'received', message_type: 'manual' }).returning('id');
    const decisionId = randomUUID();
    await publish('agent_decisions').insert({ id: decisionId, workflow: 'sms_house_voice_suggest', agent_name: 'synthetic', decision_version: 'v1', status: 'pending_review', entity_type: 'sms_log', entity_id: String(inbound[0].id || inbound[0]), sms_log_id: inbound[0].id || inbound[0], customer_id: c.id, suggested_message: 'Synthetic suggested reply' });
    created.decisions.push(decisionId);
    await publish.commit();
    expect(await pending).toMatchObject({ failed: true, code: 'suggestion_pending' });
    expect(await rowsFor(c.id)).toHaveLength(0);
    expect(await decisionStatus(decisionId)).toBe('pending_review');
  });

  test('another customer\'s suggestion does not block this customer', async () => {
    const ctx = await admin();
    const c = await customer();
    const other = await customer();
    await pendingSuggestion(other);
    const card = await executeScheduleSmsTool('schedule_sms', input(c.id), ctx);
    expect(card.preview).toBe(true);
  });

  test('list_queued_messages lists the row and cancel_queued_message cancels it', async () => {
    const ctx = await admin();
    const c = await customer();
    const inputs = input(c.id);
    const card = await executeScheduleSmsTool('schedule_sms', inputs, ctx);
    const done = await confirm(ctx, inputs, card);
    const listed = await executeCommsTool('list_queued_messages', { customer_id: c.id, channel: 'sms' }, ctx);
    expect(listed.messages.map((m) => m.message_id)).toEqual([done.message_id]);
    expect(listed.excluded_count).toBe(0);
    const cancelCard = await executeCommsTool('cancel_queued_message', { message_id: done.message_id, customer_id: c.id, channel: 'sms' }, ctx);
    expect(cancelCard._version).toBeTruthy();
    const cancelled = await executeCommsTool('cancel_queued_message', { message_id: done.message_id, customer_id: c.id, channel: 'sms', confirmed: true, _verified_message_version: cancelCard._version }, ctx);
    expect(cancelled).toMatchObject({ success: true, cancelled: true });
    expect((await rowsFor(c.id))[0].status).toBe('canceled');
  });

  test('the writer keeps the route\'s guards for the inputs the bar never sends', async () => {
    const ctx = { techRole: 'admin', technicianId: (await admin()).technicianId };
    const c = await customer();
    const base = { to: c.phone, body: 'Guard text.', scheduledFor: `${sendDate()}T10:00`, customerId: c.id };
    expect((await scheduleCustomerSms({ ...base, translationTrialId: 7 }, ctx, {})).status).toBe(409);
    expect((await scheduleCustomerSms({ ...base, scheduledFor: '2001-01-05T10:00' }, ctx, {})).status).toBe(400);
    expect((await scheduleCustomerSms({ ...base, fromNumber: '+19415550001' }, ctx, {})).status).toBe(400);
    expect((await scheduleCustomerSms({ ...base, to: '+12025550000' }, ctx, {})).status).toBe(400);
    expect((await scheduleCustomerSms({ ...base, customerId: randomUUID() }, ctx, {})).status).toBe(404);
    expect((await scheduleCustomerSms({ ...base, body: 'Pay at https://portal.wavespestcontrol.com/rate/abcdefgh12345' }, ctx, {})).status).toBe(400);
    expect((await scheduleCustomerSms(base, { techRole: 'technician', technicianId: ctx.technicianId }, {})).status).toBe(403);
    expect(await rowsFor(c.id)).toHaveLength(0);
  });
});
