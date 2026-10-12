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

describe('armDisclaimedNumberHold with no dialable number', () => {
  test('the card write still runs under the triage lock and the claim fence; a lost claim writes nothing', async () => {
    const { lockTriageCall } = require('../utils/triage-locks');
    lockTriageCall.mockClear();
    const log = [];
    const conn = { transaction: async (fn) => fn(fakeTrx(log)) };
    const afterArm = jest.fn(async () => { log.push(['afterArm']); });
    const out = await Holds.armDisclaimedNumberHold({ phone: 'anonymous', callLogId: 7, procToken: 'tok', noTextHold: true, afterArm, conn });
    expect(out).toEqual({ recorded: false, reason: 'no_phone' });
    expect(lockTriageCall).toHaveBeenCalledWith(expect.anything(), 7);
    expect(afterArm).toHaveBeenCalledTimes(1);
    expect(log.map((l) => l[0])).toEqual(['afterArm']); // no hold row, no marks

    const lostTrx = fakeTrx(log); const base = lostTrx;
    const lost = (table) => { const q = base(table); q.first = async () => null; return q; };
    lost.raw = base.raw;
    const afterArm2 = jest.fn();
    expect(await Holds.armDisclaimedNumberHold({ phone: 'anonymous', callLogId: 7, procToken: 'tok', afterArm: afterArm2, conn: { transaction: async (fn) => fn(lost) } }))
      .toEqual({ recorded: false, claimLost: true });
    expect(afterArm2).not.toHaveBeenCalled();
  });

  test('the no-text mark SQL keeps ownership for a card that was filed without the no-text mark', () => {
    expect(Holds.NO_TEXT_MARK_SQL).toContain("'no_text_hold', true");
    expect(Holds.NO_TEXT_MARK_SQL).toContain("'ownership_disclaimed', COALESCE((payload->>'ownership_disclaimed')::boolean, COALESCE(payload->>'no_text_hold', '') <> 'true')");
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
    // a plain disclaimer card OR a dual-signal card marked ownership_disclaimed keeps that call's hold
    expect(sql).toContain("(COALESCE(d.payload->>'no_text_hold', '') <> 'true' OR COALESCE(d.payload->>'ownership_disclaimed', '') = 'true')");
    expect(sql).toContain('AND h.source_call_log_id <> ?');
    expect(sql).not.toContain('? IS NULL'); // no untyped null binding
    expect(sql).toContain("d.status <> 'resolved'"); // a RESOLVED ownership card verified the number: that call joins the release
    expect(params).toEqual(['office', 'verified_same_number', '+19415551234', 7]);
  });

  test('without an excluded call the exclusion clause is omitted entirely (no untyped null binding)', async () => {
    const raw = jest.fn(async () => ({ rows: [] }));
    await Holds.clearNoTextHoldsForPhone({ phoneE164: '+19415551234', clearedBy: 'office', reason: 'verified_same_number', conn: { raw } });
    const [sql, params] = raw.mock.calls[0];
    expect(sql).not.toContain('source_call_log_id <>');
    expect(params).toEqual(['office', 'verified_same_number', '+19415551234']);
  });

  test('a non-dialable number clears nothing', async () => {
    const raw = jest.fn();
    expect(await Holds.clearNoTextHoldsForPhone({ phoneE164: 'relay', conn: { raw } })).toEqual([]);
    expect(raw).not.toHaveBeenCalled();
  });
});

