process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    req.technician = { id: 'admin-1', role: 'admin', email: 'owner@example.com' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  newsletterGroupId: jest.fn(() => 101),
  unsubscribeUrl: jest.fn((token) => `https://example.com/unsubscribe/${token}`),
  sendOne: jest.fn(),
}));
jest.mock('../services/newsletter-sender', () => ({}));
jest.mock('../services/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const adminNewsletterRouter = require('../routes/admin-newsletter');

function chain({ first } = {}) {
  const q = {};
  ['where', 'whereRaw', 'orderBy', 'limit', 'offset', 'select'].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.first = jest.fn(async () => first);
  return q;
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/newsletter', adminNewsletterRouter);
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

describe('admin newsletter test recipient guardrails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => {
      if (table !== 'newsletter_sends') throw new Error(`Unexpected table ${table}`);
      return chain({
        first: {
          id: 'send-1',
          html_body: '<p>Hello</p>',
          text_body: 'Hello',
          subject: 'Test newsletter',
          from_email: 'newsletter@wavespestcontrol.com',
          from_name: 'Waves',
          reply_to: 'contact@wavespestcontrol.com',
        },
      });
    });
  });

  test('rejects non-internal test recipients with 400 before SendGrid', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/newsletter/sends/send-1/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'customer@gmail.com' }),
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('test email recipient must be an internal/admin address');
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });
  });

  test('test send neutralizes quiz tokens — operator never previews a literal {{quiz}}', async () => {
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') {
        return chain({
          first: {
            id: 'send-1',
            html_body: '<p>Hi {{quiz}}</p>',
            text_body: 'Hi {{quiz-text}}',
            subject: 'Test newsletter',
            from_email: 'newsletter@wavespestcontrol.com',
            from_name: 'Waves',
            reply_to: 'contact@wavespestcontrol.com',
          },
        });
      }
      if (table === 'newsletter_subscribers') return chain({ first: null });
      throw new Error(`Unexpected table ${table}`);
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'm1' });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/newsletter/sends/send-1/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com' }),
      });
      expect(response.status).toBe(200);
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
      const arg = sendgrid.sendOne.mock.calls[0][0];
      expect(arg.html).not.toContain('{{quiz}}');
      expect(arg.html).toContain("biggest headache"); // neutral quiz block rendered
      expect(arg.text).not.toContain('{{quiz-text}}');
    });
  });
});
