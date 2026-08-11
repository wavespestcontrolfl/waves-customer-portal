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
// The bridge target must be a known synthetic number so the snapshot
// retire arm's bridge-source discovery can qualify fixtures (no real
// numbers in fixtures — PII rule).
jest.mock('../config/twilio-numbers', () => ({
  locations: { bradenton: { number: '+19415550100' } },
}));
// The reopen reconciliation retires through the shared history-preserving
// primitives — pin the delegation, not a re-implementation.
const mockRetire = jest.fn(async () => 1);
const mockRetireRow = jest.fn(async () => 1);
jest.mock('../services/ads/call-attribution', () => ({
  retireCallAttributionRow: (...a) => mockRetire(...a),
  retireRowPreservingHistory: (...a) => mockRetireRow(...a),
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
    const lockedRead = builders.find(
      (b) => b._table === 'bridge_ambiguous_calls'
        && b._wheres.some(([m]) => m === 'forUpdate'),
    );
    expect(lockedRead).toBeTruthy();
    // EVERY existing row for the batch is locked — open ones included
    // (audit P1 r5): a resolved-only filter left open rows unlocked, so a
    // concurrent resolver could resolve one mid-transaction and the
    // silent re-open never retired the interim organic row. The resolved
    // subset is derived from the locked read, not a second filter.
    expect(lockedRead._wheres).toContainEqual(['whereIn', 'call_log_id', ['call-1']]);
    expect(lockedRead._wheres.some(([m, col]) => m === 'whereNotNull' && col === 'resolved_at')).toBe(false);
    expect(lockedRead._wheres).toContainEqual(['select', 'call_log_id', 'resolved_at', 'resolve_reason']);
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
    // TEMPORALLY BOUNDED (audit P1 r4) by the last pass's ACTUAL evidence
    // (codex GH r3+r4+r5 + audit r10): processing_started_at (stamped by
    // every linking pass, preserved through finalization) plus the
    // processor's 10-minute stale-pass allowance; the created_at +
    // retry-window arm is a FALLBACK for pre-column rows only — inside a
    // GREATEST the seven-day term dominated every normally-processed call
    // and re-widened the window the stamp makes precise.
    expect(snap[0]).toMatch(/l\.created_at < COALESCE\(cl\.processing_started_at \+ interval '10 minutes', cl\.created_at \+ make_interval\(secs => \?\)\)/);
    expect(snap[0]).not.toMatch(/GREATEST/);
    expect(snap[1]).toEqual([7 * 24 * 60 * 60, 'call-1', 'call-2']);
  });

  test('a repeat REOPENS a rescan_clear resolution — but BRIDGED resolutions are STICKY (codex P1 GH r3)', async () => {
    // The paid claim on the call row is durable positive evidence; an
    // already-bridged call scoring ambiguously against a DIFFERENT google
    // call must not reopen (and retire its valid paid attribution).
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0].patch.last_seen_at).toBeTruthy();
    // The merge clears resolution ONLY for non-bridged records (raw CASE
    // keyed on the EXISTING row's resolve_reason).
    expect(String(mergeCalls[0].patch.resolved_at)).toMatch(/CASE WHEN bridge_ambiguous_calls\.resolve_reason = 'bridged' THEN bridge_ambiguous_calls\.resolved_at ELSE NULL END/);
    expect(String(mergeCalls[0].patch.resolve_reason)).toMatch(/CASE WHEN bridge_ambiguous_calls\.resolve_reason = 'bridged' THEN bridge_ambiguous_calls\.resolve_reason ELSE NULL END/);
  });

  test('a BRIDGED-resolved record never enters the retirement loop (codex P1 GH r3)', async () => {
    listQueueByTable.bridge_ambiguous_calls = [[
      { call_log_id: 'call-1', resolved_at: '2026-08-10T09:00:00Z', resolve_reason: 'bridged' },
    ]];
    // Even with a provenanced row present, nothing is retired — the row IS
    // the call's valid paid attribution.
    listQueueByTable.ad_service_attribution = [[{ lead_id: 'lead-9' }]];
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mockRetire).not.toHaveBeenCalled();
    expect(mockRetireRow).not.toHaveBeenCalled();
  });

  test('a FIRST-SIGHTED call that is already BRIDGED is never a retirement target (codex P1 GH r4)', async () => {
    // Record-level stickiness only protects calls that HAVE a record; an
    // already-bridged call first sighted as an ambiguous candidate has
    // none, and retiring its provenanced row would destroy the valid paid
    // attribution nothing recreates. The live paid claim on the call row
    // itself is the guard.
    listQueueByTable.bridge_ambiguous_calls = [[]]; // first sighting
    listQueueByTable.call_log = [[{ id: 'call-1' }]]; // carries google_ads_call_resource_name
    listQueueByTable.ad_service_attribution = [[{ lead_id: 'lead-9' }]];
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mockRetire).not.toHaveBeenCalled();
    expect(mockRetireRow).not.toHaveBeenCalled();
    // The guard read is the live paid-claim predicate on the call rows.
    const guardRead = builders.find((b) => b._table === 'call_log'
      && b._wheres.some(([m, col]) => m === 'whereNotNull' && col === 'google_ads_call_resource_name'));
    expect(guardRead).toBeTruthy();
    expect(guardRead._wheres).toContainEqual(['whereIn', 'id', ['call-1']]);
  });

  test('a REOPEN retires the attribution rows written while the hold was lifted (codex P1 r2)', async () => {
    // rescan_clear → same-tick organic write → ambiguity returns: the
    // re-armed hold alone cannot repair the row (recordCallPpcAttribution
    // dedupes by lead), so the reopen retires the interim rows through the
    // shared history-preserving primitive — in the SAME transaction as the
    // reopen upsert, so a crash cannot strand the interim row (audit P1 r3).
    listQueueByTable.bridge_ambiguous_calls = [[
      { call_log_id: 'call-1', resolved_at: '2026-08-10T09:00:00Z', resolve_reason: 'rescan_clear' },
    ]];
    listQueueByTable.ad_service_attribution = [[{ lead_id: 'lead-9' }]];
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mockRetire).toHaveBeenCalledTimes(1);
    // First arg is the transaction handle the reopen upsert used.
    expect(mockRetire.mock.calls[0][0]).toBe(mockDb);
    expect(mockRetire.mock.calls[0][1]).toBe('call-1');
    expect(mockRetire.mock.calls[0][2]).toBe('lead-9');
  });

  test('a PHONE-only reopen retires the interim row by WRITER MARKER (audit r6 → codex GH r7/r8 → marker)', async () => {
    // A phone-linked lead's interim row does not carry this call's
    // provenance (the resolver has no phone arm; a reused lead's original
    // sid gets borrowed instead), and every reconstruction of "which
    // writer created this row" left a corner where another writer's
    // legitimate row matched. The sweep stamps attribution_basis on its
    // inserts; marker + snapshotted lead + born-after-resolution is exact.
    listQueueByTable.bridge_ambiguous_calls = [[
      { call_log_id: 'call-1', resolved_at: '2026-08-10T09:00:00Z', resolve_reason: 'rescan_clear' },
    ]];
    listQueueByTable.ad_service_attribution = [[]]; // no exact-provenance rows
    listQueueByTable.bridge_ambiguous_call_leads = [[{ lead_id: 'lead-7' }]];
    listQueueByTable.leads = [[{ id: 'lead-7' }]]; // the lead lock read
    listQueueByTable['ad_service_attribution as asa'] = [[{ id: 'row-42' }]];
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mockRetire).not.toHaveBeenCalled(); // nothing exact-provenanced
    expect(mockRetireRow).toHaveBeenCalledTimes(1);
    expect(mockRetireRow.mock.calls[0][0]).toBe(mockDb); // same transaction
    expect(mockRetireRow.mock.calls[0][1]).toBe('row-42');
    const asaRead = builders.find((b) => b._table === 'ad_service_attribution as asa');
    expect(asaRead._wheres).toContainEqual(['whereIn', 'asa.lead_id', ['lead-7']]);
    expect(asaRead._wheres).toContainEqual(['where', 'asa.attribution_basis', 'bridge_unclaimed_sweep']);
    expect(asaRead._wheres).toContainEqual(['where', 'asa.created_at', '>', '2026-08-10T09:00:00Z']);
    // Repo lock order: the snapshot leads are locked before the rows are judged.
    const leadLock = builders.find((b) => b._table === 'leads'
      && b._wheres.some(([m]) => m === 'forUpdate'));
    expect(leadLock).toBeTruthy();
    expect(leadLock._wheres).toContainEqual(['whereIn', 'id', ['lead-7']]);
    // Writer side: the sweep self-identifies, and the marker is
    // INSERT-only in the shared recorder.
    const fs3 = require('fs');
    const path3 = require('path');
    const ca = fs3.readFileSync(path3.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    expect(ca).toMatch(/attributionBasis: 'bridge_unclaimed_sweep'/);
    expect(ca).toMatch(/attribution_basis: attributionBasis/);
    // Never patched onto existing rows — only the insert carries it.
    const patchBlock = ca.split('const patch = {}')[1].split('await dbc(\'ad_service_attribution\').insert')[0];
    expect(patchBlock).not.toMatch(/attribution_basis/);
  });

  test('an OPEN row (locked but never resolved) retires nothing — no interim write can exist under a live hold', async () => {
    listQueueByTable.bridge_ambiguous_calls = [[
      { call_log_id: 'call-1', resolved_at: null }, // existing, still OPEN
    ]];
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mockRetire).not.toHaveBeenCalled();
  });

  test('a FIRST sighting reconciles provenanced rows — late-discovered ambiguity undoes the earlier organic write (codex P1 GH r3)', async () => {
    // A 31–90-day manual scan can discover ambiguous paid evidence AFTER
    // the seven-day fallback already wrote the call's provenanced organic
    // row; per-lead dedupe would block the eventual paid attribution
    // forever if the first sighting did not retire it.
    listQueueByTable.bridge_ambiguous_calls = [[]]; // nothing existing = first sighting
    listQueueByTable.ad_service_attribution = [[{ lead_id: 'lead-9' }]];
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mockRetire).toHaveBeenCalledTimes(1);
    expect(mockRetire.mock.calls[0][1]).toBe('call-1');
    expect(mockRetire.mock.calls[0][2]).toBe('lead-9');
    // The SNAPSHOT arm stays reopen-only: without the born-after-resolution
    // anchor a NULL-provenance match could be an untouchable legacy row.
    expect(mockRetireRow).not.toHaveBeenCalled();
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
    });
  });

  test('the held-LEAD side is deliberately NOT a returned list — the sweep applies correlated arms instead (codex GH r6 + audit r13)', async () => {
    // A lead list captured before the sweep is stale by the time its
    // under-lock recheck runs (concurrent age-unlimited force-reprocess
    // can phone-link a new lead in the gap), so the hold lives in TWO
    // correlated arms inside applyAmbiguityExclusions: the persisted
    // snapshot rows of open records, and the snapshot predicate itself
    // evaluated live — both fresh in the recheck statement.
    listQueueByTable.bridge_ambiguous_calls = [[
      { call_log_id: 'call-1', twilio_call_sid: 'CA1' },
    ]];
    const res = await openAmbiguousCallExclusions();
    expect(res.excludeLeadIds).toBeUndefined();
    const fs2 = require('fs');
    const path2 = require('path');
    const ca = fs2.readFileSync(path2.join(__dirname, '../services/ads/call-attribution.js'), 'utf8');
    const arms = ca.split('const applyAmbiguityExclusions')[1];
    expect(arms).toMatch(/function persistedPhoneHold\(\)/);
    expect(arms).toMatch(/from\('bridge_ambiguous_call_leads as bal'\)/);
    expect(arms).toMatch(/whereNull\('bac\.resolved_at'\)/);
    expect(arms).toMatch(/bal\.lead_id = l\.id/);
    expect(arms).toMatch(/function livePhoneHold\(\)/);
    expect(arms).toMatch(/clh\.from_phone/);
    expect(arms).toMatch(/COALESCE\(clh\.processing_started_at \+ interval '10 minutes', clh\.created_at \+ make_interval\(secs => \?\)\)/);
    // Never an array-based lead arm.
    expect(arms).not.toMatch(/whereNotIn\('l\.id'/);
  });
});

