/**
 * Stripe webhook → Sentry capture contract.
 *
 * Sentry is initialized in prod (instrument.js) but the webhook route's
 * handler catch previously never reached it: a handler exception was logged
 * to console-only winston, written to the ledger's error column (purged at
 * 90d), and 500'd back to Stripe — a durable failure with no durable
 * operator-visible record. Contract pinned here:
 *
 *  - a handler-path exception calls Sentry.captureException with the
 *    area:stripe-webhook tag and eventType/eventId extras (identifiers
 *    only — the payload never leaves the process), and still records the
 *    ledger error + returns 500 so Stripe retries;
 *  - the capture payload carries FIXED generic text + safe identifiers
 *    (event type/id, error name/code) — NEVER any part of the original
 *    message or stack. Scrub regexes cannot recognize every PII form (an
 *    unquoted customer name or street address passes any pattern
 *    allowlist — codex on #3268), so nothing derived from the original
 *    error text may appear anywhere in the payload; the full detail lives
 *    in the ledger error column and the Railway console log. An explicit
 *    fingerprint keeps grouping stable without a stack;
 *  - a signature-verification failure does NOT capture (public endpoint —
 *    attack traffic would be Sentry-quota noise, not app failure) and
 *    returns 400 as before.
 *
 * Real listen + fetch round-trips (repo has no supertest at the root) so the
 * express.raw pipeline and the route's own catch block are what run.
 */

jest.setTimeout(30000);

const mockConstructEvent = jest.fn();
jest.mock('stripe', () => jest.fn(() => ({ webhooks: { constructEvent: mockConstructEvent } })));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  dbMock.transaction = jest.fn();
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
jest.mock('../routes/stripe-webhook-helpers', () => ({
  classifyExistingWebhookEvent: jest.fn(),
  invoicePaymentIntentBlocksFallback: jest.fn(() => false),
  lateSavedCardPaymentNeedsOrphan: jest.fn(() => false),
  savedCardAttemptMatchesPaymentIntent: jest.fn(() => false),
  savedCardCreditAdjustment: jest.fn(() => null),
  STALE_CLAIM_WINDOW_MS: 60000,
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/stripe-invoice-state', () => ({
  isInvoiceCollectibleStatus: jest.fn(() => true),
  invoiceStatusForSuccessfulPayment: jest.fn(),
  invoiceStatusForFailedPayment: jest.fn(),
  INVOICE_COLLECTIBLE_STATUSES: [],
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: {} }));
jest.mock('../services/invoice-helpers', () => ({ INVOICE_UNCOLLECTIBLE_STATUSES: ['void'], invoiceAmountDue: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendRefundIssued: jest.fn() }));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ handleDepositChargeReversed: jest.fn(async () => ({ handled: false })) }));
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(async (piId) => ({ id: piId, metadata: {} })),
}));

