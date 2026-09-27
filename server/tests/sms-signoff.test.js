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
    "Who's coming Tuesday?\nAdam",
    'Which technician is coming?\nAdam',
    'Which company is this?\nWaves Pest Control',
    'What is your name?\nAdam',
    'Your technician will be\nAdam',
    'The charge will appear as\nWaves Pest Control',
    // A smiley in content is content.
    'Your visit is Tuesday :)',
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
      ['Thanks, Adam!', 'Adam'],
      ['Thank you, Adam!', 'Adam'],
    ])('keeps %j for a customer named %s', (input, addresseeFirstName) => {
      expect(stripTrailingSignature(input, { addresseeFirstName })).toBe(input);
    });

    test.each([
      // Company sign-offs and full signature blocks still go.
      ['See you soon. - Waves Pest Control', 'Adam', 'See you soon.'],
      ['See you soon. Adam, Waves Pest Control', 'Adam', 'See you soon.'],
      // The other signer's name is still a sign-off.
      ['See you soon. - Virginia', 'Adam', 'See you soon.'],
      // A dash-set staff name is a sign-off even to a customer with that name.
      ['See you soon. - Adam', 'Adam', 'See you soon.'],
      ['See you soon. - Thanks, Adam', 'Adam', 'See you soon.'],
      // A different customer: unchanged behavior, including a thanks-only text.
      ['See you soon, Adam.', 'Maria', ''],
      ['Thanks, Adam!', 'Sam', ''],
      ['Thanks, Adam!', undefined, ''],
    ])('strips %j for a customer named %s', (input, addresseeFirstName, expected) => {
      expect(stripTrailingSignature(input, { addresseeFirstName })).toBe(expected);
    });
  });
});

