// Bid kit daily expiry check (GATE_BID_KIT): one admin bell per item that expired or expires within 30 days, deduped per
// item for 7 days, admin bell only, nothing at all with the gate off. The store and the bell are stand-ins here
// (the SQL runs in bid-kit.db.test.js); every spec is composed by the real notification rules.
const mockRows = [];
// What a re-read under the lock returns: a row a test changed after the snapshot, else the snapshot's own row.
const mockFresh = new Map();
jest.mock('../services/bid-kit-store', () => ({
  listItems: jest.fn(async () => mockRows),
  getItem: jest.fn(async (id) => (mockFresh.has(id) ? mockFresh.get(id) : mockRows.find((row) => row.id === id))),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// A transaction is a stand-in that records the advisory lock it takes.
jest.mock('../models/db', () => {
  const trx = { __trx: true, raw: jest.fn(async () => ({})) };
  return { __db: true, trx, transaction: jest.fn(async (fn) => fn(trx)) };
});
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(),
  openAdminAlertKeys: jest.fn(),
  openAdminAlertMetadata: jest.fn(),
  closeAdminAlertKeys: jest.fn(),
}));

const store = require('../services/bid-kit-store');
const db = require('../models/db');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const episodes = require('../services/admin-alert-episodes');
const { runBidKitExpiryCheck, syncExpiryBell, qualifies, specFor, keyFor, DEDUPE_DAYS } = require('../services/bid-kit-expiry');

// The bell, as the notification service reports a ring: composed by the real notification rules first.
const raiseAdminAlert = episodes.raiseAdminAlertWithReopen;

const NOW = new Date('2026-10-23T14:00:00Z'); // Oct 23, 10:00 AM Eastern
const item = (id, over = {}) => ({
  id, kind: 'document', item_key: 'insurance_certificate', label: 'Certificate of insurance', has_file: true, value: null,
  expires_on: '2999-01-01', attested_at: null, archived_at: null, ...over,
});
// A row the lock's re-read will find (for a save's close, whose item is only a handle).
const present = (row) => { mockFresh.set(row.id, row); return row; };
const trx = require('../models/db').trx;
const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;

beforeEach(() => {
  mockRows.length = 0;
  mockFresh.clear();
  jest.clearAllMocks();
  process.env.GATE_BID_KIT = 'true';
  raiseAdminAlert.mockImplementation(async () => ({ id: 'n1', deduped: false, rang: true }));
  episodes.openAdminAlertKeys.mockResolvedValue([]);
  episodes.openAdminAlertMetadata.mockResolvedValue([]);
  episodes.closeAdminAlertKeys.mockResolvedValue(0);
});
afterEach(() => { delete process.env.GATE_BID_KIT; });

test('gate off: nothing is read and nothing rings', async () => {
  delete process.env.GATE_BID_KIT;
  expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ skipped: 'gate_off' });
  expect(store.listItems).not.toHaveBeenCalled();
  expect(raiseAdminAlert).not.toHaveBeenCalled();
});

test('it rings for an expired item and an item expiring within 30 days, and for nothing else', async () => {
  mockRows.push(
    item(ID(1), { expires_on: '2026-10-01' }), // expired
    item(ID(2), { expires_on: '2026-10-23' }), // expires today
    item(ID(3), { expires_on: '2026-11-22' }), // 30 days
    item(ID(4), { expires_on: '2026-11-23' }), // 31 days: not yet
    item(ID(5), { expires_on: null }), // no expiry
    item(ID(6), { expires_on: '2026-10-01', archived_at: new Date() }), // archived
    item(ID(7), { expires_on: '2026-10-01', has_file: false, value: null }), // nothing there: missing, not an expiry
    item(ID(8), { kind: 'fact', item_key: 'phone', label: 'Phone', value: '941-555-0100', expires_on: '2026-10-05' }),
  );
  const result = await runBidKitExpiryCheck({ now: NOW });
  expect(result).toEqual({ scanned: 4, rang: 3, closed: 0, overflow: 1 }); // three bells a run: the rest is a standing count
  const bells = raiseAdminAlert.mock.calls.filter(([, , , opts]) => opts.metadata.feed !== 'activity'); // the standing count is the other call
  expect(bells.map(([, , , opts]) => opts.metadata.subject.id)).toEqual([ID(1), ID(8), ID(2)]); // soonest expiry first
});

