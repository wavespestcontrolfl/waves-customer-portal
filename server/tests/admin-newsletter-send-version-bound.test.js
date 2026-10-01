/**
 * POST /sends/:id/send binds the background dispatch claim to the exact row
 * version the handler validated (status, updated_at, approval), the same
 * way the scheduler tick does — an edit that lands between validation and
 * the claim leaves the claim empty instead of broadcasting content nobody
 * validated (codex round 7 P1 on #5187).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockSendCampaign = jest.fn(async () => ({ ok: true }));
const mockCount = jest.fn(async () => 25);

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
jest.mock('../services/newsletter-sender', () => ({
  sendCampaign: mockSendCampaign,
  countSegmentRecipients: mockCount,
}));
jest.mock('../services/newsletter-event-selection', () => ({
  validateFlagshipEventSelection: jest.fn(async () => ({ valid: true, errors: [], flagship: false, events: [] })),
  parseLockedEventIds: jest.fn(() => []),
}));
jest.mock('../services/newsletter-validator', () => ({
  validateNewsletterDraft: jest.fn(() => ({ errors: [], warnings: [] })),
  lockedPricesForSend: jest.fn(async () => []),
  findHallucinatedClaims: jest.fn(() => []),
}));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
const mockTrigger = jest.fn(async () => ({ bellWritten: true }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: mockTrigger }));
const mockAudit = jest.fn(async () => 'audit-1');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: mockAudit }));

const express = require('express');
const db = require('../models/db');
const adminNewsletterRouter = require('../routes/admin-newsletter');

const SEND_UUID = '11111111-2222-4333-8444-555555555555';
const UPDATED_AT = new Date('2026-10-06T14:00:00Z');
const DRAFT = {
  id: SEND_UUID, status: 'draft', subject: 'Pest Insider — October', subject_b: null, html_body: '<p>Hello</p>', text_body: 'Hello',
  preview_text: 'Preview', from_name: 'Waves', from_email: 'newsletter@wavespestcontrol.com', reply_to: 'contact@wavespestcontrol.com',
  segment_filter: null, newsletter_type: 'pest-insider-monthly', event_ids: [], updated_at: UPDATED_AT, proof_approved_at: null,
};

function mockDb(row) {
  db.mockImplementation((table) => {
    const q = {};
    ['where', 'whereIn', 'orderBy', 'limit', 'offset', 'select', 'whereNull', 'whereNotNull'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => (table === 'newsletter_sends' ? row : undefined));
    q.update = jest.fn(async () => 1);
    q.count = jest.fn(() => ({ first: jest.fn(async () => ({ c: 25 })) }));
    q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return q;
  });
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/newsletter', adminNewsletterRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => { jest.clearAllMocks(); });

test('the manual send hands sendCampaign the validated version to claim against', async () => {
  mockDb(DRAFT);
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/admin/newsletter/sends/${SEND_UUID}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect([200, 202]).toContain(res.status);
  });
  expect(mockSendCampaign).toHaveBeenCalledTimes(1);
  expect(mockSendCampaign).toHaveBeenCalledWith(SEND_UUID, expect.objectContaining({
    expect: { status: 'draft', updatedAt: UPDATED_AT, proofApprovedAt: null },
  }));
});

test('a VERSION_CHANGED claim from the background send is a benign no-op (no failed flip)', async () => {
  mockDb(DRAFT);
  const err = new Error('row changed'); err.code = 'VERSION_CHANGED';
  mockSendCampaign.mockRejectedValueOnce(err);
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/admin/newsletter/sends/${SEND_UUID}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect([200, 202]).toContain(res.status);
  });
  await new Promise((r) => setTimeout(r, 20));
  const updates = db.mock.results.flatMap((r) => r.value?.update?.mock?.calls || []);
  expect(updates.some((c) => c[0]?.status === 'failed')).toBe(false);
  // …but the operator is told the send did not happen (the route already answered 202).
  expect(mockTrigger).toHaveBeenCalledWith('newsletter_send_not_dispatched', expect.objectContaining({ sendId: SEND_UUID, subject: DRAFT.subject }));
});

// Codex round 11: triggerNotification can resolve without delivering
// anything; the route checks the result and leaves a durable signal.
async function sendThatChanged() {
  mockDb(DRAFT);
  const err = new Error('row changed'); err.code = 'VERSION_CHANGED';
  mockSendCampaign.mockRejectedValueOnce(err);
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/admin/newsletter/sends/${SEND_UUID}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect([200, 202]).toContain(res.status);
  });
  await new Promise((r) => setTimeout(r, 20));
}

test('a not-dispatched notice that resolved but reached nobody writes a critical audit event', async () => {
  mockTrigger.mockResolvedValueOnce({ bellWritten: false, push: null });
  await sendThatChanged();
  expect(mockAudit).toHaveBeenCalledTimes(1);
  expect(mockAudit).toHaveBeenCalledWith({
    actor_type: 'system',
    action: 'newsletter.send_not_dispatched_unnotified',
    resource_type: 'newsletter_send',
    resource_id: SEND_UUID,
    metadata: { subject: DRAFT.subject },
    critical: true,
  });
});

test('a not-dispatched notice that threw writes the audit event too', async () => {
  mockTrigger.mockRejectedValueOnce(new Error('bell table down'));
  await sendThatChanged();
  expect(mockAudit).toHaveBeenCalledTimes(1);
});

test('a delivered not-dispatched notice (bell row, or a push that reached a device) writes no audit event', async () => {
  mockTrigger.mockResolvedValueOnce({ bellWritten: true, push: null });
  await sendThatChanged();
  mockTrigger.mockResolvedValueOnce({ bellWritten: false, push: { sent: 1 } });
  await sendThatChanged();
  expect(mockAudit).not.toHaveBeenCalled();
});
