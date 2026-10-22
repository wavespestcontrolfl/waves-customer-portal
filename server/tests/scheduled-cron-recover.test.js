// node-cron 3 drops a tick when a busy event loop covers its whole matching
// second (the 2026-10-18 4:00 AM ET geo-grid scan). The scheduled-cron
// wrapper turns recovery on, and skips a replay that is too late or that
// crossed its calendar day, so a date-scoped body never runs for the wrong
// period.
const nodeCron = jest.requireActual('node-cron');
const scheduledCron = require('../utils/scheduled-cron');

// The matched time node-cron passes for a task in `timeZone`: that zone's
// wall clock re-read as a server-local Date (TimeMatcher.apply).
function zoneWallClock(instant, timeZone) {
  return new Date(new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', fractionalSecondDigits: 3, timeZone,
  }).format(instant));
}

describe('scheduled-cron replay guard', () => {
  const TZ = 'America/New_York';
  let spy;
  let body;
  let tick;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    spy = jest.spyOn(nodeCron, 'schedule').mockReturnValue({ stop() {} });
    body = jest.fn();
    scheduledCron.schedule('50 23 * * *', body, { timezone: TZ });
    tick = spy.mock.calls.at(-1)[1];
  });

  afterEach(() => {
    spy.mockRestore();
    jest.useRealTimers();
  });

  test('registers with recovery on by default', () => {
    expect(spy.mock.calls.at(-1)[2]).toEqual({ recoverMissedExecutions: true, timezone: TZ });
  });

  test('an on-time tick and a replay a few seconds late both run', () => {
    const matched = new Date('2026-10-31T03:50:00.000Z'); // 23:50 ET
    jest.setSystemTime(new Date(matched.getTime() + 300));
    tick(zoneWallClock(matched, TZ));
    jest.setSystemTime(new Date(matched.getTime() + 8000));
    tick(zoneWallClock(matched, TZ));
    expect(body).toHaveBeenCalledTimes(2);
  });

  test('a replay over the age limit is skipped', () => {
    const matched = new Date('2026-10-31T03:50:00.000Z');
    jest.setSystemTime(new Date(matched.getTime() + scheduledCron.REPLAY_MAX_LATE_MS + 1000));
    tick(zoneWallClock(matched, TZ));
    expect(body).not.toHaveBeenCalled();
  });

  test('a replay that crossed midnight in the task timezone is skipped', () => {
    const matched = new Date('2026-11-01T03:59:50.000Z'); // 23:59:50 ET Oct 31
    jest.setSystemTime(new Date(matched.getTime() + 20 * 1000)); // 00:00:10 ET Nov 1
    tick(zoneWallClock(matched, TZ));
    expect(body).not.toHaveBeenCalled();
  });

  test('a late replay across the November DST fallback is skipped', () => {
    const matched = new Date('2026-11-01T05:50:00.000Z'); // 01:50 EDT
    jest.setSystemTime(new Date('2026-11-01T06:05:00.000Z')); // 01:05 EST, 15 min later
    tick(zoneWallClock(matched, TZ));
    expect(body).not.toHaveBeenCalled();
  });

  test('a manual run (no matched time) still runs', () => {
    tick('manual');
    expect(body).toHaveBeenCalledTimes(1);
  });

  test('a caller option still wins over the recovery default', () => {
    scheduledCron.schedule('0 4 * * *', () => {}, { timezone: TZ, recoverMissedExecutions: false });
    expect(spy.mock.calls.at(-1)[2]).toEqual({ recoverMissedExecutions: false, timezone: TZ });
  });
});

// Real node-cron, real timers: block the event loop through one matching
// second. A runner that wakes too late to set up the block retries with a
// fresh second instead of failing.
describe('scheduled-cron recovery with real node-cron', () => {
  jest.setTimeout(40000);

  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  async function firesAcrossBlockedSecond(scheduleFn) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const targetSecond = Math.floor(Date.now() / 1000) + 3;
      let fired = 0;
      const task = scheduleFn(`${targetSecond % 60} * * * * *`, () => { fired += 1; }, { timezone: 'UTC' });
      try {
        await settle(targetSecond * 1000 - Date.now() - 600);
        if (Date.now() >= targetSecond * 1000 - 50) continue; // woke too late: fresh target
        while (Date.now() < targetSecond * 1000 + 1400) { /* hold the event loop */ }
        await settle(2500);
        return fired;
      } finally {
        task.stop();
      }
    }
    throw new Error('runner never woke early enough to block a whole second');
  }

  test('plain node-cron drops the tick', async () => {
    expect(await firesAcrossBlockedSecond(nodeCron.schedule)).toBe(0);
  });

  test('the wrapper fires that tick late, exactly once', async () => {
    expect(await firesAcrossBlockedSecond(scheduledCron.schedule)).toBe(1);
  });
});
