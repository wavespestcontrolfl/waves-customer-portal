// Cash forecast low-week bell (owner 2026-11-04 D4 A): which weeks are low, the one standing bell built from
// them (copy passes the admin notification rule and carries no money figure), when a refresh rings, when the
// line cannot be judged, and the close when no week is low. Synthetic numbers only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  cashForecastLive: jest.fn(() => true),
  alertEpisodesLive: jest.fn(() => true),
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', deduped: false, rang: true })),
  closeAdminAlertKeys: jest.fn(async () => 0),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'n2', deduped: false })),
}));

const gates = require('../config/feature-gates');
const episodes = require('../services/admin-alert-episodes');
const NotificationService = require('../services/notification-service');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const Bell = require('../services/cash-forecast/low-week-bell');

const { lowWeeks, composeLowWeeks, ringOnNewWeek } = Bell._private;

const week = (start, expected) => ({ week_start: start, end_booked: expected - 900, end_expected: expected });
const forecast = (over = {}) => ({
  opening: { bank_usd: 9000, partial: false },
  expected_available: true,
  weeks: [week('2026-11-02', 8000), week('2026-11-09', 6100), week('2026-12-14', 5400), week('2026-12-21', 4300)],
  settings: { floor_cents: 550000 },
  ...over,
});
const run = (f, opts = {}) => Bell.runCashForecastLowWeek({ database: jest.fn(), load: async () => f, ...opts });

beforeEach(() => {
  jest.clearAllMocks();
  gates.cashForecastLive.mockReturnValue(true);
  gates.alertEpisodesLive.mockReturnValue(true);
});

describe('which weeks are low', () => {
  test('a week whose end on the expected line is under the floor; the booked-only line never decides', () => {
    expect(lowWeeks(forecast(), 5500)).toEqual(['2026-12-14', '2026-12-21']);
    expect(lowWeeks(forecast(), 5400)).toEqual(['2026-12-21']); // at the floor is not below it
  });
});

describe('the bell', () => {
  test('one week: names it; several: the count and the first; never a money figure', () => {
    const one = composeLowWeeks(['2026-12-14']);
    const alert = composeAdminAlert(one.spec);
    expect(alert.headline).toBe('Billing — check the low week on the cash forecast');
    expect(alert.why).toBe('The week of Dec 14 ends below your floor on the expected line.');
    const two = composeAdminAlert(composeLowWeeks(['2026-12-14', '2026-12-21']).spec);
    expect(two.why).toBe('2 weeks ahead end below your floor on the expected line, the first the week of Dec 14.');
    for (const text of [alert.headline, alert.why, two.why, one.detail]) expect(text).not.toMatch(/\$|\d{4,}/);
    expect(one.spec).toMatchObject({ severity: 'needs-you', who: 'person', link: '/admin/banking?tab=forecast', doneWhen: 'no_low_week' });
  });

  test('raised as an owner-only standing row keyed on the low weeks', async () => {
    const result = await run(forecast());
    expect(result).toEqual({ count: 2, outcome: 'raised' });
    const [category, , , opts] = episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect(category).toBe('billing');
    expect(opts).toMatchObject({
      dedupeKey: 'cash-forecast-low-week', bellDefault: true, refreshOnDedupe: true, bumpOnRefresh: true,
      metadata: expect.objectContaining({ itemKeys: ['2026-12-14', '2026-12-21'], count: 2, ownerOnly: true }),
    });
  });

  test('a refresh rings only when a week joins the low list', () => {
    const ring = ringOnNewWeek(['2026-12-14', '2026-12-21']);
    expect(ring({}, { itemKeys: ['2026-12-14', '2026-12-21'] })).toBe(false); // the same weeks: refreshed quietly
    expect(ring({}, { itemKeys: ['2026-12-14'] })).toBe(true); // Dec 21 is new
    expect(ring({}, {})).toBe(true);
  });

  test('with the episode gate off, the plain raise writes the row', async () => {
    gates.alertEpisodesLive.mockReturnValue(false);
    expect(await run(forecast())).toEqual({ count: 2, outcome: 'raised' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });
});

describe('when the line cannot be judged', () => {
  test('no floor or no expected line: nothing can be below the floor, so an open row closes', async () => {
    episodes.closeAdminAlertKeys.mockResolvedValueOnce(1);
    expect(await run(forecast({ settings: { floor_cents: null } }))).toEqual({ count: 0, outcome: 'closed', reason: 'no_floor' });
    expect(episodes.closeAdminAlertKeys).toHaveBeenLastCalledWith(expect.anything(), ['cash-forecast-low-week'], 'no_low_week',
      { resolution: 'No floor is set on the cash forecast' });
    expect(await run(forecast({ expected_available: false }))).toEqual({ count: 0, outcome: 'not_judged', reason: 'no_expected_line' });
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });

  test('a balance not read, or read in part: no proof either way, so the row is left as it is', async () => {
    for (const opening of [{ bank_usd: null, partial: true }, { bank_usd: 4000, partial: true }]) {
      expect(await run(forecast({ opening }))).toEqual({ count: 0, outcome: 'not_judged', reason: 'balance_unread' });
    }
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });
});

describe('the close and the gate', () => {
  test('no week below the floor: the row closes itself', async () => {
    episodes.closeAdminAlertKeys.mockResolvedValueOnce(1);
    expect(await run(forecast({ settings: { floor_cents: 300000 } }))).toEqual({ count: 0, outcome: 'closed' });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), ['cash-forecast-low-week'], 'no_low_week',
      { resolution: 'No week ahead ends below your floor' });
  });

  test('gate off: nothing is read', async () => {
    gates.cashForecastLive.mockReturnValue(false);
    const load = jest.fn();
    expect(await run(forecast(), { load })).toEqual({ skipped: 'disabled' });
    expect(load).not.toHaveBeenCalled();
  });

  test('a failed forecast read throws and never closes the row', async () => {
    await expect(Bell.runCashForecastLowWeek({ database: jest.fn(), load: async () => { throw new Error('read failed'); } })).rejects.toThrow('read failed');
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});
