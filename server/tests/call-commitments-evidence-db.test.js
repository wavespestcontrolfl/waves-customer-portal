// Promises that close on proof (PROMISE_EVIDENCE_CLOSE, owner ruling
// 2026-09-28): an association proof closes an open Waves promise with the
// evidence stored on the row, a customer who left dismisses it, a reopened
// promise stays open, and with the switch off nothing changes. The switch
// reader and the off-path run everywhere; the lookups and writes run on a
// real Postgres (CI's DB-gated step, DATABASE_URL). Fixtures fictitious.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { promiseEvidenceCloseLive } = require('../config/feature-gates');

describe('PROMISE_EVIDENCE_CLOSE switch', () => {
  const original = process.env.PROMISE_EVIDENCE_CLOSE;
  afterEach(() => {
    if (original === undefined) delete process.env.PROMISE_EVIDENCE_CLOSE; else process.env.PROMISE_EVIDENCE_CLOSE = original;
  });

  test.each([
    [undefined, true], ['', true], ['on', true], ['true', true], ['1', true], ['anything', true],
    ['off', false], ['OFF', false], [' Off ', false], ['false', false], ['FALSE', false], ['0', false],
  ])('%p reads as live=%p — default on, off only for off / false / 0', (value, live) => {
    if (value === undefined) delete process.env.PROMISE_EVIDENCE_CLOSE; else process.env.PROMISE_EVIDENCE_CLOSE = value;
    expect(promiseEvidenceCloseLive()).toBe(live);
  });

  test('off, the new evidence is never looked up: a kind-other promise resolves to nothing without touching the database', async () => {
    const cc = require('../services/call-commitments');
    const conn = () => { throw new Error('no query expected'); };
    const call = { id: 'c1', created_at: new Date('2026-09-01T14:00:00Z'), duration_seconds: 30, direction: 'inbound', from_phone: '+15555550100', customer_id: '00000000-0000-4000-8000-000000000001' };
    const other = { id: 'p1', party: 'waves', kind: 'other', human_state: null };
    process.env.PROMISE_EVIDENCE_CLOSE = 'off';
    expect(await cc.resolveFulfillment(conn, other, call)).toBeNull();
    // On, the lookups start (proved by the query attempt); a customer's own promise is never judged by them.
    process.env.PROMISE_EVIDENCE_CLOSE = 'on';
    await expect(cc.resolveFulfillment(conn, other, call)).rejects.toThrow('no query expected');
    expect(await cc.resolveFulfillment(conn, { ...other, party: 'customer' }, call)).toBeNull();
  });
});

// The kind -> evidence rule, with no database: only a record that matches the
// promise's own kind may close it, and a booking keeps a scheduling promise only.
describe('evidence matches the promise kind', () => {
  const { evidenceNamesFor } = require('../services/call-commitments');
  const names = (kind, extra = {}) => evidenceNamesFor({ kind, ...extra });

  test.each([
    ['send_estimate', {}],
    ['callback', {}],
    ['other', {}],
    ['other', { channel: 'sms' }],
    ['other', { channel: 'call' }],
    ['other', { channel: 'email' }],
    ['other', { description: 'Text the customer the appointment options' }],
    ['send_report', {}],
  ])('%s %j never takes a booked visit, a finished visit or the customer phoning in', (kind, extra) => {
    const list = names(kind, extra);
    for (const forbidden of ['visit_booked', 'visit_done', 'caller_called_in']) expect(list).not.toContain(forbidden);
  });

  test('a booking or a finished visit keeps a scheduling promise only', () => {
    expect(names('schedule_visit')).toEqual(['visit_done']);
  });

  test('estimate and callback promises have no association evidence beyond their own direct lookups', () => {
    expect(names('send_estimate')).toEqual([]);
    expect(names('callback')).toEqual([]);
  });

  test('an "other" promise reads its channel and its words: a text or call promise takes only that text or call, anything else takes an estimate', () => {
    expect(names('other', { channel: 'sms' })).toEqual(['text_sent']);
    expect(names('other', { channel: 'call' })).toEqual(['call_placed']);
    expect(names('other', { channel: 'email', description: 'Text and email the quote' })).toEqual(['estimate']);
    expect(names('other', { channel: null, description: 'Text appointment options' })).toEqual(['text_sent']);
    expect(names('other', { channel: 'unknown', description: 'Send the SMS link' })).toEqual(['text_sent']);
    expect(names('other', { channel: null, description: 'Call the customer with the pricing' })).toEqual(['call_placed']);
    expect(names('other', { channel: 'unknown', description: 'Ring them back tomorrow' })).toEqual(['call_placed']);
    expect(names('other', { channel: null, description: 'Call or text the options' })).toEqual(['text_sent', 'call_placed']);
    expect(names('other', { channel: 'email', description: 'Call and email the quote' })).toEqual(['estimate']);
    expect(names('other', { channel: null, description: 'Link the customer into the irrigation email' })).toEqual(['estimate']);
    expect(names('other', { channel: null, description: 'The context line' })).toEqual(['estimate']);
  });
});

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const OUR_NUMBER = '+15555550100';
const DAY = 24 * 60 * 60 * 1000;

