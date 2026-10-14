/**
 * The handoff window is the provider client's OWN timeout plus a margin, read from the clients
 * (sendgrid-mail, the Twilio SDK, APNs, FCM) — never a number guessed here.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { handoffWindowMs, providerTimeoutMs, MARGIN_MS } = require('../services/receipt-handoff-window');
const { REQUEST_TIMEOUT_MS } = require('../services/sendgrid-mail');
const { APNS_REQUEST_TIMEOUT_MS } = require('../services/apns');
const { FCM_REQUEST_TIMEOUT_MS } = require('../services/fcm');
const RequestClient = require('twilio/lib/base/RequestClient');

test('email: SendGrid\'s request timeout; text: the Twilio SDK default; app: APNs / FCM (FCM fetches a token first)', () => {
  expect(providerTimeoutMs('email')).toBe(REQUEST_TIMEOUT_MS);
  expect(providerTimeoutMs('sms')).toBe(new RequestClient().defaultTimeout);
  expect(providerTimeoutMs('app')).toBe(2 * Math.max(APNS_REQUEST_TIMEOUT_MS, FCM_REQUEST_TIMEOUT_MS));
});

test('the real values (a change in a client moves the window with it)', () => {
  expect(REQUEST_TIMEOUT_MS).toBe(120_000);
  expect(new RequestClient().defaultTimeout).toBe(30_000);
  expect(APNS_REQUEST_TIMEOUT_MS).toBe(8000);
  expect(FCM_REQUEST_TIMEOUT_MS).toBe(8000);
});

test('the window is the timeout plus the margin, and covers every channel when the channel is unknown', () => {
  expect(MARGIN_MS).toBeGreaterThan(0);
  expect(handoffWindowMs('email')).toBe(REQUEST_TIMEOUT_MS + MARGIN_MS);
  expect(handoffWindowMs('sms')).toBe(30_000 + MARGIN_MS);
  expect(handoffWindowMs(undefined)).toBe(Math.max(handoffWindowMs('email'), handoffWindowMs('sms'), handoffWindowMs('app')));
});

test('the window stays under the claim\'s staleness window, so a heartbeat at the handoff always covers the request', () => {
  const STALE_LOCK_MINUTES = 10; // receipt-delivery-queue STALE_LOCK_MINUTES
  expect(handoffWindowMs(undefined)).toBeLessThan(STALE_LOCK_MINUTES * 60 * 1000);
});
