/**
 * The same-order check for a tidied technician note (owner 2026-11-21, "same
 * order"): services/service-report/report-note-order.js.
 *
 * Behavior these tests pin: a text passes only when its words are the note's
 * words in the note's order, with one sentence for each sentence of the note
 * it keeps. It adds only small words, and leaves out only a small word, a
 * word the report's screens refuse, or a whole part that is not for the
 * customer.
 * Regression they guard: a customer report, signed with the technician's
 * name, that says something the technician did not say.
 * Gap in existing proof: no other suite reads this module. Synthetic notes.
 */

const { orderRejection, noteWords, orderToCustomer } = require('../services/service-report/report-note-order');

// A stand-in for the report's word screen: the reason a customer text may not
// hold the fragment, or null. The real one is report-own-note.js.
const SCREEN = [
  [/\b(?:gate|code)\b/i, 'access_code'],
  [/\b(?:rude|paid|billing)\b/i, 'not_for_customer'],
  [/\bborlux\b/i, 'trade_name'],
  [/^\s*(?:use|open)\b/i, 'instruction'],
];
const refused = (fragment) => (SCREEN.find(([shape]) => shape.test(fragment)) || [])[1] || null;
const rejection = (note, text) => orderRejection(text, note, refused, ['Borlux SC']);

