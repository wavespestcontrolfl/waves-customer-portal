/**
 * GATE_SMS_PROMPT_B1 change A, aggregator side: the latest finished visit's service_findings reach the context only behind the
 * gate, only with customer-safe notes on that visit, redacted, and never from technician_notes. Mocked db; synthetic text.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockRows = { value: [], throws: false };
const mockChain = {
  where: jest.fn(() => mockChain),
  whereRaw: jest.fn(() => mockChain),
  orderBy: jest.fn(() => mockChain),
  limit: jest.fn(() => mockChain),
  select: jest.fn(() => (mockRows.throws ? Promise.reject(Object.assign(new Error('boom'), { code: 'XX000' })) : Promise.resolve(mockRows.value))),
};
const mockDb = jest.fn(() => mockChain);
jest.mock('../models/db', () => mockDb);

const { loadLatestVisitFindings } = require('../services/context-aggregator');

const REVIEWED = 'WHAT WE DID:\nTreated the exterior perimeter and swept eaves.\nWHAT WE FOUND:\nLight ant activity near the lanai.';
const record = (over = {}) => ({ id: 'sr-1', technician_notes: REVIEWED, structured_notes: null, service_data: null, completion_source: null, ...over });
const ROWS = [
  { title: 'Ant trail at the lanai door', detail: 'Active trail along the slider track. Gate code 4471.', recommendation: 'Keep the slider track clean.', severity: 'medium', category: 'activity' },
  { title: '', detail: 'no title', recommendation: null, severity: 'low', category: 'observation' },
  // synthesized from RAW technician notes: title only, no detail or recommendation
  { title: 'Customer was rude to the technician', detail: null, recommendation: null, severity: 'low', category: 'conducive_condition' },
  { title: 'Gate code is on the lockbox', detail: '   ', recommendation: '', severity: 'low', category: 'observation' },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.value = ROWS;
  mockRows.throws = false;
  delete process.env.GATE_SMS_PROMPT_B1;
  delete process.env.GATE_SMS_REAL_ANSWERS;
});
const on = () => { process.env.GATE_SMS_PROMPT_B1 = 'true'; process.env.GATE_SMS_REAL_ANSWERS = 'true'; };

test('gate off: no query, no findings', async () => {
  expect(await loadLatestVisitFindings(record())).toBeNull();
  expect(mockDb).not.toHaveBeenCalled();
});

test('gate on: the visit findings load with title, detail, recommendation, severity, category; codes redacted; titleless rows dropped', async () => {
  on();
  const out = await loadLatestVisitFindings(record());
  expect(mockDb).toHaveBeenCalledWith('service_findings');
  expect(mockChain.where).toHaveBeenCalledWith({ service_record_id: 'sr-1' });
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ title: 'Ant trail at the lanai door', recommendation: 'Keep the slider track clean.', severity: 'medium', category: 'activity' });
  expect(out[0].detail).not.toContain('4471');
});

test('provenance: a title-only row (raw technician-note fragment) is dropped, a structured row stays; the rule also runs in SQL before the cap', async () => {
  on();
  const out = await loadLatestVisitFindings(record());
  expect(out.map((f) => f.title)).toEqual(['Ant trail at the lanai door']);
  expect(JSON.stringify(out)).not.toMatch(/rude|lockbox/i);
  expect(mockChain.whereRaw).toHaveBeenCalledWith(expect.stringContaining("btrim(COALESCE(detail, '')) <> ''"));
  expect(mockChain.whereRaw.mock.invocationCallOrder[0]).toBeLessThan(mockChain.limit.mock.invocationCallOrder[0]);
  // a recommendation alone is structured content too
  mockRows.value = [{ title: 'Seal the slider', detail: null, recommendation: 'Replace the weatherstrip.', severity: 'low', category: 'conducive_condition' }];
  expect((await loadLatestVisitFindings(record())).map((f) => f.title)).toEqual(['Seal the slider']);
  // nothing structured: no findings at all
  mockRows.value = [{ title: 'Customer was rude to the technician', detail: null, recommendation: null }];
  expect(await loadLatestVisitFindings(record())).toBeNull();
});

test('a visit with no customer-safe notes (raw or held report) shows no findings and runs no query', async () => {
  on();
  expect(await loadLatestVisitFindings(record({ technician_notes: 'gate code 4545, customer grumpy, treated exterior' }))).toBeNull();
  expect(await loadLatestVisitFindings(record({ technician_notes: null }))).toBeNull();
  expect(await loadLatestVisitFindings(null)).toBeNull();
  expect(mockDb).not.toHaveBeenCalled();
});

test('an unreadable findings table is no findings, not a failed context; the log carries no message text', async () => {
  on();
  mockRows.throws = true;
  expect(await loadLatestVisitFindings(record())).toBeNull();
  const logger = require('../services/logger');
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('XX000'));
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('boom');
});

// The technician's own note (structured_notes.reportNote): its record's findings reach the text as the report prints
// them (finding-provenance.js provenFindingRows): every title passes the customer-copy screen, and a row whose only
// text is the stock detail stands only for a label of the record's own form. The cut to five runs after the filters.
test("on a note record, a refused title or an unlisted stock row is never texted, and the five are cut after the filters", async () => {
  on();
  const { STRUCTURED_OBSERVATION_FINDING_DETAIL: STOCK } = require('../../shared/service-completion-observations');
  const notes = { reportNote: { v: 1, text: 'I treated the perimeter and swept the webs.', source: 'cleaned' }, formObservations: ['Yellowjacket'] };
  const noteRecord = record({ service_line: 'pest', service_type: 'Quarterly Pest Control', structured_notes: notes });
  const refused = { title: 'Safe for pets once dry', detail: null, recommendation: 'Keep pets off the lawn until it dries.', severity: 'low', category: 'observation' };
  const unlisted = { title: 'Fire ant mounds', detail: STOCK, recommendation: null, severity: 'high', category: 'observation' };
  const listed = { title: 'Yellowjacket', detail: STOCK, recommendation: null, severity: 'high', category: 'observation' };
  const real = (n) => ({ title: `Ant trail ${n}`, detail: 'A trail along the north wall.', recommendation: null, severity: 'low', category: 'activity' });
  mockRows.value = [refused, unlisted, listed, real(1), real(2), real(3), real(4), real(5)];
  const out = await loadLatestVisitFindings(noteRecord);
  expect(out.map((f) => f.title)).toEqual(['Yellowjacket', 'Ant trail 1', 'Ant trail 2', 'Ant trail 3', 'Ant trail 4']);
  expect(JSON.stringify(out)).not.toMatch(/Safe for pets|Keep pets off|Fire ant mounds/);
  // A record with no note keeps the first five rows with their own text, as today.
  const legacy = await loadLatestVisitFindings(record({ structured_notes: { formObservations: ['Yellowjacket'] } }));
  expect(legacy.map((f) => f.title)).toEqual(['Safe for pets once dry', 'Fire ant mounds', 'Yellowjacket', 'Ant trail 1', 'Ant trail 2']);
});

test("on a note record, a finding's refused recommendation is never texted, and the row keeps its passing detail", async () => {
  on();
  const notes = { reportNote: { v: 1, text: 'I treated the perimeter and swept the webs.', source: 'cleaned' } };
  const noteRecord = record({ service_line: 'pest', service_type: 'Quarterly Pest Control', structured_notes: notes });
  mockRows.value = [{
    title: 'Ant trail by the lanai', detail: 'A trail along the lanai door.', recommendation: 'Keep pets off it, it is safe once dry', severity: 'low', category: 'activity',
  }];
  const out = await loadLatestVisitFindings(noteRecord);
  expect(out).toEqual([expect.objectContaining({ title: 'Ant trail by the lanai', detail: 'A trail along the lanai door.', recommendation: null })]);
  // A record with no note texts the row whole, as today.
  const legacy = await loadLatestVisitFindings(record({ structured_notes: {} }));
  expect(legacy[0].recommendation).toBe('Keep pets off it, it is safe once dry');
});
