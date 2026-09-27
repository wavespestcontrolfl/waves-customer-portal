// Optional real PostgreSQL proof for the booking estimate-ownership fence.
// Uses an isolated synthetic schema and the same customer-comms advisory key
// as merge undo; no production tables or customer data are touched.
const knex = require('knex');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const {
  EstimateOwnerMovedError,
  loadEstimateOwnershipSnapshots,
  estimateOwnershipCustomerIds,
  lockCustomerAccountRows,
  lockEstimateOwnerForUpdate,
  validateEstimateOwnershipUnderLock,
} = require('../services/customer-account-ownership');

const connection = process.env.BOOK_CAPACITY_COMMIT_TEST_DATABASE_URL;
const describeDb = connection ? describe : describe.skip;
const OWNER = '10000000-0000-4000-8000-000000000001';
const BOOKED_PROPERTY = '20000000-0000-4000-8000-000000000002';
const RESTORED_OWNER = '30000000-0000-4000-8000-000000000003';
const SHARED_ACCOUNT = '40000000-0000-4000-8000-000000000004';
const OTHER_ACCOUNT = '50000000-0000-4000-8000-000000000005';
const ESTIMATE = '60000000-0000-4000-8000-000000000006';

describeDb('booking estimate ownership fence on real PostgreSQL', () => {
  let database;
  let schema;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
    schema = `booking_owner_${process.pid}_${Date.now()}`;
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.customers (id uuid PRIMARY KEY, account_id uuid, deleted_at timestamptz)', [schema]);
    await database.raw('CREATE TABLE ??.estimates (id uuid PRIMARY KEY, customer_id uuid)', [schema]);
    await database.raw('CREATE TABLE ??.scheduled_services (id bigserial PRIMARY KEY, customer_id uuid, source_estimate_id uuid)', [schema]);
  });

  afterAll(async () => {
    if (database) {
      if (schema) await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
      await database.destroy();
    }
  });

  beforeEach(async () => {
    await database.withSchema(schema).table('scheduled_services').del();
    await database.withSchema(schema).table('estimates').del();
    await database.withSchema(schema).table('customers').del();
    await database.withSchema(schema).table('customers').insert([
      { id: OWNER, account_id: SHARED_ACCOUNT },
      { id: BOOKED_PROPERTY, account_id: SHARED_ACCOUNT },
      { id: RESTORED_OWNER, account_id: OTHER_ACCOUNT },
    ]);
    await database.withSchema(schema).table('estimates').insert({ id: ESTIMATE, customer_id: OWNER });
  });

  const useSchema = (trx) => trx.raw(`SET LOCAL search_path TO "${schema}", public`);

  test('merge undo cannot repoint the estimate between ownership validation and visit insert', async () => {
    let bookingValidated;
    let releaseBooking;
    let undoReachedFence;
    const validated = new Promise(resolve => { bookingValidated = resolve; });
    const release = new Promise(resolve => { releaseBooking = resolve; });
    const atFence = new Promise(resolve => { undoReachedFence = resolve; });
    let undoAcquiredOwnerFence = false;

    const booking = database.transaction(async (trx) => {
      await useSchema(trx);
      const [snapshot] = await loadEstimateOwnershipSnapshots(trx, [ESTIMATE]);
      const customerIds = estimateOwnershipCustomerIds(snapshot, BOOKED_PROPERTY);
      for (const id of customerIds) await lockCustomerComms(trx, id);
      const lockedCustomers = await lockCustomerAccountRows(trx, customerIds);
      await expect(validateEstimateOwnershipUnderLock(
        trx,
        snapshot,
        BOOKED_PROPERTY,
        { lockedCustomers },
      )).resolves.toMatchObject({ id: ESTIMATE, customer_id: OWNER });
      bookingValidated();
      await release;
      await trx('scheduled_services').insert({
        customer_id: BOOKED_PROPERTY,
        source_estimate_id: ESTIMATE,
      });
    });

    await validated;
    const undo = database.transaction(async (trx) => {
      await useSchema(trx);
      undoReachedFence();
      await lockCustomerComms(trx, OWNER);
      undoAcquiredOwnerFence = true;
      await trx('customers').whereIn('id', [OWNER, RESTORED_OWNER]).forUpdate();
      await trx('estimates').where({ id: ESTIMATE, customer_id: OWNER }).update({ customer_id: RESTORED_OWNER });
    });

    try {
      await atFence;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(undoAcquiredOwnerFence).toBe(false);
    } finally {
      releaseBooking();
    }
    await Promise.all([booking, undo]);

    await expect(database.withSchema(schema).table('scheduled_services').where({
      customer_id: BOOKED_PROPERTY,
      source_estimate_id: ESTIMATE,
    }).first('id')).resolves.toBeTruthy();
    await expect(database.withSchema(schema).table('estimates').where({ id: ESTIMATE }).first('customer_id'))
      .resolves.toEqual({ customer_id: RESTORED_OWNER });
  });

  test.each([
    ['same owner with a SHARE booking lock', OWNER, false],
    ['sibling owner with a SHARE booking lock', BOOKED_PROPERTY, false],
    ['same owner with an UPDATE activation lock', OWNER, true],
    ['sibling owner with an UPDATE activation lock', BOOKED_PROPERTY, true],
  ])('service-mix estimate lock and %s complete without a lock inversion', async (_label, bookingCustomerId, forUpdate) => {
    let serviceMixLockedEstimate;
    let releaseServiceMix;
    let bookingReachedFence;
    const estimateLocked = new Promise(resolve => { serviceMixLockedEstimate = resolve; });
    const release = new Promise(resolve => { releaseServiceMix = resolve; });
    const atFence = new Promise(resolve => { bookingReachedFence = resolve; });
    let bookingAcquiredFence = false;

    const serviceMix = database.transaction(async (trx) => {
      await useSchema(trx);
      const locked = await lockEstimateOwnerForUpdate(trx, { id: ESTIMATE, customer_id: OWNER });
      expect(locked).toMatchObject({ id: ESTIMATE, customer_id: OWNER });
      serviceMixLockedEstimate();
      await release;
      await trx('customers').where({ id: OWNER }).forUpdate().first('id');
    });

    await estimateLocked;
    const booking = database.transaction(async (trx) => {
      await useSchema(trx);
      const [snapshot] = await loadEstimateOwnershipSnapshots(trx, [ESTIMATE]);
      const customerIds = estimateOwnershipCustomerIds(snapshot, bookingCustomerId);
      bookingReachedFence();
      for (const id of customerIds) await lockCustomerComms(trx, id);
      bookingAcquiredFence = true;
      const lockedCustomers = await lockCustomerAccountRows(trx, customerIds, { forUpdate });
      await expect(validateEstimateOwnershipUnderLock(
        trx,
        snapshot,
        bookingCustomerId,
        { lockedCustomers },
      )).resolves.toMatchObject({ id: ESTIMATE, customer_id: OWNER });
      await trx('scheduled_services').insert({
        customer_id: bookingCustomerId,
        source_estimate_id: ESTIMATE,
      });
    });

    try {
      await atFence;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(bookingAcquiredFence).toBe(false);
    } finally {
      releaseServiceMix();
    }
    await expect(Promise.all([serviceMix, booking])).resolves.toHaveLength(2);
    await expect(database.withSchema(schema).table('scheduled_services').where({
      customer_id: bookingCustomerId,
      source_estimate_id: ESTIMATE,
    }).first('id')).resolves.toBeTruthy();
  });

  test.each([
    ['account move', 'account'],
    ['estimate repoint', 'estimate'],
  ])('a committed %s is re-read after waiting on the owner fence', async (_label, movement) => {
    let releaseMove;
    let movePublished;
    let bookingValidated = false;
    const release = new Promise(resolve => { releaseMove = resolve; });
    const published = new Promise(resolve => { movePublished = resolve; });

    const move = database.transaction(async (trx) => {
      await useSchema(trx);
      await lockCustomerComms(trx, OWNER);
      if (movement === 'account') {
        await trx('customers').where({ id: OWNER }).update({ account_id: OTHER_ACCOUNT });
      } else {
        await trx('estimates').where({ id: ESTIMATE }).update({ customer_id: RESTORED_OWNER });
      }
      movePublished();
      await release;
    });

    await published;
    const booking = database.transaction(async (trx) => {
      await useSchema(trx);
      const [snapshot] = await loadEstimateOwnershipSnapshots(trx, [ESTIMATE]);
      const customerIds = estimateOwnershipCustomerIds(snapshot, BOOKED_PROPERTY);
      for (const id of customerIds) await lockCustomerComms(trx, id);
      const lockedCustomers = await lockCustomerAccountRows(trx, customerIds, { forUpdate: true });
      const owned = await validateEstimateOwnershipUnderLock(
        trx,
        snapshot,
        BOOKED_PROPERTY,
        { forUpdate: true, lockedCustomers },
      );
      bookingValidated = true;
      expect(owned).toBe(false);
    });

    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(bookingValidated).toBe(false);
    } finally {
      releaseMove();
    }
    await Promise.all([move, booking]);
  });

  test.each([
    ['owned estimate is repointed', OWNER],
    ['unowned estimate gains an owner', null],
  ])('service-mix refuses when an %s before its estimate lock', async (_label, staleOwnerId) => {
    if (!staleOwnerId) await database.withSchema(schema).table('estimates').where({ id: ESTIMATE }).update({ customer_id: null });
    let releaseMove;
    let moveLockedEstimate;
    const release = new Promise(resolve => { releaseMove = resolve; });
    const estimateLocked = new Promise(resolve => { moveLockedEstimate = resolve; });

    const move = database.transaction(async (trx) => {
      await useSchema(trx);
      if (staleOwnerId) await lockCustomerComms(trx, staleOwnerId);
      await trx('estimates').where({ id: ESTIMATE }).forUpdate().first('id');
      await trx('estimates').where({ id: ESTIMATE }).update({ customer_id: RESTORED_OWNER });
      moveLockedEstimate();
      await release;
    });

    await estimateLocked;
    let serviceMixSettled = false;
    const serviceMix = database.transaction(async (trx) => {
      await useSchema(trx);
      await expect(lockEstimateOwnerForUpdate(trx, {
        id: ESTIMATE, customer_id: staleOwnerId,
      })).rejects.toBeInstanceOf(EstimateOwnerMovedError);
    });
    void serviceMix.then(() => { serviceMixSettled = true; }, () => { serviceMixSettled = true; });

    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(serviceMixSettled).toBe(false);
    } finally {
      releaseMove();
    }
    await expect(Promise.all([move, serviceMix])).resolves.toHaveLength(2);
  });
});
