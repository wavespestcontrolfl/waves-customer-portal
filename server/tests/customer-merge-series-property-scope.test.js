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

// Relative dates (AGENTS.md date-sensitive test rule): the liveness rules
// under test (findActiveRecurringSeries' upcoming probe and
// cancelledParentStillLive) compare against today's ET date, so an
// anchored fixture would silently lapse once the calendar passed it.
const isoDaysAhead = (n) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString().slice(0, 10);

async function seedParent(customerId, { serviceId = null, serviceType = 'Monthly Pest Control', propertyId = null, addressStamp = null, parentStatus = 'confirmed', seedChild = true, sourceEstimateId = null } = {}) {
  const parentId = randomUUID();
  await db('scheduled_services').insert({
    id: parentId, customer_id: customerId, service_type: serviceType, service_id: serviceId,
    scheduled_date: isoDaysAhead(11), status: parentStatus, is_recurring: true, recurring_parent_id: null,
    recurring_pattern: 'monthly', recurring_ongoing: true, property_id: propertyId,
    ...(sourceEstimateId ? { source_estimate_id: sourceEstimateId } : {}),
    ...(addressStamp || {}),
  });
  if (seedChild) {
    await db('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: serviceType, service_id: serviceId,
      scheduled_date: isoDaysAhead(42), status: 'pending', is_recurring: true, recurring_parent_id: parentId,
      recurring_pattern: 'monthly', property_id: propertyId, ...(addressStamp || {}),
    });
  }
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

  test('a this_only-cancelled recurring PARENT with recurring_ongoing=true is still a live duplicate (round-3 GitHub Codex P1)', async () => {
    // admin-dispatch.js's single-occurrence ('this_only') cancel stamps the
    // PARENT row status='cancelled' while deliberately leaving
    // recurring_ongoing=true — findActiveRecurringSeries' own candidate set
    // (and the old pre-filter here) excludes every cancelled parent, so this
    // shape used to be invisible to the merge guard on either side.
    const winnerId = await makeCustomer({ address_line1: '9 Palm Ct', city: 'Bradenton', zip: '34205' });
    const loserId = await makeCustomer({ address_line1: '9 Palm Ct', city: 'Bradenton', zip: '34205' });
    await seedParent(winnerId, {}); // winner: a normal live (confirmed) parent.
    // loser: this_only-cancelled anchor, still recurring_ongoing, no child
    // seeded yet (mirrors the real shape: the next occurrence isn't due).
    await seedParent(loserId, { parentStatus: 'cancelled', seedChild: false });

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).not.toBeNull();
    expect(conflict.code).toBe('duplicate_series_conflict');
  });

  test('a COMPLETED fixed-length series (recurring_ongoing=false, no upcoming child) is lapsed, not a live duplicate (pre-push audit P1)', async () => {
    const winnerId = await makeCustomer({ address_line1: '11 Palm Ct', city: 'Bradenton', zip: '34205' });
    const loserId = await makeCustomer({ address_line1: '11 Palm Ct', city: 'Bradenton', zip: '34205' });
    await seedParent(winnerId, {}); // winner: a normal live parent.
    // loser: historical series — completed parent, ongoing flag cleared,
    // no children left. findActiveRecurringSeries judges this lapsed and
    // the cancelled-but-ongoing union must not resurrect it.
    const loserParentId = await seedParent(loserId, { parentStatus: 'completed', seedChild: false });
    await db('scheduled_services').where({ id: loserParentId }).update({ recurring_ongoing: false, scheduled_date: isoDaysAhead(-250) });

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).toBeNull();
  });

  test('winner: normal series at A + this_only-cancelled ongoing anchor at B; loser live at B → still conflicts (pre-push audit P1)', async () => {
    const winnerId = await makeCustomer({ address_line1: '13 Palm Ct', city: 'Bradenton', zip: '34205' });
    const loserId = await makeCustomer({ address_line1: '77 Shell Ave', city: 'Bradenton', zip: '34205' });
    const stampB = { service_address_line1: '77 Shell Ave', service_address_city: 'Bradenton', service_address_zip: '34205' };
    await seedParent(winnerId, {}); // A: the winner's home, a normal live parent.
    await seedParent(winnerId, { parentStatus: 'cancelled', seedChild: false, addressStamp: stampB }); // B: cancelled anchor, still ongoing.
    await seedParent(loserId, { addressStamp: stampB }); // loser: live series at B.

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).not.toBeNull();
    expect(conflict.code).toBe('duplicate_series_conflict');
  });

  test('a this_only-cancelled FIXED-LENGTH parent (recurring_ongoing=false) with a future child still scheduled is a live duplicate, on either side (pre-push audit P1)', async () => {
    for (const cancelledSide of ['loser', 'winner']) {
      const winnerId = await makeCustomer({ address_line1: '15 Palm Ct', city: 'Bradenton', zip: '34205' });
      const loserId = await makeCustomer({ address_line1: '15 Palm Ct', city: 'Bradenton', zip: '34205' });
      const cancelledOwner = cancelledSide === 'loser' ? loserId : winnerId;
      const liveOwner = cancelledSide === 'loser' ? winnerId : loserId;
      await seedParent(liveOwner, {});
      // Fixed-length series: parent cancelled this_only, ongoing flag OFF,
      // but its next occurrence is still on the books.
      const parentId = await seedParent(cancelledOwner, { parentStatus: 'cancelled', seedChild: true });
      await db('scheduled_services').where({ id: parentId }).update({ recurring_ongoing: false });

      const winner = await db('customers').where({ id: winnerId }).first();
      const loser = await db('customers').where({ id: loserId }).first();
      const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
      expect(conflict).not.toBeNull();
      expect(conflict.code).toBe('duplicate_series_conflict');
    }
  });

  test('cancelled fixed-length parent liveness follows track_state over a stale status, in both directions (round-8 GitHub Codex P1)', async () => {
    const isoDaysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const cases = [
      // Tech rolling on a past-dated child whose status sync failed → live.
      { status: 'confirmed', track_state: 'en_route', expectConflict: true },
      // Tracker says done, status stuck at 'rescheduled' → lapsed.
      { status: 'rescheduled', track_state: 'complete', expectConflict: false },
    ];
    for (const c of cases) {
      const winnerId = await makeCustomer({ address_line1: '16 Palm Ct', city: 'Bradenton', zip: '34205' });
      const loserId = await makeCustomer({ address_line1: '16 Palm Ct', city: 'Bradenton', zip: '34205' });
      await seedParent(winnerId, {});
      const parentId = await seedParent(loserId, { parentStatus: 'cancelled', seedChild: true });
      await db('scheduled_services').where({ id: parentId }).update({ recurring_ongoing: false });
      await db('scheduled_services').where({ recurring_parent_id: parentId })
        .update({ scheduled_date: isoDaysAgo(2), status: c.status, track_state: c.track_state });

      const winner = await db('customers').where({ id: winnerId }).first();
      const loser = await db('customers').where({ id: loserId }).first();
      const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
      if (c.expectConflict) expect(conflict?.code).toBe('duplicate_series_conflict');
      else expect(conflict).toBeNull();
    }
  });

  test('a NON-cancelled fixed-length series: liveness keeps the rescheduled/in-progress date exemptions and follows track_state over a stale status (pre-push audit on 9c802b806a)', async () => {
    const isoDaysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const cases = [
      { status: 'rescheduled', track_state: 'scheduled', expectConflict: true }, // r15/r21 rebook intent
      { status: 'on_site', track_state: 'scheduled', expectConflict: true }, // r25 in progress
      { status: 'confirmed', track_state: 'on_property', expectConflict: true }, // tracker leads status
      { status: 'confirmed', track_state: 'scheduled', expectConflict: false }, // plain past row: lapsed
      { status: 'rescheduled', track_state: 'cancelled', expectConflict: false }, // tracker pulled it
    ];
    for (const c of cases) {
      const winnerId = await makeCustomer({ address_line1: '17 Palm Ct', city: 'Bradenton', zip: '34205' });
      const loserId = await makeCustomer({ address_line1: '17 Palm Ct', city: 'Bradenton', zip: '34205' });
      await seedParent(winnerId, {});
      const parentId = await seedParent(loserId, { seedChild: true });
      await db('scheduled_services').where({ id: parentId })
        .update({ recurring_ongoing: false, status: 'completed', scheduled_date: isoDaysAgo(30) });
      await db('scheduled_services').where({ recurring_parent_id: parentId })
        .update({ scheduled_date: isoDaysAgo(2), status: c.status, track_state: c.track_state });

      const winner = await db('customers').where({ id: winnerId }).first();
      const loser = await db('customers').where({ id: loserId }).first();
      const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
      if (c.expectConflict) expect([c, conflict?.code]).toEqual([c, 'duplicate_series_conflict']);
      else expect([c, conflict]).toEqual([c, null]);
    }
  });

  test('UNSTAMPED parents whose source estimates are linked to the same secondary property conflict, even with different home addresses (pre-push audit P1)', async () => {
    const winnerId = await makeCustomer({ address_line1: '1 Alpha St', city: 'Sarasota', zip: '34231' });
    const loserId = await makeCustomer({ address_line1: '5 Beta Ave', city: 'Sarasota', zip: '34232' });
    const winnerPropertyId = randomUUID();
    const loserPropertyId = randomUUID();
    await db('customer_properties').insert([
      { id: winnerPropertyId, customer_id: winnerId, label: 'Rental', address_line1: '22 Sample Way', city: 'Sarasota', zip: '34231', is_primary: false },
      { id: loserPropertyId, customer_id: loserId, label: 'Rental', address_line1: '22 Sample Way', city: 'Sarasota', zip: '34231', is_primary: false },
    ]);
    const winnerEstimateId = randomUUID();
    const loserEstimateId = randomUUID();
    await db('estimates').insert([
      { id: winnerEstimateId, customer_id: winnerId, property_id: winnerPropertyId, address: '22 Sample Way, Sarasota, FL 34231', status: 'accepted' },
      { id: loserEstimateId, customer_id: loserId, property_id: loserPropertyId, address: '22 Sample Way, Sarasota, FL 34231', status: 'accepted' },
    ]);
    // No property_id, no service_address_* on either parent — only the
    // creating estimate knows these series serve the rental, not the home.
    await seedParent(winnerId, { sourceEstimateId: winnerEstimateId });
    await seedParent(loserId, { sourceEstimateId: loserEstimateId });

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).not.toBeNull();
    expect(conflict.code).toBe('duplicate_series_conflict');
  });

  test('UNSTAMPED parents whose source estimates carry the same free-text secondary address and NO property link still conflict (round-5 GitHub Codex P1)', async () => {
    const winnerId = await makeCustomer({ address_line1: '1 Alpha St', city: 'Sarasota', zip: '34231' });
    const loserId = await makeCustomer({ address_line1: '5 Beta Ave', city: 'Sarasota', zip: '34232' });
    const winnerEstimateId = randomUUID();
    const loserEstimateId = randomUUID();
    await db('estimates').insert([
      { id: winnerEstimateId, customer_id: winnerId, property_id: null, address: '22 Sample Way, Sarasota, FL 34231', status: 'accepted' },
      { id: loserEstimateId, customer_id: loserId, property_id: null, address: '22 Sample Way, Sarasota, FL 34231', status: 'accepted' },
    ]);
    await seedParent(winnerId, { sourceEstimateId: winnerEstimateId });
    await seedParent(loserId, { sourceEstimateId: loserEstimateId });

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).not.toBeNull();
    expect(conflict.code).toBe('duplicate_series_conflict');
  });

  test('a recurring-shaped CALLBACK on the winner is not a live plan — merge is not blocked (round-6 GitHub Codex P2)', async () => {
    const winnerId = await makeCustomer({ address_line1: '17 Palm Ct', city: 'Bradenton', zip: '34205' });
    const loserId = await makeCustomer({ address_line1: '17 Palm Ct', city: 'Bradenton', zip: '34205' });
    const callbackId = await seedParent(winnerId, { seedChild: false });
    await db('scheduled_services').where({ id: callbackId }).update({ is_callback: true });
    await seedParent(loserId, {}); // loser: the real plan.

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    const conflict = await dedupe.dbLevelMergeConflict(db, winner, loser);
    expect(conflict).toBeNull();
  });
});
