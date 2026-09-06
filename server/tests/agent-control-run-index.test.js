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
// the uuid-keyed sources (agent_runs, autonomous_runs, message_drafts, agent_decisions, call_log) take uuid ids only
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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
    const base = { id: 'a', action_type: 'new_post', page_type: 'blog', claim_ms: 5, brief_ms: 7, total_ms: 4200, created_at: ago(60e3), claimed_at: ago(50e3) };
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_published', completed_at: ago(1e3), published_url: 'https://x/y' })).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', disposition: 'applied', link: 'https://x/y', laneId: 'blog_draft', durationMs: 4200 });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', completed_at: ago(2e3) })).toMatchObject({ lifecycle: 'waiting_human', disposition: 'drafted', link: '/admin/blog?tab=autopilot' });
    // a parked run keeps waiting through an open approval, and closes on the newest emailed decision or the in-review stamp
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', approval_status: 'awaiting_reply', approval_sent_at: ago(900), approval_at: ago(1e3) })).toMatchObject({ lifecycle: 'waiting_human', lastProgressAt: ago(1e3).toISOString() });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', approval_status: 'approved', approval_at: ago(1e3) })).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', disposition: 'applied', verification: 'passed', finishedAt: ago(1e3).toISOString(), link: null });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', approval_status: 'rejected' })).toMatchObject({ disposition: 'rejected', verification: 'failed' });
    // executing = active again FROM the decision: its own start / heartbeat, no finish (a draft parked past the hard timeout is not stalled the moment the owner replies)
    const executing = autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', completed_at: ago(40e3), updated_at: ago(40e3), approval_status: 'executing', approval_at: ago(1e3) });
    expect(executing).toMatchObject({ lifecycle: 'running', startedAt: ago(1e3).toISOString(), lastHeartbeatAt: ago(1e3).toISOString(), lastProgressAt: ago(1e3).toISOString(), finishedAt: null, durationMs: null });
    // the approval email never left: waiting on the sender since it was raised, never an owner wait
    const unsent = autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', completed_at: ago(40e3), approval_status: 'awaiting_reply', approval_sent_at: null, approval_at: ago(5e3), approval_error: 'smtp 451' });
    expect(unsent).toMatchObject({ lifecycle: 'waiting_external', disposition: 'drafted', startedAt: ago(5e3).toISOString(), finishedAt: null, errorCode: null, detail: 'Approval email not delivered yet: smtp 451' });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', approval_status: 'awaiting_reply', approval_sent_at: ago(4e3), approval_at: ago(5e3) })).toMatchObject({ lifecycle: 'waiting_human' });
    // a failed emailed approval names ITS failure (content_email_approvals.last_error), not the parked generation outcome
    // … and keeps the execution's own span: the decision → the failure (approval_at = the approval row's updated_at for a failed one)
    const approvalFailed = autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', completed_at: ago(40e3), approval_status: 'failed', execution_started_at: ago(30e3), approval_at: ago(1e3), approval_error: 'astro PR open failed: 502' });
    expect(approvalFailed).toMatchObject({ lifecycle: 'terminal', result: 'errored', failureClass: 'infrastructure', errorCode: 'approval_failed', errorMessage: 'astro PR open failed: 502', detail: 'astro PR open failed: 502', startedAt: ago(30e3).toISOString(), finishedAt: ago(1e3).toISOString(), durationMs: 29e3 });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'completed_pending_review', trust_build_approved_at: ago(500) })).toMatchObject({ lifecycle: 'terminal', disposition: 'applied', finishedAt: ago(500).toISOString() });
    expect(autonomousRuns.fromRow({ ...base, outcome: 'skipped_gate_fail', quality_gate_result: { ok: false } })).toMatchObject({ lifecycle: 'terminal', result: 'errored', failureClass: 'instruction' });
    // a gate failure the runner parked for the owner (opportunity pending_review) is an owner-action run
    expect(autonomousRuns.fromRow({ ...base, outcome: 'skipped_gate_fail', skip_reason: 'facts_insufficient', opportunity_status: 'pending_review' })).toMatchObject({ lifecycle: 'waiting_human', disposition: 'drafted', link: '/admin/blog?tab=autopilot', detail: 'facts insufficient' });
    // an in-app approval flips a parked draft to publishing_* in place (completed_at stays, only updated_at moves): running, active from that claim, kept live by the list predicate however old
    const { runStatus } = require('../services/agent-activity');
    const publishingRow = { ...base, outcome: 'publishing_named_competitor', completed_at: ago(3 * 864e5), claimed_at: ago(3 * 864e5), updated_at: ago(2e3) };
    expect(runStatus(publishingRow)).toBe('running');
    expect(autonomousRuns.fromRow(publishingRow)).toMatchObject({ lifecycle: 'running', startedAt: ago(2e3).toISOString(), lastHeartbeatAt: ago(2e3).toISOString(), finishedAt: null });
    expect(autonomousRuns.PUBLISHING).toBe("outcome LIKE 'publishing%'");
    const running = autonomousRuns.fromRow({ ...base, outcome: null, shadow_mode: true });
    expect(running.lifecycle).toBe('running');
    expect(running.subtitle).toBe('new post · blog · shadow');
    expect(running.steps.map((s) => s.status)).toEqual(['done', 'done', 'running', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(autonomousRuns.fromRow({ ...base, outcome: 'failed_publish', failure_message: 'boom' })).toMatchObject({ result: 'errored', errorCode: 'failed_publish', detail: 'boom' });
  });

  test('message_drafts: the CHECK vocabulary is fully mapped; pending / suggested wait on the owner; decisions close with a verification', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'models', 'migrations');
    // the LAST migration (by name = by date) that redefines message_drafts_status_check is the live constraint
    // up() only — a down() restores the previous vocabulary
    const up = (src) => src.split(/exports\.down\b/)[0];
    const defs = fs.readdirSync(dir).sort().flatMap((f) => [...up(fs.readFileSync(path.join(dir, f), 'utf8')).matchAll(/message_drafts_status_check CHECK \(status IN \(([^)]*)\)\)/g)].map((m) => m[1]));
    expect(defs.length).toBeGreaterThan(0);
    const statuses = [...defs[defs.length - 1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(statuses).toEqual(expect.arrayContaining(['pending', 'suggested', 'auto_sent', 'shadow']));
    for (const st of statuses) expect(messageDrafts.STATUS_MAP).toHaveProperty(st);
    expect([...messageDrafts.LIVE_STATUSES].sort()).toEqual(['pending', 'suggested']);
    const base = { id: 'd', created_at: ago(5e3), draft_ms: 900, customer_name: 'Pat Lee', intent: 'reschedule' };
    const suggested = messageDrafts.fromRow({ ...base, status: 'suggested' });
    expect(suggested).toMatchObject({ lifecycle: 'waiting_human', disposition: 'drafted' });
    expect(suggested.steps[2].detail).toBe('Suggested in the thread');
    expect(messageDrafts.fromRow({ ...base, status: 'revised', approved_at: ago(1e3) })).toMatchObject({ lifecycle: 'terminal', disposition: 'applied', verification: 'warning' });
    expect(messageDrafts.fromRow({ ...base, status: 'auto_sent', sent_at: ago(1e3) })).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' });
    expect(messageDrafts.fromRow({ ...base, status: 'shadow' })).toMatchObject({ disposition: 'no_action' });
    expect(messageDrafts.fromRow({ ...base, status: 'brand_new' })).toMatchObject({ lifecycle: 'terminal', result: null });
    const pending = messageDrafts.fromRow({ ...base, status: 'pending' });
    expect(pending).toMatchObject({ lifecycle: 'waiting_human', disposition: 'drafted', title: 'Reply draft for Pat Lee', laneId: 'sms_draft', durationMs: 900 });
    expect(pending.steps[2].status).toBe('running');
    expect(messageDrafts.fromRow({ ...base, status: 'rejected' })).toMatchObject({ lifecycle: 'terminal', disposition: 'rejected', verification: 'failed' });
    expect(messageDrafts.fromRow({ ...base, status: 'sent', sent_at: ago(1e3), campaign_type: 'winback' })).toMatchObject({ disposition: 'applied', title: 'Draft for Pat Lee', subtitle: 'winback campaign' });
    // a suggested draft stays 'suggested' after the owner acts (the judge needs it): the linked decision closes the run
    expect(messageDrafts.fromRow({ ...base, status: 'suggested', decision_status: 'pending_review' })).toMatchObject({ lifecycle: 'waiting_human', startedAt: ago(5e3).toISOString() });
    expect(messageDrafts.fromRow({ ...base, status: 'suggested', decision_status: 'pending_review' }).steps[2]).toMatchObject({ status: 'running', detail: 'Suggested in the thread' });
    // the owner scheduled it: the draft waits on the SEND from the decision's span (its scheduling transition / due time), not on the owner
    const scheduled = messageDrafts.fromRow({ ...base, status: 'suggested', decision_status: 'scheduled', decision_at: ago(2e3), decision_active_from: ago(-600e3) });
    expect(scheduled).toMatchObject({ lifecycle: 'waiting_external', startedAt: ago(-600e3).toISOString(), lastProgressAt: ago(2e3).toISOString(), finishedAt: null, durationMs: null });
    expect(scheduled.steps[2]).toMatchObject({ status: 'running', detail: 'scheduled' });
    expect(messageDrafts.fromRow({ ...base, status: 'suggested', decision_status: 'sending', decision_at: ago(1e3), decision_active_from: ago(1e3) })).toMatchObject({ lifecycle: 'running', startedAt: ago(1e3).toISOString() });
    const sentAsIs = messageDrafts.fromRow({ ...base, status: 'suggested', decision_status: 'accepted', decision_verdict: 'accepted', decision_at: ago(1e3) });
    expect(sentAsIs).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', disposition: 'applied', verification: 'passed', finishedAt: ago(1e3).toISOString(), lastProgressAt: ago(1e3).toISOString() });
    expect(sentAsIs.steps[2]).toMatchObject({ status: 'done', detail: 'accepted' });
    expect(messageDrafts.fromRow({ ...base, status: 'suggested', decision_status: 'corrected', decision_verdict: 'corrected' })).toMatchObject({ lifecycle: 'terminal', disposition: 'applied', verification: 'warning' });
    expect(messageDrafts.fromRow({ ...base, status: 'suggested', decision_status: 'ignored', decision_verdict: 'ignored' })).toMatchObject({ lifecycle: 'terminal', disposition: 'no_action', verification: 'overridden' });
    expect(messageDrafts.fromRow({ ...base, status: 'suggested', decision_status: 'superseded' })).toMatchObject({ lifecycle: 'terminal', result: 'canceled', disposition: 'no_action' });
    // a suggestion the producer set back to shadow (ignored / expired / superseded) keeps the terminal decision's outcome; a live decision is not projected onto a shadow draft
    expect(messageDrafts.fromRow({ ...base, status: 'shadow', decision_status: 'expired', decision_at: ago(1e3) })).toMatchObject({ lifecycle: 'terminal', result: 'canceled', disposition: 'no_action', finishedAt: ago(1e3).toISOString() });
    expect(messageDrafts.fromRow({ ...base, status: 'shadow', decision_status: 'ignored', decision_verdict: 'ignored' })).toMatchObject({ result: 'succeeded', disposition: 'no_action', verification: 'overridden' });
    expect(messageDrafts.fromRow({ ...base, status: 'shadow', decision_status: 'scheduled', decision_active_from: ago(-600e3) })).toMatchObject({ lifecycle: 'terminal', disposition: 'no_action', verification: 'unjudged' });
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
    // the review paths persist the owner's verdict as the row status too (admin-agent-decisions VALID_VERDICTS; admin-communications + sms-suggest-mode write the same values)
    const verdicts = new Set([...read('routes/admin-agent-decisions.js').match(/const VALID_VERDICTS = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    expect([...verdicts].sort()).toEqual(['accepted', 'corrected', 'dismissed']);
    for (const v of verdicts) statuses.add(v);
    expect(statuses.size).toBeGreaterThanOrEqual(15);
    for (const st of statuses) expect(agentDecisions.STATUS_MAP).toHaveProperty(st);
    // every human_verdict literal a producer writes is a verification
    for (const f of ['routes/admin-communications.js', 'services/sms-suggest-mode.js']) for (const m of read(f).matchAll(/human_verdict: '([a-z_]+)'/g)) verdicts.add(m[1]);
    expect(verdicts.has('ignored')).toBe(true);
    for (const v of verdicts) expect(agentDecisions.VERDICT).toHaveProperty(v);
    expect(agentDecisions.LIVE_STATUSES).toEqual(expect.arrayContaining(['pending_review', 'sending', 'scheduled']));

    const base = { id: 'x', workflow: 'sms_house_voice_suggest', detected_intent: 'book', confidence: 0.82, mode: 'suggest', created_at: ago(3e3) };
    expect(agentDecisions.fromRow({ ...base, status: 'pending_review' })).toMatchObject({ lifecycle: 'waiting_human', laneId: 'sms_suggest', area: 'sms', subtitle: 'suggest mode · confidence 82 %', workflowId: 'sms_house_voice_suggest', startedAt: ago(3e3).toISOString() });
    // a scheduled send waits from the scheduling transition / its due time (active_from, computed in SQL), not from the original decision
    expect(agentDecisions.fromRow({ ...base, status: 'scheduled', created_at: ago(3600e3), updated_at: ago(60e3), active_from: ago(-1800e3) })).toMatchObject({ lifecycle: 'waiting_external', startedAt: ago(-1800e3).toISOString(), createdAt: ago(3600e3).toISOString() });
    const reviewed = agentDecisions.fromRow({ ...base, status: 'reviewed', human_verdict: 'corrected', reviewed_at: ago(1e3), safety_flags: ['pricing_claim'] });
    expect(reviewed).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', verification: 'warning', disposition: 'applied' });
    expect(reviewed.steps.map((s) => s.key)).toEqual(['decide', 'safety', 'review']);
    // an accepted / corrected review is applied work, a dismissed one refused, an ignored suggestion overridden — none of them failed
    expect(agentDecisions.fromRow({ ...base, status: 'accepted', human_verdict: 'accepted', reviewed_at: ago(1e3) })).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', verification: 'passed', disposition: 'applied', finishedAt: ago(1e3).toISOString() });
    expect(agentDecisions.fromRow({ ...base, status: 'corrected', human_verdict: 'corrected' })).toMatchObject({ result: 'succeeded', verification: 'warning', disposition: 'applied' });
    expect(agentDecisions.fromRow({ ...base, status: 'dismissed', human_verdict: 'dismissed' })).toMatchObject({ result: 'succeeded', verification: 'failed', disposition: 'rejected' });
    const ignored = agentDecisions.fromRow({ ...base, status: 'ignored', human_verdict: 'ignored' });
    expect(ignored).toMatchObject({ result: 'succeeded', verification: 'overridden', disposition: 'no_action' });
    expect(runIndex.bucketsOf({ ...ignored, health: 'healthy', attention: null })).toMatchObject({ done: true, failed: false, attention: false });
    // auto-send: in flight, sent, failed
    expect(agentDecisions.fromRow({ ...base, workflow: 'sms_house_voice_auto_send', status: 'sending' })).toMatchObject({ lifecycle: 'running', laneId: 'sms_draft', area: 'sms' });
    expect(agentDecisions.fromRow({ ...base, workflow: 'sms_house_voice_auto_send', status: 'auto_sent' })).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' });
    const failed = agentDecisions.fromRow({ ...base, workflow: 'sms_house_voice_auto_send', status: 'auto_send_failed', correction_note: 'Auto-send did not go out: quiet hours' });
    expect(failed).toMatchObject({ lifecycle: 'terminal', result: 'errored', failureClass: 'provider', errorCode: 'auto_send_failed', errorMessage: 'Auto-send did not go out: quiet hours', detail: 'Auto-send did not go out: quiet hours' });
    expect(agentDecisions.fromRow({ ...base, status: 'auto_sent', correction_note: 'n/a' })).toMatchObject({ errorCode: null, errorMessage: null, detail: null });
    expect(runIndex.bucketsOf({ ...failed, health: 'healthy', attention: null })).toMatchObject({ failed: true, attention: true, done: false });
    // a deterministic guard keeps the SMS area with no lane; a business workflow is office; an unknown status surfaces
    expect(agentDecisions.fromRow({ ...base, workflow: 'comms_guards', status: 'auto_resolved' })).toMatchObject({ laneId: null, area: 'sms', disposition: 'no_action' });
    expect(agentDecisions.fromRow({ ...base, workflow: 'referral_reward', status: 'match' })).toMatchObject({ laneId: null, area: 'office', lifecycle: 'terminal', result: null });
  });

  test('call_log: processing_status → lifecycle with the processor heartbeat as the run heartbeat', () => {
    const base = { id: 'c', direction: 'inbound', duration_seconds: 125, recording_url: 'https://api.twilio.com/rec', created_at: ago(9e5), processing_started_at: ago(8e5), processing_heartbeat_at: ago(10e3), extraction_attempts: 2 };
    const live = callLog.fromRow({ ...base, processing_status: 'processing', transcription_status: 'completed' });
    // extraction_attempts counts failures: two failed + the pass in flight = 3 attempts; a row whose current state IS the failure counts just the failures; a success after one failure ran twice
    expect(live).toMatchObject({ lifecycle: 'running', lastHeartbeatAt: ago(10e3).toISOString(), attempts: 3, laneId: 'call_extraction', title: 'inbound · 2 min' });
    // the comms page routes the tab and the focused call from the hash (the Owed tab's own deep link)
    expect(live.link).toBe('/admin/communications#tab=calls&call=c');
    expect(callLog.fromRow({ ...base, processing_status: 'extraction_failed' }).attempts).toBe(2);
    expect(callLog.fromRow({ ...base, processing_status: 'processed', extraction_attempts: 1 }).attempts).toBe(2);
    expect(callLog.fromRow({ ...base, processing_status: 'processed', extraction_attempts: 0 }).attempts).toBe(1);
    expect(live.steps.map((s) => s.status)).toEqual(['done', 'running', 'skipped', 'skipped']);
    // the processor's stage vocabulary: 'valid' is the one extraction success; its *_failed values fail the step; enrichment = the enriched payload
    // every server-side writer of the call_log stage columns
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    const src = ['services', 'routes'].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, d, f), 'utf8'))).join('\n');
    // extractCallDataV2 returns { status: 'valid' } on success; the stored column takes that value
    expect(src).toMatch(/v2_extraction_status = 'valid'/);
    expect(callLog.V2_VALID).toBe('valid');
    for (const t of callLog.TRANSCRIBED) expect(src).toMatch(new RegExp(`transcription_status: '${t}'`));
    const done = callLog.fromRow({ ...base, processing_status: 'processed', v2_extraction_status: 'valid', transcription_status: 'summary_only', enriched: true });
    expect(done.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    const parseFailed = callLog.fromRow({ ...base, processing_status: 'processing', transcription_status: 'completed', v2_extraction_status: 'schema_failed' });
    expect(parseFailed.steps[1]).toMatchObject({ status: 'failed', detail: 'schema_failed' });
    // extraction_failed: the class follows the recorded v2 status — model output (incomplete) vs provider — and a bare one (any thrown exception: key, network) is infrastructure
    const { CALL_EXTRACTION_MAX_ATTEMPTS, EXTRACTION_RETRY_WINDOW_DAYS } = require('../config/call-extraction-retry');
    const exhausted = { ...base, extraction_attempts: CALL_EXTRACTION_MAX_ATTEMPTS };
    const extractionFailed = callLog.fromRow({ ...exhausted, processing_status: 'extraction_failed', v2_extraction_status: 'schema_failed' });
    expect(extractionFailed).toMatchObject({ lifecycle: 'terminal', result: 'errored', failureClass: 'incomplete', maxAttempts: CALL_EXTRACTION_MAX_ATTEMPTS, attempts: CALL_EXTRACTION_MAX_ATTEMPTS });
    expect(extractionFailed.steps[1].status).toBe('failed');
    expect(callLog.fromRow({ ...exhausted, processing_status: 'extraction_failed', v2_extraction_status: 'api_unavailable' }).failureClass).toBe('provider');
    expect(callLog.fromRow({ ...exhausted, processing_status: 'extraction_failed' }).failureClass).toBe('infrastructure');
    // … but a failure still inside the processor's retry limits is QUEUED work its sweep will claim again (the last failure stays as the code)
    // (the window is judged against the REAL clock — fixtures relative to it, not the frozen NOW)
    const realAgo = (ms) => new Date(Date.now() - ms);
    const retrying = callLog.fromRow({ ...base, processing_status: 'extraction_failed', extraction_attempts: 1, created_at: realAgo(864e5) });
    expect(retrying).toMatchObject({ lifecycle: 'queued', result: null, errorCode: 'extraction_failed', attempts: 1, maxAttempts: CALL_EXTRACTION_MAX_ATTEMPTS });
    expect(callLog.fromRow({ ...base, processing_status: 'extraction_failed', extraction_attempts: 1, created_at: realAgo((EXTRACTION_RETRY_WINDOW_DAYS + 1) * 864e5) }).lifecycle).toBe('terminal');
    // … only with media the sweep will claim (its gates): a non-empty recording — or a PAN-quarantined MASKED transcript — with real content (over 10 s, or PAN-quarantined); without them nothing retries it, so it is the terminal failure
    const eligible = { ...base, processing_status: 'extraction_failed', extraction_attempts: 1, created_at: realAgo(864e5) };
    expect(callLog.fromRow({ ...eligible, recording_url: null }).lifecycle).toBe('terminal');
    expect(callLog.fromRow({ ...eligible, recording_url: '' }).lifecycle).toBe('terminal');
    expect(callLog.fromRow({ ...eligible, duration_seconds: 8, recording_duration_seconds: null }).lifecycle).toBe('terminal');
    expect(callLog.fromRow({ ...eligible, duration_seconds: 8, recording_duration_seconds: 40 }).lifecycle).toBe('queued');
    expect(callLog.fromRow({ ...eligible, recording_url: null, pan_detected: true, has_transcript: true }).lifecycle).toBe('queued');
    expect(callLog.fromRow({ ...eligible, recording_url: null, pan_detected: true, has_transcript: false }).lifecycle).toBe('terminal');
    expect(callLog.fromRow({ ...eligible, duration_seconds: 3, pan_detected: true }).lifecycle).toBe('queued');
    // extraction landed, the lead write did not: the extract step stays done, the link step fails
    const linkFailed = callLog.fromRow({ ...base, processing_status: 'lead_creation_failed', v2_extraction_status: 'valid', transcription_status: 'completed', enriched: true });
    expect(linkFailed.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'failed']);
    expect(linkFailed.steps[3].detail).toBe('lead creation failed');
    expect(callLog.fromRow({ ...base, processing_status: 'voicemail' })).toMatchObject({ result: 'succeeded', disposition: 'no_action' });
    // no transcription = the processor's known-failed retry state, reclaimed by every sweep with no cap: QUEUED (never a done no-op, never terminal), the last failure as the code, the transcribe step failed, nothing after it attempted
    const noTranscript = callLog.fromRow({ ...base, processing_status: 'no_transcription', transcription_status: 'failed' });
    // … its retry policy is not the extraction limit: no cap, no count (attempts unknown, maxAttempts null)
    expect(noTranscript).toMatchObject({ lifecycle: 'queued', result: null, errorCode: 'no_transcription', attempts: 0, maxAttempts: null });
    expect(noTranscript.steps.map((s) => s.status)).toEqual(['failed', 'skipped', 'skipped', 'skipped']);
    expect(runIndex.bucketsOf({ ...noTranscript, health: 'healthy', attention: null })).toMatchObject({ active: true, failed: false, done: false });
    // … and only while a claimable recording is on the row (the sweep's gates; the PAN transcript-only branch does not reclaim this state): otherwise it is an errored transcription nothing will retry
    expect(callLog.fromRow({ ...base, processing_status: 'no_transcription', recording_url: null })).toMatchObject({ lifecycle: 'terminal', result: 'errored', failureClass: 'infrastructure', errorCode: 'no_transcription', maxAttempts: null });
    expect(callLog.fromRow({ ...base, processing_status: 'no_transcription', recording_url: null, pan_detected: true, has_transcript: true }).lifecycle).toBe('terminal');
    expect(callLog.fromRow({ ...base, processing_status: 'no_transcription', duration_seconds: 5 }).lifecycle).toBe('terminal');
    expect(callLog.fromRow({ ...base, processing_status: 'no_transcription', duration_seconds: 5, pan_detected: true }).lifecycle).toBe('queued');
    expect(callLog.fromRow({ ...base, processing_status: 'pending' }).lifecycle).toBe('queued');
    // a fresh, never-claimed call (NULL status) is queued work too
    expect(callLog.fromRow({ ...base, processing_status: null }).lifecycle).toBe('queued');
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

  test('agent_decisions: the action link is the hub decisions tab; a house-voice suggestion links to its comms thread, where it is actionable (Codex r13)', () => {
    const base = { id: 'd1', status: 'pending_review', created_at: ago(5e3), customer_id: 77 };
    expect(agentDecisions.fromRow({ ...base, workflow: 'contact_correction' }).link).toBe('/admin/agents?tab=decisions');
    expect(agentDecisions.fromRow({ ...base, workflow: 'sms_house_voice_suggest' }).link).toBe('/admin/communications?thread=77');
    expect(agentDecisions.fromRow({ ...base, workflow: 'sms_house_voice_suggest', customer_id: null }).link).toBe('/admin/communications');
  });

  test('job_health: a running job is live, a failing job is errored, a lane comes from its policy workflow_id', () => {
    const running = jobHealth.fromRow({ job_name: 'nightly_sweep', last_status: 'running', last_started_at: ago(5e3), last_finished_at: ago(3600e3), last_duration_ms: 400 });
    expect(running).toMatchObject({ lifecycle: 'running', finishedAt: null, durationMs: null, workflowId: 'nightly_sweep', title: 'nightly sweep' });
    expect(jobHealth.fromRow({ job_name: 'j', last_status: 'failed', consecutive_failures: 3, last_error: 'ENOTFOUND', last_started_at: ago(5e3), last_finished_at: ago(4e3) })).toMatchObject({ lifecycle: 'terminal', result: 'errored', failureClass: 'infrastructure', subtitle: '3 consecutive failures', detail: 'ENOTFOUND', attempts: 1, maxAttempts: null });
    const { LANE_RUNTIME, policyFor } = require('../services/agent-control/lane-policies');
    // every lane that names its cron: the job exists in the scheduler under that name, and the job reads with the lane's policy
    const scheduler = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
    const mapped = Object.entries(LANE_RUNTIME).filter(([, p]) => p.workflow_id);
    expect(mapped.map(([l]) => l).sort()).toEqual(['call_research', 'call_self_audit', 'shadow_judge', 'sms-operational-actions', 'voice_profile']);
    for (const [laneId, policy] of mapped) {
      const workflowSource = laneId === 'sms-operational-actions'
        ? require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'sms-operational-actions.js'), 'utf8')
        : scheduler;
      expect(workflowSource).toContain(`runExclusive('${policy.workflow_id}'`);
      if (laneId === 'sms-operational-actions') {
        expect(scheduler).toContain("require('./sms-operational-actions')");
        expect(scheduler).toContain('runSmsOperationalActions(');
      }
      expect(jobHealth.laneForJob(policy.workflow_id)).toBe(laneId);
    }
    const miner = jobHealth.fromRow({ job_name: 'call-research-miner', last_status: 'running', last_started_at: ago(7 * 60e3) });
    expect(miner.laneId).toBe('call_research');
    expect(policyFor(miner.laneId).stall_after_ms).toBe(900_000);
    expect(jobHealth.laneForJob('no_such_job')).toBeNull();
  });

  test('managed_sessions: a session row is a finished run keyed by its provider ref; turns are the steps', () => {
    // the row is written when the session is billed: created_at is the finish, start = finish − latency
    const ok = managedSessions.fromRow({ provider_ref: 'sess_1', lane_id: 'agent_bi', ok: true, served_model: 'claude-x', latency_ms: 5000, created_at: ago(9e3), turns: 3, turns_ok: 3 });
    expect(ok).toMatchObject({ key: 'managed_sessions:sess_1', lifecycle: 'terminal', result: 'succeeded', durationMs: 5000, stepsDone: 3, subtitle: 'claude-x · 3 turns', area: 'agents' });
    // a failed turn is not done
    expect(managedSessions.fromRow({ provider_ref: 's4', lane_id: 'agent_bi', ok: false, created_at: ago(9e3), turns: 3, turns_ok: 2 })).toMatchObject({ stepsDone: 2, stepsTotal: 3 });
    expect(ok.finishedAt).toBe(ago(9e3).toISOString());
    expect(ok.startedAt).toBe(ago(14e3).toISOString());
    expect(managedSessions.fromRow({ provider_ref: 's2', lane_id: 'agent_bi', ok: false, error_code: 'anthropic_529', created_at: ago(1e3) })).toMatchObject({ result: 'errored', failureClass: 'provider', errorCode: 'anthropic_529' });
    // a session the assistant keeps turning: created_at stays the first turn's; the newest turn is the finish and the span is the duration
    // the start is the FIRST turn's own timing (started_at from SQL): the session row's latency is the longest turn's, so a longer later turn must not move it
    const long = managedSessions.fromRow({ provider_ref: 's3', lane_id: 'customer_assistant', ok: true, latency_ms: 9000, created_at: ago(3600e3), started_at: ago(3604e3), last_turn_at: ago(2e3), turns: 6 });
    expect(long).toMatchObject({ startedAt: ago(3604e3).toISOString(), finishedAt: ago(2e3).toISOString(), durationMs: 3602e3, stepsDone: 6 });
    expect(managedSessions.fromRow({ ...long, latency_ms: 20000, started_at: ago(3604e3) }).startedAt).toBe(ago(3604e3).toISOString());
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
    spies.agentRuns.mockResolvedValue({ runs: [canonicalRun({ source: 'agent_runs', id: uid(1), sourceSystem: 'autonomous_runs', sourceRunId: uid(1), laneId: 'blog_draft', lifecycle: 'running', createdAt: ago(40 * 60e3), startedAt: ago(40 * 60e3), lastHeartbeatAt: ago(20 * 60e3), lastProgressAt: ago(20 * 60e3), canonical: true })], unavailable: false });
    spies.autonomousRuns.mockResolvedValue({ runs: [laneRun({ id: uid(2), createdAt: ago(30e3) }), laneRun({ id: uid(3), result: 'errored', createdAt: ago(45e3) })], unavailable: false });
    spies.messageDrafts.mockResolvedValue({ runs: [canonicalRun({ source: 'message_drafts', id: uid(1), laneId: 'sms_draft', lifecycle: 'waiting_human', createdAt: ago(3 * 864e5), lastProgressAt: ago(3 * 864e5) })], unavailable: false });
    const out = await runIndex.listRuns({ window: '7d', now: NOW });
    expect(out.runs.map((r) => r.key)).toEqual([`autonomous_runs:${uid(2)}`, `autonomous_runs:${uid(3)}`, `agent_runs:${uid(1)}`, `message_drafts:${uid(1)}`]);
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
    const { sql, bindings } = keyset(notMirrored(knex('call_log').select('id'), { source: 'call_log', idColumn: 'call_log.id' }), { start: 'created_at', id: 'id', cursor: { at: NOW, id: uid(9) }, limit: 3 }).toSQL().toNative();
    expect(sql).toMatch(/where not exists \(select 1 from "agent_runs" where "agent_runs"\."source_system" = \$1 and agent_runs\.source_run_id = call_log\.id::text\)/);
    expect(sql).toMatch(/\("created_at" < \$2 or \("created_at" = \$3 and "id" < \$4\)\)/);
    expect(sql).toMatch(/order by "created_at" desc, "id" desc limit \$5/);
    expect(bindings).toEqual(['call_log', NOW, NOW, uid(9), 3]);
  });

  test('status / area / lane filters; a lane filter skips single-lane adapters that cannot match', async () => {
    spies.autonomousRuns.mockImplementation(sqlLike([laneRun({ id: uid(1) }), laneRun({ id: uid(2), result: 'errored' })]));
    spies.messageDrafts.mockResolvedValue({ runs: [canonicalRun({ source: 'message_drafts', id: uid(1), laneId: 'sms_draft', lifecycle: 'waiting_human', createdAt: ago(1e3) })], unavailable: false });
    expect((await runIndex.listRuns({ status: 'failed', now: NOW })).runs.map((r) => r.key)).toEqual([`autonomous_runs:${uid(2)}`]);
    expect((await runIndex.listRuns({ status: 'done', now: NOW })).runs.map((r) => r.key)).toEqual([`autonomous_runs:${uid(1)}`]);
    expect((await runIndex.listRuns({ area: 'sms', now: NOW })).runs.map((r) => r.key)).toEqual([`message_drafts:${uid(1)}`]);
    jest.clearAllMocks();
    const byLane = await runIndex.listRuns({ lane: 'blog_draft', now: NOW });
    // equal start times: key desc keeps the order deterministic
    expect(byLane.runs.map((r) => r.key)).toEqual([`autonomous_runs:${uid(2)}`, `autonomous_runs:${uid(1)}`]);
    expect(spies.messageDrafts).not.toHaveBeenCalled();
    expect(spies.callLog).not.toHaveBeenCalled();
    expect(spies.agentDecisions).toHaveBeenCalled();
  });

  // A source behaving like its SQL: order (pagedAt desc, id desc), resume strictly after the cursor, cap at limit.
  const sqlLike = (rows) => async ({ cursor, limit }) => {
    const key = (r) => [new Date(r.pagedAt).getTime(), r.id];
    const sorted = [...rows].sort((x, y) => (key(y)[0] - key(x)[0]) || (key(y)[1] < key(x)[1] ? -1 : key(y)[1] > key(x)[1] ? 1 : 0));
    const at = cursor ? new Date(cursor.at).getTime() : null;
    const after = cursor ? sorted.filter((r) => key(r)[0] < at || (key(r)[0] === at && r.id < cursor.id)) : sorted;
    return { runs: after.slice(0, limit), unavailable: false };
  };

  test('keyset cursor: per-source positions resume each source strictly after its last row; pages walk the window; counts only on page 1; bad params are 400', async () => {
    const all = [1, 2, 3, 4, 5].map((i) => laneRun({ id: uid(i), createdAt: ago(i * 1000) }));
    spies.autonomousRuns.mockImplementation(sqlLike(all));
    const p1 = await runIndex.listRuns({ limit: 2, now: NOW });
    expect(p1.runs.map((r) => r.id)).toEqual([1, 2].map(uid));
    expect(p1.counts.all).toBe(5);
    expect(p1.countsCapped).toBe(false);
    expect(spies.autonomousRuns).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, limit: 2000 }));
    const p2 = await runIndex.listRuns({ limit: 2, cursor: p1.nextCursor, now: NOW });
    expect(p2.runs.map((r) => r.id)).toEqual([3, 4].map(uid));
    expect(p2.counts).toBeNull();
    // the position is the row's TEXT stamp, bound as-is to the adapter's raw column compare
    expect(spies.autonomousRuns).toHaveBeenCalledWith(expect.objectContaining({ cursor: { at: p1.runs[1].pagedAt, id: uid(2) }, limit: 3 }));
    expect(p1.runs[1].pagedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    const p3 = await runIndex.listRuns({ limit: 2, cursor: p2.nextCursor, now: NOW });
    expect(p3.runs.map((r) => r.id)).toEqual([5].map(uid));
    expect(p3.nextCursor).toBeNull();
    for (const bad of [{ cursor: '!!' }, { cursor: Buffer.from('{"p":{"nope":["x","y"]}}').toString('base64url') }, { cursor: Buffer.from('{"p":{"call_log":["2026-09-05T00:00:00Z","not-a-uuid"]}}').toString('base64url') }, { window: '90d' }, { status: 'weird' }, { area: 'nope' }, { lane: 'not_a_lane' }, { window: 'constructor' }, { limit: '2.5' }, { limit: 'ten' }]) {
      await expect(runIndex.listRuns({ ...bad, now: NOW })).rejects.toMatchObject({ status: 400 });
    }
  });

  test('a page never ends early: a status filter whose matches sit past non-matching slices keeps reading; equal timestamps page exactly', async () => {
    const mixed = [1, 2, 3, 4, 5, 6, 7].map((i) => laneRun({ id: uid(i), createdAt: ago(i * 1000), result: i === 6 || i === 7 ? 'errored' : 'succeeded' }));
    spies.autonomousRuns.mockImplementation(sqlLike(mixed));
    const f1 = await runIndex.listRuns({ limit: 1, status: 'failed', now: NOW });
    expect(f1.runs.map((r) => r.id)).toEqual([6].map(uid));
    const f2 = await runIndex.listRuns({ limit: 1, status: 'failed', cursor: f1.nextCursor, now: NOW });
    expect(f2.runs.map((r) => r.id)).toEqual([7].map(uid));
    expect(f2.nextCursor).toBeNull();
    // six rows at one timestamp, pages of two: every row exactly once
    const band = [1, 2, 3, 4, 5, 6].map((i) => laneRun({ id: uid(i), createdAt: ago(1000) }));
    spies.autonomousRuns.mockImplementation(sqlLike(band));
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 5 && (i === 0 || cursor); i += 1) {
      const pg = await runIndex.listRuns({ limit: 2, cursor, now: NOW });
      seen.push(...pg.runs.map((r) => r.id));
      cursor = pg.nextCursor;
    }
    expect(seen).toEqual([6, 5, 4, 3, 2, 1].map(uid));
    expect(cursor).toBeNull();
    // a filtered scan that spends its rounds on non-matching rows returns an EMPTY page with the advanced cursor
    const sparse = [...Array.from({ length: 30 }, (_, i) => laneRun({ id: uid(100 + i), createdAt: ago((i + 1) * 1000) })), laneRun({ id: uid(99), result: 'errored', createdAt: ago(99e3) })];
    spies.autonomousRuns.mockImplementation(sqlLike(sparse));
    let pg = await runIndex.listRuns({ limit: 1, status: 'failed', cursor: Buffer.from('{"p":{}}').toString('base64url'), now: NOW });
    expect(pg.runs).toEqual([]);
    expect(pg.nextCursor).not.toBeNull();
    let hops = 1;
    while (!pg.runs.length && pg.nextCursor && hops < 10) { pg = await runIndex.listRuns({ limit: 1, status: 'failed', cursor: pg.nextCursor, now: NOW }); hops += 1; }
    expect(pg.runs.map((r) => r.id)).toEqual([uid(99)]);
  });

  test('sources merge newest-first across pages, each resuming from its own position; a capped first page flags counts and offers a cursor', async () => {
    const content = [1, 3, 5].map((i) => laneRun({ id: uid(i), createdAt: ago(i * 1000) }));
    const drafts = [2, 4, 6].map((i) => canonicalRun({ source: 'message_drafts', id: uid(i), laneId: 'sms_draft', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(i * 1000) }));
    spies.autonomousRuns.mockImplementation(sqlLike(content));
    spies.messageDrafts.mockImplementation(sqlLike(drafts));
    const p1 = await runIndex.listRuns({ limit: 4, now: NOW });
    expect(p1.runs.map((r) => r.id)).toEqual([1, 2, 3, 4].map(uid));
    const p2 = await runIndex.listRuns({ limit: 4, cursor: p1.nextCursor, now: NOW });
    expect(p2.runs.map((r) => r.id)).toEqual([5, 6].map(uid));
    expect(p2.nextCursor).toBeNull();
    // a source that fills the first-page scan cap
    spies.messageDrafts.mockImplementation(async ({ cursor, limit }) => ({ runs: cursor ? [] : Array.from({ length: limit }, (_, i) => canonicalRun({ source: 'message_drafts', id: uid(1000 + i), laneId: 'sms_draft', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(i + 1) })), unavailable: false }));
    const hit = await runIndex.listRuns({ limit: 10, now: NOW });
    expect(hit.countsCapped).toBe(true);
    expect(hit.runs).toHaveLength(10);
    expect(hit.nextCursor).not.toBeNull();
  });
});

