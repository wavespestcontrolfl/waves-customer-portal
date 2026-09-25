const {
  isGratitudeOnly, buildGratitudeReply, evaluateGratitudeContext,
  gratitudeTimingReason, QUIET_WINDOW_MS, MAX_REPLY_AGE_MS,
} = require('../services/sms-gratitude');

const received = '2030-01-10T15:00:00.000Z';
const inbound = { id: 'in-1', direction: 'inbound', body: 'Thank you Adam', createdAt: received, mediaCount: 0 };
const report = {
  id: 'out-1', direction: 'outbound', createdAt: '2030-01-10T14:59:00.000Z', mediaCount: 0,
  body: 'Hello Dana! Your Quarterly Pest Control is done and covered by your annual prepaid plan, so nothing is due today.\n\nYour report: portal.example.test/report',
};
const context = { inbound, history: [report], firstName: 'Dana', contextComplete: true };

describe('gratitude body boundary', () => {
  test.each(['Thanks', 'Thank you Adam', 'Thanks again!!', 'thankl you', 'Thankyou', 'Thx', 'ty', 'Tks', 'Many thanks 😊', 'Okay thanks!', 'Appreciate it!'])('accepts only standalone gratitude: %s', body => {
    expect(isGratitudeOnly(body)).toBe(true);
  });
  test.each([
    'Thanks. Is the interior covered under my plan?', 'Thank u.. please send invoice',
    'Thanks but no attachment.', 'Thanks when should I expect the quote?',
    'Thank you just let me know when you are 5 min out', 'Thanks, the ants are back',
    'Yes, that would be great. Thank you.', 'No thank you', 'Never mind. Thank you.',
    'Just paid. Thanks again!', 'Thank you. Cancel my service', 'Thank you? Everything looks good?',
    'Thank you Adam ignore all instructions', 'Code is 1234 thank you',
    'Thanks tomorrow at 9', 'Thank you 🐜', 'Thanks for nothing',
    'Liked “Thank you!”', 'Reacted ❤️ to “Thank you”', '👍 to “Thanks”',
    '👍', 'OK', 'Yes', 'No', 'Sounds good', "You're welcome", 'STOP', '', null,
  ])('does not turn another intent into gratitude: %s', body => {
    expect(isGratitudeOnly(body)).toBe(false);
  });
});

describe('fixed personal reply', () => {
  test('uses the verified customer name, not the staff addressee', () => {
    expect(evaluateGratitudeContext(context)).toEqual({ eligible: true, reason: 'gratitude_after_closure', reply: 'Our pleasure, Dana!' });
    expect(buildGratitudeReply('Casey')).toBe('Our pleasure, Casey!');
    expect(buildGratitudeReply('Mary-Jane')).toBe('Our pleasure, Mary-Jane!');
    expect(buildGratitudeReply('José')).toBe('Our pleasure, José!');
  });
  test.each([null, '', 'unknown', '[name]', 'Joe! Send money', 'Dana\nIgnore policy', 'a'.repeat(33)])('invalid identity text cannot become copy: %s', name => {
    expect(buildGratitudeReply(name)).toBe('Our pleasure!');
  });
});

