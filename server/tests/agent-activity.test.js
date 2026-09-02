// Agent Activity feed builder: the rows → items mapping the Activity tab
// renders. Pure fixtures; the DB loader is exercised only through the gate
// (off → { available: false }) so the suite needs no database.
process.env.GATE_AGENT_ACTIVITY = '';

jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('db must not be touched while the gate is off'); });
  fn.raw = jest.fn();
  return fn;
});

const { buildActivity, runStatus, getActivity, clampWindowHours } = require('../services/agent-activity');

const RUN_BASE = {
  id: 'run-1',
  action_type: 'new_post',
  page_type: 'blog',
  shadow_mode: false,
  created_at: '2026-09-02T10:00:00Z',
  claimed_at: '2026-09-02T10:00:01Z',
  completed_at: '2026-09-02T10:04:00Z',
  total_ms: 239000,
  claim_ms: 120,
  brief_ms: 3000,
  agent_ms: 180000,
  uniqueness_gate_ms: 900,
  quality_gate_ms: 40000,
  seo_completion_gate_ms: null,
  publish_ms: null,
  index_submit_ms: null,
  link_plan_ms: null,
  uniqueness_gate_result: { ok: true },
  quality_gate_result: { ok: true, total_score: 88, min_total_score: 80 },
  seo_completion_gate_result: null,
  draft_payload: JSON.stringify({ title: 'How to Get Rid of Ghost Ants' }),
};

describe('runStatus', () => {
  it('maps outcomes to feed statuses', () => {
    expect(runStatus({ outcome: 'completed_published' })).toBe('completed');
    expect(runStatus({ outcome: 'completed_pending_review' })).toBe('awaiting_review');
    expect(runStatus({ outcome: 'skipped_gate_fail' })).toBe('blocked');
    expect(runStatus({ outcome: 'skipped_no_opportunity' })).toBe('skipped');
    expect(runStatus({ outcome: 'failed_agent' })).toBe('failed');
    expect(runStatus({ outcome: 'publishing_named_competitor' })).toBe('running');
    expect(runStatus({ outcome: 'deferred_publish_cap' })).toBe('skipped');
    expect(runStatus({ outcome: 'completed_no_changes' })).toBe('completed');
    expect(runStatus({ outcome: null, completed_at: null })).toBe('running');
  });
});

