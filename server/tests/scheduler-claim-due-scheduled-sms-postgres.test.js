// CI's DB-gated pass runs this against PostgreSQL. Fixture data lives in a
// unique schema dropped after the suite.
//
// claimDueScheduledSms (server/services/scheduler.js) — the claim query that
// flips a due 'scheduled' sms_log row to 'sending'. Owner ruling 2026-09-28:
// a voicemail_lead_sms_deferred row queued only because the 8am-8pm window
// was closed (original_block_code QUIET_HOURS_HOLD) is due NOW, whatever its
// stored scheduled_for says — that window no longer fences this entry point
// at all, so a row still carrying a future scheduled_for (queued before this
// code shipped, or by an old instance mid-deploy) must not keep waiting.
// Every OTHER retry reason on the same entry point keeps its own
// scheduled_for.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), logGateStatus: jest.fn() }));

const { claimDueScheduledSms } = require('../services/scheduler');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('claimDueScheduledSms on PostgreSQL', () => {
  let database;
  const schema = `claim_due_sms_${randomUUID().replaceAll('-', '')}`;
  const NOW = new Date('2026-09-28T02:00:00Z'); // 22:00 ET the prior evening — outside 8am-8pm

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.sms_log AS SELECT * FROM public.sms_log WITH NO DATA', [schema]);
    mockConn = database;
  });
  afterEach(async () => {
    await database.raw('TRUNCATE TABLE ??.sms_log CASCADE', [schema]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const row = (extra = {}) => ({
    id: randomUUID(), direction: 'outbound', from_phone: '+19412975749', to_phone: '+19415550100',
    message_body: 'hi', status: 'scheduled', created_at: NOW, ...extra,
  });
  const statusOf = async (id) => (await database('sms_log').where({ id }).first('status')).status;

  test('a row plainly due (scheduled_for <= now) is claimed — the baseline case is unchanged', async () => {
    const due = row({ scheduled_for: new Date(NOW.getTime() - 60 * 1000) });
    await database('sms_log').insert(due);
    const claimed = await claimDueScheduledSms(NOW);
    expect(claimed.map((r) => r.id)).toEqual([due.id]);
    expect(await statusOf(due.id)).toBe('sending');
  });

  test('a voicemail_lead_sms_deferred row queued for QUIET_HOURS_HOLD is claimed NOW even though scheduled_for is hours away', async () => {
    const queuedFor8am = row({
      scheduled_for: new Date(NOW.getTime() + 8 * 60 * 60 * 1000),
      metadata: { entry_point: 'voicemail_lead_sms_deferred', original_block_code: 'QUIET_HOURS_HOLD' },
    });
    await database('sms_log').insert(queuedFor8am);
    const claimed = await claimDueScheduledSms(NOW);
    expect(claimed.map((r) => r.id)).toEqual([queuedFor8am.id]);
    expect(await statusOf(queuedFor8am.id)).toBe('sending');
  });

  test('a voicemail_lead_sms_deferred row queued for a DIFFERENT retry reason keeps its own scheduled_for', async () => {
    const rateLimited = row({
      scheduled_for: new Date(NOW.getTime() + 8 * 60 * 60 * 1000),
      metadata: { entry_point: 'voicemail_lead_sms_deferred', original_block_code: 'PROVIDER_RATE_LIMIT' },
    });
    await database('sms_log').insert(rateLimited);
    const claimed = await claimDueScheduledSms(NOW);
    expect(claimed).toHaveLength(0);
    expect(await statusOf(rateLimited.id)).toBe('scheduled');
  });

  test('a QUIET_HOURS_HOLD row on a DIFFERENT entry point keeps its own scheduled_for', async () => {
    const otherEntryPoint = row({
      scheduled_for: new Date(NOW.getTime() + 8 * 60 * 60 * 1000),
      metadata: { entry_point: 'appointment_reminder_cron', original_block_code: 'QUIET_HOURS_HOLD' },
    });
    await database('sms_log').insert(otherEntryPoint);
    const claimed = await claimDueScheduledSms(NOW);
    expect(claimed).toHaveLength(0);
    expect(await statusOf(otherEntryPoint.id)).toBe('scheduled');
  });

  test('an accelerated claim pulls scheduled_for to the claim time so stale-claim recovery can see it', async () => {
    const queuedFor8am = row({
      scheduled_for: new Date(NOW.getTime() + 8 * 60 * 60 * 1000),
      metadata: { entry_point: 'voicemail_lead_sms_deferred', original_block_code: 'QUIET_HOURS_HOLD' },
    });
    const due = row({ scheduled_for: new Date(NOW.getTime() - 60 * 1000) });
    await database('sms_log').insert([queuedFor8am, due]);
    await claimDueScheduledSms(NOW);
    const after = await database('sms_log').whereIn('id', [queuedFor8am.id, due.id]).select('id', 'scheduled_for');
    const byId = Object.fromEntries(after.map((r) => [r.id, new Date(r.scheduled_for).getTime()]));
    expect(byId[queuedFor8am.id]).toBe(NOW.getTime());
    expect(byId[due.id]).toBe(due.scheduled_for.getTime()); // a plainly due row keeps its own time
  });

  test('claim -> retry -> claim: after the first accelerated attempt, a failure backoff is honored', async () => {
    const queuedFor8am = row({
      scheduled_for: new Date(NOW.getTime() + 8 * 60 * 60 * 1000),
      metadata: { entry_point: 'voicemail_lead_sms_deferred', original_block_code: 'QUIET_HOURS_HOLD' },
    });
    await database('sms_log').insert(queuedFor8am);
    expect((await claimDueScheduledSms(NOW)).map((r) => r.id)).toEqual([queuedFor8am.id]);
    // The send fails retryably: the scheduler re-queues it 15 minutes out,
    // keeping the metadata (original_block_code included) it was claimed with.
    const retryAt = new Date(NOW.getTime() + 15 * 60 * 1000);
    await database('sms_log').where({ id: queuedFor8am.id }).update({ status: 'scheduled', scheduled_for: retryAt });
    expect(await claimDueScheduledSms(new Date(NOW.getTime() + 2 * 60 * 1000))).toEqual([]);
    expect(await statusOf(queuedFor8am.id)).toBe('scheduled');
    expect((await claimDueScheduledSms(retryAt)).map((r) => r.id)).toEqual([queuedFor8am.id]);
  });

  test('a row with no scheduled_for at all is never claimed', async () => {
    const noSchedule = row({ scheduled_for: null });
    await database('sms_log').insert(noSchedule);
    const claimed = await claimDueScheduledSms(NOW);
    expect(claimed).toHaveLength(0);
  });

  test('mixed batch: the due row and the QUIET_HOURS_HOLD voicemail row both claim; the others do not', async () => {
    const due = row({ scheduled_for: new Date(NOW.getTime() - 60 * 1000) });
    const heldForWindow = row({
      scheduled_for: new Date(NOW.getTime() + 8 * 60 * 60 * 1000),
      metadata: { entry_point: 'voicemail_lead_sms_deferred', original_block_code: 'QUIET_HOURS_HOLD' },
    });
    const heldForOther = row({
      scheduled_for: new Date(NOW.getTime() + 8 * 60 * 60 * 1000),
      metadata: { entry_point: 'voicemail_lead_sms_deferred', original_block_code: 'PROVIDER_RATE_LIMIT' },
    });
    await database('sms_log').insert([due, heldForWindow, heldForOther]);
    const claimed = await claimDueScheduledSms(NOW);
    expect(claimed.map((r) => r.id).sort()).toEqual([due.id, heldForWindow.id].sort());
    expect(await statusOf(heldForOther.id)).toBe('scheduled');
  });
});
