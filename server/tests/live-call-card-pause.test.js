/**
 * Pause the call recording while card details are spoken (GATE_CALL_RECORDING_CARD_PAUSE, owner
 * 2026-11-16 "ok build all").
 *
 * Pins: gate off = no Twilio call; a card-intent utterance pauses the Dial recording once
 * (Status=paused, PauseBehavior=silence, Twilio.CURRENT on the caller's SID); a second trigger
 * while paused only moves the end out; the resume fires once at 90 s, or on a later stored
 * utterance when the timer was lost; a masked card number triggers; two racing triggers give one
 * Twilio pause; a Twilio error is stamped and never thrown; a bare "card" and pest talk never pause.
 * Ordering and recovery: a resume still in flight when a new card trigger arrives never lands after
 * the pause that replaces it; a decision committed before a crash is finished by the next utterance
 * or the timer; a pause whose response is lost keeps its window and still resumes at the end.
 * Across processes: two module instances sharing one db send one request at a time (the sender
 * lease in the state row); a busy decision maker retries and a busy stored utterance skips, both
 * without holding a connection; an expired lease is taken over; no connection is held while a request
 * is in flight (bounded pool of 2); a call with no open pause opens no transaction.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

const mockUpdate = jest.fn();
const mockRecordings = jest.fn(() => ({ update: mockUpdate }));
const mockCalls = jest.fn(() => ({ recordings: mockRecordings }));
jest.mock('twilio', () => jest.fn(() => ({ calls: mockCalls })));

// A small knex fake: one call_log row and a real per-key advisory lock held until the transaction
// ends. Reads and writes yield a tick so two unlocked transactions would interleave.
jest.mock('../models/db', () => {
  const newPool = () => ({ max: Infinity, inUse: 0, peak: 0, queue: [] });
  const state = { claimed: true, cardPause: undefined, writes: [], locks: new Map(), pool: newPool() };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  // A bounded connection pool: acquire waits while it is full (FIFO), like knex's.
  async function acquire() {
    const { pool } = state;
    if (pool.inUse >= pool.max) await new Promise((resolve) => pool.queue.push(resolve));
    else pool.inUse += 1;
    pool.peak = Math.max(pool.peak, pool.inUse);
  }
  function release() {
    const { pool } = state;
    const next = pool.queue.shift();
    if (next) next();
    else pool.inUse -= 1;
  }
  // A query outside a transaction takes a connection for its own duration; inside one it rides on it.
  const pooled = (inTx, fn) => async (...args) => {
    if (inTx) return fn(...args);
    await acquire();
    try { return await fn(...args); } finally { release(); }
  };
  function callLog(inTx) {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereRaw = jest.fn(() => q);
    q.first = jest.fn(pooled(inTx, async () => {
      await tick();
      return state.claimed ? { card_pause: state.cardPause ? JSON.parse(JSON.stringify(state.cardPause)) : null } : undefined;
    }));
    q.update = jest.fn(pooled(inTx, async (patch) => {
      await tick();
      if (!state.claimed) return 0;
      state.cardPause = JSON.parse(patch.metadata.bindings[0]).card_pause;
      state.writes.push(state.cardPause);
      return 1;
    }));
    return q;
  }
  function raw(sql, bindings, held) {
    if (!String(sql).includes('pg_advisory_xact_lock')) return { sql, bindings };
    const key = bindings[0];
    return (async () => {
      while (state.locks.get(key)) await state.locks.get(key);
      let release;
      state.locks.set(key, new Promise((resolve) => { release = resolve; }));
      held.push(() => { state.locks.delete(key); release(); });
    })();
  }
  const db = jest.fn(() => callLog(false));
  db.transaction = jest.fn(async (fn) => {
    await acquire();
    const held = [];
    const trx = jest.fn(() => callLog(true));
    trx.raw = (sql, bindings) => raw(sql, bindings, held);
    try {
      return await fn(trx);
    } finally {
      held.forEach((unlock) => unlock());
      release();
    }
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.__state = state;
  db.__newPool = newPool;
  return db;
});

const db = require('../models/db');
const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const cardPause = require('../services/live-call-card-pause');

const CALL = 'CA' + 'a'.repeat(32);
const trigger = (text = "what's the card number", extra = {}) => cardPause.onUtteranceStored({ callSid: CALL, text, panMasked: false, ...extra });
// Fake time moves the timers; the fake db yields on real setImmediate ticks, so let those drain.
async function advance(ms) {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
}
// A second server process: its own copy of the module (own timers), the same database.
const instances = [];
function loadInstance() {
  let inst;
  jest.isolateModules(() => {
    jest.doMock('../models/db', () => db);
    inst = require('../services/live-call-card-pause');
  });
  instances.push(inst);
  return inst;
}
const pauseCalls = () => mockUpdate.mock.calls.filter(([arg]) => arg.status === 'paused');
const resumeCalls = () => mockUpdate.mock.calls.filter(([arg]) => arg.status === 'in-progress');

beforeEach(() => {
  jest.clearAllMocks();
  const s = db.__state;
  s.claimed = true;
  s.cardPause = undefined;
  s.writes = [];
  s.locks = new Map();
  s.pool = db.__newPool();
  isEnabled.mockReturnValue(true);
  process.env.TWILIO_ACCOUNT_SID = 'AC' + 'c'.repeat(32);
  process.env.TWILIO_AUTH_TOKEN = 'token';
  mockUpdate.mockResolvedValue({ status: 'paused' });
  jest.useFakeTimers({ now: new Date('2026-11-16T15:00:00Z'), doNotFake: ['setImmediate', 'nextTick'] });
});

afterEach(() => {
  cardPause._test.timers.forEach((t) => clearTimeout(t));
  cardPause._test.timers.clear();
  cardPause._test.retries.forEach((t) => clearTimeout(t));
  cardPause._test.retries.clear();
  instances.forEach((inst) => {
    [inst._test.timers, inst._test.retries].forEach((m) => { m.forEach((t) => clearTimeout(t)); m.clear(); });
  });
  instances.length = 0;
  jest.useRealTimers();
});

describe('live call card pause', () => {
  test('gate off: no Twilio call and no state', async () => {
    isEnabled.mockReturnValue(false);
    await expect(trigger()).resolves.toMatchObject({ action: 'none', reason: 'gate_off' });
    expect(mockCalls).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('no Twilio credentials: nothing happens', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    await expect(trigger()).resolves.toMatchObject({ action: 'none' });
    expect(mockCalls).not.toHaveBeenCalled();
  });

  test('"what\'s the card number" pauses the Dial recording on the caller\'s call once', async () => {
    await expect(trigger()).resolves.toMatchObject({ action: 'pause' });
    expect(mockCalls).toHaveBeenCalledWith(CALL);
    expect(mockRecordings).toHaveBeenCalledWith('Twilio.CURRENT');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'paused', pauseBehavior: 'silence' });
    expect(db.__state.cardPause).toMatchObject({
      paused_at: '2026-11-16T15:00:00.000Z',
      resume_due_at: '2026-11-16T15:01:30.000Z',
      resumed_at: null,
      pauses: 1,
    });
  });

  test.each([
    'can I get your credit card', 'a debit card please', 'the card ending in 4242', 'what is the expiration date',
    'and the expiry date', 'the security code', 'the CVV', 'the cvc on it', 'the code on the back', 'my [card ending 4242]',
  ])('"%s" is card intent', async (text) => {
    await trigger(text);
    expect(pauseCalls()).toHaveLength(1);
  });

  test('a store that masked a card number triggers, whatever the text says', async () => {
    await trigger('[code removed]', { panMasked: true });
    expect(pauseCalls()).toHaveLength(1);
  });

  test('pest talk and a bare "card" never pause', async () => {
    await expect(trigger('I saw roaches in the kitchen')).resolves.toMatchObject({ action: 'none' });
    await expect(trigger('here is my business card')).resolves.toMatchObject({ action: 'none' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(db.__state.cardPause).toBeUndefined();
  });

  test('a second trigger while paused sends nothing and moves the end later', async () => {
    await trigger();
    jest.setSystemTime(new Date('2026-11-16T15:00:40Z'));
    await expect(trigger('and the cvv')).resolves.toMatchObject({ action: 'extend' });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(db.__state.cardPause).toMatchObject({ paused_at: '2026-11-16T15:00:00.000Z', resume_due_at: '2026-11-16T15:02:10.000Z', pauses: 1 });
    // The old end passes: the timer was moved with it, so nothing resumes yet.
    await advance(55 * 1000);
    expect(resumeCalls()).toHaveLength(0);
    await advance(40 * 1000);
    expect(resumeCalls()).toHaveLength(1);
  });

  test('the timer resumes at 90 s, exactly once', async () => {
    await trigger();
    await advance(89 * 1000);
    expect(resumeCalls()).toHaveLength(0);
    await advance(2 * 1000);
    expect(resumeCalls()).toHaveLength(1);
    expect(mockUpdate).toHaveBeenLastCalledWith({ status: 'in-progress' });
    expect(db.__state.cardPause.resumed_at).toBeTruthy();
    // A later utterance finds nothing left to resume.
    await trigger('we can come Tuesday');
    await advance(120 * 1000);
    expect(resumeCalls()).toHaveLength(1);
  });

  test('a lost timer: the next stored utterance past the end resumes, once', async () => {
    await trigger();
    cardPause._test.timers.forEach((t) => clearTimeout(t));
    cardPause._test.timers.clear();
    jest.setSystemTime(new Date('2026-11-16T15:01:00Z'));
    await expect(trigger('Tuesday works')).resolves.toMatchObject({ action: 'not_due' });
    expect(resumeCalls()).toHaveLength(0);
    jest.setSystemTime(new Date('2026-11-16T15:02:00Z'));
    await expect(trigger('Tuesday works')).resolves.toMatchObject({ action: 'resumed' });
    await trigger('thanks');
    expect(resumeCalls()).toHaveLength(1);
  });

  test('gate off with a pause running: a card phrase starts nothing, and the pause still ends on time', async () => {
    await trigger();
    expect(pauseCalls()).toHaveLength(1);
    // The gate flip restarts the server: no timer survives it.
    cardPause._test.timers.forEach((t) => clearTimeout(t));
    cardPause._test.timers.clear();
    isEnabled.mockReturnValue(false);
    jest.setSystemTime(new Date('2026-11-16T15:01:00Z'));
    await expect(trigger('the card number again', { pauseOpen: true })).resolves.toMatchObject({ action: 'not_due' });
    expect(pauseCalls()).toHaveLength(1);
    await advance(31 * 1000);
    expect(resumeCalls()).toHaveLength(1);
    await expect(trigger("what's the card number")).resolves.toMatchObject({ action: 'none', reason: 'gate_off' });
    expect(pauseCalls()).toHaveLength(1);
  });

  test('a new trigger after a resume pauses again (second pause)', async () => {
    await trigger();
    await advance(91 * 1000);
    await trigger('the card number again');
    expect(pauseCalls()).toHaveLength(2);
    expect(db.__state.cardPause).toMatchObject({ pauses: 2, resumed_at: null });
  });

  test('two racing triggers give one Twilio pause request', async () => {
    const [a, b] = await Promise.all([trigger("what's the card number"), trigger('the credit card please')]);
    expect(pauseCalls()).toHaveLength(1);
    expect([a.action, b.action].sort()).toEqual(['extend', 'pause']);
    expect(db.__state.cardPause.pauses).toBe(1);
  });

  test('a call this module never started is left alone', async () => {
    db.__state.claimed = false;
    await expect(trigger()).resolves.toMatchObject({ action: 'none', reason: 'not_started_here' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a Twilio 16108 on the pause is stamped, logged without the SID or text, and never thrown', async () => {
    mockUpdate.mockRejectedValue(Object.assign(new Error('two recordings in progress'), { code: 16108 }));
    await expect(trigger("what's the card number")).resolves.toMatchObject({ action: 'pause_failed', error_code: '16108' });
    expect(db.__state.cardPause).toMatchObject({ last_error_code: '16108', paused_at: null, resume_due_at: null });
    const logged = logger.warn.mock.calls.map(([m]) => m).join(' ');
    expect(logged).toContain('16108');
    expect(logged).not.toContain(CALL);
    expect(logged).not.toMatch(/card number/);
    // Not paused, so a later trigger tries again.
    mockUpdate.mockResolvedValue({});
    await trigger('the card number');
    expect(pauseCalls()).toHaveLength(2);
  });

  test('a failed resume (call not in progress, 21220) is stamped, kept, and not retried', async () => {
    await trigger();
    mockUpdate.mockRejectedValue(Object.assign(new Error('Call is not in-progress'), { code: 21220 }));
    await advance(91 * 1000);
    expect(db.__state.cardPause).toMatchObject({ last_error_code: '21220' });
    expect(db.__state.cardPause.resumed_at).toBeTruthy();
    await trigger('hello');
    expect(resumeCalls()).toHaveLength(1);
  });

  test('a failed resume on a network error is released so the next utterance retries', async () => {
    await trigger();
    mockUpdate.mockRejectedValueOnce(new Error('socket hang up'));
    await advance(91 * 1000);
    expect(db.__state.cardPause).toMatchObject({ last_error_code: 'unknown', resumed_at: null });
    mockUpdate.mockResolvedValue({});
    await expect(trigger('hello')).resolves.toMatchObject({ action: 'resumed' });
    expect(resumeCalls()).toHaveLength(2);
  });
});

describe('live call card pause: ordering and recovery', () => {
  const lastStatuses = () => mockUpdate.mock.calls.map(([arg]) => arg.status);
  const flush = async () => { for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  // A committed state as a crashed process would have left it.
  const seed = (extra) => {
    db.__state.cardPause = {
      paused_at: '2026-11-16T15:00:00.000Z', resume_due_at: '2026-11-16T15:01:30.000Z', resumed_at: null, pauses: 1, ...extra,
    };
  };

  test('a resume in flight when a new card trigger arrives is followed by the pause, never the other way round', async () => {
    await trigger();
    expect(lastStatuses()).toEqual(['paused']);
    // The resume request hangs on its way to Twilio.
    let landResume;
    mockUpdate.mockImplementation((arg) => (arg.status === 'in-progress'
      ? new Promise((resolve) => { landResume = () => resolve({ status: 'in-progress' }); })
      : Promise.resolve({ status: 'paused' })));
    await advance(91 * 1000);
    expect(lastStatuses()).toEqual(['paused', 'in-progress']);
    expect(db.__state.cardPause).toMatchObject({ pending: 'resume', resumed_at: null });

    // The card trigger commits a new window while the old resume is still in flight.
    const second = trigger('and the cvv');
    await flush();
    expect(db.__state.cardPause).toMatchObject({ pending: 'pause', resumed_at: null, resume_due_at: '2026-11-16T15:03:01.000Z' });
    // Nothing is sent over the resume: the requests of one call go out one at a time.
    expect(lastStatuses()).toEqual(['paused', 'in-progress']);

    landResume();
    mockUpdate.mockResolvedValue({});
    await expect(second).resolves.toMatchObject({ action: 'extend' });
    await flush();
    // The last request Twilio received is the pause; the resume it replaced was not recorded as the end.
    expect(lastStatuses()).toEqual(['paused', 'in-progress', 'paused']);
    expect(db.__state.cardPause).toMatchObject({ pending: null, resumed_at: null, resume_due_at: '2026-11-16T15:03:01.000Z' });

    // The new window ends on its own end, with its own resume.
    await advance(60 * 1000);
    expect(lastStatuses()).toHaveLength(3);
    await advance(31 * 1000);
    expect(lastStatuses()).toEqual(['paused', 'in-progress', 'paused', 'in-progress']);
    expect(db.__state.cardPause.resumed_at).toBeTruthy();
  });

  test('a resume claimed but not sent (crash) is finished by the next stored utterance', async () => {
    seed({ pending: 'resume', pause_sent: true });
    jest.setSystemTime(new Date('2026-11-16T15:02:00Z'));
    await expect(trigger('Tuesday works')).resolves.toMatchObject({ action: 'resumed' });
    expect(lastStatuses()).toEqual(['in-progress']);
    expect(db.__state.cardPause).toMatchObject({ pending: null });
    expect(db.__state.cardPause.resumed_at).toBeTruthy();
    await trigger('thanks');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  test('a pause claimed but not sent (crash) is sent by the next stored utterance, then resumed at the end', async () => {
    seed({ pending: 'pause', pause_sent: false });
    jest.setSystemTime(new Date('2026-11-16T15:00:20Z'));
    await expect(trigger('and the expiration')).resolves.toMatchObject({ action: 'paused' });
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'paused', pauseBehavior: 'silence' });
    expect(db.__state.cardPause).toMatchObject({ pending: null, pause_sent: true, resumed_at: null });
    // The restart lost the timer: the utterance armed a new one for the stored end.
    await advance(71 * 1000);
    expect(lastStatuses()).toEqual(['paused', 'in-progress']);
  });

  test('a pause claimed but never sent, found after its window, sends nothing and closes', async () => {
    seed({ pending: 'pause', pause_sent: false });
    jest.setSystemTime(new Date('2026-11-16T15:05:00Z'));
    await trigger('Tuesday works');
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(db.__state.cardPause.resumed_at).toBeTruthy();
    expect(db.__state.cardPause.pending).toBeNull();
  });

  test('a pause request sent before a crash is resumed at the end even if no timer survived', async () => {
    seed({ pending: 'pause', pause_sent: true });
    jest.setSystemTime(new Date('2026-11-16T15:02:00Z'));
    await trigger('Tuesday works');
    expect(lastStatuses()).toEqual(['in-progress']);
    expect(db.__state.cardPause.resumed_at).toBeTruthy();
  });

  test('a pause whose response is lost (applied remotely, network error) still resumes at the window end', async () => {
    mockUpdate.mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await expect(trigger("what's the card number")).resolves.toMatchObject({ action: 'pause_failed', error_code: 'ECONNRESET' });
    // The window and the pending pause stay: nothing says the recording is unpaused.
    expect(db.__state.cardPause).toMatchObject({
      paused_at: '2026-11-16T15:00:00.000Z', resume_due_at: '2026-11-16T15:01:30.000Z', pending: 'pause', pause_sent: true, last_error_code: 'ECONNRESET',
    });
    await advance(89 * 1000);
    expect(lastStatuses()).toEqual(['paused']);
    await advance(2 * 1000);
    expect(lastStatuses()).toEqual(['paused', 'in-progress']);
    expect(db.__state.cardPause.resumed_at).toBeTruthy();
  });

  test.each([
    ['a 5xx with a Twilio code', Object.assign(new Error('server error'), { code: 20500, status: 503 })],
    ['a timeout without a code', new Error('timeout of 30000ms exceeded')],
  ])('%s on the pause is an unknown outcome: the window stays and the end resumes', async (_name, err) => {
    mockUpdate.mockRejectedValueOnce(err);
    await expect(trigger()).resolves.toMatchObject({ action: 'pause_failed' });
    expect(db.__state.cardPause).toMatchObject({ paused_at: '2026-11-16T15:00:00.000Z', pending: 'pause' });
    await advance(91 * 1000);
    expect(lastStatuses()).toEqual(['paused', 'in-progress']);
  });

  test('after a lost pause response a later utterance tries the pause again; a definite refusal then keeps the window', async () => {
    mockUpdate.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await trigger();
    // The retry is refused for good: the first request may have landed, so the window stays.
    mockUpdate.mockRejectedValueOnce(Object.assign(new Error('already paused'), { code: 16108 }));
    await advance(20 * 1000);
    await expect(trigger('Tuesday works')).resolves.toMatchObject({ action: 'pause_failed', error_code: '16108' });
    expect(db.__state.cardPause).toMatchObject({ paused_at: '2026-11-16T15:00:00.000Z', resume_due_at: '2026-11-16T15:01:30.000Z', pending: null });
    // No further pause attempts, and the end still resumes.
    await trigger('Tuesday works');
    expect(pauseCalls()).toHaveLength(2);
    await advance(71 * 1000);
    expect(lastStatuses()).toEqual(['paused', 'paused', 'in-progress']);
    expect(db.__state.cardPause.resumed_at).toBeTruthy();
  });

  test('gate off with a pause that was never sent starts nothing', async () => {
    seed({ pending: 'pause', pause_sent: false });
    isEnabled.mockReturnValue(false);
    jest.setSystemTime(new Date('2026-11-16T15:00:20Z'));
    await expect(trigger('Tuesday works', { pauseOpen: true })).resolves.toMatchObject({ action: 'not_due' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('live call card pause: two server processes sharing one database', () => {
  const statuses = () => mockUpdate.mock.calls.map(([arg]) => arg.status);
  const flush = async () => { for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const utter = (inst, text, extra = {}) => inst.onUtteranceStored({ callSid: CALL, text, panMasked: false, ...extra });
  const LEASE_MS = cardPause._test.LEASE_MS;
  // A request that stays in flight until the test lets it land. Also notes how many connections are
  // in use at the moment each request goes out.
  function hang(status) {
    const held = { land: null, connsAtSend: [] };
    mockUpdate.mockImplementation((arg) => {
      held.connsAtSend.push(db.__state.pool.inUse);
      return arg.status === status
        ? new Promise((resolve) => { held.land = () => resolve({ status }); })
        : Promise.resolve({ status: arg.status });
    });
    return held;
  }
  // A committed state as a crashed or slow sender elsewhere would have left it.
  const seed = (extra) => {
    db.__state.cardPause = {
      paused_at: '2026-11-16T15:00:00.000Z', resume_due_at: '2026-11-16T15:01:30.000Z', resumed_at: null, pauses: 1, ...extra,
    };
  };

  test('the Twilio client gets a request timeout shorter than the lease', async () => {
    await trigger();
    const opts = require('twilio').mock.calls[0][2];
    expect(opts.httpClient.defaultTimeout).toBe(cardPause._test.REQUEST_TIMEOUT_MS);
    expect(cardPause._test.REQUEST_TIMEOUT_MS).toBeLessThan(LEASE_MS);
  });

  test('a due resume on another process waits for the pause still in flight, then goes out after it', async () => {
    const a = loadInstance();
    const b = loadInstance();
    const pause = hang('paused');
    const first = utter(a, "what's the card number");
    await flush();
    expect(statuses()).toEqual(['paused']);
    // Only process B keeps a timer for this call (A's restarted).
    a._test.timers.forEach((t) => clearTimeout(t));
    a._test.timers.clear();
    // A short window that has ended while the pause is still in flight.
    db.__state.cardPause.resume_due_at = '2026-11-16T15:00:04.000Z';

    // B finds A's lease live: it sends nothing, and arms its own timer for the stored end.
    jest.setSystemTime(new Date('2026-11-16T15:00:05Z'));
    await expect(utter(b, 'Tuesday works')).resolves.toMatchObject({ action: 'send_busy' });
    expect(b._test.timers.size).toBe(1);
    await advance(1000);
    // B's timer found the lease busy too and retries: still no resume over the pause.
    expect(b._test.retries.size).toBe(1);
    expect(statuses()).toEqual(['paused']);

    mockUpdate.mockResolvedValue({});
    pause.land();
    await first;
    await advance(1000);
    // The last request Twilio got is the resume, the newest decision, and it came after the pause.
    expect(statuses()).toEqual(['paused', 'in-progress']);
    expect(db.__state.cardPause).toMatchObject({ pending: null, pause_sent: false, sender: null });
    expect(db.__state.cardPause.resumed_at).toBeTruthy();
    await advance(120 * 1000);
    expect(statuses()).toEqual(['paused', 'in-progress']);
  });

  test('a resume in flight on one process: a card trigger on another sends its pause after it lands, never before', async () => {
    const a = loadInstance();
    const b = loadInstance();
    await utter(a, "what's the card number");
    expect(statuses()).toEqual(['paused']);
    const resume = hang('in-progress');
    await advance(91 * 1000);
    expect(statuses()).toEqual(['paused', 'in-progress']);

    // B commits a new window while A's resume is still in flight; its own pause waits behind the lease.
    await expect(utter(b, 'and the cvv')).resolves.toMatchObject({ action: 'extend' });
    expect(db.__state.cardPause).toMatchObject({ pending: 'pause', resumed_at: null, resume_due_at: '2026-11-16T15:03:01.000Z' });
    await advance(1000);
    expect(statuses()).toEqual(['paused', 'in-progress']);

    mockUpdate.mockResolvedValue({});
    resume.land();
    await advance(1000);
    expect(statuses()).toEqual(['paused', 'in-progress', 'paused']);
    // Paused, window kept, nothing pending, lease released: the end resumes it later.
    expect(db.__state.cardPause).toMatchObject({ pending: null, resumed_at: null, resume_due_at: '2026-11-16T15:03:01.000Z', sender: null });
    await advance(91 * 1000);
    expect(statuses()).toEqual(['paused', 'in-progress', 'paused', 'in-progress']);
  });

  test('a stored utterance while another process holds the lease sends nothing and does not wait', async () => {
    const a = loadInstance();
    const b = loadInstance();
    const pause = hang('paused');
    const first = utter(a, "what's the card number");
    await flush();
    jest.setSystemTime(new Date('2026-11-16T15:00:03Z'));
    // Resolves while A's request is still in flight.
    await expect(utter(b, 'and the expiration')).resolves.toMatchObject({ action: 'send_busy' });
    expect(statuses()).toEqual(['paused']);
    // A stored utterance never schedules a retry of its own.
    expect(b._test.retries.size).toBe(0);
    mockUpdate.mockResolvedValue({});
    pause.land();
    await first;
    expect(statuses()).toEqual(['paused']);
  });

  test('a crashed sender: its lease blocks others until it expires, then the resume is taken over', async () => {
    const b = loadInstance();
    // The holder died after claiming the resume; its lease runs 5 s more.
    seed({ pending: 'resume', pause_sent: true, sender: { token: 'dead-sender', until: new Date('2026-11-16T15:02:05Z').getTime() } });
    jest.setSystemTime(new Date('2026-11-16T15:02:00Z'));
    await expect(utter(b, 'Tuesday works')).resolves.toMatchObject({ action: 'send_busy' });
    expect(mockUpdate).not.toHaveBeenCalled();
    jest.setSystemTime(new Date('2026-11-16T15:02:06Z'));
    await expect(utter(b, 'Tuesday works')).resolves.toMatchObject({ action: 'resumed' });
    expect(statuses()).toEqual(['in-progress']);
    expect(db.__state.cardPause).toMatchObject({ pending: null, sender: null });
    expect(db.__state.cardPause.resumed_at).toBeTruthy();
  });

  test('a busy card trigger retries and sends its pause once the old lease is gone', async () => {
    const b = loadInstance();
    // A resume was claimed by a sender that crashed; the window had ended. A new card phrase arrives.
    seed({ pending: 'resume', pause_sent: true, sender: { token: 'dead-sender', until: new Date('2026-11-16T15:02:03Z').getTime() } });
    jest.setSystemTime(new Date('2026-11-16T15:02:00Z'));
    await expect(utter(b, 'and the cvv')).resolves.toMatchObject({ action: 'extend' });
    expect(db.__state.cardPause).toMatchObject({ pending: 'pause', resumed_at: null });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(b._test.retries.size).toBe(1);
    await advance(2000);
    expect(mockUpdate).not.toHaveBeenCalled();
    await advance(2000);
    expect(statuses()).toEqual(['paused']);
    expect(db.__state.cardPause).toMatchObject({ pending: null, sender: null, resumed_at: null });
    // A retry never stacks: one timer at a time, none left over.
    expect(b._test.retries.size).toBe(0);
  });

  test('a retry gives up after the lease would have expired plus a margin', async () => {
    const b = loadInstance();
    // A sender that renews forever is not a thing, but a lease that stays live must not spin the retry.
    const renew = () => seed({ pending: 'pause', pause_sent: false, sender: { token: 'busy-sender', until: Date.now() + 60 * 1000 } });
    renew();
    jest.setSystemTime(new Date('2026-11-16T15:00:10Z'));
    renew();
    const stay = setInterval(renew, 100);
    try {
      await expect(utter(b, 'and the cvv')).resolves.toMatchObject({ action: 'extend' });
      await advance(20 * 1000);
    } finally {
      clearInterval(stay);
    }
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(b._test.retries.size).toBe(0);
  });

  test('bounded pool of 2: overlapping triggers and a request in flight finish with no stall, and no connection is held during the request', async () => {
    db.__state.pool.max = 2;
    const a = loadInstance();
    const b = loadInstance();
    const pause = hang('paused');
    const first = utter(a, "what's the card number");
    await flush();
    expect(statuses()).toEqual(['paused']);
    // The request is in flight, and nothing holds a connection.
    expect(db.__state.pool.inUse).toBe(0);
    expect(pause.connsAtSend).toEqual([0]);

    // Two more triggers and a stored utterance overlap it, on both processes.
    jest.setSystemTime(new Date('2026-11-16T15:00:02Z'));
    const others = Promise.all([utter(b, 'the credit card please'), utter(a, 'and the cvv'), utter(b, 'Tuesday works')]);
    await flush();
    expect(db.__state.pool.inUse).toBe(0);
    expect(statuses()).toEqual(['paused']);

    mockUpdate.mockResolvedValue({});
    pause.land();
    await advance(1000);
    await expect(first).resolves.toBeDefined();
    await expect(others).resolves.toHaveLength(3);
    expect(db.__state.pool.peak).toBeLessThanOrEqual(2);
    expect(db.__state.pool.inUse).toBe(0);
    expect(db.__state.pool.queue).toHaveLength(0);
    expect(pauseCalls()).toHaveLength(1);
    expect(db.__state.cardPause).toMatchObject({ pending: null, resumed_at: null, sender: null });
    // The window was moved by the later triggers; its end still resumes. Small steps, so the real-time
    // database ticks keep up with the fake clock (a lease is judged on that clock).
    for (let i = 0; i < 100; i += 1) await advance(1000);
    expect(statuses()).toEqual(['paused', 'in-progress']);
  });

  test('an ordinary utterance opens no transaction: no open pause, or a pause not yet due with nothing pending', async () => {
    const a = loadInstance();
    await expect(utter(a, 'we have ants')).resolves.toMatchObject({ action: 'none' });
    expect(db.transaction).not.toHaveBeenCalled();
    await utter(a, "what's the card number");
    db.transaction.mockClear();
    jest.setSystemTime(new Date('2026-11-16T15:00:30Z'));
    await expect(utter(a, 'Tuesday works')).resolves.toMatchObject({ action: 'not_due', dueAtMs: new Date('2026-11-16T15:01:30Z').getTime() });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(statuses()).toEqual(['paused']);
  });
});
