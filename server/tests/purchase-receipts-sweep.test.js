/**
 * purchase-receipts/sweep.js — the two gates (GATE_PURCHASE_RECEIPT_RESTOCK
 * + a strict PURCHASE_RECEIPT_SINCE), sender authentication (P0: from/subject
 * are spoofable — only an aligned SPF/DKIM pass earns any processing), the
 * per-email hook path, the bells, and the ~15-min sweep's aggregation.
 *
 * receipt-processor's own matching/sizing/idempotency logic is covered in
 * purchase-receipts-processor.test.js — here it is mocked so this suite
 * tests only sweep.js's own orchestration. hasAlignedAuth/domainFromAddress
 * and gateEnvTimestamp are the REAL functions.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockState = { outcomes: [], emails: [], whereCalls: [], siteOneEmails: [], siteOneInvoice: null, otherCopy: undefined };
// Like the real processor, a recorded outcome's bell is rung through the
// ringBell callback on the line's transaction ('trx-stub' here).
jest.mock('../services/purchase-receipts/receipt-processor', () => ({
  processReceiptLine: jest.fn(async (params) => {
    const outcome = mockState.outcomes.shift();
    if (outcome?.status) await params.ringBell(outcome, 'trx-stub');
    return outcome;
  }),
}));
// Which emails are invoices and what their PDFs say are covered in
// purchase-receipts-siteone.test.js; here only what the sweep records.
jest.mock('../services/purchase-receipts/siteone-invoices', () => ({
  ...jest.requireActual('../services/purchase-receipts/siteone-invoices'),
  findSiteOneInvoiceEmails: jest.fn(async () => mockState.siteOneEmails),
  readSiteOneInvoice: jest.fn(async () => mockState.siteOneInvoice),
}));
// Covered against Postgres in purchase-receipts-postgres.test.js; here only
// its place in the sweep.
jest.mock('../services/purchase-receipts/undelivered-shipments', () => ({
  alertUndeliveredShipments: jest.fn(async () => ({ undelivered: [], errors: [] })),
}));
jest.mock('../models/db', () => {
  // Only runPurchaseReceiptRestockSweep's own emails query touches db in
  // this file — processReceiptEmail takes an already-fetched row.
  const q = {};
  for (const m of ['whereRaw', 'orderBy', 'select', 'whereNot']) q[m] = () => q;
  q.where = (...args) => { mockState.whereCalls.push(args); return q; };
  q.first = async () => mockState.otherCopy; // another copy of a SiteOne invoice already recorded
  q.then = (resolve, reject) => Promise.resolve(mockState.emails).then(resolve, reject);
  return jest.fn(() => q);
});

const { processReceiptEmail, runPurchaseReceiptRestockSweep } = require('../services/purchase-receipts/sweep');
const { processReceiptLine } = require('../services/purchase-receipts/receipt-processor');
const { alertUndeliveredShipments } = require('../services/purchase-receipts/undelivered-shipments');
const logger = require('../services/logger');

// The shape a genuine Amazon delivery email carries (every
// order-update@amazon.com email since 2026-08-05 has an aligned DKIM pass).
const ALIGNED_AMAZON_AUTH = 'dkim=pass header.i=@amazon.com; spf=pass smtp.mailfrom=amazon.com';

const deliveredEmail = {
  id: 'e1', from_address: 'order-update@amazon.com', subject: 'Delivered: 2 "Taurus SC..."',
  body_text: 'Order # 900-1000001-1000001\n\n* Taurus SC Termiticide 78 oz Quantity: 2\n* Chromebook Quantity: 1\n',
  received_at: new Date('2026-09-27T15:00:00Z'), authentication_results: ALIGNED_AMAZON_AUTH,
};
const taurus = { id: 'p1', name: 'Taurus SC' };
const loggedTaurus = (extra = {}) => ({ status: 'logged', product: taurus, receivedQty: 156, receivedUnit: 'fl_oz', hasOpenRestockRequest: false, lineId: 'line-1', ...extra });
const unmatched = { status: 'unmatched', inserted: true, product: null, lineId: 'line-2' };

function openGates() {
  process.env.GATE_PURCHASE_RECEIPT_RESTOCK = 'true';
  process.env.PURCHASE_RECEIPT_SINCE = '2026-09-26T05:49:45Z';
}

beforeEach(() => {
  mockState.outcomes = [];
  mockState.emails = [];
  mockState.whereCalls = [];
  mockState.siteOneEmails = [];
  mockState.siteOneInvoice = null;
  mockState.otherCopy = undefined;
  processReceiptLine.mockClear();
  alertUndeliveredShipments.mockClear();
  logger.warn.mockClear();
  delete process.env.GATE_PURCHASE_RECEIPT_RESTOCK;
  delete process.env.PURCHASE_RECEIPT_SINCE;
});

describe('gating', () => {
  test('gate off -> skipped before anything else, for both entry points', async () => {
    process.env.PURCHASE_RECEIPT_SINCE = '2026-09-26T05:49:45Z';
    expect(await processReceiptEmail(deliveredEmail)).toEqual({ skipped: 'gated' });
    expect(await runPurchaseReceiptRestockSweep()).toEqual({ skipped: 'gated' });
    expect(processReceiptLine).not.toHaveBeenCalled();
    expect(alertUndeliveredShipments).not.toHaveBeenCalled();
  });

  test.each([
    [undefined],
    ['2026-09-26T05:49:45'], // no offset: Railway would read it as UTC, hours off
    ['2026-09-26'], // bare date
    ['Sat Sep 26 2026 01:49:45 GMT-0400'], // locale string
    ['2026-02-30T05:49:45Z'], // impossible date
  ])('gate on but PURCHASE_RECEIPT_SINCE=%s is no cutoff at all -> skipped, nothing read or written', async (since) => {
    process.env.GATE_PURCHASE_RECEIPT_RESTOCK = 'true';
    if (since !== undefined) process.env.PURCHASE_RECEIPT_SINCE = since;
    expect(await processReceiptEmail(deliveredEmail)).toEqual({ skipped: 'no_since' });
    expect(await runPurchaseReceiptRestockSweep()).toEqual({ skipped: 'no_since' });
    expect(processReceiptLine).not.toHaveBeenCalled();
  });

  test('an explicit non-UTC offset is honored: 01:49:45-04:00 is the same instant as 05:49:45Z', async () => {
    process.env.GATE_PURCHASE_RECEIPT_RESTOCK = 'true';
    process.env.PURCHASE_RECEIPT_SINCE = '2026-09-26T01:49:45-04:00';
    const justBefore = { ...deliveredEmail, received_at: new Date('2026-09-26T05:49:44Z') };
    expect(await processReceiptEmail(justBefore)).toEqual({ skipped: 'before_since' });
  });

  test.each([
    [new Date('2026-09-01T00:00:00Z')],
    [null],
    ['not a date'],
  ])('an email received before PURCHASE_RECEIPT_SINCE (or with no readable time: %s) is skipped', async (receivedAt) => {
    openGates();
    expect(await processReceiptEmail({ ...deliveredEmail, received_at: receivedAt })).toEqual({ skipped: 'before_since' });
    expect(processReceiptLine).not.toHaveBeenCalled();
  });

  test('a non-delivery email from the same sender is skipped', async () => {
    openGates();
    expect(await processReceiptEmail({ ...deliveredEmail, subject: 'Shipped: your order' })).toEqual({ skipped: 'not_a_delivery_email' });
  });
});

describe('sender authentication (P0: from/subject are spoofable)', () => {
  beforeEach(openGates);

  test('no Authentication-Results at all -> refused, no processing, no DB write', async () => {
    expect(await processReceiptEmail({ ...deliveredEmail, authentication_results: null })).toEqual({ skipped: 'unauthenticated' });
    expect(processReceiptLine).not.toHaveBeenCalled();
  });

  test('DKIM passes but for a DIFFERENT domain -> refused (from_address claims amazon.com, auth says otherwise)', async () => {
    const spoofed = { ...deliveredEmail, authentication_results: 'dkim=pass header.i=@evil-spoofer.example; spf=fail' };
    expect(await processReceiptEmail(spoofed)).toEqual({ skipped: 'unauthenticated' });
    expect(processReceiptLine).not.toHaveBeenCalled();
  });

  test('an aligned DKIM pass for amazon.com is accepted and processing proceeds', async () => {
    mockState.outcomes = [loggedTaurus(), unmatched];
    const result = await processReceiptEmail(deliveredEmail, { notify: jest.fn(async () => ({})) });
    expect(result.skipped).toBeUndefined();
    expect(processReceiptLine).toHaveBeenCalledTimes(2);
  });
});

describe('processReceiptEmail', () => {
  beforeEach(openGates);

  test('a logged line rings one bell; an unmatched line rings none', async () => {
    mockState.outcomes = [loggedTaurus(), unmatched];
    const notify = jest.fn(async () => ({}));
    const result = await processReceiptEmail(deliveredEmail, { notify });

    expect(processReceiptLine.mock.calls[0][0]).toMatchObject({ orderNumber: '900-1000001-1000001', shipmentKey: 'e1', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 2 }, lineNo: 1 });
    expect(processReceiptLine.mock.calls[1][0]).toMatchObject({ shipmentKey: 'e1', item: { title: 'Chromebook', quantity: 1 }, lineNo: 2 });
    expect(result.logged).toEqual([{ title: 'Taurus SC Termiticide 78 oz', productId: 'p1', receivedQty: 156, receivedUnit: 'fl_oz' }]);
    expect(result.unmatched).toEqual([{ title: 'Chromebook', productId: null, receivedQty: null, receivedUnit: null }]);

    expect(notify).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = notify.mock.calls[0];
    expect(category).toBe('inventory');
    expect(title).toBe('Amazon delivery logged');
    expect(body).toBe('Amazon delivery logged: Taurus SC +156 fl oz (2 × 78 fl oz)');
    // Written on the line's own transaction, keyed by the recorded line.
    expect(opts).toMatchObject({ bell: true, link: '/admin/inventory?tab=products', dedupeKey: 'purchase-receipt:line-1', trx: 'trx-stub' });
  });

  test('a live restock request adds a read-only note to the logged bell', async () => {
    mockState.outcomes = [loggedTaurus({ hasOpenRestockRequest: true }), unmatched];
    const notify = jest.fn(async () => ({}));
    await processReceiptEmail(deliveredEmail, { notify });
    // Cancel, never receive: receiving the request would add the delivery a second time.
    expect(notify.mock.calls[0][2]).toContain('A restock request for Taurus SC is still open. If this delivery covers it, cancel that request in the Intelligence Bar; marking it received would add the stock again.');
  });

  test.each([
    ['possible_duplicate', 'possibleDuplicate', 'A manual restock or count was logged around the same time, so check the count.'],
    ['size_mismatch', 'sizeMismatch', "The listing's size or pack count doesn't match the catalog container size, so log it by hand."],
    ['needs_size', 'needsSize', 'The product has no container size in the catalog, so log it by hand.'],
    ['no_order_number', 'noOrderNumber', "The email's order number couldn't be read, so log it by hand."],
  ])('a %s line is held with one bell saying why', async (status, bucket, reason) => {
    mockState.outcomes = [{ status, product: taurus, inserted: true, lineId: 'line-9' }, unmatched];
    const notify = jest.fn(async () => ({}));
    const result = await processReceiptEmail(deliveredEmail, { notify });
    expect(result[bucket]).toEqual([{ title: 'Taurus SC Termiticide 78 oz', productId: 'p1', receivedQty: null, receivedUnit: null }]);
    expect(result.logged).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    const [, title, body, opts] = notify.mock.calls[0];
    expect(title).toBe('Amazon delivery not added');
    expect(body).toBe(`Amazon delivery: Taurus SC ×2 wasn't added. ${reason}`);
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'purchase-receipt:line-9', trx: 'trx-stub', metadata: { emailId: 'e1', productId: 'p1', status } });
  });

  test('a bell that can\'t be saved fails its line: recorded as an error, and (rolled back) retried next sweep', async () => {
    mockState.outcomes = [loggedTaurus(), unmatched];
    const result = await processReceiptEmail(deliveredEmail, { notify: jest.fn(async () => { throw new Error('admin notification insert failed'); }) });
    expect(result.logged).toEqual([]);
    expect(result.errors).toEqual([{ title: 'Taurus SC Termiticide 78 oz', message: 'admin notification insert failed' }]);
    expect(result.unmatched).toHaveLength(1); // the other line is unaffected
  });

  test('a per-item failure is recorded and does not stop the other items on the same email', async () => {
    processReceiptLine.mockImplementationOnce(async () => { throw new Error('inventory-operations boom'); });
    processReceiptLine.mockImplementationOnce(async () => unmatched);
    const result = await processReceiptEmail(deliveredEmail, { notify: jest.fn() });
    expect(result.errors).toEqual([{ title: 'Taurus SC Termiticide 78 oz', message: 'inventory-operations boom' }]);
    expect(result.unmatched).toHaveLength(1);
  });

  test('items with no readable Order # are passed down to be held (no_order_number), never logged', async () => {
    mockState.outcomes = [{ status: 'no_order_number', product: taurus, inserted: true, lineId: 'line-5' }];
    await processReceiptEmail({ ...deliveredEmail, body_text: '* Taurus SC Termiticide 78 oz\n  Quantity: 2\n' }, { notify: jest.fn(async () => ({})) });
    expect(processReceiptLine.mock.calls[0][0]).toMatchObject({ vendor: 'amazon', orderNumber: null, holdAs: 'no_order_number' });
  });

  test('an already-processed line lands in alreadyProcessed with no bell', async () => {
    mockState.outcomes = [{ skipped: true, reason: 'already_processed' }, unmatched];
    const notify = jest.fn(async () => ({}));
    const result = await processReceiptEmail(deliveredEmail, { notify });
    expect(result.alreadyProcessed).toEqual([{ title: 'Taurus SC Termiticide 78 oz', reason: 'already_processed' }]);
    expect(notify).not.toHaveBeenCalled();
  });

  test('an itemless Delivered email ("N Lawn & Garden item(s)") records one no_items line and rings a bell to check it', async () => {
    const itemless = {
      id: 'e4', from_address: 'order-update@amazon.com', subject: 'Delivered: 2 Lawn & Garden items',
      body_text: 'Order # 900-7000007-7000007\n\nTrack your package: https://www.amazon.com/x\n',
      received_at: new Date('2026-09-27T15:00:00Z'), authentication_results: ALIGNED_AMAZON_AUTH,
    };
    mockState.outcomes = [{ status: 'no_items', inserted: true, product: null, lineId: 'line-4' }];
    const notify = jest.fn(async () => ({}));
    const result = await processReceiptEmail(itemless, { notify });

    expect(processReceiptLine).toHaveBeenCalledTimes(1);
    expect(processReceiptLine.mock.calls[0][0]).toMatchObject({
      orderNumber: '900-7000007-7000007', item: { title: 'Delivered: 2 Lawn & Garden items', quantity: 1 }, lineNo: 1, forcedStatus: 'no_items',
    });
    expect(result.noItems).toEqual([{ title: 'Delivered: 2 Lawn & Garden items', productId: null, receivedQty: null, receivedUnit: null }]);
    expect(notify.mock.calls[0][2]).toBe('Amazon delivery "2 Lawn & Garden items" wasn\'t added. The email doesn\'t name the item. If it\'s stock, log it by hand.');
  });
});

describe('runPurchaseReceiptRestockSweep', () => {
  beforeEach(openGates);
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['an old cutoff is bounded to the last 7 days', '2026-09-01T00:00:00Z', '2026-09-20T12:00:00.000Z'],
    ['a recent cutoff is used as-is', '2026-09-26T05:49:45Z', '2026-09-26T05:49:45.000Z'],
  ])('%s', async (_label, since, floor) => {
    process.env.PURCHASE_RECEIPT_SINCE = since;
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-27T12:00:00Z').getTime());
    await runPurchaseReceiptRestockSweep({ notify: jest.fn() });
    const [column, op, value] = mockState.whereCalls.find(([col]) => col === 'received_at');
    expect([column, op, value.toISOString()]).toEqual(['received_at', '>=', floor]);
  });

  test('aggregates outcomes across every scanned email, tagged with the email id', async () => {
    mockState.emails = [deliveredEmail, { ...deliveredEmail, id: 'e2', body_text: 'Order # 900-8000008-8000008\n\n* Southern Ag Thuricide BT Concentrate\n' }];
    mockState.outcomes = [loggedTaurus(), unmatched, unmatched];
    const result = await runPurchaseReceiptRestockSweep({ notify: jest.fn(async () => ({})) });
    expect(result.emailsScanned).toBe(2);
    expect(result.logged).toEqual([{ title: 'Taurus SC Termiticide 78 oz', productId: 'p1', receivedQty: 156, receivedUnit: 'fl_oz', emailId: 'e1' }]);
    expect(result.unmatched.map((row) => row.emailId)).toEqual(['e1', 'e2']);
  });

  test('after the Delivered pass, runs the undelivered-shipment check and folds its results in', async () => {
    mockState.emails = [deliveredEmail];
    mockState.outcomes = [loggedTaurus(), unmatched];
    alertUndeliveredShipments.mockResolvedValueOnce({
      undelivered: [{ shipmentId: 'SHIPTEST02', emailId: 'e9' }], errors: [{ title: 'Shipped: x', message: 'boom', emailId: 'e8' }],
    });
    const result = await runPurchaseReceiptRestockSweep({ notify: jest.fn(async () => ({})) });
    expect(alertUndeliveredShipments).toHaveBeenCalledWith({ since: new Date('2026-09-26T05:49:45Z'), now: expect.any(Number), notifyAdmin: expect.any(Function) });
    // Delivered emails first, so a delivery whose email did come is settled before the check.
    expect(processReceiptLine.mock.invocationCallOrder[0]).toBeLessThan(alertUndeliveredShipments.mock.invocationCallOrder[0]);
    expect(result.undelivered).toEqual([{ shipmentId: 'SHIPTEST02', emailId: 'e9' }]);
    expect(result.errors).toEqual([{ title: 'Shipped: x', message: 'boom', emailId: 'e8' }]);
  });

  test('an unauthenticated candidate email in the same sweep is skipped and never touches processReceiptLine', async () => {
    mockState.emails = [{ ...deliveredEmail, authentication_results: null }];
    const result = await runPurchaseReceiptRestockSweep({ notify: jest.fn() });
    expect(result.emailsScanned).toBe(1);
    expect(processReceiptLine).not.toHaveBeenCalled();
    expect(result.logged).toEqual([]);
  });
});

describe('SiteOne invoices in the sweep', () => {
  beforeEach(openGates);
  const siteOneEmail = {
    id: 's1', from_address: 'AB00000@siteone.com', subject: 'SiteOne Confirmation : Invoice #900000001-001',
    received_at: new Date('2026-09-27T12:00:00Z'), authentication_results: 'dkim=pass header.i=@siteone.com; spf=pass smtp.mailfrom=siteone.com',
  };
  const lines = [
    { title: 'CSI-Pest Taurus SC Broad Spectrum Liquid Concentrate Termiticide/Insecticide 78 fl oz. Bottle (QGCY)', quantity: 1, lineNo: 1, uom: 'EA' },
    { title: 'Flowzone Cyclone 3 Variable Pressure 18V Battery Powered Sprayer (4-Gallon)', quantity: 0, lineNo: 2, uom: 'EA' },
    { title: 'LESCO 18V Variable Flow Zero Pump 4 gal. Battery Powered Backpack Sprayer', quantity: -1, lineNo: 3, uom: 'EA' },
  ];
  const run = () => runPurchaseReceiptRestockSweep({ notify: jest.fn(async () => ({})) });

  test('a reconciled invoice records its lines by invoice number: zero lines skipped, returns held', async () => {
    mockState.siteOneEmails = [siteOneEmail];
    mockState.siteOneInvoice = { number: '900000001-001', problem: null, lines };
    mockState.outcomes = [
      { status: 'logged', product: taurus, receivedQty: 78, receivedUnit: 'fl_oz', hasOpenRestockRequest: false, lineId: 'line-s1' },
      { status: 'unmatched', inserted: true, product: null, lineId: 'line-s3' },
    ];
    const notify = jest.fn(async () => ({}));
    const result = await runPurchaseReceiptRestockSweep({ notify });
    const calls = processReceiptLine.mock.calls.map(([params]) => params);
    expect(calls.map(({ vendor, orderNumber, shipmentKey, lineNo, holdAs }) => ({ vendor, orderNumber, shipmentKey, lineNo, holdAs }))).toEqual([
      { vendor: 'siteone', orderNumber: '900000001-001', shipmentKey: '900000001-001', lineNo: 1, holdAs: undefined },
      { vendor: 'siteone', orderNumber: '900000001-001', shipmentKey: '900000001-001', lineNo: 3, holdAs: 'returned' },
    ]);
    expect(notify.mock.calls[0].slice(1, 3)).toEqual(['SiteOne invoice logged', 'SiteOne invoice 900000001-001 logged: Taurus SC +78 fl oz (1 × 78 fl oz)']);
    expect(result.logged).toEqual([expect.objectContaining({ productId: 'p1', emailId: 's1' })]);
  });

  test('an invoice whose numbers don\'t reconcile holds every stocked line as unverified', async () => {
    mockState.siteOneEmails = [siteOneEmail];
    mockState.siteOneInvoice = { number: '900000001-001', problem: 'line_math', lines: [lines[0]] };
    mockState.outcomes = [{ status: 'unverified', product: taurus, inserted: true, lineId: 'line-s1' }];
    const notify = jest.fn(async () => ({}));
    await runPurchaseReceiptRestockSweep({ notify });
    expect(processReceiptLine.mock.calls[0][0]).toMatchObject({ holdAs: 'unverified' });
    expect(notify.mock.calls[0][2]).toBe("SiteOne invoice 900000001-001: Taurus SC ×1 wasn't added. The invoice line couldn't be checked (its numbers or unit of measure), so log it by hand.");
  });

  test.each([
    ['no unit of measure', null],
    ['sold by the case', 'CS'],
  ])('a reconciled line with %s is held unverified, never counted as containers', async (_label, uom) => {
    mockState.siteOneEmails = [siteOneEmail];
    mockState.siteOneInvoice = { number: '900000001-001', problem: null, lines: [{ ...lines[0], uom }] };
    mockState.outcomes = [{ status: 'unverified', product: taurus, inserted: true, lineId: 'line-s1' }];
    await run();
    expect(processReceiptLine.mock.calls[0][0]).toMatchObject({ lineNo: 1, holdAs: 'unverified' });
  });

  test('an invoice never read into lines gets one unreadable placeholder and a bell', async () => {
    mockState.siteOneEmails = [siteOneEmail];
    mockState.siteOneInvoice = { number: '900000001-001', problem: 'unreadable', lines: [] };
    mockState.outcomes = [{ status: 'unreadable', product: null, inserted: true, lineId: 'line-s1' }];
    const notify = jest.fn(async () => ({}));
    await runPurchaseReceiptRestockSweep({ notify });
    expect(processReceiptLine.mock.calls[0][0]).toMatchObject({ lineNo: 1, forcedStatus: 'unreadable' });
    expect(notify.mock.calls[0][2]).toBe("SiteOne invoice 900000001-001 wasn't added. The invoice couldn't be read. If it has stock, log it by hand.");
  });

  test('one invoice that can\'t be read is recorded as an error and never stops the next', async () => {
    const siteOne = require('../services/purchase-receipts/siteone-invoices');
    mockState.siteOneEmails = [siteOneEmail, { ...siteOneEmail, id: 's2' }];
    siteOne.readSiteOneInvoice.mockImplementationOnce(async () => { throw new Error('extraction row locked'); });
    mockState.siteOneInvoice = { number: '900000002-001', problem: null, lines: [lines[0]] };
    mockState.outcomes = [{ status: 'logged', product: taurus, receivedQty: 78, receivedUnit: 'fl_oz', hasOpenRestockRequest: false, lineId: 'line-s2' }];
    const result = await run();
    expect(result.errors).toEqual([{ title: siteOneEmail.subject, message: 'extraction row locked', emailId: 's1' }]);
    expect(result.logged).toEqual([expect.objectContaining({ emailId: 's2' })]);
  });

  test.each([
    ['still being read', () => { mockState.siteOneInvoice = { pending: true }; }],
    ['the other copy of the invoice already recorded', () => { mockState.otherCopy = { id: 'line-from-store-copy' }; }],
    ['unauthenticated', () => { mockState.siteOneEmails = [{ ...siteOneEmail, authentication_results: 'dkim=pass header.i=@evil.example' }]; }],
  ])('nothing is recorded when the invoice is %s', async (_label, arrange) => {
    mockState.siteOneEmails = [siteOneEmail];
    mockState.siteOneInvoice = { number: '900000001-001', problem: null, lines };
    arrange();
    await run();
    expect(processReceiptLine).not.toHaveBeenCalled();
  });
});
