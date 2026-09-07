/**
 * POST /admin/communications/customer-link — the Insert Link sheet's other
 * per-customer links (review_request | pay_balance | estimate | referral |
 * autopay_setup).
 * Pins the same fail-closed recipient contract as /reschedule-link
 * (admin-only, full 10-digit phone, kind allowlist), which builder each kind
 * dispatches to (account ids vs the phone-owning primary id), the response
 * shape. Builder internals
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
  REVIEW_GATE_REASONS: jest.requireActual('../services/composer-customer-links').REVIEW_GATE_REASONS,
  buildReviewRequestLink: jest.fn(),
  buildPayBalanceLink: jest.fn(),
  buildLatestEstimateLink: jest.fn(),
  buildReferralLink: jest.fn(),
  buildAutopaySetupLink: jest.fn(),
  buildAppointmentPageLink: jest.fn(),
  buildCardRequestLink: jest.fn(),
  buildPrepGuideLink: jest.fn(),
  buildServiceReportLink: jest.fn(),
  buildContractSigningLink: jest.fn(),
  buildStatementLink: jest.fn(),
  buildProjectReportLink: jest.fn(),
}));
jest.mock('../services/prep-guide-sender', () => ({
  isSupportedPestType: () => true,
  isSupportedChannel: () => true,
  sendPrepToCustomer: jest.fn(),
}));
// The card funnel's own live-status set — the route narrows its visit pick to it.
jest.mock('../services/appointment-card-request', () => ({ LIVE_VISIT_STATUSES: ['pending', 'confirmed'] }));
jest.mock('../services/review-request', () => ({
  sendGatedAsk: jest.fn(),
  findInlineAwaitingEmail: jest.fn(async () => null),
  sendInlineEmailCopy: jest.fn(),
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

// scheduled_services: the shared soonestUpcomingVisit pick (whereIn/where/
// orderBy/limit/offset chain ending in select).
function makeVisitsBuilder(rows = []) {
  const b = {};
  for (const m of ['whereIn', 'where', 'orderBy', 'limit', 'offset']) b[m] = jest.fn(() => b);
  b.select = jest.fn(() => Promise.resolve(rows));
  return b;
}

function wireDb({ customers, reviewRequests = makeReviewRequestsBuilder(), visits = makeVisitsBuilder() }) {
  db.mockImplementation((table) => {
    if (table === 'customers') return customers;
    if (table === 'scheduled_services') return visits;
    return reviewRequests;
  });
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

  test('autopay_setup: dispatches the phone-owning customer id (Auto Pay is per row)', async () => {
    wireDb({ customers: soloCustomer() });
    builders.buildAutopaySetupLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/secure/tok123',
      line: 'Hi PersonA! Set up Auto Pay for your Waves service here: https://portal.wavespestcontrol.com/secure/tok123\n\n',
      standalone: true,
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'autopay_setup' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(builders.buildAutopaySetupLink).toHaveBeenCalledWith(CUSTOMER_UUID);
      expect(body.kind).toBe('autopay_setup');
      expect(body.url).toContain('/secure/tok123');
      expect(body.line).toContain('Set up Auto Pay');
      // The resolved owner rides back so the composer selects it and the
      // /sms send carries customerId; the line is inserted as-is.
      expect(body.customerId).toBe(CUSTOMER_UUID);
      expect(body.standalone).toBe(true);
    });
  });

  test('autopay_setup: 409 when the phone belongs to more than one sibling — with or without a customerId', async () => {
    // Two rows on one account share the number: referral falls back to the
    // sorted first id, but Auto Pay must never guess (a consented card can
    // enroll on the spot). A body customerId is no proof of an operator
    // pick (thread open auto-fills it), so the check applies either way.
    const siblingsSharingPhone = () => makeCustomersBuilder({
      selectResults: [
        [{ id: 'aaaa1111-0000-4000-8000-000000000001', account_id: 'acct-1' }, { id: 'aaaa1111-0000-4000-8000-000000000002', account_id: 'acct-1' }],
        [{ id: 'aaaa1111-0000-4000-8000-000000000001' }, { id: 'aaaa1111-0000-4000-8000-000000000002' }],
        [{ first_name: 'PersonA' }],
        [{ id: 'aaaa1111-0000-4000-8000-000000000001' }, { id: 'aaaa1111-0000-4000-8000-000000000002' }],
      ],
    });
    wireDb({ customers: siblingsSharingPhone() });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'autopay_setup' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/profile instead/);
      expect(builders.buildAutopaySetupLink).not.toHaveBeenCalled();
    });
    // Explicit customerId path: the selected-customer branch issues a
    // customers.first() then the account expansion select, then the
    // firstName select, then the shared-phone rows.
    const picked = makeCustomersBuilder({
      firstRow: { id: 'aaaa1111-0000-4000-8000-000000000001', phone: '+15551234567', account_id: 'acct-1' },
      selectResults: [
        [{ id: 'aaaa1111-0000-4000-8000-000000000001' }, { id: 'aaaa1111-0000-4000-8000-000000000002' }],
        [{ first_name: 'PersonA' }],
        [{ id: 'aaaa1111-0000-4000-8000-000000000001' }, { id: 'aaaa1111-0000-4000-8000-000000000002' }],
      ],
    });
    wireDb({ customers: picked });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', {
        phone: '+15551234567', customerId: 'aaaa1111-0000-4000-8000-000000000001', kind: 'autopay_setup',
      });
      expect(res.status).toBe(409);
      expect(builders.buildAutopaySetupLink).not.toHaveBeenCalled();
    });
  });

  test('autopay_setup: auto_secured answers 200 with autoSecured and no url — a success, not a 404', async () => {
    wireDb({ customers: soloCustomer() });
    builders.buildAutopaySetupLink.mockResolvedValue({ url: null, line: '', autoSecured: true });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'autopay_setup' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ kind: 'autopay_setup', url: null, autoSecured: true, firstName: 'PersonA' });
    });
  });

  test('project_report: dispatch the whole account id set; rides the owner back (account-scoped customer bearer — /sms applies the recipient\'s consent policy)', async () => {
    wireDb({ customers: soloCustomer() });
    builders.buildProjectReportLink.mockResolvedValue({ url: 'https://portal.wavespestcontrol.com/report/project/persona-ffffffffffff', line: 'Here is your WDO report: https://portal.wavespestcontrol.com/report/project/persona-ffffffffffff\n\n', immediateOnly: true, projectReport: { id: 'p1', title: 'WDO', projectType: 'wdo', projectDate: '2026-08-10' } });
    await withServer(async (baseUrl) => {
      wireDb({ customers: soloCustomer() });
      const report = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'project_report' });
      expect(report.status).toBe(200);
      expect(builders.buildProjectReportLink).toHaveBeenCalledWith([CUSTOMER_UUID]);
      const reportBody = await report.json();
      expect(reportBody).toMatchObject({ kind: 'project_report', immediateOnly: true, projectReport: { title: 'WDO' }, customerId: CUSTOMER_UUID });
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

  // Quick Links review channel (owner ruling 2026-09-03).
  describe('review_request channel', () => {
    test('sms (default) and both mint the inline link; both echoes its channel', async () => {
      wireDb({ customers: soloCustomer() });
      builders.buildReviewRequestLink.mockResolvedValue({
        url: 'https://portal.wavespestcontrol.com/l/rv333', line: 'x', requestId: 'rr-1',
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel: 'both' });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ channel: 'both', requestId: 'rr-1' });
        expect(ReviewService.sendGatedAsk).not.toHaveBeenCalled();
      });
    });

    test('email sends the review email now through the gated engine path — nothing to insert', async () => {
      wireDb({ customers: soloCustomer() });
      ReviewService.sendGatedAsk.mockResolvedValue({ outcome: 'sent', requestId: 'rr-9' });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel: 'email' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ kind: 'review_request', channel: 'email', sent: true, requestId: 'rr-9' });
        expect(body.url).toBeUndefined();
        expect(ReviewService.sendGatedAsk).toHaveBeenCalledWith(
          expect.objectContaining({ customerId: CUSTOMER_UUID, channel: 'email', triggeredBy: 'admin', strictChannel: true }),
        );
        expect(builders.buildReviewRequestLink).not.toHaveBeenCalled();
      });
    });

    test('email after a Both whose email leg failed re-sends the SAME inline row copy (no cooldown refusal)', async () => {
      wireDb({ customers: soloCustomer() });
      ReviewService.findInlineAwaitingEmail.mockResolvedValueOnce({ id: 'rr-texted' });
      ReviewService.sendInlineEmailCopy.mockResolvedValueOnce({ sent: true });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel: 'email' });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ channel: 'email', sent: true, requestId: 'rr-texted', retriedInline: true });
        expect(ReviewService.sendInlineEmailCopy).toHaveBeenCalledWith('rr-texted');
        expect(ReviewService.sendGatedAsk).not.toHaveBeenCalled();
      });

      // A failed retry keeps the leg's own reason.
      wireDb({ customers: soloCustomer() });
      ReviewService.findInlineAwaitingEmail.mockResolvedValueOnce({ id: 'rr-texted' });
      ReviewService.sendInlineEmailCopy.mockResolvedValueOnce({ sent: false, reason: 'prefs_unavailable' });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel: 'email' });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/could not be read — try again/);
      });

      // The owed-leg lookup fails CLOSED: never fall through to a fresh ask (r11 P2).
      wireDb({ customers: soloCustomer() });
      ReviewService.findInlineAwaitingEmail.mockRejectedValueOnce(new Error('db down'));
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel: 'email' });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ reason: 'owed_lookup_failed' });
        expect(ReviewService.sendGatedAsk).not.toHaveBeenCalled();
      });

      // An uncertain leg (post-dispatch throw) is never "try again" — the
      // provider may hold it (GH Codex #3856 r8 P2).
      wireDb({ customers: soloCustomer() });
      ReviewService.findInlineAwaitingEmail.mockResolvedValueOnce({ id: 'rr-texted' });
      ReviewService.sendInlineEmailCopy.mockResolvedValueOnce({ sent: false, reason: 'email_uncertain' });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel: 'email' });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/may or may not have gone out — check the customer's email log/);
      });
    });

    test('email: the toast names the resolved email contact, not the phone owner', async () => {
      const customers = soloCustomer();
      customers.first = jest.fn(() => Promise.resolve({
        first_name: 'PersonA', email: 'a@example.com', phone: '+15551234567',
        service_contact_name: 'Jamie Onsite', service_contact_email: 'jamie@example.com',
      }));
      wireDb({ customers });
      ReviewService.sendGatedAsk.mockResolvedValue({ outcome: 'sent', requestId: 'rr-9' });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel: 'email' });
        expect(res.status).toBe(200);
        expect((await res.json()).firstName).toBe('Jamie');
      });
    });

    test('email: a blocked outcome keeps the touch\'s own reason (transient ≠ no email on file)', async () => {
      wireDb({ customers: soloCustomer() });
      ReviewService.sendGatedAsk.mockResolvedValue({ outcome: 'blocked', reason: 'prefs_unavailable' });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel: 'email' });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/could not be read — try again/);
      });
      wireDb({ customers: soloCustomer() });
      ReviewService.sendGatedAsk.mockResolvedValue({ outcome: 'blocked', reason: 'opted_out' });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel: 'email' });
        expect((await res.json()).error).toMatch(/turned off/);
      });
    });

    test('email: a gate refusal is a 409 with the shared gate copy', async () => {
      wireDb({ customers: soloCustomer() });
      ReviewService.sendGatedAsk.mockResolvedValue({ outcome: 'cooldown' });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel: 'email' });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ outcome: 'cooldown', error: expect.stringMatching(/last 30 days/) });
      });
    });

    test('an unknown channel is a 400', async () => {
      wireDb({ customers: soloCustomer() });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel: 'fax' });
        expect(res.status).toBe(400);
        expect(ReviewService.sendGatedAsk).not.toHaveBeenCalled();
        expect(builders.buildReviewRequestLink).not.toHaveBeenCalled();
      });
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

  // POST /send-prep — a zero-confirmed send whose leg the provider MAY have
  // accepted must not read as "try again" (GH Codex #3856 r8 P2).
  describe('POST /send-prep', () => {
    const { sendPrepToCustomer } = require('../services/prep-guide-sender');
    test.each(['sms', 'email'])('a partial standalone guide does not promise a blocked %s retry', async (failedChannel) => {
      sendPrepToCustomer.mockResolvedValueOnce({
        ok: true, reason: 'partial', pestType: 'sprinkler_timer', label: 'Sprinkler Timer Guide', failedChannel,
        emailSent: failedChannel === 'sms', smsSent: failedChannel === 'email',
        emailAddress: 'recipient@example.com', phone: '+19415550101',
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'send-prep', { customerId: CUSTOMER_UUID, pestType: 'sprinkler_timer', channel: 'both' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.partial).toBe(true);
        expect(body.message).toContain(`${failedChannel === 'sms' ? 'Text' : 'Email'} delivery was not confirmed.`);
        expect(body.message).toContain('this one-time guide cannot be retried with Send prep guide');
        expect(body.message).not.toMatch(/send it again|try again/);
      });
    });

    test('no leg confirmed + an uncertain leg → check the log, not try again', async () => {
      sendPrepToCustomer.mockResolvedValueOnce({ ok: false, reason: 'send_failed', label: 'Flea', emailSent: false, emailUncertain: true, smsSent: false });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'send-prep', { customerId: CUSTOMER_UUID, pestType: 'flea', channel: 'email' });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe("The prep email may or may not have gone out — check the customer's email log before sending it again.");
      });
      // Both whose text could not be planned: the email went, the copy names the link reason.
      sendPrepToCustomer.mockResolvedValueOnce({ ok: true, reason: 'partial', failedChannel: 'sms', smsLinkReason: 'prep_page_taken', takenBy: 'Interior Pest Treatment', label: 'Lawn', emailSent: true, emailAddress: 'a@example.com', smsSent: false });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'send-prep', { customerId: CUSTOMER_UUID, pestType: 'lawn', channel: 'both' });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ partial: true, message: "Lawn prep emailed to a@example.com. The text was not sent — the customer's next visit already carries the Interior Pest Treatment prep page." });
      });
      // An automation already sending this guide: nothing to do by hand.
      sendPrepToCustomer.mockResolvedValueOnce({ ok: false, reason: 'prep_send_pending', label: 'Flea Treatment' });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'send-prep', { customerId: CUSTOMER_UUID, pestType: 'flea', channel: 'both' });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/already queued to send automatically/);
      });
      // A definite failure keeps the plain retry copy.
      sendPrepToCustomer.mockResolvedValueOnce({ ok: false, reason: 'send_failed', label: 'Flea', emailSent: false, smsSent: false });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'send-prep', { customerId: CUSTOMER_UUID, pestType: 'flea', channel: 'email' });
        expect((await res.json()).error).toMatch(/try again/);
      });
    });
  });

  test('statement: resolved as a PAYER from the recipient number; a unique customer on that number rides back for consent only (GH Codex #3844 r6 P1)', async () => {
    wireDb({ customers: makeCustomersBuilder({ selectResults: [[]] }) });
    builders.buildStatementLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/pay/statement/' + 'f'.repeat(64),
      line: 'You can view and pay statement S-31 securely here: https://portal.wavespestcontrol.com/pay/statement/' + 'f'.repeat(64) + '\n\n',
      immediateOnly: true,
      statement: { id: 31, number: 'S-31', total: 412.5, payerName: 'Gulf Coast PM' },
    });
    await withServer(async (baseUrl) => {
      // A customerId that does NOT own the number would 400 every other kind; a statement ignores it.
      const res = await post(baseUrl, 'customer-link', { phone: '+19415550100', kind: 'statement', customerId: CUSTOMER_UUID });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(builders.buildStatementLink).toHaveBeenCalledWith('9415550100');
      expect(body.statement).toEqual({ id: 31, number: 'S-31', total: 412.5, payerName: 'Gulf Coast PM' });
      expect(body.immediateOnly).toBe(true);
      // The AP phone is normally no customer's phone: nothing rides back.
      expect(body.customerId).toBeUndefined();
      expect(body.url).toBe('portal.wavespestcontrol.com/pay/statement/' + 'f'.repeat(64));
    });

    // One live customer row on the number → it rides back so the /sms send
    // carries customerId and the recipient's own consent policy applies; the
    // statement itself stays authorized against the payer (the builder is
    // called the same way). Two rows → the composer's selected customer when
    // it is one of them, else 409 — never a guess, never the lead policy for
    // a number one of those rows has opted out (GH Codex #3844 r7 P1).
    wireDb({ customers: makeCustomersBuilder({ selectResults: [[{ id: CUSTOMER_UUID }]] }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+19415550100', kind: 'statement' });
      expect(res.status).toBe(200);
      expect((await res.json()).customerId).toBe(CUSTOMER_UUID);
      expect(builders.buildStatementLink).toHaveBeenLastCalledWith('9415550100');
    });
    const SIBLING_UUID = 'bbbb2222-0000-4000-8000-000000000002';
    wireDb({ customers: makeCustomersBuilder({ selectResults: [[{ id: CUSTOMER_UUID }, { id: SIBLING_UUID }]] }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+19415550100', kind: 'statement' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/more than one customer/);
    });
    wireDb({ customers: makeCustomersBuilder({ selectResults: [[{ id: CUSTOMER_UUID }, { id: SIBLING_UUID }]] }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+19415550100', kind: 'statement', customerId: SIBLING_UUID });
      expect(res.status).toBe(200);
      expect((await res.json()).customerId).toBe(SIBLING_UUID);
    });

    builders.buildStatementLink.mockResolvedValue({ url: null, line: '', reason: "This number is not a payer's AP phone on file" });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'statement' });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/not a payer's AP phone/);
    });
  });

  test('appointment: the pick skips a candidate the page would not render as upcoming — grouped state included — and takes the next one (GH Codex #3844 r14 P2)', async () => {
    const NEXT_WEEK = require('../utils/datetime-et').etDateString(new Date(Date.now() + 7 * 86_400_000));
    const appointmentPublic = require('./../routes/appointment-public');
    const spy = jest.spyOn(appointmentPublic, 'pageStateForVisit');
    try {
      const grouped = { id: 'v-grp', customer_id: CUSTOMER_UUID, scheduled_date: NEXT_WEEK, window_start: '08:00', status: 'confirmed', visit_id: 'grp-1' };
      const later = { id: 'v-later', customer_id: CUSTOMER_UUID, scheduled_date: NEXT_WEEK, window_start: '13:00', status: 'confirmed' };
      spy.mockResolvedValueOnce({ state: 'pending_rebook', phase: null }).mockResolvedValueOnce({ state: 'upcoming', phase: null });
      wireDb({ customers: soloCustomer(), visits: makeVisitsBuilder([grouped, later]) });
      builders.buildAppointmentPageLink.mockResolvedValue({ url: 'https://wavespest.co/a/abc', line: 'x', appointment: { id: 'v-later' } });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'appointment' });
        expect(res.status).toBe(200);
      });
      expect(builders.buildAppointmentPageLink).toHaveBeenCalledWith(expect.objectContaining({ id: 'v-later' }));
      expect(spy).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'v-grp', visit_id: 'grp-1' }));
    } finally {
      spy.mockRestore();
    }
  });

  test('appointment + card_request: the route picks the soonest live visit and hands the row to the builder', async () => {
    // A week out in ET — a fixed near-today date rots into pageState 'past' (pre-push Codex P1).
    const NEXT_WEEK = require('../utils/datetime-et').etDateString(new Date(Date.now() + 7 * 86_400_000));
    const visit = { id: 'v1', customer_id: CUSTOMER_UUID, scheduled_date: NEXT_WEEK, window_start: '09:00', window_end: '11:00', service_type: 'Flea Treatment', status: 'confirmed' };
    wireDb({ customers: soloCustomer(), visits: makeVisitsBuilder([visit]) });
    builders.buildAppointmentPageLink.mockResolvedValue({
      url: 'https://wavespest.co/a/abc',
      line: 'Everything about your visit: https://wavespest.co/a/abc\n\n',
      appointment: { id: 'v1', scheduledDate: NEXT_WEEK, serviceType: 'Flea Treatment' },
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'appointment' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(builders.buildAppointmentPageLink).toHaveBeenCalledWith(visit);
      expect(body.appointment).toEqual({ id: 'v1', scheduledDate: NEXT_WEEK, serviceType: 'Flea Treatment' });
      // Account-scoped pick, but the text is a customer-specific bearer: the
      // phone owner rides back so the /sms send carries customerId and the
      // recipient's own consent policy applies (GH Codex #3844 r4 P1).
      expect(body.customerId).toBe(CUSTOMER_UUID);
    });

    const visits = makeVisitsBuilder([]);
    wireDb({ customers: soloCustomer(), visits });
    builders.buildCardRequestLink.mockResolvedValue({ url: null, line: '', reason: 'No upcoming appointment for this customer' });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'card_request' });
      expect(res.status).toBe(404);
      expect(builders.buildCardRequestLink).toHaveBeenCalledWith(null);
      // Card requests anchor on the phone OWNER's visits only, never a sibling's.
      expect(db.mock.calls.filter(([t]) => t === 'scheduled_services').length).toBeGreaterThan(0);
      // …and only on the funnel's own live statuses — a soonest 'rescheduled'
      // placeholder must not be picked here and rejected there (Codex r1 P1).
      expect(visits.whereIn).toHaveBeenCalledWith('status', ['pending', 'confirmed']);
      expect((await res.json()).error).toMatch(/No upcoming appointment/);
    });
  });

  test('service_report: dispatches the whole account id set, with the phone owner riding back (the text is customer-specific — GH Codex #3844 r4 P1)', async () => {
    wireDb({ customers: soloCustomer() });
    builders.buildServiceReportLink.mockResolvedValue({
      url: 'https://wavespest.co/report/abc',
      line: 'Here is your latest service report: https://wavespest.co/report/abc\n\n',
      immediateOnly: true,
      report: { id: 'r1', serviceDate: '2026-09-01', serviceType: 'Lawn Care' },
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'service_report' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(builders.buildServiceReportLink).toHaveBeenCalledWith([CUSTOMER_UUID]);
      expect(body.customerId).toBe(CUSTOMER_UUID);
      expect(body.immediateOnly).toBe(true);
      expect(body.report).toEqual({ id: 'r1', serviceDate: '2026-09-01', serviceType: 'Lawn Care' });
    });
  });

  test('contract: per customer ROW — the phone owner only, with the owner id riding back', async () => {
    wireDb({ customers: soloCustomer() });
    builders.buildContractSigningLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/contract/tokX',
      line: 'Please review and sign your Auto Pay Authorization here: https://portal.wavespestcontrol.com/contract/tokX\n\n',
      contract: { id: 'k1', title: 'Auto Pay Authorization', requiresSignature: true },
      expiresAt: '2026-10-03T00:00:00.000Z',
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'contract' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(builders.buildContractSigningLink).toHaveBeenCalledWith([CUSTOMER_UUID]);
      expect(body.customerId).toBe(CUSTOMER_UUID);
      expect(body.expiresAt).toBe('2026-10-03T00:00:00.000Z');
      expect(body.contract).toEqual({ id: 'k1', title: 'Auto Pay Authorization', requiresSignature: true });
    });
  });

  test('prep_guide: per customer ROW too — the phone owner\'s visits only (the page shows their name + address; /sms requires them to own it)', async () => {
    wireDb({ customers: soloCustomer() });
    builders.buildPrepGuideLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/prep/' + 'a'.repeat(32),
      line: 'Your prep checklist for the upcoming Flea Treatment is here: https://portal.wavespestcontrol.com/prep/' + 'a'.repeat(32) + '\n\n',
      prep: { pestType: 'flea', label: 'Flea Treatment', scheduledDate: '2026-09-20' },
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'prep_guide' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(builders.buildPrepGuideLink).toHaveBeenCalledWith([CUSTOMER_UUID]);
      expect(body.customerId).toBe(CUSTOMER_UUID);
    });
  });

  test('appointment: the visit pick excludes rescheduled placeholders — the page renders them as pending_rebook (pre-push Codex P1); the reschedule link keeps them', async () => {
    const visits = makeVisitsBuilder([]);
    wireDb({ customers: makeCustomersBuilder({ firstRow: { id: CUSTOMER_UUID, phone: '+15551234567', account_id: CUSTOMER_UUID }, selectResults: [[{ id: CUSTOMER_UUID }], [{ first_name: 'Ann' }], [{ id: CUSTOMER_UUID }]] }), visits });
    builders.buildAppointmentPageLink.mockResolvedValue({ url: null, line: '', reason: 'No upcoming appointment' });
    await withServer(async (baseUrl) => {
      await post(baseUrl, 'customer-link', { phone: '+15551234567', customerId: CUSTOMER_UUID, kind: 'appointment' });
      expect(visits.whereIn).toHaveBeenCalledWith('status', ['pending', 'confirmed']);
    });
  });

  test('appointment: a same-day live visit past its quoted window is skipped for the later real one — the page renders it as past (GH Codex #3844 r10 P1)', async () => {
    const elapsed = { id: 'v-past', customer_id: CUSTOMER_UUID, scheduled_date: '2020-01-01', window_start: '08:00', status: 'confirmed' };
    const later = { id: 'v-next', customer_id: CUSTOMER_UUID, scheduled_date: '2099-01-01', window_start: '08:00', status: 'pending' };
    const visits = makeVisitsBuilder([elapsed, later]);
    wireDb({ customers: makeCustomersBuilder({ firstRow: { id: CUSTOMER_UUID, phone: '+15551234567', account_id: CUSTOMER_UUID }, selectResults: [[{ id: CUSTOMER_UUID }], [{ first_name: 'Ann' }], [{ id: CUSTOMER_UUID }]] }), visits });
    builders.buildAppointmentPageLink.mockResolvedValue({ url: null, line: '', reason: 'x' });
    await withServer(async (baseUrl) => {
      await post(baseUrl, 'customer-link', { phone: '+15551234567', customerId: CUSTOMER_UUID, kind: 'appointment' });
      expect(builders.buildAppointmentPageLink).toHaveBeenCalledWith(later);
    });
  });

  test.each(['email', 'both'])('review_request by %s: 409 when two live siblings on the account share the phone — the emailed ask goes to the owner\'s own inbox, never an arbitrary row\'s (GH Codex #3856 r21 P1)', async (channel) => {
    wireDb({ customers: makeCustomersBuilder({
      selectResults: [
        [{ id: CUSTOMER_UUID, account_id: CUSTOMER_UUID }, { id: 'bbbb2222-0000-4000-8000-000000000002', account_id: CUSTOMER_UUID }], // number → one account
        [{ id: CUSTOMER_UUID }, { id: 'bbbb2222-0000-4000-8000-000000000002' }], // account expansion
        [{ first_name: 'PersonA' }, { first_name: 'PersonA' }], // greeting name
        [{ id: CUSTOMER_UUID }, { id: 'bbbb2222-0000-4000-8000-000000000002' }], // phone rows on the account
      ],
    }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'review_request', channel });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/more than one customer on this account/);
    });
  });

  test.each(['appointment', 'service_report'])('%s: 409 when two live siblings on the account share the phone and no customer was picked — the owner that rides back is never an arbitrary row (GH Codex #3844 r9 P1)', async (kind) => {
    wireDb({ customers: makeCustomersBuilder({
      selectResults: [
        [{ id: CUSTOMER_UUID, account_id: CUSTOMER_UUID }, { id: 'bbbb2222-0000-4000-8000-000000000002', account_id: CUSTOMER_UUID }], // number → one account
        [{ id: CUSTOMER_UUID }, { id: 'bbbb2222-0000-4000-8000-000000000002' }], // account expansion
        [{ first_name: 'PersonA' }, { first_name: 'PersonA' }], // greeting name
        [{ id: CUSTOMER_UUID }, { id: 'bbbb2222-0000-4000-8000-000000000002' }], // phone rows on the account
      ],
    }) });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/more than one customer on this account/);
    });
  });

  test('card_request: a same-day live visit whose arrival window has elapsed is skipped for the next eligible one — the funnel would mint for the missed visit (GH Codex #3851 r5 P2)', async () => {
    const { etDateString } = require('../utils/datetime-et');
    const TODAY = etDateString();
    const NEXT_WEEK = etDateString(new Date(Date.now() + 7 * 86_400_000));
    const elapsed = { id: 'v-missed', customer_id: CUSTOMER_UUID, scheduled_date: TODAY, window_start: null, window_end: '00:00', service_type: 'Flea Treatment', status: 'confirmed' };
    const later = { id: 'v-next', customer_id: CUSTOMER_UUID, scheduled_date: NEXT_WEEK, window_start: '09:00', window_end: '11:00', service_type: 'Flea Treatment', status: 'confirmed' };
    wireDb({ customers: soloCustomer(), visits: makeVisitsBuilder([elapsed, later]) });
    builders.buildCardRequestLink.mockResolvedValue({ url: 'https://portal.wavespestcontrol.com/secure/tok22', line: 'Secure: portal.wavespestcontrol.com/secure/tok22\n\n', standalone: true, immediateOnly: true });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'card_request' });
      expect(res.status).toBe(200);
      expect(builders.buildCardRequestLink).toHaveBeenCalledWith(later);
    });
  });

  test.each(['contract', 'card_request', 'prep_guide'])('%s: 409 when the phone belongs to more than one sibling — same rule as Auto Pay', async (kind) => {
    const other = 'bbbb2222-0000-4000-8000-000000000002';
    wireDb({
      customers: makeCustomersBuilder({
        selectResults: [
          [{ id: CUSTOMER_UUID, account_id: CUSTOMER_UUID }, { id: other, account_id: CUSTOMER_UUID }],
          [{ id: CUSTOMER_UUID }, { id: other }],
          [{ first_name: 'PersonA' }, { first_name: 'PersonA' }],
          [{ id: CUSTOMER_UUID }, { id: other }],
        ],
      }),
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/more than one customer on this account/);
      expect(builders.buildContractSigningLink).not.toHaveBeenCalled();
      expect(builders.buildCardRequestLink).not.toHaveBeenCalled();
      expect(builders.buildPrepGuideLink).not.toHaveBeenCalled();
    });
  });

  test('card_request: autoSecured answers 200 like Auto Pay — a success with nothing to insert', async () => {
    wireDb({ customers: soloCustomer(), visits: makeVisitsBuilder([{ id: 'v1', customer_id: CUSTOMER_UUID, scheduled_date: '2026-09-08', status: 'confirmed' }]) });
    builders.buildCardRequestLink.mockResolvedValue({ url: null, line: '', autoSecured: true });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'customer-link', { phone: '+15551234567', kind: 'card_request' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.autoSecured).toBe(true);
      expect(body.url).toBeNull();
    });
  });
});
