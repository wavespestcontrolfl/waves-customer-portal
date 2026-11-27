/**
 * purchase-receipts/failed-lines-alert.js — the one standing alert for receipt
 * lines that threw and were never applied. Contracts pinned here:
 *  - the alert body lists up to 5 lines (vendor, invoice date, product text, reason) and "and N more";
 *  - it refreshes quietly for the same set and rings only when a NEW line joins it;
 *  - a line whose email is past the 7-day lookback is still counted (carried from the open alert);
 *  - a line drops when it was retried inside the window and did not fail again, or when a row now exists for it;
 *  - nothing left closes the alert (count_zero);
 *  - the composed alert passes the admin-notification copy rules (composeAdminAlert throws under test).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockState = { rows: new Set() };
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => {
    if (table !== 'purchase_receipt_lines') throw new Error(`unexpected table ${table}`);
    return {
      where: (k) => ({ first: async () => (mockState.rows.has(`${k.vendor}|${k.order_number}|${k.shipment_key}|${k.line_no}`) ? { id: 1 } : undefined) }),
    };
  });
  fn.transaction = async (run) => run('trx');
  return fn;
});
const mockEpisodes = { openAdminAlertMetadata: jest.fn(), raiseAdminAlertWithReopen: jest.fn(async () => ({})), closeAdminAlertKeys: jest.fn(async () => 1) };
jest.mock('../services/admin-alert-episodes', () => mockEpisodes);

const { reconcileFailedLineAlert, failedLineEntry, DEDUPE_KEY } = require('../services/purchase-receipts/failed-lines-alert');

const FLOOR = new Date('2026-11-20T00:00:00Z');
const entry = (n, receivedAt = '2026-11-25T15:00:00Z', extra = {}) => failedLineEntry({
  receipt: { vendor: 'siteone' }, email: { received_at: receivedAt }, orderNumber: `INV${n}`, shipmentKey: `INV${n}`, lineNo: 1,
  item: { title: `Product ${n} 50 LB. BAG` }, err: new Error(`boom ${n}`), ...extra,
});
const openAlert = (...failedLines) => mockEpisodes.openAdminAlertMetadata.mockResolvedValue(failedLines.length ? [{ failedLines, itemKeys: failedLines.map((l) => l.key) }] : []);
const raised = () => mockEpisodes.raiseAdminAlertWithReopen.mock.calls[0];

beforeEach(() => {
  mockState.rows = new Set();
  Object.values(mockEpisodes).forEach((m) => m.mockClear());
  openAlert();
});

describe('failedLineEntry', () => {
  test('keys the line like the table and masks emails, quoted SQL and numbers in the reason', () => {
    const e = failedLineEntry({
      receipt: { vendor: 'amazon' }, email: { received_at: '2026-11-25T15:00:00Z' }, orderNumber: null, shipmentKey: 'SHIP1', lineNo: 2,
      item: { title: 'Taurus SC' }, err: new Error("insert failed for 'Jane Doe' jane@example.com 941-555-0100\nstack"),
    });
    expect(e.key).toBe('amazon|unknown|SHIP1|2');
    expect(e.reason).not.toMatch(/Jane|example\.com|941|stack/);
  });
});

describe('reconcileFailedLineAlert', () => {
  test('one failed line raises one inventory alert that rings and names the line', async () => {
    const count = await reconcileFailedLineAlert({ failed: [entry(1)], floor: FLOOR });
    expect(count).toBe(1);
    const [category, headline, why, opts] = raised();
    expect(category).toBe('inventory');
    expect(headline).toBe('Inventory — add 1 failed receipt line by hand');
    expect(why).toBe('These lines failed to apply, so their stock was not added.');
    expect(opts).toMatchObject({ dedupeKey: DEDUPE_KEY, bell: true, refreshOnDedupe: true, link: '/admin/inventory?tab=products' });
    expect(opts.detail).toContain('- SiteOne, November 25: "Product 1 50 LB. BAG" - boom 1');
    expect(opts.ringOnRefresh(null, undefined)).toBe(true);
  });

  test('lists 5 lines and "and N more", counting all', async () => {
    const failed = [1, 2, 3, 4, 5, 6, 7].map((n) => entry(n));
    await reconcileFailedLineAlert({ failed, floor: FLOOR });
    const [, headline, , opts] = raised();
    expect(headline).toBe('Inventory — add 7 failed receipt lines by hand');
    expect(opts.detail.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(5);
    expect(opts.detail).toContain('and 2 more');
    expect(opts.metadata.count).toBe(7);
  });

  test('the same set refreshes quietly; a new line rings', async () => {
    const a = entry(1);
    openAlert(a);
    await reconcileFailedLineAlert({ failed: [a], floor: FLOOR });
    const quiet = raised()[3];
    expect(quiet.ringOnRefresh(null, { itemKeys: [a.key] })).toBe(false);
    mockEpisodes.raiseAdminAlertWithReopen.mockClear();
    const b = entry(2);
    await reconcileFailedLineAlert({ failed: [a, b], floor: FLOOR });
    expect(raised()[3].ringOnRefresh(null, { itemKeys: [a.key] })).toBe(true);
  });

  test('a line older than the 7-day lookback stays counted while no row exists for it', async () => {
    const old = entry(1, '2026-11-10T15:00:00Z');
    openAlert(old);
    const count = await reconcileFailedLineAlert({ failed: [entry(2)], floor: FLOOR });
    expect(count).toBe(2);
    const [, , , opts] = raised();
    expect(opts.metadata.itemKeys).toEqual([old.key, entry(2).key]); // oldest first
    expect(opts.detail).toContain('November 10');
    expect(mockEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('an old line closes the alert once a row exists for it', async () => {
    const old = entry(1, '2026-11-10T15:00:00Z');
    openAlert(old);
    mockState.rows.add('siteone|INV1|INV1|1');
    expect(await reconcileFailedLineAlert({ failed: [], floor: FLOOR })).toBe(0);
    expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(mockEpisodes.closeAdminAlertKeys).toHaveBeenCalledWith('trx', [DEDUPE_KEY], 'count_zero', expect.objectContaining({ resolution: expect.any(String) }));
  });

  test('a line inside the window that did not fail this run was retried and applied: it drops, the rest stay', async () => {
    const applied = entry(1);
    const stuck = entry(2);
    openAlert(applied, stuck);
    const count = await reconcileFailedLineAlert({ failed: [stuck], floor: FLOOR });
    expect(count).toBe(1);
    expect(raised()[3].metadata.itemKeys).toEqual([stuck.key]);
  });

  test('nothing failed and nothing open writes nothing', async () => {
    expect(await reconcileFailedLineAlert({ failed: [], floor: FLOOR })).toBe(0);
    expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(mockEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});
