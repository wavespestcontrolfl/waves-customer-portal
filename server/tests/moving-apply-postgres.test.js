// Moving PR B2 against real PostgreSQL (one rolled-back transaction per test), dark behind
// GATE_MOVING_APPLY: the Apply move preview, the confirm that makes the new home primary and
// stops the old house's plans after move-out (no customer text, no fee), the refusals, a resumed
// Apply after a failed step, and the termite pickup task. Sends, charges and texts nothing: the
// reminder sender and the admin bell writer are spies, and the cancellation follow-through runs
// for real behind a call recorder. All names and addresses are synthetic.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/geocoder', () => ({ geocodeAddressWithStatus: jest.fn(async () => ({ location: { lat: 27.1, lng: -82.4 } })) }));
jest.mock('../services/appointment-reminders', () => {
  const actual = jest.requireActual('../services/appointment-reminders');
  return { ...actual, handleSeriesCancellation: jest.fn(async () => null) };
});
jest.mock('../services/visit-cancellation-followthrough', () => {
  const actual = jest.requireActual('../services/visit-cancellation-followthrough');
  return { runVisitCancellationFollowThrough: jest.fn((...args) => actual.runVisitCancellationFollowThrough(...args)) };
});
jest.mock('../services/notification-service', () => {
  const actual = jest.requireActual('../services/notification-service');
  return { ...actual, notifyAdmin: jest.fn(async () => ({ id: 'n-termite' })) };
});
jest.mock('../services/recurring-series-cancel', () => {
  const actual = jest.requireActual('../services/recurring-series-cancel');
  return { ...actual, cancelSeriesRemainder: jest.fn((...args) => actual.cancelSeriesRemainder(...args)) };
});

const crypto = require('crypto');
const { etDateString, addETDays, dateOnlyString } = require('../utils/datetime-et');

const NEW_HOUSE = { line1: '40 Sample Road', line2: null, city: 'Venice', state: 'FL', zip: '34285' };
const NEW_ADDRESS = '40 Sample Road, Venice, FL 34285';
const ADMIN = { id: crypto.randomUUID(), name: 'Sample Admin' };
const day = (n) => etDateString(addETDays(new Date(), n));
const KEEP = day(10);
const MOVE_OUT = day(20);
const MOVE_IN = day(25);
const NEW_FIRST = day(30);
const AFTER_1 = day(40);
const AFTER_2 = day(130);

