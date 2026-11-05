// Apply on accept against real PostgreSQL (one rolled-back transaction per test), dark behind
// GATE_MOVING_AUTO_APPLY (owner 2026-11-04, option A): once the customer accepts the new-home
// estimate, the job applies the move through Apply move's own preview and confirm, with no office
// click; a refusal rings one office item per move and refusal; a move that is not ready, busy or
// still settling waits for the next run. Sends, charges and texts nothing: the customer sender and
// the admin bell writer are spies, and the cancellation follow-through runs for real. All names
// and addresses are synthetic.
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
jest.mock('../services/notification-service', () => {
  const actual = jest.requireActual('../services/notification-service');
  return { ...actual, notifyAdmin: jest.fn(async () => ({ id: 'n-auto-apply' })) };
});
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));

const crypto = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const NEW_HOUSE = { line1: '40 Sample Road', line2: null, city: 'Venice', state: 'FL', zip: '34285' };
const NEW_ADDRESS = '40 Sample Road, Venice, FL 34285';
const day = (n) => etDateString(addETDays(new Date(), n));
const KEEP = day(10);
const MOVE_OUT = day(20);
const MOVE_IN = day(25);
const AFTER_1 = day(40);

postgres('moving: apply on accept (live Postgres)', () => {
  // The first apply loads the property, lawn and cancellation modules.
  jest.setTimeout(30000);
  let database;
  let trx;
  let Moves;
  let Reminders;
  let Notifications;
  let Sender;
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
    for (const key of ['GATE_MOVING_FLOW', 'GATE_MOVING_ESTIMATE', 'GATE_MOVING_APPLY', 'GATE_MOVING_AUTO_APPLY', 'GATE_CUSTOMER_PROPERTIES']) OLD_ENV[key] = process.env[key];
    // Three connections: the test's transaction, the job's move fence, and a rival fence holder.
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 3 } });
    Moves = require('../services/customer-moves');
    Reminders = require('../services/appointment-reminders');
    Notifications = require('../services/notification-service');
    Sender = require('../services/messaging/send-customer-message');
  });

  const visit = (patch) => ({
    customer_id: customerId, status: 'pending', service_type: 'Quarterly Pest Control Service', ...patch,
  });
  const insertVisit = async (patch) => (await trx('scheduled_services').insert(visit(patch)).returning('id'))[0].id;

  // A customer billed per visit, moving from 1 Old Street to 40 Sample Road, who accepted the
  // new-home estimate: the old house keeps a pest series, the new home has the estimate's series.
  async function seed({ customer = {}, estimate = {} } = {}) {
    customerId = crypto.randomUUID();
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
      service_request_id: requestId, submitted_at: new Date(),
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
    const pestAfter = await insertVisit({ scheduled_date: AFTER_1, recurring_parent_id: pestRoot, recurring_pattern: 'quarterly', recurring_ongoing: true, property_id: oldHouseId });
    const newRoot = await insertVisit({
      scheduled_date: day(30), is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true,
      property_id: newHouseId, source_estimate_id: estimateId,
      service_address_line1: NEW_HOUSE.line1, service_address_city: NEW_HOUSE.city, service_address_state: 'FL', service_address_zip: NEW_HOUSE.zip,
    });
    return { move: await trx('customer_moves').where({ id: moveRow.id }).first(), estimateId, pestRoot, pestAfter, newRoot };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_MOVING_FLOW = 'true';
    process.env.GATE_MOVING_ESTIMATE = 'true';
    process.env.GATE_MOVING_APPLY = 'true';
    process.env.GATE_MOVING_AUTO_APPLY = 'true';
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
  const moveRow = (id) => trx('customer_moves').where({ id }).first();
  const autoApplyAlerts = () => Notifications.notifyAdmin.mock.calls.filter(([, , , opts]) => opts?.metadata?.kind === 'moving_auto_apply');

  test('off unless GATE_MOVING_AUTO_APPLY and GATE_MOVING_APPLY are both on', async () => {
    const s = await seed();
    delete process.env.GATE_MOVING_AUTO_APPLY;
    expect(await Moves.autoApplyAcceptedMoves()).toEqual({ skipped: true });
    process.env.GATE_MOVING_AUTO_APPLY = 'true';
    process.env.GATE_MOVING_APPLY = 'false';
    expect(await Moves.autoApplyAcceptedMoves()).toEqual({ skipped: true });
    expect((await moveRow(s.move.id)).status).toBe('submitted');
    expect(await statusOf(s.pestAfter)).toBe('pending');
  });

  test('an accepted new-home estimate is applied by the app, exactly like the office confirm, with the app named', async () => {
    const s = await seed();
    expect(await Moves.autoApplyAcceptedMoves()).toEqual({ applied: 1, waiting: 0, office: 0, failed: 0 });

    // The office confirm's own result: new home primary, old-house plan stopped after move-out, move closed.
    expect((await trx('customer_properties').where({ id: newHouseId }).first('is_primary')).is_primary).toBe(true);
    expect(await statusOf(s.pestAfter)).toBe('cancelled');
    expect(await trx('scheduled_services').where({ id: s.newRoot }).first('status', 'recurring_ongoing')).toEqual({ status: 'pending', recurring_ongoing: true });
    expect(await moveRow(s.move.id)).toMatchObject({ status: 'closed', closed_reason: 'applied', to_property_id: newHouseId, applied_by: null });
    const [summary] = await trx('activity_log').where({ customer_id: customerId, action: 'moving_applied' }).pluck('description');
    expect(summary).toMatch(/^Applied by the app after the customer accepted the new-home estimate\. New home is primary: 40 Sample Road/);
    expect((await trx('service_requests').where({ id: requestId }).first('status')).status).toBe('resolved');

    // No customer text, no fee, no office item.
    expect(Sender.sendCustomerMessage).not.toHaveBeenCalled();
    for (const [, , options] of Reminders.handleSeriesCancellation.mock.calls) expect(options.sendNotification).toBe(false);
    expect(autoApplyAlerts()).toHaveLength(0);

    // A second run finds nothing to apply.
    expect(await Moves.autoApplyAcceptedMoves()).toEqual({ applied: 0, waiting: 0, office: 0, failed: 0 });
  });

  test('old-house visits Apply never cancels ring the office before the app applies the move', async () => {
    const s = await seed();
    const oneOff = await insertVisit({ service_type: 'WDO Inspection', scheduled_date: AFTER_1, property_id: oldHouseId });
    // The item must be written first: one that does not persist leaves the move for the next run.
    Notifications.notifyAdmin.mockResolvedValueOnce({ id: null, suppressed: true });
    expect(await Moves.autoApplyAcceptedMoves()).toEqual({ applied: 0, waiting: 0, office: 0, failed: 1 });
    expect((await moveRow(s.move.id)).status).toBe('submitted');
    expect(await statusOf(s.pestAfter)).toBe('pending');

    jest.clearAllMocks();
    expect(await Moves.autoApplyAcceptedMoves()).toEqual({ applied: 1, waiting: 0, office: 0, failed: 0 });
    const left = Notifications.notifyAdmin.mock.calls.filter(([, , , opts]) => opts?.metadata?.kind === 'moving_auto_apply_left_booked');
    expect(left).toHaveLength(1);
    const [[, title, why, opts]] = left;
    expect(title).toBe("Customers — check Pat Sample's old-house visits");
    expect(why).toBe('They accepted the new-home estimate, and 1 visit at the old house stays booked.');
    expect(opts).toMatchObject({ bell: true, refreshOnDedupe: true, dedupeKey: `moving_auto_apply_left_booked:${s.move.id}` });
    expect(opts.detail).toMatch(/^Still booked at 1 Old Street, Bradenton, FL 34205: WDO Inspection .+\. Apply move never cancels these\. Cancel any that should not run\.$/);
    // The move applied; the one-time visit stays for the office.
    expect((await moveRow(s.move.id)).closed_reason).toBe('applied');
    expect(await statusOf(oneOff)).toBe('pending');
  });

  test('an estimate not accepted yet is never applied', async () => {
    const s = await seed({ estimate: { status: 'sent', accepted_at: null } });
    expect(await Moves.autoApplyAcceptedMoves()).toEqual({ applied: 0, waiting: 0, office: 0, failed: 0 });
    expect((await moveRow(s.move.id)).status).toBe('submitted');
    expect(await statusOf(s.pestAfter)).toBe('pending');
  });

  test('a refusal rings the office once per move and refusal, and the move applies once it clears', async () => {
    const s = await seed();
    // The primary property is a third house: Apply refuses before any write.
    const [{ id: thirdHouseId }] = await trx('customer_properties').insert({
      customer_id: customerId, is_primary: false, active: true, address_line1: '9 Other Lane', city: 'Sarasota', state: 'FL', zip: '34232',
    }).returning('id');
    await trx('customer_properties').where({ id: oldHouseId }).update({ is_primary: false });
    await trx('customer_properties').where({ id: thirdHouseId }).update({ is_primary: true });

    expect(await Moves.autoApplyAcceptedMoves()).toEqual({ applied: 0, waiting: 0, office: 1, failed: 0 });
    expect(await statusOf(s.pestAfter)).toBe('pending');
    const [[category, title, why, opts]] = autoApplyAlerts();
    expect(category).toBe('service');
    expect(title).toBe("Customers — apply Pat Sample's move by hand");
    expect(why).toBe('They accepted the new-home estimate, but the app could not apply the move; the item says why.');
    expect(opts).toMatchObject({ bell: true, dedupeKey: `moving_auto_apply_primary_changed:${s.move.id}` });
    expect(opts.detail).toBe("The customer's primary property is not the house they are leaving. Check the properties first. Then press Apply move on the Moving card.");

    // The same refusal on the next run carries the same key (the alert writer dedupes it for good).
    jest.clearAllMocks();
    expect(await Moves.autoApplyAcceptedMoves()).toMatchObject({ office: 1 });
    expect(autoApplyAlerts().map(([, , , o]) => o.dedupeKey)).toEqual([`moving_auto_apply_primary_changed:${s.move.id}`]);

    // The office fixes the properties: the next run applies.
    await trx('customer_properties').where({ id: thirdHouseId }).update({ is_primary: false });
    await trx('customer_properties').where({ id: oldHouseId }).update({ is_primary: true });
    expect(await Moves.autoApplyAcceptedMoves()).toMatchObject({ applied: 1, office: 0 });
    expect((await moveRow(s.move.id)).closed_reason).toBe('applied');
  });

  test('a visit under way at the old house waits, with no office item', async () => {
    const s = await seed();
    await insertVisit({ scheduled_date: day(21), status: 'on_site', recurring_parent_id: s.pestRoot, recurring_pattern: 'quarterly', property_id: oldHouseId });
    expect(await Moves.autoApplyAcceptedMoves()).toEqual({ applied: 0, waiting: 1, office: 0, failed: 0 });
    expect(autoApplyAlerts()).toHaveLength(0);
    expect((await moveRow(s.move.id)).status).toBe('submitted');
  });

  test('right after the accept a new plan not saved yet waits; an hour later it rings the office', async () => {
    const s = await seed();
    await trx('scheduled_services').where({ id: s.newRoot }).del();
    expect(await Moves.autoApplyAcceptedMoves()).toEqual({ applied: 0, waiting: 1, office: 0, failed: 0 });
    expect(autoApplyAlerts()).toHaveLength(0);

    await trx('estimates').where({ id: s.estimateId }).update({ accepted_at: new Date(Date.now() - 2 * 3600e3) });
    expect(await Moves.autoApplyAcceptedMoves()).toEqual({ applied: 0, waiting: 0, office: 1, failed: 0 });
    const [[, , , opts]] = autoApplyAlerts();
    expect(opts.dedupeKey).toBe(`moving_auto_apply_no_new_plan:${s.move.id}`);
    expect(await statusOf(s.pestAfter)).toBe('pending');
  });

  test('a running Apply or customer update on the same move (the move fence) makes the job wait', async () => {
    const s = await seed();
    const other = await database.client.acquireConnection();
    try {
      await other.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2::text))', ['customer-move-apply', s.move.id]);
      expect(await Moves.autoApplyAcceptedMoves()).toEqual({ applied: 0, waiting: 1, office: 0, failed: 0 });
      expect((await moveRow(s.move.id)).status).toBe('submitted');
    } finally {
      await other.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2::text))', ['customer-move-apply', s.move.id]);
      await database.client.releaseConnection(other);
    }
    expect(await Moves.autoApplyAcceptedMoves()).toMatchObject({ applied: 1, waiting: 0 });
  });
});