test('each bell is an admin bell, deduped per item for 7 days, and links to the item', async () => {
  mockRows.push(item(ID(1), { expires_on: '2026-11-04' }));
  await runBidKitExpiryCheck({ now: NOW });
  const [category, headline, why, opts] = raiseAdminAlert.mock.calls[0];
  expect(category).toBe('system');
  expect(opts).toMatchObject({ bell: true, dedupeKey: `bid-kit:expiry:${ID(1)}`, dedupeWindowMs: 7 * 86400000, link: `/admin/bid-kit?item=${ID(1)}` });
  expect(opts.trx).toBe(trx); // raised inside the item's locked transaction
  expect(opts.refreshOnDedupe).toBe(true); // a standing bell's words are rewritten each day...
  expect(opts.ringOnRefresh({}, {})).toBe(false); // ...quietly, never rung again inside the week
  expect(DEDUPE_DAYS).toBe(7);
  expect(keyFor({ id: ID(1) })).toBe(`bid-kit:expiry:${ID(1)}`);
  expect(opts.metadata).toMatchObject({ severity: 'needs-you', who: 'person', subject: { type: 'check', id: ID(1) }, doneWhen: 'item_renewed', bidKitItemId: ID(1) });
  expect(headline).toBe('Estimates — renew Certificate of insurance, expires Nov 4');
  expect(why).toBe('Expires Nov 4, in 12 days; bids need a current copy.');
});

test('a bell the dedupe window holds back is not counted as rung', async () => {
  mockRows.push(item(ID(1), { expires_on: '2026-11-04' }));
  raiseAdminAlert.mockResolvedValueOnce({ id: 'n1', deduped: true, rang: false });
  expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 1, rang: 0, closed: 0, overflow: 0 });
});

test('the words say expired, expires today or the day count, and every spec passes the notification rules', () => {
  const today = '2026-10-23';
  const expired = specFor(item(ID(1), { expires_on: '2026-10-20' }), today).spec;
  const same = specFor(item(ID(1), { expires_on: '2026-10-23' }), today).spec;
  const one = specFor(item(ID(1), { expires_on: '2026-10-24' }), today).spec;
  expect(expired.action).toBe('renew Certificate of insurance, expired');
  expect(expired.why).toBe('Expired Oct 20; agencies reject an expired paper.');
  expect(same.action).toBe('renew Certificate of insurance, expires today');
  expect(one.why).toBe('Expires Oct 24, in 1 day; bids need a current copy.');
  for (const spec of [expired, same, one]) expect(() => composeAdminAlert(spec)).not.toThrow();
});

test('a custom label never reaches an alert (fixed words), and a catalog item is named by the catalog', () => {
  const label = 'Pat Example 941-555-0123 pat@example.com 100 Example Way';
  const custom = specFor(item(ID(1), { item_key: 'custom', label, expires_on: '2026-11-04' }), '2026-10-23');
  const composed = composeAdminAlert(custom.spec);
  expect(composed.headline).toBe('Estimates — renew a custom bid paper, expires Nov 4');
  for (const text of [composed.headline, composed.why, custom.detail]) {
    for (const part of ['Pat', '941-555-0123', 'pat@example.com', 'Example Way']) expect(text).not.toContain(part);
  }
  const coded = specFor(item(ID(1), { label: 'coi_final_v2', expires_on: '2026-11-04' }), '2026-10-23').spec;
  expect(() => composeAdminAlert(coded)).not.toThrow();
  expect(coded.action).toContain('Certificate of insurance');
});

test('a failing bell does not stop the rest, and a failing scan does not throw', async () => {
  mockRows.push(item(ID(1), { expires_on: '2026-10-01' }), item(ID(2), { expires_on: '2026-10-02' }));
  raiseAdminAlert.mockRejectedValueOnce(new Error('bell down'));
  // The paper whose bell failed has no bell, so it stays in the standing count rather than being dropped.
  expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 2, rang: 1, closed: 0, overflow: 1 });
  store.listItems.mockRejectedValueOnce(new Error('db down'));
  expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 0, rang: 0, closed: 0, overflow: 0 });
});

