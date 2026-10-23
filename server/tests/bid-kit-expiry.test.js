// Bid kit daily expiry check (GATE_BID_KIT): one admin bell per item that expired or expires within 30 days, deduped per
// item for 7 days, admin bell only, nothing at all with the gate off. The store and the bell are stand-ins here
// (the SQL runs in bid-kit.db.test.js); every spec is composed by the real notification rules.
const mockRows = [];
jest.mock('../services/bid-kit-store', () => ({ listItems: jest.fn(async () => mockRows) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => ({ __db: true }));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(),
  openAdminAlertKeys: jest.fn(),
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
const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;

beforeEach(() => {
  mockRows.length = 0;
  jest.clearAllMocks();
  process.env.GATE_BID_KIT = 'true';
  raiseAdminAlert.mockImplementation(async () => ({ id: 'n1', deduped: false, rang: true }));
  episodes.openAdminAlertKeys.mockResolvedValue([]);
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
  expect(result).toEqual({ scanned: 4, rang: 4, closed: 0 });
  expect(raiseAdminAlert.mock.calls.map(([, , , opts]) => opts.metadata.subject.id)).toEqual([ID(1), ID(2), ID(3), ID(8)]);
});

test('each bell is an admin bell, deduped per item for 7 days, and links to the item', async () => {
  mockRows.push(item(ID(1), { expires_on: '2026-11-04' }));
  await runBidKitExpiryCheck({ now: NOW });
  const [category, headline, why, opts] = raiseAdminAlert.mock.calls[0];
  expect(category).toBe('system');
  expect(opts).toMatchObject({ bell: true, dedupeKey: `bid-kit:expiry:${ID(1)}`, dedupeWindowMs: 7 * 86400000, link: `/admin/bid-kit?item=${ID(1)}` });
  expect(DEDUPE_DAYS).toBe(7);
  expect(keyFor({ id: ID(1) })).toBe(`bid-kit:expiry:${ID(1)}`);
  expect(opts.metadata).toMatchObject({ severity: 'needs-you', who: 'person', subject: { type: 'check', id: ID(1) }, doneWhen: 'item_renewed', bidKitItemId: ID(1) });
  expect(headline).toBe('Estimates — renew Certificate of insurance, expires Nov 4');
  expect(why).toBe('Expires Nov 4, in 12 days; bids need a current copy.');
});

test('a bell the dedupe window holds back is not counted as rung', async () => {
  mockRows.push(item(ID(1), { expires_on: '2026-11-04' }));
  raiseAdminAlert.mockResolvedValueOnce({ id: 'n1', deduped: true, rang: false });
  expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 1, rang: 0, closed: 0 });
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

test('a long custom label still fits the 60-character headline, and a code-shaped label falls back to the catalog name', () => {
  const long = specFor(item(ID(1), { item_key: 'custom', label: 'Sarasota County Schools vendor registration confirmation letter for pest control services', expires_on: '2026-11-04' }), '2026-10-23').spec;
  expect(() => composeAdminAlert(long)).not.toThrow();
  expect(composeAdminAlert(long).headline.length).toBeLessThanOrEqual(60);
  const coded = specFor(item(ID(1), { label: 'coi_final_v2', expires_on: '2026-11-04' }), '2026-10-23').spec;
  expect(() => composeAdminAlert(coded)).not.toThrow();
  expect(coded.action).toContain('Certificate of insurance');
});

test('a failing bell does not stop the rest, and a failing scan does not throw', async () => {
  mockRows.push(item(ID(1), { expires_on: '2026-10-01' }), item(ID(2), { expires_on: '2026-10-02' }));
  raiseAdminAlert.mockRejectedValueOnce(new Error('bell down'));
  expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 2, rang: 1, closed: 0 });
  store.listItems.mockRejectedValueOnce(new Error('db down'));
  expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 0, rang: 0, closed: 0 });
});

