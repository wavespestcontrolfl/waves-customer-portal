/**
 * AUDIT REPRO r1-estimates-2 — POST /api/admin/estimates/:id/send-booking-link
 * duplicate-appointment guard.
 *
 * Claim: the guard only reads estimate_data.scheduled_service_id, but every
 * normal booking path links the visit via scheduled_services.source_estimate_id,
 * so an accepted estimate whose customer ALREADY has a live appointment gets
 * a fresh "pick a slot" /book SMS.
 *
 * Written to assert the EXPECTED behaviour (409, no SMS) so it FAILS on
 * current code if the bug is real. Mock/setup pattern copied from
 * tests/admin-estimates-schedule-claim.test.js.
 */
jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  mockDb.transaction = jest.fn(async (cb) => cb(mockDb));
  mockDb.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  return mockDb;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: 'SM-synthetic' })),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async (_key, vars) => `Hi ${vars.first_name}, book here: ${vars.booking_url}`),
}));
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
  estimateEditVersion: jest.fn(() => 'synthetic-edit-version'),
  estimateOfferVersion: jest.fn(() => 'synthetic-offer-version'),
  estimateExpiresAt: jest.fn(() => new Date('2026-08-04T00:00:00.000Z')),
  estimateViewUrl: jest.fn((token) => `https://portal.wavespestcontrol.com/estimate/${token}`),
}));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(() => ({ oneTimeList: [{ name: 'German Roach Treatment' }], recurringList: [] })),
  buildPricingBundle: jest.fn(async () => ({})),
  bookingServiceFor: jest.fn(() => ({ id: 'german-roach', label: 'German Roach Treatment' })),
}));
jest.mock('../utils/estimate-handoff-token', () => ({
  mintEstimateAcceptToken: jest.fn(() => 'synthetic-accept-token'),
  verifyEstimateHandoffToken: jest.fn(() => true),
  mintEstimateHandoffToken: jest.fn(() => 'synthetic-handoff-token'),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
  loadTemplateByKey: jest.fn(async () => ({ template: {}, activeVersion: { id: 'v' } })),
  renderTemplate: jest.fn(() => ({ subject: 's', text: 't' })),
  templateContentHash: jest.fn(() => 'h'),
}));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true) }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-estimates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

const TOMORROW = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

// Accepted one-time estimate. estimate_data carries NO scheduled_service_id —
// the admin "Schedule" button / Create Appointment modal / customer /book all
// link via scheduled_services.source_estimate_id, never this key.
let ESTIMATE_DATA_OVERRIDE = null;
const ESTIMATE = {
  id: 'est-1',
  token: 'tok-1',
  status: 'accepted',
  accepted_at: '2026-09-20T15:00:00.000Z',
  created_at: '2026-09-19T15:00:00.000Z',
  customer_id: 'cust-1',
  customer_name: 'Dana Reyes',
  customer_phone: '+19415550101',
  customer_email: 'dana@example.com',
  monthly_total: '0',
  onetime_total: '295',
  bill_by_invoice: false,
  archived_at: null,
  estimate_data: JSON.stringify({ oneTime: [{ name: 'German Roach Treatment', price: 295 }] }),
};

// The live appointment that every real booking path produces. Mutable
// status per test (LINKED_APPT_STATUS) so a skipped/no-show linked visit
// can be exercised without duplicating the whole fixture.
let LINKED_APPT_STATUS = 'confirmed';
function linkedAppt() {
  return {
    id: 'ss-1',
    customer_id: 'cust-1',
    source_estimate_id: 'est-1',
    status: LINKED_APPT_STATUS,
    scheduled_date: TOMORROW,
    window_start: '09:00',
    service_type: 'German Roach Treatment',
  };
}

const scheduledServicesQueries = [];

