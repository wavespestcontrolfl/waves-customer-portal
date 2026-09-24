/**
 * ADMIN-BUG-R15 follow-up (Codex review, round 1 on PR #4684) — three
 * correctness gaps in the merge duplicate-series property comparison:
 *
 *  1. The check used to be gated on the two customers' PRIMARY addresses
 *     matching, so an address-mismatched pair (exactly what /link-as-property
 *     exists to merge) never even ran the series-level comparison, even when
 *     both sides' series actually served the SAME saved property.
 *  2. The per-series property key collapsed to a bare normalized street,
 *     dropping unit/line2/city/ZIP — two different units of one building (or
 *     the same street name in two different cities) read as one property.
 *  3. The family match was by service_type TEXT only, so a catalog rename
 *     that changed a series' service_type label but kept its service_id
 *     could dodge the guard entirely.
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL). Exercises
 * dbLevelMergeConflict directly — the function both executeMerge and the IB
 * preview share.
 */
const { randomUUID } = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));

const db = require('../models/db');
const dedupe = require('../services/customer-dedupe');

jest.setTimeout(60000);

async function makeService(name) {
  const id = randomUUID();
  await db('services').insert({ id, service_key: `test_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${id.slice(0, 8)}`, name, category: 'pest_control' });
  return id;
}

async function makeCustomer(overrides) {
  const id = randomUUID();
  await db('customers').insert({
    id, first_name: 'Series', last_name: 'Scope',
    phone: `9415551${String(Math.floor(Math.random() * 900) + 100)}`,
    pipeline_stage: 'active_customer', active: true, created_at: new Date(),
    ...overrides,
  });
  return id;
}