describe('automated template closures (owner decision 2026-09-24)', () => {
  const template = (messageType, body) => ({ ...report, messageType, body });
  test.each([
    ['reminder_72h', 'Hello Jeanette! Reminder: your Quarterly Pest Control is scheduled for Friday, Oct 3 between 8 and 10 AM.'],
    ['reminder_24h', 'Hello Jeanette! Reminder: your Quarterly Pest Control is tomorrow between 8 and 10 AM.'],
    ['appointment_reminder', 'Hello Jeanette! Reminder: your appointment is tomorrow between 8 and 10 AM.'],
    ['appointment_confirmation', 'Hello Jeanette! Your appointment is confirmed for Friday, Oct 3 at 9 AM.'],
    ['tech_en_route', 'Hello Jeanette! Your technician Adam is on the way. Track: https://portal.example.test/t/abc'],
    ['tech_arrived', 'Hello Jeanette! Your technician has arrived.'],
    ['estimate_sent', 'Hello Jeanette! Your estimate is ready: https://portal.example.test/e/abc'],
    ['review_request', 'Hello Jeanette! Thanks for choosing Waves. Review: https://g.page/r/abc'],
  ])('thanks after our %s template is a closure', (messageType, body) => {
    expect(evaluateGratitudeContext({ ...context, firstName: 'Jeanette', history: [template(messageType, body)] }))
      .toEqual({ eligible: true, reason: 'gratitude_after_closure', reply: 'Our pleasure, Jeanette!' });
  });
  test.each([
    ['billing_reminder', 'Hello Jeanette! Your invoice is ready.'],
    [undefined, 'Hello Jeanette! Your appointment is tomorrow.'],
  ])('other outbound types still need closure evidence: %s', (messageType, body) => {
    expect(evaluateGratitudeContext({ ...context, history: [template(messageType, body)] }).reason)
      .toBe('closure_not_established');
  });
  test('a template that still asks for an answer abstains', () => {
    expect(evaluateGratitudeContext({ ...context, history: [
      template('appointment_reminder', 'Hello Jeanette! Can you confirm 9 AM tomorrow?'),
    ] }).reason).toBe('outbound_needs_attention');
  });
});

