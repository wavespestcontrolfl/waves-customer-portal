// Owner ruling 2026-09-26: customer texts are never signed. The shared
// stripper removes a trailing sign-off — dash- or line-set, a known closer
// + signer, any short valediction on its own line above the signer,
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
    ['Kind regards,\nAdam', ''],
    ['Your next visit is Tuesday. - Adam \u{1F44B}\u{1F3FD}', 'Your next visit is Tuesday.'],
    ['Your next visit is Tuesday. - Adam \u{1F1FA}\u{1F1F8}', 'Your next visit is Tuesday.'],
    ['See you then! - Adam \u{1F44D}\u{1F3FD}\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', 'See you then!'],
    ['See you then! - Adam \u{1F468}\u200D\u{1F469}\u200D\u{1F467} #\uFE0F\u20E3', 'See you then!'],
    ['Your visit is Tuesday. - Virginia', 'Your visit is Tuesday.'],
    ['Talk soon. Thanks, Virginia', 'Talk soon.'],
    ['"We\'ll see you Tuesday. - Adam"', "We'll see you Tuesday."],
    ["'See you Tuesday. - Adam'", 'See you Tuesday.'],
    ["'We'll see you Tuesday. - Adam'", "We'll see you Tuesday."],
    ["'See you Tuesday.' - Adam", 'See you Tuesday.'],
    ['"See you Tuesday. - Adam" \u{1F30A}', 'See you Tuesday.'],
    ['""Gold plan" covers ants. - Adam"', '"Gold plan" covers ants.'],
    ['"Quarterly" means every three months. - Adam', '"Quarterly" means every three months.'],
    ['"— Adam, Waves Pest Control"', ''],
    // Same-line valedictions that also appear in two-line form.
    ['Ants are active. All the best, Adam', 'Ants are active.'],
    ['Sincerely yours, Adam', ''],
    ['See you Tuesday. Yours truly, Adam', 'See you Tuesday.'],
    ['See you Tuesday. Many thanks, Adam', 'See you Tuesday.'],
    ['See you Tuesday. With gratitude, Adam', 'See you Tuesday.'],
    // Keyboard emoticons after the signer.
    ['Your next visit is Tuesday. - Adam :)', 'Your next visit is Tuesday.'],
    ['Your next visit is Tuesday. - Adam :-) ;D', 'Your next visit is Tuesday.'],
    ['Talk soon! Thanks, Adam <3', 'Talk soon!'],
    // An own-line signer under a finished sentence or an emoji.
    ['See you Tuesday.\nWaves Pest Control', 'See you Tuesday.'],
    ['See you Tuesday \u{1F60A}\nAdam', 'See you Tuesday \u{1F60A}'],
    ['"See you Tuesday."\nAdam', 'See you Tuesday.'],
    // A bare full signature block is a sign-off even as the whole text.
    ['Adam, Waves Pest Control', ''],
    ['Adam from Waves', ''],
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
    // Direct address to a customer named Adam is content, not a sign-off.
    'Confirmed. See you Tuesday, Adam.',
    'Please call us, Adam.',
    // Two separate quoted phrases at the edges are not a wrapper.
    '"Quarterly" means every three months, not "monthly"',
    '"Sounds good"',
    "'Gold' covers ants, not 'termites'",
    // A lone name or company as the last sentence can answer the one before.
    'Who will be coming? Adam.',
    'Which company is this? Waves Pest Control.',
    // A label/value layout answers the customer; it is not a sign-off.
    'Your technician is:\nAdam',
    'The charge appears as:\nWaves Pest Control',
    // A name on its own line after a question or an unfinished sentence
    // answers it.
    'Who will be coming?\nAdam',
    'Who is your technician?\nAdam',
    'Your technician will be\nAdam',
    'The charge will appear as\nWaves Pest Control',
    // A smiley in content is content.
    'Your visit is Tuesday :)',
    // Thanking a customer named Adam is the message, not a sign-off.
    'Thanks, Adam!',
    'Thank you, Adam!',
    // Valediction words never reach into the line above.
    'Your contacts are\nAdam,\nVirginia',
    // A dash after "is"/"as" introduces the answer.
    'The charge appears as - Waves Pest Control',
    'Your technician is - Adam',
    'Your contact is \u2014 Virginia',
  ])('keeps text that is not a sign-off: %j', (input) => {
    expect(stripTrailingSignature(input)).toBe(input);
  });

  describe('addressed to a customer who shares a signer\'s first name', () => {
    test.each([
      ['Hello Adam! See you soon, Adam.', 'Adam'],
      ['See you soon, Adam', 'adam'],
      ['Your visit is Tuesday.\nAdam', 'Adam'],
      ['Talk soon! Thanks, Virginia', 'Virginia'],
    ])('keeps %j for a customer named %s', (input, addresseeFirstName) => {
      expect(stripTrailingSignature(input, { addresseeFirstName })).toBe(input);
    });

    test.each([
      // Company sign-offs and full signature blocks still go.
      ['See you soon. - Waves Pest Control', 'Adam', 'See you soon.'],
      ['See you soon. Adam, Waves Pest Control', 'Adam', 'See you soon.'],
      // The other signer's name is still a sign-off.
      ['See you soon. - Virginia', 'Adam', 'See you soon.'],
      // A different customer: unchanged behavior.
      ['See you soon, Adam.', 'Maria', ''],
    ])('strips %j for a customer named %s', (input, addresseeFirstName, expected) => {
      expect(stripTrailingSignature(input, { addresseeFirstName })).toBe(expected);
    });
  });
});
