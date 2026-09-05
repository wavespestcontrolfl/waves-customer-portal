/**
 * Agent-control hub read (S2d). Invariants: ET windows and bucket keys;
 * lane rows fold ledger + policy + external reasons deterministically
 * (status rule, rates, deltas, sparkline zero-fill); areas roll lanes up;
 * external sources are gated and isolated; the routes 404 while
 * GATE_AGENT_CONTROL_READ is off, 400 on a bad param, and the hub probe
 * reports the ledger phase. No real DB: the knex stub resolves fixture rows.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const fixtures = {};
jest.mock('../models/db', () => {
  const make = (table) => {
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          const rows = fixtures[table];
          return (resolve, reject) => (rows instanceof Error ? reject(rows) : resolve(rows || []));
        }
        return () => chain;
      },
    });
    return chain;
  };
  const db = jest.fn((table) => make(table));
  db.raw = jest.fn((sql) => ({ sql }));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockOpsQueue = jest.fn();
jest.mock('../services/ops-queue', () => ({ getOpsQueue: (...a) => mockOpsQueue(...a) }));
const mockActivity = jest.fn();
jest.mock('../services/agent-activity', () => ({ getActivity: (...a) => mockActivity(...a) }));
jest.mock('../services/llm-dispatch-metrics', () => ({ RETENTION_DAYS: 30 }));

const hubRead = require('../services/agent-control/hub-read');
const modelSwitchboard = require('../services/model-switchboard');

// 2026-09-04 17:30 ET (EDT, UTC-4) — a fixed clock so buckets are stable.
const NOW = new Date('2026-09-04T21:30:00Z');
const GATES = ['GATE_AGENT_CONTROL_READ', 'GATE_ADMIN_OPS_QUEUE', 'GATE_AGENT_ACTIVITY', 'GATE_LLM_CALL_LEDGER', 'GATE_LLM_DISPATCH_METRICS'];
const saved = {};

beforeAll(() => { for (const g of GATES) saved[g] = process.env[g]; });
afterAll(() => { for (const g of GATES) { if (saved[g] === undefined) delete process.env[g]; else process.env[g] = saved[g]; } });
beforeEach(() => {
  for (const g of GATES) delete process.env[g];
  // chain rows (fallback rate) are written under this gate; on by default here
  process.env.GATE_LLM_DISPATCH_METRICS = 'true';
  for (const k of Object.keys(fixtures)) delete fixtures[k];
  mockOpsQueue.mockReset();
  mockActivity.mockReset();
});

const lanesFixture = () => modelSwitchboard.getSwitchboard().lanes;

describe('resolveWindow', () => {
  test('today = ET midnight → now, hourly buckets up to the current ET hour', () => {
    const w = hubRead.resolveWindow('today', NOW);
    expect(w.from.toISOString()).toBe('2026-09-04T04:00:00.000Z');
    expect(w.to).toBe(NOW);
    expect(w.unit).toBe('hour');
    expect(w.buckets[0]).toBe('2026-09-04T00');
    expect(w.buckets.at(-1)).toBe('2026-09-04T17');
    expect(w.buckets).toHaveLength(18);
  });

  test('7d / 30d = the last N ET days including today, daily buckets, prior = the same ET shape N days back', () => {
    const w = hubRead.resolveWindow('7d', NOW);
    expect(w.from.toISOString()).toBe('2026-08-29T04:00:00.000Z');
    expect(w.buckets).toEqual(['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
    // 6 full days + the same 17:30 ET portion of the 7th, ending before this window starts
    expect(w.prior.from.toISOString()).toBe('2026-08-22T04:00:00.000Z');
    expect(w.prior.to.toISOString()).toBe('2026-08-28T21:30:00.000Z');
    const today = hubRead.resolveWindow('today', NOW);
    expect(today.prior).toEqual({ from: new Date('2026-09-03T04:00:00.000Z'), to: new Date('2026-09-03T21:30:00.000Z') });
    expect(w.priorAvailable).toBe(true);
    const month = hubRead.resolveWindow('30d', NOW);
    expect(month.buckets).toHaveLength(30);
    expect(month.buckets[0]).toBe('2026-08-06');
    // its prior window starts 59 days back — past the 30-day ledger prune
    expect(month.priorAvailable).toBe(false);
  });

  test('the prior window keeps its ET wall clock across a DST change', () => {
    // Mon 2026-11-02 10:00 EST (UTC-5); the fall-back was Sun 11-01.
    const w = hubRead.resolveWindow('7d', new Date('2026-11-02T15:00:00Z'));
    expect(w.from.toISOString()).toBe('2026-10-27T04:00:00.000Z'); // 00:00 EDT
    // prior.to = Mon 10-26 10:00 EDT (UTC-4) — a millisecond shift would land at 13:00 EDT
    expect(w.prior.to.toISOString()).toBe('2026-10-26T14:00:00.000Z');
    expect(w.prior.from.toISOString()).toBe('2026-10-20T04:00:00.000Z');
    expect(w.buckets).toHaveLength(7);
  });

  test('the prior window keeps its wall clock the morning after spring-forward', () => {
    // Mon 2026-03-09 04:30 EDT; yesterday 04:30 was EDT too (the jump was 02:00 Sunday)
    const w = hubRead.resolveWindow('today', new Date('2026-03-09T08:30:00Z'));
    expect(w.prior.to.toISOString()).toBe('2026-03-08T08:30:00.000Z');
    expect(w.prior.from.toISOString()).toBe('2026-03-08T05:00:00.000Z'); // Sunday 00:00 was still EST
  });

  test('unknown preset → null (inherited names included); default is 7d', () => {
    expect(hubRead.resolveWindow('yesterday', NOW)).toBeNull();
    expect(hubRead.resolveWindow('constructor', NOW)).toBeNull();
    expect(hubRead.resolveWindow('__proto__', NOW)).toBeNull();
    expect(hubRead.resolveWindow(undefined, NOW).key).toBe('7d');
  });
});

describe('buildLanes', () => {
  const window = hubRead.resolveWindow('7d', NOW);
  const ledger = {
    current: [
      { lane_id: 'sms_draft', calls: 6, ok_calls: 4, input_tokens: '600', cached_input_tokens: '0', cache_write_tokens: '33', output_tokens: '120', usage_unknown_rows: 1, reasoning_tokens: '0', p50_latency_ms: 700, p95_latency_ms: 9000, last_active_at: '2026-09-04T21:00:00.000Z' },
      { lane_id: 'report_copy', calls: 1, ok_calls: 1, input_tokens: '10', cached_input_tokens: '0', output_tokens: '5', reasoning_tokens: '0', p50_latency_ms: 300, p95_latency_ms: 300, last_active_at: '2026-09-02T12:00:00.000Z' },
      { lane_id: 'email_classify', calls: 3, ok_calls: 0, input_tokens: '0', cached_input_tokens: '0', output_tokens: '0', reasoning_tokens: '0', p50_latency_ms: null, p95_latency_ms: null, last_active_at: '2026-09-04T20:00:00.000Z' },
    ],
    prior: [{ lane_id: 'sms_draft', calls: 1, ok_calls: 1 }],
    // The trailing hour is its own read (not clipped by the window): sms_draft
    // trips the rule; email_classify is below the min-calls floor.
    recent: [
      { lane_id: 'sms_draft', recent_calls: 6, recent_errors: 2 },
      { lane_id: 'email_classify', recent_calls: 3, recent_errors: 3 },
    ],
    // sms_tone: many chains, no fallback — the area rate must be weighted
    // (1 / 102), not the mean of the two lane rates (0.25).
    chains: [{ lane_id: 'sms_draft', chains: 2, fallbacks: 1 }, { lane_id: 'sms_tone', chains: 100, fallbacks: 0 }],
    areaLatency: [{ area: 'sms', p95_latency_ms: 8500 }],
    buckets: [
      { lane_id: 'sms_draft', bucket: '2026-09-04', calls: 6, errors: 2 },
      { lane_id: 'report_copy', bucket: '2026-09-02', calls: 1, errors: 0 },
    ],
  };

  test('folds ledger rows, policy and the status rule onto every switchboard lane', () => {
    const rows = hubRead.buildLanes({ lanes: lanesFixture(), window, ledger });
    expect(rows).toHaveLength(modelSwitchboard.LANES.length);
    const sms = rows.find((l) => l.id === 'sms_draft');
    expect(sms).toMatchObject({
      area: 'sms', status: 'attention', calls: 6, okRate: 0.667, fallbackRate: 0.5, p50LatencyMs: 700, p95LatencyMs: 9000,
      tokens: { input: 600, cachedInput: 0, cacheWrite: 33, output: 120, reasoning: 0, unknownRows: 1 },
      deltaVsPrior: { calls: 5, okRate: -0.333 },
      attention: { p0: 0, p1: 1, p2: 0, p3: 0 },
      sideEffectClass: 'customer_visible', riskTier: 2, maturity: 'M3', ledger: 'call', unrecordableReason: null,
      estCostUsd: null, runs: null, cost: null, verification: null,
      lastActiveAt: '2026-09-04T21:00:00.000Z',
    });
    expect(sms.attentionReasons).toEqual([{ priority: 'P1', kind: 'error_rate', detail: '2 of 6 calls failed in the last hour' }]);
    expect(sms.modelNow).toEqual(expect.any(String));
    expect(sms.spark).toHaveLength(7);
    expect(sms.spark.at(-1)).toEqual({ t: '2026-09-04', calls: 6, errors: 2 });
    expect(sms.spark[0]).toEqual({ t: '2026-08-29', calls: 0, errors: 0 });

    const report = rows.find((l) => l.id === 'report_copy');
    expect(report).toMatchObject({ status: 'active', calls: 1, okRate: 1, fallbackRate: null, deltaVsPrior: { calls: 1, okRate: null } });
    expect(report.spark.find((b) => b.t === '2026-09-02')).toEqual({ t: '2026-09-02', calls: 1, errors: 0 });

    expect(rows.find((l) => l.id === 'email_classify').status).toBe('active');

    const idle = rows.find((l) => l.id === 'estimate_followup');
    expect(idle).toMatchObject({ status: 'idle', calls: 0, okRate: null, p95LatencyMs: null, lastActiveAt: null, deltaVsPrior: { calls: 0, okRate: null } });
    expect(idle.spark.every((b) => b.calls === 0)).toBe(true);
  });

  test('an unrecordable lane carries its reason; extreme_tier has no call site', () => {
    const rows = hubRead.buildLanes({ lanes: lanesFixture(), window, ledger: { current: [], prior: [], chains: [], buckets: [] } });
    const t = rows.find((l) => l.id === 'transcription');
    expect(t.ledger).toBe('unrecordable');
    expect(t.unrecordableReason).toBe('audio');
    expect(rows.find((l) => l.id === 'extreme_tier').unrecordableReason).toBe('no_call_site');
    expect(rows.find((l) => l.id === 'wdo_project_brief').ledger).toBe('call');
  });

  test('external reasons attach to their lane and count by priority', () => {
    const reasons = [
      { laneId: 'blog_draft', priority: 'P1', kind: 'queue_failed', detail: '2 failed in Content engine parks' },
      { laneId: 'blog_draft', priority: 'P2', kind: 'activity_blocked', detail: '1 blocked run in the Activity feed' },
    ];
    const rows = hubRead.buildLanes({ lanes: lanesFixture(), window, ledger: { current: [], prior: [], chains: [], buckets: [] }, reasons });
    const blog = rows.find((l) => l.id === 'blog_draft');
    expect(blog.status).toBe('attention');
    expect(blog.attention).toEqual({ p0: 0, p1: 1, p2: 1, p3: 0 });
    expect(blog.attentionReasons.map((r) => r.kind)).toEqual(['queue_failed', 'activity_blocked']);
  });

  test('areas roll up from raw counts: weighted rates, the area percentile, summed attention and sparks', () => {
    const laneRows = hubRead.buildLanes({ lanes: lanesFixture(), window, ledger });
    const areas = hubRead.buildAreas({ areas: modelSwitchboard.AREAS, laneRows, window, ledger });
    expect(areas.map((a) => a.key)).toEqual(modelSwitchboard.AREAS.map((a) => a.key));
    const sms = areas.find((a) => a.key === 'sms');
    expect(sms).toMatchObject({ calls: 6, okRate: 0.667, fallbackRate: 0.01, p95LatencyMs: 8500, attention: { p0: 0, p1: 1, p2: 0, p3: 0 }, deltaVsPrior: { calls: 5 }, estCostUsd: null, tokensUnknownRows: 1 });
    expect(sms.lanes).toBe(laneRows.filter((l) => l.area === 'sms').length);
    expect(sms.spark.at(-1)).toEqual({ t: '2026-09-04', calls: 6, errors: 2 });
    const email = areas.find((a) => a.key === 'email');
    expect(email).toMatchObject({ calls: 3, okRate: 0, p95LatencyMs: null, fallbackRate: null });
    expect(areas.find((a) => a.key === 'voice')).toMatchObject({ calls: 0, okRate: null, spark: window.buckets.map((t) => ({ t, calls: 0, errors: 0 })) });
  });
});

describe('readLanes / readAreas', () => {
  test('validates window, status and area', async () => {
    await expect(hubRead.readLanes({ window: '90d', now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(hubRead.readLanes({ window: 'constructor', now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(hubRead.readLanes({ status: 'broken', now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(hubRead.readLanes({ area: 'nope', now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(hubRead.readAreas({ window: 'x', now: NOW })).rejects.toMatchObject({ status: 400 });
  });

  test('scopes by area, filters by status, counts before filtering, sorts attention → active → idle', async () => {
    fixtures.llm_dispatch_log = [
      { lane_id: 'sms_draft', calls: 6, ok_calls: 1, recent_calls: 6, recent_errors: 5, chains: 0, fallbacks: 0, bucket: '2026-09-04', errors: 5 },
      { lane_id: 'sms_tone', calls: 2, ok_calls: 2, recent_calls: 0, recent_errors: 0, chains: 0, fallbacks: 0, bucket: '2026-09-04', errors: 0 },
    ];
    const out = await hubRead.readLanes({ area: 'sms', now: NOW });
    expect(out.phases).toEqual({ ledger: false, runs: false, cost: false, verification: false });
    expect(out.basis).toMatchObject({ source: 'llm_dispatch_log', rowKinds: ['call', 'session_turn'], workloads: ['live'], sessions: 'per_turn', ledgerRecording: false, window: { key: '7d', unit: 'day' } });
    expect(out.counts).toEqual({ all: out.lanes.length, active: 1, attention: 1, idle: out.lanes.length - 2 });
    expect(out.lanes.every((l) => l.area === 'sms')).toBe(true);
    expect(out.lanes.slice(0, 2).map((l) => [l.id, l.status])).toEqual([['sms_draft', 'attention'], ['sms_tone', 'active']]);

    const only = await hubRead.readLanes({ area: 'sms', status: 'attention', now: NOW });
    expect(only.counts).toEqual(out.counts);
    expect(only.lanes.map((l) => l.id)).toEqual(['sms_draft']);
    expect(mockOpsQueue).not.toHaveBeenCalled();
    expect(mockActivity).not.toHaveBeenCalled();
  });

  test('ops-queue and Activity reasons arrive only behind their gates and never break the read', async () => {
    process.env.GATE_ADMIN_OPS_QUEUE = 'true';
    process.env.GATE_AGENT_ACTIVITY = 'true';
    mockOpsQueue.mockResolvedValue({ lanes: [
      { key: 'calls', label: 'Call processing', failed: 2 },
      { key: 'reports', label: 'Service report delivery', failed: 4 }, // business rows: not a lane failure
      { key: 'content', label: 'Content engine parks', failed: 0 },
    ] });
    mockActivity.mockResolvedValue({ available: true, items: [
      { kind: 'content_run', status: 'failed' },
      { kind: 'content_run', status: 'blocked' },
      { kind: 'content_run', status: 'blocked' },
      { kind: 'sms_draft', status: 'awaiting_review' },
      { kind: 'job', status: 'failed' },
    ] });
    const out = await hubRead.readLanes({ now: NOW });
    expect(mockActivity).toHaveBeenCalledWith({ windowHours: 24 });
    const byId = Object.fromEntries(out.lanes.map((l) => [l.id, l]));
    expect(byId.call_extraction.attentionReasons).toEqual([{ priority: 'P1', kind: 'queue_failed', detail: '2 failed in Call processing' }]);
    expect(byId.blog_draft.attentionReasons).toEqual([
      { priority: 'P1', kind: 'activity_failed', detail: '1 failed run in the Activity feed' },
      { priority: 'P2', kind: 'activity_blocked', detail: '2 blocked runs in the Activity feed' },
    ]);
    expect(byId.report_copy.status).toBe('idle');
    expect(byId.sms_draft.status).toBe('idle');
    expect(out.counts.attention).toBe(2);

    mockOpsQueue.mockRejectedValue(new Error('queue exploded'));
    mockActivity.mockResolvedValue({ available: false, items: [] });
    const degraded = await hubRead.readLanes({ window: '30d', now: NOW });
    expect(mockActivity).toHaveBeenLastCalledWith({ windowHours: 168 });
    expect(degraded.counts.attention).toBe(0);
    // 30d: no prior window survives the prune → deltas null, not "minus nearly zero"
    expect(degraded.basis.priorAvailable).toBe(false);
    expect(degraded.lanes.every((l) => l.deltaVsPrior === null)).toBe(true);
  });

  test('a ledger read failure surfaces as an error (the route 500s), never a silent empty hub', async () => {
    fixtures.llm_dispatch_log = new Error('relation missing');
    await expect(hubRead.readAreas({ now: NOW })).rejects.toThrow('relation missing');
  });

  test('fallback rate is null everywhere while the chain recorder gate is off, and basis says so', async () => {
    delete process.env.GATE_LLM_DISPATCH_METRICS;
    fixtures.llm_dispatch_log = [{ lane_id: 'sms_draft', calls: 2, ok_calls: 2, chains: 2, fallbacks: 2, bucket: '2026-09-04', errors: 0 }];
    const out = await hubRead.readLanes({ area: 'sms', now: NOW });
    expect(out.basis.chainRecording).toBe(false);
    expect(out.lanes.find((l) => l.id === 'sms_draft').fallbackRate).toBeNull();
    const areas = await hubRead.readAreas({ now: NOW });
    expect(areas.basis.chainRecording).toBe(false);
    expect(areas.areas.find((a) => a.key === 'sms').fallbackRate).toBeNull();
  });

  test('phases + basis flip with the gates', async () => {
    process.env.GATE_AGENT_CONTROL_READ = 'true';
    process.env.GATE_LLM_CALL_LEDGER = 'true';
    const out = await hubRead.readAreas({ window: 'today', now: NOW });
    expect(out.basis.ledgerRecording).toBe(true);
    expect(out.basis.chainRecording).toBe(true);
    expect(out.window).toEqual({ from: '2026-09-04T04:00:00.000Z', to: NOW.toISOString() });
    expect(out.areas).toHaveLength(modelSwitchboard.AREAS.length);
    expect(out.areas[0].spark).toHaveLength(18);
  });
});

describe('routes', () => {
  jest.mock('../middleware/admin-auth', () => ({
    adminAuthenticate: (req, res, next) => {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const users = { admin: { id: 'admin-1', role: 'admin' }, tech: { id: 'tech-1', role: 'technician' } };
      const user = users[token];
      if (!user) return res.status(401).json({ error: 'auth' });
      req.technician = user; req.technicianId = user.id; req.techRole = user.role;
      return next();
    },
    requireTechOrAdmin: (req, res, next) => (['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'staff' })),
    requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'admin' })),
  }));

  async function withServer(fn) {
    const express = require('express');
    const router = require('../routes/admin-agents');
    const app = express();
    app.use('/api/admin/agents', router);
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    const server = app.listen(0);
    try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
  }

  test('gate off → probe says no ledger and both reads 404; gate on → admin reads, tech 403, bad param 400', async () => {
    await withServer(async (base) => {
      const admin = { headers: { Authorization: 'Bearer admin' } };
      expect((await (await fetch(`${base}/api/admin/agents/control/hub`, admin)).json()).features.ledger).toBe(false);
      expect((await fetch(`${base}/api/admin/agents/control/areas`, admin)).status).toBe(404);
      expect((await fetch(`${base}/api/admin/agents/control/lanes`, admin)).status).toBe(404);

      process.env.GATE_AGENT_CONTROL_READ = 'true';
      expect((await (await fetch(`${base}/api/admin/agents/control/hub`, admin)).json()).features.ledger).toBe(true);
      expect((await fetch(`${base}/api/admin/agents/control/lanes`, { headers: { Authorization: 'Bearer tech' } })).status).toBe(403);
      expect((await fetch(`${base}/api/admin/agents/control/lanes?window=90d`, admin)).status).toBe(400);
      expect((await fetch(`${base}/api/admin/agents/control/lanes?window=constructor`, admin)).status).toBe(400);
      expect((await fetch(`${base}/api/admin/agents/control/areas?window=90d`, admin)).status).toBe(400);

      const lanes = await fetch(`${base}/api/admin/agents/control/lanes?area=ib&status=idle&window=today`, admin);
      expect(lanes.status).toBe(200);
      const body = await lanes.json();
      expect(body.phases.ledger).toBe(true);
      expect(body.lanes.length).toBeGreaterThan(0);
      expect(body.lanes.every((l) => l.area === 'ib' && l.status === 'idle')).toBe(true);

      const areas = await fetch(`${base}/api/admin/agents/control/areas?window=30d`, admin);
      expect(areas.status).toBe(200);
      const areasBody = await areas.json();
      expect(areasBody.areas).toHaveLength(modelSwitchboard.AREAS.length);
      expect(areasBody.areas[0].deltaVsPrior).toBeNull();
    });
  });
});
