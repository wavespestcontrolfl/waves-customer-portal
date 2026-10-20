'use strict';

// GET /api/documents for a contact session (GATE_CONTACT_LOGIN), codex #6363
// r4 P1 + P2: every completed visit's report is listed (a holder's linked
// stored copy does not hide it) and reached ONLY through the authenticated,
// contact-safe PDF route — never the public /report or /api/reports bearers,
// whose pages render the holder's identity — and project reports (public
// bearer only; holder name, email, phone, pay link) are not listed at all.
// The holder's list is unchanged.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockSession = { contact: null };
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Owner', contact_role: null };
    if (mockSession.contact) req.contactSession = mockSession.contact;
    next();
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/photos', () => ({ CUSTOMER_DWELL_TTL_SECONDS: 86400, getViewUrl: jest.fn(async () => 'https://cdn/p'), getDownloadUrl: jest.fn() }));
jest.mock('../services/contact-session-projection', () => ({
  ...jest.requireActual('../services/contact-session-projection'),
  contactSessionReportsWithheld: jest.fn(async () => false),
}));
jest.mock('../models/db', () => jest.fn());

const express = require('express');
const db = require('../models/db');
const documentsRouter = require('../routes/documents');

const SERVICES = [
  { id: 'svc-1', service_date: '2026-10-01', service_type: 'Pest Control', report_view_token: 'tok-1', report_template_version: 'service_report_v1', structured_notes: null, technician_name: 'Adam' },
  { id: 'svc-2', service_date: '2026-09-01', service_type: 'Lawn Care', report_view_token: 'tok-2', report_template_version: null, structured_notes: null, technician_name: 'Adam' },
];
// The holder's stored copy of svc-2's report.
const STORED = [{ id: 'doc-1', document_type: 'service_report', title: 'Visit Report', file_name: 'r.pdf', file_size_bytes: 10, uploaded_by: 'admin', linked_service_record_id: 'svc-2', created_at: '2026-09-02', s3_key: 'k', storage_key: 'k' }];
const PROJECTS = [{ id: 'proj-1', project_type: 'termite_treatment', status: 'sent', report_token: 'ptok', sent_at: '2026-08-01', created_at: '2026-07-01', title: 'Termite Treatment' }];

function wire() {
  db.mockImplementation((table) => {
    const rows = table === 'service_records' ? SERVICES
      : table === 'customer_documents' ? STORED
      : table.startsWith('projects') ? PROJECTS
      : [];
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'orWhereNot', 'whereNotNull', 'orWhere', 'leftJoin', 'select', 'orderBy', 'orderByRaw', 'limit', 'offset']) q[m] = () => q;
    q.count = () => ({ then: (resolve, reject) => Promise.resolve([{ count: String(rows.length) }]).then(resolve, reject) });
    q.columnInfo = async () => ({});
    q.first = async () => rows[0] || null;
    q.catch = () => q;
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return q;
  });
  db.raw = (s) => s;
}

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use('/api/documents', documentsRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { jest.clearAllMocks(); mockSession.contact = null; wire(); });

const list = async () => (await fetch(`${base}/api/documents`)).json();

test('the holder lists the stored copy, the public report links and the project report, as before', async () => {
  const body = await list();
  const reports = body.documents.service_report;
  expect(reports.map((d) => d.id)).toEqual(['doc-1', 'auto_report_svc-1', 'project_proj-1']);
  expect(reports[1]).toMatchObject({ viewUrl: '/report/tok-1', reportToken: 'tok-1', pdfUrl: '/api/reports/tok-1' });
  expect(body.total).toBe(1 + 2 + 1);
});

test('a contact lists every visit report through the authenticated PDF only — no public bearer, no stored copy, no project report', async () => {
  mockSession.contact = { slot: 1, name: 'Sam', phone: '+19415550202', contactRole: '', phoneKey: '9415550202' };
  const body = await list();
  expect(Object.keys(body.documents)).toEqual(['service_report']);
  const reports = body.documents.service_report;
  expect(reports.map((d) => d.id)).toEqual(['auto_report_svc-1', 'auto_report_svc-2']);
  for (const d of reports) {
    expect(d).toMatchObject({ viewUrl: null, reportToken: null, pdfUrl: `/api/documents/service-report/${d.linkedServiceRecordId}`, downloadUrl: `/api/documents/service-report/${d.linkedServiceRecordId}` });
  }
  expect(JSON.stringify(body)).not.toMatch(/tok-1|tok-2|ptok|\/report\//);
  expect(body.total).toBe(2);
});
