const { detectSmsOptCommand } = require('../services/messaging/opt-out-detector');

describe('SMS opt-out detector', () => {
  test.each([
    ['STOP', 'opt_out', 'opt_out_keyword'],
    ['stopp', 'opt_out', 'opt_out_natural_language'],
    ['please remove me from this list', 'opt_out', 'opt_out_natural_language'],
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
});
