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
 *  - the note a model reads holds no access code, and no code on the
 *    customer's file, in any wording.
 * Regression they guard: a customer report, signed with the technician's
 * name, that says something the technician did not say or may not say.
 * Gap in existing proof: no other suite reads this module. Synthetic data only.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const OwnNote = require('../services/service-report/report-own-note');

const {
  reportNoteRejection, fixedReportNote, ownNoteText, storedCodesOf, readStoredCodes, MAX_OWN_NOTE_CHARS,
} = OwnNote;
// A customer with no code on file, unless a test gives one.
const noteAsRead = (note, storedCodes = []) => OwnNote.noteAsRead(note, storedCodes);
const { reportNoteCustomerCopy } = require('../services/service-report/technician-report-copy');

// Synthetic catalog rows in the shape readCatalogScreenRows returns.
const CATALOG = [
  { id: 1, name: 'Borlux SC', display_name: 'Borlux', active_ingredient: 'Zentrathrin', category: 'insecticide', manufacturer: 'Norvane', aliases: [] },
  { id: 2, name: 'Vexion Cockroach Gel Bait', display_name: 'Vexion Gel', active_ingredient: 'Indoxacarb', category: 'bait', manufacturer: 'Norvane', aliases: [] },
];
const refusal = (note, text, storedCodes = []) => reportNoteRejection({
  note, text, catalogRows: CATALOG, storedCodes,
});

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
    'Foot traffic can resume on 11/22 in the yard.',
    'Foot traffic can resume on 3/4 in the yard.',
    'Foot traffic can resume on 11/22 in vents.',
    'Foot traffic can resume on 3/4 in all rooms.',
    'Foot traffic can resume on 3/4 in shaded areas.',
    'Foot traffic can resume on 3/4 in deep shade.',
    'Foot traffic can resume on 3/4 in hardware storage areas.',
    'Foot traffic can resume on 3/4 in 2027.',
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

