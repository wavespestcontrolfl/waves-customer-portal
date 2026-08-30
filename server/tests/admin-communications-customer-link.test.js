/**
 * POST /admin/communications/customer-link — the Insert Link sheet's other
 * per-customer links (review_request | pay_balance | estimate | referral).
 * Pins the same fail-closed recipient contract as /reschedule-link
 * (admin-only, full 10-digit phone, kind allowlist), which builder each kind
 * dispatches to (account ids vs the phone-owning primary id), the response
 * shape, and the /customer-link/cancel suppression rules. Builder internals
 * are covered by their own services — mocked here.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const role = token === 'admin' ? 'admin' : token === 'tech' ? 'technician' : null;
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: `${role}-1`, role };
    req.technicianId = `${role}-1`;
    req.techRole = role;
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  // Mirrors the real middleware: 403 for any non-admin staff role.
  requireAdmin: (req, res, next) => (
    req.techRole !== 'admin'
      ? res.status(403).json({ error: 'Admin access required' })
      : next()
  ),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/sms-media', () => ({
  mediaFromOutboundAttachments: jest.fn(() => []),
  signMediaForClient: jest.fn(async (media) => media),
}));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
}));
jest.mock('../services/sms-suggest-mode', () => ({
  SUGGEST_WORKFLOW: 'sms_house_voice_suggest',
  HUMAN_REPLY_TYPES: ['manual', 'ai_approved', 'ai_revised'],
  revertDraftsToShadow: jest.fn(async () => 0),
  markSuggestionScheduled: jest.fn(async () => 1),
  parkThreadSuggestions: jest.fn(async () => []),
  reopenScheduledSuggestions: jest.fn(async () => 0),
  ignoreParkedSuggestions: jest.fn(async () => 0),
  lockSuggestThread: jest.fn(async () => {}),
}));
jest.mock('../services/sms-auto-send', () => ({
  hasActiveAutoSendClaim: jest.fn(async () => false),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: () => true,
  gates: {},
  logGateStatus: jest.fn(),
}));
jest.mock('@anthropic-ai/sdk', () => (
  jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn() },
  }))
));
jest.mock('../services/composer-customer-links', () => ({
  buildReviewRequestLink: jest.fn(),
  buildPayBalanceLink: jest.fn(),
  buildLatestEstimateLink: jest.fn(),
  buildReferralLink: jest.fn(),
}));
jest.mock('../services/review-request', () => ({
  markInlineDeliveryFailed: jest.fn(async () => {}),
}));

const express = require('express');
const db = require('../models/db');
const communicationsRouter = require('../routes/admin-communications');
const builders = require('../services/composer-customer-links');
const ReviewService = require('../services/review-request');

const CUSTOMER_UUID = '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f';

function makeCustomersBuilder({ firstRow = null, selectResults = [] } = {}) {
  const queue = [...selectResults];
  const inner = {
    where: jest.fn(() => inner),
    orWhere: jest.fn(() => inner),
  };
  const b = { inner };
  b.where = jest.fn((...a) => {
    if (typeof a[0] === 'function') a[0](inner);
    return b;
  });
  b.whereNull = jest.fn(() => b);
  b.whereIn = jest.fn(() => b);
  b.whereRaw = jest.fn(() => b);
  b.first = jest.fn(() => Promise.resolve(firstRow));
  b.select = jest.fn(() => Promise.resolve(queue.length ? queue.shift() : []));
  return b;
}

function makeReviewRequestsBuilder(firstRow = null) {
  const b = {};
  b.where = jest.fn(() => b);
  b.first = jest.fn(() => Promise.resolve(firstRow));
  return b;
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/communications', communicationsRouter);
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

function post(baseUrl, path, body, token = 'admin') {
  return fetch(`${baseUrl}/admin/communications/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// Phone-only resolution issues four customers selects in order: exact-match
// rows, account expansion, firstNameForPhone, the primary-id phone rows.
function soloCustomer(id = CUSTOMER_UUID, firstName = 'PersonA') {
  return makeCustomersBuilder({
    selectResults: [
      [{ id, account_id: id }],
      [{ id }],
      [{ first_name: firstName }],
      [{ id }],
    ],
  });
}

function wireDb({ customers, reviewRequests = makeReviewRequestsBuilder() }) {
  db.mockImplementation((table) => (table === 'customers' ? customers : reviewRequests));
}

describe('POST /admin/communications/customer-link', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
  });

  test('403 for technicians — minting customer links is admin-only', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'referral' }, 'tech');
      expect(res.status).toBe(403);
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('400 on an unknown kind and on a missing/partial phone', async () => {
    await withServer(async (baseUrl) => {
      const badKind = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'password_reset' });
      expect(badKind.status).toBe(400);
      expect((await badKind.json()).error).toMatch(/kind must be one of/);

      const noPhone = await post(baseUrl, 'customer-link', { kind: 'referral' });
      expect(noPhone.status).toBe(400);
      expect((await noPhone.json()).error).toMatch(/full 10-digit/);
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('referral: dispatches the phone-owning customer id and returns url/line/firstName', async () => {
    wireDb({ customers: soloCustomer() });
    builders.buildReferralLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/r/WAVES-ABC12345',
      line: 'Know someone who needs pest control? Share Waves here: https://portal.wavespestcontrol.com/r/WAVES-ABC12345\n\n',
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'referral' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(builders.buildReferralLink).toHaveBeenCalledWith(CUSTOMER_UUID);
      expect(body.kind).toBe('referral');
      expect(body.firstName).toBe('PersonA');
      expect(body.url).toContain('/r/WAVES-ABC12345');
      expect(body.line).toContain('Share Waves here');
    });
  });

  test('estimate + pay_balance: dispatch the whole account id set', async () => {
    wireDb({ customers: soloCustomer() });
    builders.buildLatestEstimateLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/l/es111',
      line: 'You can view your estimate here: https://portal.wavespestcontrol.com/l/es111\n\n',
      estimate: { id: 'est-1', serviceType: 'Quarterly Pest Control', status: 'sent' },
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'estimate' });
      expect(res.status).toBe(200);
      expect(builders.buildLatestEstimateLink).toHaveBeenCalledWith([CUSTOMER_UUID]);
      expect((await res.json()).estimate.serviceType).toBe('Quarterly Pest Control');
    });

    wireDb({ customers: soloCustomer() });
    builders.buildPayBalanceLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/l/py222',
      line: 'You can view and pay your balance securely here: https://portal.wavespestcontrol.com/l/py222\n\n',
      balance: { total: 184, count: 2 },
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'pay_balance' });
      expect(res.status).toBe(200);
      expect(builders.buildPayBalanceLink).toHaveBeenCalledWith([CUSTOMER_UUID]);
      expect((await res.json()).balance).toEqual({ total: 184, count: 2 });
    });
  });

  test('review_request: returns the inline requestId the send/cancel lifecycle needs', async () => {
    wireDb({ customers: soloCustomer() });
    builders.buildReviewRequestLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/l/rv333',
      line: 'Would you share how we did? It takes 30 seconds: https://portal.wavespestcontrol.com/l/rv333\n\n',
      requestId: 'rr-1',
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(builders.buildReviewRequestLink).toHaveBeenCalledWith(CUSTOMER_UUID);
      expect(body.requestId).toBe('rr-1');
    });
  });

  test('404 with the builder\'s plain reason when there is nothing to link', async () => {
    wireDb({ customers: soloCustomer() });
    builders.buildPayBalanceLink.mockResolvedValue({ url: null, line: '', reason: 'No open balance on this account' });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'pay_balance' });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('No open balance on this account');
    });
  });
});

describe('POST /admin/communications/customer-link/cancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
  });

  test('suppresses a pending inline row and is idempotent for everything else', async () => {
    const pendingRow = { id: 'rr-1', status: 'pending', sms_sent_at: null, triggered_by: 'auto_inline' };
    wireDb({ customers: soloCustomer(), reviewRequests: makeReviewRequestsBuilder(pendingRow) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link/cancel', { requestId: 'rr-1' });
      expect(res.status).toBe(200);
      expect(ReviewService.markInlineDeliveryFailed).toHaveBeenCalledWith('rr-1');
    });

    // Already sent → left alone, still ok:true.
    const sentRow = { id: 'rr-2', status: 'sent', sms_sent_at: new Date(), triggered_by: 'auto_inline' };
    wireDb({ customers: soloCustomer(), reviewRequests: makeReviewRequestsBuilder(sentRow) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link/cancel', { requestId: 'rr-2' });
      expect(res.status).toBe(200);
      expect(ReviewService.markInlineDeliveryFailed).toHaveBeenCalledTimes(1);
    });

    // A row minted by a DIFFERENT flow (a real queued ask) must never be
    // suppressed through this endpoint.
    const cronRow = { id: 'rr-3', status: 'pending', sms_sent_at: null, triggered_by: 'auto' };
    wireDb({ customers: soloCustomer(), reviewRequests: makeReviewRequestsBuilder(cronRow) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link/cancel', { requestId: 'rr-3' });
      expect(res.status).toBe(200);
      expect(ReviewService.markInlineDeliveryFailed).toHaveBeenCalledTimes(1);
    });
  });

  test('403 for technicians, 400 without a requestId', async () => {
    await withServer(async (baseUrl) => {
      const forbidden = await post(baseUrl, 'customer-link/cancel', { requestId: 'rr-1' }, 'tech');
      expect(forbidden.status).toBe(403);
      const missing = await post(baseUrl, 'customer-link/cancel', {});
      expect(missing.status).toBe(400);
      expect(db).not.toHaveBeenCalled();
    });
  });
});
