/**
 * Admin drafts route — send paths (approve / revise) and the leftover-campaign block.
 *
 * Pins:
 *  - null-purpose drafts keep the LEGACY send contract exactly (audience
 *    'lead', purpose 'conversational', no consentBasis) — no regression to the
 *    inbound-reply lane
 *  - non-null purpose drafts send under THAT purpose, audience 'customer' when
 *    a customer is resolved, with the stored-preference marketing consentBasis
 *    for marketing-grade purposes (the validators enforce; the route no longer
 *    bypasses them as 'conversational')
 *  - a blocked send surfaces its code in the API response (instead of
 *    swallowing it) and releases the draft claim
 *  - the campaign draft generators are gone: a leftover draft that still
 *    carries a campaign_type cannot be approved or revised-sent (409, claim
 *    released, draft stays pending so it can be rejected)
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// Real listen+fetch round-trips: under full-suite parallel load the default 5s
// per-test budget can starve (a timed-out test's still-pending request then
// leaks into the next test's mock queues). Match the long-suite accommodation.
jest.setTimeout(30000);

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
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/messaging/send-manual-customer-sms', () => ({
  sendManualCustomerSms: jest.fn((...args) => (
    require('../services/messaging/send-customer-message').sendCustomerMessage(...args)
  )),
  manualSmsDeliveryState: (value) => value?.manualSmsInterlock?.deliveryState || null,
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));

const express = require('express');
const db = require('../models/db');
const draftsRouter = require('../routes/admin-drafts');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { sendManualCustomerSms } = require('../services/messaging/send-manual-customer-sms');

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

function draftRow(overrides = {}) {
  return {
    id: 'draft-1',
    sms_log_id: null,
    customer_id: 'cust-1',
    draft_response: 'Hi Dana, quick note about lawn care. Reply here for a quote.',
    flags: null,
    status: 'approved',
    campaign_type: null,
    purpose: 'marketing',
    source_ref: null,
    created_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  updates.length = 0;
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  db.transaction = jest.fn(async (fn) => fn(db));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings })); // the review-provenance stamp (flags.review_verdict)
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM_real_sid' });
});

describe('draftSendPolicyFields (unit)', () => {
  const { draftSendPolicyFields } = draftsRouter._internals;

  test('null purpose = legacy inbound-reply contract, exactly', () => {
    expect(draftSendPolicyFields({ purpose: null }, { customerId: 'cust-1' }))
      .toEqual({ audience: 'lead', purpose: 'conversational' });
  });

  test('marketing purpose + resolved customer → customer audience + opted_in basis', () => {
    const fields = draftSendPolicyFields(
      draftRow(),
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
      draftRow({ purpose: 'retention' }),
      { customerId: 'cust-1' }
    );
    expect(fields.purpose).toBe('retention');
    expect(fields.consentBasis?.status).toBe('opted_in');
  });

  test('non-marketing non-null purpose passes through without a consent basis', () => {
    const fields = draftSendPolicyFields(
      draftRow({ purpose: 'estimate_followup' }),
      { customerId: 'cust-1' }
    );
    expect(fields).toEqual({ audience: 'customer', purpose: 'estimate_followup' });
  });

  test('no resolved customer → lead audience (requireIds validator blocks marketing downstream)', () => {
    const fields = draftSendPolicyFields(draftRow(), { customerId: null });
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
    const draft = draftRow({ purpose: null, campaign_type: null, source_ref: null });
    enqueueApproveHappyPath(draft);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
    });

    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const input = sendCustomerMessage.mock.calls[0][0];
    expect(input.audience).toBe('lead');
    expect(input.purpose).toBe('conversational');
    expect(input.consentBasis).toBeUndefined();
    expect(input.entryPoint).toBe('admin_draft_approve');
    // Legacy provenance value + no campaign-only metadata.
    expect(input.metadata.original_message_type).toBe('ai_approved');
    expect(input.metadata.customerLocationId).toBeUndefined();
  });

  test('marketing-purpose draft sends under purpose=marketing with consentBasis + customer audience', async () => {
    const draft = draftRow();
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
    expect(input.metadata.original_message_type).toBe('ai_approved');
  });

  test('a draft whose body names a call-us line sends FROM that pinned line (seasonal win-back)', async () => {
    const draft = draftRow({ flags: JSON.stringify({ fromNumber: '+19412972817' }) });
    enqueueApproveHappyPath(draft);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
    });
    expect(sendCustomerMessage.mock.calls[0][0].metadata.fromNumber).toBe('+19412972817');
  });

  test('a pinned line that is not one of our numbers is ignored', async () => {
    const draft = draftRow({ flags: JSON.stringify({ fromNumber: '+15550000000' }) });
    enqueueApproveHappyPath(draft);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
    });
    expect(sendCustomerMessage.mock.calls[0][0].metadata.fromNumber).toBeUndefined();
  });

  test('a leftover campaign draft cannot be approve-sent, draft stays pending', async () => {
    const draft = draftRow({ campaign_type: 'upsell', source_ref: 'upsell_opportunities:opp-1' });
    enqueue('message_drafts', { returning: [draft] });

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(409);
      body = await res.json();
    });

    expect(body.code).toBe('CAMPAIGN_GATE_OFF');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Claim released — draft stays pending so the owner can reject it.
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release).toBeTruthy();
  });

  test('blocked send 422s with its code and releases the claim', async () => {
    const draft = draftRow();
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
    expect(body.nextAllowedAt).toBeUndefined();

    // Draft released back to pending so the owner can fix and re-approve.
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release).toBeTruthy();
    expect(release.payload.approved_by).toBeNull();
  });

  test('an uncertain approve result returns no-retry guidance and retains the claimed draft', async () => {
    const draft = draftRow();
    enqueueApproveHappyPath(draft);
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      deliveryOutcome: 'uncertain',
      code: 'PROVIDER_FAILURE',
      manualSmsInterlock: { deliveryState: 'uncertain' },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'SMS_DELIVERY_UNCERTAIN', mayHaveSent: true, retryable: false,
      });
    });

    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
    expect(updates.find((u) => u.payload.status === 'pending')).toBeUndefined();
    expect(updates.find((u) => u.payload.sent_at)).toBeUndefined();
  });

  test('an older unresolved manual send blocks approve but releases this unsent draft claim', async () => {
    const draft = draftRow();
    enqueueApproveHappyPath(draft);
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      deliveryOutcome: 'uncertain',
      code: 'MANUAL_REPLY_OUTCOME_UNRESOLVED',
      manualSmsInterlock: { deliveryState: 'uncertain' },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'SMS_DELIVERY_UNCERTAIN', mayHaveSent: true, retryable: false,
      });
    });

    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release?.payload).toMatchObject({ approved_by: null, approved_at: null });
    expect(updates.find((u) => u.payload.sent_at)).toBeUndefined();
  });

  test('legacy null-campaign drafts keep the pre-existing sentinel behavior (scope: campaign drafts only)', async () => {
    const draft = draftRow({ purpose: null, campaign_type: null, source_ref: null });
    enqueueApproveHappyPath(draft);
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'owner-silence' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
    });
  });

});

describe('PUT /admin/drafts/:id/revise', () => {
  test('a revised draft carries its composer-linked visits (UUIDs only) so the send step can hold a street-level address hold; none posted, none sent', async () => {
    const VISIT = '3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c';
    for (const [posted, expected] of [[[VISIT, 'junk', VISIT], [VISIT]], [undefined, undefined]]) {
      sendCustomerMessage.mockClear();
      enqueue('message_drafts', { returning: [draftRow()] });
      enqueue('customers', { first: { id: 'cust-1', phone: '+19415550101' } });
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/drafts/draft-1/revise`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revisedResponse: 'Your reschedule link: https://example.test/r/abc', linkedVisitIds: posted }),
        });
        expect(res.status).toBe(200);
      });
      const { metadata } = sendCustomerMessage.mock.calls[0][0];
      if (expected) expect(metadata.linked_scheduled_service_ids).toEqual(expected);
      else expect(metadata).not.toHaveProperty('linked_scheduled_service_ids');
    }
  });

  test('revise-send of a leftover campaign draft is blocked and restores the pending draft', async () => {
    const draft = draftRow({ campaign_type: 'reactivation', source_ref: 'customers:cust-1' });
    enqueue('message_drafts', { returning: [draft] });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/revise`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Edited copy.' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CAMPAIGN_GATE_OFF');
    });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Claim released with the revise fields cleared.
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release).toBeTruthy();
    expect(release.payload.revised_response).toBeNull();
    expect(release.payload.final_response).toBeNull();
  });

  test('an uncertain thrown revise retains the claim and edited response', async () => {
    const draft = draftRow();
    enqueue('message_drafts', { returning: [draft] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550101' } });
    sendCustomerMessage.mockRejectedValue(Object.assign(new Error('provider timeout'), {
      manualSmsInterlock: { deliveryState: 'uncertain' },
    }));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/revise`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Edited copy.' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'SMS_DELIVERY_UNCERTAIN', mayHaveSent: true, retryable: false,
      });
    });

    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
    expect(updates.find((u) => u.payload.status === 'pending')).toBeUndefined();
    expect(updates.find((u) => u.payload.revised_response === null)).toBeUndefined();
  });

  test('an older unresolved manual send blocks revise but releases this unsent draft claim and edit', async () => {
    const draft = draftRow();
    enqueue('message_drafts', { returning: [draft] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550101' } });
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      deliveryOutcome: 'uncertain',
      code: 'MANUAL_REPLY_OUTCOME_UNRESOLVED',
      manualSmsInterlock: { deliveryState: 'uncertain' },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/revise`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Edited copy.' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'SMS_DELIVERY_UNCERTAIN', mayHaveSent: true, retryable: false,
      });
    });

    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release?.payload).toMatchObject({
      approved_by: null,
      approved_at: null,
      revised_response: null,
      final_response: null,
    });
    expect(updates.find((u) => u.payload.sent_at)).toBeUndefined();
  });

  test('a definite revise miss releases the claim and clears edited fields', async () => {
    const draft = draftRow();
    enqueue('message_drafts', { returning: [draft] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550101' } });
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      deliveryOutcome: 'not_sent',
      code: 'SMS_OPTED_OUT',
      manualSmsInterlock: { deliveryState: 'not_sent' },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/revise`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Edited copy.' }),
      });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('SMS_OPTED_OUT');
    });

    const release = updates.find((u) => u.payload.status === 'pending');
    expect(release.payload).toMatchObject({ revised_response: null, final_response: null });
  });

});

describe('GET /admin/drafts', () => {
  test('returns campaign fields and applies the campaign_type filter', async () => {
    const listBuilder = makeBuilder('message_drafts', {
      rows: [draftRow({ campaign_type: 'upsell', source_ref: 'upsell_opportunities:opp-1', first_name: 'Dana', last_name: 'Reyes', phone: '+19415550101' })],
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
