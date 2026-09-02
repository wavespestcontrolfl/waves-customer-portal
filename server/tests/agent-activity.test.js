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

  it('dates a straggler run by its open approval and marks decided runs completed / skipped', () => {
    const { items } = buildActivity({
      runs: [
        { ...RUN_BASE, id: 'old', outcome: 'completed_pending_review', claimed_at: '2026-08-30T10:00:00Z', created_at: '2026-08-30T10:00:00Z' },
        { ...RUN_BASE, id: 'ok', outcome: 'completed_pending_review' },
        { ...RUN_BASE, id: 'no', outcome: 'completed_pending_review' },
        { ...RUN_BASE, id: 'ui', outcome: 'completed_pending_review', trust_build_approved_at: '2026-09-02T12:00:00Z' },
        { ...RUN_BASE, id: 'notes', outcome: 'completed_pending_review', reviewer_notes: 'gate summary seeded at park time' },
        { ...RUN_BASE, id: 'unsent', outcome: 'completed_pending_review' },
        { ...RUN_BASE, id: 'exec', outcome: 'completed_pending_review' },
        { ...RUN_BASE, id: 'boom', outcome: 'completed_pending_review' },
      ],
      approvals: [
        { run_id: 'old', status: 'awaiting_reply', token: 'EA-old00001', created_at: '2026-09-02T11:30:00Z', email_sent_at: '2026-09-02T11:30:05Z' },
        { run_id: 'unsent', status: 'awaiting_reply', token: 'EA-unsent01', created_at: '2026-09-02T11:40:00Z', email_sent_at: null, last_error: 'SMTP 421' },
        { run_id: 'exec', status: 'executing', token: 'EA-exec0001', created_at: '2026-09-02T10:00:00Z', decided_at: '2026-09-02T12:30:00Z' },
        { run_id: 'boom', status: 'failed', token: 'EA-boom0001', created_at: '2026-09-02T10:00:00Z', decided_at: '2026-09-02T12:40:00Z', last_error: 'publish: astro PR 502' },
        { run_id: 'ok', status: 'approved', token: 'EA-ok000001', created_at: '2026-08-30T09:00:00Z', decided_at: '2026-09-02T09:15:00Z' },
        { run_id: 'no', status: 'rejected', token: 'EA-no000001', created_at: '2026-09-02T09:00:00Z' },
      ],
    });
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by['run:old'].status).toBe('awaiting_review');
    expect(by['run:old'].startedAt).toBe('2026-09-02T11:30:00.000Z');
    expect(by['run:ok']).toMatchObject({ status: 'completed', detail: 'approved by email reply', startedAt: '2026-09-02T09:15:00.000Z' });
    expect(by['run:no']).toMatchObject({ status: 'skipped', detail: 'rejected by email reply' });
    expect(by['run:ui']).toMatchObject({ status: 'completed', detail: 'Approved in review' });
    // reviewer_notes alone is not a decision — the runner seeds it at park time
    expect(by['run:notes'].status).toBe('awaiting_review');
    expect(by['run:unsent']).toMatchObject({ status: 'blocked', detail: 'Approval email not delivered yet (EA-unsent01): SMTP 421' });
    expect(by['run:exec']).toMatchObject({ status: 'running', detail: 'Applying the emailed decision', startedAt: '2026-09-02T12:30:00.000Z' });
    expect(by['run:boom']).toMatchObject({ status: 'failed', detail: 'Emailed decision failed: publish: astro PR 502' });
  });

  it('the newest approval row per run wins regardless of input order', () => {
    const rows = [
      { run_id: 'run-1', status: 'awaiting_reply', token: 'EA-newest01', created_at: '2026-09-02T12:00:00Z', email_sent_at: '2026-09-02T12:00:05Z' },
      { run_id: 'run-1', status: 'awaiting_reply', token: 'EA-older001', created_at: '2026-09-02T08:00:00Z', email_sent_at: null, last_error: 'SMTP 421' },
      { run_id: 'run-1', status: 'failed', token: 'EA-failed01', created_at: '2026-09-01T08:00:00Z' },
    ];
    for (const approvals of [rows, [...rows].reverse()]) {
      const { items } = buildActivity({ runs: [{ ...RUN_BASE, outcome: 'completed_pending_review' }], approvals });
      expect(items[0].status).toBe('awaiting_review');
      expect(items[0].detail).toBe('Awaiting emailed reply (EA-newest01)');
    }
    // a newer terminal row after an older awaiting one means DECIDED, not awaiting
    const decidedLater = [
      { run_id: 'run-1', status: 'awaiting_reply', token: 'EA-older001', created_at: '2026-09-02T08:00:00Z', email_sent_at: '2026-09-02T08:00:05Z' },
      { run_id: 'run-1', status: 'approved', token: 'EA-older001', created_at: '2026-09-02T09:00:00Z' },
    ];
    for (const approvals of [decidedLater, [...decidedLater].reverse()]) {
      const { items } = buildActivity({ runs: [{ ...RUN_BASE, outcome: 'completed_pending_review' }], approvals });
      expect(items[0]).toMatchObject({ status: 'completed', detail: 'approved by email reply' });
    }
    // pg returns Date instances — String(Date) starts with the weekday and
    // must not be what decides "newest"
    const asDates = [
      { run_id: 'run-1', status: 'awaiting_reply', token: 'EA-sun00001', created_at: new Date('2026-09-06T08:00:00Z'), email_sent_at: '2026-09-06T08:00:05Z' },
      { run_id: 'run-1', status: 'approved', token: 'EA-tue00001', created_at: new Date('2026-09-08T09:00:00Z') },
    ];
    const { items: dated } = buildActivity({ runs: [{ ...RUN_BASE, outcome: 'completed_pending_review' }], approvals: asDates });
    expect(dated[0]).toMatchObject({ status: 'completed', detail: 'approved by email reply' });
  });

  it('an open approval outranks the skip reason in the detail line', () => {
    const { items } = buildActivity({
      runs: [{ ...RUN_BASE, outcome: 'completed_pending_review', skip_reason: 'named_competitor_review' }],
      approvals: [{ run_id: 'run-1', status: 'awaiting_reply', token: 'EA-aaaa1111', email_sent_at: '2026-09-02T10:05:00Z' }],
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
      approvals: [{ run_id: 'run-1', status: 'awaiting_reply', token: 'EA-12ab34cd', email_sent_at: '2026-09-02T10:05:00Z' }],
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
        { job_name: 'stuck_sweep', last_started_at: '2026-09-02T07:00:00Z', last_finished_at: '2026-09-01T07:00:09Z', last_status: 'running', last_duration_ms: 9000, consecutive_failures: 0 },
      ],
    });
    expect(items.map((i) => i.id)).toEqual(['draft:d1', 'job:impact_verdict_digest', 'job:stuck_sweep']);
    // a running job never shows its previous run's finish/duration
    expect(items[2]).toMatchObject({ status: 'running', finishedAt: null, durationMs: null });
    expect(items[0].status).toBe('awaiting_review');
    expect(items[0].title).toBe('Reply draft for Pat Tester');
    expect(items[0].link).toBe('/admin/agents?tab=drafts');
    expect(items[1].status).toBe('failed');
    expect(items[1].subtitle).toBe('3 consecutive failures');
    expect(items[1].detail).toBe('ECONNRESET');
    expect(summary).toMatchObject({ total: 3, awaiting_review: 1, failed: 1, running: 1, healthyJobs: 1 });
  });
});

