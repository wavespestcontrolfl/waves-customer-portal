// Owner ruling 2026-09-26: customer texts are never signed. The shared
// stripper removes a trailing sign-off — dash- or line-set, closer (listed or
// any short comma-ended valediction) + signer,
// or a bare signer that is its own final sentence, even inside wrapping
// quotes or before a trailing emoji — and nothing else.
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
    ['Talk soon. Thanks, Adam', 'Talk soon.'],
    ['Talk soon. Adam, Waves Pest Control', 'Talk soon.'],
    ['See you Tuesday. Best,\nAdam', 'See you Tuesday.'],
    ['Call us anytime. - Adam B.', 'Call us anytime.'],
    ['Talk soon. Adam Benetti, Waves Pest Control', 'Talk soon.'],
    ['See you Tuesday. Adam from Waves', 'See you Tuesday.'],
    ['Ants are active now. Thank you,\nAdam B.', 'Ants are active now.'],
    ['Ants are active now. - Thanks, Adam', 'Ants are active now.'],
    ['See you then! Cheers Adam', 'See you then!'],
    ['Best, Adam', ''],
    ['— Adam, Waves Pest Control', ''],
    ['"Your next visit is Tuesday. - Adam"', 'Your next visit is Tuesday.'],
    ['“Your next visit is Tuesday.” - Adam', 'Your next visit is Tuesday.'],
    ['Your next visit is Tuesday. - Adam \u{1F30A}', 'Your next visit is Tuesday.'],
    ['Your next visit is Tuesday! Thanks, Adam \u{1F60A}', 'Your next visit is Tuesday!'],
    ['All the best,\nAdam', ''],
    ['Ants are active. All the best,\nAdam', 'Ants are active.'],
    ['Sincerely yours,\nAdam', ''],
    ['See you Tuesday. Warm regards, Adam', 'See you Tuesday.'],
    ['Ants are active now. With gratitude,\nAdam B.', 'Ants are active now.'],
  ])('strips the trailing sign-off from %j', (input, expected) => {
    expect(stripTrailingSignature(input)).toBe(expected);
  });

  test.each([
    'Hello! Waves Pest Control here. We got your request.',
    'Thanks for choosing Waves Pest Control',
    'Hi Adam, your visit is Tuesday.',
    'Your technician is Adam.',
    'I wanted to say thanks Adam',
    'Talk soon.',
    'Ghost ants love kitchens - we treat them all the time.',
    'It is included in our "Gold plan"',
    'See you Tuesday! \u{1F30A}',
    'Call me when you can, Adam',
    'We treat ants, roaches, and spiders.',
  ])('keeps text that is not a sign-off: %j', (input) => {
    expect(stripTrailingSignature(input)).toBe(input);
  });
});
