process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
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

const express = require('express');
const communicationsRouter = require('../routes/admin-communications');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

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
});
