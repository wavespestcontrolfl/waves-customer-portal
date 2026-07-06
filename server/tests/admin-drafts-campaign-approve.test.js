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
 *  - a blocked send surfaces its code in the API response (instead of
 *    swallowing it) and releases the draft claim
 *  - the SHARED pre-send gate (campaign-drafts-gate.js) re-runs at send time
 *    with the draft's own row excluded from the cooldown; terminal verdicts
 *    retire the draft (rejected + flags.campaign_rejected_reason), cooldown
 *    holds 409 + release, guard errors 503 + release
 *  - suppression sentinels (sent:true, providerMessageId 'template-disabled'
 *    etc.) are NOT finalized as sent for campaign drafts — 422 SEND_SUPPRESSED
 *    + claim released
 *  - a REAL upsell campaign send flips the linked upsell_opportunities row to
 *    'pitched' in the same transaction as draft finalization
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
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
// Controllable campaign gate; every other gate defaults open.
const mockGates = { campaignDrafts: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => mockGates[gate] !== false),
}));
jest.mock('../services/campaign-drafts', () => ({
  CAMPAIGN_GATE: 'campaignDrafts',
}));
// The shared pre-send gate is mocked for route isolation (its verdicts are
// pinned by campaign-drafts-gate.test.js); the code sets + parseOpportunityRef
// stay REAL so the route's terminal/hold/transient mapping and the pitched
// flip are exercised against the true contract.
jest.mock('../services/campaign-drafts-gate', () => ({
  ...jest.requireActual('../services/campaign-drafts-gate'),
  evaluateCampaignSendGate: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const draftsRouter = require('../routes/admin-drafts');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { evaluateCampaignSendGate } = require('../services/campaign-drafts-gate');

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
  // Draft finalization may run in a transaction (upsell pitched flip) — the
  // trx handle reuses the same table-keyed queue machinery.
  db.transaction = jest.fn(async (fn) => fn(db));
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM_real_sid' });
  mockGates.campaignDrafts = true;
  evaluateCampaignSendGate.mockResolvedValue({
    ok: true,
    customer: { id: 'cust-1', nearest_location_id: 'loc-9' },
  });
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
    // Legacy provenance value + no campaign-only metadata.
    expect(input.metadata.original_message_type).toBe('ai_approved');
    expect(input.metadata.customerLocationId).toBeUndefined();
    // Legacy drafts never consult the campaign pre-send gate.
    expect(evaluateCampaignSendGate).not.toHaveBeenCalled();
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
    // sms_log.message_type lands as the legacy workflow type so the 30d
    // cooldown (CAMPAIGN_SMS_TYPES) and workflow-status readers see the send.
    expect(input.metadata.original_message_type).toBe('upsell');
    // Originates from the customer's local office number (legacy workflow
    // behavior) via the approval-time customer lookup.
    expect(input.metadata.customerLocationId).toBe('loc-9');

    // The SHARED gate is re-run at send time with the draft's own row
    // excluded from the cooldown — parity with the generators by construction.
    expect(evaluateCampaignSendGate).toHaveBeenCalledWith({
      campaignType: 'upsell',
      customerId: 'cust-1',
      sourceRef: 'upsell_opportunities:opp-1',
      excludeDraftId: 'draft-1',
    });
  });

  test('gate off is a full kill switch: existing campaign drafts cannot be approve-sent, draft stays pending', async () => {
    mockGates.campaignDrafts = false;
    const draft = campaignDraft();
    enqueue('message_drafts', { returning: [draft] });

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(409);
      body = await res.json();
    });

    expect(body.code).toBe('CAMPAIGN_GATE_OFF');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Claim released — draft stays pending for when the gate comes back on.
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release).toBeTruthy();
  });

  test('gate off does not touch legacy null-campaign drafts', async () => {
    mockGates.campaignDrafts = false;
    const draft = campaignDraft({ purpose: null, campaign_type: null, source_ref: null });
    enqueueApproveHappyPath(draft);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
    });

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('terminal gate verdict retires the draft instead of sending (reactivation target rebooked)', async () => {
    const draft = campaignDraft({ campaign_type: 'reactivation', source_ref: 'customers:cust-1' });
    enqueue('message_drafts', { returning: [draft] });
    evaluateCampaignSendGate.mockResolvedValue({
      ok: false, code: 'not_lapsed', customer: { id: 'cust-1', pipeline_stage: 'active_customer' },
    });

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(422);
      body = await res.json();
    });

    expect(body.code).toBe('CAMPAIGN_INELIGIBLE');
    expect(body.reason).toBe('not_lapsed');
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    // Draft marked rejected with a clear reason in flags — not released back
    // to pending, not sent. The next weekly run writes a FRESH draft if the
    // customer lapses again.
    const rejection = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'rejected');
    expect(rejection).toBeTruthy();
    expect(JSON.parse(rejection.payload.flags)).toMatchObject({ campaign_rejected_reason: 'not_lapsed' });
    expect(rejection.payload.approved_by).toBe('admin-1');
  });

  test('opportunity pitched elsewhere while pending → draft retired with the closing status in flags', async () => {
    const draft = campaignDraft();
    enqueue('message_drafts', { returning: [draft] });
    evaluateCampaignSendGate.mockResolvedValue({ ok: false, code: 'opportunity_closed', reason: 'accepted' });

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(422);
      body = await res.json();
    });

    expect(body).toMatchObject({ code: 'CAMPAIGN_INELIGIBLE', reason: 'opportunity_closed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const rejection = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'rejected');
    expect(JSON.parse(rejection.payload.flags)).toMatchObject({
      campaign_rejected_reason: 'opportunity_closed',
      campaign_rejected_detail: 'accepted',
    });
  });

  test('cooldown hit at send time (live auto lane sent while pending) → 409 hold, draft stays pending', async () => {
    const draft = campaignDraft();
    enqueue('message_drafts', { returning: [draft] });
    evaluateCampaignSendGate.mockResolvedValue({
      ok: false, code: 'cooldown_active', reason: 'recent_campaign_sms',
    });

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(409);
      body = await res.json();
    });

    expect(body.code).toBe('CAMPAIGN_COOLDOWN_HOLD');
    expect(body.reason).toBe('recent_campaign_sms');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Claim released — the condition passes with time, so the draft is NOT
    // retired.
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release).toBeTruthy();
    expect(release.payload.approved_by).toBeNull();
    expect(updates.find((u) => u.payload.status === 'rejected')).toBeUndefined();
  });

  test('gate lookup failure fails closed: 503, claim released, draft stays pending', async () => {
    const draft = campaignDraft();
    enqueue('message_drafts', { returning: [draft] });
    evaluateCampaignSendGate.mockResolvedValue({ ok: false, code: 'guard_error', reason: 'connection refused' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('CAMPAIGN_GUARD_ERROR');
    });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending')).toBeTruthy();
    expect(updates.find((u) => u.payload.status === 'rejected')).toBeUndefined();
  });

  test('blocked send 422s with its code and releases the claim', async () => {
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
    expect(body.nextAllowedAt).toBeUndefined();

    // Draft released back to pending so the owner can fix and re-approve.
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release).toBeTruthy();
    expect(release.payload.approved_by).toBeNull();
  });

  test('template-disabled sentinel is NOT a send: 422, claim released, draft not finalized, no pitched flip', async () => {
    const draft = campaignDraft();
    enqueueApproveHappyPath(draft);
    // TwilioService.sendSMS returns success:true with sid 'template-disabled'
    // (no SMS sent) when the mapped template is inactive; the wrapper
    // surfaces it as sent:true + sentinel providerMessageId.
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'template-disabled' });

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(422);
      body = await res.json();
    });

    expect(body.code).toBe('SEND_SUPPRESSED');
    expect(body.reason).toBe('template-disabled');
    // Draft NOT marked sent — claim released so it stays actionable once the
    // template is re-enabled.
    expect(updates.find((u) => u.table === 'message_drafts' && u.payload.sent_at)).toBeUndefined();
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release).toBeTruthy();
    // And the linked opportunity is NOT flipped to pitched — nothing was sent.
    expect(updates.find((u) => u.table === 'upsell_opportunities')).toBeUndefined();
  });

  test('legacy null-campaign drafts keep the pre-existing sentinel behavior (scope: campaign drafts only)', async () => {
    const draft = campaignDraft({ purpose: null, campaign_type: null, source_ref: null });
    enqueueApproveHappyPath(draft);
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'owner-silence' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
    });
  });

  test('real upsell send flips the linked opportunity to pitched atomically with finalization', async () => {
    const draft = campaignDraft();
    enqueueApproveHappyPath(draft);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
    });

    // Same transaction: draft finalized + opportunity moved to 'pitched' so
    // customer-intel pitched/accepted metrics see the campaign pitch.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const finalized = updates.find((u) => u.table === 'message_drafts' && u.payload.sent_at);
    expect(finalized).toBeTruthy();
    expect(finalized.payload.final_response).toBe(draft.draft_response);
    const pitched = updates.find((u) => u.table === 'upsell_opportunities');
    expect(pitched).toBeTruthy();
    expect(pitched.payload).toMatchObject({ status: 'pitched', pitched_by: 'campaign_draft' });
    expect(pitched.payload.pitched_at).toBeInstanceOf(Date);
  });

  test('reactivation sends never touch upsell_opportunities', async () => {
    const draft = campaignDraft({ campaign_type: 'reactivation', source_ref: 'customers:cust-1' });
    enqueueApproveHappyPath(draft);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/approve`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
    });

    expect(updates.find((u) => u.table === 'message_drafts' && u.payload.sent_at)).toBeTruthy();
    expect(updates.find((u) => u.table === 'upsell_opportunities')).toBeUndefined();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('PUT /admin/drafts/:id/revise', () => {
  test('campaign draft revise also sends under the draft purpose (no consent bypass)', async () => {
    const draft = campaignDraft({ campaign_type: 'reactivation', source_ref: 'customers:cust-1' });
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
    // Campaign message_type + local office origin apply on revise too.
    expect(input.metadata.original_message_type).toBe('reactivation');
    expect(input.metadata.customerLocationId).toBe('loc-9');
  });

  test('gate off blocks revise-send for campaign drafts and restores the pending draft', async () => {
    mockGates.campaignDrafts = false;
    const draft = campaignDraft();
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

  test('gate hold on revise releases the claim with the revise fields cleared', async () => {
    const draft = campaignDraft();
    enqueue('message_drafts', { returning: [draft] });
    evaluateCampaignSendGate.mockResolvedValue({ ok: false, code: 'cooldown_active', reason: 'recent_prepay_notice' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/revise`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Edited copy.' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CAMPAIGN_COOLDOWN_HOLD');
    });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release).toBeTruthy();
    expect(release.payload.revised_response).toBeNull();
    expect(release.payload.final_response).toBeNull();
  });

  test('template-disabled sentinel on revise: 422 SEND_SUPPRESSED, draft restored to pending, no pitched flip', async () => {
    const draft = campaignDraft();
    enqueue('message_drafts', { returning: [draft] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550101' } });
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'template-disabled' });

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-1/revise`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Edited copy. Reply here for a quote.' }),
      });
      expect(res.status).toBe(422);
      body = await res.json();
    });

    expect(body).toMatchObject({ code: 'SEND_SUPPRESSED', reason: 'template-disabled' });
    expect(updates.find((u) => u.table === 'message_drafts' && u.payload.sent_at)).toBeUndefined();
    expect(updates.find((u) => u.table === 'upsell_opportunities')).toBeUndefined();
    const release = updates.find((u) => u.table === 'message_drafts' && u.payload.status === 'pending');
    expect(release).toBeTruthy();
    expect(release.payload.revised_response).toBeNull();
    expect(release.payload.final_response).toBeNull();
  });

  test('real send on revise flips the linked upsell opportunity to pitched', async () => {
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

    const pitched = updates.find((u) => u.table === 'upsell_opportunities');
    expect(pitched).toBeTruthy();
    expect(pitched.payload).toMatchObject({ status: 'pitched', pitched_by: 'campaign_draft' });
  });
});

describe('campaign message_type mapping', () => {
  const { draftMessageType, CAMPAIGN_MESSAGE_TYPES } = draftsRouter._internals;

  test('maps campaign types to the legacy workflow sms_log types; legacy drafts keep their value', () => {
    expect(draftMessageType({ campaign_type: null }, 'ai_approved')).toBe('ai_approved');
    expect(draftMessageType({ campaign_type: 'upsell' }, 'ai_approved')).toBe('upsell');
    expect(draftMessageType({ campaign_type: 'reactivation' }, 'ai_revised')).toBe('reactivation');
    // Unknown future campaign type falls back to the campaign_type itself
    // rather than mislabeling as a legacy provenance value.
    expect(draftMessageType({ campaign_type: 'winback' }, 'ai_approved')).toBe('winback');
  });

  test('every mapped message_type is visible to the unified 30d cooldown filter', () => {
    // requireActual: this suite mocks campaign-drafts for route isolation, but
    // the contract must hold against the REAL cooldown constant.
    const real = jest.requireActual('../services/campaign-drafts');
    for (const type of Object.values(CAMPAIGN_MESSAGE_TYPES)) {
      expect(real.CAMPAIGN_SMS_TYPES).toContain(type);
    }
    // And the mocked gate name matches the real one.
    expect(real.CAMPAIGN_GATE).toBe('campaignDrafts');
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
