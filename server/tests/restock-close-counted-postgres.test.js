// "Close, already counted" and the Receive warning on a restock request, against PostgreSQL
// (CI's DB-gated pass; locally set DATABASE_URL to a migrated scratch database). Fixture tables are
// LIKE copies in a unique schema that is dropped after the suite. The real updateRestockRequest and
// order-dispatch settle code run. Fixtures are synthetic.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  proxy.schema = { hasTable: (...args) => mockConn.schema.hasTable(...args) };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const inventory = require('../services/inventory-operations');

const TABLES = ['products_catalog', 'product_restock_requests', 'vendor_orders', 'product_inventory_movements', 'notifications'];
const DAY = 24 * 60 * 60 * 1000;

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('restock close counted on PostgreSQL', () => {
  const schema = `restock_close_${randomUUID().replaceAll('-', '')}`;
  let product;

  beforeAll(async () => {
    mockConn = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 4 } });
    await mockConn.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await mockConn.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
  });
  beforeEach(async () => {
    [product] = await mockConn('products_catalog').insert({
      name: 'Synthetic SC', active: true, container_size: '1 gal', inventory_unit: 'gal', inventory_on_hand: 4,
    }).returning('*');
  });
  afterEach(async () => {
    for (const table of TABLES) await mockConn.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => {
    await mockConn.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await mockConn.destroy();
  });

  const request = (overrides = {}) => mockConn('product_restock_requests').insert({
    product_id: product.id, status: 'ordered', requested_quantity: 4, unit: 'gal', source: 'auto_reorder',
    created_at: new Date(Date.now() - 3 * DAY), ...overrides,
  }).returning('*').then(([row]) => row);
  const ledger = (requestId, overrides = {}) => mockConn('vendor_orders').insert({
    restock_request_id: requestId, adapter: 'siteone', status: 'placed', amount_cents: 12000,
    placed_at: new Date(Date.now() - 2 * DAY), ...overrides,
  }).returning('*').then(([row]) => row);
  const invoiceMovement = (quantity, daysAgo, source = 'siteone_invoice') => mockConn('product_inventory_movements').insert({
    product_id: product.id, movement_type: 'restock', quantity, unit: 'gal', stock_before: 0, stock_after: quantity,
    metadata: { source }, created_at: new Date(Date.now() - daysAgo * DAY),
  });
  const bell = (ledgerId) => mockConn('notifications').insert({
    recipient_type: 'admin', category: 'operations', title: 'Order parked', metadata: { dedupeKey: `auto-order:${ledgerId}` },
  }).returning('*').then(([row]) => row);
  const stock = async () => Number((await mockConn('products_catalog').where({ id: product.id }).first()).inventory_on_hand);
  const movements = () => mockConn('product_inventory_movements').where({ product_id: product.id });
  const reload = (id) => mockConn('product_restock_requests').where({ id }).first();

  test.each(['open', 'ordered'])('closes a %s request as received and changes no stock', async (status) => {
    const req = await request({ status });
    const result = await inventory.updateRestockRequest(req.id, { action: 'close_counted', note: 'invoice counted it' }, { actorId: null });
    expect(result.request.status).toBe('received');
    expect(result.movement).toBeUndefined();
    expect(await stock()).toBe(4);
    expect(await movements()).toHaveLength(0);
    const saved = await reload(req.id);
    expect(saved.closed_at).not.toBeNull();
    expect(saved.metadata).toMatchObject({ lastManualAction: { action: 'close_counted', note: 'invoice counted it' } });
  });

  test('a placed order settles: the request is received, the order bell is retired, and the order stays on the monthly cap', async () => {
    const req = await request();
    const order = await ledger(req.id);
    const note = await bell(order.id);
    await inventory.updateRestockRequest(req.id, { action: 'close_counted' }, { actorId: null });
    const row = await mockConn('vendor_orders').where({ id: order.id }).first();
    expect(row.status).toBe('placed');
    expect(row.placed_at).not.toBeNull();
    expect(row.evidence.revokedAt).toBeUndefined();
    expect((await mockConn('notifications').where({ id: note.id }).first()).done_at).not.toBeNull();
    const dispatch = require('../services/procurement/order-dispatch');
    expect(await dispatch.findLiveAutoOrder(mockConn, product.id)).toBeUndefined();
    expect(await dispatch.monthlySpentCents(mockConn)).toBe(12000);
  });

  test('closes a parked request (post-submit needs_review order) the same way', async () => {
    const req = await request();
    const order = await ledger(req.id, { status: 'needs_review', error: 'ambiguous_after_submit' });
    await inventory.updateRestockRequest(req.id, { action: 'close_counted' }, { actorId: null });
    expect((await reload(req.id)).status).toBe('received');
    expect(await require('../services/procurement/order-dispatch').findLiveAutoOrder(mockConn, product.id)).toBeUndefined();
    expect((await mockConn('vendor_orders').where({ id: order.id }).first()).status).toBe('needs_review');
  });

  test('refuses a request that is received or cancelled, and one whose order is still being placed', async () => {
    for (const status of ['received', 'cancelled']) {
      const req = await request({ status });
      await expect(inventory.updateRestockRequest(req.id, { action: 'close_counted' }, {})).rejects.toMatchObject({ statusCode: 409, code: 'request_closed' });
    }
    const req = await request();
    await ledger(req.id, { status: 'placing', placed_at: null });
    await expect(inventory.updateRestockRequest(req.id, { action: 'close_counted' }, {})).rejects.toMatchObject({ statusCode: 409, code: 'auto_order_placing' });
    expect((await reload(req.id)).status).toBe('ordered');
  });

  test('Receive is refused with the quantity and date an invoice already added', async () => {
    const req = await request();
    await invoiceMovement(4, 1);
    await expect(inventory.updateRestockRequest(req.id, { action: 'receive' }, {})).rejects.toMatchObject({
      statusCode: 409, code: 'already_counted_by_receipt',
      message: expect.stringMatching(/^An invoice already added 4 gal on [A-Z][a-z]+ \d{1,2}\. Receive again only if this is a second delivery\.$/),
      details: { alreadyAdded: { quantity: 4, unit: 'gal' } },
    });
    expect(await stock()).toBe(4);
    expect((await reload(req.id)).status).toBe('ordered');
  });

  test('Receive anyway (confirm) adds the stock; a hand entry or an older invoice never triggers the warning', async () => {
    const req = await request();
    await invoiceMovement(2, 1, 'admin_manual_adjustment');
    await invoiceMovement(3, 10);
    const plain = await inventory.updateRestockRequest(req.id, { action: 'receive' }, {});
    expect(plain.request.status).toBe('received');
    expect(await stock()).toBe(8);

    const second = await request();
    await invoiceMovement(1, 0.5, 'amazon_delivery');
    await expect(inventory.updateRestockRequest(second.id, { action: 'receive' }, {})).rejects.toMatchObject({ code: 'already_counted_by_receipt' });
    const confirmed = await inventory.updateRestockRequest(second.id, { action: 'receive', confirm: true }, {});
    expect(confirmed.request.status).toBe('received');
    expect(await stock()).toBe(12);
  });

  test('only invoices after the order went out count; the preview refuses the same way', async () => {
    const req = await request();
    await ledger(req.id, { placed_at: new Date(Date.now() - 1 * DAY) });
    await invoiceMovement(4, 2);
    expect((await inventory.previewRestockAction(req.id, { action: 'receive' })).new_status).toBe('received');
    await invoiceMovement(4, 0.2);
    await expect(inventory.previewRestockAction(req.id, { action: 'receive' })).rejects.toMatchObject({ code: 'already_counted_by_receipt' });
  });

  test('confirm is not accepted on other actions', async () => {
    const req = await request();
    await expect(inventory.updateRestockRequest(req.id, { action: 'close_counted', confirm: true }, {})).rejects.toMatchObject({ statusCode: 400 });
  });
});
