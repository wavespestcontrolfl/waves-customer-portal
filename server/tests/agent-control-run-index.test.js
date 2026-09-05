/**
 * Run index (S3): the legacy adapters project their ledgers onto the
 * canonical shape deterministically; listRuns merges canonical rows first
 * and dedupes mirrored legacy rows, derives health, buckets status, pages
 * with a keyset cursor and rejects bad params with 400; getRun folds a
 * legacy row with its canonical mirror; the routes 404 while the read
 * gate is off. No real DB: the adapters are mocked at the module seam
 * and fromRow is tested pure.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fixtures = {};
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
  db.__fixtures = fixtures;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm-dispatch-metrics', () => ({ RETENTION_DAYS: 30 }));

const fixtures = require('../models/db').__fixtures;
const { canonicalRun } = require('../services/agent-control/sources/shape');
const autonomousRuns = require('../services/agent-control/sources/autonomous-runs');
const messageDrafts = require('../services/agent-control/sources/message-drafts');
const agentDecisions = require('../services/agent-control/sources/agent-decisions');
const callLog = require('../services/agent-control/sources/call-log');
const jobHealth = require('../services/agent-control/sources/job-health');
const managedSessions = require('../services/agent-control/sources/managed-sessions');
const agentRuns = require('../services/agent-control/sources/agent-runs');
const runIndex = require('../services/agent-control/run-index');

const NOW = new Date('2026-09-05T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);

beforeEach(() => {
  for (const k of Object.keys(fixtures)) delete fixtures[k];
  delete process.env.GATE_AGENT_CONTROL_READ;
  delete process.env.GATE_AGENT_RUNS;
});

describe('adapters project onto the canonical shape', () => {
  test('canonicalRun fills area, risk tier, step counts and rejects vocabulary drift', () => {
    // an unknown lifecycle reads as terminal (the stated result stands); an unknown verification as unjudged
    const r = canonicalRun({ source: 's', id: 1, laneId: 'blog_draft', lifecycle: 'bogus', result: 'succeeded', verification: 'nope', steps: [{ status: 'done' }, { status: 'failed' }] });
    expect(r).toMatchObject({ key: 's:1', area: 'content', lifecycle: 'terminal', result: 'succeeded', verification: 'unjudged', stepsDone: 1, stepsTotal: 2, riskTier: expect.any(Number) });
    expect(canonicalRun({ source: 's', id: 3, workflowId: 'nightly' })).toMatchObject({ laneId: null, area: 'office', title: 'nightly', sideEffectClass: null, riskTier: null, attempts: 1 });
    expect(canonicalRun({ source: 's', id: 2, lifecycle: 'running', result: 'succeeded' }).result).toBeNull();
  });

  test('autonomous_runs: outcome → lifecycle / result / disposition, stages → steps, shadow subtitle', () => {
    const base = { id: 'a', action_type: 'new_post', page_type: 'blog', claim_ms: 5, brief_ms: 7, created_at: ago(60e3), claimed_at: ago(50e3) };
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_published', completed_at: ago(1e3), published_url: 'https://x/y' })).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', disposition: 'applied', link: 'https://x/y', laneId: 'blog_draft' });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', completed_at: ago(2e3) })).toMatchObject({ lifecycle: 'waiting_human', disposition: 'drafted', link: '/admin/blog?tab=autopilot' });
    // a parked run keeps waiting through an open approval, and closes on the newest emailed decision or the in-review stamp
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', approval_status: 'awaiting_reply', approval_at: ago(1e3) })).toMatchObject({ lifecycle: 'waiting_human', lastProgressAt: ago(1e3).toISOString() });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', approval_status: 'approved', approval_at: ago(1e3) })).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', disposition: 'applied', verification: 'passed', finishedAt: ago(1e3).toISOString(), link: null });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', approval_status: 'rejected' })).toMatchObject({ disposition: 'rejected', verification: 'failed' });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', approval_status: 'executing' })).toMatchObject({ lifecycle: 'running' });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', trust_build_approved_at: ago(500) })).toMatchObject({ lifecycle: 'terminal', disposition: 'applied', finishedAt: ago(500).toISOString() });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'skipped_gate_fail', quality_gate_result: { ok: false } })).toMatchObject({ lifecycle: 'terminal', result: 'errored', failureClass: 'instruction' });
    const running = autonomousRuns.fromRow({ ...base, outcome: null, shadow_mode: true });
    expect(running.lifecycle).toBe('running');
    expect(running.subtitle).toBe('new post · blog · shadow');
    expect(running.steps.map((s) => s.status)).toEqual(['done', 'done', 'running', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(autonomousRuns.fromRow({ ...base, outcome: 'failed_publish', failure_message: 'boom' })).toMatchObject({ result: 'errored', errorCode: 'failed_publish', detail: 'boom' });
  });

  test('message_drafts: pending waits on the owner; approved / rejected close with a verification', () => {
    const base = { id: 'd', created_at: ago(5e3), draft_ms: 900, customer_name: 'Pat Lee', intent: 'reschedule' };
    const pending = messageDrafts.fromRow({ ...base, status: 'pending' });
    expect(pending).toMatchObject({ lifecycle: 'waiting_human', disposition: 'drafted', title: 'Reply draft for Pat Lee', laneId: 'sms_draft', durationMs: 900 });
    expect(pending.steps[2].status).toBe('running');
    expect(messageDrafts.fromRow({ ...base, status: 'rejected' })).toMatchObject({ lifecycle: 'terminal', disposition: 'rejected', verification: 'failed' });
    expect(messageDrafts.fromRow({ ...base, status: 'sent', sent_at: ago(1e3), campaign_type: 'winback' })).toMatchObject({ disposition: 'applied', title: 'Draft for Pat Lee', subtitle: 'winback campaign' });
  });

  test('agent_decisions: the producers\' workflows map to lanes / the SMS area, every written status is mapped, unknown ones surface', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    // workflow ids: each producer's WORKFLOW constant
    const producers = ['services/sms-suggest-mode.js', 'services/sms-auto-send.js', 'services/reschedule-intent-flagger.js', 'services/completion-comms-guard.js', 'services/contact-correction.js', 'services/estimate-conversion-agent.js'];
    const workflows = new Set();
    for (const f of producers) for (const m of read(f).matchAll(/const [A-Z_]*WORKFLOW = '([a-z_]+)'/g)) workflows.add(m[1]);
    expect(workflows.size).toBeGreaterThanOrEqual(6);
    for (const w of workflows) expect(agentDecisions.WORKFLOW_MAP).toHaveProperty(w);
    // statuses: sms-auto-send's lifecycle constants + the literals the other producers write on agent_decisions rows
    const statuses = new Set(['pending_review', 'scheduled', 'superseded', 'expired', 'ignored', 'shadow', 'reviewed', 'auto_resolved', 'auto_applied']);
    for (const m of read('services/sms-auto-send.js').matchAll(/const (?:CLAIM|SENT|FAILED)_STATUS = '([a-z_]+)'/g)) statuses.add(m[1]);
    expect(statuses.size).toBeGreaterThanOrEqual(12);
    for (const st of statuses) expect(agentDecisions.STATUS_MAP).toHaveProperty(st);
    expect(agentDecisions.LIVE_STATUSES).toEqual(expect.arrayContaining(['pending_review', 'sending', 'scheduled']));

    const base = { id: 'x', workflow: 'sms_house_voice_suggest', detected_intent: 'book', confidence: 0.82, mode: 'suggest', created_at: ago(3e3) };
    expect(agentDecisions.fromRow({ ...base, status: 'pending_review' })).toMatchObject({ lifecycle: 'waiting_human', laneId: 'sms_suggest', area: 'sms', subtitle: 'suggest mode · confidence 82 %', workflowId: 'sms_house_voice_suggest' });
    const reviewed = agentDecisions.fromRow({ ...base, status: 'reviewed', human_verdict: 'corrected', reviewed_at: ago(1e3), safety_flags: ['pricing_claim'] });
    expect(reviewed).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', verification: 'warning', disposition: 'applied' });
    expect(reviewed.steps.map((s) => s.key)).toEqual(['decide', 'safety', 'review']);
    // auto-send: in flight, sent, failed
    expect(agentDecisions.fromRow({ ...base, workflow: 'sms_house_voice_auto_send', status: 'sending' })).toMatchObject({ lifecycle: 'running', laneId: 'sms_draft', area: 'sms' });
    expect(agentDecisions.fromRow({ ...base, workflow: 'sms_house_voice_auto_send', status: 'auto_sent' })).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' });
    const failed = agentDecisions.fromRow({ ...base, workflow: 'sms_house_voice_auto_send', status: 'auto_send_failed' });
    expect(failed).toMatchObject({ lifecycle: 'terminal', result: 'errored', failureClass: 'provider' });
    expect(runIndex.bucketsOf({ ...failed, health: 'healthy', attention: null })).toMatchObject({ failed: true, attention: true, done: false });
    // a deterministic guard keeps the SMS area with no lane; a business workflow is office; an unknown status surfaces
    expect(agentDecisions.fromRow({ ...base, workflow: 'comms_guards', status: 'auto_resolved' })).toMatchObject({ laneId: null, area: 'sms', disposition: 'no_action' });
    expect(agentDecisions.fromRow({ ...base, workflow: 'referral_reward', status: 'match' })).toMatchObject({ laneId: null, area: 'office', lifecycle: 'terminal', result: null });
  });

  test('call_log: processing_status → lifecycle with the processor heartbeat as the run heartbeat', () => {
    const base = { id: 'c', direction: 'inbound', duration_seconds: 125, created_at: ago(9e5), processing_started_at: ago(8e5), processing_heartbeat_at: ago(10e3), extraction_attempts: 2 };
    const live = callLog.fromRow({ ...base, processing_status: 'processing', transcription_status: 'completed' });
    expect(live).toMatchObject({ lifecycle: 'running', lastHeartbeatAt: ago(10e3).toISOString(), attempts: 2, laneId: 'call_extraction', title: 'inbound · 2 min' });
    expect(live.steps.map((s) => s.status)).toEqual(['done', 'running', 'skipped']);
    expect(callLog.fromRow({ ...base, processing_status: 'extraction_failed' })).toMatchObject({ lifecycle: 'terminal', result: 'errored', failureClass: 'incomplete' });
    expect(callLog.fromRow({ ...base, processing_status: 'voicemail' })).toMatchObject({ result: 'succeeded', disposition: 'no_action' });
    expect(callLog.fromRow({ ...base, processing_status: 'pending' }).lifecycle).toBe('queued');
  });

  test('call_log: every processing_status the processor writes or sweeps is mapped; an unknown one surfaces as failed / attention', () => {
    const fs = require('fs');
    const path = require('path');
    const src = ['call-recording-processor.js', 'context-aggregator.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'services', f), 'utf8')).join('\n');
    const seen = new Set();
    // assignments / comparisons (processing_status: 'x', = 'x', finalStatus = cond ? 'x' : 'y') and the sweep's IN list
    for (const m of src.matchAll(/(?:processing_status|finalStatus|preClaimStatus)\s*(?:[:=]=*|<>|!=|IS DISTINCT FROM)\s*\(?'([a-z_]+)'/g)) seen.add(m[1]);
    for (const m of src.matchAll(/finalStatus = [^\n]*/g)) for (const v of m[0].matchAll(/'([a-z_]+)'/g)) seen.add(v[1]);
    for (const m of src.matchAll(/processing_status IN \(([^)]*)\)/g)) for (const v of m[1].matchAll(/'([a-z_]+)'/g)) seen.add(v[1]);
    expect(seen.size).toBeGreaterThanOrEqual(9);
    for (const status of seen) expect(callLog.STATUS_MAP).toHaveProperty(status);
    expect(callLog.fromRow({ id: 'x', processing_status: 'customer_creation_failed', created_at: ago(1e3) })).toMatchObject({ lifecycle: 'terminal', result: 'errored', failureClass: 'tool', errorCode: 'customer_creation_failed' });
    const unknown = callLog.fromRow({ id: 'y', processing_status: 'brand_new_state', created_at: ago(1e3) });
    expect(unknown).toMatchObject({ lifecycle: 'terminal', result: null });
    expect(runIndex.bucketsOf({ ...unknown, health: 'healthy', attention: null })).toMatchObject({ failed: true, attention: true, done: false });
  });

  test('job_health: a running job is live, a failing job is errored, a lane comes from its policy workflow_id', () => {
    const running = jobHealth.fromRow({ job_name: 'nightly_sweep', last_status: 'running', last_started_at: ago(5e3), last_finished_at: ago(3600e3), last_duration_ms: 400 });
    expect(running).toMatchObject({ lifecycle: 'running', finishedAt: null, durationMs: null, workflowId: 'nightly_sweep', title: 'nightly sweep' });
    expect(jobHealth.fromRow({ job_name: 'j', last_status: 'failed', consecutive_failures: 3, last_error: 'ENOTFOUND', last_started_at: ago(5e3), last_finished_at: ago(4e3) })).toMatchObject({ lifecycle: 'terminal', result: 'errored', failureClass: 'infrastructure', subtitle: '3 consecutive failures', detail: 'ENOTFOUND', attempts: 3 });
    const { LANE_RUNTIME } = require('../services/agent-control/lane-policies');
    const [laneId, policy] = Object.entries(LANE_RUNTIME).find(([, p]) => p.workflow_id) || [];
    if (laneId) expect(jobHealth.laneForJob(policy.workflow_id)).toBe(laneId);
    expect(jobHealth.laneForJob('no_such_job')).toBeNull();
  });

  test('managed_sessions: a session row is a finished run keyed by its provider ref; turns are the steps', () => {
    const ok = managedSessions.fromRow({ provider_ref: 'sess_1', lane_id: 'agent_bi', ok: true, served_model: 'claude-x', latency_ms: 5000, created_at: ago(9e3), turns: 3 });
    expect(ok).toMatchObject({ key: 'managed_sessions:sess_1', lifecycle: 'terminal', result: 'succeeded', durationMs: 5000, stepsDone: 3, subtitle: 'claude-x · 3 turns', area: 'agents' });
    expect(ok.finishedAt).toBe(ago(4e3).toISOString());
    expect(managedSessions.fromRow({ provider_ref: 's2', lane_id: 'agent_bi', ok: false, error_code: 'anthropic_529', created_at: ago(1e3) })).toMatchObject({ result: 'errored', failureClass: 'provider', errorCode: 'anthropic_529' });
  });

  test('agent_runs: columns map straight through; counts from the subqueries; work-item entity', () => {
    const r = agentRuns.fromRow({ id: 'r1', source_system: 'call_log', source_run_id: 'c9', lane_id: 'call_extraction', lifecycle: 'running', verification: 'unjudged', attempts: 2, max_attempts: 3, steps_done: '2', steps_total: '3', tool_calls: '1', created_at: ago(5e3), started_at: ago(4e3), last_heartbeat_at: ago(1e3), summary: { title: 'Call 9' }, entity_type: 'call_log', entity_id: 'c9', trace_id: 'a'.repeat(32), side_effect_class: 'internal_write' });
    expect(r).toMatchObject({ canonical: true, key: 'agent_runs:r1', sourceSystem: 'call_log', sourceRunId: 'c9', title: 'Call 9', subtitle: 'attempt 2', stepsDone: 2, stepsTotal: 3, toolCalls: 1, entity: { type: 'call_log', id: 'c9' }, riskTier: 1 });
  });

  test('a missing table degrades to unavailable; any other DB error throws', async () => {
    fixtures['message_drafts as d'] = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    expect(await messageDrafts.list({ from: ago(1e6) })).toEqual({ runs: [], unavailable: true });
    fixtures['message_drafts as d'] = Object.assign(new Error('permission denied'), { code: '42501' });
    await expect(messageDrafts.list({ from: ago(1e6) })).rejects.toThrow('permission denied');
    fixtures.autonomous_runs = Object.assign(new Error('no column'), { code: '42703' });
    expect(await autonomousRuns.get('x')).toBeNull();
  });
});

