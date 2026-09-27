// CI's DB-gated pass runs this against the migrated PostgreSQL (same
// convention as purchase-receipts-postgres.test.js — the SKIP pattern CI
// greps for). Fixture tables are LIKE copies (constraints, defaults and the
// extended status CHECK included) in a unique schema dropped after the
// suite. The LLM leg is stubbed (a fixed decision per test — the deterministic
// validation itself is covered in inventory-agent.test.js); everything from
// there down — locking, the duplicate guard, adjustStock, the alias insert,
// the bell committing on the SAME transaction, and a concurrent run applying
// only once — runs for real.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { runInventoryAgent, drainAgentQueue, productUnchangedSinceAgent } = require('../services/purchase-receipts/inventory-agent');
const inventoryOperations = require('../services/inventory-operations');
const notifications = require('../services/notification-service');
const { undoLine } = require('../../ops/agents/inventory-agent-undo');

const TABLES = ['products_catalog', 'product_aliases', 'product_inventory_movements', 'product_restock_requests', 'purchase_receipt_lines', 'notifications', 'emails', 'email_attachments'];
const RECEIVED_AT = new Date('2026-09-27T15:00:00Z');
const HOUR = 60 * 60 * 1000;

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('inventory agent on PostgreSQL', () => {
  const schema = `inventory_agent_${randomUUID().replaceAll('-', '')}`;
  const GATE_ORIGINAL = process.env.GATE_INVENTORY_AGENT;
  let taurus;

  // Every test but the explicit "gated off" one below runs with the gate on
  // (runInventoryAgent self-checks it — see the module header).
  const SINCE_ORIGINAL = process.env.PURCHASE_RECEIPT_SINCE;
  beforeEach(() => {
    process.env.GATE_INVENTORY_AGENT = 'true';
    process.env.PURCHASE_RECEIPT_SINCE = '2026-09-01T00:00:00Z';
  });
  afterAll(() => {
    if (GATE_ORIGINAL === undefined) delete process.env.GATE_INVENTORY_AGENT;
    else process.env.GATE_INVENTORY_AGENT = GATE_ORIGINAL;
    if (SINCE_ORIGINAL === undefined) delete process.env.PURCHASE_RECEIPT_SINCE;
    else process.env.PURCHASE_RECEIPT_SINCE = SINCE_ORIGINAL;
  });

  beforeAll(async () => {
    mockConn = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 4 } });
    await mockConn.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await mockConn.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
  });
  beforeEach(async () => {
    [taurus] = await mockConn('products_catalog').insert({
      name: 'Taurus SC', active: true, category: 'insecticide', container_size: '78 fl oz', inventory_unit: 'fl_oz', inventory_on_hand: 0,
    }).returning('*');
  });
  afterEach(async () => {
    for (const table of TABLES) await mockConn.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => {
    await mockConn.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await mockConn.destroy();
  });

  // One agent_pending line + the email it came from.
  async function pendingLine(overrides = {}) {
    const [email] = await mockConn('emails').insert({
      gmail_id: `gm-${randomUUID()}`, gmail_thread_id: 'thread', from_address: 'order-update@amazon.com',
      subject: 'Delivered: 1 item', authentication_results: 'dkim=pass header.i=@amazon.com; spf=pass smtp.mailfrom=amazon.com',
      received_at: RECEIVED_AT,
    }).returning('*');
    const [row] = await mockConn('purchase_receipt_lines').insert({
      vendor: 'amazon', order_number: '900-2000002-2000002', shipment_key: 'ship-2', line_no: 1,
      raw_title: 'Bifen XTS Insecticide 96 oz', quantity: 2, product_id: null, status: 'agent_pending',
      email_id: email.id, ...overrides,
    }).returning('*');
    return row;
  }

  // Resolves once some session is blocked on an advisory lock (the catalog
  // lock), so a race test releases its held transaction only after the other
  // side is really waiting, never on a guess about timing.
  async function waitForLockWaiter() {
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await mockConn.raw("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'");
      if (rows[0].n > 0) return;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    throw new Error('no session ever waited on the catalog lock');
  }

  const notifyAdmin = (...args) => notifications.notifyAdmin(...args);
  const run = (llm, overrides = {}) => runInventoryAgent({ conn: mockConn, llm: async () => llm, notifyAdmin, ...overrides });
  const stockOf = async (id) => Number((await mockConn('products_catalog').where({ id }).first()).inventory_on_hand);
  const bellsFor = (lineId) => mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`purchase-receipt:${lineId}`]);

  test('an unmatched line the model resolves as a new product: catalog row + alias + movement + logged line + one bell, all in one transaction', async () => {
    const line = await pendingLine();
    const decision = {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: 'Bifenthrin', epa_reg_no: null },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    const result = await run({ ok: true, json: decision });
    expect(result).toMatchObject({ logged: 1, held: 0, stillPending: 0, errors: 0 });

    const created = await mockConn('products_catalog').where({ name: 'Bifen XTS' }).first();
    expect(created).toMatchObject({ active: true, category: 'insecticide', container_size: '96 oz', inventory_unit: 'oz', default_unit: 'oz', best_vendor: 'Amazon' });
    // The model proposed 'Bifenthrin' (see the decision above) — never
    // persisted. createCatalogProduct's own placeholder is what's written.
    expect(created.active_ingredient).toBe('Unknown - pending SDS');
    expect(await stockOf(created.id)).toBe(192); // 2 ordered x 96 oz

    const alias = await mockConn('product_aliases').where({ product_id: created.id }).first();
    expect(alias).toMatchObject({ alias_name: 'Bifen XTS Insecticide 96 oz' });

    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'logged', product_id: created.id, agent_created_product_id: created.id, agent_created_alias_id: alias.id });
    expect(saved.movement_id).not.toBeNull();

    const [movement] = await mockConn('product_inventory_movements').where({ product_id: created.id });
    expect(movement).toMatchObject({ movement_type: 'restock', quantity: '192.0000', unit: 'oz' });
    expect(movement.metadata).toMatchObject({ source: 'amazon_delivery', inventoryAgent: true, rawTitle: 'Bifen XTS Insecticide 96 oz' });

    expect(await bellsFor(line.id)).toHaveLength(1);
  });

  test('undo safety: the product row hash recorded after the agent restock holds until any later stock write', async () => {
    const line = await pendingLine();
    const decision = {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    const movement = await mockConn('product_inventory_movements').where({ id: saved.movement_id }).first();
    expect(saved.agent_decision.productRowHash).toEqual(expect.any(String));
    expect(await productUnchangedSinceAgent(mockConn, saved, movement)).toEqual({ ok: true });

    // A later count on the product, whatever its created_at, changes the row.
    await inventoryOperations.adjustStock(saved.product_id, { movementType: 'correction', setTotal: 150, unit: 'oz' }, { source: 'admin_manual_adjustment' });
    const after = await productUnchangedSinceAgent(mockConn, saved, movement);
    expect(after.ok).toBe(false);
  });

  test('undo safety: an edit that does NOT bump updated_at (import enrichment, best-price recalculation) still fails the check — the hash catches it where updated_at alone would not', async () => {
    const line = await pendingLine();
    const decision = {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    const movement = await mockConn('product_inventory_movements').where({ id: saved.movement_id }).first();

    // A price/import-style edit to a field the undo check never looked at
    // before (best_vendor), with updated_at left exactly as the agent wrote
    // it — the kind of write import enrichment and best-price recalculation
    // do, per the review.
    const before = await mockConn('products_catalog').where({ id: saved.product_id }).first();
    await mockConn('products_catalog').where({ id: saved.product_id }).update({ best_vendor: 'SiteOne' }); // no updated_at touch
    const after = await mockConn('products_catalog').where({ id: saved.product_id }).first();
    expect(after.updated_at).toEqual(before.updated_at); // confirms the edit really left updated_at alone

    expect(await productUnchangedSinceAgent(mockConn, saved, movement)).toMatchObject({ ok: false });
  });

  test('a correcting alias added while the model decides rolls the apply back; the line stays pending with one attempt', async () => {
    const [bifenXts] = await mockConn('products_catalog').insert({
      name: 'Bifen XTS', active: true, category: 'insecticide', container_size: '96 oz', inventory_unit: 'oz', inventory_on_hand: 0,
    }).returning('*');
    const [bifenIt] = await mockConn('products_catalog').insert({
      name: 'Bifen IT', active: true, category: 'insecticide', container_size: '96 oz', inventory_unit: 'oz', inventory_on_hand: 0,
    }).returning('*');
    const title = 'Bifen Insecticide Concentrate 96 oz';
    const line = await pendingLine({ raw_title: title, quantity: 1 });
    const decision = {
      kind: 'existing', reason: 'looks like Bifen XTS', product_id: bifenXts.id, new_product: null,
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    // An admin links this exact title to Bifen IT while the model is still deciding.
    const llm = async () => {
      await mockConn('product_aliases').insert({ product_id: bifenIt.id, alias_name: title });
      return { ok: true, json: decision };
    };
    const result = await runInventoryAgent({ conn: mockConn, llm, notifyAdmin });
    expect(result).toMatchObject({ logged: 0 });

    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'agent_pending', agent_attempts: 1 });
    expect(await mockConn('product_inventory_movements').whereIn('product_id', [bifenXts.id, bifenIt.id])).toHaveLength(0);
    expect(await mockConn('product_aliases').where({ product_id: bifenXts.id })).toHaveLength(0);
  });

  test('a pending line whose email row is gone goes to a person on the first pass instead of blocking the queue', async () => {
    const line = await pendingLine();
    await mockConn('purchase_receipt_lines').where({ id: line.id }).update({ email_id: null });
    const llm = jest.fn(async () => ({ ok: true, json: { kind: 'unsure', reason: 'unused' } }));
    await runInventoryAgent({ conn: mockConn, llm, notifyAdmin });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved.status).toBe('agent_unsure');
    expect(saved.agent_decision).toMatchObject({ reason: 'its email record is gone' });
    expect(llm).not.toHaveBeenCalled();
    expect(await bellsFor(line.id)).toHaveLength(1);
  });

  test('a shipment handed to a person by a later email closes the pending line without stock', async () => {
    const line = await pendingLine();
    const [other] = await mockConn('emails').insert({
      gmail_id: `gm-${randomUUID()}`, gmail_thread_id: 'thread', from_address: 'order-update@amazon.com',
      subject: 'Delivered: 1 item', received_at: RECEIVED_AT,
    }).returning('*');
    await mockConn('purchase_receipt_lines').insert({
      vendor: 'amazon', order_number: 'unknown', shipment_key: 'ship-2', line_no: 1,
      raw_title: 'Bifen XTS Insecticide 96 oz', quantity: 2, status: 'no_order_number', email_id: other.id,
    });
    const decision = {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    const result = await run({ ok: true, json: decision });
    // 'skipped' is never person-facing (no bell) — it must count as
    // `ignored`, not inflate `held` (review item 6).
    expect(result).toMatchObject({ logged: 0, held: 0, ignored: 1 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'skipped', movement_id: null });
    expect(saved.agent_decision).toMatchObject({ reason: 'shipment_handed_to_person' });
    expect(await mockConn('products_catalog').where({ name: 'Bifen XTS' })).toHaveLength(0);
    expect(await bellsFor(line.id)).toHaveLength(0);
  });

  test('a product added by hand while the agent creates the same item is never duplicated', async () => {
    const line = await pendingLine();
    const decision = {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    let signalLocked;
    const locked = new Promise((resolve) => { signalLocked = resolve; });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    // The admin screen's insert, holding its transaction (and the catalog
    // lock) open until the agent is waiting on that lock.
    const manual = mockConn.transaction(async (trx) => {
      await inventoryOperations.createCatalogProduct({ name: 'Bifen XTS', category: 'insecticide', unitSize: '96 oz', inventoryUnit: 'oz' }, { trx });
      signalLocked();
      await held;
    });
    await locked;
    const agent = run({ ok: true, json: decision });
    await waitForLockWaiter();
    release();
    await manual;
    await agent;

    expect(await mockConn('products_catalog').where({ name: 'Bifen XTS' })).toHaveLength(1);
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'agent_pending', agent_attempts: 1 });
  });

  test('an admin add that waits on the agent\'s create never duplicates the item (agent first)', async () => {
    let signalLocked;
    const locked = new Promise((resolve) => { signalLocked = resolve; });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    // The agent's insert, holding its transaction (and the catalog lock) open.
    const agentSide = mockConn.transaction(async (trx) => {
      await inventoryOperations.createCatalogProduct({ name: 'Bifen XTS', category: 'insecticide', unitSize: '96 oz', inventoryUnit: 'oz' },
        { trx, source: 'inventory_agent_create', guard: async () => false });
      signalLocked();
      await held;
    });
    await locked;
    const adminSide = inventoryOperations.createCatalogProduct({ name: ' bifen xts ', category: 'insecticide', unitSize: '96 oz', inventoryUnit: 'oz' });
    await waitForLockWaiter();
    release();
    await agentSide;
    expect(await adminSide).toBeNull();
    expect(await mockConn('products_catalog').whereRaw('lower(btrim(name)) = ?', ['bifen xts'])).toHaveLength(1);
  });

  test('with no valid PURCHASE_RECEIPT_SINCE the agent does nothing', async () => {
    const line = await pendingLine();
    delete process.env.PURCHASE_RECEIPT_SINCE;
    const llm = jest.fn();
    expect(await runInventoryAgent({ conn: mockConn, llm, notifyAdmin })).toEqual({ skipped: 'no_since' });
    expect(llm).not.toHaveBeenCalled();
    expect((await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).status).toBe('agent_pending');
  });

  test('a pending line received before a cutoff that moved forward closes without stock or a bell', async () => {
    const line = await pendingLine();
    process.env.PURCHASE_RECEIPT_SINCE = new Date(RECEIVED_AT.getTime() + HOUR).toISOString();
    const llm = jest.fn();
    await runInventoryAgent({ conn: mockConn, llm, notifyAdmin });
    expect(llm).not.toHaveBeenCalled();
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'skipped', movement_id: null });
    expect(saved.agent_decision).toMatchObject({ reason: 'received_before_cutoff' });
    expect(await bellsFor(line.id)).toHaveLength(0);
  });

  test('a new count product is created with each as both its stock and application unit', async () => {
    const line = await pendingLine({ raw_title: 'Snap Trap Rat Trap 12 Count', quantity: 1 });
    const decision = {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Snap Trap Rat Trap', category: 'supplies', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '12 Count', size_number: 12, size_unit: 'each', pack_text: null, pack_count: 1 },
    };
    await mockConn('products_catalog').insert({ name: 'Category Seed', active: true, category: 'supplies' });
    const result = await run({ ok: true, json: decision });
    expect(result).toMatchObject({ logged: 1 });
    const created = await mockConn('products_catalog').where({ name: 'Snap Trap Rat Trap' }).first();
    expect(created).toMatchObject({ inventory_unit: 'each', default_unit: 'each' });
    expect(await stockOf(created.id)).toBe(12);
    expect((await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).status).toBe('logged');
  });

  test('the logged bell warns to cancel a live restock request instead of receiving it', async () => {
    await mockConn('product_restock_requests').insert({
      product_id: taurus.id, status: 'open', requested_quantity: 78, unit: 'fl_oz', source: 'auto_reorder',
    });
    const line = await pendingLine({ raw_title: 'Control Solutions Taurus SC Termiticide 78 oz', product_id: taurus.id, quantity: 1 });
    const decision = {
      kind: 'existing', reason: 'the matched product', product_id: taurus.id, new_product: null,
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    const [bell] = await bellsFor(line.id);
    expect(bell.message || bell.body || JSON.stringify(bell)).toMatch(/restock request for Taurus SC is still open/);
  });

  test('an EXISTING count product whose default_unit is still the admin default and never used yet: the restock fixes it to each (review item 1)', async () => {
    const [trapProduct] = await mockConn('products_catalog').insert({
      name: 'Victor Rat Trap', active: true, category: 'supplies', container_size: '12 count', inventory_unit: null, default_unit: 'oz', inventory_on_hand: 0,
    }).returning('*');
    const line = await pendingLine({ raw_title: 'Victor Rat Trap 12 Count', product_id: trapProduct.id, quantity: 5 });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: trapProduct.id, new_product: null,
      reading: { size_text: '12 Count', size_number: 12, size_unit: 'each', pack_text: null, pack_count: 1 },
    };
    const result = await run({ ok: true, json: decision });
    expect(result).toMatchObject({ logged: 1, held: 0 });
    const updated = await mockConn('products_catalog').where({ id: trapProduct.id }).first();
    expect(updated).toMatchObject({ inventory_unit: 'each', default_unit: 'each' });
    expect(await stockOf(trapProduct.id)).toBe(60); // 5 ordered x 12 count
    const [bell] = await bellsFor(line.id);
    expect(bell.body).toMatch(/application unit to each/);
  });

  test('an EXISTING count product whose default_unit already carries usage and can\'t take a count holds for a person instead of silently deducting nothing later (review item 1)', async () => {
    const [trapProduct] = await mockConn('products_catalog').insert({
      name: 'Victor Rat Trap', active: true, category: 'supplies', container_size: '12 count', inventory_unit: null, default_unit: 'oz', inventory_on_hand: 5,
    }).returning('*');
    // Prior usage under the ounce-based default_unit — this product is
    // already "in service" that way, so the agent must not silently flip it.
    await mockConn('product_inventory_movements').insert({
      product_id: trapProduct.id, movement_type: 'correction', quantity: 5, unit: 'oz', stock_before: 0, stock_after: 5,
      metadata: { source: 'admin_manual_adjustment' },
    });
    const line = await pendingLine({ raw_title: 'Victor Rat Trap 12 Count', product_id: trapProduct.id, quantity: 5 });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: trapProduct.id, new_product: null,
      reading: { size_text: '12 Count', size_number: 12, size_unit: 'each', pack_text: null, pack_count: 1 },
    };
    const result = await run({ ok: true, json: decision });
    expect(result).toMatchObject({ logged: 0, held: 1 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'agent_unsure' });
    expect(saved.agent_decision).toMatchObject({ reason: 'application_unit_incompatible_with_count' });
    expect(await stockOf(trapProduct.id)).toBe(5); // never applied
    const [bell] = await bellsFor(line.id);
    expect(bell.body).toMatch(/application unit can't take a count/);
  });

  test('undo restores container_size/inventory_unit/inventory_on_hand/default_unit to their originals on an EXISTING product (review item 2)', async () => {
    const [trapProduct] = await mockConn('products_catalog').insert({
      name: 'Victor Rat Trap', active: true, category: 'supplies', container_size: '12 count', inventory_unit: null, default_unit: 'oz', inventory_on_hand: 0,
    }).returning('*');
    const line = await pendingLine({ raw_title: 'Victor Rat Trap 12 Count', product_id: trapProduct.id, quantity: 5 });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: trapProduct.id, new_product: null,
      reading: { size_text: '12 Count', size_number: 12, size_unit: 'each', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    // Confirm the agent really did change all three fields, so the undo
    // assertion below is proof of restoration, not a no-op.
    const afterAgent = await mockConn('products_catalog').where({ id: trapProduct.id }).first();
    expect(afterAgent).toMatchObject({ inventory_unit: 'each', default_unit: 'each', inventory_on_hand: '60.0000' });

    const outcome = await undoLine(mockConn, { lineArg: line.id, execute: true, log: () => {} });
    expect(outcome).toEqual({ executed: true });

    const restored = await mockConn('products_catalog').where({ id: trapProduct.id }).first();
    expect(restored).toMatchObject({ container_size: '12 count', inventory_unit: null, default_unit: 'oz' });
    expect(Number(restored.inventory_on_hand)).toBe(0);
    const savedLine = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(savedLine.status).toBe('agent_unsure');
    expect(savedLine.agent_decision.undoneAt).toEqual(expect.any(String));
    // The compensating movement is still on the ledger (kept, never edited).
    const movements = await mockConn('product_inventory_movements').where({ product_id: trapProduct.id }).orderBy('created_at', 'asc');
    expect(movements).toHaveLength(2); // the original restock + the undo's correction
    expect(movements[1]).toMatchObject({ movement_type: 'correction' });
  });

  test('undo returns an originally-UNTRACKED product to null (not 0) — inventory_on_hand and its unit both revert (review item 2)', async () => {
    const [bare] = await mockConn('products_catalog').insert({
      name: 'Granular Bait Untracked', active: true, category: 'bait', container_size: null, inventory_unit: null, default_unit: 'oz', inventory_on_hand: null,
    }).returning('*');
    const line = await pendingLine({ raw_title: 'Granular Bait Untracked 16 oz Bag', product_id: bare.id, quantity: 2 });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: bare.id, new_product: null,
      reading: { size_text: '16 oz', size_number: 16, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    const afterAgent = await mockConn('products_catalog').where({ id: bare.id }).first();
    expect(afterAgent.container_size).toBe('16 oz'); // setContainerSize fired
    expect(Number(afterAgent.inventory_on_hand)).toBe(32); // 2 x 16 oz — no longer untracked

    await undoLine(mockConn, { lineArg: line.id, execute: true, log: () => {} });

    const restored = await mockConn('products_catalog').where({ id: bare.id }).first();
    expect(restored.container_size).toBeNull();
    expect(restored.inventory_unit).toBeNull();
    expect(restored.inventory_on_hand).toBeNull(); // back to untracked, never 0
    expect(restored.default_unit).toBe('oz');
  });

  test('undo dry-runs by default and refuses when the product changed since the agent\'s restock', async () => {
    const line = await pendingLine({ raw_title: 'Taurus SC Termiticide 78 oz', product_id: taurus.id, quantity: 2, shipment_key: 'ship-undo-refuse' });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: taurus.id, new_product: null,
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    const dryRun = await undoLine(mockConn, { lineArg: line.id, execute: false, log: () => {} });
    expect(dryRun).toEqual({ executed: false });
    expect(await stockOf(taurus.id)).toBe(156); // dry run never writes

    // Something else touches the product after the agent's restock.
    await inventoryOperations.adjustStock(taurus.id, { movementType: 'correction', setTotal: 999, unit: 'fl_oz' }, { source: 'admin_manual_adjustment' });
    await expect(undoLine(mockConn, { lineArg: line.id, execute: true, log: () => {} }))
      .rejects.toThrow(/product changed after the agent's restock/);
    expect(await stockOf(taurus.id)).toBe(999); // refused — untouched
  });

  test('a real hand-off through processReceiptLine saves handoffFrom, and a gate-off drain restores that status', async () => {
    const { processReceiptLine } = require('../services/purchase-receipts/receipt-processor');
    const { drainAgentQueue } = require('../services/purchase-receipts/inventory-agent');
    await mockConn('products_catalog').insert({
      name: 'Granular Bait', active: true, category: 'bait', container_size: null, inventory_unit: null, inventory_on_hand: 0,
    });
    const [email] = await mockConn('emails').insert({
      gmail_id: `gm-${randomUUID()}`, gmail_thread_id: 'thread', from_address: 'order-update@amazon.com',
      subject: 'Delivered: 1 item', received_at: RECEIVED_AT,
    }).returning('*');
    const handed = await processReceiptLine({
      vendor: 'amazon', email, orderNumber: '900-3000003-3000003', shipmentKey: 'ship-3', lineNo: 1,
      item: { title: 'Granular Bait 16 oz Bag', quantity: 1 }, ringBell: async () => {},
    }, mockConn);
    expect(handed.status).toBe('agent_pending');
    const queued = await mockConn('purchase_receipt_lines').where({ id: handed.lineId }).first();
    expect(queued.agent_decision).toEqual({ handoffFrom: 'needs_size' });

    process.env.GATE_INVENTORY_AGENT = 'false';
    await drainAgentQueue({ conn: mockConn, notifyAdmin });
    const drained = await mockConn('purchase_receipt_lines').where({ id: handed.lineId }).first();
    expect(drained.status).toBe('needs_size');
    expect(await bellsFor(handed.lineId)).toHaveLength(1);
  });

  test('a needs_size line: the model reads the title\'s size, the catalog container is set once, and the line logs', async () => {
    const [bare] = await mockConn('products_catalog').insert({
      name: 'Granular Bait', active: true, category: 'bait', container_size: null, inventory_unit: null, inventory_on_hand: 0,
    }).returning('*');
    const line = await pendingLine({ raw_title: 'Granular Bait 16 oz Bag', product_id: bare.id, quantity: 2 });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: bare.id, new_product: null,
      reading: { size_text: '16 oz', size_number: 16, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    const result = await run({ ok: true, json: decision });
    expect(result).toMatchObject({ logged: 1, held: 0 });

    const updated = await mockConn('products_catalog').where({ id: bare.id }).first();
    expect(updated.container_size).toBe('16 oz');
    expect(await stockOf(bare.id)).toBe(32); // 2 ordered x 16 oz

    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'logged', product_id: bare.id, agent_created_product_id: null, agent_created_alias_id: null });
    // A product the line was already matched to (needs_size) never gets an
    // agent alias — only a line that started with no product_id at all.
    expect(await mockConn('product_aliases').where({ product_id: bare.id })).toHaveLength(0);
  });

  test('the duplicate guard: a manual restock around the same time holds the line instead of logging it', async () => {
    await mockConn('product_inventory_movements').insert({
      product_id: taurus.id, movement_type: 'restock', quantity: 10, unit: 'fl_oz',
      metadata: { source: 'intelligence_bar_adjust_stock' }, created_at: new Date(RECEIVED_AT.getTime() - 10 * HOUR),
    });
    const line = await pendingLine({ raw_title: 'Taurus SC Termiticide 78 oz', product_id: taurus.id, quantity: 2 });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: taurus.id, new_product: null,
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    const result = await run({ ok: true, json: decision });
    expect(result).toMatchObject({ held: 1, logged: 0 });

    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'possible_duplicate', product_id: taurus.id });
    expect(saved.movement_id).toBeNull();
    expect(await stockOf(taurus.id)).toBe(0);
    expect(await bellsFor(line.id)).toHaveLength(1);
  });

  test('concurrent runs over the SAME line apply it exactly once', async () => {
    const line = await pendingLine({ raw_title: 'Taurus SC Termiticide 78 oz', product_id: taurus.id, quantity: 2 });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: taurus.id, new_product: null,
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    const results = await Promise.all([run({ ok: true, json: decision }), run({ ok: true, json: decision })]);
    expect(results.reduce((sum, r) => sum + r.logged, 0)).toBe(1);
    expect(results.reduce((sum, r) => sum + r.stillPending, 0)).toBe(1);

    expect(await stockOf(taurus.id)).toBe(156); // 2 x 78 fl oz, exactly once
    const movements = await mockConn('product_inventory_movements').where({ product_id: taurus.id });
    expect(movements).toHaveLength(1);
    expect(await bellsFor(line.id)).toHaveLength(1);
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved.status).toBe('logged');
  });

  test('two DIFFERENT titles the model independently proposes the SAME new-product name for, in one run: exactly one product is created (the reload-per-line + in-transaction collision re-check, review item 1)', async () => {
    const decisionFor = (sizeText) => ({
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: sizeText, size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    });
    // Deliberately no shared words between the two titles — the deterministic
    // matcher (alias or whole-word containment) cannot tie the second title
    // to the product the first creates, so item 3's matchedProductId guard
    // never fires here; only the new-product collision guard can catch it.
    const titleA = 'Bifen XTS Insecticide Concentrate 96 oz';
    const titleB = 'Atticus Bifenthrin 7.9 IT 96 oz Termiticide Concentrate';
    const lineA = await pendingLine({ raw_title: titleA, shipment_key: 'ship-a', order_number: '900-8000001-0000001' });
    const lineB = await pendingLine({ raw_title: titleB, shipment_key: 'ship-b', order_number: '900-8000002-0000002' });
    const dispatch = async (route, payload) => {
      if (payload.text.includes(titleA)) return { ok: true, json: decisionFor('96 oz') };
      if (payload.text.includes(titleB)) return { ok: true, json: decisionFor('96 oz') };
      throw new Error(`unexpected prompt: ${payload.text.slice(0, 80)}`);
    };
    await Promise.all([
      runInventoryAgent({ conn: mockConn, llm: dispatch, notifyAdmin }),
      runInventoryAgent({ conn: mockConn, llm: dispatch, notifyAdmin }),
    ]);

    const products = await mockConn('products_catalog').where({ name: 'Bifen XTS' });
    expect(products).toHaveLength(1); // never two, however the race lands

    const lines = await mockConn('purchase_receipt_lines').whereIn('id', [lineA.id, lineB.id]);
    for (const line of lines) {
      // Applied (to the one product that exists) or left pending for a
      // later run to pick up as a now-matchable candidate — never anything
      // that implies a second catalog row.
      if (line.status === 'logged') expect(line.product_id).toBe(products[0].id);
      else expect(['agent_pending', 'agent_unsure']).toContain(line.status);
    }
  });

  test('an apply-time throw (e.g. a bell that fails to save) counts toward agent_attempts like an LLM failure; the 3rd hands off to a person', async () => {
    const line = await pendingLine({ raw_title: 'Taurus SC Termiticide 78 oz', product_id: taurus.id, quantity: 2, shipment_key: 'ship-throw' });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: taurus.id, new_product: null,
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    // Fails ONLY the success bell (the same "a bell that can't be saved
    // rolls the whole line back" discipline the deterministic lane's own
    // tests already rely on) — the hand-off bell on the 3rd try still goes
    // through, so this is a real, repeatable apply-time throw, not a
    // contrived one.
    const flakyNotify = async (category, title, body, opts) => {
      if (title === 'Inventory agent logged a purchase') throw new Error('notification service down');
      return notifications.notifyAdmin(category, title, body, opts);
    };
    const runOnce = () => runInventoryAgent({ conn: mockConn, llm: async () => ({ ok: true, json: decision }), notifyAdmin: flakyNotify });

    const r1 = await runOnce();
    expect(r1.errors).toBe(0); // the failure was recorded, not surfaced as a run-level error
    expect(await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).toMatchObject({ status: 'agent_pending', agent_attempts: 1 });
    expect(await stockOf(taurus.id)).toBe(0); // the whole apply rolled back with the bell — no partial write

    await runOnce();
    expect(await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).toMatchObject({ status: 'agent_pending', agent_attempts: 2 });

    await runOnce();
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'agent_unsure', agent_attempts: 3 });
    expect(saved.agent_decision.reason).toMatch(/notification service down/);
    expect(await stockOf(taurus.id)).toBe(0); // never applied
    expect(await bellsFor(line.id)).toHaveLength(1); // only the hand-off bell landed
  });

  test('totals: not_stock (agent_ignored) counts as `ignored`, never `held` — held is person-facing statuses only', async () => {
    const line = await pendingLine({ raw_title: 'Personal Kindle Case' });
    const result = await run({ ok: true, json: { kind: 'not_stock', reason: 'a personal purchase, not stock' } });
    expect(result).toMatchObject({ logged: 0, held: 0, ignored: 1, stillPending: 0 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved.status).toBe('agent_ignored');
    expect(await bellsFor(line.id)).toHaveLength(0); // agent_ignored rings nothing
  });

  test('totals: agent_equipment and possible_duplicate still count as `held` (the person-facing statuses)', async () => {
    await pendingLine({ raw_title: 'Backpack Sprayer 4 gal' });
    const equipmentResult = await run({ ok: true, json: { kind: 'equipment', reason: 'a backpack sprayer' } });
    expect(equipmentResult).toMatchObject({ held: 1, ignored: 0 });

    await mockConn('product_inventory_movements').insert({
      product_id: taurus.id, movement_type: 'restock', quantity: 10, unit: 'fl_oz',
      metadata: { source: 'intelligence_bar_adjust_stock' }, created_at: new Date(RECEIVED_AT.getTime() - 10 * HOUR),
    });
    const dupLine = await pendingLine({ raw_title: 'Taurus SC Termiticide 78 oz', product_id: taurus.id, quantity: 2, shipment_key: 'ship-dup' });
    const dupDecision = {
      kind: 'existing', reason: 'matches the candidate', product_id: taurus.id, new_product: null,
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    const dupResult = await run({ ok: true, json: dupDecision });
    expect(dupResult).toMatchObject({ held: 1, ignored: 0 });
    expect((await mockConn('purchase_receipt_lines').where({ id: dupLine.id }).first()).status).toBe('possible_duplicate');
  });

  test('the catalog renaming or recategorizing the candidate while the model decides rolls the apply back as product_changed — not just container_size/inventory_unit (review item 7)', async () => {
    const line = await pendingLine({ raw_title: 'Taurus SC Termiticide 78 oz', product_id: taurus.id, quantity: 1 });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: taurus.id, new_product: null,
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    // An admin renames the product between the candidate read (before the
    // "LLM call" below) and the apply transaction's own re-read under lock.
    const llm = async () => {
      await mockConn('products_catalog').where({ id: taurus.id }).update({ name: 'Taurus SC (Renamed)' });
      return { ok: true, json: decision };
    };
    const result = await runInventoryAgent({ conn: mockConn, llm, notifyAdmin });
    expect(result).toMatchObject({ logged: 0, stillPending: 1 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'agent_pending', agent_attempts: 1 });
    expect(await stockOf(taurus.id)).toBe(0); // never applied against the stale name
  });

  test('drainAgentQueue: gate-off restores queued lines to the status they would have held under without the agent (review item 2)', async () => {
    const unmatchedLine = await pendingLine({ raw_title: 'Unmatched Item', product_id: null });
    await mockConn('purchase_receipt_lines').where({ id: unmatchedLine.id }).update({ agent_decision: { handoffFrom: 'unmatched' } });

    const [bare] = await mockConn('products_catalog').insert({
      name: 'Granular Bait', active: true, category: 'bait', container_size: null, inventory_unit: null, inventory_on_hand: 0,
    }).returning('*');
    const needsSizeLine = await pendingLine({ raw_title: 'Granular Bait 16 oz Bag', product_id: bare.id, shipment_key: 'ship-needs-size' });
    await mockConn('purchase_receipt_lines').where({ id: needsSizeLine.id }).update({ agent_decision: { handoffFrom: 'needs_size' } });

    const sizeMismatchLine = await pendingLine({ raw_title: 'Taurus SC Termiticide 999 oz', product_id: taurus.id, shipment_key: 'ship-mismatch' });
    await mockConn('purchase_receipt_lines').where({ id: sizeMismatchLine.id }).update({ agent_decision: { handoffFrom: 'size_mismatch' } });

    // No recorded handoffFrom at all (defensive default).
    const noHandoffLine = await pendingLine({ raw_title: 'No Handoff Recorded', product_id: null, shipment_key: 'ship-no-handoff' });

    const llm = jest.fn();
    const result = await drainAgentQueue({ conn: mockConn, notifyAdmin, limit: 25 });
    expect(llm).not.toHaveBeenCalled(); // no LLM call at all
    expect(result).toMatchObject({ drained: 4, errors: 0 });

    expect((await mockConn('purchase_receipt_lines').where({ id: unmatchedLine.id }).first()).status).toBe('unmatched');
    expect((await mockConn('purchase_receipt_lines').where({ id: needsSizeLine.id }).first()).status).toBe('needs_size');
    expect((await mockConn('purchase_receipt_lines').where({ id: sizeMismatchLine.id }).first()).status).toBe('size_mismatch');
    expect((await mockConn('purchase_receipt_lines').where({ id: noHandoffLine.id }).first()).status).toBe('unmatched');

    // unmatched rings nothing; needs_size/size_mismatch ring the same "not
    // added" bell the deterministic sweep rings for those statuses.
    expect(await bellsFor(unmatchedLine.id)).toHaveLength(0);
    expect(await bellsFor(noHandoffLine.id)).toHaveLength(0);
    expect(await bellsFor(needsSizeLine.id)).toHaveLength(1);
    expect(await bellsFor(sizeMismatchLine.id)).toHaveLength(1);
    const mismatchBell = (await bellsFor(sizeMismatchLine.id))[0];
    expect(mismatchBell.body).toMatch(/doesn't match the catalog container size/);
  });

  test('drainAgentQueue: a line no longer agent_pending by the time it\'s locked is left alone', async () => {
    const line = await pendingLine({ agent_decision: { handoffFrom: 'unmatched' } });
    await mockConn('purchase_receipt_lines').where({ id: line.id }).update({ status: 'logged' });
    const result = await drainAgentQueue({ conn: mockConn, notifyAdmin, limit: 25 });
    expect(result).toMatchObject({ drained: 0, errors: 0 });
    expect((await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).status).toBe('logged');
  });

  test('gated off: runInventoryAgent does nothing', async () => {
    delete process.env.GATE_INVENTORY_AGENT;
    await pendingLine();
    const result = await run({ ok: true, json: { kind: 'not_stock', reason: 'x' } });
    expect(result).toEqual({ skipped: 'gated' });
    expect((await mockConn('purchase_receipt_lines')).every((r) => r.status === 'agent_pending')).toBe(true);
  });
});
