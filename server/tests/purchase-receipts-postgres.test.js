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
const { alertUndeliveredShipments, closeDeliveredUndeliveredBells } = require('../services/purchase-receipts/undelivered-shipments');
const { runPurchaseReceiptRestockSweep, processReceiptEmail } = require('../services/purchase-receipts/sweep');

const TABLES = ['products_catalog', 'product_aliases', 'product_inventory_movements', 'product_restock_requests', 'vendor_orders', 'purchase_receipt_lines', 'notifications', 'emails', 'email_attachments'];
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
  // A correction's quantity is its signed change.
  const movement = (type, hours, metadata, quantity) => mockConn('product_inventory_movements').insert({
    product_id: taurus.id, movement_type: type, quantity, unit: 'fl_oz',
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
    ['a manual restock 10h before the email', 'restock', -10, { source: 'intelligence_bar_adjust_stock' }, 10],
    ['an untagged restock (NULL metadata) 10h before', 'restock', -10, null, 10],
    ['a restock with no source key 47h before', 'restock', -47, {}, 10],
    ['a manual restock logged after the email arrived', 'restock', 1, { source: 'restock_request_receive' }, 10],
    ['a count (correction) after the email', 'correction', 2, { source: 'admin_manual_adjustment' }, 10],
    ['a count lowered after the email', 'correction', 2, { source: 'admin_manual_adjustment' }, -4],
    ['the bottle entered by hand at the counter, 10 minutes before the invoice email', 'correction', -1 / 6, { source: 'admin_inline_stock_edit' }, 78],
    ['a count raised 47h before', 'correction', -47, { source: 'admin_manual_adjustment' }, 5],
  ])('%s holds the line: no movement, possible_duplicate, amount kept', async (_label, type, hours, metadata, quantity) => {
    await movement(type, hours, metadata, quantity);
    expect(await processReceiptLine(line())).toMatchObject({ status: 'possible_duplicate', receivedQty: 156 });
    expect(await stock()).toBe(0);
    expect(await savedLine()).toMatchObject({ status: 'possible_duplicate', received_qty: '156.0000', movement_id: null });
  });

  test.each([
    ['the morning count that lowered stock before the delivery', 'correction', -9, { source: 'admin_manual_adjustment' }, -22],
    ['a count with no change before the delivery', 'correction', -9, { source: 'inventory_unit_review' }, 0],
    ['a count raised 49h before (outside the window)', 'correction', -49, { source: 'admin_manual_adjustment' }, 78],
    ['a manual restock 72h before (outside the window)', 'restock', -72, { source: 'intelligence_bar_adjust_stock' }, 10],
    ['another Amazon delivery restock 10h before', 'restock', -10, { source: 'amazon_delivery' }, 10],
    ['usage after the email', 'usage', 3, null, 10],
  ])('%s does not hold: the delivery logs', async (_label, type, hours, metadata, quantity) => {
    await movement(type, hours, metadata, quantity);
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

  test.each([
    ['an itemless email (no_items placeholder)', { forcedStatus: 'no_items', item: { title: 'Delivered: 1 Lawn & Garden item', quantity: 1 } }],
    ['an email with no readable Order # (no_order_number)', { orderNumber: null, holdAs: 'no_order_number' }],
  ])('after %s asked for a hand log, a later readable email for the shipment adds nothing', async (_label, first) => {
    await processReceiptLine(line(first));
    const later = { email: { id: randomUUID(), received_at: RECEIVED_AT } };
    expect(await processReceiptLine(line({ ...later, lineNo: 1 }))).toMatchObject({ skipped: true });
    expect(await processReceiptLine(line({ ...later, lineNo: 2 }))).toEqual({ skipped: true, reason: 'asked_to_log_by_hand' });
    expect(await stock()).toBe(0);
  });

  test('a failing stock write rolls the claim back, so the next sweep retries the line', async () => {
    await mockConn('products_catalog').where({ id: taurus.id }).update({ inventory_unit: 'each' }); // fl oz can't convert to each
    await expect(processReceiptLine(line())).rejects.toThrow(/Cannot convert/);
    expect(await savedLine()).toBeUndefined();
    await mockConn('products_catalog').where({ id: taurus.id }).update({ inventory_unit: 'fl_oz' });
    expect(await processReceiptLine(line())).toMatchObject({ status: 'logged' });
  });
  // A pest visit that took a product below zero left one open office alert for it
  // (complete-scheduled-service.js); a movement that brings the count back to zero or above closes it, and the next
  // shortfall then rings a fresh row (dedupeOpenOnly skips the closed one).
  describe('a count back to zero or above closes the pest stock shortfall alert', () => {
    const { adjustStock, stockShortfallKey } = require('../services/inventory-operations');
    const openAlert = () => notifications.notifyAdmin('inventory', 'Inventory — restock Taurus SC', 'Taurus SC went below zero in stock after a pest visit.', {
      bell: true, dedupeKey: stockShortfallKey(taurus.id), dedupeOpenOnly: true,
    });
    const alertRows = () => mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [stockShortfallKey(taurus.id)]).orderBy('created_at', 'asc');

    test('a restock to zero or above closes it, and the next shortfall rings a fresh row', async () => {
      await mockConn('products_catalog').where({ id: taurus.id }).update({ inventory_on_hand: -6 });
      await openAlert();
      await adjustStock(taurus.id, { movementType: 'restock', quantity: 78, unit: 'fl_oz' }, { source: 'test' });
      expect(await stock()).toBe(72);
      const [closed] = await alertRows();
      expect(closed.done_at).not.toBeNull();
      expect(closed.metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'stock_restocked' });
      await openAlert();
      const rows = await alertRows();
      expect(rows).toHaveLength(2);
      expect(rows[1].done_at).toBeNull();
    });

    test('a count to zero closes it too', async () => {
      await mockConn('products_catalog').where({ id: taurus.id }).update({ inventory_on_hand: -6 });
      await openAlert();
      await adjustStock(taurus.id, { movementType: 'correction', setTotal: 0, unit: 'fl_oz' }, { source: 'test' });
      expect(await stock()).toBe(0);
      expect((await alertRows())[0].done_at).not.toBeNull();
    });

    test('a restock that leaves the count below zero keeps it open', async () => {
      await mockConn('products_catalog').where({ id: taurus.id }).update({ inventory_on_hand: -100 });
      await openAlert();
      await adjustStock(taurus.id, { movementType: 'restock', quantity: 78, unit: 'fl_oz' }, { source: 'test' });
      expect(await stock()).toBe(-22);
      expect((await alertRows())[0].done_at).toBeNull();
    });
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
      expect(bell.detail || bell.body).toBe("Amazon shipped Taurus SC ×2 on September 26 but never sent a delivery confirmation, so it wasn't added. If it arrived, log it by hand.");
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

    // Amazon's Shipped and Delivered emails for one package can carry
    // different shipment ids (Gentrol, October 2026). With exactly ONE
    // authenticated Shipped email for the order, the authenticated Delivered
    // lines under other ids settle its items; a split order never does.
    describe('a Delivered email under another shipment id', () => {
      const ORDER = '900-1000001-1000001';
      const LINK = 'https://www.amazon.com/x?shipmentId=';
      // A Delivered email row (authenticated unless overridden) and one line it produced.
      const delivered = async (quantity, { lineNo = 1, auth = ALIGNED_AMAZON_AUTH, orderNumber = ORDER, title = TITLE, ...rest } = {}) => {
        const [email] = await mockConn('emails').insert({
          gmail_id: `gm-${randomUUID()}`, gmail_thread_id: 'thread', from_address: 'order-update@amazon.com', subject: 'Delivered: "Control Solutions Taurus..."',
          authentication_results: auth, body_text: `Order # ${orderNumber}\n${LINK}delivered-key\n\n* ${title}\n  Quantity: ${quantity}\n`, received_at: new Date(NOW - 5 * DAY),
        }).returning('*');
        return processReceiptLine(line({ email, orderNumber, shipmentKey: 'delivered-key', item: { title, quantity }, lineNo, ...rest }));
      };
      const shippedItems = (shipmentId, quantity, overrides = {}) => shipped(shipmentId, {
        body_text: `Order #\n${ORDER}\nTrack package: ${LINK}${shipmentId}\n\n* ${TITLE}\n  Quantity: ${quantity}\n\n* Lenovo Chromebook\n  Quantity: 1\n`,
        ...overrides,
      });
      const bellBody = async (shipmentId) => {
        const [bell] = await alertBells(shipmentId);
        return bell.detail || bell.body;
      };
      const alerted = async () => (await run()).undelivered.map((row) => row.shipmentId);

      test('the same order and item, delivered and logged under another id: no bell and no held line', async () => {
        await delivered(2);
        await shippedItems('shipped-key', 2);
        expect(await alerted()).toEqual([]);
        expect(await alertBells('shipped-key')).toHaveLength(0);
        expect(await mockConn('purchase_receipt_lines').where({ shipment_key: 'shipped-key' })).toEqual([]);
      });

      test('an item the Delivered email ruled equipment counts as handled', async () => {
        await delivered(2, { forcedStatus: 'agent_equipment' });
        await shippedItems('shipped-key', 2);
        expect(await alerted()).toEqual([]);
      });

      test('a genuinely undelivered shipment still rings, even with Delivered lines for another order or item', async () => {
        await delivered(2, { orderNumber: '900-2000002-2000002' });
        await delivered(1, { lineNo: 2, title: 'Zoecon Gentrol IGR' });
        await shippedItems('shipped-key', 2);
        expect(await alerted()).toEqual(['shipped-key']);
        expect(await alertBells('shipped-key')).toHaveLength(1);
      });

      test('a partial delivery (2 shipped, 1 delivered) still rings for the rest', async () => {
        await delivered(1);
        await shippedItems('shipped-key', 2);
        expect(await alerted()).toEqual(['shipped-key']);
        expect(await bellBody('shipped-key')).toContain('Taurus SC ×1 on');
      });

      test('a split order (two Shipped emails) rings both as before, even with a third-id delivery', async () => {
        await shippedItems('ship-a', 1, { received_at: new Date(NOW - 5 * DAY) });
        await shippedItems('ship-b', 1, { received_at: new Date(NOW - 4 * DAY) });
        await delivered(1);
        expect(await alerted()).toEqual(['ship-a', 'ship-b']);
      });

      test('two shipped lines of one product and one delivered unit: the second line still rings for ×1', async () => {
        await delivered(1);
        await shipped('shipped-key', {
          body_text: `Order #\n${ORDER}\nTrack package: ${LINK}shipped-key\n\n* ${TITLE}\n  Quantity: 1\n\n* ${TITLE}\n  Quantity: 1\n`,
        });
        expect(await alerted()).toEqual(['shipped-key']);
        expect(await mockConn('purchase_receipt_lines').where({ shipment_key: 'shipped-key', status: 'no_delivery_email' })).toHaveLength(1);
        expect(await bellBody('shipped-key')).toContain('Taurus SC ×1 on');
      });

      test('two shipped lines of one product and one delivered unit: a full sweep (alert, then closer) keeps the bell open; a second unit closes it', async () => {
        await delivered(1);
        await shipped('shipped-key', {
          body_text: `Order #\n${ORDER}\nTrack package: ${LINK}shipped-key\n\n* ${TITLE}\n  Quantity: 1\n\n* ${TITLE}\n  Quantity: 1\n`,
        });
        expect(await alerted()).toEqual(['shipped-key']);
        expect(await closeDeliveredUndeliveredBells()).toBe(0);
        expect((await alertBells('shipped-key'))[0].done_at).toBeNull();
        await delivered(1, { lineNo: 2 });
        expect(await closeDeliveredUndeliveredBells()).toBe(1);
        expect((await alertBells('shipped-key'))[0].done_at).not.toBeNull();
      });

      test('a delivered single bottle does not cover a shipped multipack of the same product', async () => {
        await delivered(1);
        await shipped('shipped-key', {
          body_text: `Order #\n${ORDER}\nTrack package: ${LINK}shipped-key\n\n* ${TITLE}, 2 Pack\n  Quantity: 1\n`,
        });
        expect(await alerted()).toEqual(['shipped-key']);
        expect(await mockConn('purchase_receipt_lines').where({ shipment_key: 'shipped-key', status: 'no_delivery_email', product_id: taurus.id })).toHaveLength(1);
        expect(await closeDeliveredUndeliveredBells()).toBe(0);
      });

      test('an unauthenticated Delivered email proves nothing', async () => {
        await delivered(2, { auth: 'dkim=pass header.i=@evil.example; spf=fail' });
        await shippedItems('shipped-key', 2);
        expect(await alerted()).toEqual(['shipped-key']);
      });

      test('an unauthenticated Shipped email for the order is ignored, not counted as a second shipment', async () => {
        await delivered(2);
        await shippedItems('shipped-key', 2);
        await shippedItems('spoofed-key', 2, { authentication_results: 'dkim=pass header.i=@evil.example; spf=fail' });
        expect(await alerted()).toEqual([]);
      });

      test('the closer uses the same proof: a partial delivery keeps the bell, the full one closes it', async () => {
        await shippedItems('shipped-key', 2);
        await run();
        await closeDeliveredUndeliveredBells();
        expect((await alertBells('shipped-key'))[0].done_at).toBeNull(); // nothing delivered yet
        await delivered(1);
        expect(await closeDeliveredUndeliveredBells()).toBe(0); // 1 of 2
        await delivered(1, { lineNo: 2 });
        expect(await closeDeliveredUndeliveredBells()).toBe(1);
        expect((await alertBells('shipped-key'))[0]).toMatchObject({
          done_by: 'purchase-receipts', resolution: 'The delivery email arrived under another shipment id; the items are accounted for',
        });
      });

      test('the closer leaves a split order\'s bells open, whatever was delivered', async () => {
        await shippedItems('ship-a', 1, { received_at: new Date(NOW - 5 * DAY) });
        await shippedItems('ship-b', 1, { received_at: new Date(NOW - 4 * DAY) });
        await run();
        await delivered(2);
        expect(await closeDeliveredUndeliveredBells()).toBe(0);
        expect((await alertBells('ship-a'))[0].done_at).toBeNull();
        expect((await alertBells('ship-b'))[0].done_at).toBeNull();
      });
    });

    test('a promised arrival day is waited out, plus the day after: "Arriving Wednesday" from Sun Sep 13 rings Fri Sep 18', async () => {
      const shippedSunday = new Date('2026-09-13T17:12:00Z'); // 1:12 PM ET
      await shipped('ship-6', { received_at: shippedSunday, body_text: `Arriving Wednesday\nOrder #\n900-1000001-1000001\nhttps://www.amazon.com/x?shipmentId=ship-6\n\n* ${TITLE}\n  Quantity: 1\n` });
      expect((await run(new Date('2026-09-17T16:00:00Z').getTime())).undelivered).toEqual([]); // Thursday noon ET
      expect((await run(new Date('2026-09-18T05:00:00Z').getTime())).undelivered).toHaveLength(1); // Friday 1 AM ET
      const [bell] = await alertBells('ship-6');
      expect(bell.detail || bell.body).toBe("Amazon shipped Taurus SC ×1 on September 13 (due September 16) but never sent a delivery confirmation, so it wasn't added. If it arrived, log it by hand.");
    });

    test('around the physical count: flagged by when it was due, and any Delivered email settles it', async () => {
      const since = new Date(NOW - 5 * DAY); // the count
      const beforeCount = new Date(since.getTime() - DAY); // shipped the day before it
      const dueAfterCount = new Date(beforeCount.getTime() + 3 * DAY).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
      const body = (shipmentId, arriving) => `Arriving ${arriving}\nOrder #\n900-1000001-1000001\nhttps://www.amazon.com/x?shipmentId=${shipmentId}\n\n* ${TITLE}\n  Quantity: 1\n`;
      await shipped('ship-due-after', { received_at: beforeCount, body_text: body('ship-due-after', dueAfterCount) }); // not in the count: flagged
      await shipped('ship-due-before', { received_at: beforeCount, body_text: body('ship-due-before', 'today') }); // due before the count: in it
      await shipped('ship-delivered', { received_at: beforeCount, body_text: body('ship-delivered', dueAfterCount) });
      await deliveredEmail({ body_text: 'Order #\n900-1000001-1000001\nhttps://www.amazon.com/x?shipmentId=ship-delivered\n', received_at: new Date(since.getTime() - HOUR) });
      const { undelivered } = await alertUndeliveredShipments({ since, now: NOW, notifyAdmin: (...args) => notifications.notifyAdmin(...args) });
      expect(undelivered.map((row) => row.shipmentId)).toEqual(['ship-due-after']);
    });

    // A Delivered email settles a shipment only when it really came from
    // Amazon and names exactly that shipment.
    const deliveredEmail = (overrides) => mockConn('emails').insert({
      gmail_id: `gm-${randomUUID()}`, gmail_thread_id: 'thread', from_address: 'order-update@amazon.com', subject: 'Delivered: "Control Solutions Taurus..."',
      authentication_results: ALIGNED_AMAZON_AUTH, received_at: new Date(NOW - 5 * DAY), ...overrides,
    });
    test.each([
      ['an HTML-only Delivered email with a plain link settles it', 'ship-html', { body_text: '', body_html: '<p>Order # 900-1000001-1000001</p><a href="https://www.amazon.com/x?orderId=1&amp;shipmentId=ship-html">Track</a>' }, false],
      ['a spoofed Delivered email does not', 'ship-spoofed', { authentication_results: 'dkim=pass header.i=@evil.example', body_text: 'Order # 900-1\nhttps://www.amazon.com/x?shipmentId=ship-spoofed\n' }, true],
      ['one naming a longer shipment id does not', 'ship-prefix', { body_text: 'Order # 900-1\nhttps://www.amazon.com/x?shipmentId=ship-prefix1\n' }, true],
    ])('%s', async (_label, shipmentId, delivered, alerts) => {
      await shipped(shipmentId);
      await deliveredEmail(delivered);
      expect((await run()).undelivered.map((row) => row.shipmentId)).toEqual(alerts ? [shipmentId] : []);
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
      // A plain logged line is information only: it writes no notification.
      expect(await mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`purchase-receipt:${rows[0].id}`])).toEqual([]);

      await billingCopy(lines, 390.54);
      await runPurchaseReceiptRestockSweep({ notify });
      expect(await stock()).toBe(78);
      expect(await mockConn('purchase_receipt_lines').where({ vendor: 'siteone' })).toHaveLength(2);
    });

    test('an invoice handed off as unreadable never auto-logs its lines when they are read later', async () => {
      const [email] = await mockConn('emails').insert({
        gmail_id: `gm-${randomUUID()}`, gmail_thread_id: 'thread', from_address: 'AB00000@siteone.com',
        subject: `SiteOne Confirmation : Invoice #${INVOICE}`, authentication_results: 'dkim=pass header.i=@siteone.com',
        received_at: new Date(Date.now() - 3 * HOUR),
      }).returning('*');
      await runPurchaseReceiptRestockSweep({ notify }); // no extraction after 2 hours: one unreadable placeholder
      expect(await mockConn('purchase_receipt_lines').where({ vendor: 'siteone' })).toEqual([expect.objectContaining({ status: 'unreadable', line_no: 1 })]);
      await mockConn('email_attachments').insert({
        email_id: email.id, filename: 'invoice.pdf', mime_type: 'application/pdf', is_invoice: true,
        extracted_data: JSON.stringify({ invoice_number: INVOICE, subtotal: 190, tax: 13.3, total: 203.3, line_items: [
          { description: SPRAYER_LINE, quantity: 1, unit_price: 95, total: 95 },
          { description: TAURUS_LINE, quantity: 1, unit_price: 95, total: 95 },
        ] }),
      });
      await runPurchaseReceiptRestockSweep({ notify });
      expect(await stock()).toBe(0);
      expect(await mockConn('purchase_receipt_lines').where({ vendor: 'siteone' })).toHaveLength(1);
    });

    test.each([
      ['an authenticated store copy before it means the billing copy adds nothing', 'dkim=pass header.i=@siteone.com', 0],
      ['an unauthenticated "copy" before it proves nothing: the billing copy logs', 'dkim=pass header.i=@evil.example', 78],
    ])('copies straddling the cutoff: %s', async (_label, earlyAuth, expectedStock) => {
      const lines = [{ description: TAURUS_LINE, quantity: 1, unit_price: 95, total: 95 }];
      const since = new Date(process.env.PURCHASE_RECEIPT_SINCE);
      await mockConn('emails').insert({
        gmail_id: `gm-${randomUUID()}`, gmail_thread_id: 'thread', from_address: 'AB00000@siteone.com',
        subject: `SiteOne Confirmation : Invoice #${INVOICE}`, authentication_results: earlyAuth,
        received_at: new Date(since.getTime() - 5 * HOUR),
      });
      await billingCopy(lines, 101.65);
      await runPurchaseReceiptRestockSweep({ notify });
      expect(await stock()).toBe(expectedStock);
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

  // siteone-request-close.js: a logged SiteOne line closes the one request the
  // robot itself placed from SiteOne, when the invoice's PO is that order's own PO,
  // with no second stock movement.
  describe('a SiteOne invoice closes the robot\'s own restock request', () => {
    const poNumberFor = (ledger) => require('../services/procurement/order-dispatch')._internals.poNumberFor(ledger);
    const siteone = (overrides = {}) => line({ vendor: 'siteone', orderNumber: '900000009-001', shipmentKey: '900000009-001', ...overrides });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // An 'ordered' request the robot raised, with its placed SiteOne ledger row (placed 2 h before the email,
    // 78 fl oz dispatched) and its bell. po is the PO the Mac adapter typed for that ledger row.
    async function robotOrder({ request = {}, order = {}, withOrder = true } = {}) {
      const [req] = await mockConn('product_restock_requests').insert({
        product_id: taurus.id, status: 'ordered', source: 'auto_reorder', requested_quantity: 78, unit: 'fl_oz', ...request,
      }).returning('*');
      if (!withOrder) return { req, po: 'WAVES-NOORDER' };
      const [vo] = await mockConn('vendor_orders').insert({
        restock_request_id: req.id, adapter: 'siteone', status: 'placed', external_order_number: 'SO-SYNTH-1',
        placed_at: new Date(RECEIVED_AT.getTime() - 2 * HOUR), request_payload: JSON.stringify({ orderedQuantity: 78 }),
        evidence: JSON.stringify({ bell: { title: 'Synthetic bell' }, bellAt: RECEIVED_AT.toISOString() }), ...order,
      }).returning('*');
      const [bell] = await mockConn('notifications').insert({
        recipient_type: 'admin', category: 'procurement', title: 'Synthetic auto-order bell', metadata: JSON.stringify({ dedupeKey: `auto-order:${vo.id}` }),
      }).returning('*');
      return { req, vo, bell, po: poNumberFor(vo) };
    }
    const requestRow = (id) => mockConn('product_restock_requests').where({ id }).first();
    const movements = () => mockConn('product_inventory_movements').where({ product_id: taurus.id });
    const liveAutoOrder = () => require('../services/procurement/order-dispatch').findLiveAutoOrder(mockConn, taurus.id);

    test('closes the one placed request without a second movement and settles its ledger bell like a manual receive', async () => {
      const { req, vo, bell, po } = await robotOrder();
      const outcome = await processReceiptLine(siteone({ purchaseOrder: po }));
      expect(outcome).toMatchObject({ status: 'logged', receivedQty: 156, hasOpenRestockRequest: false, closedRestockRequestId: req.id });
      expect(await stock()).toBe(156);
      expect(await movements()).toHaveLength(1);
      const closed = await requestRow(req.id);
      expect(closed).toMatchObject({ status: 'received', closed_by: null });
      expect(closed.closed_at).not.toBeNull();
      expect(closed.metadata.closedByReceipt).toMatchObject({ orderNumber: '900000009-001', lineNo: 1, movementId: outcome.movement.id, purchaseOrder: po });
      expect((await mockConn('notifications').where({ id: bell.id }).first()).done_at).not.toBeNull();
      const ledger = await mockConn('vendor_orders').where({ id: vo.id }).first();
      expect(ledger.evidence).not.toHaveProperty('bell');
      expect(ledger.evidence).not.toHaveProperty('bellAt');
      // A received request no longer counts as a live automatic order.
      expect(await liveAutoOrder()).toBeFalsy();
    });

    test('the PO matches however the extraction cased or padded it', async () => {
      const { req, po } = await robotOrder();
      await processReceiptLine(siteone({ purchaseOrder: ` ${po.toLowerCase()} ` }));
      expect((await requestRow(req.id)).status).toBe('received');
    });

    test('a line bigger than the order closes it too', async () => {
      const { req, po } = await robotOrder();
      await processReceiptLine(siteone({ purchaseOrder: po, item: { title: TITLE, quantity: 3 } }));
      expect((await requestRow(req.id)).status).toBe('received');
    });

    test('processing the same line again changes nothing', async () => {
      const { req, po } = await robotOrder();
      await processReceiptLine(siteone({ purchaseOrder: po }));
      const before = await requestRow(req.id);
      expect(await processReceiptLine(siteone({ purchaseOrder: po }))).toEqual({ skipped: true, reason: 'already_processed' });
      expect(await movements()).toHaveLength(1);
      expect(await requestRow(req.id)).toEqual(before);
    });

    // The P0: an unrelated invoice of the same product (a counter purchase) must not clear the guard on an order still out.
    test.each([
      ['no PO printed', () => null],
      ['a blank PO', () => '  '],
      ['another order\'s PO', () => 'WAVES-ZZZZ9999'],
      ['the PO with extra text', (po) => `${po}-2`],
    ])('an unrelated invoice of the same product (%s) leaves the request and its live-order guard in place', async (_label, printed) => {
      const { req, po } = await robotOrder();
      const outcome = await processReceiptLine(siteone({ purchaseOrder: printed(po) }));
      expect(outcome).toMatchObject({ status: 'logged', hasOpenRestockRequest: true });
      expect(outcome.closedRestockRequestId).toBeUndefined();
      expect((await requestRow(req.id)).status).toBe('ordered');
      expect(await liveAutoOrder()).toBeTruthy();
    });

    test.each([
      ['an open request (not yet ordered)', { request: { status: 'open' } }],
      ['a request the robot did not raise', { request: { source: 'manual' } }],
      ['a request with no ledger row', { withOrder: false }],
      ['a ledger row that never placed', { order: { status: 'needs_review', placed_at: null } }],
      ['a ledger row of another vendor', { order: { adapter: 'stickermule' } }],
      ['a revoked order', { order: { evidence: JSON.stringify({ revokedAt: RECEIVED_AT.toISOString() }) } }],
      ['an order placed after the email arrived', { order: { placed_at: new Date(RECEIVED_AT.getTime() + HOUR) } }],
      ['a line short of the ordered quantity', { order: { request_payload: JSON.stringify({ orderedQuantity: 200 }) } }],
      ['a ledger that recorded no dispatched quantity (no fallback to requested_quantity)', { order: { request_payload: JSON.stringify({}) } }],
    ])('leaves %s alone', async (_label, setup) => {
      const { req, po } = await robotOrder(setup);
      const outcome = await processReceiptLine(siteone({ purchaseOrder: po }));
      expect(outcome).toMatchObject({ status: 'logged', hasOpenRestockRequest: true });
      expect(outcome.closedRestockRequestId).toBeUndefined();
      expect(await stock()).toBe(156);
      expect((await requestRow(req.id)).status).toBe(setup.request?.status || 'ordered');
      expect((await requestRow(req.id)).metadata).not.toHaveProperty('closedByReceipt');
    });

    test('two live requests: nothing closes', async () => {
      const { req, po } = await robotOrder();
      const [hand] = await mockConn('product_restock_requests').insert({ product_id: taurus.id, status: 'open', source: 'manual', requested_quantity: 78 }).returning('*');
      const outcome = await processReceiptLine(siteone({ purchaseOrder: po }));
      expect(outcome).toMatchObject({ status: 'logged', hasOpenRestockRequest: true });
      expect((await requestRow(req.id)).status).toBe('ordered');
      expect((await requestRow(hand.id)).status).toBe('open');
    });

    test('an Amazon delivery never closes a request', async () => {
      const { req, po } = await robotOrder();
      await processReceiptLine(line({ purchaseOrder: po }));
      expect((await requestRow(req.id)).status).toBe('ordered');
    });

    test('a request another transaction holds rolls the whole line back (no stock, no claim) and the next sweep closes it', async () => {
      const { req, po } = await robotOrder();
      let release;
      let locked;
      const held = new Promise((resolve) => { release = resolve; });
      const holder = mockConn.transaction(async (trx) => {
        await trx('vendor_orders').where({ restock_request_id: req.id }).forUpdate().first('id');
        await trx('product_restock_requests').where({ id: req.id }).forUpdate().first('id');
        locked();
        await held;
      });
      await new Promise((resolve) => { locked = resolve; });
      const failure = await processReceiptLine(siteone({ purchaseOrder: po })).then(() => null, (err) => err);
      release();
      await holder;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(/held by another action/);
      expect(await stock()).toBe(0);
      expect(await movements()).toHaveLength(0);
      expect(await mockConn('purchase_receipt_lines').where({ vendor: 'siteone' })).toHaveLength(0);
      expect((await requestRow(req.id)).status).toBe('ordered');

      expect(await processReceiptLine(siteone({ purchaseOrder: po }))).toMatchObject({ status: 'logged', closedRestockRequestId: req.id });
      expect(await stock()).toBe(156);
    });

    // The real race: the invoice line holds the product row while a manual receive (which already holds the
    // request) waits for it. Committing the invoice's stock would let the manual receive add the same
    // delivery again.
    test('a manual receive racing the invoice line adds the delivery once', async () => {
      const inventory = require('../services/inventory-operations');
      const { req, po } = await robotOrder();
      // A session queued behind the holder (L, first in line), then the manual receive, which already holds
      // the request and waits for the product row it locks last (queued behind L, so not blocked by the holder).
      const waiting = async (queryLike) => Number((await mockConn.raw(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ?", [queryLike])).rows[0].n);
      const waitFor = async (queryLike) => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (await waiting(queryLike) >= 1) return;
          await sleep(25);
        }
        throw new Error(`timed out waiting for a session on ${queryLike}`);
      };
      let release;
      let ready;
      const held = new Promise((resolve) => { release = resolve; });
      const holder = mockConn.transaction(async (trx) => {
        await trx('products_catalog').where({ id: taurus.id }).forUpdate().first('id');
        ready();
        await held;
      });
      await new Promise((resolve) => { ready = resolve; });

      const invoiceLine = processReceiptLine(siteone({ purchaseOrder: po })).then((outcome) => outcome, (err) => err);
      await waitFor('select "id" from "products_catalog"%for update%');
      const manual = inventory.updateRestockRequest(req.id, { action: 'receive' }, { actorId: null });
      await waitFor('%row_version%from "products_catalog"%');
      release();
      await holder;
      const [lineResult, manualResult] = await Promise.all([invoiceLine, manual]);

      expect(manualResult).toMatchObject({ success: true });
      expect(lineResult).toBeInstanceOf(Error);
      expect(await stock()).toBe(78);
      expect(await movements()).toHaveLength(1);

      // The next sweep's retry sees the manual receive's committed movement and holds the line.
      expect(await processReceiptLine(siteone({ purchaseOrder: po }))).toMatchObject({ status: 'possible_duplicate' });
      expect(await stock()).toBe(78);
      expect((await requestRow(req.id)).status).toBe('received');
    });
  });

  describe('logged-delivery bells close themselves', () => {
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

    const NOTE = 'A restock request for Taurus SC is still open. If this delivery covers it, cancel that request in the Intelligence Bar; marking it received would add the stock again.';
    // The shape the earlier sweep wrote: the long body cut to 110 characters, the whole text in detail.
    const legacyLogged = (metadata, note = '') => mockConn('notifications').insert({
      recipient_type: 'admin', category: 'inventory', title: 'Amazon delivery logged',
      body: 'Amazon delivery logged: Taurus SC +156 fl oz (2 × 78 fl oz)', detail: `Amazon delivery logged: Taurus SC +156 fl oz (2 × 78 fl oz)${note && ` ${note}`}`,
      metadata: JSON.stringify({ dedupeKey: `purchase-receipt:${randomUUID()}`, emailId: 'e1', productId: taurus.id, receivedQty: 156, receivedUnit: 'fl_oz', ...metadata }),
    }).returning('*').then(([row]) => row);
    const sweep = () => runPurchaseReceiptRestockSweep({ notify: (...args) => notifications.notifyAdmin(...args) });
    const reload = (row) => mockConn('notifications').where({ id: row.id }).first();

    test('a plain logged row closes; a warned row stays while its product has a live request and closes once it is gone', async () => {
      const plain = await legacyLogged();
      const warnedLive = await legacyLogged({}, NOTE);
      const warnedGone = await legacyLogged({ productId: randomUUID() }, NOTE);
      const alertLive = await legacyLogged({ doneWhen: 'restock_request_closed' });
      const [request] = await mockConn('product_restock_requests').insert({ product_id: taurus.id, status: 'ordered', requested_quantity: 78 }).returning('*');

      await sweep();
      expect(await reload(plain)).toMatchObject({ done_by: 'purchase-receipts', resolution: 'Stock added automatically; nothing to do' });
      expect((await reload(plain)).done_at).not.toBeNull();
      expect((await reload(warnedLive)).done_at).toBeNull();
      expect((await reload(alertLive)).done_at).toBeNull();
      expect(await reload(warnedGone)).toMatchObject({ done_by: 'purchase-receipts', resolution: 'The restock request is closed' });

      await mockConn('product_restock_requests').where({ id: request.id }).update({ status: 'cancelled' });
      await sweep();
      expect(await reload(warnedLive)).toMatchObject({ done_by: 'purchase-receipts', resolution: 'The restock request is closed' });
      expect(await reload(alertLive)).toMatchObject({ done_by: 'purchase-receipts', resolution: 'The restock request is closed' });
    });

    test('held-line rows, the inventory agent\'s rows and rows already done are left alone', async () => {
      const held = await legacyLogged({ receivedQty: undefined, productId: taurus.id, status: 'size_mismatch' });
      const agent = await legacyLogged({ receivedQty: undefined, status: 'logged' });
      const person = await legacyLogged();
      await mockConn('notifications').where({ id: person.id }).update({ done_at: new Date('2026-10-20T12:00:00Z'), done_by: '42', resolution: 'Checked by hand' });

      await sweep();
      expect((await reload(held)).done_at).toBeNull();
      expect((await reload(agent)).done_at).toBeNull();
      expect(await reload(person)).toMatchObject({ done_by: '42', resolution: 'Checked by hand' });
    });

    test('a delivery that a live restock request may cover raises one needs-you alert, which the next sweep leaves open', async () => {
      await mockConn('product_restock_requests').insert({ product_id: taurus.id, status: 'open', requested_quantity: 78 });
      const email = {
        id: randomUUID(), from_address: 'order-update@amazon.com', subject: 'Delivered: 2 "Taurus SC..."', received_at: new Date(),
        body_text: `Order # 900-1000001-1000001\n\n* ${TITLE} Quantity: 2\n`, authentication_results: ALIGNED_AMAZON_AUTH,
      };
      const result = await processReceiptEmail(email, { notify: (...args) => notifications.notifyAdmin(...args) });
      expect(result.logged).toHaveLength(1);
      const [row] = await mockConn('notifications').whereRaw("metadata->>'dedupeKey' LIKE ?", ['purchase-receipt:%']);
      expect(row).toMatchObject({ title: 'Inventory — check the restock request for Taurus SC', body: 'Amazon delivery added Taurus SC; an open restock request may cover it.', done_at: null });
      expect(row.detail).toContain('cancel that request in the Intelligence Bar');
      expect(row.metadata).toMatchObject({ doneWhen: 'restock_request_closed', productId: taurus.id, receivedQty: 156 });

      await sweep();
      expect((await reload(row)).done_at).toBeNull();
    });
  });
});
