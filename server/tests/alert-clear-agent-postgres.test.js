/**
 * Alert clear-up agent against a real, fully migrated Postgres: the timeline readers use the repo's own predicates (staff-contact.js,
 * email-customer-link.js, call-commitments.js, admin-alert-relevance.js), and only a real database proves their SQL and columns.
 * Runs in CI's database jobs (DATABASE_URL); self-skips without it. Locally, e.g.
 *   ALERT_CLEAR_TEST_DATABASE_URL=postgresql://user@localhost:5432/waves_test npx jest server/tests/alert-clear-agent-postgres.test.js
 * Every row the file inserts carries its own random ids and is deleted again; nothing else in the database is read or changed.
 */
const { randomUUID } = require('crypto');

if (process.env.ALERT_CLEAR_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.ALERT_CLEAR_TEST_DATABASE_URL;
const SKIP = !process.env.DATABASE_URL;
process.env.GATE_ALERT_CLEAR_AGENT = 'shadow';
const postgres = SKIP ? describe.skip : describe;
jest.setTimeout(60000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const T0 = new Date(Date.now() - 3 * 3600 * 1000);
const at = (minutes) => new Date(T0.getTime() + minutes * 60000);
const tag = randomUUID().slice(0, 8);
const phone = (n) => `+1555${String(Math.abs(parseInt(tag, 16) % 9000) + 1000)}${String(n).padStart(3, '0')}`.slice(0, 12);
// The Waves line an inbound text comes to (the sms helper's default to_phone): the offer a yes answers is sent from it.
const LINE = '+15550000002';
const OTHER_LINE = '+15550000003';

postgres('alert clear-up agent: readers on a real schema', () => {
  let db;
  let agent;
  const made = { notifications: [], customers: [], smsLog: [], calls: [], emails: [], visits: [], estimates: [], conversations: [], reschedules: [] };

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
    await db('missed_call_text_claims').whereIn('call_log_id', made.calls).del();
    await db('call_log').whereIn('id', made.calls).del();
    await db('emails').whereIn('id', made.emails).del();
    await db('reschedule_log').whereIn('id', made.reschedules).del();
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
    const visit = async (status, extra = {}) => {
      const [r] = await db('scheduled_services').insert({ customer_id: cid, scheduled_date: '2027-01-10', window_start: '09:00', window_end: '10:00', service_type: 'Pest Control', status, created_at: at(20), ...extra }).returning('id');
      made.visits.push(r.id);
      return r.id;
    };
    await visit('cancelled');
    const live = await visit('pending');
    // Handed to the customer and not yet given a time: a placeholder day, never a booking.
    const waiting = await visit('pending', { window_start: null, window_end: null, customer_pick_by: at(1440) });
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
    // The booking's line states the day and time the visit holds, so the model can judge a yes to an offered time.
    // ...as the customer is told it: the weekday and the arrival window (start + 2 hours), not the job's 09:00-10:00.
    expect(timeline.events.find((e) => e.id === String(live)).line).toBe('VISIT created after the alert, for Sunday 2027-01-10, arrival 09:00-11:00 (pending)');
    expect(timeline.events.find((e) => e.id === String(waiting))).toMatchObject({ proof: null, line: expect.stringMatching(/waiting for the customer to pick a time/) });

    // A visit the customer is told only the day of (time-promise.js loadTimeDisplay: showHour false) states the day alone: its 09:00
    // is the planner's, not a time the customer was given.
    const promise = require('../services/time-promise');
    const spy = jest.spyOn(promise, 'loadTimeDisplay').mockImplementation(async (_conn, rows) => new Map(rows.map((x) => [x.id, { showHour: false, level: 'none', eligible: true }])));
    try {
      const dayOnly = await agent.buildTimeline(row);
      expect(spy).toHaveBeenCalled();
      expect(dayOnly.events.find((e) => e.id === String(live))).toMatchObject({ proof: 'booking', line: 'VISIT created after the alert, for Sunday 2027-01-10; the customer is told the day, not a time (pending)' });
    } finally {
      spy.mockRestore();
    }
    // A failed time-display read is a failed read: the timeline is incomplete, so the alert waits for the next sweep.
    const failed = jest.spyOn(promise, 'loadTimeDisplay').mockImplementation(async (_conn, rows) => new Map(rows.map((x) => [x.id, { showHour: true, level: 'hour', eligible: false, failed: true }])));
    try {
      expect((await agent.buildTimeline(row)).complete).toBe(false);
    } finally {
      failed.mockRestore();
    }
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
    const [conv] = await db('conversations').insert({ channel: 'sms', customer_id: cid, contact_phone: phone(31), our_endpoint_id: LINE }).returning('id');
    made.conversations.push(conv.id);
    await db('messages').insert({ conversation_id: conv.id, channel: 'sms', direction: 'inbound', author_type: 'customer', body: 'Yes', twilio_sid: sid, created_at: T0 });
    await sms({ customer_id: cid, direction: 'outbound', from_phone: LINE, to_phone: phone(31), message_type: 'manual', status: 'delivered', message_body: 'We could come Friday at 10 am. Does that work?', created_at: at(-30), metadata: { human_authored: 'true' } });
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const timeline = await agent.buildTimeline(row);
    expect(timeline.complete).toBe(true);
    // The offer's send time comes with it, so the model can read "tomorrow" from it; it went to the number the yes came from.
    expect(timeline.reply).toEqual({ lastBody: 'Yes', prevOutbound: 'We could come Friday at 10 am. Does that work?', prevAt: at(-30), whole: true });
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
    const yes = await mailRow({ gmail_thread_id: thread, from_address: address, to_address: 'contact@wavespestcontrol.com', subject: 'Re: Friday', body_text: 'Yes\n\nOn Tue, Nov 24, 2026 at 3:21 PM Waves <contact@wavespestcontrol.com> wrote:\n> Can we come', received_at: T0, label_ids: JSON.stringify(['INBOX']), customer_id: cid });
    const row = await alert('inbound_email', 'Email from Test', '/admin/communications#tab=email', { payload: { emailId: yes } });
    const timeline = await agent.buildTimeline(row);
    expect(timeline.reply.lastBody.trim()).toBe('Yes');
    expect(timeline.reply.prevOutbound).toBe('Can we come Friday at 10 am?');
    expect(timeline.reply.prevAt).toEqual(at(-60));
    expect(timeline.reply.whole).toBe(true);

    // A Waves email whose own words run past what the model is shown is cut: the model's reading cannot lift the booking requirement.
    const longThread = `th-${tag}-z`;
    await mailRow({ gmail_thread_id: longThread, from_address: 'contact@wavespestcontrol.com', to_address: address, subject: 'Update', body_text: `${'Your account update is below. '.repeat(90)}Can we come Friday at 10 am?`, received_at: at(-60), label_ids: JSON.stringify(['SENT']) });
    const longYes = await mailRow({ gmail_thread_id: longThread, from_address: address, to_address: 'contact@wavespestcontrol.com', subject: 'Re: Update', body_text: 'Yes', received_at: T0, label_ids: JSON.stringify(['INBOX']), customer_id: cid });
    const cut = await agent.buildTimeline(await alert('inbound_email', 'Email from Test', '/admin/communications#tab=email', { payload: { emailId: longYes } }));
    expect(cut.reply.whole).toBe(false);
    expect(cut.reply.prevOutbound).not.toMatch(/Can we come Friday/);
  });

  test('an email yes: an HTML-only offer is read, a forward to staff is not the offer, a phone signature keeps the yes bare, an uncaptured send stops the pairing', async () => {
    const address = `h${tag}@example.test`;
    const cid = await customer({ email: address });
    const mailRow = async (row) => {
      const [r] = await db('emails').insert({ gmail_id: `g-${randomUUID()}`, cc_address: '', bcc_address: '', ...row }).returning('id');
      made.emails.push(r.id);
      return r.id;
    };
    const sent = { from_address: 'contact@wavespestcontrol.com', subject: 'Friday', label_ids: JSON.stringify(['SENT']) };
    const thread = `th-${tag}-h`;
    // A portal send stores HTML only (body_text empty); then staff forward the thread inside Waves; then the customer says yes.
    await mailRow({ ...sent, gmail_thread_id: thread, to_address: address, body_text: '', received_at: at(-60),
      body_html: '<div dir="ltr">Can we come Friday at 10 am?</div><div class="gmail_quote">On Mon, Nov 23, 2026 at 9:00 AM Waves wrote: an older note</div>' });
    await mailRow({ ...sent, gmail_thread_id: thread, to_address: 'office@wavespestcontrol.com', body_text: 'FYI, see below', received_at: at(-30) });
    const yes = await mailRow({ gmail_thread_id: thread, from_address: address, to_address: 'contact@wavespestcontrol.com', subject: 'Re: Friday',
      body_text: 'Yes\n\nSent from my iPhone', received_at: T0, label_ids: JSON.stringify(['INBOX']), customer_id: cid });
    const timeline = await agent.buildTimeline(await alert('inbound_email', 'Email from Test', '/admin/communications#tab=email', { payload: { emailId: yes } }));
    expect(timeline.reply).toEqual({ lastBody: 'Yes', prevOutbound: 'Can we come Friday at 10 am?', prevAt: at(-60), whole: true });

    // A newer send whose Cc was never captured may have reached the customer: the pairing stops there, so nothing is whole.
    const unsure = `th-${tag}-u`;
    await mailRow({ ...sent, gmail_thread_id: unsure, to_address: address, body_text: 'Can we come Friday at 10 am?', received_at: at(-60) });
    await mailRow({ ...sent, gmail_thread_id: unsure, to_address: address, cc_address: null, body_text: 'Or Monday at 2 pm?', received_at: at(-30) });
    const unsureYes = await mailRow({ gmail_thread_id: unsure, from_address: address, to_address: 'contact@wavespestcontrol.com', subject: 'Re: Friday',
      body_text: 'Yes', received_at: T0, label_ids: JSON.stringify(['INBOX']), customer_id: cid });
    const stopped = await agent.buildTimeline(await alert('inbound_email', 'Email from Test', '/admin/communications#tab=email', { payload: { emailId: unsureYes } }));
    expect(stopped.reply).toEqual({ lastBody: 'Yes', prevOutbound: '', prevAt: null, whole: false });
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

  test('a visit move is a date change only when Waves staff made it and the visit still holds it; a no-show row never is', async () => {
    const cid = await customer();
    const sid = `SM${tag}h`;
    await sms({ customer_id: cid, direction: 'inbound', twilio_sid: sid, message_body: 'can you move it to after 3', created_at: T0, status: 'received' });
    // The visit as it stands now: Jan 12, 3 to 4 PM.
    const [visit] = await db('scheduled_services').insert({ customer_id: cid, scheduled_date: '2027-01-12', window_start: '15:00', window_end: '16:00', service_type: 'Pest Control', status: 'pending', created_at: at(-600) }).returning('id');
    made.visits.push(visit.id);
    const move = async (row) => {
      const [r] = await db('reschedule_log').insert({ scheduled_service_id: visit.id, customer_id: cid, original_date: '2027-01-10', reason_code: 'x', created_at: at(20), ...row }).returning('id');
      made.reschedules.push(r.id);
      return String(r.id);
    };
    await move({ new_date: null, initiated_by: 'system' });
    const held = await move({ new_date: '2027-01-12', new_window: '15:00-16:00', initiated_by: 'admin' });
    const sameDay = await move({ original_date: '2027-01-12', original_window: '09:00-10:00', new_date: '2027-01-12', new_window: '15:00-15:30', initiated_by: 'tech' });
    const automatic = await move({ new_date: '2027-01-12', new_window: '15:00-16:00', initiated_by: 'auto_dispatch' });
    const ownMove = await move({ new_date: '2027-01-12', new_window: '15:00-16:00', initiated_by: 'customer_self_serve' });
    const since = await move({ new_date: '2027-01-11', new_window: '15:00-16:00', initiated_by: 'admin' });
    // The same window written another way, and a new end alone: no move at all.
    await move({ original_date: '2027-01-12', original_window: '15:00:00-16:00:00', new_date: '2027-01-12', new_window: '15:00-16:00', initiated_by: 'admin' });
    await move({ original_date: '2027-01-12', original_window: '15:00-16:00', new_date: '2027-01-12', new_window: '15:00-17:00', initiated_by: 'admin_bulk' });
    // A staff hand-off for the customer to pick a time (the row rain-out.js writes: due day, no time, its marker in notes).
    const handoff = await move({ new_date: '2027-01-12', new_window: null, initiated_by: 'admin', notes: require('../services/rain-out').PICK_LOG_MARKER });
    // A staff date edit with no time (the package follow-up edit writes one): a day-only proof, with no start in its slot.
    const dayOnly = await move({ new_date: '2027-01-12', initiated_by: 'admin', reason_code: 'admin_edit' });
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const moves = (await agent.buildTimeline(row)).events.filter((e) => e.type === 'reschedule');
    expect(moves.map((e) => e.id).sort()).toEqual([held, sameDay, automatic, ownMove, since, handoff, dayOnly].sort());
    expect(moves.filter((e) => e.proof === 'date_change').map((e) => e.id).sort()).toEqual([held, sameDay, dayOnly].sort());
    expect(moves.find((e) => e.id === dayOnly).line).toMatch(/to Tuesday 2027-01-12; the visit is still on that day; this move set no time$/);
    expect(moves.find((e) => e.id === since).line).toMatch(/not an answer now, as the visit has moved since, to Tuesday 2027-01-12, arrival 15:00-17:00$/);
    expect(moves.find((e) => e.id === handoff).line).toMatch(/^VISIT HANDED TO THE CUSTOMER TO PICK A TIME by Waves staff .*no time is booked, so this is no answer$/);
  });

  test('a staff day-only edit on a visit a later hand-off parked on that day (waiting for the customer\'s pick) is no proof', async () => {
    const cid = await customer();
    const sid = `SM${tag}p`;
    await sms({ customer_id: cid, direction: 'inbound', twilio_sid: sid, message_body: 'yes', created_at: T0, status: 'received' });
    // The visit as it stands now: parked on Jan 12 with no time, waiting for the customer to pick one.
    const [visit] = await db('scheduled_services').insert({ customer_id: cid, scheduled_date: '2027-01-12', window_start: null, window_end: null, customer_pick_by: at(1440), service_type: 'Pest Control', status: 'pending', created_at: at(-600) }).returning('id');
    made.visits.push(visit.id);
    const [edit] = await db('reschedule_log').insert({ scheduled_service_id: visit.id, customer_id: cid, original_date: '2027-01-10', new_date: '2027-01-12', reason_code: 'admin_edit', initiated_by: 'admin', created_at: at(20) }).returning('id');
    made.reschedules.push(edit.id);
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const moved = (await agent.buildTimeline(row)).events.find((e) => e.id === String(edit.id));
    expect(moved).toMatchObject({ proof: null, line: expect.stringMatching(/; not an answer now, as the visit waits for the customer to pick a time$/) });
  });

  test('a known customer keeps a person\'s text to the resolved number even when that row has no customer id (number not shared)', async () => {
    const cid = await customer();
    const number = phone(41);
    const sid = `SM${tag}i`;
    await sms({ customer_id: cid, direction: 'inbound', from_phone: number, twilio_sid: sid, message_body: 'hello', created_at: T0, status: 'received' });
    const unlinked = await sms({ customer_id: null, direction: 'outbound', to_phone: number, message_type: 'manual', status: 'delivered', message_body: 'unlinked text to the number', created_at: at(8), metadata: { human_authored: 'true' } });
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const timeline = await agent.buildTimeline(row);
    expect(timeline.events.filter((e) => e.proof === 'staff_text').map((e) => e.id)).toEqual([String(unlinked)]);
  });

  test('missed-call silence: the canonical inbox, an unended later call and the claim for THIS call are all read', async () => {
    const claim = (phoneNumber, callId) => db('missed_call_text_claims').insert({ phone: phoneNumber, outcome: 'sent', call_log_id: callId });
    const missedCall = async (number, extra = {}) => {
      const [r] = await db('call_log').insert({ from_phone: number, to_phone: '+15550003333', direction: 'inbound', status: 'no-answer', created_at: at(-2), duration_seconds: 4, metadata: JSON.stringify({}), ...extra }).returning('id');
      made.calls.push(r.id);
      return r.id;
    };
    const missedAlert = (callId) => alert('missed_call', 'Missed call', `/admin/communications#tab=calls&call=${callId}`, { payload: { callLogId: callId } });
    const day = new Date(T0.getTime() + 25 * 3600 * 1000);

    // quiet: claim for this call, nothing since
    const quietNumber = phone(51);
    const quietCall = await missedCall(quietNumber);
    await claim(quietNumber, quietCall);
    const quietTimeline = await agent.buildTimeline(await missedAlert(quietCall));
    expect(quietTimeline.call.textBackSent).toBe(true);
    expect(agent.ruleVerdict({ category: 'missed_call' }, quietTimeline, false, day)).toMatchObject({ outcome: 'nothing_to_answer', rule: 'quiet_unknown_missed_call' });

    // a text-back claimed for ANOTHER call is not this call's text-back
    const otherNumber = phone(52);
    const earlier = await missedCall(otherNumber, { created_at: at(-600) });
    const later = await missedCall(otherNumber);
    await claim(otherNumber, earlier);
    expect((await agent.buildTimeline(await missedAlert(later))).call.textBackSent).toBe(false);

    // the unified inbox holds a reply the text log never got: contact, so no silence
    const inboxNumber = phone(53);
    const inboxCall = await missedCall(inboxNumber);
    await claim(inboxNumber, inboxCall);
    const [conv] = await db('conversations').insert({ channel: 'sms', contact_phone: inboxNumber }).returning('id');
    made.conversations.push(conv.id);
    await db('messages').insert({ conversation_id: conv.id, channel: 'sms', direction: 'inbound', author_type: 'customer', body: 'who called me', twilio_sid: `SM${tag}j`, created_at: at(30) });
    const inboxTimeline = await agent.buildTimeline(await missedAlert(inboxCall));
    expect(inboxTimeline.events.some((e) => e.inbound && e.type === 'sms')).toBe(true);
    expect(agent.ruleVerdict({ category: 'missed_call' }, inboxTimeline, false, day)).toBeNull();

    // a later call row with no end stamp (a recovered, post-call row) is contact too
    const droppedNumber = phone(54);
    const droppedCall = await missedCall(droppedNumber);
    await claim(droppedNumber, droppedCall);
    await missedCall(droppedNumber, { created_at: at(40), direction: 'inbound', duration_seconds: null, metadata: JSON.stringify({ source: 'twilio_recording_status_recovered' }) });
    const droppedTimeline = await agent.buildTimeline(await missedAlert(droppedCall));
    expect(droppedTimeline.events.some((e) => e.type === 'call')).toBe(true);
    expect(droppedTimeline.events.filter((e) => e.type === 'call').every((e) => e.proof === null)).toBe(true);
    expect(agent.ruleVerdict({ category: 'missed_call' }, droppedTimeline, false, day)).toBeNull();
  });

  test('a bounced text-back is none, and a robocall closes by its own rule from the call\'s own stamps', async () => {
    const day = new Date(T0.getTime() + 25 * 3600 * 1000);
    const missedCall = async (number, metadata = {}, extra = {}) => {
      const [r] = await db('call_log').insert({ from_phone: number, to_phone: '+15550003333', direction: 'inbound', status: 'no-answer', created_at: at(-2), duration_seconds: 4, metadata: JSON.stringify(metadata), ...extra }).returning('id');
      made.calls.push(r.id);
      return r.id;
    };
    const timelineFor = async (callId) => agent.buildTimeline(await alert('missed_call', 'Missed call', `/admin/communications#tab=calls&call=${callId}`, { payload: { callLogId: callId } }));

    // The claim says sent, but the text it sent bounced: no text-back reached the caller. The row carries no call id, as the send
    // pipeline writes it; the number's one text-back row is the claim's text.
    const bouncedNumber = phone(61);
    const bouncedCall = await missedCall(bouncedNumber);
    await db('missed_call_text_claims').insert({ phone: bouncedNumber, outcome: 'sent', call_log_id: bouncedCall });
    await sms({ direction: 'outbound', to_phone: bouncedNumber, message_type: 'missed_call_text_back', status: 'undelivered', twilio_sid: `SM${tag}k`, message_body: 'Sorry we missed your call', created_at: at(1), metadata: { template_key: 'missed_call_text_back' } });
    const bounced = await timelineFor(bouncedCall);
    expect(bounced.call).toMatchObject({ textBackSent: false, textBackUnsent: true, robocall: null, textBackState: 'sent:undelivered' });
    expect(agent.ruleVerdict({ category: 'missed_call' }, bounced, false, day)).toBeNull();

    // A cancelled text never went out, though the claim says sent. The agent's text base hides cancelled rows; this read keeps them.
    const textBackCall = async (n, claim, status, sentAt, suffix) => {
      const number = phone(n);
      const callId = await missedCall(number);
      await db('missed_call_text_claims').insert({ phone: number, outcome: claim, call_log_id: callId });
      await sms({ direction: 'outbound', to_phone: number, message_type: 'missed_call_text_back', status, twilio_sid: `SM${tag}${suffix}`, message_body: 'Sorry we missed your call', created_at: sentAt });
      return (await timelineFor(callId)).call;
    };
    const cancelled = await textBackCall(66, 'sent', 'cancelled', at(1), 'tb1');
    expect(cancelled).toMatchObject({ textBackSent: false, textBackUnsent: true, textBackState: 'sent:cancelled' });
    // An unclear provider reply left the claim uncertain, then the provider's receipt said delivered: the text reached the caller.
    expect(await textBackCall(67, 'uncertain', 'delivered', at(1), 'tb2')).toMatchObject({ textBackSent: true, textBackUnsent: false, textBackState: 'uncertain:delivered' });
    // Only a text written after this call began is this call's: an older delivered text-back to the number is not.
    expect(await textBackCall(68, 'uncertain', 'delivered', at(-600), 'tb3')).toMatchObject({ textBackSent: false, textBackState: 'uncertain:none' });

    // The same number calls again: the lane holds its one claim on the first call, so the delivered or bounced text is not this call's.
    const repeatNumber = phone(65);
    const firstCall = await missedCall(repeatNumber, {}, { created_at: at(-600) });
    const repeatCall = await missedCall(repeatNumber);
    await db('missed_call_text_claims').insert({ phone: repeatNumber, outcome: 'sent', call_log_id: firstCall });
    await sms({ direction: 'outbound', to_phone: repeatNumber, message_type: 'missed_call_text_back', status: 'delivered', twilio_sid: `SM${tag}m`, message_body: 'Sorry we missed your call', created_at: at(-598) });
    expect((await timelineFor(repeatCall)).call).toMatchObject({ textBackSent: false, textBackUnsent: false, textBackState: 'none:none' });

    // A failed press-1 screen: a robocall, closed after 24 hours although no text-back went out.
    const screened = await timelineFor(await missedCall(phone(62), { preconnect_screen: 'failed' }));
    expect(screened.call).toMatchObject({ textBackSent: false, robocall: 'screen_failed' });
    expect(agent.ruleVerdict({ category: 'missed_call' }, screened, false, day)).toMatchObject({ outcome: 'nothing_to_answer', rule: 'quiet_robocall' });

    // The bell's robodialer pattern marker alone is no robocall: a genuine caller can match a wave.
    const waved = await timelineFor(await missedCall(phone(63), { missed_call_spam_wave: 'block_quiet' }));
    expect(waved.call.robocall).toBeNull();
    expect(agent.ruleVerdict({ category: 'missed_call' }, waved, false, day)).toBeNull();

    // A bridged form callback rings the staff cell first, so the caller's number is only in metadata.leadPhone. Waves called the
    // number back: rule 1 stays off, as for any call from Waves to it.
    const calledBack = phone(64);
    const calledBackCall = await missedCall(calledBack, { preconnect_screen: 'failed' });
    const [bridge] = await db('call_log').insert({ from_phone: '+15550003333', to_phone: '+15550009999', direction: 'outbound', status: 'completed', created_at: at(30), duration_seconds: 40, metadata: JSON.stringify({ leadPhone: calledBack }) }).returning('id');
    made.calls.push(bridge.id);
    const bridged = await timelineFor(calledBackCall);
    expect(bridged.events.find((e) => e.id === String(bridge.id))).toMatchObject({ type: 'call', inbound: false });
    expect(agent.ruleVerdict({ category: 'missed_call' }, bridged, false, day)).toBeNull();
  });

  test('an inbound call that went from hold to voicemail answers only up to the hold', async () => {
    const cid = await customer();
    const call = async (row) => {
      const [r] = await db('call_log').insert({ customer_id: cid, from_phone: '+15550007777', to_phone: '+15550003333', direction: 'inbound', status: 'completed', answered_by: 'human', duration_seconds: 600, ...row }).returning('id');
      made.calls.push(r.id);
      return r.id;
    };
    const holdMeta = (voicemailAt, endedAt) => JSON.stringify({ ended_at: endedAt.toISOString(), conference_path: { hold: { voicemail_at: voicemailAt.toISOString() } } });
    const duringBell = await call({ created_at: at(10), metadata: holdMeta(at(12), at(40)) });
    await call({ created_at: at(-20), metadata: holdMeta(at(-15), at(40)) });
    const sid = `SM${tag}k`;
    await sms({ customer_id: cid, direction: 'inbound', twilio_sid: sid, message_body: 'call me', created_at: T0, status: 'received' });
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const timeline = await agent.buildTimeline(row);
    const human = timeline.events.filter((e) => e.proof === 'human_call');
    expect(human.map((e) => e.id)).toEqual([String(duringBell)]);
    expect(human[0].at).toEqual(at(12));
  });

  test('"voicemail left" follows the recording and its transcription status, as the missed-call bell reads it', async () => {
    const hasVoicemail = async (row) => {
      const [c] = await db('call_log').insert({ from_phone: phone(60 + made.calls.length), to_phone: '+15550003333', direction: 'inbound', status: 'no-answer', created_at: at(-2), duration_seconds: 20, metadata: JSON.stringify({}), ...row }).returning('id');
      made.calls.push(c.id);
      const timeline = await agent.buildTimeline(await alert('missed_call', 'Missed call', `/admin/communications#tab=calls&call=${c.id}`, { payload: { callLogId: c.id } }));
      return timeline.call.hasVoicemail;
    };
    expect(await hasVoicemail({ recording_sid: 'RE1', transcription_status: 'pending' })).toBe(true);
    expect(await hasVoicemail({ recording_sid: 'RE2', transcription_status: 'failed' })).toBe(true);
    expect(await hasVoicemail({ recording_sid: 'RE3', transcription_status: 'completed', transcription: '[NO SPEECH]' })).toBe(false);
    expect(await hasVoicemail({ recording_sid: 'RE4', transcription_status: 'completed', transcription: 'please call me about ants' })).toBe(true);
    expect(await hasVoicemail({})).toBe(false);
  });

  test('an email alert for a linked customer also reads texts on the customer\'s own number, with or without a customer id', async () => {
    const number = phone(71);
    const address = `p${tag}@example.test`;
    const cid = await customer({ email: address, phone: number });
    const [mail] = await db('emails').insert({ gmail_id: `g-${randomUUID()}`, cc_address: '', bcc_address: '', gmail_thread_id: `th-${tag}-p`, from_address: address, to_address: 'contact@wavespestcontrol.com', subject: 'Hi', body_text: 'hello', received_at: T0, label_ids: JSON.stringify(['INBOX']), customer_id: cid }).returning('id');
    made.emails.push(mail.id);
    const unlinked = await sms({ customer_id: null, direction: 'outbound', to_phone: number, message_type: 'manual', status: 'delivered', message_body: 'unlinked person text to the customer number', created_at: at(10), metadata: { human_authored: 'true' } });
    const row = await alert('inbound_email', 'Email from Test', '/admin/communications#tab=email', { payload: { emailId: mail.id } });
    const timeline = await agent.buildTimeline(row);
    expect(timeline.events.filter((e) => e.proof === 'staff_text').map((e) => e.id)).toEqual([String(unlinked)]);
  });

  test('recruiting messages in the unified inbox never reach the timeline, even for a customer who is also an applicant', async () => {
    const cid = await customer();
    const number = phone(81);
    const [conv] = await db('conversations').insert({ channel: 'sms', customer_id: cid, contact_phone: number }).returning('id');
    made.conversations.push(conv.id);
    const inbox = (row) => db('messages').insert({ conversation_id: conv.id, channel: 'sms', direction: 'inbound', author_type: 'customer', ...row });
    await inbox({ body: 'Here is my resume and availability', message_type: 'job_applicant_reply', twilio_sid: `SM${tag}r1`, created_at: at(10) });
    await inbox({ body: 'my ant problem got worse', twilio_sid: `SM${tag}r2`, created_at: at(12) });
    const sid = `SM${tag}r0`;
    await sms({ customer_id: cid, direction: 'inbound', twilio_sid: sid, message_body: 'hello', created_at: T0, status: 'received' });
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const timeline = await agent.buildTimeline(row);
    const lines = timeline.events.map((e) => e.line).join('\n');
    expect(lines).toMatch(/ant problem got worse/);
    expect(lines).not.toMatch(/resume/);
    // the trigger itself: a recruiting message is never resolved as the text a bell is about
    await inbox({ body: 'applicant reply as trigger', message_type: 'job_applicant_reply', twilio_sid: `SM${tag}r3`, created_at: at(-5) });
    const trig = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=SM${tag}r3`);
    const trigTimeline = await agent.buildTimeline(trig);
    expect(trigTimeline.ctx.join('\n')).not.toMatch(/applicant reply as trigger/);
  });

  test('a recruiting reply mirrored in both tables never reaches the timeline, and a SID that does not resolve is unreadable', async () => {
    const cid = await customer();
    const number = phone(91);
    const sid = `SM${tag}m1`;
    const [conv] = await db('conversations').insert({ channel: 'sms', customer_id: cid, contact_phone: number }).returning('id');
    made.conversations.push(conv.id);
    await db('messages').insert({ conversation_id: conv.id, channel: 'sms', direction: 'inbound', author_type: 'customer', body: 'mirrored applicant secret resume', message_type: 'job_applicant_reply', twilio_sid: sid, created_at: T0 });
    await sms({ customer_id: cid, direction: 'inbound', from_phone: number, message_type: 'job_applicant_reply', twilio_sid: sid, message_body: 'mirrored applicant secret resume', created_at: T0, status: 'received' });
    // a real, earlier inbound text exists: the bell must not fall back to it
    await sms({ customer_id: cid, direction: 'inbound', from_phone: number, twilio_sid: `SM${tag}m0`, message_body: 'an ordinary earlier text', created_at: at(-60), status: 'received' });
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`);
    const timeline = await agent.buildTimeline(row);
    expect(timeline.unreadable).toBe(true);
    expect(JSON.stringify(timeline)).not.toMatch(/secret resume/);
    const missing = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=SM${tag}gone`);
    const missingTimeline = await agent.buildTimeline(missing);
    expect(missingTimeline.unreadable).toBe(true);
    expect(missingTimeline.ctx).toEqual([]);
  });

  test('a shared phone admits only rows tied to the customer; an unshared one also admits unlinked rows', async () => {
    const number = phone(82);
    const mine = await customer({ phone: number });
    await customer({ phone: number });
    const sid = `SM${tag}s1`;
    await sms({ customer_id: mine, direction: 'inbound', from_phone: number, twilio_sid: sid, message_body: 'hi', created_at: T0, status: 'received' });
    await sms({ customer_id: null, direction: 'outbound', to_phone: number, message_type: 'manual', status: 'delivered', message_body: 'unlinked text to a shared number', created_at: at(5), metadata: { human_authored: 'true' } });
    const linked = await sms({ customer_id: mine, direction: 'outbound', to_phone: number, message_type: 'manual', status: 'delivered', message_body: 'text tied to this customer', created_at: at(6), metadata: { human_authored: 'true' } });
    const row = await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${mine}&message=${sid}`);
    const timeline = await agent.buildTimeline(row);
    expect(timeline.complete).toBe(true);
    expect(timeline.events.filter((e) => e.proof === 'staff_text').map((e) => e.id)).toEqual([String(linked)]);
  });

  test('the offer behind a "yes" is the last text the customer received, however many rows sit between', async () => {
    const cid = await customer();
    const sid = `SM${tag}o1`;
    const number = phone(75);
    await sms({ customer_id: cid, direction: 'outbound', from_phone: LINE, to_phone: number, message_type: 'manual', status: 'delivered', message_body: 'Friday at 10 am works for the visit?', created_at: at(-600), metadata: { human_authored: 'true' } });
    await sms({ customer_id: cid, direction: 'outbound', from_phone: LINE, to_phone: number, message_type: 'manual', status: 'queued', message_body: 'never delivered text', created_at: at(-100), metadata: { human_authored: 'true' } });
    for (let i = 0; i < 15; i += 1) await sms({ customer_id: cid, direction: 'inbound', from_phone: number, message_body: `chatter ${i}`, created_at: at(-500 + i), status: 'received' });
    await sms({ customer_id: cid, direction: 'inbound', from_phone: number, twilio_sid: sid, message_body: 'Yes', created_at: T0, status: 'received' });
    const timeline = await agent.buildTimeline(await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`));
    expect(timeline.reply).toEqual({ lastBody: 'Yes', prevOutbound: 'Friday at 10 am works for the visit?', prevAt: at(-600), whole: true });
  });

  // A customer with two numbers: the yes from the first number answers the offer sent to it, never a later bill sent to the other.
  test('the offer behind a text "yes" is the last text sent to the number the yes came from', async () => {
    const cid = await customer();
    const sid = `SM${tag}o2`;
    const [main, other] = [phone(76), phone(77)];
    await sms({ customer_id: cid, direction: 'outbound', from_phone: LINE, to_phone: main, message_type: 'manual', status: 'delivered', message_body: 'Can we come Friday at 10 am?', created_at: at(-60), metadata: { human_authored: 'true' } });
    await sms({ customer_id: cid, direction: 'outbound', from_phone: LINE, to_phone: other, message_type: 'reminder', status: 'delivered', message_body: 'Your invoice is ready.', created_at: at(-10) });
    await sms({ customer_id: cid, direction: 'inbound', from_phone: main, to_phone: LINE, twilio_sid: sid, message_body: 'Yes', created_at: T0, status: 'received' });
    const timeline = await agent.buildTimeline(await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`));
    expect(timeline.reply).toMatchObject({ prevOutbound: 'Can we come Friday at 10 am?', whole: true });
  });

  // One customer number, two Waves lines: a yes sent back to the office that offered Friday answers that offer, never a later bill
  // from the billing line; a yes to the billing line answers the bill.
  test('the offer behind a text "yes" is the last text from the Waves line the yes came to', async () => {
    const cid = await customer();
    const number = phone(78);
    await sms({ customer_id: cid, direction: 'outbound', from_phone: LINE, to_phone: number, message_type: 'manual', status: 'delivered', message_body: 'Can we come Friday at 10 am?', created_at: at(-60), metadata: { human_authored: 'true' } });
    await sms({ customer_id: cid, direction: 'outbound', from_phone: OTHER_LINE, to_phone: number, message_type: 'reminder', status: 'delivered', message_body: 'Your invoice is ready.', created_at: at(-10) });
    await sms({ customer_id: cid, direction: 'inbound', from_phone: number, to_phone: LINE, twilio_sid: `SM${tag}o3`, message_body: 'Yes', created_at: T0, status: 'received' });
    await sms({ customer_id: cid, direction: 'inbound', from_phone: number, to_phone: OTHER_LINE, twilio_sid: `SM${tag}o4`, message_body: 'Ok', created_at: at(1), status: 'received' });
    const toOffice = await agent.buildTimeline(await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=SM${tag}o3`));
    expect(toOffice.reply).toMatchObject({ prevOutbound: 'Can we come Friday at 10 am?', prevAt: at(-60), whole: true });
    const toBilling = await agent.buildTimeline(await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=SM${tag}o4`));
    expect(toBilling.reply).toMatchObject({ lastBody: 'Ok', prevOutbound: 'Your invoice is ready.', prevAt: at(-10), whole: true });
  });

  // A thread bell with no message id: the reply is the latest text in, found by its own query (13 later Waves texts fill the
  // 12-line excerpt), and its own two numbers find the message it answers.
  test('a thread bell with no message id pairs the latest text in by its own numbers, past a full excerpt', async () => {
    const cid = await customer();
    const number = phone(79);
    await sms({ customer_id: cid, direction: 'outbound', from_phone: LINE, to_phone: number, message_type: 'reminder', status: 'delivered', message_body: 'Your visit is on Friday.', created_at: at(-200) });
    await sms({ customer_id: cid, direction: 'inbound', from_phone: number, to_phone: LINE, message_body: 'OK', created_at: at(-100), status: 'received' });
    for (let i = 0; i < 13; i += 1) await sms({ customer_id: cid, direction: 'outbound', from_phone: LINE, to_phone: number, message_type: 'reminder', status: 'delivered', message_body: `notice ${i}`, created_at: at(-90 + i) });
    const timeline = await agent.buildTimeline(await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}`));
    expect(timeline.reply).toEqual({ lastBody: 'OK', prevOutbound: 'Your visit is on Friday.', prevAt: at(-200), whole: true });
  });

  // The Waves line comes from the canonical address rule: the message's own endpoint before the thread's (a thread can be
  // re-pointed). And an app push notice, even one that kept the text line's number, is no text the customer answered by text.
  test('the reply\'s Waves line is the message\'s own endpoint, and a push notice is never the offer', async () => {
    const cid = await customer();
    const number = phone(80);
    const sid = `SM${tag}o5`;
    const [conv] = await db('conversations').insert({ channel: 'sms', customer_id: cid, contact_phone: number, our_endpoint_id: OTHER_LINE }).returning('id');
    made.conversations.push(conv.id);
    await db('messages').insert({ conversation_id: conv.id, channel: 'sms', direction: 'inbound', author_type: 'customer', body: 'Yes', twilio_sid: sid, created_at: T0, metadata: JSON.stringify({ sms_our_endpoint_id: LINE }) });
    await sms({ customer_id: cid, direction: 'outbound', from_phone: LINE, to_phone: number, message_type: 'manual', status: 'delivered', message_body: 'Can we come Friday at 10 am?', created_at: at(-60), metadata: { human_authored: 'true' } });
    await sms({ customer_id: cid, direction: 'outbound', from_phone: LINE, to_phone: number, message_type: 'reminder', status: 'sent', message_body: 'Your visit is coming up.', created_at: at(-20), metadata: { channel: 'push', providerAccepted: 'true' } });
    await sms({ customer_id: cid, direction: 'outbound', from_phone: OTHER_LINE, to_phone: number, message_type: 'reminder', status: 'delivered', message_body: 'Your invoice is ready.', created_at: at(-10) });
    const timeline = await agent.buildTimeline(await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`));
    expect(timeline.reply).toMatchObject({ lastBody: 'Yes', prevOutbound: 'Can we come Friday at 10 am?', prevAt: at(-60), whole: true });
  });

  test('a visit that ran is filtered, ordered and dated by completed_at; a cancelled one and one with no completed_at are not', async () => {
    const cid = await customer();
    const sid = `SM${tag}v1`;
    await sms({ customer_id: cid, direction: 'inbound', twilio_sid: sid, message_body: 'did you finish', created_at: T0, status: 'received' });
    const visit = async (row) => {
      const [r] = await db('scheduled_services').insert({ customer_id: cid, scheduled_date: '2027-01-10', service_type: 'Pest Control', created_at: at(-900), ...row }).returning('id');
      made.visits.push(r.id);
      return r.id;
    };
    const ran = await visit({ status: 'completed', completed_at: at(30), updated_at: at(-800) });
    await visit({ status: 'cancelled', completed_at: at(31) });
    await visit({ status: 'completed', completed_at: null, updated_at: at(32) });
    const timeline = await agent.buildTimeline(await alert('inbound_sms', 'Text from Test', `/admin/communications?thread=${cid}&message=${sid}`));
    const done = timeline.events.filter((e) => e.type === 'visit');
    expect(done.map((e) => e.id)).toEqual([String(ran)]);
    expect(done[0].at).toEqual(at(30));
    expect(done[0].proof).toBeNull();
  });

  test('a text-back claim that moves from dispatching to sent changes the fingerprint on its own', async () => {
    const number = phone(83);
    const [c] = await db('call_log').insert({ from_phone: number, to_phone: '+15550003333', direction: 'inbound', status: 'no-answer', created_at: at(-2), duration_seconds: 4, metadata: JSON.stringify({}) }).returning('id');
    made.calls.push(c.id);
    await db('missed_call_text_claims').insert({ phone: number, outcome: 'dispatching', call_log_id: c.id });
    const row = await alert('missed_call', 'Missed call', `/admin/communications#tab=calls&call=${c.id}`, { payload: { callLogId: c.id } });
    const before = agent.fingerprintOf(row, await agent.buildTimeline(row), new Date());
    await db('missed_call_text_claims').where({ call_log_id: c.id }).update({ outcome: 'sent' });
    const after = agent.fingerprintOf(row, await agent.buildTimeline(row), new Date());
    expect(after).not.toBe(before);
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
