process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// DELETE /admin/communications/scheduled/:id (codex P1, review-ask-queued
// #4334): an uncertain scheduled review-ask send holds its 72h ask-spacing
// evidence in the row itself (metadata.review_ask_reservation). Physically
// deleting that row on cancel erased the only evidence the attempt ever
// happened, letting the next ask bypass the hold. Canceling it now leaves a
// row behind — status 'canceled', reservation marker intact — that
// review-ask-history's lastManualAskAt still reads regardless of status.
// Every other scheduled row keeps the original delete-on-cancel behavior.

// Minimal in-memory table so the real route handler runs against real SQL
// shapes (where/first/update/del with RETURNING) without a live database.
jest.mock('../models/db', () => {
  const store = { sms_log: {} };
  const matches = (row, filter) => Object.entries(filter).every(([k, v]) => row[k] === v);
  const pick = (row, cols) => cols.reduce((out, c) => { out[c] = row[c]; return out; }, {});
  const metadataOf = (row) => {
    if (!row) return {};
    return typeof row.metadata === 'string' ? (JSON.parse(row.metadata || '{}') || {}) : (row.metadata || {});
  };
  // Recognizes the raw SQL fragments the writer actually sends — the same
  // substring-matching convention this codebase's other hand-rolled db
  // mocks already use (e.g. scheduled-sms-review-dispatch.test.js).
  // `entry_point` mirrors production's real predicate (workflowOwnerOf,
  // the same function the writer's SQL exclusion encodes) rather than a
  // hand-copied condition, so this mock can never drift from it. Required
  // lazily (inside the predicate, not at factory-eval time) — this factory
  // itself IS the '../models/db' module scheduled-sms-cancel.js requires,
  // so requiring it up front here would be circular.
  const whereRawPredicates = {
    review_ask_reservation: (row) => metadataOf(row).review_ask_reservation !== true,
    replay_purpose: (row) => !require('../services/scheduled-sms-cancel').workflowOwnerOf(metadataOf(row)),
  };
  function builder(table) {
    let filter = {};
    let rawPredicates = [];
    const qb = {
      where(cond) { filter = { ...filter, ...cond }; return qb; },
      whereRaw(sql) {
        const hit = Object.entries(whereRawPredicates).find(([needle]) => sql.includes(needle));
        if (hit) rawPredicates.push(hit[1]);
        return qb;
      },
      async first(...cols) {
        const row = Object.values(store[table] || {}).find((r) => matches(r, filter) && rawPredicates.every((p) => p(r)));
        if (!row) return undefined;
        return cols.length ? pick(row, cols) : { ...row };
      },
      async update(patch, returning) {
        // A concurrent writer's effects (e.g. the dispatch cron's own claim
        // + requeue) become visible to this statement's WHERE evaluation at
        // the instant it runs, exactly like a real atomic UPDATE — never
        // against a snapshot read earlier. Tests hook this to simulate that
        // race landing right before THIS statement executes.
        if (db.__beforeMutate) db.__beforeMutate(table, 'update', filter);
        const rows = Object.values(store[table] || {}).filter((r) => matches(r, filter) && rawPredicates.every((p) => p(r)));
        rows.forEach((r) => Object.assign(r, patch));
        return returning ? rows.map((r) => pick(r, returning)) : rows.length;
      },
      async del(returning) {
        if (db.__beforeMutate) db.__beforeMutate(table, 'del', filter);
        const rows = Object.values(store[table] || {}).filter((r) => matches(r, filter) && rawPredicates.every((p) => p(r)));
        rows.forEach((r) => { delete store[table][r.id]; });
        return returning ? rows.map((r) => pick(r, returning)) : rows.length;
      },
    };
    return qb;
  }
  const db = (table) => builder(table);
  db.transaction = async (cb) => cb(db);
  db.__store = store;
  db.__beforeMutate = null;
  return db;
});
jest.mock('../services/twilio', () => ({}));
const mockReconcileLedger = jest.fn(async () => undefined);
jest.mock('../services/recruiting-comms', () => ({ reconcileCommsHistoryEntryByOutcome: (...args) => mockReconcileLedger(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token !== 'admin') return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: 'admin-1', role: 'admin' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) =>
    (req.techRole !== 'admin' ? res.status(403).json({ error: 'Admin access required' }) : next()),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/autopay-setup-link', () => ({ KIND: 'customer', setupLinkIneligibility: jest.fn() }));
jest.mock('../services/appointment-card-request', () => ({
  LIVE_VISIT_STATUSES: ['pending', 'confirmed'],
  TEMPLATE_KEY: 'secure_appointment_card',
  PLAN_TEMPLATE_KEY: 'secure_appointment_card_plans',
  planInviteApplies: jest.fn(async () => false),
  renderTemplate: jest.fn(async () => null),
  startInvitationEmailLeg: jest.fn(),
  requestCardForAppointment: jest.fn(async () => ({ requested: false, action: 'link_created', reason: 'request_exists', secureUrl: 'https://portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY' })),
  markCardLinkSendOutcome: jest.fn(async () => true),
  claimCardLinkSend: jest.fn(async () => false),
}));
jest.mock('../services/payer-statement-email', () => ({ markStatementSent: jest.fn() }));
jest.mock('../routes/admin-contracts', () => ({
  activatePreparedShareLinks: jest.fn(async (links) => ({ ok: true, activations: links })),
  restorePreparedShareLinks: jest.fn(async () => {}),
  recordPreparedShareLinkSends: jest.fn(async () => {}),
  unsignableContractReason: jest.fn(async () => null),
  shareLinkWritableStatuses: () => ['draft', 'sent', 'viewed'],
}));
jest.mock('../services/sms-media', () => ({
  mediaFromOutboundAttachments: jest.fn(() => []),
  signMediaForClient: jest.fn(async (media) => media),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}) }));
