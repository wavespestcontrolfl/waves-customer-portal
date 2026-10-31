/**
 * What the staff pickers say when Google road-time spending is stopped
 * (GATE_PICKER_ROAD_LIMIT_NOTICE, owner 2026-10-29, route-dispatcher audit fix F).
 *
 * What this locks down:
 *  1. Gate off: a refusal records nothing (no `road_limit`), and the month
 *     crossing 80% raises nothing.
 *  2. Gate on: each refusal reason (user day, account day, account month, no
 *     counter) sets the staff line for the request that asked; an allowed
 *     purchase, a request outside any tracked request and a "not a limit"
 *     refusal (no staff user) set none.
 *  3. The month notice: nothing below 80%, one raise at the crossing, none
 *     after it (a second concurrent purchase included), a fresh one next
 *     month, a retry only while the write has not been stored, and a failed
 *     write never refuses a purchase. Its copy obeys docs/admin-notifications.md.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/admin-alert-compose', () => ({ raiseAdminAlert: jest.fn() }));

const { raiseAdminAlert } = require('../services/admin-alert-compose');
const { composeAdminAlert } = jest.requireActual('../services/admin-alert-compose');
const { reserveRoadSpend } = require('../services/scheduling/picker-road-spend');
const notice = require('../services/scheduling/picker-road-limit-notice');

const NOW = new Date('2026-11-12T15:00:00Z'); // 10:00 ET, Nov 12
const NEXT_MONTH = new Date('2026-12-02T15:00:00Z');
const GATE = 'GATE_PICKER_ROAD_LIMIT_NOTICE';

// A transaction double: `earlier` = the account's earlier days this month,
// `rows` = what the upsert returns (account row, then the staff row).
function fakeConn({ earlier = { pro: 0, plain: 0 }, rows, fail } = {}) {
  const trx = () => {
    const q = { where: () => q, sum: () => q, first: async () => earlier };
    return q;
  };
  trx.raw = async () => {
    if (fail) throw new Error(fail);
    return { rows };
  };
  return { transaction: async (work) => work(trx) };
}
const counted = (accountPro, accountPlain, userPro = accountPro, userPlain = accountPlain) => [
  { bucket: 'all', pro_elements: accountPro, plain_elements: accountPlain },
  { bucket: 'staff:s1', pro_elements: userPro, plain_elements: userPlain },
];

// One tracked find-time request, as the route's middleware scopes it.
async function inRequest(work) {
  const req = {};
  await new Promise((resolve, reject) => {
    notice.trackRoadLimit(req, {}, () => { Promise.resolve().then(work).then(resolve, reject); });
  });
  return notice.roadLimitOf(req);
}

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  notice._test.asked.clear();
  raiseAdminAlert.mockResolvedValue({ id: 7, deduped: false });
  delete process.env[GATE];
  for (const name of ['PICKER_ROAD_DAILY_CAP_CENTS', 'PICKER_ROAD_USER_DAILY_CAP_CENTS', 'PICKER_ROAD_MONTHLY_CAP_CENTS']) delete process.env[name];
});
afterAll(() => { process.env = { ...ENV }; });

describe('the refusal line', () => {
  const refused = [
    ['the staff user\'s day', { PICKER_ROAD_USER_DAILY_CAP_CENTS: '100' }, { rows: counted(80, 0, 101, 0) }, 'user_daily_cap',
      'Google road times paused: your own daily limit reached. Times marked ~ use the estimate.'],
    ['the account\'s day', { PICKER_ROAD_DAILY_CAP_CENTS: '100' }, { rows: counted(101, 0, 80, 0) }, 'daily_cap',
      'Google road times paused: daily limit reached. Times marked ~ use the estimate.'],
    ['the account\'s month', { PICKER_ROAD_MONTHLY_CAP_CENTS: '1000' }, { earlier: { pro: 990, plain: 0 }, rows: counted(11, 0) }, 'monthly_cap',
      'Google road times paused: month limit reached. Times marked ~ use the estimate.'],
    ['no counter (fails closed)', {}, { fail: 'connection refused', rows: [] }, 'counter_unavailable',
      'Google road times paused: the spending counter is unavailable. Times marked ~ use the estimate.'],
  ];

  test.each(refused)('gate on, %s: the request carries the line', async (_name, env, conn, reason, note) => {
    process.env[GATE] = 'true';
    Object.assign(process.env, env);
    let result;
    const roadLimit = await inRequest(async () => { result = await reserveRoadSpend({ spender: 's1', pro: 20, conn: fakeConn(conn), now: NOW }); });
    expect(result).toEqual({ allowed: false, reason });
    expect(roadLimit).toEqual({ reason, note });
  });

  test.each(refused)('gate off, %s: nothing is recorded', async (_name, env, conn, reason) => {
    Object.assign(process.env, env);
    let result;
    const roadLimit = await inRequest(async () => { result = await reserveRoadSpend({ spender: 's1', pro: 20, conn: fakeConn(conn), now: NOW }); });
    expect(result).toEqual({ allowed: false, reason });
    expect(roadLimit).toBeNull();
  });

  test('gate on: a normal purchase, a refusal that is not a limit, and a call outside a request add nothing', async () => {
    process.env[GATE] = 'true';
    let bought;
    expect(await inRequest(async () => { bought = await reserveRoadSpend({ spender: 's1', pro: 5, conn: fakeConn({ rows: counted(5, 0) }), now: NOW }); })).toBeNull();
    expect(bought).toEqual({ allowed: true, day: '2026-11-12' });
    expect(await inRequest(async () => { await reserveRoadSpend({ spender: null, pro: 5, conn: fakeConn({ rows: counted(5, 0) }), now: NOW }); })).toBeNull();
    // No request scope (rain-out, the Intelligence Bar): the refusal still answers, and records nowhere.
    await expect(reserveRoadSpend({ spender: 's1', pro: 20, conn: fakeConn({ fail: 'down', rows: [] }), now: NOW }))
      .resolves.toEqual({ allowed: false, reason: 'counter_unavailable' });
  });

  test('two requests at once keep their own line', async () => {
    process.env[GATE] = 'true';
    process.env.PICKER_ROAD_DAILY_CAP_CENTS = '100';
    const [a, b] = await Promise.all([
      inRequest(async () => { await reserveRoadSpend({ spender: 's1', pro: 20, conn: fakeConn({ rows: counted(101, 0, 80, 0) }), now: NOW }); }),
      inRequest(async () => { await reserveRoadSpend({ spender: 's1', pro: 20, conn: fakeConn({ rows: counted(5, 0) }), now: NOW }); }),
    ]);
    expect(a.reason).toBe('daily_cap');
    expect(b).toBeNull();
  });
});

describe('the 80% month notice', () => {
  // The month cap defaults to $200 = 200,000 tenths of a cent; 80% = 160,000 = 16,000 traffic-aware lookups.
  const buy = (pro, earlierPro, now = NOW) => reserveRoadSpend({
    spender: 's1', pro, now, conn: fakeConn({ earlier: { pro: earlierPro, plain: 0 }, rows: counted(pro, 0) }),
  });

  test('gate off: nothing is raised at 80%, or past it', async () => {
    await expect(buy(10, 16000)).resolves.toEqual({ allowed: true, day: '2026-11-12' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('below 80% raises nothing; the purchase that reaches it raises one, with the spend and the limit', async () => {
    process.env[GATE] = 'true';
    await expect(buy(9, 15990)).resolves.toEqual({ allowed: true, day: '2026-11-12' }); // 159,990 of 160,000
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    await buy(10, 15990); // 160,000
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('system');
    expect(spec).toMatchObject({
      area: 'System', action: 'review the Google road time limit', severity: 'needs-you', who: 'person', doneWhen: 'month_limit_reviewed',
      why: 'Google road times at 80% of the month limit: $160 of $200.',
    });
    expect(opts).toMatchObject({ dedupeKey: 'picker-road-month-80:2026-11', bellDefault: true });
    expect(opts).not.toHaveProperty('refreshOnDedupe');
    // The copy obeys the admin notification rule (headline 60, one sentence, no code words).
    expect(() => composeAdminAlert(spec)).not.toThrow();
  });

  test('later purchases do not raise it again', async () => {
    process.env[GATE] = 'true';
    await buy(10, 16000);
    await buy(10, 16010);
    await buy(10, 17000);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('two purchases at the crossing at once raise it once', async () => {
    process.env[GATE] = 'true';
    let release;
    raiseAdminAlert.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ id: 7 }); }));
    const both = Promise.all([buy(10, 16000), buy(10, 16010)]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await expect(both).resolves.toEqual([{ allowed: true, day: '2026-11-12' }, { allowed: true, day: '2026-11-12' }]);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('a new month raises its own', async () => {
    process.env[GATE] = 'true';
    await buy(10, 16000);
    await buy(10, 16000, NEXT_MONTH);
    expect(raiseAdminAlert.mock.calls.map((call) => call[2].dedupeKey)).toEqual(['picker-road-month-80:2026-11', 'picker-road-month-80:2026-12']);
  });

  test('a write that failed is asked again on the next purchase; a failure never refuses a purchase', async () => {
    process.env[GATE] = 'true';
    raiseAdminAlert.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('db down'));
    await expect(buy(10, 16000)).resolves.toEqual({ allowed: true, day: '2026-11-12' });
    await expect(buy(10, 16010)).resolves.toEqual({ allowed: true, day: '2026-11-12' });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(2);
    await buy(10, 16020);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(3);
    await buy(10, 16030);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(3);
  });

  test('a changed month limit moves the line; cents show when the spend is not whole dollars', async () => {
    process.env[GATE] = 'true';
    process.env.PICKER_ROAD_MONTHLY_CAP_CENTS = '5000';
    await buy(10, 3995); // 40,050 of 50,000: past 80% = 40,000
    expect(raiseAdminAlert.mock.calls[0][1].why).toBe('Google road times at 80% of the month limit: $40.05 of $50.');
  });

  test('a refused purchase raises nothing', async () => {
    process.env[GATE] = 'true';
    process.env.PICKER_ROAD_MONTHLY_CAP_CENTS = '1000';
    await expect(buy(20, 990)).resolves.toEqual({ allowed: false, reason: 'monthly_cap' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });
});