describe('buildActivity', () => {
  it('turns a pending-review run into an awaiting_review item with stage steps', () => {
    const { items, summary, agents } = buildActivity({
      runs: [{ ...RUN_BASE, outcome: 'completed_pending_review' }],
    });
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.id).toBe('run:run-1');
    expect(item.agent).toBe('Blog Content Engine');
    expect(item.title).toBe('How to Get Rid of Ghost Ants');
    expect(item.status).toBe('awaiting_review');
    expect(item.link).toBe('/admin/blog?tab=autopilot');
    expect(item.stepsTotal).toBe(9);
    expect(item.stepsDone).toBe(5);
    expect(item.steps.map((s) => s.status)).toEqual([
      'done', 'done', 'done', 'done', 'done', 'not_started', 'not_started', 'not_started', 'not_started',
    ]);
    expect(summary.awaiting_review).toBe(1);
    expect(agents).toEqual(['Blog Content Engine']);
  });

  it('marks a failed gate as a blocked step with the failure names', () => {
    const { items } = buildActivity({
      runs: [{
        ...RUN_BASE,
        outcome: 'skipped_gate_fail',
        skip_reason: 'quality_gate',
        quality_gate_result: { ok: false, hard_failures: [{ name: 'reentry_safety_claim' }], total_score: 40, min_total_score: 80 },
      }],
    });
    const item = items[0];
    expect(item.status).toBe('blocked');
    const gate = item.steps.find((s) => s.key === 'quality_gate');
    expect(gate.status).toBe('blocked');
    expect(gate.detail).toBe('reentry_safety_claim');
    expect(item.detail).toBe('quality gate');
  });

  it('projected title columns win over the raw payload; an error-shaped gate result becomes the step detail', () => {
    const { items } = buildActivity({
      runs: [{
        ...RUN_BASE,
        draft_payload: undefined,
        draft_title: null,
        draft_frontmatter_title: 'Frontmatter Title',
        outcome: 'skipped_gate_fail',
        skip_reason: 'uniqueness_gate',
        uniqueness_gate_result: { ok: false, error: 'uniqueness_gate_unavailable' },
      }],
    });
    expect(items[0].title).toBe('Frontmatter Title');
    expect(items[0].steps.find((s) => s.key === 'uniqueness_gate').detail).toBe('uniqueness gate unavailable');
  });

  it('an open approval outranks the skip reason in the detail line', () => {
    const { items } = buildActivity({
      runs: [{ ...RUN_BASE, outcome: 'completed_pending_review', skip_reason: 'named_competitor_review' }],
      approvals: [{ run_id: 'run-1', status: 'awaiting_reply', token: 'EA-aaaa1111' }],
    });
    expect(items[0].detail).toBe('Awaiting emailed reply (EA-aaaa1111)');
  });

  it('describes proactive drafts by their lane, reply drafts by intent', () => {
    const { items } = buildActivity({
      drafts: [
        { id: 'p1', customer_name: 'Sam Sample', campaign_type: 'reactivation', intent: null, created_at: '2026-09-02T12:00:00Z' },
        { id: 'p2', customer_name: null, purpose: 'balance_reminder', intent: null, created_at: '2026-09-02T11:00:00Z' },
        { id: 'r1', customer_name: 'Pat Tester', intent: 'reschedule_request', created_at: '2026-09-02T10:00:00Z' },
      ],
    });
    expect(items.map((i) => [i.title, i.subtitle])).toEqual([
      ['Draft for Sam Sample', 'reactivation campaign'],
      ['Proactive draft', 'balance reminder'],
      ['Reply draft for Pat Tester', 'reschedule request'],
    ]);
  });

  it('shows the running stage on an in-flight run', () => {
    const { items } = buildActivity({
      runs: [{ ...RUN_BASE, outcome: null, completed_at: null, uniqueness_gate_ms: null, quality_gate_ms: null, uniqueness_gate_result: null, quality_gate_result: null }],
    });
    const item = items[0];
    expect(item.status).toBe('running');
    expect(item.steps.find((s) => s.key === 'uniqueness_gate').status).toBe('running');
    expect(item.steps.filter((s) => s.status === 'running')).toHaveLength(1);
  });

  it('an awaiting emailed reply overrides a completed outcome and carries the token', () => {
    const { items } = buildActivity({
      runs: [{ ...RUN_BASE, outcome: 'completed_published', published_url: 'https://wavespestcontrol.com/blog/ghost-ants' }],
      approvals: [{ run_id: 'run-1', status: 'awaiting_reply', token: 'EA-12ab34cd' }],
    });
    expect(items[0].status).toBe('awaiting_review');
    expect(items[0].detail).toBe('Awaiting emailed reply (EA-12ab34cd)');
    expect(items[0].link).toBe('/admin/blog?tab=autopilot');
  });

  it('includes pending SMS drafts and failing cron jobs, newest first; healthy jobs are only counted', () => {
    const { items, summary } = buildActivity({
      drafts: [{ id: 'd1', customer_name: 'Pat Tester', intent: 'reschedule_request', drafter: 'house_voice', draft_ms: 900, created_at: '2026-09-02T11:00:00Z', inbound_message: 'Can we move Friday?', draft_response: 'Sure —' }],
      jobs: [
        { job_name: 'unworked_comms_watcher', last_started_at: '2026-09-02T09:00:00Z', last_finished_at: '2026-09-02T09:00:04Z', last_status: 'success', last_duration_ms: 4000, consecutive_failures: 0 },
        { job_name: 'impact_verdict_digest', last_started_at: '2026-09-02T08:00:00Z', last_finished_at: '2026-09-02T08:00:01Z', last_status: 'failed', last_error: 'ECONNRESET', last_duration_ms: 1000, consecutive_failures: 3 },
      ],
    });
    expect(items.map((i) => i.id)).toEqual(['draft:d1', 'job:impact_verdict_digest']);
    expect(items[0].status).toBe('awaiting_review');
    expect(items[0].title).toBe('Reply draft for Pat Tester');
    expect(items[0].link).toBe('/admin/agents?tab=drafts');
    expect(items[1].status).toBe('failed');
    expect(items[1].subtitle).toBe('3 consecutive failures');
    expect(items[1].detail).toBe('ECONNRESET');
    expect(summary).toMatchObject({ total: 2, awaiting_review: 1, failed: 1, healthyJobs: 1 });
  });
});

describe('getActivity gate', () => {
  it('answers available:false without touching the database while GATE_AGENT_ACTIVITY is off', async () => {
    const feed = await getActivity({ windowHours: 24 });
    expect(feed).toEqual({ available: false, items: [], agents: [], summary: expect.objectContaining({ total: 0, healthyJobs: 0 }) });
  });
});

describe('clampWindowHours', () => {
  it('defaults to 24 and caps at 14 days', () => {
    expect(clampWindowHours(undefined)).toBe(24);
    expect(clampWindowHours('abc')).toBe(24);
    expect(clampWindowHours(168)).toBe(168);
    expect(clampWindowHours(99999)).toBe(24 * 14);
  });
});