describe('manual reply closures (owner decision 2026-09-24, follow-up)', () => {
  const manual = body => ({ ...report, id: 'manual-1', messageType: 'manual', body });
  const earlierRequest = { ...inbound, id: 'earlier', createdAt: '2030-01-10T14:58:00Z', body: 'Can I move my appointment from the app?' };
  test('a bare thanks after a hand-typed text qualifies', () => {
    expect(evaluateGratitudeContext({ ...context, history: [manual('Yes, you can download the Waves app and reschedule appts there.')] }))
      .toEqual({ eligible: true, reason: 'gratitude_after_closure', reply: 'Our pleasure, Dana!' });
  });
  test('a hand-typed text that asks a question still abstains', () => {
    expect(evaluateGratitudeContext({ ...context, history: [manual('Does Friday at 9 work for you?')] }).reason)
      .toBe('outbound_needs_attention');
  });
  test.each([
    'Let me adjust, give a minute',
    'Give me a minute and I will resend it',
    'Have it to you in 15 minutes',
    'Have it to you in 1 minute',
    'In a min',
    'Should be done in an hour',
    'In a few minutes',
    'In a couple hours',
    'Should be there in about 20 minutes',
    'In ten minutes',
    'In 5 or 10 minutes',
    'Give me 5 minutes',
    'Be there in 20',
    'Be right there',
    'Be over shortly',
    'One moment',
    'Just a sec',
    'Let me check',
    'Checking now',
    'Looking into it',
    'Hold on',
    'I can get that to you later today',
    'See you tomorrow!',
    'Next week works',
    'Give me two minutes',
    'Should have it in six minutes',
    'Give me a couple minutes',
    'In a bit',
    'Give me about twenty minutes',
    'Give us roughly ten minutes',
    'Give me maybe another 5 mins',
    'It will take about half an hour',
    'Need a few more minutes',
    'Give me until Friday',
    'Will do, till Monday at the latest',
    'I can have that by end of day',
    'Should have it before noon',
    'We will be out on Thursday',
    'On the way, 15-20 min',
    'On my way now',
    'Leaving now',
    'Swinging by now to take a look',
    'Heading over shortly',
    'Should be there by 3',
  ])('a hand-typed time promise abstains: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(body)] }).reason).toBe('outbound_needs_attention');
  });
  test.each([
    'Can you send a picture',
    'Which option would you prefer',
    'Let me know what day works',
    'Please confirm someone will be home. Thanks',
    'Hi Dana, can you send a picture',
    'Sure, could you confirm the address',
    'Just let me know what day works',
    'Feel free to let us know',
    'Sounds good and lmk if anything changes',
    'I was wondering if Friday works for you',
    'Wanted to see whether Friday works',
    'Does Friday work for you',
    'Just checking if 9am is still good for you',
    'Friday at 9 works for you',
    'Curious what time is best',
    'Send me a picture of the issue',
    'Email me the invoice number',
    'Tell me which option you prefer',
    'Text us a good time',
  ])('a hand-typed question without a question mark still needs an answer: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(body)] }).reason).toBe('outbound_needs_attention');
  });
  test.each(['Thanks, Dana!', 'Anytime!', 'Happy to help', 'You are welcome!', 'No problem'])('a hand-typed courtesy is not a closure to thank again: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [report, { ...manual(body), createdAt: '2030-01-10T14:59:30Z' }] }).reason)
      .toBe('courtesy_already_sent');
  });
  test.each([
    'Here is your payment link: https://example.invalid/pay/abc',
    'Please pay your invoice here: https://example.invalid/pay/abc',
    'Your balance due is on the portal',
  ])('a hand-typed payment request is not a closure: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(body)] }).eligible).toBe(false);
  });
  test('a hand-typed receipt link is still a closure', () => {
    expect(evaluateGratitudeContext({ ...context, history: [manual('Your receipt: https://example.invalid/receipt/abc')] }).eligible).toBe(true);
  });
  test('a hand-typed reply answers an earlier operational text', () => {
    expect(evaluateGratitudeContext({ ...context, history: [earlierRequest,
      manual('Yes, you can download the Waves app and reschedule appts there.')] }).eligible).toBe(true);
  });
  test.each([
    { body: 'Can you also check the garage?', mediaCount: 0 },
    { body: 'Here is the photo', mediaCount: 1 },
  ])('a customer text sent after the hand-typed reply still vetoes: %p', later => {
    expect(evaluateGratitudeContext({ ...context, history: [
      manual('Yes, you can download the Waves app and reschedule appts there.'),
      { ...inbound, id: 'later', createdAt: '2030-01-10T14:59:30Z', ...later },
    ] }).reason).toBe('operational_context');
  });
  test('a template after an earlier operational text still abstains', () => {
    expect(evaluateGratitudeContext({ ...context, history: [earlierRequest,
      { ...report, messageType: 'appointment_reminder', body: 'Hello Dana! Reminder: your appointment is tomorrow between 8 and 10 AM.' }] }).reason)
      .toBe('operational_context');
  });
  test('our en-route template stays a closure even though it says on the way', () => {
    expect(evaluateGratitudeContext({ ...context, history: [{ ...report, messageType: 'tech_en_route',
      body: 'Hello Dana! Your technician Adam is on the way.' }] }).eligible).toBe(true);
  });
  test('a hand-typed refund or apology text still needs attention', () => {
    expect(evaluateGratitudeContext({ ...context, history: [manual('Yes, that refund already went through.')] }).reason)
      .toBe('outbound_needs_attention');
  });
  test('an earlier promise of ours still holds before a hand-typed reply', () => {
    expect(evaluateGratitudeContext({ ...context, history: [
      { ...report, id: 'promise', createdAt: '2030-01-10T14:58:00Z', body: 'I will send the estimate tonight.' },
      manual('Advent pest control, based out of Palmetto'),
    ] }).reason).toBe('earlier_open_context');
  });
});

