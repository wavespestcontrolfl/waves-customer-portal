/**
 * POST /:id/send with scheduledAt — atomic schedule claim.
 *
 * Scheduling used to write status='scheduled' unconditionally after a
 * non-atomic sendable check on a stale read. That clobbered:
 *   - an in-flight 'sending' row (its guarded sent-write then missed and
 *     the cron re-sent → duplicate customer texts), and
 *   - a concurrent accept (money-bearing 'accepted' state overwritten,
 *     re-entering the send pipeline on a committed conversion).
 *
 * Contract: the schedule write carries the same claim filters as the
 * immediate-send path — whereNull(price_locked_at) +
 * whereNotIn(status, sending/accepted/declined/expired) — and 409s when
 * the claim misses.
 */
jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(async () => 'SMS') }));
jest.mock('../services/estimate-lead-linkage', () => ({ leadIdForEstimate: jest.fn(async () => null) }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn(() => false),
  estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
  commercialRiskTypeReviewNeeded: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(),
  buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(),
  saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({
  createOrReuseAdminEstimate: jest.fn(),
  estimateExpiresAt: jest.fn(() => new Date('2026-08-04T00:00:00.000Z')),
  estimateViewUrl: jest.fn((token) => `https://portal.wavespestcontrol.com/estimate/${token}`),
}));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(),
  buildPricingBundle: jest.fn(async () => ({})),
  bookingServiceFor: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true) }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-estimates');

function estimateRow(overrides = {}) {
  return {
    id: 'est-1',
    token: 'tok-1',
    status: 'draft',
    customer_name: 'Dana Reyes',
    customer_phone: '+19415550101',
    customer_email: 'dana@example.com',
    monthly_total: '89',
    estimate_data: null,
    ...overrides,
  };
}

// Recording builder: .first() resolves the row; .update() resolves the
// configured claim count; grouped callbacks replay against the recorder.
function makeBuilder(row, { updateResult = 1 } = {}) {
  const b = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNotIn', 'whereNotNull', 'select', 'orderBy', 'limit']) {
    b[m] = jest.fn((...args) => {
      if (typeof args[0] === 'function') args[0].call(b, b);
      return b;
    });
  }
  b.first = jest.fn(async () => row);
  b.update = jest.fn(async () => updateResult);
  return b;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/estimates', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe('schedule-send atomic claim', () => {
  beforeEach(() => jest.clearAllMocks());

  test('schedules through the claim filters when the row is claimable', async () => {
    const builder = makeBuilder(estimateRow(), { updateResult: 1 });
    db.mockImplementation(() => builder);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/est-1/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sendMethod: 'both', scheduledAt: FUTURE }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scheduled).toBe(true);

      // The claim carries the same filters as the immediate-send path.
      expect(builder.whereNull).toHaveBeenCalledWith('price_locked_at');
      expect(builder.whereNotIn).toHaveBeenCalledWith('status', ['sending', 'accepted', 'declined', 'expired']);
      expect(builder.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'scheduled',
        scheduled_send_attempts: 0,
      }));
    });
  });

  test('409s when the claim misses (row mid-send, accepted, or price-locked)', async () => {
    const builder = makeBuilder(estimateRow({ status: 'sent' }), { updateResult: 0 });
    db.mockImplementation(() => builder);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/est-1/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sendMethod: 'both', scheduledAt: FUTURE }),
      });
      expect(res.status).toBe(409);
      expect(builder.update).toHaveBeenCalledTimes(1); // no unconditional second write
    });
  });
});
