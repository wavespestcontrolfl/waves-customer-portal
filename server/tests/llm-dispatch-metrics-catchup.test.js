// Missed-tick catch-up for the LLM dispatch digest. The 6:25 ET tick can be lost; a
// bookmark row (ops_email_send_state, key llm-dispatch-digest-thru) holds the ET midnight
// that ENDS the last digested day, so the next run (the 12:28 catch-up tick or the next
// morning's tick) digests every day since, up to 7, each on its own window. Green days
// send nothing; a run that throws leaves the bookmark where it was.

const mockState = { bookmark: null, bookmarkError: null, stamps: [], days: {}, queried: [] };

// One fake for every table the digest touches. llm_dispatch_log answers by the window
// the code asks for: a one-day window is that ET day, a 7-day window is the prior week,
// anything else is the recent-silence window.
jest.mock('../models/db', () => {
  const ET_OFFSET_MS = 5 * 3600 * 1000; // EST, after DST ended on 2026-11-01
  const dayKey = (start) => new Date(start.getTime() - ET_OFFSET_MS).toISOString().slice(0, 10);
  const db = (table) => {
    if (table === 'ops_email_send_state') {
      const chain = {
        where() { return chain; },
        first() { return mockState.bookmarkError ? Promise.reject(new Error(mockState.bookmarkError)) : Promise.resolve(mockState.bookmark ? { last_sent_at: mockState.bookmark } : undefined); },
        insert(row) { chain.row = row; return chain; },
        onConflict() { return chain; },
        merge() { mockState.stamps.push(chain.row); return Promise.resolve(); },
      };
      return chain;
    }
    const win = {};
    const chain = {};
    const self = () => chain;
    for (const m of ['whereNot', 'select', 'sum', 'max', 'countDistinct']) chain[m] = self;
    chain.where = (col, op, val) => {
      if (col === 'created_at' && val instanceof Date) win[op === '>=' ? 'start' : 'end'] = val;
      return chain;
    };
    chain.andWhere = chain.where;
    chain.groupBy = () => { win.stats = true; return chain; };
    chain.count = () => chain;
    chain.del = () => Promise.resolve(0);
    const span = () => Math.round((win.end - win.start) / 86400000);
    chain.first = () => {
      mockState.queried.push(`hb:${dayKey(win.start)}:${span()}`);
      const day = mockState.days[dayKey(win.start)];
      return Promise.resolve({ n: String(span() === 1 ? (day ? day.heartbeats : 24) : 168) });
    };
    chain.then = (resolve, reject) => {
      const key = dayKey(win.start);
      if (span() === 1) mockState.queried.push(`stats:${key}`);
      let rows;
      if (span() === 1) rows = (mockState.days[key] || {}).rows || [];
      else rows = [{ policy: 'report', total: '50', fallbacks: '0', failed: '0', active_days: '7' }];
      if (span() === 1 && mockState.days[key]?.statsError) return Promise.reject(new Error(mockState.days[key].statsError)).then(resolve, reject);
      return Promise.resolve(rows).then(resolve, reject);
    };
    return chain;
  };
  db.raw = (sql) => sql;
  return db;
});

