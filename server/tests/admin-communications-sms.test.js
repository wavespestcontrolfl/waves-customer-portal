process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  // The /sms route wraps suggestion parking and the post-send sweep in
  // db.transaction; pass the mock itself through as the trx handle.
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
    if (token !== 'admin') return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: 'admin-1', role: 'admin' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) =>
    (req.techRole !== 'admin'
      ? res.status(403).json({ error: 'Admin access required' })
      : next()),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/autopay-setup-link', () => ({ KIND: 'customer', setupLinkIneligibility: jest.fn() }));
// The card funnel + its marker finalizer, re-run / invoked by the composer send.
jest.mock('../services/appointment-card-request', () => ({
  LIVE_VISIT_STATUSES: ['pending', 'confirmed'],
  TEMPLATE_KEY: 'secure_appointment_card',
  PLAN_TEMPLATE_KEY: 'secure_appointment_card_plans',
  planInviteApplies: jest.fn(async () => false),
  renderTemplate: jest.fn(async () => null),
  startInvitationEmailLeg: jest.fn(),
  requestCardForAppointment: jest.fn(async () => ({ requested: false, action: 'link_created', reason: 'request_exists', secureUrl: 'https://portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY' })),
  markCardLinkSendOutcome: jest.fn(async () => true),
  // The service claim, observed through the route: NULL → stamp on the db mock.
  claimCardLinkSend: jest.fn(async (visitId, stamp) => {
    const db = require('../models/db');
    const updated = await db('scheduled_services').where({ id: visitId }).whereNull('card_link_sent_at').update({ card_link_sent_at: stamp, updated_at: stamp });
    return updated === 1;
  }),
}));
jest.mock('../services/payer-statement-email', () => ({ markStatementSent: jest.fn() }));
// The share-link writer's send-time half (activate before the provider call,
// restore on a no-send exit, record after a real send) — its own suite covers
// the writes; the route tests pin WHEN the route calls each.
jest.mock('../routes/admin-contracts', () => ({
  activatePreparedShareLinks: jest.fn(async (links) => ({ ok: true, activations: links.map((l) => ({ ...l, customerId: 'cust-A', previous: { status: 'draft', shared_at: null } })) })),
  restorePreparedShareLinks: jest.fn(async () => {}),
  recordPreparedShareLinkSends: jest.fn(async () => {}),
  unsignableContractReason: jest.fn(async () => null),
  shareLinkWritableStatuses: (c) => (c?.contract_type === 'document_template' ? ['draft', 'sent', 'viewed', 'expired'] : ['draft', 'sent', 'viewed']),
}));
jest.mock('../services/sms-media', () => ({
  mediaFromOutboundAttachments: jest.fn(() => []),
  signMediaForClient: jest.fn(async (media) => media),
}));
jest.mock('../services/twilio-failure-alerts', () => ({
  // Returns a promise like the real one — the /sms catch path chains .catch on it.
  alertTwilioFailure: jest.fn(async () => {}),
}));
// Inert suggest-mode plumbing: the route fails CLOSED if pre-send parking
// throws (503), and the bare db mock above can't run the real park
// transaction. The suggest-mode lifecycle has its own suites
// (sms-suggest-mode.test.js, agent-decisions-suggest-guard.test.js) —
// these route tests only need the hooks to succeed quietly.
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
// Inert auto-send executor: the /sms route checks for an in-flight autonomous
// reply under the park lock. Default to "none in flight" so the send tests
// proceed; the executor's own behavior is covered by sms-auto-send.test.js.
jest.mock('../services/sms-auto-send', () => ({
  hasActiveAutoSendClaim: jest.fn(async () => false),
  isRealProviderSend: jest.fn((r) => r?.sent === true
    && (!r.deliveryOutcome || r.deliveryOutcome === 'accepted')
    && !!r.providerMessageId
    && !['gate-blocked', 'template-disabled', 'owner-silence', 'owner-sms-disabled'].includes(r.providerMessageId)),
  isAmbiguousProviderOutcome: jest.fn((r) => {
    if (!r) return false;
    if (r.deliveryOutcome === 'uncertain') return true;
    if (['accepted', 'not_sent'].includes(r.deliveryOutcome)) return false;
    if (r.deliveryOutcome != null) return true;
    return r.sent !== true && !r.blocked && Boolean(r.retryable || r.deferred);
  }),
}));
// The inline review claim boundary: the route must verify + claim BEFORE the
// provider call and abort on any validation miss (fail closed — the tokenized
// review page carries customer data).
jest.mock('../services/review-request', () => ({
  claimInlineForSend: jest.fn(async () => new Date('2026-08-31T03:00:00.000Z')),
  inlineClaimStillHeld: jest.fn(async () => true),
  releaseInlineClaim: jest.fn(async () => {}),
  markInlineDelivered: jest.fn(async () => {}),
  sendInlineEmailCopy: jest.fn(async () => ({ sent: true })),
  reviewSmsAllowedNow: jest.fn(async () => ({ allowed: true })),
  checkUnscheduledAskGates: jest.fn(async () => ({ allowed: true })),
}));
// The send seam re-validates consent + gates + claim under the per-customer
// review lock; with the bare db mock the real lock would fail closed
// (skipped: no_connection), so run the body inline here.
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
// Controllable gates: the auto-send interlock (claim check + reservation row)
// is gated on smsAutoSend, OFF by default so the manual send path is unchanged
// for the existing tests. One test flips it on via mockGates.smsAutoSend.
const mockGates = { smsAutoSend: false };
jest.mock('../config/feature-gates', () => ({
  isEnabled: (gate) => (gate === 'smsAutoSend' ? mockGates.smsAutoSend : true),
  gates: {},
  logGateStatus: jest.fn(),
}));
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => (
  jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  }))
));

const express = require('express');
const db = require('../models/db');
const communicationsRouter = require('../routes/admin-communications');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { hasActiveAutoSendClaim } = require('../services/sms-auto-send');
const suggestMode = require('../services/sms-suggest-mode');
const smsMedia = require('../services/sms-media');

