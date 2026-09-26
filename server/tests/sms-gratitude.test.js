const {
  isGratitudeOnly, buildGratitudeReply, evaluateGratitudeContext,
  gratitudeTimingReason, QUIET_WINDOW_MS, MAX_REPLY_AGE_MS,
} = require('../services/sms-gratitude');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { _SWAPS: SMS_COPY_AUDIT_SWAPS } = require('../models/migrations/20260926120000_customer_copy_audit_sms');

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
  const manual = body => ({ ...report, id: 'manual-1', messageType: 'manual', humanAuthored: true, body });
  const earlierRequest = { ...inbound, id: 'earlier', createdAt: '2030-01-10T14:58:00Z', body: 'Can I move my appointment from the app?' };
  test.each([
    { humanAuthored: false }, { humanAuthored: undefined }, { humanAuthored: 'true' },
  ])("a 'manual' row without the send-time human_authored stamp is not a typed reply: %p", override => {
    expect(evaluateGratitudeContext({ ...context, history: [{ ...manual('Yes, you can download the Waves app and reschedule appts there.'), ...override }] }).reason)
      .toBe('closure_not_established');
  });
  test.each([
    'Thanks, I updated the address.',
    'Thank you, the report is attached.',
    'Thanks, address updated.',
    'Thank you, issue resolved.',
  ])('a typed answer that opens with thanks is still an answer: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(body)] }).eligible).toBe(true);
  });
  test.each([
    'Your payment has been received',
    'That invoice was already paid',
    'No balance on your account',
  ])('a typed payment settlement is a closure: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(body)] }).eligible).toBe(true);
  });
  test.each([
    'We still need your gate code',
    "We're waiting on the photo",
    'Once we get the signed agreement we can schedule',
    "Haven't received the pictures yet",
  ])('a declarative information request still needs an answer: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(body)] }).reason).toBe('outbound_needs_attention');
  });
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
    'It should arrive Friday',
    'Expect it Friday',
    "I'm gonna move your tree and shrub care to Wednesday",
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
    'Please provide a photo of the issue',
    'Provide us the gate code',
  ])('a hand-typed question without a question mark still needs an answer: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(body)] }).reason).toBe('outbound_needs_attention');
  });
  test.each(['Thanks, Dana!', 'Anytime!', 'Happy to help', 'You are welcome!', 'No problem', 'Not a problem Steve!'])('a hand-typed courtesy is not a closure to thank again: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [report, { ...manual(body), createdAt: '2030-01-10T14:59:30Z' }] }).reason)
      .toBe('courtesy_already_sent');
  });
  test.each([
    'Here is your payment link: https://example.invalid/pay/abc',
    'Please pay your invoice here: https://example.invalid/pay/abc',
    'Your balance due is on the portal',
    'Your old invoice was paid, but please pay your new invoice here',
    'Payment received for March. The April invoice is due Friday',
    'Your old invoice was paid, please pay your new invoice here',
    'Last month went through and the new invoice is due Friday',
    'Old balance cleared - please pay the new one here',
    'Your old invoice was paid: please pay the new invoice here',
    'Your old invoice was paid so please pay the new invoice here',
    'Here is your invoice and here is the link: https://example.invalid/i/abc',
    'Invoice: https://example.invalid/i/abc',
    'Here is your invoice: https://example.invalid/i/abc',
    'Here you go https://portal.example.invalid/pay/abc',
  ])('a hand-typed payment request is not a closure: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(body)] }).eligible).toBe(false);
  });
  test.each([
    'Your invoice has been paid, no balance due. Thanks!',
    'Payment received and applied, you are all set',
    'Payment received: you are all set',
  ])('a hand-typed settlement is still a closure: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(body)] }).eligible).toBe(true);
  });
  test.each([
    ['media-only', '', 1],
    ['text with media', 'Here you go', 1],
    ['unknown media count', 'Here you go', undefined],
    ['empty body', '   ', 0],
  ])('a hand-typed send is judged on its text alone, so %s abstains', (_label, body, mediaCount) => {
    expect(evaluateGratitudeContext({ ...context, history: [{ ...manual(body), mediaCount }] }).eligible).toBe(false);
  });
  test('an earlier hand-typed payment request is still open behind a later closure', () => {
    expect(evaluateGratitudeContext({ ...context, history: [
      { ...manual('Here is your invoice: https://example.invalid/i/abc'), createdAt: '2030-01-10T14:58:00Z' },
      report,
    ] }).reason).toBe('earlier_open_context');
  });
  test.each([
    'Your receipt: https://example.invalid/receipt/abc',
    'Payment received',
    "We've completed your service",
  ])('a hand-typed closure caption with media still abstains: %s', body => {
    expect(evaluateGratitudeContext({ ...context, history: [{ ...manual(body), mediaCount: 1 }] }).reason).toBe('media_or_unknown');
  });
  test("an automated row stored as 'manual' is not held to the hand-typed pending rules", () => {
    expect(evaluateGratitudeContext({ ...context, history: [
      { ...manual('Your appointment is Friday'), humanAuthored: false, createdAt: '2030-01-10T14:58:00Z' },
      report,
    ] }).eligible).toBe(true);
  });
  test.each([
    'Here you go https://portal.wavespestcontrol.com/pay/abc',
    'Invoice: https://portal.wavespestcontrol.com/i/abc',
    'Here is your invoice https://portal.wavespestcontrol.com/pay/statement/abc?x=1',
  ])('a payment link still reads as a request after the stored-body scheme strip: %s', raw => {
    const stored = stripSmsUrlScheme(raw);
    expect(stored).not.toMatch(/https:/);
    expect(evaluateGratitudeContext({ ...context, history: [manual(stored)] }).eligible).toBe(false);
  });
  test('a stored scheme-less receipt link is still a closure', () => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(stripSmsUrlScheme('Your receipt: https://portal.wavespestcontrol.com/receipt/abc'))] }).eligible).toBe(true);
  });
  test.each([
    'Please sign: https://portal.wavespestcontrol.com/contract/abc',
    'Book here https://portal.wavespestcontrol.com/book/abc',
    'Your report: https://example.invalid/report/abc and please sign https://example.invalid/contract/abc',
    'Your report is ready. Please sign: https://portal.wavespestcontrol.com/contract/abc',
    'Your receipt is below. Book your next visit https://portal.wavespestcontrol.com/book/abc',
  ])('a typed action link stays open: %s', raw => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(stripSmsUrlScheme(raw))] }).eligible).toBe(false);
  });
  test('an earlier typed action link is still open behind a later closure', () => {
    expect(evaluateGratitudeContext({ ...context, history: [
      { ...manual('Please sign: https://portal.wavespestcontrol.com/contract/abc'), createdAt: '2030-01-10T14:58:00Z' },
      report,
    ] }).reason).toBe('earlier_open_context');
  });
  test.each([['an attachment', 1], ['an unknown media count', undefined]])('an earlier typed send with %s is still open behind a later typed text', (_label, mediaCount) => {
    expect(evaluateGratitudeContext({ ...context, history: [
      { ...manual('Contract attached'), id: 'manual-0', mediaCount, createdAt: '2030-01-10T14:58:00Z' },
      manual('Here you go'),
    ] }).reason).toBe('earlier_open_context');
  });
  test.each([
    'Here is your report: https://example.invalid/report/abc',
    'Your receipt is here https://portal.wavespestcontrol.com/receipt/abc',
  ])('a hand-typed labelled report or receipt link is still a closure: %s', raw => {
    expect(evaluateGratitudeContext({ ...context, history: [manual(stripSmsUrlScheme(raw))] }).eligible).toBe(true);
  });
  test('a scheduled typed send is judged by its provider row, not the re-stamped queued row', () => {
    const queued = { ...manual('Yup, just texted her'), id: 'queued-1', mediaCount: null, createdAt: '2030-01-10T14:59:40Z' };
    const delivered = { ...manual('Yup, just texted her'), id: 'provider-1', scheduledSourceId: 'queued-1' };
    expect(evaluateGratitudeContext({ ...context, history: [delivered, queued] }).eligible).toBe(true);
    expect(evaluateGratitudeContext({ ...context, history: [queued] }).reason).toBe('media_or_unknown');
  });
  test('a hand-typed report link is still a closure', () => {
    expect(evaluateGratitudeContext({ ...context, history: [manual('Here is your report: https://example.invalid/report/abc')] }).eligible).toBe(true);
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

describe('customer copy audit SMS drift (2026-09-26, migration 20260926120000)', () => {
  // One sample value per placeholder used across the whole swap set, shared
  // between the before/after render of each entry so only the copy itself
  // differs.
  const LINK = 'https://portal.wavespestcontrol.com/l/abcdefghjk';
  const SAMPLE = {
    amount: '86.40', amount_text: ' for $86.40',
    appointment_line: 'Reply here with any questions.',
    billing_url: LINK, booking_url: LINK,
    card_hold_policy_line: ' Your card on file will be charged after the visit.',
    card_line: ' on your card ending 4242', category: 'general',
    charge_note: ' on your card ending 4242',
    coverage_summary: 'your quarterly pest control visits',
    date: 'Oct 3', day: 'Friday', deposit_amount: '150', effective_date: 'Nov 1',
    estimate_url: LINK, eta_line: 'Your tech is about 20 minutes away.',
    first_name: 'Casey', first_visit_clause: ' Your first visit is Oct 10.',
    first_visit_date: 'Oct 10', invoice_number: 'INV-1001',
    invoice_title: 'Quarterly Pest Control', new_expiry: 'Oct 20',
    pay_link: LINK, pay_url: LINK, portal_url: LINK, price_change_url: LINK,
    project_type: 'Termite', receipt_line: ` Receipt: ${LINK}`, receipt_url: LINK,
    reference: 'REF-100', remaining: 'Your lawn care visits',
    renewal_label: 'termite bond', report_url: LINK,
    reschedule_line: 'Need to reschedule? Reply here.',
    response_time: '1 business day', resume_date: 'Oct 15',
    scope: 'all upcoming visits', service: 'Pest Control', service_date: 'Oct 3',
    service_date_clause: ' for your Oct 3 visit', service_label: 'Quarterly Pest Control',
    service_timing: 'tomorrow', service_type: 'Quarterly Pest Control',
    start_date: 'Oct 10', summary: 'We fixed the ant issue.', tech_name: 'Adam',
    time: '9 AM', track_clause: ` Track: ${LINK}`, urgency: 'is due soon',
    visit_date: 'Oct 3', when: 'this morning', window: '8-10 AM',
    window_text: ' between 8 and 10 AM',
  };
  const render = (tpl) => tpl.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in SAMPLE)) throw new Error(`sms-gratitude drift test: no sample value for {${key}}`);
    return SAMPLE[key];
  });
  // A neutral messageType that is NOT in AUTOMATED_CLOSURE_TYPES, and not
  // hand-typed, so the verdict comes only from the rendered body text —
  // never from a template-key or manual-reply carve-out.
  const asPreviousOutbound = (body) => ({
    id: 'out-1', direction: 'outbound', createdAt: '2030-01-10T14:59:00.000Z',
    mediaCount: 0, messageType: 'copy_audit_probe', humanAuthored: false, body,
  });
  const thanksInbound = {
    id: 'in-1', direction: 'inbound', body: 'Thanks!', createdAt: '2030-01-10T15:00:00.000Z', mediaCount: 0,
  };
  const reasonFor = (body) => evaluateGratitudeContext({
    inbound: thanksInbound, history: [asPreviousOutbound(body)], firstName: 'Casey', contextComplete: true,
  }).reason;

  test.each(SMS_COPY_AUDIT_SWAPS.map(([key, before, after]) => [key, before, after]))(
    '%s: the rewritten body classifies identically to the pre-audit body',
    (_key, before, after) => {
      expect(reasonFor(render(after))).toBe(reasonFor(render(before)));
    },
  );
});
