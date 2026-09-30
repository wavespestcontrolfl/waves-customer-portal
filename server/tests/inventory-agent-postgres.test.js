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

const { runInventoryAgent, drainAgentQueue, productUnchangedSinceAgent, DOWNSTREAM_ADOPTION_TABLES, decideForTitle } = require('../services/purchase-receipts/inventory-agent');
const inventoryOperations = require('../services/inventory-operations');
const notifications = require('../services/notification-service');
const { undoLine } = require('../../ops/agents/inventory-agent-undo');

const TABLES = ['products_catalog', 'product_aliases', 'product_inventory_movements', 'product_restock_requests', 'purchase_receipt_lines', 'notifications', 'emails', 'email_attachments', 'service_product_usage', 'protocol_template_products', 'lawn_protocol_product_substitutions'];
const RECEIVED_AT = new Date('2026-09-27T15:00:00Z');
// A Taurus title the deterministic matcher can't claim (its own product name
// "Taurus SC" never appears CONTIGUOUS — "Termiticide" sits between the two
// words — and every product word must appear contiguously to match), so the
// line is genuinely the agent's: a queued line the receipt rules DO resolve
// now posts through those rules without the model (Codex round 8), which
// would bypass what these tests exercise. It DOES carry every word of
// "Taurus SC" (in any order), though — required since round 10's own
// independent-evidence rule (item 2, validateExisting) refuses an
// 'existing' decision on an unmatched title unless every word of the
// candidate's name (or a pre-existing alias) appears in the title.
const AGENT_ONLY_TAURUS_TITLE = 'Taurus Termiticide SC 78 oz';
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

  // Only this database's sessions count: other lanes share this Postgres
  // server, and a waiter of theirs would release the held side early.
  // Resolves once some session is blocked on an advisory lock (the catalog
  // lock), so a race test releases its held transaction only after the other
  // side is really waiting, never on a guess about timing.
  async function waitForLockWaiter() {
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await mockConn.raw("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'");
      if (rows[0].n > 0) return;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    throw new Error('no session ever waited on the catalog lock');
  }
  // Resolves once some session waits on a ROW lock (a transaction or tuple
  // lock) — or once `settled` settles first, so code that never waits
  // (the bug a test is proving) fails its assertion instead of hanging.
  async function waitForRowLockWaiterOr(settled) {
    let done = false;
    settled.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 100 && !done; i += 1) {
      const { rows } = await mockConn.raw("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple')");
      if (rows[0].n > 0) return;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
  }

  // Releases the held side once some session waits on the lock — and ALWAYS
  // releases, even when none ever does, so a failing race test can never
  // leave its held transaction (and its locks) open and hang every later
  // test's TRUNCATE.
  async function releaseOnceWaiting(release) {
    try {
      await waitForLockWaiter();
    } finally {
      release();
    }
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

  // Superseded by item 2b, 2026-09-27 round 9 review: the OLD behavior here
  // was to roll the whole apply back and spend an attempt when the catalog
  // moved under the model's decision. Now applyDecision's own chokepoint
  // re-checks the rules under the SAME locks first — since this new alias
  // makes the title deterministically resolvable, the rules win and post it
  // directly, never wasting an attempt on a now-answerable line.
  test('a correcting alias added while the model "decides" is resolved by the rules, not rolled back (item 2b, 2026-09-27 round 9)', async () => {
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
    expect(result).toMatchObject({ logged: 1 });

    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'logged', product_id: bifenIt.id });
    expect(saved.agent_decision).toMatchObject({ kind: 'receipt_rules' });
    // Posted to Bifen IT (the rules' own resolution), never the model's
    // stale Bifen XTS proposal.
    expect(await stockOf(bifenIt.id)).toBe(96);
    expect(await stockOf(bifenXts.id)).toBe(0);
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

  // Superseded by item 2b, 2026-09-27 round 9 review: the admin's own
  // product name ("Bifen XTS") CONTAINS the pending line's title
  // ("Bifen XTS Insecticide 96 oz") as whole words, so once the agent's
  // transaction gets the catalog lock, the chokepoint's rules re-check
  // matches it deterministically and posts stock directly — never a
  // duplicate product, and never a wasted retry either.
  test('a product added by hand while the agent decides is resolved by the rules onto the admin\'s product — never duplicated, never a wasted retry', async () => {
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
    await releaseOnceWaiting(release);
    await manual;
    await agent;

    const created = await mockConn('products_catalog').where({ name: 'Bifen XTS' });
    expect(created).toHaveLength(1); // never duplicated
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'logged', product_id: created[0].id });
    expect(saved.agent_decision).toMatchObject({ kind: 'receipt_rules' });
    expect(await stockOf(created[0].id)).toBe(192); // 2 ordered x 96 oz — the line's own default quantity
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
    await releaseOnceWaiting(release);
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
      // "Rat Trap" in the title states rodent_trap (Codex round 11: a new
      // product's category must be one the listing states).
      new_product: { name: 'Snap Trap Rat Trap', category: 'rodent_trap', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '12 Count', size_number: 12, size_unit: 'each', pack_text: null, pack_count: 1 },
    };
    await mockConn('products_catalog').insert({ name: 'Category Seed', active: true, category: 'rodent_trap' });
    const result = await run({ ok: true, json: decision });
    expect(result).toMatchObject({ logged: 1 });
    const created = await mockConn('products_catalog').where({ name: 'Snap Trap Rat Trap' }).first();
    expect(created).toMatchObject({ inventory_unit: 'each', default_unit: 'each' });
    expect(await stockOf(created.id)).toBe(12);
    expect((await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).status).toBe('logged');
  });

  // Codex round 11: kilograms aren't an application unit, so a kg product
  // is kept in grams (and the restock converted) — visit completion would
  // otherwise refuse every visit that applies it.
  test('a new product sold in kilograms is stocked and applied in grams', async () => {
    const line = await pendingLine({ raw_title: 'LESCO Turf Fertilizer 2 kg', quantity: 3, shipment_key: 'ship-kg' });
    await mockConn('products_catalog').insert({ name: 'Category Seed', active: true, category: 'fertilizer' });
    const result = await run({ ok: true, json: {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'LESCO Turf Fertilizer', category: 'fertilizer', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '2 kg', size_number: 2, size_unit: 'kg', pack_text: null, pack_count: 1 },
    } });
    expect(result).toMatchObject({ logged: 1 });
    const created = await mockConn('products_catalog').where({ name: 'LESCO Turf Fertilizer' }).first();
    expect(created).toMatchObject({ inventory_unit: 'g', default_unit: 'g', container_size: '2 kg' });
    expect(await stockOf(created.id)).toBeCloseTo(6000, 0); // 3 x 2 kg
    expect((await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).status).toBe('logged');
  });

  test('a new product whose listing states no category is held for a person, whatever the model picked', async () => {
    const line = await pendingLine({ raw_title: 'Demand CS 8 oz', quantity: 1, shipment_key: 'ship-no-category' });
    const result = await run({ ok: true, json: {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Demand CS', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '8 oz', size_number: 8, size_unit: 'oz', pack_text: null, pack_count: 1 },
    } });
    expect(result).toMatchObject({ logged: 0, held: 1 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'agent_unsure' });
    expect(saved.agent_decision.reason).toMatch(/doesn't state the category/);
    expect(await mockConn('products_catalog').where({ name: 'Demand CS' })).toHaveLength(0);
  });

  // Codex round 12: not_stock on a known catalog product closed it with no
  // bell, silently dropping a real purchase.
  test('a catalog-matched (needs_size) line the model calls not_stock holds for a person with a bell', async () => {
    const [demand] = await mockConn('products_catalog').insert({
      name: 'Demand CS', active: true, category: 'insecticide', container_size: null, inventory_unit: null, inventory_on_hand: null,
    }).returning('*');
    const line = await pendingLine({ raw_title: 'Demand CS Insecticide 8 oz', product_id: demand.id, quantity: 1, shipment_key: 'ship-matched-not-stock' });
    const result = await run({ ok: true, json: { kind: 'not_stock', reason: 'looks personal' } });
    expect(result).toMatchObject({ held: 1, ignored: 0 });
    expect(await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).toMatchObject({ status: 'agent_unsure' });
    expect(await bellsFor(line.id)).toHaveLength(1);
  });

  test('a catalog match that lands while the model decides turns its not_stock into a hold too', async () => {
    const line = await pendingLine({ raw_title: 'Demand CS Insecticide 8 oz', quantity: 1, shipment_key: 'ship-matched-since' });
    const llm = async () => {
      // Matches the title by name but carries no container size, so the
      // receipt rules can't log it at apply time either.
      await mockConn('products_catalog').insert({ name: 'Demand CS', active: true, category: 'insecticide', container_size: null });
      return { ok: true, json: { kind: 'not_stock', reason: 'looks personal' } };
    };
    const result = await runInventoryAgent({ conn: mockConn, llm, notifyAdmin });
    expect(result).toMatchObject({ held: 1, ignored: 0 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'agent_unsure' });
    expect(saved.agent_decision.reason).toMatch(/catalog matches this title to a stocked product/);
    const [bell] = await bellsFor(line.id);
    expect(bell.detail || bell.body).toMatch(/matches it to Demand CS, so it wasn't ignored/);
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
    expect(bell.detail || bell.body).toMatch(/application unit to each/);
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
    expect(bell.detail || bell.body).toMatch(/application unit can't take a count/);
  });

  // 2026-09-27 pre-push audit: no movement doesn't mean unused — visit
  // completion skips the deduction for an untracked product, so a protocol
  // (or a visit, or a COGS mapping) can already apply it in ounces.
  test('an EXISTING count product with no movement but an ounce-based protocol mapping holds instead of switching its application unit', async () => {
    const [trapProduct] = await mockConn('products_catalog').insert({
      name: 'Victor Rat Trap', active: true, category: 'supplies', container_size: '12 count', inventory_unit: null, default_unit: 'oz', inventory_on_hand: null,
    }).returning('*');
    await mockConn('protocol_template_products').insert({
      protocol_template_id: randomUUID(), product_id: trapProduct.id, product_name_snapshot: 'Victor Rat Trap', rate: 1, rate_unit: 'oz',
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
    expect(saved.agent_decision).toMatchObject({ reason: 'application_unit_in_use' });
    const product = await mockConn('products_catalog').where({ id: trapProduct.id }).first();
    expect(product).toMatchObject({ default_unit: 'oz', inventory_unit: null, inventory_on_hand: null });
    expect(await mockConn('product_inventory_movements').where({ product_id: trapProduct.id })).toHaveLength(0);
    const [bell] = await bellsFor(line.id);
    expect(bell.detail || bell.body).toMatch(/already used on visits, services or protocols/);
  });

  test('a held count decision on a blank-container product leaves the catalog untouched (the savepoint rolls back)', async () => {
    const [trapProduct] = await mockConn('products_catalog').insert({
      name: 'Victor Rat Trap', active: true, category: 'supplies', container_size: null, inventory_unit: null, default_unit: 'oz', inventory_on_hand: 5,
    }).returning('*');
    await mockConn('product_inventory_movements').insert({
      product_id: trapProduct.id, movement_type: 'correction', quantity: 5, unit: 'oz', stock_before: 0, stock_after: 5,
      metadata: { source: 'admin_manual_adjustment' },
    });
    const line = await pendingLine({ raw_title: 'Victor Rat Trap 12 Count', product_id: trapProduct.id, quantity: 1 });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: trapProduct.id, new_product: null,
      reading: { size_text: '12 Count', size_number: 12, size_unit: 'each', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    expect((await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).status).toBe('agent_unsure');
    const after = await mockConn('products_catalog').where({ id: trapProduct.id }).first();
    expect(after).toMatchObject({ container_size: null, default_unit: 'oz', inventory_unit: null });
    expect(await bellsFor(line.id)).toHaveLength(1);
  });

  test('a possible duplicate leaves no container size or alias behind (the savepoint rolls back)', async () => {
    const [bare] = await mockConn('products_catalog').insert({
      name: 'Granular Bait', active: true, category: 'bait', container_size: null, inventory_unit: 'oz', inventory_on_hand: 10,
    }).returning('*');
    // A hand restock 1h before the email: the duplicate guard holds the line.
    await mockConn('product_inventory_movements').insert({
      product_id: bare.id, movement_type: 'restock', quantity: 16, unit: 'oz', stock_before: 10, stock_after: 26,
      metadata: { source: 'admin_manual_adjustment' }, created_at: new Date(RECEIVED_AT.getTime() - HOUR),
    });
    const line = await pendingLine({ raw_title: 'Granular Bait 16 oz Bag', product_id: bare.id, quantity: 1 });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: bare.id, new_product: null,
      reading: { size_text: '16 oz', size_number: 16, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'possible_duplicate', product_id: bare.id });
    expect((await mockConn('products_catalog').where({ id: bare.id }).first()).container_size).toBeNull();
    expect(await bellsFor(line.id)).toHaveLength(1);
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

  // Item 3, 2026-09-27 round 9 review: ops/agents/README.md requires a
  // mutating script to print EXACTLY what would change — the old dry run
  // named the four fields in one generic sentence but never their values.
  test('undo dry run prints each restored field\'s exact current value -> original value before offering --execute (item 3, 2026-09-27 round 9)', async () => {
    const [trapProduct] = await mockConn('products_catalog').insert({
      name: 'Victor Rat Trap', active: true, category: 'supplies', container_size: '12 count', inventory_unit: null, default_unit: 'oz', inventory_on_hand: 0,
    }).returning('*');
    const line = await pendingLine({ raw_title: 'Victor Rat Trap 12 Count', product_id: trapProduct.id, quantity: 5, shipment_key: 'ship-dryrun-fields' });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: trapProduct.id, new_product: null,
      reading: { size_text: '12 Count', size_number: 12, size_unit: 'each', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    const afterAgent = await mockConn('products_catalog').where({ id: trapProduct.id }).first();
    const savedLine = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    const original = savedLine.agent_decision.originalProductFields;
    // Not a vacuous fixture: at least one field genuinely changed, so a
    // match below is proof of restoration values, not an unchanged echo.
    expect(afterAgent.inventory_unit).not.toBe(original.inventoryUnit);

    const logged = [];
    const outcome = await undoLine(mockConn, { lineArg: line.id, execute: false, log: (msg) => logged.push(msg) });
    expect(outcome).toEqual({ executed: false });

    const fmt = (v) => (v === null || v === undefined ? 'null' : JSON.stringify(v));
    const text = logged.join('\n');
    expect(text).toContain(`container_size: ${fmt(afterAgent.container_size)} → ${fmt(original.containerSize)}`);
    expect(text).toContain(`inventory_unit: ${fmt(afterAgent.inventory_unit)} → ${fmt(original.inventoryUnit)}`);
    expect(text).toContain(`inventory_on_hand: ${fmt(afterAgent.inventory_on_hand)} → ${fmt(original.inventoryOnHand)}`);
    expect(text).toContain(`default_unit: ${fmt(afterAgent.default_unit)} → ${fmt(original.defaultUnit)}`);
    // The old generic one-line sentence (field names, no values) is gone.
    expect(text).not.toMatch(/container_size\/inventory_unit\/inventory_on_hand\/default_unit to what they were/);
  });

  // An originally-untracked product (a null on-hand) restores to the bare
  // word `null`, never the string "null" or a stray "0".
  test('undo dry run prints null (not a stray 0 or a quoted string) for a field that was originally untracked (item 3, 2026-09-27 round 9)', async () => {
    const [bare] = await mockConn('products_catalog').insert({
      name: 'Granular Bait Untracked', active: true, category: 'bait', container_size: null, inventory_unit: null, default_unit: 'oz', inventory_on_hand: null,
    }).returning('*');
    const line = await pendingLine({ raw_title: 'Granular Bait Untracked 16 oz Bag', product_id: bare.id, quantity: 2, shipment_key: 'ship-dryrun-null' });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: bare.id, new_product: null,
      reading: { size_text: '16 oz', size_number: 16, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });

    const logged = [];
    await undoLine(mockConn, { lineArg: line.id, execute: false, log: (msg) => logged.push(msg) });
    const text = logged.join('\n');
    expect(text).toMatch(/inventory_on_hand: "32\.0000" → null/);
    expect(text).toMatch(/inventory_unit: "oz" → null/);
    expect(text).toMatch(/container_size: "16 oz" → null/);
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

  test('undo of an agent-created product\'s line reverses stock and deletes the alias but NEVER deactivates the product — an informational line points at Inventory instead (review item 2)', async () => {
    const line = await pendingLine({ raw_title: 'Bifen XTS Insecticide 96 oz' });
    const decision = {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    const created = await mockConn('products_catalog').where({ name: 'Bifen XTS' }).first();
    expect(created.active).toBe(true);
    expect(await stockOf(created.id)).toBe(192); // 2 ordered x 96 oz
    const savedLine = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(savedLine.agent_created_product_id).toBe(created.id);
    expect(await mockConn('product_aliases').where({ product_id: created.id })).toHaveLength(1);
    const [loggedBell] = await bellsFor(line.id);
    expect(loggedBell.read_at).toBeNull(); // the "logged a purchase" bell starts unread

    const logged = [];
    const outcome = await undoLine(mockConn, { lineArg: savedLine.id, execute: true, log: (msg) => logged.push(msg) });
    expect(outcome).toEqual({ executed: true });

    const afterUndo = await mockConn('products_catalog').where({ id: created.id }).first();
    expect(afterUndo.active).toBe(true); // never deactivated, even though the agent created it
    expect(await stockOf(created.id)).toBe(0); // the restock reversed
    expect(await mockConn('product_aliases').where({ product_id: created.id })).toHaveLength(0); // alias still deleted
    const undoneLine = await mockConn('purchase_receipt_lines').where({ id: savedLine.id }).first();
    expect(undoneLine.status).toBe('agent_unsure');

    expect(logged.some((l) => l.includes('was created by the agent') && l.includes('Inventory'))).toBe(true);
    // Item 5, 2026-09-27 round 7 review: the stale "logged a purchase" bell
    // is retired (marked read) in the SAME transaction as the reversal.
    const [retiredBell] = await bellsFor(line.id);
    expect(retiredBell.read_at).not.toBeNull();
  });

  test('undo refuses a --line argument that is neither a full id nor an EXACT 8-character prefix, before any query (review item 3)', async () => {
    await expect(undoLine(mockConn, { lineArg: 'abc', execute: false, log: () => {} }))
      .rejects.toThrow(/not a full id or an 8-character id prefix/);
    await expect(undoLine(mockConn, { lineArg: 'abcdefabcdefg', execute: false, log: () => {} })) // 9 hex chars
      .rejects.toThrow(/not a full id or an 8-character id prefix/);
    await expect(undoLine(mockConn, { lineArg: 'not-hex!', execute: false, log: () => {} }))
      .rejects.toThrow(/not a full id or an 8-character id prefix/);
  });

  test('undo still accepts an exact 8-character hex prefix of the line id (review item 3)', async () => {
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 1, shipment_key: 'ship-prefix' });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: taurus.id, new_product: null,
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    const savedLine = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    const prefix = savedLine.id.slice(0, 8);
    const outcome = await undoLine(mockConn, { lineArg: prefix, execute: false, log: () => {} });
    expect(outcome).toEqual({ executed: false }); // resolved via the LIKE prefix match, dry run never writes
  });

  test('undo dry-runs by default and refuses when the product changed since the agent\'s restock', async () => {
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2, shipment_key: 'ship-undo-refuse' });
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

  test('undo refuses when a service now maps the product for COGS after the agent\'s decision, even though the row hash still matches (item 4, 2026-09-27 round 7)', async () => {
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2, shipment_key: 'ship-downstream' });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: taurus.id, new_product: null,
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    await run({ ok: true, json: decision });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved.status).toBe('logged');
    // Nothing touched the product row itself — the hash check alone would
    // pass — but staff mapped it into a service's COGS usage afterward.
    await mockConn('service_product_usage').insert({
      service_type: 'General Pest Control', product_id: taurus.id, usage_amount: 2, usage_unit: 'fl_oz',
      created_at: new Date(new Date(saved.agent_decided_at).getTime() + 1000),
    });

    await expect(undoLine(mockConn, { lineArg: line.id, execute: false, log: () => {} }))
      .rejects.toThrow(/a service's COGS usage mapping referencing this product was added, re-pointed, changed or removed/);
    await expect(undoLine(mockConn, { lineArg: line.id, execute: true, log: () => {} }))
      .rejects.toThrow(/a service's COGS usage mapping referencing this product was added, re-pointed, changed or removed/);
    expect(await stockOf(taurus.id)).toBe(156); // never reversed
  });

  // 2026-09-27 pre-push audit: PUT /api/admin/inventory/service-usage/:id can
  // re-point an OLDER mapping at this product, bumping only updated_at — a
  // created_at check never saw it. The recorded reference footprint does.
  const TAURUS_DECISION = {
    kind: 'existing', reason: 'matches the candidate', product_id: null, new_product: null,
    reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
  };
  const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);

  test('undo refuses when an OLDER mapping is re-pointed at the product after the agent\'s decision (only updated_at moves)', async () => {
    const [otherProduct] = await mockConn('products_catalog').insert({ name: 'Other Product', active: true, category: 'insecticide' }).returning('*');
    const [olderMapping] = await mockConn('service_product_usage').insert({
      service_type: 'General Pest Control', product_id: otherProduct.id, usage_amount: 2, usage_unit: 'fl_oz', created_at: longAgo, updated_at: longAgo,
    }).returning('*');
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2, shipment_key: 'ship-repoint' });
    await run({ ok: true, json: { ...TAURUS_DECISION, product_id: taurus.id } });
    expect((await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).status).toBe('logged');

    await mockConn('service_product_usage').where({ id: olderMapping.id }).update({ product_id: taurus.id, updated_at: new Date() });

    await expect(undoLine(mockConn, { lineArg: line.id, execute: false, log: () => {} }))
      .rejects.toThrow(/COGS usage mapping referencing this product was added, re-pointed, changed or removed/);
    await expect(undoLine(mockConn, { lineArg: line.id, execute: true, log: () => {} }))
      .rejects.toThrow(/COGS usage mapping referencing this product was added, re-pointed, changed or removed/);
    expect(await stockOf(taurus.id)).toBe(156); // never reversed
  });

  test('undo refuses when a mapping that already referenced the product is edited after the decision, even with no timestamp change', async () => {
    const [mapping] = await mockConn('service_product_usage').insert({
      service_type: 'General Pest Control', product_id: taurus.id, usage_amount: 2, usage_unit: 'fl_oz', created_at: longAgo, updated_at: longAgo,
    }).returning('*');
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2, shipment_key: 'ship-edit' });
    await run({ ok: true, json: { ...TAURUS_DECISION, product_id: taurus.id } });

    await mockConn('service_product_usage').where({ id: mapping.id }).update({ usage_amount: 3 });

    await expect(undoLine(mockConn, { lineArg: line.id, execute: true, log: () => {} }))
      .rejects.toThrow(/COGS usage mapping referencing this product was added, re-pointed, changed or removed/);
    expect(await stockOf(taurus.id)).toBe(156);
  });

  test('a reference that predates the decision and never moves does not block the undo, nor does a change to another product\'s mapping', async () => {
    const [otherProduct] = await mockConn('products_catalog').insert({ name: 'Other Product', active: true, category: 'insecticide' }).returning('*');
    await mockConn('service_product_usage').insert({
      service_type: 'General Pest Control', product_id: taurus.id, usage_amount: 2, usage_unit: 'fl_oz', created_at: longAgo, updated_at: longAgo,
    });
    const [otherMapping] = await mockConn('service_product_usage').insert({
      service_type: 'General Pest Control', product_id: otherProduct.id, usage_amount: 1, usage_unit: 'fl_oz', created_at: longAgo, updated_at: longAgo,
    }).returning('*');
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2, shipment_key: 'ship-steady' });
    await run({ ok: true, json: { ...TAURUS_DECISION, product_id: taurus.id } });

    await mockConn('service_product_usage').where({ id: otherMapping.id }).update({ usage_amount: 5, updated_at: new Date() });

    expect(await undoLine(mockConn, { lineArg: line.id, execute: true, log: () => {} })).toEqual({ executed: true });
    expect(await stockOf(taurus.id)).toBe(0);
  });

  test('an admin alias insert racing the agent\'s own alias creation always serializes — never two aliases for one title (item 2, 2026-09-27 round 7)', async () => {
    const [productA] = await mockConn('products_catalog').insert({
      name: 'Bifen XTS', active: true, category: 'insecticide', container_size: '96 oz', inventory_unit: 'oz', inventory_on_hand: 0,
    }).returning('*');
    const [productB] = await mockConn('products_catalog').insert({
      name: 'Bifen IT', active: true, category: 'insecticide', container_size: '96 oz', inventory_unit: 'oz', inventory_on_hand: 0,
    }).returning('*');
    const title = 'Bifen Insecticide Concentrate 96 oz';
    const line = await pendingLine({ raw_title: title, quantity: 1 });
    const decision = {
      kind: 'existing', reason: 'looks like Bifen XTS', product_id: productA.id, new_product: null,
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };

    let signalLocked;
    const locked = new Promise((resolve) => { signalLocked = resolve; });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    // The admin screen's own alias insert (inventoryOperations.createProductAlias,
    // the same function POST /api/admin/inventory/aliases calls), holding
    // its transaction — and the catalog-create lock — open for a DIFFERENT
    // product than the one the agent's decision names, until the agent is
    // waiting on that same lock.
    const adminInsert = mockConn.transaction(async (trx) => {
      const result = await inventoryOperations.createProductAlias({ productId: productB.id, aliasName: title, vendorId: null }, { trx });
      expect(result).toEqual({ success: true });
      signalLocked();
      await held;
    });
    await locked;
    const agent = run({ ok: true, json: decision });
    await releaseOnceWaiting(release);
    await adminInsert;
    await agent;

    // Exactly one alias for this title — the admin's, on productB — never a
    // second one from the agent racing behind it.
    const aliases = await mockConn('product_aliases').where({ alias_name: title });
    expect(aliases).toHaveLength(1);
    expect(aliases[0].product_id).toBe(productB.id);
    // Superseded by item 2b, 2026-09-27 round 9 review: the OLD behavior
    // rolled the whole apply back on seeing the now-existing alias for a
    // DIFFERENT product. Now the chokepoint's rules re-check (same locks)
    // resolves the title deterministically via that very alias and posts
    // stock straight to productB — never the model's stale productA
    // proposal, and never a wasted retry.
    expect(await stockOf(productA.id)).toBe(0);
    expect(await stockOf(productB.id)).toBe(96);
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'logged', product_id: productB.id });
    expect(saved.agent_decision).toMatchObject({ kind: 'receipt_rules' });
  });

  // Item 3, 2026-09-27 round 10 review: findAliasByNormalizedName used to
  // treat an alias still owned by a RETIRED (inactive) product as a
  // conflict, even though product-matcher.js's own deterministic matcher
  // joins active products only — a stale row on a duplicate/retired catalog
  // entry silently blocked a NEW active product (or the agent) from ever
  // claiming that exact alias text.
  describe('an alias owned only by a RETIRED product is never a conflict (item 3, 2026-09-27 round 10)', () => {
    test('admin create (createProductAlias) succeeds when only an INACTIVE product holds the exact alias text, no vendor', async () => {
      const [retired] = await mockConn('products_catalog').insert({ name: 'Old Bifen', active: false, category: 'insecticide' }).returning('*');
      await mockConn('product_aliases').insert({ product_id: retired.id, alias_name: 'Bifen XTS 96 oz' });
      const [active] = await mockConn('products_catalog').insert({ name: 'Bifen XTS', active: true, category: 'insecticide' }).returning('*');

      const result = await inventoryOperations.createProductAlias({ productId: active.id, aliasName: 'Bifen XTS 96 oz', vendorId: null });
      expect(result).toEqual({ success: true });
      // Both rows exist side by side — a NULL vendor_id never collides at
      // the (alias_name, vendor_id) index — but matchTitleToProduct only
      // ever sees the active one (its own join is `active = true`).
      const owners = (await mockConn('product_aliases').where({ alias_name: 'Bifen XTS 96 oz' })).map((a) => a.product_id).sort();
      expect(owners).toEqual([active.id, retired.id].sort());
    });

    test('admin create TRANSFERS a stale alias from a RETIRED product instead of colliding, when the SAME non-null vendor_id would otherwise violate the unique index', async () => {
      const vendorId = randomUUID(); // no `vendors` FK in this LIKE-copy schema — any UUID stands in
      const [retired] = await mockConn('products_catalog').insert({ name: 'Old Bifen', active: false, category: 'insecticide' }).returning('*');
      const [stale] = await mockConn('product_aliases').insert({ product_id: retired.id, alias_name: 'Bifen XTS 96 oz', vendor_id: vendorId }).returning('*');
      const [active] = await mockConn('products_catalog').insert({ name: 'Bifen XTS', active: true, category: 'insecticide' }).returning('*');

      const result = await inventoryOperations.createProductAlias({ productId: active.id, aliasName: 'Bifen XTS 96 oz', vendorId });
      expect(result).toMatchObject({ success: true, transferred: { id: stale.id, product_id: active.id } });
      // Transferred, never duplicated: exactly one row for this (alias_name, vendor_id).
      const rows = await mockConn('product_aliases').where({ alias_name: 'Bifen XTS 96 oz', vendor_id: vendorId });
      expect(rows).toHaveLength(1);
      expect(rows[0].product_id).toBe(active.id);
    });

    test('agent create (createAgentAlias, via the real apply path) succeeds when only an INACTIVE product holds the same exact title as an alias', async () => {
      const [retired] = await mockConn('products_catalog').insert({ name: 'Old Bifen', active: false, category: 'insecticide' }).returning('*');
      await mockConn('product_aliases').insert({ product_id: retired.id, alias_name: 'Bifen Insecticide Concentrate 96 oz' });
      // Named so its OWN words ("bifen", "concentrate") are both present in
      // the title below — round 10 item 2's independent-evidence rule for an
      // unmatched title — while staying non-contiguous in the title itself
      // ("Insecticide" sits between them), so the deterministic matcher
      // still can't claim it either; this line really is the agent's.
      const [active] = await mockConn('products_catalog').insert({
        name: 'Bifen Concentrate', active: true, category: 'insecticide', container_size: '96 oz', inventory_unit: 'oz', inventory_on_hand: 0,
      }).returning('*');
      const title = 'Bifen Insecticide Concentrate 96 oz';
      const line = await pendingLine({ raw_title: title, quantity: 1, shipment_key: 'ship-inactive-alias' });
      const decision = {
        kind: 'existing', reason: 'matches the candidate', product_id: active.id, new_product: null,
        reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
      };
      const result = await run({ ok: true, json: decision });
      expect(result).toMatchObject({ logged: 1, held: 0 });
      const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
      expect(saved).toMatchObject({ status: 'logged', product_id: active.id, agent_created_alias_id: expect.any(String) });
      // The agent's own alias (vendor_id null) sits beside the retired
      // product's — never blocked, never merged into it.
      const owners = (await mockConn('product_aliases').where({ alias_name: title })).map((a) => a.product_id).sort();
      expect(owners).toEqual([active.id, retired.id].sort());
    });

    test('an ACTIVE owner still conflicts, even alongside an inactive one holding the SAME text — admin create refuses (409-worthy), never silently prefers or ignores it', async () => {
      const [retired] = await mockConn('products_catalog').insert({ name: 'Discontinued Bifen', active: false, category: 'insecticide' }).returning('*');
      await mockConn('product_aliases').insert({ product_id: retired.id, alias_name: 'Bifen XTS 96 oz' });
      const [otherActive] = await mockConn('products_catalog').insert({ name: 'Bifen IT', active: true, category: 'insecticide' }).returning('*');
      await mockConn('product_aliases').insert({ product_id: otherActive.id, alias_name: 'Bifen XTS 96 oz' });
      const [active] = await mockConn('products_catalog').insert({ name: 'Bifen XTS', active: true, category: 'insecticide' }).returning('*');

      const adminResult = await inventoryOperations.createProductAlias({ productId: active.id, aliasName: 'Bifen XTS 96 oz', vendorId: null });
      // The active owner's row is what's reported — the inactive one sitting
      // right beside it under the SAME text is never picked instead.
      expect(adminResult).toMatchObject({ success: false, conflict: { product_id: otherActive.id } });
      expect(await mockConn('product_aliases').where({ alias_name: 'Bifen XTS 96 oz', product_id: active.id })).toHaveLength(0);
    });

    // createAgentAlias runs the SAME findAliasByNormalizedName lookup under
    // the SAME lock (inventory-agent.js, item 2, 2026-09-27 round 7 review) —
    // proven directly here rather than through the full pipeline, since a
    // pre-existing exact-title alias on an ACTIVE product is always caught by
    // the deterministic matcher (or applyDecision's own chokepoint) first in
    // the ordinary flow, long before createAgentAlias's own insert runs.
    test('the lookup createAgentAlias shares still returns the ACTIVE owner, never the inactive one holding the same text', async () => {
      const [retired] = await mockConn('products_catalog').insert({ name: 'Discontinued Bifen', active: false, category: 'insecticide' }).returning('*');
      await mockConn('product_aliases').insert({ product_id: retired.id, alias_name: 'Bifen XTS 96 oz' });
      const [otherActive] = await mockConn('products_catalog').insert({ name: 'Bifen IT', active: true, category: 'insecticide' }).returning('*');
      await mockConn('product_aliases').insert({ product_id: otherActive.id, alias_name: 'Bifen XTS 96 oz' });

      const found = await mockConn.transaction((trx) => inventoryOperations.findAliasByNormalizedName(trx, 'Bifen XTS 96 oz'));
      expect(found).toMatchObject({ product_id: otherActive.id });
    });
  });

  // 2026-09-27 pre-push audit: the agent used to lock an existing product
  // FOR UPDATE and only THEN take the catalog lock (createAgentAlias), while
  // the admin alias endpoint holds the catalog lock and its insert's
  // foreign-key check needs KEY SHARE on that same product — a lock-order
  // deadlock. The LIKE copies above carry no foreign keys, so this test adds
  // the real one for its duration.
  test('the agent takes the catalog lock before any product lock — an admin alias insert for the SAME product never deadlocks against it', async () => {
    await mockConn.raw('ALTER TABLE ??.product_aliases ADD CONSTRAINT agent_test_alias_product_fk FOREIGN KEY (product_id) REFERENCES ??.products_catalog (id)', [schema, schema]);
    try {
      const [product] = await mockConn('products_catalog').insert({
        name: 'Bifen XTS', active: true, category: 'insecticide', container_size: '96 oz', inventory_unit: 'oz', inventory_on_hand: 0,
      }).returning('*');
      // A pre-existing alias (never the exact raw title) giving the model's
      // 'existing' choice its own independent evidence (item 2, 2026-09-27
      // round 10 review): every one of its words ("bifen", "concentrate")
      // appears in the title below, so validateExisting's own name/alias
      // check passes and the decision really does reach resolveExistingProduct
      // — required for this test to exercise the lock-order path at all.
      await mockConn('product_aliases').insert({ product_id: product.id, alias_name: 'Bifen Concentrate' });
      // On its last attempt, so the attempt's reason is saved on the line: a
      // deadlock would surface there as the thrown error's message.
      const line = await pendingLine({ raw_title: 'Bifen Insecticide Concentrate 96 oz', quantity: 1, agent_attempts: 2 });
      const decision = {
        kind: 'existing', reason: 'looks like Bifen XTS', product_id: product.id, new_product: null,
        reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
      };

      let signalLocked;
      const locked = new Promise((resolve) => { signalLocked = resolve; });
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      // The admin side holds the catalog lock with its transaction open until
      // the agent is waiting, then saves an alias for the SAME product
      // through createProductAlias (the function POST /aliases calls) — its
      // foreign-key check needs KEY SHARE on the product row.
      const adminInsert = mockConn.transaction(async (trx) => {
        await inventoryOperations.lockCatalogCreate(trx);
        signalLocked();
        await held;
        return inventoryOperations.createProductAlias({ productId: product.id, aliasName: 'Bifen XTS Gallon Jug', vendorId: null }, { trx });
      });
      await locked;
      const agent = run({ ok: true, json: decision });
      // Before the fix the agent held the product FOR UPDATE by this point,
      // so the admin's insert blocked on it and Postgres aborted the agent as
      // a deadlock victim.
      await releaseOnceWaiting(release);
      await expect(adminInsert).resolves.toEqual({ success: true });
      await agent;

      // The agent waited on the catalog lock instead of deadlocking; once it
      // got it, the admin's new alias had changed the product it was shown,
      // so it stopped cleanly as product_changed (never a deadlock error)
      // and wrote no stock.
      const savedLine = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
      expect(savedLine.agent_decision).toMatchObject({ reason: 'product_changed' });
      expect(await stockOf(product.id)).toBe(0);

      expect(await mockConn('product_aliases').where({ product_id: product.id, alias_name: 'Bifen XTS Gallon Jug' })).toHaveLength(1);
    } finally {
      await mockConn.raw('ALTER TABLE ??.product_aliases DROP CONSTRAINT IF EXISTS agent_test_alias_product_fk', [schema]);
    }
  });

  // Codex round 8: a queued line the receipt lane's own rules now resolve
  // (here the title names "Taurus SC" and its container is set — as after
  // staff fill a missing size) posts through those rules; the model is never
  // asked, so its not_stock answer can't drop the purchase.
  test('a queued line the receipt rules now resolve posts through those rules without asking the model', async () => {
    const line = await pendingLine({ raw_title: 'Taurus SC Termiticide 78 oz', product_id: taurus.id, quantity: 2, shipment_key: 'ship-rules' });
    const llm = jest.fn(async () => ({ ok: true, json: { kind: 'not_stock', reason: 'looks personal' } }));
    const result = await runInventoryAgent({ conn: mockConn, llm, notifyAdmin });
    expect(llm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ logged: 1, held: 0, ignored: 0 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'logged', product_id: taurus.id, received_unit: 'fl_oz' });
    expect(Number(saved.received_qty)).toBe(156);
    expect(saved.agent_decision).toMatchObject({ kind: 'receipt_rules' });
    expect(await stockOf(taurus.id)).toBe(156);
    const movement = await mockConn('product_inventory_movements').where({ id: saved.movement_id }).first();
    expect(movement.metadata).toMatchObject({ source: 'amazon_delivery' });
    const [bell] = await bellsFor(line.id);
    expect(bell).toMatchObject({ title: 'Purchase logged' });
  });

  test('the receipt rules\' duplicate check still holds a queued line they resolve', async () => {
    await mockConn('product_inventory_movements').insert({
      product_id: taurus.id, movement_type: 'restock', quantity: 10, unit: 'fl_oz',
      metadata: { source: 'intelligence_bar_adjust_stock' }, created_at: new Date(RECEIVED_AT.getTime() - 10 * HOUR),
    });
    const line = await pendingLine({ raw_title: 'Taurus SC Termiticide 78 oz', product_id: taurus.id, quantity: 2, shipment_key: 'ship-rules-dup' });
    const llm = jest.fn(async () => ({ ok: true, json: { kind: 'unsure', reason: 'not sure' } }));
    const result = await runInventoryAgent({ conn: mockConn, llm, notifyAdmin });
    expect(llm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ logged: 0, held: 1 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'possible_duplicate', movement_id: null });
    expect(await stockOf(taurus.id)).toBe(0);
    const [bell] = await bellsFor(line.id);
    expect(bell.detail || bell.body).toMatch(/wasn't added\. A manual restock or count was logged around the same time/);
  });

  // Codex round 8: a lawn visit's substitution references its products by
  // original_product_id and substitute_product_id, not product_id.
  test('a count product used only as a lawn substitute holds instead of switching its application unit', async () => {
    const [trapProduct] = await mockConn('products_catalog').insert({
      name: 'Victor Rat Trap', active: true, category: 'supplies', container_size: '12 count', inventory_unit: null, default_unit: 'oz', inventory_on_hand: null,
    }).returning('*');
    await mockConn('lawn_protocol_product_substitutions').insert({
      scheduled_service_id: randomUUID(), original_product_id: taurus.id, substitute_product_id: trapProduct.id,
      rate_per_1000: 1, rate_unit: 'oz', approved_at: new Date(), active: true, metadata: {},
    });
    const line = await pendingLine({ raw_title: 'Victor Rat Trap 12 Count', product_id: trapProduct.id, quantity: 5 });
    const decision = {
      kind: 'existing', reason: 'matches the candidate', product_id: trapProduct.id, new_product: null,
      reading: { size_text: '12 Count', size_number: 12, size_unit: 'each', pack_text: null, pack_count: 1 },
    };
    const result = await run({ ok: true, json: decision });
    expect(result).toMatchObject({ logged: 0, held: 1 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved.agent_decision).toMatchObject({ reason: 'application_unit_in_use' });
    expect(await mockConn('products_catalog').where({ id: trapProduct.id }).first()).toMatchObject({ default_unit: 'oz', inventory_unit: null });
  });

  test('undo refuses once a lawn substitution names the product after the agent\'s decision (either column)', async () => {
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2, shipment_key: 'ship-substitution' });
    await run({ ok: true, json: {
      kind: 'existing', reason: 'matches the candidate', product_id: taurus.id, new_product: null,
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
    } });
    expect((await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).status).toBe('logged');
    const [otherProduct] = await mockConn('products_catalog').insert({ name: 'Other Product', active: true, category: 'insecticide' }).returning('*');
    await mockConn('lawn_protocol_product_substitutions').insert({
      scheduled_service_id: randomUUID(), original_product_id: otherProduct.id, substitute_product_id: taurus.id,
      rate_per_1000: 1, rate_unit: 'fl_oz', approved_at: new Date(), active: true, metadata: {},
    });
    await expect(undoLine(mockConn, { lineArg: line.id, execute: true, log: () => {} }))
      .rejects.toThrow(/a lawn visit's product substitution referencing this product was added, re-pointed, changed or removed/);
    expect(await stockOf(taurus.id)).toBe(156);
  });

  // Holds the guards' table list against the schema itself: every foreign
  // key to products_catalog is either an operational reference the unit and
  // undo guards check (DOWNSTREAM_ADOPTION_TABLES) or named here as one that
  // isn't, so a migration adding a new one fails this until it's classified.
  test('every foreign key to products_catalog is classified for the unit and undo guards', async () => {
    const { rows } = await mockConn.raw(`
      SELECT kcu.table_name || '.' || kcu.column_name AS ref
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.unique_constraint_schema
      WHERE ccu.table_name = 'products_catalog' AND ccu.table_schema = 'public' AND kcu.table_schema = 'public'`);
    const operational = DOWNSTREAM_ADOPTION_TABLES.flatMap((ref) => (ref.columns || ['product_id']).map((column) => `${ref.table}.${column}`));
    const notOperational = [
      // pricing: a price never depends on the stock unit or tracking
      'distributor_product_map.product_id', 'price_approval_events.product_id', 'price_approvals.product_id', 'price_auto_approve_rules.product_id',
      'price_history.product_id', 'price_refresh_requests.product_id', 'price_snapshots.product_id', 'pricing_engine_proposals.product_id', 'vendor_pricing.product_id',
      // identity: the agent's own alias is removed by id on undo
      'product_aliases.product_id',
      // the stock ledger: the product row hash and stock check cover it
      'product_inventory_movements.product_id',
      // low-stock alerts, recomputed from stock
      'inventory_alerts.product_id',
      // a customer-facing outline's display row, no rate or unit
      'service_outline_packet_products.product_id',
      // this lane's own receipt lines
      'purchase_receipt_lines.product_id', 'purchase_receipt_lines.agent_created_product_id',
    ];
    const classified = new Set([...operational, ...notOperational]);
    expect(rows.map((row) => row.ref).filter((ref) => !classified.has(ref)).sort()).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });

  // 2026-09-27 pre-push audit: a listing's EPA number is vendor-typed text;
  // the catalog's prints on service reports and application records.
  test('a new product never takes the listing\'s EPA number — the bell asks a person to confirm it from the label', async () => {
    const line = await pendingLine({ raw_title: 'Bifen XTS Insecticide 96 oz EPA Reg. No. 279-3206', shipment_key: 'ship-epa' });
    await run({ ok: true, json: {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: null, epa_reg_no: '279-3206' },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    } });
    const created = await mockConn('products_catalog').where({ name: 'Bifen XTS' }).first();
    // createCatalogProduct's own placeholder, same as the admin add screen.
    expect(created.epa_reg_number).toBe('N/A');
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved.agent_decision.newProduct).toMatchObject({ listingEpaRegNumber: '279-3206' });
    const [bell] = await bellsFor(line.id);
    expect(bell.detail || bell.body).toMatch(/the listing gives EPA Reg\. No\. 279-3206, so confirm it from the label/);
  });

  // 2026-09-27 pre-push audit: validation read a whitespace-only size as
  // missing, but the write's truthiness check saw it as present, so stock
  // logged without the size and later receipts stayed stuck in needs_size.
  test('a whitespace-only container size is blank on the apply path too — the validated size is saved', async () => {
    const [product] = await mockConn('products_catalog').insert({
      name: 'Demand CS', active: true, category: 'insecticide', container_size: '   ', inventory_unit: null, inventory_on_hand: null,
    }).returning('*');
    const line = await pendingLine({ raw_title: 'Demand CS Insecticide 8 oz', product_id: product.id, quantity: 3, shipment_key: 'ship-blank-size' });
    const result = await run({ ok: true, json: {
      kind: 'existing', reason: 'matches the candidate', product_id: product.id, new_product: null,
      reading: { size_text: '8 oz', size_number: 8, size_unit: 'oz', pack_text: null, pack_count: 1 },
    } });
    expect(result).toMatchObject({ logged: 1 });
    const updated = await mockConn('products_catalog').where({ id: product.id }).first();
    expect(updated.container_size).toBe('8 oz');
    expect(await stockOf(product.id)).toBe(24);
    expect((await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).status).toBe('logged');
  });

  // 2026-09-27 pre-push audit: the product lock never blocked an edit to an
  // EXISTING mapping, so one committing between the undo's footprint check
  // and its reversal slipped through. The undo now holds those rows.
  test('an edit to a referencing row that is in flight when the undo runs makes the undo wait, then refuse', async () => {
    const [mapping] = await mockConn('service_product_usage').insert({
      service_type: 'General Pest Control', product_id: taurus.id, usage_amount: 2, usage_unit: 'fl_oz', created_at: longAgo, updated_at: longAgo,
    }).returning('*');
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2, shipment_key: 'ship-concurrent-edit' });
    await run({ ok: true, json: { ...TAURUS_DECISION, product_id: taurus.id } });
    expect(await stockOf(taurus.id)).toBe(156);

    let signalEdited;
    const edited = new Promise((resolve) => { signalEdited = resolve; });
    let commitEdit;
    const commit = new Promise((resolve) => { commitEdit = resolve; });
    // The mapping edit (as PUT /service-usage/:id makes it), open and
    // uncommitted while the undo runs.
    const editor = mockConn.transaction(async (trx) => {
      await trx('service_product_usage').where({ id: mapping.id }).update({ usage_amount: 3 });
      signalEdited();
      await commit;
    });
    await edited;
    const undo = undoLine(mockConn, { lineArg: line.id, execute: true, log: () => {} });
    try {
      await waitForRowLockWaiterOr(undo);
    } finally {
      commitEdit();
    }
    await editor;
    await expect(undo).rejects.toThrow(/COGS usage mapping referencing this product was added, re-pointed, changed or removed/);
    expect(await stockOf(taurus.id)).toBe(156); // never reversed
  });

  // 2026-09-27 pre-push audit: the catalog gives bait cartridges and blocks
  // per-basis application rates (20260816000010_catalog_per_basis_rate_render).
  test.each([
    ['each/station', 'Termite Bait Cartridges', 'Termite Bait Cartridges 25 cartridges', 25],
    ['each/placement', 'Rodent Bait Blox', 'Rodent Bait Blox 16 Count', 16],
  ])('a count product whose application rate is %s logs, keeping that rate unit', async (defaultUnit, name, title, count) => {
    const [product] = await mockConn('products_catalog').insert({
      name, active: true, category: 'insecticide', container_size: `${count} count`, inventory_unit: 'each', default_unit: defaultUnit, inventory_on_hand: 0,
    }).returning('*');
    const line = await pendingLine({ raw_title: title, product_id: product.id, quantity: 2, shipment_key: `ship-${count}` });
    const result = await run({ ok: true, json: {
      kind: 'existing', reason: 'matches the candidate', product_id: product.id, new_product: null,
      reading: { size_text: title.match(/\d+ \w+$/)[0], size_number: count, size_unit: 'each', pack_text: null, pack_count: 1 },
    } });
    expect(result).toMatchObject({ logged: 1, held: 0 });
    expect(await stockOf(product.id)).toBe(2 * count);
    expect((await mockConn('products_catalog').where({ id: product.id }).first()).default_unit).toBe(defaultUnit);
    expect((await mockConn('purchase_receipt_lines').where({ id: line.id }).first()).status).toBe('logged');
  });

  test('a per-area rate that is not a count (lb/100sf) still holds a count purchase', async () => {
    const [product] = await mockConn('products_catalog').insert({
      name: 'Granular Bait Tubs', active: true, category: 'insecticide', container_size: '4 count', inventory_unit: 'each', default_unit: 'lb/100sf', inventory_on_hand: 0,
    }).returning('*');
    await pendingLine({ raw_title: 'Granular Bait Tubs 4 Count', product_id: product.id, quantity: 1, shipment_key: 'ship-lb-rate' });
    const result = await run({ ok: true, json: {
      kind: 'existing', reason: 'matches the candidate', product_id: product.id, new_product: null,
      reading: { size_text: '4 Count', size_number: 4, size_unit: 'each', pack_text: null, pack_count: 1 },
    } });
    expect(result).toMatchObject({ logged: 0, held: 1 });
    expect(await stockOf(product.id)).toBe(0);
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

  test('an alias removed while the model decides rolls the apply back as product_changed', async () => {
    const [product] = await mockConn('products_catalog').insert({
      name: 'Bifen XTS', active: true, category: 'insecticide', container_size: '96 oz', inventory_unit: 'oz', inventory_on_hand: 0,
    }).returning('*');
    // 'Bifen Concentrate', not 'Bifen Pro Concentrate' — every one of its
    // words must appear in the title below to give validateExisting its own
    // independent evidence (item 2, 2026-09-27 round 10 review); "Pro" isn't
    // in the title, so that older alias text would refuse before ever
    // reaching the race this test means to exercise.
    const [alias] = await mockConn('product_aliases').insert({ product_id: product.id, alias_name: 'Bifen Concentrate' }).returning('*');
    const line = await pendingLine({ raw_title: 'Bifen Insecticide Concentrate 96 oz', quantity: 1 });
    const decision = {
      kind: 'existing', reason: 'the alias names it', product_id: product.id, new_product: null,
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    const llm = async () => {
      await mockConn('product_aliases').where({ id: alias.id }).del();
      return { ok: true, json: decision };
    };
    await runInventoryAgent({ conn: mockConn, llm, notifyAdmin });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'agent_pending', agent_attempts: 1 });
    expect(await stockOf(product.id)).toBe(0);
  });

  // 2026-09-27 pre-push audit: a final LLM failure rang "log it by hand"
  // even after a later email handed the whole shipment to a person.
  test('a failed attempt on a shipment handed to a person closes the line quietly — no second bell', async () => {
    const line = await pendingLine({ agent_attempts: 2 });
    const [other] = await mockConn('emails').insert({
      gmail_id: `gm-${randomUUID()}`, gmail_thread_id: 'thread', from_address: 'order-update@amazon.com',
      subject: 'Delivered: 1 item', received_at: RECEIVED_AT,
    }).returning('*');
    await mockConn('purchase_receipt_lines').insert({
      vendor: 'amazon', order_number: 'unknown', shipment_key: 'ship-2', line_no: 1,
      raw_title: 'Bifen XTS Insecticide 96 oz', quantity: 2, status: 'no_order_number', email_id: other.id,
    });
    const result = await run({ ok: false, reason: 'llm_unavailable' });
    expect(result).toMatchObject({ held: 0, ignored: 1 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'skipped' });
    expect(saved.agent_decision).toMatchObject({ reason: 'shipment_handed_to_person' });
    expect(await bellsFor(line.id)).toHaveLength(0);
  });

  test('draining a line whose shipment was handed to a person closes it quietly', async () => {
    const line = await pendingLine();
    await mockConn('purchase_receipt_lines').where({ id: line.id }).update({ agent_decision: { handoffFrom: 'needs_size' } });
    const [other] = await mockConn('emails').insert({
      gmail_id: `gm-${randomUUID()}`, gmail_thread_id: 'thread', from_address: 'order-update@amazon.com',
      subject: 'Delivered: 1 item', received_at: RECEIVED_AT,
    }).returning('*');
    await mockConn('purchase_receipt_lines').insert({
      vendor: 'amazon', order_number: 'unknown', shipment_key: 'ship-2', line_no: 1,
      raw_title: 'Bifen XTS Insecticide 96 oz', quantity: 2, status: 'no_order_number', email_id: other.id,
    });
    process.env.GATE_INVENTORY_AGENT = 'false';
    const { drainAgentQueue } = require('../services/purchase-receipts/inventory-agent');
    await drainAgentQueue({ conn: mockConn, notifyAdmin });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved.status).toBe('skipped');
    expect(saved.agent_decision).toMatchObject({ reason: 'shipment_handed_to_person' });
    expect(await bellsFor(line.id)).toHaveLength(0);
  });

  // Superseded by item 2b, 2026-09-27 round 9 review: the OLD behavior
  // rolled the apply back on seeing a new deterministic match. Now the
  // chokepoint's rules re-check catches it and posts directly.
  test('a product added meanwhile that now matches an unmatched title is resolved by the rules, never the model\'s stale choice', async () => {
    const [bifenXts] = await mockConn('products_catalog').insert({
      name: 'Bifen XTS', active: true, category: 'insecticide', container_size: '96 oz', inventory_unit: 'oz', inventory_on_hand: 0,
    }).returning('*');
    const title = 'Bifen Insecticide Concentrate 96 oz';
    const line = await pendingLine({ raw_title: title, quantity: 1 });
    const decision = {
      kind: 'existing', reason: 'looks like Bifen XTS', product_id: bifenXts.id, new_product: null,
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    // Staff add a product whose name the title contains while the model decides.
    const llm = async () => {
      await mockConn('products_catalog').insert({
        name: 'Bifen Insecticide Concentrate', active: true, category: 'insecticide', container_size: '96 oz', inventory_unit: 'oz', inventory_on_hand: 0,
      });
      return { ok: true, json: decision };
    };
    await runInventoryAgent({ conn: mockConn, llm, notifyAdmin });
    const newProduct = await mockConn('products_catalog').where({ name: 'Bifen Insecticide Concentrate' }).first();
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'logged', product_id: newProduct.id });
    expect(saved.agent_decision).toMatchObject({ kind: 'receipt_rules' });
    // Matched by containment (the product's own name), not an alias.
    expect(await mockConn('product_aliases').where({ alias_name: title })).toHaveLength(0);
    expect(await stockOf(bifenXts.id)).toBe(0); // never the model's stale proposal
    expect(await stockOf(newProduct.id)).toBe(96);
  });

  test('draining a line received before the current cutoff closes it quietly (a count since then includes it)', async () => {
    const line = await pendingLine();
    await mockConn('purchase_receipt_lines').where({ id: line.id }).update({ agent_decision: { handoffFrom: 'needs_size' } });
    process.env.PURCHASE_RECEIPT_SINCE = new Date(RECEIVED_AT.getTime() + HOUR).toISOString();
    process.env.GATE_INVENTORY_AGENT = 'false';
    const { drainAgentQueue } = require('../services/purchase-receipts/inventory-agent');
    await drainAgentQueue({ conn: mockConn, notifyAdmin });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved.status).toBe('skipped');
    expect(saved.agent_decision).toMatchObject({ reason: 'received_before_cutoff' });
    expect(await bellsFor(line.id)).toHaveLength(0);
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
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2 });
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
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2 });
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

  // Item 4, 2026-09-27 round 9 review: an active product's ALIAS collides
  // with the proposed new-product name, not the product's own catalog name
  // — the gap the pure-name-only check missed.
  test('an active product\'s alias colliding with a proposed new-product name is refused before any write (item 4a, 2026-09-27 round 9)', async () => {
    const [bifenthrin] = await mockConn('products_catalog').insert({
      name: 'Bifenthrin 7.9', active: true, category: 'insecticide', container_size: '7.9 gal', inventory_unit: 'fl_oz', inventory_on_hand: 0,
    }).returning('*');
    await mockConn('product_aliases').insert({ product_id: bifenthrin.id, alias_name: 'Bifen XTS' });
    const title = 'Control Solutions Bifen XTS Insecticide 96 oz';
    const line = await pendingLine({ raw_title: title, quantity: 1, shipment_key: 'ship-alias-collision' });
    const decision = {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    const result = await run({ ok: true, json: decision });
    expect(result).toMatchObject({ logged: 0, held: 1 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved.status).toBe('agent_unsure');
    expect(saved.agent_decision.reason).toMatch(/looks like an existing product/);
    expect(await mockConn('products_catalog').where({ name: 'Bifen XTS' })).toHaveLength(0);
  });

  // The apply-time re-check (the locked guard inside createCatalogProduct)
  // is what actually protects the write: an alias saved AFTER the pure
  // validation above already passed makes the apply a retry, never a
  // duplicate product (item 4b, 2026-09-27 round 9 review).
  test('an alias colliding with the proposed name, added while the model "decides", makes the apply a retry — no product created (item 4b, 2026-09-27 round 9)', async () => {
    const [bifenthrin] = await mockConn('products_catalog').insert({
      name: 'Bifenthrin 7.9', active: true, category: 'insecticide', container_size: '7.9 gal', inventory_unit: 'fl_oz', inventory_on_hand: 0,
    }).returning('*');
    const title = 'Control Solutions Bifen XTS Insecticide 96 oz';
    const line = await pendingLine({ raw_title: title, quantity: 1, shipment_key: 'ship-alias-race' });
    const decision = {
      kind: 'new_product', reason: 'not in the catalog', product_id: null,
      new_product: { name: 'Bifen XTS', category: 'insecticide', active_ingredient: null, epa_reg_no: null },
      reading: { size_text: '96 oz', size_number: 96, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    const llm = async () => {
      // A different admin action ties "Bifen XTS" to the existing active
      // product as an alias while the model is "thinking" — AFTER the pure
      // validation above (which ran against the pre-alias snapshot) already
      // let the proposal through.
      await mockConn('product_aliases').insert({ product_id: bifenthrin.id, alias_name: 'Bifen XTS' });
      return { ok: true, json: decision };
    };
    const result = await runInventoryAgent({ conn: mockConn, llm, notifyAdmin });
    expect(result).toMatchObject({ logged: 0 });
    // agent_decision itself is only written on the 3rd, final attempt
    // (recordAttemptFailure) — the first two just bump agent_attempts — so
    // the retry (never a duplicate product) is what's checked here.
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'agent_pending', agent_attempts: 1 });
    expect(await mockConn('products_catalog').where({ name: 'Bifen XTS' })).toHaveLength(0);
  });

  // Item 2, 2026-09-27 round 9 review — decideForTitle's own re-classification.
  test('decideForTitle never calls the model when its own re-classification already resolves the title (item 2a, 2026-09-27 round 9)', async () => {
    const dispatch = jest.fn(async () => ({ ok: true, json: { kind: 'not_stock', reason: 'unused' } }));
    const result = await decideForTitle(mockConn, dispatch, {
      rawTitle: 'Control Solutions Taurus SC Termiticide 78 oz', quantity: 2, vendor: 'amazon', siteOneFields: null,
    }, { activeProducts: [], activeProductAliases: {} });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rulesResolve: true });
  });

  test('processOneLine posts a rulesResolve sentinel through the same locked rules path — no bare product_id needed, the model was never asked', async () => {
    // Unmatched at first (no product yet), so postIfDeterministic's OWN
    // cheap pre-check does NOT catch it — the title only becomes resolvable
    // once the alias below exists.
    const [bifenXts] = await mockConn('products_catalog').insert({
      name: 'Bifen XTS', active: true, category: 'insecticide', container_size: '96 oz', inventory_unit: 'oz', inventory_on_hand: 0,
    }).returning('*');
    const title = 'Bifen Insecticide Concentrate 96 oz';
    const line = await pendingLine({ raw_title: title, quantity: 2, shipment_key: 'ship-rules-resolve' });
    // The alias exists BEFORE the run starts this time (unlike the
    // chokepoint test below, which adds it mid-flight) — so
    // postIfDeterministic's pre-check itself would already catch this.
    // decideForTitle's OWN check is exercised instead by the assertion that
    // the model is never called, proven directly above; this test proves
    // the END-TO-END posting path (postLineThroughRules) actually applies
    // the rules and logs stock, not just that dispatch was skipped.
    await mockConn('product_aliases').insert({ product_id: bifenXts.id, alias_name: title });
    const dispatch = jest.fn();
    const result = await runInventoryAgent({ conn: mockConn, llm: dispatch, notifyAdmin });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ logged: 1 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'logged', product_id: bifenXts.id });
    expect(saved.agent_decision).toMatchObject({ kind: 'receipt_rules' });
    expect(await stockOf(bifenXts.id)).toBe(192); // 2 x 96 oz
  });

  // The chokepoint INSIDE applyDecision's own transaction: the catalog
  // becomes resolvable WHILE the (real, async) LLM call is in flight — after
  // decideForTitle's own check already ran and found it unresolved, so the
  // model really is asked — and a terminal not_stock answer must still lose
  // to what the rules now resolve (item 2b, 2026-09-27 round 9 review).
  test('the apply-time chokepoint: the rules win over a not_stock answer when the catalog resolves while the model "decides" (item 2b, 2026-09-27 round 9)', async () => {
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2, shipment_key: 'ship-chokepoint' });
    const llm = async () => {
      // Simulates a concurrent transaction committing while the LLM call is
      // in flight: an exact-title alias now ties this line to Taurus SC.
      await mockConn('product_aliases').insert({ product_id: taurus.id, alias_name: AGENT_ONLY_TAURUS_TITLE });
      return { ok: true, json: { kind: 'not_stock', reason: 'looks personal' } };
    };
    const result = await runInventoryAgent({ conn: mockConn, llm, notifyAdmin });
    expect(result).toMatchObject({ logged: 1, held: 0, ignored: 0 });
    const saved = await mockConn('purchase_receipt_lines').where({ id: line.id }).first();
    expect(saved).toMatchObject({ status: 'logged', product_id: taurus.id });
    expect(saved.agent_decision).toMatchObject({ kind: 'receipt_rules' });
    expect(await stockOf(taurus.id)).toBe(156); // 2 x 78 fl oz — never the not_stock answer
  });

  test('an apply-time throw (e.g. a bell that fails to save) counts toward agent_attempts like an LLM failure; the 3rd hands off to a person', async () => {
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2, shipment_key: 'ship-throw' });
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
    const dupLine = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 2, shipment_key: 'ship-dup' });
    const dupDecision = {
      kind: 'existing', reason: 'matches the candidate', product_id: taurus.id, new_product: null,
      reading: { size_text: '78 oz', size_number: 78, size_unit: 'oz', pack_text: null, pack_count: 1 },
    };
    const dupResult = await run({ ok: true, json: dupDecision });
    expect(dupResult).toMatchObject({ held: 1, ignored: 0 });
    expect((await mockConn('purchase_receipt_lines').where({ id: dupLine.id }).first()).status).toBe('possible_duplicate');
  });

  test('the catalog renaming or recategorizing the candidate while the model decides rolls the apply back as product_changed — not just container_size/inventory_unit (review item 7)', async () => {
    const line = await pendingLine({ raw_title: AGENT_ONLY_TAURUS_TITLE, product_id: null, quantity: 1 });
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
