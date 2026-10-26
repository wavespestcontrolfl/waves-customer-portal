'use strict';

// Signed contracts in the customer portal's Documents tab: GET /api/documents lists each SIGNED customer_contracts row
// (service agreements and the AutoPay authorization under Agreements, other signed forms under Other Paperwork) with a
// customer-scoped download, and GET /api/documents/contract/:id/download streams the executed PDF. Invariants: an open
// (unsigned) contract is never listed and never downloadable (its signing token must not surface here); a contact
// session sees none; another customer's contract, a malformed id and a missing row are the same 404; the count on
// file includes the signed contracts. Synthetic data only.

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
  contactRecordScope: jest.fn(async () => null),
  scopeContactRecords: jest.fn((q) => q),
}));
jest.mock('../models/db', () => jest.fn());

const express = require('express');
const db = require('../models/db');
const documentsRouter = require('../routes/documents');

const SIGNED_AGREEMENT = {
  id: '11111111-1111-4111-8111-111111111111', customer_id: 'cust-1', contract_type: 'document_template', status: 'signed',
  title: 'Lawn & Ornamental Service Agreement', service_name: 'Lawn Care, quarterly', signed_at: '2026-10-20T15:00:00.000Z', created_at: '2026-10-19T15:00:00.000Z',
  document_template_document_type: 'service_agreement', signed_name: 'Pat Owner', recipient_initials: 'PO',
  contract_text_snapshot: 'Lawn agreement text', esign_disclosure_snapshot: 'I agree to sign electronically.',
  document_template_requires_signature: true, requires_signature_snapshot: true,
};
const SIGNED_AUTOPAY = {
  id: '22222222-2222-4222-8222-222222222222', customer_id: 'cust-1', contract_type: 'autopay_authorization', status: 'signed',
  title: 'AutoPay Authorization', service_name: null, signed_at: '2026-09-01T15:00:00.000Z', created_at: '2026-09-01T14:00:00.000Z', document_template_document_type: null,
};
const SIGNED_NOTICE = {
  id: '33333333-3333-4333-8333-333333333333', customer_id: 'cust-1', contract_type: 'document_template', status: 'signed',
  title: 'Consumer Notice Form (FDACS-13692)', service_name: null, signed_at: '2026-08-01T15:00:00.000Z', created_at: '2026-08-01T14:00:00.000Z', document_template_document_type: 'notice',
};

// The signed-contract query is `where({ 'cc.customer_id', 'cc.status': 'signed' })` then an optional `where('cc.id', id)`.
let contracts;
function wire() {
  db.mockImplementation((table) => {
    const q = {};
    const filters = {};
    for (const m of ['whereIn', 'whereNull', 'whereNot', 'orWhereNot', 'whereNotNull', 'orWhere', 'leftJoin', 'select', 'orderBy', 'orderByRaw', 'limit', 'offset', 'whereRaw']) q[m] = () => q;
    q.where = (a, b) => { if (typeof a === 'object') Object.assign(filters, a); else if (b !== undefined) filters[a] = b; return q; };
    const rows = () => {
      if (!String(table).startsWith('customer_contracts')) return [];
      return contracts.filter((c) => c.customer_id === filters['cc.customer_id'] && c.status === filters['cc.status'] && (filters['cc.id'] === undefined || c.id === filters['cc.id']));
    };
    q.count = () => ({ then: (resolve, reject) => Promise.resolve([{ count: String(rows().length) }]).then(resolve, reject) });
    q.columnInfo = async () => ({});
    q.first = async () => (table === 'customers' ? { first_name: 'Pat', last_name: 'Owner', company_name: null } : rows()[0] || null);
    q.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
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
beforeEach(() => {
  jest.clearAllMocks();
  mockSession.contact = null;
  contracts = [SIGNED_AGREEMENT, SIGNED_AUTOPAY, SIGNED_NOTICE, { ...SIGNED_AGREEMENT, id: '44444444-4444-4444-8444-444444444444', status: 'viewed', signed_at: null }];
  wire();
});

const list = async () => (await fetch(`${base}/api/documents`)).json();

describe('GET /api/documents lists signed contracts', () => {
  test('the holder sees each signed contract once, filed by kind, with a customer-scoped download and no share', async () => {
    const body = await list();
    const agreements = body.documents.service_agreement || [];
    expect(agreements.map((d) => d.id)).toEqual([`contract_${SIGNED_AGREEMENT.id}`, `contract_${SIGNED_AUTOPAY.id}`]);
    expect(agreements[0]).toMatchObject({
      title: 'Lawn & Ornamental Service Agreement',
      description: 'Signed October 20, 2026 · Lawn Care, quarterly',
      fileName: 'Lawn_Ornamental_Service_Agreement_2026-10-20.pdf',
      downloadUrl: `/api/documents/contract/${SIGNED_AGREEMENT.id}/download`,
      isAutoGenerated: true,
      isSignedContract: true,
      shareable: false,
    });
    expect(agreements[0]).not.toHaveProperty('viewUrl');
    expect((body.documents.other || []).map((d) => d.id)).toEqual([`contract_${SIGNED_NOTICE.id}`]);
    // The open (viewed) agreement is nowhere on the page, and nothing carries a signing token.
    expect(JSON.stringify(body)).not.toContain('44444444-4444-4444-8444-444444444444');
    // No signing link or token (the public signing URL is /contract/<token>; the download URL here is under /api/documents/).
    expect(JSON.stringify(body)).not.toMatch(/share_token|signingUrl|"\/contract\//);
    expect(body.total).toBe(3);
  });

  test('a contact session lists no contracts', async () => {
    mockSession.contact = { id: 'contact-1' };
    const body = await list();
    expect(body.documents.service_agreement).toBeUndefined();
    expect(body.documents.other).toBeUndefined();
  });
});

describe('GET /api/documents/contract/:id/download', () => {
  test('streams the executed PDF of the holder\'s signed contract, never cached', async () => {
    const res = await fetch(`${base}/api/documents/contract/${SIGNED_AGREEMENT.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(800);
  });

  test.each([
    ['an open (unsigned) contract', '44444444-4444-4444-8444-444444444444'],
    ['another customer\'s contract', '55555555-5555-4555-8555-555555555555'],
    ['a malformed id', 'contract-1'],
  ])('%s is a 404', async (_label, id) => {
    contracts.push({ ...SIGNED_AGREEMENT, id: '55555555-5555-4555-8555-555555555555', customer_id: 'cust-2' });
    const res = await fetch(`${base}/api/documents/contract/${id}/download`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Document not found' });
  });

  test('a contact session is a 404', async () => {
    mockSession.contact = { id: 'contact-1' };
    const res = await fetch(`${base}/api/documents/contract/${SIGNED_AGREEMENT.id}/download`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/documents/share/:id', () => {
  test('a signed contract never gets a public share link', async () => {
    const res = await fetch(`${base}/api/documents/share/contract_${SIGNED_AGREEMENT.id}`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Document not found' });
  });
});