describe('bells close when the paper no longer needs renewing', () => {
  const CLEAR = expect.stringContaining('renewed, archived or no longer expires');

  test('the daily job closes the open bell of every item that no longer qualifies, one locked close each, and keeps the ones that do', async () => {
    mockRows.push(
      item(ID(1), { expires_on: '2026-11-04' }), // still inside the window: keeps its bell
      item(ID(2), { expires_on: '2027-10-01' }), // renewed: the date moved out
      item(ID(3), { expires_on: '2026-10-01', has_file: false }), // no longer there
    ); // ID(4) was archived (not listed at all)
    episodes.openAdminAlertKeys.mockResolvedValue([keyFor({ id: ID(1) }), keyFor({ id: ID(2) }), keyFor({ id: ID(3) }), keyFor({ id: ID(4) })]);
    episodes.closeAdminAlertKeys.mockResolvedValue(1);
    const result = await runBidKitExpiryCheck({ now: NOW });
    expect(result).toEqual({ scanned: 1, rang: 1, closed: 3, overflow: 0 });
    expect(episodes.openAdminAlertKeys).toHaveBeenCalledWith(db, 'bid-kit:expiry');
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(3);
    for (const call of episodes.closeAdminAlertKeys.mock.calls) {
      expect(call[0]).toBe(trx); // inside the item's locked transaction
      expect(call[2]).toBe('no_longer_qualifies');
      expect(call[3]).toEqual({ resolution: CLEAR });
    }
    expect(episodes.closeAdminAlertKeys.mock.calls.map(([, keys]) => keys)).toEqual([[keyFor({ id: ID(2) })], [keyFor({ id: ID(3) })], [keyFor({ id: ID(4) })]]);
  });

  test('a failure while closing never fails the job or hides what rang', async () => {
    mockRows.push(item(ID(1), { expires_on: '2026-11-04' }));
    episodes.openAdminAlertKeys.mockRejectedValueOnce(new Error('db down'));
    expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 1, rang: 1, closed: 0, overflow: 0 });
  });

  test('a renewal (a save that moves the date out of the window) closes that item\'s bell at once', async () => {
    const renewed = await syncExpiryBell(present(item(ID(1), { expires_on: '2027-10-01' })), { now: NOW });
    expect(renewed).toEqual({ closed: 0 }); // the mock closed nothing, but it was asked
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(trx, [keyFor({ id: ID(1) })], 'renewed', { resolution: CLEAR });
  });

  test('an archived item closes its bell, with the archived reason', async () => {
    await syncExpiryBell(present(item(ID(1), { expires_on: '2026-10-01', archived_at: new Date() })), { now: NOW });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(trx, [keyFor({ id: ID(1) })], 'archived', { resolution: CLEAR });
  });

  test('an item that still qualifies keeps its bell (a file replaced while the date is still inside or past the window)', async () => {
    for (const expires_on of ['2026-10-01', '2026-11-04', '2026-11-22']) {
      await syncExpiryBell(present(item(ID(1), { expires_on })), { now: NOW });
    }
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('with the gate off the save path closes nothing and touches nothing', async () => {
    delete process.env.GATE_BID_KIT;
    expect(await syncExpiryBell(present(item(ID(1), { expires_on: '2027-10-01' })), { now: NOW })).toEqual({ skipped: 'gate_off' });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a failed close never fails the save', async () => {
    episodes.closeAdminAlertKeys.mockRejectedValueOnce(new Error('db down'));
    expect(await syncExpiryBell(present(item(ID(1), { expires_on: '2027-10-01' })), { now: NOW })).toEqual({ closed: 0, failed: true });
  });

  describe('an item listed in the standing count', () => {
    const { OVERFLOW_KEY } = require('../services/bid-kit-expiry');
    const standingRaises = () => raiseAdminAlert.mock.calls.filter(([, , , opts]) => opts.dedupeKey.startsWith(OVERFLOW_KEY));

    test('renewed: it leaves the count at once, and the rest stay listed with their dates', async () => {
      episodes.openAdminAlertMetadata.mockResolvedValue([{ dedupeKey: OVERFLOW_KEY, itemKeys: [ID(1), ID(2)] }]);
      present(item(ID(2), { expires_on: '2026-11-04' }));
      await syncExpiryBell(present(item(ID(1), { expires_on: '2027-10-01' })), { now: NOW });
      expect(episodes.openAdminAlertMetadata).toHaveBeenCalledWith(db, OVERFLOW_KEY);
      expect(standingRaises()).toHaveLength(1);
      const opts = standingRaises()[0][3];
      expect(opts.metadata).toMatchObject({ count: 1, itemKeys: [ID(2)] });
      expect(opts.detail).toContain('Nov 4');
      expect(opts.ringOnRefresh({}, {})).toBe(false);
    });

    test('the last listed item archived: the count closes', async () => {
      episodes.openAdminAlertMetadata.mockResolvedValue([{ dedupeKey: OVERFLOW_KEY, itemKeys: [ID(1)] }]);
      await syncExpiryBell(present(item(ID(1), { expires_on: '2026-10-01', archived_at: new Date() })), { now: NOW });
      expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(trx, [OVERFLOW_KEY], 'count_zero', expect.objectContaining({ resolution: expect.any(String) }));
      expect(standingRaises()).toHaveLength(0);
    });

    test('a corrected date that still qualifies shows in the count; an item not listed leaves the count alone', async () => {
      episodes.openAdminAlertMetadata.mockResolvedValue([{ dedupeKey: OVERFLOW_KEY, itemKeys: [ID(1)] }]);
      await syncExpiryBell(present(item(ID(1), { expires_on: '2026-11-09' })), { now: NOW });
      expect(standingRaises()[0][3].detail).toContain('Nov 9');
      raiseAdminAlert.mockClear();
      await syncExpiryBell(present(item(ID(3), { expires_on: '2027-10-01' })), { now: NOW });
      expect(standingRaises()).toHaveLength(0);
    });

    test('a failed refresh never fails the save', async () => {
      episodes.openAdminAlertMetadata.mockRejectedValueOnce(new Error('db down'));
      expect(await syncExpiryBell(present(item(ID(1), { expires_on: '2027-10-01' })), { now: NOW })).toEqual({ closed: 0 });
    });
  });

  test('qualifies is by date: unsigned items count, missing, undated and archived ones do not', () => {
    const today = '2026-10-23';
    expect(qualifies(item(ID(1), { expires_on: '2026-11-04', attested_at: null }), today)).toBe(true);
    expect(qualifies(item(ID(1), { expires_on: '2026-11-04', has_file: false }), today)).toBe(false);
    expect(qualifies(item(ID(1), { expires_on: null }), today)).toBe(false);
    expect(qualifies(item(ID(1), { expires_on: '2026-10-01', archived_at: new Date() }), today)).toBe(false);
  });
});