describe('buildActivity digests', () => {
  it('maps ops_digest bell rows by subject prefix and read state', () => {
    const { items } = buildActivity({
      digests: [
        { id: 'n1', title: 'ACT: 3 promised quotes never went out — oldest 4d', body: 'Line one\nLine two', link: '/admin/pipeline', metadata: { opsKey: 'promised-estimate' }, read_at: null, created_at: '2026-09-02T07:11:00Z' },
        { id: 'n2', title: 'FIX: lead-to-cash invariants — 2 violations', body: 'x', link: '/admin/invoices', metadata: JSON.stringify({ opsKey: 'lead-to-cash-invariants' }), read_at: null, created_at: '2026-09-02T06:55:00Z' },
        { id: 'n3', title: 'ACT: brain review — 1 blocked', body: 'y', link: '/admin/knowledge', metadata: null, read_at: '2026-09-02T09:00:00Z', created_at: '2026-09-02T06:00:00Z' },
        { id: 'n4', title: 'FIRST: autopay charge on a card hold', body: 'z', link: null, metadata: {}, read_at: null, created_at: '2026-09-02T05:00:00Z' },
        { id: 'n5', title: '[Review] Price-match draft ready — 3 opportunities for Mark', body: 'w', link: '/admin/price-match', metadata: { opsKey: 'price-match-owner-copy' }, read_at: null, created_at: '2026-09-02T04:00:00Z' },
      ],
    });
    expect(items.map((i) => [i.id, i.status, i.title, i.agent])).toEqual([
      ['digest:n1', 'awaiting_review', '3 promised quotes never went out — oldest 4d', 'Waves Ops'],
      ['digest:n2', 'failed', 'lead-to-cash invariants — 2 violations', 'Waves Ops'],
      ['digest:n3', 'completed', 'brain review — 1 blocked', 'Waves Ops'],
      ['digest:n4', 'completed', 'autopay charge on a card hold', 'Waves Ops'],
      ['digest:n5', 'awaiting_review', 'Price-match draft ready — 3 opportunities for Mark', 'Waves Ops'],
    ]);
    expect(items[0].subtitle).toBe('promised estimate · needs you');
    expect(items[0].notificationId).toBe('n1');
    expect(items[1].subtitle).toBe('lead to cash invariants · needs a fix');
    expect(items[0].link).toBe('/admin/pipeline');
    expect(items[0].detail).toBe('Line one\nLine two');
    // never truncated — in-app mode this is the only copy of the digest
    const long = 'x'.repeat(5000);
    expect(buildActivity({ digests: [{ id: 'n5', title: 'ACT: long', body: long, created_at: '2026-09-02T05:00:00Z' }] }).items[0].detail).toHaveLength(5000);
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
