/**
 * Codex #5506 r2 P1: the 6 PM missed-appointment sweep scans candidates, then records a customer_noshow per
 * visit. A promotion to a street-level hold (call-recording-processor promoteReusedRowToStreetLevelHold) can
 * land between the scan and the recording, so the sweep re-reads the hold under the visit row lock right
 * before onSkip. Race shape: the scan sees no hold, the recheck sees one, and nothing is recorded. Also the
 * helper itself (runUnlessLiveHold) against a real row lock. Synthetic data only.
 */
const { randomUUID } = require('crypto');
const { createLawnVisitDb } = require('./helpers/lawn-visit-db');

let mockKnex;

jest.mock('../models/db', () => {
  const db = (...args) => mockKnex(...args);
  db.transaction = (...args) => mockKnex.transaction(...args);
  db.raw = (...args) => mockKnex.raw(...args);
  db.queryBuilder = (...args) => mockKnex.queryBuilder(...args);
  Object.defineProperty(db, 'fn', { get: () => mockKnex.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gateEnvTimestamp: () => null,
  gateEnvValue: () => false,
  isEnabled: (name) => name === 'cronJobs',
  logGateStatus: jest.fn(),
}));
jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(),
  scheduleTimeout: jest.fn(),
  scheduleInterval: jest.fn(),
  isScheduledTick: () => false,
  runAsScheduledTick: (fn) => fn(),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: async (_name, fn) => fn(),
  recordMissedTick: jest.fn(),
  settleDeadRunningJobs: jest.fn(async () => ({})),
}));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+19415550199') }));

