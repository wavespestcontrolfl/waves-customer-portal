/**
 * The technician's own note as report copy (owner 2026-11-19): the reader.
 *
 * A completion will store structured_notes.reportNote = { v: 1, text, source }:
 * the customer text of a report whose summary is the technician's note. These
 * tests pin the reader (no caller reads it yet):
 *  - only that exact shape reads as customer copy, and the customer-copy
 *    screens run on every read;
 *  - a record with a note, refused or in any other shape, never falls back
 *    to its raw notes column;
 *  - the printed summary signs a 'cleaned' note with the technician's first
 *    name (as the identity snapshot froze it, never a generic label) and
 *    leaves a 'fixed' one and the titled report as they are.
 */

const {
  reportNoteCustomerCopy,
  visitReportCustomerCopy,
  carriesReportNote,
  printedReportSummary,
  reportTechnicianFirstName,
  noteRecordCopyViolations,
  heldAccessCode,
  MAX_REPORT_NOTE_CHARS,
} = require('../services/service-report/technician-report-copy');

const NOTE = 'I found a fire ant hill near the back of the house and spot-treated it. I also swept the spider webs outside.';
const TITLED = 'WHAT WE DID\n\nWe treated the exterior perimeter.\n\nWHAT WE FOUND\n\nLight ant activity near the lanai.';
const stored = (overrides = {}) => ({ reportNote: { v: 1, text: NOTE, source: 'cleaned', ...overrides } });
// What a record that carries a note in any other shape reads as: no text.
const SHAPELESS = { body: null, violations: ['report_note_shape'], source: null };
const MALFORMED = [
  { reportNote: null },
  { reportNote: NOTE },
  { reportNote: [] },
  stored({ v: 2 }),
  stored({ source: 'edited' }),
  stored({ text: '   ' }),
  stored({ text: 42 }),
  stored({ text: 'x'.repeat(MAX_REPORT_NOTE_CHARS + 1) }),
  stored({ text: `${NOTE}\nGate code 4471.` }),
  // Every other line or paragraph break (pre-push P1 on fc43308977).
  ...['\u2028', '\u2029', '\u0085', '\v', '\f', '\r'].map((brk) => stored({ text: `${NOTE}${brk}Gate code 4471.` })),
];
// Stored notes that cannot be read may hold a note: a cut-off serialized note,
// or a string that parses to something other than an object.
// pg decodes a JSONB scalar to a number or boolean (pre-push P1 on b005660da2).
const UNREADABLE = ['{not json', '{"reportNote":{"v":1,"text":"I treated the la', '"a string"', '42', 42, true, false, [], ['x']];

