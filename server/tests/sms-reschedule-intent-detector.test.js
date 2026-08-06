const { hasRescheduleOrAwayIntent, hasSchedulingIntent } = require('../services/sms-intent');

// Positive cases are the four real texts from the 2026-08-05 weekly comms
// sweep that the automation ignored (lightly paraphrased, no PII).
describe('hasRescheduleOrAwayIntent', () => {
  test('vacation-departure reschedule ask (the serviced-anyway incident)', () => {
    expect(hasRescheduleOrAwayIntent(
      'Good evening. We are leaving for vacation tomorrow morning. Can we rescheduled for next week? Sorry for the short notice.',
    )).toBe(true);
  });

  test('move-to-month ask with garage access', () => {
    expect(hasRescheduleOrAwayIntent(
      'Hi Adam We won’t be back till November 12. How about moving till late October and I can let you in via garage.',
    )).toBe(true);
  });

  test('away-recovery push ask', () => {
    expect(hasRescheduleOrAwayIntent(
      'She is recovering now and will stay here for another month or 2 so we will need to reschedule again.',
    )).toBe(true);
  });

  test('cancel wording', () => {
    expect(hasRescheduleOrAwayIntent('I need to cancel the appointment for Friday')).toBe(true);
  });

  test('out-of-town without a verb still flags', () => {
    expect(hasRescheduleOrAwayIntent('We are out of town this week')).toBe(true);
  });

  test('skip-this-visit wording', () => {
    expect(hasRescheduleOrAwayIntent('Can we skip this month? Nothing going on pest-wise')).toBe(true);
  });

  // Negatives: ordinary scheduling questions and confirmations must NOT
  // flag — those are hasSchedulingIntent's territory, not a reschedule ask.
  test('timing question does not flag', () => {
    const body = 'What time are you coming tomorrow?';
    expect(hasSchedulingIntent(body)).toBe(true);
    expect(hasRescheduleOrAwayIntent(body)).toBe(false);
  });

  test('confirmation does not flag', () => {
    expect(hasRescheduleOrAwayIntent('Sounds good, see you Saturday!')).toBe(false);
  });

  test('away + access permission is a heads-up, not a reschedule ask', () => {
    expect(hasRescheduleOrAwayIntent('I will not be home but I have a gate code for the left gate: 9618')).toBe(false);
    expect(hasRescheduleOrAwayIntent("I won't be here Saturday but exterior only is fine")).toBe(false);
  });

  test('permission never suppresses an explicit reschedule verb', () => {
    expect(hasRescheduleOrAwayIntent("The gate code is 1234 but actually can we reschedule to next week?")).toBe(true);
  });

  test('bare moving-the-couch does not flag', () => {
    expect(hasRescheduleOrAwayIntent('The guys are moving furniture in the living room')).toBe(false);
  });

  test('reaction and empty bodies do not flag', () => {
    expect(hasRescheduleOrAwayIntent('Liked “Hello! Your service is tomorrow”')).toBe(false);
    expect(hasRescheduleOrAwayIntent('')).toBe(false);
    expect(hasRescheduleOrAwayIntent(null)).toBe(false);
  });

  test('thanks does not flag', () => {
    expect(hasRescheduleOrAwayIntent('Thank you so much!')).toBe(false);
  });
});