describe('listRuns', () => {
  const laneRun = (over) => canonicalRun({ source: 'autonomous_runs', laneId: 'blog_draft', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(60e3), ...over });
  let spies;
  beforeEach(() => {
    spies = {
      agentRuns: jest.spyOn(agentRuns, 'list').mockResolvedValue({ runs: [], unavailable: false }),
      autonomousRuns: jest.spyOn(autonomousRuns, 'list').mockResolvedValue({ runs: [], unavailable: false }),
      messageDrafts: jest.spyOn(messageDrafts, 'list').mockResolvedValue({ runs: [], unavailable: false }),
      agentDecisions: jest.spyOn(agentDecisions, 'list').mockResolvedValue({ runs: [], unavailable: false }),
      callLog: jest.spyOn(callLog, 'list').mockResolvedValue({ runs: [], unavailable: false }),
      jobHealth: jest.spyOn(jobHealth, 'list').mockResolvedValue({ runs: [], unavailable: true }),
      managedSessions: jest.spyOn(managedSessions, 'list').mockResolvedValue({ runs: [], unavailable: false }),
    };
  });
  afterEach(() => jest.restoreAllMocks());

  test('merges canonical and legacy rows newest-first, derives health, buckets and counts, reports unavailable sources', async () => {
    spies.agentRuns.mockResolvedValue({ runs: [canonicalRun({ source: 'agent_runs', id: 'r1', sourceSystem: 'autonomous_runs', sourceRunId: 'a1', laneId: 'blog_draft', lifecycle: 'running', createdAt: ago(40 * 60e3), startedAt: ago(40 * 60e3), lastHeartbeatAt: ago(20 * 60e3), lastProgressAt: ago(20 * 60e3), canonical: true })], unavailable: false });
    spies.autonomousRuns.mockResolvedValue({ runs: [laneRun({ id: 'a2', createdAt: ago(30e3) }), laneRun({ id: 'a3', result: 'errored', createdAt: ago(45e3) })], unavailable: false });
    spies.messageDrafts.mockResolvedValue({ runs: [canonicalRun({ source: 'message_drafts', id: 'd1', laneId: 'sms_draft', lifecycle: 'waiting_human', createdAt: ago(3 * 864e5), lastProgressAt: ago(3 * 864e5) })], unavailable: false });
    const out = await runIndex.listRuns({ window: '7d', now: NOW });
    expect(out.runs.map((r) => r.key)).toEqual(['autonomous_runs:a2', 'autonomous_runs:a3', 'agent_runs:r1', 'message_drafts:d1']);
    expect(out.runs[2]).toMatchObject({ health: 'stalled', healthReason: 'no_heartbeat' });
    expect(out.runs[3]).toMatchObject({ health: 'healthy', attention: 'human_wait' });
    expect(out.counts).toEqual({ all: 4, active: 1, waiting: 1, attention: 3, done: 1, failed: 1 });
    expect(out.unavailableSources).toEqual(['job_health']);
    expect(out.phases.runs).toBe(false);
    expect(out.nextCursor).toBeNull();
    expect(spies.autonomousRuns).toHaveBeenCalledWith(expect.objectContaining({ from: expect.any(Date), laneId: null, cursor: null }));
  });

  test('legacy adapters exclude rows a canonical run mirrors through an SQL anti-join (page-independent)', () => {
    const knex = require('knex')({ client: 'pg' });
    const { notMirrored, keyset } = require('../services/agent-control/sources/shape');
    const { sql, bindings } = keyset(notMirrored(knex('call_log').select('id'), { source: 'call_log', idColumn: 'call_log.id' }), { start: 'created_at', id: 'id', cursor: { at: NOW, id: 'c9' }, limit: 3 }).toSQL().toNative();
    expect(sql).toMatch(/where not exists \(select 1 from "agent_runs" where "agent_runs"\."source_system" = \$1 and agent_runs\.source_run_id = call_log\.id::text\)/);
    expect(sql).toMatch(/\("created_at" < \$2 or \("created_at" = \$3 and "id" < \$4\)\)/);
    expect(sql).toMatch(/order by "created_at" desc, "id" desc limit \$5/);
    expect(bindings).toEqual(['call_log', NOW, NOW, 'c9', 3]);
  });

  test('status / area / lane filters; a lane filter skips single-lane adapters that cannot match', async () => {
    spies.autonomousRuns.mockImplementation(sqlLike([laneRun({ id: 'a1' }), laneRun({ id: 'a2', result: 'errored' })]));
    spies.messageDrafts.mockResolvedValue({ runs: [canonicalRun({ source: 'message_drafts', id: 'd1', laneId: 'sms_draft', lifecycle: 'waiting_human', createdAt: ago(1e3) })], unavailable: false });
    expect((await runIndex.listRuns({ status: 'failed', now: NOW })).runs.map((r) => r.key)).toEqual(['autonomous_runs:a2']);
    expect((await runIndex.listRuns({ status: 'done', now: NOW })).runs.map((r) => r.key)).toEqual(['autonomous_runs:a1']);
    expect((await runIndex.listRuns({ area: 'sms', now: NOW })).runs.map((r) => r.key)).toEqual(['message_drafts:d1']);
    jest.clearAllMocks();
    const byLane = await runIndex.listRuns({ lane: 'blog_draft', now: NOW });
    // equal start times: key desc keeps the order deterministic
    expect(byLane.runs.map((r) => r.key)).toEqual(['autonomous_runs:a2', 'autonomous_runs:a1']);
    expect(spies.messageDrafts).not.toHaveBeenCalled();
    expect(spies.callLog).not.toHaveBeenCalled();
    expect(spies.agentDecisions).toHaveBeenCalled();
  });

  // A source behaving like its SQL: order (start desc, id desc), resume strictly after the cursor, cap at limit.
  const sqlLike = (rows) => async ({ cursor, limit }) => {
    const key = (r) => [new Date(r.startedAt).getTime(), r.id];
    const sorted = [...rows].sort((x, y) => (key(y)[0] - key(x)[0]) || (key(y)[1] < key(x)[1] ? -1 : key(y)[1] > key(x)[1] ? 1 : 0));
    const after = cursor ? sorted.filter((r) => key(r)[0] < cursor.at.getTime() || (key(r)[0] === cursor.at.getTime() && r.id < cursor.id)) : sorted;
    return { runs: after.slice(0, limit), unavailable: false };
  };

  test('keyset cursor: per-source positions resume each source strictly after its last row; pages walk the window; counts only on page 1; bad params are 400', async () => {
    const all = [1, 2, 3, 4, 5].map((i) => laneRun({ id: `a${i}`, createdAt: ago(i * 1000) }));
    spies.autonomousRuns.mockImplementation(sqlLike(all));
    const p1 = await runIndex.listRuns({ limit: 2, now: NOW });
    expect(p1.runs.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(p1.counts.all).toBe(5);
    expect(p1.countsCapped).toBe(false);
    expect(spies.autonomousRuns).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, limit: 2000 }));
    const p2 = await runIndex.listRuns({ limit: 2, cursor: p1.nextCursor, now: NOW });
    expect(p2.runs.map((r) => r.id)).toEqual(['a3', 'a4']);
    expect(p2.counts).toBeNull();
    expect(spies.autonomousRuns).toHaveBeenCalledWith(expect.objectContaining({ cursor: { at: new Date(p1.runs[1].startedAt), id: 'a2' }, limit: 3 }));
    const p3 = await runIndex.listRuns({ limit: 2, cursor: p2.nextCursor, now: NOW });
    expect(p3.runs.map((r) => r.id)).toEqual(['a5']);
    expect(p3.nextCursor).toBeNull();
    for (const bad of [{ cursor: '!!' }, { cursor: Buffer.from('{"p":{"nope":["x","y"]}}').toString('base64url') }, { window: '90d' }, { status: 'weird' }, { area: 'nope' }, { lane: 'not_a_lane' }, { window: 'constructor' }]) {
      await expect(runIndex.listRuns({ ...bad, now: NOW })).rejects.toMatchObject({ status: 400 });
    }
  });

  test('a page never ends early: a status filter whose matches sit past non-matching slices keeps reading; equal timestamps page exactly', async () => {
    const mixed = [1, 2, 3, 4, 5, 6, 7].map((i) => laneRun({ id: `m${i}`, createdAt: ago(i * 1000), result: i === 6 || i === 7 ? 'errored' : 'succeeded' }));
    spies.autonomousRuns.mockImplementation(sqlLike(mixed));
    const f1 = await runIndex.listRuns({ limit: 1, status: 'failed', now: NOW });
    expect(f1.runs.map((r) => r.id)).toEqual(['m6']);
    const f2 = await runIndex.listRuns({ limit: 1, status: 'failed', cursor: f1.nextCursor, now: NOW });
    expect(f2.runs.map((r) => r.id)).toEqual(['m7']);
    expect(f2.nextCursor).toBeNull();
    // six rows at one timestamp, pages of two: every row exactly once
    const band = [1, 2, 3, 4, 5, 6].map((i) => laneRun({ id: `b${i}`, createdAt: ago(1000) }));
    spies.autonomousRuns.mockImplementation(sqlLike(band));
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 5 && (i === 0 || cursor); i += 1) {
      const pg = await runIndex.listRuns({ limit: 2, cursor, now: NOW });
      seen.push(...pg.runs.map((r) => r.id));
      cursor = pg.nextCursor;
    }
    expect(seen).toEqual(['b6', 'b5', 'b4', 'b3', 'b2', 'b1']);
    expect(cursor).toBeNull();
    // a filtered scan that spends its rounds on non-matching rows returns an EMPTY page with the advanced cursor
    const sparse = [...Array.from({ length: 30 }, (_, i) => laneRun({ id: `s${String(i).padStart(2, '0')}`, createdAt: ago((i + 1) * 1000) })), laneRun({ id: 'zz', result: 'errored', createdAt: ago(99e3) })];
    spies.autonomousRuns.mockImplementation(sqlLike(sparse));
    let pg = await runIndex.listRuns({ limit: 1, status: 'failed', cursor: Buffer.from('{"p":{}}').toString('base64url'), now: NOW });
    expect(pg.runs).toEqual([]);
    expect(pg.nextCursor).not.toBeNull();
    let hops = 1;
    while (!pg.runs.length && pg.nextCursor && hops < 10) { pg = await runIndex.listRuns({ limit: 1, status: 'failed', cursor: pg.nextCursor, now: NOW }); hops += 1; }
    expect(pg.runs.map((r) => r.id)).toEqual(['zz']);
  });

  test('sources merge newest-first across pages, each resuming from its own position; a capped first page flags counts and offers a cursor', async () => {
    const content = [1, 3, 5].map((i) => laneRun({ id: `c${i}`, createdAt: ago(i * 1000) }));
    const drafts = [2, 4, 6].map((i) => canonicalRun({ source: 'message_drafts', id: `d${i}`, laneId: 'sms_draft', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(i * 1000) }));
    spies.autonomousRuns.mockImplementation(sqlLike(content));
    spies.messageDrafts.mockImplementation(sqlLike(drafts));
    const p1 = await runIndex.listRuns({ limit: 4, now: NOW });
    expect(p1.runs.map((r) => r.id)).toEqual(['c1', 'd2', 'c3', 'd4']);
    const p2 = await runIndex.listRuns({ limit: 4, cursor: p1.nextCursor, now: NOW });
    expect(p2.runs.map((r) => r.id)).toEqual(['c5', 'd6']);
    expect(p2.nextCursor).toBeNull();
    // a source that fills the first-page scan cap
    spies.messageDrafts.mockImplementation(async ({ cursor, limit }) => ({ runs: cursor ? [] : Array.from({ length: limit }, (_, i) => canonicalRun({ source: 'message_drafts', id: `x${String(i).padStart(4, '0')}`, laneId: 'sms_draft', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(i + 1) })), unavailable: false }));
    const hit = await runIndex.listRuns({ limit: 10, now: NOW });
    expect(hit.countsCapped).toBe(true);
    expect(hit.runs).toHaveLength(10);
    expect(hit.nextCursor).not.toBeNull();
  });
});

