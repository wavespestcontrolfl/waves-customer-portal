/**
 * Real-Postgres coverage for the day-only agreement shadow sweep: the candidate
 * SELECTs (sandbox exclusion, windows, day word, quiet thread, judged-once),
 * the visit facts behind the rules, the real time picker's call shape, and the
 * rows the sweep writes. Every test runs in a transaction that is rolled back.
 * The model is stubbed; no text, call or visit is ever created by the code
 * under test. Self-skips without DATABASE_URL (CI and a local migrated
 * database have it). Synthetic data only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The real time picker reads through the models/db singleton: route it to the
// test's own transaction so it sees the fixtures and nothing is committed.
jest.mock('../models/db', () => {
  const current = () => global.__dayAgreementTrx;
  return new Proxy(function db() {}, {
    apply: (_target, _this, args) => current()(...args),
    get: (_target, key) => { const value = current()[key]; return typeof value === 'function' ? value.bind(current()) : value; },
  });
});

const { randomUUID } = require('node:crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

// The exact line the CI `server` job greps to pick DB-gated suites (tests.yml).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres('day-agreement shadow sweep (Postgres)', () => {
  jest.setTimeout(30000);
  const featureGates = require('../config/feature-gates');
  const shadow = require('../services/day-agreement-shadow');
  const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');

  const NOW = new Date('2040-03-12T16:00:00Z'); // Monday 12:00 ET
  const ago = (minutes) => new Date(NOW.getTime() - minutes * 60000);
  const dayPlus = (n) => etDateString(addETDays(NOW, n));
  const PHONE = '+19415550142';
  let database;
  let trx;
  let oldGate;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    oldGate = featureGates.gates.dayAgreementShadow;
  });
  beforeEach(async () => {
    featureGates.gates.dayAgreementShadow = true;
    trx = await database.transaction();
    global.__dayAgreementTrx = trx;
  });
  afterEach(async () => {
    featureGates.gates.dayAgreementShadow = oldGate;
    await trx.rollback();
  });
  afterAll(async () => { await database.destroy(); });

  // ---- fixtures ----------------------------------------------------------------------
  const customer = async (over = {}) => {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Sample', last_name: 'Owner', phone: PHONE, email: `${id}@example.invalid`,
      latitude: 27.4, longitude: -82.45, ...over,
    });
    return id;
  };
  const visit = async (customerId, date, over = {}) => {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, scheduled_date: date, service_type: 'Pest Control', status: 'confirmed',
      window_start: '09:00', window_end: '10:00', created_at: ago(60 * 24 * 5), updated_at: ago(60 * 24 * 5), ...over,
    });
    return id;
  };
  const extraction = (status = 'requested') => ({ scheduling: { status }, meta: {} });
  const call = async (customerId, over = {}) => {
    const id = randomUUID();
    await trx('call_log').insert({
      id, direction: 'inbound', from_phone: PHONE, customer_id: customerId, created_at: ago(90), processed_at: ago(60),
      processing_status: 'processed', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify(extraction()),
      transcription: 'Agent: We can come Wednesday.\nCaller: Wednesday works for me.', ...over,
      ...(over.ai_extraction_enriched !== undefined ? { ai_extraction_enriched: JSON.stringify(over.ai_extraction_enriched) } : {}),
    });
    return id;
  };
  const text = async (customerId, body, minutesAgo, { direction = 'inbound', type = null, to = '+19415550100' } = {}) => {
    const id = randomUUID();
    await trx('sms_log').insert({
      id, customer_id: customerId, direction, from_phone: direction === 'inbound' ? PHONE : to, to_phone: direction === 'inbound' ? to : PHONE,
      message_body: body, created_at: ago(minutesAgo), message_type: type || (direction === 'inbound' ? 'inbound' : 'manual'),
      status: direction === 'inbound' ? 'received' : 'sent',
    });
    return id;
  };
  const agreement = (over = {}) => ({
    at: '2040-03-12T10:30', act: true, kind: 'new_visit', day: dayPlus(2), from_day: null, daypart: 'any', service: 'pest control',
    blockers: [], confidence: 0.9, reason: 'Staff offered the day; the customer agreed.', ...over,
  });
  const answering = (...agreements) => jest.fn(async () => ({ ok: true, json: { agreements }, model: 'stub-model' }));
  const slot = (date, start, techId = null) => ({ date, start_time: start, end_time: start, technician: { id: techId } });
  const technician = async () => {
    const id = randomUUID();
    await trx('technicians').insert({ id, name: 'Sample Tech' });
    return id;
  };
  const sweep = (deps) => shadow.runDayAgreementShadow({ now: NOW, conn: trx, deps });
  const decisions = () => trx('day_agreement_decisions').orderBy('source_key');

  // ---- calls -------------------------------------------------------------------------
  describe('calls', () => {
    test('a day agreed on a call becomes one would_book row with the first slot the picker offered, and the call is judged once', async () => {
      const customerId = await customer();
      const callId = await call(customerId);
      const target = dayPlus(2);
      const dispatch = answering(agreement({ daypart: 'afternoon' }));
      const techB = await technician();
      const findSlots = jest.fn(async () => ({ slots: [slot(target, '09:00'), slot(target, '13:30'), slot(target, '14:00', techB), slot(target, '15:00')] }));
      const first = await sweep({ dispatch, findSlots });
      expect(first).toMatchObject({ judged: 1, would_book: 1, skip: 0, errors: 0 });
      const [row] = await decisions();
      expect(row).toMatchObject({
        source_kind: 'call', source_key: `call:${callId}#0`, call_log_id: callId, customer_id: customerId, verdict: 'would_book',
        skip_reason: null, chosen_window_start: '14:00:00', chosen_technician_id: techB, prompt_version: 'day-agreement-v1', model: 'stub-model', from_visit_id: null,
      });
      expect((await trx.raw('SELECT target_date::text AS d FROM day_agreement_decisions WHERE id = ?', [row.id])).rows[0].d).toBe(target);
      expect(row.agreed_at.toISOString()).toBe(ago(90).toISOString());
      expect(row.judged).toMatchObject({ act: true, kind: 'new_visit', daypart: 'afternoon' });
      // The picker was asked about that one day only, with whole-hour steps and the customer's pin.
      expect(findSlots).toHaveBeenCalledWith(expect.objectContaining({
        dateFrom: target, dateTo: target, slotStepMinutes: 60, everyStepStart: true, lat: 27.4, lng: -82.45, excludeServiceIds: [],
      }));
      // No transcript or message text reaches the table.
      expect(JSON.stringify(row)).not.toMatch(/Wednesday works|Agent:/);
      // A second sweep finds nothing new: judged once.
      const second = await sweep({ dispatch, findSlots });
      expect(second).toMatchObject({ judged: 0 });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    test('the model sees the transcript, today, and the visits on file at the time of the call', async () => {
      const customerId = await customer();
      await visit(customerId, dayPlus(5), { window_start: '10:00' });
      await visit(customerId, dayPlus(6), { created_at: ago(30) }); // booked after the call started: not shown
      await call(customerId);
      const dispatch = answering(agreement({ act: false, kind: null, day: null, blockers: ['no_day_agreed'] }));
      await sweep({ dispatch, findSlots: jest.fn() });
      const prompt = dispatch.mock.calls[0][1].text;
      expect(prompt).toContain('Today is Monday 2040-03-12');
      expect(prompt).toContain('Caller: Wednesday works for me.');
      expect(prompt).toContain(`${dayPlus(5)} 10:00 Pest Control (confirmed)`);
      expect(prompt).not.toContain(dayPlus(6));
      const [row] = await decisions();
      expect(row).toMatchObject({ verdict: 'skip', skip_reason: 'model_no_act' });
    });

    test('which calls are candidates: sandbox, voicemail, spam, old, unprocessed and non-scheduling calls are left alone', async () => {
      const customerId = await customer();
      const wanted = await call(customerId);
      await call(customerId, { source: VOICE_RELAY_SANDBOX_SOURCE });
      await call(customerId, { processing_status: 'voicemail' });
      await call(customerId, { processing_status: 'spam' });
      await call(customerId, { answered_by: 'voicemail' });
      await call(customerId, { ai_extraction_enriched: { scheduling: { status: 'requested' }, meta: { is_voicemail: true } } });
      await call(customerId, { ai_extraction_enriched: { scheduling: { status: 'requested' }, spam_verdict: { spam_kind: 'robocall' } } });
      await call(customerId, { processed_at: ago(200) });
      await call(customerId, { processed_at: null });
      await call(customerId, { v2_extraction_status: 'parse_failed' });
      await call(customerId, { ai_extraction_enriched: { scheduling: { status: 'confirmed' }, meta: {} } });
      await call(customerId, { ai_extraction_enriched: { scheduling: { status: 'none' }, meta: {} } });
      await call(customerId, { transcription: null });
      const found = await shadow._internals.loadCallCandidates(trx, NOW);
      expect(found.map((r) => r.id)).toEqual([wanted]);
    });

    test('all four scheduling statuses are candidates (the fourth stored as a stringified extraction), up to the per-tick batch', async () => {
      const customerId = await customer();
      const ids = [];
      for (const status of ['requested', 'reschedule_requested', 'ambiguous']) {
        ids.push(await call(customerId, { ai_extraction_enriched: { scheduling: { status }, meta: {} } }));
      }
      const stringified = await call(customerId);
      await trx('call_log').where({ id: stringified }).update({ ai_extraction_enriched: trx.raw('to_jsonb(?::text)', [JSON.stringify(extraction('offered'))]) });
      const found = (await shadow._internals.loadCallCandidates(trx, NOW)).map((r) => r.id);
      expect([...found].sort()).toEqual([...ids, stringified].sort());
      // A fifth waits for the next tick.
      await call(customerId);
      expect(await shadow._internals.loadCallCandidates(trx, NOW)).toHaveLength(shadow._internals.BATCH.call);
    });

    test('a call with no linked customer is recorded as a skip without a model call', async () => {
      await call(null);
      const dispatch = jest.fn();
      expect(await sweep({ dispatch })).toMatchObject({ judged: 1, skip: 1 });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'skip', skip_reason: 'no_customer', judged: null, model: null })]);
    });

    test('a move names the one confirmed visit on the old day; two visits on that day make it ambiguous', async () => {
      const customerId = await customer();
      const from = dayPlus(4);
      const target = dayPlus(2);
      const moving = await visit(customerId, from, { estimated_duration_minutes: 90, service_type: 'Lawn Care' });
      await call(customerId);
      const dispatch = answering(agreement({ kind: 'move', from_day: from, daypart: 'morning' }));
      const findSlots = jest.fn(async () => ({ slots: [slot(target, '08:00')] }));
      await sweep({ dispatch, findSlots });
      const [row] = await decisions();
      expect(row).toMatchObject({ verdict: 'would_move', from_visit_id: moving, chosen_window_start: '08:00:00' });
      // The picker works around the visit being moved and keeps its length and service.
      expect(findSlots).toHaveBeenCalledWith(expect.objectContaining({ durationMinutes: 90, serviceType: 'Lawn Care', excludeServiceIds: [moving] }));

      await trx('day_agreement_decisions').delete();
      await visit(customerId, from, { window_start: '13:00' });
      await sweep({ dispatch, findSlots });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'skip', skip_reason: 'move_visit_ambiguous', from_visit_id: null })]);
    });

    test('staff already acted: a visit created on the agreed day after the call skips the moment', async () => {
      const customerId = await customer();
      await call(customerId);
      await visit(customerId, dayPlus(2), { created_at: ago(30), updated_at: ago(30) });
      await sweep({ dispatch: answering(agreement()), findSlots: jest.fn() });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'skip', skip_reason: 'staff_already_acted' })]);
    });

    test('a visit already on the agreed day (booked before the call) skips a new visit', async () => {
      const customerId = await customer();
      await call(customerId);
      await visit(customerId, dayPlus(2));
      await sweep({ dispatch: answering(agreement()), findSlots: jest.fn() });
      expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'day_has_visit' })]);
    });

    test('a same-day agreement is skipped (drop-ins are not bookings)', async () => {
      const customerId = await customer();
      await call(customerId);
      await sweep({ dispatch: answering(agreement({ day: dayPlus(0) })), findSlots: jest.fn() });
      expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'day_not_after_today' })]);
    });

    test('no slot in the daypart is a no_slot skip; a picker that throws is recorded, not retried', async () => {
      const customerId = await customer();
      await call(customerId);
      const target = dayPlus(2);
      await sweep({ dispatch: answering(agreement({ daypart: 'morning' })), findSlots: jest.fn(async () => ({ slots: [slot(target, '14:00')] })) });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'skip', skip_reason: 'no_slot', target_date: expect.anything() })]);

      await trx('day_agreement_decisions').delete();
      await sweep({ dispatch: answering(agreement()), findSlots: jest.fn(async () => { throw new Error('picker down'); }) });
      expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'slot_lookup_failed' })]);
    });

    test('a customer with no coordinates and no visit to read them from is a skip', async () => {
      const customerId = await customer({ latitude: null, longitude: null });
      await call(customerId);
      await sweep({ dispatch: answering(agreement()), findSlots: jest.fn() });
      expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'no_coordinates' })]);
    });

    test('several agreement moments in one call are several rows, #0 first', async () => {
      const customerId = await customer();
      const callId = await call(customerId);
      const findSlots = jest.fn(async () => ({ slots: [slot(dayPlus(3), '10:00')] }));
      await sweep({ dispatch: answering(agreement({ confidence: 0.4 }), agreement({ day: dayPlus(3) })), findSlots });
      expect(findSlots).toHaveBeenCalledTimes(1); // only the moment that passed the rules asks the picker
      expect((await decisions()).map((r) => [r.source_key, r.verdict, r.skip_reason])).toEqual([
        [`call:${callId}#0`, 'skip', 'low_confidence'],
        [`call:${callId}#1`, 'would_book', null],
      ]);
    });

    test('an unusable answer from every model is recorded once; an outage records nothing and stops the tick', async () => {
      const customerId = await customer();
      await call(customerId);
      const unusable = jest.fn(async () => ({ ok: false, reason: 'all_providers_failed', failures: [{ reason: 'schema_invalid', validator: true }] }));
      expect(await sweep({ dispatch: unusable })).toMatchObject({ judged: 1, skip: 1 });
      expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'judge_unusable' })]);
      await sweep({ dispatch: unusable });
      expect(unusable).toHaveBeenCalledTimes(1);

      await trx('day_agreement_decisions').delete();
      await text(customerId, 'Wednesday works', 45);
      const outage = jest.fn(async () => ({ ok: false, reason: 'all_providers_failed', failures: [{ reason: 'anthropic_529' }, { reason: 'openai_529' }] }));
      expect(await sweep({ dispatch: outage })).toMatchObject({ judged: 0, transient: 1 });
      expect(outage).toHaveBeenCalledTimes(1); // the text leg was not tried after the outage
      expect(await decisions()).toEqual([]);
    });

    test('the sweep with the gate off reads and writes nothing', async () => {
      const customerId = await customer();
      await call(customerId);
      featureGates.gates.dayAgreementShadow = false;
      expect(await sweep({ dispatch: jest.fn() })).toEqual({ skipped: 'gate_off' });
      expect(await decisions()).toEqual([]);
    });
  });

  // ---- text threads ------------------------------------------------------------------
  describe('text threads', () => {
    test('a quiet thread whose latest inbound text has a day word is judged with the thread, labelled and stamped in Eastern time', async () => {
      const customerId = await customer();
      await text(customerId, 'We can come Wednesday morning.', 100, { direction: 'outbound', type: 'manual' });
      await text(customerId, 'Your visit is tomorrow at 9.', 99, { direction: 'outbound', type: 'reminder' });
      const latest = await text(customerId, 'Wednesday works', 45);
      const dispatch = answering(agreement({ at: '2040-03-12T10:15', daypart: 'morning' }));
      const target = dayPlus(2);
      const findSlots = jest.fn(async () => ({ slots: [slot(target, '08:00')] }));
      expect(await sweep({ dispatch, findSlots })).toMatchObject({ judged: 1, would_book: 1 });
      const prompt = dispatch.mock.calls[0][1].text;
      expect(prompt).toContain('[Mon 2040-03-12 10:20] WAVES (manual): We can come Wednesday morning.');
      expect(prompt).toContain('WAVES (reminder): Your visit is tomorrow at 9.');
      expect(prompt).toContain('[Mon 2040-03-12 11:15] CUSTOMER: Wednesday works');
      const [row] = await decisions();
      expect(row).toMatchObject({
        source_kind: 'sms', source_key: `sms:9415550142:${latest}#0`, phone_digits: '9415550142', call_log_id: null, verdict: 'would_book',
      });
      // The moment's own time (the customer's reply), not the sweep's.
      expect(row.agreed_at.toISOString()).toBe('2040-03-12T14:15:00.000Z');
      expect(JSON.stringify(row)).not.toMatch(/Wednesday works|come Wednesday/);
    });

    test('which threads are candidates: day word, 3 hour window, 30 quiet minutes either way, latest inbound only', async () => {
      const customerId = await customer();
      const wanted = await text(customerId, 'sat is fine', 45);
      const found = (await shadow._internals.loadSmsCandidates(trx, NOW)).map((r) => r.id);
      expect(found).toEqual([wanted]);

      // Quiet: an outbound text 10 minutes ago, or an inbound one, ends the candidacy.
      const reply = await text(customerId, 'Great, see you then', 10, { direction: 'outbound' });
      expect(await shadow._internals.loadSmsCandidates(trx, NOW)).toEqual([]);
      await trx('sms_log').where({ id: reply }).delete();
      expect(await shadow._internals.loadSmsCandidates(trx, NOW)).toHaveLength(1);

      // The LATEST inbound text must carry the day word: a newer text without one hides the older one.
      await text(customerId, 'thanks!', 35);
      expect(await shadow._internals.loadSmsCandidates(trx, NOW)).toEqual([]);
    });

    test('outside the window or with no day word nothing is a candidate', async () => {
      const customerId = await customer();
      await text(customerId, 'Tuesday works', 200); // older than 3 hours
      await text(await customer({ phone: '+19415550177' }), 'thanks so much', 45);
      expect(await shadow._internals.loadSmsCandidates(trx, NOW)).toEqual([]);
    });

    test('a thread from a number with no customer is a skip without a model call', async () => {
      await text(null, 'Tuesday works', 45);
      const dispatch = jest.fn();
      expect(await sweep({ dispatch })).toMatchObject({ judged: 1, skip: 1 });
      expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'no_customer', judged: null })]);
      expect(dispatch).not.toHaveBeenCalled();
    });

    test('a newer inbound text makes a new source: the thread is judged again under the new key', async () => {
      const customerId = await customer();
      await text(customerId, 'Tuesday works', 100);
      const dispatch = answering(agreement({ act: false, kind: null, day: null, blockers: ['no_day_agreed'] }));
      await sweep({ dispatch });
      await text(customerId, 'actually Thursday', 45);
      await sweep({ dispatch });
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect((await decisions()).map((r) => r.source_key.split(':')[2])).toHaveLength(2);
    });

    test('an agreement older than the 6 hour limit inside a long thread is history, not news', async () => {
      const customerId = await customer();
      await text(customerId, 'Tuesday works', 45);
      await sweep({ dispatch: answering(agreement({ at: '2040-03-11T09:00' })), findSlots: jest.fn() });
      expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'stale_moment' })]);
    });
  });

  // ---- the table ---------------------------------------------------------------------
  describe('day_agreement_decisions', () => {
    const base = (over = {}) => ({ source_kind: 'call', source_key: `call:${randomUUID()}#0`, verdict: 'skip', skip_reason: 'no_slot', ...over });
    const rejected = async (row) => {
      await expect(trx.transaction((sp) => sp('day_agreement_decisions').insert(row))).rejects.toThrow();
    };

    test('a skip needs a reason and a would_* row cannot carry one; verdict and kind are checked', async () => {
      await trx('day_agreement_decisions').insert(base());
      await trx('day_agreement_decisions').insert(base({ verdict: 'would_book', skip_reason: null }));
      await rejected(base({ skip_reason: null }));
      await rejected(base({ verdict: 'would_move' }));
      await rejected(base({ verdict: 'booked', skip_reason: null }));
      await rejected(base({ source_kind: 'email' }));
    });

    test('one row for a source key: a second insert is refused, and the sweep\'s own insert ignores a repeat', async () => {
      const row = base({ source_key: `call:${randomUUID()}#0` });
      await trx('day_agreement_decisions').insert(row);
      await rejected(row);
      await trx('day_agreement_decisions').insert(row).onConflict('source_key').ignore();
      expect(await trx('day_agreement_decisions').where({ source_key: row.source_key })).toHaveLength(1);
    });

    test('deleting the call, the customer or the visit it names keeps the row', async () => {
      const customerId = await customer();
      const callId = await call(customerId);
      const visitId = await visit(customerId, dayPlus(4));
      await trx('day_agreement_decisions').insert(base({ call_log_id: callId, customer_id: customerId, from_visit_id: visitId }));
      await trx('scheduled_services').where({ id: visitId }).delete();
      await trx('call_log').where({ id: callId }).delete();
      const [row] = await decisions();
      expect(row).toMatchObject({ call_log_id: null, from_visit_id: null, customer_id: customerId });
    });
  });

  // ---- the real time picker ----------------------------------------------------------
  describe('the real picker', () => {
    test('findAvailableSlots accepts the sweep\'s call shape and the first whole-hour slot in the daypart is chosen', async () => {
      const technicianId = randomUUID();
      await trx('technicians').insert({ id: technicianId, name: 'Sample Tech', field_dispatchable: true, employment_status: 'active' });
      const customerId = await customer();
      const target = dayPlus(2);
      const picked = await shadow._internals.pickSlot(trx, { customerId, day: target, daypart: 'afternoon', fromVisit: null }, {});
      expect(picked.reason).toBeUndefined();
      expect(picked.slot).toMatchObject({ date: target, technician: { id: technicianId } });
      expect(picked.slot.start_time).toMatch(/^(12|13|14|15|16):00$/);
    });
  });
});
