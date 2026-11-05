// The app-made new-home estimate against real PostgreSQL (one rolled-back transaction per test),
// dark behind GATE_MOVING_AUTO_ESTIMATE (owner 2026-11-04, option A): a submitted in-area move of a
// pest-only customer billed per visit gets the office's own new-home estimate, priced by the server
// on the county facts of the new home, once, as a draft with the $99 waived; free refusals reach the
// office before any lookup; a county record that does not confirm the home, a price outside the band,
// or an attempt that never finished go to the office with one ringing item. The property lookup is a
// stub (no network, no spend); the admin bell writer is a spy; nothing is sent. All names and
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
jest.mock('../routes/property-lookup-v2', () => ({ ...jest.requireActual('../routes/property-lookup-v2'), performPropertyLookup: jest.fn() }));
jest.mock('../services/notification-service', () => {
  const actual = jest.requireActual('../services/notification-service');
  return { ...actual, notifyAdmin: jest.fn(async () => ({ id: 'n-auto-estimate' })) };
});
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/address-validation', () => ({ ...jest.requireActual('../services/address-validation'), validateAddress: jest.fn() }));
jest.mock('../services/short-url', () => ({ ...jest.requireActual('../services/short-url'), shortenOrPassthrough: jest.fn(async (url) => url) }));

const crypto = require('crypto');

const NEW_HOUSE = { line1: '40 Sample Road', line2: null, city: 'Venice', state: 'FL', zip: '34285' };
const NEW_ADDRESS = '40 Sample Road, Venice, FL 34285';