describe('a code on the customer\'s file is found by its value, in any wording', () => {
  const onFile = storedCodesOf({
    neighborhood_gate_code: '#4471', property_gate_code: 'Blue Bird', garage_code: null, lockbox_code: 'box c902, then 55 12',
  });

  test('the forms of the four code fields: the field, each word and run in it, each group of figures', () => {
    expect([...onFile].sort()).toEqual([
      '12', '4471', '55', '902', 'bird', 'blue', 'bluebird', 'box', 'boxc902then5512', 'c902', 'then',
    ]);
    expect(storedCodesOf({ lockbox_code: '#12*34' })).toEqual(['1234']);
    expect(storedCodesOf({ lockbox_code: '12 34' })).toEqual(['1234', '12', '34']);
    expect(storedCodesOf({ garage_code: '  ' })).toEqual([]);
    expect(storedCodesOf(undefined)).toEqual([]);
    // The access codes section and the gate directory: the code as a code
    // field, and of the directions beside it only a run with a figure.
    expect(storedCodesOf(undefined, [{ code: 'Rose 77', instructions: 'dial 4471 then press 2. Ask for Sam' }]).sort())
      .toEqual(['4471', '77', 'rose', 'rose77']);
    expect(storedCodesOf(undefined, [{ code: null, instructions: null }])).toEqual([]);
    // A visitor pass is a link, filed with no code: the link is the code,
    // with or without its "https://".
    const pass = storedCodesOf(undefined, [{ code: null, instructions: 'Visitor pass: https://www.passes.example/p/abcdef.' }]);
    expect(pass).toEqual(['passesexamplepabcdef']);
    expect(noteAsRead('treated shed. pass is https://passes.example/p/abcdef', pass)).toBe('[redacted]');
    expect(noteAsRead('treated shed. passes.example/p/abcdef', pass)).toBe('[redacted]');
    expect(noteAsRead('treated shed. passes checked', pass)).toBe('treated shed. passes checked');
    // The link ends where the visit card's pass link ends.
    expect(storedCodesOf(undefined, [{ code: null, instructions: 'https://passes.example/p/abcdef<br>Show it' }]))
      .toEqual(['passesexamplepabcdef']);
    // A gate directory row of the type "instructions" is a customer's gate-code
    // field, as filed: a code field, word by word. Other directions are not.
    expect(storedCodesOf(undefined, [{ code: null, instructions: 'Bluebird', access_type: 'instructions' }])).toEqual(['bluebird']);
    expect(storedCodesOf(undefined, [{ code: '6612', instructions: 'Bluebird lane side', access_type: 'keypad' }])).toEqual(['6612']);
    // Of a neighbor's pass only the link is a code: its words and figures are not this customer's.
    expect(storedCodesOf(undefined, [], [{ instructions: 'Show this at gate 4471: https://passes.example/p/qrstuv' }]))
      .toEqual(['passesexamplepqrstuv']);
    // Another field of the file is no code field.
    expect(storedCodesOf({ parking_notes: 'park at 7788' })).toEqual([]);
  });

  test('a note that holds one is not read at all, and no text passes for it', async () => {
    const notes = [
      'bluebird. treated shed',
      'treated shed. ask for Blue-Bird at the desk',
      'side door, then b l u e b i r d. treated shed',
      'treated shed\n4471',
      'treated shed. 44 71 on the pad',
      'treated shed. 4-4-7-1',
      'ｔｒｅａｔｅｄ shed. ４４７１',
      'treated shed. blue\u200Bbird',
      'treated shed. C902 opens the pad',
      // A word of a code field is a code: nothing tells it from the words beside it.
      'treated shed. bird nest in the eaves',
    ];
    for (const note of notes) {
      expect(noteAsRead(note, onFile)).toBe('[redacted]');
      expect(await refusal(note, 'I treated the shed.', onFile)).toEqual({ reason: 'stored_code' });
    }
  });

  test('a text that holds one is refused', async () => {
    expect(await refusal('treated shed', 'I treated the shed. Bluebird.', onFile)).toEqual({ reason: 'stored_code' });
    expect(await refusal('treated shed', 'I treated the shed, 44 71.', onFile)).toEqual({ reason: 'stored_code' });
  });

  test('a word code beside an instruction, and a short code', async () => {
    const annotated = storedCodesOf({ lockbox_code: 'use bluebird', garage_code: '#12' });
    for (const note of ['Bluebird. Treated shed.', 'treated shed. b l u e b i r d', 'treated shed. #12', 'treated shed\n12']) {
      expect(noteAsRead(note, annotated)).toBe('[redacted]');
      expect(await refusal(note, 'I treated the shed.', annotated)).toEqual({ reason: 'stored_code' });
    }
    // A short code is a whole word of the note: "used" is not "use", and 21 is not 12.
    const note = 'swept 21 webs and used a brush on the eaves. treated shed';
    expect(noteAsRead(note, annotated)).toBe(note);
    await expect(refusal(note, 'I swept 21 webs and used a brush on the eaves. I treated the shed.', annotated)).resolves.toBeNull();
    // The same count as the short code is the code: the safe side.
    expect(noteAsRead('swept 12 webs. treated shed', annotated)).toBe('[redacted]');
  });

  test('a note with no code of this customer is read as before', async () => {
    const note = 'saw a jay by the bath. treated shed';
    expect(noteAsRead(note, onFile)).toBe(note);
    await expect(refusal(note, 'I saw a jay by the bath. I treated the shed.', onFile)).resolves.toBeNull();
    // The same words for a customer with no code on file.
    expect(noteAsRead('bluebird nest in the eaves. treated shed')).toBe('bluebird nest in the eaves. treated shed');
  });

  test('codes that were not read stop the check: nothing is read or let out', async () => {
    expect(() => OwnNote.noteAsRead('treated shed')).toThrow('the codes on the customer\'s file were not read');
    await expect(reportNoteRejection({ note: 'treated shed', text: 'I treated the shed.', catalogRows: CATALOG }))
      .rejects.toThrow('need a database and a customer');
  });

  test('with a database and a customer, the codes are read from the three places a code is filed', async () => {
    const asked = [];
    // The three reads, in the shape knex gives them.
    const fileOf = (rows) => (table) => {
      const read = { table };
      asked.push(read);
      const chain = {
        join: (...on) => { read.join = [...(read.join || []), on]; return chain; },
        where: (...filter) => { read.where = filter; return chain; },
        first: async (...columns) => { read.columns = columns; return rows[table]; },
        select: async (...columns) => { read.columns = columns; return rows[table] || []; },
      };
      return chain;
    };
    const db = fileOf({
      property_preferences: { lockbox_code: 'bluebird' },
      customer_access_codes: [{ code: '#9031', instructions: null }, { code: null, instructions: 'call box, dial 2040' }],
      'neighborhood_access as gate': [
        { code: '6612#', instructions: 'guard on weekends', access_type: 'keypad' },
        { code: null, instructions: 'Kingfisher', access_type: 'instructions' },
      ],
      'customer_access_codes as pass': [{ instructions: 'Gate 5150. https://passes.example/p/qrstuv' }],
    });
    expect((await readStoredCodes(db, 'customer-1')).sort()).toEqual(['2040', '6612', '9031', 'bluebird', 'kingfisher', 'passesexamplepqrstuv']);
    expect(asked).toEqual([
      {
        table: 'property_preferences',
        where: [{ customer_id: 'customer-1' }],
        columns: ['neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code'],
      },
      { table: 'customer_access_codes', where: [{ customer_id: 'customer-1' }], columns: ['code', 'instructions'] },
      {
        table: 'neighborhood_access as gate',
        join: [['customer_properties as home', 'home.neighborhood_id', 'gate.neighborhood_id']],
        where: ['home.customer_id', 'customer-1'],
        columns: ['gate.code', 'gate.instructions', 'gate.access_type'],
      },
      {
        table: 'customer_access_codes as pass',
        join: [
          ['customer_properties as theirs', 'theirs.id', 'pass.property_id'],
          ['customer_properties as home', 'home.neighborhood_id', 'theirs.neighborhood_id'],
        ],
        where: [{ 'home.customer_id': 'customer-1', 'pass.kind': 'pass' }],
        columns: ['pass.instructions'],
      },
    ]);
    // A code of each place stops the note.
    for (const note of [
      'bluebird. treated shed', 'treated shed. 9031', 'treated shed. 20 40 at the box', 'treated shed\n6612',
      'treated shed. passes.example/p/qrstuv', 'treated shed. kingfisher',
    ]) {
      expect(await reportNoteRejection({
        note, text: 'I treated the shed.', catalogRows: CATALOG, db, customerId: 'customer-1',
      })).toEqual({ reason: 'stored_code' });
    }
    // A customer with nothing on file has no code.
    expect(await readStoredCodes(fileOf({}), 'customer-2')).toEqual([]);
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
    // Area names that make the recap longer than the reader shows: no areas.
    const longAreas = Array.from({ length: 12 }, (_, n) => `the long covered walkway number ${n + 1} beside the east side of the main building`);
    outcomes.forEach((visitOutcome) => {
      const text = fixedReportNote({ serviceType: 'Pest Control', areasServiced: longAreas, visitOutcome });
      expect(text).not.toBe('');
      expect(reportNoteCustomerCopy({ reportNote: { v: 1, text, source: 'fixed' } }).body).toBe(text);
    });
    // A service name and an area the reader refuses: still a sentence it shows.
    outcomes.forEach((visitOutcome) => {
      const text = fixedReportNote({ serviceType: 'Gate inspection', areasServiced: ['side gate'], visitOutcome });
      expect(text).not.toBe('');
      expect(reportNoteCustomerCopy({ reportNote: { v: 1, text, source: 'fixed' } }).body).toBe(text);
    });
  });

  test('a catalog that cannot be read throws: the caller uses the fixed sentence', async () => {
    await expect(reportNoteRejection({ note: 'treated outside', text: 'I treated outside.', storedCodes: [] }))
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
    await expect(reportNoteRejection({
      note: 'treated outside', text: 'I treated outside.', db, storedCodes: [],
    })).resolves.toBeNull();
    expect((await reportNoteRejection({
      note: 'sprayed Borlux outside', text: 'I sprayed Borlux outside.', db, storedCodes: [],
    }))?.reason).toBe('trade_name');
    expect(tables).toEqual(['products_catalog', 'product_aliases', 'products_catalog', 'product_aliases']);
  });

  test('a finding that opens with "do not", and a fraction after "on", are no order and no date', async () => {
    await expect(refusal('do not see activity in the attic', 'I do not see activity in the attic.')).resolves.toBeNull();
    await expect(refusal('put mesh on 1/4 inch gaps', 'I put mesh on 1/4 inch gaps.')).resolves.toBeNull();
    await expect(refusal('put mesh on 3/4" gaps', 'I put mesh on 3/4" gaps.')).resolves.toBeNull();
    // "In" alone is no measure after a word that leads to a day: the safe side.
    expect((await refusal('put mesh on 1/4 in gaps', 'I put mesh on 1/4 in gaps.'))?.reason).toBe('time');
  });

  test('a plan stays a plan when its time goes, wherever the note holds the time', async () => {
    expect(await refusal('treating outside tomorrow', 'I was treating outside.')).toEqual({ reason: 'not_in_note', words: ['was'] });
    await expect(refusal('treating outside tomorrow', 'Treating outside.')).resolves.toBeNull();
    expect(await refusal('spot treating outside tomorrow', 'I was spot treating outside.')).toEqual({ reason: 'not_in_note', words: ['was'] });
    expect(await refusal('treating outside, tomorrow', 'I was treating outside.')).toEqual({ reason: 'not_in_note', words: ['was'] });
    expect(await refusal('treating outside tomorrow', 'I\'m treating outside.')).toEqual({ reason: 'not_in_note', words: ['am'] });
    expect(await refusal('treating outside, in two weeks', 'I was treating outside.')).toEqual({ reason: 'not_in_note', words: ['was'] });
    await expect(refusal('treating outside, in two weeks', 'Treating outside.')).resolves.toBeNull();
    expect(await refusal('treating outside, on 11/22', 'I was treating outside.')).toEqual({ reason: 'not_in_note', words: ['was'] });
    expect(await refusal('treating outside, on March 4', 'I was treating outside.')).toEqual({ reason: 'not_in_note', words: ['was'] });
    // A date in a sentence of its own, in a part another screen refuses first, and in a sentence the access mask took.
    expect(await refusal('treating outside. on March 4.', 'I was treating outside.')).toEqual({ reason: 'not_in_note', words: ['was'] });
    expect(await refusal('treating outside, pest free on March 4', 'I was treating outside.')).toEqual({ reason: 'not_in_note', words: ['was'] });
    expect(await refusal('gate opens tomorrow. treating outside', 'I was treating outside.')).toEqual({ reason: 'not_in_note', words: ['was'] });
    await expect(refusal('gate opens tomorrow. treating outside', 'Treating outside.')).resolves.toBeNull();
    // A word in "-ing" that names a thing sets no tense.
    await expect(refusal('ants active in building. back tomorrow', 'Ants were active in the building.')).resolves.toBeNull();
    // A note with no time.
    await expect(refusal('seeing ants in the kitchen', 'I\'m seeing ants in the kitchen.')).resolves.toBeNull();
    expect(await refusal('treated outside', 'I am treated outside.')).toEqual({ reason: 'not_in_note', words: ['am'] });
  });
});
