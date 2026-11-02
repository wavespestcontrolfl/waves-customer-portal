// A customer's "interested" tap on a promotion card (POST /api/promotions/:id/interest). The office used to
// hear of it by a text to the owner's phone, which reached nobody since about 2026-09-01 (twilio.js turns an
// owner-phone internal_alert into a bell trigger the bell policy denylists). It now rings the add-a-service
// bell, bundle_quote_requested: a declared customer contact that opens the customer's requests panel.
const express = require('express');
const http = require('http');

let mockInserts;
let mockServiceTypes;
jest.mock('../models/db', () => jest.fn((table) => {
  const q = {
    insert: (row) => { mockInserts.push({ table, row }); return q; },
    returning: async () => [{ id: 'req-1', ...mockInserts[mockInserts.length - 1].row }],
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
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true })) }));
jest.mock('../services/request-app-notifications', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'We got it') }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));

const TwilioService = require('../services/twilio');
const { triggerNotification } = require('../services/notification-triggers');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const logger = require('../services/logger');

async function tapInterest(body) {
  const app = express();
  app.use(express.json());
  app.use('/api/promotions', require('../routes/promotions'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/promotions/promo-7/interest`, {
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

test('a tap rings the add-a-service bell for the customer and texts the owner nothing', async () => {
  const res = await tapInterest({ serviceType: 'mosquito', serviceName: 'Mosquito Control' });

  expect(res).toEqual({ status: 200, json: { success: true } });
  expect(mockInserts).toEqual([expect.objectContaining({ table: 'service_requests', row: expect.objectContaining({ category: 'add_service' }) })]);
  expect(triggerNotification).toHaveBeenCalledWith('bundle_quote_requested', {
    bundled: false,
    customerId: 'cust-1',
    customerName: 'Jamie Rivera',
    suggestedService: 'Mosquito Control',
    relationship: 'add',
    previousTier: 'Silver',
    refreshed: false,
    // The request row, so Mark handled closes the bell (GATE_PORTAL_ITEM_CLOSE, read by bundleRequestAlert).
    requestId: 'req-1',
  });
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  // The customer's own confirmation is unchanged.
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});

test('a customer with no services yet is asking to start one', async () => {
  mockServiceTypes = [];
  await tapInterest({ serviceType: 'lawn_care' });
  expect(triggerNotification).toHaveBeenCalledWith('bundle_quote_requested', expect.objectContaining({
    suggestedService: 'lawn_care', relationship: 'start',
  }));
});

test('a bell failure is logged and the tap still succeeds (the request row stands)', async () => {
  triggerNotification.mockRejectedValueOnce(new Error('bell down'));
  const res = await tapInterest({ serviceType: 'mosquito', serviceName: 'Mosquito Control' });
  expect(res.status).toBe(200);
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Promotion interest bell failed for request req-1'));
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});
