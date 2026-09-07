/**
 * Ops queue — read-only projection of every long-running lane (GATE_ADMIN_OPS_QUEUE).
 * Invariants: every lane is isolated (one failing lane degrades to an error row);
 * statuses normalize to pending / parked / failed; failed-first ordering;
 * the route is admin-only and 404 while the gate is off.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const fixtures = {};
const mockJobHealth = jest.fn();
const mockReviewItems = jest.fn();

// Minimal knex-shaped stub: every builder method chains, awaiting resolves the
// table's fixture rows (or throws when the fixture is an Error).
jest.mock('../models/db', () => {
  const make = (table) => {
    const exclusions = [];
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'whereNot') return (key, value) => { exclusions.push([key, value]); return chain; };
        if (prop === 'then') {
          const fixture = fixtures[table];
          const rows = Array.isArray(fixture) ? fixture.filter(row => exclusions.every(([key, value]) => row[key] !== value)) : fixture;
          return (resolve, reject) => (rows instanceof Error ? reject(rows) : resolve(rows || []));
        }
        return () => chain;
      },
    });
    return chain;
  };
  return jest.fn((table) => make(table));
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/intelligence-bar/job-health-tools', () => ({
  getScheduledJobHealth: (...a) => mockJobHealth(...a),
}));
jest.mock('../services/content/autonomous-review-queue', () => ({
  listReviewItems: (...a) => mockReviewItems(...a),
}));
jest.mock('../services/content/email-approvals', () => ({ EXECUTING_RECOVERY_MINUTES: 15 }));
jest.mock('../services/service-report/delivery-queue', () => ({ STALE_CLAIM_MS: 30 * 60 * 1000 }));
jest.mock('../services/service-report/pdf-queue', () => ({ STALE_CLAIM_MS: 30 * 60 * 1000 }));
jest.mock('../services/call-recording-processor', () => ({ CALL_EXTRACTION_MAX_ATTEMPTS: 3 }));
// The stall rule is the watchdog's; here it is a fixture: c1 is stalled.
jest.mock('../services/call-processing-stall-watchdog', () => ({
  computeStalledCalls: (rows) => rows.filter((r) => r.id === 'c1'),
  MIN_DURATION_SECONDS: 11,
}));

const { getOpsQueue, LANES } = require('../services/ops-queue');

const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60000).toISOString();

describe('getOpsQueue', () => {
  beforeEach(() => {
    for (const k of Object.keys(fixtures)) delete fixtures[k];
    mockJobHealth.mockResolvedValue({ jobs: [
      { job: 'pricing-sweep', state: 'failing', consecutive_failures: 3, last_error: 'boom', last_started_at: ago(30) },
      { job: 'ga4-sync', state: 'stale', last_success_age_minutes: 20000, last_success_at: ago(20000) },
      { job: 'digest', state: 'running', last_started_at: ago(2) },
      // Stuck past its budget is recoverable (the next tick may overwrite it) — parked, not failed.
      { job: 'nightly-audit', state: 'stuck', last_started_at: ago(90) },
      { job: 'healthy-one', state: 'healthy', last_success_at: ago(5) },
    ] });
    mockReviewItems.mockResolvedValue({ status: 'pending_review', counts: {}, items: [
      // The shape listReviewItems actually returns (buildReviewItem): targeting fields, no brief object.
      { id: 'opp-1', skip_reason: 'affiliate_review', target_keyword: 'Best ant bait for lanais', query: 'ant bait lanai', run: { completed_at: ago(60) } },
    ] });
    fixtures.call_log = [
      { id: 'c1', from_phone: '+15550000100', direction: 'inbound', processing_status: 'processing', processing_started_at: ago(45), created_at: ago(50) },
      // A live heartbeat beats an old start: still pending, not stalled.
      { id: 'c5', from_phone: '+15550000105', direction: 'inbound', processing_status: 'processing', processing_started_at: ago(45), processing_heartbeat_at: ago(1), created_at: ago(50) },
      { id: 'c2', from_phone: '+15550000101', direction: 'inbound', processing_status: null, updated_at: ago(1), created_at: ago(1) },
      { id: 'c3', from_phone: '+15550009999', to_phone: '+15550000102', direction: 'outbound', processing_status: 'extraction_failed', extraction_attempts: 3, created_at: ago(90) },
      // no_transcription is retried promptly by the processor — pending.
      { id: 'c7', from_phone: '+15550000107', direction: 'inbound', processing_status: 'no_transcription', created_at: ago(400) },
      // Under the retry cap: the processor re-runs it — pending, not failed.
      { id: 'c6', from_phone: '+15550000106', direction: 'inbound', processing_status: 'extraction_failed', extraction_attempts: 1, created_at: ago(30) },
      // Under the cap but created outside the sweep's 7-day fence (a force-reprocess
      // of an old call that failed again): nothing retries it — failed, dated by the failure.
      { id: 'c8', from_phone: '+15550000108', direction: 'inbound', processing_status: 'extraction_failed', extraction_attempts: 1, created_at: ago(20000), updated_at: ago(15) },
    ];
    fixtures.content_email_approvals = [
      { id: 'ea-1', token: 'EA-1a2b3c4d', kind: 'named_competitor_review', status: 'awaiting_reply', email_sent_at: ago(10), created_at: ago(10) },
      { id: 'ea-2', token: 'EA-ffffffff', kind: 'trust_build_1_of_3', status: 'failed', last_error: 'smtp', created_at: ago(20000), updated_at: ago(200) },
      // Email not yet sent (poller retries): nobody has anything to answer — pending, not parked.
      { id: 'ea-3', token: 'EA-33333333', kind: 'trust_build_2_of_3', status: 'awaiting_reply', email_sent_at: null, created_at: ago(3) },
      // Healthy execution inside the recovery window — pending.
      { id: 'ea-4', token: 'EA-44444444', kind: 'trust_build_3_of_3', status: 'executing', email_sent_at: ago(30), created_at: ago(30), updated_at: ago(2) },
      // Executing past EXECUTING_RECOVERY_MINUTES: an orphaned claim — parked.
      { id: 'ea-5', token: 'EA-55555555', kind: 'named_competitor_review', status: 'executing', email_sent_at: ago(60), created_at: ago(60), updated_at: ago(40) },
    ];
    fixtures.ib_pending_actions = [
      { id: 'pa-1', tool_name: 'send_sms', summary: 'send_sms — to: +15550000100, message: SECRET SMS BODY', context: 'customers', expires_at: ago(-5), created_at: ago(1) },
    ];
    fixtures.service_report_deliveries = [
      { id: 'd1', service_record_id: 'rec-11111111', channel: 'email', status: 'queued', attempts: 0, max_attempts: 5, created_at: ago(3) },
      { id: 'd2', service_record_id: 'rec-22222222', channel: 'email', status: 'failed', attempts: 5, max_attempts: 5, failed_at: ago(30), created_at: ago(60) },
      // Live claim inside STALE_CLAIM_MS — pending.
      { id: 'd3', service_record_id: 'rec-44444444', channel: 'email', status: 'sending', attempts: 1, max_attempts: 5, locked_at: ago(5), created_at: ago(6) },
      // Claim older than STALE_CLAIM_MS: orphaned (the recovery sweep's rule) — parked.
      { id: 'd4', service_record_id: 'rec-55555555', channel: 'email', status: 'sending', attempts: 1, max_attempts: 5, locked_at: ago(45), created_at: ago(50) },
    ];
    fixtures.service_report_pdf_jobs = [
      { id: 'p1', service_record_id: 'rec-33333333', status: 'rendering', locked_at: ago(2), created_at: ago(2) },
      { id: 'p2', service_record_id: 'rec-66666666', status: 'rendering', locked_at: ago(40), created_at: ago(41) },
    ];
    fixtures.dispatch_alerts = [
      { id: 'da-1', severity: 'warn', payload: JSON.stringify({ source: 'typed_completion', customerName: 'Test Customer', serviceType: 'termite_retreat', suggestedFollowupDate: '2026-09-20' }), created_at: ago(500) },
    ];
    fixtures.admin_alerts = [
      { id: 'retired-readiness', type: 'lawn_protocol_readiness', severity: 'critical', title: 'Retired readiness snapshot', last_seen_at: ago(1) },
      { id: 'aa-1', type: 'closeout_contradiction', severity: 'high', title: 'Closeout contradiction on a test visit', href: '/admin/dispatch', last_seen_at: ago(20) },
      { id: 'aa-2', type: 'missing_required_photos', severity: 'low', title: 'Missing photos', last_seen_at: ago(40) },
      { id: 'aa-3', type: 'report_delivery_incomplete', status: 'snoozed', severity: 'medium', title: 'Snooze elapsed alert', last_seen_at: ago(60) },
    ];
  });

  test('normalizes every lane to pending / parked / failed with failed-first ordering and lane totals', async () => {
    const q = await getOpsQueue();
    expect(q.lanes.map((l) => l.key)).toEqual(LANES.map((l) => l.key));
    const by = Object.fromEntries(q.lanes.map((l) => [l.key, l]));

    expect(by.jobs.items.map((i) => [i.id, i.status])).toEqual([
      ['pricing-sweep', 'failed'], ['nightly-audit', 'parked'], ['ga4-sync', 'parked'], ['digest', 'pending'],
    ]);
    expect(by.jobs.items[1].detail).toMatch(/marked running for over an hour/);
    expect(by.jobs.items[0].detail).toMatch(/3 consecutive failures — boom/);

    expect(by.calls.items.map((i) => [i.id, i.status])).toEqual([
      ['c8', 'failed'], ['c3', 'failed'], ['c1', 'parked'], ['c2', 'pending'], ['c6', 'pending'], ['c5', 'pending'], ['c7', 'pending'],
    ]);
    expect(by.calls.items[0]).toMatchObject({ at: ago(15), detail: expect.stringMatching(/no automatic retry/) });
    expect(by.calls.items.find((i) => i.id === 'c7').detail).toMatch(/retry scheduled/);
    expect(by.calls.items.find((i) => i.id === 'c6').detail).toMatch(/retry scheduled \(1\/3\)/);
    expect(by.calls.items[2].detail).toMatch(/stalled in processing/);
    expect(by.calls.items[1].title).toBe('Outbound call · +15550000102'); // the far end, not the Waves number
    expect(by.calls.items.find((i) => i.id === 'c5').status).toBe('pending');

    expect(by.content.items).toEqual([expect.objectContaining({ id: 'opp-1', status: 'parked', title: 'Best ant bait for lanais', detail: 'parked: affiliate review' })]);
    expect(by.approvals.items.map((i) => [i.id, i.status])).toEqual([
      ['ea-2', 'failed'], ['ea-1', 'parked'], ['ea-5', 'parked'], ['ea-3', 'pending'], ['ea-4', 'pending'],
    ]);
    expect(by.approvals.items[0].at).toBe(ago(200)); // the failure event, not the request
    expect(by.approvals.items.find((i) => i.id === 'ea-5').detail).toMatch(/orphaned claim/);
    expect(by.approvals.items.find((i) => i.id === 'ea-3').detail).toBe('approval email not yet sent');
    expect(by.ib.items).toEqual([expect.objectContaining({ id: 'pa-1', status: 'parked', title: 'Send sms' })]);
    expect(JSON.stringify(by.ib)).not.toContain('SECRET');
    expect(by.reports.items.map((i) => [i.id, i.status])).toEqual([
      ['delivery:d2', 'failed'], ['pdf:p2', 'parked'], ['delivery:d4', 'parked'],
      ['pdf:p1', 'pending'], ['delivery:d1', 'pending'], ['delivery:d3', 'pending'], // newest first within a status
    ]);
    expect(by.reports.items[1].detail).toMatch(/rendering claim older than 30 minutes/);
    expect(by.reports.items[2].detail).toMatch(/sending claim older than 30 minutes/);
    expect(by.followups.items).toEqual([expect.objectContaining({ status: 'parked', title: 'Test Customer · termite retreat', detail: expect.stringContaining('suggested 2026-09-20') })]);
    expect(by.alerts.items.map((i) => [i.id, i.status])).toEqual([['aa-1', 'failed'], ['aa-2', 'parked'], ['aa-3', 'parked']]);
    expect(by.alerts.items[2].detail).toMatch(/snooze elapsed/);

    expect(by.calls).toMatchObject({ pending: 4, parked: 1, failed: 2, total: 7, error: null });
    expect(q.totals).toEqual({
      pending: 1 + 4 + 2 + 3, // digest, c2 + c5 + c6 + c7, ea-3 + ea-4, d1 + d3 + p1
      parked: 2 + 1 + 1 + 2 + 1 + 2 + 1 + 2, // ga4 + nightly-audit, c1, opp-1, ea-1 + ea-5, pa-1, d4 + p2, da-1, aa-2 + aa-3
      failed: 1 + 2 + 1 + 1 + 1, // pricing, c3 + c8, ea-2, d2, aa-1
      truncated: false,
      truncatedStatuses: [],
    });
    expect(typeof q.generatedAt).toBe('string');
  });

  test('a lane that throws degrades to an error row and never takes the view down', async () => {
    fixtures.content_email_approvals = new Error('relation "content_email_approvals" does not exist');
    mockJobHealth.mockRejectedValue(new Error('job_health missing'));
    mockReviewItems.mockResolvedValue({ items: [], counts: {}, unavailable: true });
    const q = await getOpsQueue();
    const by = Object.fromEntries(q.lanes.map((l) => [l.key, l]));
    expect(by.approvals).toMatchObject({ error: expect.stringMatching(/does not exist/), items: [], total: 0 });
    expect(by.jobs).toMatchObject({ error: 'job_health missing', items: [] });
    expect(by.content).toMatchObject({ error: 'review tables unavailable', items: [] });
    expect(by.calls.total).toBe(7);
  });

  test('items are capped per lane and never carry tool params, transcripts, or bodies', async () => {
    fixtures.ib_pending_actions = Array.from({ length: 40 }, (_, i) => ({
      id: `pa-${i}`, tool_name: 'send_sms', summary: `Send ${i}`, params: { body: 'SECRET BODY' }, expires_at: ago(-5), created_at: ago(i),
    }));
    fixtures.call_log = [{ id: 'c1', from_phone: '+1', direction: 'inbound', processing_status: 'processing', transcription: 'SECRET TRANSCRIPT', processing_started_at: ago(1), created_at: ago(1) }];
    const q = await getOpsQueue();
    const by = Object.fromEntries(q.lanes.map((l) => [l.key, l]));
    expect(by.ib.items).toHaveLength(25);
    expect(by.ib.total).toBe(40);
    expect(by.ib.truncated).toBe(false);
    expect(q.totals.truncated).toBe(false);
    expect(JSON.stringify(q)).not.toContain('SECRET');
  });
});

describe('getOpsQueue scan cap', () => {
  test('a lane that hits the scan cap reports truncated so counts read as a floor', async () => {
    for (const k of Object.keys(fixtures)) delete fixtures[k];
    mockJobHealth.mockResolvedValue({ jobs: [] });
    mockReviewItems.mockResolvedValue({ items: [{ id: 'opp-1', target_keyword: 'x' }], counts: { pending_review: 150 } });
    fixtures.ib_pending_actions = Array.from({ length: 200 }, (_, i) => ({ id: `pa-${i}`, tool_name: 'send_sms', expires_at: ago(-5), created_at: ago(i) }));
    const q = await getOpsQueue();
    const ib = q.lanes.find((l) => l.key === 'ib');
    expect(ib.truncated).toBe(true);
    expect(ib.truncatedStatuses).toEqual(['parked']); // the capped scan feeds parked only
    expect(ib.total).toBe(200);
    const content = q.lanes.find((l) => l.key === 'content');
    expect(content).toMatchObject({ total: 150, parked: 150, truncated: false }); // exact count, no "+"
    expect(q.totals.parked).toBeGreaterThanOrEqual(150);
    expect(q.totals.truncated).toBe(true);
    expect(q.totals.truncatedStatuses).toEqual(['parked']); // failed / pending stay exact in the tab
  });

  test('a capped extraction_failed scan floors pending AND failed — the scan feeds both statuses', async () => {
    for (const k of Object.keys(fixtures)) delete fixtures[k];
    mockJobHealth.mockResolvedValue({ jobs: [] });
    mockReviewItems.mockResolvedValue({ items: [], counts: {} });
    // Half under the retry cap inside the creation fence (pending retries),
    // half at the cap (terminal) — one scan, two statuses.
    fixtures.call_log = Array.from({ length: 200 }, (_, i) => ({
      id: `cf-${i}`, from_phone: '+15550001000', direction: 'inbound', processing_status: 'extraction_failed',
      extraction_attempts: i % 2 ? 1 : 3, created_at: ago(30 + i), updated_at: ago(i),
    }));
    const q = await getOpsQueue();
    const calls = q.lanes.find((l) => l.key === 'calls');
    expect(calls.truncated).toBe(true);
    expect(calls.truncatedStatuses).toEqual(expect.arrayContaining(['failed', 'pending']));
    expect(calls.pending).toBeGreaterThan(0);
    expect(calls.failed).toBeGreaterThan(0);
  });
});

describe('GET /api/admin/agents/queue', () => {
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
  const original = process.env.GATE_ADMIN_OPS_QUEUE;
  afterAll(() => {
    if (original === undefined) delete process.env.GATE_ADMIN_OPS_QUEUE; else process.env.GATE_ADMIN_OPS_QUEUE = original;
  });

  async function withServer(fn) {
    const express = require('express');
    const router = require('../routes/admin-agents');
    const app = express();
    app.use('/api/admin/agents', router);
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    const server = app.listen(0);
    try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
  }

  test('gate off → hub probe says no queue and 404; gate on → admin gets the queue, tech 403', async () => {
    delete process.env.GATE_ADMIN_OPS_QUEUE;
    await withServer(async (base) => {
      const a = await fetch(`${base}/api/admin/agents/control/hub`, { headers: { Authorization: 'Bearer admin' } });
      const hub = await a.json();
      expect(hub.features).toEqual({ queue: false, ledger: false, runs: false, cost: false, verification: false });
      expect(hub.areas.map((x) => x.key)).toContain('sms');
      expect((await fetch(`${base}/api/admin/agents/queue`, { headers: { Authorization: 'Bearer admin' } })).status).toBe(404);
      process.env.GATE_ADMIN_OPS_QUEUE = 'true';
      expect((await fetch(`${base}/api/admin/agents/queue`, { headers: { Authorization: 'Bearer tech' } })).status).toBe(403);
      const ok = await fetch(`${base}/api/admin/agents/queue`, { headers: { Authorization: 'Bearer admin' } });
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.lanes).toHaveLength(LANES.length);
    });
  });
});
