// db is mocked so the write-path describe below can drive extendEstimate
// end-to-end; every other describe here exercises pure/pre-write paths that
// never touch it.
jest.mock('../models/db', () => {
  const mockDeletes = [];
  const dbFn = jest.fn((table) => {
    const b = { _table: table, _whereIn: null };
    for (const m of ['where', 'whereNull', 'whereNotNull']) b[m] = jest.fn(() => b);
    b.whereIn = jest.fn((...args) => { b._whereIn = args; return b; });
    b.update = jest.fn(() => Promise.resolve(1));
    b.del = jest.fn(() => {
      mockDeletes.push({ table: b._table, whereIn: b._whereIn });
      return Promise.resolve(1);
    });
    return b;
  });
  dbFn.fn = { now: jest.fn(() => 'NOW()') };
  dbFn._deletes = mockDeletes;
  return dbFn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The re-arm heals uncounted sends before deleting their rows — pin the
// boundary; repair behavior itself is pinned in the follow-up suites.
jest.mock('../services/estimate-follow-up', () => ({
  _private: { repairFollowupCounters: jest.fn(async () => null) },
}));

const db = require('../models/db');
const { repairFollowupCounters } = require('../services/estimate-follow-up')._private;
const {
  extendEstimate,
  computeExtensionExpiry,
  extensionStatusUpdate,
  EXTENDABLE_STATUSES,
} = require('../services/estimate-extension');

const DAY = 86400000;
const NOW = new Date('2026-07-10T12:00:00Z');
const FUTURE = new Date(NOW.getTime() + 3 * DAY).toISOString();
const PAST = new Date(NOW.getTime() - 3 * DAY).toISOString();

describe('computeExtensionExpiry (shared by admin extend + public auto-grant)', () => {
  it('extends an already-expired estimate from NOW, not from the lapsed expiry', () => {
    const result = computeExtensionExpiry({ expires_at: PAST }, 7, NOW);
    expect(result.getTime()).toBe(NOW.getTime() + 7 * DAY);
  });

  it('pushes an active estimate out from its CURRENT expiry', () => {
    const result = computeExtensionExpiry({ expires_at: FUTURE }, 7, NOW);
    expect(result.getTime()).toBe(new Date(FUTURE).getTime() + 7 * DAY);
  });

  it('treats a missing expiry as "now" (7d from today)', () => {
    const result = computeExtensionExpiry({ expires_at: null }, 7, NOW);
    expect(result.getTime()).toBe(NOW.getTime() + 7 * DAY);
  });
});

describe('extensionStatusUpdate (view-blocking status revival)', () => {
  it('revives a sweep-expired row to viewed when the customer had viewed', () => {
    expect(extensionStatusUpdate({ status: 'expired', viewed_at: PAST })).toBe('viewed');
  });

  it('revives a sweep-expired unviewed row to sent', () => {
    expect(extensionStatusUpdate({ status: 'expired', viewed_at: null })).toBe('sent');
  });

  it('revives send_failed (view-blocked regardless of expiry) the same way', () => {
    expect(extensionStatusUpdate({ status: 'send_failed', viewed_at: PAST })).toBe('viewed');
    expect(extensionStatusUpdate({ status: 'send_failed', viewed_at: null })).toBe('sent');
  });

  it('revives a DATE-EXPIRED stuck sending row with publication evidence (codex P2)', () => {
    // Left as 'sending', the extension's updated_at bump delays
    // recoverStaleScheduledEstimateClaims, and that recovery later flips the
    // row to send_failed/scheduled — killing the just-extended link.
    expect(extensionStatusUpdate({ status: 'sending', sent_at: PAST, expires_at: PAST }, NOW)).toBe('sent');
    expect(extensionStatusUpdate({ status: 'sending', viewed_at: PAST, expires_at: PAST }, NOW)).toBe('viewed');
  });

  it('leaves already-viewable statuses untouched (returns null = no status write)', () => {
    expect(extensionStatusUpdate({ status: 'sent', viewed_at: null })).toBe(null);
    expect(extensionStatusUpdate({ status: 'viewed', viewed_at: PAST })).toBe(null);
    // An ACTIVE (future-expiry) or evidence-less 'sending' row belongs to the
    // in-flight send machinery.
    expect(extensionStatusUpdate({ status: 'sending', sent_at: PAST, expires_at: FUTURE }, NOW)).toBe(null);
    expect(extensionStatusUpdate({ status: 'sending', sent_at: null, viewed_at: null, expires_at: PAST }, NOW)).toBe(null);
  });
});

describe('extendEstimate validation (pre-write throws)', () => {
  it('refuses a LIVE sending claim — in-flight finalization owns status and expiry', async () => {
    // Thrown BEFORE any DB access: an extension mid-send would either be
    // overwritten by the send's final expires_at write or steal its claim.
    await expect(extendEstimate({
      estimate: { id: 1, status: 'sending', expires_at: FUTURE },
      days: 7,
      entryPoint: 'test',
      workflow: 'test',
    })).rejects.toMatchObject({ statusCode: 400 });
    // Null expiry = mid-send window not written yet: also live, also refused.
    await expect(extendEstimate({
      estimate: { id: 1, status: 'sending', expires_at: null },
      days: 7,
      entryPoint: 'test',
      workflow: 'test',
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a STALE sending row with no publication evidence — re-send, not extend', async () => {
    // No sent_at/viewed_at means the crashed send never reached the customer:
    // there is no link to extend, and the row would stay status='sending' for
    // the stale-send recovery to flip to send_failed later.
    await expect(extendEstimate({
      estimate: { id: 1, status: 'sending', expires_at: PAST, sent_at: null, viewed_at: null },
      days: 7,
      entryPoint: 'test',
      workflow: 'test',
    })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('extendEstimate post-write: engine expiring re-arm (codex 2736 r9)', () => {
  it('deletes the engine expiring jobs + ledger rows after the guarded update (silent extension)', async () => {
    db._deletes.length = 0;
    const res = await extendEstimate({
      estimate: { id: 'est-9', status: 'viewed', archived_at: null, expires_at: FUTURE, viewed_at: PAST },
      days: 7,
      silent: true,
      entryPoint: 'test',
      workflow: 'test',
    });
    expect(res.newExpiry).toBeInstanceOf(Date);
    // Uncounted sends are healed into the estimate's counters BEFORE their
    // rows are deleted (codex 2736 r11) — never destroy uncounted evidence.
    expect(repairFollowupCounters).toHaveBeenCalledWith('est-9');
    // The one-lifecycle enqueue guard + sends-group budget key on these rows;
    // deleting them IS the re-arm for the new deadline (mirrors the
    // followup_expiring_sent reset).
    expect(db._deletes).toEqual([
      { table: 'estimate_followup_jobs', whereIn: ['rule_key', ['expiring_engaged', 'expiring_never_viewed']] },
      { table: 'estimate_followup_sends', whereIn: ['rule_key', ['expiring_engaged', 'expiring_never_viewed']] },
    ]);
  });
});

describe('EXTENDABLE_STATUSES', () => {
  it('covers every published status the public eligibility predicate can admit', () => {
    // Superset requirement: isEstimateExtensionRequestEligible admits
    // date-expired send_failed/sending rows with sent_at, so the service must
    // accept them or the public POST 500s on a row the UI offered the button
    // for (codex P1, 2026-07-10).
    expect(EXTENDABLE_STATUSES).toEqual(['sent', 'viewed', 'expired', 'send_failed', 'sending']);
  });
});
