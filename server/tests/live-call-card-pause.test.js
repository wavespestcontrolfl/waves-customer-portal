/**
 * Pause the call recording while card details are spoken (GATE_CALL_RECORDING_CARD_PAUSE, owner
 * 2026-11-16 "ok build all").
 *
 * Pins: gate off = no Twilio call; a card-intent utterance pauses the Dial recording once
 * (Status=paused, PauseBehavior=silence, Twilio.CURRENT on the caller's SID); a second trigger
 * while paused only moves the end out; the resume fires once at 90 s, or on a later stored
 * utterance when the timer was lost; a masked card number triggers; two racing triggers give one
 * Twilio pause; a Twilio error is stamped and never thrown; a bare "card" and pest talk never pause.
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
  const state = { claimed: true, cardPause: undefined, writes: [], locks: new Map() };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  function callLog() {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereRaw = jest.fn(() => q);
    q.first = jest.fn(async () => {
      await tick();
      return state.claimed ? { card_pause: state.cardPause ? JSON.parse(JSON.stringify(state.cardPause)) : null } : undefined;
    });
    q.update = jest.fn(async (patch) => {
      await tick();
      if (!state.claimed) return 0;
      state.cardPause = JSON.parse(patch.metadata.bindings[0]).card_pause;
      state.writes.push(state.cardPause);
      return 1;
    });
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
  const db = jest.fn(() => callLog());
  db.transaction = jest.fn(async (fn) => {
    const held = [];
    const trx = jest.fn(() => callLog());
    trx.raw = (sql, bindings) => raw(sql, bindings, held);
    try {
      return await fn(trx);
    } finally {
      held.forEach((release) => release());
    }
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.__state = state;
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
const pauseCalls = () => mockUpdate.mock.calls.filter(([arg]) => arg.status === 'paused');
const resumeCalls = () => mockUpdate.mock.calls.filter(([arg]) => arg.status === 'in-progress');

beforeEach(() => {
  jest.clearAllMocks();
  const s = db.__state;
  s.claimed = true;
  s.cardPause = undefined;
  s.writes = [];
  s.locks = new Map();
  isEnabled.mockReturnValue(true);
  process.env.TWILIO_ACCOUNT_SID = 'AC' + 'c'.repeat(32);
  process.env.TWILIO_AUTH_TOKEN = 'token';
  mockUpdate.mockResolvedValue({ status: 'paused' });
  jest.useFakeTimers({ now: new Date('2026-11-16T15:00:00Z'), doNotFake: ['setImmediate', 'nextTick'] });
});

afterEach(() => {
  cardPause._test.timers.forEach((t) => clearTimeout(t));
  cardPause._test.timers.clear();
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
