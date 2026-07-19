/**
 * Admin drafts route — clarify dispatch decision wiring.
 *
 * The locked decision itself (staleness re-read, partial-answer rewrite,
 * sent_at stamp under the per-phone clarify lock) is pinned by
 * estimate-clarify-asks.test.js. THIS file pins the route's side of the
 * contract:
 *  - the gate recheck runs BEFORE the decision (gate off → 409 + release,
 *    decision never invoked)
 *  - outcome mapping: 'send' dispatches the DECISION's body (not the claimed
 *    row's), 'retired' → 409 CLARIFY_STALE with no send and no release
 *    (status already moved), 'rewritten' on revise → 409 CLARIFY_UPDATED +
 *    claim released with the revision cleared, 'error' → 503 + release
 *  - every post-decision failure (recipient missing, provider throw, blocked
 *    send) reconciles via reopenClarifyAfterFailedSend — NEVER plain
 *    releaseDraftClaim, whose unconditional pending-write could resurrect a
 *    concurrently rejected draft; if reconciliation itself fails the draft
 *    is left claimed rather than blind-released
 *  - non-clarify drafts never touch the clarify service
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

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
const mockGates = {};
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => mockGates[gate] !== false),
}));
const mockPreDispatchCheck = jest.fn(async () => ({ ok: true }));
jest.mock('../services/estimate-clarify-asks', () => ({
  claimClarifyDispatch: jest.fn(),
  clarifyPreDispatchCheck: jest.fn(() => mockPreDispatchCheck),
  reopenClarifyAfterFailedSend: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const draftsRouter = require('../routes/admin-drafts');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const {
  claimClarifyDispatch,
  reopenClarifyAfterFailedSend,
} = require('../services/estimate-clarify-asks');

// Table-keyed queue of chainable builders (house pattern — see
// admin-drafts-campaign-approve.test.js).
const updates = [];
function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of [
    'join', 'leftJoin', 'where', 'whereIn', 'whereNot', 'whereNull',
    'whereNotNull', 'orderBy', 'select', 'limit', 'count',
  ]) b[m] = jest.fn(() => b);
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.update = jest.fn((payload) => { b._mode = 'update'; updates.push({ table, payload }); return b; });
  b.returning = jest.fn(() => Promise.resolve(cfg.returning ?? []));
  b.catch = jest.fn(() => Promise.resolve());
  b.then = (resolve, reject) => {
    if (cfg.error) return Promise.reject(cfg.error).then(resolve, reject);
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

const CLARIFY_FLAGS = {
  missing: ['street_address'],
  toPhone: '+19415550142',
  channel_provenance: 'sms',
};

function clarifyDraft(overrides = {}) {
  return {
    id: 'draft-9',
    sms_log_id: null,
    customer_id: null,
    campaign_type: null,
    purpose: null,
    intent: 'estimate_clarify',
    source_ref: 'clarify:9415550142',
    status: 'pending',
    draft_response: 'Claimed-row question?',
    revised_response: null,
    final_response: null,
    created_at: new Date(Date.now() - 60000).toISOString(),
    flags: JSON.stringify(CLARIFY_FLAGS),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  updates.length = 0;
  queues = {};
  for (const key of Object.keys(mockGates)) delete mockGates[key];
  db.mockImplementation((table) => {
    const cfg = (queues[table] || []).shift() || {};
    return makeBuilder(table, cfg);
  });
  db.transaction = async (callback) => callback(db);
  db.fn = { now: () => new Date() };
  reopenClarifyAfterFailedSend.mockResolvedValue({ reopened: true, retired: false });
});

describe('approve — clarify dispatch wiring', () => {
  test("outcome 'send' dispatches the decision's body and finalizes with it", async () => {
    enqueue('message_drafts', { returning: [clarifyDraft()] });      // claim
    enqueue('message_drafts', { update: 1 });                         // finalize
    claimClarifyDispatch.mockResolvedValue({
      outcome: 'send',
      body: 'Decision-fresh question?',
      flags: CLARIFY_FLAGS,
    });
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM1' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-9/approve`, { method: 'PUT' });
      expect(res.status).toBe(200);
    });

    expect(claimClarifyDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ isRevision: false, draft: expect.objectContaining({ id: 'draft-9' }) }),
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550142',
      body: 'Decision-fresh question?',
      purpose: 'estimate_followup',
      // The locked final recheck rides into the canonical send path as the
      // last await before the provider handoff.
      preDispatchCheck: mockPreDispatchCheck,
    }));
    const finalize = updates.find((u) => u.payload.final_response !== undefined);
    expect(finalize.payload.final_response).toBe('Decision-fresh question?');
    expect(reopenClarifyAfterFailedSend).not.toHaveBeenCalled();
  });

  test("outcome 'retired' → 409 CLARIFY_STALE, no send, no claim release", async () => {
    enqueue('message_drafts', { returning: [clarifyDraft()] });
    claimClarifyDispatch.mockResolvedValue({
      outcome: 'retired',
      message: 'Clarify draft retired — the linked lead is closed.',
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-9/approve`, { method: 'PUT' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CLARIFY_STALE');
    });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // The decision already moved status to rejected — a release here would
    // resurrect a retired draft.
    expect(updates.filter((u) => u.table === 'message_drafts')).toHaveLength(1); // the claim only
  });

  test("outcome 'error' → 503 and the claim is released to pending", async () => {
    enqueue('message_drafts', { returning: [clarifyDraft()] });
    enqueue('message_drafts', { update: 1 });                         // release
    claimClarifyDispatch.mockResolvedValue({ outcome: 'error' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-9/approve`, { method: 'PUT' });
      expect(res.status).toBe(503);
    });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const release = updates[updates.length - 1];
    expect(release.payload.status).toBe('pending');
    expect(release.payload.approved_by).toBeNull();
  });

  test('gate off → 409 CLARIFY_GATE_OFF before the decision ever runs', async () => {
    mockGates.estimateClarifyAsks = false;
    enqueue('message_drafts', { returning: [clarifyDraft()] });
    enqueue('message_drafts', { update: 1 });                         // release

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-9/approve`, { method: 'PUT' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CLARIFY_GATE_OFF');
    });

    expect(claimClarifyDispatch).not.toHaveBeenCalled();
  });

  test('reconciliation unavailable → the draft is left claimed, never blind-released', async () => {
    enqueue('message_drafts', { returning: [clarifyDraft()] });
    claimClarifyDispatch.mockResolvedValue({
      outcome: 'send', body: 'Q?', flags: CLARIFY_FLAGS,
    });
    sendCustomerMessage.mockRejectedValue(new Error('twilio down'));
    reopenClarifyAfterFailedSend.mockResolvedValue({ reopened: false, retired: false });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-9/approve`, { method: 'PUT' });
      expect(res.status).toBe(500);
    });

    // No unconditional release — a concurrent reject must never be
    // resurrected by the fallback path.
    expect(updates.filter((u) => u.table === 'message_drafts')).toHaveLength(1); // the claim only
  });

  test('a provider throw after the committed decision reconciles via reopen, never plain release', async () => {
    enqueue('message_drafts', { returning: [clarifyDraft()] });
    claimClarifyDispatch.mockResolvedValue({
      outcome: 'send', body: 'Q?', flags: CLARIFY_FLAGS,
    });
    sendCustomerMessage.mockRejectedValue(new Error('twilio down'));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-9/approve`, { method: 'PUT' });
      expect(res.status).toBe(500);
    });

    expect(reopenClarifyAfterFailedSend).toHaveBeenCalledWith({
      draftId: 'draft-9',
      dispatchedMissing: ['street_address'],
      releaseFields: {},
    });
    // No direct message_drafts write beyond the claim — reconciliation is
    // the service's job, under the clarify lock.
    expect(updates.filter((u) => u.table === 'message_drafts')).toHaveLength(1);
  });

  test('recipient resolution runs BEFORE the decision — a lookup throw leaves nothing to reconcile', async () => {
    // sms_log_id forces resolveDraftRecipient onto a db read we can fail.
    enqueue('message_drafts', { returning: [clarifyDraft({ sms_log_id: 'sms-1' })] });
    enqueue('sms_log', { error: new Error('db connection lost') });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-9/approve`, { method: 'PUT' });
      expect(res.status).toBe(500);
    });

    // The decision never ran, so there is no committed dispatch to unwind.
    expect(claimClarifyDispatch).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(reopenClarifyAfterFailedSend).not.toHaveBeenCalled();
  });

  test('a blocked send (sent:false) also reconciles via reopen', async () => {
    enqueue('message_drafts', { returning: [clarifyDraft()] });
    claimClarifyDispatch.mockResolvedValue({
      outcome: 'send', body: 'Q?', flags: CLARIFY_FLAGS,
    });
    sendCustomerMessage.mockResolvedValue({ sent: false, code: 'CONSENT_REQUIRED' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-9/approve`, { method: 'PUT' });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('CONSENT_REQUIRED');
    });

    expect(reopenClarifyAfterFailedSend).toHaveBeenCalledTimes(1);
  });

  test('non-clarify drafts never touch the clarify service, even on send failure', async () => {
    const legacy = clarifyDraft({ intent: 'general_question', source_ref: null, flags: JSON.stringify({ toPhone: '+19415550142' }) });
    enqueue('message_drafts', { returning: [legacy] });
    enqueue('message_drafts', { update: 1 });                         // release
    sendCustomerMessage.mockResolvedValue({ sent: false, code: 'SUPPRESSED' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-9/approve`, { method: 'PUT' });
      expect(res.status).toBe(422);
    });

    expect(claimClarifyDispatch).not.toHaveBeenCalled();
    expect(reopenClarifyAfterFailedSend).not.toHaveBeenCalled();
    const release = updates[updates.length - 1];
    expect(release.payload.status).toBe('pending');
  });
});

describe('revise — clarify dispatch wiring', () => {
  test("outcome 'rewritten' → 409 CLARIFY_UPDATED; the decision released the claim, the route must not", async () => {
    enqueue('message_drafts', { returning: [clarifyDraft({ status: 'revised' })] });
    claimClarifyDispatch.mockResolvedValue({ outcome: 'rewritten' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-9/revise`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Owner-typed stale copy' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CLARIFY_UPDATED');
    });

    expect(claimClarifyDispatch).toHaveBeenCalledWith(expect.objectContaining({
      isRevision: true,
      releaseFields: { revised_response: null, final_response: null },
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // No route-side release — an unconditional pending-write here could
    // resurrect a draft rejected between the decision's commit and now.
    expect(updates.filter((u) => u.table === 'message_drafts')).toHaveLength(1); // the claim only
  });

  test('a revise-path provider throw reconciles via reopen with the revision cleared', async () => {
    enqueue('message_drafts', { returning: [clarifyDraft({ status: 'revised', final_response: 'Owner copy' })] });
    claimClarifyDispatch.mockResolvedValue({
      outcome: 'send', body: 'Owner copy', flags: CLARIFY_FLAGS,
    });
    sendCustomerMessage.mockRejectedValue(new Error('twilio down'));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-9/revise`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Owner copy' }),
      });
      expect(res.status).toBe(500);
    });

    expect(reopenClarifyAfterFailedSend).toHaveBeenCalledWith({
      draftId: 'draft-9',
      dispatchedMissing: ['street_address'],
      releaseFields: { revised_response: null, final_response: null },
    });
  });
});