describe('reportNoteCustomerCopy: the stored shape', () => {
  test('reads the note from an object or a JSON string', () => {
    expect(reportNoteCustomerCopy(stored())).toEqual({ body: NOTE, violations: [], source: 'cleaned' });
    expect(reportNoteCustomerCopy(JSON.stringify(stored({ source: 'fixed' })))).toEqual({ body: NOTE, violations: [], source: 'fixed' });
  });

  test('a record with no note reads as null, so the titled report may stand', () => {
    expect(reportNoteCustomerCopy(null)).toBeNull();
    expect(reportNoteCustomerCopy('')).toBeNull();
    expect(reportNoteCustomerCopy('null')).toBeNull();
    expect(reportNoteCustomerCopy({})).toBeNull();
    expect(reportNoteCustomerCopy({ reportNote: undefined })).toBeNull();
    expect(carriesReportNote({})).toBe(false);
  });

  // Pre-push P1 on fc43308977: a parse failure read as "no note".
  test('stored notes that cannot be read count as a note and read as no text', () => {
    UNREADABLE.forEach((notes) => {
      expect(reportNoteCustomerCopy(notes)).toEqual({ body: null, violations: ['report_note_unreadable'], source: null });
      expect(carriesReportNote(notes)).toBe(true);
    });
  });

  test('a note in any other shape reads as no text, a second line included', () => {
    MALFORMED.forEach((notes) => expect(reportNoteCustomerCopy(notes)).toEqual(SHAPELESS));
    expect(reportNoteCustomerCopy(stored({ text: `  ${NOTE}  ` }))?.body).toBe(NOTE);
  });

  test('the customer-copy screens run on every read', () => {
    const unsafe = reportNoteCustomerCopy(stored({ text: 'I treated the lanai. It is safe for pets now.' }));
    expect(unsafe.body).toBeNull();
    expect(unsafe.violations.length).toBeGreaterThan(0);
    expect(reportNoteCustomerCopy(stored({ text: 'I treated the garage. The gate code is 4471.' })).body).toBeNull();
    // Forms the report check in customerCopyViolations does not name.
    for (const text of [
      'I treated the yard. Side access 4417 for the yard.',
      'I treated the yard. Side gate 12-34 for the yard.',
      'I treated the yard. I used 1234 to get through the gate.',
    ]) {
      const held = reportNoteCustomerCopy(stored({ text }));
      expect(held.body).toBeNull();
      expect(held.violations).toEqual(['note_record_access_code']);
    }
    // A code noun beside a location word, and a word after a code noun far
    // from it: the completion check and the visit-history redactor caught
    // these; the words about getting in catch them now.
    expect(noteRecordCopyViolations('I treated the yard. The side gate has a code.')).toEqual(['note_record_access_code']);
    expect(noteRecordCopyViolations('I treated the yard. The password for the side gate came from the owner today: Bluebird.')).toEqual(['note_record_access_code']);
    expect(noteRecordCopyViolations('I treated the yard and the garage door frame.')).toEqual([]);
  });

  test('a code-shaped number withholds the note, whatever words surround it; small counts stand', () => {
    // Rounds 24 and 26: a code with no code noun.
    for (const text of [
      'I treated the yard. The pedestrian entrance unlocks with 1234.',
      'I treated the yard. I punched 1234 into the padlock.',
    ]) {
      expect([text, noteRecordCopyViolations(text)]).toEqual([text, ['note_record_access_code']]);
    }
    // Only the code's shape catches each of these: 3 or more digits, with up
    // to 3 spaces, line breaks or hyphens between any two, or 3 or more
    // number words.
    for (const text of [
      'I treated the yard. The number is 1234.',
      'I treated the yard. The number is 12 34.',
      'I treated the yard. The number is 1 2 3 4.',
      'I treated the yard. The number is 12 - 34.',
      'I treated the yard. The number is 12\n34.',
      'I treated the yard. The number is one two three four.',
      'I treated the yard. The number is twelve thirty-four.',
    ]) {
      expect([text, noteRecordCopyViolations(text)]).toEqual([text, ['note_record_access_code']]);
    }
    for (const text of [
      'I treated 3 stations and 12 feet of fence.',
      'I applied 1.25 oz per gallon.',
      'I checked stations 1, 2 and 3.',
      'I treated two or three spots.',
      'I treated twenty-five feet of fence line.',
      'I will check the stations in 14 days.',
    ]) {
      expect([text, noteRecordCopyViolations(text)]).toEqual([text, []]);
    }
  });

  test('a value that speaks of getting in is withheld, whatever the code is; pest copy about doors and entry points stands', () => {
    // Round 27: a code that is a word has no shape.
    expect(noteRecordCopyViolations('I treated the yard. I used the word ROSE to unlock the side gate.')).toEqual(['note_record_access_code']);
    // One line for each part of the rule: no other part catches it.
    for (const text of [
      'Rose works at the side gate.',
      'Rose opens the padlock.',
      'Rose is the key for the shed.',
      'I tried a new code.',
      'Rose is the magic word.',
      'Rose grants access to the yard.',
      // Round 28, and how anyone gets in: getting or letting in, entering,
      // keying a word in, a security device.
      'I punched rose into the security panel to get inside.',
      'Rose is how to get in.',
      'Rose lets you in.',
      'Enter rose at the back.',
      'I punched rose at the back.',
      'Say rose at the back.',
      'Rose works on the panel.',
      'Side entry: rose.',
      'ROSE at the side entry.',
      // A door, garage, entrance or lanai only when it is keyed, followed by
      // a colon or a dash, or beside a word in capitals on its line.
      'Say rose at the front door.',
      'Front door: rose.',
      'Front door - rose.',
      'Use ROSE at the front door.',
    ]) {
      const value = `I treated the yard. ${text}`;
      expect([value, noteRecordCopyViolations(value)]).toEqual([value, ['note_record_access_code']]);
    }
    // Pests that get in are refused too: no list tells their way in from a
    // person's (production: 6 more of 401 raw notes, 2 of 474 recaps).
    for (const text of [
      'Ants enter through gaps under the door.',
      'Ants were getting inside through the slider track.',
    ]) {
      expect([text, noteRecordCopyViolations(text)]).toEqual([text, ['note_record_access_code']]);
    }
    // Pest copy about doors and entry points stands.
    for (const text of [
      'I treated around the doors with a granular product.',
      'I treated the garage-door frame.',
      'I sealed the entry points by the HVAC pad.',
      'I treated inside and outside.',
      'I treated along the slider track and through the garage.',
    ]) {
      expect([text, noteRecordCopyViolations(text)]).toEqual([text, []]);
    }
    // A title line in capitals holds no code.
    expect(heldAccessCode('WHAT WE DID:\nI treated around the front door.')).toBe(false);
  });

  test('a time figure in any form withholds the note; the sanctioned wording and days stand', () => {
    // AGENTS.md bans a fixed re-entry or drying time; on a note record each
    // time figure counts, as no word list can tell which one is a re-entry
    // time (noteRecordCopyViolations). The unit word alone decides, so no
    // way of writing the figure gets past it.
    for (const text of [
      'I treated the lanai. Keep pets inside for eighteen minutes after application.',
      'I treated the lanai. You can re-enter in ½ hour.',
      'I treated the lanai. Wait 30min before you let the dog out.',
      'I treated the lanai. Wait ½hr.',
      'I treated the lanai. Wait 2h.',
      'I treated the lanai. Wait 90s before stepping back onto the patio.',
      'I treated the lanai. Give it an hour and a half.',
      'I treated the lanai. Give it a few minutes.',
      'I treated the lanai. Keep the dog in for hours.',
      'I treated the lanai. The dog can go out at 3 o\u2019clock.',
      'I treated the lanai. The dog can go out at half past three.',
      // A clock time in any marked form, or an hour after a time word.
      'I treated the lanai. Pets can return at four PM.',
      'I treated the lanai. Pets can return at four p.m.',
      'I treated the lanai. Pets can go out at seven am.',
      'I treated the lanai. Pets can go out at 7 a.m.',
      'I treated the lanai. Pets can go out at four-thirty AM.',
      'I treated the lanai. Pets can go out at four in the afternoon.',
      'I treated the lanai. Pets can return after four.',
      'I treated the lanai. Keep pets inside until 4.',
      'I treated the lanai. Keep pets inside between 2 and 4.',
      // Each part of the rule alone: no other part catches these. No line
      // names a pet, a person, drying or re-entry, so the sentence rules
      // (the next tests) stay out of them.
      'I treated the lanai. The work ended once it was 3:30.',
      'I treated the lanai. The work ended once it was four PM.',
      'I treated the lanai. The work ended once it was nine-ish a.m.',
      'I treated the lanai. The work ended once it was seven am.',
      'I treated the lanai. The work ended once it was 3 o\'clock.',
      'I treated the lanai. The work ended once it was four in the afternoon.',
      'I treated the lanai. The work ended at a quarter to four.',
      'I treated the lanai. The work ended after four.',
      // A 24-hour clock after a time word.
      'I treated the lanai. The work ended at 1600.',
      'I treated the lanai. The work ended after 0830.',
      'I treated the lanai. The work ran until 2400.',
      'I treated the perimeter. The spray dries in 30 minutes.',
      'I treated the perimeter. Allow a 30-minute drying period.',
      'I treated the lanai. Return to the treated area after 30+ minutes.',
      'I treated the lanai. Give it thirty or more minutes.',
      'I treated the lanai. Keep the dog in for half an hour.',
      'I treated the lanai. The dog can go out at 3:30.',
      'I treated the lanai. The dog can go out after 4 pm.',
      'I treated the lanai. Keep the dog in overnight.',
    ]) {
      const parsed = reportNoteCustomerCopy(stored({ text }));
      expect(parsed.body).toBeNull();
      expect(parsed.violations).toContain('note_record_time');
    }
    for (const text of [
      'I treated the lanai. Keep people and pets off treated areas until dry.',
      'I placed bait in the garage. I will check the stations again in 14 days.',
      'I treated the lanai and swept the webs. Have a great day!',
      // The ordinal, and words that only contain a unit's letters.
      'This was your second visit. I sealed a gap in the second bathroom.',
      'I found a black widow with the red hourglass marking and removed it.',
      'I treated the insect entry points and examined the attic.',
      'I split the bait, half to the front and half to the back.',
      // "am" after anything but a number, a part of the day with no hour.
      'I am glad the lanai looks better. I treated the IPM zones.',
      'I treated the lanai and swept the webs. Have a great afternoon!',
    ]) expect(reportNoteCustomerCopy(stored({ text })).body).toBe(text);
  });

  test('a day word in a sentence about drying or re-entry withholds the note; follow-up days stand', () => {
    // Days stay legal, except in a sentence that names drying or re-entry or
    // the people and pets a re-entry line is about: there "until dry" is the
    // only time a note may give. Each marker and each kind of time word has a
    // line here that no other part of the rule catches.
    for (const text of [
      'I treated the lawn edge. The spray dries in half a day.',
      'I treated the lawn edge. Keep pets off the treated grass for two days.',
      'I treated the yard. Keep off the treated grass for 1.5 days.',
      'I treated the yard. Keep off the grass approx. 2 days.',
      // The split into sentences tells case apart: a small letter after a
      // full stop never starts a sentence, and "approx." never ends one.
      'I treated the yard. Avoid the patio for approx. two days.',
      'I treated the yard. Avoid the patio for approx. Two days.',
      'I treated the yard. Avoid the patio for Approx. Two days.',
      'I treated the yard. Keep pets off the grass treated w. granules for two days.',
      'I treated the yard. Stay off the treated grass for a couple of days.',
      'I treated the yard. Re-entry is fine in two days.',
      'I treated the yard. The yard is off-limits for a day.',
      'I treated the yard. Avoid the treated lawn for a week.',
      'I treated the yard. The dog can go out in two days.',
      'I treated the yard. In two days the treated lawn will be dry.',
      'I treated the yard. Keep off the lawn until Monday.',
      'I treated the patio. The patio is off limits until Sat.',
      'I treated the yard. Keep pets off the lawn until Thurs.',
      'I treated the yard. Keep off the treated grass for the rest of today.',
      'I treated the yard. The spray will be dry by this evening.',
      'I treated the yard. Stay inside until after lunch.',
      // Any figure or number word, a month or a season.
      'I treated the yard. Pets can return 11/22.',
      'I treated the yard. Keep off 2d.',
      'I treated the yard. Keep pets inside until twenty past.',
      'I treated the yard. Keep pets inside for another two.',
      'I treated the yard. Keep pets off the lawn until November.',
      'I treated the yard. Avoid the treated soil until spring.',
      // A figure or number word with no day word: the re-entry verbs of the
      // complete screen (the next test) need a day word, so only this rule
      // catches these.
      'I treated the yard. Re-entry is fine in another two.',
      'I treated the yard. Keep off the treated grass for another 48.',
      'I treated the yard. Stay off the treated grass for another two.',
      'I treated the yard. For a day the yard is off-limits.',
      'I treated the yard. Pets can go out in 48.',
      // A customer's permission to use the place again, with a named place
      // or a pronoun.
      'I treated the patio. You can use the patio again in two days.',
      'I treated the patio. You can use it again in two days.',
      'I treated the lanai. Feel free to use the lanai after 2.',
      'I treated the yard. It is fine to enjoy the yard in two days.',
      'I treated the patio. The treated patio is fine to use again on Monday.',
      'I treated the lanai. The lanai\u2019s okay to use in two days.',
      'I treated the pool deck. You\u2019re free to use the pool deck on Monday.',
    ]) {
      const parsed = reportNoteCustomerCopy(stored({ text }));
      expect(parsed.body).toBeNull();
      expect(parsed.violations).toEqual(['note_record_time']);
    }
    for (const text of [
      'I treated the lanai. Keep people and pets off treated areas until dry.',
      'I placed bait in the garage. I will check the stations again in 14 days.',
      'I treated the lanai. Keep an eye out for activity over the next two weeks.',
      // "may" the verb and "fall" the verb are no month or season.
      'I treated the lanai. Pets may return once it is dry.',
      'I treated the lanai. The webs fall away once the spray is dry.',
      // A follow-up on a short weekday names no drying or re-entry.
      'I placed bait in the garage. I will check the stations on Thurs.',
      // The technician's own use is no permission to the customer.
      'I placed bait in the garage. I will use a new bait in two weeks.',
      // A full stop before a capital ends the sentence.
      'I treated the lanai. Keep pets off until dry. In two weeks you should see fewer ants.',
    ]) expect(reportNoteCustomerCopy(stored({ text })).body).toBe(text);
    // A note holds one line, but a finding field or list value can hold two:
    // a line break does not end the sentence.
    expect(noteRecordCopyViolations('Keep off the treated grass\nfor two days.')).toEqual(['note_record_time']);
  });

  test('a re-entry verb the complete screen knows, with a day word, withholds the note; a follow-up by the technician stands', () => {
    // activity-indicators.js REENTRY_VERB_SRC (return, come back, walk on,
    // use the treated area, ready for use, ...) pairs with minutes and hours
    // in the complete screen; on a note record it pairs with a day word too.
    // None of these lines names a drying or re-entry marker of the rule above.
    for (const text of [
      'I treated the yard. You can return to the treated area in two days.',
      'I treated the patio. Return to the treated patio in two days.',
      'I treated the yard. In two days you can return to the treated area.',
      'I treated the lawn. You can walk on the lawn again on Monday.',
      'I treated the rooms. You can use the treated rooms again in a week.',
      'I treated the rooms. The treated rooms are ready for use in 2d.',
      'I treated the rooms. You can return 11/22.',
    ]) {
      const parsed = reportNoteCustomerCopy(stored({ text }));
      expect(parsed.body).toBeNull();
      expect(parsed.violations).toEqual(['note_record_time']);
    }
    for (const text of [
      'I placed bait in the garage. I will return in two weeks to check the bait stations.',
      'I placed bait in the garage. We\u2019ll come back in 14 days to check the stations.',
      'I placed bait in the garage. Your technician will return in two weeks.',
    ]) expect(reportNoteCustomerCopy(stored({ text })).body).toBe(text);
  });
});

