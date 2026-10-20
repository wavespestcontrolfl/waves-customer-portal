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
    await trx('technicians').insert({ id: SLOT_TECH, name: 'Sample Slot Tech' });
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
  const text = async (customerId, body, minutesAgo, {
    direction = 'inbound', type = null, to = '+19415550100', status = null, phone = PHONE,
  } = {}) => {
    const id = randomUUID();
    await trx('sms_log').insert({
      id, customer_id: customerId, direction, from_phone: direction === 'inbound' ? phone : to, to_phone: direction === 'inbound' ? to : phone,
      message_body: body, created_at: ago(minutesAgo), message_type: type || (direction === 'inbound' ? 'inbound' : 'manual'),
      status: status || (direction === 'inbound' ? 'received' : 'sent'),
    });
    return id;
  };
  const agreement = (over = {}) => ({
    at: '2040-03-12T10:30', act: true, kind: 'new_visit', day: dayPlus(2), from_day: null, daypart: 'any', service: 'Quarterly Pest Control Service',
    blockers: [], confidence: 0.9, reason: 'Staff offered the day; the customer agreed.', ...over,
  });
  const answering = (...agreements) => jest.fn(async () => ({ ok: true, json: { agreements }, model: 'stub-model' }));
  // Every slot find-time returns carries a technician; the collision guard drops a slot without one.
  const SLOT_TECH = randomUUID();
  const slot = (date, start, techId = SLOT_TECH) => ({
    date, start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}${start.slice(2)}`, technician: { id: techId },
  });
  const technician = async () => {
    const id = randomUUID();
    await trx('technicians').insert({ id, name: 'Sample Tech' });
    return id;
  };
  const SERVICE_NAME = 'Quarterly Pest Control Service';
  const catalogService = () => trx('services').where({ service_key: 'pest_general_quarterly' }).first();
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

    test('voicemail and spam calls are filtered in SQL, so they cannot crowd an eligible call out of the scan limit', async () => {
      const customerId = await customer();
      const rows = [];
      for (let i = 0; i < 105; i += 1) {
        rows.push({
          id: randomUUID(), direction: 'inbound', from_phone: PHONE, customer_id: customerId, created_at: ago(120), processed_at: ago(170 - (i % 60)),
          processing_status: 'processed', v2_extraction_status: 'valid', transcription: 'Agent: hi\nCaller: hi',
          answered_by: i % 3 === 0 ? 'voicemail' : null,
          ai_extraction_enriched: JSON.stringify(i % 3 === 0 ? extraction() : i % 3 === 1
            ? { scheduling: { status: 'requested' }, meta: { is_voicemail: true } }
            : { scheduling: { status: 'requested' }, meta: {}, spam_verdict: { spam_kind: 'robocall' } }),
        });
      }
      await trx('call_log').insert(rows);
      const wanted = await call(customerId, { processed_at: ago(5) });
      expect((await shadow._internals.loadCallCandidates(trx, NOW)).map((r) => r.id)).toEqual([wanted]);
      // A spam verdict of not_spam, or an empty one, is still a conversation.
      const notSpam = await call(customerId, { processed_at: ago(4), ai_extraction_enriched: { scheduling: { status: 'requested' }, meta: {}, spam_verdict: { spam_kind: 'not_spam' } } });
      expect((await shadow._internals.loadCallCandidates(trx, NOW)).map((r) => r.id).sort()).toEqual([wanted, notSpam].sort());
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

    test('a call longer than the transcript cap is skipped without a model call, never judged on a cut transcript (pre-push audit P1)', async () => {
      const customerId = await customer();
      await call(customerId, { transcription: `Agent: We can come Wednesday.\nCaller: Wednesday works.\n${'Caller: more talk. '.repeat(2000)}` });
      const dispatch = answering(agreement());
      expect(await sweep({ dispatch, findSlots: jest.fn() })).toMatchObject({ skip: 1 });
      expect(dispatch).not.toHaveBeenCalled();
      expect((await decisions())[0]).toMatchObject({ verdict: 'skip', skip_reason: 'transcript_too_long' });
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
      const moving = await visit(customerId, from, { estimated_duration_minutes: null, window_start: '09:00', window_end: '10:30', service_type: 'Lawn Care' }); // length from the stored window (Codex #6350 r12)
      await call(customerId);
      const dispatch = answering(agreement({ kind: 'move', from_day: from, daypart: 'morning' }));
      const findSlots = jest.fn(async () => ({ slots: [slot(target, '09:00')] }));
      await sweep({ dispatch, findSlots });
      const [row] = await decisions();
      expect(row).toMatchObject({ verdict: 'would_move', from_visit_id: moving, chosen_window_start: '09:00:00' });
      // The picker works around the visit being moved and keeps its length and service.
      expect(findSlots).toHaveBeenCalledWith(expect.objectContaining({ durationMinutes: 90, serviceType: 'Lawn Care', excludeServiceIds: [moving] }));

      await trx('day_agreement_decisions').delete();
      await visit(customerId, from, { window_start: '13:00' });
      await sweep({ dispatch, findSlots });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'skip', skip_reason: 'move_visit_ambiguous', from_visit_id: null })]);
    });

    test('a new visit for a customer with several active properties is property_ambiguous and never placed; one active property, or a move, proceeds', async () => {
      const customerId = await customer();
      const property = (over = {}) => trx('customer_properties').insert({
        id: randomUUID(), customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: false,
        address_line1: '1 Example Lane', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(), ...over,
      });
      await property({ is_primary: true });
      await call(customerId);
      const findSlots = jest.fn(async () => ({ slots: [slot(dayPlus(2), '10:00')] }));
      await sweep({ dispatch: answering(agreement()), findSlots });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'would_book' })]);

      // A second ACTIVE property makes it ambiguous; an inactive one does not.
      await trx('day_agreement_decisions').delete();
      await property({ active: false, address_line1: '2 Example Lane' });
      await sweep({ dispatch: answering(agreement()), findSlots });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'would_book' })]);
      await trx('day_agreement_decisions').delete();
      findSlots.mockClear();
      await property({ address_line1: '3 Example Lane' });
      await sweep({ dispatch: answering(agreement()), findSlots });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'skip', skip_reason: 'property_ambiguous', target_date: expect.anything() })]);
      expect(findSlots).not.toHaveBeenCalled();

      // A move is placed by the moved visit's own pin, so several properties do not block it.
      await trx('day_agreement_decisions').delete();
      await visit(customerId, dayPlus(4), { lat: 27.9, lng: -82.1 });
      await sweep({ dispatch: answering(agreement({ kind: 'move', from_day: dayPlus(4) })), findSlots });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'would_move' })]);
    });

    test('a catalog that cannot be read or is empty leaves the source unjudged and costs no model call; once it is back the source is judged', async () => {
      const customerId = await customer();
      await call(customerId);
      await trx('services').update({ is_active: false });
      const dispatch = answering(agreement());
      expect(await sweep({ dispatch, findSlots: jest.fn() })).toMatchObject({ judged: 0, errors: 1 });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await decisions()).toEqual([]);
      await trx('services').update({ is_active: true });
      expect(await sweep({ dispatch, findSlots: jest.fn(async () => ({ slots: [slot(dayPlus(2), '10:00')] })) })).toMatchObject({ judged: 1, would_book: 1 });
    });

    test('an out-of-range or junk agreement time is at_unreadable, never rolled into another time', async () => {
      const customerId = await customer();
      await text(customerId, 'Tuesday works', 45);
      for (const at of ['2040-03-12T12:60', '2040-03-12T24:00', '2040-03-12T11:00 junk']) {
        await trx('day_agreement_decisions').delete();
        await sweep({ dispatch: answering(agreement({ at })), findSlots: jest.fn() });
        expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'at_unreadable' })]);
      }
    });

    test('Weds works is a candidate text', async () => {
      const customerId = await customer();
      const wanted = await text(customerId, 'Weds works for me', 45);
      expect((await shadow._internals.loadSmsCandidates(trx, NOW)).map((r) => r.id)).toEqual([wanted]);
    });

    test('a move is placed at the moved visit\'s own pin, not the customer\'s', async () => {
      const customerId = await customer({ latitude: 27.4, longitude: -82.45 });
      const from = dayPlus(4);
      await visit(customerId, from, { lat: 27.9, lng: -82.1 });
      await call(customerId);
      const findSlots = jest.fn(async () => ({ slots: [] }));
      await sweep({ dispatch: answering(agreement({ kind: 'move', from_day: from })), findSlots });
      expect(findSlots).toHaveBeenCalledWith(expect.objectContaining({ lat: 27.9, lng: -82.1 }));
      // A visit with no pin falls back to the customer\'s.
      await trx('day_agreement_decisions').delete();
      await trx('scheduled_services').where({ customer_id: customerId }).update({ lat: null, lng: null });
      await sweep({ dispatch: answering(agreement({ kind: 'move', from_day: from })), findSlots });
      expect(findSlots).toHaveBeenLastCalledWith(expect.objectContaining({ lat: 27.4, lng: -82.45 }));
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

    test('no slot in the daypart is a no_slot skip; a picker that throws leaves the source unjudged for the next tick (Codex #6350 r8)', async () => {
      const customerId = await customer();
      await call(customerId);
      const target = dayPlus(2);
      await sweep({ dispatch: answering(agreement({ daypart: 'morning' })), findSlots: jest.fn(async () => ({ slots: [slot(target, '14:00')] })) });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'skip', skip_reason: 'no_slot', target_date: expect.anything() })]);

      await trx('day_agreement_decisions').delete();
      const down = await sweep({ dispatch: answering(agreement()), findSlots: jest.fn(async () => { throw new Error('picker down'); }) });
      expect(down).toMatchObject({ errors: 1 });
      expect(await decisions()).toEqual([]);
      // The picker recovers: the next sweep judges the source.
      await sweep({ dispatch: answering(agreement()), findSlots: jest.fn(async () => ({ slots: [slot(target, '09:00')] })) });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'would_book' })]);
    });

    test('a visit with NO technician that occupies the window blocks that slot (the mirror collision guard), so the next free hour is chosen', async () => {
      const customerId = await customer();
      const other = await customer({ phone: '+19415550188' });
      const target = dayPlus(2);
      const techId = await technician();
      await call(customerId);
      // Another customer's unassigned visit holds 13:00-14:00 that day.
      await visit(other, target, { technician_id: null, window_start: '13:00', window_end: '14:00' });
      const findSlots = jest.fn(async () => ({ slots: [slot(target, '13:00', techId), slot(target, '15:00', techId)] }));
      await sweep({ dispatch: answering(agreement({ daypart: 'afternoon' })), findSlots });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'would_book', chosen_window_start: '15:00:00' })]);
    });

    test('when every offered window is occupied by an unassigned visit the moment is no_slot', async () => {
      const customerId = await customer();
      const other = await customer({ phone: '+19415550188' });
      const target = dayPlus(2);
      await call(customerId);
      await visit(other, target, { technician_id: null, window_start: '09:00', window_end: '10:00' });
      await sweep({ dispatch: answering(agreement({ daypart: 'morning' })), findSlots: jest.fn(async () => ({ slots: [slot(target, '09:00', null)] })) });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'skip', skip_reason: 'no_slot' })]);
    });

    test('the moved visit is not a collision for itself; any other visit in the window still is', async () => {
      const { filterCollidingSlots } = require('../services/estimate-slot-availability');
      const customerId = await customer();
      const target = dayPlus(2);
      const moving = await visit(customerId, target, { technician_id: null, window_start: '13:00', window_end: '14:00' });
      const candidate = { date: target, techId: null, windowStart: '13:00', windowEnd: '14:00' };
      const range = { dateFrom: target, dateTo: target };
      expect(await filterCollidingSlots([candidate], range)).toEqual([]);
      expect(await filterCollidingSlots([candidate], { ...range, excludeServiceIds: [moving] })).toEqual([candidate]);
      await visit(await customer({ phone: '+19415550188' }), target, { technician_id: null, window_start: '13:00', window_end: '14:00' });
      expect(await filterCollidingSlots([candidate], { ...range, excludeServiceIds: [moving] })).toEqual([]);
    });

    test('a text agreement whose time cannot be read is at_unreadable, never judged against the latest inbound time', async () => {
      const customerId = await customer();
      await text(customerId, 'Tuesday works', 45);
      const findSlots = jest.fn();
      await sweep({ dispatch: answering(agreement({ at: 'Monday morning' })), findSlots });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'skip', skip_reason: 'at_unreadable' })]);
      expect(findSlots).not.toHaveBeenCalled();
      // An act:false moment with no readable time is just recorded as the model's no.
      await trx('day_agreement_decisions').delete();
      await sweep({ dispatch: answering(agreement({ at: 'x', act: false, kind: null, day: null, blockers: ['no_day_agreed'] })), findSlots });
      expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'model_no_act' })]);
    });

    test('a call agreement is not affected by the model\'s at: the call start is the moment', async () => {
      const customerId = await customer();
      await call(customerId);
      await sweep({ dispatch: answering(agreement({ at: 'garbage' })), findSlots: jest.fn(async () => ({ slots: [slot(dayPlus(2), '10:00')] })) });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'would_book' })]);
    });

    test('act:true with a blocker is a model_blocker skip and the picker is never asked', async () => {
      const customerId = await customer();
      await call(customerId);
      const findSlots = jest.fn();
      await sweep({ dispatch: answering(agreement({ blockers: ['customer_unsure'] })), findSlots });
      expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'model_blocker' })]);
      expect(findSlots).not.toHaveBeenCalled();
    });

    test('a new visit asks the picker about the ONE catalog service the model named, with its catalog length', async () => {
      const customerId = await customer();
      await call(customerId);
      await trx('services').where({ service_key: 'pest_general_quarterly' }).update({ default_duration_minutes: 75 });
      const findSlots = jest.fn(async () => ({ slots: [slot(dayPlus(2), '10:00')] }));
      const dispatch = answering(agreement({ service: 'Quarterly Pest Control Service' }));
      await sweep({ dispatch, findSlots });
      expect(findSlots).toHaveBeenCalledWith(expect.objectContaining({
        serviceType: SERVICE_NAME, serviceTypes: [SERVICE_NAME], durationMinutes: 75,
      }));
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'would_book' })]);
      // The model is shown the catalog names, and only the non-generic ones.
      const prompt = dispatch.mock.calls[0][1].text;
      expect(prompt).toContain(`- ${SERVICE_NAME}`);
      expect(prompt).not.toContain('Waves Pest Control Appointment Service');
    });

    test('the short name or key also resolves; an unnamed, unknown or generic service is service_unresolved and the picker is never asked', async () => {
      const customerId = await customer();
      const findSlots = jest.fn(async () => ({ slots: [slot(dayPlus(2), '10:00')] }));
      for (const service of ['Pest Quarterly', 'pest_general_quarterly']) {
        await call(customerId);
        await sweep({ dispatch: answering(agreement({ service })), findSlots });
      }
      expect((await decisions()).map((r) => r.verdict)).toEqual(['would_book', 'would_book']);
      await trx('day_agreement_decisions').delete();
      findSlots.mockClear();
      for (const service of [null, 'pest control', 'Waves Pest Control Appointment Service', 'Waves Assessment', 'Pest Control and Lawn Care']) {
        await trx('call_log').delete();
        await call(customerId);
        await trx('day_agreement_decisions').delete();
        await sweep({ dispatch: answering(agreement({ service })), findSlots });
        expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'skip', skip_reason: 'service_unresolved', target_date: expect.anything() })]);
      }
      expect(findSlots).not.toHaveBeenCalled();
    });

    test('a move keeps its own visit\'s service: an unnamed judged service does not block it', async () => {
      const customerId = await customer();
      const from = dayPlus(4);
      await visit(customerId, from, { service_type: 'Lawn Care' });
      await call(customerId);
      const findSlots = jest.fn(async () => ({ slots: [slot(dayPlus(2), '10:00')] }));
      await sweep({ dispatch: answering(agreement({ kind: 'move', from_day: from, service: null })), findSlots });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'would_move' })]);
      expect(findSlots).toHaveBeenCalledWith(expect.objectContaining({ serviceType: 'Lawn Care', serviceTypes: ['Lawn Care'] }));
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
      const dispatch = answering(agreement({ at: '2040-03-12T11:15', daypart: 'morning' }));
      const target = dayPlus(2);
      const findSlots = jest.fn(async () => ({ slots: [slot(target, '09:00')] }));
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
      expect(row.agreed_at.toISOString()).toBe('2040-03-12T15:15:00.000Z');
      expect(JSON.stringify(row)).not.toMatch(/Wednesday works|come Wednesday/);
    });

    test('a Waves text that never went out (scheduled, failed) is not shown to the judge (pre-push audit P1)', async () => {
      const customerId = await customer();
      await text(customerId, 'We can come Thursday instead.', 100, { direction: 'outbound', status: 'scheduled' });
      await text(customerId, 'Sorry, Thursday is full.', 99, { direction: 'outbound', status: 'failed' });
      await text(customerId, 'We can come Wednesday morning.', 98, { direction: 'outbound' });
      await text(customerId, 'Wednesday works', 45);
      const dispatch = answering(agreement({ daypart: 'morning' }));
      await sweep({ dispatch, findSlots: jest.fn(async () => ({ slots: [slot(dayPlus(2), '09:00')] })) });
      const prompt = dispatch.mock.calls[0][1].text;
      expect(prompt).toContain('We can come Wednesday morning.');
      expect(prompt).not.toMatch(/Thursday/);
    });

    test('a thread with a text longer than the cap is skipped without a model call (pre-push audit P1)', async () => {
      const customerId = await customer();
      await text(customerId, `We can come Wednesday. ${'More details here. '.repeat(150)}`, 98, { direction: 'outbound' });
      await text(customerId, 'Wednesday works', 45);
      const dispatch = answering(agreement());
      await sweep({ dispatch, findSlots: jest.fn() });
      expect(dispatch).not.toHaveBeenCalled();
      expect((await decisions())[0]).toMatchObject({ verdict: 'skip', skip_reason: 'message_too_long' });
    });

    test('a customer gets at most four model judgments a day across calls and texts; the next is a rate-limit skip without a model call (Codex security review)', async () => {
      const customerId = await customer();
      for (let i = 0; i < 4; i += 1) {
        await trx('day_agreement_decisions').insert({
          source_kind: 'sms', source_key: `sms:9415550142:${randomUUID()}#0`, phone_digits: '9415550142', customer_id: customerId,
          verdict: 'skip', skip_reason: 'model_no_act', model: 'stub-model', created_at: ago(60 * (i + 1)),
        });
      }
      await text(customerId, 'Wednesday works', 45);
      const dispatch = answering(agreement());
      await sweep({ dispatch, findSlots: jest.fn() });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await trx('day_agreement_decisions').where({ skip_reason: 'judge_rate_limited' })).toHaveLength(1);
      // A call from the same customer is rate-limited too.
      await call(customerId);
      await sweep({ dispatch, findSlots: jest.fn() });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await trx('day_agreement_decisions').where({ skip_reason: 'judge_rate_limited' })).toHaveLength(2);
    });

    test('pre-model skips (no customer, too long) never count toward the quota (Codex #6350 r8)', async () => {
      const customerId = await customer();
      for (let i = 0; i < 4; i += 1) {
        await trx('day_agreement_decisions').insert({
          source_kind: 'sms', source_key: `sms:9415550142:${randomUUID()}#0`, phone_digits: '9415550142', customer_id: customerId,
          verdict: 'skip', skip_reason: 'message_too_long', created_at: ago(60 * (i + 1)),
        });
      }
      await text(customerId, 'Wednesday works', 45);
      const dispatch = answering(agreement());
      await sweep({ dispatch, findSlots: jest.fn(async () => ({ slots: [slot(dayPlus(2), '09:00')] })) });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    test('the thread is read for this phone only, so another number on the customer never crowds it out (Codex #6350 r8)', async () => {
      const customerId = await customer();
      await text(customerId, 'We can come Wednesday morning.', 300, { direction: 'outbound' });
      for (let i = 0; i < 120; i += 1) await text(customerId, `other number ${i}`, 200 - i, { direction: 'outbound', to: '+19415550100' , status: 'sent' }).then((id) => trx('sms_log').where({ id }).update({ to_phone: '+19415559999' }));
      await text(customerId, 'Wednesday works', 45);
      const dispatch = answering(agreement({ daypart: 'morning' }));
      await sweep({ dispatch, findSlots: jest.fn(async () => ({ slots: [slot(dayPlus(2), '09:00')] })) });
      const prompt = dispatch.mock.calls[0][1].text;
      expect(prompt).toContain('We can come Wednesday morning.');
      expect(prompt).not.toContain('other number');
    });

    test('an agreement followed by a quick "thanks" is still judged: no earlier sweep saw it (pre-push audit)', async () => {
      const customerId = await customer();
      await text(customerId, 'We can come Wednesday morning.', 100, { direction: 'outbound' });
      await text(customerId, 'Wednesday works', 47);
      await text(customerId, 'thanks!', 45);
      const dispatch = answering(agreement({ at: '2040-03-12T11:13', daypart: 'morning' }));
      await sweep({ dispatch, findSlots: jest.fn(async () => ({ slots: [slot(dayPlus(2), '09:00', await technician())] })) });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'would_book' })]);
    });

    test('a repeated agreement is recorded once, and a moment an earlier sweep of the phone already judged is an earlier_moment skip (Codex #6350 r11)', async () => {
      const customerId = await customer();
      await text(customerId, 'Thursday?', 150);
      await text(customerId, 'We can come Wednesday morning.', 100, { direction: 'outbound' });
      await text(customerId, 'Wednesday works', 45);
      // An earlier sweep (10:00 ET) already judged this phone's thread, so the 09:30 moment was seen.
      const judgedInbound = await text(customerId, 'ok', 120); // the 10:00 ET text an earlier sweep judged
      await trx('day_agreement_decisions').insert({
        source_kind: 'sms', source_key: `sms:9415550142:${judgedInbound}#0`, phone_digits: '9415550142', customer_id: customerId,
        verdict: 'skip', skip_reason: 'model_no_act', model: 'stub-model',
      });
      const same = agreement({ at: '2040-03-12T11:15', daypart: 'morning' });
      const early = agreement({ at: '2040-03-12T09:30' });
      const dispatch = answering(same, same, early);
      await sweep({ dispatch, findSlots: jest.fn(async () => ({ slots: [slot(dayPlus(2), '09:00', await technician())] })) });
      const rows = await decisions();
      expect(rows).toHaveLength(3); // the seeded earlier judgment + this source's two distinct moments
      expect(rows.map((r) => r.skip_reason)).toContain('earlier_moment');
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

    test('the quiet probe ignores Waves texts that never went out (scheduled, failed, cancelled, reserved) but counts delivered ones', async () => {
      const customerId = await customer();
      const wanted = await text(customerId, 'sat is fine', 45);
      const unsent = async (status, extra = {}) => {
        const id = await text(customerId, 'Great, see you then', 10, { direction: 'outbound' });
        await trx('sms_log').where({ id }).update({ status, ...extra });
        return id;
      };
      for (const status of ['scheduled', 'failed', 'queued', 'undelivered']) {
        const id = await unsent(status);
        expect((await shadow._internals.loadSmsCandidates(trx, NOW)).map((r) => r.id)).toEqual([wanted]);
        await trx('sms_log').where({ id }).delete();
      }
      const cancelled = await unsent('canceled');
      expect((await shadow._internals.loadSmsCandidates(trx, NOW)).map((r) => r.id)).toEqual([wanted]);
      await trx('sms_log').where({ id: cancelled }).delete();
      const reserved = await unsent('sending', { metadata: JSON.stringify({ review_ask_reservation: true }) });
      expect((await shadow._internals.loadSmsCandidates(trx, NOW)).map((r) => r.id)).toEqual([wanted]);
      await trx('sms_log').where({ id: reserved }).delete();
      // A delivered Waves text 10 minutes ago does end the quiet period.
      await unsent('delivered');
      expect(await shadow._internals.loadSmsCandidates(trx, NOW)).toEqual([]);
    });

    test('push-only deliveries are no activity and no thread context (from_phone push, or metadata channel push)', async () => {
      const customerId = await customer();
      const wanted = await text(customerId, 'sat is fine', 45);
      const push = await text(customerId, 'PUSHBODY app notice', 10, { direction: 'outbound' });
      await trx('sms_log').where({ id: push }).update({ from_phone: 'push', status: 'sent' });
      const channel = await text(customerId, 'CHANNELBODY app notice', 9, { direction: 'outbound' });
      await trx('sms_log').where({ id: channel }).update({ status: 'sent', metadata: JSON.stringify({ channel: 'push' }) });
      expect((await shadow._internals.loadSmsCandidates(trx, NOW)).map((r) => r.id)).toEqual([wanted]);
      const dispatch = answering(agreement({ act: false, kind: null, day: null, blockers: ['no_day_agreed'] }));
      await sweep({ dispatch });
      const prompt = dispatch.mock.calls[0][1].text;
      expect(prompt).toContain('sat is fine');
      expect(prompt).not.toMatch(/PUSHBODY|CHANNELBODY/);
    });

    test('recruiting applicants\' texts (job_* types) are never candidates, never a quiet-breaking message, never thread context', async () => {
      const customerId = await customer();
      // An applicant\'s inbound text with a day word is not a candidate.
      await text(customerId, 'I can start Monday', 45, { type: 'job_application' });
      expect(await shadow._internals.loadSmsCandidates(trx, NOW)).toEqual([]);
      // A real customer thread: a recruiting reply 10 minutes ago neither ends the quiet period nor reaches the model.
      const wanted = await text(customerId, 'sat is fine', 50);
      await text(customerId, 'RECRUITBODY interview Tuesday', 10, { direction: 'outbound', type: 'job_interview' });
      expect((await shadow._internals.loadSmsCandidates(trx, NOW)).map((r) => r.id)).toEqual([wanted]);
      const dispatch = answering(agreement({ act: false, kind: null, day: null, blockers: ['no_day_agreed'] }));
      await sweep({ dispatch });
      expect(dispatch.mock.calls[0][1].text).not.toMatch(/RECRUITBODY|start Monday/);
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
      await text(customerId, 'Tuesday works', 480);
      await text(customerId, 'Tuesday works', 45);
      // 480 minutes before NOW (12:00 ET) is 04:00 ET: a message the model was shown, but too old to act on.
      await sweep({ dispatch: answering(agreement({ at: '2040-03-12T04:00' })), findSlots: jest.fn() });
      expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'stale_moment' })]);
    });

    test('an SMS action whose time is not the minute of a message in the thread is at_ungrounded and the picker is never asked', async () => {
      const customerId = await customer();
      await text(customerId, 'Tuesday works', 45); // 11:15 ET
      const findSlots = jest.fn();
      for (const at of ['2040-03-12T11:30', '2040-03-12T10:30', '2040-03-11T11:15']) {
        await trx('day_agreement_decisions').delete();
        await sweep({ dispatch: answering(agreement({ at })), findSlots });
        expect(await decisions()).toEqual([expect.objectContaining({ skip_reason: 'at_ungrounded', target_date: expect.anything() })]);
      }
      expect(findSlots).not.toHaveBeenCalled();
      // The same time as a message minute is grounded and goes on to the picker.
      await trx('day_agreement_decisions').delete();
      await sweep({ dispatch: answering(agreement({ at: '2040-03-12T11:15' })), findSlots: jest.fn(async () => ({ slots: [slot(dayPlus(2), '10:00')] })) });
      expect(await decisions()).toEqual([expect.objectContaining({ verdict: 'would_book' })]);
    });

    test('a day-less "yes that works" is a candidate when a delivered Waves text with a day word was sent to the phone in the 3 hours before it', async () => {
      const customerId = await customer();
      const yes = await text(customerId, 'Yes that works', 45);
      expect(await shadow._internals.loadSmsCandidates(trx, NOW)).toEqual([]);
      const offer = (body, minutesAgo, opts = {}) => text(customerId, body, minutesAgo, { direction: 'outbound', ...opts });
      // Not an offer: undelivered, push-only, recruiting, no day word, or sent more than 3 hours before the reply.
      const notOffers = [
        await offer('We can come Wednesday', 100, { status: 'scheduled' }),
        await offer('We can come Wednesday', 100, { status: 'failed' }),
        await offer('We can come Wednesday', 100, { type: 'job_interview' }),
        await offer('Does a morning visit suit you', 100),
        await offer('We can come Wednesday', 45 + 181),
      ];
      const push = await offer('We can come Wednesday', 100);
      await trx('sms_log').where({ id: push }).update({ from_phone: 'push' });
      expect(await shadow._internals.loadSmsCandidates(trx, NOW)).toEqual([]);
      await trx('sms_log').whereIn('id', [...notOffers, push]).delete();
      // A delivered Waves text with a day word inside the 3 hours before the reply is the offer.
      await offer('We can come Wednesday morning', 100);
      expect((await shadow._internals.loadSmsCandidates(trx, NOW)).map((r) => r.id)).toEqual([yes]);
      // The quiet period still applies: a delivered Waves text 10 minutes ago ends it.
      await offer('Great, see you then', 10);
      expect(await shadow._internals.loadSmsCandidates(trx, NOW)).toEqual([]);
    });

    test('the offer admits the thread to the model, which sees the offer and the reply', async () => {
      const customerId = await customer();
      await text(customerId, 'We can come Wednesday morning', 100, { direction: 'outbound' });
      await text(customerId, 'Yes that works', 45);
      const dispatch = answering(agreement({ act: false, kind: null, day: null, blockers: ['no_day_agreed'] }));
      await sweep({ dispatch });
      expect(dispatch.mock.calls[0][1].text).toMatch(/WAVES \(manual\): We can come Wednesday morning[\s\S]*CUSTOMER: Yes that works/);
    });

    test('a candidate that is no longer the latest inbound text, or no longer quiet, is left unjudged: no row, no model call', async () => {
      const customerId = await customer();
      const other = await customer({ phone: '+19415550177' });
      const PHONE2 = '+19415550177';
      await text(customerId, 'Tuesday works', 60);
      await text(other, 'Thursday works', 50, { phone: PHONE2 });
      // While the first source is being judged, the second phone writes again.
      const dispatch = jest.fn(async () => {
        await text(other, 'actually Friday', 1, { phone: PHONE2 });
        return { ok: true, json: { agreements: [agreement({ act: false, kind: null, day: null, blockers: ['no_day_agreed'] })] }, model: 'm' };
      });
      const tally = await sweep({ dispatch });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(tally).toMatchObject({ judged: 1, left: 1 });
      expect((await decisions()).map((r) => r.customer_id)).toEqual([customerId]);
    });

    test('smsStillCandidate: latest inbound and quiet is true; a newer inbound or a delivered Waves text since is false', async () => {
      const customerId = await customer();
      const id = await text(customerId, 'Tuesday works', 60);
      const src = { key: `sms:9415550142:${id}`, phoneDigits: '9415550142' };
      expect(await shadow._internals.smsStillCandidate(trx, src, NOW)).toBe(true);
      const reply = await text(customerId, 'On our way', 5, { direction: 'outbound' });
      expect(await shadow._internals.smsStillCandidate(trx, src, NOW)).toBe(false);
      await trx('sms_log').where({ id: reply }).delete();
      expect(await shadow._internals.smsStillCandidate(trx, src, NOW)).toBe(true);
      await text(customerId, 'thanks', 40);
      expect(await shadow._internals.smsStillCandidate(trx, src, NOW)).toBe(false);
    });

    test('a visit changed after the agreement is left out of what the model sees, with a count; one untouched since is shown', async () => {
      const customerId = await customer();
      await visit(customerId, dayPlus(5), { window_start: '10:00' });
      await visit(customerId, dayPlus(6), { window_start: '11:00', updated_at: ago(30) });
      await call(customerId);
      const dispatch = answering(agreement({ act: false, kind: null, day: null, blockers: ['no_day_agreed'] }));
      await sweep({ dispatch });
      const prompt = dispatch.mock.calls[0][1].text;
      expect(prompt).toContain(`${dayPlus(5)} 10:00 Pest Control (confirmed)`);
      expect(prompt).not.toContain(dayPlus(6));
      expect(prompt).toContain('1 visit(s) changed after this moment are not shown.');
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
      const picked = await shadow._internals.pickSlot(trx, { customerId, day: target, daypart: 'afternoon', fromVisit: null, service: await catalogService() }, {});
      expect(picked.reason).toBeUndefined();
      expect(picked.slot).toMatchObject({ date: target, technician: { id: technicianId } });
      expect(picked.slot.start_time).toMatch(/^(12|13|14|15|16):00$/);
    });

    test('under capacity routing a technician switched off for the service is never offered; with every technician off it is no_slot', async () => {
      const OLD = process.env.GATE_SCHEDULING_CAPACITY;
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      try {
        const off = randomUUID();
        const on = randomUUID();
        await trx('technicians').insert([
          { id: off, name: 'Sample Off', field_dispatchable: true, employment_status: 'active' },
          { id: on, name: 'Sample On', field_dispatchable: true, employment_status: 'active' },
        ]);
        await trx('technician_capabilities').insert({ technician_id: off, service_category: 'general', active: false });
        const customerId = await customer();
        const target = dayPlus(2);
        const args = { customerId, day: target, daypart: 'any', fromVisit: null, service: await catalogService() };
        const picked = await shadow._internals.pickSlot(trx, args, {});
        expect(picked.slot.technician.id).toBe(on);
        await trx('technician_capabilities').insert({ technician_id: on, service_category: 'general', active: false });
        expect(await shadow._internals.pickSlot(trx, args, {})).toEqual({ reason: 'no_slot' });
        // The same two technicians are both offered for work in a category neither is switched off for.
        const lawn = await shadow._internals.pickSlot(trx, { ...args, service: { name: 'Monthly Lawn Care Service', default_duration_minutes: 60 } }, {});
        expect(lawn.slot).toBeDefined();
      } finally {
        if (OLD === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = OLD;
      }
    });

    test('outside capacity routing the collision guard drops a technician switched off for the service', async () => {
      const { filterCollidingSlots } = require('../services/estimate-slot-availability');
      const off = randomUUID();
      await trx('technicians').insert({ id: off, name: 'Sample Off' });
      await trx('technician_capabilities').insert({ technician_id: off, service_category: 'general', active: false });
      const target = dayPlus(2);
      const candidate = (techId) => ({ date: target, techId, windowStart: '10:00', windowEnd: '11:00' });
      const range = { dateFrom: target, dateTo: target, serviceMix: { services: [SERVICE_NAME] } };
      expect(await filterCollidingSlots([candidate(off), candidate(SLOT_TECH)], range)).toEqual([candidate(SLOT_TECH)]);
    });

    test('outside capacity routing a 17:00 start is possible: the customer day end (18:00) reaches find-time', async () => {
      const technicianId = randomUUID();
      await trx('technicians').insert({ id: technicianId, name: 'Sample Tech', field_dispatchable: true, employment_status: 'active' });
      // At the depot, so the drive back to the day's end costs nothing and the last start is the day-end limit.
      const { HQ } = require('../services/auto-dispatch/geo');
      const customerId = await customer({ latitude: HQ.lat, longitude: HQ.lng });
      const picked = await shadow._internals.pickSlot(trx, { customerId, day: dayPlus(2), daypart: 'after 17:00', fromVisit: null, service: await catalogService() }, {});
      expect(picked.slot).toMatchObject({ start_time: '17:00', technician: { id: technicianId } });
    });

    test('under capacity routing the picker still hands back only customer-grid starts: no 08:00, no lunch-overlapping start', async () => {
      const OLD = process.env.GATE_SCHEDULING_CAPACITY;
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      try {
        await trx('technicians').insert({ id: randomUUID(), name: 'Sample Tech', field_dispatchable: true, employment_status: 'active' });
        const customerId = await customer();
        const target = dayPlus(2);
        const first = await shadow._internals.pickSlot(trx, { customerId, day: target, daypart: 'morning', fromVisit: null, service: await catalogService() }, {});
        expect(first.slot).toBeDefined();
        expect(first.slot.start_time).not.toBe('08:00');
        const everyStart = await shadow._internals.pickSlot(trx, { customerId, day: target, daypart: 'before 09:00', fromVisit: null, service: await catalogService() }, {});
        expect(everyStart).toEqual({ reason: 'no_slot' });
      } finally {
        if (OLD === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = OLD;
      }
    });
  });
});
