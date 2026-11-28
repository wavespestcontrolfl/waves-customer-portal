/**
 * DB-backed history-total auto-order policy (services/procurement/history-order-policy.js)
 * against live Postgres: serialized under CAPS_LOCK_KEY, optimistic concurrency
 * (expectedRevision -> 409), catalog eligibility check when enabling, instant
 * unblocked emergency OFF even if catalog items went stale, and critical audit_log
 * written in the same transaction.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');

maybeDescribe('history-order-policy (live Postgres)', () => {
  let db;
  let policy;
  const TEST_KEY = `test.procurement.policy.${crypto.randomUUID()}`;
  const ACTOR = crypto.randomUUID();
  const made = { products_catalog: [], vendor_pricing: [] };

  beforeAll(() => {
    db = require('../models/db');
    policy = require('../services/procurement/history-order-policy');
  });

  afterEach(async () => {
    await db('system_settings').where({ key: TEST_KEY }).delete();
    if (made.vendor_pricing.length) await db('vendor_pricing').whereIn('id', made.vendor_pricing.splice(0)).delete();
    if (made.products_catalog.length) await db('products_catalog').whereIn('id', made.products_catalog.splice(0)).delete();
    await db('audit_log').where({ action: 'procurement.history_order_policy.updated', actor_id: ACTOR }).delete();
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function stickerProduct({ autoReorderEnabled = true, active = true, approvalStatus = 'approved', price = 314 } = {}) {
    const vendor = await db('vendors').where({ code: 25 }).first();
    const id = crypto.randomUUID();
    const sku = `sm-${id.slice(0, 8)}`;
    const [product] = await db('products_catalog').insert({
      id,
      name: `Fixture Sticker ${id.slice(0, 8)}`,
      category: 'supplies',
      active,
      inventory_unit: 'each',
      inventory_on_hand: 25,
      low_stock_threshold: 50,
      auto_reorder_enabled: autoReorderEnabled,
      auto_reorder_vendor_id: vendor.id,
      reorder_quantity: 500,
    }).returning('*');
    made.products_catalog.push(product.id);
    if (price != null) {
      const [vp] = await db('vendor_pricing').insert({
        product_id: product.id,
        vendor_id: vendor.id,
        price,
        quantity: '500 count',
        unit: 'each',
        vendor_sku: sku,
        approval_status: approvalStatus,
        is_active: true,
      }).returning('id');
      made.vendor_pricing.push(vp.id);
    }
    return { product, vendor, sku, itemKey: `stickermule:${sku}` };
  }

  test('defaults dark when absent, saves atomically with critical audit_log, and rejects stale expectedRevision (409)', async () => {
    const fx = await stickerProduct();
    expect(await policy.readHistoryOrderPolicy(db, { key: TEST_KEY })).toMatchObject({
      enabled: false,
      approvedItems: [],
      maxPerOrderCents: null,
      maxMonthlyCents: null,
      revision: 0,
      invalid: false,
    });

    const eligible = await policy.listEligibleHistoryItems(db);
    expect(eligible.find((i) => i.productId === fx.product.id)).toMatchObject({
      vendorSku: fx.sku,
      itemKey: fx.itemKey,
      eligible: true,
      unitPrice: 314,
    });

    const saved = await policy.saveHistoryOrderPolicy(
      db,
      { enabled: true, approvedItems: [fx.itemKey], maxPerOrderCents: 35000, maxMonthlyCents: 80000 },
      { actorId: ACTOR, expectedRevision: 0, key: TEST_KEY }
    );
    expect(saved.policy).toMatchObject({
      enabled: true,
      approvedItems: [fx.itemKey],
      maxPerOrderCents: 35000,
      maxMonthlyCents: 80000,
      revision: 1,
      updatedBy: ACTOR,
      invalid: false,
    });
    expect(policy.isItemApproved(saved.policy, 'stickermule', fx.sku)).toBe(true);

    const audits = await db('audit_log').where({ action: 'procurement.history_order_policy.updated', actor_id: ACTOR });
    expect(audits).toHaveLength(1);
    expect(audits[0].action.length).toBeLessThanOrEqual(96);
    expect(audits[0].resource_type).toBe('system_settings');
    expect(audits[0].metadata).toMatchObject({ key: TEST_KEY, before: { enabled: false, revision: 0 }, after: { enabled: true, revision: 1 } });

    // Stale tab (expectedRevision 0 instead of 1) is rejected with 409 Conflict.
    await expect(
      policy.saveHistoryOrderPolicy(
        db,
        { enabled: false, approvedItems: [], maxPerOrderCents: 35000, maxMonthlyCents: 80000 },
        { actorId: ACTOR, expectedRevision: 0, key: TEST_KEY }
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'policy_revision_conflict', currentRevision: 1 });
  });

  test('enabling refuses ineligible items; turning OFF always succeeds even after the product is deactivated', async () => {
    const unapproved = await stickerProduct({ approvalStatus: 'pending' });
    const disabled = await stickerProduct({ autoReorderEnabled: false });
    await expect(
      policy.saveHistoryOrderPolicy(
        db,
        { enabled: true, approvedItems: [unapproved.itemKey], maxPerOrderCents: 35000, maxMonthlyCents: 80000 },
        { actorId: ACTOR, expectedRevision: 0, key: TEST_KEY }
      )
    ).rejects.toMatchObject({ statusCode: 400, code: 'ineligible_item' });
    await expect(
      policy.saveHistoryOrderPolicy(
        db,
        { enabled: true, approvedItems: [disabled.itemKey], maxPerOrderCents: 35000, maxMonthlyCents: 80000 },
        { actorId: ACTOR, expectedRevision: 0, key: TEST_KEY }
      )
    ).rejects.toMatchObject({ statusCode: 400, code: 'ineligible_item' });

    // Enable a valid item, then deactivate the product: turning OFF must still succeed immediately.
    const live = await stickerProduct();
    await policy.saveHistoryOrderPolicy(
      db,
      { enabled: true, approvedItems: [live.itemKey], maxPerOrderCents: 35000, maxMonthlyCents: 80000 },
      { actorId: ACTOR, expectedRevision: 0, key: TEST_KEY }
    );
    await db('products_catalog').where({ id: live.product.id }).update({ active: false });

    const off = await policy.saveHistoryOrderPolicy(
      db,
      { enabled: false, approvedItems: [live.itemKey], maxPerOrderCents: 35000, maxMonthlyCents: 80000 },
      { actorId: ACTOR, expectedRevision: 1, key: TEST_KEY }
    );
    expect(off.policy).toMatchObject({ enabled: false, revision: 2 });
  });

  test('corrupted system_settings JSON fails closed on read and can be recovered at expectedRevision 0', async () => {
    await db('system_settings').insert({
      key: TEST_KEY,
      value: '{corrupted-json',
      category: 'procurement',
      description: 'fixture',
    });
    expect(await policy.readHistoryOrderPolicy(db, { key: TEST_KEY })).toMatchObject({
      enabled: false,
      revision: 0,
      invalid: true,
    });
    const repaired = await policy.saveHistoryOrderPolicy(
      db,
      { enabled: false, approvedItems: [], maxPerOrderCents: 35000, maxMonthlyCents: 80000 },
      { actorId: ACTOR, expectedRevision: 0, key: TEST_KEY }
    );
    expect(repaired.policy).toMatchObject({ enabled: false, revision: 1, invalid: false });
  });
});
