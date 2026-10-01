// The technician's note as a customer sees it (owner ruling 2026-10-01:
// customers see only the report text, never the tech's raw note). One rule
// for the service history, the service-report PDF and the pay page; the
// voice agent's spoken report uses the reviewed parse alone.

const { customerReportNotes, reviewedReportNotes } = require('../services/service-report/customer-report-notes');

const REVIEWED = [
  'WHAT WE DID',
  'We treated the exterior perimeter and knocked down webs on the lanai.',
  'WHAT WE FOUND',
  'Light ant activity along the kitchen slab and no other concerns.',
].join('\n');
const FOUR_SECTION = [
  'WHAT WE FOUND',
  'Ghost ants were trailing at the kitchen counter.',
  'WHAT WE DID AND WHY',
  'We placed bait along the counter edge.',
  'WHAT TO EXPECT',
  'You may see more ants for a few days.',
  "WHAT'S NEXT",
  'If ants are still trailing, let us know.',
].join('\n');

const record = (overrides = {}) => ({
  technician_notes: REVIEWED,
  structured_notes: null,
  service_data: null,
  completion_source: null,
  ...overrides,
});

describe('customerReportNotes', () => {
  const gate = process.env.GATE_REPORT_WRITER_RULES;
  afterEach(() => {
    if (gate === undefined) delete process.env.GATE_REPORT_WRITER_RULES;
    else process.env.GATE_REPORT_WRITER_RULES = gate;
  });

  test('the reviewed report shows as its text, without the section titles', () => {
    expect(customerReportNotes(record())).toBe(
      'We treated the exterior perimeter and knocked down webs on the lanai. Light ant activity along the kitchen slab and no other concerns.',
    );
  });

  test("the tech's own note never shows", () => {
    expect(customerReportNotes(record({ technician_notes: 'Gate code 4417. Dog in the yard, customer owes $40 from last time.' }))).toBeNull();
    // A note typed under the reviewed report is not reviewed copy either.
    expect(customerReportNotes(record({ technician_notes: `${REVIEWED}\nGate code 4417` }))).toBeNull();
  });

  test('a code inside the reviewed text is never shown', () => {
    const notes = REVIEWED.replace('no other concerns.', 'no other concerns, gate code 4417.');
    expect(customerReportNotes(record({ technician_notes: notes })) || '').not.toContain('4417');
  });

  test('a report body the completion rejected, or service data that cannot be read, shows nothing', () => {
    expect(customerReportNotes(record({ service_data: { technicianReportBodyRejected: 'trade_name' } }))).toBeNull();
    expect(customerReportNotes(record({ service_data: '{not json' }))).toBeNull();
  });

  test('a typed report held from customers shows nothing', () => {
    expect(customerReportNotes(record({ structured_notes: { typedReportDelivery: 'internal_only' } }))).toBeNull();
    expect(customerReportNotes(record({ structured_notes: JSON.stringify({ typedReportDelivery: 'disabled' }) }))).toBeNull();
  });

  test("a project completion keeps its line: it is the project's own title and recommendations", () => {
    const notes = 'Project completed: Rodent exclusion\n\nSeal the gap under the garage door.';
    expect(customerReportNotes(record({ technician_notes: notes, completion_source: 'project_completion' }))).toBe(notes);
    expect(customerReportNotes(record({ technician_notes: notes, structured_notes: { projectCompletion: true } }))).toBe(notes);
    // The voice agent's rule has no such exception.
    expect(reviewedReportNotes(record({ technician_notes: notes, completion_source: 'project_completion' }))).toBeNull();
  });

  test('a four-section report shows only while the writer rules are on, like the web report', () => {
    delete process.env.GATE_REPORT_WRITER_RULES;
    expect(customerReportNotes(record({ technician_notes: FOUR_SECTION }))).toBeNull();
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    expect(customerReportNotes(record({ technician_notes: FOUR_SECTION }))).toBe(
      'Ghost ants were trailing at the kitchen counter. We placed bait along the counter edge. You may see more ants for a few days. If ants are still trailing, let us know.',
    );
  });

  test('an empty note shows nothing', () => {
    expect(customerReportNotes(record({ technician_notes: '' }))).toBeNull();
    expect(customerReportNotes(record({ technician_notes: null }))).toBeNull();
  });
});
