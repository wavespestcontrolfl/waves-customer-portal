// Late recap clips (GATE_RECAP_GLASSES_CLIPS, owner 2026-11-01) against the races a re-render can lose, through
// PostgreSQL. Every state change orders on the service_recaps row: the late-clip mark (clip_revision + re-queue),
// a render's finish (publishes 'ready' only when clip_revision is still the claimed one), an approval (only the
// render it read) and a send claim (only an approved recap). A forced re-render never pulls a recap out from under
// a send in progress. Every write runs in a transaction that is rolled back. Synthetic rows only. Skips without
// DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/service-report/pdf-queue', () => ({ ensureReportToken: jest.fn() }));
jest.mock('../services/service-report/recap-payload', () => ({ buildRecapPayload: jest.fn() }));
jest.mock('../services/service-report/recap-render', () => ({ renderRecapToFile: jest.fn(), cleanupRecapFile: jest.fn() }));
jest.mock('../services/service-report/recap-storage', () => ({ putRecapFromFile: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { ensureReportToken } = require('../services/service-report/pdf-queue');
const { buildRecapPayload } = require('../services/service-report/recap-payload');
const { renderRecapToFile } = require('../services/service-report/recap-render');
const { putRecapFromFile } = require('../services/service-report/recap-storage');
const pipeline = require('../services/service-report/recap-pipeline');
const { sendRecap } = require('../services/service-report/recap-delivery');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
const SAVED_GATE = process.env.GATE_RECAP_GLASSES_CLIPS;
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);

async function insertRecap(fields, scheduledServiceId = randomUUID()) {
  const [row] = await mockPg('service_recaps').insert({
    scheduled_service_id: scheduledServiceId,
    status: 'ready',
    s3_key: 'recaps/test/visit-recap-v1.mp4',
    greeting_version: pipeline.RECAP_GREETING_VERSION,
    ...fields,
  }).returning('*');
  return row;
}

describeDb('late recap clips: the send and render races', () => {
  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    mockPg = await database.transaction();
  });
  afterEach(async () => {
    const trx = mockPg;
    mockPg = database;
    await trx.rollback();
    if (SAVED_GATE === undefined) delete process.env.GATE_RECAP_GLASSES_CLIPS; else process.env.GATE_RECAP_GLASSES_CLIPS = SAVED_GATE;
  });
  afterAll(async () => {
    if (database) await database.destroy();
  });

  test('a forced re-render leaves a recap whose send is in progress alone, and takes one whose send went stale', async () => {
    const inFlight = await insertRecap({ status: 'approved', approved_at: minutesAgo(1), send_attempt_at: minutesAgo(1) });
    expect(await pipeline.enqueueRecap(inFlight.scheduled_service_id, { force: true })).toMatchObject({ ok: true, queued: false });
    expect(await mockPg('service_recaps').where({ id: inFlight.id }).first('status', 'approved_at'))
      .toMatchObject({ status: 'approved', approved_at: expect.any(Date) });

    const stale = await insertRecap({ status: 'approved', approved_at: minutesAgo(20), send_attempt_at: minutesAgo(10) });
    expect(await pipeline.enqueueRecap(stale.scheduled_service_id, { force: true })).toMatchObject({ ok: true, queued: true });
    expect(await mockPg('service_recaps').where({ id: stale.id }).first('status', 'approved_at'))
      .toEqual({ status: 'pending', approved_at: null });
  });

  test('a send whose recap was re-queued after its read is not claimed: no text goes out', async () => {
    const [customer] = await mockPg('customers').insert({ first_name: 'Test', phone: '+19415550100' }).returning('id');
    const [visit] = await mockPg('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: '2026-11-01', service_type: 'Quarterly Pest Control Service', status: 'completed',
    }).returning('id');
    const recap = await insertRecap({ status: 'approved', approved_at: minutesAgo(1) }, visit.id);
    await mockPg('service_records').insert({
      scheduled_service_id: recap.scheduled_service_id,
      customer_id: customer.id,
      service_date: '2026-11-01',
      service_type: 'Quarterly Pest Control Service',
      report_view_token: null,
    });
    // The late clip lands while the sender looks up the report link, just before its claim.
    ensureReportToken.mockImplementation(async () => {
      await pipeline.enqueueRecap(recap.scheduled_service_id, { force: true });
      return 'test-token';
    });

    const result = await sendRecap(recap.scheduled_service_id);

    expect(result).toMatchObject({ ok: false });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(await mockPg('service_recaps').where({ id: recap.id }).first('status', 'sent_at', 'send_attempt_at'))
      .toEqual({ status: 'pending', sent_at: null, send_attempt_at: null });
  });

  describe('an approval that loses the race', () => {
    // A knex whose first service_recaps read runs `between` before handing back the row it read.
    function knexWithStepAfterRecapRead(between) {
      let fired = false;
      const wrapped = (table) => {
        const query = mockPg(table);
        if (table !== 'service_recaps' || fired) return query;
        const first = query.first.bind(query);
        query.first = async (...columns) => {
          const row = await first(...columns);
          fired = true;
          await between(row);
          return row;
        };
        return query;
      };
      wrapped.fn = mockPg.fn;
      wrapped.raw = (...args) => mockPg.raw(...args);
      return wrapped;
    }

    test('a late clip re-queues the recap after the approval read it: nothing is approved', async () => {
      const recap = await insertRecap({ status: 'ready', rendered_at: minutesAgo(3) });
      const knexRace = knexWithStepAfterRecapRead(() => pipeline.enqueueRecap(recap.scheduled_service_id, { force: true }));

      const result = await pipeline.approveRecap(recap.scheduled_service_id, { approvedBy: 'tech', knex: knexRace });

      expect(result).toEqual({ ok: false, error: 'not_ready (re-rendering)' });
      expect(await mockPg('service_recaps').where({ id: recap.id }).first('status', 'approved_at'))
        .toEqual({ status: 'pending', approved_at: null });
    });

    test('a newer render replaced the one the approval read: the newer one is not approved unseen', async () => {
      const recap = await insertRecap({ status: 'ready', rendered_at: minutesAgo(3) });
      const knexRace = knexWithStepAfterRecapRead(() => mockPg('service_recaps').where({ id: recap.id })
        .update({ status: 'ready', rendered_at: new Date(), s3_key: 'recaps/test/visit-recap-v2.mp4' }));

      const result = await pipeline.approveRecap(recap.scheduled_service_id, { approvedBy: 'tech', knex: knexRace });

      expect(result).toEqual({ ok: false, error: 'not_ready (re-rendering)' });
      expect((await mockPg('service_recaps').where({ id: recap.id }).first('status')).status).toBe('ready');
    });

    test('with no race, the ready recap is approved', async () => {
      const recap = await insertRecap({ status: 'ready', rendered_at: minutesAgo(3) });
      const result = await pipeline.approveRecap(recap.scheduled_service_id, { approvedBy: 'tech' });
      expect(result).toMatchObject({ ok: true, recap: { status: 'approved', approved_by: 'tech' } });
    });
  });

  describe('the late-clip mark', () => {
    beforeEach(() => { process.env.GATE_RECAP_GLASSES_CLIPS = 'true'; });
    const READY_CLIP = { status: 'ready' };
    const row = (id) => mockPg('service_recaps').where({ id }).first('status', 'approved_at', 'clip_revision', 'attempts');

    test('a built, unsent recap goes back to pending with its approval cleared', async () => {
      const recap = await insertRecap({ status: 'approved', approved_at: minutesAgo(1), approved_by: 'tech', attempts: 3 });
      expect(await pipeline.rebuildRecapForLateClip(recap.scheduled_service_id, READY_CLIP)).toEqual({ marked: true, status: 'pending' });
      expect(await row(recap.id)).toEqual({ status: 'pending', approved_at: null, clip_revision: 1, attempts: 0 });
    });

    test('a rendering recap keeps rendering; only the count moves', async () => {
      const recap = await insertRecap({ status: 'rendering', locked_at: minutesAgo(1), attempts: 1 });
      expect(await pipeline.rebuildRecapForLateClip(recap.scheduled_service_id, READY_CLIP)).toEqual({ marked: true, status: 'rendering' });
      expect(await row(recap.id)).toMatchObject({ status: 'rendering', clip_revision: 1, attempts: 1 });
    });

    test('a recap being sent keeps its approval', async () => {
      const recap = await insertRecap({ status: 'approved', approved_at: minutesAgo(1), send_attempt_at: minutesAgo(1) });
      await pipeline.rebuildRecapForLateClip(recap.scheduled_service_id, READY_CLIP);
      expect(await row(recap.id)).toMatchObject({ status: 'approved', approved_at: expect.any(Date) });
    });

    test('a sent recap is not touched', async () => {
      const recap = await insertRecap({ status: 'approved', approved_at: minutesAgo(9), sent_at: minutesAgo(8) });
      expect(await pipeline.rebuildRecapForLateClip(recap.scheduled_service_id, READY_CLIP)).toEqual({ marked: false, status: null });
      expect(await row(recap.id)).toMatchObject({ status: 'approved', clip_revision: 0 });
    });

    test('gate off: nothing is touched', async () => {
      delete process.env.GATE_RECAP_GLASSES_CLIPS;
      const recap = await insertRecap({ status: 'ready' });
      expect(await pipeline.rebuildRecapForLateClip(recap.scheduled_service_id, READY_CLIP)).toEqual({ marked: false });
      expect(await row(recap.id)).toMatchObject({ status: 'ready', clip_revision: 0 });
    });
  });

  describe('a render that finishes', () => {
    beforeEach(() => {
      buildRecapPayload.mockResolvedValue({ media: [] });
      renderRecapToFile.mockResolvedValue('/tmp/recap-test.mp4');
      putRecapFromFile.mockResolvedValue('recaps/test/visit-recap-v1.mp4');
    });

    // The claim's copy of the row is what processRecap gets (claimDueRecaps RETURNING r.*).
    async function claimedRecap() {
      return insertRecap({ status: 'rendering', locked_at: minutesAgo(2), attempts: 1, rendered_at: null });
    }

    test('gate on: a clip counted during the render queues one more render, and nothing can be approved or sent', async () => {
      process.env.GATE_RECAP_GLASSES_CLIPS = 'true';
      const claimed = await claimedRecap();
      await pipeline.rebuildRecapForLateClip(claimed.scheduled_service_id, { status: 'ready' });

      expect(await pipeline.processRecap(claimed)).toMatchObject({ status: 'pending' });
      expect(await pipeline.approveRecap(claimed.scheduled_service_id, { approvedBy: 'tech' }))
        .toEqual({ ok: false, error: 'not_ready (pending)' });
      expect(await sendRecap(claimed.scheduled_service_id)).toMatchObject({ ok: false });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(await mockPg('service_recaps').where({ id: claimed.id }).first('status', 'attempts'))
        .toEqual({ status: 'pending', attempts: 0 });
    });

    test('gate on: no clip after the claim publishes ready', async () => {
      process.env.GATE_RECAP_GLASSES_CLIPS = 'true';
      const claimed = await claimedRecap();
      expect(await pipeline.processRecap(claimed)).toMatchObject({ status: 'ready' });
      expect((await mockPg('service_recaps').where({ id: claimed.id }).first('status')).status).toBe('ready');
    });

    test('gate off: the render ends ready, exactly as before', async () => {
      delete process.env.GATE_RECAP_GLASSES_CLIPS;
      const claimed = await claimedRecap();
      await mockPg('service_recaps').where({ id: claimed.id }).update({ clip_revision: 4 });
      expect(await pipeline.processRecap(claimed)).toMatchObject({ status: 'ready' });
      expect((await mockPg('service_recaps').where({ id: claimed.id }).first('status')).status).toBe('ready');
    });
  });
});
