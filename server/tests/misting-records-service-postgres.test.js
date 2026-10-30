/**
 * Misting system records service (GATE_MOSQUITO_MISTING) against a real PostgreSQL: a disposable schema
 * with stub parent tables and the real migration. Skipped without DATABASE_URL; run for real in CI
 * (DB-gated suites step). Covers the stored math, the DB-level label check, current-calibration
 * selection per property (NULL-safe), the refill rules, voids, ordering and the customer cascade.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');
const knex = require('knex');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockEnsurePrimary = jest.fn();
jest.mock('../services/customer-properties', () => ({ ensurePrimaryProperty: (...a) => mockEnsurePrimary(...a) }));

const migration = require('../models/migrations/20261030120000_misting_records');
const svc = require('../services/misting-records');
const { etDateString } = require('../utils/datetime-et');

jest.setTimeout(60000); // schema setup and the first migration are slow on a busy machine

const schema = `misting_svc_${randomUUID().replaceAll('-', '')}`;

const calInput = (over = {}) => ({
  installedOn: '2026-03-01',
  vendor: 'Pynamite',
  model: 'Test 55',
  serialNumber: 'SN-TEST-1',
  tankGallons: 55,
  zoneCount: 2,
  nozzleCount: 40,
  riserCount: 4,
  nozzleFlowFlOzPerMin: 1,
  cycleSeconds: 45,
  mistTimes: ['22:30', '06:30', '19:30'],
  productName: 'Sector Misting Concentrate',
  epaRegNo: '1021-1834',
  concentrateFlOzPerTank: 64,
  labelMaxFlOzPer1000CuFtDay: 9.5,
  treatedAreaSqFt: 6000,
  treatedHeightFt: 8,
  cabinetLocked: true,
  labelPosted: true,
  scheduleAvoidsPeople: true,
  notes: 'Test install',
  ...over,
});

const refillInput = (calibrationId, over = {}) => ({
  calibrationId,
  refilledOn: '2026-04-01',
  concentrateFlOzAdded: 64,
  waterGallonsAdded: 55,
  levelBeforePct: 20,
  counterReset: true,
  ...over,
});

postgres('misting records service (PostgreSQL)', () => {
  let admin;
  let app;
  let customerId;
  let tech;
  let homeId;

  const create = (over, id = customerId) => svc.createCalibration({ customerId: id, input: calInput(over), actorId: tech, knex: app });
  const refill = (calibrationId, over, id = customerId) => svc.createRefill({ customerId: id, input: refillInput(calibrationId, over), actorId: tech, knex: app });
  const code = (promise) => promise.then(() => null, (e) => ({ status: e.statusCode, code: e.code, message: e.message }));
  const addProperty = async (extra = {}) => (await app('customer_properties').insert({ customer_id: customerId, ...extra }).returning('id'))[0].id;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(target.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && target.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    admin = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await app.schema.createTable('customers', (t) => { t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); });
    await app.schema.createTable('customer_properties', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('label', 100);
      t.boolean('is_primary').notNullable().defaultTo(false);
      t.string('address_line1', 200);
      t.string('address_line2', 100);
      t.string('city', 50);
      t.string('state', 2);
      t.string('zip', 10);
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(app.fn.now());
    });
    await app.schema.createTable('technicians', (t) => { t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); t.string('name'); });
    await migration.up(app);
  });

  beforeEach(async () => {
    customerId = (await app('customers').insert({}).returning('id'))[0].id;
    tech = (await app('technicians').insert({ name: 'Test Tech' }).returning('id'))[0].id;
    // Most customers have their primary property on file; a calibration is stamped with its real id.
    homeId = await addProperty({ is_primary: true, label: 'Home', address_line1: '1 Test Lane' });
    mockEnsurePrimary.mockReset();
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  test('saves a calibration with the server-computed numbers, sorted mist times and the recorder', async () => {
    const cal = await create();
    expect(cal).toMatchObject({
      customerId, propertyId: homeId, installedOn: '2026-03-01', vendor: 'Pynamite', tankGallons: 55, zoneCount: 2,
      nozzleCount: 40, riserCount: 4, mistTimes: ['06:30', '19:30', '22:30'], epaRegNo: '1021-1834',
      concentrateFlOzPerTank: 64, mixFlOzPerGal: 1.164, treatedVolumeCuFt: 48000, outputFlOzPerCycle: 33,
      dailyOutputFlOz: 99, labelDailyCapFlOz: 456, cabinetLocked: true, source: 'staff', voidedAt: null,
      recordedBy: { id: tech, name: 'Test Tech' },
    });
  });

  test('numbers sent by the client for the computed columns are ignored', async () => {
    const cal = await create({ dailyOutputFlOz: 1, labelDailyCapFlOz: 99999, treatedVolumeCuFt: 1, source: 'sensor' });
    expect(cal).toMatchObject({ dailyOutputFlOz: 99, labelDailyCapFlOz: 456, treatedVolumeCuFt: 48000, source: 'staff' });
  });

  test('a stronger mix halves the daily cap and a weaker mix never raises it', async () => {
    expect((await create({ concentrateFlOzPerTank: 128 })).labelDailyCapFlOz).toBe(228);
    expect((await create({ tankGallons: 10, concentrateFlOzPerTank: 11.6 })).labelDailyCapFlOz).toBe(456);
  });

  test('the over-label case is refused with both numbers; exactly at the cap is accepted', async () => {
    const over = { nozzleCount: 16, riserCount: 4, nozzleFlowFlOzPerMin: 1.375, treatedAreaSqFt: 1000, treatedHeightFt: 5 };
    expect(await code(create(over))).toEqual({
      status: 422, code: 'MISTING_OVER_LABEL',
      message: 'This schedule puts out 61.9 fl oz a day. The label allows 47.5. Shorten the mist or run fewer cycles.',
    });
    const edge = { nozzleCount: 15, riserCount: 4, nozzleFlowFlOzPerMin: 2.5, cycleSeconds: 60, mistTimes: ['06:30'], treatedAreaSqFt: 1000, treatedHeightFt: 5 };
    expect(await code(create(edge))).toBeNull();
    expect(await code(create({ ...edge, nozzleFlowFlOzPerMin: 2.501 }))).toMatchObject({ status: 422, code: 'MISTING_OVER_LABEL' });
  });

  test('the database itself refuses an over-label row that skips the service', async () => {
    const cal = await create();
    await expect(app('misting_calibrations').where({ id: cal.id }).update({ daily_output_fl_oz: 500 })).rejects.toMatchObject({ constraint: 'misting_calibrations_within_label' });
  });

  test('the known-product label rules: limit above the label, mix off the label, and an unknown product keeps its own limit', async () => {
    expect(await code(create({ labelMaxFlOzPer1000CuFtDay: 12 }))).toEqual({
      status: 422, code: 'MISTING_LABEL_LIMIT_MISMATCH', message: 'The Sector label allows at most 9.5 fl oz per 1,000 cu ft a day.',
    });
    expect(await code(create({ concentrateFlOzPerTank: 200 }))).toMatchObject({ status: 422, code: 'MISTING_MIX_OFF_LABEL' });
    const weak = await code(create({ concentrateFlOzPerTank: 40 }));
    expect(weak).toMatchObject({ status: 422, code: 'MISTING_MIX_OFF_LABEL' });
    expect(weak.message).toBe('The Sector label mixes 64 to 128 fl oz of concentrate in 55 gallons (1.16 to 2.33 fl oz a gallon). This mix is 0.73 fl oz a gallon.');
    const other = await create({ productName: 'Other Concentrate', epaRegNo: '555-123', labelMaxFlOzPer1000CuFtDay: 40, concentrateFlOzPerTank: 200 });
    expect(other).toMatchObject({ labelMaxFlOzPer1000CuFtDay: 40, labelDailyCapFlOz: 1920 });
  });

  test('all three checks must be true, and the message names the missing ones', async () => {
    expect(await code(create({ cabinetLocked: false, scheduleAvoidsPeople: undefined }))).toMatchObject({
      status: 422, code: 'MISTING_CHECKS_INCOMPLETE',
      message: expect.stringMatching(/Lock the cabinet.*Set mist times when people and pets are not outside/),
    });
    expect(await code(create({ labelPosted: 'yes' }))).toMatchObject({ code: 'MISTING_CHECKS_INCOMPLETE', message: expect.stringContaining('Post the label and dilution statement at the unit') });
  });

  test('shape and range problems are 400s; a missing customer is 404', async () => {
    for (const over of [{ tankGallons: 0 }, { tankGallons: 301 }, { zoneCount: 5 }, { nozzleCount: 0, riserCount: 0 }, { nozzleFlowFlOzPerMin: 11 },
      { cycleSeconds: 4 }, { mistTimes: [] }, { mistTimes: ['6:30'] }, { mistTimes: ['06:30', '06:30'] }, { epaRegNo: 'abc' },
      { treatedHeightFt: 16 }, { treatedAreaSqFt: 99 }, { installedOn: '2999-01-01' }, { installedOn: '2026-02-30' }, { concentrateFlOzPerTank: 7041 }, { vendor: '' }]) {
      expect(await code(create(over))).toMatchObject({ status: 400, code: 'MISTING_BAD_INPUT' });
    }
    expect(await code(create({ epaRegNo: '25(b)', productName: 'Exempt', labelMaxFlOzPer1000CuFtDay: 40 }))).toBeNull();
    expect(await code(create({}, randomUUID()))).toMatchObject({ status: 404 });
  });

  test('properties: the real id is always stored; 2+ active homes require a pick; a stranger or retired property is refused', async () => {
    const primary = homeId;
    expect((await create()).propertyId).toBe(primary);
    expect((await create({ propertyId: primary })).propertyId).toBe(primary);
    const second = await addProperty({ label: 'Lake house', address_line1: '12 Test Lane', city: 'Venice', state: 'FL', zip: '34285' });
    expect(await code(create())).toEqual({ status: 400, code: 'MISTING_BAD_INPUT', message: 'Pick which property the system is at.' });
    expect((await create({ propertyId: second })).propertyId).toBe(second);
    expect((await create({ propertyId: primary })).propertyId).toBe(primary);
    const stranger = (await app('customers').insert({}).returning('id'))[0].id;
    const strangerProp = (await app('customer_properties').insert({ customer_id: stranger }).returning('id'))[0].id;
    expect(await code(create({ propertyId: strangerProp }))).toMatchObject({ status: 400 });
    const retired = await addProperty({ active: false });
    expect(await code(create({ propertyId: retired }))).toMatchObject({ status: 400 });
    expect(mockEnsurePrimary).not.toHaveBeenCalled();
  });

  test('a customer who never had a property row gets the primary created first, and the calibration is stamped with it', async () => {
    const fresh = (await app('customers').insert({}).returning('id'))[0].id;
    mockEnsurePrimary.mockImplementation(async (id) => {
      const [row] = await app('customer_properties').insert({ customer_id: id, is_primary: true, label: 'Primary' }).returning('id');
      return { created: true, propertyId: row.id };
    });
    const cal = await create({}, fresh);
    expect(mockEnsurePrimary).toHaveBeenCalledTimes(1);
    expect(mockEnsurePrimary).toHaveBeenCalledWith(fresh);
    const row = await app('customer_properties').where({ customer_id: fresh }).first();
    expect(cal.propertyId).toBe(row.id);
  });

  test('no primary can be made (no address) is a 400; every row retired is a 400 and nothing is created', async () => {
    const noAddress = (await app('customers').insert({}).returning('id'))[0].id;
    mockEnsurePrimary.mockResolvedValue({ created: false, propertyId: null });
    expect(await code(create({}, noAddress))).toEqual({ status: 400, code: 'MISTING_BAD_INPUT', message: 'This customer has no active property.' });
    const retiredOnly = (await app('customers').insert({}).returning('id'))[0].id;
    await app('customer_properties').insert({ customer_id: retiredOnly, active: false });
    mockEnsurePrimary.mockClear();
    expect(await code(create({}, retiredOnly))).toEqual({ status: 400, code: 'MISTING_BAD_INPUT', message: 'This customer has no active property.' });
    expect(mockEnsurePrimary).not.toHaveBeenCalled();
  });

  test('the newest non-voided calibration is current per property; a re-calibration supersedes', async () => {
    const primary = homeId;
    const second = await addProperty({ label: 'Lake house' });
    const a1 = await create({ propertyId: primary });
    const b1 = await create({ propertyId: second });
    const a2 = await create({ propertyId: primary, notes: 'Re-calibrated' });
    const { calibrations, properties } = await svc.listCustomerRecords(customerId, { knex: app });
    expect(properties.map((p) => [p.id, p.isPrimary])).toEqual([[primary, true], [second, false]]);
    expect(calibrations.map((c) => c.id)).toEqual([a2.id, b1.id, a1.id]);
    expect(Object.fromEntries(calibrations.map((c) => [c.id, c.isCurrent]))).toEqual({ [a2.id]: true, [b1.id]: true, [a1.id]: false });
    expect((await svc.currentCalibration(app, customerId, primary)).id).toBe(a2.id);
    expect((await svc.currentCalibration(app, customerId, second)).id).toBe(b1.id);
  });

  test('moving the primary to another home leaves each system under its own home', async () => {
    const second = await addProperty({ label: 'Lake house' });
    const atA = await create({ propertyId: homeId });
    await app('customer_properties').where({ id: homeId }).update({ is_primary: false });
    await app('customer_properties').where({ id: second }).update({ is_primary: true });
    const atB = await create({ propertyId: second });
    const { calibrations } = await svc.listCustomerRecords(customerId, { knex: app });
    expect(Object.fromEntries(calibrations.map((c) => [c.id, [c.propertyId, c.isCurrent]]))).toEqual({ [atA.id]: [homeId, true], [atB.id]: [second, true] });
    expect((await svc.currentCalibration(app, customerId, homeId)).id).toBe(atA.id);
  });

  test('a calibration whose property row was deleted (NULL) is history: never current, and takes no refills', async () => {
    const second = await addProperty({ label: 'Lake house' });
    const cal = await create({ propertyId: second });
    await refill(cal.id);
    await app('customer_properties').where({ id: second }).del();
    const { calibrations, refills } = await svc.listCustomerRecords(customerId, { knex: app });
    expect(calibrations.find((c) => c.id === cal.id)).toMatchObject({ propertyId: null, isCurrent: false });
    expect(refills[0]).toMatchObject({ propertyId: null });
    expect(await svc.currentCalibration(app, customerId, null)).toBeUndefined();
    expect(await code(refill(cal.id))).toMatchObject({ status: 409, code: 'MISTING_CALIBRATION_NOT_CURRENT' });
    // A new calibration at the remaining home is unaffected.
    expect((await create()).propertyId).toBe(homeId);
  });

  test('a current calibration past the 200-row history limit is still listed, as current', async () => {
    const second = await addProperty({ label: 'Lake house' });
    const keep = await create({ propertyId: homeId });
    const template = await app('misting_calibrations').where({ id: keep.id }).first();
    const base = new Date(template.created_at).getTime() + 1000;
    // 200 newer (voided) rows at another property push the current one past the history limit.
    await app('misting_calibrations').insert(Array.from({ length: 200 }, (_, n) => ({
      ...template,
      id: randomUUID(),
      property_id: second,
      created_at: new Date(base + n * 1000),
      updated_at: new Date(base + n * 1000),
      voided_at: new Date(base + n * 1000),
      voided_by: null,
      void_reason: 'Synthetic history',
    })));
    const { calibrations } = await svc.listCustomerRecords(customerId, { knex: app });
    expect(calibrations).toHaveLength(201);
    expect(calibrations.find((c) => c.id === keep.id)).toMatchObject({ isCurrent: true });
  });

  test('two writers at once keep a strict order: the later call is the newer record', async () => {
    const [x, y] = await Promise.all([create({ notes: 'x' }), create({ notes: 'y' })]);
    const { calibrations } = await svc.listCustomerRecords(customerId, { knex: app });
    expect(calibrations).toHaveLength(2);
    expect(calibrations.filter((c) => c.isCurrent)).toHaveLength(1);
    expect([x.id, y.id]).toContain(calibrations[0].id);
  });

  test('a refill is stored against the current calibration, with its product and the recorder', async () => {
    const cal = await create();
    const r = await refill(cal.id, { productName: ' sector misting concentrate ', epaRegNo: '1021-1834', notes: 'First fill' });
    expect(r).toMatchObject({
      calibrationId: cal.id, propertyId: homeId, refilledOn: '2026-04-01', productName: 'Sector Misting Concentrate', epaRegNo: '1021-1834',
      concentrateFlOzAdded: 64, waterGallonsAdded: 55, levelBeforePct: 20, counterReset: true, notes: 'First fill', recordedBy: { id: tech, name: 'Test Tech' },
    });
    const { refills } = await svc.listCustomerRecords(customerId, { knex: app });
    expect(refills.map((x) => x.id)).toEqual([r.id]);
  });

  test('refill rules: superseded calibration 409, product changed 422, mix changed 422, dates and amounts 400', async () => {
    const old = await create();
    const current = await create({ notes: 'Re-calibrated' });
    expect(await code(refill(old.id))).toMatchObject({ status: 409, code: 'MISTING_CALIBRATION_NOT_CURRENT' });
    expect(await code(refill(randomUUID()))).toMatchObject({ status: 404 });
    expect(await code(refill(current.id, { epaRegNo: '555-123' }))).toEqual({ status: 422, code: 'MISTING_PRODUCT_CHANGED', message: 'Record a new calibration first: the product changed.' });
    expect(await code(refill(current.id, { productName: 'Something Else' }))).toMatchObject({ code: 'MISTING_PRODUCT_CHANGED' });
    expect(await code(refill(current.id, { concentrateFlOzAdded: 100 }))).toMatchObject({
      status: 422, code: 'MISTING_MIX_CHANGED', message: 'This mix is 1.82 fl oz per gallon; the calibration is 1.16. Record a new calibration first if the mix changed.',
    });
    expect(await code(refill(current.id, { concentrateFlOzAdded: 70 }))).toBeNull(); // 1.27 against 1.16 is 9% over: inside the 10% slack
    expect(await code(refill(current.id, { refilledOn: '2026-02-28' }))).toMatchObject({ status: 400 });
    expect(await code(refill(current.id, { refilledOn: '2999-01-01' }))).toMatchObject({ status: 400 });
    expect(await code(refill(current.id, { waterGallonsAdded: 56 }))).toMatchObject({ status: 400 });
    expect(await code(refill(current.id, { levelBeforePct: 101 }))).toMatchObject({ status: 400 });
    expect(await code(refill('not-a-uuid'))).toMatchObject({ status: 400 });
    expect(await code(refill(current.id, { refilledOn: etDateString() }))).toBeNull();
  });

  test('a refill against another customer\'s calibration is not found', async () => {
    const other = (await app('customers').insert({}).returning('id'))[0].id;
    await app('customer_properties').insert({ customer_id: other, is_primary: true });
    const cal = await create({}, other);
    expect(await code(refill(cal.id))).toMatchObject({ status: 404 });
  });

  describe('a retired property (active = false, property_id kept)', () => {
    const retire = (id) => app('customer_properties').where({ id }).update({ active: false });
    const reactivate = (id) => app('customer_properties').where({ id }).update({ active: true });

    test('its calibration stops being current, takes no refill, and lists as history; re-activating brings it back', async () => {
      const second = await addProperty({ label: 'Lake house' });
      const atHome = await create({ propertyId: homeId });
      const atLake = await create({ propertyId: second });
      await refill(atLake.id);
      await retire(second);

      expect(await svc.currentCalibration(app, customerId, second)).toBeUndefined();
      expect((await svc.currentCalibrationForCustomer(app, customerId)).id).toBe(atHome.id);
      expect(await code(refill(atLake.id))).toEqual({
        status: 409,
        code: 'MISTING_PROPERTY_RETIRED',
        message: 'This property was removed from the customer. Re-add it before logging a refill.',
      });
      const { calibrations, refills, properties } = await svc.listCustomerRecords(customerId, { knex: app });
      expect(properties.map((p) => p.id)).toEqual([homeId]);
      expect(calibrations.find((c) => c.id === atLake.id)).toMatchObject({ propertyId: second, isCurrent: false });
      expect(calibrations.find((c) => c.id === atHome.id).isCurrent).toBe(true);
      expect(refills[0]).toMatchObject({ propertyId: second });
      // A superseded or voided calibration keeps its own code.
      const newer = await create({ propertyId: homeId, notes: 'Re-calibrated' });
      expect(await code(refill(atHome.id))).toMatchObject({ status: 409, code: 'MISTING_CALIBRATION_NOT_CURRENT' });
      expect(await code(refill(newer.id))).toBeNull();

      await reactivate(second);
      expect((await svc.currentCalibration(app, customerId, second)).id).toBe(atLake.id);
      expect(await code(refill(atLake.id))).toBeNull();
    });

    test('a calibration cannot be recorded at a retired property, and a new one at an active home works as usual', async () => {
      const second = await addProperty({ label: 'Lake house' });
      await create({ propertyId: second });
      await retire(second);
      expect(await code(create({ propertyId: second }))).toMatchObject({ status: 400, message: 'That property is not an active property of this customer.' });
      const atHome = await create({ propertyId: homeId });
      expect(await code(refill(atHome.id))).toBeNull();
    });

    test('voiding a row at a removed property is still allowed (it fixes a mistake)', async () => {
      const second = await addProperty({ label: 'Lake house' });
      const cal = await create({ propertyId: second });
      const r = await refill(cal.id);
      await retire(second);
      expect(await svc.voidRefill({ id: r.id, reason: 'Logged on the wrong day', actorId: tech, knex: app })).toMatchObject({ voidReason: 'Logged on the wrong day' });
      expect(await svc.voidCalibration({ id: cal.id, reason: 'Entered by mistake', actorId: tech, knex: app })).toMatchObject({ voidReason: 'Entered by mistake' });
    });

    test('a property row of another customer never counts as active for this customer', async () => {
      const other = (await app('customers').insert({}).returning('id'))[0].id;
      const otherHome = (await app('customer_properties').insert({ customer_id: other, is_primary: true }).returning('id'))[0].id;
      const cal = await create({}, other);
      expect(cal.propertyId).toBe(otherHome);
      expect(await svc.currentCalibration(app, customerId, otherHome)).toBeUndefined();
      expect(await svc.currentCalibrationForCustomer(app, customerId)).toBeUndefined();
    });
  });

  test('currentCalibrationForCustomer picks the newest across active properties and ignores retired and NULL ones', async () => {
    const lake = await addProperty({ label: 'Lake house' });
    const gone = await addProperty({ label: 'Old house' });
    const deleted = await addProperty({ label: 'Deleted house' });
    expect(await svc.currentCalibrationForCustomer(app, customerId)).toBeUndefined();
    const atHome = await create({ propertyId: homeId });
    const atLake = await create({ propertyId: lake });
    expect((await svc.currentCalibrationForCustomer(app, customerId)).id).toBe(atLake.id);
    await create({ propertyId: gone, notes: 'newest, but retired' });
    await create({ propertyId: deleted, notes: 'even newer, but deleted' });
    await app('customer_properties').where({ id: gone }).update({ active: false });
    await app('customer_properties').where({ id: deleted }).del();
    expect((await svc.currentCalibrationForCustomer(app, customerId)).id).toBe(atLake.id);
    await svc.voidCalibration({ id: atLake.id, reason: 'Wrong house', actorId: tech, knex: app });
    expect((await svc.currentCalibrationForCustomer(app, customerId)).id).toBe(atHome.id);
  });

  describe('refill vs the daily limit', () => {
    // A system exactly at its daily cap: 19 emitters x 2.5 fl oz a minute x 60 s x 1 cycle = 47.5 fl oz, cap 47.5.
    const atCap = { nozzleCount: 15, riserCount: 4, nozzleFlowFlOzPerMin: 2.5, cycleSeconds: 60, mistTimes: ['06:30'], treatedAreaSqFt: 1000, treatedHeightFt: 5 };

    test('at the cap: the same mix and a weaker mix are accepted; a stronger mix is refused with both numbers', async () => {
      const cal = await create(atCap);
      expect(cal).toMatchObject({ dailyOutputFlOz: 47.5, labelDailyCapFlOz: 47.5 });
      expect(await code(refill(cal.id, { concentrateFlOzAdded: 64 }))).toBeNull();
      expect(await code(refill(cal.id, { concentrateFlOzAdded: 63 }))).toBeNull();
      expect(await code(refill(cal.id, { concentrateFlOzAdded: 70 }))).toEqual({
        status: 422,
        code: 'MISTING_REFILL_OVER_LABEL',
        message: 'At this mix the label allows 43.4 fl oz a day, and this system puts out 47.5. Use the calibration\'s mix, or record a new calibration.',
      });
    });

    test('a stronger refill is fine while the system has room under the lowered cap', async () => {
      const cal = await create();
      expect(await code(refill(cal.id, { concentrateFlOzAdded: 70 }))).toBeNull();
    });

    test('an unknown product at the cap: a stronger refill is refused, a weaker one accepted', async () => {
      const other = { ...atCap, productName: 'Other Concentrate', epaRegNo: '555-123' };
      const cal = await create(other);
      expect(cal.labelDailyCapFlOz).toBe(47.5);
      expect(await code(refill(cal.id, { concentrateFlOzAdded: 70 }))).toMatchObject({ status: 422, code: 'MISTING_REFILL_OVER_LABEL' });
      expect(await code(refill(cal.id, { concentrateFlOzAdded: 60 }))).toBeNull();
    });

    test('a Sector refill outside the label mix range is refused with the label-range message, even inside the 10% slack', async () => {
      const cal = await create();
      expect(await code(refill(cal.id, { concentrateFlOzAdded: 60 }))).toEqual({
        status: 422,
        code: 'MISTING_MIX_OFF_LABEL',
        message: 'The Sector label mixes 64 to 128 fl oz of concentrate in 55 gallons (1.16 to 2.33 fl oz a gallon). This mix is 1.09 fl oz a gallon.',
      });
    });

    test('the 10% rule still applies first', async () => {
      const cal = await create();
      expect(await code(refill(cal.id, { concentrateFlOzAdded: 100 }))).toMatchObject({ code: 'MISTING_MIX_CHANGED' });
    });
  });

  test('voids: reason required, once only, a calibration with open refills is blocked, and voiding the newest restores the older one', async () => {
    const first = await create();
    const second = await create({ notes: 'Re-calibrated' });
    const r = await refill(second.id);
    expect(await code(svc.voidCalibration({ id: second.id, reason: 'x', actorId: tech, knex: app }))).toMatchObject({ status: 400 });
    expect(await code(svc.voidCalibration({ id: second.id, reason: 'Entered wrong nozzle count', actorId: tech, knex: app }))).toEqual({
      status: 409, code: 'MISTING_CALIBRATION_HAS_REFILLS', message: 'Void its refills first, or record a new calibration instead.',
    });
    const voidedRefill = await svc.voidRefill({ id: r.id, reason: 'Logged on the wrong day', actorId: tech, knex: app });
    expect(voidedRefill).toMatchObject({ voidReason: 'Logged on the wrong day', voidedBy: tech });
    expect(voidedRefill.voidedAt).toEqual(expect.any(String));
    expect(await code(svc.voidRefill({ id: r.id, reason: 'again please', actorId: tech, knex: app }))).toMatchObject({ status: 409, code: 'MISTING_ALREADY_VOIDED' });
    const voidedCal = await svc.voidCalibration({ id: second.id, reason: 'Entered wrong nozzle count', actorId: tech, knex: app });
    expect(voidedCal).toMatchObject({ voidReason: 'Entered wrong nozzle count', voidedBy: tech });
    const { calibrations, refills } = await svc.listCustomerRecords(customerId, { knex: app });
    expect(calibrations.find((c) => c.id === first.id).isCurrent).toBe(true);
    expect(calibrations.find((c) => c.id === second.id)).toMatchObject({ isCurrent: false, voidReason: 'Entered wrong nozzle count' });
    expect(refills[0]).toMatchObject({ id: r.id, voidReason: 'Logged on the wrong day' });
    // A voided calibration cannot take a refill.
    expect(await code(refill(second.id))).toMatchObject({ status: 409 });
    expect(await code(svc.voidRefill({ id: randomUUID(), reason: 'does not exist', actorId: tech, knex: app }))).toMatchObject({ status: 404 });
  });

  test('lists are newest first; refills order by refill date', async () => {
    const cal = await create();
    const a = await refill(cal.id, { refilledOn: '2026-04-01' });
    const b = await refill(cal.id, { refilledOn: '2026-05-01' });
    const c = await refill(cal.id, { refilledOn: '2026-04-15' });
    const { refills } = await svc.listCustomerRecords(customerId, { knex: app });
    expect(refills.map((x) => x.id)).toEqual([b.id, c.id, a.id]);
  });

  test('a missing customer lists as 404, and deleting a customer removes its records', async () => {
    expect(await code(svc.listCustomerRecords(randomUUID(), { knex: app }))).toMatchObject({ status: 404 });
    const cal = await create();
    await refill(cal.id);
    await app('customers').where({ id: customerId }).del();
    expect(await app('misting_calibrations').where({ customer_id: customerId })).toHaveLength(0);
    expect(await app('misting_refills').where({ customer_id: customerId })).toHaveLength(0);
  });
});