function makeQueryBuilder(rows = []) {
  const calls = { limit: [], offset: [] };
  const builder = {
    calls,
    leftJoin: jest.fn(() => builder),
    whereNull: jest.fn(() => builder),
    whereRaw: jest.fn(() => builder),
    where: jest.fn((arg) => {
      if (typeof arg === 'function') arg.call(builder, builder);
      return builder;
    }),
    select: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    whereNot: jest.fn(() => builder),
    orWhereNull: jest.fn(() => builder),
    orWhere: jest.fn(() => builder),
    orWhereRaw: jest.fn(() => builder),
    limit: jest.fn((value) => {
      calls.limit.push(value);
      return builder;
    }),
    offset: jest.fn((value) => {
      calls.offset.push(value);
      return builder;
    }),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return builder;
}

function makeFirstQueryBuilder(row = null) {
  const builder = {
    where: jest.fn(() => builder),
    whereNull: jest.fn(() => builder),
    first: jest.fn(() => Promise.resolve(row)),
  };
  return builder;
}

// Permissive chainable builder for paths that issue arbitrary queries (e.g. the
// gate-on reservation insert + delete and the post-send sweep). insert→returning
// yields a row id; everything else resolves empty/null.
function makeUniversalBuilder() {
  const b = {};
  const chain = () => b;
  for (const m of ['where', 'whereNull', 'whereNot', 'whereIn', 'whereRaw', 'leftJoin', 'join', 'joinRaw', 'select', 'orderBy', 'groupBy', 'distinct', 'limit', 'offset', 'insert', 'update', 'onConflict', 'ignore', 'merge', 'count']) {
    b[m] = jest.fn(chain);
  }
  b.returning = jest.fn(() => Promise.resolve([{ id: 'resv-1' }]));
  b.first = jest.fn(() => Promise.resolve(null));
  b.del = jest.fn(() => Promise.resolve(1));
  b.pluck = jest.fn(() => Promise.resolve([]));
  b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return b;
}

function smsMessageRow(overrides = {}) {
  return {
    id: 'message-1',
    conversation_id: 'conversation-1',
    direction: 'inbound',
    body: 'Hello',
    status: 'received',
    message_type: 'manual',
    created_at: new Date('2026-05-20T12:00:00Z'),
    media: null,
    is_read: false,
    read_at: null,
    customer_id: 'customer-1',
    our_endpoint_id: '+19413187612',
    contact_phone: '+15551234567',
    first_name: 'Ada',
    last_name: 'Lovelace',
    customer_phone: '+15551234567',
    ...overrides,
  };
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

describe('admin communications SMS route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    mockGates.smsAutoSend = false;
  });

  test('cleans rewrite model labels and quotes before returning SMS copy', () => {
    expect(
      communicationsRouter._internals.cleanSmsRewriteOutput('SMS: "Hello Taylor, we can help with that."'),
    ).toBe('Hello Taylor, we can help with that.');
    expect(
      communicationsRouter._internals.cleanSmsRewriteOutput('Waves Pest Control: Hello Taylor, we can help.'),
    ).toBe('Hello Taylor, we can help.');
  });

  test('builds SMS rewrite prompt with Waves tone and fact-preservation guardrails', () => {
    const prompt = communicationsRouter._internals.buildSmsRewritePrompt({
      body: 'we will b their at 8 and it is $250',
      customer: {
        first_name: 'Taylor',
        last_name: 'Reed',
        city: 'Sarasota',
        waveguard_tier: 'Green',
      },
      lastInboundMessage: 'Can you confirm price?',
      recentMessages: [
        { direction: 'inbound', body: 'Can you confirm price?' },
        { direction: 'outbound', body: 'It is $250.' },
      ],
    });

    expect(prompt).toContain('Keep the Waves style');
    expect(prompt).toContain('Preserve the operator\'s exact meaning');
    expect(prompt).toContain('Do not invent details');
    expect(prompt).toContain('Customer context: name: Taylor Reed, city: Sarasota, tier: Green');
    expect(prompt).toContain('Customer: Can you confirm price?');
    expect(prompt).toContain('Draft:\nwe will b their at 8 and it is $250');
  });

  test('requires a full phone before SMS rewrite customer context lookup', () => {
    const { fullPhoneLast10 } = communicationsRouter._internals;
    expect(fullPhoneLast10('555-123-4567')).toBe('5551234567');
    expect(fullPhoneLast10('+1 (555) 123-4567')).toBe('5551234567');
    expect(fullPhoneLast10('4567')).toBe('');
    expect(fullPhoneLast10('')).toBe('');
  });

  test('rejects selected SMS rewrite customer context when phone mismatches recipient', async () => {
    const customerBuilder = makeFirstQueryBuilder({
      id: 'customer-1',
      phone: '+15551234567',
      first_name: 'Ada',
      last_name: 'Lovelace',
      city: 'Sarasota',
      waveguard_tier: 'Green',
    });
    db.mockReturnValueOnce(customerBuilder);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/rewrite-sms`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          body: 'can be there tomorow',
          customerId: 'customer-1',
          customerPhone: '+15557654321',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('customerPhone must match the selected customer phone');
      expect(customerBuilder.where).toHaveBeenCalledWith({ id: 'customer-1' });
      expect(customerBuilder.whereNull).toHaveBeenCalledWith('deleted_at');
      expect(mockAnthropicCreate).not.toHaveBeenCalled();
    });
  });

  // Codex 07-18: the registry defines smsToneRewrite on SMS_SONNET
  // (config/models.js) and sms-draft-canary deliberately skips a separate
  // probe because this endpoint shares the save-the-sale model. Dispatching
  // the generic customer-copy policy (MODEL_VOICE) here would silently run
  // rewrites on the wrong model whenever MODEL_SMS_SONNET/MODEL_VOICE
  // diverge, bypassing the SMS override/canary contract. Identity pins (toBe)
  // so an equal-but-different route object still fails.
  test('rewrite-sms dispatches the dedicated smsToneRewrite registry route with the Terra backup', async () => {
    const MODELS = require('../config/models');
    const llmCall = require('../services/llm/call');
    const dispatchSpy = jest.spyOn(llmCall, 'dispatchWithFallback')
      .mockResolvedValue({ ok: true, text: 'Hi Ada — we can be there tomorrow at 8am.' });

    try {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/communications/rewrite-sms`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ body: 'can be there tomorow at 8' }),
        });
        const resBody = await res.json();
        expect(res.status).toBe(200);
        expect(resBody.body).toBe('Hi Ada — we can be there tomorrow at 8am.');
      });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const [policy, payload] = dispatchSpy.mock.calls[0];
      expect(policy.primary).toBe(MODELS.ROUTES.smsToneRewrite);
      expect(policy.fallback).toBe(MODELS.TEXT_POLICIES.customerCopy.fallback);
      expect(payload).toMatchObject({ jsonMode: false, maxTokens: 500 });
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  test('returns a readable error when policy blocks a send', async () => {
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'EMOJI_FOR_CUSTOMER',
      reason: 'Body contains emoji "👍" but audience="lead" forbids it. Customer/lead-facing messages must be emoji-free.',
      segmentCount: 1,
      encoding: 'UCS_2',
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: '+15551234567',
          body: 'Sounds good 👍',
          messageType: 'manual',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.error).toBe('Body contains emoji "👍" but audience="lead" forbids it. Customer/lead-facing messages must be emoji-free.');
      expect(body.code).toBe('EMOJI_FOR_CUSTOMER');
    });
  });

  test('allows desktop manual sends with exact quote prices', async () => {
    sendCustomerMessage.mockResolvedValue({
      sent: true,
      blocked: false,
      providerMessageId: 'SM123',
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: '+15551234567',
          body: 'A one-time treatment is $250.',
          messageType: 'manual',
        }),
      });

      expect(res.status).toBe(200);
      expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
        entryPoint: 'admin_communications_manual_sms',
        metadata: expect.objectContaining({
          original_message_type: 'manual',
          adminUserId: 'admin-1',
        }),
      }));
    });
  });

  describe('Auto Pay setup link in the body (delivery seam)', () => {
    const SECURE_BODY = 'Set it up here: https://portal.wavespestcontrol.com/secure/abcDEF123_-xyz789QWERTY';
    function wireAutopayDb({ row, owner = { id: 'cust-A', phone: '+15551234567' } }) {
      require('../services/autopay-setup-link').setupLinkIneligibility.mockResolvedValue({ reason: null, customer: owner });
      db.mockImplementation((table) => {
        const first = jest.fn();
        if (table === 'sms_templates') first.mockResolvedValue({ is_active: true });
        else if (table === 'customers') first.mockResolvedValue(owner);
        const select = jest.fn(async () => (table === 'appointment_card_requests' && row ? [{ token: 'abcDEF123_-xyz789QWERTY', ...row }] : []));
        const update = jest.fn(async (payload) => { stamps.push({ table, payload }); return 1; });
        return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), first, select, update };
      });
    }
    const stamps = [];
    beforeEach(() => { stamps.length = 0; });
    const send = (baseUrl, extra = { customerId: 'cust-A' }) => fetch(`${baseUrl}/admin/communications/sms`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '+15551234567', body: SECURE_BODY, messageType: 'manual', ...extra }),
    });

    test('a live link reclassifies the send as an Auto Pay customer SMS', async () => {
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM1' });
      wireAutopayDb({ row: { id: 'r1', kind: 'customer', status: 'pending', expires_at: new Date(Date.now() + 86400e3), customer_id: 'cust-A' } });
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl);
        expect(res.status).toBe(200);
        expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
          metadata: expect.objectContaining({
            original_message_type: 'autopay_setup_link',
            autopay_setup_tokens: ['abcDEF123_-xyz789QWERTY'],
          }),
        }));
        // The durable request records the send — sent_at only, never
        // updated_at (the completion lease token).
        const stamp = stamps.find((s) => s.table === 'appointment_card_requests');
        expect(stamp).toBeTruthy();
        expect(Object.keys(stamp.payload)).toEqual(['sent_at']);
      });
    });

    // Visit-lane card request in the body: the composer send runs the
    // service's own one-text mechanics — claim the visit BEFORE the
    // provider call, mark the request after a real send, release otherwise.
    const CARD = { id: 'r9', kind: 'visit', status: 'pending', customer_id: 'cust-A', scheduled_service_id: 'v-77', sent_at: null, token: 'abcDEF123_-xyz789QWERTY' };
    function wireCardDb({ claimResult = 1 } = {}) {
      db.mockImplementation((table) => {
        const first = jest.fn();
        if (table === 'customers') first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
        else if (table === 'appointment_card_requests') first.mockResolvedValue(CARD);
        else if (table === 'scheduled_services') first.mockResolvedValue({ id: 'v-77', customer_id: 'cust-A', service_type: 'Flea Treatment', scheduled_date: '2026-09-08' });
        // The Auto Pay seam's token lookup sees the same visit-lane row and leaves it alone.
        const select = jest.fn(async () => (table === 'appointment_card_requests' ? [{ token: 'abcDEF123_-xyz789QWERTY', ...CARD }] : []));
        const update = jest.fn(async (payload) => {
          stamps.push({ table, payload, sent: sendCustomerMessage.mock.calls.length });
          return table === 'scheduled_services' && payload.card_link_sent_at instanceof Date ? claimResult : 1;
        });
        return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), first, select, update };
      });
    }

    test('a live visit-lane card request link: the visit is claimed BEFORE the provider call, the send is the card request itself (purpose, template key, operator-initiated — GH Codex #3844 r5 P1), the request marked and the email twin started after a real send', async () => {
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM2' });
      const { startInvitationEmailLeg } = require('../services/appointment-card-request');
      startInvitationEmailLeg.mockClear();
      wireCardDb();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl);
        expect(res.status).toBe(200);
        expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
          purpose: 'card_request',
          customerId: 'cust-A',
          identityTrustLevel: 'phone_matches_customer',
          operatorInitiated: true,
          metadata: expect.objectContaining({ original_message_type: 'secure_appointment_card', scheduled_service_id: 'v-77', trigger: 'admin' }),
        }));
        expect(startInvitationEmailLeg).toHaveBeenCalledWith({
          visit: expect.objectContaining({ id: 'v-77', customer_id: 'cust-A' }),
          secureUrl: expect.stringMatching(/\/secure\/abcDEF123_-xyz789QWERTY$/),
          planChoice: false,
        });
        const claim = stamps.find((s) => s.table === 'scheduled_services');
        expect(Object.keys(claim.payload).sort()).toEqual(['card_link_sent_at', 'updated_at']);
        expect(claim.sent).toBe(0); // claimed before dispatch
        // The canonical funnel was re-run at the send, then the service's own finalizer marked the request.
        const { requestCardForAppointment, markCardLinkSendOutcome } = require('../services/appointment-card-request');
        expect(requestCardForAppointment).toHaveBeenCalledWith({ scheduledServiceId: 'v-77', trigger: 'admin', delivery: 'inline' });
        expect(markCardLinkSendOutcome).toHaveBeenCalledWith('v-77', claim.payload.card_link_sent_at);
        expect(stamps.filter((s) => s.table === 'scheduled_services')).toHaveLength(1); // never released
      });
    });

    test('the funnel refusing at the send (visit repriced to $0 meanwhile) refuses BEFORE any claim or provider call', async () => {
      const { requestCardForAppointment } = require('../services/appointment-card-request');
      requestCardForAppointment.mockResolvedValueOnce({ requested: false, action: 'skipped', reason: 'zero_price_visit' });
      wireCardDb();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/nothing to secure/);
        expect(sendCustomerMessage).not.toHaveBeenCalled();
        expect(stamps.find((s) => s.table === 'scheduled_services')).toBeUndefined();
      });
    });

    test('a verified statement link: a real send stamps finalized → sent through the email delivery\'s writer; a suppressed send does not', async () => {
      const STMT_BODY = `Pay here: portal.wavespestcontrol.com/pay/statement/${'f'.repeat(64)}`;
      const { markStatementSent } = require('../services/payer-statement-email');
      db.mockImplementation((table) => {
        const first = jest.fn();
        if (table === 'payer_statements') first.mockResolvedValue({ id: 31, payer_id: 7, status: 'finalized' });
        else if (table === 'payers') first.mockResolvedValue({ id: 7, ap_phone: '+15551234567' });
        return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), whereRaw: jest.fn(function () { return this; }), first, select: jest.fn(async () => []), update: jest.fn(async () => 1) };
      });
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM3' });
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { body: STMT_BODY });
        expect(res.status).toBe(200);
        // The operator behind the composer send is the child closeouts' actor (GitHub r10 P2 #4127).
        expect(markStatementSent).toHaveBeenCalledWith(31, expect.anything(), { actorTechnicianId: 'admin-1', actorRole: 'admin' });
      });
      markStatementSent.mockClear();
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, suppressed: true });
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { body: STMT_BODY });
        expect(res.status).toBe(200);
        expect(markStatementSent).not.toHaveBeenCalled();
      });
    });

    test('a lost claim (another send owns the visit, or a text already went) refuses BEFORE any provider call', async () => {
      wireCardDb({ claimResult: 0 });
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/already being sent, or was already texted/);
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      });
    });

    test('a suppressed (non-provider) send releases the claim, never marks the request and starts no email twin', async () => {
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, suppressed: true });
      const { startInvitationEmailLeg } = require('../services/appointment-card-request');
      startInvitationEmailLeg.mockClear();
      wireCardDb();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl);
        expect(res.status).toBe(200);
        expect(startInvitationEmailLeg).not.toHaveBeenCalled();
        const visitWrites = stamps.filter((s) => s.table === 'scheduled_services');
        expect(visitWrites).toHaveLength(2);
        expect(visitWrites[1].payload.card_link_sent_at).toBeNull();
        expect(stamps.find((s) => s.table === 'appointment_card_requests')).toBeUndefined();
      });
    });

    test('a RETRYABLE provider outcome (timeout / 5xx / 429 — the provider may hold the text) keeps the claim: the maybe-sent marker lands, no release, no email twin (GH Codex #3851 r4 P1)', async () => {
      sendCustomerMessage.mockResolvedValue({ sent: false, blocked: false, code: 'PROVIDER_FAILURE', retryable: true, deferred: true });
      const { startInvitationEmailLeg, markCardLinkSendOutcome } = require('../services/appointment-card-request');
      startInvitationEmailLeg.mockClear();
      markCardLinkSendOutcome.mockClear();
      wireCardDb();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl);
        expect(res.status).toBe(422);
        const visitWrites = stamps.filter((s) => s.table === 'scheduled_services');
        expect(visitWrites).toHaveLength(1); // the claim — never released
        expect(markCardLinkSendOutcome).toHaveBeenCalledWith('v-77', visitWrites[0].payload.card_link_sent_at);
        expect(startInvitationEmailLeg).not.toHaveBeenCalled();
      });
    });

    test('a THROW carrying a retryable provider outcome (audit write failed after a Twilio timeout) holds the claim the same way — marker stamped, never released (GH Codex #3851 r5 P1)', async () => {
      const ambiguous = new Error('audit row failed');
      ambiguous.providerOutcome = { sent: false, retryable: true, providerErrorCode: 'ETIMEDOUT' };
      sendCustomerMessage.mockRejectedValueOnce(ambiguous);
      const { startInvitationEmailLeg, markCardLinkSendOutcome } = require('../services/appointment-card-request');
      startInvitationEmailLeg.mockClear();
      markCardLinkSendOutcome.mockClear();
      wireCardDb();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl);
        expect(res.status).toBe(500);
        const visitWrites = stamps.filter((s) => s.table === 'scheduled_services');
        expect(visitWrites).toHaveLength(1);
        expect(markCardLinkSendOutcome).toHaveBeenCalledWith('v-77', visitWrites[0].payload.card_link_sent_at);
        expect(startInvitationEmailLeg).not.toHaveBeenCalled();
      });
    });

    test('a blocked send releases the claim', async () => {
      sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, reason: 'quiet hours' });
      wireCardDb();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl);
        expect(res.status).toBe(422);
        const visitWrites = stamps.filter((s) => s.table === 'scheduled_services');
        expect(visitWrites).toHaveLength(2);
        expect(visitWrites[1].payload.card_link_sent_at).toBeNull();
        expect(stamps.find((s) => s.table === 'appointment_card_requests')).toBeUndefined();
      });
    });

    test('schedule-sms refuses a body carrying a live visit-lane card request link — only /sms consumes the claim', async () => {
      const card = { id: 'r9', kind: 'visit', status: 'pending', customer_id: 'cust-A', scheduled_service_id: 'v-77' };
      db.mockImplementation((table) => {
        const first = jest.fn();
        if (table === 'appointment_card_requests') first.mockResolvedValue(card);
        const select = jest.fn(async () => (table === 'appointment_card_requests' ? [{ token: 'abcDEF123_-xyz789QWERTY', ...card }] : []));
        return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), first, select, update: jest.fn(async () => 1) };
      });
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/communications/schedule-sms`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: '+15551234567', body: SECURE_BODY, messageType: 'manual', scheduledFor: '2099-01-01T10:00' }),
        });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/Card request links are re-checked at delivery/);
      });
    });

    test('schedule-sms refuses a body carrying a live Auto Pay link — immediate sends only', async () => {
      wireAutopayDb({ row: { id: 'r1', kind: 'customer', status: 'pending', expires_at: new Date(Date.now() + 86400e3), customer_id: 'cust-A' } });
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/communications/schedule-sms`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: '+15551234567', body: SECURE_BODY, messageType: 'manual', scheduledFor: '2099-01-01T10:00' }),
        });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/send them now/);
      });
    });

    test('schedule-sms refuses a body carrying a review link — the ask rides the immediate send only', async () => {
      await withServer(async (baseUrl) => {
        for (const body of ['Review us: portal.wavespestcontrol.com/rate/tok-abc123', 'https://portal.wavespestcontrol.com/api/rate/tok-abc123/go']) {
          const res = await fetch(`${baseUrl}/admin/communications/schedule-sms`, {
            method: 'POST',
            headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: '+15551234567', body, messageType: 'manual', scheduledFor: '2099-01-01T10:00' }),
          });
          expect(res.status).toBe(400);
          expect((await res.json()).error).toMatch(/immediate send/);
        }
      });
    });

    test('schedule-sms resolves a branded /l/:code short link through short_codes.kind', async () => {
      const shortCodes = {
        whereIn: jest.fn(function () { return this; }),
        where: jest.fn(function () { return this; }),
        select: jest.fn(async () => [{ code: 'abcde' }]),
      };
      db.mockImplementation((table) => {
        if (table === 'short_codes') return shortCodes;
        throw new Error(`unexpected table ${table}`);
      });
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/communications/schedule-sms`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
          // A legacy five-character code and a current ten-character one.
          // A legacy five-character code (pasted with capitals — the public
          // resolver lowercases, so must the fence) and a current ten-character one.
          body: JSON.stringify({ to: '+15551234567', body: 'Review us: wavespestcontrol.com/L/AbCdE or wavespestcontrol.com/l/abc123xyz9', messageType: 'manual', scheduledFor: '2099-01-01T10:00' }),
        });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/immediate send/);
        expect(shortCodes.whereIn).toHaveBeenCalledWith('code', ['abcde', 'abc123xyz9']);
        expect(shortCodes.where).toHaveBeenCalledWith({ kind: 'review' });
      });
    });

    test('/sms refuses a contract signing link whose token matches no live contract (rotated or expired) — fail closed before sending', async () => {
      wireAutopayDb({ row: null });
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { customerId: 'cust-A', body: 'Please sign: portal.wavespestcontrol.com/contract/abcDEF123_-xyz789QWERTY' });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/contract signing link is expired or no longer live/);
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      });
    });

    // A composer-carried project report link: the project send flow's own
    // delivery claim is taken before the provider call and handed back once
    // the provider has answered, so a resend that starts meanwhile 409s on
    // its claim instead of texting the same report twice (GH Codex #3893
    // r11 P1).
    describe('project report link in the body', () => {
      const REPORT_BODY = `Your report: portal.wavespestcontrol.com/report/project/${'f'.repeat(32)}`;
      const REPORTS = [{ id: 'p1', deliveryStatus: 'sent' }];
      const CLAIM = { projects: [{ id: 'p1', token: 't1', previousStatus: 'sent' }] };
      const ccl = () => require('../services/composer-customer-links');
      let bearerSpy;
      let claimSpy;
      let releaseSpy;
      beforeEach(() => {
        bearerSpy = jest.spyOn(ccl(), 'bearerLinkSendCheck').mockResolvedValue({ ok: true, projectReports: REPORTS });
        claimSpy = jest.spyOn(ccl(), 'claimProjectReportSends').mockResolvedValue({ ok: true, claim: CLAIM });
        releaseSpy = jest.spyOn(ccl(), 'releaseProjectReportSends').mockResolvedValue(undefined);
        db.mockImplementation((table) => {
          const first = jest.fn();
          if (table === 'customers') first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
          return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), first, select: jest.fn(async () => []), update: jest.fn(async () => 1), del: jest.fn(async () => 1) };
        });
      });
      afterEach(() => {
        bearerSpy.mockRestore();
        claimSpy.mockRestore();
        releaseSpy.mockRestore();
      });

      test('a real send: the claim is taken BEFORE the provider call and handed back AFTER it', async () => {
        sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM9', provider: 'twilio' });
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: REPORT_BODY });
          expect(res.status).toBe(200);
          expect(claimSpy).toHaveBeenCalledWith(REPORTS);
          expect(claimSpy.mock.invocationCallOrder[0]).toBeLessThan(sendCustomerMessage.mock.invocationCallOrder[0]);
          expect(releaseSpy).toHaveBeenCalledWith(CLAIM);
          expect(releaseSpy.mock.invocationCallOrder[0]).toBeGreaterThan(sendCustomerMessage.mock.invocationCallOrder[0]);
        });
      });

      test('an AMBIGUOUS provider outcome (retryable / deferred) keeps the claim — the provider may still hold the text (GH Codex #3893 r12 P1)', async () => {
        sendCustomerMessage.mockResolvedValue({ sent: false, blocked: false, retryable: true, code: 'PROVIDER_TIMEOUT', reason: 'timed out' });
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: REPORT_BODY });
          expect(res.status).toBe(422);
          expect(claimSpy).toHaveBeenCalledWith(REPORTS);
          expect(releaseSpy).not.toHaveBeenCalled();
        });
      });

      test('a blocked send hands the claim back; a lost claim (the flow is sending) refuses before the provider', async () => {
        sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SMS_OPTED_OUT', reason: 'opted out' });
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: REPORT_BODY });
          expect(res.status).toBe(422);
          expect(releaseSpy).toHaveBeenCalledWith(CLAIM);
        });
        sendCustomerMessage.mockClear();
        releaseSpy.mockClear();
        claimSpy.mockResolvedValue({ ok: false, error: 'This project report is being re-sent right now — give it a moment, then send again.' });
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: REPORT_BODY });
          expect(res.status).toBe(409);
          expect((await res.json()).error).toMatch(/being re-sent right now/);
          expect(sendCustomerMessage).not.toHaveBeenCalled();
          expect(releaseSpy).not.toHaveBeenCalled();
        });
      });
    });

    // A composer-carried prep guide link: the provider call and the tagger's
    // replay marker run under the manual prep sender's per-customer lock, so
    // a manual send of another guide cannot re-key the page's token while
    // this text is in flight (GH Codex #3856 r22 P0).
    describe('prep guide link in the body', () => {
      const PREP_BODY = `Your prep guide: portal.wavespestcontrol.com/prep/${'a'.repeat(32)}`;
      const PREPS = [{ customerId: 'cust-A', pestType: 'flea', templateKey: 'prep.flea' }];
      // What the same page renders once the lock is ours (a released
      // provisional page re-claimed for another guide keeps its token).
      const FRESH_PREPS = [{ customerId: 'cust-A', pestType: 'bed_bug', templateKey: 'prep.bed_bug' }];
      const ccl = () => require('../services/composer-customer-links');
      const { runExclusive } = require('../utils/cron-lock');
      let bearerSpy;
      let markSpy;
      let recheckSpy;
      beforeEach(() => {
        bearerSpy = jest.spyOn(ccl(), 'bearerLinkSendCheck').mockResolvedValue({ ok: true, preps: PREPS });
        markSpy = jest.spyOn(ccl(), 'markPrepGuidesSent').mockResolvedValue(undefined);
        recheckSpy = jest.spyOn(ccl(), 'recheckPrepLinks').mockResolvedValue({ ok: true, preps: FRESH_PREPS });
        db.mockImplementation((table) => {
          const first = jest.fn();
          if (table === 'customers') first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
          return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), first, select: jest.fn(async () => []), update: jest.fn(async () => 1) };
        });
      });
      afterEach(() => {
        bearerSpy.mockRestore();
        markSpy.mockRestore();
        recheckSpy.mockRestore();
        runExclusive.mockImplementation(async (_key, fn) => fn());
      });

      test('a real send: the provider call AND the replay marker run inside the prep-send lock', async () => {
        sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM9', provider: 'twilio' });
        const lockReleased = jest.fn();
        runExclusive.mockImplementation(async (key, fn) => {
          const out = await fn();
          if (key.startsWith('prep-send:')) lockReleased(key);
          return out;
        });
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: PREP_BODY });
          expect(res.status).toBe(200);
          expect(runExclusive).toHaveBeenCalledWith('prep-send:cust-A', expect.any(Function), { recordHealth: false, waitForSlot: false });
          const lockTaken = runExclusive.mock.invocationCallOrder[runExclusive.mock.calls.findIndex(([key]) => key === 'prep-send:cust-A')];
          expect(lockTaken).toBeLessThan(sendCustomerMessage.mock.invocationCallOrder[0]);
          // …and the marker uses the entries the in-lock recheck resolved,
          // not the pre-lock ones (pre-push Codex P1 on e8b68e9cc).
          expect(markSpy).toHaveBeenCalledWith(FRESH_PREPS, expect.anything());
          expect(markSpy).not.toHaveBeenCalledWith(PREPS, expect.anything());
          expect(markSpy.mock.invocationCallOrder[0]).toBeLessThan(lockReleased.mock.invocationCallOrder[0]);
          // The prep links are re-validated INSIDE the lock, before the provider.
          expect(recheckSpy).toHaveBeenCalledWith(PREP_BODY, '5551234567', { trustedCustomerId: 'cust-A', usDestination: true });
          expect(recheckSpy.mock.invocationCallOrder[0]).toBeGreaterThan(lockTaken);
          expect(recheckSpy.mock.invocationCallOrder[0]).toBeLessThan(sendCustomerMessage.mock.invocationCallOrder[0]);
        });
      });

      test('a prep link that stopped resolving between the pre-lock check and the lock (a released provisional page) refuses as not-sent — nothing dispatched, no marker (pre-push Codex P1 on 7f82e7564)', async () => {
        recheckSpy.mockResolvedValue({ ok: false, error: 'This prep guide link has expired — remove it and insert a fresh one.' });
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: PREP_BODY });
          expect(res.status).toBe(422);
          expect((await res.json()).error).toMatch(/prep guide link has expired/);
          expect(sendCustomerMessage).not.toHaveBeenCalled();
          expect(markSpy).not.toHaveBeenCalled();
        });
      });

      test('a held lease (a manual prep send mid-flight) refuses as not-sent — nothing dispatched, no marker', async () => {
        runExclusive.mockImplementation(async (key, fn) => (key.startsWith('prep-send:') ? { skipped: true, reason: 'locked' } : fn()));
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: PREP_BODY });
          expect(res.status).toBe(422);
          expect((await res.json()).error).toMatch(/prep guide is being sent to this customer right now/);
          expect(sendCustomerMessage).not.toHaveBeenCalled();
          expect(markSpy).not.toHaveBeenCalled();
        });
      });

      test('a throw the provider ACCEPTED still writes the marker; one it did not accept writes nothing', async () => {
        sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('audit write failed'), { providerOutcome: { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-card' } }));
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: PREP_BODY });
          expect(res.status).toBe(500);
          expect(markSpy).toHaveBeenCalledWith(FRESH_PREPS, expect.anything());
        });
        markSpy.mockClear();
        sendCustomerMessage.mockRejectedValueOnce(new Error('provider down'));
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: PREP_BODY });
          expect(res.status).toBe(500);
          expect(markSpy).not.toHaveBeenCalled();
        });
      });
    });

    // A prepared (composer-inserted) contract link in the body: activated
    // BEFORE the provider call, restored on every no-send exit, recorded
    // after a real send (GH Codex #3844 r3 P1).
    describe('prepared contract signing link in the body', () => {
      const CONTRACT_BODY = 'Please sign: portal.wavespestcontrol.com/contract/abcDEF123_-xyz789QWERTY';
      const { hashContractToken } = jest.requireActual('../services/contracts');
      const TOKEN_HASH = hashContractToken('abcDEF123_-xyz789QWERTY');
      const contracts = () => require('../routes/admin-contracts');
      function wireContractDb() {
        db.mockImplementation((table) => {
          const first = jest.fn();
          if (table === 'customer_contracts') first.mockResolvedValue({ id: 'k1', customer_id: 'cust-A', status: 'draft', share_token_expires_at: null });
          else if (table === 'customers') first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
          return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), first, select: jest.fn(async () => []), update: jest.fn(async () => 1) };
        });
      }
      beforeEach(() => {
        contracts().activatePreparedShareLinks.mockClear();
        contracts().restorePreparedShareLinks.mockClear();
        contracts().recordPreparedShareLinkSends.mockClear();
      });

      test('a real send: activated BEFORE the provider call, recorded after it, never restored', async () => {
        sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM7', provider: 'twilio' });
        wireContractDb();
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: CONTRACT_BODY });
          expect(res.status).toBe(200);
          const { activatePreparedShareLinks, recordPreparedShareLinkSends, restorePreparedShareLinks } = contracts();
          expect(activatePreparedShareLinks).toHaveBeenCalledWith([{ id: 'k1', tokenHash: TOKEN_HASH, delivered: true }], expect.anything());
          expect(activatePreparedShareLinks.mock.invocationCallOrder[0]).toBeLessThan(sendCustomerMessage.mock.invocationCallOrder[0]);
          expect(recordPreparedShareLinkSends).toHaveBeenCalledWith(
            [expect.objectContaining({ id: 'k1', tokenHash: TOKEN_HASH })], expect.anything(), expect.objectContaining({ providerMessageId: 'SM7' }),
          );
          expect(restorePreparedShareLinks).not.toHaveBeenCalled();
        });
      });

      test('an unwritten composer insert: the body\'s minted token + the composer\'s contractId reach activation as delivered:false', async () => {
        const CONTRACT_UUID = 'aaaa1111-0000-4000-8000-000000000001';
        const MINTED = require('../utils/composer-contract-token').mintComposerContractToken(CONTRACT_UUID);
        sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM7', provider: 'twilio' });
        // Every db(table) call is a fresh builder — count contract lookups
        // across them: by hash → nothing stored; by id → the composer's contract.
        let contractLookups = 0;
        db.mockImplementation((table) => {
          const first = jest.fn();
          if (table === 'customer_contracts') first.mockImplementation(async () => (contractLookups++ === 0 ? null : { id: CONTRACT_UUID, customer_id: 'cust-A', status: 'draft' }));
          else if (table === 'customers') first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
          return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), first, select: jest.fn(async () => []), update: jest.fn(async () => 1) };
        });
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', contractId: CONTRACT_UUID, body: `Please sign: portal.wavespestcontrol.com/contract/${MINTED}` });
          expect(res.status).toBe(200);
          expect(contracts().activatePreparedShareLinks).toHaveBeenCalledWith([{ id: CONTRACT_UUID, tokenHash: hashContractToken(MINTED), delivered: false }], expect.anything());
          expect(contracts().activatePreparedShareLinks.mock.invocationCallOrder[0]).toBeLessThan(sendCustomerMessage.mock.invocationCallOrder[0]);
        });
      });

      test('activation refused (rotated meanwhile) → 409 before any provider call', async () => {
        contracts().activatePreparedShareLinks.mockResolvedValueOnce({ ok: false, error: 'This contract signing link is no longer live — remove it and insert a fresh one.' });
        wireContractDb();
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: CONTRACT_BODY });
          expect(res.status).toBe(409);
          expect((await res.json()).error).toMatch(/no longer live/);
          expect(sendCustomerMessage).not.toHaveBeenCalled();
        });
      });

      test.each([
        ['blocked', { sent: false, blocked: true, reason: 'quiet hours' }, 422],
        ['suppressed (non-provider)', { sent: true, blocked: false, suppressed: true }, 200],
      ])('a %s send hands the prepared link back and records nothing', async (_label, outcome, status) => {
        sendCustomerMessage.mockResolvedValue(outcome);
        wireContractDb();
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: CONTRACT_BODY });
          expect(res.status).toBe(status);
          expect(contracts().restorePreparedShareLinks).toHaveBeenCalledWith([expect.objectContaining({ id: 'k1' })], expect.anything(), expect.objectContaining({ reason: expect.any(String) }));
          expect(contracts().recordPreparedShareLinkSends).not.toHaveBeenCalled();
        });
      });

      test('a RETRYABLE provider outcome keeps the prepared link activated — never restored, nothing recorded (GH Codex #3851 r4 P1)', async () => {
        sendCustomerMessage.mockResolvedValue({ sent: false, blocked: false, code: 'PROVIDER_FAILURE', retryable: true, deferred: true });
        wireContractDb();
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: CONTRACT_BODY });
          expect(res.status).toBe(422);
          expect(contracts().restorePreparedShareLinks).not.toHaveBeenCalled();
          expect(contracts().recordPreparedShareLinkSends).not.toHaveBeenCalled();
        });
      });

      test('a THROW carrying a retryable provider outcome keeps the prepared link activated too (GH Codex #3851 r5 P1)', async () => {
        const ambiguous = new Error('audit row failed');
        ambiguous.providerOutcome = { sent: false, retryable: true };
        sendCustomerMessage.mockRejectedValueOnce(ambiguous);
        wireContractDb();
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: CONTRACT_BODY });
          expect(res.status).toBe(500);
          expect(contracts().restorePreparedShareLinks).not.toHaveBeenCalled();
          expect(contracts().recordPreparedShareLinkSends).not.toHaveBeenCalled();
        });
      });

      test('a throw AFTER provider acceptance records the delivery; a throw before it restores', async () => {
        const accepted = new Error('audit row failed');
        accepted.providerOutcome = { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM8', provider: 'twilio' };
        sendCustomerMessage.mockRejectedValueOnce(accepted);
        wireContractDb();
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: CONTRACT_BODY });
          expect(res.status).toBe(500);
          expect(contracts().recordPreparedShareLinkSends).toHaveBeenCalledWith([expect.objectContaining({ id: 'k1' })], expect.anything(), accepted.providerOutcome);
          expect(contracts().restorePreparedShareLinks).not.toHaveBeenCalled();
        });
        contracts().recordPreparedShareLinkSends.mockClear();
        sendCustomerMessage.mockRejectedValueOnce(new Error('provider down'));
        await withServer(async (baseUrl) => {
          const res = await send(baseUrl, { customerId: 'cust-A', body: CONTRACT_BODY });
          expect(res.status).toBe(500);
          expect(contracts().restorePreparedShareLinks).toHaveBeenCalledWith([expect.objectContaining({ id: 'k1' })], expect.anything(), expect.anything());
          expect(contracts().recordPreparedShareLinkSends).not.toHaveBeenCalled();
        });
      });
    });

    test('a service report link is bound to the recipient\'s account at /sms: on the account → sent; off it → 409 before any provider call (pre-push Codex P0)', async () => {
      const REPORT_BODY = `Here is your latest service report: portal.wavespestcontrol.com/report/${'b'.repeat(32)}`;
      const wireReport = ({ recipientRows }) => db.mockImplementation((table) => {
        const first = jest.fn();
        if (table === 'customers') first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567', account_id: null });
        else if (table === 'service_records') first.mockResolvedValue({ id: 'r1', customer_id: 'cust-A', structured_notes: null });
        const select = jest.fn(async () => (table === 'customers' ? recipientRows : []));
        return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereNotNull: jest.fn(function () { return this; }), whereRaw: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), first, select, update: jest.fn(async () => 1) };
      });
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM5' });
      wireReport({ recipientRows: [{ id: 'cust-A', account_id: null }] });
      await withServer(async (baseUrl) => {
        expect((await send(baseUrl, { customerId: 'cust-A', body: REPORT_BODY })).status).toBe(200);
        expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      });
      sendCustomerMessage.mockClear();
      wireReport({ recipientRows: [] });
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { customerId: 'cust-A', body: REPORT_BODY });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/different customer/);
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      });
    });

    test('a bearer send with no selected customer adopts the one live owner of the number as the trusted customer — the recipient\'s own consent policy, not the lead one (GH Codex #3844 r9 P1); several owners refuse', async () => {
      const STMT_BODY = `Pay here: portal.wavespestcontrol.com/pay/statement/${'f'.repeat(64)}`;
      const wireOwners = (owners) => db.mockImplementation((table) => {
        const first = jest.fn();
        if (table === 'payer_statements') first.mockResolvedValue({ id: 31, payer_id: 7, status: 'sent' });
        else if (table === 'payers') first.mockResolvedValue({ id: 7, ap_phone: '+15551234567' });
        return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), whereRaw: jest.fn(function () { return this; }), first, select: jest.fn(async () => (table === 'customers' ? owners : [])), update: jest.fn(async () => 1) };
      });
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM9' });
      wireOwners([{ id: 'cust-A' }]);
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { body: STMT_BODY });
        expect(res.status).toBe(200);
        expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
          audience: 'customer', customerId: 'cust-A', identityTrustLevel: 'phone_matches_customer',
        }));
      });
      // A +44 destination whose last ten digits are the payer's US number is a
      // different phone: the bearer never goes there (GH Codex #3844 r10 P1).
      sendCustomerMessage.mockClear();
      wireOwners([{ id: 'cust-A' }]);
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { body: STMT_BODY, to: '+445551234567' });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/US number/);
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      });
      sendCustomerMessage.mockClear();
      wireOwners([{ id: 'cust-A' }, { id: 'cust-B' }]);
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { body: STMT_BODY });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/more than one customer/);
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      });
    });

    test('a statement link on a throw AFTER provider acceptance is still stamped finalized → sent (GH Codex #3844 r3 P1); a throw before it is not', async () => {
      const STMT_BODY = `Pay here: portal.wavespestcontrol.com/pay/statement/${'f'.repeat(64)}`;
      const { markStatementSent } = require('../services/payer-statement-email');
      markStatementSent.mockClear();
      db.mockImplementation((table) => {
        const first = jest.fn();
        if (table === 'payer_statements') first.mockResolvedValue({ id: 31, payer_id: 7, status: 'finalized' });
        else if (table === 'payers') first.mockResolvedValue({ id: 7, ap_phone: '+15551234567' });
        return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), whereRaw: jest.fn(function () { return this; }), first, select: jest.fn(async () => []), update: jest.fn(async () => 1) };
      });
      const accepted = new Error('audit row failed');
      accepted.providerOutcome = { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM9' };
      sendCustomerMessage.mockRejectedValueOnce(accepted);
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { body: STMT_BODY });
        expect(res.status).toBe(500);
        // The operator behind the composer send is the child closeouts' actor (GitHub r10 P2 #4127).
        expect(markStatementSent).toHaveBeenCalledWith(31, expect.anything(), { actorTechnicianId: 'admin-1', actorRole: 'admin' });
      });
      markStatementSent.mockClear();
      sendCustomerMessage.mockRejectedValueOnce(new Error('provider down'));
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { body: STMT_BODY });
        expect(res.status).toBe(500);
        expect(markStatementSent).not.toHaveBeenCalled();
      });
    });

    test('schedule-sms refuses a body carrying a contract signing link — the same immediate-only fence', async () => {
      wireAutopayDb({ row: null });
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/communications/schedule-sms`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: '+15551234567', body: 'Please sign: portal.wavespestcontrol.com/contract/abcDEF123_-xyz789QWERTY', messageType: 'manual', scheduledFor: '2099-01-01T10:00' }),
        });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/^Contract signing links are re-checked at delivery/);
      });
    });

    test('a send without the resolved owner as customerId is refused — the link must ride the owner policy', async () => {
      wireAutopayDb({ row: { id: 'r1', kind: 'customer', status: 'pending', expires_at: new Date(Date.now() + 86400e3), customer_id: 'cust-A' } });
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, {});
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/search dropdown/);
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      });
    });

    test('an Auto Pay refusal never claims the review row riding the same body', async () => {
      const ReviewService = require('../services/review-request');
      require('../services/autopay-setup-link').setupLinkIneligibility.mockResolvedValue({ reason: null, customer: { id: 'cust-A', phone: '+15551234567' } });
      db.mockImplementation((table) => {
        const first = jest.fn();
        if (table === 'review_requests') first.mockResolvedValue({ id: 'rr-1', customer_id: 'cust-A', status: 'pending', sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-abc123' });
        else if (table === 'customers') first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
        else if (table === 'sms_templates') first.mockResolvedValue({ is_active: true });
        const select = jest.fn(async () => (table === 'appointment_card_requests' ? [{ id: 'r1', kind: 'customer', token: 'abcDEF123_-xyz789QWERTY', status: 'pending', expires_at: new Date(Date.now() - 1000), customer_id: 'cust-A' }] : []));
        return { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), whereIn: jest.fn(function () { return this; }), first, select };
      });
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { customerId: 'cust-A', reviewRequestId: 'rr-1', body: `${SECURE_BODY} Review us: portal.wavespestcontrol.com/rate/tok-abc123` });
        expect(res.status).toBe(409);
        expect(ReviewService.claimInlineForSend).not.toHaveBeenCalled();
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      });
    });

    test('an expired link aborts the send before the provider call', async () => {
      wireAutopayDb({ row: { id: 'r1', kind: 'customer', status: 'pending', expires_at: new Date(Date.now() - 1000), customer_id: 'cust-A' } });
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/expired or no longer live/);
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      });
    });

    test('a link owned by a different customer aborts the send (fail closed)', async () => {
      wireAutopayDb({
        row: { id: 'r1', kind: 'customer', status: 'pending', expires_at: new Date(Date.now() + 86400e3), customer_id: 'cust-B' },
        owner: { id: 'cust-B', phone: '+19998887777' },
      });
      await withServer(async (baseUrl) => {
        // No customerId: the route's own phone-match 400 would fire first
        // with one — the seam's ownership refusal is what's pinned here.
        const res = await send(baseUrl, {});
        expect(res.status).toBe(409);
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      });
    });
  });

  test('review link for a different customer aborts the send (fail closed)', async () => {
    const ReviewService = require('../services/review-request');
    db.mockImplementation((table) => {
      const first = jest.fn();
      if (table === 'review_requests') {
        first.mockResolvedValue({
          id: 'rr-1', customer_id: 'cust-A', status: 'pending',
          sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-abc123',
        });
      } else if (table === 'customers') {
        // Owner phone does NOT match the recipient below.
        first.mockResolvedValue({ id: 'cust-A', phone: '+19998887777' });
      }
      const builder = makeUniversalBuilder();
      builder.first = first;
      return builder;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: '+15551234567',
          body: 'Review us: portal.wavespestcontrol.com/rate/tok-abc123',
          messageType: 'manual',
          reviewRequestId: 'rr-1',
        }),
      });

      expect(res.status).toBe(422);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(ReviewService.claimInlineForSend).not.toHaveBeenCalled();
    });
  });

  test('a lost review claim aborts the send before the provider call', async () => {
    const ReviewService = require('../services/review-request');
    ReviewService.claimInlineForSend.mockResolvedValueOnce(false);
    db.mockImplementation((table) => {
      const first = jest.fn();
      if (table === 'review_requests') {
        first.mockResolvedValue({
          id: 'rr-1', customer_id: 'cust-A', status: 'pending',
          sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-abc123',
        });
      } else if (table === 'customers') {
        first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      }
      const builder = makeUniversalBuilder();
      builder.first = first;
      return builder;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: '+15551234567',
          body: 'Review us: portal.wavespestcontrol.com/rate/tok-abc123',
          messageType: 'manual',
          reviewRequestId: 'rr-1',
        }),
      });

      expect(res.status).toBe(409);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });

  test('a stale mint-time gate is re-run at the send seam — a cadence ask since mint blocks the send', async () => {
    const ReviewService = require('../services/review-request');
    ReviewService.checkUnscheduledAskGates.mockResolvedValueOnce({ allowed: false, outcome: 'cooldown' });
    db.mockImplementation((table) => {
      const first = jest.fn();
      if (table === 'review_requests') {
        first.mockResolvedValue({
          id: 'rr-1', customer_id: 'cust-A', status: 'pending',
          sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-abc123',
        });
      } else if (table === 'customers') {
        first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      }
      const builder = makeUniversalBuilder();
      builder.first = first;
      return builder;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: '+15551234567',
          body: 'Review us: portal.wavespestcontrol.com/rate/tok-abc123',
          messageType: 'manual',
          reviewRequestId: 'rr-1',
        }),
      });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/last 30 days/);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(ReviewService.claimInlineForSend).not.toHaveBeenCalled();
    });
  });

  test('an email-only review preference set after the mint refuses the SMS send', async () => {
    const ReviewService = require('../services/review-request');
    ReviewService.reviewSmsAllowedNow.mockResolvedValueOnce({ allowed: false, reason: 'email_only' });
    db.mockImplementation((table) => {
      const first = jest.fn();
      if (table === 'review_requests') {
        first.mockResolvedValue({
          id: 'rr-1', customer_id: 'cust-A', status: 'pending',
          sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-abc123',
        });
      } else if (table === 'customers') {
        first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      }
      const builder = makeUniversalBuilder();
      builder.first = first;
      return builder;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: '+15551234567',
          body: 'Review us: portal.wavespestcontrol.com/rate/tok-abc123',
          messageType: 'manual',
          reviewRequestId: 'rr-1',
        }),
      });

      expect(res.status).toBe(422);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(ReviewService.checkUnscheduledAskGates).not.toHaveBeenCalled();
    });
  });

  test('the server link match is canonical — a host-case edit of the short URL still validates', async () => {
    const ReviewService = require('../services/review-request');
    const { existingShortUrlFor } = require('../services/short-url');
    existingShortUrlFor.mockResolvedValueOnce('https://portal.wavespestcontrol.com/s/AbC123');
    sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM777' });
    db.mockImplementation((table) => {
      const first = jest.fn();
      if (table === 'review_requests') {
        first.mockResolvedValue({
          id: 'rr-1', customer_id: 'cust-A', status: 'pending',
          sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-not-in-body',
        });
      } else if (table === 'customers') {
        first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      }
      const builder = makeUniversalBuilder();
      builder.first = first;
      return builder;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: '+15551234567',
          // Operator capitalized the host; the short code is the same link.
          body: 'Review us: Portal.WavesPestControl.com/s/AbC123',
          messageType: 'manual',
          reviewRequestId: 'rr-1',
        }),
      });

      expect(res.status).toBe(200);
      expect(ReviewService.claimInlineForSend).toHaveBeenCalledWith('rr-1', { emailRequested: false });
    });
  });

  test('a case-mangled token PATH does not verify — that is a dead link, not the ask', async () => {
    const ReviewService = require('../services/review-request');
    db.mockImplementation((table) => {
      const first = jest.fn();
      if (table === 'review_requests') {
        first.mockResolvedValue({
          id: 'rr-1', customer_id: 'cust-A', status: 'pending',
          sms_sent_at: null, triggered_by: 'auto_inline', token: 'tokAbC123',
        });
      } else if (table === 'customers') {
        first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      }
      const builder = makeUniversalBuilder();
      builder.first = first;
      return builder;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: '+15551234567',
          // Host case is fine; the TOKEN was lowercased — the link is dead.
          body: 'Review us: Portal.wavespestcontrol.com/rate/tokabc123',
          messageType: 'manual',
          reviewRequestId: 'rr-1',
        }),
      });

      expect(res.status).toBe(409);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(ReviewService.claimInlineForSend).not.toHaveBeenCalled();
    });
  });

  test('a verification error after the claim won hands the fenced claim back (503, not a stranded row)', async () => {
    const ReviewService = require('../services/review-request');
    ReviewService.inlineClaimStillHeld.mockRejectedValueOnce(new Error('db blip'));
    db.mockImplementation((table) => {
      const first = jest.fn();
      if (table === 'review_requests') {
        first.mockResolvedValue({
          id: 'rr-1', customer_id: 'cust-A', status: 'pending',
          sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-abc123',
        });
      } else if (table === 'customers') {
        first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      }
      const builder = makeUniversalBuilder();
      builder.first = first;
      return builder;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: '+15551234567',
          body: 'Review us: portal.wavespestcontrol.com/rate/tok-abc123',
          messageType: 'manual',
          reviewRequestId: 'rr-1',
        }),
      });

      expect(res.status).toBe(503);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(ReviewService.releaseInlineClaim).toHaveBeenCalledWith('rr-1', expect.any(Date));
    });
  });

  test('a fully validated review claim sends and marks the row delivered', async () => {
    const ReviewService = require('../services/review-request');
    sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM999' });
    db.mockImplementation((table) => {
      const first = jest.fn();
      if (table === 'review_requests') {
        first.mockResolvedValue({
          id: 'rr-1', customer_id: 'cust-A', status: 'pending',
          sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-abc123',
        });
      } else if (table === 'customers') {
        first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      }
      const builder = makeUniversalBuilder();
      builder.first = first;
      return builder;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: '+15551234567',
          body: 'Review us: portal.wavespestcontrol.com/rate/tok-abc123',
          messageType: 'manual',
          reviewRequestId: 'rr-1',
        }),
      });

      expect(res.status).toBe(200);
      expect(ReviewService.claimInlineForSend).toHaveBeenCalledWith('rr-1', { emailRequested: false });
      expect(ReviewService.markInlineDelivered).toHaveBeenCalledWith('rr-1', expect.any(Date));
    });
  });

  // Quick Links "Both" (owner ruling 2026-09-03): the same ask is emailed
  // only after the text REALLY sent — never on a released claim.
  describe('reviewRequestEmail (Both channel)', () => {
    const wireInlineRow = () => {
      db.mockImplementation((table) => {
        const first = jest.fn();
        if (table === 'review_requests') {
          first.mockResolvedValue({
            id: 'rr-1', customer_id: 'cust-A', status: 'pending',
            sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-abc123',
          });
        } else if (table === 'customers') {
          first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
        }
        const builder = makeUniversalBuilder();
      builder.first = first;
      return builder;
      });
    };
    const send = (baseUrl, extra) => fetch(`${baseUrl}/admin/communications/sms`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: '+15551234567',
        body: 'Review us: portal.wavespestcontrol.com/rate/tok-abc123',
        messageType: 'manual',
        reviewRequestId: 'rr-1',
        ...extra,
      }),
    });

    test('emails the same ask after a real send and reports the outcome', async () => {
      const ReviewService = require('../services/review-request');
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM999' });
      wireInlineRow();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { reviewRequestEmail: true });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ reviewEmail: { sent: true } });
        expect(ReviewService.markInlineDelivered).toHaveBeenCalledWith('rr-1', expect.any(Date));
        expect(ReviewService.sendInlineEmailCopy).toHaveBeenCalledWith('rr-1');
        // Both stamps the owed email leg on the claim — the Quick Links
        // retry path's persisted evidence this ask asked for an email.
        expect(ReviewService.claimInlineForSend).toHaveBeenCalledWith('rr-1', { emailRequested: true });
      });
    });

    test('a throw after provider acceptance still emails the Both copy and says so', async () => {
      const ReviewService = require('../services/review-request');
      const accepted = new Error('audit write failed');
      accepted.providerOutcome = { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-review' };
      sendCustomerMessage.mockRejectedValue(accepted);
      // The error path fires the async Twilio failure alert (a promise).
      require('../services/twilio-failure-alerts').alertTwilioFailure.mockResolvedValue(undefined);
      ReviewService.sendInlineEmailCopy.mockResolvedValue({ sent: true });
      wireInlineRow();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { reviewRequestEmail: true });
        expect(res.status).toBe(500);
        expect((await res.json()).error).toMatch(/text was accepted; the review email was sent too/);
        expect(ReviewService.markInlineDelivered).toHaveBeenCalledWith('rr-1', expect.any(Date));
        expect(ReviewService.sendInlineEmailCopy).toHaveBeenCalledWith('rr-1');
        expect(ReviewService.releaseInlineClaim).not.toHaveBeenCalled();
      });
    });

    test('canonical uncertainty retains the inline claim without sending the email copy', async () => {
      const ReviewService = require('../services/review-request');
      const uncertain = new Error('audit write failed');
      uncertain.providerOutcome = { sent: false, deliveryOutcome: 'uncertain' };
      sendCustomerMessage.mockRejectedValueOnce(uncertain);
      wireInlineRow();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { reviewRequestEmail: true });
        expect(res.status).toBe(500);
        expect(ReviewService.releaseInlineClaim).not.toHaveBeenCalled();
        expect(ReviewService.markInlineDelivered).not.toHaveBeenCalled();
        expect(ReviewService.sendInlineEmailCopy).not.toHaveBeenCalled();
      });
    });

    test('proven retryable non-delivery releases the inline claim', async () => {
      const ReviewService = require('../services/review-request');
      sendCustomerMessage.mockResolvedValueOnce({
        sent: false,
        blocked: false,
        deliveryOutcome: 'not_sent',
        retryable: true,
        code: 'PROVIDER_FAILURE',
      });
      wireInlineRow();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { reviewRequestEmail: true });
        expect(res.status).toBe(422);
        expect(ReviewService.releaseInlineClaim).toHaveBeenCalledWith('rr-1', expect.any(Date));
        expect(ReviewService.markInlineDelivered).not.toHaveBeenCalled();
      });
    });

    test('a real send whose delivery stamp throws twice reports the withheld email', async () => {
      const ReviewService = require('../services/review-request');
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM999' });
      ReviewService.markInlineDelivered.mockRejectedValue(new Error('db down'));
      wireInlineRow();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { reviewRequestEmail: true });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ reviewEmail: { sent: false, reason: 'email_not_attempted' } });
        expect(ReviewService.markInlineDelivered).toHaveBeenCalledTimes(2);
        expect(ReviewService.sendInlineEmailCopy).not.toHaveBeenCalled();
      });
    });

    test('never emails when the text did not really send (claim released)', async () => {
      const ReviewService = require('../services/review-request');
      // A suppression sentinel is definitive non-delivery.
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'not_sent', providerMessageId: 'owner-silence' });
      wireInlineRow();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, { reviewRequestEmail: true });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ reviewEmail: { sent: false, reason: 'text_not_sent' } });
        expect(ReviewService.releaseInlineClaim).toHaveBeenCalledWith('rr-1', expect.any(Date));
        expect(ReviewService.sendInlineEmailCopy).not.toHaveBeenCalled();
      });
    });

    test('a Text-only send never emails', async () => {
      const ReviewService = require('../services/review-request');
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM999' });
      wireInlineRow();
      await withServer(async (baseUrl) => {
        const res = await send(baseUrl, {});
        expect(res.status).toBe(200);
        expect((await res.json()).reviewEmail).toBeUndefined();
        expect(ReviewService.sendInlineEmailCopy).not.toHaveBeenCalled();
      });
    });
  });

  test('refuses a manual send while an autonomous reply is mid-send to the thread', async () => {
    // The auto-send interlock is only active when Phase E auto-send is enabled.
    mockGates.smsAutoSend = true;
    // An auto-send claim is in flight for this thread (it reserved under the
    // shared lock). The manual send must back off, not race its provider
    // window — both would reach the customer.
    hasActiveAutoSendClaim.mockResolvedValueOnce(true);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: '+15551234567',
          body: 'Replying by hand',
          messageType: 'manual',
        }),
      });

      expect(res.status).toBe(409);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });

  test.each([
    ['returned', async () => sendCustomerMessage.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_UNKNOWN' })],
    ['thrown', async () => sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('provider unknown'), { providerOutcome: { sent: false, deliveryOutcome: 'uncertain' } }))],
  ])('a %s uncertain outcome keeps gate-off claimed suggestions linked for recovery', async (_kind, arrange) => {
    db.mockImplementation(() => makeUniversalBuilder());
    suggestMode.parkThreadSuggestions.mockResolvedValueOnce(['parked-1']);
    await arrange();

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: '+15551234567', body: 'Replying by hand' }),
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(suggestMode.createReplyHoldingReservation).toHaveBeenCalledWith(db, expect.objectContaining({
        parkedDecisionIds: ['parked-1'],
      }));
      expect(suggestMode.settleReplyHoldingReservation).toHaveBeenCalledWith({ reservationId: 'resv-1', uncertain: true });
      expect(suggestMode.reopenScheduledSuggestions).not.toHaveBeenCalled();
    });
  });

  test('does not enter the provider when the durable uncertainty boundary cannot be armed', async () => {
    mockGates.smsAutoSend = true;
    db.mockImplementation(() => makeUniversalBuilder());
    suggestMode.settleReplyHoldingReservation.mockResolvedValueOnce(false);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: '+15551234567', body: 'Replying by hand' }),
      });

      expect(res.status).toBe(503);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });

  test('a gate-on manual send without fromNumber reserves and still sends (no 503)', async () => {
    // Regression: the reservation insert must resolve a non-null from_phone
    // without referencing an out-of-scope customer. With the gate on and no
    // fromNumber, it must NOT throw → 503; it should reserve and send.
    mockGates.smsAutoSend = true; // hasActiveAutoSendClaim default mock → false
    db.mockImplementation(() => makeUniversalBuilder());
    sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM777' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: '+15551234567', body: 'Hi there' }), // no fromNumber
      });

      expect(res.status).toBe(200);
      expect(sendCustomerMessage).toHaveBeenCalled();
    });
  });

  test('rejects an MMS whose media exceeds Twilio\'s 5MB total per-message cap', async () => {
    // Six sub-5MB images individually pass the per-file cap but blow the 5MB
    // aggregate Twilio enforces — guard before the send instead of bouncing.
    smsMedia.mediaFromOutboundAttachments.mockReturnValueOnce(
      Array.from({ length: 6 }, (_, i) => ({ url: `https://cdn/${i}.jpg`, size: 1024 * 1024 })),
    );

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: '+15551234567',
          body: 'See attached',
          mediaAttachments: Array.from({ length: 6 }, (_, i) => ({ url: `https://cdn/${i}.jpg`, size: 1024 * 1024 })),
          messageType: 'manual',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(413);
      expect(body.error).toMatch(/5MB per-message limit/);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });

  test('allows an MMS whose media stays within the 5MB total cap', async () => {
    smsMedia.mediaFromOutboundAttachments.mockReturnValueOnce([
      { url: 'https://cdn/a.jpg', size: 2 * 1024 * 1024 },
      { url: 'https://cdn/b.jpg', size: 2 * 1024 * 1024 },
    ]);
    sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, providerMessageId: 'SM999' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/sms`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: '+15551234567',
          body: 'See attached',
          mediaAttachments: [
            { url: 'https://cdn/a.jpg', size: 2 * 1024 * 1024 },
            { url: 'https://cdn/b.jpg', size: 2 * 1024 * 1024 },
          ],
          messageType: 'manual',
        }),
      });

      expect(res.status).toBe(200);
      expect(sendCustomerMessage).toHaveBeenCalled();
    });
  });

  test('bounds the SMS log by default and returns pagination metadata', async () => {
    const builder = makeQueryBuilder([smsMessageRow()]);
    db.mockReturnValue(builder);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/log`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.messages).toHaveLength(1);
      expect(body).toMatchObject({
        page: 1,
        limit: 500,
        hasMore: false,
        nextPage: null,
      });
      expect(builder.calls.limit).toEqual([501]);
      expect(builder.calls.offset).toEqual([0]);
    });
  });

  test.each([
    ['+449415550103', ['449415550103']],
    ['+19415550103', ['19415550103', '9415550103']],
    ['(941) 555-0103', ['19415550103', '9415550103']],
  ])('matches the full contact identity for %s', async (phone, expectedDigits) => {
    const builder = makeQueryBuilder([]);
    db.mockReturnValue(builder);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/log?phone=${encodeURIComponent(phone)}`, { headers: { Authorization: 'Bearer admin' } });
      expect(res.status).toBe(200);
      expect(builder.whereRaw).toHaveBeenCalledWith(expect.not.stringContaining('RIGHT('), [expectedDigits]);
    });
  });

  test('bounds searched SMS log results when no limit is supplied', async () => {
    const builder = makeQueryBuilder([smsMessageRow()]);
    db.mockReturnValue(builder);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/log?search=Ada`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.messages).toHaveLength(1);
      expect(body.limit).toBe(500);
      expect(builder.calls.limit).toEqual([501]);
      expect(builder.calls.offset).toEqual([0]);
    });
  });

  test('keeps explicit SMS log pagination available for callers that request it', async () => {
    const builder = makeQueryBuilder([
      smsMessageRow({ id: 'message-1' }),
      smsMessageRow({ id: 'message-2' }),
      smsMessageRow({ id: 'message-3' }),
    ]);
    db.mockReturnValue(builder);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/log?limit=2&page=3`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.messages.map((m) => m.id)).toEqual(['message-1', 'message-2']);
      expect(body).toMatchObject({
        page: 3,
        limit: 2,
        hasMore: true,
        nextPage: 4,
      });
      expect(builder.calls.limit).toEqual([3]);
      expect(builder.calls.offset).toEqual([4]);
    });
  });

  test('resolves unknown SMS log rows from a unique matching customer phone', async () => {
    const messagesBuilder = makeQueryBuilder([
      smsMessageRow({
        customer_id: null,
        first_name: null,
        last_name: null,
        customer_phone: null,
        contact_phone: '+15551234567',
      }),
    ]);
    const customersBuilder = makeQueryBuilder([
      {
        id: 'customer-1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone: '(555) 123-4567',
      },
    ]);

    db.mockImplementation((table) => {
      if (table === 'messages') return messagesBuilder;
      if (table === 'customers') return customersBuilder;
      return makeQueryBuilder([]);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/log`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.messages[0]).toMatchObject({
        customerId: 'customer-1',
        customerName: 'Ada Lovelace',
        from: '+15551234567',
      });
    });
  });

  test('CSV export escaping neutralizes spreadsheet formulas', () => {
    const { csvEscape } = communicationsRouter._internals;

    expect(csvEscape('=IMPORTXML("https://example.com")')).toBe('"\'=IMPORTXML(""https://example.com"")"');
    expect(csvEscape('+SUM(1,1)')).toBe("\"'+SUM(1,1)\"");
    expect(csvEscape('-10')).toBe("'-10");
    expect(csvEscape('@cmd')).toBe("'@cmd");
    expect(csvEscape('\t=HYPERLINK("https://example.com")')).toBe('"\'\t=HYPERLINK(""https://example.com"")"');
    expect(csvEscape('\r=cmd')).toBe('"\'\r=cmd"');
    expect(csvEscape('   @cmd')).toBe("'   @cmd");
    expect(csvEscape('plain')).toBe('plain');
  });
});

