// POST /api/admin/document-templates/:key/preview — the editor's Preview.
// It renders the draft the editor sends (unsaved edits included) and falls
// back to the active saved version without one. It writes nothing.
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (_q, _s, n) => n(), requireAdmin: (_q, _s, n) => n() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn() }));
jest.mock('../services/new-construction-warranty', () => ({}));
jest.mock('../services/document-template-bulk-send', () => ({}));

let mockTemplateRow = null;
const mockWrites = [];
jest.mock('../models/db', () => {
  const builder = () => {
    const b = {};
    for (const m of ['whereNot', 'leftJoin', 'select', 'where']) b[m] = jest.fn(() => b);
    b.first = jest.fn(async () => mockTemplateRow);
    b.insert = jest.fn(async (row) => { mockWrites.push(row); return [row]; });
    b.update = jest.fn(async (row) => { mockWrites.push(row); return 1; });
    return b;
  };
  const fn = jest.fn(() => builder());
  fn.transaction = jest.fn();
  return fn;
});

const express = require('express');
const router = require('../routes/admin-document-templates');

const TEMPLATE = {
  id: 't1',
  template_key: 'service_agreement.lawn_ornamental',
  name: 'Lawn Agreement',
  status: 'active',
  active_version__id: 'v1',
  active_version__version_number: 1,
  active_version__title: 'Lawn Agreement',
  active_version__body: 'Saved terms for {{customer.name}}',
};

async function preview(body) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/document-templates', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/document-templates/${TEMPLATE.template_key}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  mockTemplateRow = { ...TEMPLATE };
  mockWrites.length = 0;
});

test('renders the draft the editor sends, not the saved version, and writes nothing', async () => {
  const { status, body } = await preview({
    context: { customer: { name: 'Jordan' } },
    draft: { title: 'Draft title', body: 'New clause for {{customer.name}} on {{agreement.start_date}}' },
  });
  expect(status).toBe(200);
  expect(body.rendered).toMatchObject({
    title: 'Draft title',
    body: 'New clause for Jordan on {{agreement.start_date}}',
    unresolvedVariables: ['agreement.start_date'],
  });
  expect(body.rendered.body).not.toContain('Saved terms');
  // A draft is not a saved version: the summary names no version.
  expect(body.rendered.renderSummary).toMatchObject({ templateVersionId: null, versionNumber: null });
  expect(mockWrites).toEqual([]);
});

test('without a draft it renders the active saved version', async () => {
  const { status, body } = await preview({ context: { customer: { name: 'Jordan' } } });
  expect(status).toBe(200);
  expect(body.rendered).toMatchObject({ title: 'Lawn Agreement', body: 'Saved terms for Jordan' });
});

test('a draft previews even before a version is published; no draft and no version stays a 409', async () => {
  mockTemplateRow = { ...TEMPLATE, active_version__id: null };
  expect((await preview({ draft: { title: 'First draft', body: 'Body' } })).body.rendered).toMatchObject({ title: 'First draft', body: 'Body' });
  expect((await preview({})).status).toBe(409);
});
