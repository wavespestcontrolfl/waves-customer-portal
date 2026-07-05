/**
 * Admin drafts route — campaign purpose passthrough (consent-bypass fix).
 *
 * Pins:
 *  - null-purpose drafts keep the LEGACY send contract exactly (audience
 *    'lead', purpose 'conversational', no consentBasis) — no regression to the
 *    inbound-reply lane
 *  - non-null purpose drafts send under THAT purpose, audience 'customer' when
 *    a customer is resolved, with the stored-preference marketing consentBasis
 *    for marketing-grade purposes (the validators enforce; the route no longer
 *    bypasses them as 'conversational')
 *  - a QUIET_HOURS_HOLD block surfaces code + held + nextAllowedAt in the API
 *    response (instead of swallowing them) and releases the draft claim
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: 'admin-1', role: 'admin' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const draftsRouter = require('../routes/admin-drafts');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

// ---------------------------------------------------------------------------
// Table-keyed queue of chainable builders (house pattern — see
// booking-abandon-recovery.test.js). NOTE: queues are reset in beforeEach;
// jest.clearAllMocks() does NOT clear once-style queues.
// ---------------------------------------------------------------------------
const updates = [];
function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of [
    'join', 'leftJoin', 'where', 'whereIn', 'whereNull', 'whereNotNull',
    'orderBy', 'select', 'limit', 'count',
  ]) b[m] = jest.fn(() => b);
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.update = jest.fn((payload) => { b._mode = 'update'; updates.push({ table, payload }); return b; });
  b.returning = jest.fn(() => Promise.resolve(cfg.returning ?? []));
  b.catch = jest.fn(() => Promise.resolve());
  b.then = (resolve, reject) => {
    const value = b._mode === 'update' ? (cfg.update ?? 1)
      : b._mode === 'first' ? cfg.first
        : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  return b;
}

let queues;
function enqueue(table, cfg) { (queues[table] = queues[table] || []).push(cfg); }

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/drafts', draftsRouter);
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

function campaignDraft(overrides = {}) {
  return {
    id: 'draft-1',
    sms_log_id: null,
    customer_id: 'cust-1',
    draft_response: 'Hi Dana, quick note about lawn care. Reply here for a quote.',
    flags: null,
    status: 'approved',
    campaign_type: 'upsell',
    purpose: 'marketing',
    source_ref: 'upsell_opportunities:opp-1',
    created_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  updates.length = 0;
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  sendCustomerMessage.mockResolvedValue({ sent: true });
});

describe('draftSendPolicyFields (unit)', () => {
  const { draftSendPolicyFields } = draftsRouter._internals;

  test('null purpose = legacy inbound-reply contract, exactly', () => {
    expect(draftSendPolicyFields({ purpose: null }, { customerId: 'cust-1' }))
      .toEqual({ audience: 'lead', purpose: 'conversational' });
  });

  test('marketing purpose + resolved customer → customer audience + opted_in basis', () => {
    const fields = draftSendPolicyFields(
      campaignDraft(),
      { customerId: 'cust-1' }
    );
    expect(fields.audience).toBe('customer');
    expect(fields.purpose).toBe('marketing');
    expect(fields.consentBasis).toMatchObject({
      status: 'opted_in',
      source: 'customer_marketing_preferences',
    });
    expect(fields.consentBasis.capturedAt).toBe('2026-07-01T12:00:00.000Z');
  });

  test('retention purpose is marketing-grade too', () => {
    const fields = draftSendPolicyFields(
      campaignDraft({ purpose: 'retention' }),
      { customerId: 'cust-1' }
    );
    expect(fields.purpose).toBe('retention');
    expect(fields.consentBasis?.status).toBe('opted_in');
  });

  test('non-marketing non-null purpose passes through without a consent basis', () => {
    const fields = draftSendPolicyFields(
      campaignDraft({ purpose: 'estimate_followup' }),
      { customerId: 'cust-1' }
    );
    expect(fields).toEqual({ audience: 'customer', purpose: 'estimate_followup' });
  });

  test('no resolved customer → lead audience (requireIds validator blocks marketing downstream)', () => {
    const fields = draftSendPolicyFields(campaignDraft(), { customerId: null });
    expect(fields.audience).toBe('lead');
  });
});

describe('PUT /admin/drafts/:id/approve', () => {
  function enqueueApproveHappyPath(draft) {
    // 1. claim update … returning([draft])
    enqueue('message_drafts', { returning: [draft] });
    // 2. resolveDraftRecipient — customers lookup
    enqueue('customers', { first: { id: draft.customer_id, phone: '+19415550101' } });
    // (post-send final update / releaseDraftClaim uses the default builder)
  }

  test('legacy null-purpose draft sends exactly as before', async () => {
    const draft = campaignDraft({ purpose: null, campaign_type: null, source_ref: null });
    enqueueApproveHappyPath(draft);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
    });

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const input = sendCustomerMessage.mock.calls[0][0];
    expect(input.audience).toBe('lead');
    expect(input.purpose).toBe('conversational');
    expect(input.consentBasis).toBeUndefined();
    expect(input.entryPoint).toBe('admin_draft_approve');
  });

  test('marketing campaign draft sends under purpose=marketing with consentBasis + customer audience', async () => {
    const draft = campaignDraft();
    enqueueApproveHappyPath(draft);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
    });

    const input = sendCustomerMessage.mock.calls[0][0];
    expect(input.audience).toBe('customer');
    expect(input.purpose).toBe('marketing');
    expect(input.customerId).toBe('cust-1');
    expect(input.consentBasis).toMatchObject({ status: 'opted_in', source: 'customer_marketing_preferences' });
    expect(input.metadata.campaign_type).toBe('upsell');
    expect(input.metadata.source_ref).toBe('upsell_opportunities:opp-1');
  });

  test('QUIET_HOURS_HOLD surfaces code + held + nextAllowedAt and releases the claim', async () => {
    const draft = campaignDraft();
    enqueueApproveHappyPath(draft);
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'QUIET_HOURS_HOLD',
      reason: 'Florida quiet hours (8pm-8am ET) — held',
      retryable: true,
      deferred: true,
      nextAllowedAt: '2026-07-05T12:00:00.000Z',
    });

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(422);
      body = await res.json();
    });

    expect(body.code).toBe('QUIET_HOURS_HOLD');
    expect(body.held).toBe(true);
    expect(body.nextAllowedAt).toBe('2026-07-05T12:00:00.000Z');
    expect(body.error).toMatch(/quiet hours/i);

    // Draft released back to pending so the owner can re-approve after 8am.
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release).toBeTruthy();
    expect(release.payload.approved_by).toBeNull();
  });

  test('non-retryable block still 422s with its code and no held flag', async () => {
    const draft = campaignDraft();
    enqueueApproveHappyPath(draft);
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'NO_MARKETING_CONSENT',
      reason: 'Purpose "marketing" requires marketing consent.',
    });

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(422);
      body = await res.json();
    });

    expect(body.code).toBe('NO_MARKETING_CONSENT');
    expect(body.held).toBeUndefined();
    expect(body.nextAllowedAt).toBeUndefined();
  });
});

describe('PUT /admin/drafts/:id/revise', () => {
  test('campaign draft revise also sends under the draft purpose (no consent bypass)', async () => {
    const draft = campaignDraft();
    enqueue('message_drafts', { returning: [draft] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550101' } });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/revise`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Edited copy. Reply here for a quote.' }),
      });
      expect(res.status).toBe(200);
    });

    const input = sendCustomerMessage.mock.calls[0][0];
    expect(input.purpose).toBe('marketing');
    expect(input.audience).toBe('customer');
    expect(input.consentBasis?.status).toBe('opted_in');
    expect(input.entryPoint).toBe('admin_draft_revise');
  });
});

describe('GET /admin/drafts', () => {
  test('returns campaign fields and applies the campaign_type filter', async () => {
    const listBuilder = makeBuilder('message_drafts', {
      rows: [campaignDraft({ first_name: 'Dana', last_name: 'Reyes', phone: '+19415550101' })],
    });
    const countBuilder = makeBuilder('message_drafts', { first: { count: '1' } });
    const buildersByTable = { message_drafts: [listBuilder, countBuilder] };
    db.mockImplementation((table) => (buildersByTable[table] || []).shift() || makeBuilder(table));

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts?campaign_type=upsell`);
      expect(res.status).toBe(200);
      body = await res.json();
    });

    expect(listBuilder.where).toHaveBeenCalledWith('message_drafts.campaign_type', 'upsell');
    expect(body.drafts[0].campaignType).toBe('upsell');
    expect(body.drafts[0].purpose).toBe('marketing');
    expect(body.drafts[0].sourceRef).toBe('upsell_opportunities:opp-1');
  });

  test('campaign_type=none scopes to legacy non-campaign drafts', async () => {
    const listBuilder = makeBuilder('message_drafts', { rows: [] });
    const countBuilder = makeBuilder('message_drafts', { first: { count: '0' } });
    const buildersByTable = { message_drafts: [listBuilder, countBuilder] };
    db.mockImplementation((table) => (buildersByTable[table] || []).shift() || makeBuilder(table));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts?campaign_type=none`);
      expect(res.status).toBe(200);
    });

    expect(listBuilder.whereNull).toHaveBeenCalledWith('message_drafts.campaign_type');
  });
});
