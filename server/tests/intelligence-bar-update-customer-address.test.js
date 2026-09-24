// Verifies the Intelligence Bar `update_customer` tool keeps an address edit
// consistent with the Customers route (PUT /:id): the primary customer_properties
// row is synced ATOMICALLY (a unique-index collision rolls back with a clear
// error) and the customer is re-geocoded so the map pin / dispatch drive-time use
// the new location. A plain `customers` update used to leave both stale — the bug
// behind "I updated the address but it still shows the old one."

jest.mock('../models/db', () => {
  const qb = {};
  qb.where = jest.fn(() => qb);
  qb.whereIn = jest.fn(() => qb);
  qb.whereNull = jest.fn(() => qb);
  qb.forUpdate = jest.fn(() => qb);
  qb.first = jest.fn();
  // The bulk fast path pre-reads before-rows (FOR UPDATE) whenever tier or
  // rate is in the update — for the #3245 rate-changed ledger sync and the
  // #3140 implied-monthly lane stamp. Empty = no rate changes, no stamps.
  qb.select = jest.fn(() => Promise.resolve([]));
  qb.update = jest.fn(() => Promise.resolve(1));
  const db = jest.fn(() => qb);
  // trx behaves like db() — the executor only uses trx('customers').where().update()
  db.transaction = jest.fn(async (cb) => cb(db));
  // advisory locks (customer-comms / customer-email) go through trx.raw
  db.raw = jest.fn(() => Promise.resolve());
  db.__qb = qb;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-properties', () => ({
  syncPrimaryAddress: jest.fn(() => Promise.resolve()),
  syncPrimaryCoordsFromCustomer: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/customer-address-fanout', () => ({
  propagateCustomerAddressChange: jest.fn(() => Promise.resolve({ leads: 0, estimates: 0 })),
}));
jest.mock('../services/geocoder', () => ({
  ensureCustomerGeocoded: jest.fn(() => Promise.resolve({ latitude: 27.1, longitude: -82.4 })),
}));
// Churn billing disarm disclosure (GitHub Codex #4684 r4): churnGuardOrRepair
// itself (its live-visit/prepay-term/pending-invoice checks and its call
// into cancellation-processor.js's disarm helpers) is exercised elsewhere
// (customer-lifecycle-guard's own tests) — here it is mocked so the tool
// RESULT shape can be asserted for both the blocked and wound-down paths
// without re-deriving every one of its DB reads.
jest.mock('../services/customer-lifecycle-guard', () => ({
  churnGuardOrRepair: jest.fn(),
  describeLiveVisit: jest.fn(() => 'This customer still has a scheduled visit'),
}));

const db = require('../models/db');
const customerProperties = require('../services/customer-properties');
const addressFanout = require('../services/customer-address-fanout');
const geocoder = require('../services/geocoder');
const { churnGuardOrRepair } = require('../services/customer-lifecycle-guard');
const { executeTool } = require('../services/intelligence-bar/tools');

const CUSTOMER_ID = 'cust-1';
const baseRow = {
  id: CUSTOMER_ID, first_name: 'Jenny', last_name: 'Miguel',
  address_line1: '123 Old Street', city: 'Bradenton', state: 'FL', zip: '34205',
  pipeline_stage: 'new_lead', member_since: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  db.transaction.mockImplementation(async (cb) => cb(db));
});

test('an address change syncs the primary property atomically and re-geocodes', async () => {
  db.__qb.first
    .mockResolvedValueOnce(baseRow) // before (pre-transaction read)
    .mockResolvedValueOnce(baseRow) // locked in-transaction read (FOR UPDATE)
    .mockResolvedValueOnce({ ...baseRow, address_line1: '9136 93rd Run E', city: 'Parrish', zip: '34219' }); // after

  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID,
    updates: { address_line1: '9136 93rd Run E', city: 'Parrish', zip: '34219' },
  });

  expect(result.success).toBe(true);
  // property mirror + lead/estimate snapshot fan-out synced inside the transaction
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(customerProperties.syncPrimaryAddress).toHaveBeenCalledTimes(1);
  expect(addressFanout.propagateCustomerAddressChange).toHaveBeenCalledTimes(1);
  expect(addressFanout.propagateCustomerAddressChange).toHaveBeenCalledWith(
    expect.objectContaining({
      before: expect.objectContaining({ address_line1: '123 Old Street' }),
      after: expect.objectContaining({ address_line1: '9136 93rd Run E' }),
    }),
    expect.anything(),
  );
  // coords cleared, then a re-geocode kicked off
  expect(db.__qb.update).toHaveBeenCalledWith(expect.objectContaining({ latitude: null, longitude: null }));
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledWith(CUSTOMER_ID);
});

