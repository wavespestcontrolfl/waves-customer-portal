/**
 * purchase-receipts/failed-lines-alert.js — the one standing alert for receipt
 * lines that threw (and invoice emails that could not be read) and were never
 * applied. Contracts pinned here:
 *  - the body lists up to 5 entries and "and N more", while EVERY open key stays in metadata;
 *  - it refreshes quietly for the same set and rings only when a NEW entry joins it;
 *  - an entry past the 7-day lookback stays counted;
 *  - an entry drops ONLY on positive evidence: a purchase_receipt_lines row for its key, or an
 *    outcome this run recorded for that exact key. Not attempting it is not evidence;
 *  - a key with a row never enters the alert, even when this run just failed it;
 *  - an unreadable invoice email is one entry until a later run reads it (or a row names its email);
 *  - nothing left closes the alert (count_zero);
 *  - the composed alert passes the admin-notification copy rules (composeAdminAlert throws under test).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// Rows in purchase_receipt_lines, as { vendor, order_number, shipment_key, line_no, email_id }.
const mockState = { rows: [], alert: null };
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => {
    if (table === 'notifications') {
      const q = { where: () => q, whereRaw: () => q, orderBy: () => q, first: async () => mockState.alert };
      return q;
    }
    if (table !== 'purchase_receipt_lines') throw new Error(`unexpected table ${table}`);
    let matched = [];
    const builder = {
      whereIn: (col, values) => {
        matched = mockState.rows.filter((row) => values.includes(row[col]));
        return builder;
      },
      select: async () => matched,
    };
    return builder;
  });
  fn.transaction = async (run) => run('trx');
  return fn;
});
const mockEpisodes = { raiseAdminAlertWithReopen: jest.fn(async () => ({})), closeAdminAlertKeys: jest.fn(async () => 1) };
jest.mock('../services/admin-alert-episodes', () => mockEpisodes);

const { reconcileFailedLineAlert, failedLineEntry, failedEmailEntry, DEDUPE_KEY } = require('../services/purchase-receipts/failed-lines-alert');

const entry = (n, receivedAt = '2026-11-25T15:00:00Z', lineNo = 1, title = `Product ${n} 50 LB. BAG`) => failedLineEntry({
  receipt: { vendor: 'siteone' }, email: { id: 'mail-a', received_at: receivedAt }, orderNumber: `INV${n}`, shipmentKey: `INV${n}`, lineNo,
  item: { title }, err: new Error(`boom ${n}`),
});
const emailEntry = (id = 's1', receivedAt = '2026-11-25T15:00:00Z') => failedEmailEntry({ vendor: 'siteone', email: { id, received_at: receivedAt } });
const rowFor = (e, extra = {}) => ({ vendor: e.vendor, order_number: e.orderNumber, shipment_key: e.shipmentKey, line_no: e.lineNo, raw_title: 'other', email_id: 'x', ...extra });
const openAlert = (...failedLines) => { mockState.alert = failedLines.length ? { metadata: { failedLines, itemKeys: failedLines.map((l) => l.key) }, done_at: null } : null; };
// A row staff pressed Done on: it still holds its entries in metadata.
const doneAlert = (...failedLines) => { openAlert(...failedLines); mockState.alert.done_at = '2026-11-26T12:00:00Z'; };
const raised = () => mockEpisodes.raiseAdminAlertWithReopen.mock.calls[0];

beforeEach(() => {
  mockState.rows = [];
  mockState.alert = null;
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

describe('raise, refresh, ring', () => {
  test('one failed line raises one inventory alert that rings and names the line', async () => {
    const count = await reconcileFailedLineAlert({ failed: [entry(1)], settled: [] });
    expect(count).toBe(1);
    const [category, headline, why, opts] = raised();
    expect(category).toBe('inventory');
    expect(headline).toBe('Inventory — check 1 failed receipt item');
    expect(why).toBe('Their stock was not added; log it by hand if it is stock.');
    expect(opts).toMatchObject({ dedupeKey: DEDUPE_KEY, bell: true, refreshOnDedupe: true, link: '/admin/inventory?tab=products' });
    expect(opts.detail).toContain('- SiteOne, November 25: "Product 1 50 LB. BAG" - boom 1');
    expect(opts.ringOnRefresh(null, undefined)).toBe(true);
  });

  test('lists 5 and "and N more", yet every open key stays in metadata', async () => {
    const failed = Array.from({ length: 7 }, (_, i) => entry(i + 1));
    await reconcileFailedLineAlert({ failed, settled: [] });
    const [, headline, , opts] = raised();
    expect(headline).toBe('Inventory — check 7 failed receipt items');
    expect(opts.detail.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(5);
    expect(opts.detail).toContain('and 2 more');
    expect(opts.metadata.count).toBe(7);
    expect(opts.metadata.failedLines).toHaveLength(7);
    expect(opts.metadata.itemKeys).toEqual(failed.map((e) => e.key));
  });

  test('more than 200 open keys are all kept (no display-limit discard)', async () => {
    const failed = Array.from({ length: 450 }, (_, i) => entry(String(i).padStart(3, '0')));
    await reconcileFailedLineAlert({ failed, settled: [] });
    expect(raised()[3].metadata.failedLines).toHaveLength(450);
  });

  test('the same set refreshes quietly; a new entry rings', async () => {
    const a = entry(1);
    openAlert(a);
    await reconcileFailedLineAlert({ failed: [a], settled: [] });
    expect(raised()[3].ringOnRefresh(null, { itemKeys: [a.key] })).toBe(false);
    mockEpisodes.raiseAdminAlertWithReopen.mockClear();
    await reconcileFailedLineAlert({ failed: [a, entry(2)], settled: [] });
    expect(raised()[3].ringOnRefresh(null, { itemKeys: [a.key] })).toBe(true);
  });
});

describe('what keeps and what drops an entry', () => {
  test('an entry older than the 7-day lookback stays counted, and the list runs oldest first', async () => {
    const old = entry(1, '2026-11-10T15:00:00Z');
    openAlert(old);
    expect(await reconcileFailedLineAlert({ failed: [entry(2)], settled: [] })).toBe(2);
    const [, , , opts] = raised();
    expect(opts.metadata.itemKeys).toEqual([old.key, entry(2).key]);
    expect(opts.detail).toContain('November 10');
    expect(mockEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('not attempting an entry is not evidence: a carried line absent from this run stays', async () => {
    const carried = entry(1); // inside the window, but its invoice read threw so the line was never tried
    openAlert(carried);
    expect(await reconcileFailedLineAlert({ failed: [], settled: [{ key: entry(9).key }] })).toBe(1);
    expect(raised()[3].metadata.itemKeys).toEqual([carried.key]);
  });

  test('an outcome recorded this run for that exact key drops it; the rest stay', async () => {
    const applied = entry(1);
    const stuck = entry(2);
    openAlert(applied, stuck);
    expect(await reconcileFailedLineAlert({ failed: [], settled: [{ key: applied.key }] })).toBe(1);
    expect(raised()[3].metadata.itemKeys).toEqual([stuck.key]);
  });

  test('a row for its key drops an old line and closes the alert when it was the last', async () => {
    const old = entry(1, '2026-11-10T15:00:00Z');
    openAlert(old);
    mockState.rows = [rowFor(old)];
    expect(await reconcileFailedLineAlert({ failed: [], settled: [] })).toBe(0);
    expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(mockEpisodes.closeAdminAlertKeys).toHaveBeenCalledWith('trx', [DEDUPE_KEY], 'count_zero', expect.objectContaining({ resolution: expect.any(String) }));
  });

  test('a key this run failed but a row already holds never enters the alert (a second copy recorded it)', async () => {
    const failed = entry(1);
    mockState.rows = [rowFor(failed)];
    expect(await reconcileFailedLineAlert({ failed: [failed], settled: [{ key: failed.key }] })).toBe(0);
    expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(mockEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled(); // nothing was open
  });

  test('a failed line with no row stays even when the same key shows as settled earlier in the run', async () => {
    const failed = entry(1);
    expect(await reconcileFailedLineAlert({ failed: [failed], settled: [{ key: failed.key }] })).toBe(1);
  });

  test('the other copy of the same invoice recorded the line: matched by vendor + invoice number, not the exact key', async () => {
    const failed = entry(1);
    // Copy B (another email, another order_number text) wrote line 1 under the same shipment key.
    mockState.rows = [rowFor(failed, { order_number: 'INV1-COPY', email_id: 'copy-b' })];
    expect(await reconcileFailedLineAlert({ failed: [failed], settled: [] })).toBe(0);
    expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });

  test('a copy that numbered the lines differently still matches by product text that occurs once on the invoice', async () => {
    const failed = entry(1);
    mockState.rows = [rowFor(failed, { line_no: 7, raw_title: 'PRODUCT 1 50 lb. bag', email_id: 'copy-b' })];
    expect(await reconcileFailedLineAlert({ failed: [failed], settled: [] })).toBe(0);
  });

  test('product text that occurs twice on the invoice proves nothing: the failed line stays', async () => {
    const failed = entry(1);
    mockState.rows = [
      rowFor(failed, { line_no: 7, raw_title: 'Product 1 50 LB. BAG', email_id: 'copy-b' }),
      rowFor(failed, { line_no: 8, raw_title: 'product 1 50 lb bag', email_id: 'copy-b' }),
    ];
    expect(await reconcileFailedLineAlert({ failed: [failed], settled: [] })).toBe(1);
    // ...but the exact line number still clears it.
    mockState.rows.push(rowFor(failed, { line_no: failed.lineNo, raw_title: 'Other', email_id: 'copy-b' }));
    mockEpisodes.raiseAdminAlertWithReopen.mockClear();
    expect(await reconcileFailedLineAlert({ failed: [failed], settled: [] })).toBe(0);
  });

  test('a recorded sibling line with the same title never clears a rolled-back line (line 1 recorded, line 2 failed)', async () => {
    const failed = entry(1, '2026-11-25T15:00:00Z', 2);
    mockState.rows = [rowFor(failed, { line_no: 1, raw_title: 'Product 1 50 LB. BAG', email_id: 'mail-a' })];
    expect(await reconcileFailedLineAlert({ failed: [failed], settled: [] })).toBe(1);
    // Even when another copy also holds one row with that text, the failing email's own sibling makes it ambiguous.
    mockState.rows.push(rowFor(failed, { line_no: 5, raw_title: 'product 1 50 lb bag', email_id: 'copy-b' }));
    expect(await reconcileFailedLineAlert({ failed: [failed], settled: [] })).toBe(1);
  });

  test('text fallback is one-to-one: two failed entries with one text and one other-copy row clear neither', async () => {
    const [one, two] = [entry(1, '2026-11-25T15:00:00Z', 1), entry(1, '2026-11-25T15:00:00Z', 2)];
    mockState.rows = [rowFor(one, { line_no: 9, raw_title: 'Product 1 50 LB. BAG', email_id: 'copy-b' })];
    expect(await reconcileFailedLineAlert({ failed: [one, two], settled: [] })).toBe(2);
  });

  test('a row that already matches another entry by line number cannot also clear a second entry by text', async () => {
    const a = entry(1, '2026-11-25T15:00:00Z', 1, 'Taurus SC 78 oz');
    const b = entry(1, '2026-11-25T15:00:00Z', 2, 'CrossCheck 1 gal');
    mockState.rows = [rowFor(b, { line_no: 2, raw_title: 'Taurus SC 78 oz', email_id: 'copy-b' })];
    expect(await reconcileFailedLineAlert({ failed: [a, b], settled: [] })).toBe(1);
    expect(raised()[3].metadata.itemKeys).toEqual([a.key]);
  });

  test('another invoice, or another line with other text, never hides a failed line', async () => {
    const failed = entry(1);
    mockState.rows = [rowFor(entry(2)), rowFor(failed, { line_no: 2, raw_title: 'Something else' })];
    expect(await reconcileFailedLineAlert({ failed: [failed], settled: [] })).toBe(1);
  });

  test('nothing failed and nothing open writes nothing', async () => {
    expect(await reconcileFailedLineAlert({ failed: [], settled: [] })).toBe(0);
    expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(mockEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});

describe('an invoice email that could not be read', () => {
  test('is one alert line until a later run reads it', async () => {
    const e = emailEntry();
    expect(e.key).toBe('email|siteone|s1');
    await reconcileFailedLineAlert({ failed: [e], settled: [] });
    expect(raised()[3].detail).toContain('- invoice email could not be read: SiteOne November 25');
    // Next run: not read yet (not attempted) keeps it; a clean read of that email drops it and closes the alert.
    openAlert(e);
    mockEpisodes.raiseAdminAlertWithReopen.mockClear();
    expect(await reconcileFailedLineAlert({ failed: [], settled: [] })).toBe(1);
    expect(await reconcileFailedLineAlert({ failed: [], settled: [{ key: e.key }] })).toBe(0);
    expect(mockEpisodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
  });

  test('an older email\'s rows under the same invoice never clear a newer email that could not be read', async () => {
    const e = emailEntry('s9');
    openAlert(e);
    mockState.rows = [{ vendor: 'siteone', order_number: 'INV1', shipment_key: 'INV1', line_no: 1, raw_title: 'Product 1', email_id: 's2-older' }];
    expect(await reconcileFailedLineAlert({ failed: [e], settled: [] })).toBe(1);
    expect(raised()[3].metadata.itemKeys).toEqual(['email|siteone|s9']);
  });

  test('a purchase_receipt_lines row from that email also resolves it', async () => {
    const e = emailEntry('s7');
    openAlert(e);
    mockState.rows = [{ vendor: 'siteone', order_number: 'INV1', shipment_key: 'INV1', line_no: 1, email_id: 's7' }];
    expect(await reconcileFailedLineAlert({ failed: [], settled: [] })).toBe(0);
  });
});

describe('after staff pressed Done', () => {
  test('a new failure reopens the row listing only the new entry; handled ones are kept out of the list and count', async () => {
    const handled = [entry(1), entry(2)];
    doneAlert(...handled);
    const fresh = entry(3);
    expect(await reconcileFailedLineAlert({ failed: [...handled, fresh], settled: [] })).toBe(3);
    const [, headline, , opts] = raised();
    expect(headline).toBe('Inventory — check 1 failed receipt item');
    expect(opts.detail).toContain('Product 3');
    expect(opts.detail).not.toMatch(/Product [12] /);
    expect(opts.ringOnRefresh(null, { itemKeys: handled.map((l) => l.key) })).toBe(true);
    expect(opts.metadata).toMatchObject({ handledKeys: handled.map((l) => l.key), count: 1 });
    expect(opts.metadata.itemKeys).toEqual([...handled, fresh].map((l) => l.key));
  });

  test('the handled set survives later runs while the row is open again', async () => {
    const [a, b] = [entry(1), entry(2)];
    openAlert(a, b);
    mockState.alert.metadata.handledKeys = [a.key];
    await reconcileFailedLineAlert({ failed: [a, b], settled: [] });
    expect(raised()[3].detail).toContain('Product 2');
    expect(raised()[3].detail).not.toContain('Product 1 ');
  });

  test('nothing new since Done writes nothing and keeps the row done; resolving them all closes it', async () => {
    const a = entry(1);
    doneAlert(a);
    expect(await reconcileFailedLineAlert({ failed: [a], settled: [] })).toBe(1);
    expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(mockEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    mockState.rows = [rowFor(a)];
    expect(await reconcileFailedLineAlert({ failed: [], settled: [] })).toBe(0);
    expect(mockEpisodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
  });
});
