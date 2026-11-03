// Moving PR 2b against real PostgreSQL (one rolled-back transaction per test), dark behind
// GATE_MOVING_PAUSE (owner Q4): the daily job's reminder text a week before move-out, the pause
// of every plan at the house left on the move-out day for the visits after it (no customer text,
// no fee), the office hand-offs and their items written with the move change, the move fence,
// the end after 60 days, the receipt's pause lane, and Apply move after a pause. Sends, charges
// and texts nothing: the customer sender, the reminder sender and the admin bell writer are spies,
// and the cancellation follow-through runs for real behind a call recorder. All names and
// addresses are synthetic.
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
  return { ...actual, notifyAdmin: jest.fn(async () => ({ id: 'n-pause' })) };
});
jest.mock('../services/recurring-series-cancel', () => {
  const actual = jest.requireActual('../services/recurring-series-cancel');
  return { ...actual, cancelSeriesRemainder: jest.fn((...args) => actual.cancelSeriesRemainder(...args)) };
});
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/short-url', () => {
  const actual = jest.requireActual('../services/short-url');
  return { ...actual, shortenOrPassthrough: jest.fn(async (url) => url) };
});

const crypto = require('crypto');
const { etDateString, addETDays, dateOnlyString } = require('../utils/datetime-et');

const NEW_HOUSE = { line1: '40 Sample Road', line2: null, city: 'Venice', state: 'FL', zip: '34285' };
const NEW_ADDRESS = '40 Sample Road, Venice, FL 34285';
const day = (n) => etDateString(addETDays(new Date(), n));
const KEEP = day(-10);
const MOVE_OUT = day(-2);
const PAST_OPEN = day(-1);
const AFTER_1 = day(10);
const AFTER_2 = day(100);
const DAYS_AGO_3 = () => new Date(Date.now() - 3 * 86400e3);