describe('getRun', () => {
  afterEach(() => jest.restoreAllMocks());

  test('a legacy row folds with its canonical mirror: canonical run + legacy steps when the mirror has none; calls by run id', async () => {
    jest.spyOn(callLog, 'get').mockResolvedValue({ run: canonicalRun({ source: 'call_log', id: 'c1', laneId: 'call_extraction', lifecycle: 'running', createdAt: ago(1e3), steps: [{ key: 'transcribe', status: 'done' }] }) });
    jest.spyOn(agentRuns, 'findMirror').mockResolvedValue('r9');
    jest.spyOn(agentRuns, 'get').mockResolvedValue({ run: canonicalRun({ source: 'agent_runs', id: 'r9', sourceSystem: 'call_log', sourceRunId: 'c1', laneId: 'call_extraction', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(1e3), canonical: true }), attempts: [{ attempt_no: 1 }], artifacts: [], events: [{ event_type: 'finished' }], workItem: { id: 'w' } });
    fixtures.llm_dispatch_log = [{ id: 1, row_kind: 'call' }];
    const d = await runIndex.getRun('call_log', 'c1', { now: NOW });
    expect(d.run).toMatchObject({ key: 'agent_runs:r9', canonical: true, stepsDone: 1, health: 'healthy' });
    expect(d.steps).toEqual([{ key: 'transcribe', status: 'done' }]);
    expect(d.attempts).toHaveLength(1);
    expect(d.calls).toHaveLength(1);
    expect(d.legacy).toEqual({ source: 'call_log', id: 'c1' });
    expect(d.trace).toEqual({ id: null, calls: 1 });
  });

  test('unknown source → 400; unknown id → null; a legacy row without a mirror is returned as-is', async () => {
    await expect(runIndex.getRun('nope', '1')).rejects.toMatchObject({ status: 400 });
    jest.spyOn(jobHealth, 'get').mockResolvedValue(null);
    expect(await runIndex.getRun('job_health', 'missing')).toBeNull();
    jest.spyOn(messageDrafts, 'get').mockResolvedValue({ run: canonicalRun({ source: 'message_drafts', id: 'd', laneId: 'sms_draft', lifecycle: 'waiting_human', createdAt: ago(1e3) }) });
    jest.spyOn(agentRuns, 'findMirror').mockResolvedValue(null);
    const d = await runIndex.getRun('message_drafts', 'd', { now: NOW });
    expect(d.run.canonical).toBe(false);
    expect(d.events).toEqual([]);
    expect(d.calls).toEqual([]);
    expect(d.legacy).toBeNull();
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

  test('reads 404 while the read gate is off; on, list + detail answer, tech is 403, bad params 400, probe reports the write gate', async () => {
    jest.spyOn(runIndex, 'listRuns');
    jest.spyOn(agentRuns, 'list').mockResolvedValue({ runs: [], unavailable: false });
    for (const s of [autonomousRuns, messageDrafts, agentDecisions, callLog, jobHealth, managedSessions]) jest.spyOn(s, 'list').mockResolvedValue({ runs: [], unavailable: false });
    jest.spyOn(jobHealth, 'get').mockImplementation(async (id) => (id === 'j' ? { run: canonicalRun({ source: 'job_health', id: 'j', workflowId: 'j', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(1e3) }) } : null));
    jest.spyOn(agentRuns, 'findMirror').mockResolvedValue(null);
    await withServer(async (base) => {
      const admin = { headers: { Authorization: 'Bearer admin' } };
      expect((await fetch(`${base}/api/admin/agents/control/runs`, admin)).status).toBe(404);
      expect((await fetch(`${base}/api/admin/agents/control/runs/job_health/j`, admin)).status).toBe(404);
      expect((await (await fetch(`${base}/api/admin/agents/control/hub`, admin)).json()).features.runs).toBe(false);

      process.env.GATE_AGENT_CONTROL_READ = 'true';
      process.env.GATE_AGENT_RUNS = 'true';
      expect((await (await fetch(`${base}/api/admin/agents/control/hub`, admin)).json()).features.runs).toBe(true);
      expect((await fetch(`${base}/api/admin/agents/control/runs`, { headers: { Authorization: 'Bearer tech' } })).status).toBe(403);
      expect((await fetch(`${base}/api/admin/agents/control/runs?window=90d`, admin)).status).toBe(400);
      expect((await fetch(`${base}/api/admin/agents/control/runs?status=constructor`, admin)).status).toBe(400);
      const list = await fetch(`${base}/api/admin/agents/control/runs?area=content&status=active&window=today&limit=10`, admin);
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(body).toMatchObject({ runs: [], counts: expect.any(Object), phases: { runs: true }, window: { key: 'today' } });
      expect(runIndex.listRuns).toHaveBeenCalledWith(expect.objectContaining({ area: 'content', status: 'active', window: 'today', limit: '10', cursor: null, lane: null }));
      const detail = await fetch(`${base}/api/admin/agents/control/runs/job_health/j`, admin);
      expect(detail.status).toBe(200);
      expect((await detail.json()).run.key).toBe('job_health:j');
      expect((await fetch(`${base}/api/admin/agents/control/runs/nope/1`, admin)).status).toBe(400);
      expect((await fetch(`${base}/api/admin/agents/control/runs/job_health/missing`, admin)).status).toBe(404);
    });
  });
});