describe('visitReportCustomerCopy: one rule for a record', () => {
  // A pest visit: the note stands only on a pest report (phase 1).
  const PEST = { service_line: 'pest' };

  test('the note wins over a titled report in the notes column', () => {
    expect(visitReportCustomerCopy({ ...PEST, technician_notes: TITLED, structured_notes: stored() }).body).toBe(NOTE);
  });

  test('a visit whose recorded outcome applied nothing shows no note, callback or not', () => {
    const outcome = (visitOutcome) => JSON.stringify({ protocol: { visitOutcome } });
    for (const row of [
      { is_callback: true, service_data: outcome('inspection_only') },
      { is_callback: true, service_data: outcome('customer_declined') },
      { service_data: outcome('inspection_only') },
      { structured_notes: { ...stored(), visitOutcome: 'customer_declined' } },
    ]) {
      const parsed = visitReportCustomerCopy({ ...PEST, technician_notes: TITLED, structured_notes: stored(), ...row });
      expect(parsed.body).toBeNull();
      expect(parsed.violations).toEqual(['report_note_no_application']);
    }
    // A treated or incomplete visit keeps it; a record with no note keeps
    // its titled report.
    for (const visitOutcome of ['treated', 'incomplete']) {
      expect(visitReportCustomerCopy({ ...PEST, is_callback: true, structured_notes: stored(), service_data: outcome(visitOutcome) }).body).toBe(NOTE);
    }
    expect(visitReportCustomerCopy({ ...PEST, technician_notes: TITLED, service_data: outcome('inspection_only') }).body).toContain('We treated');
  });

  test('service data that is present but cannot be read shows no note; absent data reads as none', () => {
    // It hides the outcome and the frozen typed cards the note rule checks.
    for (const service_data of [
      '{"typedReportSnapshot": {', '  ', 'null', '[]', [], 5,
      JSON.stringify(JSON.stringify({ protocol: { visitOutcome: 'treated' } })),
      { protocol: '{"visitOutcome": ' }, { protocol: [] },
    ]) {
      const parsed = visitReportCustomerCopy({ ...PEST, technician_notes: TITLED, structured_notes: stored(), service_data });
      expect(parsed.body).toBeNull();
      expect(parsed.violations).toEqual(['report_note_unreadable_service_data']);
    }
    for (const service_data of [null, undefined, '', {}, '{}', { protocol: null }, { protocol: JSON.stringify({ visitOutcome: 'treated' }) }]) {
      expect(visitReportCustomerCopy({ ...PEST, structured_notes: stored(), service_data }).body).toBe(NOTE);
    }
    // A record with no note keeps its titled report, as on main.
    expect(visitReportCustomerCopy({ ...PEST, technician_notes: TITLED, service_data: '{"typedReportSnapshot": {' }).body).toContain('We treated');
  });

  test('a note stands only on a pest record; a row read without the line column shows none', () => {
    expect(visitReportCustomerCopy({ service_line: null, service_type: 'Quarterly Pest Control', technician_notes: TITLED, structured_notes: stored() }).body).toBe(NOTE);
    for (const row of [
      { service_line: 'lawn', service_type: 'Quarterly Pest Control' },
      { service_line: null, service_type: 'Lawn Care' },
      { service_type: 'Quarterly Pest Control' },
    ]) {
      const parsed = visitReportCustomerCopy({ ...row, technician_notes: TITLED, structured_notes: stored() });
      expect(parsed.body).toBeNull();
      expect(parsed.violations).toEqual(['report_note_service_line']);
    }
  });

  test('a record with no note keeps the titled report', () => {
    const parsed = visitReportCustomerCopy({ technician_notes: TITLED, structured_notes: '{}' });
    expect(parsed.body).toBe('We treated the exterior perimeter. Light ant activity near the lanai.');
    expect(parsed.source).toBeUndefined();
    expect(visitReportCustomerCopy({ technician_notes: 'treated lanai, gate code 4471' })).toBeNull();
    expect(visitReportCustomerCopy(null)).toBeNull();
  });

  test('a refused note never falls back to the notes column', () => {
    const refused = stored({ text: 'I treated the lanai. It is safe for pets now.' });
    expect(visitReportCustomerCopy({ ...PEST, technician_notes: TITLED, structured_notes: refused }).body).toBeNull();
  });

  test('a note in any other shape, or notes that cannot be read, never fall back to a titled report in the notes column', () => {
    [...MALFORMED, ...UNREADABLE].forEach((notes) => (
      expect(visitReportCustomerCopy({ ...PEST, technician_notes: TITLED, structured_notes: notes }).body).toBeNull()
    ));
  });
});