maybeDescribe('promises close on proof (live Postgres)', () => {
  let db;
  let cc;
  let seq = 0;
  const made = { callIds: [], customerIds: [], smsIds: [], visitIds: [], estimateIds: [], emailIds: [], emailMessageIds: [], commitmentIds: [], leadIds: [] };
  const original = process.env.PROMISE_EVIDENCE_CLOSE;

  beforeAll(() => {
    db = require('../models/db');
    cc = require('../services/call-commitments');
  });
  afterAll(async () => {
    if (original === undefined) delete process.env.PROMISE_EVIDENCE_CLOSE; else process.env.PROMISE_EVIDENCE_CLOSE = original;
    const del = async (table, ids) => { if (ids.length) await db(table).whereIn('id', ids).del(); };
    await db('audit_log').whereIn('resource_id', made.commitmentIds).del();
    await del('email_messages', made.emailMessageIds);
    await del('emails', made.emailIds);
    await del('estimates', made.estimateIds);
    await del('leads', made.leadIds);
    await del('scheduled_services', made.visitIds);
    await del('sms_log', made.smsIds);
    await del('call_log', made.callIds); // cascades the commitments
    await del('customers', made.customerIds);
    await db.destroy();
  });
  beforeEach(() => { delete process.env.PROMISE_EVIDENCE_CLOSE; delete process.env.GATE_CALLBACK_CARD; });

  // One customer, one call that ended three days ago, one open promise.
  async function world({ kind = 'other', party = 'waves', customer = true, human_state = null, status = 'open', customerExtra = {}, channel = null, description = null } = {}) {
    seq += 1;
    const n = String(seq).padStart(4, '0');
    const phone = `+1555555${n}`;
    const email = `evidence${n}@example.invalid`;
    let customerId = null;
    if (customer) {
      const [row] = await db('customers').insert({ first_name: `Evidence${n}`, phone, email, ...customerExtra }).returning('id');
      customerId = row.id;
      made.customerIds.push(customerId);
    }
    const [call] = await db('call_log').insert({
      twilio_call_sid: `CA${'6'.repeat(24)}${n}ev`, direction: 'inbound', from_phone: phone, to_phone: OUR_NUMBER, status: 'completed',
      duration_seconds: 90, customer_id: customerId, created_at: new Date(Date.now() - 3 * DAY),
    }).returning('*');
    made.callIds.push(call.id);
    const [commitment] = await db('call_commitments').insert({
      call_log_id: call.id, commitment_key: `${party}:${kind}`, party, kind, description: description || `Fixture ${kind}`, channel, source: 'ai',
      last_seen_generation: 1, evidence: '[]', human_state, status,
    }).returning('*');
    made.commitmentIds.push(commitment.id);
    return { n, phone, email, customerId, call, commitment };
  }
  const later = (minutes = 30) => new Date(Date.now() - 3 * DAY + (90 + minutes * 60) * 1000);
  // When the portal closed a row (the proof's closed_at), set back for a test.
  const closedAt = (ids, at) => db('call_commitments').whereIn('id', [].concat(ids))
    .update({ fulfillment: db.raw("fulfillment || jsonb_build_object('closed_at', ?::text)", [at.toISOString()]) });
  // A churned customer: the live stage plus the churn date, N days ago.
  const churnedStage = (daysAgo) => ({ pipeline_stage: 'churned', churned_at: new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10) });
  // Every page of the closed-automatically list, walked with its cursor.
  const allAutoClosed = async (days, limit = 100) => {
    const all = [];
    let before = null;
    for (let page = 0; page < 1000; page += 1) {
      const { commitments, next } = await cc.listAutoClosedCommitments(db, { days, limit, before });
      all.push(...commitments);
      if (!next) return all;
      before = next;
    }
    throw new Error('the closed-automatically walk never ended');
  };
  const row = (id) => db('call_commitments').where({ id }).first();
  const track = (list) => async (query) => { const [r] = await query.returning('id'); list.push(r.id); return r; };
  const addSms = track(made.smsIds);
  const addVisit = track(made.visitIds);

  // Each evidence path: the seed that makes it true, the basis it is stored
  // under, and a near-miss that must not close.
  const inbound = (w, extra = {}) => db('call_log').insert({
    twilio_call_sid: `CA${'5'.repeat(24)}${w.n}in${Object.keys(extra).length}`, direction: 'inbound', from_phone: w.phone, to_phone: OUR_NUMBER, status: 'completed',
    duration_seconds: 75, v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: false, is_spam: false } }), customer_id: w.customerId, created_at: later(), ...extra,
  }).returning('id').then(([r]) => { made.callIds.push(r.id); return r; });
  // A call a person placed through the staff bridge that reached a live conversation.
  const outboundCall = (w, extra = {}) => db('call_log').insert({
    twilio_call_sid: `CA${'4'.repeat(24)}${w.n}ou${Object.keys(extra).length}`, direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, status: 'completed',
    duration_seconds: 80, customer_id: w.customerId, created_at: later(), source: 'admin-click',
    v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: false } }), ...extra,
  }).returning('id').then(([r]) => { made.callIds.push(r.id); return r; });
  const sms = (w, message_type, extra = {}) => addSms(db('sms_log').insert({
    direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, customer_id: w.customerId, message_type, status: 'sent', created_at: later(), ...extra }));
  // A text a person wrote in the composer: 'manual' plus the human_authored stamp.
  const staffText = (w, extra = {}) => sms(w, 'manual', { status: 'delivered', metadata: JSON.stringify({ human_authored: true }), ...extra });
  const visit = (w, extra = {}) => addVisit(db('scheduled_services').insert({
    scheduled_date: '2026-12-01', service_type: 'General Pest Control', status: 'pending', customer_id: w.customerId, created_at: later(), ...extra }));
  const estimate = async (w) => {
    const [r] = await db('estimates').insert({
      status: 'sent', customer_id: w.customerId, customer_phone: w.phone, sent_at: later(), created_at: later(),
      estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: later().toISOString(), lastDeliveredAt: later().toISOString() } }),
    }).returning('id');
    made.estimateIds.push(r.id);
    return r;
  };
  const reportEmail = async (w, extra = {}) => {
    const [r] = await db('email_messages').insert({
      recipient_type: 'customer', recipient_id: String(w.customerId), recipient_email_snapshot: w.email, template_key: 'service.report_ready', status: 'sent', sent_at: later(), ...extra,
    }).returning('id');
    made.emailMessageIds.push(r.id);
    return r;
  };

  // Each row: the promise kind (and the channel it names), the record that
  // keeps it, the basis stored, the proof kind. Only evidence that matches the
  // KIND of the promise closes it (see the booking-never-closes test below).
  const CASES = [
    ['other', null, 'an estimate sent to the customer', (w) => estimate(w), 'estimate_sent_to_same_customer_within_14_days', 'estimate_sent'],
    ['other', 'sms', 'a text a person sent to the caller', (w) => staffText(w), 'text_sent_to_caller_within_14_days', 'sms_sent'],
    ['other', 'sms', 'the booking lane\'s link text to the caller', (w) => sms(w, 'call_booking_link_text'), 'text_sent_to_caller_within_14_days', 'sms_sent'],
    ['other', 'call', 'a call a person placed to the caller', (w) => outboundCall(w), 'outbound_call_to_caller_within_14_days', 'outbound_call'],
    ['schedule_visit', null, 'a visit completed for the customer', (w) => visit(w, { status: 'completed', completed_at: later(), created_at: new Date(Date.now() - 20 * DAY) }), 'visit_completed_for_same_customer_within_14_days', 'visit_completed'],
    ['send_report', null, 'a service report text to the caller', (w) => sms(w, 'service_report'), 'service_report_text_to_caller_within_14_days', 'sms_sent'],
    ['send_report', null, 'a service report email to the customer', (w) => reportEmail(w), 'service_report_email_to_customer_within_14_days', 'email_sent'],
    ['send_paperwork', null, 'a service report text to the caller', (w) => sms(w, 'service_report_ready'), 'service_report_text_to_caller_within_14_days', 'sms_sent'],
  ];

  test.each(CASES)('%s (%s): %s closes the promise with the proof stored; with the switch off it stays open and unchanged', async (kind, channel, _what, seed, basis, proofKind) => {
    const w = await world({ kind, channel });
    const record = await seed(w);
    process.env.PROMISE_EVIDENCE_CLOSE = 'off';
    const before = await row(w.commitment.id);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
    const untouched = await row(w.commitment.id);
    expect(untouched).toMatchObject({ status: 'open', human_state: null });
    // Off is today's contract: only a pre-existing hint may be written; the new evidence is invisible.
    if (untouched.fulfillment) expect(untouched.fulfillment.basis).not.toBe(basis);
    expect(untouched.status).toBe(before.status);
    delete process.env.PROMISE_EVIDENCE_CLOSE;
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1, failed: 0 });
    const closed = await row(w.commitment.id);
    expect(closed).toMatchObject({ status: 'fulfilled', human_state: null });
    expect(closed.fulfillment).toMatchObject({ kind: proofKind, record_id: record.id, strength: 'association', basis });
    expect(new Date(closed.fulfilled_at).getTime()).toBe(new Date(closed.fulfillment.matched_at).getTime());
  });

  test('near-misses do not close: a cancelled or generated visit, a visit before the call or after the window, an unsent or foreign report, a staff email', async () => {
    const stayOpen = async (kind, seed) => {
      const w = await world({ kind });
      await seed(w);
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    };
    await stayOpen('callback', (w) => visit(w, { created_at: new Date(Date.now() - 3 * DAY - 60 * 1000) }));
    await stayOpen('callback', (w) => visit(w, { created_at: new Date(Date.now() - 3 * DAY + 15 * DAY) }));
    await stayOpen('schedule_visit', (w) => visit(w, { status: 'cancelled' }));
    await stayOpen('schedule_visit', async (w) => {
      const [parent] = await db('scheduled_services').insert({ scheduled_date: '2026-09-01', service_type: 'General Pest Control', status: 'completed', customer_id: w.customerId, created_at: new Date(Date.now() - 20 * DAY) }).returning('id');
      made.visitIds.push(parent.id);
      await visit(w, { recurring_parent_id: parent.id });
    });
    // A staff email is not closing evidence: the Gmail sync links no customer to outbound mail.
    await stayOpen('callback', (w) => db('emails').insert({ gmail_id: `g-${w.n}`, gmail_thread_id: `t-${w.n}`, from_address: 'office@wavespestcontrol.com',
      to_address: w.email, label_ids: JSON.stringify(['SENT']), received_at: later() }).returning('id').then(([r]) => { made.emailIds.push(r.id); }));
    await stayOpen('send_report', (w) => sms(w, 'service_report', { status: 'failed' }));
    // Queued for quiet hours, or never accepted by the provider, is not sent.
    await stayOpen('send_report', (w) => sms(w, 'service_report_v1', { status: 'scheduled' }));
    await stayOpen('send_appointment_confirmation', (w) => sms(w, 'confirmation', { status: 'scheduled' }));
    // A text to the shared number for another household member keeps nothing.
    const householdMember = async (w) => {
      const [other] = await db('customers').insert({ first_name: `Member${w.n}`, phone: w.phone }).returning('id');
      made.customerIds.push(other.id);
      return other.id;
    };
    await stayOpen('send_report', async (w) => sms(w, 'service_report', { customer_id: await householdMember(w) }));
    await stayOpen('send_appointment_confirmation', async (w) => sms(w, 'confirmation', { customer_id: await householdMember(w) }));
    await stayOpen('send_report', (w) => reportEmail(w, { status: 'bounced' }));
    await stayOpen('send_report', (w) => reportEmail(w, { status: 'dropped' }));
    // Off the books is no appointment.
    await stayOpen('schedule_visit', (w) => visit(w, { status: 'rescheduled' }));
    await stayOpen('schedule_visit', (w) => visit(w, { status: 'skipped' }));
    await stayOpen('send_estimate', (w) => visit(w, { status: 'completed', completed_at: new Date(Date.now() - 4 * DAY), created_at: new Date(Date.now() - 20 * DAY) }));
  });

  test('a callback whose card already placed a call never takes the new evidence (the card attempt early-return is kept)', async () => {
    const w = await world({ kind: 'callback' });
    await visit(w);
    await db('call_log').insert({
      twilio_call_sid: `CA${'3'.repeat(24)}${w.n}ca`, direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, status: 'no-answer', duration_seconds: 5,
      created_at: later(5), metadata: JSON.stringify({ relatedCommitmentId: w.commitment.id }),
    }).returning('id').then(([r]) => made.callIds.push(r.id));
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
  });

  // ── Evidence must match the KIND of the promise (owner audit 2026-10-05) ──
  // A visit booked is the schedule_visit promise's evidence and nobody else's:
  // a booking on the customer's own chase call is not Waves sending an estimate,
  // texting, calling back or doing an "other" thing.
  test('a booking alone never keeps an estimate, text, callback or other promise, however it was booked, and leaves no hint either', async () => {
    const stayOpen = async (kind, channel = null) => {
      const w = await world({ kind, channel });
      // The customer's own chase call, later, on which the visit was booked.
      const chase = await inbound(w, { created_at: later(40 * 60) });
      await visit(w, { created_at: later(40 * 60 + 5), source_call_log_id: chase.id });
      await visit(w); // and one booked shortly after the promise call
      await visit(w, { status: 'completed', completed_at: later(60), created_at: new Date(Date.now() - 20 * DAY) });
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0, failed: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    };
    await stayOpen('send_estimate');
    await stayOpen('callback');
    await stayOpen('other');
    await stayOpen('other', 'sms');
    await stayOpen('other', 'call');
    await stayOpen('other', 'email');
  });

  test('send_estimate waits for the estimate itself: a booking first does not close it, and the estimate sent later does, stored at its own time', async () => {
    const w = await world({ kind: 'send_estimate' });
    await visit(w, { created_at: later(10) });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    const sent = await estimate(w);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
    const closed = await row(w.commitment.id);
    expect(closed.fulfillment).toMatchObject({ kind: 'estimate_sent', record_id: sent.id });
    expect(Math.abs(new Date(closed.fulfillment.matched_at).getTime() - later().getTime())).toBeLessThan(5000);
  });

  test('send_estimate: an estimate for another customer, or one sent before the call ended, keeps nothing', async () => {
    const other = await world({ kind: 'send_estimate' });
    const w = await world({ kind: 'send_estimate' });
    await estimate(other);
    const early = await estimate(w);
    const earlyAt = new Date(Date.now() - 3 * DAY + 30 * 1000).toISOString();
    await db('estimates').where({ id: early.id }).update({ sent_at: new Date(earlyAt), estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: earlyAt, lastDeliveredAt: earlyAt } }) });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
  });

  test('a promise to text is kept by a text sent to the caller after the call, not by a booking, an automated reminder, a text before the call, a failed or queued one, or another household member\'s', async () => {
    const stayOpen = async (seed, attrs = { channel: 'sms' }) => {
      const w = await world({ kind: 'other', ...attrs });
      await seed(w);
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    };
    await stayOpen((w) => sms(w, 'review_request'));
    await stayOpen((w) => sms(w, 'appointment_reminder'));
    await stayOpen((w) => sms(w, 'confirmation'));
    await stayOpen((w) => staffText(w, { created_at: new Date(Date.now() - 3 * DAY - 60 * 1000) }));
    await stayOpen((w) => staffText(w, { created_at: new Date(Date.now() - 3 * DAY + 15 * DAY) }));
    await stayOpen((w) => staffText(w, { status: 'failed' }));
    // Handed to the provider is not delivered: a person's text counts only once delivered.
    await stayOpen((w) => staffText(w, { status: 'sent' }));
    // An unrelated estimate sent meanwhile keeps neither a text nor a call promise.
    await stayOpen((w) => estimate(w));
    await stayOpen((w) => estimate(w), { channel: 'call' });
    await stayOpen((w) => estimate(w), { description: 'Text the customer appointment options' });
    await stayOpen((w) => staffText(w, { status: 'scheduled' }));
    await stayOpen(async (w) => {
      const [member] = await db('customers').insert({ first_name: `Member${w.n}`, phone: w.phone }).returning('id');
      made.customerIds.push(member.id);
      await staffText(w, { customer_id: member.id });
    });
    // A text-shaped promise on a channel that is not sms, or an email, takes no text.
    await stayOpen((w) => staffText(w), { channel: 'email', description: 'Email the customer the details' });
    // With no channel recorded, the words decide: a text to send takes a text, any other words take none.
    const worded = await world({ kind: 'other', description: 'Text the customer the appointment options' });
    const wordedText = await staffText(worded);
    const unworded = await world({ kind: 'other', description: 'Add the customer to the irrigation list' });
    await staffText(unworded);
    await cc.refreshFulfillment(db, worded.call.id);
    await cc.refreshFulfillment(db, unworded.call.id);
    expect(await row(worded.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { record_id: wordedText.id, basis: 'text_sent_to_caller_within_14_days' } });
    expect(await row(unworded.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
  });

  test('a promise to call is kept by a call a person placed to the caller, never by the customer calling in', async () => {
    const stayOpen = async (kind, seed, channel = null) => {
      const w = await world({ kind, channel });
      await seed(w);
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    };
    // The audited shape: the customer chases us on a short inbound call.
    await stayOpen('callback', (w) => inbound(w, { duration_seconds: 8 }));
    await stayOpen('callback', (w) => inbound(w));
    await stayOpen('other', (w) => inbound(w), 'call');
    await stayOpen('callback', (w) => outboundCall(w, { source: 'collections_voice' }));
    const w = await world({ kind: 'callback' });
    await inbound(w);
    const back = await outboundCall(w);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { kind: 'outbound_call', record_id: back.id, strength: 'direct' } });
  });

  test('a promise to call is also kept by a Call Log callback-card leg correlated to the source call, on the card policy\'s stricter customer-leg bar', async () => {
    const cardCall = (w, extra = {}, leg = { status: 'completed', duration_seconds: 90 }) => db('call_log').insert({
      twilio_call_sid: `CA${'2'.repeat(24)}${w.n}cd${Object.keys(extra).length}${Math.random().toString(36).slice(2, 5)}`, direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone,
      status: 'completed', duration_seconds: 5, customer_id: w.customerId, created_at: later(), source: 'admin-callback',
      v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: false } }),
      metadata: JSON.stringify({ relatedCallId: w.call.id, callback_policy: 'card', customer_leg: leg }), ...extra,
    }).returning('id').then(([r]) => { made.callIds.push(r.id); return r; });
    // Staff leg only (customer never picked up), a short customer leg, voicemail: none keeps it.
    for (const [extra, leg] of [[{}, { status: 'no-answer', duration_seconds: 0 }], [{}, { status: 'completed', duration_seconds: 30 }], [{ ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: true } }) }, undefined]]) {
      const w = await world({ kind: 'other', channel: 'call' });
      await cardCall(w, extra, leg);
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    }
    const w = await world({ kind: 'other', channel: 'call' });
    const done = await cardCall(w);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1, failed: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { kind: 'outbound_call', record_id: done.id } });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(w.call.id);
    // The proof call reprocessed to voicemail: the scan lists it and the promise reopens.
    await db('call_log').where({ id: done.id }).update({ ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: true } }) });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).toContain(w.call.id);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ reopened: 1, failed: 0 });
  });

  test('the lapse scan mirrors the promise medium for every proof kind: a text, a call or an estimate that no longer matches a reworded or re-channelled "other" promise reopens it', async () => {
    const closeWith = async (attrs, proofFor) => {
      const w = await world({ kind: 'other', ...attrs });
      const proof = { strength: 'association', closed_by: 'promise_evidence', judged_customer_id: w.customerId, closed_at: new Date().toISOString(), matched_at: later().toISOString(), ...(await proofFor(w)) };
      await db('call_commitments').where({ id: w.commitment.id }).update({ status: 'fulfilled', fulfillment: JSON.stringify(proof), fulfilled_at: later() });
      return w;
    };
    const textProof = async (w) => ({ kind: 'sms_sent', record_type: 'sms_log', record_id: (await staffText(w)).id, basis: 'text_sent_to_caller_within_14_days' });
    const callProof = async (w) => ({ kind: 'outbound_call', record_type: 'call_log', record_id: (await outboundCall(w)).id, basis: 'outbound_call_to_caller_within_14_days' });
    const estimateProof = async (w) => ({ kind: 'estimate_sent', record_type: 'estimate', record_id: (await estimate(w)).id, basis: 'estimate_sent_to_same_customer_within_14_days' });
    const stale = [
      await closeWith({ channel: 'call' }, textProof), // a text on a promise now channelled call
      await closeWith({ description: 'Call the customer with the pricing' }, textProof), // reworded to call
      await closeWith({ description: 'Add them to the email list' }, textProof), // reworded to neither
      await closeWith({ channel: 'sms' }, callProof),
      await closeWith({ description: 'Text appointment options' }, callProof),
      await closeWith({ channel: 'email' }, callProof),
      await closeWith({ description: 'Phone them with the quote' }, estimateProof),
      await closeWith({ channel: 'sms' }, estimateProof),
    ];
    const fine = [
      await closeWith({ channel: 'sms' }, textProof),
      await closeWith({ description: 'Text appointment options' }, textProof),
      await closeWith({ channel: 'call' }, callProof),
      await closeWith({ description: 'Call the customer with the pricing' }, callProof),
      await closeWith({ description: 'Add them to the email list' }, estimateProof),
    ];
    const listed = await cc.listLapsedEvidenceClosedCallIds(db);
    for (const w of stale) expect(listed).toContain(w.call.id);
    for (const w of fine) expect(listed).not.toContain(w.call.id);
    for (const w of stale) {
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ reopened: 1, failed: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfilled_at: null });
    }
  });

  test('an "other" promise with no channel whose words say call is kept by a call placed, never by an estimate', async () => {
    const w = await world({ kind: 'other', description: 'Call the customer with the pricing' });
    await estimate(w);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    const back = await outboundCall(w);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { kind: 'outbound_call', record_id: back.id } });
  });

  test('a promise to call from an unlinked caller is kept by a staff call to that number; a booking-link text logged with no customer id is not guessed at for a linked caller', async () => {
    const w = await world({ kind: 'other', channel: 'call', customer: false });
    const back = await outboundCall(w);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1, failed: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { kind: 'outbound_call', record_id: back.id } });
    // The scan leaves an unlinked call proof alone (no flapping).
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(w.call.id);
    // Another caller's link text (no customer id) on the same phone is not this call's proof.
    const linked = await world({ kind: 'other', channel: 'sms' });
    await sms(linked, 'call_booking_link_text', { customer_id: null });
    expect(await cc.refreshFulfillment(db, linked.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(linked.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
  });

  test('a call-placed close is reopened by the lapse scan once its proof call is reprocessed to voicemail or invalid, or is not a staff-bridge call', async () => {
    const changes = [
      { ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: true } }) },
      { v2_extraction_status: 'failed' },
      { source: 'collections_voice' },
      { duration_seconds: 30 },
    ];
    const worlds = [];
    for (const change of changes) {
      const w = await world({ kind: 'other', channel: 'call' });
      const proofCall = await outboundCall(w);
      await cc.refreshFulfillment(db, w.call.id);
      expect((await row(w.commitment.id)).status).toBe('fulfilled');
      worlds.push({ w, proofCall, change });
    }
    const steady = await world({ kind: 'other', channel: 'call' });
    await outboundCall(steady);
    await cc.refreshFulfillment(db, steady.call.id);
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(steady.call.id);
    for (const { proofCall, change } of worlds) await db('call_log').where({ id: proofCall.id }).update(change);
    const lapsed = await cc.listLapsedEvidenceClosedCallIds(db);
    expect(lapsed).not.toContain(steady.call.id);
    for (const { w } of worlds) {
      expect(lapsed).toContain(w.call.id);
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ reopened: 1, failed: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    }
  });

  test('closes an earlier version wrote on the wrong kind of evidence are listed by the lapse scan and reopen: a visit for an estimate, text or callback; the customer phoning in for a callback', async () => {
    const stale = async (kind, proofFor) => {
      const w = await world({ kind });
      const closed = { strength: 'association', closed_by: 'promise_evidence', judged_customer_id: w.customerId, closed_at: new Date().toISOString(), matched_at: later().toISOString(), ...(await proofFor(w)) };
      await db('call_commitments').where({ id: w.commitment.id }).update({ status: 'fulfilled', fulfillment: JSON.stringify(closed), fulfilled_at: later() });
      return w;
    };
    const visitProof = async (w) => ({ kind: 'appointment_booked', record_type: 'scheduled_service', record_id: (await visit(w)).id, basis: 'visit_booked_for_same_customer_within_14_days' });
    const bad = [];
    for (const kind of ['send_estimate', 'other', 'callback']) bad.push(await stale(kind, visitProof));
    const estimateProof = async (w) => ({ kind: 'estimate_sent', record_type: 'estimate', record_id: (await estimate(w)).id, basis: 'estimate_sent_to_same_customer_within_14_days' });
    bad.push(await stale('callback', estimateProof));
    for (const [channel, description] of [['sms', 'Text options'], ['call', 'Call them'], [null, 'Text the customer the options'], [null, 'Call the customer with the pricing'], ['unknown', 'Phone them about the quote']]) {
      const w = await world({ kind: 'other', channel, description });
      const closed = { strength: 'association', closed_by: 'promise_evidence', judged_customer_id: w.customerId, closed_at: new Date().toISOString(), matched_at: later().toISOString(), ...(await estimateProof(w)) };
      await db('call_commitments').where({ id: w.commitment.id }).update({ status: 'fulfilled', fulfillment: JSON.stringify(closed), fulfilled_at: later() });
      bad.push(w);
    }
    // An estimate keeping an estimate promise, or a plain "other", is the right kind.
    const keepEstimate = await stale('send_estimate', estimateProof);
    bad.push(await stale('callback', async (w) => ({ kind: 'inbound_call', record_type: 'call_log', record_id: (await inbound(w)).id, basis: 'caller_called_in_and_talked_with_staff_within_14_days' })));
    // A schedule_visit close on a booking is the right kind and stays.
    const keep = await stale('schedule_visit', visitProof);
    const listed = await cc.listLapsedEvidenceClosedCallIds(db);
    for (const w of bad) expect(listed).toContain(w.call.id);
    expect(listed).not.toContain(keep.call.id);
    expect(listed).not.toContain(keepEstimate.call.id);
    for (const w of bad) {
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ reopened: 1, failed: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null, fulfilled_at: null });
    }
  });

  test('an existing association hint closes too: same-customer estimate on send_estimate, confirmation text on send_appointment_confirmation; a customer\'s own promise stays a hint', async () => {
    const est = await world({ kind: 'send_estimate' });
    const sent = await estimate(est);
    const conf = await world({ kind: 'send_appointment_confirmation' });
    const text = await sms(conf, 'confirmation');
    const theirs = await world({ kind: 'call_back', party: 'customer' });
    const back = await inbound(theirs, { duration_seconds: 45 });
    for (const w of [est, conf, theirs]) await cc.refreshFulfillment(db, w.call.id);
    expect(await row(est.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { record_id: sent.id, strength: 'association' } });
    expect(await row(conf.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { record_id: text.id, strength: 'association' } });
    expect(await row(theirs.commitment.id)).toMatchObject({ status: 'open', fulfillment: { record_id: back.id, strength: 'association' } });
  });

  test('customer left: a churn after the call dismisses the Waves promise with the proof and no human verdict; a churn before the call, a soft delete (a merge), or the customer\'s own promise does not', async () => {
    const churned = await world({ kind: 'send_report', customerExtra: churnedStage(1) });
    const deleted = await world({ kind: 'other', customerExtra: { deleted_at: new Date(Date.now() - 1 * DAY) } });
    const before = await world({ kind: 'other', customerExtra: churnedStage(10) });
    const theirs = await world({ kind: 'send_photos', party: 'customer', customerExtra: churnedStage(1) });
    for (const w of [churned, deleted, before, theirs]) await cc.refreshFulfillment(db, w.call.id);
    expect(await row(churned.commitment.id)).toMatchObject({
      status: 'dismissed', human_state: null, fulfilled_at: null,
      fulfillment: { kind: 'customer_left', basis: 'customer_left_after_promise', strength: 'association', record_type: 'customer', record_id: churned.customerId },
    });
    // A merge soft-deletes the duplicate profile while the caller is still a customer: never "left".
    expect(await row(deleted.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    expect(await row(before.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    expect(await row(theirs.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    // Off: nobody is dismissed.
    process.env.PROMISE_EVIDENCE_CLOSE = 'false';
    const off = await world({ kind: 'other', customerExtra: churnedStage(1) });
    await cc.refreshFulfillment(db, off.call.id);
    expect(await row(off.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
  });

  test('the stored proof is the EARLIEST follow-up across evidence types, not the first type looked up', async () => {
    const w = await world({ kind: 'send_report' });
    const mail = await reportEmail(w, { sent_at: later(10) }); // the report email 10 minutes after the call (looked up second)
    await sms(w, 'service_report', { created_at: later(2 * 60) }); // the report text two hours on (looked up first)
    await cc.refreshFulfillment(db, w.call.id);
    expect((await row(w.commitment.id)).fulfillment).toMatchObject({ kind: 'email_sent', record_id: mail.id });
  });

  test('a relink to another customer reopens a promise the old customer\'s evidence closed, and a customer-left dismissal', async () => {
    const [other] = await db('customers').insert({ first_name: 'Relinked', phone: '+15555559999' }).returning('id');
    made.customerIds.push(other.id);
    const kept = await world({ kind: 'schedule_visit' });
    await visit(kept);
    const left = await world({ kind: 'other', customerExtra: churnedStage(1) });
    for (const w of [kept, left]) await cc.refreshFulfillment(db, w.call.id);
    expect((await row(kept.commitment.id)).status).toBe('fulfilled');
    expect((await row(left.commitment.id)).status).toBe('dismissed');
    for (const w of [kept, left]) {
      await db('call_log').where({ id: w.call.id }).update({ customer_id: other.id });
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ reopened: 1, failed: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', human_state: null, fulfillment: null, fulfilled_at: null });
    }
  });

  test('only rows this file closed on its own are re-judged or listed: another writer\'s association-strength proof is left alone', async () => {
    const w = await world({ kind: 'send_reschedule_link' });
    const foreign = { kind: 'reschedule_link_delivered', strength: 'association', record_type: 'sms_log', basis: 'some_other_writer' };
    await db('call_commitments').where({ id: w.commitment.id }).update({ status: 'fulfilled', fulfillment: JSON.stringify(foreign), fulfilled_at: new Date() });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ checked: 0, reopened: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: foreign });
    expect((await allAutoClosed(7)).map((c) => c.id)).not.toContain(w.commitment.id);
    // Its own closes carry the marker.
    const own = await world({ kind: 'schedule_visit' });
    await visit(own);
    await cc.refreshFulfillment(db, own.call.id);
    expect((await row(own.commitment.id)).fulfillment).toMatchObject({ strength: 'association', closed_by: 'promise_evidence' });
  });

  test('a close found through the old customer is not written once the call was relinked meanwhile (the write re-checks the call\'s customer)', async () => {
    const w = await world({ kind: 'schedule_visit' });
    await visit(w);
    const staleCall = await db('call_log').where({ id: w.call.id }).first();
    const [other] = await db('customers').insert({ first_name: 'RelinkedMeanwhile', phone: '+15555559998' }).returning('id');
    made.customerIds.push(other.id);
    await db('call_log').where({ id: w.call.id }).update({ customer_id: other.id });
    // A refresh that read the call before the relink still judges customer A's visit…
    expect(await cc.refreshFulfillment(db, w.call.id, staleCall)).toMatchObject({ fulfilled: 0 });
    // …but its write is fenced to the call's current customer.
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
  });

  test('a visit cancelled after it closed a promise, or a customer who returned, is found by the periodic scan and the promise reopens', async () => {
    const booked = await world({ kind: 'schedule_visit' });
    const v = await visit(booked);
    const left = await world({ kind: 'other', customerExtra: churnedStage(1) });
    for (const w of [booked, left]) await cc.refreshFulfillment(db, w.call.id);
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toEqual(expect.arrayContaining([booked.call.id]));
    await db('scheduled_services').where({ id: v.id }).update({ status: 'cancelled' });
    // Reactivated, the old churn date left behind: the live stage decides.
    await db('customers').where({ id: left.customerId }).update({ pipeline_stage: 'active_customer' });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).toEqual(expect.arrayContaining([booked.call.id, left.call.id]));
    for (const w of [booked, left]) {
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ reopened: 1 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    }
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toEqual(expect.arrayContaining([booked.call.id, left.call.id]));
    // A lapse on a promise closed more than 30 days ago is history: not listed.
    const old = await world({ kind: 'schedule_visit' });
    const oldVisit = await visit(old);
    await cc.refreshFulfillment(db, old.call.id);
    await closedAt(old.commitment.id, new Date(Date.now() - 31 * DAY));
    await db('scheduled_services').where({ id: oldVisit.id }).update({ status: 'cancelled' });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(old.call.id);
    // Off: nothing is listed.
    process.env.PROMISE_EVIDENCE_CLOSE = 'off';
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).toEqual([]);
  });

  test('Reopen acts on the version the office was shown: a newer verdict answers 409 and is left standing', async () => {
    const w = await world({ kind: 'schedule_visit' });
    await visit(w);
    await cc.refreshFulfillment(db, w.call.id);
    const shown = await row(w.commitment.id);
    // Someone marked it done by hand after the list was loaded.
    await db('call_commitments').where({ id: w.commitment.id }).update({ human_state: 'confirmed', updated_at: new Date(Date.now() + 5000) });
    await expect(cc.applyHumanUpdate(db, w.commitment.id, { action: 'reopen', expectedAt: shown.updated_at })).rejects.toMatchObject({ status: 409 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'fulfilled', human_state: 'confirmed' });
    const current = await row(w.commitment.id);
    await cc.applyHumanUpdate(db, w.commitment.id, { action: 'reopen', expectedAt: current.updated_at });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', human_state: 'confirmed' });
  });

  test('human-touched promises are never closed: a confirmed one with proof waiting stays open, and a human-dismissed one stays dismissed', async () => {
    const confirmed = await world({ kind: 'schedule_visit', human_state: 'confirmed' });
    await visit(confirmed);
    const dismissed = await world({ kind: 'schedule_visit', human_state: 'dismissed', status: 'dismissed' });
    await visit(dismissed);
    for (const w of [confirmed, dismissed]) expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ checked: 0 });
    expect(await row(confirmed.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    expect(await row(dismissed.commitment.id)).toMatchObject({ status: 'dismissed' });
  });

  test('reopen sticks: an automatically closed promise a person reopens is not closed again by the same evidence; a callback (cards on) is judged only by evidence after the reopen', async () => {
    // Non-callback: the reopen is a human verdict the refresh leaves alone.
    const w = await world({ kind: 'schedule_visit' });
    await visit(w);
    await cc.refreshFulfillment(db, w.call.id);
    expect((await row(w.commitment.id)).status).toBe('fulfilled');
    await cc.applyHumanUpdate(db, w.commitment.id, { action: 'reopen' });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ checked: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', human_state: 'confirmed', fulfillment: null });
    // SLA kind: the renewal event, not just the verdict, bounds the evidence.
    const est = await world({ kind: 'send_estimate' });
    await estimate(est);
    await cc.refreshFulfillment(db, est.call.id);
    await cc.applyHumanUpdate(db, est.commitment.id, { action: 'reopen' });
    await cc.refreshFulfillment(db, est.call.id);
    expect(await row(est.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });

    // Callback under the card policy stays refreshable after a reopen, so the
    // reopened card is the office's: the old visit cannot close it again, only the card's own direct proof can.
    const { gates } = require('../config/feature-gates');
    const gateWas = gates.callCommitments;
    gates.callCommitments = true;
    process.env.GATE_CALLBACK_CARD = 'true';
    try {
      const cb = await world({ kind: 'callback' });
      await visit(cb);
      await cc.refreshFulfillment(db, cb.call.id);
      // A booking keeps no callback: the promise is still open until Waves calls.
      expect((await row(cb.commitment.id)).status).toBe('open');
      await db('call_commitments').where({ id: cb.commitment.id }).update({ status: 'fulfilled', fulfillment: JSON.stringify({ kind: 'outbound_call', strength: 'direct', basis: 'callback_returned_connected_outbound_call' }), fulfilled_at: new Date() });
      await cc.applyHumanUpdate(db, cb.commitment.id, { action: 'reopen' });
      // The reopened card is still refreshable (checked: 1), but a person owns it now.
      expect(await cc.refreshFulfillment(db, cb.call.id)).toMatchObject({ checked: 1, fulfilled: 0 });
      expect(await row(cb.commitment.id)).toMatchObject({ status: 'open', human_state: 'confirmed' });
      // A reopened card is the office's: a newer inbound call (an association)
      // leaves it open with nothing written; the card's own direct proof — a
      // connected call back after the reopen — still closes it.
      await inbound(cb, { created_at: new Date(Date.now() + 60 * 1000) });
      await cc.refreshFulfillment(db, cb.call.id);
      expect(await row(cb.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
      const back = await outboundCall(cb, { created_at: new Date(Date.now() + 2 * 60 * 1000) });
      await cc.refreshFulfillment(db, cb.call.id);
      expect(await row(cb.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { record_id: back.id, strength: 'direct' } });
    } finally {
      gates.callCommitments = gateWas;
    }
  });

  test('an association-closed promise is re-judged on every refresh but, still kept by the same record, left exactly as it was', async () => {
    const w = await world({ kind: 'schedule_visit' });
    await visit(w);
    await cc.refreshFulfillment(db, w.call.id);
    const closed = await row(w.commitment.id);
    expect(closed).toMatchObject({ status: 'fulfilled', fulfillment: { basis: 'visit_booked_for_same_customer_within_14_days' } });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ checked: 1, reopened: 0, fulfilled: 0 });
    expect((await row(w.commitment.id)).updated_at).toEqual(closed.updated_at);
  });

  test('listAutoClosedCommitments: association closes and customer-left dismissals in the window, newest first; never direct, manual, human-dismissed, reopened, customer-party or out-of-window rows', async () => {
    const kept = await world({ kind: 'schedule_visit' });
    await visit(kept);
    const left = await world({ kind: 'send_report', customerExtra: churnedStage(1) });
    const direct = await world({ kind: 'schedule_visit' });
    const manual = await world({ kind: 'schedule_visit' });
    const humanDismissed = await world({ kind: 'schedule_visit' });
    const old = await world({ kind: 'schedule_visit' });
    await visit(old);
    for (const w of [kept, left, old]) await cc.refreshFulfillment(db, w.call.id);
    const ids = (r) => r.map((c) => c.id);
    await db('call_commitments').where({ id: direct.commitment.id }).update({ status: 'fulfilled', fulfillment: JSON.stringify({ kind: 'appointment_booked', strength: 'direct', basis: 'visit_booked_from_this_call' }) });
    await db('call_commitments').where({ id: manual.commitment.id }).update({ status: 'fulfilled', human_state: 'confirmed', fulfillment: JSON.stringify({ kind: 'manual', basis: 'marked_done_by_office' }) });
    await db('call_commitments').where({ id: humanDismissed.commitment.id }).update({ status: 'dismissed', human_state: 'dismissed', fulfillment: JSON.stringify({ kind: 'customer_left', strength: 'association' }) });
    await closedAt(old.commitment.id, new Date(Date.now() - 10 * DAY));
    await closedAt(kept.commitment.id, new Date(Date.now() - 2 * 60 * 1000));
    // A reprocess of the old call rewrites updated_at on its untouched rows: it did not close again.
    await db('call_commitments').where({ id: old.commitment.id }).update({ updated_at: new Date() });
    const week = await allAutoClosed(7);
    const mine = week.filter((c) => [kept, left, direct, manual, humanDismissed, old].some((w) => w.commitment.id === c.id));
    expect(ids(mine)).toEqual([left.commitment.id, kept.commitment.id]);
    expect(mine[0]).toMatchObject({ status: 'dismissed', customer_first_name: `Evidence${left.n}`, call_log_id: left.call.id, fulfillment: { kind: 'customer_left' } });
    expect(mine[1].fulfillment).toMatchObject({ strength: 'association', kind: 'appointment_booked' });
    expect(ids(await allAutoClosed(30))).toContain(old.commitment.id);
    // A reopened promise drops out.
    await cc.applyHumanUpdate(db, kept.commitment.id, { action: 'reopen' });
    expect(ids(await allAutoClosed(7))).not.toContain(kept.commitment.id);
  });

  test('a callback card staff claimed stays theirs: association evidence and a customer who left change nothing; its own direct proof still closes it', async () => {
    const { gates } = require('../config/feature-gates');
    const gateWas = gates.callCommitments;
    gates.callCommitments = true;
    process.env.GATE_CALLBACK_CARD = 'true';
    try {
      const w = await world({ kind: 'callback', human_state: 'confirmed', customerExtra: churnedStage(1) });
      await inbound(w);
      await visit(w);
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ checked: 1, fulfilled: 0, hinted: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', human_state: 'confirmed', fulfillment: null });
      const back = await outboundCall(w);
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { record_id: back.id, strength: 'direct' } });
    } finally {
      gates.callCommitments = gateWas;
    }
  });

  test('a technician follow-up keeps a booked visit as a hint, never a close', async () => {
    const w = await world({ kind: 'technician_follow_up' });
    const v = await visit(w);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0, hinted: 1 });
    const hint = await row(w.commitment.id);
    expect(hint).toMatchObject({ status: 'open', fulfillment: { record_id: v.id, strength: 'association' } });
    expect(hint.fulfillment.closed_by).toBeUndefined();
  });

  test('an association counts only from a later stated time that is not a deadline; a deadline, or direct proof, keeps the promise early', async () => {
    const statedAt = new Date(Date.now() - 1 * DAY); // two days after the call
    const floored = await world({ kind: 'schedule_visit' });
    await db('call_commitments').where({ id: floored.commitment.id }).update({ due_at: statedAt, due_type: 'floor' });
    await visit(floored); // booked half an hour after the call: before the stated time
    expect(await cc.refreshFulfillment(db, floored.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(floored.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    const onTime = await visit(floored, { created_at: new Date(statedAt.getTime() + 60 * 60 * 1000) });
    expect(await cc.refreshFulfillment(db, floored.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(floored.commitment.id)).fulfillment).toMatchObject({ record_id: onTime.id });
    // Untyped is a floor too.
    const untyped = await world({ kind: 'schedule_visit' });
    await db('call_commitments').where({ id: untyped.commitment.id }).update({ due_at: statedAt });
    await visit(untyped);
    expect(await cc.refreshFulfillment(db, untyped.call.id)).toMatchObject({ fulfilled: 0 });
    // A deadline is the latest moment, not the first.
    const deadline = await world({ kind: 'schedule_visit' });
    await db('call_commitments').where({ id: deadline.commitment.id }).update({ due_at: statedAt, due_type: 'deadline' });
    const early = await visit(deadline);
    expect(await cc.refreshFulfillment(db, deadline.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(deadline.commitment.id)).fulfillment).toMatchObject({ record_id: early.id });
    // Direct proof is not held to the stated time.
    const direct = await world({ kind: 'schedule_visit' });
    await db('call_commitments').where({ id: direct.commitment.id }).update({ due_at: statedAt, due_type: 'floor' });
    const booked = await visit(direct, { source_call_log_id: direct.call.id });
    expect(await cc.refreshFulfillment(db, direct.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(direct.commitment.id)).fulfillment).toMatchObject({ record_id: booked.id, strength: 'direct' });
  });

  test('a promise given a later stated time by a reprocess is found by the periodic scan when its refresh never ran', async () => {
    const statedAt = new Date(Date.now() - 1 * DAY); // two days after the call
    // The same rewrite with no refresh after it (the refresh failed, or the switch was off then).
    const s = await world({ kind: 'schedule_visit' });
    await visit(s);
    await cc.refreshFulfillment(db, s.call.id);
    const restate = (patch) => db('call_commitments').where({ id: s.commitment.id }).update({ ...patch, updated_at: new Date() });
    await restate({ due_at: statedAt, due_type: 'deadline' }); // a deadline never moves where an association counts from
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(s.call.id);
    await restate({ due_at: later(10), due_type: 'floor' }); // a stated time before the proof leaves it standing
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(s.call.id);
    await restate({ due_at: statedAt, due_type: 'floor' });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).toContain(s.call.id);
    expect(await cc.refreshFulfillment(db, s.call.id)).toMatchObject({ reopened: 1, failed: 0 });
    expect(await row(s.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(s.call.id);
  });

  test('a relink the refresh never saw is found by the periodic scan whatever evidence closed the promise; a merge that moves the evidence with the call keeps it and stops listing it', async () => {
    const w = await world({ kind: 'schedule_visit' });
    await visit(w);
    await cc.refreshFulfillment(db, w.call.id);
    expect((await row(w.commitment.id)).fulfillment).toMatchObject({ kind: 'appointment_booked', judged_customer_id: w.customerId });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(w.call.id);
    const [other] = await db('customers').insert({ first_name: `Relink${w.n}`, phone: `+1555558${w.n}` }).returning('id');
    made.customerIds.push(other.id);
    await db('call_log').where({ id: w.call.id }).update({ customer_id: other.id }); // no refresh after it
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).toContain(w.call.id);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ reopened: 1, failed: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(w.call.id);

    const m = await world({ kind: 'schedule_visit' });
    const v = await visit(m);
    await cc.refreshFulfillment(db, m.call.id);
    const [survivor] = await db('customers').insert({ first_name: `Survivor${m.n}`, phone: `+1555559${m.n}` }).returning('id');
    made.customerIds.push(survivor.id);
    await db('call_log').where({ id: m.call.id }).update({ customer_id: survivor.id });
    await db('scheduled_services').where({ id: v.id }).update({ customer_id: survivor.id });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).toContain(m.call.id);
    expect(await cc.refreshFulfillment(db, m.call.id)).toMatchObject({ reopened: 0, failed: 0 });
    expect(await row(m.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { record_id: v.id, judged_customer_id: survivor.id } });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(m.call.id);
  });

  test('listAutoClosedCommitments pages newest first by position: every row exactly once, ties broken by id', async () => {
    const worlds = [];
    for (let i = 0; i < 3; i += 1) {
      const w = await world({ kind: 'schedule_visit' });
      await visit(w);
      await cc.refreshFulfillment(db, w.call.id);
      worlds.push(w);
    }
    const tied = worlds.slice(0, 2).map((w) => w.commitment.id);
    await closedAt(tied, new Date(Date.now() - 60 * 1000));
    const seen = (await allAutoClosed(7, 1)).map((c) => c.id);
    expect(new Set(seen).size).toBe(seen.length);
    const mine = new Set(worlds.map((w) => w.commitment.id));
    expect(seen.filter((id) => mine.has(id))).toEqual([worlds[2].commitment.id, ...[...tied].sort().reverse()]);
  });

  test('customer left is the live churned stage: a reactivated customer who still carries an old churn date, or a churned row with no date, is not dismissed', async () => {
    const reactivated = await world({ kind: 'other', customerExtra: { ...churnedStage(1), pipeline_stage: 'active_customer' } });
    const undated = await world({ kind: 'other', customerExtra: { pipeline_stage: 'churned' } });
    for (const w of [reactivated, undated]) {
      await cc.refreshFulfillment(db, w.call.id);
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    }
  });

  test('a promise for a slot the call confirmed is kept only by a booking for that slot: once it lapses, another visit on the books stays a hint and never closes it again', async () => {
    const w = await world({ kind: 'schedule_visit' });
    const { etDateString, parseETDateTime } = require('../utils/datetime-et');
    const day = etDateString(new Date(Date.now() - 2 * DAY));
    const slotAt = parseETDateTime(`${day}T15:00`);
    const offset = slotAt.getUTCHours() === 19 ? '-04:00' : '-05:00';
    await db('call_log').where({ id: w.call.id }).update({
      v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ scheduling: { status: 'confirmed', confirmed_start_at: `${day}T15:00:00${offset}` } }),
    });
    await db('call_commitments').where({ id: w.commitment.id }).update({ due_at: slotAt, due_type: 'floor' });
    const atSlot = await visit(w, { scheduled_date: day, window_start: '15:00' });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(w.commitment.id)).fulfillment).toMatchObject({ record_id: atSlot.id, strength: 'direct', basis: 'visit_booked_at_the_promised_time' });
    // The slot booking lapses; another visit for the customer, booked after the slot came, is on the books.
    await db('scheduled_services').where({ id: atSlot.id }).update({ status: 'cancelled' });
    const another = await visit(w, { scheduled_date: '2026-12-15', created_at: new Date(Date.now() - 1 * DAY) });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ reopened: 1 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: { record_id: another.id, strength: 'association', slot_bound: true } });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
    expect((await row(w.commitment.id)).status).toBe('open');
  });

  test('a reused lead\'s estimate is only a hint: the promise stays open whether it was handed off inside or outside the association window', async () => {
    const w = await world({ kind: 'send_estimate' });
    const [lead] = await db('leads').insert({ first_name: `Reused${w.n}`, phone: w.phone, created_at: new Date(Date.now() - 30 * DAY) }).returning('id');
    made.leadIds.push(lead.id);
    await db('call_log').where({ id: w.call.id }).update({ metadata: JSON.stringify({ lead_id: lead.id }) });
    const handedOff = (at) => ({ sent_at: at, estimate_data: JSON.stringify({ lead_id: lead.id, deliveryState: { firstDeliveredAt: at.toISOString(), lastDeliveredAt: at.toISOString() } }) });
    const [est] = await db('estimates').insert({ status: 'sent', customer_phone: w.phone, created_at: new Date(Date.now() - 4 * DAY), ...handedOff(new Date(Date.now() - 3 * DAY + 20 * DAY)) }).returning('id');
    made.estimateIds.push(est.id);
    // Handed off twenty days after the call: past the window, nothing to show.
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    // Inside the window: still open, carrying the reused-lead hint.
    await db('estimates').where({ id: est.id }).update(handedOff(later()));
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: { record_id: est.id, basis: 'estimate_sent_on_a_lead_reused_from_an_earlier_call', hint_only: true } });
  });

  test('contact records are not closing evidence: a staff call placed through the bridge, a person\'s text, the caller phoning back all leave the promise open with no hint', async () => {
    for (const seed of [(w) => outboundCall(w), (w) => staffText(w), (w) => inbound(w)]) {
      const w = await world({ kind: 'other' });
      await seed(w);
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0, hinted: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    }
  });

  test('a later stated time moves the start of the association window, never its end: 14 days from the call still closes it', async () => {
    const callEnd = (w) => new Date(new Date(w.call.created_at).getTime() + 90 * 1000);
    const late = await world({ kind: 'schedule_visit' });
    await db('call_commitments').where({ id: late.commitment.id }).update({ due_at: new Date(callEnd(late).getTime() + 13 * DAY), due_type: 'floor' });
    // Day 20 after the call: past the original 14-day window, however late the stated time.
    await visit(late, { created_at: new Date(callEnd(late).getTime() + 20 * DAY) });
    expect(await cc.refreshFulfillment(db, late.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(late.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    // Day 13.5: after the stated time and inside the window, it closes.
    const inside = await visit(late, { created_at: new Date(callEnd(late).getTime() + 13.5 * DAY) });
    expect(await cc.refreshFulfillment(db, late.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(late.commitment.id)).fulfillment).toMatchObject({ record_id: inside.id });
  });

  test('the closed-automatically list and the lapse scan read when the portal closed a row, not updated_at: a reprocess never makes an old close look new', async () => {
    const w = await world({ kind: 'schedule_visit' });
    const v = await visit(w);
    await cc.refreshFulfillment(db, w.call.id);
    const closed = await row(w.commitment.id);
    expect(closed.fulfillment.closed_at).toEqual(expect.any(String));
    await closedAt(w.commitment.id, new Date(Date.now() - 40 * DAY));
    await db('call_commitments').where({ id: w.commitment.id }).update({ updated_at: new Date() });
    expect((await allAutoClosed(30)).map((c) => c.id)).not.toContain(w.commitment.id);
    await db('scheduled_services').where({ id: v.id }).update({ status: 'cancelled' });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(w.call.id);
    // A re-judge that keeps the row closed on another record keeps its first close time.
    await closedAt(w.commitment.id, new Date(Date.now() - 2 * DAY));
    const firstClose = (await row(w.commitment.id)).fulfillment.closed_at;
    const other = await visit(w, { scheduled_date: '2026-12-20' });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ reopened: 0 });
    expect((await row(w.commitment.id)).fulfillment).toMatchObject({ record_id: other.id, closed_at: firstClose });
  });

  test('a customer who left dismisses a promise of any kind the portal may close — a technician follow-up or a slot-bound visit too, never as a hint', async () => {
    const followUp = await world({ kind: 'technician_follow_up', customerExtra: churnedStage(1) });
    await visit(followUp); // a booked visit is only a hint for this kind
    const photos = await world({ kind: 'send_photos', customerExtra: churnedStage(1) });
    for (const w of [followUp, photos]) {
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
      expect(await row(w.commitment.id)).toMatchObject({
        status: 'dismissed', fulfilled_at: null, fulfillment: { kind: 'customer_left', closed_by: 'promise_evidence' },
      });
    }
  });

  test('a reused lead\'s earlier estimate (a hint) never hides a later proof that keeps the promise: the customer\'s own estimate sent afterwards closes it', async () => {
    const w = await world({ kind: 'send_estimate' });
    const [lead] = await db('leads').insert({ first_name: `Reused${w.n}`, phone: w.phone, created_at: new Date(Date.now() - 30 * DAY) }).returning('id');
    made.leadIds.push(lead.id);
    await db('call_log').where({ id: w.call.id }).update({ metadata: JSON.stringify({ lead_id: lead.id }) });
    const early = later(10);
    const [est] = await db('estimates').insert({ status: 'sent', customer_phone: w.phone, created_at: new Date(Date.now() - 4 * DAY), sent_at: early,
      estimate_data: JSON.stringify({ lead_id: lead.id, deliveryState: { firstDeliveredAt: early.toISOString(), lastDeliveredAt: early.toISOString() } }) }).returning('id');
    made.estimateIds.push(est.id);
    const booked = await estimate(w);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(w.commitment.id)).fulfillment).toMatchObject({ record_id: booked.id, basis: 'estimate_sent_to_same_customer_within_14_days' });
  });

  test('the lapse scan never lists a DIRECT call proof: an unlinked promise returned by a staff call to a linked customer stays closed without flapping', async () => {
    // The promise call has no customer, so the direct lookup matches the
    // callback by phone; the staff call back itself is linked to a customer.
    const w = await world({ kind: 'callback', customer: false });
    const [other] = await db('customers').insert({ first_name: `Linked${w.n}`, phone: `+1555557${w.n}` }).returning('id');
    made.customerIds.push(other.id);
    const back = await outboundCall(w, { customer_id: other.id });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
    const closed = await row(w.commitment.id);
    expect(closed.fulfillment).toMatchObject({ record_id: back.id, strength: 'direct', record_type: 'call_log' });
    expect(closed.fulfillment.closed_by).toBeUndefined();
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(w.call.id);
  });

  describe('a callback\'s own direct proof reads the shared staff-contact rules', () => {
    const closesWith = async (seed) => {
      const w = await world({ kind: 'callback' });
      const record = await seed(w);
      const result = await cc.refreshFulfillment(db, w.call.id);
      return { w, record, result, saved: await row(w.commitment.id) };
    };

    test('an automated outbound call (collections voice) or a call with no live conversation is not a returned callback', async () => {
      for (const extra of [
        { source: 'collections_voice' },
        { source: null },
        { source: 'admin-click', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: true } }) },
        { source: 'admin-click', v2_extraction_status: 'failed' },
        { source: 'admin-click', metadata: JSON.stringify({ customer_leg: { status: 'no-answer', duration_seconds: 0 } }) },
        { source: 'admin-click', metadata: JSON.stringify({ customer_leg: { status: 'completed', duration_seconds: 59 } }) },
        { source: 'admin-click', duration_seconds: 45 },
      ]) {
        const { result, saved } = await closesWith((w) => outboundCall(w, extra));
        expect(result).toMatchObject({ fulfilled: 0 });
        expect(saved).toMatchObject({ status: 'open', fulfillment: null });
      }
    });

    test('a staff-bridge call back with a live conversation closes it directly, whichever bridge source placed it', async () => {
      for (const source of ['admin-click', 'admin-callback', 'tech-click']) {
        const { record, result, saved } = await closesWith((w) => outboundCall(w, { source }));
        expect(result).toMatchObject({ fulfilled: 1 });
        expect(saved).toMatchObject({ status: 'fulfilled', fulfillment: { record_id: record.id, strength: 'direct', basis: 'callback_returned_connected_outbound_call' } });
      }
    });

    test('a queued, unstamped or undelivered manual text is not a returned callback; a delivered composer text, a delivered staff-queue send and an accepted push notice are', async () => {
      const composer = JSON.stringify({ human_authored: true });
      for (const seed of [
        // 'manual' with no human stamp: automations reuse the type.
        (w) => sms(w, 'manual', { status: 'delivered' }),
        // Stamped but only queued, or sent with no provider acceptance for a push.
        (w) => sms(w, 'manual', { status: 'queued', metadata: composer }),
        (w) => sms(w, 'manual', { status: 'sent', metadata: composer }),
        (w) => sms(w, 'ai_assistant_reply', { status: 'delivered' }),
        // A stamped text that only queued: the push proof needs provider acceptance too.
        (w) => sms(w, 'manual', { status: 'sent', from_phone: 'push', metadata: composer }),
      ]) {
        const { result, saved } = await closesWith(seed);
        expect(result).toMatchObject({ fulfilled: 0 });
        expect(saved).toMatchObject({ status: 'open', fulfillment: null });
      }
      for (const seed of [
        (w) => sms(w, 'manual', { status: 'delivered', metadata: composer }),
        (w) => sms(w, 'ai_approved', { status: 'delivered' }),
        (w) => sms(w, 'ai_revised', { status: 'delivered' }),
        (w) => sms(w, 'manual', { status: 'sent', from_phone: 'push', metadata: JSON.stringify({ human_authored: true, providerAccepted: true }) }),
      ]) {
        const { record, saved } = await closesWith(seed);
        expect(saved).toMatchObject({ status: 'fulfilled', fulfillment: { record_id: record.id, strength: 'direct', basis: 'callback_returned_by_human_text' } });
      }
    });

    test('a text from the sending admin counts as a person\'s (admin_user_id)', async () => {
      const [admin] = await db('technicians').insert({ name: 'Synthetic Evidence Staff', email: `staff-${Date.now()}@example.invalid`, role: 'technician', employment_status: 'active' }).returning('id');
      try {
        const { record, saved } = await closesWith((w) => sms(w, 'manual', { status: 'delivered', admin_user_id: admin.id }));
        expect(saved).toMatchObject({ status: 'fulfilled', fulfillment: { record_id: record.id, strength: 'direct' } });
      } finally {
        await db('sms_log').whereIn('id', made.smsIds).update({ admin_user_id: null });
        await db('technicians').where({ id: admin.id }).del();
      }
    });
  });

  test('a promise call with no usable phone (blocked caller ID) linked to a customer is not kept by that customer phoning in, nor by a text to a number the call never had', async () => {
    const w = await world({ kind: 'callback' });
    await db('call_log').where({ id: w.call.id }).update({ from_phone: null });
    await inbound(w);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0, failed: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    // Nothing phone-based is looked up: a text to the number the call never had proves nothing.
    const bare = await world({ kind: 'callback' });
    await db('call_log').where({ id: bare.call.id }).update({ from_phone: null });
    await staffText(bare, { status: 'delivered' });
    expect(await cc.refreshFulfillment(db, bare.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(bare.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
  });

  describe('the direct proof pages past a long run of candidates the shared predicates refuse', () => {
    const BULK = 201; // one more than a page
    test('a valid staff call back after 201 invalid staff calls still closes the callback', async () => {
      const w = await world({ kind: 'callback' });
      const at = later(5);
      const rows = Array.from({ length: BULK }, (_, i) => ({
        twilio_call_sid: `CA${'2'.repeat(24)}${w.n}b${String(i).padStart(3, '0')}`, direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone,
        status: 'completed', duration_seconds: 80, customer_id: w.customerId, created_at: at, source: 'admin-click',
        v2_extraction_status: 'failed', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: false } }),
      }));
      const inserted = await db('call_log').insert(rows).returning('id');
      inserted.forEach((r) => made.callIds.push(r.id));
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
      const good = await outboundCall(w, { created_at: later(20) });
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { record_id: good.id, strength: 'direct' } });
    });

    test('a delivered composer text after 201 undelivered ones still closes the callback', async () => {
      const w = await world({ kind: 'callback' });
      const at = later(5);
      const rows = Array.from({ length: BULK }, () => ({
        direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, customer_id: w.customerId, message_type: 'manual', status: 'sent',
        created_at: at, metadata: JSON.stringify({ human_authored: true }),
      }));
      const inserted = await db('sms_log').insert(rows).returning('id');
      inserted.forEach((r) => made.smsIds.push(r.id));
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
      const good = await staffText(w, { status: 'delivered', created_at: later(20) });
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'fulfilled', fulfillment: { record_id: good.id, strength: 'direct' } });
    });
  });
});
