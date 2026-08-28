const { hasSchedulingIntent, isSmsReaction, isCourtesyOnly, hasRescheduleOrAwayIntent } = require('../services/sms-intent');

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
  // quote — only a whole-message reaction counts. The second case is the one
  // a greedy `.+` misses (Codex #3346 P1): the trailing ask ENDS in a quote,
  // so an unbounded match runs from the first opening delimiter to the last
  // closing one and the whole message reads as a reaction.
  test('a genuine reschedule ask after a quote is still an ask', () => {
    for (const body of [
      'Liked “Your service is Thursday”\n\nActually, can we reschedule to Friday?',
      'Liked “Your service is Thursday”\n\nActually, can we reschedule to “Friday”',
      'Liked “Your service is Thursday” Actually, can we reschedule to “Friday”',
    ]) {
      expect(isSmsReaction(body)).toBe(false);
      expect(hasRescheduleOrAwayIntent(body)).toBe(true);
    }
  });
});

describe('emoji tapbacks + courtesy closers (2026-08-28 notification quieting)', () => {
  // iOS 17.4+ renders any-emoji tapbacks as `Reacted <emoji> to "…"`. The
  // quoted text is OUR outbound — scanning it as customer prose tripped the
  // scheduling detector on "Your service is scheduled …".
  test('detects the iOS emoji tapback formats (incl. skin tone + ZWJ)', () => {
    expect(isSmsReaction('Reacted ❤️ to "Good afternoon! Your service is scheduled for Thursday"')).toBe(true);
    expect(isSmsReaction('Reacted 👍🏽 to \u201cok\u201d')).toBe(true);
    expect(isSmsReaction('Reacted 👨‍👩‍👧 to an image')).toBe(true);
    expect(isSmsReaction('Removed ❤️ from "Thanks for the update"')).toBe(true);
    expect(isSmsReaction('Reacted 1️⃣ to "Your service is scheduled for Thursday"')).toBe(true); // keycap (hook P1)
    expect(isSmsReaction('I reacted badly to the spray')).toBe(false);
    expect(hasSchedulingIntent('Reacted ❤️ to "Your service is scheduled for Thursday"')).toBe(true); // still prose to that detector — the webhook gates on isSmsReaction first
  });

  test('bare affirmatives and 👍 are closers only when we are NOT awaiting an answer', () => {
    for (const t of ['Sounds good', 'Great', 'Perfect', 'Will do', 'Got it', 'Okay', 'Ok great', 'Np', 'All set', '👍', '🙏🙏', 'Ok 👍']) {
      expect([t, isCourtesyOnly(t, { awaitingAnswer: false })]).toEqual([t, true]);
      expect([t, isCourtesyOnly(t, { awaitingAnswer: true })]).toEqual([t, false]); // "does 9am work?" → 👍 is the answer
      expect([t, isCourtesyOnly(t)]).toEqual([t, false]); // default = strict
    }
  });

  test('bare affirmatives and 👍 are closers only when we are NOT awaiting an answer', () => {
    for (const t of ['Sounds good', 'Great', 'Perfect', 'Will do', 'Got it', 'Okay', 'Ok great', 'Np', 'All set', '👍', '🙏🙏', 'Ok 👍']) {
      expect([t, isCourtesyOnly(t, { awaitingAnswer: false })]).toEqual([t, true]);
      expect([t, isCourtesyOnly(t, { awaitingAnswer: true })]).toEqual([t, false]); // "does 9am work?" → 👍 is the answer
      expect([t, isCourtesyOnly(t)]).toEqual([t, false]); // default = strict
    }
    for (const t of ['Thanks!', 'Sounds good, thanks!', 'Thank you 🙏']) {
      expect([t, isCourtesyOnly(t, { awaitingAnswer: true })]).toEqual([t, false]); // "please confirm…" → "Thanks!" is a non-answer (hook P1)
      expect([t, isCourtesyOnly(t, { awaitingAnswer: false })]).toEqual([t, true]);
    }
    for (const t of ['Yes', 'No', 'Sure', 'Hello', 'Good morning', '❓', 'Thanks spider', 'Sure, 8 AM works']) {
      expect([t, isCourtesyOnly(t, { awaitingAnswer: false })]).toEqual([t, false]); // real content stays loud regardless
    }
  });

  test('pure courtesy closers are detected (no open question)', () => {
    for (const t of ['Thanks!', 'Thank you ', 'Ok, thanks ', 'Sounds good, thanks!', 'Got it, thank you', 'Perfect, thanks Adam!', 'I appreciate you!', 'Thanks for the update!', 'Awesome thank you so much', 'thank you for letting me know', 'Thanks Adam', 'Thank you guys!', 'You too!', 'Have a great weekend']) {
      expect([t, isCourtesyOnly(t, { awaitingAnswer: false })]).toEqual([t, true]);
    }
  });

  test('anything that wants an answer is NOT courtesy (fail-safe direction)', () => {
    for (const t of [
      'Yes', 'No', 'Sure', 'Yep', 'Yup', 'Okay', 'Ok', 'K', // may answer a question we asked → stay loud (hook P1)
      'Good morning', 'Good afternoon', 'Hello', 'Bye', // greetings open threads, they do not close them (hook P1)
      'Sounds good', 'Great', 'Perfect', 'Will do', 'Got it', 'Ok great', 'Np', 'No problem', 'All set', '👍', // bare affirmatives / 👍 can answer "does 9am work?" — strict default (hook P1)
      'Thanks again Adam. Your opinion do you think the second session is going to be enough?',
      'Thanks, but you missed the backyard',
      'Sure, 8 AM works',
      'Ok. I won\u2019t be home then Thanks for stopping by.',
      'Thanks! Can we reschedule to Friday?',
      'Hey Adam', 'Hello Adam, good afternoon.',
      'Sounds good let me know if you have any issues or need me! Appreciate it.',
      'Thanks — the invoice says $81', '', null,
      'Ok call', 'Thanks help', 'Thanks spray', 'Thanks reschedule', 'Thanks spider', 'Got it charge', 'Thanks Tyler', // only KNOWN addressees after a thanks (hook P1 ×2)
      '❓', '🚨', '📞', '🐜', '👍❓', // non-acknowledgement emoji are content (hook P1)
    ]) {
      expect([t, isCourtesyOnly(t)]).toEqual([t, false]);
    }
  });
});
