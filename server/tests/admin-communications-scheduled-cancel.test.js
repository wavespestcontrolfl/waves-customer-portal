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
  function builder(table) {
    let filter = {};
    const qb = {
      where(cond) { filter = { ...filter, ...cond }; return qb; },
      async first(...cols) {
        const row = Object.values(store[table] || {}).find((r) => matches(r, filter));
        if (!row) return undefined;
        return cols.length ? pick(row, cols) : { ...row };
      },
      async update(patch, returning) {
        const rows = Object.values(store[table] || {}).filter((r) => matches(r, filter));
        rows.forEach((r) => Object.assign(r, patch));
        return returning ? rows.map((r) => pick(r, returning)) : rows.length;
      },
      async del(returning) {
        const rows = Object.values(store[table] || {}).filter((r) => matches(r, filter));
        rows.forEach((r) => { delete store[table][r.id]; });
        return returning ? rows.map((r) => pick(r, returning)) : rows.length;
      },
    };
    return qb;
  }
  const db = (table) => builder(table);
  db.transaction = async (cb) => cb(db);
  db.__store = store;
  return db;
});
jest.mock('../services/twilio', () => ({}));
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

  test('canceling an unknown id is a no-op success', async () => {
    const { status, body } = await withServer((baseUrl) => cancel(baseUrl, 'does-not-exist'));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });
});
