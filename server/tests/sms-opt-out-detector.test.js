const { detectSmsOptCommand } = require('../services/messaging/opt-out-detector');

describe('SMS opt-out detector', () => {
  test.each([
    ['STOP', 'opt_out', 'opt_out_keyword'],
    ['stopp', 'opt_out', 'opt_out_natural_language'],
    ['please remove me from this list', 'opt_out', 'opt_out_natural_language'],
    ['remove me', 'opt_out', 'opt_out_natural_language'],
    ['please remove me', 'opt_out', 'opt_out_natural_language'],
    ['take me off', 'opt_out', 'opt_out_natural_language'],
    ["don't text me anymore", 'opt_out', 'opt_out_natural_language'],
    ['wrong number', 'opt_out', 'wrong_number'],
    ['Disliked "STOP"', 'opt_out', 'opt_out_keyword'],
    ['START', 'opt_in', 'opt_in_keyword'],
    ['Opt in', 'opt_in', 'opt_in_keyword'],
  ])('classifies %s', (body, action, reason) => {
    expect(detectSmsOptCommand(body)).toMatchObject({ action, reason });
  });

  test('ignores normal replies', () => {
    expect(detectSmsOptCommand('Can we schedule for Tuesday?')).toEqual({ action: null });
    expect(detectSmsOptCommand('I need to cancel my service')).toEqual({ action: null });
    expect(detectSmsOptCommand("please remove me from Friday's schedule")).toEqual({ action: null });
    expect(detectSmsOptCommand('take me off the route tomorrow')).toEqual({ action: null });
  });

  // Footer-stripping (the `ignoreReplyInstructions` option and its regexes)
  // was removed 2026-09-11 (codex round 3 design fix): this detector now
  // only ever runs against a sender the webhook has already resolved as
  // compliance-eligible, on their full untouched text, so a vendor's own
  // reply-instruction footer is never a scenario this detector needs to
  // defend against — see the comment above `detectSmsOptCommand` and
  // docs/public-route-contracts.md:200-260. It still matches this phrasing
  // as natural-language opt-out (unchanged): who gets that treated as a
  // real opt-out is now decided entirely by the caller's eligibility check.
  test.each([
    'Reply "NO" if you need me to stop texting',
    'Reply STOP to stop messages',
    'Text “STOP” to stop texting you',
    'Say NO if you want us to stop messaging you',
    'We have exclusive leads. Reply STOP to stop messages.',
    'We have exclusive leads\nReply STOP to stop messages',
  ])('still recognizes a reply-instruction footer as natural-language opt-out (no stripping option exists anymore): %s', (body) => {
    expect(detectSmsOptCommand(body).action).toBe('opt_out');
  });

  // A bare "no text(s)" stays a stop request unless the sentence reports, in the past tense, a text
  // that never came; that complaint wording unsubscribed a customer on 2026-10-19. A request is
  // never in the past tense, and questions get no exception. "No more texts" is a request anywhere.
  test.each([
    'No texts please',
    'NO TEXTS!',
    'no sms',
    'No texts, thank you',
    'Ok. No messages.',
    'Please no texts from now on',
    'No text messages please',
    'Hi Adam\nNo texts please',
    'Please no texts or calls',
    'No text messages to me please',
    'No texts please \u{1F64F}',
    'Call me anytime but no texts',
    'I get too many notifications so no texts',
    'I want to receive no texts from you',
    'My answer was no texts',
    'Can I get no texts from you?',
    "I'm traveling Friday so no texts that day",
    'No messages from you',
    'No texts please?',
    'Can I have no texts please?',
    'Please, no texts?',
    'No texts, only calls?',
    'No texts, understood?',
    'I said no texts yesterday',
    'I asked for no texts last week',
    'I would prefer it if I received no texts',
    "I'd rather I got no texts",
    'I wish I got no texts',
    'My preference has been no texts',
    'I had said no texts that day',
    'I asked that no messages were sent to me',
    'I got no text. STOP',
    'There was no message; unsubscribe',
    'I got no text that day.\nStop',
    'I got no text, STOP',
    'I got no text. STOP please',
    'I got no text. Please stop',
    'I got no text. Stop contacting me.',
    'I got no text, stop sending them',
    'I got no text. Unsubscribe me',
    'I got no text. Cancel please',
    'I got your confirmation, but I want no texts that day',
    'I got your message but I need no texts that day',
    'I received your confirmation but I said no texts that day',
    'No\ntexts please',
    'No\nmessages',
    'I got no texts, keep it that way',
    'I got no texts. Please keep it that way.',
    'No texts delivered to this number please',
    'Please no messages delivered to my phone anymore',
    'I got no texts. Stop interrupting me.',
    'I got no texts. Stop instantly.',
    'There were no messages this week and I want it that way',
    'no more texts',
    'Please, no more messages.',
    'No more text messages',
    'We went with another company, no more texts please',
  ])('"no texts" as a request is opt_out: %s', (body) => {
    expect(detectSmsOptCommand(body)).toMatchObject({ action: 'opt_out', reason: 'opt_out_natural_language' });
  });

  test.each([
    'Hi, we had a lawn visit set for Thursday. I got the confirmation two days before but no text that day.',
    'I got the confirmation but no text that day',
    'Why was there no text?',
    'Did you send it? I got no text',
    'I got no text reminder this time',
    'There was no message from the tech',
    'We have had no texts since Monday',
    'No text came',
    'No text messages arrived',
    "There's been no text all week",
    'I got no text that day. Please call me.',
    'I got no text that day, can the tech stop by tomorrow',
    'I got no text that day, please call me',
    "I got no text; don't stop sending reminders",
    'I got no text. Never stop sending me reminders',
    'No text was received',
    'No messages were delivered',
    'No message was sent yesterday',
    'I got no text. Cancel it please',
    'There was no message. End it now',
  ])('"no text" that reports a missing text in the past tense is not opt_out: %s', (body) => {
    expect(detectSmsOptCommand(body)).toEqual({ action: null });
  });

  test.each([
    'wrong number',
    'sorry wrong number',
    'you have the wrong number',
    'Sorry, you have the wrong number.',
  ])('a genuine human wrong-number reply is opt_out/wrong_number: %s', (body) => {
    expect(detectSmsOptCommand(body)).toMatchObject({
      action: 'opt_out',
      reason: 'wrong_number',
    });
  });
});
