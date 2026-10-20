// Real node-cron, real timers: a busy event loop that spans a task's whole
// matching second. Without recoverMissedExecutions node-cron 3 drops that
// tick silently (the 2026-10-18 4:00 AM ET geo-grid scan); the
// scheduled-cron wrapper turns recovery on, so the tick fires late, once.
const nodeCron = jest.requireActual('node-cron');
const scheduledCron = require('../utils/scheduled-cron');

function blockUntil(ms) {
  while (Date.now() < ms) { /* hold the event loop, like a top-of-hour herd */ }
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('scheduled-cron missed-tick recovery', () => {
  jest.setTimeout(15000);

  async function firesAcrossBlockedSecond(scheduleFn) {
    // Let the task take its first once-a-second checks before the block.
    const targetSecond = Math.floor(Date.now() / 1000) + 3;
    let fired = 0;
    const task = scheduleFn(`${targetSecond % 60} * * * * *`, () => { fired += 1; }, { timezone: 'UTC' });
    try {
      await settle(targetSecond * 1000 - Date.now() - 600);
      // A slow runner that wakes inside the matching second cannot prove
      // anything either way: fail loudly instead of passing by accident.
      expect(Date.now()).toBeLessThan(targetSecond * 1000 - 50);
      blockUntil(targetSecond * 1000 + 1400); // the whole matching second passes blocked
      await settle(2500);
      return fired;
    } finally {
      task.stop();
    }
  }

  test('plain node-cron drops the tick when the loop is blocked through its second', async () => {
    expect(await firesAcrossBlockedSecond(nodeCron.schedule)).toBe(0);
  });

  test('the scheduled-cron wrapper fires that tick late, exactly once', async () => {
    expect(await firesAcrossBlockedSecond(scheduledCron.schedule)).toBe(1);
  });

  test('a caller option still wins over the recovery default', () => {
    const spy = jest.spyOn(nodeCron, 'schedule').mockReturnValue({ stop() {} });
    try {
      scheduledCron.schedule('0 4 * * *', () => {}, { timezone: 'America/New_York', recoverMissedExecutions: false });
      expect(spy.mock.calls[0][2]).toEqual({ recoverMissedExecutions: false, timezone: 'America/New_York' });
    } finally {
      spy.mockRestore();
    }
  });
});