describe('getRun', () => {
  afterEach(() => jest.restoreAllMocks());

  test('a legacy row folds with its canonical mirror: canonical run + legacy steps when the mirror has none; calls by run id', async () => {
    jest.spyOn(callLog, 'get').mockResolvedValue({ run: canonicalRun({ source: 'call_log', id: uid(1), laneId: 'call_extraction', lifecycle: 'running', createdAt: ago(1e3), steps: [{ key: 'transcribe', status: 'done' }] }) });
    jest.spyOn(agentRuns, 'findMirror').mockResolvedValue(uid(9));
    jest.spyOn(agentRuns, 'get').mockResolvedValue({ run: canonicalRun({ source: 'agent_runs', id: uid(9), sourceSystem: 'call_log', sourceRunId: uid(1), laneId: 'call_extraction', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(1e3), canonical: true }), attempts: [{ attempt_no: 1 }], artifacts: [], events: [{ event_type: 'finished' }], workItem: { id: 'w' } });
    fixtures.llm_dispatch_log = [{ id: 1, row_kind: 'call' }];
    const d = await runIndex.getRun('call_log', uid(1), { now: NOW });
    // the timeline is the legacy steps; the counts stay the canonical run's (current attempt), not a recount
    expect(d.run).toMatchObject({ key: `agent_runs:${uid(9)}`, canonical: true, stepsDone: 0, stepsTotal: 0, health: 'healthy' });
    expect(d.steps).toEqual([{ key: 'transcribe', status: 'done' }]);
    expect(d.attempts).toHaveLength(1);
    expect(d.calls).toHaveLength(1);
    expect(d.legacy).toEqual({ source: 'call_log', id: uid(1) });
    expect(d.trace).toEqual({ id: null, calls: 1, capped: false });
    // more calls than the cap: the newest 500 (oldest first), and the truncation is stated
    fixtures.llm_dispatch_log = Array.from({ length: 501 }, (_, i) => ({ id: 501 - i, row_kind: 'call' })); // the query orders newest first
    const big = await runIndex.getRun('call_log', uid(1), { now: NOW });
    expect(big.calls).toHaveLength(500);
    expect(big.calls[0].id).toBe(2);
    expect(big.calls[499].id).toBe(501);
    expect(big.trace).toEqual({ id: null, calls: 500, capped: true });
  });

  test('opening a canonical run by its own id folds in the legacy row it mirrors (steps, session calls)', async () => {
    jest.spyOn(agentRuns, 'get').mockResolvedValue({ run: canonicalRun({ source: 'agent_runs', id: uid(7), sourceSystem: 'managed_sessions', sourceRunId: 'sess_9', laneId: 'agent_bi', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(1e3), canonical: true }), attempts: [], artifacts: [], events: [], workItem: null });
    const legacyGet = jest.spyOn(managedSessions, 'get').mockResolvedValue({ run: canonicalRun({ source: 'managed_sessions', id: 'sess_9', laneId: 'agent_bi', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(1e3), steps: [{ key: 'turn_1', status: 'done' }] }) });
    fixtures.llm_dispatch_log = [{ id: 1, row_kind: 'session_turn' }];
    const d = await runIndex.getRun('agent_runs', uid(7), { now: NOW });
    expect(legacyGet).toHaveBeenCalledWith('sess_9');
    expect(d.run.key).toBe(`agent_runs:${uid(7)}`);
    expect(d.steps).toEqual([{ key: 'turn_1', status: 'done' }]);
    expect(d.calls).toHaveLength(1);
    expect(d.legacy).toEqual({ source: 'managed_sessions', id: 'sess_9' });
    // a canonical run whose source system is not a ledger here (an S5 lane writing directly) has no legacy fold
    jest.spyOn(agentRuns, 'get').mockResolvedValue({ run: canonicalRun({ source: 'agent_runs', id: uid(8), sourceSystem: 'cron', sourceRunId: 'tick-1', workflowId: 'nightly', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(1e3), canonical: true }), attempts: [], artifacts: [], events: [], workItem: null });
    const e = await runIndex.getRun('agent_runs', uid(8), { now: NOW });
    expect(e.legacy).toBeNull();
    expect(e.steps).toEqual([]);
  });

  test('unknown source → 400; unknown id → null; a legacy row without a mirror is returned as-is', async () => {
    await expect(runIndex.getRun('nope', '1')).rejects.toMatchObject({ status: 400 });
    jest.spyOn(jobHealth, 'get').mockResolvedValue(null);
    expect(await runIndex.getRun('job_health', 'missing')).toBeNull();
    // a uuid-keyed source never asks PostgreSQL about a non-uuid id (22P02 → 500): it is not found; a name-keyed source takes any id
    const agentGet = jest.spyOn(agentRuns, 'get');
    const callGet = jest.spyOn(callLog, 'get');
    expect(await runIndex.getRun('agent_runs', 'not-a-uuid')).toBeNull();
    expect(await runIndex.getRun('call_log', 'CA1234')).toBeNull();
    expect(agentGet).not.toHaveBeenCalled();
    expect(callGet).not.toHaveBeenCalled();
    expect(jobHealth.get).toHaveBeenCalledWith('missing');
    // a legacy row that was pruned (session ledger rows keep 30 days) still opens through its durable mirror
    jest.spyOn(managedSessions, 'get').mockResolvedValue(null);
    jest.spyOn(agentRuns, 'findMirror').mockResolvedValueOnce(uid(11));
    jest.spyOn(agentRuns, 'get').mockResolvedValue({ run: canonicalRun({ source: 'agent_runs', id: uid(11), sourceSystem: 'managed_sessions', sourceRunId: 'sess_gone', laneId: 'agent_bi', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(1e3), canonical: true }), attempts: [], artifacts: [], events: [], workItem: null });
    const pruned = await runIndex.getRun('managed_sessions', 'sess_gone', { now: NOW });
    expect(pruned.run.key).toBe(`agent_runs:${uid(11)}`);
    expect(pruned.legacy).toBeNull();
    jest.spyOn(messageDrafts, 'get').mockResolvedValue({ run: canonicalRun({ source: 'message_drafts', id: uid(4), laneId: 'sms_draft', lifecycle: 'waiting_human', createdAt: ago(1e3) }) });
    jest.spyOn(agentRuns, 'findMirror').mockResolvedValue(null);
    const d = await runIndex.getRun('message_drafts', uid(4), { now: NOW });
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

describe('paging key', () => {
  test('pagedAt is the immutable creation stamp (an adapter may name its own); the span a run displays is not the page key', () => {
    const { canonicalRun } = require('../services/agent-control/sources/shape');
    const stamp = (d) => d.toISOString().replace('Z', '000Z'); // six fractional digits: one key across every source
    const r = canonicalRun({ source: 's', id: 1, createdAt: ago(9e3), startedAt: ago(2e3) });
    expect(r.pagedAt).toBe(stamp(ago(9e3)));
    expect(r.startedAt).toBe(ago(2e3).toISOString());
    expect(canonicalRun({ source: 's', id: 1, createdAt: ago(9e3), pagedAt: ago(7e3) }).pagedAt).toBe(stamp(ago(7e3)));
    // an adapter's own microsecond stamp (pagedAtColumn) passes through untouched
    expect(canonicalRun({ source: 's', id: 1, createdAt: ago(9e3), pagedAt: '2026-09-05T10:04:00.858123Z' }).pagedAt).toBe('2026-09-05T10:04:00.858123Z');
    const { pagedAtColumn } = require('../services/agent-control/sources/shape');
    const knex = require('knex')({ client: 'pg' });
    expect(pagedAtColumn(knex, 'd.created_at').toQuery()).toBe('to_char("d"."created_at" AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS paged_at');
  });

  test('the merge orders and bookmarks on pagedAt, never on the span a run displays (Codex r14)', async () => {
    const runIndex = require('../services/agent-control/run-index');
    const decisions = require('../services/agent-control/sources/agent-decisions');
    // row 2 is a scheduled decision: created second, its span is in the future; row 4 resumed just now
    const mk = (i, startedAt) => canonicalRun({ source: 'agent_decisions', id: uid(i), workflowId: 'w', lifecycle: 'terminal', result: 'succeeded', createdAt: ago(i * 1000), startedAt });
    const rows = [mk(1), mk(2, ago(-600e3)), mk(3), mk(4, ago(0))];
    // the adapter's SQL: (pagedAt desc, id desc), resuming strictly after the cursor
    const key = (r) => [new Date(r.pagedAt).getTime(), r.id];
    const spy = jest.spyOn(decisions, 'list').mockImplementation(async ({ cursor, limit }) => {
      const sorted = [...rows].sort((x, y) => (key(y)[0] - key(x)[0]) || (key(y)[1] < key(x)[1] ? -1 : 1));
      const at = cursor ? new Date(cursor.at).getTime() : null;
      const after = cursor ? sorted.filter((r) => key(r)[0] < at || (key(r)[0] === at && r.id < cursor.id)) : sorted;
      return { runs: after.slice(0, limit), unavailable: false };
    });
    try {
      const p1 = await runIndex.listRuns({ limit: 2, now: NOW });
      // creation order, not span order (a span-ordered merge would list 4 and 2 first)
      expect(p1.runs.map((r) => r.id)).toEqual([uid(1), uid(2)]);
      const p2 = await runIndex.listRuns({ limit: 2, cursor: p1.nextCursor, now: NOW });
      // the source resumes from row 2's pagedAt — its creation — not from its future span
      expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: { at: rows[1].pagedAt, id: uid(2) } }));
      expect(new Date(rows[1].pagedAt).getTime()).toBeLessThan(new Date(rows[1].startedAt).getTime());
      expect(p2.runs.map((r) => r.id)).toEqual([uid(3), uid(4)]);
      expect(p2.nextCursor).toBeNull();
    } finally { spy.mockRestore(); }
  });
});
