// Make-up move (GATE_CALL_MAKEUP_MOVE) on a real Postgres (CI's DB-gated step,
// DATABASE_URL): the queries the mocked suite (call-makeup-move.test.js)
// cannot check. The booking transaction's check finds the missed visit, a
// settled no-show or a move after the call changes the answer, the reprocess
// check reads the marker, the move's own guard runs its reads and writes in a
// real transaction, and the detector's indexes cover both call-move actions.
// Fixtures are fictitious (555-01xx numbers, synthetic names and addresses).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({ handleReschedule: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn().mockResolvedValue({}) }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn((name) => name === 'callAgentCommitTrustedLabels' || actual.isEnabled(name)) };
});

const { createHash } = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const OUR_NUMBER = '+15555550100';
const HOUR = 60 * 60 * 1000;

maybeDescribe('make-up move (live Postgres)', () => {
  let db;
  let makeup;
  let seq = 0;
  const made = { customerIds: [], callIds: [], visitIds: [] };

  beforeAll(() => {
    db = require('../models/db');
    makeup = require('../services/call-reschedule-apply');
  });
  afterAll(async () => {
    if (made.callIds.length) {
      await db('activity_log').whereRaw("metadata->>'call_log_id' = ANY(?::text[])", [made.callIds.map(String)]).del();
      await db('triage_items').whereIn('call_log_id', made.callIds).del();
    }
    if (made.visitIds.length) await db('reschedule_log').whereIn('scheduled_service_id', made.visitIds).del();
    if (made.visitIds.length) await db('scheduled_services').whereIn('id', made.visitIds).del();
    if (made.callIds.length) await db('call_log').whereIn('id', made.callIds).del();
    if (made.customerIds.length) await db('customers').whereIn('id', made.customerIds).del();
    await db.destroy();
  });

  // One customer whose quarterly visit four days ago was missed (open
  // customer_noshow row, no field work), one call an hour ago agreeing a slot
  // three days out, and the row the booking transaction would insert.
  async function world({ noshowResolved = false } = {}) {
    seq += 1;
    const n = String(seq).padStart(2, '0');
    const phone = `+1555551${7000 + seq}`;
    const now = new Date();
    const missedDate = etDateString(addETDays(now, -4));
    const slotDate = etDateString(addETDays(now, 3));
    const [customer] = await db('customers').insert({ first_name: `Makeup${n}`, last_name: 'Fixture', phone,
      email: `makeup${n}@example.invalid`, address_line1: `${100 + seq} Example Street`, city: 'Bradenton', state: 'FL', zip: '34205' }).returning('*');
    made.customerIds.push(customer.id);
    const [visit] = await db('scheduled_services').insert({ customer_id: customer.id, scheduled_date: missedDate,
      window_start: '09:00', window_end: '10:00', status: 'confirmed', is_recurring: true, service_type: 'Quarterly Pest Control Service' }).returning('*');
    made.visitIds.push(visit.id);
    await db('reschedule_log').insert({ scheduled_service_id: visit.id, customer_id: customer.id, original_date: missedDate,
      original_window: '09:00:00-10:00:00', reason_code: 'customer_noshow', initiated_by: 'system', created_at: new Date(now.getTime() - 3 * 24 * HOUR),
      ...(noshowResolved ? { resolved_at: now } : {}) });
    const v2 = {
      meta: { is_spam: false, is_voicemail: false },
      caller: { decision_maker_present: true },
      consent: { do_not_contact_request: false },
      confidence: { scheduling_window: 0.95 },
      call_nature: 'existing_customer_scheduling',
      service_request: { primary_service_category: 'pest_general', specific_service_name: null, service_intent: 'follow_up_existing_service', secondary_categories: [] },
      scheduling: { status: 'confirmed', confirmed_start_at: `${slotDate}T17:00:00-04:00`, caller_accepted_slot: true, agent_committed_booking: true },
    };
    const transcription = 'Caller: Nobody came.\nAgent: I will come by at 5 PM.\nCaller: Okay.';
    const [call] = await db('call_log').insert({
      twilio_call_sid: `CA${'7'.repeat(26)}mk${n}`, direction: 'inbound', from_phone: phone, to_phone: OUR_NUMBER, status: 'completed',
      duration_seconds: 120, customer_id: customer.id, created_at: new Date(now.getTime() - HOUR),
      processing_token: `tok-${n}`, processing_generation: 1, v2_extraction_status: 'valid',
      ai_extraction_enriched: JSON.stringify(v2), transcription, metadata: JSON.stringify({ stir_verstat: 'TN-Validation-Passed-A' }),
    }).returning('*');
    made.callIds.push(call.id);
    const booking = { customer_id: customer.id, property_id: null, service_address_line1: customer.address_line1, service_address_line2: null,
      service_address_city: 'Bradenton', service_address_zip: '34205', scheduled_date: slotDate, window_start: '17:00', status: 'confirmed',
      followUpPlanned: false, reService: false, callbackHold: false };
    return { customer, visit, call, booking, missedDate, slotDate, token: `tok-${n}` };
  }

  const plan = (w) => db.transaction((trx) => makeup.planCallMakeupForBooking(trx, { call: w.call, procToken: w.token, procGeneration: 1, booking: w.booking }));

  test('the booking transaction finds the missed visit and writes nothing', async () => {
    const w = await world();
    const before = await db('activity_log').count({ n: '*' }).first();
    expect(await plan(w)).toMatchObject({ action: 'apply', visitId: w.visit.id, newDate: w.slotDate, newWindow: { start: '17:00', end: '18:00' } });
    expect(await db('activity_log').count({ n: '*' }).first()).toEqual(before);
    expect((await db('scheduled_services').where({ id: w.visit.id }).first()).source_call_log_id).toBeNull();
  });

  test('a settled no-show is no evidence: the insert goes ahead', async () => {
    const w = await world({ noshowResolved: true });
    expect(await plan(w)).toMatchObject({ action: 'skip', reason: 'no_missed_visit' });
  });

  test('a staff move of the visit after the call holds, though the visit is now upcoming', async () => {
    const w = await world();
    const later = etDateString(addETDays(new Date(), 5));
    await db('scheduled_services').where({ id: w.visit.id }).update({ scheduled_date: later });
    await db('reschedule_log').insert({ scheduled_service_id: w.visit.id, customer_id: w.customer.id, original_date: w.missedDate,
      new_date: later, reason_code: 'customer_request', initiated_by: 'admin', created_at: new Date() });
    expect(await plan(w)).toMatchObject({ action: 'needs_review', reason: 'handled_after_call', visitId: w.visit.id });
  });

  test('the move\'s own guard runs in a real transaction: it stamps the call and writes the marker; a reprocess then reads it', async () => {
    const w = await world();
    const applyPlan = await plan(w);
    const rebooker = {
      reschedule: jest.fn((id, _date, _win, _reason, _by, opts) => db.transaction(async (trx) => {
        await opts.beforeMove(trx);
        const service = await trx('scheduled_services').where({ id }).forUpdate().first();
        await opts.moveGuard({ trx, service });
        // A real move would re-date the row here; the guard is what this checks.
        await trx('scheduled_services').where({ id }).update({ scheduled_date: w.slotDate, window_start: '17:00', window_end: '18:00' });
        return { success: true };
      })),
    };
    const out = await makeup.applyCallMakeupMove({ conn: db, call: w.call, plan: applyPlan, procToken: w.token, procGeneration: 1, rebooker });
    expect(out).toMatchObject({ outcome: 'applied', visitId: w.visit.id });
    expect((await db('scheduled_services').where({ id: w.visit.id }).first()).source_call_log_id).toBe(w.call.id);
    const marker = await db('activity_log').where({ action: makeup.MAKEUP_ACTIVITY_ACTION }).whereRaw("metadata->>'call_log_id' = ?", [String(w.call.id)]).first();
    const meta = typeof marker.metadata === 'string' ? JSON.parse(marker.metadata) : marker.metadata;
    // The hash is over the row as stored (jsonb keeps its own key order), the same read the reprocess check makes.
    const stored = await db('call_log').where({ id: w.call.id }).first('transcription', 'ai_extraction_enriched');
    expect(meta).toMatchObject({ scheduled_service_id: w.visit.id, to: { date: w.slotDate, start: '17:00', end: '18:00' },
      source_hash: createHash('sha256').update(JSON.stringify([stored.transcription, stored.ai_extraction_enriched])).digest('hex') });

    // A reprocess of the same call: the moved visit IS the booking.
    expect(await makeup.priorCallMakeupDecision(db, { call: w.call, procToken: w.token })).toEqual({ outcome: 'noop', reason: 'already_applied', visitId: w.visit.id });
    // The visit moved again by staff: a person decides.
    await db('scheduled_services').where({ id: w.visit.id }).update({ window_start: '08:00', window_end: '09:00' });
    expect(await makeup.priorCallMakeupDecision(db, { call: w.call, procToken: w.token })).toMatchObject({ outcome: 'needs_review', reason: 'prior_makeup_differs' });
  });

  test('a live visit already on the agreed day, landing after the booking transaction, holds the move', async () => {
    const w = await world();
    const applyPlan = await plan(w);
    const [replacement] = await db('scheduled_services').insert({ customer_id: w.customer.id, scheduled_date: w.slotDate,
      window_start: '13:00', window_end: '14:00', status: 'confirmed', service_type: 'General Pest Control' }).returning('id');
    made.visitIds.push(replacement.id);
    const rebooker = { reschedule: (id, _d, _w, _r, _b, opts) => db.transaction(async (trx) => {
      await opts.beforeMove(trx);
      await opts.moveGuard({ trx, service: await trx('scheduled_services').where({ id }).forUpdate().first() });
    }) };
    expect(await makeup.applyCallMakeupMove({ conn: db, call: w.call, plan: applyPlan, procToken: w.token, procGeneration: 1, rebooker }))
      .toMatchObject({ outcome: 'needs_review', reason: 'existing_appointment_on_target_date' });
    expect(await db('activity_log').where({ action: makeup.MAKEUP_ACTIVITY_ACTION }).whereRaw("metadata->>'call_log_id' = ?", [String(w.call.id)]).first()).toBeUndefined();
  });

  test('the no-show detector\'s promise indexes cover both call-move actions', async () => {
    const rows = await db('pg_indexes').where({ tablename: 'activity_log' })
      .whereIn('indexname', ['activity_log_call_move_visit_idx', 'activity_log_call_move_window_idx', 'activity_log_applied_reschedule_visit_idx', 'activity_log_applied_window_idx'])
      .select('indexname', 'indexdef');
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(Object.keys(byName).sort()).toEqual(['activity_log_call_move_visit_idx', 'activity_log_call_move_window_idx']);
    for (const def of Object.values(byName)) expect(def).toMatch(/call_reschedule_applied[\s\S]*call_makeup_move_applied/);
  });
});
