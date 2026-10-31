/**
 * Cancelling a scheduled (approved) send clears EVERY proof field, including
 * the proof_refused_at marker the Pest Insider catch-up reads — a cancelled
 * approval must never look like a refused one (codex #5414 round 2 P2).
 * With GATE_NEWSLETTER_AUTO_SEND on, Cancel schedule also skips the week, so the
 * 4:30 AM catch-up cannot proof and queue it again (owner 2026-10-30, A).
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
let scheduledSend;

beforeEach(() => {
  updates.length = 0;
  // Approved by an APPROVED reply (it carries the approving email id).
  scheduledSend = { id: SEND_UUID, status: 'scheduled', proof_approved_at: new Date(), proof_approval_email_id: 'email-9', proof_refused_at: new Date() };
  db.mockImplementation((table) => {
    const q = {};
    ['where', 'whereIn', 'orderBy', 'limit', 'select', 'whereNull', 'whereNotNull'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => (table === 'newsletter_sends' ? scheduledSend : undefined));
    q.update = jest.fn(async (patch) => { updates.push([table, patch]); return 1; });
    return q;
  });
});

afterEach(() => { delete process.env.GATE_NEWSLETTER_AUTO_SEND; });

async function postCancel() {
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
}

test('cancel-schedule clears the refusal marker along with the other proof fields', async () => {
  await postCancel();
  const [, patch] = updates.find(([table]) => table === 'newsletter_sends');
  expect(patch).toMatchObject({ status: 'draft', proof_token: null, proof_sent_at: null, proof_approved_at: null, proof_refused_at: null });
  // Switch off: the week goes back to 'drafted' and waits for a fresh proof.
  expect(updates.find(([table]) => table === 'newsletter_calendar')[1]).toMatchObject({ status: 'drafted' });
});

test('with the auto-send switch on, Cancel schedule skips the week so the catch-up cannot queue it again', async () => {
  process.env.GATE_NEWSLETTER_AUTO_SEND = 'true';
  await postCancel();
  expect(updates.find(([table]) => table === 'newsletter_calendar')[1]).toMatchObject({ status: 'skipped' });
});

test('an issue the switch queued skips its week on cancel even with the switch off now', async () => {
  scheduledSend = { ...scheduledSend, proof_approval_email_id: null };
  await postCancel();
  expect(updates.find(([table]) => table === 'newsletter_calendar')[1]).toMatchObject({ status: 'skipped' });
});