postgres('moving PR 2b: the move pause (live Postgres)', () => {
  let database;
  let trx;
  let Moves;
  let Reminders;
  let FollowThrough;
  let Notifications;
  let Sender;
  let customerId;
  let oldHouseId;
  let otherHouseId;
  let requestId;
  const OLD_ENV = {};

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    for (const key of ['GATE_MOVING_FLOW', 'GATE_MOVING_PAUSE', 'GATE_MOVING_ESTIMATE', 'GATE_MOVING_APPLY', 'GATE_CUSTOMER_PROPERTIES']) OLD_ENV[key] = process.env[key];
    // Three connections: the test's transaction, the job's move fence, and a rival fence holder.
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 3 } });
    Moves = require('../services/customer-moves');
    Reminders = require('../services/appointment-reminders');
    FollowThrough = require('../services/visit-cancellation-followthrough');
    Notifications = require('../services/notification-service');
    Sender = require('../services/messaging/send-customer-message');
  });

  const visit = (patch) => ({
    customer_id: customerId, status: 'pending', service_type: 'Quarterly Pest Control Service', ...patch,
  });
  const insertVisit = async (patch) => (await trx('scheduled_services').insert(visit(patch)).returning('id'))[0].id;

  // A customer billed per visit who moved out of 1 Old Street two days ago with no new address:
  // the old house keeps a pest series (linked to it) and a lawn series (no property link, so it
  // reads as the primary), a one-time WDO visit after move-out, and an open pest visit dated
  // between move-out and today. Their rental at 9 Other Lane keeps its own pest series.
  async function seed({ customer = {}, move = {} } = {}) {
    customerId = crypto.randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Pat', last_name: 'Sample', phone: '+19415550188', email: 'pat@example.invalid',
      address_line1: '1 Old Street', city: 'Bradenton', state: 'FL', zip: '34205', billing_mode: 'per_application', ...customer,
    });
    [{ id: oldHouseId }] = await trx('customer_properties').insert({
      customer_id: customerId, is_primary: true, active: true, address_line1: '1 Old Street', city: 'Bradenton', state: 'FL', zip: '34205',
    }).returning('id');
    [{ id: otherHouseId }] = await trx('customer_properties').insert({
      customer_id: customerId, is_primary: false, active: true, address_line1: '9 Other Lane', city: 'Sarasota', state: 'FL', zip: '34232',
    }).returning('id');
    [{ id: requestId }] = await trx('service_requests').insert({
      customer_id: customerId, category: 'moving', source: 'moving_page', subject: 'Moving: address not known yet', status: 'new',
      created_at: DAYS_AGO_3(), updated_at: DAYS_AGO_3(),
    }).returning('id');
    const [moveRow] = await trx('customer_moves').insert({
      customer_id: customerId, token: crypto.randomBytes(24).toString('hex'), status: 'submitted', from_property_id: oldHouseId,
      move_out_date: MOVE_OUT, service_request_id: requestId, submitted_at: DAYS_AGO_3(), ...move,
    }).returning('*');

    const pestRoot = await insertVisit({ scheduled_date: KEEP, status: 'completed', is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true, property_id: oldHouseId });
    const pestPastOpen = await insertVisit({ scheduled_date: PAST_OPEN, recurring_parent_id: pestRoot, recurring_pattern: 'quarterly', recurring_ongoing: true, property_id: oldHouseId });
    const pestAfter1 = await insertVisit({ scheduled_date: AFTER_1, recurring_parent_id: pestRoot, recurring_pattern: 'quarterly', recurring_ongoing: true, property_id: oldHouseId });
    const pestAfter2 = await insertVisit({ scheduled_date: AFTER_2, recurring_parent_id: pestRoot, recurring_pattern: 'quarterly', recurring_ongoing: true, property_id: oldHouseId });
    const lawnRoot = await insertVisit({ service_type: 'Lawn Care', scheduled_date: KEEP, status: 'completed', is_recurring: true, recurring_pattern: 'monthly', recurring_ongoing: true });
    const lawnAfter = await insertVisit({ service_type: 'Lawn Care', scheduled_date: AFTER_1, recurring_parent_id: lawnRoot, recurring_pattern: 'monthly', recurring_ongoing: true });
    const oneOff = await insertVisit({ service_type: 'WDO Inspection', scheduled_date: AFTER_1, property_id: oldHouseId });
    const otherRoot = await insertVisit({
      scheduled_date: day(5), is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true, property_id: otherHouseId,
      service_address_line1: '9 Other Lane', service_address_city: 'Sarasota', service_address_state: 'FL', service_address_zip: '34232',
    });
    return {
      move: await trx('customer_moves').where({ id: moveRow.id }).first(),
      pestRoot, pestPastOpen, pestAfter1, pestAfter2, lawnRoot, lawnAfter, oneOff, otherRoot,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_MOVING_FLOW = 'true';
    process.env.GATE_MOVING_PAUSE = 'true';
    process.env.GATE_CUSTOMER_PROPERTIES = 'true';
    delete process.env.GATE_MOVING_ESTIMATE;
    delete process.env.GATE_MOVING_APPLY;
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
  const moveRow = (id) => trx('customer_moves').where({ id }).first();
  const alertCalls = (kind) => Notifications.notifyAdmin.mock.calls.filter(([, , , opts]) => opts?.metadata?.kind === `moving_pause_${kind}`);

  test('after move-out, every plan at the house left pauses quietly and the move is held 60 days', async () => {
    const s = await seed();
    const result = await Moves.runMovePauseJob();
    expect(result).toMatchObject({ paused: 1, office: 0, busy: 0, failed: 0, ended: 0, reminded: 0 });

    // Old house: visits from today on cancelled; the open visit dated before today and the one-time visit stay.
    expect(await statusOf(s.pestAfter1)).toBe('cancelled');
    expect(await statusOf(s.pestAfter2)).toBe('cancelled');
    expect(await statusOf(s.lawnAfter)).toBe('cancelled');
    expect(await statusOf(s.pestPastOpen)).toBe('pending');
    expect(await statusOf(s.oneOff)).toBe('pending');
    expect(await trx('scheduled_services').whereIn('id', [s.pestRoot, s.lawnRoot]).pluck('recurring_ongoing')).toEqual([false, false]);
    // The plan at their other property is untouched.
    expect(await trx('scheduled_services').where({ id: s.otherRoot }).first('status', 'recurring_ongoing')).toEqual({ status: 'pending', recurring_ongoing: true });
    const notes = await trx('job_status_history').whereIn('job_id', [s.pestAfter1, s.lawnAfter]).pluck('notes');
    expect(notes).toEqual([expect.stringContaining(`move pause ${s.move.id}`), expect.stringContaining(`move pause ${s.move.id}`)]);

    // No customer text, no fee.
    expect(Sender.sendCustomerMessage).not.toHaveBeenCalled();
    for (const [, , options] of Reminders.handleSeriesCancellation.mock.calls) expect(options.sendNotification).toBe(false);
    expect(FollowThrough.runVisitCancellationFollowThrough).toHaveBeenCalledTimes(2);
    for (const [args] of FollowThrough.runVisitCancellationFollowThrough.mock.calls) {
      expect(args).toMatchObject({ waiveFee: true, source: 'moving-pause', linkedChildren: [] });
    }

    // The move stays submitted (an address can still come in), held until move-out + 60 days.
    const after = await moveRow(s.move.id);
    expect(after).toMatchObject({ status: 'submitted', pause_state: 'paused', closed_reason: null });
    expect(dateOnlyString(after.pause_ends_on)).toBe(etDateString(addETDays(new Date(`${MOVE_OUT}T12:00:00Z`), 60)));
    expect(await trx('activity_log').where({ customer_id: customerId, action: 'moving_paused' }).count({ n: '*' }).first()).toEqual({ n: '1' });

    // The office hears about the two visits still booked at the old house, in one ringing item.
    expect(Notifications.notifyAdmin).toHaveBeenCalledTimes(1);
    const [[category, title, why, opts]] = alertCalls('left_booked');
    expect(category).toBe('service');
    expect(title).toBe("Customers — check Pat Sample's old-house visits");
    expect(why).toBe('The plans paused after the move-out, but 2 visits are still booked at the old house.');
    expect(opts).toMatchObject({ bell: true, dedupeKey: `moving_pause_left_booked:${s.move.id}` });
    // Written in the move change's own transaction (notifyAdmin's trx).
    expect(opts.trx && opts.trx.isTransaction).toBe(true);
    expect(opts.detail).toContain('WDO Inspection');
    expect(opts.detail).toContain('Quarterly Pest Control Service');

    // A second run finds nothing to do.
    jest.clearAllMocks();
    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 0, office: 0 });
    expect(Notifications.notifyAdmin).not.toHaveBeenCalled();
    expect(FollowThrough.runVisitCancellationFollowThrough).not.toHaveBeenCalled();
  });

  test('on the move-out day, the visits after it stop and that day\'s own visit stays', async () => {
    const s = await seed({ move: { move_out_date: day(0) } });
    const today = await insertVisit({ scheduled_date: day(0), recurring_parent_id: s.pestRoot, recurring_pattern: 'quarterly', property_id: oldHouseId });
    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 1 });
    expect(await statusOf(today)).toBe('pending');
    expect(await statusOf(s.pestAfter1)).toBe('cancelled');
    expect(await statusOf(s.lawnAfter)).toBe('cancelled');
    // The open visit dated before the move-out is a visit before it, not one left booked after it.
    expect(await statusOf(s.pestPastOpen)).toBe('pending');
    const [[, , why]] = alertCalls('left_booked');
    expect(why).toBe('The plans paused after the move-out, but 1 visit is still booked at the old house.');
  });

  test('nothing pauses before the move-out day, for a move with an address, or with the gate off', async () => {
    const s = await seed({ move: { move_out_date: day(1) } });
    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 0 });
    expect(await statusOf(s.pestAfter1)).toBe('pending');

    await trx('customer_moves').where({ id: s.move.id }).update({
      move_out_date: MOVE_OUT, typed_address: NEW_ADDRESS, normalized_address: JSON.stringify(NEW_HOUSE), address_verdict: 'in_area',
    });
    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 0 });
    expect(await statusOf(s.pestAfter1)).toBe('pending');

    await trx('customer_moves').where({ id: s.move.id }).update({ typed_address: null, normalized_address: null, address_verdict: null });
    process.env.GATE_MOVING_PAUSE = 'false';
    expect(await Moves.runMovePauseJob()).toEqual({ skipped: true });
    expect(await statusOf(s.pestAfter1)).toBe('pending');
    expect((await moveRow(s.move.id)).pause_state).toBeNull();
  });

  test('the reminder text goes once, 0 to 7 days before move-out, never on the day of the submit', async () => {
    const s = await seed({ move: { move_out_date: day(5) } });
    const result = await Moves.runMovePauseJob();
    expect(result).toMatchObject({ reminded: 1, reminderNotSent: 0, paused: 0 });
    expect(Sender.sendCustomerMessage).toHaveBeenCalledTimes(1);
    const [[input]] = Sender.sendCustomerMessage.mock.calls;
    expect(input).toMatchObject({
      to: '+19415550188', channel: 'sms', audience: 'customer', purpose: 'support_resolution', customerId,
      identityTrustLevel: 'phone_matches_customer', entryPoint: 'moving_address_reminder',
      metadata: { original_message_type: 'moving_address_reminder', move_id: s.move.id },
    });
    const [y, m, d] = day(5).split('-').map(Number);
    const pretty = `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${d}, ${y}`;
    expect(input.body).toBe(`Hi Pat, you move out on ${pretty}. We pause your Waves visits after that until we have your new address.\n\nAdd it here: ${input.body.split('Add it here: ')[1]}`);
    expect(input.body).toContain(`/moving/${s.move.token}`);
    const after = await moveRow(s.move.id);
    expect(after.pause_reminder_at).not.toBeNull();
    expect(after.pause_reminder_sent).toBe(true);
    expect(await statusOf(s.pestAfter1)).toBe('pending');

    // Never a second text.
    expect(await Moves.runMovePauseJob()).toMatchObject({ reminded: 0 });
    expect(Sender.sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('no reminder on the submit day, more than 7 days ahead, with an address or for prepay; a failed send is not retried', async () => {
    const s = await seed({ move: { move_out_date: day(5), submitted_at: new Date() } });
    expect(await Moves.runMovePauseJob()).toMatchObject({ reminded: 0 });
    await trx('customer_moves').where({ id: s.move.id }).update({ submitted_at: DAYS_AGO_3(), move_out_date: day(8) });
    expect(await Moves.runMovePauseJob()).toMatchObject({ reminded: 0 });
    await trx('customer_moves').where({ id: s.move.id }).update({
      move_out_date: day(5), typed_address: NEW_ADDRESS, normalized_address: JSON.stringify(NEW_HOUSE), address_verdict: 'in_area',
    });
    expect(await Moves.runMovePauseJob()).toMatchObject({ reminded: 0 });
    expect(Sender.sendCustomerMessage).not.toHaveBeenCalled();

    await trx('customer_moves').where({ id: s.move.id }).update({ typed_address: null, normalized_address: null, address_verdict: null });
    // The text says the visits pause: a customer the job hands to the office never gets it.
    await trx('customers').where({ id: customerId }).update({ billing_mode: 'annual_prepay' });
    expect(await Moves.runMovePauseJob()).toMatchObject({ reminded: 0, reminderNotSent: 0 });
    expect(Sender.sendCustomerMessage).not.toHaveBeenCalled();
    expect((await moveRow(s.move.id)).pause_reminder_at).toBeNull();
    await trx('customers').where({ id: customerId }).update({ billing_mode: 'per_application' });
    Sender.sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'OPTED_OUT' });
    expect(await Moves.runMovePauseJob()).toMatchObject({ reminded: 0, reminderNotSent: 1 });
    expect((await moveRow(s.move.id)).pause_reminder_sent).toBe(false);
    expect(await Moves.runMovePauseJob()).toMatchObject({ reminderNotSent: 0 });
    expect(Sender.sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('annual prepay and monthly members go to the office once, and nothing is cancelled', async () => {
    const s = await seed({ customer: { billing_mode: 'annual_prepay' } });
    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 0, office: 1 });
    expect(await statusOf(s.pestAfter1)).toBe('pending');
    expect(await moveRow(s.move.id)).toMatchObject({ status: 'submitted', pause_state: 'office', pause_ends_on: null });
    expect((await moveRow(s.move.id)).pause_note).toContain('prepay for the year');
    const [[, title, why, opts]] = alertCalls('office');
    expect(title).toBe("Customers — pause Pat Sample's plan by hand");
    expect(why).toMatch(/^Their move-out is .+ with no new address on file; the automatic pause did not run\.$/);
    expect(opts).toMatchObject({ bell: true, dedupeKey: `moving_pause_office:${s.move.id}` });
    expect(opts.detail).toContain('Pause their visits by hand.');

    // Once: the next run leaves it with the office.
    jest.clearAllMocks();
    expect(await Moves.runMovePauseJob()).toMatchObject({ office: 0 });
    expect(Notifications.notifyAdmin).not.toHaveBeenCalled();

    // A monthly member, by the billing code's own lane rule (no mode, a tier and a rate).
    await trx('customer_moves').where({ id: s.move.id }).update({ pause_state: null, pause_note: null, paused_at: null });
    await trx('customers').where({ id: customerId }).update({ billing_mode: null, waveguard_tier: 'Gold', monthly_rate: 89 });
    expect(await Moves.runMovePauseJob()).toMatchObject({ office: 1 });
    expect((await moveRow(s.move.id)).pause_note).toContain('monthly membership');
    expect(await statusOf(s.pestAfter1)).toBe('pending');
  });

  test('a visit under way at the old house hands the pause to the office before anything is cancelled', async () => {
    const s = await seed();
    const underway = await insertVisit({ scheduled_date: day(0), status: 'on_site', recurring_parent_id: s.pestRoot, recurring_pattern: 'quarterly', property_id: oldHouseId });
    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 0, office: 1 });
    expect((await moveRow(s.move.id)).pause_note).toContain('under way');
    expect(await statusOf(underway)).toBe('on_site');
    expect(await statusOf(s.pestAfter1)).toBe('pending');
    expect(await statusOf(s.lawnAfter)).toBe('pending');
    expect(alertCalls('office')).toHaveLength(1);
  });

  test('a cancel refused partway hands the pause to the office naming what already stopped', async () => {
    const s = await seed();
    const SeriesCancel = require('../services/recurring-series-cancel');
    const actual = jest.requireActual('../services/recurring-series-cancel');
    // The second plan's visits change under the series locks: its re-check refuses it.
    let calls = 0;
    SeriesCancel.cancelSeriesRemainder.mockImplementation(async (args) => {
      calls += 1;
      if (calls === 2) await trx('scheduled_services').where({ recurring_parent_id: args.parentId }).update({ scheduled_date: day(11) });
      return actual.cancelSeriesRemainder(args);
    });
    try {
      expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 0, office: 1 });
    } finally {
      SeriesCancel.cancelSeriesRemainder.mockImplementation((...args) => actual.cancelSeriesRemainder(...args));
    }
    const note = (await moveRow(s.move.id)).pause_note;
    expect(note).toMatch(/^Stopped: .+\. Not stopped: .+ changed while the pause was running\.$/);
    expect((await moveRow(s.move.id)).pause_state).toBe('office');
  });

  test('an office item that fails to write rolls back its move change, and the next run repeats the step', async () => {
    const s = await seed();
    // The pause's item for the visits left booked: the cancels stand, the mark rolls back.
    Notifications.notifyAdmin.mockRejectedValueOnce(new Error('insert failed'));
    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 0, failed: 1 });
    expect(await statusOf(s.pestAfter1)).toBe('cancelled');
    expect((await moveRow(s.move.id)).pause_state).toBeNull();
    expect(await trx('activity_log').where({ customer_id: customerId, action: 'moving_paused' }).count({ n: '*' }).first()).toEqual({ n: '0' });
    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 1, failed: 0 });
    expect((await moveRow(s.move.id)).pause_state).toBe('paused');
    expect(alertCalls('left_booked')).toHaveLength(2);

    // The hand-off's item: nothing is recorded until the item is written.
    await trx('customer_moves').where({ id: s.move.id }).update({ pause_state: null, paused_at: null, pause_ends_on: null });
    await trx('customers').where({ id: customerId }).update({ billing_mode: 'annual_prepay' });
    Notifications.notifyAdmin.mockRejectedValueOnce(new Error('insert failed'));
    expect(await Moves.runMovePauseJob()).toMatchObject({ office: 0, failed: 1 });
    expect((await moveRow(s.move.id)).pause_state).toBeNull();
    expect(await Moves.runMovePauseJob()).toMatchObject({ office: 1 });
    expect(alertCalls('office')).toHaveLength(2);
    expect((await moveRow(s.move.id)).pause_state).toBe('office');
  });

  test('the submit names the pause lane for the receipt: per visit, office, no plan, gate off', async () => {
    const s = await seed({ move: { move_out_date: null, submitted_at: null, status: 'open' } });
    const submit = () => Moves.submitMove(s.move, { moveOutDate: day(5) });
    expect((await submit()).pauseLane).toBe('auto');
    await trx('customers').where({ id: customerId }).update({ billing_mode: 'annual_prepay' });
    expect((await submit()).pauseLane).toBe('office');
    await trx('customers').where({ id: customerId }).update({ billing_mode: 'one_time' });
    expect((await submit()).pauseLane).toBeNull();
    await trx('customers').where({ id: customerId }).update({ billing_mode: 'per_application' });
    process.env.GATE_MOVING_PAUSE = 'false';
    expect((await submit()).pauseLane).toBeNull();
  });

  test('a full page of moves the reminder skips never holds back an eligible one', async () => {
    const s = await seed({ move: { move_out_date: day(5), id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' } });
    // 50 prepay movers (one page) whose ids sort before the eligible move's id.
    for (let i = 0; i < 50; i += 1) {
      const id = crypto.randomUUID();
      await trx('customers').insert({ id, first_name: 'Sam', last_name: 'Sample', phone: '+19415550199', billing_mode: 'annual_prepay' });
      await trx('customer_moves').insert({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, customer_id: id, token: crypto.randomBytes(24).toString('hex'),
        status: 'submitted', move_out_date: day(5), submitted_at: DAYS_AGO_3(),
      });
    }
    expect(await Moves.runMovePauseJob()).toMatchObject({ reminded: 1 });
    expect(Sender.sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(Sender.sendCustomerMessage.mock.calls[0][0].metadata.move_id).toBe(s.move.id);
  });

  test('a new move-out date after the pause goes to the office, and the old deadline never closes the move', async () => {
    const s = await seed();
    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 1 });
    // The same date again keeps the pause.
    expect((await Moves.submitMove(await moveRow(s.move.id), { moveOutDate: MOVE_OUT })).pauseLane).toBe('auto');
    expect((await moveRow(s.move.id)).pause_state).toBe('paused');

    const saved = await Moves.submitMove(await moveRow(s.move.id), { moveOutDate: day(20) });
    expect(saved.pauseLane).toBe('office');
    const after = await moveRow(s.move.id);
    expect(after).toMatchObject({ status: 'submitted', pause_state: 'office' });
    expect(after.pause_note).toContain('changed the move-out date');
    const item = await trx('service_requests').where({ id: requestId }).first('description');
    expect(item.description).toContain('Check those visits against the new date.');

    // Past the old deadline, the end pass leaves it alone: the office has it.
    await trx('customer_moves').where({ id: s.move.id }).update({ pause_ends_on: day(-1) });
    expect(await Moves.runMovePauseJob()).toMatchObject({ ended: 0, paused: 0 });
    expect((await moveRow(s.move.id)).status).toBe('submitted');
  });

  test('the pause waits for a running Apply or customer update on the same move (the move fence)', async () => {
    const s = await seed();
    const other = await database.client.acquireConnection();
    try {
      await other.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2::text))', ['customer-move-apply', s.move.id]);
      expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 0, busy: 1 });
      expect(await statusOf(s.pestAfter1)).toBe('pending');
      expect((await moveRow(s.move.id)).pause_state).toBeNull();
    } finally {
      await other.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2::text))', ['customer-move-apply', s.move.id]);
      await database.client.releaseConnection(other);
    }
    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 1, busy: 0 });
    expect(await statusOf(s.pestAfter1)).toBe('cancelled');
  });

  test('a run that stopped after its cancels resumes: the follow-through replays and the move is marked', async () => {
    const s = await seed();
    // Simulate a run that cancelled the pest plan and died before its follow-through and the mark.
    const actual = jest.requireActual('../services/recurring-series-cancel');
    const FT = jest.requireActual('../services/visit-cancellation-followthrough');
    FollowThrough.runVisitCancellationFollowThrough.mockImplementationOnce(async () => { throw Object.assign(new Error('process stopped'), { statusCode: 500 }); });
    await expect(actual.cancelSeriesRemainder({
      parentId: s.pestRoot, customerId, serviceType: 'Quarterly Pest Control Service', recurringPattern: 'quarterly', scope: 'following',
      fromDate: day(0), notifyCustomer: false, notes: `Customer moved out with no new address; plan paused after the move-out date (moving flow, move pause ${s.move.id})`,
      actorId: null, waiveFee: true, source: 'moving-pause', allowEmpty: true, linkedChildren: [],
    })).rejects.toThrow('process stopped');
    expect(await statusOf(s.pestAfter1)).toBe('cancelled');
    // The follow-through never ran: the tracker still shows the visit as booked.
    expect((await trx('scheduled_services').where({ id: s.pestAfter1 }).first('track_state')).track_state).not.toBe('cancelled');
    FollowThrough.runVisitCancellationFollowThrough.mockReset();
    FollowThrough.runVisitCancellationFollowThrough.mockImplementation((...args) => FT.runVisitCancellationFollowThrough(...args));

    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 1 });
    const replay = FollowThrough.runVisitCancellationFollowThrough.mock.calls.map(([args]) => args)
      .find((args) => args.targetIds.includes(s.pestAfter1));
    expect(replay).toMatchObject({ waiveFee: true, source: 'moving-pause', linkedChildren: [] });
    expect([...replay.targetIds].sort()).toEqual([s.pestAfter1, s.pestAfter2].sort());
    expect(await trx('scheduled_services').whereIn('id', [s.pestAfter1, s.pestAfter2]).pluck('track_state')).toEqual(['cancelled', 'cancelled']);
    expect(await statusOf(s.lawnAfter)).toBe('cancelled');
    expect((await moveRow(s.move.id)).pause_state).toBe('paused');
  });

  test('60 days after move-out with still no address, the move closes and the office gets one item', async () => {
    const s = await seed({ move: { move_out_date: day(-61), pause_state: 'paused', paused_at: new Date(Date.now() - 59 * 86400e3), pause_ends_on: day(-1) } });
    expect(await Moves.runMovePauseJob()).toMatchObject({ ended: 1, paused: 0 });
    expect(await moveRow(s.move.id)).toMatchObject({ status: 'closed', closed_reason: 'pause_expired' });
    expect((await trx('service_requests').where({ id: requestId }).first('status')).status).toBe('resolved');
    expect(await trx('activity_log').where({ customer_id: customerId, action: 'moving_pause_ended' }).count({ n: '*' }).first()).toEqual({ n: '1' });
    const [[, title, why, opts]] = alertCalls('ended');
    expect(title).toBe("Customers — close out Pat Sample's move");
    expect(why).toMatch(/^No new address 60 days after the move-out on .+, so their plans stay stopped\.$/);
    expect(opts).toMatchObject({ bell: true, dedupeKey: `moving_pause_ended:${s.move.id}` });
    // The moving link no longer opens.
    expect(await Moves.loadMoveByToken(s.move.token)).toBeNull();
  });

  test('the pause does not end on its last day, or once an address came in', async () => {
    const s = await seed({ move: { move_out_date: day(-60), pause_state: 'paused', paused_at: new Date(), pause_ends_on: day(0) } });
    expect(await Moves.runMovePauseJob()).toMatchObject({ ended: 0 });
    await trx('customer_moves').where({ id: s.move.id }).update({
      pause_ends_on: day(-1), typed_address: NEW_ADDRESS, normalized_address: JSON.stringify(NEW_HOUSE), address_verdict: 'in_area',
    });
    expect(await Moves.runMovePauseJob()).toMatchObject({ ended: 0 });
    expect((await moveRow(s.move.id)).status).toBe('submitted');
  });

  test('an address added after the pause goes through Apply move, which finds nothing left to stop', async () => {
    const s = await seed();
    expect(await Moves.runMovePauseJob()).toMatchObject({ paused: 1 });

    // The customer adds the new address; the office makes the new-home estimate and the customer accepts it.
    process.env.GATE_MOVING_ESTIMATE = 'true';
    process.env.GATE_MOVING_APPLY = 'true';
    const [{ id: newHouseId }] = await trx('customer_properties').insert({
      customer_id: customerId, is_primary: false, active: true, occupancy_type: 'unknown',
      address_line1: NEW_HOUSE.line1, city: NEW_HOUSE.city, state: NEW_HOUSE.state, zip: NEW_HOUSE.zip,
    }).returning('id');
    const estimateId = crypto.randomUUID();
    await trx('estimates').insert({
      id: estimateId, customer_id: customerId, customer_name: 'Pat Sample', status: 'accepted', address: NEW_ADDRESS, property_id: newHouseId,
      accepted_at: new Date(),
      estimate_data: JSON.stringify({ inputs: { svcPest: true, pestFreq: '4' }, move: { moveId: s.move.id, estimateId, address: NEW_ADDRESS, moveOutDate: MOVE_OUT } }),
    });
    await trx('customer_moves').where({ id: s.move.id }).update({
      typed_address: NEW_ADDRESS, normalized_address: JSON.stringify(NEW_HOUSE), address_verdict: 'in_area', estimate_id: estimateId,
    });
    await insertVisit({
      scheduled_date: day(20), is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true,
      property_id: newHouseId, source_estimate_id: estimateId,
      service_address_line1: NEW_HOUSE.line1, service_address_city: NEW_HOUSE.city, service_address_state: 'FL', service_address_zip: NEW_HOUSE.zip,
    });

    const preview = await Moves.applyMovePreview(customerId, s.move.id);
    expect(preview.stops.every((stop) => stop.cancelCount === 0)).toBe(true);
    const result = await Moves.applyMove(customerId, s.move.id, { version: preview.version, actorId: null });
    expect(result).toMatchObject({ applied: true, primaryChanged: true, visitsCancelled: 0 });
    expect(await moveRow(s.move.id)).toMatchObject({ status: 'closed', closed_reason: 'applied', to_property_id: newHouseId });
    // The open visit dated between move-out and today was never cancelled by either step.
    expect(await statusOf(s.pestPastOpen)).toBe('pending');
  });
});
