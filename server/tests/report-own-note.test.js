/**
 * The technician's own note as the report text (owner 2026-11-19 "GO"; owner
 * 2026-11-21 "same order"): what code lets out.
 *
 * services/service-report/report-own-note.js decides whether a tidied note
 * may be the customer's report text. Behavior these tests pin:
 *  - same order: the text's words are the note's words in the note's order;
 *    it adds only small words, leaves out only what is not for a customer,
 *    and never joins two sentences of the note;
 *  - the report's word screens run on the text: products, active ingredients,
 *    amounts, time, "safe", an access code, a contact line;
 *  - the wordings today's reader screens let stand are refused here, where
 *    the note is written (owner 2026-11-20, *A*).
 * Regression they guard: a customer report, signed with the technician's
 * name, that says something the technician did not say.
 * Gap in existing proof: no other suite reads this module. Synthetic data only.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  reportNoteRejection, orderRejection, fixedReportNote, ownNoteText, noteAsRead, MAX_OWN_NOTE_CHARS,
} = require('../services/service-report/report-own-note');
const { reportNoteCustomerCopy } = require('../services/service-report/technician-report-copy');

// Synthetic catalog rows in the shape readCatalogScreenRows returns.
const CATALOG = [
  { id: 1, name: 'Borlux SC', display_name: 'Borlux', active_ingredient: 'Zentrathrin', category: 'insecticide', manufacturer: 'Norvane', aliases: ['Quellar P'] },
  { id: 2, name: 'Vexion Cockroach Gel Bait', display_name: 'Vexion Gel', active_ingredient: 'Indoxacarb', category: 'bait', manufacturer: 'Norvane', aliases: [] },
];
const refusal = (note, text) => reportNoteRejection({ note, text, catalogRows: CATALOG });

describe('same order: the text may go out', () => {
  test.each([
    ['fragments become sentences', 'found fire ant hill near back of house spot treated it swept spider webs outside',
      'I found a fire ant hill near the back of the house and spot treated it. I swept the spider webs outside.'],
    ['the customer is "you"', 'customer said she\'s been seeing little ants by the kitchen sink. baited under the sink and along the window',
      'You said you have been seeing little ants by the kitchen sink. I baited under the sink and along the window.'],
    ['a short form becomes its full word', 'treated int and ext. cust has a new baby so used only bait inside',
      'I treated the interior and exterior. You have a new baby so I used only bait inside.'],
    ['a count as a word', 'checked all rodent stations. feeding in 2 of 6. replaced bait', 'I checked all the rodent stations. Feeding was in two of six. I replaced the bait.'],
    ['what phone dictation writes for a word of the trade', 'pimento bugs in the lanai. swept the eves', 'Palmetto bugs were in the lanai. I swept the eaves.'],
    ['two words written as one', 'customer said the lawn guy saw sod web worms', 'You said the lawn guy saw sod webworms.'],
    ['"I serviced" before a part that names only places', 'cust not home. ext only', 'You were not home. I serviced the exterior only.'],
    ['a product name and its amount are left out', 'sprayed Borlux around the house 2 gallons, baited the kitchen', 'I sprayed around the house. I baited the kitchen.'],
    ['a period of time is left out with its figure', 'set 4 traps in the attic will recheck in two weeks', 'I set four traps in the attic and will recheck.'],
    ['a refused pair of words is left out together', 'quiet visit no issues sprayed outside', 'It was a quiet visit. I sprayed outside.'],
    ['a part for the office is left out whole', 'billing: charge extra for the wasp nest. customer was rude. treated outside', 'I treated outside.'],
    ['nothing seen with no spot named is left out', 'no activity inside. treated baseboards in kitchen', 'I treated the baseboards in the kitchen.'],
    ['nothing seen in a named spot stays', 'no droppings in the attic. set 2 traps', 'No droppings were in the attic. I set two traps.'],
  ])('%s', async (_label, note, text) => {
    await expect(refusal(note, text)).resolves.toBeNull();
    // What passes here is a note the report reader shows.
    expect(reportNoteCustomerCopy({ reportNote: { v: 1, text: ownNoteText(text), source: 'cleaned' } }).body).toBe(ownNoteText(text));
  });
});

describe('same order: the text is refused', () => {
  test.each([
    ['an added place', 'treated outside', 'I treated outside and inside.', 'not_in_note', 'inside'],
    ['an added pest', 'treated kitchen for ants', 'I treated the kitchen for ants and roaches.', 'not_in_note', 'roaches'],
    ['a changed count', '3 rodent stations checked 2 had feeding', 'Three rodent stations were checked and four had feeding.', 'not_in_note', 'four'],
    ['an added reason', 'treated the garage', 'I treated the garage because of ants.', 'not_in_note', 'because'],
    ['a word in a new spelling the check does not know', 'mouse in the shed', 'A house was in the shed.', 'not_in_note', 'house'],
    ['"not" made from "note"', 'left a note. treated the shed', 'I left. It was not treated, the shed.', 'not_in_note', 'not'],
    ['two words that changed places', 'treated the mouse hole by the house', 'I treated the house hole by the mouse.', 'out_of_order', 'hole'],
    ['a denial left out', 'no ants in kitchen treated baseboards', 'Ants were in the kitchen. I treated the baseboards.', 'left_out', 'no'],
    ['"not" left out', 'did not treat the shed, dog inside', 'I did treat the shed.', 'left_out', 'not'],
    ['the person who did the work left out', 'customer treated the shed himself', 'I treated the shed.', 'left_out', 'customer'],
    ['a condition left out', 'will come back if activity continues', 'I will come back.', 'left_out', 'if'],
    ['a count left out', 'set 4 traps in attic', 'I set traps in the attic.', 'left_out', '4'],
    ['a plain word that could open an order left out', 'left the shed window open', 'I left the shed window.', 'left_out', 'open'],
    ['a part for the customer left out', 'treated kitchen. found german roaches behind fridge. treated shed', 'I treated the kitchen. I treated the shed.', 'left_out', 'found'],
    ['half of a refused pair kept', 'quiet visit no issues sprayed outside', 'It was a quiet visit, issues. I sprayed outside.', 'left_out', 'no'],
    ['two sentences of the note joined', 'cust not home. ext only', 'You were not home and I serviced the exterior only.', 'joined', 'exterior'],
    ['"I" put beside the customer', 'customer treated the shed', 'The customer and I treated the shed.', 'not_in_note', 'i'],
    ['"I serviced" before work or a pest', 'ants in the kitchen', 'I serviced ants in the kitchen.', 'not_in_note', 'serviced'],
  ])('%s', async (_label, note, text, reason, word) => {
    await expect(refusal(note, text)).resolves.toEqual({ reason, words: [word] });
  });

  test('the check alone, with no screen: a word no screen refuses is never left out', () => {
    expect(orderRejection('I treated around the fence.', 'treated around the gate and the fence')).toEqual({ reason: 'left_out', words: ['gate'] });
    expect(orderRejection('I treated around the fence.', 'treated around the gate and the fence', (fragment) => /gate/.test(fragment))).toBeNull();
  });
});

describe('the report\'s word screens run on the text', () => {
  test.each([
    ['a product name', 'sprayed Borlux around the house', 'I sprayed Borlux around the house.', 'trade_name'],
    ['an active ingredient', 'sprayed zentrathrin around the house', 'I sprayed zentrathrin around the house.', 'active_ingredient'],
    ['an amount', 'sprayed 2 gallons around the house', 'I sprayed 2 gallons around the house.', 'amount'],
    ['"safe"', 'treated outside safe for the dog', 'I treated outside. It is safe for the dog.', 'banned'],
    ['a gate', 'treated around the gate and the fence', 'I treated around the gate and the fence.', 'access_code'],
    ['a code the redactor left', 'used 4471 at the side. treated the shed', 'I used 4471 at the side. I treated the shed.', 'access_code'],
    ['a contact line', 'treated outside. call us if ants come back', 'I treated outside. Call us if ants come back.', 'contact_line'],
    ['a line break', 'treated outside. swept webs', 'I treated outside.\nI swept webs.', 'shape'],
    ['a sign-off', 'treated outside', 'I treated outside. - Marcus', 'shape'],
    ['no text', 'treated outside', '  ', 'empty'],
    ['a text that is too long', 'treated outside', `I treated outside. ${'I treated outside. '.repeat(40)}`, 'too_long'],
  ])('%s', async (_label, note, text, reason) => {
    expect((await refusal(note, text))?.reason).toBe(reason);
  });

  test('an access code in the note is never a word of the text', async () => {
    const note = 'gate code is 4471. dog in back yard so i couldn\'t treat the back';
    expect(noteAsRead(note)).not.toContain('4471');
    await expect(refusal(note, 'A dog was in the back yard so I couldn\'t treat the back.')).resolves.toBeNull();
    expect((await refusal(note, 'The code is 4471. A dog was in the back yard so I couldn\'t treat the back.'))?.reason).toBe('access_code');
  });

  test('a line break in the note ends a sentence of the note', async () => {
    expect((await refusal('cust not home\next only', 'You were not home and I serviced the exterior only.'))?.reason).toBe('joined');
  });
});

// The wording list of owner ruling 2026-11-20 (*A*): each passes the report
// reader's screens, so a saved note must never hold it.
describe('the wordings the reader lets stand are refused where the note is written', () => {
  test.each([
    'You can return to the treated patio in two days.',
    'The spray needs to dry. That takes two days.',
    'Wait a day before stepping onto the grass.',
    'Keep off until dry. That takes two days.',
    'Drying time? Two days.',
    'The patio is good to go in two days.',
    'I treated the patio. Foot traffic can resume on Monday.',
    'Use rose at the back.',
    'For the shed, use bluebird when prompted.',
    'The pass phrase is bluebird.',
  ])('%s', async (wording) => {
    // The note says it word for word, so only the screens can refuse it.
    expect(await refusal(wording, wording)).not.toBeNull();
  });

  test('a part that orders the customer names the order', async () => {
    await expect(refusal('use rose at the back', 'Use rose at the back.')).resolves.toEqual({ reason: 'instruction', words: ['use'] });
  });
});

describe('the stored text and the fixed sentence', () => {
  test('the stored form: one line of plain text, a small g on german roaches, dollarweed as one word', () => {
    expect(ownNoteText('  "I saw German roaches and dollar weed."  ')).toBe('I saw german roaches and dollarweed.');
    expect(MAX_OWN_NOTE_CHARS).toBeLessThan(900);
  });

  test('the fixed sentence is the fallback recap, from the service name and the areas', () => {
    const text = fixedReportNote({ serviceType: 'Pest Control', areasServiced: ['kitchen', 'garage'] });
    expect(text).toMatch(/Pest Control/i);
    expect(text).toMatch(/kitchen/);
    expect(reportNoteCustomerCopy({ reportNote: { v: 1, text, source: 'fixed' } }).body).toBe(text);
  });

  test('a catalog that cannot be read throws: the caller uses the fixed sentence', async () => {
    await expect(reportNoteRejection({ note: 'treated outside', text: 'I treated outside.' })).rejects.toThrow();
  });
});
