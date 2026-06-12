process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    req.technician = { id: 'admin-1', role: 'admin', email: 'owner@example.com' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  newsletterGroupId: jest.fn(() => 101),
  unsubscribeUrl: jest.fn((token) => `https://example.com/unsubscribe/${token}`),
  sendOne: jest.fn(),
}));
jest.mock('../services/newsletter-sender', () => ({}));
jest.mock('../services/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const adminNewsletterRouter = require('../routes/admin-newsletter');

const EVENT_UUID = '2b0fcf1c-2a8e-4d3e-9b5a-1f2e3d4c5b6a';

function draftRow(eventIds) {
  return {
    id: 'send-1',
    status: 'draft',
    subject: 'Existing subject',
    subject_b: null,
    html_body: '<p>Hello</p>',
    text_body: 'Hello',
    preview_text: 'Preview',
    from_name: 'Waves',
    from_email: 'newsletter@wavespestcontrol.com',
    reply_to: 'contact@wavespestcontrol.com',
    segment_filter: null,
    ai_prompt: null,
    newsletter_type: 'local-weekly-fresh-events',
    auto_share_social: true,
    event_ids: eventIds,
  };
}

function mockSendsTable(row) {
  const update = jest.fn(async () => 1);
  db.mockImplementation((table) => {
    if (table !== 'newsletter_sends') throw new Error(`Unexpected table ${table}`);
    const q = {};
    ['where', 'orderBy', 'limit', 'offset', 'select'].forEach((method) => {
      q[method] = jest.fn(() => q);
    });
    q.first = jest.fn(async () => row);
    q.update = update;
    return q;
  });
  return update;
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/newsletter', adminNewsletterRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function patchSend(baseUrl, body) {
  const res = await fetch(`${baseUrl}/admin/newsletter/sends/send-1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

// jsonb readback regression: knex returns event_ids as a parsed JS array, and
// node-pg encodes a raw JS array as a Postgres array literal ('{a,b}'), which
// is invalid jsonb input. The PATCH route must therefore never pass the stored
// array through to update() unserialized — non-empty sets 500ed every UI save
// of an autopilot draft, and empty ones silently corrupted '[]' into '{}'.
describe('PATCH /sends/:id event_ids preservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('re-serializes a stored jsonb array when the client omits eventIds', async () => {
    const update = mockSendsTable(draftRow([EVENT_UUID]));
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { subject: 'New subject' });
      expect(res.status).toBe(200);
    });
    expect(update).toHaveBeenCalledTimes(1);
    const payload = update.mock.calls[0][0];
    expect(typeof payload.event_ids).toBe('string');
    expect(payload.event_ids).toBe(JSON.stringify([EVENT_UUID]));
  });

  test('re-serializes an empty stored array instead of letting it corrupt to {}', async () => {
    const update = mockSendsTable(draftRow([]));
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { subject: 'New subject' });
      expect(res.status).toBe(200);
    });
    const payload = update.mock.calls[0][0];
    expect(payload.event_ids).toBe('[]');
  });

  test('passes through a stored string value verbatim', async () => {
    const stored = JSON.stringify([EVENT_UUID]);
    const update = mockSendsTable(draftRow(stored));
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { subject: 'New subject' });
      expect(res.status).toBe(200);
    });
    const payload = update.mock.calls[0][0];
    expect(payload.event_ids).toBe(stored);
  });

  test('client-supplied eventIds are still validated and stringified', async () => {
    const update = mockSendsTable(draftRow([EVENT_UUID]));
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, {
        subject: 'New subject',
        eventIds: [EVENT_UUID, 'not-a-uuid'],
      });
      expect(res.status).toBe(200);
    });
    const payload = update.mock.calls[0][0];
    expect(payload.event_ids).toBe(JSON.stringify([EVENT_UUID]));
  });
});
