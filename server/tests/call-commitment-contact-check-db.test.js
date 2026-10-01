// Model-judged close of Waves "other" call promises on a real Postgres (CI's
// DB-gated step, DATABASE_URL): which promises are candidates, which records
// may witness one, the close and its guards, the verdict cache, and that the
// re-judge keeps a close while its witness stands and the lapse scan lists it
// when it goes. The provider is mocked at dispatchWithFallback. Fixtures
// fictitious.
process.env.GATE_CALL_COMMITMENTS = 'true';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
const OUR_NUMBER = '+15555550100';
const DAY = 24 * 60 * 60 * 1000;
jest.setTimeout(60000);

maybeDescribe('model-judged close of "other" promises (live Postgres)', () => {
  let db;
  let cc;
  let check;
  let staff;
  let seq = 0;
  const made = { callIds: [], customerIds: [], smsIds: [], commitmentIds: [] };
  const saved = { close: process.env.PROMISE_EVIDENCE_CLOSE, check: process.env.PROMISE_CONTACT_CHECK };
  // What the mocked provider answers, by the promise's description; anything
  // else (a stray row in a shared scratch database) is answered "open".
  const scenario = new Map();
  const asked = (w) => dispatchWithFallback.mock.calls.filter(([, payload]) => payload.text.includes(w.commitment.description));

  beforeAll(() => {
    db = require('../models/db');
    cc = require('../services/call-commitments');
    check = require('../services/call-commitment-contact-check');
    staff = require('../services/staff-contact');
  });
  afterAll(async () => {
    for (const [name, value] of [['PROMISE_EVIDENCE_CLOSE', saved.close], ['PROMISE_CONTACT_CHECK', saved.check]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    const del = async (table, ids) => { if (ids.length) await db(table).whereIn('id', ids).del(); };
    await db('audit_log').whereIn('resource_id', made.commitmentIds).del();
    await del('sms_log', made.smsIds);
    await del('call_log', made.callIds); // cascades the commitments
    await del('customers', made.customerIds);
    await db.destroy();
  });
  beforeEach(() => {
    delete process.env.PROMISE_EVIDENCE_CLOSE; delete process.env.PROMISE_CONTACT_CHECK;
    scenario.clear();
    dispatchWithFallback.mockReset();
    dispatchWithFallback.mockImplementation(async (_policy, payload) => {
      for (const [description, answer] of scenario) if (payload.text.includes(description)) return typeof answer === 'function' ? answer(payload) : answer;
      return { ok: true, json: { verdict: 'open', record_ref: null, quote: null } };
    });
  });

  // One customer, one call that ended about three days ago, one open promise.
  async function world({ kind = 'other', party = 'waves', customer = true, human_state = null, source = 'ai', status = 'open', callExtra = {}, commitmentExtra = {} } = {}) {
    seq += 1;
    const n = `${Date.now().toString().slice(-5)}${String(seq).padStart(3, '0')}`;
    const phone = `+1555${n.padStart(7, '0').slice(-7)}`;
    let customerId = null;
    if (customer) {
      const [row] = await db('customers').insert({ first_name: `Contact${n}`, phone, email: `contact${n}@example.invalid` }).returning('id');
      customerId = row.id;
      made.customerIds.push(customerId);
    }
    const [call] = await db('call_log').insert({
      twilio_call_sid: `CA${'7'.repeat(20)}${n}`.slice(0, 34), direction: 'inbound', from_phone: phone, to_phone: OUR_NUMBER, status: 'completed',
      duration_seconds: 90, customer_id: customerId, created_at: new Date(Date.now() - 3 * DAY), ...callExtra,
    }).returning('*');
    made.callIds.push(call.id);
    const [commitment] = await db('call_commitments').insert({
      call_log_id: call.id, commitment_key: `${party}:${kind}`, party, kind, description: `Look into the warranty question ${n}`, source,
      last_seen_generation: 1, evidence: JSON.stringify([{ quote: 'I will check on the warranty and let you know', speaker: 'agent' }]), human_state, status, ...commitmentExtra,
    }).returning('*');
    made.commitmentIds.push(commitment.id);
    return { n, phone, customerId, call, commitment };
  }
  const later = (minutes = 30) => new Date(Date.now() - 3 * DAY + (90 + minutes * 60) * 1000);
  const person = JSON.stringify({ human_authored: true });
  const addSms = async (w, extra = {}) => {
    const [r] = await db('sms_log').insert({ direction: 'outbound', from_phone: OUR_NUMBER, to_phone: w.phone, customer_id: w.customerId,
      message_type: 'manual', status: 'delivered', message_body: 'Good news: the warranty covers the retreatment.', metadata: person, created_at: later(), ...extra }).returning('id');
    made.smsIds.push(r.id);
    return r.id;
  };
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
  const say = (w, answer) => scenario.set(w.commitment.description, answer);
  const fulfilledBy = (ref, quote) => ({ ok: true, json: { verdict: 'fulfilled', record_ref: ref, quote } });
  const row = (id) => db('call_commitments').where({ id }).first();
  // A run whose every model call failed throws (job health); the scratch database may hold other rows, so tests read the stored verdicts instead.
  const run = (over = {}) => check.runPromiseContactCheck({ now: new Date(), ...over })
    .catch((err) => { if (/every model call failed/.test(err.message)) return { failed_run: true }; throw err; });
  const lapsed = async () => cc.listLapsedEvidenceClosedCallIds(db);

  describe('candidates', () => {
    test('only open, untouched, AI-recorded Waves "other" promises on a customer call inside the window', async () => {
      const eligible = await world();
      const excluded = {
        customerParty: await world({ party: 'customer', kind: 'provide_info' }),
        otherKind: await world({ kind: 'callback' }),
        humanState: await world({ human_state: 'confirmed' }),
        enteredByHand: await world({ source: 'human' }),
        alreadyClosed: await world({ status: 'fulfilled' }),
        noCustomer: await world({ customer: false }),
        outsideWindow: await world({ callExtra: { created_at: new Date(Date.now() - 20 * DAY) } }),
      };
      const ids = (await check.listCandidates(db, new Date())).map((r) => r.id);
      expect(ids).toContain(eligible.commitment.id);
      for (const [name, w] of Object.entries(excluded)) expect([name, ids.includes(w.commitment.id)]).toEqual([name, false]);
    });

    test('every candidate is read, page by page: a full page of older promises never crowds a newer one out', async () => {
      // A whole page of older promises with nothing to judge, then a newer one with a witness.
      const older = [];
      try {
        for (let i = 0; i < check.CANDIDATE_LIMIT; i += 1) {
          older.push(await world({ callExtra: { created_at: new Date(Date.now() - 5 * DAY + i * 1000) } }));
        }
        const newer = await world();
        const text = await addSms(newer);
        say(newer, fulfilledBy(`sms:${text}`, 'the warranty covers the retreatment'));
        const result = await run();
        expect(result.candidates).toBeGreaterThan(check.CANDIDATE_LIMIT);
        expect(asked(newer)).toHaveLength(1);
        expect((await row(newer.commitment.id)).status).toBe('fulfilled');
      } finally {
        // The shared scratch database: later tests read a single page.
        await db('call_log').whereIn('id', older.map((w) => w.call.id)).del();
        await db('customers').whereIn('id', older.map((w) => w.customerId)).del();
      }
    });

    test('a promise whose 14 days have passed is never asked about, even with a witness on file', async () => {
      const w = await world();
      await addSms(w);
      const result = await run({ now: new Date(Date.now() + 12 * DAY) });
      expect(result).toBeTruthy();
      expect(asked(w)).toHaveLength(0);
    });
  });

  describe('witnesses', () => {
    test('only a person\'s delivered text or call back to the call\'s CURRENT customer, after the call ended, inside the window', async () => {
      const w = await world();
      const stranger = await world();
      const good = await addSms(w);
      const goodCall = await addCall(w);
      // Not witnesses: each fails one rule.
      await addSms(w, { metadata: null, message_body: 'Automated: your visit is tomorrow.' });               // an automated text (no person stamp)
      await addSms(w, { status: 'sent', message_body: 'Queued, never delivered.' });                           // not delivered
      await addSms(w, { status: 'failed', message_body: 'Failed text.' });
      await addSms(w, { created_at: new Date(Date.now() - 3 * DAY), message_body: 'Sent while still on the call.' }); // before the call ended
      await addSms(w, { created_at: new Date(Date.now() + 1000), message_body: 'From the future.' });
      await addSms(w, { direction: 'inbound', message_body: 'Customer: thanks!' });
      await addSms(stranger, { to_phone: w.phone, message_body: 'Same phone, another customer.' });           // phone alone never counts
      await addSms(w, { customer_id: null, message_body: 'Unlinked text to the same phone.' });
      await addSms(w, { metadata: JSON.stringify({ human_authored: true, review_ask_reservation: true }), status: 'sending', message_body: 'A reservation.' });
      await addCall(w, { source: 'collections_voice', transcription: 'Agent: this is a collections call.' });   // an automated call
      await addCall(w, { ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: true } }), transcription: 'Voicemail left.' });
      await addCall(w, { v2_extraction_status: 'failed', transcription: 'Never reviewed.' });
      await addCall(w, { source: 'voice_relay_sandbox', transcription: 'A sandbox call.' });
      await addCall(w, { direction: 'inbound', transcription: 'The customer called in.' });
      await addCall(w, { metadata: JSON.stringify({ customer_leg: { status: 'no-answer', duration_seconds: 0 } }), transcription: 'Nobody picked up.' });
      await addCall(w, { transcription: '' });                                                                 // nothing to quote
      const after = cc.callEndedAt(w.call);
      const evidence = await check.loadContactWitnesses(db, { callId: w.call.id, customerId: w.customerId, from: after, until: cc.windowEnd(after), now: new Date() });
      expect(evidence.failures).toEqual([]);
      expect(evidence.records.map((r) => r.ref).sort()).toEqual([`call:${goodCall}`, `sms:${good}`].sort());
    });

    test('the promise\'s own call is never its witness', async () => {
      const w = await world({ callExtra: { direction: 'outbound', source: 'admin-click', v2_extraction_status: 'valid', from_phone: OUR_NUMBER, to_phone: '+15555550111',
        ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: false } }), transcription: 'Agent: I will check and let you know.' } });
      const after = cc.callEndedAt(w.call);
      // Even a window opened at the call's own start would see it, if the rule let it.
      const evidence = await check.loadContactWitnesses(db, { callId: w.call.id, customerId: w.customerId, from: new Date(w.call.created_at.getTime() - 1000), until: cc.windowEnd(after), now: new Date() });
      expect(evidence.records.filter((r) => r.id === w.call.id)).toEqual([]);
    });

    test('a later stated floor moves the start: a text from before "after the inspection" is no witness', async () => {
      const floor = new Date(Date.now() - 3 * DAY + 4 * 60 * 60 * 1000);
      const w = await world({ commitmentExtra: { due_at: floor, due_type: 'floor', due_basis: 'stated' } });
      await addSms(w, { created_at: later(30), message_body: 'Too early.' });
      const ok = await addSms(w, { created_at: new Date(floor.getTime() + 60 * 60 * 1000), message_body: 'After the floor.' });
      const [candidate] = (await check.listCandidates(db, new Date())).filter((r) => r.id === w.commitment.id);
      const after = cc.callEndedAt({ created_at: candidate.call_created_at, duration_seconds: candidate.call_duration_seconds, direction: candidate.call_direction });
      const from = cc.associationFrom(candidate, after);
      expect(from.getTime()).toBe(floor.getTime());
      const evidence = await check.loadContactWitnesses(db, { callId: w.call.id, customerId: w.customerId, from, until: cc.windowEnd(after), now: new Date() });
      expect(evidence.records.map((r) => r.id)).toEqual([ok]);
    });

    test('a source that truncates or a text that is too long settles the verdict as uncertain, and no provider is asked', async () => {
      const w = await world();
      for (let i = 0; i < check.WITNESS_LIMIT + 1; i += 1) await addSms(w, { message_body: `Update number ${i}.` });
      const first = await run();
      expect(first).toBeTruthy();
      expect(asked(w)).toHaveLength(0);
      expect((await row(w.commitment.id)).contact_check).toMatchObject({ verdict: 'uncertain', reason: 'incomplete_sources', retry_after: null });
      expect((await row(w.commitment.id)).status).toBe('open');
      const long = await world();
      await addSms(long, { message_body: 'x'.repeat(check.BODY_LIMIT + 1) });
      await run();
      expect(asked(long)).toHaveLength(0);
      expect((await row(long.commitment.id)).contact_check).toMatchObject({ verdict: 'uncertain', reason: 'incomplete_sources' });
    });

    test('a card number never reaches the provider; a quote from the masked text still grounds', async () => {
      const w = await world();
      const id = await addSms(w, { message_body: 'Your deposit was on card 4111 1111 1111 1111 and the warranty covers the retreatment.' });
      say(w, fulfilledBy(`sms:${id}`, 'the warranty covers the retreatment'));
      await run();
      const [, payload] = asked(w)[0];
      expect(payload.text).not.toMatch(/4111/);
      expect((await row(w.commitment.id)).status).toBe('fulfilled');
    });
  });

  describe('the verdict and the close', () => {
    test('a grounded fulfilled verdict closes the promise with its proof, the judged customer and the witness time', async () => {
      const w = await world();
      const witness = await addSms(w);
      say(w, fulfilledBy(`sms:${witness}`, 'the warranty covers the retreatment'));
      await run();
      const closed = await row(w.commitment.id);
      expect(closed.status).toBe('fulfilled');
      expect(closed.fulfillment).toMatchObject({ strength: 'association', kind: 'person_contact', basis: 'model_judged_person_contact', record_type: 'sms_log',
        record_id: witness, quote: 'the warranty covers the retreatment', closed_by: 'promise_evidence', judged_customer_id: w.customerId });
      expect(new Date(closed.fulfillment.closed_at).getTime()).toBeGreaterThan(Date.now() - 60000);
      const witnessRow = await db('sms_log').where({ id: witness }).first('created_at');
      expect(new Date(closed.fulfilled_at).getTime()).toBe(new Date(witnessRow.created_at).getTime());
      expect(new Date(closed.fulfillment.matched_at).getTime()).toBe(new Date(witnessRow.created_at).getTime());
      expect(closed.contact_check).toMatchObject({ verdict: 'fulfilled', record_type: 'sms_log', record_id: witness, retry_after: null });
      // The Owed tab's list offers it, with the proof.
      const listed = (await cc.listAutoClosedCommitments(db, { days: 7 })).commitments.map((r) => r.id);
      expect(listed).toContain(w.commitment.id);
    });

    test('a call back closes it the same way, with the call as the witness', async () => {
      const w = await world();
      const callBack = await addCall(w);
      say(w, fulfilledBy(`call:${callBack}`, 'it covers the retreatment'));
      await run();
      expect((await row(w.commitment.id)).fulfillment).toMatchObject({ kind: 'person_contact', record_type: 'call_log', record_id: callBack, quote: 'it covers the retreatment' });
    });

    test.each([
      ['an open verdict', () => ({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } })],
      ['an uncertain verdict', () => ({ ok: true, json: { verdict: 'uncertain', record_ref: null, quote: null } })],
      ['a quote that is not in the witness', (id) => fulfilledBy(`sms:${id}`, 'we sent a technician this morning')],
      ['a ref that was never offered', () => fulfilledBy('sms:00000000-0000-4000-8000-000000000000', 'the warranty covers the retreatment')],
      ['a ref to a text that is not a witness (automated)', (_id, w) => w.automated && fulfilledBy(`sms:${w.automated}`, 'Automated reminder')],
      ['a provider failure', () => ({ ok: false, reason: 'error' })],
    ])('%s never closes the promise', async (_name, answer) => {
      const w = await world();
      const witness = await addSms(w);
      w.automated = await addSms(w, { metadata: null, message_body: 'Automated reminder: your visit is tomorrow.' });
      say(w, answer(witness, w));
      await run();
      const after = await row(w.commitment.id);
      expect(after.status).toBe('open');
      expect(after.fulfillment).toBeNull();
    });

    test('a text the customer can only thank does not close it: an open answer is stored, not acted on', async () => {
      const w = await world();
      await addSms(w, { message_body: 'Thanks so much, talk soon!' });
      await run();
      expect(asked(w)).toHaveLength(1);
      const after = await row(w.commitment.id);
      expect(after.status).toBe('open');
      expect(after.contact_check).toMatchObject({ verdict: 'open' });
    });

    test('a panel open never asks a model and never closes on contact alone', async () => {
      const w = await world();
      await addSms(w);
      const result = await cc.refreshFulfillment(db, w.call.id);
      expect(result).toMatchObject({ fulfilled: 0, failed: 0 });
      expect(asked(w)).toHaveLength(0);
      expect((await row(w.commitment.id)).status).toBe('open');
    });

    test('no witness at all: no model call, nothing stored', async () => {
      const w = await world();
      await run();
      expect(asked(w)).toHaveLength(0);
      expect((await row(w.commitment.id)).contact_check).toBeNull();
    });

    test('the same promise and the same evidence are never judged twice; new evidence is', async () => {
      const w = await world();
      await addSms(w, { message_body: 'We are still looking into it.' });
      await run();
      await run();
      expect(asked(w)).toHaveLength(1);
      await addSms(w, { message_body: 'The warranty covers the retreatment.', created_at: later(60) });
      await run();
      expect(asked(w)).toHaveLength(2);
    });

    test('a provider failure waits an hour and then asks again; a semantic answer does not', async () => {
      const w = await world();
      await addSms(w);
      say(w, { ok: false, reason: 'openai_timeout' });
      const now = new Date();
      await run({ now });
      const stored = (await row(w.commitment.id)).contact_check;
      expect(stored).toMatchObject({ verdict: 'uncertain', reason: 'provider_failed' });
      expect(new Date(stored.retry_after).getTime()).toBe(now.getTime() + 3600000);
      await run({ now: new Date(now.getTime() + 30 * 60000) });
      expect(asked(w)).toHaveLength(1);
      say(w, { ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
      await run({ now: new Date(now.getTime() + 61 * 60000) });
      expect(asked(w)).toHaveLength(2);
      await run({ now: new Date(now.getTime() + 5 * 3600000) });
      expect(asked(w)).toHaveLength(2);
    });

    test('a run whose every model call failed is a failed run for job health; one that answered anything is not', () => {
      expect(check.everyModelCallFailed({ model_calls: 2, provider_failed: 2 })).toBe(true);
      expect(check.everyModelCallFailed({ model_calls: 2, provider_failed: 1 })).toBe(false);
      expect(check.everyModelCallFailed({ model_calls: 0, provider_failed: 0 })).toBe(false);
    });

    test('a provider that failed is not asked again in the same run: the rest wait for the next tick', async () => {
      const [a, b] = [await world(), await world()];
      await addSms(a); await addSms(b);
      dispatchWithFallback.mockImplementation(async () => ({ ok: false, reason: 'openai_timeout' }));
      const result = await run();
      // Every promise the run reached shares the provider; after the first failure none is asked.
      expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
      expect(result.failed_run || result.deferred >= 1).toBeTruthy();
      expect(asked(a).length + asked(b).length).toBeLessThanOrEqual(1);
    });

    test('a run makes at most its budget of model calls; the rest wait', async () => {
      const [a, b] = [await world(), await world()];
      await addSms(a); await addSms(b);
      const candidates = (await check.listCandidates(db, new Date())).filter((r) => [a, b].some((w) => w.commitment.id === r.id));
      const budget = { left: 1 };
      const outcomes = [];
      for (const candidate of candidates) outcomes.push((await check.checkOne(db, candidate, { now: new Date(), budget })).outcome);
      expect(outcomes.sort()).toEqual(['deferred', 'judged']);
      expect(budget.left).toBe(0);
    });

    test('the kill switch and PROMISE_EVIDENCE_CLOSE stop new checks', async () => {
      const w = await world();
      const witness = await addSms(w);
      say(w, fulfilledBy(`sms:${witness}`, 'the warranty covers the retreatment'));
      process.env.PROMISE_CONTACT_CHECK = 'off';
      expect(await run()).toEqual({ skipped: true, reason: 'gated_off' });
      delete process.env.PROMISE_CONTACT_CHECK;
      process.env.PROMISE_EVIDENCE_CLOSE = 'off';
      expect(await run()).toEqual({ skipped: true, reason: 'gated_off' });
      expect(asked(w)).toHaveLength(0);
      expect((await row(w.commitment.id)).status).toBe('open');
    });
  });

  describe('whose words, and when (round 2)', () => {
    test('a call quote must be Waves\' own words: a customer\'s line, or an unlabeled transcript, never closes', async () => {
      const w = await world();
      const call = await addCall(w, { transcription: 'Agent: Just checking in on the yard.\nCustomer: The warranty covers the retreatment, thanks.' });
      say(w, fulfilledBy(`call:${call}`, 'the warranty covers the retreatment'));
      await run();
      const after = await row(w.commitment.id);
      expect(after.status).toBe('open');
      expect(after.contact_check).toMatchObject({ verdict: 'uncertain', reason: 'not_waves_words' });
      const flat = await world();
      const flatCall = await addCall(flat, { transcription: 'Speaker 1: I checked on the warranty, it covers the retreatment.\nSpeaker 2: Great.' });
      say(flat, fulfilledBy(`call:${flatCall}`, 'it covers the retreatment'));
      await run();
      expect((await row(flat.commitment.id)).status).toBe('open');
    });

    test('a text sent DURING an outbound promise call is not later evidence: the call ends at its start plus its length', async () => {
      // Waves called the customer (no bridge) and talked for 10 minutes.
      const w = await world({ callExtra: { direction: 'outbound', from_phone: OUR_NUMBER, duration_seconds: 600 } });
      const start = new Date(w.call.created_at);
      await addSms(w, { created_at: new Date(start.getTime() + 5 * 60 * 1000) });
      await run();
      expect(asked(w)).toHaveLength(0);
      expect((await row(w.commitment.id)).status).toBe('open');
    });

    test('a bridged call back is dated by its customer leg: one placed before a stated floor but that reached the customer after it counts, and closes at that time', async () => {
      const callEnd = new Date(Date.now() - 3 * DAY + 90 * 1000);
      const floor = new Date(callEnd.getTime() + 60 * 60 * 1000);
      const w = await world({ commitmentExtra: { due_at: floor, due_type: 'floor' } });
      const legEnded = new Date(floor.getTime() + 5 * 60 * 1000);
      const call = await addCall(w, { created_at: new Date(floor.getTime() - 5 * 60 * 1000),
        metadata: JSON.stringify({ customer_leg: { status: 'completed', duration_seconds: 300, ended_at: legEnded.toISOString() } }) });
      say(w, fulfilledBy(`call:${call}`, 'it covers the retreatment'));
      await run();
      const after = await row(w.commitment.id);
      expect(after.status).toBe('fulfilled');
      expect(new Date(after.fulfilled_at).toISOString()).toBe(legEnded.toISOString());
      expect(after.fulfillment.matched_at).toBe(legEnded.toISOString());
      // And the panel's re-judge agrees with the close.
      expect((await cc.refreshFulfillment(db, w.call.id)).reopened).toBe(0);
    });
  });

  describe('the close is guarded', () => {
    test('a promise touched while the model was thinking is not closed; the next run closes it without asking again', async () => {
      const w = await world();
      const witness = await addSms(w);
      say(w, (payload) => {
        // A hint refresh (or any writer) moves updated_at under the judgment.
        return db('call_commitments').where({ id: w.commitment.id }).update({ updated_at: new Date(Date.now() + 1000) })
          .then(() => fulfilledBy(`sms:${witness}`, 'the warranty covers the retreatment'));
      });
      await run();
      expect((await row(w.commitment.id)).status).toBe('open');
      expect((await row(w.commitment.id)).contact_check).toMatchObject({ verdict: 'fulfilled' });
      await run();
      expect((await row(w.commitment.id)).status).toBe('fulfilled');
      expect(asked(w)).toHaveLength(1);
    });

    test('a call relinked to another customer while the model was thinking closes nothing', async () => {
      const w = await world();
      const other = await world();
      const witness = await addSms(w);
      say(w, () => db('call_log').where({ id: w.call.id }).update({ customer_id: other.customerId }).then(() => fulfilledBy(`sms:${witness}`, 'the warranty covers the retreatment')));
      await run();
      expect((await row(w.commitment.id)).status).toBe('open');
    });

    test('a call whose end moved while the model was thinking (a reprocess) closes nothing; the next run judges it again', async () => {
      const w = await world();
      const witness = await addSms(w);
      say(w, () => db('call_log').where({ id: w.call.id }).update({ duration_seconds: 240 }).then(() => fulfilledBy(`sms:${witness}`, 'the warranty covers the retreatment')));
      await run();
      expect((await row(w.commitment.id)).status).toBe('open');
      say(w, fulfilledBy(`sms:${witness}`, 'the warranty covers the retreatment'));
      await run();
      expect((await row(w.commitment.id)).status).toBe('fulfilled');
    });

    test('a witness that vanishes, or is relinked, while the model was thinking closes nothing', async () => {
      const gone = await world();
      const goneWitness = await addSms(gone);
      say(gone, () => db('sms_log').where({ id: goneWitness }).del().then(() => fulfilledBy(`sms:${goneWitness}`, 'the warranty covers the retreatment')));
      const moved = await world();
      const other = await world();
      const movedWitness = await addSms(moved);
      say(moved, () => db('sms_log').where({ id: movedWitness }).update({ customer_id: other.customerId }).then(() => fulfilledBy(`sms:${movedWitness}`, 'the warranty covers the retreatment')));
      await run();
      expect((await row(gone.commitment.id)).status).toBe('open');
      expect((await row(moved.commitment.id)).status).toBe('open');
    });

    test('a person who touched the promise since is never overwritten', async () => {
      const w = await world();
      const witness = await addSms(w);
      say(w, () => db('call_commitments').where({ id: w.commitment.id }).update({ human_state: 'confirmed' }).then(() => fulfilledBy(`sms:${witness}`, 'the warranty covers the retreatment')));
      await run();
      expect((await row(w.commitment.id))).toMatchObject({ status: 'open', human_state: 'confirmed' });
    });

    test('bookkeeping never moves updated_at, the version the close is guarded on', async () => {
      const w = await world();
      await addSms(w, { message_body: 'Still working on it.' });
      const before = (await row(w.commitment.id)).updated_at;
      await run();
      expect((await row(w.commitment.id)).contact_check).toMatchObject({ verdict: 'open' });
      expect((await row(w.commitment.id)).updated_at.getTime()).toBe(before.getTime());
    });
  });

  describe('the re-judge keeps a model-judged close while its witness stands', () => {
    async function closedBy(kind) {
      const w = await world();
      const witness = kind === 'sms' ? await addSms(w) : await addCall(w);
      say(w, fulfilledBy(`${kind}:${witness}`, kind === 'sms' ? 'the warranty covers the retreatment' : 'it covers the retreatment'));
      await run();
      expect((await row(w.commitment.id)).status).toBe('fulfilled');
      return { ...w, witness };
    }

    test.each(['sms', 'call'])('a panel open (refreshFulfillment) leaves a %s close as it was, switch on or off', async (kind) => {
      const w = await closedBy(kind);
      const first = await row(w.commitment.id);
      // The proof records the md5 of the words the model read.
      const words = kind === 'sms' ? (await db('sms_log').where({ id: w.witness }).first('message_body')).message_body
        : (await db('call_log').where({ id: w.witness }).first('transcription')).transcription;
      expect(first.fulfillment.witness_md5).toBe(check.textMd5(words));
      expect(first.fulfillment.promise_md5).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
      for (const value of [undefined, 'off']) {
        if (value) process.env.PROMISE_CONTACT_CHECK = value; else delete process.env.PROMISE_CONTACT_CHECK;
        const result = await cc.refreshFulfillment(db, w.call.id);
        expect(result).toMatchObject({ reopened: 0, failed: 0 });
        const after = await row(w.commitment.id);
        expect(after.status).toBe('fulfilled');
        expect(after.fulfillment).toEqual(first.fulfillment);
        expect(after.updated_at.getTime()).toBe(first.updated_at.getTime());
      }
      expect(await lapsed()).not.toContain(w.call.id);
      expect(asked(w)).toHaveLength(1);
    });

    test('a text witness that no longer postdates the call reopens the promise on the next panel open', async () => {
      // The lapse scan does not read time (the stated-floor arm aside); the re-judge does.
      const w = await closedBy('sms');
      await db('sms_log').where({ id: w.witness }).update({ created_at: new Date(Date.now() - 4 * DAY) });
      expect((await cc.refreshFulfillment(db, w.call.id)).reopened).toBe(1);
      expect((await row(w.commitment.id)).status).toBe('open');
    });

    test.each([
      ['relinked to another customer', async (w, other) => db('sms_log').where({ id: w.witness }).update({ customer_id: other.customerId })],
      ['deleted', async (w) => db('sms_log').where({ id: w.witness }).del()],
      ['no longer delivered', async (w) => db('sms_log').where({ id: w.witness }).update({ status: 'failed' })],
      ['no longer a person\'s text', async (w) => db('sms_log').where({ id: w.witness }).update({ metadata: null })],
      ['edited (its words are no longer the ones the model read)', async (w) => db('sms_log').where({ id: w.witness }).update({ message_body: 'Running a few minutes late today.' })],
    ])('a text witness %s: the lapse scan lists the call and the re-judge reopens the promise', async (_name, change) => {
      const w = await closedBy('sms');
      const other = await world();
      await change(w, other);
      expect(await lapsed()).toContain(w.call.id);
      const result = await cc.refreshFulfillment(db, w.call.id);
      expect(result.reopened).toBe(1);
      const after = await row(w.commitment.id);
      expect(after.status).toBe('open');
      expect(after.fulfilled_at).toBeNull();
      expect(await lapsed()).not.toContain(w.call.id);
    });

    test.each([
      ['relinked to another customer', async (w, other) => db('call_log').where({ id: w.witness }).update({ customer_id: other.customerId })],
      ['deleted', async (w) => db('call_log').where({ id: w.witness }).del()],
      ['reclassified as a voicemail', async (w) => db('call_log').where({ id: w.witness }).update({ ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: true } }) })],
      ['no longer a valid extraction', async (w) => db('call_log').where({ id: w.witness }).update({ v2_extraction_status: 'failed' })],
      ['not placed by a person', async (w) => db('call_log').where({ id: w.witness }).update({ source: 'collections_voice' })],
      ['re-transcribed (its words are no longer the ones the model read)', async (w) => db('call_log').where({ id: w.witness }).update({ transcription: 'Agent: Just confirming Thursday.\nCustomer: Sounds good.' })],
    ])('a call witness %s: the lapse scan lists the call and the re-judge reopens the promise', async (_name, change) => {
      const w = await closedBy('call');
      const other = await world();
      await change(w, other);
      expect(await lapsed()).toContain(w.call.id);
      expect((await cc.refreshFulfillment(db, w.call.id)).reopened).toBe(1);
      expect((await row(w.commitment.id)).status).toBe('open');
    });

    test.each([
      ['its description', (w) => ({ description: `${w.commitment.description} and the second yard` })],
      ['its quotes', () => ({ evidence: JSON.stringify([{ quote: 'I will check on the termite bond and let you know', speaker: 'agent' }]) })],
      ['its due time', () => ({ due_at: new Date(Date.now() + DAY), due_type: 'deadline' })],
    ])('a reprocess that rewrites what was promised (%s) reopens a model-judged close on the next panel open', async (_name, patch) => {
      const w = await closedBy('sms');
      await db('call_commitments').where({ id: w.commitment.id }).update(patch(w));
      expect((await cc.refreshFulfillment(db, w.call.id)).reopened).toBe(1);
      expect((await row(w.commitment.id)).status).toBe('open');
    });

    test('the promise\'s call relinked to another customer reopens it, and the new customer\'s own contact can close it again', async () => {
      const w = await closedBy('sms');
      const other = await world();
      await db('call_log').where({ id: w.call.id }).update({ customer_id: other.customerId });
      expect(await lapsed()).toContain(w.call.id);
      expect((await cc.refreshFulfillment(db, w.call.id)).reopened).toBe(1);
      expect((await row(w.commitment.id)).status).toBe('open');
      // The first customer's text is no witness for the new customer.
      await run();
      expect((await row(w.commitment.id)).status).toBe('open');
    });

    test('a person\'s later touch (Reopen) is final: the check never closes it again', async () => {
      const w = await closedBy('sms');
      await cc.applyHumanUpdate(db, w.commitment.id, { action: 'reopen', reviewedBy: 'tester' });
      const reopened = await row(w.commitment.id);
      expect(reopened).toMatchObject({ status: 'open', human_state: 'confirmed' });
      await run();
      expect((await row(w.commitment.id)).status).toBe('open');
    });

    test('a close another writer stored (a report text) is not taken for a model-judged one by the lapse scan', async () => {
      const w = await world();
      const text = await addSms(w, { metadata: null, message_type: 'service_report', message_body: 'Your service report is ready.' });
      await db('call_commitments').where({ id: w.commitment.id }).update({ status: 'fulfilled', fulfilled_at: later(),
        fulfillment: JSON.stringify(cc.storedProof({ kind: 'sms_sent', record_type: 'sms_log', record_id: text, matched_at: later().toISOString(), strength: 'association', basis: 'service_report_text_to_caller_within_14_days' }, w.customerId)) });
      expect(await lapsed()).not.toContain(w.call.id);
    });
  });

  describe('the SQL twins of the shared predicates agree with them', () => {
    const asSql = async (fragment, columns, values) => (await db.raw(`SELECT (${fragment}) IS TRUE AS ok FROM (SELECT ${columns}) t`, values)).rows[0].ok;

    test('operatorReply + smsDelivered', async () => {
      const cols = "?::text AS status, ?::text AS message_type, ?::text AS from_phone, ?::jsonb AS metadata, ?::uuid AS admin_user_id";
      const cases = [];
      for (const status of ['delivered', 'sent', 'failed', 'queued']) {
        for (const message_type of ['manual', 'ai_approved', 'ai_revised', 'confirmation']) {
          for (const from_phone of [OUR_NUMBER, 'push']) {
            for (const metadata of [{}, { human_authored: true }, { providerAccepted: true }, { human_authored: true, providerAccepted: true }, { channel: 'push', providerAccepted: true }, { human_authored: 'false' }]) {
              for (const admin_user_id of [null, '00000000-0000-4000-8000-000000000009']) cases.push({ status, message_type, from_phone, metadata, admin_user_id });
            }
          }
        }
      }
      for (const c of cases) {
        const js = staff.operatorReply({ ...c, operator_sent: c.metadata.human_authored === true || c.admin_user_id != null })
          && staff.smsDelivered({ status: c.status, from_phone: c.from_phone, provider_accepted: c.metadata.providerAccepted === true, push_channel: c.metadata.channel === 'push' });
        const sql = await asSql(`${staff.operatorReplySql('t')} AND ${staff.smsDeliveredSql('t')}`, cols, [c.status, c.message_type, c.from_phone, JSON.stringify(c.metadata), c.admin_user_id]);
        expect([JSON.stringify(c), sql]).toEqual([JSON.stringify(c), Boolean(js)]);
      }
    });

    test('personCallBack', async () => {
      const cols = '?::text AS source, ?::text AS v2_extraction_status, ?::jsonb AS ai_extraction_enriched, ?::jsonb AS metadata';
      for (const source of ['admin-click', 'admin-callback', 'tech-click', 'collections_voice', null]) {
        for (const status of ['valid', 'failed', null]) {
          for (const voicemail of [false, true, null]) {
            for (const leg of [null, { status: 'completed', duration_seconds: 60 }, { status: 'completed', duration_seconds: '59' }, { status: 'completed', duration_seconds: '75.5' },
              { status: 'completed', duration_seconds: 'abc' }, { status: 'completed' }, { status: 'no-answer', duration_seconds: 90 }]) {
              const enriched = voicemail === null ? {} : { meta: { is_voicemail: voicemail } };
              const record = { source, v2_extraction_status: status, is_voicemail: voicemail === null ? null : String(voicemail),
                customer_leg_status: leg?.status ?? null, customer_leg_seconds: leg?.duration_seconds != null ? String(leg.duration_seconds) : null };
              const sql = await asSql(staff.personCallBackSql('t'), cols, [source, status, JSON.stringify(enriched), JSON.stringify(leg ? { customer_leg: leg } : {})]);
              expect([JSON.stringify(record), sql]).toEqual([JSON.stringify(record), staff.personCallBack(record)]);
            }
          }
        }
      }
    });
  });
});