// #4975: opt-in `anySigner` for text a model writes from arbitrary input —
// a dash sign-off by a name the patterns do not know, in unambiguous form only.
describe('stripTrailingSignature — anySigner', () => {
  const any = (text) => stripTrailingSignature(text, { anySigner: true });

  test.each([
    ['We can help. — Sarah', 'We can help.'],
    ['We can help!\n— Sarah', 'We can help!'],
    ['Would you like to schedule?\n— Sarah', 'Would you like to schedule?'],
    ['— Sarah', ''],
    ['We can help. — sarah', 'We can help.'],
    ['We can help. — Élodie', 'We can help.'],
    ['We can help.\n\n— Sarah Jones, Waves Team', 'We can help.'],
    // Codex r4 + r5 on #4975: closer-marked sign-offs by any name.
    ['We can help.\nThanks,\nSarah', 'We can help.'],
    ['We can help.\nBest regards,\nSarah Jones, Waves Team', 'We can help.'],
    ['Talk soon!\nSarah', 'Talk soon!'],
    ['We can help.\nThanks!\nSarah Jones', 'We can help.\nThanks!'],
    // Codex r7 on #4975: the company joined by from/at/with, and a signature
    // under a list (blank line or not) is not a list value.
    ['We can help. — Sarah from Waves', 'We can help.'],
    ['We can help.\n— Sarah with the Waves team', 'We can help.'],
    ['We can help.\nThanks,\nSarah at Waves Pest Control', 'We can help.'],
    ['Options:\n- Lawn Care\n\n— Adam, Waves Pest Control', 'Options:\n- Lawn Care'],
    ['Options:\n- Lawn Care\n\n— Sarah', 'Options:\n- Lawn Care'],
    ['Options:\n- Lawn Care\n— Adam, Waves Pest Control', 'Options:\n- Lawn Care'],
    // #4975 follow-up (owner ruling on #5083): a dashed Waves name after any
    // question is a sign-off, as it is for every other caller.
    ['When works best for you?\n— Adam', 'When works best for you?'],
    ['What day works best for you?\n- Adam', 'What day works best for you?'],
    ['Which works better, Tuesday or Wednesday?\n— Waves Pest Control', 'Which works better, Tuesday or Wednesday?'],
    ['Who will be coming?\n— Adam', 'Who will be coming?'],
    ['Which representative is coming?\n— Adam', 'Which representative is coming?'],
    ['Which company is this?\n— Waves Team', 'Which company is this?'],
  ])('%j → %j', (text, expected) => {
    expect(any(text)).toBe(expected);
  });

  test.each([
    'Which service? — Lawn Care',
    'We serve your area — Sarasota.',
    'Totally. — Tuesday works.',
    'Your technician is — Sarah',
    'Your technician is\n— Sarah',
    'Your technician is:\nSarah',
    'Your technician is \n— Sarah',
    'Your technician this week:\nSarah',
    'Who will be coming?\nSarah Jones',
    'Here are the options,\nLawn Care',
    // Codex r5 on #4975: a bare capitalized final line is not enough —
    // short calls to action have the same shape as a name.
    'We can help with ants.\nReply YES',
    'We can help with ants.\nCall Today',
    'We can help with ants.\nSchedule Online',
    'We can help.\nSarah Jones',
    'Thanks, Sarah!',
    'See you Tuesday — Mike will be your tech.',
    // Codex r6 on #4975: a dashed value under a label, an information
    // question or a list item is the answer, not a sign-off.
    'Which service:\n— Lawn Care',
    'Your technician:\n— Sarah',
    'Your technician is:\n— Sarah',
    'Who will be coming?\n— Sarah',
    'Your technician is:\n— Adam',
    'Options:\n- Lawn Care\n- Pest Control',
    // #4975 follow-up: a dashed answer to an information question stays. An
    // unknown name there has an answer's shape too, so it stays as well.
    'Which service?\n— Lawn Care',
    'Where are you located?\n— Lakewood Ranch',
    'When works for you?\n— Sarah',
    // Codex r1 + r2 on #5083: a three-word call to action is not a name, and
    // a signature never runs onto the next line.
    'Thanks!\nCall Us Today',
    'Talk soon!\nSchedule Online Today',
    'Options:\n- Lawn Care\nTuesday',
    'Options:\n- Lawn Care,\nTuesday',
  ])('%j is not a sign-off and is kept', (text) => {
    expect(any(text)).toBe(text);
  });

  test('without anySigner an unknown name is left alone (existing callers unchanged)', () => {
    expect(stripTrailingSignature('We can help. — Sarah')).toBe('We can help. — Sarah');
  });

  test('the customer\'s own first name is the addressee and stays; a closer + other name on one line goes only when the customer is known', () => {
    const as = (addresseeFirstName) => ({ anySigner: true, addresseeFirstName });
    expect(stripTrailingSignature('Talk soon!\nSarah', as('Sarah'))).toBe('Talk soon!\nSarah');
    expect(stripTrailingSignature('Talk soon!\nSarah', as('Tom'))).toBe('Talk soon!');
    // Codex r5 on #4975: same-line closer + name.
    expect(stripTrailingSignature('We can help. Thanks, Sarah', as('Pat'))).toBe('We can help.');
    expect(stripTrailingSignature('We can help. Thanks, Sarah', as('Sarah'))).toBe('We can help. Thanks, Sarah');
    expect(stripTrailingSignature('We can help. Thanks, Sarah', as(undefined))).toBe('We can help. Thanks, Sarah');
  });
});

// Pre-push audit on #4975: the addressee check compares the first word of a
// full name ("Sarah Jones") with the customer's first name.
test('anySigner keeps a closer block that names the customer by full name', () => {
  expect(stripTrailingSignature('Thanks,\nSarah Jones!', { anySigner: true, addresseeFirstName: 'Sarah' })).toBe('Thanks,\nSarah Jones!');
  expect(stripTrailingSignature('We can help.\nSarah Jones', { anySigner: true, addresseeFirstName: 'Sarah' })).toBe('We can help.\nSarah Jones');
});
