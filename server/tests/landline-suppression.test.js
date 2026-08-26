jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: () => 'NOW()' };
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const { suppressNonMobileOnBounce } = require('../services/messaging/landline-suppression');
const { checkSuppression, recordNonMobileSuppression } = require('../services/messaging/validators/suppression');

let lastSuppressionChain = null;
let lastCustomersChain = null;
let insertResult = ['+18777175476']; // non-empty => a new row was recorded

function makeSuppressionChain() {
  const c = { _rows: [], _wheres: [] };
  c.insert = jest.fn((row) => { c._rows.push(row); return c; });
  c.onConflict = jest.fn(() => c);
  c.ignore = jest.fn(() => Promise.resolve(insertResult));
  // guarded-merge contract: merge({...}).where(reason cleared).where(active
  // false) — chain stays awaitable at every step.
  c.merge = jest.fn(() => c);
  c.where = jest.fn((...a) => { c._wheres.push(a); return c; });
  c.whereRaw = jest.fn((...a) => { c._wheres.push(['raw', ...a]); return c; });
  c.then = (resolve, reject) => Promise.resolve(insertResult).then(resolve, reject);
  lastSuppressionChain = c;
  return c;
}

function makeCustomersChain() {
  const c = { _updates: [] };
  c.whereRaw = jest.fn(() => c);
  c.whereNull = jest.fn(() => c);
  c.where = jest.fn((arg) => {
    if (typeof arg === 'function') {
      const sub = {};
      sub.whereNull = jest.fn(() => sub);
      sub.orWhereNot = jest.fn(() => sub);
      arg(sub);
    }
    return c;
  });
  c.update = jest.fn((patch) => { c._updates.push(patch); return Promise.resolve(1); });
  lastCustomersChain = c;
  return c;
}

function wireDb() {
  db.mockImplementation((table) => {
    if (table === 'messaging_suppression') return makeSuppressionChain();
    if (table === 'customers') return makeCustomersChain();
    throw new Error(`Unexpected db table ${table}`);
  });
}

describe('landline suppression on delivery bounce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    insertResult = ['+18777175476'];
    lastSuppressionChain = null;
    lastCustomersChain = null;
    wireDb();
  });

  test('records a non_mobile suppression on a carrier 30006 bounce', async () => {
    const res = await suppressNonMobileOnBounce({ errorCode: '30006', to: '(877) 717-5476' });

    expect(res.acted).toBe(true);
    expect(res.recorded).toBe(true);
    expect(res.phone).toBe('+18777175476'); // normalized to E.164
    expect(lastSuppressionChain._rows[0]).toMatchObject({ reason: 'non_mobile', active: true });
    expect(lastSuppressionChain._rows[0].source).toBe('twilio_status_30006');
    // Refreshes the customers.line_type cache too.
    expect(lastCustomersChain._updates[0]).toEqual({ line_type: 'landline' });
  });

  test('never clobbers a real existing record — the merge is guarded to clearance tombstones only', async () => {
    await suppressNonMobileOnBounce({ errorCode: '30006', to: '+18777175476' });

    expect(lastSuppressionChain.onConflict).toHaveBeenCalledWith('phone');
    // A pure clearance tombstone (reason='cleared', inactive — written when
    // a START arrived for a never-suppressed phone) is supersedable by a
    // genuine landline verdict; every other existing row keeps the
    // never-clobber contract via the two guards below.
    expect(lastSuppressionChain.merge).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'non_mobile', active: true, cleared_at: null }),
    );
    expect(lastSuppressionChain._wheres).toEqual(expect.arrayContaining([
      ['messaging_suppression.reason', 'cleared'],
      ['messaging_suppression.active', false],
    ]));
  });

  test('ignores non-landline delivery codes (e.g. 30003 unreachable handset)', async () => {
    const res = await suppressNonMobileOnBounce({ errorCode: '30003', to: '+18777175476' });

    expect(res.acted).toBe(false);
    expect(res.reason).toBe('not_a_landline_code');
    expect(db).not.toHaveBeenCalledWith('messaging_suppression');
  });

  test('no-ops when there is no recipient number', async () => {
    const res = await suppressNonMobileOnBounce({ errorCode: '30006', to: '' });
    expect(res.acted).toBe(false);
    expect(res.reason).toBe('no_recipient');
  });

  test('reports recorded=false when the row already existed (conflict ignored)', async () => {
    insertResult = []; // conflict => nothing inserted
    const res = await suppressNonMobileOnBounce({ errorCode: '30006', to: '+18777175476' });
    expect(res.acted).toBe(true);
    expect(res.recorded).toBe(false);
  });

  test('recordNonMobileSuppression writes reason non_mobile via insert-if-absent', async () => {
    const res = await recordNonMobileSuppression({ phone: '+18777175476', source: 'twilio_status_30006' });
    expect(res.ok).toBe(true);
    expect(res.recorded).toBe(true);
    expect(lastSuppressionChain.merge).toHaveBeenCalled(); // guarded tombstone-only merge
  });
});

describe('checkSuppression non_mobile branch', () => {
  test('blocks a recipient flagged as non_mobile with a dedicated code', async () => {
    const result = await checkSuppression(
      { to: '+18777175476' },
      {},
      { suppression: { reason: 'non_mobile', created_at: '2026-06-20T10:00:00Z' } },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SUPPRESSED_NON_MOBILE');
  });
});
