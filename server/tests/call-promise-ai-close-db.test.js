// AI close of open Waves call promises on a real Postgres (CI's DB-gated step,
// DATABASE_URL): which promises are candidates, what closes them (a later text, a
// booked or rescheduled visit, the customer's own "got it"), what never does
// (open, uncertain, an ungrounded quote, the customer's words on a call), the
// dark gate, the verdict cache, Reopen, and the re-judge that keeps or reopens a
// close. The provider is mocked at dispatchWithFallback. Fixtures fictitious.
process.env.GATE_CALL_COMMITMENTS = 'true';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
const OUR_NUMBER = '+15555550100';
const DAY = 24 * 60 * 60 * 1000;
jest.setTimeout(60000);

maybeDescribe('AI close of open call promises (live Postgres)', () => {
  let db;
  let cc;
  let close;
  let seq = 0;
  const made = { callIds: [], customerIds: [], smsIds: [], commitmentIds: [], visitIds: [] };
  const saved = { gate: process.env.GATE_CALL_PROMISE_AI_CLOSE, close: process.env.PROMISE_EVIDENCE_CLOSE };
  // What the mocked provider answers, by the promise's description; anything
  // else (a stray row in a shared scratch database) is answered "open".
  const scenario = new Map();
  const THREAD_PROMPT = 'Decide whether a LATER text in this customer';
  const askedAll = (w) => dispatchWithFallback.mock.calls.filter(([, payload]) => payload.text.includes(w.commitment.description));
  // The record check and the later-thread check are two prompts about one promise.
  const asked = (w) => askedAll(w).filter(([, payload]) => !payload.text.includes(THREAD_PROMPT));
  const askedThread = (w) => askedAll(w).filter(([, payload]) => payload.text.includes(THREAD_PROMPT));

  beforeAll(() => {
    db = require('../models/db');
    cc = require('../services/call-commitments');
    close = require('../services/call-promise-ai-close');
  });
  afterAll(async () => {
    for (const [name, value] of [['GATE_CALL_PROMISE_AI_CLOSE', saved.gate], ['PROMISE_EVIDENCE_CLOSE', saved.close]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    const del = async (table, ids, column = 'id') => { if (ids.length) await db(table).whereIn(column, ids).del(); };
    await db('audit_log').whereIn('resource_id', made.commitmentIds).del();
    await del('job_status_history', made.visitIds, 'job_id');
    await del('scheduled_services', made.visitIds);
    await del('sms_log', made.smsIds);
    await del('call_log', made.callIds); // cascades the commitments
    await del('customer_properties', made.customerIds, 'customer_id');
    await del('customers', made.customerIds);
    await db.destroy();
  });
  beforeEach(() => {
    process.env.GATE_CALL_PROMISE_AI_CLOSE = 'true';
    delete process.env.PROMISE_EVIDENCE_CLOSE;
    scenario.clear();
    dispatchWithFallback.mockReset();
    dispatchWithFallback.mockImplementation(async (_policy, payload) => {
      for (const [description, answer] of scenario) if (payload.text.includes(description)) return typeof answer === 'function' ? answer(payload) : answer;
      return { ok: true, json: { verdict: payload.text.includes(THREAD_PROMPT) ? 'not_completed' : 'open', record_ref: null, quote: null } };
    });
  });

  // One customer with one active property, one call that ended about three days
  // ago, one open promise.
  async function world({ kind = 'other', description = null, human_state = null, source = 'ai', status = 'open', commitmentExtra = {} } = {}) {
    seq += 1;
    // Never let the clock digits spell 4111 (the card-number scrub tests).
    const n = `${Date.now().toString().slice(-5)}${String(seq).padStart(3, '0')}`.replace(/4111/g, '4101');
    const phone = `+1555${n.padStart(7, '0').slice(-7)}`;
    const [customer] = await db('customers').insert({ first_name: `Promise${n}`, phone, email: `promise${n}@example.invalid` }).returning('id');
    made.customerIds.push(customer.id);
    const [property] = await db('customer_properties').insert({ customer_id: customer.id, is_primary: true, address_line1: `${n} Example Lane`, city: 'Sarasota', zip: '34236', active: true }).returning('id');
    const [call] = await db('call_log').insert({
      twilio_call_sid: `CA${'6'.repeat(20)}${n}`.slice(0, 34), direction: 'inbound', from_phone: phone, to_phone: OUR_NUMBER, status: 'completed',
      duration_seconds: 90, customer_id: customer.id, created_at: new Date(Date.now() - 3 * DAY),
    }).returning('*');
    made.callIds.push(call.id);
    const [commitment] = await db('call_commitments').insert({
      call_log_id: call.id, commitment_key: `waves:${kind}`, party: 'waves', kind, source, last_seen_generation: 1, human_state, status,
      description: description || `Look into the warranty question ${n}`,
      evidence: JSON.stringify([{ quote: 'I will check on the warranty and let you know', speaker: 'agent' }]), ...commitmentExtra,
    }).returning('*');
    made.commitmentIds.push(commitment.id);
    return { n, phone, customerId: customer.id, propertyId: property.id, call, commitment };
  }
  const later = (minutes = 30) => new Date(Date.now() - 3 * DAY + (90 + minutes * 60) * 1000);
  const person = JSON.stringify({ human_authored: true });
  const addSms = async (w, extra = {}) => {
    const [r] = await db('sms_log').insert({ direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, customer_id: w.customerId,
      message_type: 'manual', status: 'delivered', message_body: 'Good news: the warranty covers the retreatment.', metadata: person, created_at: later(), ...extra }).returning('id');
    made.smsIds.push(r.id);
    return r.id;
  };
  const addCustomerText = (w, body) => addSms(w, { direction: 'inbound', from_phone: w.phone, to_phone: OUR_NUMBER, message_type: null, status: 'received', metadata: null, message_body: body, created_at: later(60) });
  let callSeq = 0;
  const addCall = async (w, extra = {}) => {
    callSeq += 1;
    const [r] = await db('call_log').insert({
      twilio_call_sid: `CB${w.n}${String(callSeq).padStart(4, '0')}${'8'.repeat(24)}`.slice(0, 34), direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, status: 'completed',
      duration_seconds: 80, customer_id: w.customerId, created_at: later(45), source: 'admin-click', v2_extraction_status: 'valid',
      ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: false } }),
      transcription: 'Agent: I checked on the warranty, it covers the retreatment.\nCustomer: Great, thanks.', ...extra }).returning('id');
    made.callIds.push(r.id);
    return r.id;
  };
  const addVisit = async (w, extra = {}) => {
    const [r] = await db('scheduled_services').insert({ customer_id: w.customerId, property_id: w.propertyId, service_type: 'Quarterly Pest Control',
      scheduled_date: '2099-01-15', window_start: '09:00:00', status: 'confirmed', created_at: later(20), ...extra }).returning('id');
    made.visitIds.push(r.id);
    return r.id;
  };
  const say = (w, answer) => scenario.set(w.commitment.description, answer);
  const fulfilledBy = (ref, quote) => ({ ok: true, json: { verdict: 'fulfilled', record_ref: ref, quote } });
  const row = (id) => db('call_commitments').where({ id }).first();
  const run = (w, over = {}) => close.runCallPromiseAiClose({ conn: db, now: new Date(), callIds: [].concat(w).map((x) => x.call.id), ...over });

  describe('what closes a promise', () => {
    test('a later text a person sent, quoted exactly by the model, closes it with the proof on the row', async () => {
      const w = await world();
      const text = await addSms(w);
      say(w, fulfilledBy(`sms:${text}`, 'the warranty covers the retreatment'));
      const result = await run(w);
      expect(result).toMatchObject({ candidates: 1, model_calls: 1, closed: 1, lost: 0 });
      const after = await row(w.commitment.id);
      expect(after.status).toBe('fulfilled');
      expect(after.fulfillment).toMatchObject({ kind: 'ai_check', strength: 'association', basis: 'ai_check', closed_by: 'promise_evidence', closed_agent: 'ai-check',
        record_type: 'sms_log', record_id: text, quote: 'the warranty covers the retreatment', judged_customer_id: w.customerId });
      expect(new Date(after.fulfilled_at).getTime()).toBeGreaterThan(w.call.created_at.getTime());
      // The Owed tab's Closed-automatically list shows it, with the proof.
      const listed = await cc.listAutoClosedCommitments(db, { days: 7 });
      expect(listed.commitments.find((c) => c.id === w.commitment.id)?.fulfillment).toMatchObject({ kind: 'ai_check', quote: 'the warranty covers the retreatment' });
    });

    test('a visit booked after the call keeps a scheduling promise', async () => {
      const w = await world({ kind: 'schedule_visit', description: 'Book the follow-up visit' });
      w.commitment.description = `Book the follow-up visit ${w.n}`;
      await db('call_commitments').where({ id: w.commitment.id }).update({ description: w.commitment.description });
      const visit = await addVisit(w);
      say(w, fulfilledBy(`visit:${visit}`, 'status confirmed'));
      expect(await run(w)).toMatchObject({ model_calls: 1, closed: 1 });
      expect((await row(w.commitment.id)).fulfillment).toMatchObject({ kind: 'ai_check', record_type: 'scheduled_service', record_id: visit });
    });

    test('a visit rescheduled after the call keeps it too', async () => {
      const w = await world({ kind: 'schedule_visit' });
      const visit = await addVisit(w, { status: 'rescheduled', created_at: new Date(Date.now() - 30 * DAY) });
      await db('job_status_history').insert({ job_id: visit, from_status: 'confirmed', to_status: 'rescheduled', transitioned_at: later(20) });
      say(w, fulfilledBy(`visit:${visit}`, 'status rescheduled'));
      expect(await run(w)).toMatchObject({ closed: 1 });
      expect((await row(w.commitment.id)).status).toBe('fulfilled');
    });

    test('the customer\'s confirmation counts from any phone on the account, not only the one that called', async () => {
      const w = await world({ kind: 'send_report' });
      const reply = await addSms(w, { direction: 'inbound', from_phone: '+15555559999', to_phone: OUR_NUMBER, message_type: null, status: 'received', metadata: null,
        message_body: 'My wife got the report, thanks!', created_at: later(60) });
      say(w, (payload) => (payload.text.includes(THREAD_PROMPT)
        ? { ok: true, json: { verdict: 'completed', record_ref: `sms:${reply}`, quote: 'got the report' } }
        : { ok: true, json: { verdict: 'open', record_ref: null, quote: null } }));
      expect(await run(w)).toMatchObject({ closed: 1 });
      expect((await row(w.commitment.id)).fulfillment).toMatchObject({ witness: 'customer', record_id: reply });
    });

    test('a promise no record answers is closed by the customer\'s own later text saying it is done (the thread check)', async () => {
      const w = await world({ kind: 'send_report' });
      const reply = await addCustomerText(w, 'Got the report, thanks!');
      say(w, (payload) => (payload.text.includes(THREAD_PROMPT)
        ? { ok: true, json: { verdict: 'completed', record_ref: `sms:${reply}`, quote: 'Got the report' } }
        : { ok: true, json: { verdict: 'open', record_ref: null, quote: null } }));
      const result = await run(w);
      expect(result).toMatchObject({ model_calls: 1, closed: 1 });
      expect((await row(w.commitment.id)).fulfillment).toMatchObject({ kind: 'ai_check', check: 'thread_confirmation', witness: 'customer', record_type: 'sms_log', record_id: reply, quote: 'Got the report' });
    });
  });

  describe('what never closes a promise', () => {
    test('open, uncertain, a quote the record does not hold, and a cited record that is not an offered one all leave it open', async () => {
      const cases = [
        ['open', () => ({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } })],
        ['uncertain', () => ({ ok: true, json: { verdict: 'uncertain', record_ref: null, quote: null } })],
        ['ungrounded quote', (id) => fulfilledBy(`sms:${id}`, 'your retreatment is booked for Friday')],
        ['unknown record', () => fulfilledBy('sms:00000000-0000-4000-8000-000000000001', 'the warranty covers the retreatment')],
        ['provider failed', () => ({ ok: false })],
      ];
      for (const [label, answer] of cases) {
        const w = await world();
        const text = await addSms(w);
        say(w, answer(text));
        const result = await run(w);
        expect([label, result.closed]).toEqual([label, 0]);
        expect([label, (await row(w.commitment.id)).status]).toEqual([label, 'open']);
      }
    });

    test('a person\'s later text alone never closes it: the model is always asked', async () => {
      const w = await world();
      await addSms(w);
      // The record check and the later-thread check: two calls, no close.
      expect(await run(w)).toMatchObject({ model_calls: 2, closed: 0 });
      expect(asked(w)).toHaveLength(1);
      expect(askedThread(w)).toHaveLength(1);
      expect((await row(w.commitment.id)).status).toBe('open');
    });

    test('a call record proves it only in Waves\' own words, never the customer\'s', async () => {
      const w = await world();
      const call = await addCall(w);
      say(w, fulfilledBy(`call:${call}`, 'Great, thanks'));
      expect(await run(w)).toMatchObject({ closed: 0 });
      expect((await row(w.commitment.id)).status).toBe('open');
      const agent = await world();
      const agentCall = await addCall(agent);
      say(agent, fulfilledBy(`call:${agentCall}`, 'it covers the retreatment'));
      expect(await run(agent)).toMatchObject({ closed: 1 });
      expect((await row(agent.commitment.id)).fulfillment).toMatchObject({ record_type: 'call_log', record_id: agentCall });
    });

    test('a promise with no later record costs no model call; untouched, reviewed, withdrawn-by-reprocess, closed and customer-less promises are not candidates', async () => {
      const lonely = await world();
      const reviewed = await world({ human_state: 'confirmed' });
      const done = await world({ status: 'fulfilled' });
      const customerParty = await world();
      await db('call_commitments').where({ id: customerParty.commitment.id }).update({ party: 'customer', kind: 'provide_info' });
      const noCustomer = await world();
      await db('call_log').where({ id: noCustomer.call.id }).update({ customer_id: null });
      for (const w of [reviewed, done, customerParty, noCustomer]) await addSms(w);
      const result = await run([lonely, reviewed, done, customerParty, noCustomer]);
      expect(result).toMatchObject({ candidates: 1, model_calls: 0, closed: 0 });
      for (const w of [lonely, reviewed, done, customerParty, noCustomer]) expect(asked(w)).toHaveLength(0);
    });

    test('gate off: nothing is read, asked or written', async () => {
      delete process.env.GATE_CALL_PROMISE_AI_CLOSE;
      const w = await world();
      const text = await addSms(w);
      say(w, fulfilledBy(`sms:${text}`, 'the warranty covers the retreatment'));
      expect(await run(w)).toEqual({ skipped: true, reason: 'gated_off' });
      expect(close.runInBackground({ conn: db, callIds: [w.call.id] })).toBeNull();
      expect(dispatchWithFallback).not.toHaveBeenCalled();
      const after = await row(w.commitment.id);
      expect(after).toMatchObject({ status: 'open', fulfillment: null, contact_check: null });
      // The fixed-rule refresh is untouched by the gate: still no AI proof.
      await cc.refreshFulfillment(db, w.call.id);
      expect((await row(w.commitment.id)).fulfillment?.kind).not.toBe('ai_check');
    });
  });

  describe('cost', () => {
    test('an unchanged promise with unchanged evidence is never asked twice; a new record is asked again', async () => {
      const w = await world();
      await addSms(w);
      await run(w);
      await run(w);
      expect(asked(w)).toHaveLength(1);
      expect(askedThread(w)).toHaveLength(1);
      const stored = (await row(w.commitment.id)).contact_check.ai_close;
      expect(stored).toMatchObject({ version: close.VERSION, fulfillment_check: { verdict: 'open' } });
      await addSms(w, { message_body: 'One more thing about the warranty.', created_at: later(90) });
      await run(w);
      expect(asked(w)).toHaveLength(2);
    });

    test('a failed provider call is asked again only after the retry pause', async () => {
      const w = await world();
      await addSms(w);
      say(w, { ok: false });
      await run(w);
      await run(w);
      expect(asked(w)).toHaveLength(1);
      await run(w, { now: new Date(Date.now() + 2 * 60 * 60 * 1000) });
      expect(asked(w)).toHaveLength(2);
    });

    test('model calls are capped per run; the rest are deferred, oldest call first', async () => {
      const first = await world();
      const second = await world();
      await db('call_log').where({ id: first.call.id }).update({ created_at: new Date(Date.now() - 4 * DAY) });
      await addSms(first, { created_at: new Date(Date.now() - 4 * DAY + 20 * 60 * 1000) });
      await addSms(second);
      const result = await run([first, second], { maxModelCalls: 1 });
      expect(result).toMatchObject({ model_calls: 1, deferred: 1 });
      expect(asked(first)).toHaveLength(1);
      expect(asked(second)).toHaveLength(0);
    });
  });

  describe('Reopen and the re-judge', () => {
    async function closedByText() {
      const w = await world();
      const text = await addSms(w);
      say(w, fulfilledBy(`sms:${text}`, 'the warranty covers the retreatment'));
      expect(await run(w)).toMatchObject({ closed: 1 });
      return { w, text };
    }

    test('staff Reopen puts it back; it is a human verdict, so the AI never closes it again', async () => {
      const { w } = await closedByText();
      await cc.applyHumanUpdate(db, w.commitment.id, { action: 'reopen', reviewedBy: 'tester' });
      expect(await row(w.commitment.id)).toMatchObject({ status: 'open', human_state: 'confirmed', fulfillment: null });
      const before = dispatchWithFallback.mock.calls.length;
      expect(await run(w)).toMatchObject({ candidates: 0, closed: 0 });
      expect(dispatchWithFallback.mock.calls.length).toBe(before);
      await cc.refreshFulfillment(db, w.call.id);
      expect((await row(w.commitment.id)).status).toBe('open');
    });

    test('the watchdog\'s lapse scan lists the call only once the cited record is gone or a cited visit died, so the refresh can reopen it', async () => {
      const { w, text } = await closedByText();
      expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(w.call.id);
      await db('sms_log').where({ id: text }).del();
      expect(await cc.listLapsedEvidenceClosedCallIds(db)).toContain(w.call.id);

      const booked = await world({ kind: 'schedule_visit' });
      const visit = await addVisit(booked);
      say(booked, fulfilledBy(`visit:${visit}`, 'status confirmed'));
      expect(await run(booked)).toMatchObject({ closed: 1 });
      expect(await cc.listLapsedEvidenceClosedCallIds(db)).not.toContain(booked.call.id);
      await db('scheduled_services').where({ id: visit }).update({ status: 'skipped' });
      expect(await cc.listLapsedEvidenceClosedCallIds(db)).toContain(booked.call.id);
    });

    test('a refresh keeps the close while the cited record stands, with no model call', async () => {
      const { w } = await closedByText();
      const before = dispatchWithFallback.mock.calls.length;
      await cc.refreshFulfillment(db, w.call.id);
      expect((await row(w.commitment.id)).status).toBe('fulfilled');
      expect(dispatchWithFallback.mock.calls.length).toBe(before);
    });

    test('a refresh reopens it when the cited record is gone, or the call was relinked to another customer, or the promise was rewritten', async () => {
      const gone = await closedByText();
      await db('sms_log').where({ id: gone.text }).del();
      await cc.refreshFulfillment(db, gone.w.call.id);
      expect((await row(gone.w.commitment.id)).status).toBe('open');

      const relinked = await closedByText();
      const other = await world();
      await db('call_log').where({ id: relinked.w.call.id }).update({ customer_id: other.customerId });
      await cc.refreshFulfillment(db, relinked.w.call.id);
      expect((await row(relinked.w.commitment.id)).status).toBe('open');

      // A visit that kept a scheduling promise and was then cancelled or skipped no longer keeps it; a rescheduled one still does.
      const booked = await world({ kind: 'schedule_visit' });
      const visit = await addVisit(booked);
      say(booked, fulfilledBy(`visit:${visit}`, 'status confirmed'));
      expect(await run(booked)).toMatchObject({ closed: 1 });
      await db('scheduled_services').where({ id: visit }).update({ status: 'rescheduled' });
      await cc.refreshFulfillment(db, booked.call.id);
      expect((await row(booked.commitment.id)).status).toBe('fulfilled');
      await db('scheduled_services').where({ id: visit }).update({ status: 'cancelled' });
      await cc.refreshFulfillment(db, booked.call.id);
      expect((await row(booked.commitment.id)).status).toBe('open');

      const rewritten = await closedByText();
      await db('call_commitments').where({ id: rewritten.w.commitment.id }).update({ description: `${rewritten.w.commitment.description} (changed)` });
      await cc.refreshFulfillment(db, rewritten.w.call.id);
      expect((await row(rewritten.w.commitment.id)).status).toBe('open');
    });
  });

  describe('the Owed queue read', () => {
    test('runs one small background pass, one at a time', async () => {
      const w = await world();
      await addSms(w);
      const first = close.runInBackground({ conn: db, callIds: [w.call.id] });
      expect(first).toBeInstanceOf(Promise);
      expect(close.runInBackground({ conn: db, callIds: [w.call.id] })).toBeNull();
      await first;
      expect(asked(w)).toHaveLength(1);
      expect(close.runInBackground({ conn: db, callIds: [] })).toBeNull();
    });
  });
});
