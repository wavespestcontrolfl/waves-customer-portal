/**
 * Engagement engine — pins the contract:
 *   - view-event rules match on session boundaries (return_visit_hot only
 *     on the SECOND visit, dark_then_return past the dark gap, high intent
 *     at 3+ sessions) and enqueue durable jobs after the fire delay;
 *   - already-sent rules never re-enqueue;
 *   - the processor re-validates at send time: category (pest/lawn v1),
 *     conversion, reply-pause, active-view hold (defer), the 4-send cap,
 *     12h spacing (hot rules exempt), prefs opt-out;
 *   - gate off = jobs consumed as 'shadow' with the would-send logged —
 *     never claimed, never sent, no post-flip backlog;
 *   - sends claim through the shared ledger and release on failure.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-service-lines', () => ({
  inferEstimateServiceLines: jest.fn(() => [{ key: 'pest' }]),
}));
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
}));
jest.mock('../services/estimate-engagement-sessions', () => ({
  sessionsForEstimate: jest.fn(async () => []),
  SESSION_GAP_MINUTES: 30,
}));
jest.mock('../services/estimate-follow-up', () => ({
  _private: {
    claimFollowupSend: jest.fn(async () => true),
    releaseFollowupSend: jest.fn(async () => {}),
    sendDualChannel: jest.fn(async () => true),
    estimateEmailPayload: jest.fn((est, firstName, url) => ({ first_name: firstName, estimate_url: url })),
    mintStageLinks: jest.fn(async () => ({ smsUrl: 'url', emailUrl: 'url' })),
    hasRepliedRecently: jest.fn(async () => false),
    wasRecentlyOpened: jest.fn(() => false),
    bumpFollowupCounters: jest.fn(async () => {}),
    repairFollowupCounters: jest.fn(async () => null),
  },
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const logger = require('../services/logger');
const { inferEstimateServiceLines } = require('../services/estimate-service-lines');
const { customerConvertedSince } = require('../services/estimate-conversion-guard');
const { sessionsForEstimate } = require('../services/estimate-engagement-sessions');
const followupShared = require('../services/estimate-follow-up')._private;
const Engine = require('../services/estimate-engagement-engine');

// Builder stub — chain methods return the builder; awaiting resolves by
// mode. insert/update/del recorded in writes.
const writes = [];
function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of [
    'join', 'whereIn', 'whereNotNull', 'whereNull', 'where', 'whereNot', 'select',
    'orderBy', 'orderByRaw', 'leftJoin', 'limit', 'whereNotExists', 'whereRaw', 'onConflict', 'ignore',
    'returning', 'as', 'distinctOn',
  ]) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.insert = jest.fn((payload) => {
    b._mode = 'insert';
    writes.push({ table, op: 'insert', payload });
    return b;
  });
  b.update = jest.fn((payload) => {
    b._mode = 'update';
    writes.push({ table, op: 'update', payload });
    return b;
  });
  b.then = (resolve, reject) => {
    if (b._mode === 'update' && cfg.updateError) {
      return Promise.reject(new Error(cfg.updateError)).then(resolve, reject);
    }
    const value =
      b._mode === 'insert' ? (cfg.insert ?? [{ id: 'job-1' }])
        : b._mode === 'update' ? (cfg.update ?? 1)
          : b._mode === 'first' ? cfg.first
            : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  return b;
}

let queues;
function enqueue(table, cfg) {
  (queues[table] = queues[table] || []).push(cfg);
}

// enqueueJob is a single raw INSERT ... SELECT (atomic lifecycle guard).
// Calls land here; results come from jobInsertResults (default = queued).
const rawJobs = [];
let jobInsertResults;
// Lost-claim bookkeeping repairs (raw UPDATE ... FROM estimate_followup_sends).
const rawRepairs = [];

const NOW = new Date('2026-06-10T15:00:00Z');
const H = 3600000;
const MIN = 60000;

const RULE_ROWS = [
  { rule_key: 'return_visit_hot', enabled: true, trigger_type: 'view_event', priority: 10, template_key: 'estimate.engage_return_visit', params: {} },
  { rule_key: 'dark_then_return', enabled: true, trigger_type: 'view_event', priority: 15, template_key: 'estimate.engage_return_after_dark', params: {} },
  { rule_key: 'multi_view_high_intent', enabled: true, trigger_type: 'view_event', priority: 20, template_key: 'estimate.engage_high_intent', params: {} },
];

function session(startIso, endIso) {
  return { startedAt: new Date(startIso), endedAt: new Date(endIso || startIso), viewCount: 1 };
}

function baseEstimate(overrides = {}) {
  return {
    id: 'est-1',
    status: 'viewed',
    archived_at: null,
    customer_id: 'cust-1',
    customer_name: 'Taylor Doe',
    customer_email: 'taylor@example.com',
    token: 'tok-xyz',
    sent_at: new Date(NOW.getTime() - 100 * H),
    follow_up_count: 0,
    last_follow_up_at: null,
    expires_at: new Date(NOW.getTime() + 5 * 86400000),
    viewed_at: new Date(NOW.getTime() - 80 * H),
    last_viewed_at: new Date(NOW.getTime() - 80 * H),
    ...overrides,
  };
}

function pendingJob(overrides = {}) {
  return {
    id: 'job-1',
    estimate_id: 'est-1',
    rule_key: 'viewed_gone_quiet_72h',
    due_at: new Date(NOW.getTime() - 5 * MIN),
    trigger: '{}',
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

const QUIET_RULE = { rule_key: 'viewed_gone_quiet_72h', enabled: true, trigger_type: 'time_sweep', priority: 50, template_key: 'estimate.engage_gone_quiet', params: {} };
const HOT_RULE = RULE_ROWS[0];

beforeEach(() => {
  jest.clearAllMocks();
  writes.length = 0;
  rawJobs.length = 0;
  rawRepairs.length = 0;
  jobInsertResults = [];
  queues = {};
  db.mockImplementation((rawTable) => {
    const table = String(rawTable).split(' as ')[0]; // normalize aliased scans
    return makeBuilder(table, (queues[table] || []).shift() || {});
  });
  db.raw.mockImplementation((sql, bindings) => {
    if (typeof sql === 'string' && sql.includes('INSERT INTO estimate_followup_jobs')) {
      rawJobs.push({ sql, bindings });
      return Promise.resolve({ rows: jobInsertResults.shift() ?? [{ id: 'job-1' }] });
    }
    if (typeof sql === 'string' && sql.includes('UPDATE estimates SET')) {
      rawRepairs.push({ sql, bindings });
      return Promise.resolve({ rowCount: 1 });
    }
    return sql;
  });
  isEnabled.mockReturnValue(true);
  inferEstimateServiceLines.mockReturnValue([{ key: 'pest' }]);
  customerConvertedSince.mockResolvedValue({ converted: false });
  followupShared.claimFollowupSend.mockResolvedValue(true);
  followupShared.sendDualChannel.mockResolvedValue(true);
  followupShared.hasRepliedRecently.mockResolvedValue(false);
  followupShared.bumpFollowupCounters.mockResolvedValue(undefined);
  followupShared.repairFollowupCounters.mockResolvedValue(null);
});

describe('onEstimateViewed (view-event rules)', () => {
  function enqueueViewRules() {
    enqueue('estimate_followup_rules', { rows: RULE_ROWS });
  }

  test('second visit ≥15min later within 48h queues return_visit_hot after the fire delay', async () => {
    enqueueViewRules();
    sessionsForEstimate.mockResolvedValue([
      session('2026-06-10T12:00:00Z', '2026-06-10T12:10:00Z'),
      session('2026-06-10T14:55:00Z'),
    ]);

    await Engine.onEstimateViewed(baseEstimate(), NOW);

    expect(rawJobs).toHaveLength(1);
    expect(rawJobs[0].sql).toContain('NOT EXISTS');
    const [estimateId, ruleKey, dueAt] = rawJobs[0].bindings;
    expect(estimateId).toBe('est-1');
    expect(ruleKey).toBe('return_visit_hot');
    // due ≈ evaluation time + 15min fire delay
    expect(dueAt).toBeInstanceOf(Date);
  });

  test('a 20-min return (inside the 30-min session gap) still queues return_visit_hot', async () => {
    enqueueViewRules();
    // The default 30-min gap folds the 14:30 reopen into one session — the
    // hot rule sessionizes at its OWN 15-min threshold and sees two visits
    // (codex 2736 r7: the advertised window was unreachable otherwise).
    sessionsForEstimate.mockImplementation(async (id, opts = {}) => (
      opts.gapMinutes === 15
        ? [session('2026-06-10T14:00:00Z', '2026-06-10T14:10:00Z'), session('2026-06-10T14:30:00Z')]
        : [session('2026-06-10T14:00:00Z', '2026-06-10T14:30:00Z')]
    ));

    await Engine.onEstimateViewed(baseEstimate(), NOW);

    expect(sessionsForEstimate).toHaveBeenCalledWith('est-1', { gapMinutes: 15 });
    expect(rawJobs.map((j) => j.bindings[1])).toEqual(['return_visit_hot']);
  });

  test('a return after 4 days dark queues dark_then_return, NOT return_visit_hot', async () => {
    enqueueViewRules();
    sessionsForEstimate.mockResolvedValue([
      session('2026-06-06T12:00:00Z', '2026-06-06T12:10:00Z'),
      session('2026-06-10T14:55:00Z'),
    ]);

    await Engine.onEstimateViewed(baseEstimate(), NOW);

    expect(rawJobs.map((j) => j.bindings[1])).toEqual(['dark_then_return']);
  });

  test('three sessions inside 72h queue multi_view_high_intent', async () => {
    enqueueViewRules();
    sessionsForEstimate.mockResolvedValue([
      session('2026-06-09T12:00:00Z', '2026-06-09T12:05:00Z'),
      session('2026-06-10T09:00:00Z', '2026-06-10T09:05:00Z'),
      session('2026-06-10T14:55:00Z'),
    ]);
    // high intent is the only match (3 sessions ≠ exactly 2; last gap < 3d)

    await Engine.onEstimateViewed(baseEstimate(), NOW);

    expect(rawJobs.map((j) => j.bindings[1])).toEqual(['multi_view_high_intent']);
  });

  test('prior send or terminal job suppresses the enqueue inside ONE statement', async () => {
    enqueueViewRules();
    sessionsForEstimate.mockResolvedValue([
      session('2026-06-10T12:00:00Z', '2026-06-10T12:10:00Z'),
      session('2026-06-10T14:55:00Z'),
    ]);
    jobInsertResults.push([]); // NOT EXISTS guard (send or terminal job) blocked it

    await Engine.onEstimateViewed(baseEstimate(), NOW);

    // The statement itself carries both guards — atomic with the insert.
    expect(rawJobs).toHaveLength(1);
    expect(rawJobs[0].sql).toContain('FROM estimate_followup_jobs');
    expect(rawJobs[0].sql).toContain('FROM estimate_followup_sends');
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('queued'));
  });

  test('gate off at enqueue stamps the job enqueued_dark', async () => {
    isEnabled.mockReturnValue(false);
    enqueueViewRules();
    sessionsForEstimate.mockResolvedValue([
      session('2026-06-10T12:00:00Z', '2026-06-10T12:10:00Z'),
      session('2026-06-10T14:55:00Z'),
    ]);

    await Engine.onEstimateViewed(baseEstimate(), NOW);

    expect(rawJobs).toHaveLength(1);
    expect(JSON.parse(rawJobs[0].bindings[3])).toEqual(expect.objectContaining({ enqueued_dark: true }));
  });

  test('terminal/archived/email-less estimates never evaluate', async () => {
    await Engine.onEstimateViewed(baseEstimate({ status: 'accepted' }));
    await Engine.onEstimateViewed(baseEstimate({ archived_at: new Date() }));
    await Engine.onEstimateViewed(baseEstimate({ customer_email: null }));
    expect(db).not.toHaveBeenCalled();
  });
});

describe('processDueJobs', () => {
  // Happy-path queue for one due job on the gone-quiet rule.
  function enqueueProcessorHappyPath({ job = pendingJob(), est = baseEstimate() } = {}) {
    enqueue('estimate_followup_jobs', { rows: [job] });     // due scan
    enqueue('estimate_followup_rules', { rows: [QUIET_RULE, HOT_RULE] });
    enqueue('estimates', { first: est });                   // fresh re-read
    enqueue('notification_prefs', { first: { email_enabled: true } });
    // job status update + estimate bump resolve via builder defaults
  }

  test('sends the email, claims the ledger, marks the job done', async () => {
    enqueueProcessorHappyPath();

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(1);
    expect(followupShared.claimFollowupSend).toHaveBeenCalledWith(
      'est-1', 'viewed_gone_quiet_72h', 'estimate.engage_gone_quiet', expect.any(Object),
      { blockLegacyFlags: [], blockRuleKeys: [] },
    );
    expect(followupShared.sendDualChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'est-1' }),
      expect.objectContaining({
        email: expect.objectContaining({ templateKey: 'estimate.engage_gone_quiet' }),
      }),
    );
    // Non-expiring stages keep the plain per-(stage, estimate) key.
    expect(followupShared.sendDualChannel.mock.calls[0][1].email.idempotencySuffix).toBeUndefined();
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'done' }));
    expect(followupShared.bumpFollowupCounters).toHaveBeenCalledWith('est-1', 'viewed_gone_quiet_72h');
  });

  test('gate off = shadow: job consumed, would-send logged, nothing claimed', async () => {
    isEnabled.mockReturnValue(false);
    enqueueProcessorHappyPath();

    const result = await Engine.processDueJobs(NOW);

    expect(result).toEqual({ sent: 0, shadow: 1 });
    expect(followupShared.claimFollowupSend).not.toHaveBeenCalled();
    expect(followupShared.sendDualChannel).not.toHaveBeenCalled();
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'shadow' }));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('shadow: would send viewed_gone_quiet_72h'));
  });

  test('gate off: a spacing defer CONSUMES the job as shadow — nothing pending survives to a flip', async () => {
    isEnabled.mockReturnValue(false);
    enqueueProcessorHappyPath({
      est: baseEstimate({ follow_up_count: 1, last_follow_up_at: new Date(NOW.getTime() - 1 * H) }),
    });

    const result = await Engine.processDueJobs(NOW);

    expect(result).toEqual({ sent: 0, shadow: 1 });
    expect(followupShared.claimFollowupSend).not.toHaveBeenCalled();
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    // Shadow, not a defer: a pending job due while dark must never send
    // after a mid-window gate flip (codex 2736 r8).
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'shadow', outcome_reason: 'gate-off:spacing' }));
  });

  test('gate off: an unexpected error consumes as shadow too, never a pending retry', async () => {
    isEnabled.mockReturnValue(false);
    customerConvertedSince.mockRejectedValue(new Error('db hiccup'));
    enqueueProcessorHappyPath();

    const result = await Engine.processDueJobs(NOW);

    expect(result).toEqual({ sent: 0, shadow: 1 });
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({
      status: 'shadow',
      outcome_reason: expect.stringContaining('gate-off:error'),
    }));
  });

  test('an enqueued_dark job stays shadow even after the gate flips ON', async () => {
    isEnabled.mockReturnValue(true); // gate is on by fire time…
    enqueueProcessorHappyPath({
      job: pendingJob({ trigger: '{"enqueued_dark":true}' }), // …but the session happened dark
    });

    const result = await Engine.processDueJobs(NOW);

    expect(result).toEqual({ sent: 0, shadow: 1 });
    expect(followupShared.claimFollowupSend).not.toHaveBeenCalled();
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'shadow', outcome_reason: 'enqueued-dark' }));
  });

  test('gate off: a FULL due batch keeps draining — no >batch leftovers survive to a flip', async () => {
    isEnabled.mockReturnValue(false);
    const batch = Array.from({ length: 50 }, (_, i) => pendingJob({ id: `job-${i}`, estimate_id: `est-${i}` }));
    enqueue('estimate_followup_jobs', { rows: batch }); // pass 1: full batch
    enqueue('estimate_followup_rules', { rows: [QUIET_RULE, HOT_RULE] });
    for (let i = 0; i < 50; i++) {
      enqueue('estimates', { first: baseEstimate({ id: `est-${i}` }) });
      enqueue('notification_prefs', { first: { email_enabled: true } });
    }
    // pass 2's due scan drains to empty via the builder default (rows: [])

    const result = await Engine.processDueJobs(NOW);

    expect(result).toEqual({ sent: 0, shadow: 50 });
    expect(followupShared.claimFollowupSend).not.toHaveBeenCalled();
  });

  test('v1 category scope: a termite estimate is skipped', async () => {
    inferEstimateServiceLines.mockReturnValue([{ key: 'termite' }]);
    enqueueProcessorHappyPath();

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'skipped', outcome_reason: 'category-ineligible' }));
  });

  test('pest+lawn bundles stay eligible', async () => {
    inferEstimateServiceLines.mockReturnValue([{ key: 'pest' }, { key: 'lawn' }]);
    enqueueProcessorHappyPath();

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(1);
  });

  test('the 4-send cap counts BOTH lanes via follow_up_count', async () => {
    // Four legacy sends, zero ledger rows — the cap must still trip.
    enqueueProcessorHappyPath({ est: baseEstimate({ follow_up_count: 4 }) });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'skipped', outcome_reason: 'max-sends-cap' }));
  });

  test('a send 1h ago (either lane) defers a non-exempt rule to the spacing boundary', async () => {
    const lastSent = new Date(NOW.getTime() - 1 * H);
    enqueueProcessorHappyPath({ est: baseEstimate({ follow_up_count: 1, last_follow_up_at: lastSent }) });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    expect(followupShared.claimFollowupSend).not.toHaveBeenCalled();
    const defer = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(defer.payload.due_at.getTime()).toBe(lastSent.getTime() + 12 * H);
    expect(defer.payload.status).toBeUndefined(); // stays pending
  });

  test('return_visit_hot is spacing-EXEMPT and still sends', async () => {
    enqueueProcessorHappyPath({
      job: pendingJob({ rule_key: 'return_visit_hot' }),
      est: baseEstimate({ follow_up_count: 1, last_follow_up_at: new Date(NOW.getTime() - 1 * H) }),
    });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(1);
    expect(followupShared.claimFollowupSend).toHaveBeenCalledWith(
      'est-1', 'return_visit_hot', 'estimate.engage_return_visit', expect.any(Object),
      { blockLegacyFlags: [], blockRuleKeys: [] },
    );
  });

  test('actively-viewing customers defer instead of getting emailed mid-read', async () => {
    enqueueProcessorHappyPath({
      job: pendingJob({ rule_key: 'return_visit_hot' }),
      est: baseEstimate({ last_viewed_at: new Date(NOW.getTime() - 5 * MIN) }),
    });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    expect(followupShared.claimFollowupSend).not.toHaveBeenCalled();
    const defer = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(defer.payload.status).toBeUndefined();
    expect(defer.payload.due_at).toBeInstanceOf(Date);
  });

  test('converted customers skip', async () => {
    customerConvertedSince.mockResolvedValue({ converted: true, reason: 'paid-invoice' });
    enqueueProcessorHappyPath();

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ outcome_reason: 'converted:paid-invoice' }));
  });

  test('send failure releases the claim and defers for retry', async () => {
    followupShared.sendDualChannel.mockResolvedValue(false);
    enqueueProcessorHappyPath();

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    expect(followupShared.releaseFollowupSend).toHaveBeenCalledWith('est-1', 'viewed_gone_quiet_72h');
    const defer = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(defer.payload.status).toBeUndefined(); // deferred, not failed (attempt 1 of 5)
  });

  test('a customer return DEFERS the gone-quiet job to the new quiet boundary — never consumes the rule', async () => {
    const freshView = new Date(NOW.getTime() - 2 * H);
    enqueueProcessorHappyPath({
      est: baseEstimate({ last_viewed_at: freshView }),
    });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    expect(followupShared.claimFollowupSend).not.toHaveBeenCalled();
    const defer = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    // Pending defer, NOT a terminal skip (codex 2736 r9): the one-lifecycle
    // enqueue guard would otherwise lose the gone-quiet reminder forever.
    expect(defer.payload.status).toBeUndefined();
    expect(defer.payload.due_at.getTime()).toBe(freshView.getTime() + 72 * H);
  });

  test('an unopened job goes stale once the estimate is viewed', async () => {
    const UNOPENED_RULE = { rule_key: 'delivery_unopened_24h', enabled: true, trigger_type: 'time_sweep', priority: 40, template_key: 'estimate.engage_unopened', params: {} };
    enqueue('estimate_followup_jobs', { rows: [pendingJob({ rule_key: 'delivery_unopened_24h' })] });
    enqueue('estimate_followup_rules', { rows: [UNOPENED_RULE] });
    enqueue('estimates', { first: baseEstimate({ status: 'viewed' }) });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'skipped', outcome_reason: 'stale-condition' }));
  });

  test('a RESEND restarts the unopened timer — job defers to sent_at + minAge', async () => {
    const UNOPENED_RULE = { rule_key: 'delivery_unopened_24h', enabled: true, trigger_type: 'time_sweep', priority: 40, template_key: 'estimate.engage_unopened', params: {} };
    const freshSend = new Date(NOW.getTime() - 2 * H);
    enqueue('estimate_followup_jobs', { rows: [pendingJob({ rule_key: 'delivery_unopened_24h' })] });
    enqueue('estimate_followup_rules', { rows: [UNOPENED_RULE] });
    enqueue('estimates', { first: baseEstimate({ status: 'sent', viewed_at: null, last_viewed_at: null, sent_at: freshSend }) });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    const defer = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(defer.payload.status).toBeUndefined(); // still pending — NOT a terminal skip
    expect(defer.payload.due_at.getTime()).toBe(freshSend.getTime() + 24 * H);
  });

  test('an expiring send scopes its email idempotency to the CURRENT deadline (extension re-arm)', async () => {
    const EXPIRING_RULE = { rule_key: 'expiring_engaged', enabled: true, trigger_type: 'time_sweep', priority: 30, template_key: 'estimate.engage_expiring', params: {} };
    const expires = new Date(NOW.getTime() + 1 * 86400000);
    enqueue('estimate_followup_jobs', { rows: [pendingJob({ rule_key: 'expiring_engaged' })] });
    enqueue('estimate_followup_rules', { rows: [EXPIRING_RULE] });
    enqueue('estimates', { first: baseEstimate({ expires_at: expires }) });
    enqueue('estimate_followup_sends', { first: undefined }); // no sibling send
    enqueue('notification_prefs', { first: { email_enabled: true } });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(1);
    // codex 2736 r10: a re-armed deadline must not dedupe against the OLD
    // deadline's email — the key carries the current expires_at lifecycle.
    expect(followupShared.sendDualChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email: expect.objectContaining({ idempotencySuffix: expires.toISOString() }),
      }),
    );
    // codex 2736 r12: the claim is PINNED to the deadline the copy was
    // validated against — a concurrent extension makes it a lost-claim skip
    // instead of a wrong-deadline email.
    expect(followupShared.claimFollowupSend).toHaveBeenCalledWith(
      'est-1', 'expiring_engaged', 'estimate.engage_expiring', expect.any(Object),
      expect.objectContaining({ requireExpiresAt: expires }),
    );
  });

  test('a sibling expiring send suppresses the other variant', async () => {
    const EXPIRING_RULE = { rule_key: 'expiring_engaged', enabled: true, trigger_type: 'time_sweep', priority: 30, template_key: 'estimate.engage_expiring', params: {} };
    enqueue('estimate_followup_jobs', { rows: [pendingJob({ rule_key: 'expiring_engaged' })] });
    enqueue('estimate_followup_rules', { rows: [EXPIRING_RULE] });
    enqueue('estimates', { first: baseEstimate({ expires_at: new Date(NOW.getTime() + 1 * 86400000) }) });
    enqueue('estimate_followup_sends', { first: { id: 'never-viewed-send' } }); // sibling already sent

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    expect(followupShared.claimFollowupSend).not.toHaveBeenCalled();
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'skipped', outcome_reason: 'sibling-sent' }));
  });

  test('a legacy-lane unviewed claim suppresses the engine unopened email', async () => {
    const UNOPENED_RULE = { rule_key: 'delivery_unopened_24h', enabled: true, trigger_type: 'time_sweep', priority: 40, template_key: 'estimate.engage_unopened', params: {} };
    enqueue('estimate_followup_jobs', { rows: [pendingJob({ rule_key: 'delivery_unopened_24h' })] });
    enqueue('estimate_followup_rules', { rows: [UNOPENED_RULE] });
    enqueue('estimates', { first: baseEstimate({ status: 'sent', viewed_at: null, last_viewed_at: null, followup_unviewed_sent: true }) });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'skipped', outcome_reason: 'stale-condition' }));
  });

  test('a resend resets the gone-quiet clock — job defers to sent_at + minQuiet', async () => {
    const freshSend = new Date(NOW.getTime() - 1 * H);
    enqueueProcessorHappyPath({
      est: baseEstimate({ sent_at: freshSend }),
    });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    const defer = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(defer.payload.status).toBeUndefined();
    expect(defer.payload.due_at.getTime()).toBe(freshSend.getTime() + 72 * H);
  });

  test('a lapsed expires_at skips BEFORE the daily sweep flips status', async () => {
    enqueueProcessorHappyPath({
      est: baseEstimate({ expires_at: new Date(NOW.getTime() - 1 * H) }),
    });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    expect(followupShared.claimFollowupSend).not.toHaveBeenCalled();
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'skipped', outcome_reason: 'link-expired' }));
  });

  test('a legacy-lane expiring claim suppresses the engine expiring email', async () => {
    const EXPIRING_RULE = { rule_key: 'expiring_engaged', enabled: true, trigger_type: 'time_sweep', priority: 30, template_key: 'estimate.engage_expiring', params: {} };
    enqueue('estimate_followup_jobs', { rows: [pendingJob({ rule_key: 'expiring_engaged' })] });
    enqueue('estimate_followup_rules', { rows: [EXPIRING_RULE] });
    enqueue('estimates', { first: baseEstimate({ expires_at: new Date(NOW.getTime() + 1 * 86400000), followup_expiring_sent: true }) });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'skipped', outcome_reason: 'stale-condition' }));
  });

  test('a bookkeeping failure AFTER a successful send never releases the claim', async () => {
    followupShared.bumpFollowupCounters.mockRejectedValue(new Error('bump failed mid-transaction'));
    enqueueProcessorHappyPath();

    await Engine.processDueJobs(NOW);

    expect(followupShared.sendDualChannel).toHaveBeenCalledTimes(1);
    // The email went out — the ledger row must survive, or a retry re-emails.
    expect(followupShared.releaseFollowupSend).not.toHaveBeenCalled();
  });

  test('counters heal BEFORE the guardrails judge them — a lost bump still trips the cap', async () => {
    // In-memory row says 3 sends; the heal reveals a 4th whose bump died.
    followupShared.repairFollowupCounters.mockResolvedValue({ follow_up_count: 4, last_follow_up_at: new Date(NOW.getTime() - 20 * H) });
    enqueueProcessorHappyPath({ est: baseEstimate({ follow_up_count: 3 }) });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    expect(followupShared.repairFollowupCounters).toHaveBeenCalledWith('est-1');
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'skipped', outcome_reason: 'max-sends-cap' }));
  });

  test('rule priority breaks due_at ties — the expiring email wins the budget', async () => {
    const EXPIRING_RULE = { rule_key: 'expiring_engaged', enabled: true, trigger_type: 'time_sweep', priority: 30, template_key: 'estimate.engage_expiring', params: {} };
    const due = new Date(NOW.getTime() - 5 * MIN);
    enqueue('estimate_followup_jobs', {
      rows: [
        pendingJob({ id: 'job-quiet', rule_key: 'viewed_gone_quiet_72h', estimate_id: 'est-1', due_at: due }),
        pendingJob({ id: 'job-exp', rule_key: 'expiring_engaged', estimate_id: 'est-2', due_at: due }),
      ],
    });
    enqueue('estimate_followup_rules', { rows: [QUIET_RULE, EXPIRING_RULE, HOT_RULE] });
    // Processed order after the priority sort: expiring (30) then quiet (50).
    enqueue('estimates', { first: baseEstimate({ id: 'est-2', expires_at: new Date(NOW.getTime() + 1 * 86400000) }) });
    enqueue('estimate_followup_sends', { first: undefined }); // expiring sibling check
    enqueue('notification_prefs', { first: { email_enabled: true } });
    enqueue('estimates', { first: baseEstimate({ id: 'est-1' }) });
    enqueue('notification_prefs', { first: { email_enabled: true } });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(2);
    expect(followupShared.claimFollowupSend.mock.calls[0][1]).toBe('expiring_engaged');
    expect(followupShared.claimFollowupSend.mock.calls[1][1]).toBe('viewed_gone_quiet_72h');
  });

  test('an unexpected per-job error defers the job out of the due batch (poison guard)', async () => {
    customerConvertedSince.mockRejectedValue(new Error('db hiccup'));
    enqueueProcessorHappyPath();

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    const defer = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(defer.payload.status).toBeUndefined(); // still pending, but...
    expect(defer.payload.due_at).toBeInstanceOf(Date);
    expect(defer.payload.due_at.getTime()).toBeGreaterThan(NOW.getTime()); // ...bumped out of the batch
    expect(defer.payload.attempts).toBeDefined(); // attempt counted toward the 5-try cap
  });

  test('inactive estimate (accepted since enqueue) skips', async () => {
    enqueue('estimate_followup_jobs', { rows: [pendingJob()] });
    enqueue('estimate_followup_rules', { rows: [QUIET_RULE] });
    enqueue('estimates', { first: baseEstimate({ status: 'accepted' }) });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'skipped', outcome_reason: 'estimate-inactive' }));
  });
});