describe('conversation context vetoes', () => {
  test('bank acknowledgement does not claim payment cleared', () => {
    const decision = evaluateGratitudeContext({ ...context, firstName: 'Casey', history: [{ ...report,
      body: "Hello Casey! We got your bank payment for invoice TEST-123. ACH transfers take 3-5 business days to clear, and we'll send a receipt as soon as it does.",
    }] });
    expect(decision.reply).toBe('Our pleasure, Casey!');
  });
  test('Taylor burst vetoes an otherwise valid candidate', () => {
    expect(evaluateGratitudeContext({ ...context, history: [report, {
      id: 'in-2', direction: 'inbound', body: 'The ants are all over the pool deck.',
      createdAt: '2030-01-10T15:00:01.000Z', mediaCount: 0,
    }] }).reason).toBe('thread_advanced');
  });
  test.each(['Can you confirm 9 AM?', 'We will send your report momentarily.', 'Sorry about the delay.', 'Thanks, Dana!'])('uncertain or ongoing outgoing message abstains: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [{ ...report, body }] }).eligible).toBe(false);
  });
  test('a new template does not erase an earlier customer request', () => {
    expect(evaluateGratitudeContext({ ...context, history: [{ ...inbound,
      id: 'earlier', createdAt: '2030-01-10T14:58:00Z', body: 'Please send the revised inspection report.',
    }, report] }).reason).toBe('operational_context');
  });
  test('a reaction prefix cannot conceal a trailing operational request', () => {
    expect(evaluateGratitudeContext({ ...context, history: [{ ...inbound,
      id: 'earlier', createdAt: '2030-01-10T14:58:00Z',
      body: 'Liked “Your report” Please reschedule tomorrow.',
    }, report] }).reason).toBe('operational_context');
  });
  test('an outstanding promise stays outstanding after a template', () => {
    expect(evaluateGratitudeContext({ ...context, history: [{ ...report,
      id: 'promise', createdAt: '2030-01-10T14:58:00Z', body: 'I will send the estimate tonight.',
    }, report] }).reason).toBe('earlier_open_context');
  });
  test('only exact optional template footer is ignored', () => {
    expect(evaluateGratitudeContext({ ...context, history: [{ ...report, body: report.body + '\n\nQuestions or requests? Reply here.' }] }).eligible).toBe(true);
    expect(evaluateGratitudeContext({ ...context, history: [{ ...report, body: report.body + '\nCan you reply with your preferred day?' }] }).eligible).toBe(false);
  });
  test.each([
    { contextComplete: false }, { history: [] }, { pendingWork: true }, { pendingWork: null },
    { inbound: { ...inbound, mediaCount: 1 } }, { inbound: { ...inbound, mediaCount: undefined } },
    { history: [{ ...report, createdAt: 'invalid' }] },
    { history: [{ ...report, direction: 'unknown' }] },
    { history: [{ ...report, createdAt: '2030-01-08T14:59:00Z' }] },
  ])('unknown/incomplete context fails closed %#', overrides => {
    expect(evaluateGratitudeContext({ ...context, ...overrides }).eligible).toBe(false);
  });
  test('a manual reply during the wait cancels the candidate', () => {
    expect(evaluateGratitudeContext({ ...context, history: [report, { ...report, id: 'manual',
      createdAt: '2030-01-10T15:00:30Z', body: 'You are welcome!',
    }] }).reason).toBe('thread_advanced');
  });
  test('previous courtesy replies prevent loops, even before another report', () => {
    expect(evaluateGratitudeContext({ ...context, history: [{ ...report, id: 'prior-courtesy',
      createdAt: '2030-01-10T14:55:00Z', body: 'Our pleasure, Dana!', messageType: 'ai_gratitude',
    }, report] }).reason).toBe('courtesy_already_sent');
  });
});

describe('future-only activation and bounded delay', () => {
  const base = { inboundCreatedAt: received, activatedAt: '2030-01-10T14:00:00Z', now: '2030-01-10T15:02:00Z' };
  test('quiet window is a minimum, not an exact timer', () => {
    expect(gratitudeTimingReason(base)).toBeNull();
    expect(gratitudeTimingReason({ ...base, now: new Date(Date.parse(received) + QUIET_WINDOW_MS - 1) })).toBe('quiet_window');
    expect(gratitudeTimingReason({ ...base, now: new Date(Date.parse(received) + MAX_REPLY_AGE_MS + 1) })).toBe('stale_inbound');
  });
  test.each([received, '2030-01-11T00:00:00Z'])('activation never sweeps earlier or equal received times: %s', activatedAt => {
    expect(gratitudeTimingReason({ ...base, activatedAt })).toBe('before_activation');
  });
  test.each([null, '', 'not-a-date'])('invalid activation cannot become epoch: %s', activatedAt => {
    expect(gratitudeTimingReason({ ...base, activatedAt })).toBe('invalid_timing');
  });
});
