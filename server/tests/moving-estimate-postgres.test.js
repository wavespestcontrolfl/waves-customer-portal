// Moving PR B1 against real PostgreSQL (one rolled-back transaction per test), dark behind
// GATE_MOVING_ESTIMATE: which moves may get a new-home estimate, the $99 setup-fee waiver and
// the move link the estimate save stamps, the address lock on a revise, the Multi-Home count
// and the move a converted estimate places its first visit from. Sends, charges and texts
// nothing. All names and addresses are synthetic.
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
// The paid address check, the short link and the alert writer are stubbed for the resubmit test.
jest.mock('../services/address-validation', () => {
  const actual = jest.requireActual('../services/address-validation');
  return { ...actual, validateAddress: jest.fn() };
});
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url) }));
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: jest.fn(async () => ({ id: 'n1' })) };
});

const crypto = require('crypto');

const NEW_HOUSE = { line1: '40 Sample Road', line2: null, city: 'Venice', state: 'FL', zip: '34285' };
const NEW_ADDRESS = '40 Sample Road, Venice, FL 34285';
const ADMIN = { id: crypto.randomUUID(), name: 'Sample Admin' };

postgres('moving PR B1: new-home estimate (live Postgres)', () => {
  let database;
  let trx;
  let Moves;
  let Persistence;
  let Linkage;
  let customerId;
  let oldHouseId;
  const OLD_ENV = {};

  const gatesOn = () => {
    process.env.GATE_MOVING_FLOW = 'true';
    process.env.GATE_MOVING_ESTIMATE = 'true';
  };

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    for (const key of ['GATE_MOVING_FLOW', 'GATE_MOVING_ESTIMATE', 'GATE_CUSTOMER_PROPERTIES']) OLD_ENV[key] = process.env[key];
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    Moves = require('../services/customer-moves');
    Persistence = require('../services/admin-estimate-persistence');
    Linkage = require('../services/estimate-property-linkage');
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    gatesOn();
    trx = await database.transaction();
    mockConnection = trx;
    customerId = crypto.randomUUID();
    await trx('technicians').insert({ id: ADMIN.id, name: ADMIN.name, role: 'admin', employment_type: '1099', active: true });
    await trx('customers').insert({
      id: customerId, first_name: 'Pat', last_name: 'Sample', phone: '+19415550188', email: 'pat@example.invalid',
      address_line1: '1 Old Street', city: 'Bradenton', state: 'FL', zip: '34205', billing_mode: 'per_application',
    });
    [{ id: oldHouseId }] = await trx('customer_properties').insert({
      customer_id: customerId, is_primary: true, active: true, address_line1: '1 Old Street', city: 'Bradenton', state: 'FL', zip: '34205',
    }).returning('id');
    const visit = (service_type, extra = {}) => ({
      customer_id: customerId, scheduled_date: '2026-12-01', service_type, status: 'pending', is_recurring: true, recurring_ongoing: true, ...extra,
    });
    await trx('scheduled_services').insert([
      visit('Quarterly Pest Control Service', { recurring_pattern: 'quarterly' }),
      visit('Termite Bait Monitoring', { recurring_pattern: 'quarterly' }),
      visit('Mosquito Misting Service', { recurring_pattern: 'monthly' }),
      visit('Re-service Callback', { is_callback: true }),
    ]);
  });

  afterEach(async () => {
    await trx.rollback();
    for (const [key, value] of Object.entries(OLD_ENV)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  afterAll(async () => { if (database) await database.destroy(); });

  const insertMove = async (patch = {}) => {
    const [row] = await trx('customer_moves').insert({
      customer_id: customerId,
      token: crypto.randomBytes(24).toString('hex'),
      status: 'submitted',
      from_property_id: null,
      normalized_address: JSON.stringify(NEW_HOUSE),
      address_verdict: 'in_area',
      move_out_date: '2026-11-20',
      move_in_date: '2026-11-25',
      submitted_at: new Date(),
      ...patch,
    }).returning('*');
    return row;
  };
  const acceptedEstimate = async (patch = {}) => {
    const [row] = await trx('estimates').insert({
      customer_id: customerId, customer_name: 'Pat Sample', status: 'accepted', address: '1 Old Street, Bradenton, FL 34205',
      estimate_data: JSON.stringify({ inputs: { svcPest: true, pestFreq: '4' } }), accepted_at: new Date('2026-01-10T15:00:00Z'), ...patch,
    }).returning('id');
    return row.id || row;
  };
  const body = (move, patch = {}) => ({
    address: NEW_ADDRESS, customerName: 'Pat Sample', customerPhone: '(941) 555-0188', customerEmail: 'pat@example.invalid',
    customerId, moveId: move.id, monthlyTotal: 60, annualTotal: 720, onetimeTotal: 0, waveguardTier: 'Bronze',
    showOneTimeOption: false, billByInvoice: false,
    estimateData: { inputs: { address: NEW_ADDRESS, svcPest: true }, result: { total: 60 } }, ...patch,
  });
  const NO_INPUTS = async () => ({ recomputed: false, reason: 'NO_INPUTS' });
  const create = (move, patch = {}, opts = {}) => Persistence.createOrReuseAdminEstimate({
    database: trx, body: body(move, patch), technicianId: ADMIN.id, technician: ADMIN, recompute: NO_INPUTS, moveAllowed: true, ...opts,
  });
  const storedData = async (id) => {
    const row = await trx('estimates').where({ id }).first('estimate_data');
    return typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : row.estimate_data;
  };

  describe('which moves may get a new-home estimate', () => {
    test('a submitted, in-area move of a per-visit customer can start one', async () => {
      const move = await insertMove();
      expect(await Moves.newHomeAction(move)).toEqual({ action: 'start', estimateId: null, reason: null });
    });

    test('nothing shows with the gate off or before the customer submits', async () => {
      const move = await insertMove();
      delete process.env.GATE_MOVING_ESTIMATE;
      expect(await Moves.newHomeAction(move)).toBeNull();
      gatesOn();
      delete process.env.GATE_MOVING_FLOW;
      expect(await Moves.newHomeAction(move)).toBeNull();
      gatesOn();
      expect(await Moves.newHomeAction({ ...move, status: 'open' })).toBeNull();
    });

    test('an out-of-area or incomplete address, a prepay or a monthly plan is refused with a reason', async () => {
      const outside = await insertMove({ address_verdict: 'out_of_area' });
      expect(await Moves.newHomeAction(outside)).toMatchObject({ action: 'blocked', reason: Moves.NEW_HOME_REFUSALS.out_of_area });
      await trx('customer_moves').where({ id: outside.id }).del();

      const partial = await insertMove({ normalized_address: JSON.stringify({ ...NEW_HOUSE, zip: null }) });
      expect(await Moves.newHomeAction(partial)).toMatchObject({ action: 'blocked', reason: Moves.NEW_HOME_REFUSALS.no_address });
      await trx('customer_moves').where({ id: partial.id }).del();

      const move = await insertMove();
      await trx('customers').where({ id: customerId }).update({ billing_mode: 'annual_prepay' });
      expect(await Moves.newHomeAction(move)).toMatchObject({ action: 'blocked', reason: Moves.NEW_HOME_REFUSALS.prepay });
      await trx('customers').where({ id: customerId }).update({ billing_mode: 'monthly_membership' });
      expect(await Moves.newHomeAction(move)).toMatchObject({ action: 'blocked', reason: Moves.NEW_HOME_REFUSALS.monthly });
    });

    test('the billing code\'s own lane decides: a legacy row with no mode, a real tier and a monthly rate is a monthly member', async () => {
      const move = await insertMove();
      await trx('customers').where({ id: customerId }).update({ billing_mode: null, waveguard_tier: 'Gold', monthly_rate: 60 });
      expect(await Moves.newHomeAction(move)).toMatchObject({ action: 'blocked', reason: Moves.NEW_HOME_REFUSALS.monthly });
      await trx('customers').where({ id: customerId }).update({ waveguard_tier: null });
      expect(await Moves.newHomeAction(move)).toMatchObject({ action: 'start' });
      await trx('customers').where({ id: customerId }).update({ billing_mode: 'one_time' });
      expect(await Moves.newHomeAction(move)).toMatchObject({ action: 'blocked', reason: Moves.NEW_HOME_REFUSALS.no_plan });
    });

    test('a live prepaid visit refuses it even when the billing mode says per visit', async () => {
      const move = await insertMove();
      const [{ id: termId }] = await trx('annual_prepay_terms').insert({
        customer_id: customerId, term_start: '2026-06-01', term_end: '2027-05-31',
      }).returning('id');
      await trx('scheduled_services').where({ customer_id: customerId, service_type: 'Quarterly Pest Control Service' })
        .update({ annual_prepay_term_id: termId });
      expect(await Moves.newHomeAction(move)).toMatchObject({ action: 'blocked', reason: Moves.NEW_HOME_REFUSALS.prepay });
    });
  });

  describe('estimate source', () => {
    test('copies the old house\'s accepted estimate and lists the plan, leaving termite and misting out', async () => {
      const [{ id: otherHouse }] = await trx('customer_properties').insert({
        customer_id: customerId, is_primary: false, active: true, address_line1: '9 Beach Lane', city: 'Venice', state: 'FL', zip: '34285',
      }).returning('id');
      const oldHouseEstimate = await acceptedEstimate({ property_id: oldHouseId });
      await acceptedEstimate({
        property_id: otherHouse, address: '9 Beach Lane, Venice, FL 34285', accepted_at: new Date('2026-06-01T15:00:00Z'),
        estimate_data: JSON.stringify({ inputs: { svcLawn: true } }),
      });
      await trx('scheduled_services').insert({
        customer_id: customerId, scheduled_date: '2026-12-01', service_type: 'Palm Tree Injection', status: 'pending',
        is_recurring: true, recurring_ongoing: true, recurring_pattern: 'semi_annual',
      });
      const move = await insertMove({ from_property_id: oldHouseId });
      const source = await Moves.moveEstimateSource(customerId, move.id);
      expect(source.move).toEqual({ id: move.id, address: NEW_ADDRESS, moveOutDate: '2026-11-20', moveInDate: '2026-11-25' });
      expect(source.customer).toEqual({ id: customerId, name: 'Pat Sample', phone: '+19415550188', email: 'pat@example.invalid' });
      expect(source.source).toEqual({ estimateId: oldHouseEstimate, inputs: { svcPest: true, pestFreq: '4' } });
      expect(source.planServices).toEqual(expect.arrayContaining([
        { name: 'Quarterly Pest Control Service', frequency: 'quarterly' },
        { name: 'Termite Bait Monitoring', frequency: 'quarterly' },
        { name: 'Mosquito Misting Service', frequency: 'monthly' },
      ]));
      expect(source.planServices.map((s) => s.name)).not.toContain('Re-service Callback');
      expect(source.leftOut).toEqual([
        { name: 'Mosquito Misting Service', reason: 'The misting system stays with the old house.' },
        { name: 'Palm Tree Injection', reason: 'Palm treatments depend on the palms at the new home. Add them after counting.' },
        { name: 'Termite Bait Monitoring', reason: 'Termite stations and treatments stay with the old house.' },
      ]);
    });

    test('a customer with no builder estimate gets source null; another customer\'s move is not found', async () => {
      const move = await insertMove();
      expect((await Moves.moveEstimateSource(customerId, move.id)).source).toBeNull();
      await expect(Moves.moveEstimateSource(crypto.randomUUID(), move.id)).rejects.toMatchObject({ code: 'not_found', status: 404 });
      delete process.env.GATE_MOVING_ESTIMATE;
      await expect(Moves.moveEstimateSource(customerId, move.id)).rejects.toMatchObject({ code: 'gate_off', status: 404 });
    });
  });

  describe('the estimate save', () => {
    test('stamps the move and the waiver before pricing, links the move and records the house being left', async () => {
      const move = await insertMove({ from_property_id: null });
      const seen = [];
      const spy = async (estimateData) => { seen.push(JSON.parse(JSON.stringify(estimateData))); return { recomputed: false, reason: 'NO_INPUTS' }; };
      const { estimate } = await create(move, {}, { recompute: spy });
      expect(seen[0].operatorPriceAdjustment).toMatchObject({ waiveSetupFee: true, type: null, value: 0 });
      expect(seen[0].move).toEqual({ moveId: move.id, estimateId: estimate.id, address: NEW_ADDRESS, moveOutDate: '2026-11-20', moveInDate: '2026-11-25' });
      const data = await storedData(estimate.id);
      expect(data.move).toEqual({ moveId: move.id, estimateId: estimate.id, address: NEW_ADDRESS, moveOutDate: '2026-11-20', moveInDate: '2026-11-25' });
      expect(data.operatorPriceAdjustment).toMatchObject({ waiveSetupFee: true });
      expect(data.operatorPriceAdjustment.internalReason).toMatch(/moving/i);
      const after = await trx('customer_moves').where({ id: move.id }).first();
      expect(after.estimate_id).toBe(estimate.id);
      expect(after.from_property_id).toBe(oldHouseId);
      expect(await Moves.newHomeAction(after)).toEqual({ action: 'open', estimateId: estimate.id, reason: null });
      await expect(Moves.moveEstimateSource(customerId, move.id)).rejects.toMatchObject({ code: 'estimate_exists', estimateId: estimate.id });
    });

    test('refuses a second live estimate, but a declined one frees the move', async () => {
      const move = await insertMove();
      const { estimate } = await create(move);
      await expect(create(move)).rejects.toMatchObject({ statusCode: 409, code: 'estimate_exists' });
      await trx('estimates').where({ id: estimate.id }).update({ status: 'declined' });
      const { estimate: second } = await create(move);
      expect((await trx('customer_moves').where({ id: move.id }).first()).estimate_id).toBe(second.id);
    });

    test('refuses a technician, another address, a group, a refused move and the gate off', async () => {
      const move = await insertMove();
      await expect(create(move, {}, { moveAllowed: false })).rejects.toMatchObject({ statusCode: 403 });
      await expect(create(move, { address: '1 Old Street, Bradenton, FL 34205' })).rejects.toMatchObject({ statusCode: 409, code: 'move_address' });
      await expect(create(move, { groupWithEstimateId: crypto.randomUUID() })).rejects.toMatchObject({ statusCode: 400 });
      await trx('customers').where({ id: customerId }).update({ billing_mode: 'annual_prepay' });
      await expect(create(move)).rejects.toMatchObject({ statusCode: 409, code: 'prepay' });
      await trx('customers').where({ id: customerId }).update({ billing_mode: 'per_application' });
      delete process.env.GATE_MOVING_ESTIMATE;
      await expect(create(move)).rejects.toMatchObject({ statusCode: 409, code: 'gate_off' });
      expect((await trx('customer_moves').where({ id: move.id }).first()).estimate_id).toBeNull();
    });

    test('a new-home estimate is never a multi-property group anchor', async () => {
      const move = await insertMove();
      const { estimate } = await create(move);
      await expect(Persistence.createOrReuseAdminEstimate({
        database: trx,
        body: body(move, { moveId: undefined, groupWithEstimateId: estimate.id, address: '9 Beach Lane, Venice, FL 34285' }),
        technicianId: ADMIN.id, technician: ADMIN, recompute: NO_INPUTS,
      })).rejects.toMatchObject({ statusCode: 400 });
      expect((await trx('estimates').where({ id: estimate.id }).first('estimate_group_id')).estimate_group_id).toBeNull();
    });

    test('a browser cannot invent a move stamp', async () => {
      const move = await insertMove();
      const { estimate } = await create(move, {
        moveId: undefined,
        estimateData: { inputs: { address: NEW_ADDRESS }, result: { total: 60 }, move: { moveId: move.id } },
      });
      const data = await storedData(estimate.id);
      expect(data.move).toBeUndefined();
      expect(data.operatorPriceAdjustment).toBeUndefined();
      expect((await trx('customer_moves').where({ id: move.id }).first()).estimate_id).toBeNull();
    });

    test('a revise keeps the move and the waiver the browser does not send, and cannot change the address', async () => {
      const move = await insertMove();
      const { estimate } = await create(move);
      const revise = (patch) => Persistence.reviseAdminEstimate({
        database: trx, estimateId: estimate.id, body: body(move, { moveId: undefined, ...patch }), technicianId: ADMIN.id, technician: ADMIN, recompute: NO_INPUTS,
      });
      await revise({ notes: 'Revised' });
      const data = await storedData(estimate.id);
      expect(data.move).toEqual({ moveId: move.id, estimateId: estimate.id, address: NEW_ADDRESS, moveOutDate: '2026-11-20', moveInDate: '2026-11-25' });
      expect(data.operatorPriceAdjustment).toMatchObject({ waiveSetupFee: true });
      await expect(revise({ address: '1 Old Street, Bradenton, FL 34205' })).rejects.toMatchObject({ statusCode: 409, code: 'move_address_changed' });
      const otherCustomer = crypto.randomUUID();
      await trx('customers').insert({ id: otherCustomer, first_name: 'Sam', last_name: 'Sample', phone: '+19415550199' });
      // Another customer: the general linked-customer guard refuses first; the
      // move binding repeats the check on the locked row.
      await expect(revise({ customerId: otherCustomer })).rejects.toMatchObject({ statusCode: 409 });
      expect((await trx('estimates').where({ id: estimate.id }).first('customer_id')).customer_id).toBe(customerId);
      // The waiver stays with the estimate after the gate goes off: the price the customer saw does not change.
      delete process.env.GATE_MOVING_ESTIMATE;
      await revise({ notes: 'Gate off' });
      expect((await storedData(estimate.id)).operatorPriceAdjustment).toMatchObject({ waiveSetupFee: true });
    });
  });

  describe('a resubmitted move', () => {
    const NOW = new Date('2026-11-02T15:00:00Z');
    const resubmit = async (moveId, typed, street) => {
      const { validateAddress, STATUSES } = require('../services/address-validation');
      validateAddress.mockResolvedValueOnce({
        status: STATUSES.VALIDATED_ACCEPT, inServiceArea: true,
        normalized: { street_line_1: street, city: 'Venice', state: 'FL', postal_code: '34285' },
      });
      const fresh = await trx('customer_moves').where({ id: moveId }).first();
      const check = await Moves.checkMoveAddress(fresh, typed, { now: NOW });
      const again = await trx('customer_moves').where({ id: moveId }).first();
      await Moves.submitMove(again, { checkId: check.checkId, moveOutDate: '2026-11-20', moveInDate: '2026-11-26' }, { now: NOW });
      return trx('customer_moves').where({ id: moveId }).first();
    };

    test('keeps the estimate for the same house and drops it for another house, telling the office', async () => {
      const move = await insertMove();
      const { estimate } = await create(move);
      const same = await resubmit(move.id, '40 Sample Road, Venice FL 34285', '40 Sample Road');
      expect(same.estimate_id).toBe(estimate.id);
      expect(await Moves.moveForEstimate(estimate.id)).toMatchObject({ id: move.id, move_in_date: '2026-11-26' });

      const other = await resubmit(move.id, '52 Other Lane, Venice FL 34285', '52 Other Lane');
      const request = await trx('service_requests').where({ id: other.service_request_id }).first();
      expect(request.description).toMatch(/can no longer open or accept that estimate/);
      // The old estimate leaves every customer surface through the shared estimate guard.
      const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
      expect(await callSideBlockForEstimateData(trx, await storedData(estimate.id), { estimateStatus: 'draft' })).toBe('move_address_changed');
      // The card offers a new estimate, and its save replaces the link.
      expect(await Moves.newHomeAction(other)).toEqual({ action: 'start', estimateId: null, reason: null });
      const { estimate: replacement } = await create(move, {
        address: '52 Other Lane, Venice, FL 34285',
        estimateData: { inputs: { address: '52 Other Lane, Venice, FL 34285', svcPest: true }, result: { total: 60 } },
      });
      expect((await trx('customer_moves').where({ id: move.id }).first()).estimate_id).toBe(replacement.id);
      expect(await callSideBlockForEstimateData(trx, await storedData(replacement.id), { estimateStatus: 'draft' })).toBeNull();
      // Back to the first address: the replaced estimate stays superseded for good.
      await resubmit(move.id, '40 Sample Road, Venice FL 34285', '40 Sample Road');
      expect(await callSideBlockForEstimateData(trx, await storedData(estimate.id))).toBe('move_superseded');
      expect(await callSideBlockForEstimateData(trx, await storedData(replacement.id))).toBe('move_address_changed');
    });

    test('conversion share-locks the move and refuses a stale one inside the accept transaction', async () => {
      const move = await insertMove();
      const { estimate } = await create(move);
      const data = await storedData(estimate.id);
      await expect(Moves.lockMoveForConversion(trx, data)).resolves.toMatchObject({ id: move.id, move_in_date: '2026-11-25' });
      expect(await Moves.lockMoveForConversion(trx, { inputs: {} })).toBeNull();
      await trx('customer_moves').where({ id: move.id }).update({ status: 'closed', closed_reason: 'cancelled', closed_at: new Date() });
      await expect(Moves.lockMoveForConversion(trx, data)).rejects.toMatchObject({ code: 'MOVE_ESTIMATE_STALE', reason: 'move_closed', statusCode: 409 });
      // Gate off: no first-visit placement, but a stale move still refuses.
      delete process.env.GATE_MOVING_ESTIMATE;
      await expect(Moves.lockMoveForConversion(trx, data)).rejects.toMatchObject({ code: 'MOVE_ESTIMATE_STALE' });
      await trx('customer_moves').where({ id: move.id }).update({ status: 'submitted', closed_reason: null, closed_at: null });
      expect(await Moves.lockMoveForConversion(trx, data)).toBeNull();
    });

    test('a cancelled or missing move takes its estimate off the customer surface; an applied one does not', async () => {
      const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
      const move = await insertMove();
      const { estimate } = await create(move);
      const data = await storedData(estimate.id);
      expect(await callSideBlockForEstimateData(trx, data)).toBeNull();
      await trx('customer_moves').where({ id: move.id }).update({ status: 'closed', closed_reason: 'applied', closed_at: new Date() });
      expect(await callSideBlockForEstimateData(trx, data)).toBeNull();
      await trx('customer_moves').where({ id: move.id }).update({ closed_reason: 'cancelled' });
      expect(await callSideBlockForEstimateData(trx, data)).toBe('move_closed');
      expect(await callSideBlockForEstimateData(trx, { ...data, move: { ...data.move, moveId: crypto.randomUUID() } })).toBe('move_missing');
      // An estimate with no move stamp is untouched by the move rule.
      expect(await callSideBlockForEstimateData(trx, { inputs: {} })).toBeNull();
    });

    test('after a resubmit, a revise cannot carry the old estimate to the new address; the card offers a new one', async () => {
      const move = await insertMove();
      const { estimate } = await create(move);
      const moved = await resubmit(move.id, '52 Other Lane, Venice FL 34285', '52 Other Lane');
      await expect(Persistence.reviseAdminEstimate({
        database: trx, estimateId: estimate.id, technicianId: ADMIN.id, technician: ADMIN, recompute: NO_INPUTS,
        body: body(move, {
          moveId: undefined, address: '52 Other Lane, Venice, FL 34285',
          estimateData: { inputs: { address: '52 Other Lane, Venice, FL 34285', svcPest: true }, result: { total: 60 } },
        }),
      })).rejects.toMatchObject({ statusCode: 409, code: 'move_address_changed' });
      expect(await Moves.newHomeAction(moved)).toEqual({ action: 'start', estimateId: null, reason: null });
    });

    test('an out-of-area move steers no estimate', async () => {
      const move = await insertMove();
      const { estimate } = await create(move);
      await trx('customer_moves').where({ id: move.id }).update({ address_verdict: 'out_of_area' });
      expect(await Moves.moveForEstimate(estimate.id)).toBeNull();
    });
  });

  describe('accept-time guards', () => {
    const secondHouse = async () => {
      const [{ id }] = await trx('customer_properties').insert({
        customer_id: customerId, is_primary: false, active: true, address_line1: NEW_HOUSE.line1, city: NEW_HOUSE.city, state: 'FL', zip: NEW_HOUSE.zip,
      }).returning('id');
      return id;
    };

    const multiHomeFlag = async () => (await trx('customers').where({ id: customerId }).first('has_multi_home')).has_multi_home;

    test('the house a submitted or applied move leaves does not count toward Multi-Home', async () => {
      process.env.GATE_CUSTOMER_PROPERTIES = 'true';
      await secondHouse();
      const move = await insertMove({ from_property_id: oldHouseId });
      expect(await Linkage.multiHomeFlipPending(trx, customerId)).toBe(false);
      expect(await Linkage.refreshHasMultiHome(customerId, trx)).toBe(false);
      await trx('customer_moves').where({ id: move.id }).update({ status: 'closed', closed_reason: 'applied', closed_at: new Date() });
      expect(await Linkage.refreshHasMultiHome(customerId, trx)).toBe(false);
      expect(await multiHomeFlag()).not.toBe(true);
      // A cancelled move: the customer keeps both homes, so the old house counts again.
      await trx('customer_moves').where({ id: move.id }).update({ closed_reason: 'cancelled' });
      expect(await Linkage.multiHomeFlipPending(trx, customerId)).toBe(true);
      expect(await Linkage.refreshHasMultiHome(customerId, trx)).toBe(true);
      expect(await multiHomeFlag()).toBe(true);
    });

    test('with the gate off the count is exactly today\'s', async () => {
      await secondHouse();
      await insertMove({ from_property_id: oldHouseId });
      delete process.env.GATE_MOVING_ESTIMATE;
      expect(await Linkage.refreshHasMultiHome(customerId, trx)).toBe(true);
    });

    test('a new-home estimate adopts no visit before the move-in date', async () => {
      const { findLinkedUpcomingAppointment } = require('../routes/estimate-public');
      const move = await insertMove({ move_in_date: '2099-03-10' });
      const { estimate } = await create(move);
      const row = await trx('estimates').where({ id: estimate.id }).first();
      const [{ id: early }] = await trx('scheduled_services').insert({
        customer_id: customerId, source_estimate_id: estimate.id, scheduled_date: '2099-03-01', service_type: 'Quarterly Pest Control Service', status: 'pending',
      }).returning('id');
      expect(await findLinkedUpcomingAppointment(row, null, { database: trx })).toBeNull();
      const [{ id: onTime }] = await trx('scheduled_services').insert({
        customer_id: customerId, source_estimate_id: estimate.id, scheduled_date: '2099-03-12', service_type: 'Quarterly Pest Control Service', status: 'pending',
      }).returning('id');
      expect((await findLinkedUpcomingAppointment(row, null, { database: trx }))?.id).toBe(onTime);
      // Gate off: the move-in floor does not apply.
      delete process.env.GATE_MOVING_ESTIMATE;
      expect((await findLinkedUpcomingAppointment(row, null, { database: trx }))?.id).toBe(early);
    });

    test('moveForEstimate finds the submitted move by its estimate, with calendar dates', async () => {
      const move = await insertMove();
      const { estimate } = await create(move);
      expect(await Moves.moveForEstimate(estimate.id)).toMatchObject({
        id: move.id, move_in_date: '2026-11-25', move_out_date: '2026-11-20', normalized_address: NEW_HOUSE,
      });
      delete process.env.GATE_MOVING_ESTIMATE;
      expect(await Moves.moveForEstimate(estimate.id)).toBeNull();
      gatesOn();
      await trx('customer_moves').where({ id: move.id }).update({ status: 'closed', closed_reason: 'cancelled', closed_at: new Date() });
      expect(await Moves.moveForEstimate(estimate.id)).toBeNull();
    });
  });
});
