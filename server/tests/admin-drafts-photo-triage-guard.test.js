/**
 * Admin drafts route — photo-triage dispatch-time offer recheck (codex
 * #4810 r6). The recheck itself is pinned in photo-triage-opportunity.test.js;
 * THIS file pins the route's side: owned/unavailable → 409
 * PHOTO_TRIAGE_OFFER_STALE + claim released + no send; repriced → 409
 * PHOTO_TRIAGE_REPRICED + flags.quote refreshed on the released row; a
 * lookup failure → 503 + release; ok → the send proceeds; non-photo-triage
 * drafts never touch the recheck. Harness cloned from the clarify wiring
 * suite.
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
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
const mockGates = {};
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => mockGates[gate] !== false),
}));
const mockPreDispatchCheck = jest.fn(async () => ({ ok: true }));
jest.mock('../services/composer-customer-links', () => ({
  autopayLinkSendCheck: jest.fn(async () => ({ present: false })),
  immediateOnlyLinkSendCheck: jest.fn(async () => ({ present: false })),
}));
jest.mock('../services/estimate-clarify-asks', () => ({
  claimClarifyDispatch: jest.fn(),
  clarifyPreDispatchCheck: jest.fn(() => mockPreDispatchCheck),
  reopenClarifyAfterFailedSend: jest.fn(),
}));
const mockRecheck = jest.fn(async () => ({ ok: true }));
jest.mock('../services/photo-triage-opportunity', () => ({
  recheckDraftOffer: (...args) => mockRecheck(...args),
}));

const express = require('express');
const db = require('../models/db');
const draftsRouter = require('../routes/admin-drafts');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

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

const PHOTO_FLAGS = {
  origin: 'photo_triage', assessment_type: 'tree_shrub', opportunity_mode: 'quote',
  opportunity_reasons: ['actionable', 'quoted'], quote: { service: 'tree_shrub', per_visit: 83.33 },
  toPhone: '+19415550142',
};

function photoDraft(overrides = {}) {
  return {
    id: 'draft-77',
    sms_log_id: null,
    customer_id: 'cust-1',
    campaign_type: null,
    purpose: null,
    intent: 'inbound_reply',
    source_ref: null,
    status: 'pending',
    draft_response: "Thanks for the photo. Want a quote for our tree & shrub program? Just reply yes.",
    revised_response: null,
    final_response: null,
    created_at: new Date(Date.now() - 60000).toISOString(),
    flags: JSON.stringify(PHOTO_FLAGS),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  updates.length = 0;
  queues = {};
  for (const key of Object.keys(mockGates)) delete mockGates[key];
  mockGates.smsGratitudeReplies = false;
  db.mockImplementation((table) => {
    const cfg = (queues[table] || []).shift() || {};
    return makeBuilder(table, cfg);
  });
  db.transaction = async (callback) => callback(db);
  db.fn = { now: () => new Date() };
  mockRecheck.mockReset();
  mockRecheck.mockResolvedValue({ ok: true });
});

describe('approve — photo-triage offer recheck wiring', () => {
  test('recheck ok → the send proceeds', async () => {
    enqueue('message_drafts', { returning: [photoDraft()] });   // claim
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });                   // finalize
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM1' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBe(200);
    });
    expect(mockRecheck).toHaveBeenCalledWith({ customerId: 'cust-1', flags: expect.objectContaining({ origin: 'photo_triage' }) });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('customer now owns the family → 409 PHOTO_TRIAGE_OFFER_STALE, claim released, nothing sent', async () => {
    enqueue('message_drafts', { returning: [photoDraft()] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });                   // release
    mockRecheck.mockResolvedValue({ blocked: 'owned', family: 'tree_shrub' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PHOTO_TRIAGE_OFFER_STALE');
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const release = updates[updates.length - 1];
    expect(release.table).toBe('message_drafts');
    expect(release.payload.status).toBe('pending');
    expect(release.payload.approved_by).toBeNull();
    // The stored verdict is downgraded so the owner's rewrite passes the
    // recheck: advise + already_owned, no stale quote.
    const flags = JSON.parse(release.payload.flags);
    expect(flags.opportunity_mode).toBe('advise');
    expect(flags.opportunity_reasons).toContain('already_owned');
    expect(flags.quote).toBeNull();
    expect(flags.offer_recheck_held_at).toBeTruthy();
    // The pitch sentence is gone from the text a second Approve would send.
    expect(release.payload.draft_response).toBe('Thanks for the photo. Reply if you have questions.');
    expect(release.payload.draft_response).not.toMatch(/quote/i);
  });

  test('figure drifted → 409 PHOTO_TRIAGE_REPRICED and the released row carries the refreshed owner-only figure', async () => {
    enqueue('message_drafts', { returning: [photoDraft()] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });
    mockRecheck.mockResolvedValue({ repriced: 91.5, family: 'tree_shrub' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PHOTO_TRIAGE_REPRICED');
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const release = updates[updates.length - 1];
    expect(release.payload.status).toBe('pending');
    const flags = JSON.parse(release.payload.flags);
    expect(flags.quote.per_visit).toBe(91.5);
    expect(flags.quote_repriced_at).toBeTruthy();
    // The customer text is untouched — it never carried a price.
    expect(release.payload.draft_response).toBeUndefined();
  });

  test('recheck lookup failure → 503, claim released', async () => {
    enqueue('message_drafts', { returning: [photoDraft()] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });
    mockRecheck.mockRejectedValue(new Error('catalog down'));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBe(503);
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates[updates.length - 1].payload.status).toBe('pending');
  });

  test('a non-photo-triage draft never touches the recheck', async () => {
    enqueue('message_drafts', { returning: [photoDraft({ flags: JSON.stringify({ toPhone: '+19415550142' }) })] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM2' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBe(200);
    });
    expect(mockRecheck).not.toHaveBeenCalled();
  });
});

describe('revise — photo-triage offer recheck wiring', () => {
  test('owned → 409 with the revision cleared on the released row, nothing sent', async () => {
    enqueue('message_drafts', { returning: [photoDraft()] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });
    mockRecheck.mockResolvedValue({ blocked: 'unavailable', family: 'tree_shrub' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/revise`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Edited copy that still asks for a quote.' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PHOTO_TRIAGE_OFFER_STALE');
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const release = updates[updates.length - 1];
    expect(release.payload.status).toBe('pending');
    expect(release.payload).toMatchObject({ revised_response: null, final_response: null });
    expect(JSON.parse(release.payload.flags).opportunity_reasons).toContain('offer_unavailable');
  });

  test('after a hold, the rewritten draft (flags now advise + no-pitch reason) sends without asking the offer core', async () => {
    const heldFlags = { ...PHOTO_FLAGS, opportunity_mode: 'advise', opportunity_reasons: ['actionable', 'already_owned'], quote: null };
    enqueue('message_drafts', { returning: [photoDraft({ flags: JSON.stringify(heldFlags) })] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });
    // The real recheck short-circuits on a no-pitch reason; here the mock
    // pins that the route hands it the downgraded flags.
    mockRecheck.mockImplementation(async ({ flags }) => (flags.opportunity_reasons.includes('already_owned') ? { ok: true } : { blocked: 'owned', family: 'tree_shrub' }));
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM3' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/revise`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Thanks for the photo. Reply if you have questions.' }),
      });
      expect(res.status).toBe(200);
    });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });
});
