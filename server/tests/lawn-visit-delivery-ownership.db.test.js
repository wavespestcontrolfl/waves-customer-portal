const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const { createLawnVisitDb } = require('./helpers/lawn-visit-db');
const pipelineMigration = require('../models/migrations/20260908000030_lawn_assessment_runs_pipeline');
const ownerMigration = require('../models/migrations/20260909000050_lawn_assessment_runs_pipeline_owner');
const { claimPipeline, renewPipeline, ownsPipeline, releasePipeline, loadRun } = require('../services/lawn-visit-runs');
const { etDateString } = require('../utils/datetime-et');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

(SKIP ? describe.skip : describe)('lawn delivery ownership (real PostgreSQL)', () => {
  let db;
  beforeAll(async () => {
    db = await createLawnVisitDb();
    await pipelineMigration.up(db.knex);
    await ownerMigration.up(db.knex);
  }, 60000);
  afterAll(async () => { if (db) await db.dispose(); });

  async function seed(confirmed = true) {
    const customerId = randomUUID();
    await db.knex('customers').insert({ id: customerId, first_name: 'Delivery fixture', phone: `+1555${String(parseInt(customerId.slice(0, 6), 16) % 10000000).padStart(7, '0')}` });
    const [assessment] = await db.knex('lawn_assessments').insert({
      customer_id: customerId, service_date: etDateString(), confirmed_by_tech: confirmed,
    }).returning('*');
    await db.knex('lawn_assessment_runs').insert({
      assessment_id: assessment.id, customer_id: customerId, status: 'unavailable',
      prompt_version: 'ownership-fixture', context_hash: 'c'.repeat(64),
    });
    return assessment.id;
  }
  const stored = (id) => loadRun(id, db.knex);
  const expire = (id) => db.knex('lawn_assessment_runs').where({ assessment_id: id })
    .update({ pipeline_claimed_at: db.knex.raw("clock_timestamp() - interval '16 minutes'") });

  test('only a confirmed run can be claimed, and simultaneous workers elect one owner', async () => {
    const pending = await seed(false);
    expect(await claimPipeline(pending, db.knex)).toBeNull();
    expect(await claimPipeline(randomUUID(), db.knex)).toBeNull();
    const id = await seed();
    const claims = await Promise.all([claimPipeline(id, db.knex), claimPipeline(id, db.knex)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean);
    expect(winner.pipeline_owner_token).toMatch(/^[a-f0-9-]{36}$/);
    expect(winner.pipeline_claimed_at).toBeInstanceOf(Date);
    expect(await ownsPipeline(id, winner.pipeline_owner_token, db.knex)).toBe(true);
    expect(await ownsPipeline(id, randomUUID(), db.knex)).toBe(false);
  });

  test('renewal uses database time and keeps an active claim exclusive', async () => {
    const id = await seed();
    const claim = await claimPipeline(id, db.knex);
    await db.knex('lawn_assessment_runs').where({ assessment_id: id })
      .update({ pipeline_claimed_at: db.knex.raw("clock_timestamp() - interval '14 minutes'") });
    const before = await stored(id);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(0);
    try {
      expect(await renewPipeline(id, claim.pipeline_owner_token, db.knex)).toBe(true);
      expect(await claimPipeline(id, db.knex)).toBeNull();
    } finally { clock.mockRestore(); }
    const after = await stored(id);
    expect(after.pipeline_owner_token).toBe(claim.pipeline_owner_token);
    expect(after.pipeline_claimed_at.getTime()).toBeGreaterThan(before.pipeline_claimed_at.getTime());
  });

  test('expired workers cannot revive or release a replacement claim', async () => {
    const id = await seed();
    const original = await claimPipeline(id, db.knex);
    await expire(id);
    expect(await renewPipeline(id, original.pipeline_owner_token, db.knex)).toBe(false);
    expect(await ownsPipeline(id, original.pipeline_owner_token, db.knex)).toBe(false);
    const replacement = await claimPipeline(id, db.knex);
    expect(replacement.pipeline_owner_token).not.toBe(original.pipeline_owner_token);
    expect(await renewPipeline(id, original.pipeline_owner_token, db.knex)).toBe(false);
    expect(await releasePipeline(id, original.pipeline_owner_token, db.knex)).toBe(false);
    expect((await stored(id)).pipeline_owner_token).toBe(replacement.pipeline_owner_token);
    expect(await releasePipeline(id, replacement.pipeline_owner_token, db.knex)).toBe(true);
    expect(await claimPipeline(id, db.knex)).not.toBeNull();
  });

  test('completed deliveries cannot be reclaimed or renewed, even with an empty claim timestamp', async () => {
    const id = await seed();
    const claim = await claimPipeline(id, db.knex);
    await db.knex('lawn_assessment_runs').where({ assessment_id: id }).update({
      pipeline_completed_at: db.knex.fn.now(), pipeline_claimed_at: null,
    });
    expect(await claimPipeline(id, db.knex)).toBeNull();
    expect(await renewPipeline(id, claim.pipeline_owner_token, db.knex)).toBe(false);
    expect(await releasePipeline(id, claim.pipeline_owner_token, db.knex)).toBe(false);
  });

  test('timestamp-only historical claims must expire before acquiring a new token', async () => {
    const id = await seed();
    await db.knex('lawn_assessment_runs').where({ assessment_id: id })
      .update({ pipeline_claimed_at: db.knex.fn.now() });
    expect(await claimPipeline(id, db.knex)).toBeNull();
    await expire(id);
    expect((await claimPipeline(id, db.knex)).pipeline_owner_token).toBeTruthy();
  });

  test('claims roll back with an enclosing transaction', async () => {
    const id = await seed();
    const original = await stored(id);
    const failure = new Error('outer transaction failed');
    await expect(db.knex.transaction(async (trx) => {
      expect(await claimPipeline(id, trx)).not.toBeNull();
      throw failure;
    })).rejects.toBe(failure);
    expect(await stored(id)).toEqual(original);
  });

  test('missing ownership DDL fails closed while the caller transaction remains usable', async () => {
    const id = await seed();
    await ownerMigration.down(db.knex);
    try {
      await db.knex.transaction(async (trx) => {
        await expect(claimPipeline(id, trx)).rejects.toMatchObject({ code: '42703' });
        expect((await trx.raw('SELECT 1 AS ok')).rows[0].ok).toBe(1);
      });
      expect((await stored(id)).pipeline_claimed_at).toBeNull();
    } finally { await ownerMigration.up(db.knex); }
  });

  test('the forward migration preserves historical timestamps through repeated and partial upgrades', async () => {
    const id = await seed();
    await ownerMigration.down(db.knex);
    await ownerMigration.down(db.knex);
    await db.knex('lawn_assessment_runs').where({ assessment_id: id }).update({
      pipeline_claimed_at: db.knex.fn.now(), pipeline_completed_at: db.knex.fn.now(),
    });
    const before = await stored(id);
    await db.knex.schema.alterTable('lawn_assessment_runs', (t) => t.uuid('pipeline_owner_token').nullable());
    const token = randomUUID();
    await db.knex('lawn_assessment_runs').where({ assessment_id: id }).update({ pipeline_owner_token: token });
    await ownerMigration.up(db.knex);
    await ownerMigration.up(db.knex);
    const after = await stored(id);
    expect(after).toMatchObject({
      pipeline_claimed_at: before.pipeline_claimed_at, pipeline_completed_at: before.pipeline_completed_at,
      pipeline_owner_token: token, pipeline_health_completed_at: null,
    });
    const { rows } = await db.knex.raw('SELECT udt_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?', [db.schema, 'lawn_assessment_runs', 'pipeline_health_completed_at']);
    expect(rows[0].udt_name).toBe('timestamptz');
  });

  test('invalid durations and missing ownership never touch an eligible run', async () => {
    const id = await seed();
    const before = await stored(id);
    for (const staleAfterMs of [0, -1, Infinity, '900']) {
      await expect(claimPipeline(id, db.knex, { staleAfterMs })).rejects.toThrow(TypeError);
    }
    await expect(renewPipeline(id, null, db.knex)).rejects.toThrow(TypeError);
    await expect(releasePipeline(id, '', db.knex)).rejects.toThrow(TypeError);
    expect(await stored(id)).toEqual(before);
  });
});
