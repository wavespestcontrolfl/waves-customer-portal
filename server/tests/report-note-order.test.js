/**
 * The same-order check for a tidied technician note (owner 2026-11-21, "same
 * order"): services/service-report/report-note-order.js.
 *
 * Behavior these tests pin: a text passes only when its words are the note's
 * words, letter for letter and in the note's order, with one sentence for
 * each sentence of the note it keeps. It adds only small words, and leaves
 * out only a small word or what the report's screens say may go: a word, two
 * words together, a whole part of the note.
 * Regression they guard: a customer report, signed with the technician's
 * name, that says something the technician did not say.
 * Gap in existing proof: no other suite reads this module. Synthetic notes.
 */

const { orderRejection, noteWords, isCount } = require('../services/service-report/report-note-order');

// A stand-in for what the report's screens say may go. The real screens are
// report-own-note.js: there, what may go is what no report text may hold.
const screen = {
  wordGoes: (word) => ['gate', 'code', 'borlux', 'weeks'].includes(word),
  pairGoes: (first, second) => (first === 'no' && second === 'issues') || (isCount(first) && ['gallons', 'weeks'].includes(second)),
  partGoes: (part) => /\b(?:gate|code|rude|paid|billing)\b|\[redacted\]|^\s*no (?:activity inside|bugs outside)\s*$|\bkeep pets off\b/i.test(part),
  names: ['Borlux SC'],
};
const rejection = (note, text) => orderRejection(text, note, screen);

describe('the text may go out', () => {
  test.each([
    ['a note with no marks becomes one sentence', 'found fire ant hill near back of house spot treated it swept spider webs outside',
      'I found a fire ant hill near the back of the house and spot treated it and swept the spider webs outside.'],
    ['a note of four sentences keeps four sentences', 'checked the kitchen. checked the shed. checked the attic. checked the yard',
      'I checked the kitchen. I checked the shed. I checked the attic. I checked the yard.'],
    ['the customer is "you", with the verb form "you" takes', 'customer said she\'s been seeing little ants by the kitchen sink. baited under the sink and along the window',
      'You said you have been seeing little ants by the kitchen sink. I baited under the sink and along the window.'],
    ['a short form becomes its full word', 'treated int and ext. cust has a new baby so used only bait inside',
      'I treated the interior and exterior. You have a new baby so I used only bait inside.'],
    ['a count as a word', 'checked all rodent stations. feeding in 2 of 6. replaced bait', 'I checked all the rodent stations. Feeding was in two of six. I replaced the bait.'],
    ['a decimal stays a decimal', 'found 1.5 nests by the shed', 'I found 1.5 nests by the shed.'],
    ['a range stays a range, with any dash', 'set 2 - 3 traps in the attic', 'I set 2–3 traps in the attic.'],
    ['what phone dictation writes for a word of the trade', 'pimento bugs in the lanai. swept the eves', 'Palmetto bugs were in the lanai. I swept the eaves.'],
    ['a part that names only a place stays as said', 'cust not home. ext only', 'You were not home. Exterior only.'],
    ['a question stays a question', 'treated the shed. is the dog inside?', 'I treated the shed. Is the dog inside?'],
    ['a condition stays with its work', 'if ants return, treat the shed', 'If ants return, treat the shed.'],
    ['an obligation stays an obligation', 'had to treat shed', 'I had to treat the shed.'],
    ['a word that is also a property name of an object', 'constructor checked stairs', 'The constructor checked the stairs.'],
    ['every word of a product name goes, and a figure with its unit', 'sprayed Borlux SC around the house 2 gallons, baited the kitchen', 'I sprayed around the house and baited the kitchen.'],
    ['"of" goes with the amount before it', 'applied 2 gallons of bait in the kitchen', 'I applied bait in the kitchen.'],
    ['a word that leads into a product name goes with it', 'treated with Borlux SC in kitchen', 'I treated in the kitchen.'],
    ['a period goes with its figure and the word that leads into it', 'set 4 traps in the attic will recheck in two weeks', 'I set four traps in the attic and will recheck.'],
    ['a word the screens let go', 'treated around the gate and the fence', 'I treated around the fence.'],
    ['two words that go together', 'quiet visit no issues sprayed outside', 'It was a quiet visit and I sprayed outside.'],
    ['two words that go together, before the same word again', 'no issues, no ants in the kitchen', 'No ants were in the kitchen.'],
    ['a part the screens refuse goes whole', 'billing: charge extra for the wasp nest. customer was rude. treated outside', 'I treated outside.'],
    ['a removed code goes with its part', 'used [redacted] at the side. treated shed', 'I treated the shed.'],
    ['a refused part between two that stay', 'treated the lawn, keep pets off the grass, swept the eaves', 'I treated the lawn and swept the eaves.'],
    ['a refused part goes with the condition inside it', 'treated the lawn, keep pets off until dry', 'I treated the lawn.'],
    ['a part the screens do not refuse stays', 'water in the basement. treated shed', 'Water was in the basement. I treated the shed.'],
    ['a part that goes shares a word with a part that stays', 'no activity inside. no ants in the kitchen. treated baseboards', 'No ants were in the kitchen. I treated the baseboards.'],
    ['of two parts that may go, one goes and one stays', 'no activity inside. no activity in the kitchen. no bugs outside',
      'No activity in the kitchen. No bugs outside.'],
  ])('%s', (_label, note, text) => {
    expect(rejection(note, text)).toBeNull();
  });
});