describe('scheduler wiring (source pins)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
  const block = src.split("runExclusive('google-call-bridge-organic'")[1].slice(0, 14000);

  test('the organic exclusions come from ALL OPEN persisted records, not the day\'s scan set', () => {
    expect(block).toMatch(/\.\.\.\(await require\('\.\/ads\/google-call-bridge'\)\.openAmbiguousCallExclusions\(\)\)/);
    // Recording AND resolution live in applyBridge (every apply path,
    // manual included — codex P1s, r2+r3 GH rounds: a 31–90-day manual
    // scan reaches calls the ~29-day cron window never re-sees, for both
    // purposes). The cron ONLY reads.
    expect(block).not.toMatch(/recordAmbiguousBridgeCalls/);
    expect(block).not.toMatch(/resolveAmbiguousBridgeCalls/);
    // ...and the read sits on EVERY sweep path, AFTER the unconfigured
    // branch — an opt-in install with pre-teardown records must still hold
    // their leads.
    const open = block.indexOf('openAmbiguousCallExclusions');
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
    // The held-lead hold is correlated arms, never an array (audit r13).
    expect(sweep).toMatch(/function persistedPhoneHold\(\)/);
    expect(sweep).toMatch(/function livePhoneHold\(\)/);
  });

  test('applyBridge itself persists AND resolves every scan\'s ambiguities — manual admin applies included (codex P1s r2+r3)', () => {
    const fs2 = require('fs');
    const bridgeSrc = fs2.readFileSync(path.join(__dirname, '../services/ads/google-call-bridge.js'), 'utf8');
    const apply = bridgeSrc.split('async function applyBridge')[1].split('\nfunction isBridgeTargetNumber')[0];
    // The complete qualifying set, preview fallback included, recorded
    // before the return — a 31–90-day manual scan's candidates would
    // otherwise evaporate before the next organic fallback.
    expect(apply).toMatch(/skipReason === 'ambiguous'/);
    expect(apply).toMatch(/m\.ambiguousCandidates \|\| \[\]/);
    expect(apply).toMatch(/await recordAmbiguousBridgeCalls\(ambiguousCandidates\)/);
    // Resolution rides the same path with the scan's OWN trust, window,
    // and DB-clock start (a cron-only resolver left manual-scan records
    // permanently unclearable — its window never reaches them).
    expect(apply).toMatch(/SELECT now\(\) AS db_now/);
    expect(apply.indexOf('scanStartedAt =')).toBeLessThan(apply.indexOf('await previewBridge(options)'));
    expect(apply).toMatch(/await resolveAmbiguousBridgeCalls\(\{/);
    expect(apply).toMatch(/ambiguousCallIds: ambiguousCandidateCallIds/);
    expect(apply).toMatch(/\(scanDays - 1\) \* 24 \* 60 \* 60 \* 1000/);
    expect(apply).toMatch(/scanStartedAt,/);
    // configured is part of trust (codex P2 GH r4): an unconfigured apply
    // runs no scan, and absence from a scan that never ran clears nothing.
    expect(apply).toMatch(/rescanTrusted: !!preview\.configured && !preview\.scanFailed && !capHit && !writeFailed/);
    // Each fetch compares against ITS OWN cap (codex P1 GH r5): CRM rows
    // against the fixed CRM_FETCH_LIMIT, never the caller's Google limit —
    // a healthy manual apply at the default limit read 200–499 CRM calls
    // as capped and could never clear its old records.
    expect(apply).toMatch(/\(preview\.summary\?\.googleCalls \|\| 0\) >= scanLimit/);
    expect(apply).toMatch(/\(preview\.summary\?\.crmMainLineCalls \|\| 0\) >= CRM_FETCH_LIMIT/);
    const bridgeSrc2 = fs2.readFileSync(path.join(__dirname, '../services/ads/google-call-bridge.js'), 'utf8');
    expect(bridgeSrc2).toMatch(/const CRM_FETCH_LIMIT = 500/);
    expect(bridgeSrc2).toMatch(/\.limit\(CRM_FETCH_LIMIT\)/);
  });
});

describe('processing_started_at durability (source pins)', () => {
  const fs = require('fs');
  const path = require('path');

  test('finalization never clears the snapshot bound\'s anchor (audit P1 r9)', () => {
    const proc = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    // A finalized old force-reprocessed call must keep its last-pass
    // timestamp: the phone snapshot's COALESCE falls back to
    // created_at + the retry window otherwise, dropping the lead the late
    // pass actually linked — and once the call ages out of the scan
    // window, no arm protects that lead from the irreversible organic
    // label. In-flight state is processing_token/status; every
    // processing_started_at reader COALESCEs behind a status guard.
    expect(proc).not.toMatch(/processing_started_at: null/);
    // Both claim paths (sweep and force-reprocess) stamp it.
    expect((proc.match(/processing_started_at: new Date\(\)/g) || []).length).toBeGreaterThanOrEqual(2);
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

  test('the writer-marker column is nullable, guarded, and reversible (audit r16)', () => {
    const basisSrc = fs.readFileSync(
      path.join(__dirname, '../models/migrations/20260811000003_ad_service_attribution_basis.js'),
      'utf8',
    );
    expect(basisSrc).toMatch(/hasColumn\('ad_service_attribution', 'attribution_basis'\)/);
    expect(basisSrc).toMatch(/t\.string\('attribution_basis', 40\)/);
    expect(basisSrc).toMatch(/dropColumn\('attribution_basis'\)/);
  });
});
