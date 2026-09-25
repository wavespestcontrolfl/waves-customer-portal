/**
 * Admin drafts route — photo-triage dispatch-time offer recheck (codex
 * #4810 r6) and the approve-as-written rule (r11: /revise refuses photo-triage
 * drafts). The recheck itself is pinned in photo-triage-opportunity.test.js;
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
  gateEnvTimestamp: jest.fn(() => null),
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
  ...jest.requireActual('../services/photo-triage-opportunity'),
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
  origin: 'photo_triage', gauge_version: 1, assessment_type: 'tree_shrub', offer_family: 'tree_shrub', opportunity_mode: 'quote',
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
    intent: 'photo_triage',
    source_ref: null,
    status: 'pending',
    draft_response: "Thanks for the photo. Want a quote for our tree & shrub program? Just reply yes.",
    revised_response: null,
    final_response: null,
    created_at: new Date(Date.now() - 60000).toISOString(),
    context_summary: 'Photo triage ran a tree_shrub assessment and gauged it as quote (actionable, quoted). Offer core priced tree_shrub at $83.33 per application — owner-only; the draft text carries no price. Review the assessment before approving.',
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
    expect(mockRecheck).toHaveBeenCalledWith({
      customerId: 'cust-1', flags: expect.objectContaining({ origin: 'photo_triage' }),
    });
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
    // The stale owner-only price sentence is gone from the context too.
    expect(release.payload.context_summary).not.toMatch(/\$83\.33/);
    expect(release.payload.context_summary).toMatch(/Held at approve: the customer now has tree_shrub on their plan/);
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
    // The owner-only context carries the NEW figure only.
    expect(release.payload.context_summary).toMatch(/\$91\.50 per application/);
    expect(release.payload.context_summary).not.toMatch(/\$83\.33/);
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
    enqueue('message_drafts', { returning: [photoDraft({ intent: 'inbound_reply', flags: JSON.stringify({ toPhone: '+19415550142' }) })] });
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

describe('approve — the recheck runs again at the pre-dispatch hook (codex #4810 r12)', () => {
  test('ok at the route → the same recheck is handed to sendCustomerMessage as preDispatchCheck; a late owned answer blocks there', async () => {
    enqueue('message_drafts', { returning: [photoDraft()] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });
    // Route-level check passes; the customer enrolls before the handoff.
    mockRecheck.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ blocked: 'owned', family: 'tree_shrub' });
    let late;
    sendCustomerMessage.mockImplementation(async (input) => {
      late = await input.preDispatchCheck({ channel: 'sms' });
      return { sent: false, blocked: true, code: late.code, reason: late.reason };
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
    expect(late).toMatchObject({ ok: false, code: 'PHOTO_TRIAGE_OFFER_STALE' });
    expect(mockRecheck).toHaveBeenCalledTimes(2);
    expect(mockRecheck.mock.calls[1][0]).toMatchObject({ customerId: 'cust-1', flags: expect.objectContaining({ origin: 'photo_triage' }) });
    // Claim handed back (failed-send path), nothing finalized as sent.
    expect(updates.some((u) => u.table === 'message_drafts' && u.payload.status === 'pending')).toBe(true);
    expect(updates.some((u) => u.payload.status === 'sent')).toBe(false);
  });
});

describe('approve — the late recheck also guards the provider handoff and keeps the retry contract (codex #4810 r13)', () => {
  test('the same check is passed as preProviderCheck; an outage there answers the retryable 503, never a raw error', async () => {
    enqueue('message_drafts', { returning: [photoDraft()] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });
    mockRecheck.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('db down: secret detail'));
    let atHandoff;
    sendCustomerMessage.mockImplementation(async (input) => {
      expect((await input.preDispatchCheck({ channel: 'sms' })).ok).toBe(true);
      atHandoff = await input.preProviderCheck({ channel: 'sms' });
      return { sent: false, blocked: true, code: atHandoff.code, reason: atHandoff.reason, retryable: atHandoff.retryable };
    });

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBe(503);
      body = await res.json();
    });
    expect(atHandoff).toMatchObject({ ok: false, code: 'PHOTO_TRIAGE_RECHECK_UNAVAILABLE', retryable: true });
    expect(body.code).toBe('PHOTO_TRIAGE_RECHECK_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toMatch(/secret detail/);
    expect(updates.some((u) => u.payload.status === 'sent')).toBe(false);
  });
});

describe('approve — the SMS row\'s current linkage wins over the draft\'s own customer_id (codex #4810 r15)', () => {
  test('a draft stamped for customer A whose SMS row now points at B rechecks against B', async () => {
    enqueue('message_drafts', { returning: [photoDraft({ sms_log_id: 'sms-9', customer_id: 'cust-A' })] });
    enqueue('sms_log', { first: { id: 'sms-9', from_phone: '+19415550142', to_phone: '+19415550000', customer_id: 'cust-B' } }); // recipient resolve
    enqueue('sms_log', { first: { id: 'sms-9', customer_id: 'cust-B' } });                                                          // guard re-read
    enqueue('message_drafts', { update: 1 });
    mockRecheck.mockResolvedValue({ blocked: 'recipient_changed', family: 'tree_shrub' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBe(409);
    });
    expect(mockRecheck).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-B' }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('approve — the late hooks re-read the SMS row linkage on every call (codex #4810 r16)', () => {
  test('a re-link during the send pipeline is seen by preDispatchCheck', async () => {
    enqueue('message_drafts', { returning: [photoDraft({ sms_log_id: 'sms-9', customer_id: 'cust-A' })] });
    enqueue('sms_log', { first: { id: 'sms-9', from_phone: '+19415550142', to_phone: '+19415550000', customer_id: 'cust-A' } }); // recipient resolve
    enqueue('sms_log', { first: { id: 'sms-9', customer_id: 'cust-A' } });   // route-level guard
    enqueue('sms_log', { first: { id: 'sms-9', customer_id: 'cust-B' } });   // late hook — re-linked meanwhile
    enqueue('message_drafts', { update: 1 });
    mockRecheck.mockImplementation(async ({ customerId }) => (customerId === 'cust-A' ? { ok: true } : { blocked: 'recipient_changed', family: 'tree_shrub' }));
    let late;
    sendCustomerMessage.mockImplementation(async (input) => {
      late = await input.preDispatchCheck({ channel: 'sms' });
      return { sent: false, blocked: true, code: late.code, reason: late.reason };
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
    expect(mockRecheck.mock.calls.map((c) => c[0].customerId)).toEqual(['cust-A', 'cust-B']);
    expect(late).toMatchObject({ ok: false, code: 'PHOTO_TRIAGE_OFFER_STALE' });
  });
});

describe('approve — recipient changed since the draft was gauged', () => {
  test('→ 409 PHOTO_TRIAGE_RECIPIENT_CHANGED, claim released, flags and text untouched, nothing sent', async () => {
    enqueue('message_drafts', { returning: [photoDraft()] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });
    mockRecheck.mockResolvedValue({ blocked: 'recipient_changed', family: 'tree_shrub' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PHOTO_TRIAGE_RECIPIENT_CHANGED');
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const release = updates[updates.length - 1].payload;
    expect(release.status).toBe('pending');
    expect(release).not.toHaveProperty('flags');
    expect(release).not.toHaveProperty('draft_response');
  });
});

describe('approve — recipient resolution', () => {
  test('a draft linked only through its sms_log row rechecks against THAT customer', async () => {
    enqueue('message_drafts', { returning: [photoDraft({ customer_id: null, sms_log_id: 'sms-5', flags: JSON.stringify({ ...PHOTO_FLAGS, toPhone: undefined }) })] });
    enqueue('sms_log', { first: { id: 'sms-5', customer_id: 'cust-linked', from_phone: '+19415550142', to_phone: '+19415550100' } });
    enqueue('message_drafts', { update: 1 });
    mockRecheck.mockResolvedValue({ blocked: 'owned', family: 'tree_shrub' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBe(409);
    });
    expect(mockRecheck).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-linked' }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('revise — photo-triage drafts are approve-as-written (codex #4810 r7–r11)', () => {
  test('a revision is refused: 409 PHOTO_TRIAGE_NOT_REVISABLE, claim released with the edit cleared, nothing rechecked or sent', async () => {
    enqueue('message_drafts', { returning: [photoDraft({ status: 'revised' })] });   // claim
    enqueue('message_drafts', { update: 1 });                                        // release

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/revise`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'We can do it for 80 dollars per application.' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PHOTO_TRIAGE_NOT_REVISABLE');
    });
    expect(mockRecheck).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const release = updates[updates.length - 1].payload;
    expect(release).toMatchObject({ status: 'pending', revised_response: null, final_response: null });
    expect(release).not.toHaveProperty('draft_response');
  });
});

describe('pre-gauge photo-triage drafts (no gauge_version) stay revisable and are held at approve (codex #4810 r14)', () => {
  const LEGACY_FLAGS = JSON.stringify({ origin: 'photo_triage', assessment_type: 'pest', assessment_id: 'a1', toPhone: '+19415550142' });

  test('approve → 409 PHOTO_TRIAGE_PRE_GAUGE, claim released, nothing sent', async () => {
    enqueue('message_drafts', { returning: [photoDraft({ flags: LEGACY_FLAGS })] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });
    mockRecheck.mockResolvedValue({ blocked: 'pre_gauge', family: null });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/approve`, { method: 'PUT' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PHOTO_TRIAGE_PRE_GAUGE');
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates[updates.length - 1].payload.status).toBe('pending');
  });

  test('revise is NOT refused for them — the owner can rewrite the old copy', async () => {
    enqueue('message_drafts', { returning: [photoDraft({ status: 'revised', flags: LEGACY_FLAGS })] });
    enqueue('customers', { first: { id: 'cust-1', phone: '+19415550142' } });
    enqueue('message_drafts', { update: 1 });
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM9' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/drafts/draft-77/revise`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisedResponse: 'Thanks for the photo. That looks like an ant species. Reply if you have questions.' }),
      });
      expect(res.status).toBe(200);
    });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });
});
