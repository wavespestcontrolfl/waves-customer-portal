jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((...args) => mock(...args));
    trx.fn = mock.fn;
    return fn(trx);
  });
  return mock;
});

jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));

jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));

jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => false),
  sendOne: jest.fn(),
}));

jest.mock('../services/logger', () => ({
  error: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const adminServiceOutlines = require('../routes/admin-service-outlines');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    insert: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/service-outlines', adminServiceOutlines);
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

describe('admin service outline sends', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does not rotate an existing outline token when SMS delivery throws', async () => {
    const packetQuery = chain({
      first: jest.fn().mockResolvedValue({
        id: 'packet-1',
        estimate_id: 'estimate-1',
        customer_id: 'customer-1',
        status: 'sent',
        validation_status: 'passed',
        token_hash: 'old-token-hash',
        expires_at: null,
        revoked_at: null,
      }),
    });
    const estimateQuery = chain({
      first: jest.fn().mockResolvedValue({
        id: 'estimate-1',
        customer_id: 'customer-1',
        customer_phone: '+19415550123',
        customer_email: 'customer@example.com',
        customer_name: 'Ava',
      }),
    });

    db.mockImplementation((table) => {
      if (table === 'service_outline_packets') return packetQuery;
      if (table === 'estimates') return estimateQuery;
      return chain();
    });
    sendCustomerMessage.mockRejectedValueOnce(new Error('provider unavailable'));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/service-outlines/packet-1/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'sms' }),
      });
      expect(res.status).toBe(500);
    });

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(packetQuery.update).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
