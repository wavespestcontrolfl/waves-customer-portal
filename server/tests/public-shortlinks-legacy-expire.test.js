/**
 * GATE_SHORTLINK_LEGACY_EXPIRE (security audit 2026-10-02): ~2k live 5-char
 * short codes (≈26 bits, minted 2026-04-19..2026-08-07) front never-expiring
 * bearer-token URLs. Gate on: /l/<1-7 char code> answers 410 (existing expired
 * page) and resolveShortCode returns null for it; 10-char codes and unknown
 * codes behave as before. Gate off: byte-identical. Independent of the gate,
 * existingShortUrlFor never hands back a legacy code for a re-send.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ jwt: { secret: 'shortlink-legacy-test-secret' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/short-url', () => ({
  ...jest.requireActual('../services/short-url'),
  resolveShortCode: jest.fn(() => Promise.resolve('https://portal.example.test/x')),
}));

const express = require('express');
const db = require('../models/db');
const shortUrl = require('../services/short-url');

const TARGET = 'https://portal.example.test/reschedule/bearer-token';
const HUMAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1';
const ROWS = {
  abcde: { id: 'sc-legacy', code: 'abcde', target_url: TARGET, expires_at: null },
  abcdefghjk: { id: 'sc-long', code: 'abcdefghjk', target_url: TARGET, expires_at: null },
};

let server;
let base;
const savedGate = process.env.GATE_SHORTLINK_LEGACY_EXPIRE;

function mockShortCodes() {
  db.mockImplementation((table) => {
    const b = {};
    let code;
    b.where = jest.fn((cond) => { code = cond && cond.code; return b; });
    b.first = jest.fn(() => Promise.resolve(table === 'short_codes' ? ROWS[code] : undefined));
    return b;
  });
}

beforeAll((done) => {
  const app = express();
  app.use('/l', require('../routes/public-shortlinks'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  if (savedGate === undefined) delete process.env.GATE_SHORTLINK_LEGACY_EXPIRE; else process.env.GATE_SHORTLINK_LEGACY_EXPIRE = savedGate;
  server.close(done);
});
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_SHORTLINK_LEGACY_EXPIRE;
  mockShortCodes();
});

const hit = (code) => fetch(`${base}/l/${code}`, { redirect: 'manual', headers: { 'user-agent': HUMAN_UA } });

describe('GET /l/:code with GATE_SHORTLINK_LEGACY_EXPIRE', () => {
  test('gate unset: a live 5-char code still 302s to its target', async () => {
    const res = await hit('abcde');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(TARGET);
    expect(shortUrl.resolveShortCode).toHaveBeenCalledTimes(1);
  });

  test('gate on: the same 5-char row answers 410 with the expired page and never resolves', async () => {
    process.env.GATE_SHORTLINK_LEGACY_EXPIRE = 'true';
    const res = await hit('abcde');
    expect(res.status).toBe(410);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('This link has expired');
    expect(shortUrl.resolveShortCode).not.toHaveBeenCalled();
  });

  test('gate on: a 10-char row still 302s', async () => {
    process.env.GATE_SHORTLINK_LEGACY_EXPIRE = 'true';
    const res = await hit('abcdefghjk');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(TARGET);
    expect(shortUrl.resolveShortCode).toHaveBeenCalledTimes(1);
  });

  test('gate on: an unknown 5-char code is still 404, not 410', async () => {
    process.env.GATE_SHORTLINK_LEGACY_EXPIRE = 'true';
    const res = await hit('zzzzz');
    expect(res.status).toBe(404);
    expect(shortUrl.resolveShortCode).not.toHaveBeenCalled();
  });

  test('the gate is strict: any value but "true" leaves legacy codes live', async () => {
    process.env.GATE_SHORTLINK_LEGACY_EXPIRE = '1';
    const res = await hit('abcde');
    expect(res.status).toBe(302);
  });
});

describe('short-url legacy code handling', () => {
  test('isLegacyShortCode boundaries: 7 chars is legacy, 8 is not', () => {
    expect(shortUrl.LEGACY_CODE_MAX_LENGTH).toBe(7);
    expect(shortUrl.isLegacyShortCode('abcde')).toBe(true);
    expect(shortUrl.isLegacyShortCode('abcdefg')).toBe(true);
    expect(shortUrl.isLegacyShortCode('abcdefgh')).toBe(false);
    expect(shortUrl.isLegacyShortCode('abcdefghjk')).toBe(false);
    expect(shortUrl.isLegacyShortCode('')).toBe(false);
    expect(shortUrl.isLegacyShortCode(null)).toBe(false);
  });

  test('resolveShortCode returns null for a legacy code only while the gate is on', async () => {
    const real = jest.requireActual('../services/short-url');
    const builder = (row) => {
      const b = {};
      b.where = jest.fn(() => b);
      b.first = jest.fn(() => Promise.resolve(row));
      b.update = jest.fn(() => Promise.resolve(1));
      b.insert = jest.fn(() => Promise.resolve([1]));
      return b;
    };
    db.raw = jest.fn((expr) => expr);
    db.mockImplementation(() => builder(ROWS.abcde));
    process.env.GATE_SHORTLINK_LEGACY_EXPIRE = 'true';
    expect(await real.resolveShortCode('abcde', { userAgent: HUMAN_UA })).toBeNull();
    // no telemetry bump: only the lookup builder was created
    expect(db).toHaveBeenCalledTimes(1);
    delete process.env.GATE_SHORTLINK_LEGACY_EXPIRE;
    expect(await real.resolveShortCode('abcde', { userAgent: HUMAN_UA })).toBe(TARGET);
  });

  test.each([undefined, 'true'])('existingShortUrlFor skips legacy codes in the lookup (gate=%s)', async (gate) => {
    if (gate) process.env.GATE_SHORTLINK_LEGACY_EXPIRE = gate;
    const q = {};
    q.where = jest.fn(() => q);
    q.whereRaw = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.first = jest.fn(() => Promise.resolve({ code: 'abcdefghjk' }));
    db.mockImplementation(() => q);
    const real = jest.requireActual('../services/short-url');
    const url = await real.existingShortUrlFor({ kind: 'reschedule', entityType: 'scheduled_service', entityId: 7 });
    expect(q.whereRaw).toHaveBeenCalledWith('char_length(code) > ?', [7]);
    expect(url).toMatch(/\/l\/abcdefghjk$/);
  });

  test('allShortUrlsFor returns every code for the entity, legacy and replacement, with no length filter (history reader)', async () => {
    process.env.GATE_SHORTLINK_LEGACY_EXPIRE = 'true';
    const q = {};
    q.where = jest.fn(() => q);
    q.whereRaw = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.select = jest.fn(() => Promise.resolve([{ code: 'abcde' }, { code: 'abcdefghjk' }]));
    db.mockImplementation(() => q);
    const real = jest.requireActual('../services/short-url');
    const urls = await real.allShortUrlsFor({ kind: 'review', entityType: 'review_requests', entityId: 'rr-1', rethrow: true });
    expect(q.whereRaw).not.toHaveBeenCalled();
    expect(urls.map((u) => u.split('/l/')[1])).toEqual(['abcde', 'abcdefghjk']);
  });

  test('allShortUrlsFor rethrows a lookup failure when asked (unreadable ≠ no codes)', async () => {
    const q = {};
    q.where = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.select = jest.fn(() => Promise.reject(new Error('db down')));
    db.mockImplementation(() => q);
    const real = jest.requireActual('../services/short-url');
    await expect(real.allShortUrlsFor({ kind: 'review', entityType: 'review_requests', entityId: 'rr-1', rethrow: true })).rejects.toThrow('db down');
    expect(await real.allShortUrlsFor({ kind: 'review', entityType: 'review_requests', entityId: 'rr-1' })).toEqual([]);
  });
});