test('a colliding address rolls back and returns a clear error, no geocode', async () => {
  db.__qb.first
    .mockResolvedValueOnce(baseRow) // before
    .mockResolvedValueOnce(baseRow); // locked in-transaction read (liveness re-assert, GH r10 P1)
  const dup = new Error('duplicate key'); dup.code = '23505';
  customerProperties.syncPrimaryAddress.mockRejectedValueOnce(dup);

  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID,
    updates: { address_line1: '9136 93rd Run E', city: 'Parrish', zip: '34219' },
  });

  expect(result).toEqual({ error: 'That address already exists as another property on this customer.' });
  expect(geocoder.ensureCustomerGeocoded).not.toHaveBeenCalled();
});

test('resubmitting the same address still syncs + re-geocodes (self-heals a stale row)', async () => {
  // customers.address_* already equals the submitted value (a prior pre-fix IB edit
  // updated the text but skipped the mirror/geocode). A diff-vs-customer-row check
  // would skip the heal; presence-based must still run sync + geocode.
  db.__qb.first
    .mockResolvedValueOnce(baseRow) // before — address already matches what we submit
    .mockResolvedValueOnce(baseRow) // locked in-transaction read
    .mockResolvedValueOnce(baseRow); // after

  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID,
    updates: { address_line1: '123 Old Street', city: 'Bradenton', state: 'FL', zip: '34205' },
  });

  expect(result.success).toBe(true);
  expect(customerProperties.syncPrimaryAddress).toHaveBeenCalledTimes(1);
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledWith(CUSTOMER_ID);
});

test('a non-address change does not touch the property mirror or geocoder', async () => {
  db.__qb.first
    .mockResolvedValueOnce(baseRow) // before
    .mockResolvedValueOnce(baseRow) // locked in-transaction read
    .mockResolvedValueOnce({ ...baseRow, crm_notes: 'gate code 1234' }); // after

  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID,
    updates: { notes: 'gate code 1234' },
  });

  expect(result.success).toBe(true);
  expect(customerProperties.syncPrimaryAddress).not.toHaveBeenCalled();
  expect(addressFanout.propagateCustomerAddressChange).not.toHaveBeenCalled();
  expect(geocoder.ensureCustomerGeocoded).not.toHaveBeenCalled();
});

test('a bulk ADDRESS edit takes the per-row path: mirror + fan-out + re-geocode per row', async () => {
  const rowA = { ...baseRow, id: 'cust-a' };
  const rowB = { ...baseRow, id: 'cust-b' };
  db.__qb.first
    .mockResolvedValueOnce(rowA) // before (cust-a)
    .mockResolvedValueOnce(rowA) // locked read (cust-a)
    .mockResolvedValueOnce(rowB) // before (cust-b)
    .mockResolvedValueOnce(rowB); // locked read (cust-b)

  const result = await executeTool('bulk_update_customers', {
    customer_ids: ['cust-a', 'cust-b'],
    updates: { address_line1: '9136 93rd Run E', city: 'Parrish', zip: '34219' },
  });

  expect(result.success).toBe(true);
  expect(result.updated_count).toBe(2);
  // one transaction per row, each with the mirror + snapshot fan-out
  expect(db.transaction).toHaveBeenCalledTimes(2);
  expect(customerProperties.syncPrimaryAddress).toHaveBeenCalledTimes(2);
  expect(addressFanout.propagateCustomerAddressChange).toHaveBeenCalledTimes(2);
  // stale coords cleared, re-geocode kicked off for each row
  expect(db.__qb.update).toHaveBeenCalledWith(expect.objectContaining({ latitude: null, longitude: null }));
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledWith('cust-a');
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledWith('cust-b');
});