// CI's DB-gated step selects suites by this exact line (.github/workflows/tests.yml).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres('uncleared street-level holds vs the scan-then-act background scanners (real PostgreSQL)', () => {
  let fixture;
  const hold = require('../services/street-level-hold');

  beforeAll(async () => {
    fixture = await createLawnVisitDb(false);
    mockKnex = fixture.knex;
    for (const table of ['reschedule_log', 'triage_items', 'call_log', 'dispatch_alerts']) {
      await fixture.knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [fixture.schema, table, table]);
    }
    // The real foreign key onSkip's insert takes a FOR KEY SHARE on the visit row through.
    await fixture.knex.raw('ALTER TABLE reschedule_log ADD CONSTRAINT reschedule_log_visit_fk FOREIGN KEY (scheduled_service_id) REFERENCES scheduled_services(id)');
  }, 60000);

  afterAll(async () => { if (fixture) await fixture.dispose(); });

  beforeEach(async () => {
    jest.restoreAllMocks();
    for (const table of ['dispatch_alerts', 'reschedule_log', 'triage_items', 'scheduled_services', 'customers', 'call_log']) await fixture.knex(table).del();
  });

  async function seedVisit({ held = false } = {}) {
    const customerId = randomUUID();
    const callId = randomUUID();
    const visitId = randomUUID();
    const { etDateString } = require('../utils/datetime-et');
    await fixture.knex('customers').insert({ id: customerId, first_name: 'Fixture', phone: '+19415550100' });
    await fixture.knex('call_log').insert({ id: callId });
    await fixture.knex('scheduled_services').insert({
      id: visitId, customer_id: customerId, scheduled_date: etDateString(new Date(Date.now() - 86400000)), window_start: '08:00:00', window_end: '10:00:00',
      service_type: 'pest_control', status: 'pending', customer_confirmed: false, source_action: 'voice_agent', source_call_log_id: callId,
    });
    const card = () => fixture.knex('triage_items').insert({
      call_log_id: callId, category: 'review', reason_code: 'outbound_booking_review', status: 'open',
      payload: JSON.stringify({ street_level_address: true, scheduled_service_id: visitId }),
    });
    if (held) await card();
    return { customerId, visitId, card };
  }

  async function sweep() {
    const cron = require('../utils/scheduled-cron');
    cron.schedule.mockClear();
    require('../services/scheduler').initScheduledJobs();
    const job = cron.schedule.mock.calls.find(([, callback]) => String(callback).includes('missed appointment check'))[1];
    await job();
  }
  const noshows = (visitId) => fixture.knex('reschedule_log').where({ scheduled_service_id: visitId, reason_code: 'customer_noshow' });

  test('baseline: a clear, past-window visit is flagged as a no-show', async () => {
    const { visitId } = await seedVisit();
    await sweep();
    expect(await noshows(visitId)).toHaveLength(1);
  });

  test('the scan already excludes a hold that exists when it runs', async () => {
    const { visitId } = await seedVisit({ held: true });
    await sweep();
    expect(await noshows(visitId)).toHaveLength(0);
  });

  test('RACE: the scan sees no hold, a promotion lands, the recheck sees it, and nothing is recorded', async () => {
    const { visitId, card } = await seedVisit();
    // Blind the scan's NOT EXISTS (as if it ran before the promotion), then land the promotion's card.
    jest.spyOn(hold, 'heldVisitSubquery').mockImplementation((q) => q.select(1).whereRaw('false'));
    await card();
    await sweep();
    expect(await noshows(visitId)).toHaveLength(0);
  });

  test('a ONE-connection pool (the guard holds it) still records a clear candidate: the action runs on the guard\'s transaction', async () => {
    const { visitId } = await seedVisit();
    const knexFactory = require('knex');
    const tight = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [fixture.schema], pool: { min: 0, max: 1, acquireTimeoutMillis: 3000 } });
    const original = mockKnex;
    mockKnex = tight;
    try {
      await sweep();
    } finally {
      mockKnex = original;
      await tight.destroy();
    }
    expect(await noshows(visitId)).toHaveLength(1);
  });

  test('late alerts raised before a visit became a hold are auto-resolved (system stamp) by the detector tick; other visits\' alerts stay open', async () => {
    const held = await seedVisit();
    const clear = await seedVisit();
    const mkAlert = (jobId) => fixture.knex('dispatch_alerts').insert({ type: 'tech_late', severity: 'warn', job_id: jobId, payload: JSON.stringify({ delay_minutes: 30 }) });
    await mkAlert(held.visitId);
    await mkAlert(clear.visitId);
    await held.card();   // the promotion lands after the alert was raised
    await require('../services/tech-late-detector').resolveAlertsForHeldVisits();
    const rows = await fixture.knex('dispatch_alerts').select('job_id', 'resolved_at', 'payload');
    const byJob = Object.fromEntries(rows.map((r) => [r.job_id, r]));
    expect(byJob[held.visitId].resolved_at).not.toBeNull();
    expect(byJob[held.visitId].payload.superseded_at).toBeTruthy();   // auto-resolve, not a person's acknowledgement
    expect(byJob[clear.visitId].resolved_at).toBeNull();
  });

  test('runUnlessLiveHold passes the action its own transaction', async () => {
    const { visitId } = await seedVisit();
    let seen;
    await hold.runUnlessLiveHold(visitId, async (trx) => { seen = trx; return trx('scheduled_services').where({ id: visitId }).first('id'); });
    expect(typeof seen).toBe('function');
    expect(seen.isTransaction).toBe(true);
  });

  test('runUnlessLiveHold: the action runs only while the visit is not held, and a promotion waits behind the lock', async () => {
    const { visitId, card } = await seedVisit();
    const ran = [];
    expect(await hold.runUnlessLiveHold(visitId, async () => { ran.push('clear'); return 7; })).toEqual({ held: false, result: 7 });

    // While the action runs, a promoter's FOR UPDATE on the same row must wait for it (and the action's own
    // FK insert, on the same transaction, must not conflict with the lock the guard holds).
    let promoterGot = null;
    let promoter;
    const guarded = hold.runUnlessLiveHold(visitId, async (trx) => {
      promoter = fixture.knex.transaction().then(async (trx) => {
        await trx('scheduled_services').where({ id: visitId }).forUpdate().first('id');
        promoterGot = Date.now();
        await trx.commit();
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(promoterGot).toBeNull();                       // still waiting behind the guard's lock
      await trx('reschedule_log').insert({ scheduled_service_id: visitId, reason_code: 'customer_noshow' });   // FK insert, on the guard's trx
      ran.push('fk-insert');
    });
    await guarded;
    await promoter;                                          // released once the guard's transaction ended
    expect(ran).toEqual(['clear', 'fk-insert']);
    expect(promoterGot).not.toBeNull();

    await card();
    const action = jest.fn();
    expect(await hold.runUnlessLiveHold(visitId, action)).toEqual({ held: true });
    expect(action).not.toHaveBeenCalled();
  });
});
