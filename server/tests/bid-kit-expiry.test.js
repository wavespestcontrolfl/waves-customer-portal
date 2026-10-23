// Bid kit daily expiry check (GATE_BID_KIT): one admin bell per item that expired or expires within 30 days, deduped per
// item for 7 days, admin bell only, nothing at all with the gate off. The store and the bell are stand-ins here
// (the SQL runs in bid-kit.db.test.js); every spec is composed by the real notification rules.
const mockRows = [];
jest.mock('../services/bid-kit-store', () => ({ listItems: jest.fn(async () => mockRows) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(),
}));

const store = require('../services/bid-kit-store');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');
const { runBidKitExpiryCheck, specFor, keyFor, DEDUPE_DAYS } = require('../services/bid-kit-expiry');

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
  raiseAdminAlert.mockImplementation(async (_category, spec) => { composeAdminAlert(spec); return { id: 'n1', deduped: false }; });
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
  expect(result).toEqual({ scanned: 4, rang: 4 });
  expect(raiseAdminAlert.mock.calls.map(([, spec]) => spec.subject.id)).toEqual([ID(1), ID(2), ID(3), ID(8)]);
});

test('each bell is an admin bell, deduped per item for 7 days, and links to the item', async () => {
  mockRows.push(item(ID(1), { expires_on: '2026-11-04' }));
  await runBidKitExpiryCheck({ now: NOW });
  const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
  expect(category).toBe('system');
  expect(opts).toMatchObject({ bell: true, dedupeKey: `bid-kit:expiry:${ID(1)}`, dedupeWindowMs: 7 * 86400000 });
  expect(DEDUPE_DAYS).toBe(7);
  expect(keyFor({ id: ID(1) })).toBe(`bid-kit:expiry:${ID(1)}`);
  expect(spec).toMatchObject({ severity: 'needs-you', who: 'person', link: `/admin/bid-kit?item=${ID(1)}`, subject: { type: 'check', id: ID(1) } });
  expect(spec.action).toBe('renew Certificate of insurance, expires Nov 4');
  expect(spec.why).toBe('Expires Nov 4, in 12 days; bids need a current copy.');
});

test('a bell the dedupe window holds back is not counted as rung', async () => {
  mockRows.push(item(ID(1), { expires_on: '2026-11-04' }));
  raiseAdminAlert.mockResolvedValueOnce({ id: 'n1', deduped: true });
  expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 1, rang: 0 });
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
  expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 2, rang: 1 });
  store.listItems.mockRejectedValueOnce(new Error('db down'));
  expect(await runBidKitExpiryCheck({ now: NOW })).toEqual({ scanned: 0, rang: 0 });
});