const mockEmailSend = jest.fn();
jest.mock('../services/email', () => ({ send: (...args) => mockEmailSend(...args) }));
jest.mock('pg', () => ({ Client: jest.fn(() => ({ connect: jest.fn(), query: jest.fn(), end: jest.fn() })) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORIGINAL_ENV = { ...process.env };
const FAILED_DAY = { rows: [{ policy: 'report', total: '3', fallbacks: '0', failed: '1', active_days: '1' }], heartbeats: 24 };
const GREEN_DAY = { rows: [{ policy: 'report', total: '50', fallbacks: '0', failed: '0', active_days: '1' }], heartbeats: 24 };

// 2026-11-05 06:25 ET (EST)
const TICK_AT = new Date('2026-11-05T11:25:00Z');
const ET_MIDNIGHT = (day) => new Date(`${day}T05:00:00Z`);

let mockDeliver;
let mockRetire;
function load() {
  let mod;
  jest.isolateModules(() => { mod = require('../services/llm-dispatch-metrics'); });
  return mod;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.useFakeTimers({ now: TICK_AT });
  Object.assign(mockState, { bookmark: null, bookmarkError: null, stamps: [], days: {}, queried: [] });
  process.env = { ...ORIGINAL_ENV, GATE_LLM_DISPATCH_METRICS: 'true' };
  mockEmailSend.mockResolvedValue({ ok: true });
  mockDeliver = jest.fn(async (args) => { await args.sendEmail(); return { ok: true }; });
  mockRetire = jest.fn(async () => 0);
  jest.doMock('../services/ops-digest', () => ({ deliverOpsDigest: mockDeliver }));
  jest.doMock('../services/ops-digest-fall-off', () => ({ retireIfClean: mockRetire }));
});

afterEach(() => {
  jest.useRealTimers();
  jest.dontMock('../services/ops-digest');
  jest.dontMock('../services/ops-digest-fall-off');
});
afterAll(() => { process.env = ORIGINAL_ENV; });

describe('missedDigestDays', () => {
  const missed = (bookmark) => load()._private.missedDigestDays(bookmark, TICK_AT);

  it('no bookmark: yesterday only, as the digest always did', () => {
    expect(missed(null)).toEqual([1]);
  });
  it('bookmark at the end of yesterday: nothing owed', () => {
    expect(missed(ET_MIDNIGHT('2026-11-05'))).toEqual([]);
  });
  it('bookmark at the end of the day before yesterday: yesterday is owed', () => {
    expect(missed(ET_MIDNIGHT('2026-11-04'))).toEqual([1]);
  });
  it('one lost tick: two days, oldest first', () => {
    expect(missed(ET_MIDNIGHT('2026-11-03'))).toEqual([2, 1]);
  });
  it('a long gap is capped at the newest 7 days', () => {
    expect(missed(ET_MIDNIGHT('2026-10-10'))).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });
});

describe('runLlmDispatchDigestWithCatchUp', () => {
  it('a lost tick: both missed days are evaluated on their own windows, the bad one reported, the green one silent', async () => {
    mockState.bookmark = ET_MIDNIGHT('2026-11-03'); // Nov 3 and Nov 4 are owed
    mockState.days = { '2026-11-03': FAILED_DAY, '2026-11-04': GREEN_DAY };
    const { runLlmDispatchDigestWithCatchUp } = load();
    const out = await runLlmDispatchDigestWithCatchUp();

    expect(mockState.queried).toEqual(expect.arrayContaining(['stats:2026-11-03', 'stats:2026-11-04']));
    expect(out.days).toEqual(['2026-11-03', '2026-11-04']);
    expect(out.emailed).toBe(true);
    expect(out.exceptions).toHaveLength(1);
    expect(out.exceptions[0]).toMatchObject({ policy: 'report', kind: 'all_providers_failed' });
    expect(mockDeliver).toHaveBeenCalledTimes(1);
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    // The email names the day that was bad, not the day the catch-up ran.
    expect(mockEmailSend.mock.calls[0][0].body).toMatch(/on 2026-11-03:/);
    // A later clean day must not retire the bell the earlier bad day just raised.
    expect(mockRetire).not.toHaveBeenCalled();
    expect(mockState.stamps).toHaveLength(1);
    expect(mockState.stamps[0].last_sent_at).toEqual(ET_MIDNIGHT('2026-11-05'));
  });

  it('two bad days go out together, each line led by its day', async () => {
    mockState.bookmark = ET_MIDNIGHT('2026-11-03');
    mockState.days = { '2026-11-03': FAILED_DAY, '2026-11-04': { ...FAILED_DAY, rows: [{ policy: 'report', total: '10', fallbacks: '9', failed: '0', active_days: '1' }] } };
    const { runLlmDispatchDigestWithCatchUp } = load();
    const out = await runLlmDispatchDigestWithCatchUp();

    expect(out.exceptions.map((e) => e.kind)).toEqual(['all_providers_failed', 'fallback_rate']);
    expect(mockDeliver).toHaveBeenCalledTimes(1);
    const body = mockEmailSend.mock.calls[0][0].body;
    expect(body).toMatch(/on 2026-11-03 to 2026-11-04:/);
    expect(body).toMatch(/2026-11-03: 1 of 3 calls failed/);
    expect(body).toMatch(/2026-11-04: fallback provider answered 9 of 10 calls/);
  });

  it('green missed days send nothing, retire the standing bell once, and move the bookmark', async () => {
    mockState.bookmark = ET_MIDNIGHT('2026-11-03');
    mockState.days = { '2026-11-03': GREEN_DAY, '2026-11-04': GREEN_DAY };
    const { runLlmDispatchDigestWithCatchUp } = load();
    const out = await runLlmDispatchDigestWithCatchUp();

    expect(out).toMatchObject({ exceptions: [], emailed: false });
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
    expect(mockRetire).toHaveBeenCalledTimes(1);
    expect(mockState.stamps[0].last_sent_at).toEqual(ET_MIDNIGHT('2026-11-05'));
  });

  it('the normal tick (bookmark at the end of the day before yesterday) digests yesterday only', async () => {
    mockState.bookmark = ET_MIDNIGHT('2026-11-04');
    mockState.days = { '2026-11-04': GREEN_DAY };
    const { runLlmDispatchDigestWithCatchUp } = load();
    const out = await runLlmDispatchDigestWithCatchUp();
    expect(out).not.toHaveProperty('days');
    expect(mockState.queried.filter((q) => q.startsWith('stats:'))).toEqual(['stats:2026-11-04']);
  });

  it('a catch-up after a finished run does nothing: no queries, no email, no bookmark write', async () => {
    mockState.bookmark = ET_MIDNIGHT('2026-11-05');
    const { runLlmDispatchDigestWithCatchUp } = load();
    await expect(runLlmDispatchDigestWithCatchUp()).resolves.toEqual({ skipped: 'already_digested' });
    expect(mockState.queried).toEqual([]);
    expect(mockEmailSend).not.toHaveBeenCalled();
    expect(mockState.stamps).toEqual([]);
  });

  it('the backfill is capped at 7 days', async () => {
    mockState.bookmark = ET_MIDNIGHT('2026-10-01');
    const { runLlmDispatchDigestWithCatchUp } = load();
    const out = await runLlmDispatchDigestWithCatchUp();
    expect(out.days).toHaveLength(7);
    expect(out.days[0]).toBe('2026-10-29');
    expect(out.days[6]).toBe('2026-11-04');
    expect(mockState.queried.filter((q) => q.startsWith('stats:'))).toHaveLength(7);
  });

  it('a read failure on one missed day alerts for that day, throws, and leaves the bookmark where it was', async () => {
    mockState.bookmark = ET_MIDNIGHT('2026-11-03');
    mockState.days = { '2026-11-03': GREEN_DAY, '2026-11-04': { statsError: 'relation gone' } };
    const { runLlmDispatchDigestWithCatchUp } = load();
    const err = await runLlmDispatchDigestWithCatchUp().catch((e) => e);
    expect(err.message).toMatch(/relation gone/);
    expect(err.alerted).toBe(true);
    expect(mockEmailSend.mock.calls[0][0].body).toMatch(/Recording status for 2026-11-04 is UNKNOWN/);
    expect(mockState.stamps).toEqual([]);
  });

  it('an undeliverable exception email fails the run and leaves the bookmark where it was', async () => {
    mockState.bookmark = ET_MIDNIGHT('2026-11-03');
    mockState.days = { '2026-11-03': FAILED_DAY, '2026-11-04': GREEN_DAY };
    mockEmailSend.mockResolvedValue({ ok: false, error: 'smtp down' });
    mockDeliver.mockImplementation(async (args) => args.sendEmail());
    const { runLlmDispatchDigestWithCatchUp } = load();
    await expect(runLlmDispatchDigestWithCatchUp()).rejects.toThrow(/digest email failed.*smtp down/);
    expect(mockState.stamps).toEqual([]);
  });

  it('gate off: nothing is digested or sent, but the bookmark moves so the days it was off are not backfilled later', async () => {
    process.env.GATE_LLM_DISPATCH_METRICS = 'false';
    mockState.bookmark = ET_MIDNIGHT('2026-10-20');
    const { runLlmDispatchDigestWithCatchUp } = load();
    const out = await runLlmDispatchDigestWithCatchUp();
    expect(out).toMatchObject({ skipped: 'gate_off' });
    expect(mockState.queried).toEqual([]);
    expect(mockEmailSend).not.toHaveBeenCalled();
    expect(mockState.stamps[0].last_sent_at).toEqual(ET_MIDNIGHT('2026-11-05'));
  });

  it('an unreadable bookmark falls back to yesterday only', async () => {
    mockState.bookmarkError = 'connection reset';
    mockState.days = { '2026-11-04': GREEN_DAY };
    const { runLlmDispatchDigestWithCatchUp } = load();
    const out = await runLlmDispatchDigestWithCatchUp();
    expect(out).toMatchObject({ exceptions: [] });
    expect(mockState.queried.filter((q) => q.startsWith('stats:'))).toEqual(['stats:2026-11-04']);
  });
});

describe('digestCatchUpNeeded', () => {
  it('no bookmark: not needed (the 6:25 tick starts the bookmark)', async () => {
    await expect(load().digestCatchUpNeeded()).resolves.toBe(false);
  });
  it('bookmark behind: needed', async () => {
    mockState.bookmark = ET_MIDNIGHT('2026-11-04');
    await expect(load().digestCatchUpNeeded()).resolves.toBe(true);
  });
  it('bookmark at the end of yesterday: not needed', async () => {
    mockState.bookmark = ET_MIDNIGHT('2026-11-05');
    await expect(load().digestCatchUpNeeded()).resolves.toBe(false);
  });
  it('an unreadable bookmark: not needed', async () => {
    mockState.bookmarkError = 'connection reset';
    await expect(load().digestCatchUpNeeded()).resolves.toBe(false);
  });
});