async function seedParent(customerId, { serviceId = null, serviceType = 'Monthly Pest Control', propertyId = null, addressStamp = null } = {}) {
  const parentId = randomUUID();
  await db('scheduled_services').insert({
    id: parentId, customer_id: customerId, service_type: serviceType, service_id: serviceId,
    scheduled_date: '2026-10-05', status: 'confirmed', is_recurring: true, recurring_parent_id: null,
    recurring_pattern: 'monthly', recurring_ongoing: true, property_id: propertyId,
    ...(addressStamp || {}),
  });
  await db('scheduled_services').insert({
    id: randomUUID(), customer_id: customerId, service_type: serviceType, service_id: serviceId,
    scheduled_date: '2026-11-05', status: 'pending', is_recurring: true, recurring_parent_id: parentId,
    recurring_pattern: 'monthly', property_id: propertyId, ...(addressStamp || {}),
  });
  return parentId;
}

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('duplicate-series merge guard: property scope + service_id identity (real PG)', () => {
  afterAll(async () => { await db.destroy(); });

  test('link-as-property merge: same secondary property via property_id, different primary addresses → conflict', async () => {
    const winnerId = await makeCustomer({ address_line1: '1 Alpha St', city: 'Sarasota', zip: '34231' });
    const loserId = await makeCustomer({ address_line1: '5 Beta Ave', city: 'Sarasota', zip: '34232' });
    // A single customer_properties row stands in for the shared secondary
    // property both sides' series are stamped to — the FK only requires the
    // row to exist, not that it belong to either customer_id, which is
    // exactly the shape a resolved property_id-linked pair produces.
    const propertyId = randomUUID();
    await db('customer_properties').insert({
      id: propertyId, customer_id: winnerId, label: 'Shared secondary', address_line1: '22 Sample Way', city: 'Sarasota', zip: '34231', is_primary: false,
    });
    await seedParent(winnerId, { propertyId });
    await seedParent(loserId, { propertyId });

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).not.toBeNull();
    expect(conflict.code).toBe('duplicate_series_conflict');
  });

  test('two units of one building: same street, different units → allowed (no conflict)', async () => {
    const winnerId = await makeCustomer({ address_line1: '500 Ocean Dr', address_line2: 'Apt 101', city: 'Sarasota', zip: '34231' });
    const loserId = await makeCustomer({ address_line1: '500 Ocean Dr', address_line2: 'Apt 202', city: 'Sarasota', zip: '34231' });
    await seedParent(winnerId, {});
    await seedParent(loserId, {});

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).toBeNull();
  });

  test('renamed service_type with the SAME service_id still conflicts (same address)', async () => {
    const serviceId = await makeService('Monthly Pest Control');
    const winnerId = await makeCustomer({ address_line1: '9 Palm Ct', city: 'Bradenton', zip: '34205' });
    const loserId = await makeCustomer({ address_line1: '9 Palm Ct', city: 'Bradenton', zip: '34205' });
    await seedParent(winnerId, { serviceId, serviceType: 'Monthly Pest Control' });
    // Catalog rename: same service_id, different label text — a pure
    // text/family match would miss this.
    await seedParent(loserId, { serviceId, serviceType: 'Pest Control (Monthly Plan)' });

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).not.toBeNull();
    expect(conflict.code).toBe('duplicate_series_conflict');
  });

  test('distinct customer-owned property_id rows at the SAME real address still conflict (round-1 GitHub Codex P1)', async () => {
    // Each customer independently saved the same physical address as their
    // OWN customer_properties row — two different property_id UUIDs, same
    // address_line1/city/zip. A bare property_id inequality must not be
    // read as "different premises".
    const winnerId = await makeCustomer({ address_line1: '1 Alpha St', city: 'Sarasota', zip: '34231' });
    const loserId = await makeCustomer({ address_line1: '5 Beta Ave', city: 'Sarasota', zip: '34232' });
    const winnerPropertyId = randomUUID();
    const loserPropertyId = randomUUID();
    await db('customer_properties').insert([
      { id: winnerPropertyId, customer_id: winnerId, label: 'Rental', address_line1: '22 Sample Way', city: 'Sarasota', zip: '34231', is_primary: false },
      { id: loserPropertyId, customer_id: loserId, label: 'Rental', address_line1: '22 Sample Way', city: 'Sarasota', zip: '34231', is_primary: false },
    ]);
    await seedParent(winnerId, { propertyId: winnerPropertyId });
    await seedParent(loserId, { propertyId: loserPropertyId });

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).not.toBeNull();
    expect(conflict.code).toBe('duplicate_series_conflict');
  });

  test('a stamped unitless secondary address does not inherit either owner\'s home unit (round-1 GitHub Codex P1)', async () => {
    // Both series are stamped to the SAME unitless secondary address
    // (no property_id, no service_address_line2) — but the two customers'
    // own HOME addresses carry DIFFERENT units. The secondary property's key
    // must come from the stamp alone; borrowing either owner's home unit
    // would either falsely diverge (blocking nothing) or, worse, could
    // falsely agree with a third, unrelated match.
    const winnerId = await makeCustomer({ address_line1: '1 Alpha St', address_line2: 'Apt 9', city: 'Sarasota', zip: '34231' });
    const loserId = await makeCustomer({ address_line1: '5 Beta Ave', address_line2: 'Unit 4', city: 'Sarasota', zip: '34232' });
    const sharedStamp = { service_address_line1: '22 Sample Way', service_address_line2: null, service_address_city: 'Sarasota', service_address_zip: '34231' };
    await seedParent(winnerId, { addressStamp: sharedStamp });
    await seedParent(loserId, { addressStamp: sharedStamp });

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).not.toBeNull();
    expect(conflict.code).toBe('duplicate_series_conflict');
  });

  test('same street + unit, one side missing ZIP → still conflicts (round-2 GitHub Codex P1)', async () => {
    // addressCompat's own rule: an optional locality component (ZIP, city,
    // unit) only disqualifies a match when BOTH sides provide it and they
    // disagree — a missing ZIP on one side must not read as a mismatch.
    const winnerId = await makeCustomer({ address_line1: '500 Ocean Dr', address_line2: 'Apt 101', city: 'Sarasota', zip: '34231' });
    const loserId = await makeCustomer({ address_line1: '500 Ocean Dr', address_line2: 'Apt 101', city: 'Sarasota', zip: null });
    await seedParent(winnerId, {});
    await seedParent(loserId, {});

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).not.toBeNull();
    expect(conflict.code).toBe('duplicate_series_conflict');
  });

  test('same street, DIFFERENT ZIP on both sides → no conflict (round-2 GitHub Codex P1)', async () => {
    // Both sides provide a ZIP and they genuinely disagree — a real mismatch
    // addressCompat must still reject, not a missing-field false negative.
    const winnerId = await makeCustomer({ address_line1: '500 Ocean Dr', city: 'Sarasota', zip: '34231' });
    const loserId = await makeCustomer({ address_line1: '500 Ocean Dr', city: 'Sarasota', zip: '34285' });
    await seedParent(winnerId, {});
    await seedParent(loserId, {});

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).toBeNull();
  });
});
