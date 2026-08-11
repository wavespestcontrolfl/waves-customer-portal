// Persisted bridge-ambiguity records (owner ruling 2026-08-11, closing the
// GH-r24 P1 on PR #3303): the day's ambiguous candidate set was the ONLY
// record of ambiguity, rebuilt from the fixed 30-day scan — the day a
// candidate aged out, the exclusion evaporated and the organic sweep
// stamped its lead with the irreversible organic label.

let listQueueByTable = {};
let updateResultsByTable = {};
const insertCalls = [];
const updateCalls = [];
const mergeCalls = [];
const builders = [];

const mockDb = jest.fn((table) => {
  const b = { _table: table, _wheres: [] };
  ['join', 'where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull',
    'whereExists', 'whereRaw', 'forUpdate', 'select', 'orderBy', 'limit'].forEach((m) => {
    b[m] = jest.fn((...a) => { b._wheres.push([m, ...a]); return b; });
  });
  b.modify = jest.fn((fn) => { fn(b); return b; });
  b.insert = jest.fn((rows) => { insertCalls.push({ table, rows }); return b; });
  b.onConflict = jest.fn(() => b);
  b.merge = jest.fn((patch) => { mergeCalls.push({ table, patch }); return b; });
  b.update = jest.fn((patch) => {
    updateCalls.push({ table, wheres: b._wheres.slice(), patch });
    const q = updateResultsByTable[table];
    return Promise.resolve((q && q.length) ? q.shift() : 0);
  });
  b.then = (res, rej) => {
    const q = listQueueByTable[table];
    const val = (q && q.length) ? q.shift() : [];
    return Promise.resolve(val).then(res, rej);
  };
  builders.push(b);
  return b;
});
mockDb.raw = jest.fn((sql) => sql);
mockDb.fn = { now: () => 'NOW()' };
mockDb.transaction = jest.fn(async (fn) => fn(mockDb));

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('google-ads-api', () => ({ GoogleAdsApi: jest.fn(), enums: { CampaignStatus: { ENABLED: 'ENABLED', PAUSED: 'PAUSED' } } }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'uuid-1') }));
// The reopen reconciliation retires through the shared history-preserving
// primitive — pin the delegation, not a re-implementation.
const mockRetire = jest.fn(async () => 1);
jest.mock('../services/ads/call-attribution', () => ({
  retireCallAttributionRow: (...a) => mockRetire(...a),
}));

const {
  recordAmbiguousBridgeCalls,
  resolveAmbiguousBridgeCalls,
  openAmbiguousCallExclusions,
} = require('../services/ads/google-call-bridge');

beforeEach(() => {
  jest.clearAllMocks();
  listQueueByTable = {};
  updateResultsByTable = {};
  insertCalls.length = 0;
  updateCalls.length = 0;
  mergeCalls.length = 0;
  builders.length = 0;
});

