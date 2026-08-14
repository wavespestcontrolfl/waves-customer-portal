/**
 * DELETE /:id — draft delete vs the one-tap purchase ledger.
 *
 * one_tap_purchases FKs estimates with default NO ACTION, so the advertised
 * draft-delete died on 23503 (→ 500) for any estimate an initiated one-tap
 * attempt referenced (GH #3395 r5 P2). Contract: non-completed ledger rows
 * are removed inside the delete transaction; a completed row (consent
 * artifact) refuses the delete with a 400 instead of ever being destroyed.
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
jest.mock('../services/slot-reservation', () => ({
  releaseReservation: jest.fn(async () => ({ released: true })),
}));

const express = require('express');
const slotReservation = require('../services/slot-reservation');
const db = require('../models/db');
const router = require('../routes/admin-estimates');

// Table-aware recording builders: db('estimates') answers the draft row,
// db('one_tap_purchases') answers the configured ledger rows; the
// transaction replays the same table map and records deletes.
function makeTableDb({ estimate, oneTapRows = [], holdRows = [] }) {
  const calls = { deleted: [], updated: [] };
  const builderFor = (table) => {
    const b = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereNotIn', 'select', 'orderBy', 'limit']) {
      b[m] = jest.fn((...args) => {
        if (typeof args[0] === 'function') args[0].call(b, b);
        return b;
      });
    }
    b.first = jest.fn(async () => (table === 'estimates' ? estimate : undefined));
    const listFor = { one_tap_purchases: oneTapRows, scheduled_services: holdRows };
    b.then = (resolve, reject) => Promise.resolve(listFor[table] || []).then(resolve, reject);
    b.update = jest.fn(async (patch) => { calls.updated.push({ table, patch }); return 1; });
    b.del = jest.fn(async () => { calls.deleted.push(table); return 1; });
    return b;
  };
  db.mockImplementation((table) => builderFor(table));
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => builderFor(table);
    trx.fn = db.fn;
    trx.raw = db.raw;
    return fn(trx);
  });
  return calls;
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

describe('standard send is blocked on one-tap drafts (GH #3395 r12 P2)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('POST /:id/send answers 400 for source=one_tap_purchase — internal flow state, never published', async () => {
    makeTableDb({ estimate: { id: 'est-1', status: 'draft', source: 'one_tap_purchase' } });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/est-1/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sendMethod: 'both' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/one-tap purchase draft/);
    });
  });
});

describe('draft delete with one-tap ledger rows', () => {
  beforeEach(() => jest.clearAllMocks());

  test('removes non-completed ledger rows in the transaction so the estimate delete cannot 23503', async () => {
    const calls = makeTableDb({
      estimate: { id: 'est-1', status: 'draft' },
      oneTapRows: [{ id: 'otp-1', status: 'initiated' }, { id: 'otp-2', status: 'voided' }],
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/est-1`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(calls.deleted).toEqual(expect.arrayContaining(['one_tap_purchases', 'estimates']));
      // The ledger delete lands BEFORE the estimate delete (FK order).
      expect(calls.deleted.indexOf('one_tap_purchases')).toBeLessThan(calls.deleted.indexOf('estimates'));
    });
  });

  test('a completed one-tap ledger row (consent artifact) refuses the delete with 400', async () => {
    const calls = makeTableDb({
      estimate: { id: 'est-1', status: 'draft' },
      oneTapRows: [{ id: 'otp-1', status: 'completed' }],
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/est-1`, { method: 'DELETE' });
      expect(res.status).toBe(400);
      expect(calls.deleted).toEqual([]);
    });
  });

  test('a reserved attempt\'s LIVE hold is released through slot-reservation before the estimate delete (GH r6 P2)', async () => {
    const calls = makeTableDb({
      estimate: { id: 'est-1', status: 'draft' },
      oneTapRows: [{ id: 'otp-1', status: 'reserved' }],
      holdRows: [{ id: 'ss-hold-1' }],
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/est-1`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(slotReservation.releaseReservation).toHaveBeenCalledWith({
        scheduledServiceId: 'ss-hold-1', estimateId: 'est-1',
      });
      expect(calls.deleted).toEqual(expect.arrayContaining(['one_tap_purchases', 'estimates']));
    });
  });

  test('an estimate with no ledger rows deletes without touching one_tap_purchases', async () => {
    const calls = makeTableDb({ estimate: { id: 'est-1', status: 'draft' }, oneTapRows: [] });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/est-1`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(calls.deleted).toEqual(expect.arrayContaining(['estimates']));
      expect(calls.deleted).not.toContain('one_tap_purchases');
    });
  });
});
