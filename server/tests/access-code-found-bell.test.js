// The found-codes bell (owner ruling 2026-10-24): the copy passes the admin
// notification rule and never carries a code, the customer's words or a phone
// number; a refresh rings only when a code joins; an empty list (or the
// section off) closes the row; the gate off reads nothing. The lifecycle
// through the real notification service runs in access-code-found-bell-db.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  accessCodesFoundBellLive: jest.fn(() => true),
  alertEpisodesLive: jest.fn(() => true),
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', deduped: false, rang: true })),
  closeAdminAlertKeys: jest.fn(async () => 0),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'n2', deduped: false })),
}));
jest.mock('../services/access-code-capture', () => ({ enabled: jest.fn(() => true), listFound: jest.fn() }));

const gates = require('../config/feature-gates');
const episodes = require('../services/admin-alert-episodes');
const NotificationService = require('../services/notification-service');
const capture = require('../services/access-code-capture');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const Bell = require('../services/access-code-found-bell');

const { composeFound, ringOnNewCode } = Bell._private;
const NOW = new Date('2026-10-24T14:00:00Z');

// A found row as listFound serializes it, with a code and the client's words
// the copy must never repeat.
const item = (over = {}) => ({
  id: 'f1', customerId: 'cust-1', customerName: 'Pat Synthetic', senderPhone: null, senderEmail: null,
  kind: 'door', code: '4821', instructions: null, life: 'standing', scheduledServiceId: null,
  status: 'found', sourceType: 'sms', sourceQuote: 'Door code is 4821', sourceAt: '2026-10-24T11:16:45.000Z',
  createdAt: '2026-10-24T11:17:00.000Z', suggestedCustomer: null, ...over,
});

function fakeConn() {
  const trx = { raw: jest.fn(async () => ({})) };
  const conn = { transaction: jest.fn(async (fn) => fn(trx)) };
  return { conn, trx };
}

const run = (items, over = {}) => {
  const { conn, trx } = fakeConn();
  const list = jest.fn(async () => ({ total: over.total ?? items.length, items }));
  return { conn, trx, list, result: Bell.syncFoundCodesBell({ now: NOW, conn, gateEnabled: true, sectionOn: true, list, ...over }) };
};

const neverLeaks = (composed) => {
  const text = [composed.spec.action, composed.spec.why, composed.detail].join('\n');
  expect(text).not.toContain('4821');
  expect(text).not.toMatch(/code is/i);
  expect(text).not.toMatch(/\d{3}-\d{4}|\+1\d{10}/);
};

beforeEach(() => {
  jest.clearAllMocks();
  gates.accessCodesFoundBellLive.mockReturnValue(true);
  gates.alertEpisodesLive.mockReturnValue(true);
});

