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
jest.mock('../services/newsletter-sender', () => ({ hasOutstandingDeliveries: jest.fn(async () => false) }));
jest.mock('../services/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const NewsletterSender = require('../services/newsletter-sender');
const adminNewsletterRouter = require('../routes/admin-newsletter');

const EVENT_UUID = '2b0fcf1c-2a8e-4d3e-9b5a-1f2e3d4c5b6a';
const SEND_UUID = '11111111-2222-4333-8444-555555555555';

function draftRow(eventIds) {
  return {
    id: SEND_UUID,
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
    if (table === 'events_raw') {
      // Occurrence snapshot read (snapshotEventOccurrences) on eventIds saves.
      const e = {};
      e.whereIn = jest.fn(() => e);
      e.select = jest.fn(async () => [{ id: EVENT_UUID, start_at: new Date('2026-10-10T22:00:00Z') }]);
      return e;
    }
    if (table !== 'newsletter_sends') throw new Error(`Unexpected table ${table}`);
    const q = {};
    ['where', 'whereIn', 'orderBy', 'limit', 'offset', 'select'].forEach((method) => {
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
  const res = await fetch(`${baseUrl}/admin/newsletter/sends/${SEND_UUID}`, {
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
    // The occurrence snapshot is saved with the event list.
    expect(JSON.parse(payload.event_occurrences)).toEqual({ [EVENT_UUID]: '2026-10-10T22:00:00.000Z' });
  });
});

// The Pest Insider's proof kill switch and its fact-register claim scan key on
// newsletter_type='pest-insider-monthly' (email division fact register lane).
// A template swap in the composer replaces only the HTML body, so retyping the
// draft would carry its old text body, subject or preview past both gates.
describe('PATCH /sends/:id refuses retyping a Pest Insider draft', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('changing a Pest Insider draft to another type is refused before any write', async () => {
    const update = mockSendsTable({ ...draftRow([]), newsletter_type: 'pest-insider-monthly' });
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { newsletterType: 'local-weekly-fresh-events', subject: 'Retyped' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Pest Insider/);
    });
    expect(update).not.toHaveBeenCalled();
  });

  test('an edit that keeps the Pest Insider type goes through', async () => {
    const update = mockSendsTable({ ...draftRow([]), newsletter_type: 'pest-insider-monthly' });
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { newsletterType: 'pest-insider-monthly', subject: 'Still the Pest Insider' });
      expect(res.status).toBe(200);
    });
    expect(update).toHaveBeenCalledTimes(1);
  });
});


