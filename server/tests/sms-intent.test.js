const { hasSchedulingIntent, isSmsReaction, hasRescheduleOrAwayIntent } = require('../services/sms-intent');

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

  // Regression (2026-08-11): every appointment template is multi-line, so the
  // quoted body of a tapback on one spans newlines. `.` does not match \n —
  // the reaction read as prose and its quoted "Reschedule here:" line raised
  // a reschedule flag + owner bell against a still-armed visit.
  test('detects tapbacks quoting a multi-line message', () => {
    const reminder = 'Hello there! Your Quarterly Pest Control Service is this Thursday, between 2:00 PM and 4:00 PM.\n\nReschedule here: https://wav.es/ab12c';
    const tapback = `Liked “${reminder}”`;
    expect(isSmsReaction(tapback)).toBe(true);
    expect(hasRescheduleOrAwayIntent(tapback)).toBe(false);

    expect(isSmsReaction('Removed a like from "Reminder: your service is tomorrow.\n\nReschedule here: https://wav.es/ab12c"')).toBe(true);
  });

  // The reaction gate must not swallow a real ask that merely follows a
  // quote — only a whole-message reaction counts.
  test('a genuine reschedule ask after a quote is still an ask', () => {
    const body = 'Liked “Your service is Thursday”\n\nActually, can we reschedule to Friday?';
    expect(isSmsReaction(body)).toBe(false);
    expect(hasRescheduleOrAwayIntent(body)).toBe(true);
  });
});