describe('the per-item lock and the re-read', () => {
  const lockCalls = () => trx.raw.mock.calls.map(([sql, params]) => [sql, params[0]]);
  const LOCK = 'SELECT pg_advisory_xact_lock(hashtext(?))';

  test('every raise takes the item\'s own lock first and reads the row again inside it', async () => {
    mockRows.push(item(ID(1), { expires_on: '2026-11-04' }), item(ID(2), { expires_on: '2026-10-01' }));
    await runBidKitExpiryCheck({ now: NOW });
    expect(lockCalls()).toEqual([[LOCK, `bid-kit:expiry-item:${ID(2)}`], [LOCK, `bid-kit:expiry-item:${ID(1)}`]]); // soonest expiry first
    expect(store.getItem.mock.calls.map(([id, conn]) => [id, conn])).toEqual([[ID(2), trx], [ID(1), trx]]);
  });

  test('a renewal that lands after the snapshot but before the raise leaves no bell: the fresh row does not qualify', async () => {
    mockRows.push(item(ID(1), { expires_on: '2026-11-04' }), item(ID(2), { expires_on: '2026-11-05' }));
    // After the list was read, someone renewed item 1 and archived item 2.
    present(item(ID(1), { expires_on: '2027-10-01' }));
    present(item(ID(2), { expires_on: '2026-11-05', archived_at: new Date() }));
    expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 2, rang: 0, closed: 0, overflow: 0 });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('the bell is raised from the fresh row, not the snapshot', async () => {
    mockRows.push(item(ID(1), { expires_on: '2026-11-04' }));
    present(item(ID(1), { expires_on: '2026-11-10' })); // moved, but still inside the window
    await runBidKitExpiryCheck({ now: NOW });
    expect(raiseAdminAlert.mock.calls[0][1]).toBe('Estimates — renew Certificate of insurance, expires Nov 10');
  });

  test('a save\'s close waits on the same lock and re-reads: a row that qualifies again keeps its bell', async () => {
    // The handle passed in says "renewed", but the fresh row (changed again) is back inside the window.
    present(item(ID(1), { expires_on: '2026-11-04' }));
    expect(await syncExpiryBell({ id: ID(1) }, { now: NOW })).toEqual({ closed: 0 });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(lockCalls()).toEqual([[LOCK, `bid-kit:expiry-item:${ID(1)}`]]);
    // And a handle whose row is gone closes the bell.
    await syncExpiryBell({ id: ID(2) }, { now: NOW });
    expect(episodes.closeAdminAlertKeys.mock.calls.at(-1).slice(1, 3)).toEqual([[keyFor({ id: ID(2) })], 'archived']);
  });

  test('closing a stale bell takes the item\'s lock too, and leaves the bell when the fresh row qualifies again', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue([keyFor({ id: ID(5) }), keyFor({ id: ID(6) }), 'bid-kit:expiry:not-an-id']);
    mockRows.push(item(ID(5), { expires_on: '2027-10-01' }), item(ID(6), { expires_on: '2027-10-01' }));
    present(item(ID(6), { expires_on: '2026-11-04' })); // came back inside the window after the snapshot
    const result = await runBidKitExpiryCheck({ now: NOW });
    expect(result.closed).toBe(0);
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
    expect(episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual([keyFor({ id: ID(5) })]);
    expect(lockCalls().map(([, key]) => key)).toEqual([`bid-kit:expiry-item:${ID(5)}`, `bid-kit:expiry-item:${ID(6)}`]);
  });

  test('normal expiring items still ring', async () => {
    mockRows.push(item(ID(1), { expires_on: '2026-10-25' }), item(ID(2), { expires_on: '2026-10-01' }), item(ID(3), { expires_on: '2999-01-01' }));
    expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 2, rang: 2, closed: 0, overflow: 0 });
  });
});