describe('printedReportSummary: the note as the report prints it', () => {
  const record = (overrides = {}) => ({ technician_name: 'Jordan Rivers', ...overrides });

  test("a cleaned note is signed with the technician's first name; a fixed one is not", () => {
    expect(printedReportSummary({ body: NOTE, source: 'cleaned' }, record())).toBe(`${NOTE} — Jordan`);
    expect(printedReportSummary({ body: NOTE, source: 'fixed' }, record())).toBe(NOTE);
    expect(printedReportSummary({ body: null, source: 'cleaned' }, record())).toBeNull();
  });

  test('the titled report prints as it is', () => {
    const titled = visitReportCustomerCopy({ technician_notes: TITLED });
    expect(printedReportSummary(titled, record())).toBe(titled.body);
  });

  test('the stored first name wins; a generic label or no name signs nothing', () => {
    expect(printedReportSummary({ body: NOTE, source: 'cleaned' }, record({ technician_first_name: 'Jo' }))).toBe(`${NOTE} — Jo`);
    expect(printedReportSummary({ body: NOTE, source: 'cleaned' }, record({ technician_name: 'Waves Technician' }))).toBe(NOTE);
    expect(printedReportSummary({ body: NOTE, source: 'cleaned' }, {})).toBe(NOTE);
  });

  // Pre-push P1 on b005660da2: a generic label in the first-name field signed the note.
  test('a generic label in any name field signs nothing', () => {
    [
      { technician_first_name: 'Waves Technician' },
      { technician_first_name: 'your technician' },
      { technician_first_name: 'Waves', technician_last_name: 'Team' },
      { technician_first_name: 'Technician' },
      { technician_first_name: '', technician_name: 'Technician' },
    ].forEach((fields) => expect(reportTechnicianFirstName(record(fields))).toBeNull());
    expect(reportTechnicianFirstName(record({ technician_first_name: 'Mary Ann', technician_last_name: 'Rivers' }))).toBe('Mary Ann');
  });

  test('the name is the one the identity snapshot froze, not a later row', () => {
    const frozen = JSON.stringify({ reportIdentitySnapshot: { version: 1, technicianName: 'Jordan Rivers' } });
    expect(reportTechnicianFirstName({ technician_name: 'Casey Rivers', service_data: frozen })).toBe('Jordan');
    expect(reportTechnicianFirstName({ technician_name: 'Casey Rivers' })).toBe('Casey');
  });
});
