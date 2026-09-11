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

  test.each([
    'Reply "NO" if you need me to stop texting',
    'Reply STOP to stop messages',
    'Text “STOP” to stop texting you',
    'Say NO if you want us to stop messaging you',
    'We have exclusive leads. Reply STOP to stop messages.',
    'We have exclusive leads\nReply STOP to stop messages',
  ])('can exclude a vendor reply instruction while keeping legacy detection: %s', (body) => {
    expect(detectSmsOptCommand(body).action).toBe('opt_out');
    expect(detectSmsOptCommand(body, { ignoreReplyInstructions: true }).action).toBeNull();
  });

  test.each([
    "Please stop texting me. I don't have any leads for you.",
    'Please remove me from your list. Reply STOP to stop messages.',
    'Reply NO if you need me to stop texting. Please stop texting me.',
    'Reply NO if you need me to stop texting; do not contact me again.',
    'Wrong number. Reply STOP to stop messages.',
    'I already tried to reply STOP to stop messages about exclusive leads, but you keep texting me.',
    'Your instructions told me to text STOP to stop messages about exclusive leads.',
    'Reply STOP to stop messages about exclusive leads did not work when I tried it.',
    'STOP',
    'Disliked "STOP"',
  ])('preserves a real opt-out even when reply instructions are excluded: %s', (body) => {
    expect(detectSmsOptCommand(body, { ignoreReplyInstructions: true }).action).toBe('opt_out');
  });

  test.each([
    'We have exclusive pest leads. Reply STOP if this is the wrong number.',
    'We have exclusive pest leads for you. Text STOP if wrong number.',
    'Exclusive leads available in your area\nReply NO if this is the wrong number',
  ])('can exclude a vendor wrong-number footer while keeping legacy detection: %s', (body) => {
    expect(detectSmsOptCommand(body).action).toBe('opt_out');
    expect(detectSmsOptCommand(body, { ignoreReplyInstructions: true }).action).toBeNull();
  });

  test('strips an "in error" footer variant that carries no other opt-out signal', () => {
    const body = 'I found your info online. Reply STOP if you received this in error.';
    expect(detectSmsOptCommand(body).action).toBeNull();
    expect(detectSmsOptCommand(body, { ignoreReplyInstructions: true }).action).toBeNull();
  });

  test.each([
    'We have exclusive pest leads. If this is the wrong number, reply STOP.',
    'We have exclusive pest leads for you. If wrong number, text STOP.',
    'Exclusive leads available in your area\nIf this is the wrong number, reply NO',
  ])('can exclude a condition-first vendor wrong-number footer while keeping legacy detection: %s', (body) => {
    expect(detectSmsOptCommand(body).action).toBe('opt_out');
    expect(detectSmsOptCommand(body, { ignoreReplyInstructions: true }).action).toBeNull();
  });

  test.each([
    'wrong number',
    'sorry wrong number',
    'you have the wrong number',
    'Sorry, you have the wrong number.',
  ])('keeps a genuine human wrong-number reply working even when reply instructions are excluded: %s', (body) => {
    expect(detectSmsOptCommand(body, { ignoreReplyInstructions: true })).toMatchObject({
      action: 'opt_out',
      reason: 'wrong_number',
    });
  });
});
