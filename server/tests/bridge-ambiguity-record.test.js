// Persisted bridge-ambiguity records (owner ruling 2026-08-11, closing the
// GH-r24 P1 on PR #3303): the day's ambiguous candidate set was the ONLY
// record of ambiguity, rebuilt from the fixed 30-day scan — the day a
// candidate aged out, the exclusion evaporated and the organic sweep
// stamped its lead with the irreversible organic label.

let listQueueByTable = {};
const insertCalls = [];
const updateCalls = [];
const mergeCalls = [];

const mockDb = jest.fn((table) => {
  const b = { _wheres: [] };
  ['join', 'where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'select', 'orderBy', 'limit'].forEach((m) => {
    b[m] = jest.fn((...a) => { b._wheres.push([m, ...a]); return b; });
  });
  b.modify = jest.fn((fn) => { fn(b); return b; });
  b.insert = jest.fn((rows) => { insertCalls.push({ table, rows }); return b; });
  b.onConflict = jest.fn(() => b);
  b.merge = jest.fn((patch) => { mergeCalls.push({ table, patch }); return b; });
  b.update = jest.fn((patch) => {
    updateCalls.push({ table, wheres: b._wheres.slice(), patch });
    return Promise.resolve(1);
  });
  b.then = (res, rej) => {
    const q = listQueueByTable[table];
    const val = (q && q.length) ? q.shift() : [];
    return Promise.resolve(val).then(res, rej);
  };
  return b;
});
mockDb.raw = jest.fn((sql) => sql);
mockDb.fn = { now: () => 'NOW()' };

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('google-ads-api', () => ({ GoogleAdsApi: jest.fn(), enums: { CampaignStatus: { ENABLED: 'ENABLED', PAUSED: 'PAUSED' } } }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'uuid-1') }));

const {
  recordAmbiguousBridgeCalls,
  resolveAmbiguousBridgeCalls,
  openAmbiguousCallExclusions,
} = require('../services/ads/google-call-bridge');

beforeEach(() => {
  jest.clearAllMocks();
  listQueueByTable = {};
  insertCalls.length = 0;
  updateCalls.length = 0;
  mergeCalls.length = 0;
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

  test('a repeat REOPENS a previously resolved record — today\'s scan supersedes an old resolution', async () => {
    await recordAmbiguousBridgeCalls([{ id: 'call-1', twilioCallSid: 'CA1' }]);
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0].patch).toMatchObject({ resolved_at: null, resolve_reason: null });
    expect(mergeCalls[0].patch.last_seen_at).toBeTruthy();
  });

  test('no valid candidates → no insert at all', async () => {
    const n = await recordAmbiguousBridgeCalls([{ twilioCallSid: 'CA-orphan' }]);
    expect(n).toBe(0);
    expect(insertCalls).toHaveLength(0);
  });
});

describe('resolveAmbiguousBridgeCalls', () => {
  test('bridged calls resolve even on an untrusted scan day — the paid claim is durable state on the call row', async () => {
    listQueueByTable['bridge_ambiguous_calls as bac'] = [[{ call_log_id: 'call-9' }]];
    const res = await resolveAmbiguousBridgeCalls({ rescanTrusted: false });
    expect(res).toEqual({ bridged: 1, rescanCleared: 0 });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch.resolve_reason).toBe('bridged');
    // Conditioned on still-open so a concurrent resolve is not overwritten.
    expect(updateCalls[0].wheres).toContainEqual(['whereNull', 'resolved_at']);
  });

  test('rescan_clear fires ONLY on a trusted scan, only for calls the window still covers, never for today\'s ambiguous set', async () => {
    listQueueByTable['bridge_ambiguous_calls as bac'] = [
      [], // no bridged rows
      [{ call_log_id: 'call-old-ambig' }], // rescan-clear candidates
    ];
    const windowStart = new Date('2026-07-13T00:00:00Z');
    const res = await resolveAmbiguousBridgeCalls({
      ambiguousCallIds: ['call-today'],
      scanWindowStart: windowStart,
      rescanTrusted: true,
    });
    expect(res).toEqual({ bridged: 0, rescanCleared: 1 });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch.resolve_reason).toBe('rescan_clear');
  });

  test('an UNTRUSTED scan never rescan-clears — absence from a degraded scan is not evidence', async () => {
    listQueueByTable['bridge_ambiguous_calls as bac'] = [[]];
    const res = await resolveAmbiguousBridgeCalls({
      ambiguousCallIds: [],
      scanWindowStart: new Date('2026-07-13T00:00:00Z'),
      rescanTrusted: false,
    });
    expect(res).toEqual({ bridged: 0, rescanCleared: 0 });
    expect(updateCalls).toHaveLength(0);
  });

  test('a missing window boundary never rescan-clears, trusted or not', async () => {
    listQueueByTable['bridge_ambiguous_calls as bac'] = [[]];
    const res = await resolveAmbiguousBridgeCalls({ rescanTrusted: true });
    expect(res).toEqual({ bridged: 0, rescanCleared: 0 });
    expect(updateCalls).toHaveLength(0);
  });
});