describe('no raw database error text reaches a log or the error handler', () => {
  const logger = require('../services/logger');
  const { errorTag, scrubError } = require('../services/bid-kit-log');
  const SECRET = 'Jane Q. Sample, jane.sample@example.test, 100 Fixture Way';
  const dbError = () => Object.assign(new Error(`insert into "bid_kit_items" ("label") values ('${SECRET}') - value too long`), { code: '22001', constraint: 'bid_kit_items_label_len' });
  const logged = () => JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls, logger.info.mock.calls]);

  test('the tag is the code (or name) and the constraint, never the message', () => {
    expect(errorTag(dbError())).toBe('22001 constraint=bid_kit_items_label_len');
    expect(errorTag(new TypeError('boom jane.sample@example.test'))).toBe('TypeError');
    expect(errorTag(null)).toBe('Error');
    const safe = scrubError(dbError());
    expect(safe.message).toBe('Bid kit request failed (22001 constraint=bid_kit_items_label_len)');
    expect(safe.code).toBe('22001');
    expect(safe.stack).not.toMatch(/Jane|jane\.sample|Fixture Way/);
  });

  test('a failing scan, raise, close and stale close all log the tag only', async () => {
    mockRows.push(item(ID(1), { expires_on: '2026-11-04', label: SECRET }));
    raiseAdminAlert.mockRejectedValueOnce(dbError());
    episodes.openAdminAlertKeys.mockResolvedValueOnce([keyFor({ id: ID(7) })]);
    episodes.closeAdminAlertKeys.mockRejectedValue(dbError());
    mockFresh.set(ID(7), undefined);
    await runBidKitExpiryCheck({ now: NOW });
    store.listItems.mockRejectedValueOnce(dbError());
    await runBidKitExpiryCheck({ now: NOW });
    await syncExpiryBell(present(item(ID(1), { expires_on: '2027-10-01', label: SECRET })), { now: NOW });
    expect(logger.warn).toHaveBeenCalled();
    expect(logged()).not.toMatch(/Jane|jane\.sample|Fixture Way|insert into|bid_kit_items\\?"/);
    expect(logged()).toContain('22001');
  });
});