describe('the text is refused', () => {
  test.each([
    ['an added place', 'treated outside', 'I treated outside and inside.', 'not_in_note', 'inside'],
    ['an added pest', 'treated kitchen for ants', 'I treated the kitchen for ants and roaches.', 'not_in_note', 'roaches'],
    ['a changed count', '3 rodent stations checked 2 had feeding', 'Three rodent stations were checked and four had feeding.', 'not_in_note', 'four'],
    ['a decimal read as a whole number', 'found 1.5 nests', 'I found 15 nests.', 'not_in_note', '15'],
    ['a fraction read as a range', 'applied 1/2 bag', 'I applied 1-2 bag.', 'not_in_note', '1mark45mark2'],
    ['an added reason', 'treated the garage', 'I treated the garage because of ants.', 'not_in_note', 'because'],
    ['one letter changed', 'mouse in the shed', 'A house was in the shed.', 'not_in_note', 'house'],
    ['another action with almost the same letters', 'taped the opening', 'I tapped the opening.', 'not_in_note', 'tapped'],
    ['a changed tense', 'treat shed', 'I treated the shed.', 'not_in_note', 'treated'],
    ['one made many', 'ant in the kitchen', 'Ants were in the kitchen.', 'not_in_note', 'ants'],
    ['"not" made from "note"', 'left a note. treated the shed', 'I left. It was not treated, the shed.', 'not_in_note', 'not'],
    ['"nowhere" made from "now here"', 'ants are now here', 'Ants are nowhere.', 'not_in_note', 'nowhere'],
    ['two words written as one', 'saw sod web worms', 'I saw sod webworms.', 'not_in_note', 'webworms'],
    ['a sentence of added words alone', 'treated the shed', 'I treated the shed. I was there.', 'not_in_note', 'i'],
    ['"I" put beside the customer', 'customer treated the shed', 'The customer and I treated the shed.', 'not_in_note', 'i'],
    ['"I" put beside another person', 'the neighbor sprayed the fence line', 'The neighbor and I sprayed the fence line.', 'not_in_note', 'i'],
    ['"I" put where the note names no one', 'customer said saw roaches in kitchen', 'You said I saw roaches in the kitchen.', 'not_in_note', 'i'],
    ['"I" put after a comma the text adds', 'customer said saw roaches in kitchen', 'You said, I saw roaches in the kitchen.', 'not_in_note', 'i'],
    ['an added "serviced"', 'checked the shed. yard only', 'I checked the shed and I serviced it. Yard only.', 'not_in_note', 'serviced'],
    ['an added "have"', 'ants in the kitchen', 'I have ants in the kitchen.', 'not_in_note', 'have'],
    ['two words that changed places', 'treated the mouse hole by the house', 'I treated the house hole by the mouse.', 'out_of_order', 'hole'],
    ['a denial left out', 'no ants in kitchen treated baseboards', 'Ants were in the kitchen and I treated the baseboards.', 'left_out', 'no'],
    ['"not" left out', 'did not treat the shed, dog inside', 'I did treat the shed.', 'left_out', 'not'],
    ['"would" left out of "I\'d"', 'I\'d treat the shed', 'I treat the shed.', 'left_out', 'would'],
    ['an obligation made a claim', 'had to treat shed', 'I treat the shed.', 'left_out', 'had'],
    ['the person who did the work left out', 'customer treated the shed himself', 'I treated the shed.', 'left_out', 'customer'],
    ['a condition left out', 'will come back if activity continues', 'I will come back.', 'left_out', 'if'],
    ['a condition left out with the refused part that opens with it', 'treated kitchen, if customer paid', 'I treated the kitchen.', 'left_out', 'if'],
    ['a count left out', 'set 4 traps in attic', 'I set traps in the attic.', 'left_out', '4'],
    ['a unit left out and its figure kept', 'applied 2 gallons of bait', 'I applied 2 bait.', 'out_of_order', '2'],
    ['half of two words that go together kept', 'quiet visit no issues sprayed outside', 'It was a quiet visit, issues and I sprayed outside.', 'left_out', 'no'],
    ['a plain word left out', 'left the shed window open', 'I left the shed window.', 'left_out', 'open'],
    ['a finding the screens do not refuse left out', 'open gap under the sink, treated shed', 'I treated the shed.', 'left_out', 'open'],
    ['a finding left out with a denial beside it', 'found a nest and did not treat it. checked the shed', 'I checked the shed.', 'left_out', 'found'],
    ['nothing seen in a named spot left out', 'do not see activity in the attic. treated shed', 'I treated the shed.', 'left_out', 'do'],
    ['a whole sentence for the customer left out', 'treated kitchen. found german roaches behind fridge. treated shed', 'I treated the kitchen. I treated the shed.', 'left_out', 'found'],
    ['two sentences of the note joined', 'cust not home. ext only', 'You were not home and exterior only.', 'joined', 'exterior'],
    ['a line break in the note is a sentence end', 'cust not home\next only', 'You were not home and exterior only.', 'joined', 'exterior'],
    ['a denial cut from what it denies', 'did not treat shed', 'I did not. I treat the shed.', 'split', 'treat'],
    ['a condition cut from the work it holds back', 'if ants return, treat the shed', 'If ants return. I treat the shed.', 'split', 'treat'],
    ['a question made a statement', 'treated the shed?', 'I treated the shed.', 'question', 'treated'],
    ['a statement made a question', 'treated the shed', 'I treated the shed?', 'question', 'treated'],
  ])('%s', (_label, note, text, reason, word) => {
    expect(rejection(note, text)).toEqual({ reason, words: [word] });
  });

  test('no note: no text passes', () => {
    expect(rejection('', 'I was there.')).toEqual({ reason: 'not_in_note', words: ['i'] });
  });

  test('with no screen, only a small word is left out', () => {
    expect(orderRejection('I treated around the fence.', 'treated around the gate and the fence')).toEqual({ reason: 'left_out', words: ['gate'] });
    expect(orderRejection('I applied bait.', 'applied 2 gallons of bait')).toEqual({ reason: 'left_out', words: ['2'] });
    expect(orderRejection('I treated the shed.', 'no activity inside. treated shed')).toEqual({ reason: 'left_out', words: ['no'] });
  });

  test('a word the screens refuse inside a part stays missing: "not paid" must not leave "not" behind', () => {
    expect(rejection('customer not paid treated kitchen', 'You not treated the kitchen.')).toEqual({ reason: 'left_out', words: ['paid'] });
  });

  test('a denial, a condition or a person never goes as one word, whatever the screens say', () => {
    const all = { wordGoes: () => true };
    expect(orderRejection('I treated the shed.', 'not treated shed', all)).toEqual({ reason: 'left_out', words: ['not'] });
    expect(orderRejection('The shed.', 'customer treated shed', all)).toEqual({ reason: 'left_out', words: ['customer'] });
  });
});

describe('the words the check reads', () => {
  test('contractions, and a mark between two digits', () => {
    expect(noteWords("I'd say she's been here; didn't see 1.5 or 1,200")).toEqual(
      ['i', 'would', 'say', 'she', 'has', 'been', 'here', 'did', 'not', 'see', '1point5', 'or', '1200'],
    );
    expect(noteWords('1/2, 1-2, 1 – 2')).toEqual(['1mark47mark2', '1mark45mark2', '1mark45mark2']);
  });
});