const express = require('express');
const Sentry = require('@sentry/node');
const db = require('../models/db');
const router = require('../routes/stripe-webhook');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use('/api/stripe/webhook', router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}/api/stripe/webhook`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

function postWebhook() {
  return fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': 't=1,v1=test',
    },
    body: '{}',
  });
}

// Ledger builder: the atomic claim succeeds (we own the event); the
// mark-processed update rejects per-test to force the handler catch, and the
// catch's own error-record update resolves.
function ledgerBuilder({ update }) {
  const builder = {
    insert: jest.fn(() => builder),
    onConflict: jest.fn(() => builder),
    ignore: jest.fn(() => builder),
    returning: jest.fn(async () => ['evt_test_1']),
    where: jest.fn(() => builder),
    update,
  };
  return builder;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('handler-path exception captures generic text + identifiers to Sentry, records the ledger error, and 500s', async () => {
  const boom = new Error('handler exploded');
  boom.code = 'ECONNRESET';
  const update = jest.fn()
    .mockRejectedValueOnce(boom) // mark-processed → throws into the catch
    .mockResolvedValue(1); // catch's error-record write succeeds
  const builder = ledgerBuilder({ update });
  db.mockImplementation((table) => {
    if (table === 'stripe_webhook_events') return builder;
    throw new Error(`Unexpected db table: ${table}`);
  });
  mockConstructEvent.mockReturnValue({
    id: 'evt_test_1',
    type: 'waves.test_event',
    created: 1754500000,
    data: { object: { id: 'obj_1' } },
  });

  const res = await postWebhook();
  expect(res.status).toBe(500);

  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  const [capturedErr, context] = Sentry.captureException.mock.calls[0];
  expect(capturedErr).toBeInstanceOf(Error);
  // Fixed generic text — the original message never reaches the payload.
  expect(capturedErr.message).toBe('stripe-webhook handler failure (waves.test_event)');
  expect(context).toEqual({
    tags: { area: 'stripe-webhook' },
    extra: {
      eventType: 'waves.test_event',
      eventId: 'evt_test_1',
      errorName: 'Error',
      errorCode: 'ECONNRESET',
    },
    fingerprint: ['stripe-webhook-handler', 'waves.test_event', 'Error'],
  });

  // The existing ledger error-record contract survives the capture — the
  // DB-internal ledger keeps the ORIGINAL message (that is where the
  // operator reads the real failure).
  expect(update).toHaveBeenCalledWith({ error: 'handler exploded' });
});

test('PII-bearing handler error never reaches the Sentry capture payload — not even in scrubber-proof forms', async () => {
  // Synthetic fixture only. Includes PII shapes a scrub regex CANNOT
  // recognize (an unquoted name, a street address) alongside the quoted
  // SQL-literal/email/phone shapes — the contract is that NONE of the
  // original text survives, not that patterns were masked.
  const boom = new Error(
    "update \"customers\" set \"name\" = 'Jane Q Fixture' where id = 7 - relation locked; customer Jane Q Fixture at 123 Palmetto Fixture Ln could not be notified at jane.fixture@example.com or +1 (941) 555-0100"
  );
  boom.stack = 'Error: SMS to +19415550100 for Jane Q Fixture bounced\n    at handler (/app/server/routes/stripe-webhook.js:800:11)';
  boom.code = { nested: 'not a safe short token' }; // must be dropped, not serialized
  const update = jest.fn()
    .mockRejectedValueOnce(boom) // mark-processed → throws into the catch
    .mockResolvedValue(1); // catch's error-record write succeeds
  const builder = ledgerBuilder({ update });
  db.mockImplementation((table) => {
    if (table === 'stripe_webhook_events') return builder;
    throw new Error(`Unexpected db table: ${table}`);
  });
  mockConstructEvent.mockReturnValue({
    id: 'evt_test_pii',
    type: 'waves.test_event',
    created: 1754500000,
    data: { object: { id: 'obj_pii' } },
  });

  const res = await postWebhook();
  expect(res.status).toBe(500);

  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  const [capturedErr, context] = Sentry.captureException.mock.calls[0];
  const payload = JSON.stringify({ message: capturedErr.message, stack: capturedErr.stack, name: capturedErr.name, context });
  expect(payload).not.toContain('jane.fixture@example.com');
  expect(payload).not.toContain('Jane Q Fixture');
  expect(payload).not.toContain('Palmetto Fixture');
  expect(payload).not.toContain('9415550100');
  expect(payload).not.toContain('555-0100');
  // Fixed generic text; the stack is frame-less (a synthetic stack would
  // point at the catch block for every failure).
  expect(capturedErr.message).toBe('stripe-webhook handler failure (waves.test_event)');
  expect(capturedErr.stack).toBe('Error: stripe-webhook handler failure (waves.test_event)');
  expect(capturedErr.name).toBe('Error');
  expect(context.extra).toEqual({
    eventType: 'waves.test_event',
    eventId: 'evt_test_pii',
    errorName: 'Error',
    errorCode: undefined, // non-token err.code dropped
  });
  expect(context.fingerprint).toEqual(['stripe-webhook-handler', 'waves.test_event', 'Error']);

  // The ledger error record (DB-internal, 90d purge) keeps the original
  // message — that is where the real failure text lives.
  expect(update).toHaveBeenCalledWith({ error: boom.message });
});

test('signature-verification failure returns 400 and does NOT capture to Sentry', async () => {
  db.mockImplementation((table) => {
    throw new Error(`db must not be touched on a signature failure (table: ${table})`);
  });
  mockConstructEvent.mockImplementation(() => {
    throw new Error('No signatures found matching the expected signature for payload');
  });

  const res = await postWebhook();
  expect(res.status).toBe(400);
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

test('clean processing path neither captures nor errors', async () => {
  const update = jest.fn().mockResolvedValue(1);
  const builder = ledgerBuilder({ update });
  db.mockImplementation((table) => {
    if (table === 'stripe_webhook_events') return builder;
    throw new Error(`Unexpected db table: ${table}`);
  });
  mockConstructEvent.mockReturnValue({
    id: 'evt_test_2',
    type: 'waves.test_event',
    created: 1754500000,
    data: { object: { id: 'obj_2' } },
  });

  const res = await postWebhook();
  expect(res.status).toBe(200);
  expect(Sentry.captureException).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ processed: true }));
});
