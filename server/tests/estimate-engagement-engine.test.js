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
    'join', 'whereIn', 'whereNotNull', 'whereNull', 'where', 'select',
    'orderBy', 'limit', 'whereNotExists', 'whereRaw', 'onConflict', 'ignore',
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
    viewed_at: new Date(NOW.getTime() - 26 * H),
    last_viewed_at: new Date(NOW.getTime() - 26 * H),
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
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  isEnabled.mockReturnValue(true);
  inferEstimateServiceLines.mockReturnValue([{ key: 'pest' }]);
  customerConvertedSince.mockResolvedValue({ converted: false });
  followupShared.claimFollowupSend.mockResolvedValue(true);
  followupShared.sendDualChannel.mockResolvedValue(true);
  followupShared.hasRepliedRecently.mockResolvedValue(false);
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
    enqueue('estimate_followup_sends', { first: undefined }); // not already sent
    enqueue('estimate_followup_jobs', { insert: [{ id: 'job-1' }] });

    await Engine.onEstimateViewed(baseEstimate(), NOW);

    const jobInsert = writes.find((w) => w.table === 'estimate_followup_jobs');
    expect(jobInsert.payload).toEqual(expect.objectContaining({ estimate_id: 'est-1', rule_key: 'return_visit_hot' }));
    // due ≈ session start evaluation time + 15min fire delay
    expect(jobInsert.payload.due_at).toBeInstanceOf(Date);
  });

  test('a return after 4 days dark queues dark_then_return, NOT return_visit_hot', async () => {
    enqueueViewRules();
    sessionsForEstimate.mockResolvedValue([
      session('2026-06-06T12:00:00Z', '2026-06-06T12:10:00Z'),
      session('2026-06-10T14:55:00Z'),
    ]);
    enqueue('estimate_followup_sends', { first: undefined });
    enqueue('estimate_followup_jobs', { insert: [{ id: 'job-1' }] });

    await Engine.onEstimateViewed(baseEstimate(), NOW);

    const jobKeys = writes.filter((w) => w.table === 'estimate_followup_jobs').map((w) => w.payload.rule_key);
    expect(jobKeys).toEqual(['dark_then_return']);
  });

  test('three sessions inside 72h queue multi_view_high_intent', async () => {
    enqueueViewRules();
    sessionsForEstimate.mockResolvedValue([
      session('2026-06-09T12:00:00Z', '2026-06-09T12:05:00Z'),
      session('2026-06-10T09:00:00Z', '2026-06-10T09:05:00Z'),
      session('2026-06-10T14:55:00Z'),
    ]);
    // high intent is the only match (3 sessions ≠ exactly 2; last gap < 3d)
    enqueue('estimate_followup_sends', { first: undefined });
    enqueue('estimate_followup_jobs', { insert: [{ id: 'job-1' }] });

    await Engine.onEstimateViewed(baseEstimate(), NOW);

    const jobKeys = writes.filter((w) => w.table === 'estimate_followup_jobs').map((w) => w.payload.rule_key);
    expect(jobKeys).toEqual(['multi_view_high_intent']);
  });

  test('already-sent rules never re-enqueue', async () => {
    enqueueViewRules();
    sessionsForEstimate.mockResolvedValue([
      session('2026-06-10T12:00:00Z', '2026-06-10T12:10:00Z'),
      session('2026-06-10T14:55:00Z'),
    ]);
    enqueue('estimate_followup_sends', { first: { id: 'sent-already' } });

    await Engine.onEstimateViewed(baseEstimate(), NOW);

    expect(writes.filter((w) => w.table === 'estimate_followup_jobs')).toHaveLength(0);
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
  function enqueueProcessorHappyPath({ job = pendingJob(), est = baseEstimate(), ledgerRows = [] } = {}) {
    enqueue('estimate_followup_jobs', { rows: [job] });     // due scan
    enqueue('estimate_followup_rules', { rows: [QUIET_RULE, HOT_RULE] });
    enqueue('estimates', { first: est });                   // fresh re-read
    enqueue('estimate_followup_sends', { rows: ledgerRows }); // caps/spacing ledger
    enqueue('notification_prefs', { first: { email_enabled: true } });
    // job status update + estimate bump resolve via builder defaults
  }

  test('sends the email, claims the ledger, marks the job done', async () => {
    enqueueProcessorHappyPath();

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(1);
    expect(followupShared.claimFollowupSend).toHaveBeenCalledWith(
      'est-1', 'viewed_gone_quiet_72h', 'estimate.engage_gone_quiet', expect.any(Object),
    );
    expect(followupShared.sendDualChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'est-1' }),
      expect.objectContaining({
        email: expect.objectContaining({ templateKey: 'estimate.engage_gone_quiet' }),
      }),
    );
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'done' }));
    expect(writes.some((w) => w.table === 'estimates' && w.op === 'update')).toBe(true);
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

  test('the 4-send cap skips the job', async () => {
    enqueueProcessorHappyPath({
      ledgerRows: [
        { rule_key: 'a', sent_at: new Date(NOW.getTime() - 40 * H) },
        { rule_key: 'b', sent_at: new Date(NOW.getTime() - 60 * H) },
        { rule_key: 'c', sent_at: new Date(NOW.getTime() - 80 * H) },
        { rule_key: 'payment_step_abandoned', sent_at: new Date(NOW.getTime() - 90 * H) },
      ],
    });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(0);
    const jobUpdate = writes.filter((w) => w.table === 'estimate_followup_jobs' && w.op === 'update').pop();
    expect(jobUpdate.payload).toEqual(expect.objectContaining({ status: 'skipped', outcome_reason: 'max-sends-cap' }));
  });

  test('a send 1h ago defers a non-exempt rule to the spacing boundary', async () => {
    const lastSent = new Date(NOW.getTime() - 1 * H);
    enqueueProcessorHappyPath({ ledgerRows: [{ rule_key: 'a', sent_at: lastSent }] });

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
      ledgerRows: [{ rule_key: 'a', sent_at: new Date(NOW.getTime() - 1 * H) }],
    });

    const result = await Engine.processDueJobs(NOW);

    expect(result.sent).toBe(1);
    expect(followupShared.claimFollowupSend).toHaveBeenCalledWith(
      'est-1', 'return_visit_hot', 'estimate.engage_return_visit', expect.any(Object),
    );
  });

  test('actively-viewing customers defer instead of getting emailed mid-read', async () => {
    enqueueProcessorHappyPath({
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