describe('Communications review ask serialization', () => {
  const history = require('../services/review-ask-history');
  const locks = require('../utils/cron-lock');
  const reviews = require('../services/review-request');
  const held = new Set();
  let bearerSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    held.clear();
    require('../services/short-url').existingShortUrlFor.mockReset().mockResolvedValue(null);
    mockGates.smsAutoSend = false;
    history.lastDeliveredAskAt.mockReset().mockResolvedValue(null);
    history.lastManualAskAt.mockReset().mockResolvedValue(null);
    locks.runExclusive.mockReset().mockImplementation(async (key, callback) => {
      if (held.has(key)) return { skipped: true, reason: 'lease_held' };
      held.add(key);
      try { return await callback(); } finally { held.delete(key); }
    });
    for (const method of ['inlineClaimStillHeld', 'claimInlineForSend']) reviews[method].mockReset().mockResolvedValue(true);
    reviews.reviewSmsAllowedNow.mockReset().mockResolvedValue({ allowed: true });
    reviews.checkUnscheduledAskGates.mockReset().mockResolvedValue({ allowed: true });
    reviews.markInlineDelivered.mockReset().mockResolvedValue(undefined);
    reviews.sendInlineEmailCopy.mockReset().mockResolvedValue({ sent: true });
    reviews.releaseInlineClaim.mockReset().mockResolvedValue(undefined);
    sendCustomerMessage.mockReset().mockResolvedValue({ sent: true, providerMessageId: 'SM-test' });
    suggestMode.parkThreadSuggestions.mockReset().mockResolvedValue([]);
    suggestMode.createReplyHoldingReservation.mockReset().mockResolvedValue('resv-1');
    suggestMode.settleReplyHoldingReservation.mockReset().mockResolvedValue(true);
    suggestMode.reopenScheduledSuggestions.mockReset().mockResolvedValue(0);
    suggestMode.ignoreParkedSuggestions.mockReset().mockResolvedValue(0);
    bearerSpy = jest.spyOn(require('../services/composer-customer-links'), 'bearerLinkSendCheck').mockResolvedValue({ ok: true });
    db.mockImplementation(table => {
      const builder = makeUniversalBuilder();
      if (table === 'customers') builder.first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      if (table === 'review_requests') builder.first.mockResolvedValue({ id: 'rr-1', customer_id: 'cust-A', status: 'pending', sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-abc123' });
      return builder;
    });
  });
  afterEach(() => { bearerSpy?.mockRestore(); locks.runExclusive.mockImplementation(async (_key, callback) => callback()); });
  const send = (baseUrl, overrides = {}) => fetch(`${baseUrl}/admin/communications/sms`, {
    method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: '+15551234567', customerId: 'cust-A', messageType: 'manual', body: 'Please review us: https://g.page/r/example/review', ...overrides }),
  });
  const inline = { reviewRequestId: 'rr-1', body: 'Review us: portal.wavespestcontrol.com/rate/tok-abc123' };

  const wireReservationLedger = () => {
    let reservations = [];
    db.mockImplementation(table => {
      const b = makeUniversalBuilder();
      if (table === 'customers') b.first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      if (table === 'review_requests') b.first.mockResolvedValue({ id: 'rr-1', customer_id: 'cust-A', status: 'pending', sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-abc123' });
      if (table === 'sms_log') {
        let selected;
        b.where.mockImplementation(predicate => {
          selected = reservations.find(row => Object.entries(predicate).every(([key, value]) => row[key] === value));
          return b;
        });
        b.insert.mockImplementation(values => {
          selected = {
            ...values,
            metadata: typeof values.metadata === 'string' ? JSON.parse(values.metadata) : values.metadata,
            id: `resv-${reservations.length + 1}`,
          };
          reservations.push(selected);
          b.returning.mockResolvedValue([{ id: selected.id }]);
          return b;
        });
        b.update.mockImplementation(values => {
          if (selected) {
            Object.assign(selected, values, {
              metadata: typeof values.metadata === 'string' ? JSON.parse(values.metadata) : (values.metadata || selected.metadata),
            });
            b.returning.mockResolvedValue([{ id: selected.id }]);
          } else {
            b.returning.mockResolvedValue([]);
          }
          return b;
        });
        b.del.mockImplementation(async () => {
          reservations = reservations.filter(row => row !== selected);
          return selected ? 1 : 0;
        });
      }
      return b;
    });
    suggestMode.createReplyHoldingReservation.mockImplementation(async (dbh, {
      to, customerId, fromNumber, body, adminUserId, agentDecisionId, parkedDecisionIds = [],
    }) => {
      const [row] = await dbh('sms_log').insert({
        customer_id: customerId,
        direction: 'outbound',
        from_phone: fromNumber,
        to_phone: to,
        message_body: body,
        status: 'sending',
        message_type: 'manual',
        admin_user_id: adminUserId,
        metadata: JSON.stringify({
          manual_send_reservation: true,
          ...(agentDecisionId ? { agent_decision_id: agentDecisionId } : {}),
          ...(parkedDecisionIds.length ? { parked_decision_ids: parkedDecisionIds } : {}),
        }),
      }).returning('id');
      return row?.id || null;
    });
    suggestMode.settleReplyHoldingReservation.mockImplementation(async ({ reservationId, uncertain, acceptedResult } = {}) => {
      const row = reservations.find(reservation => reservation.id === reservationId);
      if (!row) return false;
      if (acceptedResult) {
        row.status = 'sent';
        row.twilio_sid = acceptedResult.providerMessageId || null;
        row.metadata.provider_outcome = 'accepted';
      } else if (uncertain) {
        row.metadata.provider_outcome_uncertain = true;
      } else {
        reservations = reservations.filter(reservation => reservation !== row);
      }
      return true;
    });
    return () => reservations;
  };

  test('bare staff ask holds the lock through delivery; overlapping cadence and staff asks cannot dispatch', async () => {
    let entered, release;
    const providerEntered = new Promise(resolve => { entered = resolve; });
    const providerRelease = new Promise(resolve => { release = resolve; });
    sendCustomerMessage.mockImplementationOnce(async () => {
      expect(held.has('review-send:cust-A')).toBe(true);
      entered();
      await providerRelease;
      history.lastManualAskAt.mockResolvedValue(new Date());
      return { sent: true, providerMessageId: 'SM-test' };
    });
    await withServer(async baseUrl => {
      const first = send(baseUrl);
      try {
        await providerEntered;
        const cadenceProvider = jest.fn();
        expect(await locks.runExclusive('review-send:cust-A', cadenceProvider)).toMatchObject({ skipped: true });
        expect(cadenceProvider).not.toHaveBeenCalled();
        const second = await send(baseUrl);
        expect(second.status).toBe(409);
        expect((await second.json()).code).toBe('REVIEW_SEND_BUSY');
      } finally { release(); }
      expect((await first).status).toBe(200);
      const afterDelivery = await send(baseUrl);
      expect(afterDelivery.status).toBe(409);
      expect((await afterDelivery.json()).code).toBe('REVIEW_ASK_SPACING');
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    });
  });
  test.each(['accepted', 'accepted throw', 'stamp failure', 'tracked stamp failure', 'tracked accepted throw'])('ask retains durable spacing when accepted evidence cannot settle: %s', async mode => {
    const tracked = mode.startsWith('tracked');
    if (tracked) {
      require('../services/short-url').existingShortUrlFor.mockResolvedValue('https://wavespest.co/l/abc123');
      reviews.markInlineDelivered.mockRejectedValue(new Error('delivery stamp unavailable'));
      expect(jest.requireActual('../services/review-ask-history').looksLikeReviewAsk('wavespest.co/l/abc123')).toBe(false);
    }
    let reserved = false;
    const deleted = jest.fn();
    db.mockImplementation(table => {
      const b = makeUniversalBuilder();
      if (table === 'customers') b.first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      if (table === 'review_requests') b.first.mockResolvedValue({ id: 'rr-1', customer_id: 'cust-A', status: 'pending', sms_sent_at: null, triggered_by: 'auto_inline', token: 'tok-abc123' });
      if (table === 'sms_log') {
        if (tracked) b.first.mockResolvedValue({ id: 'provider-log' });
        b.insert.mockImplementation(values => {
          expect(held.has('review-send:cust-A')).toBe(true);
          expect(JSON.parse(values.metadata).review_ask_reservation).toBe(true);
          reserved = true;
          return b;
        });
        b.update.mockImplementation(() => {
          expect(held.has('review-send:cust-A')).toBe(true);
          if (mode === 'stamp failure') throw new Error('stamp unavailable');
          return b;
        });
        b.del.mockImplementation(async () => { deleted(); reserved = false; return 1; });
      }
      return b;
    });
    history.lastManualAskAt.mockImplementation(async () => reserved ? new Date() : null);
    sendCustomerMessage.mockImplementation(async () => {
      expect(reserved).toBe(true);
      if (mode.includes('throw')) throw Object.assign(new Error('audit unavailable'), { providerOutcome: { sent: true, providerMessageId: 'SM-accepted' } });
      return { sent: true, providerMessageId: 'SM-accepted' };
    });
    await withServer(async baseUrl => {
      expect((await send(baseUrl, tracked ? { reviewRequestId: 'rr-1', body: 'wavespest.co/l/abc123' } : {})).status).toBe(mode.includes('throw') ? 500 : 200);
      expect(reserved).toBe(true);
      expect(deleted).not.toHaveBeenCalled();
      const retry = await send(baseUrl);
      expect(retry.status).toBe(409);
      expect((await retry.json()).code).toBe('REVIEW_ASK_SPACING');
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    });
  });

  test.each(['gate-blocked', 'template-disabled', 'owner-silence'])('suppressed staff asks release their reservation: %s', async providerMessageId => {
    const deleted = jest.fn(async () => 1);
    const stamped = jest.fn();
    db.mockImplementation(table => {
      const b = makeUniversalBuilder();
      if (table === 'customers') b.first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      if (table === 'sms_log') { b.del = deleted; b.update = stamped; }
      return b;
    });
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId, deliveryOutcome: 'not_sent' });
    await withServer(async baseUrl => {
      await send(baseUrl);
      expect(deleted).toHaveBeenCalledTimes(1);
      expect(stamped).not.toHaveBeenCalled();
    });
  });

  test.each(['bare', 'tracked', 'tracked inferred'].flatMap(kind => [false, true].flatMap(auditThrows => [
    ['timeout', new Error('socket timeout'), true],
    ['reset', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }), true],
    ['server error', Object.assign(new Error('server failed'), { status: 503 }), true],
    ['refusal', { success: false, preSendBlocked: true, code: 'QUIET_HOURS_HOLD' }, false],
    ['suppression', { success: true, suppressed: true, sid: 'owner-sms-disabled' }, false],
  ].map(([label, providerResult, retained]) => ({ kind, auditThrows, label, providerResult, retained })))))
  ('$kind $label retains only uncertain delivery (audit throw: $auditThrows)', async ({ kind, auditThrows, providerResult, retained }) => {
    mockGates.smsAutoSend = kind === 'tracked inferred';
    const reservations = wireReservationLedger();
    history.lastManualAskAt.mockImplementation(async customerId => reservations().some(row =>
      row.customer_id === customerId && row.metadata.review_ask_reservation) ? new Date() : null);
    // Exercise the actual adapter's classification, including its thrown-error
    // path. The wrapper's post-provider audit failure preserves this outcome.
    require('../services/twilio').sendSMS = jest.fn(async () => {
      if (providerResult instanceof Error) throw providerResult;
      return providerResult;
    });
    sendCustomerMessage.mockImplementationOnce(async input => {
      const outcome = await jest.requireActual('../services/messaging/providers/twilio-sms').sendViaTwilio(input);
      if (auditThrows) throw Object.assign(new Error('audit failed'), { providerOutcome: outcome });
      return outcome;
    });
    await withServer(async baseUrl => {
      await send(baseUrl, kind !== 'bare' ? { ...inline, reviewRequestEmail: true,
        ...(kind === 'tracked inferred' ? { customerId: null } : {}) } : {});
      expect(reservations().some(row => row.metadata.review_ask_reservation)).toBe(retained);
      expect(reviews.markInlineDelivered).not.toHaveBeenCalled();
      expect(reviews.sendInlineEmailCopy).not.toHaveBeenCalled();
      if (kind !== 'bare') {
        if (retained) expect(reviews.releaseInlineClaim).not.toHaveBeenCalled();
        else expect(reviews.releaseInlineClaim).toHaveBeenCalled();
      }
      const retry = await send(baseUrl);
      expect(retry.status).toBe(retained ? 409 : 200);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(retained ? 1 : 2);
    });
  });

  test.each([
    ['uncertain', { sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_UNKNOWN' }, true],
    ['known not_sent', { sent: false, deliveryOutcome: 'not_sent', code: 'PROVIDER_FAILURE' }, false],
    ['accepted with review-stamp failure', { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-accepted' }, true],
  ])('a review ask with a parked suggestion keeps independent reservation lifecycles: %s', async (mode, providerResult, reviewRetained) => {
    const reservations = wireReservationLedger();
    suggestMode.parkThreadSuggestions.mockResolvedValueOnce(['parked-1']);
    suggestMode.ignoreParkedSuggestions.mockResolvedValueOnce(1);
    sendCustomerMessage.mockImplementationOnce(async () => {
      const reviewRow = reservations().find(row => row.metadata.review_ask_reservation);
      const replyRow = reservations().find(row => row.metadata.parked_decision_ids?.includes('parked-1'));
      expect(reviewRow).toBeDefined();
      expect(replyRow).toBeDefined();
      expect(reviewRow.id).not.toBe(replyRow.id);
      return providerResult;
    });
    if (mode === 'accepted with review-stamp failure') {
      reviews.markInlineDelivered.mockRejectedValue(new Error('review stamp unavailable'));
    }

    await withServer(async baseUrl => {
      const response = await send(baseUrl, inline);
      expect(response.status).toBe(mode === 'accepted with review-stamp failure' ? 200 : 422);

      const reviewRows = reservations().filter(row => row.metadata.review_ask_reservation);
      const replyRows = reservations().filter(row => row.metadata.parked_decision_ids?.includes('parked-1'));
      expect(reviewRows).toHaveLength(reviewRetained ? 1 : 0);
      expect(replyRows).toHaveLength(mode === 'uncertain' ? 1 : 0);
      if (reviewRetained) expect(reviewRows[0].metadata.parked_decision_ids).toBeUndefined();
      if (mode === 'uncertain') {
        expect(replyRows[0].metadata).toMatchObject({
          manual_send_reservation: true,
          provider_outcome_uncertain: true,
          parked_decision_ids: ['parked-1'],
        });
        expect(suggestMode.reopenScheduledSuggestions).not.toHaveBeenCalled();
      } else if (mode === 'known not_sent') {
        expect(suggestMode.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({
          decisionIds: [null, 'parked-1'],
        }));
      } else {
        expect(reviewRows[0]).toMatchObject({ status: 'sending', metadata: { review_ask_reservation: true } });
        expect(reviews.markInlineDelivered).toHaveBeenCalledTimes(2);
        expect(suggestMode.ignoreParkedSuggestions).toHaveBeenCalledWith(expect.objectContaining({
          decisionIds: ['parked-1'],
        }));
        expect(suggestMode.settleReplyHoldingReservation).toHaveBeenCalledWith(expect.objectContaining({
          acceptedResult: providerResult,
        }));
      }
    });
  });

  test('a failed pre-send reservation prevents the provider call', async () => {
    db.mockImplementation(table => {
      const b = makeUniversalBuilder();
      if (table === 'customers') b.first.mockResolvedValue({ id: 'cust-A', phone: '+15551234567' });
      if (table === 'sms_log') b.insert.mockImplementation(() => { throw new Error('reservation unavailable'); });
      return b;
    });
    await withServer(async baseUrl => {
      expect((await send(baseUrl)).status).toBe(500);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });

  test('a preceding cadence delivery blocks the bare staff ask', async () => {
    history.lastDeliveredAskAt.mockResolvedValue(new Date());
    await withServer(async baseUrl => {
      const response = await send(baseUrl);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('REVIEW_ASK_SPACING');
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });
  test('history failure releases the inline claim without sending', async () => {
    history.lastManualAskAt.mockRejectedValue(new Error('history unavailable'));
    await withServer(async baseUrl => {
      expect((await send(baseUrl, inline)).status).toBe(503);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(reviews.releaseInlineClaim).toHaveBeenCalledWith('rr-1', true);
    });
  });
  test('inline stamping and the owed email stay inside the lock', async () => {
    reviews.markInlineDelivered.mockImplementation(async () => { expect(held.has('review-send:cust-A')).toBe(true); });
    reviews.sendInlineEmailCopy.mockImplementation(async () => { expect(held.has('review-send:cust-A')).toBe(true); return { sent: true }; });
    await withServer(async baseUrl => {
      const response = await send(baseUrl, { ...inline, reviewRequestEmail: true });
      expect(response.status).toBe(200);
      expect((await response.json()).reviewEmail).toEqual({ sent: true });
      expect(reviews.markInlineDelivered).toHaveBeenCalledTimes(1);
      expect(reviews.sendInlineEmailCopy).toHaveBeenCalledTimes(1);
    });
  });
  test('an accepted provider throw stamps delivery before unlocking', async () => {
    sendCustomerMessage.mockRejectedValue(Object.assign(new Error('audit failed'), { providerOutcome: { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-accepted' } }));
    reviews.markInlineDelivered.mockImplementation(async () => { expect(held.has('review-send:cust-A')).toBe(true); });
    await withServer(async baseUrl => {
      expect((await send(baseUrl, inline)).status).toBe(500);
      expect(reviews.markInlineDelivered).toHaveBeenCalledTimes(1);
      expect(reviews.releaseInlineClaim).not.toHaveBeenCalled();
    });
  });
  test.each([
    'Please review your invoice when you have time.',
    'Office directions: https://maps.app.goo.gl/abc123',
    'Meet here: https://goo.gl/maps/abc123',
    'https://maps.google.com/?q=office',
  ])('ordinary message retains its send behavior: %s', async body => {
    history.lastManualAskAt.mockRejectedValue(new Error('must not read history'));
    await withServer(async baseUrl => {
      expect((await send(baseUrl, { body })).status).toBe(200);
      expect(history.lastManualAskAt).not.toHaveBeenCalled();
      expect(locks.runExclusive).not.toHaveBeenCalled();
    });
  });
});
