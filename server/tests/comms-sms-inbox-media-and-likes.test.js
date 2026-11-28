/**
 * Targeted tests for PR 7 of the 2026-11-27 Communications audit:
 *   C2-02: HMAC attachment validation, drop raw mediaUrls, https-only fallback
 *   C2-15: Multer error handling returns 413/415 instead of 500
 *   C2-25: Monotonic delivery_status transitions in conversations.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockGetSignedUrl = jest.fn(async (_s3, cmd) => `https://s3.example.com/signed/${encodeURIComponent(cmd.input.Key)}`);
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => mockGetSignedUrl(...args),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn(async () => ({})) })),
  PutObjectCommand: jest.fn((input) => ({ input })),
  GetObjectCommand: jest.fn((input) => ({ input })),
}));
jest.mock('../config', () => ({
  jwt: { secret: 'test-jwt-secret' },
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
  twilio: { accountSid: 'AC_test', authToken: 'auth_test' },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.techRole = 'admin';
    req.technicianId = 'admin-1';
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const smsMedia = require('../services/sms-media');
const attachRouter = require('../routes/admin-communications-attach');

function withAttachServer(fn) {
  const app = express();
  app.use('/api/admin/communications', attachRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin/communications`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('C2-02: sms-media HMAC validation & safe URLs', () => {
  test('resolveVerifiedOutboundAttachments rejects invalid attachmentToken and never trusts client url', async () => {
    const res = await smsMedia.resolveVerifiedOutboundAttachments([
      {
        key: 'sms-attachments/123-evil.jpg',
        url: 'javascript:alert(1)',
        size: 1024,
        mimeType: 'image/jpeg',
        attachmentToken: 'deadbeef',
      },
    ]);
    expect(res).toEqual({ error: 'Invalid or unverified media attachment', status: 400 });
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  test('resolveVerifiedOutboundAttachments rejects tampered size even with valid key', async () => {
    const token = smsMedia.createAttachmentToken({
      key: 'sms-attachments/123-big.jpg',
      size: 6 * 1024 * 1024,
      mimeType: 'image/jpeg',
    });
    const res = await smsMedia.resolveVerifiedOutboundAttachments([
      {
        key: 'sms-attachments/123-big.jpg',
        url: 'https://attacker.example/evil.jpg',
        size: 100, // tampered size
        mimeType: 'image/jpeg',
        attachmentToken: token,
      },
    ]);
    expect(res).toEqual({ error: 'Invalid or unverified media attachment', status: 400 });
  });

  test('resolveVerifiedOutboundAttachments derives presigned URL server-side for valid HMAC token', async () => {
    const key = 'sms-attachments/123-photo.jpg';
    const token = smsMedia.createAttachmentToken({ key, size: 2048, mimeType: 'image/jpeg' });
    const res = await smsMedia.resolveVerifiedOutboundAttachments([
      {
        key,
        url: 'https://attacker.example/ignored.jpg',
        fileName: 'photo.jpg',
        size: 2048,
        mimeType: 'image/jpeg',
        attachmentToken: token,
      },
    ]);
    expect(res.error).toBeUndefined();
    expect(res.mediaUrls).toEqual([`https://s3.example.com/signed/${encodeURIComponent(key)}`]);
    expect(res.media).toEqual([
      {
        direction: 'outbound',
        key,
        url: null,
        fileName: 'photo.jpg',
        contentType: 'image/jpeg',
        size: 2048,
        index: 0,
      },
    ]);
  });

  test('resolveVerifiedOutboundAttachments rejects more than 10 attachments before signing anything', async () => {
    const attachments = Array.from({ length: 11 }, (_, i) => {
      const key = `sms-attachments/file-${i}.jpg`;
      return {
        key,
        fileName: `file-${i}.jpg`,
        size: 1024,
        mimeType: 'image/jpeg',
        attachmentToken: smsMedia.createAttachmentToken({ key, size: 1024, mimeType: 'image/jpeg' }),
      };
    });
    const res = await smsMedia.resolveVerifiedOutboundAttachments(attachments);
    expect(res).toEqual({ error: 'Too many attachments (maximum 10 per message)', status: 400 });
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  test('mediaFromOutboundAttachments drops raw urls and invalid tokens', () => {
    expect(smsMedia.mediaFromOutboundAttachments([], ['https://attacker.example/x.png'])).toEqual([]);
    expect(smsMedia.mediaFromOutboundAttachments([
      { key: 'sms-attachments/1.jpg', url: 'javascript:alert(1)', attachmentToken: 'bad' },
    ])).toEqual([]);
  });

  test('signMediaForClient strips javascript: fallback URLs', async () => {
    const signed = await smsMedia.signMediaForClient([
      { key: null, url: 'javascript:alert(1)', fileName: 'bad.jpg' },
      { key: null, url: 'https://cdn.example.com/good.jpg', fileName: 'good.jpg' },
    ]);
    expect(signed[0].url).toBeNull();
    expect(signed[1].url).toBe('https://cdn.example.com/good.jpg');
  });
});

describe('C2-15: /attach Multer error handling', () => {
  test('returns 415 for unsupported file type (e.g. HEIC / PDF) instead of 500', async () => {
    await withAttachServer(async (base) => {
      const form = new FormData();
      form.append('attachments', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'quote.pdf');
      const res = await fetch(`${base}/attach`, { method: 'POST', body: form });
      const body = await res.json();
      expect(res.status).toBe(415);
      expect(body.error).toMatch(/Unsupported file type/);
    });
  });

  test('returns 413 when file exceeds 5MB limit instead of 500', async () => {
    await withAttachServer(async (base) => {
      const form = new FormData();
      const big = new Uint8Array(5 * 1024 * 1024 + 10);
      form.append('attachments', new Blob([big], { type: 'image/jpeg' }), 'huge.jpg');
      const res = await fetch(`${base}/attach`, { method: 'POST', body: form });
      const body = await res.json();
      expect(res.status).toBe(413);
      expect(body.error).toMatch(/5MB limit/);
    });
  });
});

describe('C2-25: monotonic delivery_status transitions in conversations.appendMessage', () => {
  test('late sent does not overwrite delivered or failed on SMS messages', async () => {
    const updates = [];
    await jest.isolateModulesAsync(async () => {
      const mockTrx = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        first: jest.fn(async () => ({ id: 'msg-1', delivery_status: 'delivered', metadata: {} })),
        update: jest.fn((patch) => {
          updates.push(patch);
          return { returning: jest.fn(async () => [{ id: 'msg-1', ...patch }]) };
        }),
      }));
      mockTrx.raw = jest.fn(async () => ({}));
      const mockDb = Object.assign(jest.fn(), {
        transaction: jest.fn(async (cb) => cb(mockTrx)),
      });
      jest.doMock('../models/db', () => mockDb);
      const conversations = require('../services/conversations');
      await conversations.appendMessage({
        conversationId: 'conv-1',
        channel: 'sms',
        direction: 'outbound',
        authorType: 'staff',
        twilioSid: 'SM-123',
        deliveryStatus: 'sent',
      });
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].delivery_status).toBeUndefined();
  });

  test('delivered advances sent on SMS messages', async () => {
    const updates = [];
    await jest.isolateModulesAsync(async () => {
      const mockTrx = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        first: jest.fn(async () => ({ id: 'msg-2', delivery_status: 'sent', metadata: {} })),
        update: jest.fn((patch) => {
          updates.push(patch);
          return { returning: jest.fn(async () => [{ id: 'msg-2', ...patch }]) };
        }),
      }));
      mockTrx.raw = jest.fn(async () => ({}));
      const mockDb = Object.assign(jest.fn(), {
        transaction: jest.fn(async (cb) => cb(mockTrx)),
      });
      jest.doMock('../models/db', () => mockDb);
      const conversations = require('../services/conversations');
      await conversations.appendMessage({
        conversationId: 'conv-1',
        channel: 'sms',
        direction: 'outbound',
        authorType: 'staff',
        twilioSid: 'SM-124',
        deliveryStatus: 'delivered',
      });
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].delivery_status).toBe('delivered');
  });
});
