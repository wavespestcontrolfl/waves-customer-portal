jest.mock('../models/db', () => jest.fn());
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: () => '+19415550199' }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const RequestApp = require('../services/request-app-notifications');
const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
let request;
let prefs;
let customer;
let queued;
let readFailed;
const updatedAt = '2026-09-09T12:00:00.000Z';
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
  request = { id: 'request-1', customer_id: 'customer-1', category: 'general', source: null, status: 'new', updated_at: updatedAt };
  prefs = { request_channel: 'push' };
  customer = { active: true, phone: '+19415550142' };
  queued = [];
  readFailed = false;
  db.mockImplementation((table) => {
    const q = { where: jest.fn(() => q), first: jest.fn(async () => {
      if (readFailed) throw new Error('database unavailable');
      return { service_requests: request, customers: customer, notification_prefs: prefs }[table];
    }), insert: jest.fn(async (row) => { queued.push(row); }) };
    return q;
  });
  sendCustomerMessage.mockResolvedValue({ sent: true });
});
afterEach(() => { delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS; });

test.each(['QUIET_HOURS_HOLD', 'PUSH_IN_FLIGHT', 'APP_DELIVERY_HOLD'])('preserves an App-only event through %s', async (code) => {
  sendCustomerMessage.mockResolvedValue({ sent: false, code, deferred: true, nextAllowedAt: '2026-09-09T13:00:00Z' });
  await RequestApp.send({ customerId: 'customer-1', request });
  const sent = sendCustomerMessage.mock.calls[0][0];
  expect(sent).toMatchObject({ channel: 'sms', purpose: 'support_resolution', metadata: { appOnly: true } });
  expect(JSON.parse(queued[0].metadata)).toMatchObject({ ...sent.metadata, entry_point: 'request_app_deferred', refresh_customer_phone: true });
  expect(await recheckDeferredReplay('request_app_deferred', JSON.parse(queued[0].metadata))).toEqual({ eligible: true });
  request.updated_at = '2026-09-09T12:01:00Z';
  expect(await recheckDeferredReplay('request_app_deferred', JSON.parse(queued[0].metadata))).toMatchObject({ eligible: false });
});

test.each(['admin', 'cancellation', 'measurement_review', 'cta', 'inactive', 'email', 'gate'])('keeps %s requests outside App status delivery', async (kind) => {
  if (kind === 'admin') request.source = 'admin';
  if (['cancellation', 'measurement_review'].includes(kind)) request.category = kind;
  if (kind === 'cta') request.source = require('../services/cta-service-request').CTA_REQUEST_SOURCES[0];
  if (kind === 'inactive') customer.active = false;
  if (kind === 'email') prefs.request_channel = 'email';
  if (kind === 'gate') delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS;
  await RequestApp.send({ customerId: 'customer-1', request });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('each request transition has its own event identity', async () => {
  await RequestApp.send({ customerId: 'customer-1', request, received: true });
  request.updated_at = '2026-09-09T12:01:00Z';
  await RequestApp.send({ customerId: 'customer-1', request });
  expect(sendCustomerMessage.mock.calls.map(([input]) => input.customerInitiated)).toEqual([true, false]);
  expect(new Set(sendCustomerMessage.mock.calls.map(([input]) => input.metadata.notificationEventKey)).size).toBe(2);
});

test('an unknown replay state fails closed and remains retryable', async () => {
  readFailed = true;
  expect(await recheckDeferredReplay('request_app_deferred', {
    customer_id: 'customer-1', service_request_id: request.id, request_updated_at: updatedAt,
  })).toMatchObject({ eligible: false, retryable: true });
});
