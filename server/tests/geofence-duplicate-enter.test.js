// isDuplicateEnter() defines the duplicate-ENTER cooldown. A suppressed
// drive-past (logged as 'arrival_suppressed_other_job') leaves the arrival SMS
// pending and MUST NOT count as a duplicate — otherwise the tech's real arrival
// within the window is dropped and the text never sends. Lock the dedup set.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const matcher = require('../services/geofence-matcher');

function chain(result) {
  return {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(result),
  };
}

describe('isDuplicateEnter dedup window', () => {
  test('dedups the timer/reminder actions but ignores a suppressed drive-past', async () => {
    const c = chain(null);
    db.mockReturnValue(c);

    await matcher.isDuplicateEnter('tech-1', 'cust-1', 15);

    const dedupActions = c.whereIn.mock.calls[0][1];
    expect(dedupActions).toEqual(
      expect.arrayContaining(['timer_started', 'reminder_sent', 'timer_already_running']),
    );
    // The suppressed drive-past action is deliberately NOT a dedup trigger.
    expect(dedupActions).not.toContain('arrival_suppressed_other_job');
  });
});
