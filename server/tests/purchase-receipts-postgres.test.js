// CI's DB-gated pass runs this against the migrated PostgreSQL. Fixture
// tables are LIKE copies (constraints and defaults included) in a unique
// schema that is dropped after the suite. The real matcher, sizing and
// adjustStock run; this proves the SQL the mocked suites can't: the
// duplicate-receipt guard's time windows and NULL-safe source test, the
// UNIQUE claim under a concurrent run, the status CHECK, and rollback.
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

const { processReceiptLine } = require('../services/purchase-receipts/receipt-processor');

const TABLES = ['products_catalog', 'product_aliases', 'product_inventory_movements', 'product_restock_requests', 'purchase_receipt_lines'];
const RECEIVED_AT = new Date('2026-09-27T15:00:00Z');
const TITLE = 'Control Solutions Taurus SC Termiticide 78 oz';
const HOUR = 60 * 60 * 1000;

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('purchase receipts on PostgreSQL', () => {
  const schema = `purchase_receipts_${randomUUID().replaceAll('-', '')}`;
  let taurus;

  beforeAll(async () => {
    mockConn = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 4 } });
    await mockConn.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await mockConn.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
  });
  beforeEach(async () => {
    [taurus] = await mockConn('products_catalog').insert({
      name: 'Taurus SC', active: true, container_size: '78 fl oz', inventory_unit: 'fl_oz', inventory_on_hand: 0,
    }).returning('*');
  });
  afterEach(async () => {
    for (const table of TABLES) await mockConn.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => {
    await mockConn.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await mockConn.destroy();
  });

  const line = (overrides = {}) => ({
    email: { id: randomUUID(), received_at: RECEIVED_AT }, orderNumber: '900-1000001-1000001',
    shipmentKey: 'ship-1', item: { title: TITLE, quantity: 2 }, lineNo: 1, ...overrides,
  });
  // A ledger row `hours` after the email's received_at (negative = before).
  const movement = (type, hours, metadata) => mockConn('product_inventory_movements').insert({
    product_id: taurus.id, movement_type: type, quantity: 10, unit: 'fl_oz',
    metadata, created_at: new Date(RECEIVED_AT.getTime() + hours * HOUR),
  });
  const stock = async () => Number((await mockConn('products_catalog').where({ id: taurus.id }).first()).inventory_on_hand);
  const savedLine = () => mockConn('purchase_receipt_lines').where({ order_number: '900-1000001-1000001' }).first();

  test('a clean delivery restocks through adjustStock and links the movement to the claim', async () => {
    const outcome = await processReceiptLine(line());
    expect(outcome).toMatchObject({ status: 'logged', receivedQty: 156, receivedUnit: 'fl_oz', hasOpenRestockRequest: false });
    expect(await stock()).toBe(156);
    const [written] = await mockConn('product_inventory_movements').where({ product_id: taurus.id });
    expect(written).toMatchObject({ movement_type: 'restock', unit: 'fl_oz' });
    expect(written.metadata).toMatchObject({ source: 'amazon_delivery', orderNumber: '900-1000001-1000001', rawTitle: TITLE });
    expect(await savedLine()).toMatchObject({ status: 'logged', movement_id: written.id });
  });

  test('the same line twice logs once', async () => {
    await processReceiptLine(line());
    expect(await processReceiptLine(line())).toEqual({ skipped: true, reason: 'already_processed' });
    expect(await stock()).toBe(156);
  });

  test('two runs racing on the same line: one restock, one skip', async () => {
    const outcomes = await Promise.all([processReceiptLine(line()), processReceiptLine(line())]);
    expect(outcomes.map((o) => o.status || o.reason).sort()).toEqual(['already_processed', 'logged']);
    expect(await stock()).toBe(156);
    expect(await mockConn('product_inventory_movements').where({ product_id: taurus.id }).count('* as n').first()).toEqual({ n: '1' });
  });

  test.each([
    ['a manual restock 10h before the email', 'restock', -10, { source: 'intelligence_bar_adjust_stock' }],
    ['an untagged restock (NULL metadata) 10h before', 'restock', -10, null],
    ['a restock with no source key 47h before', 'restock', -47, {}],
    ['a manual restock logged after the email arrived', 'restock', 1, { source: 'restock_request_receive' }],
    ['a count (correction) after the email', 'correction', 2, { source: 'admin_manual_adjustment' }],
  ])('%s holds the line: no movement, possible_duplicate, amount kept', async (_label, type, hours, metadata) => {
    await movement(type, hours, metadata);
    expect(await processReceiptLine(line())).toMatchObject({ status: 'possible_duplicate', receivedQty: 156 });
    expect(await stock()).toBe(0);
    expect(await savedLine()).toMatchObject({ status: 'possible_duplicate', received_qty: '156.0000', movement_id: null });
  });

  test.each([
    ['the morning count before the delivery', 'correction', -9, { source: 'admin_manual_adjustment' }],
    ['a manual restock 72h before (outside the window)', 'restock', -72, { source: 'intelligence_bar_adjust_stock' }],
    ['another Amazon delivery restock 10h before', 'restock', -10, { source: 'amazon_delivery' }],
    ['usage after the email', 'usage', 3, null],
  ])('%s does not hold: the delivery logs', async (_label, type, hours, metadata) => {
    await movement(type, hours, metadata);
    expect(await processReceiptLine(line())).toMatchObject({ status: 'logged' });
    expect(await stock()).toBe(156);
  });

  test('a live restock request is reported and left exactly as it was', async () => {
    const [request] = await mockConn('product_restock_requests').insert({ product_id: taurus.id, status: 'open', requested_quantity: 78 }).returning('*');
    expect(await processReceiptLine(line())).toMatchObject({ status: 'logged', hasOpenRestockRequest: true });
    expect(await mockConn('product_restock_requests').where({ id: request.id }).first()).toEqual(request);
  });

  test('a failing stock write rolls the claim back, so the next sweep retries the line', async () => {
    await mockConn('products_catalog').where({ id: taurus.id }).update({ inventory_unit: 'each' }); // fl oz can't convert to each
    await expect(processReceiptLine(line())).rejects.toThrow(/Cannot convert/);
    expect(await savedLine()).toBeUndefined();
    await mockConn('products_catalog').where({ id: taurus.id }).update({ inventory_unit: 'fl_oz' });
    expect(await processReceiptLine(line())).toMatchObject({ status: 'logged' });
  });
});