describe('lockNoTextLines / callLineRows', () => {
  const LOCK = 'SELECT pg_advisory_xact_lock(hashtext(?))';
  function lockConn(rows, log) {
    const conn = (table) => {
      const q = {
        where() { return q; }, orderBy() { return q; },
        select: async () => { log.push(['select', table]); return rows; },
        update: async () => { log.push(['update', table]); return 1; },
      };
      return q;
    };
    conn.raw = async (sql, params) => { log.push(['raw', sql, params]); return { rows: [] }; };
    return conn;
  }

  test('takes the phone-wide advisory lock on the E.164 before any hold row is written', async () => {
    const log = [];
    const conn = lockConn([{ phone_e164: '(941) 555-1234', cleared_at: null }], log);
    const [line] = await Holds.callLineRows(conn, 7);
    expect(line).toEqual({ key: '+19415551234', active: true });
    await Holds.lockNoTextLines(conn, [line.key]);
    await Holds.clearNoTextHoldsForPhone({ phoneE164: line.key, exceptCallLogId: 7, reason: 'verified_same_number', conn: { raw: conn.raw } });
    const kinds = log.map((l) => (l[0] === 'raw' ? (l[1] === LOCK ? 'lock' : 'hold-update') : l[0]));
    expect(kinds).toEqual(['select', 'lock', 'hold-update']);
    expect(log[1][2]).toEqual(['no_text_line:+19415551234']);
    expect(log[2][1]).toContain('UPDATE disclaimed_number_holds');
  });

  test('several lines lock once each, in sorted order, so two releases never take them crosswise', async () => {
    const log = [];
    const conn = lockConn([{ phone_e164: '+19415559999' }, { phone_e164: '+19415550001' }, { phone_e164: '+19415559999' }, { phone_e164: 'relay' }], log);
    const lines = await Holds.callLineRows(conn, 7);
    expect(lines.map((l) => l.key)).toEqual(['+19415559999', '+19415550001']); // newest first, de-duplicated, non-dialable dropped
    await Holds.lockNoTextLines(conn, lines.map((l) => l.key));
    expect(log.filter((l) => l[0] === 'raw').map((l) => l[2][0])).toEqual(['no_text_line:+19415550001', 'no_text_line:+19415559999']);
  });

  test('a line is active when any of its rows is uncleared; no call or no rows gives nothing to lock', async () => {
    const log = [];
    const lines = await Holds.callLineRows(lockConn([{ phone_e164: '+19415550001', cleared_at: new Date() }, { phone_e164: '+19415550002', cleared_at: new Date() }, { phone_e164: '+19415550002', cleared_at: null }], log), 7);
    expect(lines).toEqual([{ key: '+19415550001', active: false }, { key: '+19415550002', active: true }]);
    expect(await Holds.callLineRows(lockConn([], log), null)).toEqual([]);
    await Holds.lockNoTextLines(lockConn([], log), []);
    expect(log.filter((l) => l[0] === 'raw')).toEqual([]);
  });

  test('clearDisclaimedNumberHoldsForCall can be limited to the selected lines', async () => {
    const calls = [];
    const q = { where() { return q; }, whereNull() { return q; }, modify(fn) { fn(q); return q; }, whereIn(c, v) { calls.push([c, v]); return q; }, update: async () => 1 };
    const conn = () => q;
    await Holds.clearDisclaimedNumberHoldsForCall({ callLogId: 7, reason: 'r', phoneKeys: ['+19415550001'], conn });
    expect(calls).toEqual([['phone_e164', ['+19415550001']]]);
    calls.length = 0;
    await Holds.clearDisclaimedNumberHoldsForCall({ callLogId: 7, reason: 'r', conn });
    expect(calls).toEqual([]);
  });
});

describe('card <-> hold binding SQL', () => {
  test('stampOpenNoTextCards appends a { line_e164, held_at } binding for every active hold of the call, once', async () => {
    const raw = jest.fn(async () => ({ rows: [] }));
    await Holds.stampOpenNoTextCards({ raw }, 'call-1');
    const [sql, params] = raw.mock.calls[0];
    expect(sql).toContain("jsonb_build_object('line_e164', h.phone_e164, 'held_at', h.held_at::text)");
    expect(sql).toContain("t.reason_code = 'text_number_differs' AND t.status IN ('open', 'in_progress')");
    expect(sql).toContain('h.cleared_at IS NULL');
    expect(sql).toContain("COALESCE(t.payload->'hold_bindings', '[]'::jsonb) || fresh.elems"); // appended, never replaced
    expect(sql).toContain('NOT EXISTS'); // idempotent
    expect(sql).not.toContain('ani_phone'); // no phone matching at all: the hold row names the line
    expect(params).toEqual(['call-1']);
  });

  test('no call: nothing runs', async () => {
    const raw = jest.fn();
    await Holds.stampOpenNoTextCards({ raw }, null);
    expect(raw).not.toHaveBeenCalled();
  });

  test('a card refresh keeps the bindings the new payload does not carry', () => {
    const conn = { raw: jest.fn((sql, bindings) => ({ sql, bindings })) };
    const out = Holds.refreshedCardPayload(conn, { ani_phone: '+19415550100' });
    expect(out.sql).toContain("jsonb_build_object('hold_bindings', payload->'hold_bindings')");
    expect(out.bindings).toEqual(['{"ani_phone":"+19415550100"}']);
  });

  test('unstamped cards bind only inside the 5-minute window and on the canonical line, never as a wildcard', () => {
    const sql = Holds.NO_TEXT_CARD_FOR_HOLD_SQL;
    expect(sql).toContain("t.payload->'hold_bindings' IS NULL");
    expect(sql).toContain("h.held_at BETWEEN t.created_at - interval '5 minutes' AND t.created_at + interval '5 minutes'");
    expect(sql).toContain("= h.phone_e164");
  });

  test('the SQL phone identity follows utils/phone.js: NANP collapses to +1 + ten digits, other countries keep every digit', () => {
    const sql = Holds.canonicalPhoneSql('x');
    expect(sql).toContain("'+1' || right(regexp_replace(x, '\\D', '', 'g'), 10)");
    expect(sql).toContain("ELSE '+' || regexp_replace(x, '\\D', '', 'g')");
    expect(sql).toContain("~ '^1\\d{10}$'");
  });

  test('the line-blocked check looks at every active hold on the line, not only calls with a no-text card', async () => {
    const raw = jest.fn(async () => ({ rows: [{ phone_e164: '+19415551234' }] }));
    const out = await Holds.linesBlockedByOwnershipCard({ raw }, ['+19415551234', '+19415557777']);
    expect([...out]).toEqual(['+19415551234']);
    const [sql, params] = raw.mock.calls[0];
    expect(sql).not.toContain('text_number_differs');
    expect(sql).toContain(Holds.lineOwnershipBlockSql('h.phone_e164'));
    expect(sql).toContain("d.reason_code = 'callback_number_needed'");
    expect(params).toEqual(['+19415551234', '+19415557777']);
  });
});
