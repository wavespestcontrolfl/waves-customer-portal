/**
 * Scheduled-estimate cron vs the clarify re-price hold (codex r18 P2 on
 * #3804).
 *
 * A unit reply stamps the hold on every live unsent draft for the call —
 * a row the cron has ALREADY claimed as 'sending' included, past the reach
 * of the reply's own unschedule (which flips 'scheduled' rows only). The
 * send then refuses the held row with REPRICE_PENDING. That refusal is
 * deterministic: retrying restored the row to 'scheduled' with a fresh due
 * time and the cron reclaimed it until the attempts ran out. Two rails:
 * the claim never takes a held row, and a hold refusal parks the row as an
 * inert send_failed with no due time — the shape the sibling release
 * already leaves.
 */

jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(),
  scheduleTimeout: jest.fn(),
  scheduleInterval: jest.fn(),
  isScheduledTick: () => true,
  runAsScheduledTick: (task) => task(),
}));
jest.mock('../models/db', () => {
  const state = { rawSql: [], updates: [], claimRows: [] };
  const builder = (table) => {
    const wheres = [];
    const b = {};
    const chain = () => b;
    Object.assign(b, {
      where: jest.fn((w) => { wheres.push(w); return b; }),
      whereRaw: chain, whereNull: chain, whereIn: chain, whereNotNull: chain,
      insert: chain, onConflict: chain, ignore: chain, merge: jest.fn(async () => undefined),
      update: jest.fn(async (payload) => { state.updates.push({ table, wheres: wheres.slice(), payload }); return 1; }),
      first: jest.fn(async () => null),
      select: jest.fn(async () => []),
      catch: chain,
    });
    return b;
  };
  const fn = jest.fn(builder);
  fn.raw = jest.fn(async (sql) => {
    state.rawSql.push(String(sql));
    return { rows: String(sql).includes("SET status = 'sending'") ? state.claimRows : [] };
  });
  fn.fn = { now: () => 'NOW()' };
  fn.__state = state;
  return fn;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  logGateStatus: jest.fn(),
  gateEnvValue: jest.fn(() => undefined),
}));
jest.mock('../routes/admin-estimates', () => ({ sendEstimateNow: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({ sweepWedgedPendingInvalidations: jest.fn(async () => undefined) }));
jest.mock('../services/estimator-engine', () => ({
  sweepPendingQuarantines: jest.fn(async () => undefined),
  sweepPendingReconciles: jest.fn(async () => undefined),
}));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));

const db = require('../models/db');
const cronApi = require('../utils/scheduled-cron');
const { sendEstimateNow } = require('../routes/admin-estimates');
const { REPRICE_PENDING_ABSENT_SQL } = require('../utils/estimate-claim-sql');
const { claimDueScheduledEstimates, initScheduledJobs } = require('../services/scheduler');

// The every-5-minutes estimate sender, as registered — the ONE tick whose
// body claims due rows.
function scheduledEstimateTick() {
  if (!cronApi.schedule.mock.calls.length) initScheduledJobs();
  const registration = cronApi.schedule.mock.calls.find(([expr, task]) => expr === '*/5 * * * *' && String(task).includes('claimDueScheduledEstimates'));
  expect(registration).toBeDefined();
  return registration[1];
}

const parkedUpdate = (id) => db.__state.updates.find((u) => u.table === 'estimates' && u.wheres.some((w) => w && w.id === id && w.status === 'sending'));

