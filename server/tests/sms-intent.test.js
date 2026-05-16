const { hasSchedulingIntent, isSmsReaction } = require('../services/sms-intent');

describe('SMS intent helpers', () => {
  test('detects scheduling changes and schedule lookups', () => {
    expect(hasSchedulingIntent('We will not be home on Saturday. Can we schedule for June 2nd?')).toBe(true);
    expect(hasSchedulingIntent("Hey Adam - hope you are staying cool, it's HOT! i'm trying to find out when we are on your schedule next.")).toBe(true);
  });

  test('detects SMS tapback reactions', () => {
    expect(isSmsReaction('Liked \u201cHey Dale, let me digest this when I get a break.\u201d')).toBe(true);
    expect(isSmsReaction('Loved "Thanks for the update"')).toBe(true);
    expect(isSmsReaction('Loved an image')).toBe(true);
    expect(isSmsReaction('Liked a photo')).toBe(true);
    expect(isSmsReaction('Removed a like from "Thanks for the update"')).toBe(true);
    expect(isSmsReaction('Removed an emphasis from "OK"')).toBe(true);
    expect(isSmsReaction('Removed a question mark from "OK"')).toBe(true);
  });

  test('does not treat normal prose as a tapback reaction', () => {
    expect(isSmsReaction('I liked the service today, thank you.')).toBe(false);
    expect(isSmsReaction('Can we schedule for June 2nd?')).toBe(false);
  });
});