describe('churn billing disarm disclosure in the tool RESULT (GitHub Codex #4684 r4)', () => {
  test('update_customer stage->churned reports billing_wound_down when churnGuardOrRepair does not block', async () => {
    db.__qb.first
      .mockResolvedValueOnce(baseRow) // before (pre-transaction read)
      .mockResolvedValueOnce(baseRow) // locked in-transaction read (FOR UPDATE)
      .mockResolvedValueOnce({ ...baseRow, pipeline_stage: 'churned', active: false }); // after
    churnGuardOrRepair.mockResolvedValueOnce({ blocked: false });

    const result = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID,
      updates: { pipeline_stage: 'churned' },
    });

    expect(result.success).toBe(true);
    // churnGuardOrRepair (Codex #4715 parent round-6 rename/widen of
    // churnGuardForRow) takes the locked row as a 3rd arg for its
    // already-churned rail-only-repair decision.
    expect(churnGuardOrRepair).toHaveBeenCalledWith(expect.anything(), CUSTOMER_ID, expect.anything());
    expect(result.billing_wound_down).toBe(true);
    expect(result.billing_wound_down_fields).toEqual(expect.arrayContaining([
      'active', 'autopay_enabled', 'next_charge_date', 'payment_methods.autopay_enabled', 'payments.next_retry_at',
    ]));
    // Codex #4715 r1 P2: the completed card only renders warning/error/message
    // on an ordinary result — the structured fields above are invisible
    // without this.
    expect(result.message).toBe('Billing wound down: Auto Pay off (customer + saved methods), next charge date and armed retries cleared.');
  });

  test('update_customer stage->churned refuses (no billing_wound_down) when churnGuardOrRepair blocks on a live visit', async () => {
    db.__qb.first
      .mockResolvedValueOnce(baseRow) // before
      .mockResolvedValueOnce(baseRow); // locked in-transaction read
    churnGuardOrRepair.mockResolvedValueOnce({
      blocked: true,
      liveVisit: { liveReason: 'upcoming_visit', scheduled_date: '2026-10-01', status: 'confirmed' },
      liveTerm: null,
      pendingPrepayInvoice: null,
      error: 'still has a scheduled visit — use "Cancel plan…" first',
    });

    const result = await executeTool('update_customer', {
      customer_id: CUSTOMER_ID,
      updates: { pipeline_stage: 'churned' },
    });

    expect(result.error).toMatch(/^Cannot mark Churned:/);
    expect(result.preview_changed).toBe(true);
    expect(result.billing_wound_down).toBeUndefined();
    expect(result.message).toBeUndefined();
  });

  test('bulk_update_customers (fast CASE path) reports billing_wound_down_count for non-blocked rows and skips the blocked one', async () => {
    db.__qb.select.mockResolvedValueOnce([{ id: 'cust-a' }, { id: 'cust-b' }, { id: 'cust-c' }]);
    churnGuardOrRepair.mockImplementation((trx, cid) => Promise.resolve(
      cid === 'cust-b' ? { blocked: true, error: 'still has an active prepay term — use "Cancel plan…" first' } : { blocked: false },
    ));

    const result = await executeTool('bulk_update_customers', {
      customer_ids: ['cust-a', 'cust-b', 'cust-c'],
      updates: { pipeline_stage: 'churned' },
    });

    expect(result.success).toBe(true);
    expect(churnGuardOrRepair).toHaveBeenCalledTimes(3);
    expect(result.billing_wound_down_count).toBe(2);
    expect(result.skipped_customers).toEqual(expect.arrayContaining([
      expect.objectContaining({ customer_id: 'cust-b' }),
    ]));
    expect(result.message).toBe('Billing wound down for 2 customer(s): Auto Pay off (customer + saved methods), next charge date and armed retries cleared.');
    // Codex #4715 r2 P2: the card renders `warning` first and hides
    // `message` on a partial update — the wind-down sentence must ride in
    // `warning` too, not only in `message`.
    expect(result.warning).toContain('Billing wound down for 2 customer(s)');
  });

  test('bulk_update_customers (per-row path, churn + address combined) reports billing_wound_down_count only for the row that committed', async () => {
    const rowA = { ...baseRow, id: 'cust-a' };
    const rowB = { ...baseRow, id: 'cust-b' };
    db.__qb.first
      .mockResolvedValueOnce(rowA) // before (cust-a)
      .mockResolvedValueOnce(rowA) // locked read (cust-a)
      .mockResolvedValueOnce(rowB) // before (cust-b)
      .mockResolvedValueOnce(rowB); // locked read (cust-b)
    churnGuardOrRepair.mockImplementation((trx, cid) => Promise.resolve(
      cid === 'cust-b' ? { blocked: true, error: 'still has a scheduled visit — use "Cancel plan…" first' } : { blocked: false },
    ));

    const result = await executeTool('bulk_update_customers', {
      customer_ids: ['cust-a', 'cust-b'],
      updates: { pipeline_stage: 'churned', city: 'Venice' },
    });

    expect(result.success).toBe(true);
    expect(result.updated_count).toBe(1);
    expect(result.billing_wound_down_count).toBe(1);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ customer_id: 'cust-b' }),
    ]));
    expect(result.message).toBe('Billing wound down for 1 customer(s): Auto Pay off (customer + saved methods), next charge date and armed retries cleared.');
    // Codex #4715 r2 P2: same as the fast CASE path — `warning` must carry
    // the wind-down sentence too, since the card hides `message` when a
    // `warning` is also present.
    expect(result.warning).toContain('Billing wound down for 1 customer(s)');
  });
});

test('a bulk NON-address edit skips per-customer fanout (one transaction, no address machinery)', async () => {
  // The scalar path now resolves the LIVE pinned set first (GH r9 on
  // #3648) — the first select is that live-row read; later selects (lane
  // beforeRows) keep the empty default.
  db.__qb.select.mockResolvedValueOnce([{ id: 'cust-a' }, { id: 'cust-b' }]);
  const result = await executeTool('bulk_update_customers', {
    customer_ids: ['cust-a', 'cust-b'],
    updates: { waveguard_tier: 'gold' },
  });

  expect(result.success).toBe(true);
  // The non-address path wraps the bulk scalar write + plan-rate-ledger
  // syncs in ONE transaction (codex #3245 r3) — but never the per-customer
  // address/email fanout machinery.
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(customerProperties.syncPrimaryAddress).not.toHaveBeenCalled();
  expect(addressFanout.propagateCustomerAddressChange).not.toHaveBeenCalled();
  expect(geocoder.ensureCustomerGeocoded).not.toHaveBeenCalled();
});