describe('openAmbiguousCallExclusions', () => {
  test('shapes ALL open records for the sweep — ids deduped, NULL sids dropped from the sid arm only', async () => {
    listQueueByTable.bridge_ambiguous_calls = [[
      { call_log_id: 'call-1', twilio_call_sid: 'CA1' },
      { call_log_id: 'call-2', twilio_call_sid: null }, // still excluded via the id/stamp/phone arms
    ]];
    const res = await openAmbiguousCallExclusions();
    expect(res).toEqual({
      excludeCallIds: ['call-1', 'call-2'],
      excludeCallSids: ['CA1'],
    });
  });
});

describe('scheduler wiring (source pins)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
  const block = src.split("runExclusive('google-call-bridge-organic'")[1].slice(0, 14000);

  test('the organic exclusions come from ALL OPEN persisted records, not the day\'s scan set', () => {
    expect(block).toMatch(/organicExclusions = await require\('\.\/ads\/google-call-bridge'\)\.openAmbiguousCallExclusions\(\)/);
    // The day's candidates are persisted BEFORE resolution and the read.
    const rec = block.indexOf('recordAmbiguousBridgeCalls');
    const resv = block.indexOf('resolveAmbiguousBridgeCalls');
    const open = block.indexOf('openAmbiguousCallExclusions');
    expect(rec).toBeGreaterThan(-1);
    expect(resv).toBeGreaterThan(rec);
    expect(open).toBeGreaterThan(resv);
    // ...and the read sits on EVERY sweep path, AFTER the unconfigured
    // branch — an opt-in install with pre-teardown records must still hold
    // their leads.
    expect(open).toBeGreaterThan(block.indexOf('google_ads_unconfigured'));
  });

  test('rescan_clear is gated on a TRUSTED scan and a coverage boundary with a one-day margin', () => {
    expect(block).toMatch(/rescanTrusted: !r\.scanFailed && !capHit && !writeFailed/);
    expect(block).toMatch(/\(bridgeScanDays - 1\) \* 24 \* 60 \* 60 \* 1000/);
    // One named window constant feeds BOTH the scan and the boundary — they
    // cannot drift apart.
    expect(block).toMatch(/applyBridge\(\{ days: bridgeScanDays, limit: 500 \}\)/);
  });
});

describe('migration (source pins)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../models/migrations/20260811000001_bridge_ambiguous_calls.js'),
    'utf8',
  );

  test('one row per call, cascading with the call, with an open-rows partial index', () => {
    expect(src).toMatch(/t\.uuid\('call_log_id'\)\.primary\(\)\.references\('id'\)\.inTable\('call_log'\)\.onDelete\('CASCADE'\)/);
    expect(src).toMatch(/WHERE resolved_at IS NULL/);
    // House style: idempotent in both directions.
    expect(src).toMatch(/hasTable\('bridge_ambiguous_calls'\)/);
  });
});
