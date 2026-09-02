/**
 * GATE_TECH_DICTATION_UPLOAD — field dictation upload on /api/tech/services.
 *
 * Invariants: gate off → availability false and POST 404; techs only for
 * their own assigned service (admin any); audio mime allowlist; the clip is
 * transcribed with the call-recording transcriber (never persisted) and the
 * response carries text only; transcriber miss → 502, never a fake transcript.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockTranscribe = jest.fn();
const mockFirst = jest.fn();

jest.mock('../models/db', () => {
  const chain = { where: jest.fn(() => chain), first: (...a) => mockFirst(...a) };
  return jest.fn(() => chain);
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({
  transcribeWithOpenAI: (...args) => mockTranscribe(...args),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
      other: { id: 'tech-2', role: 'technician' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
}));

const express = require('express');
const router = require('../routes/tech-track');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/tech/services', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

function clip(baseUrl, { token = 'tech', type = 'audio/webm;codecs=opus', bytes = 'opus-bytes' } = {}) {
  const form = new FormData();
  form.append('audio', new Blob([bytes], { type }), 'dictation.webm');
  return fetch(`${baseUrl}/api/tech/services/svc-1/dictation`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
}

describe('call-recording-processor production surface', () => {
  test('exports transcribeWithOpenAI on the module itself, not only _test (pre-push P1)', () => {
    const real = jest.requireActual('../services/call-recording-processor');
    expect(typeof real.transcribeWithOpenAI).toBe('function');
  });
});

describe('tech dictation upload', () => {
  const original = process.env.GATE_TECH_DICTATION_UPLOAD;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_TECH_DICTATION_UPLOAD = 'true';
    process.env.OPENAI_API_KEY = 'test-key';
    mockFirst.mockResolvedValue({ id: 'svc-1', technician_id: 'tech-1' });
    mockTranscribe.mockResolvedValue({ text: '  Treated the exterior perimeter. ', provider: 'openai' });
  });
  afterAll(() => {
    if (original === undefined) delete process.env.GATE_TECH_DICTATION_UPLOAD;
    else process.env.GATE_TECH_DICTATION_UPLOAD = original;
  });

  test('gate off: availability false, upload 404, transcriber never called', async () => {
    delete process.env.GATE_TECH_DICTATION_UPLOAD;
    await withServer(async (baseUrl) => {
      const avail = await fetch(`${baseUrl}/api/tech/services/svc-1/dictation/availability`, { headers: { Authorization: 'Bearer tech' } });
      expect(await avail.json()).toEqual({ available: false });
      const res = await clip(baseUrl);
      expect(res.status).toBe(404);
      expect(mockTranscribe).not.toHaveBeenCalled();
    });
  });

  test('gate on: availability true for the assigned tech; 403 for another tech; admin allowed', async () => {
    await withServer(async (baseUrl) => {
      const mine = await fetch(`${baseUrl}/api/tech/services/svc-1/dictation/availability`, { headers: { Authorization: 'Bearer tech' } });
      expect(await mine.json()).toEqual({ available: true });
      const theirs = await fetch(`${baseUrl}/api/tech/services/svc-1/dictation/availability`, { headers: { Authorization: 'Bearer other' } });
      expect(theirs.status).toBe(403);
      const denied = await clip(baseUrl, { token: 'other' });
      expect(denied.status).toBe(403);
      expect(mockTranscribe).not.toHaveBeenCalled();
      const admin = await clip(baseUrl, { token: 'admin' });
      expect(admin.status).toBe(200);
    });
  });

  test('transcribes the clip with the call transcriber (mime + filename passed) and returns trimmed text only', async () => {
    await withServer(async (baseUrl) => {
      const res = await clip(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: 'Treated the exterior perimeter.' });
      expect(mockTranscribe).toHaveBeenCalledTimes(1);
      const [buffer, opts] = mockTranscribe.mock.calls[0];
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.toString()).toBe('opus-bytes');
      expect(opts.mimeType).toBe('audio/webm');
      expect(opts.filename).toBe('clip.webm');
      expect(opts.model).toBe('gpt-4o-transcribe');
      expect(opts.prompt).toMatch(/field notes/);
    });
  });

  test('unsupported audio type → 415; empty body → 400; transcriber miss → 502 with no fake text', async () => {
    await withServer(async (baseUrl) => {
      expect((await clip(baseUrl, { type: 'video/mp4' })).status).toBe(415);
      const empty = await fetch(`${baseUrl}/api/tech/services/svc-1/dictation`, { method: 'POST', headers: { Authorization: 'Bearer tech' } });
      expect(empty.status).toBe(400);
      mockTranscribe.mockResolvedValue(null);
      const miss = await clip(baseUrl);
      expect(miss.status).toBe(502);
      expect((await miss.json()).text).toBeUndefined();
    });
  });
});
