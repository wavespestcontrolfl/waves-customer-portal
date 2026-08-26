jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  recipientPhoneKey,
  optinBlocksSend,
  markRecipientOptin,
} = require('../services/recipient-optin');

describe('recipient double opt-in', () => {
  test('recipientPhoneKey matches the webhook last-10 convention', () => {
    expect(recipientPhoneKey('+19415550123')).toBe('9415550123');
    expect(recipientPhoneKey('(941) 555-0123')).toBe('9415550123');
    expect(recipientPhoneKey('')).toBe('');
    expect(recipientPhoneKey(null)).toBe('');
  });

  test('no row = grandfathered recipient, always allowed', () => {
    expect(optinBlocksSend(null, true)).toBe(false);
    expect(optinBlocksSend(undefined, true)).toBe(false);
  });

  test('pending and declined rows hold sends while the gate is on', () => {
    expect(optinBlocksSend({ status: 'pending' }, true)).toBe(true);
    expect(optinBlocksSend({ status: 'declined' }, true)).toBe(true);
    expect(optinBlocksSend({ status: 'confirmed' }, true)).toBe(false);
  });

  test('request_failed and lookup_error rows also hold sends (never-asked/unknown state)', () => {
    expect(optinBlocksSend({ status: 'request_failed' }, true)).toBe(true);
    expect(optinBlocksSend({ status: 'lookup_error' }, true)).toBe(true);
  });

  test('gate off disables the hold entirely', () => {
    expect(optinBlocksSend({ status: 'pending' }, false)).toBe(false);
    expect(optinBlocksSend({ status: 'declined' }, false)).toBe(false);
  });

  test('a later YES confirms declined rows even without dispatched_at (sync-21610 decline, codex #3495 r13)', async () => {
    // A synchronous 21610 declines the row BEFORE dispatch stamps
    // dispatched_at, and no sweep re-asks a declined row — the confirm
    // predicate must carve declined rows out of the dispatched_at
    // requirement or the person's explicit START+YES never unblocks them.
    // Capture the predicate the confirm update builds.
    const applied = { whereNotNull: [], orWhere: [] };
    function makeChain(rows = []) {
      const q = {};
      ['where', 'whereNot'].forEach((m) => {
        q[m] = jest.fn((arg) => {
          if (typeof arg === 'function') arg.call(q);
          return q;
        });
      });
      q.whereNotNull = jest.fn((col) => { applied.whereNotNull.push(col); return q; });
      q.orWhere = jest.fn((arg) => { applied.orWhere.push(arg); return q; });
      q.update = jest.fn(async () => 1);
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return q;
    }
    const confirmChain = makeChain();
    const pendingChain = makeChain([]); // no pending rows → no marker recovery
    const queues = { recipient_optin: [confirmChain, pendingChain] };
    const dbh = jest.fn((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`Unexpected table ${table}`);
      return queue.shift();
    });

    const updated = await markRecipientOptin('+19415550123', 'confirmed', { dbh });

    expect(updated).toBe(1);
    // ask_failed stays excluded; the dispatched_at requirement is grouped
    // with an OR status='declined' escape hatch.
    expect(confirmChain.whereNot).toHaveBeenCalledWith({ status: 'ask_failed' });
    expect(applied.whereNotNull).toContain('dispatched_at');
    expect(applied.orWhere).toContainEqual({ status: 'declined' });
  });
});
