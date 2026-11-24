// Press-1 all-unknown trial (GATE_CALL_SCREEN_ALL_UNKNOWN, owner 2026-11-24
// "trial"): who still rings straight through. A staff phone, an active
// technician, a number on a live lead and a remembered caller skip the prompt.
// One statement answers it; a failure or a slow read fails open (no challenge),
// so a broken query never makes a real caller press a key.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.select = jest.fn();
  return db;
});

const db = require('../models/db');
const logger = require('../services/logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { screenAllUnknownHit, withinLimit, callerKey } = require('../services/press1-screen-all-unknown');

// Fake: the three subquery builders record their SQL; the outer select answers
// `first()` with the given row (or a promise, or rejects with an Error).
function fakeDb(answer = { tech: false, lead: false, remembered: false }) {
  const seen = { tables: [], sql: [], bindings: [], whereIn: [], timeout: null };
  db.mockImplementation((table) => {
    seen.tables.push(table);
    const b = {};
    for (const m of ['select', 'where', 'whereNull', 'whereNotNull', 'orWhere', 'orWhereNull', 'orWhereNotNull']) {
      b[m] = jest.fn((arg) => { if (typeof arg === 'function') arg(b); return b; });
    }
    b.whereRaw = jest.fn((sql, bindings) => { seen.sql.push(sql); seen.bindings.push(...(bindings || [])); return b; });
    b.whereIn = jest.fn((col, vals) => { seen.whereIn.push([col, vals]); return b; });
    return b;
  });
  db.select.mockImplementation(() => {
    const outer = {
      timeout: jest.fn((ms, opts) => { seen.timeout = [ms, opts]; return outer; }),
      first: jest.fn(() => {
        if (answer instanceof Promise) return answer;
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(answer);
      }),
    };
    return outer;
  });
  return seen;
}

afterEach(() => { db.mockReset(); db.select.mockReset(); jest.clearAllMocks(); jest.restoreAllMocks(); });

const CALLER = '+19415550101';

test('an unknown caller with no lead, no staff phone and no earlier conversation hears the prompt', async () => {
  const seen = fakeDb();
  await expect(screenAllUnknownHit(CALLER)).resolves.toBe(true);
  expect(seen.tables).toEqual(['technicians', 'leads', 'call_log']);
  expect(db.select).toHaveBeenCalledTimes(1);
  expect(seen.timeout).toEqual([1500, { cancel: true }]);
});

test.each([
  ['an active technician phone', { tech: true, lead: false, remembered: false }],
  ['a number on a live lead', { tech: false, lead: true, remembered: false }],
  ['a remembered caller', { tech: false, lead: false, remembered: true }],
])('%s rings through', async (_label, answer) => {
  fakeDb(answer);
  await expect(screenAllUnknownHit(CALLER)).resolves.toBe(false);
});

test('a Waves line or env staff phone rings through without any read', async () => {
  jest.spyOn(TWILIO_NUMBERS, 'isInternalNumber').mockReturnValue(true);
  fakeDb();
  await expect(screenAllUnknownHit(CALLER)).resolves.toBe(false);
  expect(db.select).not.toHaveBeenCalled();
});

test('an anonymous or short caller id is never screened by the trial', async () => {
  fakeDb();
  for (const from of ['', 'anonymous', '+266696687', '12345']) {
    await expect(screenAllUnknownHit(from)).resolves.toBe(false);
  }
  expect(db.select).not.toHaveBeenCalled();
});

test('a failed read fails open (no prompt) and logs no phone number', async () => {
  fakeDb(Object.assign(new Error('canceling statement due to statement timeout +19415550101'), { code: '57014' }));
  await expect(screenAllUnknownHit(CALLER)).resolves.toBe(false);
  const line = logger.warn.mock.calls.map((c) => c[0]).join(' ');
  expect(line).toContain('failing open');
  expect(line).toContain('57014');
  expect(line).not.toMatch(/5550101/);
});

test('a read that runs past 1.5 s (a pool wait too) fails open (no prompt)', async () => {
  jest.useFakeTimers();
  try {
    fakeDb(new Promise(() => {}));
    const pending = screenAllUnknownHit(CALLER);
    await jest.advanceTimersByTimeAsync(1600);
    await expect(pending).resolves.toBe(false);
    expect(logger.warn.mock.calls.map((c) => c[0]).join(' ')).toContain('past its limit');
  } finally {
    jest.useRealTimers();
  }
});

describe('the remembered-caller proof', () => {
  let seen;
  beforeEach(async () => { seen = fakeDb(); await screenAllUnknownHit(CALLER); });

  test('a message counts only on a call nobody answered, with a finished transcript that holds words', () => {
    expect(seen.whereIn).toContainEqual(['answered_by', ['missed', 'voicemail', 'unknown']]);
    expect(seen.sql.some((q) => q.startsWith("regexp_replace(COALESCE(transcription, ''), ?"))).toBe(true);
    expect(seen.bindings.some((b) => typeof b === 'string' && b.includes('NO SPEECH'))).toBe(true);
  });

  test('any call Sandy handled or transferred proves nothing', () => {
    expect(seen.sql.some((q) => q.startsWith("COALESCE(call_outcome, '') NOT IN"))).toBe(true);
    expect(seen.bindings).toEqual(expect.arrayContaining(['ai_handled', 'ai_transferred']));
    expect(seen.sql.some((q) => q.includes("jsonb_exists(metadata, 'relay_transfer_ring_at')"))).toBe(true);
  });

  test('staff talk time runs from the staff press 1 to the recorded end', () => {
    expect(seen.sql.some((q) => q.includes("forward_acceptance'->>'accepted_at'") && q.includes("(metadata->>'ended_at')::timestamptz"))).toBe(true);
  });

  test('an outbound call counts when its customer leg connected 30 s, or an older bridge recorded 30 s', () => {
    expect(seen.sql).toContain("metadata->'customer_leg'->>'status' = 'completed'");
    expect(seen.sql.some((q) => q.includes("customer_leg'->>'duration_seconds')::numeric >= ?"))).toBe(true);
    expect(seen.sql).toContain("metadata->'customer_leg' IS NULL");
  });
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

test('callerKey matches phoneKeySql for stored US numbers', () => {
  expect(callerKey('+19415550101')).toBe('19415550101');
  expect(callerKey('(941) 555-0101')).toBe('19415550101');
  expect(callerKey('9415550101')).toBe('19415550101');
});
