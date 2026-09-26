// CI's DB-gated pass runs this against the migrated PostgreSQL. Fixture
// tables are LIKE copies (constraints and defaults included) in a unique
// schema that is dropped after the suite. The real matcher, sizing,
// adjustStock and notifyAdmin run; this proves what the mocked suites
// can't: the duplicate-receipt guard's time windows and NULL-safe source
// test, the UNIQUE claim under a concurrent run, re-reading the product
// under a real row lock, the bell committing (or failing) with its line,
// the status CHECKs, rollback, and the undelivered-shipment alert.
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
const notifications = require('../services/notification-service');
const { alertUndeliveredShipments } = require('../services/purchase-receipts/undelivered-shipments');
const { runPurchaseReceiptRestockSweep } = require('../services/purchase-receipts/sweep');

const TABLES = ['products_catalog', 'product_aliases', 'product_inventory_movements', 'product_restock_requests', 'purchase_receipt_lines', 'notifications', 'emails', 'email_attachments'];
const RECEIVED_AT = new Date('2026-09-27T15:00:00Z');
const TITLE = 'Control Solutions Taurus SC Termiticide 78 oz';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ALIGNED_AMAZON_AUTH = 'dkim=pass header.i=@amazon.com; spf=pass smtp.mailfrom=amazon.com';

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
    vendor: 'amazon', email: { id: randomUUID(), received_at: RECEIVED_AT }, orderNumber: '900-1000001-1000001',
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

  test('the line\'s bell commits with it, keyed to the line', async () => {
    const ringBell = (outcome, trx) => notifications.notifyAdmin('inventory', 'Amazon delivery logged', 'body', {
      bell: true, dedupeKey: `purchase-receipt:${outcome.lineId}`, trx,
    });
    const outcome = await processReceiptLine(line({ ringBell }));
    const bells = await mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`purchase-receipt:${outcome.lineId}`]);
    expect(bells).toHaveLength(1);
  });

  test('a bell that can\'t be saved rolls back the line and its stock; the retry logs once', async () => {
    const failingBell = (_outcome, trx) => trx.raw('SELECT 1 / 0');
    await expect(processReceiptLine(line({ ringBell: failingBell }))).rejects.toThrow(/division by zero/);
    expect(await stock()).toBe(0);
    expect(await savedLine()).toBeUndefined();
    expect(await processReceiptLine(line())).toMatchObject({ status: 'logged' });
    expect(await stock()).toBe(156);
  });

  test('a container_size edit that commits while the line waits on the product lock is what counts', async () => {
    const blocker = await mockConn.transaction();
    await blocker('products_catalog').where({ id: taurus.id }).forUpdate().first('id');
    const pending = processReceiptLine(line()); // first read sees 78 fl oz, then waits on the lock
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await mockConn.raw("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
      if (rows[0].n > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await blocker('products_catalog').where({ id: taurus.id }).update({ container_size: '96 fl oz' });
    await blocker.commit();
    expect(await pending).toMatchObject({ status: 'size_mismatch' });
    expect(await stock()).toBe(0);
  });

  test('no readable Order #: a would-be restock is held as no_order_number under order "unknown"', async () => {
    expect(await processReceiptLine(line({ orderNumber: null, holdAs: 'no_order_number' }))).toMatchObject({ status: 'no_order_number' });
    expect(await stock()).toBe(0);
    expect(await mockConn('purchase_receipt_lines').where({ order_number: 'unknown' }).first()).toMatchObject({ status: 'no_order_number', product_id: taurus.id });
  });

  test('a failing stock write rolls the claim back, so the next sweep retries the line', async () => {
    await mockConn('products_catalog').where({ id: taurus.id }).update({ inventory_unit: 'each' }); // fl oz can't convert to each
    await expect(processReceiptLine(line())).rejects.toThrow(/Cannot convert/);
    expect(await savedLine()).toBeUndefined();
    await mockConn('products_catalog').where({ id: taurus.id }).update({ inventory_unit: 'fl_oz' });
    expect(await processReceiptLine(line())).toMatchObject({ status: 'logged' });
  });
  describe('shipments whose Delivered email never came', () => {
    const NOW = new Date('2026-09-30T12:00:00Z').getTime();
    const shipped = (shipmentId, overrides = {}) => mockConn('emails').insert({
      gmail_id: `gm-${randomUUID()}`, gmail_thread_id: 'thread', from_address: 'shipment-tracking@amazon.com',
      subject: 'Shipped: "Control Solutions Taurus..." and 1 more item', authentication_results: ALIGNED_AMAZON_AUTH,
      body_text: `Order #\n900-1000001-1000001\nTrack package: https://www.amazon.com/x?shipmentId=${shipmentId}\n\n`
        + `* ${TITLE}\n  Quantity: 2\n\n* Lenovo Chromebook\n  Quantity: 1\n`,
      received_at: new Date(NOW - 4 * DAY), ...overrides,
    });
    const run = (now = NOW) => alertUndeliveredShipments({
      since: new Date(NOW - 30 * DAY), now, notifyAdmin: (...args) => notifications.notifyAdmin(...args),
    });
    const alertBells = (shipmentId) => mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`purchase-receipt-undelivered:${shipmentId}`]);

    test('a stocked shipment unconfirmed after 3 days: its stocked items are held and ONE bell asks for a hand log', async () => {
      await shipped('ship-1');
      expect((await run()).undelivered).toHaveLength(1);
      const rows = await mockConn('purchase_receipt_lines').where({ shipment_key: 'ship-1' });
      expect(rows).toEqual([expect.objectContaining({ status: 'no_delivery_email', product_id: taurus.id, raw_title: TITLE, line_no: 1 })]);
      const [bell] = await alertBells('ship-1');
      expect(bell.body).toBe("Amazon shipped Taurus SC ×2 on September 26 but never sent a delivery confirmation, so it wasn't added. If it arrived, log it by hand.");
      expect(await stock()).toBe(0);
    });

    test('a re-run never re-rings', async () => {
      await shipped('ship-1');
      await run();
      expect((await run()).undelivered).toEqual([]);
      expect(await alertBells('ship-1')).toHaveLength(1);
      expect(await mockConn('purchase_receipt_lines').where({ shipment_key: 'ship-1' })).toHaveLength(1);
    });

    test('its late Delivered email is never auto-logged, so the box can\'t be counted twice', async () => {
      await shipped('ship-1');
      await run();
      // The same line key as the alert's row, and a line the Delivered email numbers differently.
      expect(await processReceiptLine(line())).toEqual({ skipped: true, reason: 'already_processed' });
      expect(await processReceiptLine(line({ lineNo: 2 }))).toEqual({ skipped: true, reason: 'asked_to_log_by_hand' });
      expect(await stock()).toBe(0);
    });

    test('a shipment whose Delivered email came is settled: no bell', async () => {
      await processReceiptLine(line()); // the Delivered line for shipment ship-1
      await shipped('ship-1');
      expect((await run()).undelivered).toEqual([]);
      expect(await alertBells('ship-1')).toHaveLength(0);
    });

    test('a promised arrival day is waited out, plus the day after: "Arriving Wednesday" from Sun Sep 13 rings Fri Sep 18', async () => {
      const shippedSunday = new Date('2026-09-13T17:12:00Z'); // 1:12 PM ET
      await shipped('ship-6', { received_at: shippedSunday, body_text: `Arriving Wednesday\nOrder #\n900-1000001-1000001\nhttps://www.amazon.com/x?shipmentId=ship-6\n\n* ${TITLE}\n  Quantity: 1\n` });
      expect((await run(new Date('2026-09-17T16:00:00Z').getTime())).undelivered).toEqual([]); // Thursday noon ET
      expect((await run(new Date('2026-09-18T05:00:00Z').getTime())).undelivered).toHaveLength(1); // Friday 1 AM ET
      const [bell] = await alertBells('ship-6');
      expect(bell.body).toBe("Amazon shipped Taurus SC ×1 on September 13 (due September 16) but never sent a delivery confirmation, so it wasn't added. If it arrived, log it by hand.");
    });

    test('too recent, unauthenticated, personal items only, or outside the lookback: no bell', async () => {
      await shipped('ship-2', { received_at: new Date(NOW - 2 * DAY) });
      await shipped('ship-3', { authentication_results: 'dkim=pass header.i=@evil.example; spf=fail' });
      await shipped('ship-4', { body_text: 'Order #\n900-1\nhttps://www.amazon.com/x?shipmentId=ship-4\n\n* Lenovo Chromebook\n  Quantity: 1\n' });
      await shipped('ship-5', { received_at: new Date(NOW - 15 * DAY) });
      expect((await run()).undelivered).toEqual([]);
      expect(await mockConn('purchase_receipt_lines')).toEqual([]);
      expect(await mockConn('notifications')).toEqual([]);
    });
  });
  describe('SiteOne invoices through the sweep', () => {
    const INVOICE = '900000001-001';
    const TAURUS_LINE = 'CSI-Pest Taurus SC Broad Spectrum Liquid Concentrate Termiticide/Insecticide 78 fl oz. Bottle (QGCY) UOM:EA';
    const SPRAYER_LINE = 'Flowzone Cyclone 3 Variable Pressure 18V Battery Powered Sprayer (4-Gallon)';
    const savedEnv = {};
    beforeAll(() => {
      for (const key of ['GATE_PURCHASE_RECEIPT_RESTOCK', 'PURCHASE_RECEIPT_SINCE']) savedEnv[key] = process.env[key];
      process.env.GATE_PURCHASE_RECEIPT_RESTOCK = 'true';
      process.env.PURCHASE_RECEIPT_SINCE = new Date(Date.now() - 2 * DAY).toISOString();
    });
    afterAll(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });

    // An authenticated invoice email plus the invoice pipeline's extraction of its PDF.
    async function invoiceEmail({ from, subject, bodyHtml = '', hoursAgo, lines, total }) {
      const [email] = await mockConn('emails').insert({
        gmail_id: `gm-${randomUUID()}`, gmail_thread_id: 'thread', from_address: from, subject, body_html: bodyHtml,
        authentication_results: `dkim=pass header.i=@${from.split('@')[1]}`, received_at: new Date(Date.now() - hoursAgo * HOUR),
      }).returning('*');
      const subtotal = lines.reduce((sum, line) => sum + line.total, 0);
      await mockConn('email_attachments').insert({
        email_id: email.id, filename: 'invoice.pdf', mime_type: 'application/pdf', is_invoice: true,
        extracted_data: JSON.stringify({ invoice_number: INVOICE, subtotal, tax: total - subtotal, total, line_items: lines }),
      });
      return email;
    }
    const storeCopy = (lines, total) => invoiceEmail({ from: 'AB00000@siteone.com', subject: `SiteOne Confirmation : Invoice #${INVOICE}`, hoursAgo: 3, lines, total });
    const billingCopy = (lines, total) => invoiceEmail({
      from: 'siteoneus@billtrust.com', subject: 'Acct No. 0000000: Your Invoice From SiteOne Landscape Supply, LLC is Attached',
      bodyHtml: `<td align=center>${INVOICE}</td>`, hoursAgo: 1, lines, total,
    });
    const notify = (...args) => notifications.notifyAdmin(...args);

    test('a reconciled invoice adds its stocked line to stock; its billing copy adds nothing more', async () => {
      const lines = [
        { description: TAURUS_LINE, quantity: 1, unit_price: 95, total: 95 },
        { description: SPRAYER_LINE, quantity: 1, unit_price: 269.99, total: 269.99 },
      ];
      await storeCopy(lines, 390.54);
      const result = await runPurchaseReceiptRestockSweep({ notify });
      expect(result.logged).toHaveLength(1);
      expect(await stock()).toBe(78);
      const rows = await mockConn('purchase_receipt_lines').where({ vendor: 'siteone', shipment_key: INVOICE }).orderBy('line_no');
      expect(rows.map((row) => [row.line_no, row.status])).toEqual([[1, 'logged'], [2, 'unmatched']]);
      const [movement] = await mockConn('product_inventory_movements').where({ product_id: taurus.id });
      expect(movement.metadata).toMatchObject({ source: 'siteone_invoice', orderNumber: INVOICE });
      const [bell] = await mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`purchase-receipt:${rows[0].id}`]);
      expect(bell.body).toBe(`SiteOne invoice ${INVOICE} logged: Taurus SC +78 fl oz (1 × 78 fl oz)`);

      await billingCopy(lines, 390.54);
      await runPurchaseReceiptRestockSweep({ notify });
      expect(await stock()).toBe(78);
      expect(await mockConn('purchase_receipt_lines').where({ vendor: 'siteone' })).toHaveLength(2);
    });

    test('a return of a stocked product is held for a hand adjustment, never subtracted or added', async () => {
      await storeCopy([{ description: TAURUS_LINE, quantity: -1, unit_price: 95, total: -95 }], -101.65);
      await runPurchaseReceiptRestockSweep({ notify });
      expect(await stock()).toBe(0);
      expect(await mockConn('purchase_receipt_lines').where({ vendor: 'siteone' }).first()).toMatchObject({ status: 'returned', product_id: taurus.id });
    });

    test('an invoice whose numbers don\'t reconcile moves nothing; its stocked line is held unverified', async () => {
      await storeCopy([{ description: TAURUS_LINE, quantity: 2, unit_price: 95, total: 95 }], 101.65);
      await runPurchaseReceiptRestockSweep({ notify });
      expect(await stock()).toBe(0);
      expect(await mockConn('purchase_receipt_lines').where({ vendor: 'siteone' }).first()).toMatchObject({ status: 'unverified' });
    });
  });
});
