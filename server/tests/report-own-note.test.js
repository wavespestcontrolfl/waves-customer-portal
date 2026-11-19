/**
 * The technician's own note as the report text (owner 2026-11-19): what code
 * lets out.
 *
 * services/service-report/report-own-note.js decides whether a cleaned-up
 * note may be the customer's report text. These tests pin what a customer can
 * and cannot get:
 *  - the trace: a cleaned note may fix a word of the note and may not add one
 *    (a pest, a place, a number, work, a denial, a reason);
 *  - the report's own word screens run on it: products, active ingredients,
 *    amounts, periods of time, "safe", an absence with no place, a contact line;
 *  - an access code in the note never traces;
 *  - the fixed sentence is today's fallback sentence.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  reportNoteRejection,
  fixedReportNote,
  ownNoteText,
  untracedWords,
  MAX_OWN_NOTE_CHARS,
} = require('../services/service-report/report-own-note');

// Synthetic catalog rows in the shape readCatalogScreenRows returns.
const CATALOG = [
  { id: 1, name: 'Borlux SC', display_name: 'Borlux', active_ingredient: 'Zentrathrin', category: 'insecticide', manufacturer: 'Norvane', aliases: ['Quellar P'] },
  { id: 2, name: 'Vexion Cockroach Gel Bait', display_name: 'Vexion Gel', active_ingredient: 'Indoxacarb', category: 'bait', manufacturer: 'Norvane', aliases: [] },
  { id: 3, name: 'Yard sign sticker 4x5 "Serviced by Waves"', display_name: null, active_ingredient: null, category: 'supplies', manufacturer: null, aliases: [] },
];
const refusal = (note, text) => reportNoteRejection({ note, text, catalogRows: CATALOG });

describe('the trace: a cleaned note adds no word', () => {
  test.each([
    ['fragments become sentences', 'found fire ant hill near back of house spot treated it swept spider webs outside',
      'I found a fire ant hill near the back of the house and spot-treated it. I also swept the spider webs outside.'],
    ['what was seen may be said as seen', 'ants in kitchen light activity', 'I saw ants in the kitchen and light activity.'],
    ['a short note stays short', 'quiet visit spot treated outside', 'It was a quiet visit. I spot-treated outside.'],
    ['a fixed dictation error', 'cinch bugs in front lawn', 'I saw chinch bugs in the front lawn.'],
    ['a typing slip', 'treated the kitchne and the garage', 'I treated the kitchen and the garage.'],
    ['one word written as two, and two as one', 'web worms in the back yard treated carport', 'I treated webworms in the back yard and the car port.'],
    ['a number as a word', '3 rodent stations checked 2 had feeding', 'I checked three rodent stations, and two had feeding.'],
    ['a technician\'s short forms', 'treated ext perimeter and int baseboards, igr behind fridge',
      'I treated the outside perimeter and the inside baseboards, and put an insect growth regulator behind the refrigerator.'],
    ['what the customer said, said to the customer', 'cust said seeing roaches in garage', 'You told me you are seeing roaches in the garage.'],
    ['what the customer sees, said to the customer', 'customer still seeing ghost ants in master bath', 'You told me you are still seeing ghost ants in the master bathroom.'],
    ['a denial the note holds', 'customer not home, did outside only', 'You were not home. I did the outside only.'],
    ['work the note states, in a plain verb', 'sprayed around the house, baited kitchen', 'I treated around the house and put out bait in the kitchen.'],
    ['a dropped product leaves a treatment', 'sprayed Borlux around the house', 'I sprayed a treatment around the house.'],
    ['a plain verb for work the note gives no verb for', 'cust not home. ext only', 'You were not home, and I serviced the exterior only.'],
    ['a product form with no verb', 'granules around the whole house', 'I spread granules around the whole house.'],
    ['what phone dictation writes for a word of the trade', 'swept the eves and the lanai', 'I swept the eaves and the lanai.'],
  ])('%s', (_label, note, text) => {
    expect(untracedWords(text, note)).toEqual([]);
  });

  test.each([
    ['a place', 'treated outside', 'I treated outside and inside.', ['inside']],
    ['a pest', 'treated kitchen for ants', 'I treated the kitchen for ants and roaches.', ['roaches']],
    ['a number', 'checked rodent stations', 'I checked four rodent stations.', ['four']],
    ['a reason', 'baited kitchen', 'I baited the kitchen to keep ants away.', ['keep', 'ants', 'away']],
    ['an expectation', 'treated outside', 'I treated outside. Activity should drop.', ['activity', 'drop']],
    ['a denial', 'checked the attic', 'I checked the attic and found no rodents.', ['no', 'rodents']],
    ['a wider claim', 'treated the kitchen', 'I treated the whole home.', ['whole', 'home']],
    ['work the note does not state', 'checked stations, light feeding', 'I checked the stations and applied a treatment.', ['applied', 'treatment']],
    ['the customer speaking, when the note has no one speaking', 'ants in kitchen', 'You told me about ants in the kitchen.', ['told']],
    ['the customer speaking, when the note only names the customer', 'customer had ants', 'You told me you had ants.', ['told']],
    ['another pest one letter from a short word', 'rats in attic', 'I saw ants in the attic.', ['ants']],
    ['another count', 'set 12 traps', 'I set 13 traps.', ['13']],
    ['another count one letter from a count word', 'checked eight traps', 'I checked eighty traps.', ['eighty']],
    ['a word in another script', 'checked the attic', 'I checked the attic. 危険です。', ['危険です']],
  ])('refuses %s the note does not have', (_label, note, text, added) => {
    expect(untracedWords(text, note)).toEqual(added);
  });

  test.each([
    ['work the note denies', 'did not treat the kitchen', 'I treated the kitchen.', ['treated']],
    ['a pest the note denies', 'no roaches in the garage', 'I saw roaches in the garage.', ['roaches']],
    ['a short form of a denial', 'didnt spray the back yard dog out', 'I sprayed the back yard.', ['sprayed']],
    ['a denial moved after the word', 'could not access the attic', 'I accessed the attic, not the garage.', ['garage', 'accessed']],
  ])('refuses dropping %s', (_label, note, text, added) => {
    expect(untracedWords(text, note)).toEqual(added);
  });

  test.each([
    ['the denial kept', 'did not treat the kitchen', 'I did not treat the kitchen.'],
    ['a contracted denial', 'couldnt treat the back yard', "I couldn't treat the back yard."],
    ['a word the note says both ways', 'did not treat the kitchen treated the garage', 'I treated the garage. I did not treat the kitchen.'],
    ['a self-denying word', 'nothing in the attic', 'I found nothing in the attic.'],
  ])('keeps %s', (_label, note, text) => {
    expect(untracedWords(text, note)).toEqual([]);
  });
});

describe('the screens on a cleaned note', () => {
  test('a product the note names is refused in any case, with its active ingredient', async () => {
    const note = 'sprayed borlux around the house';
    expect(await refusal(note, 'I sprayed Borlux around the house.')).toEqual({ reason: 'trade_name' });
    expect(await refusal(note, 'I sprayed borlux around the house.')).toEqual({ reason: 'trade_name' });
    expect(await refusal(note, 'I sprayed zentrathrin around the house.')).toMatchObject({ reason: 'active_ingredient' });
    expect(await refusal(note, 'I sprayed around the house.')).toBeNull();
    // A catalog brand the note does not name, as the catalog writes it.
    expect(await refusal('gel in the kitchen', 'I put Vexion gel in the kitchen.')).toEqual({ reason: 'trade_name' });
    // A supply's ordinary words are no product name.
    expect(await refusal('left a yard sign by the driveway', 'I left a yard sign by the driveway.')).toBeNull();
  });

  test.each([
    ['an amount', 'used 2 oz in the kitchen', 'I used 2 oz in the kitchen.', 'amount'],
    ['a period of time', 'treated outside back in two weeks', 'I treated outside. I will be back in two weeks.', 'timeframe'],
    ['"safe"', 'treated outside safe for pets', 'I treated outside. It is safe for pets.', 'banned'],
    ['an absence with no room or spot', 'sprayed perimeter no activity inside', 'I sprayed the perimeter. I saw no activity inside.', 'unscoped_absence'],
    ['a contact line', 'treated outside call us if you see more', 'I treated outside. Call us if you see more.', 'contact_line'],
    ['a price', 'treated outside, invoice sent', 'I treated outside. The invoice was sent.', 'price'],
    ['a sign-off', 'treated outside', 'I treated outside. - Waves', 'shape'],
    ['a second line', 'treated outside swept webs', 'I treated outside.\nI swept webs.', 'shape'],
    ['another script', 'checked the attic', 'I checked the attic. 危険です。', 'shape'],
    ['a symbol', 'treated the kitchen', 'I treated the kitchen ☠', 'shape'],
    ['a fourth sentence', 'checked the kitchen', 'I checked the kitchen. I checked the kitchen. I checked the kitchen. I checked the kitchen.', 'sentences'],
    ['a marked access code', 'gate code 4545 treated outside', 'The gate code is [redacted]. I treated outside.', 'access_code'],
    ['nothing', 'treated outside', '   ', 'empty'],
    ['any text, when the note is blank', '', 'I serviced it today.', 'no_note'],
    ['any text, when the note states nothing', 'it was the', 'It was the visit.', 'no_note'],
  ])('refuses %s', async (_label, note, text, reason) => {
    expect(await refusal(note, text)).toMatchObject({ reason });
  });

  test('the marks a field note uses are plain text', async () => {
    expect(await refusal('soil 85° in back, station #4 full', 'The soil was 85° in the back, and station #4 is full.')).toBeNull();
  });

  test('three sentences are the most a note may have', async () => {
    expect(await refusal('checked the kitchen', 'I checked the kitchen. I checked the kitchen. I checked the kitchen.')).toBeNull();
  });

  test('dollarweed is one word, so the price screen does not read "dollar"', async () => {
    const note = 'cinch bugs in the front lawn also saw some dollar weed';
    expect(await refusal(note, 'I saw chinch bugs in the front lawn. I also saw some dollar weed.')).toBeNull();
    expect(ownNoteText('I also saw some dollar weed.')).toBe('I also saw some dollarweed.');
    // A price is still a price.
    expect(await refusal('extra dollar amount for the wasp nest', 'There is an extra dollar amount for the wasp nest.')).toMatchObject({ reason: 'price' });
  });

  test('an absence passes with the room it was checked in', async () => {
    expect(await refusal('no ants in the kitchen today, treated outside', 'I saw no ants in the kitchen. I treated outside.')).toBeNull();
  });

  test('a text over the length limit is refused', async () => {
    const note = 'treated the kitchen';
    expect(await refusal(note, `${'I treated the kitchen. '.repeat(40)}`.trim())).toEqual({ reason: 'too_long' });
    expect('I treated the kitchen. '.repeat(40).trim().length).toBeGreaterThan(MAX_OWN_NOTE_CHARS);
  });

  test('the stored text has one form: quotes and spare spaces off, a small g on german roaches', () => {
    expect(ownNoteText('  "I saw  German roaches under the sink."  ')).toBe('I saw german roaches under the sink.');
    expect(ownNoteText(null)).toBe('');
  });

  test('a catalog that cannot be read throws, so the caller fails closed', async () => {
    await expect(reportNoteRejection({ note: 'treated outside', text: 'I treated outside.' })).rejects.toThrow();
  });
});

describe('the note as the check reads it', () => {
  test('an access code in the note is redacted first, so a code never traces', async () => {
    const raw = 'lockbox code 2211. cust said ants by the pool, treated pool cage';
    expect(await refusal(raw, 'You told me about ants by the pool. I treated the pool cage.')).toBeNull();
    expect(await refusal(raw, 'I treated the pool cage and the lanai.')).toEqual({ reason: 'not_in_note', words: ['lanai'] });
    expect(await refusal(raw, 'The lockbox code is 2211.')).toMatchObject({ reason: 'access_code' });
  });
});

describe('the fixed sentence', () => {
  test("is today's fallback sentence, from the service name and the areas on the record", () => {
    expect(fixedReportNote({ serviceType: 'Quarterly Pest Control Service', areasServiced: ['Outside'] }))
      .toBe('Today we completed your Quarterly Pest Control Service. We treated Outside.');
  });

  test('runs the customer-copy screens on the labels it prints, and names neither when they fail', () => {
    expect(fixedReportNote({ serviceType: 'Quarterly Pest Control Service', areasServiced: ['side gate code 1234'] }))
      .toBe('Today we completed your service.');
    expect(fixedReportNote({ serviceType: 'Safe pet treatment', areasServiced: ['Outside'] })).toBe('Today we completed your service.');
    expect(fixedReportNote({})).toBe('Today we completed your service.');
  });
});
