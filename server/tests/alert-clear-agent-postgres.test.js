/**
 * Alert clear-up agent against a real, fully migrated Postgres: the timeline readers use the repo's own predicates (staff-contact.js,
 * email-customer-link.js, call-commitments.js, admin-alert-relevance.js), and only a real database proves their SQL and columns.
 * Self-skips without ALERT_CLEAR_TEST_DATABASE_URL, e.g.
 *   ALERT_CLEAR_TEST_DATABASE_URL=postgresql://user@localhost:5432/waves_test npx jest server/tests/alert-clear-agent-postgres.test.js
 * Every row the file inserts carries its own random ids and is deleted again; nothing else in the database is read or changed.
 */
const { randomUUID } = require('crypto');

const connection = process.env.ALERT_CLEAR_TEST_DATABASE_URL;
if (connection) process.env.DATABASE_URL = connection;
process.env.GATE_ALERT_CLEAR_AGENT = 'shadow';
const postgres = connection ? describe : describe.skip;
jest.setTimeout(60000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const T0 = new Date(Date.now() - 3 * 3600 * 1000);
const at = (minutes) => new Date(T0.getTime() + minutes * 60000);
const tag = randomUUID().slice(0, 8);
const phone = (n) => `+1555${String(Math.abs(parseInt(tag, 16) % 9000) + 1000)}${String(n).padStart(3, '0')}`.slice(0, 12);

postgres('alert clear-up agent: readers on a real schema', () => {
  let db;
  let agent;
  const made = { notifications: [], customers: [], smsLog: [], calls: [], emails: [], visits: [], estimates: [], conversations: [] };

  const customer = async (extra = {}) => {
    const [row] = await db('customers').insert({ first_name: `Test${tag}`, phone: phone(Math.floor(Math.random() * 900)), ...extra }).returning('id');
    made.customers.push(row.id);
    return row.id;
  };
  const alert = async (category, title, link, metadata = {}) => {
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category, title, link, created_at: T0, metadata: JSON.stringify({ rungAt: T0.toISOString(), ...metadata }),
    }).returning(['id', 'category', 'title', 'link', 'metadata', 'created_at']);
    made.notifications.push(row.id);
    return row;
  };
  const sms = async (row) => {
    const [r] = await db('sms_log').insert({ from_phone: '+15550000001', to_phone: '+15550000002', ...row }).returning('id');
    made.smsLog.push(r.id);
    return r.id;
  };
  const proofs = (timeline) => timeline.events.filter((e) => e.proof).map((e) => `${e.type}:${e.proof}`);

  beforeAll(async () => {
    db = require('../models/db');
    agent = require('../services/alert-clear-agent');
  });

  afterAll(async () => {
    if (!db) return;
    await db('alert_clear_verdicts').whereIn('notification_id', made.notifications).del();
    await db('notifications').whereIn('id', made.notifications).del();
    await db('sms_log').whereIn('id', made.smsLog).del();
    await db('call_log').whereIn('id', made.calls).del();
    await db('emails').whereIn('id', made.emails).del();
    await db('scheduled_services').whereIn('id', made.visits).del();
    await db('estimates').whereIn('id', made.estimates).del();
    await db('messages').whereIn('conversation_id', made.conversations).del();
    await db('conversations').whereIn('id', made.conversations).del();
    await db('customers').whereIn('id', made.customers).del();
    await db.destroy();
  });

  test('a text is a person\'s only by the operator + delivery predicates, and many rows before it do not hide it', async () => {
    const cid = await customer();
    const sid = `SM${tag}a`;
    await sms({ customer_id: cid, direction: 'inbound', twilio_sid: sid, message_body: 'Can you come Friday?', created_at: T0, status: 'received' });
    await sms({ customer_id: cid, direction: 'outbound', message_type: 'manual', status: 'delivered', message_body: 'automated sender reusing manual', created_at: at(2) });
    for (let i = 0; i < 40; i += 1) await sms({ customer_id: cid, direction: 'outbound', message_type: 'reminder', status: 'delivered', message_body: `auto ${i}`, created_at: at(3 + i) });
    await sms({ customer_id: cid, direction: 'outbound', message_type: 'manual', status: 'queued', message_body: 'human but not delivered', created_at: at(50), metadata: { human_authored: 'true' } });
    const personId = await sms({ customer_id: cid, direction: 'outbound', message_type: 'manual', status: 'delivered', message_body: 'Friday works', created_at: at(60), metadata: { human_authored: 'true' } });
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const timeline = await agent.buildTimeline(row);
    expect(timeline.complete).toBe(true);
    expect(timeline.alertAt).toEqual(T0);
    expect(proofs(timeline)).toEqual(['sms:staff_text']);
    expect(timeline.events.find((e) => e.proof === 'staff_text').id).toBe(String(personId));
  });

  test('a text from an unknown sender is resolved by its SID, and the number\'s later staff text answers it', async () => {
    const number = phone(7);
    const sid = `SM${tag}b`;
    await sms({ direction: 'inbound', from_phone: number, to_phone: '+15550000002', twilio_sid: sid, message_body: 'who is this', created_at: at(-5), status: 'received' });
    await sms({ direction: 'outbound', from_phone: '+15550000002', to_phone: number, message_type: 'manual', status: 'delivered', message_body: 'This is Waves', created_at: at(30), metadata: { human_authored: 'true' } });
    const row = await alert('inbound_sms', 'Text from a new number', `/admin/communications?message=${sid}`, { rungAt: at(120).toISOString() });
    const timeline = await agent.buildTimeline(row);
    expect(timeline.unreadable).toBeUndefined();
    expect(timeline.alertAt).toEqual(at(-5));
    expect(timeline.customerKnown).toBe(false);
    expect(proofs(timeline)).toEqual(['sms:staff_text']);
    expect(timeline.trigger).toBe(`sms:${sid}`);
  });

  test('a cancelled visit is not a booking; a live one is. Only a handed-off estimate counts, never sent_at alone', async () => {
    const cid = await customer();
    const sid = `SM${tag}c`;
    await sms({ customer_id: cid, direction: 'inbound', twilio_sid: sid, message_body: 'yes', created_at: T0, status: 'received' });
    const visit = async (status) => {
      const [r] = await db('scheduled_services').insert({ customer_id: cid, scheduled_date: '2027-01-10', service_type: 'Pest Control', status, created_at: at(20) }).returning('id');
      made.visits.push(r.id);
      return r.id;
    };
    await visit('cancelled');
    const live = await visit('pending');
    const est = async (data) => {
      const [r] = await db('estimates').insert({ customer_id: cid, sent_at: at(25), status: 'sent', estimate_data: JSON.stringify(data) }).returning('id');
      made.estimates.push(r.id);
      return r.id;
    };
    await est({});
    const handed = await est({ deliveryState: { lastDeliveredAt: at(30).toISOString() } });
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const timeline = await agent.buildTimeline(row);
    expect(timeline.complete).toBe(true);
    const found = timeline.events.filter((e) => e.proof).map((e) => `${e.proof}:${e.id}`).sort();
    expect(found).toEqual([`booking:${live}`, `estimate_sent:${handed}`].sort());
  });

  test('a sent staff email counts only when it provably reached this customer; a draft never does; SMS alerts see it too', async () => {
    const address = `c${tag}@example.test`;
    const cid = await customer({ email: address });
    const email = async (row) => {
      const [r] = await db('emails').insert({ gmail_id: `g-${randomUUID()}`, cc_address: '', bcc_address: '', ...row }).returning('id');
      made.emails.push(r.id);
      return r.id;
    };
    const thread = `th-${tag}`;
    const inbound = await email({ gmail_thread_id: thread, from_address: address, to_address: 'contact@wavespestcontrol.com', subject: 'Quote?', body_text: 'Need a quote', received_at: T0, label_ids: JSON.stringify(['INBOX']), customer_id: cid });
    await email({ gmail_thread_id: thread, from_address: 'contact@wavespestcontrol.com', to_address: 'someone-else@example.test', subject: 'Re: Quote?', body_text: 'wrong person', received_at: at(10), label_ids: JSON.stringify(['SENT']) });
    await email({ gmail_thread_id: thread, from_address: 'contact@wavespestcontrol.com', to_address: address, subject: 'Re: Quote?', body_text: 'unsent draft', received_at: at(15), label_ids: JSON.stringify(['DRAFT']) });
    const sentId = await email({ gmail_thread_id: thread, from_address: 'contact@wavespestcontrol.com', to_address: address, subject: 'Re: Quote?', body_text: 'Here is your quote', received_at: at(20), label_ids: JSON.stringify(['SENT']) });
    const row = await alert('inbound_email', 'Email from Test', '/admin/communications#tab=email', { payload: { emailId: inbound } });
    const timeline = await agent.buildTimeline(row);
    expect(timeline.complete).toBe(true);
    expect(timeline.events.filter((e) => e.proof === 'staff_email').map((e) => e.id)).toEqual([String(sentId)]);
    expect(timeline.events.some((e) => e.draft)).toBe(true);
    expect(timeline.events.filter((e) => e.draft).every((e) => e.proof === null)).toBe(true);

    const sid = `SM${tag}d`;
    await sms({ customer_id: cid, direction: 'inbound', twilio_sid: sid, message_body: 'any news', created_at: at(-1), status: 'received' });
    const smsRow = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const smsTimeline = await agent.buildTimeline(smsRow);
    expect(smsTimeline.events.filter((e) => e.proof === 'staff_email').map((e) => e.id)).toEqual([String(sentId)]);
  });

  test('a call counts as a person\'s only by the repo predicates, dated by when it ended', async () => {
    const cid = await customer();
    const call = async (row) => {
      const [r] = await db('call_log').insert({ customer_id: cid, from_phone: '+15550000009', to_phone: '+15550000008', ...row }).returning('id');
      made.calls.push(r.id);
      return r.id;
    };
    const missed = await call({ direction: 'inbound', status: 'no-answer', created_at: T0, duration_seconds: 5, metadata: JSON.stringify({}) });
    await call({ direction: 'outbound', status: 'completed', created_at: at(10), duration_seconds: 90, answered_by: 'voicemail', metadata: JSON.stringify({ ended_at: at(11).toISOString() }) });
    const bridged = await call({
      direction: 'outbound', status: 'completed', created_at: at(20), duration_seconds: 80, source: 'admin-click', v2_extraction_status: 'valid',
      ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }), metadata: JSON.stringify({ ended_at: at(22).toISOString() }),
    });
    const row = await alert('missed_call', 'Missed call', `/admin/communications#tab=calls&call=${missed}`, { payload: { callLogId: missed } });
    const timeline = await agent.buildTimeline(row);
    expect(timeline.complete).toBe(true);
    const human = timeline.events.filter((e) => e.proof === 'human_call');
    expect(human.map((e) => e.id)).toEqual([String(bridged)]);
    expect(human[0].at).toEqual(at(22));
  });

  test('an email alert with no customer and no number reads no phone-less rows (a call with a null number, a text with a blank one)', async () => {
    const emailRow = async (row) => {
      const [r] = await db('emails').insert({ gmail_id: `g-${randomUUID()}`, cc_address: '', bcc_address: '', ...row }).returning('id');
      made.emails.push(r.id);
      return r.id;
    };
    const mail = await emailRow({ gmail_thread_id: `th-${tag}-x`, from_address: `stranger${tag}@example.test`, to_address: 'contact@wavespestcontrol.com', subject: 'Hi', body_text: 'hello', received_at: T0, label_ids: JSON.stringify(['INBOX']) });
    const [nullPhoneCall] = await db('call_log').insert({ direction: 'outbound', status: 'completed', from_phone: null, to_phone: null, created_at: at(10), duration_seconds: 70, source: 'admin-click', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }), metadata: JSON.stringify({ ended_at: at(12).toISOString() }) }).returning('id');
    made.calls.push(nullPhoneCall.id);
    await sms({ direction: 'outbound', from_phone: '', to_phone: '', message_type: 'manual', status: 'delivered', message_body: 'blank number text', created_at: at(15), metadata: { human_authored: 'true' } });
    const row = await alert('inbound_email', 'Email from a stranger', '/admin/communications#tab=email', { payload: { emailId: mail } });
    const timeline = await agent.buildTimeline(row);
    expect(timeline.complete).toBe(true);
    expect(timeline.events.filter((e) => e.type === 'call' || e.type === 'sms')).toEqual([]);
    expect(proofs(timeline)).toEqual([]);
  });

  test('the triggering text is carried from the canonical message, and the offer before it makes a bare yes a reply pair', async () => {
    const cid = await customer();
    const sid = `SM${tag}f`;
    const [conv] = await db('conversations').insert({ channel: 'sms', customer_id: cid, contact_phone: phone(31) }).returning('id');
    made.conversations.push(conv.id);
    await db('messages').insert({ conversation_id: conv.id, channel: 'sms', direction: 'inbound', author_type: 'customer', body: 'Yes', twilio_sid: sid, created_at: T0 });
    await sms({ customer_id: cid, direction: 'outbound', message_type: 'manual', status: 'delivered', message_body: 'We could come Friday at 10 am. Does that work?', created_at: at(-30), metadata: { human_authored: 'true' } });
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const timeline = await agent.buildTimeline(row);
    expect(timeline.complete).toBe(true);
    expect(timeline.reply).toEqual({ lastBody: 'Yes', prevOutbound: 'We could come Friday at 10 am. Does that work?' });
    expect(timeline.ctx[timeline.ctx.length - 1]).toMatch(/the text this alert is about\): Yes/);
  });

  test('an email "yes" is paired with the Waves offer before it, a draft is not mail', async () => {
    const address = `r${tag}@example.test`;
    const cid = await customer({ email: address });
    const mailRow = async (row) => {
      const [r] = await db('emails').insert({ gmail_id: `g-${randomUUID()}`, cc_address: '', bcc_address: '', ...row }).returning('id');
      made.emails.push(r.id);
      return r.id;
    };
    const thread = `th-${tag}-y`;
    await mailRow({ gmail_thread_id: thread, from_address: 'contact@wavespestcontrol.com', to_address: address, subject: 'Friday', body_text: 'Can we come Friday at 10 am?', received_at: at(-60), label_ids: JSON.stringify(['SENT']) });
    await mailRow({ gmail_thread_id: thread, from_address: 'contact@wavespestcontrol.com', to_address: address, subject: 'Friday', body_text: 'draft that was never sent', received_at: at(-30), label_ids: JSON.stringify(['DRAFT']) });
    const yes = await mailRow({ gmail_thread_id: thread, from_address: address, to_address: 'contact@wavespestcontrol.com', subject: 'Re: Friday', body_text: 'Yes\n\nOn Tue someone wrote:\n> Can we come', received_at: T0, label_ids: JSON.stringify(['INBOX']), customer_id: cid });
    const row = await alert('inbound_email', 'Email from Test', '/admin/communications#tab=email', { payload: { emailId: yes } });
    const timeline = await agent.buildTimeline(row);
    expect(timeline.reply.lastBody.trim()).toBe('Yes');
    expect(timeline.reply.prevOutbound).toBe('Can we come Friday at 10 am?');
  });

  test('a hold voicemail bell: top-level call id, fragment link, judged from the bell\'s own time (a call during the hold answers nothing)', async () => {
    const cid = await customer();
    const call = async (row) => {
      const [r] = await db('call_log').insert({ customer_id: cid, from_phone: '+15550004444', to_phone: '+15550003333', ...row }).returning('id');
      made.calls.push(r.id);
      return r.id;
    };
    const held = await call({ direction: 'inbound', status: 'completed', created_at: at(-10), duration_seconds: 300, answered_by: 'human', metadata: JSON.stringify({ ended_at: at(-4).toISOString() }) });
    const during = await call({ direction: 'outbound', status: 'completed', created_at: at(-8), duration_seconds: 80, source: 'admin-click', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }), metadata: JSON.stringify({ ended_at: at(-6).toISOString() }) });
    const afterBell = await call({ direction: 'outbound', status: 'completed', created_at: at(20), duration_seconds: 80, source: 'admin-click', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }), metadata: JSON.stringify({ ended_at: at(22).toISOString() }) });
    const row = await alert('voicemail_callback', 'Call back an unknown caller', `/admin/communications#tab=calls&call=${held}`, {
      dedupeKey: 'call-hold-voicemail:CA' + tag, callLogId: held, reason: 'timeout', payload: { customerId: cid, phone: '+15550004444' },
    });
    const timeline = await agent.buildTimeline(row);
    expect(timeline.complete).toBe(true);
    expect(timeline.unreadable).toBeUndefined();
    expect(timeline.alertAt).toEqual(T0);
    const ids = timeline.events.filter((e) => e.proof === 'human_call').map((e) => e.id);
    expect(ids).toEqual([String(afterBell)]);
    expect(ids).not.toContain(String(during));
    expect(ids).not.toContain(String(held));
  });

  test('a call whose transcript arrives later gets a new fingerprint', async () => {
    const [c] = await db('call_log').insert({ from_phone: '+15550006666', to_phone: '+15550003333', direction: 'inbound', status: 'completed', created_at: at(-3), duration_seconds: 20, metadata: JSON.stringify({}) }).returning('id');
    made.calls.push(c.id);
    const row = await alert('voicemail_callback', 'Voicemail', `/admin/communications#tab=calls&call=${c.id}`, { payload: { callLogId: c.id } });
    const before = agent.fingerprintOf(row, await agent.buildTimeline(row), new Date());
    await db('call_log').where({ id: c.id }).update({ transcription: 'please call me about the wasps' });
    const after = agent.fingerprintOf(row, await agent.buildTimeline(row), new Date());
    expect(after).not.toBe(before);
  });

  test('a reader that fills its row cap makes the timeline incomplete (a capped timeline is never trusted)', async () => {
    const cid = await customer();
    const sid = `SM${tag}g`;
    await sms({ customer_id: cid, direction: 'inbound', twilio_sid: sid, message_body: 'hi', created_at: T0, status: 'received' });
    const rows = Array.from({ length: 300 }, (_x, i) => ({ customer_id: cid, direction: 'outbound', from_phone: '+15550000001', to_phone: '+15550000002', message_type: 'reminder', status: 'delivered', message_body: `auto ${i}`, created_at: at(1 + (i % 100)) }));
    const inserted = await db('sms_log').insert(rows).returning('id');
    inserted.forEach((x) => made.smsLog.push(x.id));
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const timeline = await agent.buildTimeline(row);
    expect(timeline.complete).toBe(false);
  });

  test('the open alerts are paged from a cursor and wrap around', async () => {
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push((await alert('inbound_sms', `Paging ${i}`, '/x')).id);
    const sorted = ids.slice().sort();
    const rows = await agent.defaultDeps().candidates(sorted[1]);
    const mine = rows.map((r) => r.id).filter((id) => ids.includes(id));
    expect(mine).toEqual([sorted[2], sorted[0], sorted[1]]);
  });

  test('a whole sweep on the real tables: reservation row first, finished verdict after, then the same fingerprint is skipped', async () => {
    const cid = await customer();
    const sid = `SM${tag}e`;
    await sms({ customer_id: cid, direction: 'inbound', twilio_sid: sid, message_body: 'when are you coming', created_at: T0, status: 'received' });
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const seen = [];
    const realDeps = agent.defaultDeps();
    const judge = jest.fn(async () => {
      seen.push(await db('alert_clear_verdicts').where({ notification_id: row.id }).select('rule', 'source', 'outcome'));
      return { outcome: 'still_owed', why: 'no reply yet', proof: null, model: 'stub-model' };
    });
    const only = { candidates: async () => [row], judge, canCall: () => true };
    // Test-owned cursor storage: the shared sweep cursor in system_settings is never read, written or deleted here.
    let testCursor = null;
    const cursorDeps = { cursor: async () => testCursor, saveCursor: async (id) => { testCursor = id; } };
    const first = await agent.runAlertClearAgent({ deps: { ...only, ...cursorDeps } });
    expect(first.ai_still_owed).toBe(1);
    expect(seen[0]).toEqual([{ rule: 'ai_reserved', source: 'ai', outcome: 'still_owed' }]);
    const after = await db('alert_clear_verdicts').where({ notification_id: row.id }).select('rule', 'source', 'outcome', 'model', 'why');
    expect(after).toEqual([{ rule: null, source: 'ai', outcome: 'still_owed', model: 'stub-model', why: 'no reply yet' }]);
    const second = await agent.runAlertClearAgent({ deps: { ...only, ...cursorDeps } });
    expect(testCursor).toBeNull();
    expect(second.unchanged).toBe(1);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(await realDeps.aiCountToday(new Date())).toBeGreaterThanOrEqual(1);
  });
});
