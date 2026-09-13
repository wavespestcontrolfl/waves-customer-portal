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