describe('recordAmbiguousBridgeCalls', () => {
  test('upserts one row per candidate call, deduped by id, sid carried for the sid-exclusion arm', async () => {
    const n = await recordAmbiguousBridgeCalls([
      { id: 'call-1', twilioCallSid: 'CA1' },
      { id: 'call-1', twilioCallSid: 'CA1' }, // duplicate candidate
      { id: 'call-2', twilioCallSid: null },
      { id: null }, // id-less shapes are skipped, never inserted
    ]);
    expect(n).toBe(2);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].rows).toEqual([
      { call_log_id: 'call-1', twilio_call_sid: 'CA1' },
      { call_log_id: 'call-2', twilio_call_sid: null },
    ]);
  });

  test('the whole lifecycle write rides ONE transaction with the existing records locked (audit P1 r3)', async () => {
    // Reopen check, upsert, snapshot, and retirement were separate
    // autocommit statements — a concurrent resolve could land between the
    // reopen SELECT and the upsert, leaving the interim organic row
    // unretired. The reopen read locks FOR UPDATE inside the transaction.
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    const reopenRead = builders.find(
      (b) => b._table === 'bridge_ambiguous_calls'
        && b._wheres.some(([m]) => m === 'forUpdate')
        && b._wheres.some(([m, col]) => m === 'whereNotNull' && col === 'resolved_at'),
    );
    expect(reopenRead).toBeTruthy();
  });

  test('records SNAPSHOT the leads matching the caller leg — the durable identity for the indefinite phone hold (audit P1 r3)', async () => {
    // A findReusableCallLead association carries neither sid nor stamp;
    // once its call ages past the scan window the fresh-candidates phone
    // arm no longer sees it. The snapshot names the exact leads held.
    await recordAmbiguousBridgeCalls([
      { id: 'call-1', twilioCallSid: 'CA1' },
      { id: 'call-2', twilioCallSid: null },
    ]);
    const snap = mockDb.raw.mock.calls.find(([sql]) => /bridge_ambiguous_call_leads/.test(sql));
    expect(snap).toBeTruthy();
    expect(snap[0]).toMatch(/INSERT INTO bridge_ambiguous_call_leads/);
    expect(snap[0]).toMatch(/ON CONFLICT DO NOTHING/);
    // CALLER leg, last-10 compare, length-guarded — same predicate as the
    // fresh phone arm.
    expect(snap[0]).toMatch(/cl\.from_phone/);
    expect(snap[0]).toMatch(/RIGHT\(regexp_replace\(COALESCE\(l\.phone, ''\), '\[\^0-9\]', '', 'g'\), 10\)/);
    expect(snap[0]).toMatch(/LENGTH\(regexp_replace\(COALESCE\(l\.phone, ''\), '\[\^0-9\]', '', 'g'\)\) >= 10/);
    // TEMPORALLY BOUNDED (audit P1 r4): a reused lead existed by the
    // call's last possible processing pass — created_at anchored to the
    // immutable call time plus the shared extraction retry window, so
    // repeat/reopen re-records can never add a later, distinct lead.
    expect(snap[0]).toMatch(/l\.created_at < cl\.created_at \+ make_interval\(secs => \?\)/);
    expect(snap[1]).toEqual([7 * 24 * 60 * 60, 'call-1', 'call-2']);
  });

  test('a repeat REOPENS a previously resolved record — today\'s scan supersedes an old resolution', async () => {
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0].patch).toMatchObject({ resolved_at: null, resolve_reason: null });
    expect(mergeCalls[0].patch.last_seen_at).toBeTruthy();
  });

  test('a REOPEN retires the attribution rows written while the hold was lifted (codex P1 r2)', async () => {
    // rescan_clear → same-tick organic write → ambiguity returns: the
    // re-armed hold alone cannot repair the row (recordCallPpcAttribution
    // dedupes by lead), so the reopen retires the interim rows through the
    // shared history-preserving primitive — in the SAME transaction as the
    // reopen upsert, so a crash cannot strand the interim row (audit P1 r3).
    listQueueByTable.bridge_ambiguous_calls = [[{ call_log_id: 'call-1' }]]; // previously RESOLVED
    listQueueByTable.ad_service_attribution = [[{ lead_id: 'lead-9' }]];
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mockRetire).toHaveBeenCalledTimes(1);
    // First arg is the transaction handle the reopen upsert used.
    expect(mockRetire.mock.calls[0][0]).toBe(mockDb);
    expect(mockRetire.mock.calls[0][1]).toBe('call-1');
    expect(mockRetire.mock.calls[0][2]).toBe('lead-9');
  });

  test('a FIRST sighting (never resolved) retires nothing — no interim write can exist under an open hold', async () => {
    listQueueByTable.bridge_ambiguous_calls = [[]]; // no resolved rows among the batch
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mockRetire).not.toHaveBeenCalled();
  });

  test('no valid candidates → no insert at all', async () => {
    const n = await recordAmbiguousBridgeCalls([{ twilioCallSid: 'CA-orphan' }]);
    expect(n).toBe(0);
    expect(insertCalls).toHaveLength(0);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe('resolveAmbiguousBridgeCalls', () => {
  test('bridged calls resolve even on an untrusted scan day — one atomic UPDATE, no read-then-write gap (audit P1 r3)', async () => {
    updateResultsByTable.bridge_ambiguous_calls = [1];
    const res = await resolveAmbiguousBridgeCalls({ rescanTrusted: false });
    expect(res).toEqual({ bridged: 1, rescanCleared: 0 });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch.resolve_reason).toBe('bridged');
    // Conditioned on still-open so a concurrent resolve is not overwritten,
    // with the paid-claim evidence correlated in the SAME statement.
    expect(updateCalls[0].wheres).toContainEqual(['whereNull', 'resolved_at']);
    expect(updateCalls[0].wheres.some(([m]) => m === 'whereExists')).toBe(true);
  });

  test('rescan_clear: trusted scan + window coverage + NOT re-reported since the scan started (audit P1 r3)', async () => {
    updateResultsByTable.bridge_ambiguous_calls = [0, 1];
    const windowStart = new Date('2026-07-13T00:00:00Z');
    const scanStartedAt = new Date('2026-08-11T09:00:00Z');
    const res = await resolveAmbiguousBridgeCalls({
      ambiguousCallIds: ['call-today'],
      scanWindowStart: windowStart,
      scanStartedAt,
      rescanTrusted: true,
    });
    expect(res).toEqual({ bridged: 0, rescanCleared: 1 });
    expect(updateCalls).toHaveLength(2);
    const rescan = updateCalls[1];
    expect(rescan.patch.resolve_reason).toBe('rescan_clear');
    expect(rescan.wheres).toContainEqual(['whereNull', 'resolved_at']);
    // The freshness gate: a slow scan can never clear an ambiguity a
    // concurrent manual apply re-reported while the scan ran.
    expect(rescan.wheres).toContainEqual(['where', 'last_seen_at', '<', scanStartedAt]);
    expect(rescan.wheres).toContainEqual(['whereNotIn', 'call_log_id', ['call-today']]);
    expect(rescan.wheres.some(([m]) => m === 'whereExists')).toBe(true);
  });

  test('an UNTRUSTED scan never rescan-clears — absence from a degraded scan is not evidence', async () => {
    const res = await resolveAmbiguousBridgeCalls({
      ambiguousCallIds: [],
      scanWindowStart: new Date('2026-07-13T00:00:00Z'),
      scanStartedAt: new Date('2026-08-11T09:00:00Z'),
      rescanTrusted: false,
    });
    expect(res).toEqual({ bridged: 0, rescanCleared: 0 });
    // Only the bridged UPDATE ran (affecting nothing).
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch.resolve_reason).toBe('bridged');
  });

  test('a missing window boundary never rescan-clears, trusted or not', async () => {
    const res = await resolveAmbiguousBridgeCalls({
      rescanTrusted: true,
      scanStartedAt: new Date('2026-08-11T09:00:00Z'),
    });
    expect(res).toEqual({ bridged: 0, rescanCleared: 0 });
    expect(updateCalls).toHaveLength(1);
  });

  test('a missing scanStartedAt fails CLOSED — no rescan_clear without the freshness boundary (audit P1 r3)', async () => {
    const res = await resolveAmbiguousBridgeCalls({
      scanWindowStart: new Date('2026-07-13T00:00:00Z'),
      rescanTrusted: true,
    });
    expect(res).toEqual({ bridged: 0, rescanCleared: 0 });
    expect(updateCalls).toHaveLength(1);
  });
});

