// The Documents API PDF (routes/documents.js generateServiceReportPDF) is a
// customer render of one visit, at two entry points: the signed-in download
// (GET /api/documents/service-report/:serviceRecordId) and the public share
// link (GET /api/documents/shared/:token). On a record that carries the
// Every record prints the web report's customer lists (report-data.js
// buildProtocolPayload: structuredObservations, structuredRecommendations):
// only what the completion form recorded. The merged lists fold in raw
// [Found] / [Next] lines of technician_notes, and no reviewed path prints
// ai_report. On every record each value passes the complete customer-copy
// screen (customerCopyViolations) before it prints, and on a record that
// carries the technician's own note (structured_notes.reportNote) the note's
// screen too. The real pdfkit renders; a spy on its text() reads what the PDF
// prints.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan' };
    next();
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/photos', () => ({
  CUSTOMER_DWELL_TTL_SECONDS: 86400,
  getViewUrl: jest.fn(),
  getDownloadUrl: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());

const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('../models/db');
const documentsRouter = require('../routes/documents');
// Production loads the web report's module at boot (server/index.js mounts
// reports-public.js, which requires it), so the PDF's lazy require of
// buildProtocolPayload finds it loaded. Load it here too, outside each
// test's time limit: on a busy machine it takes seconds.
require('../services/service-report/report-data');

const SHARE_TOKEN = 'a'.repeat(64);
const NOTE_TEXT = 'I treated the perimeter and knocked down the webs by the lanai.';
// The raw note's tagged lines, as completion merges them into the lists.
const RAW_FOUND = 'Dog loose in the back yard, warn the next tech';
const RAW_NEXT = 'Office: bill the builder for the soffit repair';

let serviceRow = null;

function installDb() {
  db.raw = jest.fn(() => 'raw');
  db.mockImplementation((table) => {
    const name = String(table).split(' ')[0];
    const one = {
      service_records: serviceRow,
      customers: { id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan' },
      document_share_links: {
        id: 'link-1',
        share_token: SHARE_TOKEN,
        service_record_id: 'svc-1',
        customer_id: 'cust-1',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      },
    }[name] || null;
    const q = {
      where() { return q; },
      whereNull() { return q; },
      leftJoin() { return q; },
      select() { return q; },
      first: async () => one,
      update: async () => 1,
      then(resolve, reject) { return Promise.resolve([]).then(resolve, reject); },
      catch(handler) { return Promise.resolve([]).catch(handler); },
    };
    return q;
  });
}

function visit(structuredNotes) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    service_type: 'Quarterly Pest Control',
    service_line: 'pest',
    service_date: '2026-11-18',
    status: 'completed',
    technician_name: 'Jordan Reyes',
    technician_notes: `[Found] ${RAW_FOUND}\n[Next] ${RAW_NEXT}\nSprayed the eaves.`,
    structured_notes: structuredNotes,
    ai_report: JSON.stringify({ observations: ['Wasp nest under the eave'], recommendations: ['Seal the soffit gap'] }),
  };
}

const LISTS = {
  // The merged lists: the form's values plus the raw note's tagged lines.
  observations: ['Light ant activity', RAW_FOUND],
  recommendations: ['Trim the hedge back from the wall', RAW_NEXT],
  // The form's own values; "Safe for pets once dry" fails the screen.
  formObservations: ['Light ant activity', 'Safe for pets once dry'],
  formRecommendations: ['Trim the hedge back from the wall'],
};

let server;
let base;
let textSpy;

