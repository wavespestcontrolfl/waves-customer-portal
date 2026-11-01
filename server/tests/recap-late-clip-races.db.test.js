// Late recap clips (GATE_RECAP_GLASSES_CLIPS, owner 2026-11-01) against the races a re-render can lose, through
// PostgreSQL. Every state change orders on the service_recaps row: the late-clip mark (clip_revision + re-queue),
// a render's finish (publishes 'ready' only when clip_revision is still the claimed one), an approval (only the
// render it read) and a send claim (only an approved recap). A forced re-render never pulls a recap out from under
// a send in progress. A clip change (confirm or removal) and its recap mark commit together, the mark first.
// Writes run in a transaction that is rolled back, except the two-connection test, which commits its rows and
// deletes them after. Synthetic rows only. Skips without DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockHeadBytes = 1000;
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn(async () => ({ ContentLength: mockHeadBytes })) })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));
jest.mock('../config', () => ({ ...jest.requireActual('../config'), s3: { bucket: 'test-bucket', region: 'us-east-1' } }));

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
const recapMedia = require('../services/service-report/recap-media');
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

// An approved recap with the rows sendRecap needs to reach its claim (customer, visit, report).
async function insertSendableRecap(fields) {
  const [customer] = await mockPg('customers').insert({ first_name: 'Test', phone: '+19415550100' }).returning('id');
  const [visit] = await mockPg('scheduled_services').insert({
    customer_id: customer.id, scheduled_date: '2026-11-01', service_type: 'Quarterly Pest Control Service', status: 'completed',
  }).returning('id');
  const recap = await insertRecap({ status: 'approved', approved_at: minutesAgo(1), ...fields }, visit.id);
  await mockPg('service_records').insert({
    scheduled_service_id: recap.scheduled_service_id,
    customer_id: customer.id,
    service_date: '2026-11-01',
    service_type: 'Quarterly Pest Control Service',
    report_view_token: null,
  });
  return recap;
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
    const recap = await insertSendableRecap({});
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
      expect(await pipeline.markRecapClipsChanged(recap.scheduled_service_id, READY_CLIP)).toEqual({ marked: true, status: 'pending' });
      expect(await row(recap.id)).toEqual({ status: 'pending', approved_at: null, clip_revision: 1, attempts: 0 });
    });

    test('a rendering recap keeps rendering; only the count moves', async () => {
      const recap = await insertRecap({ status: 'rendering', locked_at: minutesAgo(1), attempts: 1 });
      expect(await pipeline.markRecapClipsChanged(recap.scheduled_service_id, READY_CLIP)).toEqual({ marked: true, status: 'rendering' });
      expect(await row(recap.id)).toMatchObject({ status: 'rendering', clip_revision: 1, attempts: 1 });
    });

    test('a recap being sent keeps its approval', async () => {
      const recap = await insertRecap({ status: 'approved', approved_at: minutesAgo(1), send_attempt_at: minutesAgo(1) });
      await pipeline.markRecapClipsChanged(recap.scheduled_service_id, READY_CLIP);
      expect(await row(recap.id)).toMatchObject({ status: 'approved', approved_at: expect.any(Date) });
    });

    test('a clip changed during a send that then failed: the retry renders again instead of sending the old video', async () => {
      const recap = await insertRecap({ status: 'approved', approved_at: minutesAgo(1), send_attempt_at: minutesAgo(1) });
      await pipeline.markRecapClipsChanged(recap.scheduled_service_id, READY_CLIP);
      // The send fails: recap-delivery releases its in-flight marker; the recap is still approved.
      await mockPg('service_recaps').where({ id: recap.id }).update({ send_attempt_at: null });

      expect(await sendRecap(recap.scheduled_service_id)).toEqual({ ok: false, reason: 'rerendering_clips' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(await row(recap.id)).toMatchObject({ status: 'pending', approved_at: null, clip_revision: 1 });
    });

    test('a retry that read a clean count while another send ran: a clip change and that send failing first stop its claim', async () => {
      const recap = await insertSendableRecap({ send_attempt_at: minutesAgo(1) });
      // While the retry looks up the report link: a clip changes during the other send, then that send
      // fails and releases its in-flight marker. The retry read clip_revision 0 before both.
      ensureReportToken.mockImplementation(async () => {
        await pipeline.markRecapClipsChanged(recap.scheduled_service_id, READY_CLIP);
        await mockPg('service_recaps').where({ id: recap.id }).update({ send_attempt_at: null });
        return 'test-token';
      });

      expect(await sendRecap(recap.scheduled_service_id)).toEqual({ ok: false, reason: 'rerendering_clips' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(await row(recap.id)).toMatchObject({ status: 'pending', approved_at: null, clip_revision: 1 });
    });

    test('a send that died mid-way: the re-claim after its window renders again too', async () => {
      const recap = await insertRecap({ status: 'approved', approved_at: minutesAgo(20), send_attempt_at: minutesAgo(1) });
      await pipeline.markRecapClipsChanged(recap.scheduled_service_id, READY_CLIP);
      await mockPg('service_recaps').where({ id: recap.id }).update({ send_attempt_at: minutesAgo(10) });

      expect(await sendRecap(recap.scheduled_service_id)).toEqual({ ok: false, reason: 'rerendering_clips' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(await row(recap.id)).toMatchObject({ status: 'pending', approved_at: null });
    });

    test('a sent recap is not touched', async () => {
      const recap = await insertRecap({ status: 'approved', approved_at: minutesAgo(9), sent_at: minutesAgo(8) });
      expect(await pipeline.markRecapClipsChanged(recap.scheduled_service_id, READY_CLIP)).toEqual({ marked: false, status: null });
      expect(await row(recap.id)).toMatchObject({ status: 'approved', clip_revision: 0 });
    });

    test('gate off: nothing is touched', async () => {
      delete process.env.GATE_RECAP_GLASSES_CLIPS;
      const recap = await insertRecap({ status: 'ready' });
      expect(await pipeline.markRecapClipsChanged(recap.scheduled_service_id, READY_CLIP)).toEqual({ marked: false });
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
      await pipeline.markRecapClipsChanged(claimed.scheduled_service_id, { status: 'ready' });

      expect(await pipeline.processRecap(claimed)).toMatchObject({ status: 'pending' });
      expect(await pipeline.approveRecap(claimed.scheduled_service_id, { approvedBy: 'tech' }))
        .toEqual({ ok: false, error: 'not_ready (pending)' });
      expect(await sendRecap(claimed.scheduled_service_id)).toMatchObject({ ok: false });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(await mockPg('service_recaps').where({ id: claimed.id }).first('status', 'attempts'))
        .toEqual({ status: 'pending', attempts: 0 });
    });

    test('gate on: no clip after the claim publishes ready, and the count starts again from 0', async () => {
      process.env.GATE_RECAP_GLASSES_CLIPS = 'true';
      const claimed = await claimedRecap();
      await mockPg('service_recaps').where({ id: claimed.id }).update({ clip_revision: 2 });
      expect(await pipeline.processRecap({ ...claimed, clip_revision: 2 })).toMatchObject({ status: 'ready' });
      expect(await mockPg('service_recaps').where({ id: claimed.id }).first('status', 'clip_revision'))
        .toEqual({ status: 'ready', clip_revision: 0 });
    });

    test('gate off: the render ends ready, exactly as before', async () => {
      delete process.env.GATE_RECAP_GLASSES_CLIPS;
      const claimed = await claimedRecap();
      await mockPg('service_recaps').where({ id: claimed.id }).update({ clip_revision: 4 });
      expect(await pipeline.processRecap(claimed)).toMatchObject({ status: 'ready' });
      expect((await mockPg('service_recaps').where({ id: claimed.id }).first('status')).status).toBe('ready');
    });
  });
  describe('a clip change and its recap mark commit together', () => {
    beforeEach(() => { process.env.GATE_RECAP_GLASSES_CLIPS = 'true'; });
    const markFails = async () => { throw new Error('mark failed'); };
    const insertClip = async (scheduledServiceId, status) => (await mockPg('service_media').insert({
      scheduled_service_id: scheduledServiceId, media_type: 'video', role: 'perimeter',
      s3_key: 'recap-media/test/clip.mp4', status, duration_ms: 5000,
    }).returning('*'))[0];

    test('a failed mark rolls the confirm back: the clip stays uploading', async () => {
      const recap = await insertRecap({ status: 'ready' });
      const clip = await insertClip(recap.scheduled_service_id, 'uploading');
      await expect(recapMedia.confirmUpload(clip.id, { scheduledServiceId: recap.scheduled_service_id, durationMs: 5000, onChange: markFails }))
        .rejects.toThrow('mark failed');
      expect((await mockPg('service_media').where({ id: clip.id }).first('status')).status).toBe('uploading');
    });

    test('a failed mark rolls the removal back: the clip is still there', async () => {
      const recap = await insertRecap({ status: 'ready' });
      const clip = await insertClip(recap.scheduled_service_id, 'ready');
      await expect(recapMedia.deleteMedia(clip.id, { scheduledServiceId: recap.scheduled_service_id, onChange: markFails }))
        .rejects.toThrow('mark failed');
      expect((await mockPg('service_media').where({ id: clip.id }).first('status')).status).toBe('ready');
    });

    describe('on two connections', () => {
      // These rows are committed, so a second connection sees them; each test deletes its own.
      let committedRecap = null;
      afterEach(async () => {
        if (!committedRecap) return;
        await database('service_media').where({ scheduled_service_id: committedRecap.scheduled_service_id }).del();
        await database('service_recaps').where({ id: committedRecap.id }).del();
        committedRecap = null;
      });

      test('a removal that waits on a confirm of the same clip marks the recap with the confirmed status', async () => {
        const scheduledServiceId = randomUUID();
        [committedRecap] = await database('service_recaps').insert({
          scheduled_service_id: scheduledServiceId, status: 'ready', s3_key: 'recaps/test/visit-recap-v1.mp4',
          rendered_at: minutesAgo(3), greeting_version: pipeline.RECAP_GREETING_VERSION,
        }).returning('*');
        const [clip] = await database('service_media').insert({
          scheduled_service_id: scheduledServiceId, media_type: 'video', role: 'perimeter',
          s3_key: 'recap-media/test/clip.mp4', status: 'uploading',
        }).returning('*');
        const removalSaw = [];
        let removal;

        const confirmed = await recapMedia.confirmUpload(clip.id, {
          scheduledServiceId,
          durationMs: 5000,
          onChange: async (row, trx) => {
            await pipeline.markRecapClipsChanged(scheduledServiceId, row, { knex: trx });
            // The tech removes the clip while its confirm is mid-transaction, on another connection.
            removal = recapMedia.deleteMedia(clip.id, {
              scheduledServiceId,
              onChange: async (current, removalTrx) => {
                removalSaw.push(current.status);
                await pipeline.markRecapClipsChanged(scheduledServiceId, current, { knex: removalTrx });
              },
            }, database);
            await new Promise((resolve) => { setTimeout(resolve, 150); });
          },
        }, database);

        expect(confirmed).toMatchObject({ ok: true, row: { status: 'ready' } });
        expect(await removal).toMatchObject({ id: clip.id, status: 'ready' });
        expect(removalSaw).toEqual(['ready']);
        expect(await database('service_recaps').where({ id: committedRecap.id }).first('status', 'clip_revision'))
          .toEqual({ status: 'pending', clip_revision: 2 });
        expect(await database('service_media').where({ id: clip.id }).first()).toBeUndefined();
      });

      test('a removal holds the recap row until it commits: a render claim skips it, an approval is refused', async () => {
        const scheduledServiceId = randomUUID();
        [committedRecap] = await database('service_recaps').insert({
          scheduled_service_id: scheduledServiceId, status: 'ready', s3_key: 'recaps/test/visit-recap-v1.mp4',
          rendered_at: minutesAgo(3), greeting_version: pipeline.RECAP_GREETING_VERSION,
        }).returning('*');
        const [clip] = await database('service_media').insert({
          scheduled_service_id: scheduledServiceId, media_type: 'video', role: 'perimeter',
          s3_key: 'recap-media/test/clip.mp4', status: 'ready', duration_ms: 5000,
        }).returning('*');
        let renderClaim;
        let approval;

        await recapMedia.deleteMedia(clip.id, {
          scheduledServiceId,
          onChange: async (row, trx) => {
            await pipeline.markRecapClipsChanged(scheduledServiceId, row, { knex: trx });
            // Mid-change, from other connections: the render's SKIP LOCKED claim, and the tech's approval.
            renderClaim = await database.raw('SELECT id FROM service_recaps WHERE id = ? FOR UPDATE SKIP LOCKED', [committedRecap.id]);
            approval = pipeline.approveRecap(scheduledServiceId, { approvedBy: 'tech', knex: database });
          },
        }, database);

        expect(renderClaim.rows).toEqual([]);
        expect(await approval).toMatchObject({ ok: false });
        expect(await database('service_recaps').where({ id: committedRecap.id }).first('status', 'approved_at', 'clip_revision'))
          .toEqual({ status: 'pending', approved_at: null, clip_revision: 1 });
        expect(await database('service_media').where({ id: clip.id }).first()).toBeUndefined();
      });
    });
  });
});