// Codex round 12 on #5187: a partially delivered campaign whose stored copy the
// resume re-validation now rejects is corrected IN PLACE — it keeps its
// publicly readable 'failed'/'sent' state (the web version the first batch
// received stays up) and the next Resume reaches only the ledger's
// outstanding rows. Copy fields only.
describe('PATCH /sends/:id correct-and-resume for a partially delivered campaign', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  // `deliveryRow` stands for "a Resume still has someone to mail": the
  // route asks the sender's outstanding-retryable predicate (codex round 14
  // P2 — a ledger row alone never makes a campaign correctable).
  function mockTables({ send, deliveryRow }) {
    const update = jest.fn(async () => 1);
    const whereIns = [];
    NewsletterSender.hasOutstandingDeliveries.mockResolvedValue(Boolean(deliveryRow));
    db.mockImplementation((table) => {
      const q = {};
      ['where', 'orderBy', 'limit', 'offset', 'select'].forEach((method) => { q[method] = jest.fn(() => q); });
      q.whereIn = jest.fn((...args) => { whereIns.push(args); return q; });
      if (table === 'newsletter_sends') { q.first = jest.fn(async () => send); q.update = update; return q; }
      throw new Error(`Unexpected table ${table}`);
    });
    return { update, whereIns };
  }
  const failedInsider = { ...draftRow([]), status: 'failed', newsletter_type: 'pest-insider-monthly' };

  test('a failed campaign WITH a delivery ledger accepts a copy correction, scoped to its own status and without touching its state', async () => {
    const { update, whereIns } = mockTables({ send: failedInsider, deliveryRow: { id: 'd-1' } });
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { htmlBody: '<p>Corrected</p>', textBody: 'Corrected' });
      expect(res.status).toBe(200);
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(whereIns).toContainEqual(['status', ['failed']]);
    expect(update.mock.calls[0][0]).toMatchObject({ html_body: '<p>Corrected</p>', text_body: 'Corrected' });
    expect(update.mock.calls[0][0].status).toBeUndefined();
  });

  test('a correction is bound to the inspected row version: a Resume that re-finalized the row in between makes the save a 409, not an archive rewrite (codex round 19 P2)', async () => {
    const inspectedAt = new Date('2026-09-28T17:00:00Z');
    const send = { ...failedInsider, status: 'sent', updated_at: inspectedAt };
    const { update } = mockTables({ send, deliveryRow: { id: 'd-1' } });
    const wheres = [];
    const base = db.getMockImplementation();
    db.mockImplementation((table) => {
      const q = base(table);
      const where = q.where;
      q.where = jest.fn((...args) => { wheres.push(args); return where(...args); });
      return q;
    });
    update.mockResolvedValueOnce(0); // the row moved on: same status, later updated_at
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { htmlBody: '<p>Corrected</p>', textBody: 'Corrected' });
      expect(res.status).toBe(409);
    });
    expect(wheres).toContainEqual(['updated_at', '<', new Date(inspectedAt.getTime() + 1)]);
  });

  test('a correction that still carries a blocked claim is refused with the validation errors — the web version never shows it (pre-push audit P1)', async () => {
    const { update } = mockTables({ send: failedInsider, deliveryRow: { id: 'd-1' } });
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, {
        htmlBody: '<p>Termites swarm again after storms.</p>', textBody: 'Termites swarm again after storms.',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errors.some((e) => /termite_second_swarm/.test(e))).toBe(true);
    });
    expect(update).not.toHaveBeenCalled();
  });

  test("adding or removing subject B on a partially delivered campaign is refused — every recipient's variant is fixed (codex round 13 P1)", async () => {
    const { update } = mockTables({ send: failedInsider, deliveryRow: { id: 'd-1' } });
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { subjectB: 'A second subject line' });
      expect(res.status).toBe(400);
    });
    expect(update).not.toHaveBeenCalled();
  });

  test('the composer may send the stored type back unchanged; a changed type is still refused (codex round 13 P2)', async () => {
    const same = mockTables({ send: failedInsider, deliveryRow: { id: 'd-1' } });
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { htmlBody: '<p>Corrected</p>', textBody: 'Corrected', newsletterType: 'pest-insider-monthly', subjectB: null });
      expect(res.status).toBe(200);
    });
    expect(same.update).toHaveBeenCalledTimes(1);
    const changed = mockTables({ send: failedInsider, deliveryRow: { id: 'd-1' } });
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { htmlBody: '<p>Corrected</p>', newsletterType: 'reengagement' });
      expect(res.status).toBe(400);
    });
    expect(changed.update).not.toHaveBeenCalled();
  });

  test('a failed campaign with NO outstanding recipient is still not editable', async () => {
    const { update } = mockTables({ send: failedInsider, deliveryRow: undefined });
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { htmlBody: '<p>Corrected</p>' });
      expect(res.status).toBe(400);
    });
    expect(update).not.toHaveBeenCalled();
  });

  test('a partially delivered campaign cannot change its audience or type — the ledger is the audience', async () => {
    const { update } = mockTables({ send: failedInsider, deliveryRow: { id: 'd-1' } });
    await withServer(async (baseUrl) => {
      const res = await patchSend(baseUrl, { segmentFilter: { tags: ['everyone'] } });
      expect(res.status).toBe(400);
    });
    expect(update).not.toHaveBeenCalled();
  });
});
