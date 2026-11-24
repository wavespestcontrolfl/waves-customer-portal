// Press-1 all-unknown trial (GATE_CALL_SCREEN_ALL_UNKNOWN, owner 2026-11-24
// "trial"): who still rings straight through. A staff phone, a number on a live
// lead and a remembered caller skip the prompt; every read fails open (no
// challenge), so a broken query never makes a real caller press a key.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const logger = require('../services/logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { screenAllUnknownHit, withinLimit, callerKey } = require('../services/press1-screen-all-unknown');

// A chainable fake: each table answers .first() with its configured row.
function fakeDb({ technicians = null, leads = null, call_log = null, throwOn = null } = {}) {
  const seen = { tables: [], sql: [] };
  db.mockImplementation((table) => {
    seen.tables.push(table);
    const builder = {};
    const chain = () => builder;
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'orWhere', 'orWhereNull', 'orWhereNotNull', 'timeout']) builder[m] = jest.fn((arg) => {
      if (typeof arg === 'function') arg(builder);
      return chain();
    });
    builder.whereRaw = jest.fn((sql, bindings) => { seen.sql.push(sql); seen.bindings = [...(seen.bindings || []), ...(bindings || [])]; return builder; });
    builder.whereIn = jest.fn((col, vals) => { seen.whereIn = [...(seen.whereIn || []), [col, vals]]; return builder; });
    builder.first = jest.fn(async () => {
      if (throwOn === table) throw Object.assign(new Error('canceling statement due to statement timeout +19415550101'), { code: '57014' });
      return { technicians, leads, call_log }[table];
    });
    return builder;
  });
  return seen;
}

afterEach(() => { db.mockReset(); jest.clearAllMocks(); jest.restoreAllMocks(); });

const CALLER = '+19415550101';

test('an unknown caller with no lead and no earlier conversation hears the prompt', async () => {
  const seen = fakeDb();
  await expect(screenAllUnknownHit(CALLER)).resolves.toBe(true);
  expect(seen.tables).toEqual(['technicians', 'leads', 'call_log']);
});

test('a number on a live lead rings through', async () => {
  fakeDb({ leads: { id: 'l1' } });
  await expect(screenAllUnknownHit(CALLER)).resolves.toBe(false);
});

test('a remembered caller (talked with the office, or left a message) rings through', async () => {
  fakeDb({ call_log: { id: 'c1' } });
  await expect(screenAllUnknownHit(CALLER)).resolves.toBe(false);
});

test('an active technician phone rings through, with no lead or call read', async () => {
  const seen = fakeDb({ technicians: { id: 't1' } });
  await expect(screenAllUnknownHit(CALLER)).resolves.toBe(false);
  expect(seen.tables).toEqual(['technicians']);
});

test('a message counts only on a call nobody answered; any call Sandy touched proves nothing', async () => {
  const seen = fakeDb();
  await screenAllUnknownHit(CALLER);
  expect(seen.whereIn).toContainEqual(['answered_by', ['missed', 'voicemail', 'unknown']]);
  expect(seen.sql.some((q) => q.startsWith("COALESCE(call_outcome, '') NOT IN"))).toBe(true);
  expect(seen.bindings).toEqual(expect.arrayContaining(['ai_handled', 'ai_transferred']));
});

test('an outbound call counts only when its customer leg connected for 30 s or more', async () => {
  const seen = fakeDb();
  await screenAllUnknownHit(CALLER);
  expect(seen.sql).toContain("metadata->'customer_leg'->>'status' = 'completed'");
  expect(seen.sql.some((q) => q.includes("customer_leg'->>'duration_seconds')::numeric >= ?"))).toBe(true);
});

test('reads that run past the shared 1.5 s deadline fail open (no prompt)', async () => {
  jest.useFakeTimers();
  try {
    db.mockImplementation(() => {
      const b = {};
      for (const m of ['where', 'whereRaw', 'whereIn', 'whereNull', 'timeout']) b[m] = () => b;
      b.first = () => new Promise(() => {});
      return b;
    });
    const pending = screenAllUnknownHit(CALLER);
    await jest.advanceTimersByTimeAsync(1600);
    await expect(pending).resolves.toBe(false);
    expect(logger.warn.mock.calls.map((c) => c[0]).join(' ')).toContain('past its limit');
  } finally {
    jest.useRealTimers();
  }
});

test('a Waves line or env staff phone rings through without any read', async () => {
  jest.spyOn(TWILIO_NUMBERS, 'isInternalNumber').mockReturnValue(true);
  const seen = fakeDb();
  await expect(screenAllUnknownHit(CALLER)).resolves.toBe(false);
  expect(seen.tables).toEqual([]);
});

test.each(['technicians', 'leads', 'call_log'])('a failed %s read fails open (no prompt) and logs no phone number', async (table) => {
  fakeDb({ throwOn: table });
  await expect(screenAllUnknownHit(CALLER)).resolves.toBe(false);
  const line = logger.warn.mock.calls.map((c) => c[0]).join(' ');
  expect(line).toContain('failing open');
  expect(line).not.toMatch(/5550101/);
});

test('an anonymous or short caller id is never screened by the trial', async () => {
  const seen = fakeDb();
  for (const from of ['', 'anonymous', '+266696687', '12345']) {
    await expect(screenAllUnknownHit(from)).resolves.toBe(false);
  }
  expect(seen.tables).toEqual([]);
});

test('callerKey matches phoneKeySql for stored US numbers', () => {
  expect(callerKey('+19415550101')).toBe('19415550101');
  expect(callerKey('(941) 555-0101')).toBe('19415550101');
  expect(callerKey('9415550101')).toBe('19415550101');
});

test('withinLimit answers the fallback once the read runs past 1.5 s', async () => {
  jest.useFakeTimers();
  try {
    const pending = withinLimit(new Promise(() => {}), 'fallback');
    await jest.advanceTimersByTimeAsync(1600);
    await expect(pending).resolves.toBe('fallback');
    await expect(withinLimit(Promise.resolve('fast'), 'fallback')).resolves.toBe('fast');
  } finally {
    jest.useRealTimers();
  }
});

test('once the deadline passes, no later read starts (the lead and call reads never run)', async () => {
  jest.useFakeTimers();
  try {
    const tables = [];
    db.mockImplementation((table) => {
      tables.push(table);
      const b = {};
      for (const m of ['where', 'whereRaw', 'whereIn', 'whereNull', 'orWhere', 'orWhereNull', 'whereNotNull', 'orWhereNotNull']) b[m] = (arg) => { if (typeof arg === 'function') arg(b); return b; };
      b.timeout = () => b;
      // The technician read answers only after the deadline.
      b.first = () => new Promise((resolve) => setTimeout(() => resolve(null), 2000));
      return b;
    });
    const pending = screenAllUnknownHit(CALLER);
    await jest.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toBe(false);
    expect(tables).toEqual(['technicians']);
  } finally {
    jest.useRealTimers();
  }
});

test('a Sandy transfer and the staff talk time are part of the remembered-caller proof', async () => {
  const seen = fakeDb();
  await screenAllUnknownHit(CALLER);
  expect(seen.sql.some((q) => q.includes("jsonb_exists(metadata, 'relay_transfer_ring_at')"))).toBe(true);
  expect(seen.sql.some((q) => q.includes("forward_acceptance'->>'accepted_at'"))).toBe(true);
});