postgres('moving: the app-made new-home estimate (live Postgres)', () => {
  // The first save loads the estimate, pricing and lookup modules.
  jest.setTimeout(60000);
  let database;
  let trx;
  let Auto;
  let Lookup;
  let Notifications;
  let Sender;
  let customerId;
  let oldHouseId;
  const OLD_ENV = {};

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    for (const key of ['GATE_MOVING_FLOW', 'GATE_MOVING_ESTIMATE', 'GATE_MOVING_AUTO_ESTIMATE']) OLD_ENV[key] = process.env[key];
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    Auto = require('../services/moving-auto-estimate');
    Lookup = require('../routes/property-lookup-v2');
    Notifications = require('../services/notification-service');
    Sender = require('../services/messaging/send-customer-message');
  });

  // The county record of a single-family home (the lead draft suite's own shape).
  const countyLookup = (record = {}) => ({
    propertyRecord: {
      propertyType: 'Single Family',
      squareFootage: 1850,
      stories: 1,
      yearBuilt: 1998,
      _source: 'county',
      _parcel: { county: 'Sarasota', parcelId: '0000000001', lotSqft: 9200, landUseDescription: 'SINGLE FAMILY DETACHED' },
      _fieldEvidence: { squareFootage: { sourceType: 'county' } },
      ...record,
    },
    enriched: {},
  });

  // A customer billed per visit with one monthly pest plan at 1 Old Street, priced by an accepted
  // estimate, who sent a move to 40 Sample Road (in our area) with no estimate yet.
  async function seed({ customer = {}, inputs = {}, plan = {}, move = {} } = {}) {
    customerId = crypto.randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Pat', last_name: 'Sample', phone: '+19415550188', email: 'pat@example.invalid',
      address_line1: '1 Old Street', city: 'Bradenton', state: 'FL', zip: '34205', billing_mode: 'per_application', ...customer,
    });
    [{ id: oldHouseId }] = await trx('customer_properties').insert({
      customer_id: customerId, is_primary: true, active: true, address_line1: '1 Old Street', city: 'Bradenton', state: 'FL', zip: '34205',
    }).returning('id');
    const sourceId = crypto.randomUUID();
    await trx('estimates').insert({
      id: sourceId, customer_id: customerId, customer_name: 'Pat Sample', status: 'accepted', address: '1 Old Street, Bradenton, FL 34205',
      property_id: oldHouseId, accepted_at: new Date('2026-01-10T15:00:00Z'),
      estimate_data: JSON.stringify({
        inputs: { svcPest: true, pestFreq: '4', manualDiscountType: 'NONE', ...inputs },
        engineRequest: { profile: { homeSqFt: 1600, lotSqFt: 8000, stories: 1, propertyType: 'single_family' }, selectedServices: ['PEST'], options: { pestFreq: 4, roachType: 'REGULAR' } },
      }),
    });
    const root = (await trx('scheduled_services').insert({
      customer_id: customerId, status: 'completed', service_type: 'Monthly Pest Control Service', scheduled_date: '2026-10-01',
      is_recurring: true, recurring_pattern: 'monthly', recurring_ongoing: true, property_id: oldHouseId, estimated_price: 50, ...plan,
    }).returning('id'))[0].id;
    const [{ id: requestId }] = await trx('service_requests').insert({
      customer_id: customerId, category: 'moving', source: 'moving_page', subject: 'Moving: Venice', status: 'new',
    }).returning('id');
    const [row] = await trx('customer_moves').insert({
      customer_id: customerId, token: crypto.randomBytes(24).toString('hex'), status: 'submitted', from_property_id: oldHouseId,
      typed_address: NEW_ADDRESS, normalized_address: JSON.stringify(NEW_HOUSE), address_verdict: 'in_area',
      move_out_date: '2026-11-20', move_in_date: '2026-11-25', service_request_id: requestId, submitted_at: new Date(), ...move,
    }).returning('*');
    return { move: row, root, sourceId };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_MOVING_FLOW = 'true';
    process.env.GATE_MOVING_ESTIMATE = 'true';
    process.env.GATE_MOVING_AUTO_ESTIMATE = 'true';
    Lookup.performPropertyLookup.mockResolvedValue(countyLookup());
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

  const moveRow = (id) => trx('customer_moves').where({ id }).first();
  const officeItems = () => Notifications.notifyAdmin.mock.calls.filter(([, , , opts]) => opts?.metadata?.kind === 'moving_auto_estimate_office');
  const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

  test('off unless GATE_MOVING_AUTO_ESTIMATE and GATE_MOVING_ESTIMATE are both on', async () => {
    const s = await seed();
    delete process.env.GATE_MOVING_AUTO_ESTIMATE;
    expect(await Auto.runMoveAutoEstimateJob()).toEqual({ skipped: true });
    process.env.GATE_MOVING_AUTO_ESTIMATE = 'true';
    delete process.env.GATE_MOVING_ESTIMATE;
    expect(await Auto.runMoveAutoEstimateJob()).toEqual({ skipped: true });
    expect(Lookup.performPropertyLookup).not.toHaveBeenCalled();
    expect(await moveRow(s.move.id)).toMatchObject({ auto_estimate_at: null, estimate_id: null });
  });

  test('a pest-only mover gets the new-home estimate once: server-priced on the county facts, the $99 waived, a draft, no message', async () => {
    // First the price band: a current visit price far below the engine's sends it to the office and names both prices.
    const s = await seed({ plan: { estimated_price: 1 } });
    expect(await Auto.runMoveAutoEstimateJob()).toEqual({ drafted: 0, office: 1, skipped: 0, failed: 0 });
    const [[, title, why, opts]] = officeItems();
    expect(title).toBe("Customers — price Pat Sample's new home by hand");
    expect(why).toBe('The app did not make their new-home estimate; the item says why.');
    expect(opts).toMatchObject({ bell: true, dedupeKey: `moving_auto_estimate_office:${s.move.id}` });
    const price = Number(/The new visit price \(\$(\d+\.\d\d)\) is more than 25% above the current one \(\$1\.00\)/.exec(opts.detail)[1]);
    expect(price).toBeGreaterThan(0);
    expect(await moveRow(s.move.id)).toMatchObject({ auto_estimate_state: 'office', estimate_id: null });
    expect(Lookup.performPropertyLookup).toHaveBeenCalledTimes(1);
    expect(Lookup.performPropertyLookup.mock.calls[0][0]).toBe(NEW_ADDRESS);

    // The same move with its real current price inside the band: the estimate is drafted.
    jest.clearAllMocks();
    await trx('scheduled_services').where({ id: s.root }).update({ estimated_price: price });
    await trx('customer_moves').where({ id: s.move.id }).update({ auto_estimate_at: null, auto_estimate_state: null, auto_estimate_note: null });
    expect(await Auto.runMoveAutoEstimateJob()).toEqual({ drafted: 1, office: 0, skipped: 0, failed: 0 });
    const after = await moveRow(s.move.id);
    expect(after.auto_estimate_state).toBe('drafted');
    const estimate = await trx('estimates').where({ id: after.estimate_id }).first();
    expect(estimate).toMatchObject({ status: 'draft', pricing_authority: 'SERVER', customer_id: customerId, address: NEW_ADDRESS });
    const data = parsed(estimate.estimate_data);
    expect(data.move).toMatchObject({ moveId: s.move.id, estimateId: estimate.id });
    expect(data.operatorPriceAdjustment).toMatchObject({ waiveSetupFee: true });
    expect(data.engineInputs).toMatchObject({ homeSqFt: 1850, services: { pest: { frequency: 'monthly' } } });
    expect(data.automation.moveAutoEstimate).toMatchObject({ moveId: s.move.id, sourceEstimateId: s.sourceId, cadence: 'monthly', currentVisitPrice: price, homeSqFt: 1850, lotSqFt: 9200 });
    expect(Number(estimate.annual_total)).toBeCloseTo(price * 12, 0);
    expect(officeItems()).toHaveLength(0);
    expect(Sender.sendCustomerMessage).not.toHaveBeenCalled();

    // Once: a second run finds nothing to do, and spends nothing.
    jest.clearAllMocks();
    expect(await Auto.runMoveAutoEstimateJob()).toEqual({ drafted: 0, office: 0, skipped: 0, failed: 0 });
    expect(Lookup.performPropertyLookup).not.toHaveBeenCalled();
  });

  test.each([
    ['a tenant account', { customer: { contact_role: 'tenant' } }, 'This is a tenant account'],
    ['termite on the plan', { plan: { service_type: 'Termite Bait Monitoring' } }, 'termite, misting or palm'],
    ['a discount on the earlier estimate', { inputs: { manualDiscountType: 'PERCENT' } }, 'The earlier estimate had a discount'],
    ['lawn on the earlier estimate', { inputs: { svcLawn: true } }, 'one pest service'],
    ['a schedule it cannot read', { plan: { recurring_pattern: 'every_6_weeks' } }, 'visit schedule'],
    ['no current visit price', { plan: { estimated_price: null } }, 'current visit price'],
    ['prepay billing', { customer: { billing_mode: 'annual_prepay' } }, 'prepays for the year'],
  ])('%s goes to the office before any lookup', async (_label, variant, words) => {
    const s = await seed(variant);
    expect(await Auto.runMoveAutoEstimateJob()).toEqual({ drafted: 0, office: 1, skipped: 0, failed: 0 });
    expect(Lookup.performPropertyLookup).not.toHaveBeenCalled();
    const after = await moveRow(s.move.id);
    expect(after).toMatchObject({ auto_estimate_state: 'office', estimate_id: null });
    expect(after.auto_estimate_note).toContain(words);
    expect(officeItems()).toHaveLength(1);
    expect(await trx('activity_log').where({ customer_id: customerId, action: 'moving_auto_estimate_office' }).count({ n: '*' }).first()).toEqual({ n: '1' });
  });

  test('a county record that does not confirm a single-family home goes to the office after its one lookup', async () => {
    const s = await seed();
    Lookup.performPropertyLookup.mockResolvedValue(countyLookup({ propertyType: 'Condo' }));
    expect(await Auto.runMoveAutoEstimateJob()).toEqual({ drafted: 0, office: 1, skipped: 0, failed: 0 });
    expect((await moveRow(s.move.id)).auto_estimate_note).toBe('The county record does not confirm the new home\'s size, so the price would rest on a guess.');
    expect(await Auto.runMoveAutoEstimateJob()).toMatchObject({ office: 0 });
    expect(Lookup.performPropertyLookup).toHaveBeenCalledTimes(1);
  });

  test('a claimed attempt that never finished goes to the office, with no second lookup', async () => {
    const s = await seed({ move: { auto_estimate_at: new Date(Date.now() - 3600e3) } });
    expect(await Auto.runMoveAutoEstimateJob()).toEqual({ drafted: 0, office: 1, skipped: 0, failed: 0 });
    expect((await moveRow(s.move.id)).auto_estimate_note).toBe('The automatic price for the new home did not finish.');
    expect(Lookup.performPropertyLookup).not.toHaveBeenCalled();
  });

  test('after the old-house stop ran, the plan it stopped still gives the schedule and the price', async () => {
    const s = await seed({ plan: { recurring_ongoing: false } });
    const child = (await trx('scheduled_services').insert({
      customer_id: customerId, status: 'cancelled', service_type: 'Monthly Pest Control Service', scheduled_date: '2026-12-01',
      recurring_parent_id: s.root, recurring_pattern: 'monthly', property_id: oldHouseId,
    }).returning('id'))[0].id;
    await trx('job_status_history').insert({
      job_id: child, from_status: 'pending', to_status: 'cancelled', transitioned_at: new Date(),
      notes: `Customer moved out; plan stopped after the move-out date (moving flow, move pause ${s.move.id})`,
    });
    const facts = await Auto._private.freeChecks(s.move);
    expect(facts.code).toBeUndefined();
    expect(facts).toMatchObject({ cadence: { frequency: 'monthly', visits: 12 }, currentPrice: 50 });
    expect(facts.pest).toMatchObject({ frequency: 'monthly' });
  });

  test('a new address after a finished attempt clears it, so the new address gets its own; the same address does not', async () => {
    const Moves = require('../services/customer-moves');
    const { validateAddress, STATUSES } = require('../services/address-validation');
    const s = await seed({ customer: { contact_role: 'tenant' } });
    expect(await Auto.runMoveAutoEstimateJob()).toMatchObject({ office: 1 });
    const resubmit = async (street) => {
      validateAddress.mockResolvedValueOnce({
        status: STATUSES.VALIDATED_ACCEPT, inServiceArea: true,
        normalized: { street_line_1: street, city: 'Venice', state: 'FL', postal_code: '34285' },
      });
      const check = await Moves.checkMoveAddress(await moveRow(s.move.id), `${street}, Venice FL`);
      await Moves.submitMove(await moveRow(s.move.id), { checkId: check.checkId, moveOutDate: '2026-11-20' });
      return moveRow(s.move.id);
    };
    // The same house again: the finished attempt stands.
    expect(await resubmit('40 Sample Road')).toMatchObject({ auto_estimate_state: 'office' });
    // Another house: cleared, so the next run tries the new address.
    expect(await resubmit('12 Other Road')).toMatchObject({ auto_estimate_at: null, auto_estimate_state: null, auto_estimate_note: null });
  });

  test('a unit address goes to the office before any lookup', async () => {
    const s = await seed({ move: { typed_address: '40 Sample Road Apt 4, Venice, FL 34285', normalized_address: JSON.stringify({ ...NEW_HOUSE, line2: 'Apt 4' }) } });
    expect(await Auto.runMoveAutoEstimateJob()).toMatchObject({ office: 1 });
    expect(Lookup.performPropertyLookup).not.toHaveBeenCalled();
    expect((await moveRow(s.move.id)).auto_estimate_note).toContain('unit number');
  });
});