describe('the copy', () => {
  test('one code from a customer names the kind, the customer and the day', () => {
    const composed = composeFound([item()], 1);
    const alert = composeAdminAlert(composed.spec);
    expect(alert.headline).toBe('Customers — review the door code from Pat Synthetic');
    expect(alert.why).toBe('From a text on Oct 24; a technician sees it only after the office saves it.');
    expect(alert.link).toBe('/admin/customers/gate-codes?view=found');
    expect(alert.metadata).toMatchObject({ area: 'Customers', severity: 'needs-you', doneWhen: 'count_zero', who: 'person' });
    expect(composed.itemKeys).toEqual(['f1']);
    neverLeaks(composed);
  });

  test('a code from a number with no customer asks for a link first, and the detail names the suggested home', () => {
    const composed = composeFound([item({
      customerId: null, customerName: null, senderPhone: '+19415550123', kind: 'pass', sourceType: 'call',
      suggestedCustomer: { id: 'cust-9', name: 'Sam Example', address: '1 Sample Way' },
    })], 1);
    const alert = composeAdminAlert(composed.spec);
    expect(alert.headline).toBe('Customers — review a visitor pass from an unknown sender');
    expect(alert.why).toBe('From a call on Oct 24; no customer is linked yet, so link one, then save it.');
    expect(composed.detail).toContain('Visitor pass from an unknown sender (call, Oct 24); the message names a home of Sam Example');
    expect(composed.detail).not.toContain('1 Sample Way');
    expect(composed.detail).not.toContain('5550123');
    neverLeaks(composed);
  });

  test('a one-visit code says to pick the visit', () => {
    const alert = composeAdminAlert(composeFound([item({ life: 'visit', kind: 'call_box', sourceType: 'email' })], 1).spec);
    expect(alert.headline).toBe('Customers — review the call box code from Pat Synthetic');
    expect(alert.why).toBe('From an email on Oct 24; it is for one visit, so pick the visit when you save it.');
  });

  test('several codes are counted, the senders listed once each, the oldest day given', () => {
    const items = [
      item({ id: 'f4', kind: 'garage', customerName: 'Pat Synthetic', sourceAt: '2026-10-24T13:00:00.000Z' }),
      item({ id: 'f3', kind: 'lockbox', customerName: 'Pat Synthetic', sourceAt: '2026-10-24T12:00:00.000Z' }),
      item({ id: 'f2', customerId: null, customerName: null, kind: 'neighborhood_gate', sourceAt: '2026-10-23T15:00:00.000Z' }),
      item({ id: 'f1', customerId: 'cust-2', customerName: 'Kim Sample', sourceAt: '2026-10-22T15:00:00.000Z' }),
    ];
    const composed = composeFound(items, 4);
    const alert = composeAdminAlert(composed.spec);
    expect(alert.headline).toBe('Customers — review 4 codes found in messages');
    expect(alert.why).toBe('From Pat Synthetic, an unknown sender and Kim Sample; the oldest is from Oct 22.');
    expect(composed.itemKeys).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(composed.detail.split('\n')).toEqual([
      '4 codes wait on Customers → Gate codes, Found in messages. A technician sees a code only after the office saves it. Save, dismiss or link each one there.',
      '- Garage code from Pat Synthetic (text, Oct 24)',
      '- Lockbox code from Pat Synthetic (text, Oct 24)',
      '- Gate code from an unknown sender (text, Oct 23)',
      '- Door code from Kim Sample (text, Oct 22)',
    ]);
    neverLeaks(composed);
  });

  test('a list longer than the names the why can hold says how many more, and a capped list says so in the detail', () => {
    const items = ['Avery', 'Blake', 'Casey', 'Devon', 'Emery'].map((first, i) => item({ id: `f${i}`, customerId: `c${i}`, customerName: `${first} Synthetic` }));
    const composed = composeFound(items, 7);
    expect(composeAdminAlert(composed.spec).why).toBe('From Avery Synthetic, Blake Synthetic, Casey Synthetic and 2 more; the oldest is from Oct 24.');
    expect(composed.spec.action).toBe('review 7 codes found in messages');
    expect(composed.detail.split('\n').at(-1)).toBe('- and 2 more');
  });

  test('long or code-shaped names still pass the rule', () => {
    const long = 'Bartholomew-Alexander Montgomery_Worthington-Smythe the.Third';
    expect(() => composeAdminAlert(composeFound([item({ customerName: long })], 1).spec)).not.toThrow();
    const many = Array.from({ length: 3 }, (_, i) => item({ id: `f${i}`, customerId: `c${i}`, customerName: `${long} ${i}` }));
    expect(() => composeAdminAlert(composeFound(many, 3).spec)).not.toThrow();
    expect(composeAdminAlert(composeFound(many, 3).spec).why.length).toBeLessThanOrEqual(110);
  });
});

describe('when a refresh rings', () => {
  test('a code that joins rings; a code that leaves, or the same list, is quiet', () => {
    expect(ringOnNewCode(['f1', 'f2'])(null, { itemKeys: ['f1'] })).toBe(true);
    expect(ringOnNewCode(['f1'])(null, { itemKeys: ['f1', 'f2'] })).toBe(false);
    expect(ringOnNewCode(['f1', 'f2'])(null, { itemKeys: ['f2', 'f1'] })).toBe(false);
    expect(ringOnNewCode(['f1'])(null, {})).toBe(true);
  });
});

