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

const { runInventoryAgent, productUnchangedSinceAgent } = require('../services/purchase-receipts/inventory-agent');
const inventoryOperations = require('../services/inventory-operations');
const notifications = require('../services/notification-service');

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

  test('undo safety: the product row version recorded after the agent restock holds until any later stock write', async () => {
    const line = await pendingLine();
    const decision = {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    const movement = await mockConn('product_inventory_movements').where({ id: saved.movement_id }).first();
    expect(saved.agent_decision.productRowVersion).toEqual(expect.any(String));
    expect(await productUnchangedSinceAgent(mockConn, saved, movement)).toEqual({ ok: true });

    // A later count on the product, whatever its created_at, changes the row.
    await inventoryOperations.adjustStock(saved.product_id, { movementType: 'correction', setTotal: 150, unit: 'oz' }, { source: 'admin_manual_adjustment' });
    const after = await productUnchangedSinceAgent(mockConn, saved, movement);
    expect(after.ok).toBe(false);
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
    await run({ ok: true, json: decision });
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
    await new Promise((resolve) => { setTimeout(resolve, 300); });
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
    await new Promise((resolve) => { setTimeout(resolve, 300); });
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

  test('gated off: runInventoryAgent does nothing', async () => {
    delete process.env.GATE_INVENTORY_AGENT;
    await pendingLine();
    const result = await run({ ok: true, json: { kind: 'not_stock', reason: 'x' } });
    expect(result).toEqual({ skipped: 'gated' });
    expect((await mockConn('purchase_receipt_lines')).every((r) => r.status === 'agent_pending')).toBe(true);
  });
});
