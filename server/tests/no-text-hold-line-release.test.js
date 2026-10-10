/**
 * disclaimed-number-holds: the two #6112 round-7 changes, with a fake connection.
 *   - armDisclaimedNumberHold runs the caller's afterArm(trx) INSIDE its transaction, after the hold
 *     row and the no-text marks, so a throwing card write rolls the hold back with it.
 *   - clearNoTextHoldsForPhone lifts every active no-text hold on the line except the given call,
 *     keeps plain disclaimed-number holds, and returns the source call ids.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../utils/triage-locks', () => ({ lockTriageCall: jest.fn(async () => {}) }));

const Holds = require('../services/disclaimed-number-holds');

function fakeTrx(log) {
  const chain = (table) => {
    const q = {
      where() { return q; }, whereIn() { return q; }, forUpdate() { return q; },
      first: async () => ({ id: 1 }),
      update: async (patch) => { log.push(['update', table, patch]); return 1; },
      then(resolve) { return resolve(1); },
    };
    return q;
  };
  const trx = (table) => chain(table);
  trx.raw = async (sql, params) => { log.push(['raw', sql.trim().split('\n')[0], params]); return { rows: [{ cleared_at: null }] }; };
  return trx;
}

describe('armDisclaimedNumberHold afterArm', () => {
  test('afterArm runs inside the transaction, after the hold row, and a throw aborts the whole transaction', async () => {
    const log = [];
    let committed = false;
    const conn = {
      transaction: async (fn) => {
        try { const out = await fn(fakeTrx(log)); committed = true; return out; } catch (e) { committed = false; throw e; }
      },
    };
    const afterArm = jest.fn(async () => { log.push(['afterArm']); });
    await Holds.armDisclaimedNumberHold({ phone: '+19415551234', callLogId: 7, procToken: 'tok', noTextHold: true, afterArm, conn });
    expect(afterArm).toHaveBeenCalledTimes(1);
    // hold row first (the INSERT raw), the no-text marks, then afterArm last — all inside the transaction
    const kinds = log.map((l) => l[0]);
    expect(kinds[0]).toBe('raw');
    expect(log[0][1]).toMatch(/INSERT INTO disclaimed_number_holds/);
    expect(kinds.filter((k) => k === 'update')).toHaveLength(2);
    expect(kinds[kinds.length - 1]).toBe('afterArm');
    expect(committed).toBe(true);

    const boom = jest.fn(async () => { throw new Error('card insert failed'); });
    await expect(Holds.armDisclaimedNumberHold({ phone: '+19415551234', callLogId: 7, procToken: 'tok', noTextHold: true, afterArm: boom, conn }))
      .rejects.toThrow('card insert failed');
    expect(committed).toBe(false);
  });

  test('a lost processing claim writes neither the hold nor the card', async () => {
    const log = [];
    const trx = fakeTrx(log);
    trx.__lost = true;
    const lostTrx = (table) => { const q = trx(table); q.first = async () => null; return q; };
    lostTrx.raw = trx.raw;
    const conn = { transaction: async (fn) => fn(lostTrx) };
    const afterArm = jest.fn();
    const out = await Holds.armDisclaimedNumberHold({ phone: '+19415551234', callLogId: 7, procToken: 'tok', noTextHold: true, afterArm, conn });
    expect(out).toEqual({ recorded: false, claimLost: true });
    expect(afterArm).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });
});

describe('clearNoTextHoldsForPhone', () => {
  test('clears active no-text holds on the line except the given call, keeps plain disclaimed holds, returns the call ids', async () => {
    const raw = jest.fn(async () => ({ rows: [{ source_call_log_id: 11 }, { source_call_log_id: 12 }] }));
    const out = await Holds.clearNoTextHoldsForPhone({ phoneE164: '(941) 555-1234', exceptCallLogId: 7, clearedBy: 'office', reason: 'verified_same_number', conn: { raw } });
    expect(out).toEqual([11, 12]);
    const [sql, params] = raw.mock.calls[0];
    expect(sql).toContain('h.cleared_at IS NULL');
    expect(sql).toContain("t.reason_code = 'text_number_differs'");
    expect(sql).toContain("d.reason_code = 'callback_number_needed'");
    expect(sql).toContain("COALESCE(d.payload->>'no_text_hold', '') <> 'true'");
    expect(sql).toContain('h.source_call_log_id <> ?');
    expect(params).toEqual(['office', 'verified_same_number', '+19415551234', 7, 7]);
  });

  test('a non-dialable number clears nothing', async () => {
    const raw = jest.fn();
    expect(await Holds.clearNoTextHoldsForPhone({ phoneE164: 'relay', conn: { raw } })).toEqual([]);
    expect(raw).not.toHaveBeenCalled();
  });
});
