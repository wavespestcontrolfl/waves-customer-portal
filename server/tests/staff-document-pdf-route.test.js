const express = require('express');
const { etDateString, etParts, parseETDateTime } = require('../utils/datetime-et');
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/staff-documents', () => ({ detail: jest.fn(), preview: jest.fn() }));
jest.mock('../services/pdf/staff-document-pdf', () => ({ renderStaffDocumentPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-QA')) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.techRole = 'admin'; req.technicianId = '00000000-0000-4000-8000-000000000001'; next(); },
  requireTechOrAdmin: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
}));
const documents = require('../services/staff-documents');
const { renderStaffDocumentPdf } = require('../services/pdf/staff-document-pdf');
const app = express(); app.use('/documents', require('../routes/tech-staff-documents'));
const id = '00000000-0000-4000-8000-000000000002';
const version = '00000000-0000-4000-8000-000000000003';
const previewHash = 'a'.repeat(64);
let server; let origin; let effective;
const previous = process.env.GATE_CONTROLLED_STAFF_DOCUMENTS;
beforeAll(async () => {
  process.env.GATE_CONTROLLED_STAFF_DOCUMENTS = 'true';
  const date = new Date(Date.now() + 3600000); const parts = etParts(date);
  effective = `${etDateString(date)}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  server = require('node:http').createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/documents/${id}/pdf`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  if (previous === undefined) delete process.env.GATE_CONTROLLED_STAFF_DOCUMENTS; else process.env.GATE_CONTROLLED_STAFF_DOCUMENTS = previous;
});
beforeEach(() => {
  jest.clearAllMocks();
  documents.detail.mockResolvedValue({ version: { id: version, content_hash: null }, rendered: { body: 'Current values' }, acknowledgments: [], records: [] });
  documents.preview.mockResolvedValue({ rendered: { body: 'Future reviewed values' }, preview_hash: previewHash, effective_at: parseETDateTime(effective).toISOString() });
});
const query = () => new URLSearchParams({ version, effective_at: effective, preview_hash: previewHash });
test('a draft PDF renders the exact preview for the selected Eastern effective time', async () => {
  const response = await fetch(`${origin}?${query()}`);
  expect(response.status).toBe(200);
  expect(documents.preview).toHaveBeenCalledWith(id, version, parseETDateTime(effective), expect.objectContaining({ role: 'admin' }));
  expect(renderStaffDocumentPdf).toHaveBeenCalledWith(expect.objectContaining({ rendered: { body: 'Future reviewed values' }, preview_effective_at: parseETDateTime(effective).toISOString() }), expect.any(Object));
});
test('a stale draft preview cannot silently export different policy wording', async () => {
  documents.preview.mockResolvedValue({ rendered: { body: 'Changed values' }, preview_hash: 'b'.repeat(64) });
  expect((await fetch(`${origin}?${query()}`)).status).toBe(409);
  expect(renderStaffDocumentPdf).not.toHaveBeenCalled();
});
test('draft export requires an effective time and reviewed preview', async () => {
  expect((await fetch(`${origin}?version=${version}`)).status).toBe(400);
  expect(renderStaffDocumentPdf).not.toHaveBeenCalled();
});
test('issued exports retain their immutable snapshot regardless of draft preview parameters', async () => {
  documents.detail.mockResolvedValue({ version: { id: version, content_hash: 'issued' }, rendered: { body: 'Issued wording' }, acknowledgments: [], records: [] });
  expect((await fetch(`${origin}?${query()}`)).status).toBe(200);
  expect(documents.preview).not.toHaveBeenCalled();
  expect(renderStaffDocumentPdf).toHaveBeenCalledWith(expect.objectContaining({ rendered: { body: 'Issued wording' } }), expect.any(Object));
});
