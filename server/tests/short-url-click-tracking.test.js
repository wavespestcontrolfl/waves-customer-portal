/**
 * Short-url click-tracking contracts.
 *
 * Pins: (1) shortenOrPassthrough keeps its bare-string contract (short URL on
 * success, long URL on failure) with NO new columns leaking into untracked
 * call sites; (2) the tracking opts (leadId/channel/purpose/messageRef) ride
 * the insert only when provided; (3) createTrackedShortLink returns
 * { code, shortUrl } and degrades to the long URL; (4) resolveShortCode
 * writes a short_code_clicks row for human UAs (hashed IP, never raw) and
 * writes NO row for bot/preview UAs.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const crypto = require('crypto');
const db = require('../models/db');
const {
  createShortCode,
  createTrackedShortLink,
  shortenOrPassthrough,
  resolveShortCode,
} = require('../services/short-url');

const inserts = [];
const updates = [];
let queues;

function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of ['where', 'whereIn']) b[m] = jest.fn(() => b);
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.insert = jest.fn((payload) => { b._mode = 'insert'; b._payload = payload; inserts.push({ table, payload }); return b; });
  b.returning = jest.fn(() => b);
  b.update = jest.fn((payload) => { b._mode = 'update'; updates.push({ table, payload }); return b; });
  b.then = (resolve, reject) => {
    if (b._mode === 'insert' && cfg.insertError) return Promise.reject(cfg.insertError).then(resolve, reject);
    const value = b._mode === 'insert' ? (cfg.insert ?? [{ code: b._payload.code }])
      : b._mode === 'update' ? (cfg.update ?? 1)
        : b._mode === 'first' ? cfg.first
          : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  b.catch = (onRejected) => b.then(undefined, onRejected);
  return b;
}

function enqueue(table, cfg) { (queues[table] = queues[table] || []).push(cfg); }

beforeEach(() => {
  jest.clearAllMocks();
  inserts.length = 0;
  updates.length = 0;
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
});

const LONG_URL = 'https://portal.wavespestcontrol.com/estimate/tok-abc';

describe('createShortCode tracking opts', () => {
  test('untracked call sites insert EXACTLY the legacy columns — no new keys', async () => {
    await createShortCode(LONG_URL, { kind: 'estimate', entityType: 'estimates', entityId: 'est-1', customerId: 'cust-1' });

    const { payload } = inserts[0];
    expect(Object.keys(payload).sort()).toEqual([
      'code', 'created_by', 'customer_id', 'entity_id', 'entity_type', 'expires_at', 'kind', 'target_url',
    ]);
  });

  test('tracked mints carry lead_id / channel / purpose / message_ref', async () => {
    await createShortCode(LONG_URL, {
      kind: 'estimate', entityType: 'estimates', entityId: 'est-1', customerId: 'cust-1',
      leadId: 'lead-1', channel: 'sms', purpose: 'estimate_followup_viewed', messageRef: 'message_drafts:d-1',
    });

    expect(inserts[0].payload).toMatchObject({
      lead_id: 'lead-1',
      channel: 'sms',
      purpose: 'estimate_followup_viewed',
      message_ref: 'message_drafts:d-1',
    });
  });
});

describe('shortenOrPassthrough — bare-string contract unchanged', () => {
  test('returns the short URL string on success', async () => {
    const url = await shortenOrPassthrough(LONG_URL, { kind: 'estimate' });
    expect(typeof url).toBe('string');
    expect(url).toMatch(/\/l\/[a-z0-9-]+$/);
  });

  test('falls back to the long URL string on shortener failure', async () => {
    // Exhaust all 8 collision retries so createShortCode throws.
    const err = Object.assign(new Error('duplicate'), { code: '23505', detail: 'short_codes_code_unique' });
    for (let i = 0; i < 8; i++) enqueue('short_codes', { insertError: err });
    const url = await shortenOrPassthrough(LONG_URL, { kind: 'estimate' });
    expect(url).toBe(LONG_URL);
  });
});

describe('createTrackedShortLink', () => {
  test('returns { code, shortUrl } on success', async () => {
    const out = await createTrackedShortLink(LONG_URL, { kind: 'estimate', channel: 'sms', purpose: 'click_followup' });
    expect(out.code).toMatch(/^[a-z0-9-]+$/);
    expect(out.shortUrl).toContain(`/l/${out.code}`);
  });

  test('degrades to { code: null, shortUrl: longUrl } on failure — never blocks the caller', async () => {
    const err = Object.assign(new Error('duplicate'), { code: '23505', detail: 'short_codes_code_unique' });
    for (let i = 0; i < 8; i++) enqueue('short_codes', { insertError: err });
    const out = await createTrackedShortLink(LONG_URL, { kind: 'estimate' });
    expect(out).toEqual({ code: null, shortUrl: LONG_URL });
  });
});

describe('resolveShortCode click rows', () => {
  const ROW = { id: 'sc-1', code: 'k3j9x', target_url: LONG_URL, expires_at: null };
  const HUMAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
  const BOT_UA = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';

  test('human click → short_code_clicks row with sha256 ip hash, never the raw IP', async () => {
    enqueue('short_codes', { first: ROW });

    const target = await resolveShortCode('k3j9x', { ip: '203.0.113.9', userAgent: HUMAN_UA });

    expect(target).toBe(LONG_URL);
    // Counter cache still bumps on the code row.
    expect(updates[0].table).toBe('short_codes');
    // Per-click row.
    const click = inserts.find((i) => i.table === 'short_code_clicks');
    expect(click).toBeDefined();
    expect(click.payload).toMatchObject({
      short_code_id: 'sc-1',
      is_bot: false,
      user_agent: HUMAN_UA,
      ip_hash: crypto.createHash('sha256').update('203.0.113.9').digest('hex'),
    });
    expect(JSON.stringify(click.payload)).not.toContain('203.0.113.9');
  });

  test('bot/preview UA → NO click row (counter path untouched by this PR)', async () => {
    enqueue('short_codes', { first: ROW });

    const target = await resolveShortCode('k3j9x', { ip: '203.0.113.9', userAgent: BOT_UA });

    expect(target).toBe(LONG_URL);
    expect(inserts.find((i) => i.table === 'short_code_clicks')).toBeUndefined();
  });

  test('unknown / expired codes resolve to null with no telemetry', async () => {
    enqueue('short_codes', { first: undefined });
    expect(await resolveShortCode('nope', { userAgent: HUMAN_UA })).toBeNull();

    enqueue('short_codes', { first: { ...ROW, expires_at: new Date(Date.now() - 1000) } });
    expect(await resolveShortCode('k3j9x', { userAgent: HUMAN_UA })).toBeNull();

    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  test('click-row insert failure is swallowed — the redirect never breaks', async () => {
    enqueue('short_codes', { first: ROW });
    enqueue('short_code_clicks', { insertError: new Error('relation missing') });

    const target = await resolveShortCode('k3j9x', { ip: '1.2.3.4', userAgent: HUMAN_UA });
    expect(target).toBe(LONG_URL);
  });
});