describe('syncFoundCodesBell', () => {
  test('the gate off reads nothing and writes nothing', async () => {
    gates.accessCodesFoundBellLive.mockReturnValue(false);
    const { conn } = fakeConn();
    await expect(Bell.syncFoundCodesBell({ now: NOW, conn })).resolves.toEqual({ skipped: 'disabled' });
    expect(conn.transaction).not.toHaveBeenCalled();
    expect(capture.listFound).not.toHaveBeenCalled();
  });

  test('waiting codes raise one row under the lock, through the reopen helper, with its item keys and count', async () => {
    const { trx, list, result } = run([item({ id: 'f2' }), item({ id: 'f1' })]);
    await expect(result).resolves.toEqual({ count: 2, outcome: 'raised' });
    expect(trx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['admin:access-codes-found']);
    expect(trx.raw.mock.invocationCallOrder[0]).toBeLessThan(list.mock.invocationCallOrder[0]);
    expect(list).toHaveBeenCalledWith(trx, { limit: 50, offset: 0 });
    const [category, title, why, opts] = episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect(category).toBe('access_codes');
    expect(title).toBe('Customers — review 2 codes found in messages');
    expect(why).toBe('From Pat Synthetic; the oldest is from Oct 24.');
    expect(opts).toMatchObject({
      dedupeKey: 'access-codes-found', trx, refreshOnDedupe: true, bumpOnRefresh: true,
      link: '/admin/customers/gate-codes?view=found',
      metadata: { itemKeys: ['f1', 'f2'], count: 2, area: 'Customers', severity: 'needs-you', doneWhen: 'count_zero', who: 'person' },
    });
    expect(opts.ringOnRefresh(null, { itemKeys: ['f1'] })).toBe(true);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('the count is the whole list, not only the codes the row names', async () => {
    const { result } = run([item({ id: 'f1' })], { total: 3 });
    await expect(result).resolves.toMatchObject({ count: 3 });
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[0][1]).toBe('Customers — review 3 codes found in messages');
  });

  test('an empty list closes the row done', async () => {
    episodes.closeAdminAlertKeys.mockResolvedValueOnce(1);
    const { trx, result } = run([]);
    await expect(result).resolves.toEqual({ count: 0, outcome: 'closed' });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(trx, ['access-codes-found'], 'count_zero', { now: NOW, resolution: 'No codes are waiting' });
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });

  test('with nothing open, an empty list is clear', async () => {
    await expect(run([]).result).resolves.toEqual({ count: 0, outcome: 'clear' });
  });

  test('the access codes section off closes the row without reading the list', async () => {
    const { list, result } = run([item()], { sectionOn: false });
    await expect(result).resolves.toEqual({ count: 0, outcome: 'clear' });
    expect(list).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys.mock.calls[0][2]).toBe('section_off');
  });

  test('a quiet refresh, a ringing refresh, a plain dedupe and a silenced category each report their outcome', async () => {
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ deduped: true, refreshed: true, rung: false });
    await expect(run([item()]).result).resolves.toMatchObject({ outcome: 'refreshed' });
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ deduped: true, refreshed: true, rung: true });
    await expect(run([item()]).result).resolves.toMatchObject({ outcome: 'raised' });
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ deduped: true });
    await expect(run([item()]).result).resolves.toMatchObject({ outcome: 'unchanged' });
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ suppressed: true, deduped: true });
    await expect(run([item()]).result).resolves.toMatchObject({ outcome: 'suppressed' });
  });

  test('a row that was not written fails the run', async () => {
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce(null);
    await expect(run([item()]).result).rejects.toThrow('found codes bell was not written');
  });

  test('with alert episodes off it raises through the plain alert path and never closes', async () => {
    gates.alertEpisodesLive.mockReturnValue(false);
    const { trx, result } = run([item()]);
    await expect(result).resolves.toMatchObject({ count: 1, outcome: 'raised' });
    const [category, title, , opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect([category, title]).toEqual(['access_codes', 'Customers — review the door code from Pat Synthetic']);
    expect(opts).toMatchObject({ dedupeKey: 'access-codes-found', trx, refreshOnDedupe: true });
    await expect(run([]).result).resolves.toEqual({ count: 0, outcome: 'clear' });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('by default it reads the Gate codes page list and its section gate', async () => {
    capture.listFound.mockResolvedValueOnce({ total: 1, items: [item()] });
    const { conn, trx } = fakeConn();
    await expect(Bell.syncFoundCodesBell({ now: NOW, conn })).resolves.toMatchObject({ count: 1, outcome: 'raised' });
    expect(capture.enabled).toHaveBeenCalled();
    expect(capture.listFound).toHaveBeenCalledWith(trx, { limit: 50, offset: 0 });
  });
});