// Only lockSuggestThread runs on this route's happy path (decisionIds stays
// empty for every row these tests seed); the rest are stubbed inert so the
// module loads — their own behavior belongs to sms-suggest-mode.test.js.
jest.mock('../services/sms-suggest-mode', () => ({
  SUGGEST_WORKFLOW: 'sms_house_voice_suggest',
  HUMAN_REPLY_TYPES: ['manual', 'ai_approved', 'ai_revised'],
  revertDraftsToShadow: jest.fn(async () => 0),
  markSuggestionScheduled: jest.fn(async () => 1),
  parkThreadSuggestions: jest.fn(async () => []),
  createReplyHoldingReservation: jest.fn(async () => 'resv-1'),
  settleReplyHoldingReservation: jest.fn(async () => true),
  reopenScheduledSuggestions: jest.fn(async () => 0),
  ignoreParkedSuggestions: jest.fn(async () => 0),
  sweepStaleSuggestionsAfterReply: jest.fn(async () => undefined),
  lockSuggestThread: jest.fn(async () => {}),
}));
jest.mock('../services/sms-auto-send', () => ({
  hasActiveAutoSendClaim: jest.fn(async () => false),
  isRealProviderSend: jest.fn(() => false),
  isAmbiguousProviderOutcome: jest.fn(() => false),
}));
jest.mock('../services/review-request', () => ({
  claimInlineForSend: jest.fn(async () => null),
  inlineClaimStillHeld: jest.fn(async () => true),
  releaseInlineClaim: jest.fn(async () => {}),
  markInlineDelivered: jest.fn(async () => {}),
  sendInlineEmailCopy: jest.fn(async () => ({ sent: true })),
  reviewSmsAllowedNow: jest.fn(async () => ({ allowed: true })),
  checkUnscheduledAskGates: jest.fn(async () => ({ allowed: true })),
}));
jest.mock('../services/review-ask-history', () => ({
  ...jest.requireActual('../services/review-ask-history'),
  lastDeliveredAskAt: jest.fn(async () => null),
  lastManualAskAt: jest.fn(async () => null),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_key, fn) => fn()),
  wasLockSkipped: (r) => !!(r && r.skipped === true),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  existingShortUrlFor: jest.fn(async () => null),
  allShortUrlsFor: jest.fn(async () => []),
  createTrackedShortLink: jest.fn(async (url) => ({ code: null, shortUrl: url })),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
  shortLinkBaseUrl: () => 'https://wavespest.co',
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => true, gates: {}, logGateStatus: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

const express = require('express');
const db = require('../models/db');
const suggest = require('../services/sms-suggest-mode');
const communicationsRouter = require('../routes/admin-communications');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/communications', communicationsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
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

function seedScheduledRow(id, overrides = {}) {
  db.__store.sms_log[id] = {
    id, direction: 'outbound', to_phone: '+19415551234', status: 'scheduled',
    message_body: 'Please leave a Google review.', metadata: {}, created_at: new Date(),
    ...overrides,
  };
}

async function cancel(baseUrl, id) {
  const response = await fetch(`${baseUrl}/admin/communications/scheduled/${id}`, {
    method: 'DELETE', headers: { Authorization: 'Bearer admin' },
  });
  return { status: response.status, body: await response.json() };
}

describe('DELETE /admin/communications/scheduled/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.__store.sms_log = {};
    db.__beforeMutate = null;
  });

  test('a queued review-ask retry is canceled in place, keeping its reservation as spacing evidence', async () => {
    seedScheduledRow('sms-1', {
      metadata: { review_ask_reservation: true, scheduled_sms_attempts: 3 },
    });

    const { status, body } = await withServer((baseUrl) => cancel(baseUrl, 'sms-1'));

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    const row = db.__store.sms_log['sms-1'];
    expect(row).toBeDefined();
    expect(row.status).toBe('canceled');
    expect(row.metadata).toMatchObject({ review_ask_reservation: true, scheduled_sms_attempts: 3 });
  });

  test('a review-ask reservation stored as a JSON metadata string is still recognized', async () => {
    seedScheduledRow('sms-json', {
      metadata: JSON.stringify({ review_ask_reservation: true }),
    });

    await withServer((baseUrl) => cancel(baseUrl, 'sms-json'));

    const row = db.__store.sms_log['sms-json'];
    expect(row).toBeDefined();
    expect(row.status).toBe('canceled');
  });

  test('an admin cancelling a queued recruiting text settles its comms_history entry (deferred → blocked) so the queue stops promising an automatic send (#4623 r17)', async () => {
    seedScheduledRow('sms-r', {
      message_type: 'job_application_received',
      metadata: { entry_point: 'recruiting_comms_deferred', job_application_id: 'app-1', ledger_entry_id: 'entry-1', audience: 'applicant' },
    });
    mockReconcileLedger.mockClear();

    const { status } = await withServer((baseUrl) => cancel(baseUrl, 'sms-r'));

    expect(status).toBe(200);
    expect(db.__store.sms_log['sms-r']).toBeUndefined();
    expect(mockReconcileLedger).toHaveBeenCalledTimes(1);
    const [appId, entryId, transitions] = mockReconcileLedger.mock.calls[0];
    expect(appId).toBe('app-1');
    expect(entryId).toBe('entry-1');
    expect(transitions).toEqual({ deferred: expect.objectContaining({ outcome: 'blocked', code: 'cancelled_by_admin' }) });
  });

  test('an ordinary scheduled message (no reservation marker) is still physically deleted', async () => {
    seedScheduledRow('sms-2');

    const { status, body } = await withServer((baseUrl) => cancel(baseUrl, 'sms-2'));

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.__store.sms_log['sms-2']).toBeUndefined();
  });

  test('a row the dispatch cron already claimed before the request arrived (status already sending) is left untouched', async () => {
    seedScheduledRow('sms-3', {
      status: 'sending',
      metadata: { review_ask_reservation: true },
    });

    const { status, body } = await withServer((baseUrl) => cancel(baseUrl, 'sms-3'));

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    const row = db.__store.sms_log['sms-3'];
    expect(row).toBeDefined();
    expect(row.status).toBe('sending');
    // Never matched 'scheduled', so the route never opens the thread lock.
    expect(suggest.lockSuggestThread).not.toHaveBeenCalled();
  });

  // codex P1 (pre-push local audit on #4334): the marker must not be read
  // once and acted on later — a scheduled row that gains the marker between
  // the route's decision and its write used to still get physically
  // deleted, because the earlier read never saw it. The fix folds the
  // marker check into the SAME statement that mutates the row, so there is
  // no snapshot for a concurrent writer (the dispatch cron's own claim +
  // requeue) to invalidate. Simulated here by mutating the store — from
  // outside the route's own transaction — at the exact instant the route's
  // first mutating statement (the conditional DELETE) runs, exactly where a
  // real concurrent transaction's commit would become visible.
  test('a marker that appears concurrently, right as the route mutates, still cancels in place instead of deleting', async () => {
    seedScheduledRow('sms-race', { metadata: {} });
    let fired = false;
    db.__beforeMutate = (table, op, filter) => {
      if (!fired && table === 'sms_log' && op === 'del' && filter.id === 'sms-race') {
        fired = true;
        // The dispatch cron claimed this row, attempted an uncertain send,
        // and requeued it with the reservation marker — all landing in the
        // instant between this request's transaction opening and its
        // conditional DELETE actually running.
        db.__store.sms_log['sms-race'].metadata = { review_ask_reservation: true };
      }
    };

    const { status, body } = await withServer((baseUrl) => cancel(baseUrl, 'sms-race'));

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(fired).toBe(true);
    const row = db.__store.sms_log['sms-race'];
    expect(row).toBeDefined();
    expect(row.status).toBe('canceled');
    expect(row.metadata).toMatchObject({ review_ask_reservation: true });
  });

  test('canceling an unknown id is a no-op success', async () => {
    const { status, body } = await withServer((baseUrl) => cancel(baseUrl, 'does-not-exist'));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });

  // Found during #5224's pre-push audit: this writer reconciles recruiting
  // texts, review-ask reservations and parked Agent Review decisions, but
  // never the deferred-replay registry's own terminal/finalize handling
  // (onTerminal/finalize) — that only runs inside the scheduled-sms
  // executor. Deleting a workflow-owned row here would strand its
  // obligation exactly like a bare status flip used to (Codex round 1's
  // original bug). invoice_send_deferred registers no onTerminal hook at
  // all (it just holds its invoice's send claim) — proof the refusal must
  // key off registry OWNERSHIP (isDeferredReplayEntryPoint), not "has an
  // onTerminal hook".
  test('a workflow-owned scheduled row (deferred-replay entry point, no onTerminal hook) is refused with 409, completely untouched', async () => {
    seedScheduledRow('sms-wf', {
      message_type: 'invoice',
      metadata: { entry_point: 'invoice_send_deferred', invoice_id: 'inv-1' },
    });

    const { status, body } = await withServer((baseUrl) => cancel(baseUrl, 'sms-wf'));

    expect(status).toBe(409);
    expect(body.error).toMatch(/automated workflow \(invoice send deferred\)/i);
    const row = db.__store.sms_log['sms-wf'];
    expect(row).toBeDefined();
    expect(row.status).toBe('scheduled');
    expect(row.metadata).toMatchObject({ entry_point: 'invoice_send_deferred' });
  });

  // Ownership is NOT limited to the deferred-replay registry: several
  // producers park scheduled rows under entry points the registry does not
  // list (estimate_deposit_receipt_requeue, referral_nudge_deferred, ...),
  // and review asks ride replay_purpose / bundled_review_request_id.
  test.each([
    ['a non-registry entry_point (deposit receipt requeue)', { entry_point: 'estimate_deposit_receipt_requeue', estimate_id: 'e-1' }, /deposit receipt requeue/i],
    ['a replay_purpose with no entry_point', { replay_purpose: 'review_request' }, /review request/i],
    ['a bundled review request', { bundled_review_request_id: 'rr-1' }, /review request/i],
  ])('refuses %s with 409 and leaves the row untouched', async (_label, metadata, re) => {
    seedScheduledRow('sms-own', { metadata });

    const { status, body } = await withServer((baseUrl) => cancel(baseUrl, 'sms-own'));

    expect(status).toBe(409);
    expect(body.error).toMatch(re);
    expect(db.__store.sms_log['sms-own']).toMatchObject({ status: 'scheduled' });
  });

  test('a plain staff-scheduled row (human_authored only) still deletes', async () => {
    seedScheduledRow('sms-plain', { metadata: { human_authored: true } });

    const { status, body } = await withServer((baseUrl) => cancel(baseUrl, 'sms-plain'));

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.__store.sms_log['sms-plain']).toBeUndefined();
  });

  // recruiting_comms_deferred is registry-owned too, but this writer
  // already reconciles it inline (reconcileCancelledRecruitingText, tested
  // above) to the same outcome its own onTerminal hook would produce — the
  // one entry point exempt from the workflow-owned refusal.
  test('a recruiting_comms_deferred row is still cancelled (its own inline reconciliation), never refused as workflow-owned', async () => {
    seedScheduledRow('sms-r2', {
      message_type: 'job_application_received',
      metadata: { entry_point: 'recruiting_comms_deferred', job_application_id: 'app-2', ledger_entry_id: 'entry-2' },
    });

    const { status, body } = await withServer((baseUrl) => cancel(baseUrl, 'sms-r2'));

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.__store.sms_log['sms-r2']).toBeUndefined();
  });

  // Agent-Review-linked and staff rows carry none of the workflow-ownership
  // markers, so the refusal predicate must never match them (the writer's
  // own re-park/reopen handling keeps covering decision-linked rows; that
  // path needs a richer db mock than this file's and is covered by
  // sms-suggest-mode.test.js).
  test('workflowOwnerOf: decision-linked, parked and plain staff metadata are not workflow-owned; the recruiting entry point is exempt', () => {
    const { workflowOwnerOf } = require('../services/scheduled-sms-cancel');
    expect(workflowOwnerOf({ agent_decision_id: 'dec-1' })).toBeNull();
    expect(workflowOwnerOf({ parked_decision_ids: ['dec-1'] })).toBeNull();
    expect(workflowOwnerOf({ human_authored: true })).toBeNull();
    expect(workflowOwnerOf({ review_ask_reservation: true })).toBeNull();
    expect(workflowOwnerOf({})).toBeNull();
    expect(workflowOwnerOf(null)).toBeNull();
    expect(workflowOwnerOf({ entry_point: 'recruiting_comms_deferred', replay_purpose: 'x' })).toBeNull();
    expect(workflowOwnerOf({ entry_point: 'referral_nudge_deferred' })).toBe('referral_nudge_deferred');
  });

  // Fable review on #5364, P2: the inline recruiting reconcile only maps
  // 'deferred' → 'blocked', so an already-attempted recruiting row (ledger at
  // 'handoff') must be refused, not exempted.
  test('workflowOwnerOf: an attempted recruiting row (finalize_only or provider retry) is workflow-owned', () => {
    const { workflowOwnerOf } = require('../services/scheduled-sms-cancel');
    expect(workflowOwnerOf({ entry_point: 'recruiting_comms_deferred', finalize_only: true })).toBe('recruiting_comms_deferred');
    expect(workflowOwnerOf({ entry_point: 'recruiting_comms_deferred', provider_retry_at: '2026-09-30T00:00:00Z' })).toBe('recruiting_comms_deferred');
    expect(workflowOwnerOf({ entry_point: 'recruiting_comms_deferred', scheduled_sms_recovered_at: '2026-09-30T00:00:00Z' })).toBe('recruiting_comms_deferred');
    expect(workflowOwnerOf({ entry_point: 'recruiting_comms_deferred', finalize_only: false })).toBeNull();
  });

  // Fable review on #5364, P2: the AI auto-reply provider retry holds no state
  // outside its row, and the IB tool refuses it — the inbox stays its cancel path.
  test('workflowOwnerOf: the stateless AI auto-reply retry stays deletable', () => {
    const { workflowOwnerOf } = require('../services/scheduled-sms-cancel');
    expect(workflowOwnerOf({ entry_point: 'twilio_inbound_ai_assistant_retry', provider_retry: true })).toBeNull();
  });

  test('workflowOwnerOf: a non-empty falsy bundled_review_request_id is owned, matching the SQL twin', () => {
    const { workflowOwnerOf } = require('../services/scheduled-sms-cancel');
    expect(workflowOwnerOf({ bundled_review_request_id: 0 })).toBe('review request');
    expect(workflowOwnerOf({ bundled_review_request_id: '' })).toBeNull();
  });

  test('an attempted recruiting row is refused from the inbox and left in place', async () => {
    seedScheduledRow('sms-rec-attempted', {
      metadata: { entry_point: 'recruiting_comms_deferred', finalize_only: true, job_application_id: 'app-3', ledger_entry_id: 'entry-3' },
    });
    const { status } = await withServer((baseUrl) => cancel(baseUrl, 'sms-rec-attempted'));
    expect(status).toBe(409);
    expect(mockReconcileLedger).not.toHaveBeenCalled();
    expect(db.__store.sms_log['sms-rec-attempted']).toBeDefined();
  });

  // Same race shape as the review-ask-reservation race test above, for the
  // new CAS: an entry_point stamped by a concurrent writer between this
  // request's pre-check and its own conditional DELETE must still refuse —
  // never delete a row that became workflow-owned mid-flight.
  test('an entry_point stamped concurrently, right as the route mutates, refuses instead of deleting', async () => {
    seedScheduledRow('sms-wf-race', { metadata: {} });
    let fired = false;
    db.__beforeMutate = (table, op, filter) => {
      if (!fired && table === 'sms_log' && op === 'del' && filter.id === 'sms-wf-race') {
        fired = true;
        db.__store.sms_log['sms-wf-race'].metadata = { entry_point: 'invoice_send_deferred' };
      }
    };

    const { status, body } = await withServer((baseUrl) => cancel(baseUrl, 'sms-wf-race'));

    expect(status).toBe(409);
    expect(body.error).toMatch(/automated workflow \(invoice send deferred\)/i);
    expect(fired).toBe(true);
    const row = db.__store.sms_log['sms-wf-race'];
    expect(row).toBeDefined();
    expect(row.status).toBe('scheduled'); // never deleted, never cancelled in place
  });
});