describe('openAmbiguousCallExclusions', () => {
  test('shapes ALL open records for the sweep — ids deduped, NULL sids dropped from the sid arm only', async () => {
    listQueueByTable.bridge_ambiguous_calls = [[
      { call_log_id: 'call-1', twilio_call_sid: 'CA1' },
      { call_log_id: 'call-2', twilio_call_sid: null }, // still excluded via the id/stamp arms
    ]];
    const res = await openAmbiguousCallExclusions();
    expect(res).toEqual({
      excludeCallIds: ['call-1', 'call-2'],
      excludeCallSids: ['CA1'],
      excludeLeadIds: [],
    });
  });

  test('held leads come from the snapshot rows of OPEN records — the indefinite phone hold (audit P1 r3)', async () => {
    listQueueByTable.bridge_ambiguous_calls = [[
      { call_log_id: 'call-1', twilio_call_sid: 'CA1' },
    ]];
    listQueueByTable['bridge_ambiguous_call_leads as bal'] = [[
      { lead_id: 'lead-7' },
      { lead_id: 'lead-7' }, // two calls holding the same lead — dedupe
      { lead_id: 'lead-8' },
    ]];
    const res = await openAmbiguousCallExclusions();
    expect(res.excludeLeadIds).toEqual(['lead-7', 'lead-8']);
    // The read joins to the PARENT record's open state — resolution drops
    // the hold without touching the snapshot rows.
    const read = builders.find((b) => b._table === 'bridge_ambiguous_call_leads as bal');
    expect(read._wheres).toContainEqual(['whereNull', 'bac.resolved_at']);
  });
});

