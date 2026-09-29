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
    const call = { id: 'c1', created_at: new Date('2026-09-01T14:00:00Z'), duration_seconds: 30, direction: 'inbound', from_phone: '+15555550100', customer_id: null };
    const other = { id: 'p1', party: 'waves', kind: 'other', human_state: null };
    process.env.PROMISE_EVIDENCE_CLOSE = 'off';
    expect(await cc.resolveFulfillment(conn, other, call)).toBeNull();
    // On, the lookups start (proved by the query attempt); a customer's own promise is never judged by them.
    process.env.PROMISE_EVIDENCE_CLOSE = 'on';
    await expect(cc.resolveFulfillment(conn, other, call)).rejects.toThrow('no query expected');
    expect(await cc.resolveFulfillment(conn, { ...other, party: 'customer' }, call)).toBeNull();
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
  async function world({ kind = 'other', party = 'waves', customer = true, human_state = null, status = 'open', customerExtra = {} } = {}) {
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
      call_log_id: call.id, commitment_key: `${party}:${kind}`, party, kind, description: `Fixture ${kind}`, source: 'ai',
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
  const addEmail = track(made.emailIds);

  // Each evidence path: the seed that makes it true, the basis it is stored
  // under, and a near-miss that must not close.
  const inbound = (w, extra = {}) => db('call_log').insert({
    twilio_call_sid: `CA${'5'.repeat(24)}${w.n}in${Object.keys(extra).length}`, direction: 'inbound', from_phone: w.phone, to_phone: OUR_NUMBER, status: 'completed',
    duration_seconds: 75, v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: false } }), customer_id: w.customerId, created_at: later(), ...extra,
  }).returning('id').then(([r]) => { made.callIds.push(r.id); return r; });
  const outboundCall = (w, extra = {}) => db('call_log').insert({
    twilio_call_sid: `CA${'4'.repeat(24)}${w.n}ou`, direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, status: 'completed',
    duration_seconds: 80, customer_id: w.customerId, created_at: later(), ...extra,
  }).returning('id').then(([r]) => { made.callIds.push(r.id); return r; });
  const sms = (w, message_type, extra = {}) => addSms(db('sms_log').insert({
    direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, customer_id: w.customerId, message_type, status: 'sent', created_at: later(), ...extra }));
  // A text a person wrote in the composer: 'manual' plus the human_authored stamp.
  const staffText = (w, extra = {}) => sms(w, 'manual', { metadata: JSON.stringify({ human_authored: true }), ...extra });
  const visit = (w, extra = {}) => addVisit(db('scheduled_services').insert({
    scheduled_date: '2026-12-01', service_type: 'General Pest Control', status: 'pending', customer_id: w.customerId, created_at: later(), ...extra }));
  const staffEmail = (w, extra = {}) => addEmail(db('emails').insert({
    gmail_id: `g-${w.n}-${Object.keys(extra).length}`, gmail_thread_id: `t-${w.n}`, from_address: 'office@wavespestcontrol.com', to_address: w.email,
    customer_id: w.customerId, label_ids: JSON.stringify(['SENT']), received_at: later(), ...extra }));
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

  const CASES = [
    ['other', 'a connected staff call to the caller', (w) => outboundCall(w), 'staff_call_to_caller_within_14_days', 'outbound_call'],
    ['other', 'a human-typed text to the caller', (w) => staffText(w), 'staff_text_to_caller_within_14_days', 'sms_sent'],
    ['other', 'a completed inbound call from the caller', (w) => inbound(w), 'completed_inbound_call_from_caller_within_14_days', 'inbound_call'],
    ['other', 'a visit booked for the customer', (w) => visit(w), 'visit_booked_for_same_customer_within_14_days', 'appointment_booked'],
    ['other', 'a visit completed for the customer', (w) => visit(w, { status: 'completed', completed_at: later(), created_at: new Date(Date.now() - 20 * DAY) }), 'visit_completed_for_same_customer_within_14_days', 'visit_completed'],
    ['other', 'an estimate sent to the customer', (w) => estimate(w), 'estimate_sent_to_same_customer_within_14_days', 'estimate_sent'],
    ['callback', 'a completed inbound call from the caller', (w) => inbound(w), 'completed_inbound_call_from_caller_within_14_days', 'inbound_call'],
    ['callback', 'a staff email to the customer', (w) => staffEmail(w), 'staff_email_to_customer_within_14_days', 'email_sent'],
    ['callback', 'a visit booked for the customer', (w) => visit(w), 'visit_booked_for_same_customer_within_14_days', 'appointment_booked'],
    ['callback', 'an estimate sent to the customer', (w) => estimate(w), 'estimate_sent_to_same_customer_within_14_days', 'estimate_sent'],
    ['send_estimate', 'a visit booked for the customer', (w) => visit(w), 'visit_booked_for_same_customer_within_14_days', 'appointment_booked'],
    ['send_estimate', 'a visit completed for the customer', (w) => visit(w, { status: 'completed', completed_at: later(), created_at: new Date(Date.now() - 20 * DAY) }), 'visit_completed_for_same_customer_within_14_days', 'visit_completed'],
    ['schedule_visit', 'a visit completed for the customer', (w) => visit(w, { status: 'completed', completed_at: later(), created_at: new Date(Date.now() - 20 * DAY) }), 'visit_completed_for_same_customer_within_14_days', 'visit_completed'],
    ['send_report', 'a service report text to the caller', (w) => sms(w, 'service_report'), 'service_report_text_to_caller_within_14_days', 'sms_sent'],
    ['send_report', 'a service report email to the customer', (w) => reportEmail(w), 'service_report_email_to_customer_within_14_days', 'email_sent'],
    ['send_report', 'a staff email to the customer', (w) => staffEmail(w), 'staff_email_to_customer_within_14_days', 'email_sent'],
    ['send_paperwork', 'a service report text to the caller', (w) => sms(w, 'service_report_ready'), 'service_report_text_to_caller_within_14_days', 'sms_sent'],
    ['send_paperwork', 'a staff email to the customer', (w) => staffEmail(w), 'staff_email_to_customer_within_14_days', 'email_sent'],
  ];

  test.each(CASES)('%s: %s closes the promise with the proof stored; with the switch off it stays open and unchanged', async (kind, _what, seed, basis, proofKind) => {
    const w = await world({ kind });
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

  test('near-misses do not close: a voicemail, short or AI-only inbound call, a cancelled or generated visit, an unsent, foreign, self-addressed or longer-address email, before the call, after the window', async () => {
    const stayOpen = async (kind, seed) => {
      const w = await world({ kind });
      await seed(w);
      expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    };
    await stayOpen('callback', (w) => inbound(w, { ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: true } }) }));
    await stayOpen('callback', (w) => inbound(w, { duration_seconds: 40 }));
    await stayOpen('callback', (w) => inbound(w, { call_outcome: 'ai_handled' }));
    await stayOpen('callback', (w) => inbound(w, { status: 'no-answer' }));
    await stayOpen('callback', (w) => inbound(w, { created_at: new Date(Date.now() - 3 * DAY - 60 * 1000) }));
    await stayOpen('callback', (w) => inbound(w, { created_at: new Date(Date.now() - 3 * DAY + 15 * DAY) }));
    await stayOpen('other', (w) => visit(w, { status: 'cancelled' }));
    await stayOpen('other', async (w) => {
      const [parent] = await db('scheduled_services').insert({ scheduled_date: '2026-09-01', service_type: 'General Pest Control', status: 'completed', customer_id: w.customerId, created_at: new Date(Date.now() - 20 * DAY) }).returning('id');
      made.visitIds.push(parent.id);
      await visit(w, { recurring_parent_id: parent.id });
    });
    await stayOpen('callback', (w) => staffEmail(w, { label_ids: JSON.stringify(['SENT', 'INBOX']) }));
    await stayOpen('callback', (w) => staffEmail(w, { label_ids: JSON.stringify(['INBOX']), from_address: w.email, to_address: 'office@wavespestcontrol.com' }));
    await stayOpen('callback', (w) => staffEmail(w, { from_address: 'someone@example.invalid' }));
    await stayOpen('callback', (w) => staffEmail(w, { to_address: `x${w.email}` }));
    await stayOpen('callback', (w) => staffEmail(w, { received_at: new Date(Date.now() - 3 * DAY - 60 * 1000) }));
    // The exact address, but the sync linked the message to no one, or to another customer.
    await stayOpen('callback', (w) => staffEmail(w, { customer_id: null }));
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
    await stayOpen('callback', async (w) => staffEmail(w, { customer_id: await householdMember(w) }));
    await stayOpen('send_appointment_confirmation', async (w) => sms(w, 'confirmation', { customer_id: await householdMember(w) }));
    await stayOpen('send_report', (w) => reportEmail(w, { status: 'bounced' }));
    await stayOpen('send_report', (w) => reportEmail(w, { status: 'dropped' }));
    // Off the books is no appointment.
    await stayOpen('other', (w) => visit(w, { status: 'rescheduled' }));
    await stayOpen('other', (w) => visit(w, { status: 'skipped' }));
    // A linked call is answered only by a call linked to the same customer (shared household number).
    await stayOpen('callback', async (w) => {
      const [other] = await db('customers').insert({ first_name: `Household${w.n}`, phone: w.phone }).returning('id');
      made.customerIds.push(other.id);
      await inbound(w, { customer_id: other.id });
    });
    await stayOpen('send_estimate', (w) => visit(w, { status: 'completed', completed_at: new Date(Date.now() - 4 * DAY), created_at: new Date(Date.now() - 20 * DAY) }));
  });

  test('a staff email finds the customer by one exact address among several recipients, case-insensitively', async () => {
    const w = await world({ kind: 'callback' });
    const e = await staffEmail(w, { to_address: `"Someone" <other@example.invalid>, ${w.email.toUpperCase()}` });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(w.commitment.id)).fulfillment).toMatchObject({ record_id: e.id, basis: 'staff_email_to_customer_within_14_days' });
  });

  test('a callback whose card already placed a call never takes the new evidence (the card attempt early-return is kept)', async () => {
    const w = await world({ kind: 'callback' });
    await inbound(w);
    await db('call_log').insert({
      twilio_call_sid: `CA${'3'.repeat(24)}${w.n}ca`, direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, status: 'no-answer', duration_seconds: 5,
      created_at: later(5), metadata: JSON.stringify({ relatedCommitmentId: w.commitment.id }),
    }).returning('id').then(([r]) => made.callIds.push(r.id));
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
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
    const w = await world({ kind: 'other' });
    await outboundCall(w, { created_at: later(2 * 24 * 60) }); // a staff call two days on (looked up first)
    const quote = await estimate(w); // the quote that went out 30 minutes after the call
    await cc.refreshFulfillment(db, w.call.id);
    expect((await row(w.commitment.id)).fulfillment).toMatchObject({ kind: 'estimate_sent', record_id: quote.id });
  });

  test('a relink to another customer reopens a promise the old customer\'s evidence closed, and a customer-left dismissal', async () => {
    const [other] = await db('customers').insert({ first_name: 'Relinked', phone: '+15555559999' }).returning('id');
    made.customerIds.push(other.id);
    const kept = await world({ kind: 'other' });
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
    const own = await world({ kind: 'other' });
    await visit(own);
    await cc.refreshFulfillment(db, own.call.id);
    expect((await row(own.commitment.id)).fulfillment).toMatchObject({ strength: 'association', closed_by: 'promise_evidence' });
  });

  test('a close found through the old customer is not written once the call was relinked meanwhile (the write re-checks the call\'s customer)', async () => {
    const w = await world({ kind: 'other' });
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
    const booked = await world({ kind: 'other' });
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
    const old = await world({ kind: 'other' });
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
    const w = await world({ kind: 'other' });
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
    const confirmed = await world({ kind: 'other', human_state: 'confirmed' });
    await visit(confirmed);
    const dismissed = await world({ kind: 'other', human_state: 'dismissed', status: 'dismissed' });
    await visit(dismissed);
    for (const w of [confirmed, dismissed]) expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ checked: 0 });
    expect(await row(confirmed.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    expect(await row(dismissed.commitment.id)).toMatchObject({ status: 'dismissed' });
  });

  test('reopen sticks: an automatically closed promise a person reopens is not closed again by the same evidence; a callback (cards on) is judged only by evidence after the reopen', async () => {
    // Non-callback: the reopen is a human verdict the refresh leaves alone.
    const w = await world({ kind: 'other' });
    await visit(w);
    await cc.refreshFulfillment(db, w.call.id);
    expect((await row(w.commitment.id)).status).toBe('fulfilled');
    await cc.applyHumanUpdate(db, w.commitment.id, { action: 'reopen' });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ checked: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', human_state: 'confirmed', fulfillment: null });
    // SLA kind: the renewal event, not just the verdict, bounds the evidence.
    const est = await world({ kind: 'send_estimate' });
    await visit(est);
    await cc.refreshFulfillment(db, est.call.id);
    await cc.applyHumanUpdate(db, est.commitment.id, { action: 'reopen' });
    await cc.refreshFulfillment(db, est.call.id);
    expect(await row(est.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });

    // Callback under the card policy stays refreshable after a reopen, so the
    // boundary does the work: the old inbound call cannot close it again, a newer one can.
    const { gates } = require('../config/feature-gates');
    const gateWas = gates.callCommitments;
    gates.callCommitments = true;
    process.env.GATE_CALLBACK_CARD = 'true';
    try {
      const cb = await world({ kind: 'callback' });
      await inbound(cb);
      await cc.refreshFulfillment(db, cb.call.id);
      expect((await row(cb.commitment.id)).status).toBe('fulfilled');
      await cc.applyHumanUpdate(db, cb.commitment.id, { action: 'reopen' });
      // The reopened card is still refreshable (checked: 1), and the old call is before the renewal.
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
    const kept = await world({ kind: 'other' });
    await visit(kept);
    const left = await world({ kind: 'send_report', customerExtra: churnedStage(1) });
    const direct = await world({ kind: 'other' });
    const manual = await world({ kind: 'other' });
    const humanDismissed = await world({ kind: 'other' });
    const old = await world({ kind: 'other' });
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
      await staffEmail(w);
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

  test('a staff email to an address another live customer shares proves nothing; a merged (soft-deleted) duplicate with it does not count', async () => {
    const shared = await world({ kind: 'callback' });
    const [spouse] = await db('customers').insert({ first_name: `Spouse${shared.n}`, phone: `+1555557${shared.n}`, email: ` ${shared.email.toUpperCase()}` }).returning('id');
    made.customerIds.push(spouse.id);
    await staffEmail(shared);
    expect(await cc.refreshFulfillment(db, shared.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(shared.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    const merged = await world({ kind: 'callback' });
    const [duplicate] = await db('customers').insert({ first_name: `Duplicate${merged.n}`, phone: `+1555557${merged.n}`, email: merged.email, deleted_at: new Date() }).returning('id');
    made.customerIds.push(duplicate.id);
    const e = await staffEmail(merged);
    expect(await cc.refreshFulfillment(db, merged.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(merged.commitment.id)).fulfillment).toMatchObject({ record_id: e.id });
  });

  test('an association counts only from a later stated time that is not a deadline; a deadline, or direct proof, keeps the promise early', async () => {
    const statedAt = new Date(Date.now() - 1 * DAY); // two days after the call
    const floored = await world({ kind: 'other' });
    await db('call_commitments').where({ id: floored.commitment.id }).update({ due_at: statedAt, due_type: 'floor' });
    await staffText(floored); // half an hour after the call: before the stated time
    expect(await cc.refreshFulfillment(db, floored.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(floored.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    const onTime = await staffText(floored, { created_at: new Date(statedAt.getTime() + 60 * 60 * 1000) });
    expect(await cc.refreshFulfillment(db, floored.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(floored.commitment.id)).fulfillment).toMatchObject({ record_id: onTime.id });
    // Untyped is a floor too.
    const untyped = await world({ kind: 'other' });
    await db('call_commitments').where({ id: untyped.commitment.id }).update({ due_at: statedAt });
    await staffText(untyped);
    expect(await cc.refreshFulfillment(db, untyped.call.id)).toMatchObject({ fulfilled: 0 });
    // A deadline is the latest moment, not the first.
    const deadline = await world({ kind: 'other' });
    await db('call_commitments').where({ id: deadline.commitment.id }).update({ due_at: statedAt, due_type: 'deadline' });
    const early = await staffText(deadline);
    expect(await cc.refreshFulfillment(db, deadline.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(deadline.commitment.id)).fulfillment).toMatchObject({ record_id: early.id });
    // Direct proof is not held to the stated time.
    const direct = await world({ kind: 'schedule_visit' });
    await db('call_commitments').where({ id: direct.commitment.id }).update({ due_at: statedAt, due_type: 'floor' });
    const booked = await visit(direct, { source_call_log_id: direct.call.id });
    expect(await cc.refreshFulfillment(db, direct.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(direct.commitment.id)).fulfillment).toMatchObject({ record_id: booked.id, strength: 'direct' });
  });

  test('a relink the refresh never saw is found by the periodic scan whatever evidence closed the promise; a merge that moves the evidence with the call keeps it and stops listing it', async () => {
    const w = await world({ kind: 'other' });
    await staffText(w);
    await cc.refreshFulfillment(db, w.call.id);
    expect((await row(w.commitment.id)).fulfillment).toMatchObject({ kind: 'sms_sent', judged_customer_id: w.customerId });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(w.call.id);
    const [other] = await db('customers').insert({ first_name: `Relink${w.n}`, phone: `+1555558${w.n}` }).returning('id');
    made.customerIds.push(other.id);
    await db('call_log').where({ id: w.call.id }).update({ customer_id: other.id }); // no refresh after it
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).toContain(w.call.id);
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ reopened: 1, failed: 0 });
    expect(await row(w.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(w.call.id);

    const m = await world({ kind: 'other' });
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
      const w = await world({ kind: 'other' });
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

  test('a staff text closes a promise only with a person\'s provenance: an automated send typed \'manual\' (the reschedule acknowledgement) is not a follow-up', async () => {
    const automated = await world({ kind: 'other' });
    await sms(automated, 'manual'); // no human_authored stamp, no sending admin
    expect(await cc.refreshFulfillment(db, automated.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(automated.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    const typed = await world({ kind: 'other' });
    const text = await staffText(typed);
    expect(await cc.refreshFulfillment(db, typed.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(typed.commitment.id)).fulfillment).toMatchObject({ record_id: text.id, basis: 'staff_text_to_caller_within_14_days' });
  });

  test('a later stated time moves the start of the association window, never its end: 14 days from the call still closes it', async () => {
    const callEnd = (w) => new Date(new Date(w.call.created_at).getTime() + 90 * 1000);
    const late = await world({ kind: 'other' });
    await db('call_commitments').where({ id: late.commitment.id }).update({ due_at: new Date(callEnd(late).getTime() + 13 * DAY), due_type: 'floor' });
    // Day 20 after the call: past the original 14-day window, however late the stated time.
    await staffText(late, { created_at: new Date(callEnd(late).getTime() + 20 * DAY) });
    expect(await cc.refreshFulfillment(db, late.call.id)).toMatchObject({ fulfilled: 0 });
    expect(await row(late.commitment.id)).toMatchObject({ status: 'open', fulfillment: null });
    // Day 13.5: after the stated time and inside the window, it closes.
    const inside = await staffText(late, { created_at: new Date(callEnd(late).getTime() + 13.5 * DAY) });
    expect(await cc.refreshFulfillment(db, late.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(late.commitment.id)).fulfillment).toMatchObject({ record_id: inside.id });
  });

  test('the closed-automatically list and the lapse scan read when the portal closed a row, not updated_at: a reprocess never makes an old close look new', async () => {
    const w = await world({ kind: 'other' });
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

  test('a reused lead\'s earlier estimate (a hint) never hides a later proof that keeps the promise: the visit booked afterwards closes it', async () => {
    const w = await world({ kind: 'send_estimate' });
    const [lead] = await db('leads').insert({ first_name: `Reused${w.n}`, phone: w.phone, created_at: new Date(Date.now() - 30 * DAY) }).returning('id');
    made.leadIds.push(lead.id);
    await db('call_log').where({ id: w.call.id }).update({ metadata: JSON.stringify({ lead_id: lead.id }) });
    const early = later(10);
    const [est] = await db('estimates').insert({ status: 'sent', customer_phone: w.phone, created_at: new Date(Date.now() - 4 * DAY), sent_at: early,
      estimate_data: JSON.stringify({ lead_id: lead.id, deliveryState: { firstDeliveredAt: early.toISOString(), lastDeliveredAt: early.toISOString() } }) }).returning('id');
    made.estimateIds.push(est.id);
    const booked = await visit(w, { created_at: later(120) });
    expect(await cc.refreshFulfillment(db, w.call.id)).toMatchObject({ fulfilled: 1 });
    expect((await row(w.commitment.id)).fulfillment).toMatchObject({ record_id: booked.id, basis: 'visit_booked_for_same_customer_within_14_days' });
  });
});
