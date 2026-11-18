/**
 * findFoldTarget (services/reservice-fold.js, GATE_RESERVICE_FOLD, owner 2026-11-17) on a real migrated PostgreSQL: which
 * plan visit a re-service on a date folds into. Every case runs in a transaction that is rolled back; synthetic records only.
 * The second suite moves a plan visit for the customer's own link pick (GATE_RESERVICE_FOLD_LINK) through the real rebooker and
 * the reschedule page's own loaders; it commits, so it removes everything it made.
 * Dates are fixed, never the clock: the re-service is on 2099-03-02 and a plan visit N days later is on 2099-03-(2+N).
 */
jest.setTimeout(60000);

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

const RESERVICE_DAY = '2099-03-02';
const later = (days) => {
  const d = new Date(Date.UTC(2099, 2, 2 + days, 12));
  return d.toISOString().slice(0, 10);
};

describeOrSkip('findFoldTarget', () => {
  let db; let findFoldTarget; let trx; let customerId; let primaryId; let rentalId; let pestServiceId; let lawnServiceId;

  beforeAll(async () => {
    db = require('../models/db');
    ({ findFoldTarget } = require('../services/reservice-fold'));
    pestServiceId = (await db('services').where({ name: 'Quarterly Pest Control Service' }).first('id')).id;
    lawnServiceId = (await db('services').where({ service_key: 'lawn_fertilization' }).first('id')).id;
  });

  beforeEach(async () => {
    trx = await db.transaction();
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'FoldTest', phone: `+1555${customerId.slice(0, 7)}`, active: true });
    [{ id: primaryId }] = await trx('customer_properties').insert({ customer_id: customerId, is_primary: true, active: true, address_line1: '1 Fold Primary Way', city: 'Bradenton', zip: '34201' }).returning('id');
    [{ id: rentalId }] = await trx('customer_properties').insert({ customer_id: customerId, is_primary: false, active: true, address_line1: '2 Fold Rental Way', city: 'Bradenton', zip: '34201' }).returning('id');
  });
  afterEach(async () => { await trx.rollback(); });

  async function plan(day, extra = {}) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, scheduled_date: later(day), status: 'pending', is_recurring: true, recurring_pattern: 'quarterly',
      service_type: 'Quarterly Pest Control Service', service_id: pestServiceId, window_start: '09:00', window_end: '10:00', ...extra,
    });
    return id;
  }
  const find = (extra = {}) => findFoldTarget(trx, { customerId, lane: 'pest', date: RESERVICE_DAY, propertyId: null, ...extra });

  test('a plan visit 5 days later folds; the answer carries what the move and the notice need', async () => {
    const id = await plan(5, { technician_id: null, customer_request: 'x', notes: 'Dog in yard' });
    expect(await find()).toEqual({
      id, customer_id: customerId, property_id: null, service_id: pestServiceId, is_callback: false,
      scheduled_date: later(5), window_start: '09:00:00', window_end: '10:00:00', service_type: 'Quarterly Pest Control Service',
      technician_id: null, status: 'pending', customer_request: 'x', notes: 'Dog in yard',
    });
  });

  test('the window is inclusive: 14 days later folds, 15 days later does not', async () => {
    const id = await plan(14);
    expect((await find()).id).toBe(id);
    await trx('scheduled_services').where({ id }).update({ scheduled_date: later(15) });
    expect(await find()).toBeNull();
  });

  test('a plan visit on the same day folds; one the day before does not', async () => {
    const id = await plan(0);
    expect((await find()).id).toBe(id);
    await trx('scheduled_services').where({ id }).update({ scheduled_date: later(-1) });
    expect(await find()).toBeNull();
  });

  test('the earliest plan visit in range wins, then the earliest start', async () => {
    await plan(9);
    const early = await plan(6, { window_start: '13:00', window_end: '14:00' });
    const earlier = await plan(6, { window_start: '08:00', window_end: '09:00' });
    expect((await find()).id).toBe(earlier);
    await trx('scheduled_services').where({ id: earlier }).update({ status: 'cancelled' });
    expect((await find()).id).toBe(early);
  });

  test('the other line does not match: a lawn plan visit is not a pest fold, and the lawn lane finds it', async () => {
    const id = await plan(5, { service_type: 'Lawn Fertilization & Weed Control Service', service_id: lawnServiceId });
    expect(await find()).toBeNull();
    expect((await find({ lane: 'lawn' })).id).toBe(id);
  });

  test('a cancelled, completed, skipped or no-show visit does not fold', async () => {
    for (const status of ['cancelled', 'completed', 'skipped', 'no_show', 'en_route']) {
      const id = await plan(5, { status });
      expect(await find()).toBeNull();
      await trx('scheduled_services').where({ id }).del();
    }
    const confirmed = await plan(5, { status: 'confirmed' });
    expect((await find()).id).toBe(confirmed);
  });

  test('a one-time visit, a callback and a visit mid Quick Move hand-off do not fold', async () => {
    await plan(5, { is_recurring: false });
    await plan(6, { is_callback: true });
    await plan(7, { customer_pick_by: new Date('2099-03-01T12:00:00Z') });
    expect(await find()).toBeNull();
  });

  test('another customer\'s plan visit does not fold', async () => {
    const other = randomUUID();
    await trx('customers').insert({ id: other, first_name: 'Synthetic', last_name: 'FoldOther', phone: `+1555${other.slice(0, 7)}`, active: true });
    await plan(5, { customer_id: other });
    expect(await find()).toBeNull();
  });

  test('a visit on a shared stop does not fold, even when its partner is finished; the answer carries the status the move pins', async () => {
    const [{ id: visitId }] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: later(5), stop_base_key: `fold-${randomUUID()}`, created_by: 'test' }).returning('id');
    const id = await plan(5, { visit_id: visitId });
    const partner = await plan(5, { visit_id: visitId, service_type: 'Lawn Fertilization & Weed Control Service', service_id: lawnServiceId });
    expect(await find()).toBeNull();
    await trx('scheduled_services').where({ id: partner }).update({ status: 'completed' });
    expect(await find()).toBeNull();
    await trx('scheduled_services').where({ id }).update({ visit_id: null, status: 'confirmed' });
    expect(await find()).toMatchObject({ id, status: 'confirmed' });
  });

  test('a call booking the office has not reviewed does not fold; once reviewed or confirmed by the customer, it does', async () => {
    const id = await plan(5, { source_action: 'ai_call_pipeline_followup' });
    expect(await find()).toBeNull();
    await trx('scheduled_services').where({ id }).update({ customer_confirmed: true });
    expect((await find()).id).toBe(id);
    // A voice-agent booking a move left 'confirmed' but never reviewed is still hidden from the customer.
    await trx('scheduled_services').where({ id }).update({ source_action: 'voice_agent', status: 'confirmed', customer_confirmed: false });
    expect(await find()).toBeNull();
    // The office's confirm of an outbound-review booking: a plain confirmed visit.
    await trx('scheduled_services').where({ id }).update({ source_action: 'ai_call_outbound_review', status: 'confirmed' });
    expect((await find()).id).toBe(id);
  });

  describe('premise', () => {
    test('a re-service on the primary premise matches a plan visit with no property and one on the primary property', async () => {
      const unlinked = await plan(8, { property_id: null });
      expect((await find({ propertyId: null })).id).toBe(unlinked);
      await trx('scheduled_services').where({ id: unlinked }).update({ property_id: primaryId });
      expect((await find({ propertyId: null })).id).toBe(unlinked);
      expect((await find({ propertyId: primaryId })).id).toBe(unlinked);
    });

    test('a re-service on the primary premise does not match a plan visit at another property', async () => {
      await plan(8, { property_id: rentalId });
      expect(await find({ propertyId: null })).toBeNull();
      expect(await find({ propertyId: primaryId })).toBeNull();
    });

    test('a re-service at a non-primary property matches only plan visits on exactly that property', async () => {
      await plan(5, { property_id: null });
      await plan(6, { property_id: primaryId });
      expect(await find({ propertyId: rentalId })).toBeNull();
      const rental = await plan(9, { property_id: rentalId });
      expect((await find({ propertyId: rentalId })).id).toBe(rental);
    });
  });

  test('a missing customer, lane or a malformed date finds nothing', async () => {
    await plan(5);
    expect(await find({ customerId: null })).toBeNull();
    expect(await find({ lane: null })).toBeNull();
    expect(await find({ date: 'soon' })).toBeNull();
  });
});

