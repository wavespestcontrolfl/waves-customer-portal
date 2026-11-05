// AI close of open Waves promises on calls with NO customer record, on a real Postgres (CI's DB-gated step,
// DATABASE_URL). GATE_CALL_PROMISE_AI_NO_CUSTOMER (owner 2026-11-05, "A, AI"): which promises are candidates, what
// closes them (a later live call or a person's text on the SAME phone, quoted by the model), what never does (a
// voicemail, another phone, contact from before, an automated text), the shared-phone guard, the daily cap of 10
// model calls newest-first, and the re-judge that reopens a close when the call gains a customer or the gate goes off.
// The provider is mocked at dispatchWithFallback: no real model is ever called. Fixtures fictitious.
process.env.GATE_CALL_COMMITMENTS = 'true';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
const OUR_NUMBER = '+15555550100';
const DAY = 24 * 60 * 60 * 1000;
jest.setTimeout(60000);

maybeDescribe('AI close of promises on calls with no customer (live Postgres)', () => {
  let db;
  let cc;
  let close;
  let evidence;
  let seq = 0;
  const made = { callIds: [], customerIds: [], smsIds: [], commitmentIds: [] };
  const GATES = ['GATE_CALL_PROMISE_AI_CLOSE', 'GATE_CALL_PROMISE_AI_NO_CUSTOMER', 'PROMISE_EVIDENCE_CLOSE'];
  const saved = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));
  const scenario = new Map();
  const THREAD_PROMPT = 'Decide whether a LATER text in this customer';
  const asked = (w) => dispatchWithFallback.mock.calls.filter(([, payload]) => payload.text.includes(w.commitment.description)
    && !payload.text.includes(THREAD_PROMPT));
  const modelCalls = () => dispatchWithFallback.mock.calls.length;

  beforeAll(() => {
    db = require('../models/db');
    cc = require('../services/call-commitments');
    close = require('../services/call-promise-ai-close');
    evidence = require('../services/call-promise-phone-evidence');
  });
  afterAll(async () => {
    for (const g of GATES) { if (saved[g] === undefined) delete process.env[g]; else process.env[g] = saved[g]; }
    const del = async (table, ids, column = 'id') => { if (ids.length) await db(table).whereIn(column, ids).del(); };
    await db('audit_log').whereIn('resource_id', made.commitmentIds).del();
    await del('sms_log', made.smsIds);
    await del('call_log', made.callIds); // cascades the commitments
    await del('customers', made.customerIds);
    await db.destroy();
  });
  beforeEach(() => {
    process.env.GATE_CALL_PROMISE_AI_CLOSE = 'true';
    process.env.GATE_CALL_PROMISE_AI_NO_CUSTOMER = 'true';
    delete process.env.PROMISE_EVIDENCE_CLOSE;
    scenario.clear();
    dispatchWithFallback.mockReset();
    dispatchWithFallback.mockImplementation(async (_policy, payload) => {
      for (const [description, answer] of scenario) if (payload.text.includes(description)) return typeof answer === 'function' ? answer(payload) : answer;
      return { ok: true, json: { verdict: payload.text.includes(THREAD_PROMPT) ? 'not_completed' : 'open', record_ref: null, quote: null } };
    });
  });
  afterEach(async () => {
    // The day's cap is shared across tests: start each from zero.
    await db('audit_log').where({ action: evidence.MODEL_CALL_ACTION }).del();
  });

  // One promise from a 55 second call, three days ago, from a number with no customer record: the Nov 4 shape.
  async function world({ kind = 'schedule_visit', callAgeDays = 3, description = null } = {}) {
    seq += 1;
    const n = `${Date.now().toString().slice(-5)}${String(seq).padStart(3, '0')}`.replace(/4111/g, '4101');
    const phone = `+1555${n.padStart(7, '0').slice(-7)}`;
    const startedAt = new Date(Date.now() - callAgeDays * DAY);
    const [call] = await db('call_log').insert({
      twilio_call_sid: `CA${'7'.repeat(20)}${n}`.slice(0, 34), direction: 'inbound', from_phone: phone, to_phone: OUR_NUMBER, status: 'completed',
      duration_seconds: 55, customer_id: null, created_at: startedAt, disposition: 'vendor_logged',
    }).returning('*');
    made.callIds.push(call.id);
    const [commitment] = await db('call_commitments').insert({
      call_log_id: call.id, commitment_key: `waves:${kind}`, party: 'waves', kind, source: 'ai', last_seen_generation: 1, status: 'open',
      description: description || `Text the time frames in about ten minutes ${n}`,
      evidence: JSON.stringify([{ quote: 'I will text you the time frames in about ten minutes', speaker: 'agent' }]),
    }).returning('*');
    made.commitmentIds.push(commitment.id);
    return { n, phone, call, commitment, startedAt };
  }
  const after = (w, minutes) => new Date(w.startedAt.getTime() + (55 + minutes * 60) * 1000);
  let callSeq = 0;
  const addCall = async (w, extra = {}) => {
    callSeq += 1;
    const [r] = await db('call_log').insert({
      twilio_call_sid: `CB${w.n}${String(callSeq).padStart(4, '0')}${'8'.repeat(24)}`.slice(0, 34), direction: 'inbound', from_phone: w.phone, to_phone: OUR_NUMBER,
      status: 'completed', duration_seconds: 210, answered_by: 'human', customer_id: null, created_at: after(w, 150),
      transcription: 'Agent: Good to hear from you. Let us do the walkthrough at two PM tomorrow.\nCaller: That works for me.', ...extra }).returning('id');
    made.callIds.push(r.id);
    return r.id;
  };
  const person = JSON.stringify({ human_authored: true });
  const addSms = async (w, extra = {}) => {
    const [r] = await db('sms_log').insert({ direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, customer_id: null,
      message_type: 'manual', status: 'delivered', message_body: 'Here are the time frames: Tuesday between two and four.', metadata: person,
      created_at: after(w, 30), ...extra }).returning('id');
    made.smsIds.push(r.id);
    return r.id;
  };
  const say = (w, answer) => scenario.set(w.commitment.description, answer);
  const fulfilledBy = (ref, quote) => ({ ok: true, json: { verdict: 'fulfilled', record_ref: ref, quote } });
  const row = (id) => db('call_commitments').where({ id }).first();
  const run = (w, over = {}) => close.runCallPromiseAiClose({ conn: db, now: new Date(), callIds: [].concat(w).map((x) => x.call.id), ...over });

  describe('which promises are candidates', () => {
    test('gate off: a call with no customer is never listed and never judged', async () => {
      process.env.GATE_CALL_PROMISE_AI_NO_CUSTOMER = 'false';
      const w = await world();
      await addCall(w);
      expect(await close.listNoCustomerCandidates(db, { callIds: [w.call.id] })).toEqual([]);
      const result = await run(w);
      expect(result).toMatchObject({ candidates: 0, closed: 0 });
      expect(result.no_customer_candidates).toBeUndefined();
      expect(modelCalls()).toBe(0);
    });

    test('gate on: it is listed in its own pass; the customer pass still never lists it', async () => {
      const w = await world();
      expect((await close.listNoCustomerCandidates(db, { callIds: [w.call.id] })).map((r) => r.id)).toEqual([w.commitment.id]);
      expect(await close.listCandidates(db, { callIds: [w.call.id] })).toEqual([]);
    });

    test('the AI close itself off: the no-customer gate alone does nothing', async () => {
      process.env.GATE_CALL_PROMISE_AI_CLOSE = 'false';
      const w = await world();
      expect(await close.listNoCustomerCandidates(db, { callIds: [w.call.id] })).toEqual([]);
      expect(await run(w)).toEqual({ skipped: true, reason: 'gated_off' });
    });
  });

  describe('what closes a promise', () => {
    test('the example: a later 3.5 minute live call on the same phone, quoted from Waves\' own words, closes it with the phone proof on the row', async () => {
      const w = await world();
      const later = await addCall(w);
      say(w, fulfilledBy(`call:${later}`, 'walkthrough at two PM tomorrow'));
      const result = await run(w);
      expect(result).toMatchObject({ no_customer_candidates: 1, no_customer_model_calls: 1, model_calls: 1, closed: 1, lost: 0 });
      expect(asked(w)).toHaveLength(1);
      const done = await row(w.commitment.id);
      expect(done.status).toBe('fulfilled');
      expect(done.fulfillment).toMatchObject({ kind: 'ai_check', basis: 'ai_check', identity: 'phone', closed_by: 'promise_evidence',
        record_type: 'call_log', record_id: later, judged_customer_id: null });
      expect(done.fulfillment.quote).toBeUndefined();
      // The Owed tab's closed-automatically list shows it.
      const listed = await cc.listAutoClosedCommitments(db, { days: 7 });
      expect(listed.commitments.find((c) => c.id === w.commitment.id)?.fulfillment).toMatchObject({ identity: 'phone', record_id: later });
    });

    test('a text a person sent to that phone, quoted by the model, closes it', async () => {
      const w = await world();
      const text = await addSms(w);
      say(w, fulfilledBy(`sms:${text}`, 'time frames: Tuesday between two and four'));
      expect(await run(w)).toMatchObject({ closed: 1 });
      expect((await row(w.commitment.id)).fulfillment).toMatchObject({ identity: 'phone', record_type: 'sms_log', record_id: text });
    });

    test('the model is told what it read: the later call and texts both ways reach it; no phone number does', async () => {
      const w = await world();
      await addCall(w);
      await addSms(w);
      await addSms(w, { direction: 'inbound', from_phone: w.phone, to_phone: OUR_NUMBER, message_type: null, status: 'received', metadata: null, message_body: 'Tuesday works', created_at: after(w, 60) });
      await run(w);
      const prompt = asked(w)[0][1].text;
      expect(prompt).toContain('walkthrough at two PM');
      expect(prompt).toContain('Tuesday works');
      // (The promise text carries the fixture's serial; the number itself, in any form, must not.)
      expect(prompt).not.toContain(w.phone.slice(2));
      expect(prompt).not.toContain(w.phone);
    });
  });

  describe('what never closes a promise', () => {
    test('a later voicemail, a call on a different phone, and contact from before the promise give the model nothing to judge', async () => {
      const voicemail = await world();
      await addCall(voicemail, { answered_by: 'voicemail', duration_seconds: 40 });
      const elsewhere = await world();
      await addCall(elsewhere, { from_phone: '+15555559998' });
      const earlier = await world();
      await addCall(earlier, { created_at: new Date(earlier.startedAt.getTime() - 60 * 60 * 1000) });
      const result = await run([voicemail, elsewhere, earlier]);
      expect(result).toMatchObject({ no_customer_candidates: 3, model_calls: 0, closed: 0 });
      expect(modelCalls()).toBe(0);
      for (const w of [voicemail, elsewhere, earlier]) expect((await row(w.commitment.id)).status).toBe('open');
    });

    test('an automated text is no witness; a person\'s text is', async () => {
      const automated = await world();
      await addSms(automated, { message_type: 'confirmation', metadata: null });
      const human = await world();
      await addSms(human);
      await run([automated, human]);
      expect(asked(automated)).toHaveLength(0);
      expect(asked(human)).toHaveLength(1);
    });

    test('a quote the record does not hold, or a record that is not an offered one, leaves it open', async () => {
      const w = await world();
      const later = await addCall(w);
      say(w, fulfilledBy(`call:${later}`, 'your estimate is attached'));
      expect(await run(w)).toMatchObject({ closed: 0 });
      expect((await row(w.commitment.id)).status).toBe('open');
    });
  });

  describe('the shared-phone guard', () => {
    test('a number more than one customer carries, a number that is ours, and a sentinel are skipped before any model call', async () => {
      const shared = await world();
      const [a, b] = await db('customers').insert([{ first_name: 'SharedA', phone: shared.phone }, { first_name: 'SharedB', phone: shared.phone }]).returning('id');
      made.customerIds.push(a.id, b.id);
      await addCall(shared);
      // A staff cell is one of "our" numbers (twilio-numbers.js isInternalNumber).
      const ours = await world();
      const priorForward = process.env.WAVES_FALLBACK_FORWARD_NUMBERS;
      process.env.WAVES_FALLBACK_FORWARD_NUMBERS = ours.phone;
      const sentinel = await world();
      await db('call_log').where({ id: sentinel.call.id }).update({ from_phone: 'anonymous' });
      let result;
      try {
        result = await run([shared, ours, sentinel]);
      } finally {
        if (priorForward === undefined) delete process.env.WAVES_FALLBACK_FORWARD_NUMBERS; else process.env.WAVES_FALLBACK_FORWARD_NUMBERS = priorForward;
      }
      expect(result).toMatchObject({ no_customer_candidates: 3, skipped: 3, model_calls: 0 });
      expect(modelCalls()).toBe(0);
      expect(require('../services/logger').info).toHaveBeenCalledWith(expect.stringContaining(`skipped no-customer promise ${shared.commitment.id}: multiple_customers`));
    });

    test('a number exactly one customer carries is still judged', async () => {
      const w = await world();
      const [c] = await db('customers').insert({ first_name: 'OnlyOne', phone: w.phone }).returning('id');
      made.customerIds.push(c.id);
      await addCall(w);
      expect(await run(w)).toMatchObject({ skipped: 0, model_calls: 1 });
    });
  });

  describe('the daily cap', () => {
    test('10 model calls per Eastern day, newest call first, shared by every pass; the rest wait', async () => {
      const worlds = [];
      for (let i = 0; i < 12; i += 1) {
        const w = await world({ callAgeDays: 2 + i / 100 });
        await addSms(w);
        worlds.push(w); // worlds[11] is the oldest call
      }
      // The model answers "open" to each: the cost is the call, not the close. A promise with a person's text costs two
      // calls (the record check and the thread check), so the cap of 10 judges the five newest.
      const first = await run(worlds);
      expect(first).toMatchObject({ no_customer_candidates: 12, no_customer_model_calls: 10 });
      expect(modelCalls()).toBe(10);
      expect(await evidence.noCustomerCallsToday(db, require('../utils/datetime-et').etDateString(new Date()))).toBe(10);
      // Newest first: the two oldest promises were not judged.
      expect(asked(worlds[0])).toHaveLength(1);
      expect(asked(worlds[4])).toHaveLength(1);
      expect(asked(worlds[5])).toHaveLength(0);
      expect(asked(worlds[11])).toHaveLength(0);
      expect(require('../services/logger').info).toHaveBeenCalledWith(expect.stringContaining('daily cap of 10 model calls is spent'));
      // A second pass the same day (the Owed read, a restart) spends nothing: the count lives in audit_log.
      dispatchWithFallback.mockClear();
      await run(worlds);
      expect(modelCalls()).toBe(0);
    });

    test('a verdict cached on unchanged evidence costs no call, so it does not draw on the cap', async () => {
      const w = await world();
      await addSms(w);
      await run(w);
      // The record check, and the later-text thread check over the person's text.
      expect(modelCalls()).toBeGreaterThanOrEqual(1);
      await db('audit_log').where({ action: evidence.MODEL_CALL_ACTION }).del();
      dispatchWithFallback.mockClear();
      const again = await run(w);
      expect(modelCalls()).toBe(0);
      expect(again.no_customer_model_calls).toBe(0);
    });
  });

  describe('a close is re-judged', () => {
    test('it stands while the call has no customer and the gate is on; it reopens when the call gains a customer, or the gate goes off', async () => {
      const w = await world();
      const later = await addCall(w);
      say(w, fulfilledBy(`call:${later}`, 'walkthrough at two PM tomorrow'));
      await run(w);
      expect((await row(w.commitment.id)).status).toBe('fulfilled');

      await cc.refreshFulfillment(db, w.call.id);
      expect((await row(w.commitment.id)).status).toBe('fulfilled');

      process.env.GATE_CALL_PROMISE_AI_NO_CUSTOMER = 'false';
      await cc.refreshFulfillment(db, w.call.id);
      expect((await row(w.commitment.id)).status).toBe('open');

      process.env.GATE_CALL_PROMISE_AI_NO_CUSTOMER = 'true';
      await run(w);
      expect((await row(w.commitment.id)).status).toBe('fulfilled');
      const [c] = await db('customers').insert({ first_name: 'Linked', phone: w.phone }).returning('id');
      made.customerIds.push(c.id);
      await db('call_log').where({ id: w.call.id }).update({ customer_id: c.id });
      await cc.refreshFulfillment(db, w.call.id);
      expect((await row(w.commitment.id)).status).toBe('open');
    });
  });
});
