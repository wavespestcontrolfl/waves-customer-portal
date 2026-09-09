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
    'STOP',
    'Disliked "STOP"',
  ])('preserves a real opt-out even when reply instructions are excluded: %s', (body) => {
    expect(detectSmsOptCommand(body, { ignoreReplyInstructions: true }).action).toBe('opt_out');
  });
});
