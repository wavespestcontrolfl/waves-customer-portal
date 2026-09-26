// Owner ruling 2026-09-26: customer texts are never signed. The shared
// stripper removes only a TRAILING sign-off set off by a dash or its own line.
const { stripTrailingSignature } = require('../services/messaging/sms-signoff');

describe('stripTrailingSignature', () => {
  test.each([
    ['Talk soon. — Adam, Waves Pest Control', 'Talk soon.'],
    ['Talk soon! - Adam', 'Talk soon!'],
    ['Talk soon!\nAdam, Waves Pest Control', 'Talk soon!'],
    ['See you Thursday. —Waves Pest Control', 'See you Thursday.'],
    ['Got it! — Adam — Waves Pest Control', 'Got it!'],
    ['Talk soon!\n— Adam\nWaves Pest Control', 'Talk soon!'],
    ['See you then! — Waves', 'See you then!'],
    ['Thanks! - The Waves Team', 'Thanks!'],
    ['— Adam, Waves Pest Control', ''],
  ])('strips the trailing sign-off from %j', (input, expected) => {
    expect(stripTrailingSignature(input)).toBe(expected);
  });

  test.each([
    'Hello! Waves Pest Control here. We got your request.',
    'Thanks for choosing Waves Pest Control',
    'Hi Adam, your visit is Tuesday.',
  ])('keeps text that is not a sign-off: %j', (input) => {
    expect(stripTrailingSignature(input)).toBe(input);
  });
});
