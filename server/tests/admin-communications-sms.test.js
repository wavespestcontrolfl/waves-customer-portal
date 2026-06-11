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
