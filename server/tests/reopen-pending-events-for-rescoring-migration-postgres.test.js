// Runs with the existing CI PostgreSQL pass, in its own schema; never a
// production connection. Verifies the one-time re-open migration against a
// real events_raw table: which pending rows lose their stored assessment
// (and are re-scored by the next curation run) and which are left alone.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

const migration = require('../models/migrations/20260928010000_reopen_pending_events_for_rescoring');

const DAY = 24 * 60 * 60 * 1000;

(SKIP ? describe.skip : describe)('reopen pending events for re-scoring (PostgreSQL)', () => {
  let db;
  const schema = `reopen_rescoring_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    // Only the columns the migration reads or writes (20260427000003,
    // 20260611000014, 20260728100000).
    await db.schema.createTable('events_raw', (t) => {
      t.increments('id');
      t.string('title');
      t.string('admin_status').notNullable().defaultTo('pending');
      t.integer('merged_into');
      t.string('approved_via', 20);
      t.timestamp('start_at');
      t.timestamp('curated_at');
      t.text('curation_note');
      t.integer('editorial_score');
      t.jsonb('score_breakdown');
      t.jsonb('rejection_codes');
      t.jsonb('audience_tags');
      t.string('novelty_type');
      t.jsonb('editorial_evidence');
      t.timestamp('updated_at');
    });
  }, 30000);

  afterAll(async () => {
    await db?.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]).catch(() => {});
    await db?.destroy();
  });

  async function insert(title, overrides = {}) {
    const [row] = await db('events_raw').insert({
      title,
      admin_status: 'pending',
      start_at: new Date(Date.now() + 10 * DAY),
      curated_at: new Date(),
      editorial_score: 64,
      score_breakdown: JSON.stringify({ final: 64 }),
      rejection_codes: JSON.stringify([]),
      ...overrides,
    }).returning('id');
    return row.id ?? row;
  }

  test('re-opens upcoming pending scored rows; leaves policy rejections, decided, merged and past rows alone', async () => {
    const reopened = await insert('scored pending');
    const policy = await insert('policy rejection', { rejection_codes: JSON.stringify(['business_open_house']) });
    const approved = await insert('approved', { admin_status: 'approved' });
    const merged = await insert('merged', { merged_into: reopened });
    const past = await insert('past', { start_at: new Date(Date.now() - 3 * DAY) });
    // Operator resets made with this code carry approved_via 'operator_reset'
    // and happen after this one-time migration runs at deploy; prod had no
    // pending scored row with approved_via set when it shipped.

    await migration.up(db);

    const byId = new Map((await db('events_raw').select('*')).map((r) => [r.id, r]));
    expect(byId.get(reopened).curated_at).toBeNull();
    expect(byId.get(reopened).score_breakdown).toBeNull();
    expect(byId.get(reopened).editorial_score).toBeNull();
    for (const id of [policy, approved, merged, past]) {
      expect(byId.get(id).curated_at).not.toBeNull();
    }
    expect(byId.get(policy).score_breakdown).not.toBeNull();
  });

  test('down is a no-op', async () => {
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