describe('the daily ring budget (docs/admin-notifications.md rule 3)', () => {
  const MANY = (n) => Array.from({ length: n }, (_, i) => item(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, {
    label: `Paper ${String.fromCharCode(65 + i)}`, expires_on: `2026-10-${String(10 + i).padStart(2, '0')}`, // a different, past or near date for each
  }));
  const bellCalls = () => raiseAdminAlert.mock.calls.filter(([, , , opts]) => !opts.dedupeKey.startsWith(OVERFLOW_KEY));
  const standingCalls = () => raiseAdminAlert.mock.calls.filter(([, , , opts]) => opts.dedupeKey.startsWith(OVERFLOW_KEY));
  const { OVERFLOW_KEY, MAX_NEW_BELLS } = require('../services/bid-kit-expiry');

  test('12 due items: three bells, expired first then soonest, and one quiet standing row that counts the other nine', async () => {
    mockRows.push(...MANY(12));
    const result = await runBidKitExpiryCheck({ now: NOW });
    expect(MAX_NEW_BELLS).toBe(3);
    expect(result).toEqual({ scanned: 12, rang: 3, closed: 0, overflow: 9 });
    expect(bellCalls().map(([, , , opts]) => opts.metadata.subject.id)).toEqual(MANY(3).map((row) => row.id));
    const standing = standingCalls();
    expect(standing).toHaveLength(1);
    const [category, headline, why, opts] = standing[0];
    expect(category).toBe('system');
    expect(headline).toBe('Estimates — renew 9 more bid papers');
    expect(why).toBe('9 more papers expire within 30 days; the full list is under Show full text.');
    expect(opts).toMatchObject({ bell: true, refreshOnDedupe: true, link: '/admin/bid-kit' }); // admitted by the bell policy, kept off the bell by feed: 'activity'
    expect(opts.metadata).toMatchObject({ count: 9, feed: 'activity', quiet: true, doneWhen: 'count_zero', severity: 'needs-you' });
    expect(opts.metadata.itemKeys).toHaveLength(9);
    expect(opts.ringOnRefresh({}, {})).toBe(false); // a changed count is rewritten quietly, never rung
    // The standing row names each waiting paper by its catalog name and date; the three with bells are not in it.
    expect([...opts.metadata.itemKeys].sort()).toEqual(MANY(12).slice(3).map((row) => row.id).sort());
    for (const day of ['Oct 13', 'Oct 17', 'Oct 21']) expect(opts.detail).toContain(day);
    for (const day of ['Oct 10', 'Oct 11', 'Oct 12']) expect(opts.detail).not.toContain(day);
    expect(() => composeAdminAlert({ area: 'Estimates', action: 'renew 9 more bid papers', why, severity: 'needs-you', link: '/admin/bid-kit', subject: { type: 'check', id: 'x' }, doneWhen: 'count_zero', who: 'person' })).not.toThrow();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('after the first three are renewed the next run raises the next three, and the count shrinks', async () => {
    const all = MANY(12);
    mockRows.push(...all.slice(3)); // the first three were renewed
    episodes.openAdminAlertKeys.mockResolvedValue([OVERFLOW_KEY]); // their bells are closed; the standing row is open
    const result = await runBidKitExpiryCheck({ now: NOW });
    expect(result).toEqual({ scanned: 9, rang: 3, closed: 0, overflow: 6 });
    expect(bellCalls().map(([, , , opts]) => opts.metadata.subject.id)).toEqual(all.slice(3, 6).map((row) => row.id));
    expect(standingCalls()[0][3].metadata.count).toBe(6);
  });

  test('an item that already has an open bell is not counted as overflow and never uses the budget', async () => {
    const all = MANY(6);
    mockRows.push(...all);
    episodes.openAdminAlertKeys.mockResolvedValue(all.slice(0, 3).map(keyFor)); // three bells stand from earlier runs
    raiseAdminAlert.mockImplementation(async (c, h, w, opts) => (opts.dedupeKey && all.slice(0, 3).some((row) => keyFor(row) === opts.dedupeKey)
      ? { id: 'n0', deduped: true, rang: false } : { id: 'n1', deduped: false, rang: true }));
    const result = await runBidKitExpiryCheck({ now: NOW });
    expect(result).toEqual({ scanned: 6, rang: 3, closed: 0, overflow: 0 });
    expect(standingCalls()).toHaveLength(0);
  });

  test('past the budget, an item with an open bell still has its words refreshed, quietly, onto its standing row', async () => {
    const all = MANY(6);
    mockRows.push(...all);
    const holders = all.slice(3).map(keyFor); // the three least urgent already have bells
    episodes.openAdminAlertKeys.mockResolvedValue(holders);
    raiseAdminAlert.mockImplementation(async (c, h, w, opts) => (holders.includes(opts.dedupeKey)
      ? { id: 'n0', deduped: true, refreshed: true, rung: false, rang: false } : { id: 'n1', deduped: false, rang: true }));
    const result = await runBidKitExpiryCheck({ now: NOW });
    expect(result).toEqual({ scanned: 6, rang: 3, closed: 0, overflow: 0 });
    const calls = bellCalls();
    expect(calls.map(([, , , opts]) => opts.dedupeKey)).toEqual(all.map(keyFor));
    for (const [, , , opts] of calls.slice(3)) {
      expect(opts.dedupeWindowMs).toBeUndefined(); // onto the standing row whatever its age: never a new row
      expect(opts.refreshOnDedupe).toBe(true);
      expect(opts.ringOnRefresh({}, {})).toBe(false);
    }
    expect(standingCalls()).toHaveLength(0);
  });

  test('past the budget, an item whose bell closed meanwhile is not raised at all', async () => {
    const all = MANY(4);
    mockRows.push(...all);
    episodes.openAdminAlertKeys
      .mockResolvedValueOnce([keyFor(all[3])]) // the run sees the fourth item's bell open...
      .mockResolvedValue([]); // ...but it is closed when the item's lock is taken
    raiseAdminAlert.mockImplementation(async () => ({ id: 'n1', deduped: false, rang: true }));
    const result = await runBidKitExpiryCheck({ now: NOW });
    expect(result).toEqual({ scanned: 4, rang: 3, closed: 0, overflow: 0 });
    expect(bellCalls()).toHaveLength(3);
  });

  test('the standing row closes when the overflow reaches zero, and nothing closes while no standing row is open', async () => {
    mockRows.push(...MANY(2));
    episodes.openAdminAlertKeys.mockResolvedValue([OVERFLOW_KEY]);
    episodes.openAdminAlertMetadata.mockResolvedValue([{ dedupeKey: OVERFLOW_KEY, itemKeys: [ID(8)] }]); // as read under the lock
    episodes.closeAdminAlertKeys.mockResolvedValue(1);
    expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 2, rang: 2, closed: 0, overflow: 0 });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(trx, [OVERFLOW_KEY], 'count_zero', expect.objectContaining({ resolution: expect.any(String) }));
    expect(standingCalls()).toHaveLength(0);
    episodes.closeAdminAlertKeys.mockClear();
    episodes.openAdminAlertKeys.mockResolvedValue([]);
    episodes.openAdminAlertMetadata.mockResolvedValue([]);
    await runBidKitExpiryCheck({ now: NOW });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('an overflow paper renewed after the snapshot is not listed: the count is decided from rows read under its lock', async () => {
    const all = MANY(5);
    mockRows.push(...all);
    present({ ...all[3], expires_on: '2027-10-01' }); // renewed between the daily snapshot and the count's lock
    const result = await runBidKitExpiryCheck({ now: NOW });
    expect(result).toEqual({ scanned: 5, rang: 3, closed: 0, overflow: 1 });
    expect(episodes.openAdminAlertMetadata).toHaveBeenCalledWith(trx, OVERFLOW_KEY); // read under the lock
    expect(standingCalls()[0][3].metadata).toMatchObject({ count: 1, itemKeys: [all[4].id] });
  });

  test('a save refresh whose item left the list meanwhile writes nothing', async () => {
    episodes.openAdminAlertMetadata
      .mockResolvedValueOnce([{ dedupeKey: OVERFLOW_KEY, itemKeys: [ID(1)] }]) // the cheap look outside the lock lists it...
      .mockResolvedValue([{ dedupeKey: OVERFLOW_KEY, itemKeys: [ID(2)] }]); // ...but under the lock another refresh removed it
    await syncExpiryBell(present(item(ID(1), { expires_on: '2027-10-01' })), { now: NOW });
    expect(standingCalls()).toHaveLength(0);
    expect(episodes.closeAdminAlertKeys.mock.calls.flatMap(([, keys]) => keys)).not.toContain(OVERFLOW_KEY);
  });

  test('a paper with no bell whose raise failed stays in the standing count instead of being dropped', async () => {
    const all = MANY(2);
    mockRows.push(...all);
    episodes.openAdminAlertKeys.mockResolvedValue([OVERFLOW_KEY]); // it was listed in the standing count
    episodes.openAdminAlertMetadata.mockResolvedValue([{ dedupeKey: OVERFLOW_KEY, itemKeys: [all[0].id] }]);
    raiseAdminAlert.mockImplementation(async (c, h, w, opts) => {
      if (opts.dedupeKey === keyFor(all[0])) throw new Error('notifications down');
      return { id: 'n1', deduped: false, rang: true };
    });
    const result = await runBidKitExpiryCheck({ now: NOW });
    expect(result).toMatchObject({ rang: 1, overflow: 1 });
    expect(standingCalls()[0][3].metadata).toMatchObject({ count: 1, itemKeys: [all[0].id] });
    expect(episodes.closeAdminAlertKeys.mock.calls.flatMap(([, keys]) => keys)).not.toContain(OVERFLOW_KEY);
  });

  test('a count that closed at zero comes back as a new quiet row under a new key, never a reopened (rung) one', async () => {
    mockRows.push(...MANY(5));
    await runBidKitExpiryCheck({ now: NOW }); // no standing count is open
    const first = standingCalls()[0][3];
    expect(first.dedupeKey).toMatch(/^bid-kit:expiry-overflow:[0-9a-f-]{36}$/);
    expect(first.metadata).toMatchObject({ feed: 'activity', quiet: true });
    raiseAdminAlert.mockClear();
    episodes.openAdminAlertKeys.mockResolvedValue([first.dedupeKey]);
    episodes.openAdminAlertMetadata.mockResolvedValue([{ dedupeKey: first.dedupeKey, itemKeys: first.metadata.itemKeys }]);
    await runBidKitExpiryCheck({ now: NOW }); // while it stands, the same row is rewritten
    expect(standingCalls()[0][3].dedupeKey).toBe(first.dedupeKey);
    raiseAdminAlert.mockClear();
    episodes.openAdminAlertKeys.mockResolvedValue([]); // closed at zero (auto-cleared rows are not open)
    episodes.openAdminAlertMetadata.mockResolvedValue([]);
    await runBidKitExpiryCheck({ now: NOW });
    const next = standingCalls()[0][3].dedupeKey;
    expect(next).toMatch(/^bid-kit:expiry-overflow:[0-9a-f-]{36}$/);
    expect(next).not.toBe(first.dedupeKey);
  });

  test('the standing row is not an item bell: the stale-bell sweep never closes it', async () => {
    mockRows.push(...MANY(1));
    episodes.openAdminAlertKeys.mockResolvedValue([OVERFLOW_KEY, keyFor({ id: ID(9) })]);
    episodes.openAdminAlertMetadata.mockResolvedValue([{ dedupeKey: OVERFLOW_KEY, itemKeys: [ID(8)] }]);
    await runBidKitExpiryCheck({ now: NOW });
    const closed = episodes.closeAdminAlertKeys.mock.calls.flatMap(([, keys]) => keys);
    expect(closed.filter((key) => key === OVERFLOW_KEY)).toHaveLength(1); // closed once, as the standing row, never as a stale item bell
    expect(closed).toContain(keyFor({ id: ID(9) })); // the stale item bell still closes through its own path
  });
});