describe('the text may go out', () => {
  test.each([
    ['a note with no marks becomes one sentence', 'found fire ant hill near back of house spot treated it swept spider webs outside',
      'I found a fire ant hill near the back of the house and spot treated it and swept the spider webs outside.'],
    ['a note of four sentences keeps four sentences', 'checked the kitchen. checked the shed. checked the attic. checked the yard',
      'I checked the kitchen. I checked the shed. I checked the attic. I checked the yard.'],
    ['the customer is "you"', 'customer said she\'s been seeing little ants by the kitchen sink. baited under the sink and along the window',
      'You said you have been seeing little ants by the kitchen sink. I baited under the sink and along the window.'],
    ['a short form becomes its full word', 'treated int and ext. cust has a new baby so used only bait inside',
      'I treated the interior and exterior. You have a new baby so I used only bait inside.'],
    ['a count as a word', 'checked all rodent stations. feeding in 2 of 6. replaced bait', 'I checked all the rodent stations. Feeding was in two of six. I replaced the bait.'],
    ['a decimal stays a decimal', 'found 1.5 nests by the shed', 'I found 1.5 nests by the shed.'],
    ['what phone dictation writes for a word of the trade', 'pimento bugs in the lanai. swept the eves', 'Palmetto bugs were in the lanai. I swept the eaves.'],
    ['two words written as one', 'customer said the lawn guy saw sod web worms', 'You said the lawn guy saw sod webworms.'],
    ['"I serviced" before a part that names only places', 'cust not home. ext only', 'You were not home. I serviced the exterior only.'],
    ['a question stays a question', 'treated the shed. is the dog inside?', 'I treated the shed. Is the dog inside?'],
    ['a condition stays with its work', 'if ants return, treat the shed', 'If ants return, I treat the shed.'],
    ['every word of a product name and its amount are left out', 'sprayed Borlux SC around the house 2 gallons, baited the kitchen', 'I sprayed around the house and baited the kitchen.'],
    ['a period of time is left out with its figure', 'set 4 traps in the attic will recheck in two weeks', 'I set four traps in the attic and will recheck.'],
    ['a word the screen refuses is left out', 'treated around the gate and the fence', 'I treated around the fence.'],
    ['a refused pair of words is left out together', 'quiet visit no issues sprayed outside', 'It was a quiet visit and I sprayed outside.'],
    ['a part for the office is left out whole', 'billing: charge extra for the wasp nest. customer was rude. treated outside', 'I treated outside.'],
    ['a removed code goes with its part', 'used [redacted] at the side. treated shed', 'I treated the shed.'],
    ['an order to the customer is left out', 'treated the lawn, keep pets off the grass, swept the eaves', 'I treated the lawn and swept the eaves.'],
    ['a finding that opens like an order stays', 'water in the basement. treated shed', 'Water was in the basement. I treated the shed.'],
    ['nothing seen with no spot named is left out', 'no activity inside. treated baseboards in kitchen', 'I treated the baseboards in the kitchen.'],
    ['nothing seen in a named spot stays', 'no droppings in the attic. set 2 traps', 'No droppings were in the attic. I set two traps.'],
    ['a part that is left out shares a word with a part that stays', 'no activity inside. no ants in the kitchen. treated baseboards', 'No ants were in the kitchen. I treated the baseboards.'],
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
    ['an added reason', 'treated the garage', 'I treated the garage because of ants.', 'not_in_note', 'because'],
    ['a word in a new spelling the check does not know', 'mouse in the shed', 'A house was in the shed.', 'not_in_note', 'house'],
    ['"not" made from "note"', 'left a note. treated the shed', 'I left. It was not treated, the shed.', 'not_in_note', 'not'],
    ['"not able" written as one word', 'ants not able to reach the bait', 'Ants notable to reach the bait.', 'not_in_note', 'notable'],
    ['a sentence of added words alone', 'treated the shed', 'I treated the shed. I was there.', 'not_in_note', 'i'],
    ['"I" put beside the customer', 'customer treated the shed', 'The customer and I treated the shed.', 'not_in_note', 'i'],
    ['"I" put beside another person', 'the neighbor sprayed the fence line', 'The neighbor and I sprayed the fence line.', 'not_in_note', 'i'],
    ['"I serviced" before work or a pest', 'ants in the kitchen', 'I serviced ants in the kitchen.', 'not_in_note', 'serviced'],
    ['two words that changed places', 'treated the mouse hole by the house', 'I treated the house hole by the mouse.', 'out_of_order', 'hole'],
    ['a denial left out', 'no ants in kitchen treated baseboards', 'Ants were in the kitchen and I treated the baseboards.', 'left_out', 'no'],
    ['"not" left out', 'did not treat the shed, dog inside', 'I did treat the shed.', 'left_out', 'not'],
    ['"would" left out of "I\'d"', 'I\'d treat the shed', 'I treated the shed.', 'left_out', 'would'],
    ['the person who did the work left out', 'customer treated the shed himself', 'I treated the shed.', 'left_out', 'customer'],
    ['a condition left out', 'will come back if activity continues', 'I will come back.', 'left_out', 'if'],
    ['a condition left out with the office part that holds it', 'treated kitchen, if customer paid', 'I treated the kitchen.', 'left_out', 'if'],
    ['a count left out', 'set 4 traps in attic', 'I set traps in the attic.', 'left_out', '4'],
    ['a plain word that could open an order left out', 'left the shed window open', 'I left the shed window.', 'left_out', 'open'],
    ['a finding left out as if it were an order', 'open gap under the sink, treated shed', 'I treated the shed.', 'left_out', 'open'],
    ['a part for the customer left out', 'treated kitchen. found german roaches behind fridge. treated shed', 'I treated the kitchen. I treated the shed.', 'left_out', 'found'],
    ['half of a refused pair kept', 'quiet visit no issues sprayed outside', 'It was a quiet visit, issues and I sprayed outside.', 'left_out', 'no'],
    ['two sentences of the note joined', 'cust not home. ext only', 'You were not home and I serviced the exterior only.', 'joined', 'exterior'],
    ['a line break in the note is a sentence end', 'cust not home\next only', 'You were not home and I serviced the exterior only.', 'joined', 'exterior'],
    ['a denial cut from what it denies', 'did not treat shed', 'I did not. I treated the shed.', 'split', 'treated'],
    ['a condition cut from the work it holds back', 'if ants return, treat the shed', 'If ants return. I treated the shed.', 'split', 'treated'],
    ['a question made a statement', 'treated the shed?', 'I treated the shed.', 'question', 'treated'],
    ['a statement made a question', 'treated the shed', 'I treated the shed?', 'question', 'treated'],
  ])('%s', (_label, note, text, reason, word) => {
    expect(rejection(note, text)).toEqual({ reason, words: [word] });
  });

  test('no note: no text passes', () => {
    expect(rejection('', 'I was there.')).toEqual({ reason: 'not_in_note', words: ['i'] });
  });

  test('with no screen, a word is left out only when it is a small word', () => {
    expect(orderRejection('I treated around the fence.', 'treated around the gate and the fence')).toEqual({ reason: 'left_out', words: ['gate'] });
  });

  test('a word for the office never goes alone: "not paid" must not leave "not" behind', () => {
    expect(rejection('customer not paid treated kitchen', 'You have not treated the kitchen.')).toEqual({ reason: 'left_out', words: ['paid'] });
  });
});

describe('the words the check reads', () => {
  test('contractions, decimals and thousands', () => {
    expect(noteWords("I'd say she's been here; didn't see 1.5 or 1,200")).toEqual(
      ['i', 'would', 'say', 'she', 'has', 'been', 'here', 'did', 'not', 'see', '1point5', 'or', '1200'],
    );
  });

  test.each([
    ['keep pets off the grass', true],
    ['water the lawn twice', true],
    ['customer should water the lawn', true],
    ['advised customer to keep the dogs out', true],
    ['do not use the lanai', true],
    ['water in the basement', false],
    ['keep seeing ants in the kitchen', false],
    ['sprayed perimeter to keep the ants out', false],
    ['open gap under the sink', false],
  ])('an order to the customer: %s', (part, isOrder) => {
    expect(orderToCustomer(noteWords(part))).toBe(isOrder);
  });
});
