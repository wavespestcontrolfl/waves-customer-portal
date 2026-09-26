/**
 * purchase-receipts/sweep.js — the two gates (GATE_PURCHASE_RECEIPT_RESTOCK
 * + PURCHASE_RECEIPT_SINCE), sender authentication (P0: from/subject are
 * spoofable — only an aligned SPF/DKIM pass earns any processing), the
 * per-email hook path, the bell for a 'logged' line, and the ~15-min
 * sweep's aggregation across emails.
 *
 * receipt-processor's own matching/sizing/idempotency logic is covered in
 * purchase-receipts-processor.test.js — here it is mocked so this suite
 * tests only sweep.js's own orchestration. hasAlignedAuth/domainFromAddress
 * are the REAL (unmocked) functions from inbox-hygiene.js/spam-blocker.js —
 * this suite is exactly what proves the integration actually authenticates.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockState = { outcomes: [], emails: [] };
jest.mock('../services/purchase-receipts/receipt-processor', () => ({
  processReceiptLine: jest.fn(async () => mockState.outcomes.shift()),
}));
jest.mock('../models/db', () => {
  // Only runPurchaseReceiptRestockSweep's own emails query touches db in
  // this file — processReceiptEmail takes an already-fetched row.
  const q = {};
  for (const m of ['whereRaw', 'where', 'orderBy']) q[m] = () => q;
  q.then = (resolve, reject) => Promise.resolve(mockState.emails).then(resolve, reject);
  return jest.fn(() => q);
});

const { processReceiptEmail, runPurchaseReceiptRestockSweep } = require('../services/purchase-receipts/sweep');
const { processReceiptLine } = require('../services/purchase-receipts/receipt-processor');

// A real "dkim=pass header.i=@amazon.com" clause — the shape a genuine
// Amazon delivery email carries (prod check: every order-update@amazon.com
// email since 2026-08-05 has this). hasAlignedAuth/domainFromAddress are
// real, unmocked code — this is what makes every other test in this file
// (which all use this fixture) an actual proof the auth gate passes real
// deliveries, not just a mock that ignores it.
const ALIGNED_AMAZON_AUTH = 'dkim=pass header.i=@amazon.com; spf=pass smtp.mailfrom=amazon.com';

const deliveredEmail = {
  id: 'e1', from_address: 'order-update@amazon.com', subject: 'Delivered: 2 "Atticus Talak..."',
  body_text: 'Order # 114-9578837-7732259\n\n* Taurus SC Termiticide 78 oz Quantity: 2\n* Chromebook Quantity: 1\n',
  received_at: new Date(), authentication_results: ALIGNED_AMAZON_AUTH,
};

beforeEach(() => {
  mockState.outcomes = [];
  mockState.emails = [];
  processReceiptLine.mockClear();
  delete process.env.GATE_PURCHASE_RECEIPT_RESTOCK;
  delete process.env.PURCHASE_RECEIPT_SINCE;
});

describe('gating', () => {
  test('gate off -> skipped before anything else, for both entry points', async () => {
    process.env.PURCHASE_RECEIPT_SINCE = '2026-01-01T00:00:00Z';
    expect(await processReceiptEmail(deliveredEmail)).toEqual({ skipped: 'gated' });
    expect(await runPurchaseReceiptRestockSweep()).toEqual({ skipped: 'gated' });
    expect(processReceiptLine).not.toHaveBeenCalled();
  });

  test('gate on but PURCHASE_RECEIPT_SINCE unset -> skipped, no read/write at all', async () => {
    process.env.GATE_PURCHASE_RECEIPT_RESTOCK = 'true';
    expect(await processReceiptEmail(deliveredEmail)).toEqual({ skipped: 'no_since' });
    expect(await runPurchaseReceiptRestockSweep()).toEqual({ skipped: 'no_since' });
    expect(processReceiptLine).not.toHaveBeenCalled();
  });

  test('an email received before PURCHASE_RECEIPT_SINCE is skipped (never replays pre-activation history)', async () => {
    process.env.GATE_PURCHASE_RECEIPT_RESTOCK = 'true';
    process.env.PURCHASE_RECEIPT_SINCE = '2026-09-26T00:00:00Z';
    const old = { ...deliveredEmail, received_at: new Date('2026-09-01T00:00:00Z') };
    expect(await processReceiptEmail(old)).toEqual({ skipped: 'before_since' });
    expect(processReceiptLine).not.toHaveBeenCalled();
  });

  test('a non-delivery email from the same sender is skipped', async () => {
    process.env.GATE_PURCHASE_RECEIPT_RESTOCK = 'true';
    process.env.PURCHASE_RECEIPT_SINCE = '2026-01-01T00:00:00Z';
    const shipped = { ...deliveredEmail, subject: 'Shipped: your order' };
    expect(await processReceiptEmail(shipped)).toEqual({ skipped: 'not_a_delivery_email' });
  });
});

describe('sender authentication (P0: from/subject are spoofable)', () => {
  beforeEach(() => {
    process.env.GATE_PURCHASE_RECEIPT_RESTOCK = 'true';
    process.env.PURCHASE_RECEIPT_SINCE = '2026-01-01T00:00:00Z';
  });

  test('no Authentication-Results at all -> refused, no processing, no DB write', async () => {
    const spoofed = { ...deliveredEmail, authentication_results: null };
    expect(await processReceiptEmail(spoofed)).toEqual({ skipped: 'unauthenticated' });
    expect(processReceiptLine).not.toHaveBeenCalled();
  });

  test('DKIM passes but for a DIFFERENT domain -> refused (from_address claims amazon.com, auth says otherwise)', async () => {
    const spoofed = { ...deliveredEmail, authentication_results: 'dkim=pass header.i=@evil-spoofer.example; spf=fail' };
    expect(await processReceiptEmail(spoofed)).toEqual({ skipped: 'unauthenticated' });
    expect(processReceiptLine).not.toHaveBeenCalled();
  });

  test('an aligned DKIM pass for amazon.com is accepted and processing proceeds', async () => {
    mockState.outcomes = [{ status: 'logged', product: { id: 'p1', name: 'Taurus SC' }, receivedQty: 156, receivedUnit: 'fl_oz' }, { status: 'unmatched', inserted: true }];
    const result = await processReceiptEmail(deliveredEmail, { notify: jest.fn(async () => ({})) });
    expect(result.skipped).toBeUndefined();
    expect(processReceiptLine).toHaveBeenCalledTimes(2);
  });
});

describe('processReceiptEmail', () => {
  beforeEach(() => {
    process.env.GATE_PURCHASE_RECEIPT_RESTOCK = 'true';
    process.env.PURCHASE_RECEIPT_SINCE = '2026-01-01T00:00:00Z';
  });

  test('a logged line rings one bell; an unmatched line rings none', async () => {
    mockState.outcomes = [
      { status: 'logged', product: { id: 'p1', name: 'Taurus SC' }, receivedQty: 156, receivedUnit: 'fl_oz' },
      { status: 'unmatched', inserted: true },
    ];
    const notify = jest.fn(async () => ({}));
    const result = await processReceiptEmail(deliveredEmail, { notify });

    expect(processReceiptLine).toHaveBeenCalledTimes(2);
    expect(processReceiptLine.mock.calls[0][0]).toMatchObject({ orderNumber: '114-9578837-7732259', shipmentKey: 'e1', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 2 }, lineNo: 1 });
    expect(processReceiptLine.mock.calls[1][0]).toMatchObject({ shipmentKey: 'e1', item: { title: 'Chromebook', quantity: 1 }, lineNo: 2 });

    expect(result.logged).toEqual([{ title: 'Taurus SC Termiticide 78 oz', receivedQty: 156, receivedUnit: 'fl_oz', productId: 'p1' }]);
    expect(result.unmatched).toEqual([{ title: 'Chromebook' }]);

    expect(notify).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = notify.mock.calls[0];
    expect(category).toBe('inventory');
    expect(title).toMatch(/Amazon delivery logged/i);
    expect(body).toContain('Taurus SC');
    expect(body).toContain('+156 fl oz');
    expect(body).toContain('2 × 78 fl oz');
    expect(opts.bell).toBe(true);
    expect(opts.link).toBe('/admin/inventory?tab=products');
    expect(opts.dedupeKey).toBe('amazon-delivery:e1:Taurus SC Termiticide 78 oz');
  });

  test('size_mismatch and needs_size lines never ring a bell', async () => {
    mockState.outcomes = [{ status: 'size_mismatch', inserted: true }, { status: 'needs_size', inserted: true }];
    const notify = jest.fn(async () => ({}));
    const result = await processReceiptEmail(deliveredEmail, { notify });
    expect(result.sizeMismatch).toEqual([{ title: 'Taurus SC Termiticide 78 oz' }]);
    expect(result.needsSize).toEqual([{ title: 'Chromebook' }]);
    expect(notify).not.toHaveBeenCalled();
  });

  test('a per-item failure is recorded and does not stop the other items on the same email', async () => {
    // mockImplementationOnce (not a stateful mockImplementation) so this
    // test's override cannot leak into later tests/describes that expect
    // the default mockState.outcomes.shift() behavior.
    processReceiptLine.mockImplementationOnce(async () => { throw new Error('inventory-operations boom'); });
    processReceiptLine.mockImplementationOnce(async () => ({ status: 'unmatched', inserted: true }));
    const result = await processReceiptEmail(deliveredEmail, { notify: jest.fn() });
    expect(result.errors).toEqual([{ title: 'Taurus SC Termiticide 78 oz', message: 'inventory-operations boom' }]);
    expect(result.unmatched).toEqual([{ title: 'Chromebook' }]);
  });

  test('an itemless Delivered email ("N Lawn & Garden item(s)") records exactly one no_items placeholder line (no sibling recovery)', async () => {
    const itemless = {
      id: 'e4', from_address: 'order-update@amazon.com', subject: 'Delivered: 2 Lawn & Garden items',
      body_text: 'Order # 100-1111111-1111111\n\nTrack your package: https://www.amazon.com/x\n',
      received_at: new Date(), authentication_results: ALIGNED_AMAZON_AUTH,
    };
    mockState.outcomes = [{ status: 'no_items', inserted: true, product: null }];
    const notify = jest.fn(async () => ({}));
    const result = await processReceiptEmail(itemless, { notify });

    expect(processReceiptLine).toHaveBeenCalledTimes(1);
    expect(processReceiptLine.mock.calls[0][0]).toMatchObject({
      orderNumber: '100-1111111-1111111', item: { title: 'Delivered: 2 Lawn & Garden items', quantity: 1 }, lineNo: 1, forcedStatus: 'no_items',
    });
    expect(result.noItems).toEqual([{ title: 'Delivered: 2 Lawn & Garden items', orderNumber: '100-1111111-1111111' }]);
    expect(result.logged).toEqual([]);
    expect(notify).not.toHaveBeenCalled(); // no_items never bells
  });
});

describe('runPurchaseReceiptRestockSweep', () => {
  beforeEach(() => {
    process.env.GATE_PURCHASE_RECEIPT_RESTOCK = 'true';
    process.env.PURCHASE_RECEIPT_SINCE = '2026-01-01T00:00:00Z';
  });

  test('aggregates outcomes across every scanned email', async () => {
    mockState.emails = [deliveredEmail, { ...deliveredEmail, id: 'e2', body_text: 'Order # 200-0000000-0000000\n\n* Southern Ag Thuricide BT Concentrate\n' }];
    mockState.outcomes = [
      { status: 'logged', product: { id: 'p1', name: 'Taurus SC' }, receivedQty: 156, receivedUnit: 'fl_oz' },
      { status: 'unmatched', inserted: true },
      { status: 'unmatched', inserted: true },
    ];
    const result = await runPurchaseReceiptRestockSweep({ notify: jest.fn(async () => ({})) });
    expect(result.emailsScanned).toBe(2);
    expect(result.logged).toEqual([{ title: 'Taurus SC Termiticide 78 oz', receivedQty: 156, receivedUnit: 'fl_oz', productId: 'p1', emailId: 'e1' }]);
    expect(result.unmatched).toHaveLength(2);
    expect(result.unmatched[1].emailId).toBe('e2');
  });

  test('an unauthenticated candidate email in the same sweep is skipped and never touches processReceiptLine', async () => {
    mockState.emails = [{ ...deliveredEmail, authentication_results: null }];
    const result = await runPurchaseReceiptRestockSweep({ notify: jest.fn() });
    expect(result.emailsScanned).toBe(1);
    expect(processReceiptLine).not.toHaveBeenCalled();
    expect(result.logged).toEqual([]);
  });
});