beforeAll(async () => {
  textSpy = jest.spyOn(PDFDocument.prototype, 'text');
  const app = express();
  app.use(express.json());
  app.use('/api/documents', documentsRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  textSpy.mockRestore();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  serviceRow = null;
  installDb();
});

async function printed(path) {
  textSpy.mockClear();
  const response = await fetch(`${base}${path}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/pdf');
  await response.arrayBuffer();
  return textSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe.each([
  ['the signed-in download', '/api/documents/service-report/svc-1'],
  ['the share link', `/api/documents/shared/${SHARE_TOKEN}`],
])('the report PDF through %s', (_label, path) => {
  test('a visit corrected after completion prints its note only where the web report shows it', async () => {
    // The web report judges the line from the stored row (no stored line: the
    // stored type); this PDF prints the frozen title completion saved.
    const notes = JSON.stringify({ reportNote: { v: 1, text: NOTE_TEXT, source: 'cleaned' }, ...LISTS });
    const frozenAs = (serviceTitle) => JSON.stringify({ reportIdentitySnapshot: { version: 1, serviceTitle } });
    // Completed as pest, corrected to lawn: the web withholds the note.
    serviceRow = { ...visit(notes), service_line: null, service_type: 'Lawn Fertilization', service_data: frozenAs('Quarterly Pest Control') };
    const lawnNow = await printed(path);
    expect(lawnNow).toContain('Quarterly Pest Control');
    expect(lawnNow).not.toContain('I treated the perimeter');
    // Completed as lawn, corrected to pest: the web shows the note.
    serviceRow = { ...visit(notes), service_line: null, service_type: 'Quarterly Pest Control', service_data: frozenAs('Lawn Fertilization') };
    expect(await printed(path)).toContain('I treated the perimeter');
  });

  test("a note record prints the form's screened lists, never the raw note's lines or the AI report", async () => {
    serviceRow = visit(JSON.stringify({ reportNote: { v: 1, text: NOTE_TEXT, source: 'cleaned' }, ...LISTS }));
    const text = await printed(path);
    expect(text).toContain('I treated the perimeter');
    expect(text).toContain('Light ant activity');
    expect(text).toContain('Trim the hedge back from the wall');
    expect(text).not.toContain('Dog loose');
    expect(text).not.toContain('bill the builder');
    expect(text).not.toContain('Sprayed the eaves');
    expect(text).not.toContain('Safe for pets');
    expect(text).not.toContain('Wasp nest');
    expect(text).not.toContain('Seal the soffit');
  });

  test('stored notes that cannot be read count as a note: no merged list and no AI report prints', async () => {
    serviceRow = visit([`[Found] ${RAW_FOUND}`]);
    const text = await printed(path);
    expect(text).not.toContain('Dog loose');
    expect(text).not.toContain('Wasp nest');
    expect(text).not.toContain('Seal the soffit');
  });

  test("a record with no note prints the form's lists too: no raw note line, no AI report", async () => {
    serviceRow = visit(JSON.stringify(LISTS));
    const text = await printed(path);
    expect(text).toContain('Light ant activity');
    expect(text).toContain('Trim the hedge back from the wall');
    expect(text).not.toContain('Dog loose');
    expect(text).not.toContain('bill the builder');
    expect(text).not.toContain('Sprayed the eaves');
    expect(text).not.toContain('Wasp nest');
    expect(text).not.toContain('Seal the soffit');
    // The complete screen runs on every record: "Safe for pets" never prints.
    expect(text).not.toContain('Safe for pets');
  });

  test('a record with no note and no form lists prints no list, never the merged ones', async () => {
    serviceRow = visit(JSON.stringify({ observations: LISTS.observations, recommendations: LISTS.recommendations }));
    const text = await printed(path);
    expect(text).not.toContain('Light ant activity');
    expect(text).not.toContain('Dog loose');
    expect(text).not.toContain('bill the builder');
    expect(text).not.toContain('Wasp nest');
    expect(text).not.toContain("What I Noticed");
    expect(text).not.toContain('What We Recommend');
  });

  test('a form value that holds an access code drops, on every record', async () => {
    // The second value only the completion access-code check catches
    // (withoutAccessCodeLines); the complete screen catches the first too.
    serviceRow = visit(JSON.stringify({ ...LISTS, formRecommendations: ['Trim the hedge back from the wall', 'Gate code 4545 for next time', 'Side access 4417 for the yard'] }));
    const text = await printed(path);
    expect(text).toContain('Trim the hedge back from the wall');
    expect(text).not.toContain('4545');
    expect(text).not.toContain('4417');
  });

  test('a recommendation the complete screen refuses never prints, on a record with no note too', async () => {
    // A value stored before completion screened the list: the web payload
    // drops it (customerCopyViolations), and so does the PDF.
    serviceRow = visit(JSON.stringify({ ...LISTS, formRecommendations: ['Trim the hedge back from the wall', 'Toxic residue on the sill'] }));
    const text = await printed(path);
    expect(text).toContain('Trim the hedge back from the wall');
    expect(text).not.toContain('Toxic residue');
  });
});
