// new_plan_without_welcome (lead-to-cash invariants) on a real PostgreSQL: a
// first recurring plan that started 3 hours to 14 days ago and left no
// new_customer_welcome row is found, unless the welcome rule would not have
// called the customer new or the silence is by design. Every row is written
// inside one transaction that is rolled back. Invented data only.
const { randomUUID } = require('node:crypto');

// CI's DB-gated step selects suites by this exact line.
const SKIP = !process.env.DATABASE_URL;
const connection = process.env.DATABASE_URL;

jest.setTimeout(60000);

const NOW = new Date('2026-11-09T15:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const daysAgo = (d) => hoursAgo(d * 24);
const dateOnly = (d) => d.toISOString().slice(0, 10);

(SKIP ? describe.skip : describe)('new_plan_without_welcome (PostgreSQL)', () => {
  let database;
  let trx;
  let SEQUENCE_TYPE;
  let findIds;
  let DETECTORS;

  beforeAll(async () => {
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    ({ SEQUENCE_TYPE } = require('../services/new-recurring-welcome-sms'));
    const invariants = require('../services/lead-to-cash-invariants');
    findIds = invariants._private.newPlanWithoutWelcomeCustomerIds;
    DETECTORS = invariants.DETECTORS;
  });
  beforeEach(async () => { trx = await database.transaction(); });
  afterEach(async () => { await trx?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const newCustomer = async (over = {}) => {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Test', last_name: `Welcome-${id.slice(0, 6)}`, phone: '+15555550100', ...over });
    return id;
  };
  // A plan root created at `createdAt`; `followUpsAt` (optional) creates two
  // follow-up rows at that moment, as staff making an old visit recurring do.
  const newPlan = async (customerId, { createdAt = hoursAgo(30), followUpsAt = null, ...over } = {}) => {
    const rootId = randomUUID();
    await trx('scheduled_services').insert({
      id: rootId, customer_id: customerId, scheduled_date: dateOnly(daysAgo(-5)), service_type: 'Pest Control Service',
      status: 'confirmed', is_recurring: true, created_at: createdAt, ...over,
    });
    if (followUpsAt) {
      await trx('scheduled_services').insert([1, 2].map((n) => ({
        id: randomUUID(), customer_id: customerId, scheduled_date: dateOnly(daysAgo(-5 - 30 * n)), service_type: 'Pest Control Service',
        status: 'pending', is_recurring: true, recurring_parent_id: rootId, created_at: followUpsAt,
      })));
    }
    return rootId;
  };
  const found = async () => findIds(NOW, trx);
  const welcomeRow = (customerId, status) => ({ customer_id: customerId, sequence_type: SEQUENCE_TYPE, status });

  test('a plan made recurring at creation with no welcome row is found', async () => {
    const customerId = await newCustomer();
    await newPlan(customerId, { createdAt: hoursAgo(30) });
    expect(await found()).toContain(customerId);
  });

  test('the registered detector exists and the ids it reads are bare customer uuids', async () => {
    const customerId = await newCustomer();
    await newPlan(customerId);
    const detector = DETECTORS.find((d) => d.key === 'new_plan_without_welcome');
    expect(detector.href).toBe('/admin/customers');
    expect(typeof detector.run).toBe('function');
    expect(await found()).toContain(customerId);
  });

  test.each(['active', 'completed', 'cancelled'])('a welcome row with status %s clears the customer', async (status) => {
    const customerId = await newCustomer();
    await newPlan(customerId);
    await trx('sms_sequences').insert(welcomeRow(customerId, status));
    expect(await found()).not.toContain(customerId);
  });

  test('a sequence of another type does not clear the customer', async () => {
    const customerId = await newCustomer();
    await newPlan(customerId);
    await trx('sms_sequences').insert({ customer_id: customerId, sequence_type: 'review_request', status: 'completed' });
    expect(await found()).toContain(customerId);
  });

  test('a visit made recurring later (old root, recent follow-ups) is found', async () => {
    const customerId = await newCustomer();
    await newPlan(customerId, { createdAt: daysAgo(60), followUpsAt: hoursAgo(30) });
    expect(await found()).toContain(customerId);
  });

  test('a plan whose follow-ups are older than the window is not recent', async () => {
    const customerId = await newCustomer();
    await newPlan(customerId, { createdAt: daysAgo(60), followUpsAt: daysAgo(20) });
    expect(await found()).not.toContain(customerId);
  });

  test('only the first plan is judged: an older plan makes a recent one not first', async () => {
    const customerId = await newCustomer();
    await newPlan(customerId, { createdAt: daysAgo(40), status: 'cancelled' });
    await newPlan(customerId, { createdAt: hoursAgo(30) });
    expect(await found()).not.toContain(customerId);
  });

  test('inside the 3-hour grace the plan is not yet found, and just outside it is', async () => {
    const early = await newCustomer();
    await newPlan(early, { createdAt: hoursAgo(2) });
    const late = await newCustomer();
    await newPlan(late, { createdAt: hoursAgo(4) });
    const ids = await found();
    expect(ids).not.toContain(early);
    expect(ids).toContain(late);
  });

  test('a plan older than 14 days is outside the window', async () => {
    const customerId = await newCustomer();
    await newPlan(customerId, { createdAt: daysAgo(15) });
    expect(await found()).not.toContain(customerId);
  });

  test('a serviced visit older than the 90-day history window clears the customer, a newer one does not', async () => {
    const old = await newCustomer();
    await newPlan(old);
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: old, scheduled_date: dateOnly(daysAgo(120)), service_type: 'Pest Control Service', status: 'completed',
    });
    const recent = await newCustomer();
    await newPlan(recent);
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: recent, scheduled_date: dateOnly(daysAgo(30)), service_type: 'Pest Control Service', status: 'on_site',
    });
    const ids = await found();
    expect(ids).not.toContain(old);
    expect(ids).toContain(recent);
  });

  test('an old service record clears the customer unless it was cancelled', async () => {
    const served = await newCustomer();
    await newPlan(served);
    await trx('service_records').insert({ customer_id: served, service_date: dateOnly(daysAgo(150)), service_type: 'Pest Control Service', status: 'completed' });
    const cancelled = await newCustomer();
    await newPlan(cancelled);
    await trx('service_records').insert({ customer_id: cancelled, service_date: dateOnly(daysAgo(150)), service_type: 'Pest Control Service', status: 'cancelled' });
    const ids = await found();
    expect(ids).not.toContain(served);
    expect(ids).toContain(cancelled);
  });

  test('a Mark Won estimate linked to the plan root clears the customer', async () => {
    const customerId = await newCustomer();
    const estimateId = randomUUID();
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted', price_locked_by: 'manual_accept', accepted_at: hoursAgo(29) });
    await newPlan(customerId, { source_estimate_id: estimateId, source_action: 'admin_manual' });
    expect(await found()).not.toContain(customerId);
  });

  test('a Mark Won estimate accepted near the plan start clears the customer even with no link on the root', async () => {
    const customerId = await newCustomer();
    await trx('estimates').insert({ id: randomUUID(), customer_id: customerId, status: 'accepted', price_locked_by: 'manual_accept', accepted_at: hoursAgo(29) });
    await newPlan(customerId, { source_action: 'admin_manual' });
    expect(await found()).not.toContain(customerId);
  });

  test('an online accept (not Mark Won) does not clear the customer, and a plan from the admin route alone is still found', async () => {
    const online = await newCustomer();
    await trx('estimates').insert({ id: randomUUID(), customer_id: online, status: 'accepted', price_locked_by: 'customer_accept', accepted_at: hoursAgo(29) });
    await newPlan(online);
    const staff = await newCustomer();
    await newPlan(staff, { source_action: 'admin_manual' });
    const ids = await found();
    expect(ids).toContain(online);
    expect(ids).toContain(staff);
  });

  test('a Mark Won estimate accepted long before the plan does not clear the customer', async () => {
    const customerId = await newCustomer();
    await trx('estimates').insert({ id: randomUUID(), customer_id: customerId, status: 'accepted', price_locked_by: 'manual_accept', accepted_at: daysAgo(40) });
    await newPlan(customerId);
    expect(await found()).toContain(customerId);
  });

  test('a customer with no phone and no email is not found; an email alone is', async () => {
    const nobody = await newCustomer({ phone: '', email: null });
    await newPlan(nobody);
    const emailOnly = await newCustomer({ phone: '', email: 'someone@example.test' });
    await newPlan(emailOnly);
    const ids = await found();
    expect(ids).not.toContain(nobody);
    expect(ids).toContain(emailOnly);
  });

  test('a cancelled plan root is not found', async () => {
    const customerId = await newCustomer();
    await newPlan(customerId, { status: 'cancelled' });
    expect(await found()).not.toContain(customerId);
  });

  test('a commercial-only plan (tier Commercial) and a deleted customer are not found', async () => {
    const commercial = await newCustomer({ waveguard_tier: 'Commercial' });
    await newPlan(commercial);
    const deleted = await newCustomer({ deleted_at: hoursAgo(10) });
    await newPlan(deleted);
    const ids = await found();
    expect(ids).not.toContain(commercial);
    expect(ids).not.toContain(deleted);
  });

  test('a one-time visit with no recurring flag is not a plan', async () => {
    const customerId = await newCustomer();
    await newPlan(customerId, { is_recurring: false });
    expect(await found()).not.toContain(customerId);
  });

  test('a customer with two recent plans is listed once', async () => {
    const customerId = await newCustomer();
    await newPlan(customerId, { createdAt: hoursAgo(30) });
    await newPlan(customerId, { createdAt: hoursAgo(20) });
    expect((await found()).filter((id) => id === customerId)).toHaveLength(1);
  });
});
