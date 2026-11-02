// A customer's "interested" tap on a promotion card (POST /api/promotions/:id/interest). The office used to
// hear of it by a text to the owner's phone, which reached nobody since about 2026-09-01 (twilio.js turns an
// owner-phone internal_alert into a bell trigger the bell policy denylists). It is now a ringing owner alert
// (services/owner-alerts.js), one row per customer, service and ET day, so a repeated or replayed tap, with any
// promotion id, refreshes that row and rings nothing new (Codex security review P2s on #7427). The request row,
// the customer's App receipt and confirmation text are unchanged.
const express = require('express');
const http = require('http');

let mockInserts;
let mockServiceTypes;
jest.mock('../models/db', () => jest.fn((table) => {
  const q = {
    insert: (row) => { mockInserts.push({ table, row }); return q; },
    returning: async () => [{ id: `req-${mockInserts.length}`, ...mockInserts[mockInserts.length - 1].row }],
    where: () => q,
    select: async () => mockServiceTypes.map((service_type) => ({ service_type })),
  };
  return q;
}));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customer = {
      id: 'cust-1', first_name: 'Jamie', last_name: 'Rivera', phone: '+15550001111', waveguard_tier: 'Silver',
      address_line1: '1 Example Way', city: 'Bradenton',
    };
    req.customerId = 'cust-1';
    next();
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
// The real owner-alerts composer runs (copy that breaks the notification rule throws under test); only the
// row write is stubbed.
jest.mock('../services/ops-digest', () => ({
  ...jest.requireActual('../services/ops-digest'),
  deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n-1' })),
}));
jest.mock('../services/request-app-notifications', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'We got it') }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));

const TwilioService = require('../services/twilio');
const { deliverOpsDigest } = require('../services/ops-digest');
const AppNotifications = require('../services/request-app-notifications');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { etDateString } = require('../utils/datetime-et');

async function tapInterest(promoId, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/promotions', require('../routes/promotions'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/promotions/${promoId}/interest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInserts = [];
  mockServiceTypes = ['Quarterly Pest Control'];
});

test('a tap rings one owner alert for the customer and service, and texts the owner nothing', async () => {
  const res = await tapInterest('promo-7', { serviceType: 'mosquito', serviceName: 'Mosquito Control' });

  expect(res).toEqual({ status: 200, json: { success: true } });
  expect(mockInserts).toEqual([expect.objectContaining({ table: 'service_requests', row: expect.objectContaining({ category: 'add_service', status: 'new' }) })]);
  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  const digest = deliverOpsDigest.mock.calls[0][0];
  expect(digest).toMatchObject({
    headline: 'Estimates — follow up with Jamie Rivera about Mosquito',
    summary: 'Tapped interested in Mosquito on a portal promotion.',
    link: '/admin/customers?customerId=cust-1',
    audience: 'owner',
    dedupeKey: `owner-alert:promotion-interest:cust-1:mosquito:${etDateString()}`,
  });
  expect(digest.text).toContain('Mosquito Control (promotion promo-7)');
  expect(digest.metadata).toMatchObject({ customerId: 'cust-1', ownerAlert: 'promotion-interest', severity: 'needs-you' });
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  // The customer's side is unchanged: App receipt for the new request, and the confirmation text.
  expect(AppNotifications.send).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', received: true }));
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});

test('a replayed tap under any promotion id or label lands on the same row and item, so it rings nothing new', async () => {
  await tapInterest('promo-7', { serviceType: 'mosquito', serviceName: 'Mosquito Control' });
  await tapInterest('promo-999', { serviceType: 'Mosquito', serviceName: 'Anything at all' });

  const [first, second] = deliverOpsDigest.mock.calls.map(([d]) => d);
  expect(second.dedupeKey).toBe(first.dedupeKey);
  expect(second.itemKeys).toEqual(first.itemKeys);
  expect(first.itemKeys).toEqual([`cust-1:mosquito:${etDateString()}`]);
});

test('a service the server does not know files under one "other" row, never a client-chosen key', async () => {
  mockServiceTypes = [];
  await tapInterest('promo-1', { serviceType: 'x'.repeat(200) });
  const digest = deliverOpsDigest.mock.calls[0][0];
  expect(digest.dedupeKey).toBe(`owner-alert:promotion-interest:cust-1:other:${etDateString()}`);
  expect(digest.headline).toBe('Estimates — follow up with Jamie Rivera about a service');
});

test('an alert that cannot be written is logged and the tap still succeeds', async () => {
  deliverOpsDigest.mockRejectedValueOnce(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
  const res = await tapInterest('promo-7', { serviceType: 'mosquito', serviceName: 'Mosquito Control' });
  expect(res.status).toBe(200);
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});
