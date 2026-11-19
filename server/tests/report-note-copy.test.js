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
  printedReportSummary,
  reportTechnicianFirstName,
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
];

describe('reportNoteCustomerCopy: the stored shape', () => {
  test('reads the note from an object or a JSON string', () => {
    expect(reportNoteCustomerCopy(stored())).toEqual({ body: NOTE, violations: [], source: 'cleaned' });
    expect(reportNoteCustomerCopy(JSON.stringify(stored({ source: 'fixed' })))).toEqual({ body: NOTE, violations: [], source: 'fixed' });
  });

  test('a record with no note reads as null, so the titled report may stand', () => {
    expect(reportNoteCustomerCopy(null)).toBeNull();
    expect(reportNoteCustomerCopy('{not json')).toBeNull();
    expect(reportNoteCustomerCopy({})).toBeNull();
    expect(reportNoteCustomerCopy({ reportNote: undefined })).toBeNull();
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
  });
});

describe('visitReportCustomerCopy: one rule for a record', () => {
  test('the note wins over a titled report in the notes column', () => {
    expect(visitReportCustomerCopy({ technician_notes: TITLED, structured_notes: stored() }).body).toBe(NOTE);
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
    expect(visitReportCustomerCopy({ technician_notes: TITLED, structured_notes: refused }).body).toBeNull();
  });

  test('a note in any other shape never falls back to a titled report in the notes column', () => {
    MALFORMED.forEach((notes) => expect(visitReportCustomerCopy({ technician_notes: TITLED, structured_notes: notes }).body).toBeNull());
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

  test('the name is the one the identity snapshot froze, not a later row', () => {
    const frozen = JSON.stringify({ reportIdentitySnapshot: { version: 1, technicianName: 'Jordan Rivers' } });
    expect(reportTechnicianFirstName({ technician_name: 'Casey Rivers', service_data: frozen })).toBe('Jordan');
    expect(reportTechnicianFirstName({ technician_name: 'Casey Rivers' })).toBe('Casey');
  });
});