describe('scheduler wiring (source pins)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
  const block = src.split("runExclusive('google-call-bridge-organic'")[1].slice(0, 14000);

  test('the organic exclusions come from ALL OPEN persisted records, not the day\'s scan set', () => {
    expect(block).toMatch(/\.\.\.\(await require\('\.\/ads\/google-call-bridge'\)\.openAmbiguousCallExclusions\(\)\)/);
    // Recording lives in applyBridge (every apply path, manual included) —
    // NOT in the cron; the cron only resolves and reads.
    expect(block).not.toMatch(/recordAmbiguousBridgeCalls/);
    const resv = block.indexOf('resolveAmbiguousBridgeCalls');
    const open = block.indexOf('openAmbiguousCallExclusions');
    expect(resv).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(resv);
    // ...and the read sits on EVERY sweep path, AFTER the unconfigured
    // branch — an opt-in install with pre-teardown records must still hold
    // their leads.
    expect(open).toBeGreaterThan(block.indexOf('google_ads_unconfigured'));
  });

  test('only the DAY\'S fresh candidates take the broad phone arm — persisted holds ride the durable arms (codex P1 r2)', () => {
    expect(block).toMatch(/dayAmbiguousCallIds = r\.ambiguousCandidateCallIds \|\| \[\]/);
    expect(block).toMatch(/excludePhoneCallIds: dayAmbiguousCallIds/);
    // Sweep side: the phone arm consumes ONLY excludePhoneCallIds; the
    // stamp arm keeps the (possibly indefinite) persisted ids; the exact
    // snapshot leads carry the indefinite phone hold (audit P1 r3).
    const fs2 = require('fs');
    const ca = fs2.readFileSync(path.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    const sweep = ca.split('async function attributeUnclaimedBridgeLeads')[1];
    const phoneArm = sweep.split('function phoneLinkedCallAmbiguous')[1];
    expect(phoneArm).toMatch(/whereIn\('clp\.id', excludePhoneCallIds\)/);
    expect(phoneArm).not.toMatch(/whereIn\('clp\.id', excludeCallIds\)/);
    expect(sweep).toMatch(/if \(excludePhoneCallIds\.length\)/);
    expect(sweep).toMatch(/if \(excludeLeadIds\.length\)/);
    expect(sweep).toMatch(/whereNotIn\('l\.id', excludeLeadIds\)/);
  });

  test('rescan_clear is gated on a TRUSTED scan, a coverage boundary with a one-day margin, and a DB-clock scan start', () => {
    expect(block).toMatch(/rescanTrusted: !r\.scanFailed && !capHit && !writeFailed/);
    expect(block).toMatch(/\(bridgeScanDays - 1\) \* 24 \* 60 \* 60 \* 1000/);
    // One named window constant feeds BOTH the scan and the boundary — they
    // cannot drift apart.
    expect(block).toMatch(/applyBridge\(\{ days: bridgeScanDays, limit: 500 \}\)/);
    // The freshness boundary is captured from the DB clock BEFORE the scan
    // (last_seen_at is DB-clock too) and passed through (audit P1 r3).
    expect(block).toMatch(/SELECT now\(\) AS db_now/);
    const captured = block.indexOf('bridgeScanStartedAt =');
    expect(captured).toBeGreaterThan(-1);
    expect(captured).toBeLessThan(block.indexOf('applyBridge({ days: bridgeScanDays'));
    expect(block).toMatch(/scanStartedAt: bridgeScanStartedAt/);
  });

  test('applyBridge itself persists every scan\'s candidates — manual admin applies included (codex P1 r2)', () => {
    const fs2 = require('fs');
    const bridgeSrc = fs2.readFileSync(path.join(__dirname, '../services/ads/google-call-bridge.js'), 'utf8');
    const apply = bridgeSrc.split('async function applyBridge')[1].split('\nfunction isBridgeTargetNumber')[0];
    // The complete qualifying set, preview fallback included, recorded
    // before the return — a 31–90-day manual scan's candidates would
    // otherwise evaporate before the next organic fallback.
    expect(apply).toMatch(/skipReason === 'ambiguous'/);
    expect(apply).toMatch(/m\.ambiguousCandidates \|\| \[\]/);
    expect(apply).toMatch(/await recordAmbiguousBridgeCalls\(ambiguousCandidates\)/);
    expect(apply).toMatch(/ambiguousCandidateCallIds:/);
  });
});

describe('migration (source pins)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../models/migrations/20260811000001_bridge_ambiguous_calls.js'),
    'utf8',
  );
  const leadsSrc = fs.readFileSync(
    path.join(__dirname, '../models/migrations/20260811000002_bridge_ambiguous_call_leads.js'),
    'utf8',
  );

  test('one row per call, cascading with the call, with an open-rows partial index', () => {
    expect(src).toMatch(/t\.uuid\('call_log_id'\)\.primary\(\)\.references\('id'\)\.inTable\('call_log'\)\.onDelete\('CASCADE'\)/);
    expect(src).toMatch(/WHERE resolved_at IS NULL/);
    // House style: idempotent in both directions.
    expect(src).toMatch(/hasTable\('bridge_ambiguous_calls'\)/);
  });

  test('the phone-linkage snapshot cascades with BOTH parents and keys one association once (audit P1 r3)', () => {
    expect(leadsSrc).toMatch(/references\('call_log_id'\)\.inTable\('bridge_ambiguous_calls'\)\.onDelete\('CASCADE'\)/);
    expect(leadsSrc).toMatch(/references\('id'\)\.inTable\('leads'\)\.onDelete\('CASCADE'\)/);
    expect(leadsSrc).toMatch(/t\.primary\(\['call_log_id', 'lead_id'\]\)/);
    expect(leadsSrc).toMatch(/hasTable\('bridge_ambiguous_call_leads'\)/);
  });
});