// ── The customer's own pick on the /reservice link (GATE_RESERVICE_FOLD_LINK) ─────────────────────────────────────────────
describeOrSkip('the customer link fold on real rows', () => {
  let db; let fold; let pestServiceId; let customerId; const made = [];
  const SLOT = { start_time: '11:00', end_time: '12:00', technician_id: null };

  beforeAll(async () => {
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    db = require('../models/db');
    fold = require('../services/reservice-fold');
    pestServiceId = (await db('services').where({ name: 'Quarterly Pest Control Service' }).first('id')).id;
  });
  afterAll(async () => {
    delete process.env.GATE_ADMIN_COLLECTIVE_MOVE;
    await db.destroy();
  });

  beforeEach(async () => {
    customerId = randomUUID();
    await db('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'FoldLink', phone: `+1555${customerId.slice(0, 7)}`, active: true });
  });
  afterEach(async () => {
    await db('reschedule_log').where({ customer_id: customerId }).del();
    await db('appointment_reminders').whereIn('scheduled_service_id', made).del();
    await db('scheduled_services').where({ customer_id: customerId }).del();
    await db('customers').where({ id: customerId }).del();
    made.length = 0;
  });

  async function planVisit(date, extra = {}) {
    const id = randomUUID();
    made.push(id);
    await db('scheduled_services').insert({
      id, customer_id: customerId, scheduled_date: date, status: 'pending', is_recurring: true, recurring_pattern: 'quarterly',
      service_type: 'Quarterly Pest Control Service', service_id: pestServiceId, window_start: '13:00', window_end: '14:00',
      estimated_duration_minutes: 60, ...extra,
    });
    return id;
  }
  const lookup = () => fold.findFoldTarget(db, { customerId, lane: 'pest', date: RESERVICE_DAY, propertyId: null });

  test('a replay is read off real time values: the stored 09:00:00 compares equal to the picked 09:00', async () => {
    const { hhmm } = require('../routes/reschedule-public')._internals;
    await planVisit(later(0), { window_start: '09:00', window_end: '10:00' });
    const target = await lookup();
    expect(target.scheduled_date).toBe(RESERVICE_DAY);
    expect(String(target.window_start)).toBe('09:00:00');
    expect(hhmm(target.window_start)).toBe('09:00');
  });

  test('the reschedule page\'s own loader and verdict accept a fold target (active customer, ungrouped, far from now)', async () => {
    const id = await planVisit(later(8));
    const { loadById, pageEligibility } = require('../routes/reschedule-public')._internals;
    const svc = await loadById(id);
    expect(svc).toMatchObject({ id, customer_id: customerId, customer_active: true });
    expect(await pageEligibility(svc)).toMatchObject({ ok: true });
    await db('customers').where({ id: customerId }).update({ active: false });
    expect(await pageEligibility(await loadById(id))).toMatchObject({ ok: false, reason: 'account_inactive' });
  });

  test('the customer move commits as a single visit: the reason and initiator fit reschedule_log, the plan behind it stays, the words land once', async () => {
    const first = await planVisit(later(8), { notes: 'Old note' });
    const second = await planVisit(later(8 + 91));
    const { loadById, pageEligibility } = require('../routes/reschedule-public')._internals;
    const target = await lookup();
    const svc = await loadById(target.id);
    const elig = await pageEligibility(svc);
    const customerRequest = { text: 'Ants in the kitchen', source: 'picker', pests: ['ants'], pestLabels: ['Ants'] };
    const out = await fold.moveFoldTargetForCustomer({ conn: db, target, svc, elig, lane: 'pest', date: RESERVICE_DAY, slot: SLOT, customerRequest });
    expect(out).toEqual({ moved: true });
    const rows = await db('scheduled_services').whereIn('id', [first, second]).select('id', 'scheduled_date', 'window_start', 'window_end', 'customer_request', 'customer_request_source', 'customer_request_pests', 'notes');
    const moved = rows.find((r) => r.id === first);
    const stays = rows.find((r) => r.id === second);
    expect([moved.window_start, moved.window_end]).toEqual(['11:00:00', '12:00:00']);
    expect(await db.raw('select scheduled_date::text d from scheduled_services where id = ?', [first]).then((r) => r.rows[0].d)).toBe(RESERVICE_DAY);
    expect(moved).toMatchObject({ customer_request: 'Ants in the kitchen', customer_request_source: 'picker', customer_request_pests: ['ants'], notes: 'Old note' });
    expect(stays.scheduled_date.toISOString().slice(0, 10)).not.toBe(RESERVICE_DAY);
    const log = await db('reschedule_log').where({ scheduled_service_id: first }).first('reason_code', 'initiated_by', 'new_date');
    expect(log).toMatchObject({ reason_code: 'reservice_fold', initiated_by: 'customer' });
  });

  test('a visit that already has words keeps them and the new words go to the notes once', async () => {
    const id = await planVisit(later(8), { customer_request: 'Earlier words', notes: 'Old note' });
    const { loadById, pageEligibility } = require('../routes/reschedule-public')._internals;
    const target = await lookup();
    const svc = await loadById(id);
    await fold.moveFoldTargetForCustomer({
      conn: db, target, svc, elig: await pageEligibility(svc), lane: 'pest', date: RESERVICE_DAY, slot: SLOT,
      customerRequest: { text: 'New words', source: 'picker', pests: null, pestLabels: [] },
    });
    const row = await db('scheduled_services').where({ id }).first('customer_request', 'notes');
    expect(row.customer_request).toBe('Earlier words');
    expect(row.notes.split("Customer's words (picker): New words.")).toHaveLength(2);
    expect(row.notes.startsWith('Old note\n[Re-service folded in, ')).toBe(true);
  });

  describe('a replayed pick (the plan visit already sits on the picked slot) holds the visit before it carries the words', () => {
    const words = (text) => ({ text, source: 'picker', pests: null, pestLabels: [] });
    const hold = (target, text) => fold.holdReplay({ conn: db, target, customerRequest: words(text), date: RESERVICE_DAY });
    const read = (id) => db('scheduled_services').where({ id }).first('customer_request', 'customer_request_source', 'notes');

    test('a visit that was always at the slot (no fold ever ran) takes the words as its request', async () => {
      const id = await planVisit(later(0), { window_start: '09:00', window_end: '10:00' });
      expect(await hold(await lookup(), 'Ants in the kitchen')).toBe(true);
      expect(await read(id)).toMatchObject({ customer_request: 'Ants in the kitchen', customer_request_source: 'picker', notes: null });
    });

    test('a true double tap: the same words again are not copied anywhere (not into the notes, the request unchanged)', async () => {
      const id = await planVisit(later(0));
      const target = await lookup();
      await hold(target, 'Ants in the kitchen');
      await hold(target, 'Ants in the kitchen');
      expect(await read(id)).toMatchObject({ customer_request: 'Ants in the kitchen', notes: null });
    });

    test('new words on a repeat pick go into the notes once, however often they are sent', async () => {
      const id = await planVisit(later(0), { notes: 'Old note' });
      const target = await lookup();
      await hold(target, 'Ants in the kitchen');
      await hold(target, 'Spiders in the garage');
      await hold(target, 'Spiders in the garage');
      const row = await read(id);
      expect(row.customer_request).toBe('Ants in the kitchen');
      expect(row.notes.split("Customer's words (picker): Spiders in the garage.")).toHaveLength(2);
      expect(row.notes.startsWith('Old note\n[Re-service folded in, ')).toBe(true);
      expect(row.notes).not.toContain('Ants in the kitchen');
    });

    test('staff cancelled the visit after the lookup: false, and nothing is written to it', async () => {
      const id = await planVisit(later(0), { notes: 'Old note' });
      const target = await lookup();
      await db('scheduled_services').where({ id }).update({ status: 'cancelled' });
      expect(await hold(target, 'Ants in the kitchen')).toBe(false);
      expect(await read(id)).toMatchObject({ customer_request: null, customer_request_source: null, notes: 'Old note' });
    });

    test('staff moved the visit after the lookup (a new start): false, and nothing is written to it', async () => {
      const id = await planVisit(later(0), { window_start: '09:00', window_end: '10:00' });
      const target = await lookup();
      await db('scheduled_services').where({ id }).update({ window_start: '10:00', window_end: '11:00' });
      expect(await hold(target, 'Ants in the kitchen')).toBe(false);
      expect(await read(id)).toMatchObject({ customer_request: null, notes: null });
    });
  });

  test('a visit that changed since the lookup is refused (a 4xx) and nothing moves', async () => {
    const id = await planVisit(later(8));
    const { loadById, pageEligibility } = require('../routes/reschedule-public')._internals;
    const target = await lookup();
    const svc = await loadById(id);
    const elig = await pageEligibility(svc);
    await db('scheduled_services').where({ id }).update({ status: 'confirmed' });
    const out = await fold.moveFoldTargetForCustomer({ conn: db, target, svc, elig, lane: 'pest', date: RESERVICE_DAY, slot: SLOT, customerRequest: null });
    expect(out.moved).toBe(false);
    expect((await db('reschedule_log').where({ scheduled_service_id: id }).count('* as n').first()).n).toBe('0');
  });
});
