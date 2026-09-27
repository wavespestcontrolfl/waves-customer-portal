// The shared bounded raw-connection mechanism (lifted from
// reschedule-link-promises.js, now also behind the renewal gate's session
// lock — Codex #4971 r13 P2): a count cap and a connect timeout, with a
// timed-out attempt holding its slot until the connect actually settles.
jest.mock('../models/db', () => ({ client: {} }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { rawConnectionSlots, trackConnectionLoss } = require('../services/raw-connection-slots');
const { EventEmitter } = require('events');

describe('rawConnectionSlots', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.client.acquireRawConnection = jest.fn(async () => ({ id: Symbol('conn') }));
    db.client.destroyRawConnection = jest.fn(async () => {});
  });

  test('the cap is enforced: the (max+1)th acquire gets null at once, without a connect; a release frees a slot', async () => {
    const slots = rawConnectionSlots({ max: 2, connectMs: 1000, logPrefix: '[test] lock session' });
    const a = await slots.acquire();
    const b = await slots.acquire();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(await slots.acquire()).toBeNull();
    expect(db.client.acquireRawConnection).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith('[test] lock session at its connection cap (2)');

    await slots.release(a);
    expect(db.client.destroyRawConnection).toHaveBeenCalledWith(a);
    expect(await slots.acquire()).toBeTruthy();
    expect(slots.openCount()).toBe(2);
  });

  test('a connect that does not finish in time returns null, and keeps its slot until the connect settles', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      let settle;
      db.client.acquireRawConnection = jest.fn(() => new Promise((resolve) => { settle = resolve; }));
      const slots = rawConnectionSlots({ max: 1, connectMs: 5000, logPrefix: '[test] lock session' });
      const attempt = slots.acquire();
      await jest.advanceTimersByTimeAsync(5001);
      expect(await attempt).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[test] lock session connection unavailable'));
      // Still counted: the socket may yet open.
      expect(slots.openCount()).toBe(1);
      expect(await slots.acquire()).toBeNull();

      const late = { id: 'late' };
      settle(late);
      await Promise.resolve();
      await Promise.resolve();
      expect(db.client.destroyRawConnection).toHaveBeenCalledWith(late);
      expect(slots.openCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a connect that fails outright frees its slot at once', async () => {
    db.client.acquireRawConnection = jest.fn(async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); });
    const slots = rawConnectionSlots({ max: 1, connectMs: 1000, logPrefix: '[test] lock session' });
    expect(await slots.acquire()).toBeNull();
    expect(slots.openCount()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('[test] lock session connection unavailable (ECONNREFUSED)');
  });
});

// Codex #4971 r15 P1: extracted from reschedule-link-promises.js's send
// interlock (trackInterlockLoss) so the parent-decision lock session
// (annual-prepay-renewals.js) shares this exact mechanism instead of a
// second copy — every raw-connection session-lock user's own error/end/close
// is the one authority for "is this session still held".
describe('trackConnectionLoss', () => {
  test.each(['error', 'end', 'close'])('marks held.lost on a %s event', (event) => {
    const connection = new EventEmitter();
    const held = { lost: false };
    trackConnectionLoss(connection, held);
    expect(held.lost).toBe(false);
    connection.emit(event, new Error('boom'));
    expect(held.lost).toBe(true);
  });

  test('does nothing for a connection with no .on (never throws)', () => {
    const held = { lost: false };
    expect(() => trackConnectionLoss({}, held)).not.toThrow();
    expect(() => trackConnectionLoss(null, held)).not.toThrow();
    expect(held.lost).toBe(false);
  });
});