function makeBuilder(table) {
  const b = { table, wheres: [] };
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNotIn', 'whereNotNull', 'whereRaw', 'orWhere', 'orWhereIn', 'andWhere', 'whereNot', 'forUpdate', 'select', 'orderBy', 'limit', 'modify']) {
    b[m] = jest.fn((...args) => {
      if (typeof args[0] === 'function') args[0].call(b, b);
      b.wheres.push([m, ...args]);
      return b;
    });
  }
  b.first = jest.fn(async () => {
    if (table === 'estimates') return { ...ESTIMATE, ...(ESTIMATE_DATA_OVERRIDE ? { estimate_data: ESTIMATE_DATA_OVERRIDE } : {}) };
    if (table === 'scheduled_services') {
      scheduledServicesQueries.push(b.wheres.slice());
      // Answer like a real DB: the row matches on source_estimate_id (how
      // it is actually linked) or on its own id, but only when its status
      // isn't excluded by a whereNotIn('status', [...]) on this query.
      const flat = JSON.stringify(b.wheres);
      const bySource = b.wheres.some(([m, a]) => m === 'where' && a && typeof a === 'object' && String(a.source_estimate_id) === 'est-1')
        || b.wheres.some(([m, a, v]) => m === 'where' && a === 'source_estimate_id' && String(v) === 'est-1')
        || /source_estimate_id/.test(flat) && /est-1/.test(flat);
      const byId = b.wheres.some(([m, a]) => m === 'where' && a && typeof a === 'object' && String(a.id) === 'ss-1');
      if (!bySource && !byId) return null;
      const excludedStatuses = b.wheres.find(([m, col]) => m === 'whereNotIn' && col === 'status')?.[2] || [];
      if (excludedStatuses.includes(LINKED_APPT_STATUS)) return null;
      return { ...linkedAppt() };
    }
    return null;
  });
  b.update = jest.fn(async () => 1);
  b.insert = jest.fn(async () => [1]);
  b.then = undefined;
  return b;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/estimates', router);
  app.use((err, _req, res, _next) => res.status(err.status || err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

describe('AUDIT r1-estimates-2: send-booking-link on an already-booked estimate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    scheduledServicesQueries.length = 0;
    ESTIMATE_DATA_OVERRIDE = null;
    LINKED_APPT_STATUS = 'confirmed';
    db.mockImplementation((table) => makeBuilder(table));
  });

  test('refuses (409) and sends NO SMS when a live scheduled_services row is linked via source_estimate_id', async () => {
    const res = await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/estimates/est-1/send-booking-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return { status: r.status, body: await r.json() };
    });

    // Diagnostic: what did the route actually ask scheduled_services?
     
    console.log('scheduled_services lookups by the route:', JSON.stringify(scheduledServicesQueries));
     
    console.log('response:', res.status, JSON.stringify(res.body));
     
    console.log('sendCustomerMessage calls:', JSON.stringify(sendCustomerMessage.mock.calls.map(([a]) => ({ to: a.to, body: a.body, purpose: a.purpose }))));

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has .*appointment/i);
  });
  test('CONTROL (mock fidelity): the legacy estimate_data.scheduled_service_id key DOES fire the 409 on current code', async () => {
    ESTIMATE_DATA_OVERRIDE = JSON.stringify({ oneTime: [{ name: 'German Roach Treatment', price: 295 }], scheduled_service_id: 'ss-1' });
    const res = await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/estimates/est-1/send-booking-link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return { status: r.status, body: await r.json() };
    });
     
    console.log('CONTROL lookups:', JSON.stringify(scheduledServicesQueries), 'response:', res.status, JSON.stringify(res.body));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
  });

  test.each(['skipped', 'no_show', 'cancelled', 'rescheduled', 'completed'])(
    'a %s linked visit is terminal — the guard does NOT block a fresh booking link',
    async (status) => {
      LINKED_APPT_STATUS = status;
      const res = await withServer(async (baseUrl) => {
        const r = await fetch(`${baseUrl}/estimates/est-1/send-booking-link`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        return { status: r.status, body: await r.json() };
      });
      expect(res.status).toBe(200);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    },
  );
});
