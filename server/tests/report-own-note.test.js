/**
 * The technician's own note as the report text (owner 2026-11-19 "GO"; owner
 * 2026-11-21 "same order"): what code lets out.
 *
 * services/service-report/report-own-note.js decides whether a tidied note
 * may be the customer's report text. Behavior these tests pin:
 *  - the report's word screens run on the text: products, active ingredients,
 *    amounts, time, "safe", an access code, a contact line, a word for the
 *    office;
 *  - the wordings today's reader screens let stand are refused here, where
 *    the note is written (owner 2026-11-20, *A*);
 *  - the same-order check (report-note-order.test.js has its cases) runs with
 *    these screens, and what passes is a note the report reader shows;
 *  - the note a model reads holds no access code.
 * Regression they guard: a customer report, signed with the technician's
 * name, that says something the technician did not say or may not say.
 * Gap in existing proof: no other suite reads this module. Synthetic data only.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  reportNoteRejection, fixedReportNote, ownNoteText, noteAsRead, MAX_OWN_NOTE_CHARS,
} = require('../services/service-report/report-own-note');
const { reportNoteCustomerCopy } = require('../services/service-report/technician-report-copy');

// Synthetic catalog rows in the shape readCatalogScreenRows returns.
const CATALOG = [
  { id: 1, name: 'Borlux SC', display_name: 'Borlux', active_ingredient: 'Zentrathrin', category: 'insecticide', manufacturer: 'Norvane', aliases: [] },
  { id: 2, name: 'Vexion Cockroach Gel Bait', display_name: 'Vexion Gel', active_ingredient: 'Indoxacarb', category: 'bait', manufacturer: 'Norvane', aliases: [] },
];
const refusal = (note, text) => reportNoteRejection({ note, text, catalogRows: CATALOG });

describe('same order, with the report\'s own screens', () => {
  test.each([
    ['the customer is "you"', 'customer said she\'s been seeing little ants by the kitchen sink. baited under the sink and along the window',
      'You said you have been seeing little ants by the kitchen sink. I baited under the sink and along the window.'],
    ['every word of a product name and its amount are left out', 'sprayed Borlux SC around the house 2 gallons, baited the kitchen', 'I sprayed around the house and baited the kitchen.'],
    ['a product name goes and the plain word after it stays', 'put Vexion Gel under the sink', 'I put gel under the sink.'],
    ['a period of time is left out with its figure', 'set 4 traps in the attic will recheck in two weeks', 'I set four traps in the attic and will recheck.'],
    ['a refused pair of words is left out together', 'quiet visit no issues sprayed outside', 'It was a quiet visit and I sprayed outside.'],
    ['a part for the office is left out whole', 'billing: charge extra for the wasp nest. customer was rude. treated outside', 'I treated outside.'],
    ['a sentence that names a gate goes whole', 'treated around the gate and the fence. swept the eaves', 'I swept the eaves.'],
    ['an inch mark as the last character stays', 'gap under the door was 5"', 'The gap under the door was 5"'],
    ['a note of four sentences keeps four sentences', 'checked the kitchen. checked the shed. checked the attic. checked the yard',
      'I checked the kitchen. I checked the shed. I checked the attic. I checked the yard.'],
  ])('%s', async (_label, note, text) => {
    await expect(refusal(note, text)).resolves.toBeNull();
    // What passes here is a note the report reader shows.
    expect(reportNoteCustomerCopy({ reportNote: { v: 1, text: ownNoteText(text), source: 'cleaned' } }).body).toBe(ownNoteText(text));
  });

  test.each([
    ['an added place', 'treated outside', 'I treated outside and inside.', 'not_in_note', 'inside'],
    ['a denial left out', 'no ants in kitchen treated baseboards', 'Ants were in the kitchen and I treated the baseboards.', 'left_out', 'no'],
    ['a condition left out with the office part that holds it', 'treated kitchen, if customer paid', 'I treated the kitchen.', 'left_out', 'if'],
    ['two sentences of the note joined', 'cust not home. ext only', 'You were not home and exterior only.', 'joined', 'exterior'],
    ['a sentence of the note cut in two', 'did not treat shed', 'I did not. I treat the shed.', 'split', 'treat'],
  ])('refused: %s', async (_label, note, text, reason, word) => {
    await expect(refusal(note, text)).resolves.toEqual({ reason, words: [word] });
  });
});

describe('the report\'s word screens run on the text', () => {
  test.each([
    ['a product name', 'sprayed Borlux around the house', 'I sprayed Borlux around the house.', 'trade_name'],
    ['an active ingredient', 'sprayed zentrathrin around the house', 'I sprayed zentrathrin around the house.', 'active_ingredient'],
    ['an amount', 'sprayed 2 gallons around the house', 'I sprayed 2 gallons around the house.', 'amount'],
    ['"safe"', 'treated outside safe for the dog', 'I treated outside. It is safe for the dog.', 'banned'],
    ['a gate', 'treated around the gate and the fence', 'I treated around the gate and the fence.', 'access_code'],
    ['a number shaped like a code', 'used 4471 at the side. treated the shed', 'I used 4471 at the side. I treated the shed.', 'access_code'],
    ['a contact line', 'treated outside. call us if ants come back', 'I treated outside. Call us if ants come back.', 'contact_line'],
    ['a word for the office', 'treated outside. customer paid by check', 'I treated outside. You paid by check.', 'not_for_customer'],
    ['a remark about the customer', 'customer was rude. treated outside', 'You were rude. I treated outside.', 'not_for_customer'],
    ['a line break', 'treated outside. swept webs', 'I treated outside.\nI swept webs.', 'shape'],
    ['a banned word in full-width letters', 'spray is safe', 'Spray is ｓａｆｅ.', 'shape'],
    ['a full-width sentence mark', 'treated outside. use rose at the back', 'I treated outside。Use rose at the back.', 'shape'],
    ['a line break the reader refuses', 'treated shed', 'I treated\u0085shed.', 'shape'],
    ['a line separator inside the text', 'treated shed', 'I treated\u2028shed.', 'shape'],
    ['a sign-off', 'treated outside', 'I treated outside. - Marcus', 'shape'],
    ['no text', 'treated outside', '  ', 'empty'],
    ['a text that is too long', 'treated outside', `I treated outside. ${'I treated outside. '.repeat(40)}`, 'too_long'],
  ])('%s', async (_label, note, text, reason) => {
    expect((await refusal(note, text))?.reason).toBe(reason);
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
    'Foot traffic can resume on Nov 22.',
    'Foot traffic can resume on the 3rd of December.',
    'Foot traffic can resume on the 3rd of May.',
    'Foot traffic can resume on Fri.',
    'Foot traffic can resume on 11/22.',
    'Foot traffic can resume on 3/4.',
    'I treated the patio on 11/22/26.',
    'Do not enter the yard.',
    'Use rose at the back.',
    'For the shed, use bluebird when prompted.',
    'The pass phrase is bluebird.',
    'Water the lawn twice.',
  ])('%s', async (wording) => {
    // The note says it word for word, so only the screens can refuse it.
    expect(await refusal(wording, wording)).not.toBeNull();
  });

  test('a part that orders the customer names the order', async () => {
    await expect(refusal('use rose at the back', 'Use rose at the back.')).resolves.toEqual({ reason: 'instruction', words: ['use'] });
  });
});

describe('the note a model reads holds no access code', () => {
  test('a code beside a code word, and the text that repeats it', async () => {
    const note = 'gate code is 4471. dog in back yard so i couldn\'t treat the back';
    expect(noteAsRead(note)).not.toContain('4471');
    await expect(refusal(note, 'A dog was in the back yard so I couldn\'t treat the back.')).resolves.toBeNull();
    expect((await refusal(note, 'The code is 4471. A dog was in the back yard so I couldn\'t treat the back.'))?.reason).toBe('access_code');
  });

  test('a number shaped like a code, with no code word beside it', async () => {
    expect(noteAsRead('used 4471 at the side. treated shed')).toBe('[redacted]. treated shed');
    expect(noteAsRead('side door four four seven one. treated shed')).not.toMatch(/four four seven one/);
    await expect(refusal('used 4471 at the side. treated shed', 'I treated the shed.')).resolves.toBeNull();
  });

  test('a word of access never goes alone: its sentence is masked with the words beside it', async () => {
    for (const note of ['Gate: bluebird. Treated shed.', 'Gate, bluebird. Treated shed.', 'For the shed, use bluebird when prompted. Treated shed.']) {
      expect(noteAsRead(note)).toBe('[redacted]. Treated shed.');
      await expect(refusal(note, 'I treated the shed.')).resolves.toBeNull();
      expect(await refusal(note, 'Bluebird. I treated the shed.')).not.toBeNull();
    }
    expect(noteAsRead('set traps in the garage, by the AC unit. swept eaves')).toBe('[redacted]. swept eaves');
    // A number in the next sentence keeps its mark.
    expect(noteAsRead('side gate open. found 2.5 inch gap')).toBe('[redacted]. found 2.5 inch gap');
  });

  test('the note is read in one letter form before any screen', async () => {
    expect(noteAsRead('ｇａｔｅ, bluebird. treated shed')).toBe('[redacted]. treated shed');
    expect(noteAsRead('ga\u200Bte, bluebird. treated shed')).toBe('[redacted]. treated shed');
    expect(await refusal('ｇａｔｅ, bluebird. treated shed', 'Bluebird. I treated shed.')).not.toBeNull();
    expect((await refusal('sprayed ｚｅｎｔｒａｔｈｒｉｎ around the house', 'I sprayed zentrathrin around the house.'))?.reason).toBe('active_ingredient');
    // A fraction sign stays as written.
    expect(noteAsRead('applied 1½ oz')).toBe('applied 1½ oz');
  });

  test('a part that qualifies the rest goes only with its whole sentence, whatever screen refuses it', async () => {
    const note = 'will treat outside, weather permitting tomorrow';
    expect(await refusal(note, 'I will treat outside.')).toEqual({ reason: 'left_out', words: ['weather'] });
    await expect(refusal(note, 'I will treat outside, weather permitting.')).resolves.toBeNull();
    // The product screen answers first for this part: the rule still holds.
    const named = 'will treat outside, weather permitting in two days with Borlux';
    expect(await refusal(named, 'I will treat outside.')).toEqual({ reason: 'left_out', words: ['weather'] });
    await expect(refusal(named, 'I will treat outside, weather permitting.')).resolves.toBeNull();
    // A part with a word of time that is no condition goes whole.
    await expect(refusal('sprayed perimeter, back in 2 weeks', 'I sprayed the perimeter.')).resolves.toBeNull();
    await expect(refusal('treated kitchen, roaches should be gone in 2 weeks', 'I treated the kitchen.')).resolves.toBeNull();
    // "may" is no month without its day.
    await expect(refusal('found 2 may be more nests', 'I found 2 may be more nests.')).resolves.toBeNull();
  });

  test('a condition masked with its sentence takes its work with it', async () => {
    expect(noteAsRead('will treat shed, if gate opens')).toBe('[redacted]');
    expect(await refusal('will treat shed, if gate opens', 'I will treat shed.')).not.toBeNull();
  });

  test('a pass phrase', async () => {
    const note = 'the pass phrase is bluebird. treated shed';
    expect(noteAsRead(note)).not.toContain('bluebird');
    await expect(refusal(note, 'I treated the shed.')).resolves.toBeNull();
    expect(await refusal(note, 'The pass phrase is bluebird. I treated the shed.')).not.toBeNull();
  });
});

describe('the stored text and the fixed sentence', () => {
  test('the stored form: one line of plain text, a small g on german roaches, dollarweed as one word', () => {
    expect(ownNoteText('  "I saw German roaches and dollar weed."  ')).toBe('I saw german roaches and dollarweed.');
    expect(MAX_OWN_NOTE_CHARS).toBe(600);
  });

  test('the fixed sentence is the fallback recap, from the service name and the areas', () => {
    const text = fixedReportNote({ serviceType: 'Pest Control', areasServiced: ['kitchen', 'garage'] });
    expect(text).toMatch(/Pest Control/i);
    expect(text).toMatch(/kitchen/);
    expect(reportNoteCustomerCopy({ reportNote: { v: 1, text, source: 'fixed' } }).body).toBe(text);
  });

  test('the fixed sentence follows the visit outcome: an inspection never reads as a treatment', () => {
    const text = fixedReportNote({ serviceType: 'Pest Control', areasServiced: ['kitchen'], visitOutcome: 'inspection_only' });
    expect(text).toMatch(/inspection/i);
    expect(text).not.toMatch(/we treated/i);
    expect(reportNoteCustomerCopy({ reportNote: { v: 1, text, source: 'fixed' } }).body).toBe(text);
  });

  test('the fixed sentence is one the reader shows, for every visit outcome with and with no areas', () => {
    const outcomes = [undefined, 'completed', 'inspection_only', 'customer_declined', 'follow_up_needed', 'customer_concern', 'incomplete'];
    outcomes.forEach((visitOutcome) => [['kitchen'], []].forEach((areasServiced) => {
      const text = fixedReportNote({ serviceType: 'Pest Control', areasServiced, visitOutcome });
      expect(text).toMatch(/Pest Control/);
      expect(reportNoteCustomerCopy({ reportNote: { v: 1, text, source: 'fixed' } }).body).toBe(text);
    }));
    expect(fixedReportNote({ serviceType: 'Pest Control', areasServiced: [], visitOutcome: 'inspection_only' })).not.toMatch(/accessible/);
    // A service name and an area the reader refuses: still a sentence it shows.
    outcomes.forEach((visitOutcome) => {
      const text = fixedReportNote({ serviceType: 'Gate inspection', areasServiced: ['side gate'], visitOutcome });
      expect(text).not.toBe('');
      expect(reportNoteCustomerCopy({ reportNote: { v: 1, text, source: 'fixed' } }).body).toBe(text);
    });
  });

  test('a catalog that cannot be read throws: the caller uses the fixed sentence', async () => {
    await expect(reportNoteRejection({ note: 'treated outside', text: 'I treated outside.' }))
      .rejects.toThrow('catalog-wide trade-name screen needs a catalog read');
  });

  test('with a database and no rows given, the catalog is read from it', async () => {
    const tables = [];
    const db = (table) => ({
      select: async () => {
        tables.push(table);
        return table === 'products_catalog' ? CATALOG.map(({ aliases, ...row }) => row) : [];
      },
    });
    await expect(reportNoteRejection({ note: 'treated outside', text: 'I treated outside.', db })).resolves.toBeNull();
    expect((await reportNoteRejection({ note: 'sprayed Borlux outside', text: 'I sprayed Borlux outside.', db }))?.reason).toBe('trade_name');
    expect(tables).toEqual(['products_catalog', 'product_aliases', 'products_catalog', 'product_aliases']);
  });

  test('a finding that opens with "do not", and a fraction after "on", are no order and no date', async () => {
    await expect(refusal('do not see activity in the attic', 'I do not see activity in the attic.')).resolves.toBeNull();
    await expect(refusal('put mesh on 1/4 inch gaps', 'I put mesh on 1/4 inch gaps.')).resolves.toBeNull();
    await expect(refusal('put mesh on 3/4" gaps', 'I put mesh on 3/4" gaps.')).resolves.toBeNull();
  });
});