postgres('moving PR B2: Apply move (live Postgres)', () => {
  let database;
  let trx;
  let Moves;
  let Reminders;
  let FollowThrough;
  let Notifications;
  let SeriesCancel;
  let customerId;
  let oldHouseId;
  let newHouseId;
  let requestId;
  const OLD_ENV = {};

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    for (const key of ['GATE_MOVING_FLOW', 'GATE_MOVING_ESTIMATE', 'GATE_MOVING_APPLY', 'GATE_CUSTOMER_PROPERTIES']) OLD_ENV[key] = process.env[key];
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    Moves = require('../services/customer-moves');
    Reminders = require('../services/appointment-reminders');
    FollowThrough = require('../services/visit-cancellation-followthrough');
    Notifications = require('../services/notification-service');
    SeriesCancel = require('../services/recurring-series-cancel');
  });

  const visit = (patch) => ({
    customer_id: customerId, status: 'pending', service_type: 'Quarterly Pest Control Service', ...patch,
  });
  const insertVisit = async (patch) => (await trx('scheduled_services').insert(visit(patch)).returning('id'))[0].id;

  // A customer billed per visit, moving from 1 Old Street to 40 Sample Road, who accepted the
  // new-home estimate: the old house keeps a pest series (linked to it) and a lawn series (no
  // property link, so it reads as the primary), the new home has the estimate's pest series.
  async function seed({ customer = {}, move = {}, estimate = {} } = {}) {
    customerId = crypto.randomUUID();
    await trx('technicians').insert({ id: ADMIN.id, name: ADMIN.name, role: 'admin', employment_type: '1099', active: true });
    await trx('customers').insert({
      id: customerId, first_name: 'Pat', last_name: 'Sample', phone: '+19415550188', email: 'pat@example.invalid',
      address_line1: '1 Old Street', city: 'Bradenton', state: 'FL', zip: '34205', billing_mode: 'per_application', ...customer,
    });
    [{ id: oldHouseId }] = await trx('customer_properties').insert({
      customer_id: customerId, is_primary: true, active: true, address_line1: '1 Old Street', city: 'Bradenton', state: 'FL', zip: '34205',
    }).returning('id');
    [{ id: newHouseId }] = await trx('customer_properties').insert({
      customer_id: customerId, is_primary: false, active: true, occupancy_type: 'unknown',
      address_line1: NEW_HOUSE.line1, city: NEW_HOUSE.city, state: NEW_HOUSE.state, zip: NEW_HOUSE.zip,
    }).returning('id');
    [{ id: requestId }] = await trx('service_requests').insert({
      customer_id: customerId, category: 'moving', source: 'moving_page', subject: 'Moving: Venice', status: 'new',
      created_at: new Date(Date.now() - 3600e3), updated_at: new Date(Date.now() - 3600e3),
    }).returning('id');
    const [moveRow] = await trx('customer_moves').insert({
      customer_id: customerId, token: crypto.randomBytes(24).toString('hex'), status: 'submitted', from_property_id: oldHouseId,
      normalized_address: JSON.stringify(NEW_HOUSE), address_verdict: 'in_area', move_out_date: MOVE_OUT, move_in_date: MOVE_IN,
      service_request_id: requestId, submitted_at: new Date(), ...move,
    }).returning('*');
    const estimateId = crypto.randomUUID();
    await trx('estimates').insert({
      id: estimateId, customer_id: customerId, customer_name: 'Pat Sample', status: 'accepted', address: NEW_ADDRESS, property_id: newHouseId,
      accepted_at: new Date(),
      estimate_data: JSON.stringify({
        inputs: { svcPest: true, pestFreq: '4' },
        move: { moveId: moveRow.id, estimateId, address: NEW_ADDRESS, moveOutDate: MOVE_OUT, moveInDate: MOVE_IN },
      }),
      ...estimate,
    });
    await trx('customer_moves').where({ id: moveRow.id }).update({ estimate_id: estimateId });

    const pestRoot = await insertVisit({ scheduled_date: KEEP, is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true, property_id: oldHouseId });
    const pestAfter1 = await insertVisit({ scheduled_date: AFTER_1, recurring_parent_id: pestRoot, recurring_pattern: 'quarterly', recurring_ongoing: true, property_id: oldHouseId });
    const pestAfter2 = await insertVisit({ scheduled_date: AFTER_2, recurring_parent_id: pestRoot, recurring_pattern: 'quarterly', recurring_ongoing: true, property_id: oldHouseId });
    const lawnRoot = await insertVisit({ service_type: 'Lawn Care', scheduled_date: KEEP, is_recurring: true, recurring_pattern: 'monthly', recurring_ongoing: true });
    const lawnAfter = await insertVisit({ service_type: 'Lawn Care', scheduled_date: AFTER_1, recurring_parent_id: lawnRoot, recurring_pattern: 'monthly', recurring_ongoing: true });
    const oneOff = await insertVisit({ service_type: 'WDO Inspection', scheduled_date: AFTER_1, property_id: oldHouseId });
    // A call-created visit 2 linked to a pest visit Apply cancels: one-time, so it stays booked.
    const linkedFollowUp = await insertVisit({
      service_type: 'Pest Control Follow-Up', scheduled_date: day(45), property_id: oldHouseId,
      parent_service_id: pestAfter1, source_action: 'ai_call_pipeline_followup', customer_confirmed: false,
    });
    const newRoot = await insertVisit({
      scheduled_date: NEW_FIRST, is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true,
      property_id: newHouseId, source_estimate_id: estimateId,
      service_address_line1: NEW_HOUSE.line1, service_address_city: NEW_HOUSE.city, service_address_state: 'FL', service_address_zip: NEW_HOUSE.zip,
    });
    return {
      move: await trx('customer_moves').where({ id: moveRow.id }).first(),
      estimateId, pestRoot, pestAfter1, pestAfter2, lawnRoot, lawnAfter, oneOff, linkedFollowUp, newRoot,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_MOVING_FLOW = 'true';
    process.env.GATE_MOVING_ESTIMATE = 'true';
    process.env.GATE_MOVING_APPLY = 'true';
    process.env.GATE_CUSTOMER_PROPERTIES = 'true';
    trx = await database.transaction();
    mockConnection = trx;
  });

  afterEach(async () => {
    await trx.rollback();
    for (const [key, value] of Object.entries(OLD_ENV)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  afterAll(async () => { if (database) await database.destroy(); });

  const statusOf = async (id) => (await trx('scheduled_services').where({ id }).first('status')).status;

  test('the preview names every change, and the card offers Apply move', async () => {
    const s = await seed();
    expect(await Moves.applyAction(s.move)).toEqual({ action: 'review', reason: null });
    const preview = await Moves.applyMovePreview(customerId, s.move.id);
    expect(preview).toMatchObject({
      moveId: s.move.id,
      fromAddress: '1 Old Street, Bradenton, FL 34205',
      toAddress: NEW_ADDRESS,
      moveOutDate: MOVE_OUT,
      primaryChange: true,
      newPlan: [{ name: 'Quarterly Pest Control Service', frequency: 'quarterly' }],
      oneOffs: [
        { id: s.oneOff, date: AFTER_1, name: 'WDO Inspection' },
        { id: s.linkedFollowUp, date: day(45), name: 'Pest Control Follow-Up' },
      ],
      stations: null,
    });
    expect(preview.stops).toEqual(expect.arrayContaining([
      { name: 'Quarterly Pest Control Service', frequency: 'quarterly', cancelCount: 2, firstCancelDate: AFTER_1, keepCount: 1 },
      { name: 'Lawn Care', frequency: 'monthly', cancelCount: 1, firstCancelDate: AFTER_1, keepCount: 1 },
    ]));
    expect(preview.stops).toHaveLength(2);
    expect(preview.version).toMatch(/^[a-f0-9]{64}$/);
    // A preview writes nothing.
    expect(await statusOf(s.pestAfter1)).toBe('pending');
    expect((await trx('customer_properties').where({ id: oldHouseId }).first('is_primary')).is_primary).toBe(true);
  });

  test('confirm makes the new home primary, stops the old plans after move-out quietly, and closes the move', async () => {
    const s = await seed();
    // A third old-house plan with no visit booked after move-out still stops.
    const mosquitoRoot = await insertVisit({
      service_type: 'Mosquito Control', scheduled_date: KEEP, is_recurring: true, recurring_pattern: 'monthly', recurring_ongoing: true, property_id: oldHouseId,
    });
    const preview = await Moves.applyMovePreview(customerId, s.move.id);
    expect(preview.stops).toContainEqual({ name: 'Mosquito Control', frequency: 'monthly', cancelCount: 0, firstCancelDate: null, keepCount: 1 });
    const result = await Moves.applyMove(customerId, s.move.id, { version: preview.version, actorId: ADMIN.id });
    expect(result).toMatchObject({ applied: true, primaryChanged: true, plansStopped: 3, visitsCancelled: 3, stationTask: false });
    expect(await trx('scheduled_services').where({ id: mosquitoRoot }).first('status', 'recurring_ongoing')).toEqual({ status: 'pending', recurring_ongoing: false });

    // The new home is the primary property and the account address.
    expect((await trx('customer_properties').where({ id: newHouseId }).first('is_primary')).is_primary).toBe(true);
    expect((await trx('customer_properties').where({ id: oldHouseId }).first('is_primary', 'active'))).toEqual({ is_primary: false, active: true });
    expect((await trx('customers').where({ id: customerId }).first('address_line1', 'city'))).toEqual({ address_line1: '40 Sample Road', city: 'Venice' });

    // Old house: visits after move-out cancelled, the visit before it stays there, both plans stopped.
    expect(await statusOf(s.pestAfter1)).toBe('cancelled');
    expect(await statusOf(s.pestAfter2)).toBe('cancelled');
    expect(await statusOf(s.lawnAfter)).toBe('cancelled');
    expect(await trx('scheduled_services').whereIn('id', [s.pestRoot, s.lawnRoot]).orderBy('service_type').select('status', 'property_id', 'recurring_ongoing'))
      .toEqual([
        { status: 'pending', property_id: oldHouseId, recurring_ongoing: false },
        { status: 'pending', property_id: oldHouseId, recurring_ongoing: false },
      ]);
    const stops = await trx('recurring_plan_alerts').where({ customer_id: customerId, resolved_action: 'cancel_series' }).pluck('recurring_parent_id');
    expect(stops.sort()).toEqual([s.pestRoot, s.lawnRoot, mosquitoRoot].sort());
    const notes = await trx('job_status_history').whereIn('job_id', [s.pestAfter1, s.lawnAfter]).pluck('notes');
    expect(notes).toEqual([expect.stringContaining(`Apply move ${s.move.id}`), expect.stringContaining(`Apply move ${s.move.id}`)]);

    // New home, the one-time visit and the linked call follow-up are untouched.
    expect(await trx('scheduled_services').where({ id: s.newRoot }).first('status', 'recurring_ongoing', 'property_id'))
      .toEqual({ status: 'pending', recurring_ongoing: true, property_id: newHouseId });
    expect(await statusOf(s.oneOff)).toBe('pending');
    expect(await statusOf(s.linkedFollowUp)).toBe('pending');

    // No customer text, no fee.
    expect(Reminders.handleSeriesCancellation).toHaveBeenCalledTimes(2);
    for (const [, , options] of Reminders.handleSeriesCancellation.mock.calls) expect(options.sendNotification).toBe(false);
    expect(FollowThrough.runVisitCancellationFollowThrough).toHaveBeenCalledTimes(2);
    for (const [args] of FollowThrough.runVisitCancellationFollowThrough.mock.calls) {
      expect(args).toMatchObject({ waiveFee: true, source: 'moving-apply', linkedChildren: [] });
    }
    // The real follow-through moved the cancelled visits' tracker off scheduled.
    expect(await trx('scheduled_services').where({ id: s.pestAfter1 }).first('track_state')).toEqual({ track_state: 'cancelled' });

    // The move closes as applied; the estimate stays open to the customer; the office item closes.
    expect(await trx('customer_moves').where({ id: s.move.id }).first('status', 'closed_reason', 'to_property_id', 'applied_by'))
      .toEqual({ status: 'closed', closed_reason: 'applied', to_property_id: newHouseId, applied_by: ADMIN.id });
    const estimateRow = await trx('estimates').where({ id: s.estimateId }).first('estimate_data');
    expect(await Moves.moveLinkBlock(trx, estimateRow.estimate_data)).toBeNull();
    expect((await trx('service_requests').where({ id: requestId }).first('status')).status).toBe('resolved');
    expect(await trx('activity_log').where({ customer_id: customerId, action: 'moving_applied' }).count({ n: '*' }).first()).toEqual({ n: '1' });

    // Applied: the card shows no button, and a second confirm is refused.
    const after = await trx('customer_moves').where({ id: s.move.id }).first();
    expect(await Moves.applyAction(after)).toEqual({ action: 'applied', reason: null });
    await expect(Moves.applyMove(customerId, s.move.id, { version: preview.version, actorId: ADMIN.id })).rejects.toMatchObject({ code: 'already_applied', status: 409 });
  });

  test('a stale or missing version is refused before any write', async () => {
    const s = await seed();
    await expect(Moves.applyMove(customerId, s.move.id, { version: 'f'.repeat(64), actorId: ADMIN.id }))
      .rejects.toMatchObject({ code: 'apply_changed', status: 409 });
    await expect(Moves.applyMove(customerId, s.move.id, { actorId: ADMIN.id })).rejects.toMatchObject({ code: 'apply_changed' });
    // A visit booked after the preview changes the plan, so the old version no longer applies.
    const { version } = await Moves.applyMovePreview(customerId, s.move.id);
    await insertVisit({ scheduled_date: day(200), recurring_parent_id: s.pestRoot, recurring_pattern: 'quarterly', recurring_ongoing: true, property_id: oldHouseId });
    await expect(Moves.applyMove(customerId, s.move.id, { version, actorId: ADMIN.id })).rejects.toMatchObject({ code: 'apply_changed' });
    // So does moving a visit Apply would cancel to another date, still after move-out.
    const fresh = await Moves.applyMovePreview(customerId, s.move.id);
    await trx('scheduled_services').where({ id: s.pestAfter2 }).update({ scheduled_date: day(140) });
    await expect(Moves.applyMove(customerId, s.move.id, { version: fresh.version, actorId: ADMIN.id })).rejects.toMatchObject({ code: 'apply_changed' });
    // And so does an edit to the customer's saved properties the primary change would act on.
    const third = await Moves.applyMovePreview(customerId, s.move.id);
    await trx('customer_properties').where({ id: oldHouseId }).update({ label: 'Home', updated_at: trx.raw("now() + interval '1 second'") });
    await expect(Moves.applyMove(customerId, s.move.id, { version: third.version, actorId: ADMIN.id })).rejects.toMatchObject({ code: 'apply_changed' });
    expect((await trx('customer_properties').where({ id: oldHouseId }).first('is_primary')).is_primary).toBe(true);
    expect(await statusOf(s.pestAfter1)).toBe('pending');
  });

  test('a plan moved to another house while Apply runs is refused under the series locks, never cancelled there', async () => {
    const s = await seed();
    const preview = await Moves.applyMovePreview(customerId, s.move.id);
    const actual = jest.requireActual('../services/recurring-series-cancel');
    // Between the primary change and the cancel, someone moves a pest visit to the new home.
    SeriesCancel.cancelSeriesRemainder.mockImplementationOnce(async (args) => {
      await trx('scheduled_services').where({ id: s.pestAfter1 }).update({ property_id: newHouseId });
      return actual.cancelSeriesRemainder(args);
    });
    const err = await Moves.applyMove(customerId, s.move.id, { version: preview.version, actorId: ADMIN.id }).catch((e) => e);
    expect(err).toMatchObject({ code: 'series_changed', status: 409, step: 'plans', progress: expect.objectContaining({ primaryChanged: true }) });
    expect(err.message).toContain('Quarterly Pest Control Service changed while Apply move was running');
    expect(await statusOf(s.pestAfter1)).toBe('pending');
    expect(await statusOf(s.pestAfter2)).toBe('pending');
    expect((await trx('scheduled_services').where({ id: s.pestRoot }).first('recurring_ongoing')).recurring_ongoing).toBe(true);
    expect((await trx('customer_moves').where({ id: s.move.id }).first('status')).status).toBe('submitted');
  });

  test('a plan with no visit to cancel, moved to another house while Apply runs, is not stopped there', async () => {
    const s = await seed();
    const mosquitoRoot = await insertVisit({
      service_type: 'Mosquito Control', scheduled_date: KEEP, is_recurring: true, recurring_pattern: 'monthly', recurring_ongoing: true, property_id: oldHouseId,
    });
    const preview = await Moves.applyMovePreview(customerId, s.move.id);
    expect(preview.stops).toContainEqual(expect.objectContaining({ name: 'Mosquito Control', cancelCount: 0 }));
    const actual = jest.requireActual('../services/recurring-series-cancel');
    SeriesCancel.cancelSeriesRemainder.mockImplementation(async (args) => {
      if (args.parentId === mosquitoRoot) await trx('scheduled_services').where({ id: mosquitoRoot }).update({ property_id: newHouseId });
      return actual.cancelSeriesRemainder(args);
    });
    try {
      const err = await Moves.applyMove(customerId, s.move.id, { version: preview.version, actorId: ADMIN.id }).catch((e) => e);
      expect(err).toMatchObject({ code: 'series_changed', step: 'plans' });
      expect(err.message).toContain('Mosquito Control changed');
      expect((await trx('scheduled_services').where({ id: mosquitoRoot }).first('recurring_ongoing')).recurring_ongoing).toBe(true);
    } finally {
      SeriesCancel.cancelSeriesRemainder.mockImplementation((...args) => actual.cancelSeriesRemainder(...args));
    }
  });

  test('a visit confirmed while Apply runs is refused under the series locks too', async () => {
    const s = await seed();
    const preview = await Moves.applyMovePreview(customerId, s.move.id);
    const actual = jest.requireActual('../services/recurring-series-cancel');
    SeriesCancel.cancelSeriesRemainder.mockImplementation(async (args) => {
      if (args.parentId === s.pestRoot) await trx('scheduled_services').where({ id: s.pestAfter2 }).update({ status: 'confirmed' });
      return actual.cancelSeriesRemainder(args);
    });
    try {
      const err = await Moves.applyMove(customerId, s.move.id, { version: preview.version, actorId: ADMIN.id }).catch((e) => e);
      expect(err).toMatchObject({ code: 'series_changed', step: 'plans' });
      expect(await statusOf(s.pestAfter1)).toBe('pending');
    } finally {
      SeriesCancel.cancelSeriesRemainder.mockImplementation((...args) => actual.cancelSeriesRemainder(...args));
    }
  });

  test('a resumed Apply replays the follow-through an earlier attempt did not finish', async () => {
    const s = await seed();
    const first = await Moves.applyMovePreview(customerId, s.move.id);
    // The first attempt's cancel commits, then its follow-through stops (as if the process died).
    FollowThrough.runVisitCancellationFollowThrough.mockImplementationOnce(async () => { throw new Error('process stopped'); });
    const err = await Moves.applyMove(customerId, s.move.id, { version: first.version, actorId: ADMIN.id }).catch((e) => e);
    expect(err).toMatchObject({ step: 'plans', progress: expect.objectContaining({ primaryChanged: true }) });
    const cancelledFirst = (await trx('scheduled_services').where({ customer_id: customerId, status: 'cancelled' }).pluck('id')).sort();
    expect(cancelledFirst.length).toBeGreaterThan(0);

    FollowThrough.runVisitCancellationFollowThrough.mockClear();
    // The customer changes the move-out date before the office tries again: recovery still finds the earlier cancels.
    await trx('customer_moves').where({ id: s.move.id }).update({ move_out_date: day(21) });
    const again = await Moves.applyMovePreview(customerId, s.move.id);
    const result = await Moves.applyMove(customerId, s.move.id, { version: again.version, actorId: ADMIN.id });
    expect(result.applied).toBe(true);
    // The replay names exactly the visits the first attempt cancelled, with the fee waived and no linked cascade.
    const replay = FollowThrough.runVisitCancellationFollowThrough.mock.calls.map(([args]) => args)
      .find((args) => args.targetIds.some((id) => cancelledFirst.includes(id)));
    expect(replay).toMatchObject({ waiveFee: true, source: 'moving-apply', linkedChildren: [] });
    expect([...replay.targetIds].sort()).toEqual(cancelledFirst);
    expect(await trx('scheduled_services').whereIn('id', cancelledFirst).pluck('track_state')).toEqual(cancelledFirst.map(() => 'cancelled'));
  });

  test('a customer resubmit waits for a running Apply, and a submission changed during Apply is never closed', async () => {
    const s = await seed();
    // Apply holds the move's advisory key on its own session; the moving-page submit waits for it.
    const other = await database.client.acquireConnection();
    try {
      await other.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2::text))', ['customer-move-apply', s.move.id]);
      await trx.raw("SET LOCAL lock_timeout = '300ms'");
      await expect(Moves.submitMove(s.move, { moveOutDate: day(22) })).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await other.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2::text))', ['customer-move-apply', s.move.id]);
      await database.client.releaseConnection(other);
    }
    await trx.raw("SET LOCAL lock_timeout = '0'");
    expect(dateOnlyString((await trx('customer_moves').where({ id: s.move.id }).first('move_out_date')).move_out_date)).toBe(MOVE_OUT);

    // A submission that still lands mid-Apply (simulated here) stops Apply at the close: the move stays open.
    const preview = await Moves.applyMovePreview(customerId, s.move.id);
    const actual = jest.requireActual('../services/recurring-series-cancel');
    SeriesCancel.cancelSeriesRemainder.mockImplementationOnce(async (args) => {
      await trx('customer_moves').where({ id: s.move.id }).update({ move_out_date: day(22), submitted_at: new Date(Date.now() + 5000) });
      return actual.cancelSeriesRemainder(args);
    });
    const err = await Moves.applyMove(customerId, s.move.id, { version: preview.version, actorId: ADMIN.id }).catch((e) => e);
    expect(err).toMatchObject({ code: 'apply_changed', step: 'close' });
    expect((await trx('customer_moves').where({ id: s.move.id }).first('status')).status).toBe('submitted');
    expect((await trx('service_requests').where({ id: requestId }).first('status')).status).toBe('new');
  });

  test('refusals: gate off, estimate not accepted, no move-out date, prepay, paid visits, tenant, unresolved plan', async () => {
    let s = await seed();
    process.env.GATE_MOVING_APPLY = 'false';
    expect(await Moves.applyAction(s.move)).toBeNull();
    await expect(Moves.applyMovePreview(customerId, s.move.id)).rejects.toMatchObject({ code: 'gate_off', status: 404 });
    process.env.GATE_MOVING_APPLY = 'true';

    await trx('estimates').where({ id: s.estimateId }).update({ status: 'sent' });
    expect(await Moves.applyAction(s.move)).toBeNull();
    await expect(Moves.applyMovePreview(customerId, s.move.id)).rejects.toMatchObject({ code: 'estimate_not_accepted' });
    await trx('estimates').where({ id: s.estimateId }).update({ status: 'accepted' });

    await trx('customer_moves').where({ id: s.move.id }).update({ move_out_date: null });
    s.move = await trx('customer_moves').where({ id: s.move.id }).first();
    expect(await Moves.applyAction(s.move)).toEqual({ action: 'blocked', reason: Moves.APPLY_REFUSALS.no_move_out });
    await trx('customer_moves').where({ id: s.move.id }).update({ move_out_date: MOVE_OUT });

    await trx('scheduled_services').where({ id: s.pestAfter2 }).update({ prepaid_amount: 55 });
    await expect(Moves.applyMovePreview(customerId, s.move.id)).rejects.toMatchObject({ code: 'paid_visits', message: expect.stringContaining('already prepaid') });
    await trx('scheduled_services').where({ id: s.pestAfter2 }).update({ prepaid_amount: null });

    await trx('customers').where({ id: customerId }).update({ billing_mode: 'annual_prepay' });
    await expect(Moves.applyMovePreview(customerId, s.move.id)).rejects.toMatchObject({ code: 'prepay' });
    await trx('customers').where({ id: customerId }).update({ billing_mode: 'per_application', contact_role: 'tenant' });
    await expect(Moves.applyMovePreview(customerId, s.move.id)).rejects.toMatchObject({ code: 'primary_role_unavailable' });
    await trx('customers').where({ id: customerId }).update({ contact_role: null });

    // A plan visit under way today after a past move-out: Apply waits for it.
    await trx('customer_moves').where({ id: s.move.id }).update({ move_out_date: day(-3) });
    const underway = await insertVisit({ scheduled_date: day(0), recurring_parent_id: s.pestRoot, recurring_pattern: 'quarterly', property_id: oldHouseId, status: 'on_site' });
    await expect(Moves.applyMovePreview(customerId, s.move.id)).rejects.toMatchObject({ code: 'visit_underway', message: expect.stringContaining('Let the technician finish it') });
    await trx('scheduled_services').where({ id: underway }).del();
    await trx('customer_moves').where({ id: s.move.id }).update({ move_out_date: MOVE_OUT });

    // A legacy visit with no status after move-out would stay booked: refused, named.
    const legacy = await insertVisit({ scheduled_date: day(150), recurring_parent_id: s.pestRoot, recurring_pattern: 'quarterly', property_id: oldHouseId, status: null });
    await expect(Moves.applyMovePreview(customerId, s.move.id)).rejects.toMatchObject({ code: 'legacy_visits', message: expect.stringContaining('Quarterly Pest Control Service') });
    await trx('scheduled_services').where({ id: legacy }).del();

    // A plan whose visits name a third address cannot be tied to one house.
    const odd = await insertVisit({
      service_type: 'Tree & Shrub Care', scheduled_date: AFTER_1, is_recurring: true, recurring_pattern: 'monthly', recurring_ongoing: true,
      service_address_line1: '9 Other Lane', service_address_city: 'Sarasota', service_address_zip: '34232',
    });
    await expect(Moves.applyMovePreview(customerId, s.move.id)).rejects.toMatchObject({ code: 'unresolved_series', message: expect.stringContaining('Tree & Shrub Care') });
    await trx('scheduled_services').where({ id: odd }).del();
    s = { ...s, move: await trx('customer_moves').where({ id: s.move.id }).first() };
    expect(await Moves.applyAction(s.move)).toEqual({ action: 'review', reason: null });
  });

  test('a step that fails reports what is done, and the next confirm resumes from there', async () => {
    const s = await seed();
    const first = await Moves.applyMovePreview(customerId, s.move.id);
    SeriesCancel.cancelSeriesRemainder.mockImplementationOnce(async () => { throw new Error('connection reset'); });
    const err = await Moves.applyMove(customerId, s.move.id, { version: first.version, actorId: ADMIN.id }).catch((e) => e);
    expect(err).toMatchObject({ step: 'plans', progress: { primaryChanged: true, plansStopped: 0 } });
    expect((await trx('customer_moves').where({ id: s.move.id }).first('status')).status).toBe('submitted');

    const again = await Moves.applyMovePreview(customerId, s.move.id);
    expect(again.primaryChange).toBe(false);
    expect(again.stops).toHaveLength(2);
    expect(again.version).not.toBe(first.version);
    const result = await Moves.applyMove(customerId, s.move.id, { version: again.version, actorId: ADMIN.id });
    expect(result).toMatchObject({ applied: true, primaryChanged: false, plansStopped: 2, visitsCancelled: 3 });
    expect(await statusOf(s.lawnAfter)).toBe('cancelled');
    expect((await trx('customer_moves').where({ id: s.move.id }).first('closed_reason')).closed_reason).toBe('applied');
  });

  test('a move-out date in the past cancels only from today; open visits in between are listed, never cancelled', async () => {
    const s = await seed({ move: { move_out_date: day(-6), move_in_date: day(-3) } });
    const pastOpen = await insertVisit({ scheduled_date: day(-2), recurring_parent_id: s.pestRoot, recurring_pattern: 'quarterly', recurring_ongoing: true, property_id: oldHouseId });
    const preview = await Moves.applyMovePreview(customerId, s.move.id);
    expect(preview.pastOpen).toEqual([{ id: pastOpen, date: day(-2), name: 'Quarterly Pest Control Service' }]);
    const pest = preview.stops.find((x) => x.name === 'Quarterly Pest Control Service');
    // The visit dated KEEP (in 10 days) is now after move-out too, so it is cancelled.
    expect(pest).toMatchObject({ cancelCount: 3, firstCancelDate: KEEP, keepCount: 0 });
    const result = await Moves.applyMove(customerId, s.move.id, { version: preview.version, actorId: ADMIN.id });
    expect(result.pastOpen).toEqual(preview.pastOpen);
    expect(await statusOf(pastOpen)).toBe('pending');
    expect(await statusOf(s.pestRoot)).toBe('cancelled');
    expect(await statusOf(s.pestAfter1)).toBe('cancelled');
    expect((await trx('scheduled_services').where({ id: s.pestRoot }).first('recurring_ongoing')).recurring_ongoing).toBe(false);
  });

  test('rented termite stations open one pickup task dated after move-out', async () => {
    const s = await seed();
    await trx('termite_stations').insert({ customer_id: customerId, station_number: 1, program: 'termite', owned_by: 'waves', is_active: true, geometry_image: JSON.stringify({}) });
    const preview = await Moves.applyMovePreview(customerId, s.move.id);
    expect(preview.stations).toEqual({ count: 1, flagged: false });
    const result = await Moves.applyMove(customerId, s.move.id, { version: preview.version, actorId: ADMIN.id });
    expect(result.stationTask).toBe(true);
    expect(Notifications.notifyAdmin).toHaveBeenCalledTimes(1);
    const [, , , options] = Notifications.notifyAdmin.mock.calls[0];
    expect(options).toMatchObject({
      dedupeKey: `termite_station_retrieval:${customerId}:${requestId}`,
      metadata: expect.objectContaining({ kind: 'termite_station_retrieval', retrieveAfter: MOVE_OUT, requestId }),
    });
  });
});