describe('scheduled-estimate cron vs the clarify re-price hold', () => {
  beforeEach(() => {
    db.__state.rawSql = [];
    db.__state.updates = [];
    db.__state.claimRows = [];
    sendEstimateNow.mockReset();
  });

  test('the due claim never takes a held row: the hold predicate rides every stage of the claim, like the archive guard', async () => {
    await claimDueScheduledEstimates(new Date('2026-09-03T21:00:00Z'));
    const sql = db.__state.rawSql.find((s) => s.includes("SET status = 'sending'"));
    expect(sql).toBeDefined();
    expect(sql.split(REPRICE_PENDING_ABSENT_SQL).length - 1).toBe(3);
    // ranked (the batch), due (the FOR UPDATE stage) and the final UPDATE each carry it.
    expect(sql.indexOf(REPRICE_PENDING_ABSENT_SQL)).toBeLessThan(sql.indexOf('), due AS ('));
    const dueAt = sql.indexOf('), due AS (');
    const lockAt = sql.indexOf('FOR UPDATE OF e SKIP LOCKED');
    expect(sql.indexOf(REPRICE_PENDING_ABSENT_SQL, dueAt)).toBeLessThan(lockAt);
    expect(sql.lastIndexOf(REPRICE_PENDING_ABSENT_SQL)).toBeGreaterThan(sql.indexOf('UPDATE estimates AS e'));
  });

  test('a hold refusal at send time parks the claimed row as an inert send_failed with no due time — never a retry', async () => {
    const tick = scheduledEstimateTick();
    db.__state.claimRows = [{ id: 'est-held', send_method: 'both', scheduled_send_attempts: 1 }];
    sendEstimateNow.mockRejectedValue(Object.assign(new Error('This estimate is held for a re-price (a customer clarify reply).'), { statusCode: 409, code: 'REPRICE_PENDING' }));
    await tick();
    expect(sendEstimateNow).toHaveBeenCalledWith(expect.objectContaining({ id: 'est-held' }), 'both', { callerPreClaimed: true });
    expect(parkedUpdate('est-held').payload).toEqual(expect.objectContaining({ status: 'send_failed', scheduled_at: null }));
    expect(parkedUpdate('est-held').payload.last_send_error).toMatch(/held for a re-price/);
  });

  test('a reviewed scheduled attempt stops after any throw, including post-provider bookkeeping failure', async () => {
    const tick = scheduledEstimateTick();
    const scheduledAt = new Date();
    db.__state.claimRows = [{ id: 'est-reviewed', send_method: 'sms', scheduled_send_attempts: 1, scheduled_at: scheduledAt,
      estimate_data: { manualSendAttempts: [{ key: 'review-attempt', scheduleReview: { scheduledAt: scheduledAt.toISOString() } }] } }];
    sendEstimateNow.mockRejectedValue(new Error('receipt write unavailable after provider acceptance'));
    await tick();
    expect(parkedUpdate('est-reviewed').payload).toEqual(expect.objectContaining({ status: 'send_failed', scheduled_at: null }));
  });

  test('a historical reviewed schedule does not disable the current legacy schedule retry', async () => {
    const tick = scheduledEstimateTick();
    const scheduledAt = new Date();
    db.__state.claimRows = [{ id: 'est-later', send_method: 'sms', scheduled_send_attempts: 1, scheduled_at: scheduledAt,
      estimate_data: { manualSendAttempts: [{ key: 'old-review', scheduleReview: { scheduledAt: new Date(scheduledAt.getTime() - 86400000).toISOString() } }] } }];
    sendEstimateNow.mockRejectedValue(new Error('provider unavailable'));
    await tick();
    const update = parkedUpdate('est-later');
    expect(update.payload.status).toBe('scheduled');
    expect(update.payload.scheduled_at).toBeInstanceOf(Date);
  });

  test('an ordinary transient failure still retries: back to scheduled with a fresh due time', async () => {
    const tick = scheduledEstimateTick();
    db.__state.claimRows = [{ id: 'est-flaky', send_method: 'sms', scheduled_send_attempts: 1 }];
    sendEstimateNow.mockRejectedValue(new Error('provider timeout'));
    await tick();
    const update = parkedUpdate('est-flaky');
    expect(update.payload.status).toBe('scheduled');
    expect(update.payload.scheduled_at).toBeInstanceOf(Date);
  });
});