describe('bells close when the paper no longer needs renewing', () => {
  const CLEAR = expect.stringContaining('renewed, archived or no longer expires');

  test('the daily job closes the open bell of every item that no longer qualifies, and keeps the ones that do', async () => {
    mockRows.push(
      item(ID(1), { expires_on: '2026-11-04' }), // still inside the window: keeps its bell
      item(ID(2), { expires_on: '2027-10-01' }), // renewed: the date moved out
      item(ID(3), { expires_on: '2026-10-01', has_file: false }), // no longer there
    ); // ID(4) was archived (not listed at all)
    episodes.openAdminAlertKeys.mockResolvedValue([keyFor({ id: ID(1) }), keyFor({ id: ID(2) }), keyFor({ id: ID(3) }), keyFor({ id: ID(4) })]);
    episodes.closeAdminAlertKeys.mockResolvedValue(3);
    const result = await runBidKitExpiryCheck({ now: NOW });
    expect(result).toEqual({ scanned: 1, rang: 1, closed: 3 });
    expect(episodes.openAdminAlertKeys).toHaveBeenCalledWith(db, 'bid-kit:expiry:');
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
    const [conn, keys, reason, opts] = episodes.closeAdminAlertKeys.mock.calls[0];
    expect(conn).toBe(db);
    expect(keys).toEqual([keyFor({ id: ID(2) }), keyFor({ id: ID(3) }), keyFor({ id: ID(4) })]);
    expect(reason).toBe('no_longer_qualifies');
    expect(opts).toEqual({ resolution: CLEAR });
  });

  test('a failure while closing never fails the job or hides what rang', async () => {
    mockRows.push(item(ID(1), { expires_on: '2026-11-04' }));
    episodes.openAdminAlertKeys.mockRejectedValueOnce(new Error('db down'));
    expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 1, rang: 1, closed: 0 });
  });

  test('a renewal (a save that moves the date out of the window) closes that item\'s bell at once', async () => {
    const renewed = await syncExpiryBell(item(ID(1), { expires_on: '2027-10-01' }), { now: NOW });
    expect(renewed).toEqual({ closed: 0 }); // the mock closed nothing, but it was asked
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(db, [keyFor({ id: ID(1) })], 'renewed', { resolution: CLEAR });
  });

  test('an archived item closes its bell, with the archived reason', async () => {
    await syncExpiryBell(item(ID(1), { expires_on: '2026-10-01', archived_at: new Date() }), { now: NOW });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(db, [keyFor({ id: ID(1) })], 'archived', { resolution: CLEAR });
  });

  test('an item that still qualifies keeps its bell (a file replaced while the date is still inside or past the window)', async () => {
    for (const expires_on of ['2026-10-01', '2026-11-04', '2026-11-22']) {
      await syncExpiryBell(item(ID(1), { expires_on }), { now: NOW });
    }
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('with the gate off the save path closes nothing and touches nothing', async () => {
    delete process.env.GATE_BID_KIT;
    expect(await syncExpiryBell(item(ID(1), { expires_on: '2027-10-01' }), { now: NOW })).toEqual({ skipped: 'gate_off' });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a failed close never fails the save', async () => {
    episodes.closeAdminAlertKeys.mockRejectedValueOnce(new Error('db down'));
    expect(await syncExpiryBell(item(ID(1), { expires_on: '2027-10-01' }), { now: NOW })).toEqual({ closed: 0, failed: true });
  });

  test('qualifies is by date: unsigned items count, missing, undated and archived ones do not', () => {
    const today = '2026-10-23';
    expect(qualifies(item(ID(1), { expires_on: '2026-11-04', attested_at: null }), today)).toBe(true);
    expect(qualifies(item(ID(1), { expires_on: '2026-11-04', has_file: false }), today)).toBe(false);
    expect(qualifies(item(ID(1), { expires_on: null }), today)).toBe(false);
    expect(qualifies(item(ID(1), { expires_on: '2026-10-01', archived_at: new Date() }), today)).toBe(false);
  });
});
