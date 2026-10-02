/**
 * Cancelling a scheduled (approved) send clears EVERY proof field, including
 * the proof_refused_at marker the Pest Insider catch-up reads — a cancelled
 * approval must never look like a refused one (codex #5414 round 2 P2).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { id: 'admin-1', role: 'admin' }; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), newsletterGroupId: jest.fn(() => 101), unsubscribeUrl: jest.fn(), sendOne: jest.fn() }));
jest.mock('../services/newsletter-sender', () => ({ sendCampaign: jest.fn(), countSegmentRecipients: jest.fn(async () => 25) }));
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
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({})) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => 'audit-1') }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-newsletter');

const SEND_UUID = '11111111-2222-4333-8444-555555555555';
const updates = [];

beforeEach(() => {
  updates.length = 0;
  db.mockImplementation((table) => {
    const q = {};
    ['where', 'whereIn', 'orderBy', 'limit', 'select', 'whereNull', 'whereNotNull'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => (table === 'newsletter_sends'
      ? { id: SEND_UUID, status: 'scheduled', proof_approved_at: new Date(), proof_approval_email_id: 'email-9', proof_refused_at: new Date() }
      : undefined));
    q.update = jest.fn(async (patch) => { updates.push([table, patch]); return 1; });
    return q;
  });
});

test('cancel-schedule clears the refusal marker along with the other proof fields', async () => {
  const app = express();
  app.use(express.json());
  app.use('/admin/newsletter', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/newsletter/sends/${SEND_UUID}/cancel-schedule`, { method: 'POST' });
    expect(res.status).toBe(200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const [, patch] = updates.find(([table]) => table === 'newsletter_sends');
  expect(patch).toMatchObject({ status: 'draft', proof_token: null, proof_sent_at: null, proof_approved_at: null, proof_refused_at: null });
});
