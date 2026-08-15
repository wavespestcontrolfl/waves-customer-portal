// Live-PG behavioral test for 20260815000003_call_log_twilio_sid_unique —
// specifically the child-table unique-collision handling added after the
// prod 2026-08-15 failure: repointing loser-referencing rows onto the winner
// collided with the winner's own row under call_spam_verdicts'
// (call_log_id, classifier_version) unique and aborted the deploy.
//
// Runs only with DATABASE_URL (repo convention: the CI jest suite runs
// without it by design — execute locally against a scratch DB/staging).
// Everything happens inside a throwaway schema with search_path pinned to
// it, so ::regclass lookups and unqualified UPDATEs resolve to the scratch
// tables, never the real ones.

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const migration = require('../models/migrations/20260815000003_call_log_twilio_sid_unique');

const SCHEMA = `mig_dedupe_test_${process.pid}`;

function makeKnex() {
   
  const knexFactory = require('knex');
  return knexFactory({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    searchPath: [SCHEMA],
    pool: { min: 1, max: 2 },
  });
}

async function createScratchTables(knex) {
  await knex.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await knex.raw(`CREATE SCHEMA "${SCHEMA}"`);
  await knex.raw(`
    CREATE TABLE "${SCHEMA}".call_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      twilio_call_sid text,
      status text,
      metadata jsonb,
      recording_sid text,
      transcription text,
      ai_extraction jsonb,
      ai_extraction_enriched jsonb,
      duration_seconds int,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`
    CREATE TABLE "${SCHEMA}".spam_verdicts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      call_log_id uuid NOT NULL REFERENCES "${SCHEMA}".call_log(id) ON DELETE CASCADE,
      verdict text NOT NULL,
      signals jsonb NOT NULL,
      classifier_version text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (call_log_id, classifier_version)
    )`);
  // Partial unique mirrors triage_items' open-only index.
  await knex.raw(`
    CREATE TABLE "${SCHEMA}".open_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      call_log_id uuid NOT NULL REFERENCES "${SCHEMA}".call_log(id) ON DELETE CASCADE,
      reason_code text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`
    CREATE UNIQUE INDEX open_items_open_unique
    ON "${SCHEMA}".open_items (call_log_id, reason_code)
    WHERE status = 'open'`);
}

async function seedDupPair(knex, sid) {
  const [winner] = await knex('call_log')
    .insert({ twilio_call_sid: sid, status: 'completed', recording_sid: `RE${sid}` })
    .returning('*');
  const [loser] = await knex('call_log')
    .insert({ twilio_call_sid: sid, status: 'in-progress' })
    .returning('*');
  return { winner, loser };
}

maybeDescribe('call_log dedupe merges child-table unique collisions', () => {
  let knex;

  beforeEach(async () => {
    knex = makeKnex();
    await createScratchTables(knex);
  });

  afterEach(async () => {
    await knex.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await knex.destroy();
  });

  test('identical colliding verdict rows are merged, not fatal (the prod 2026-08-15 failure)', async () => {
    const { winner, loser } = await seedDupPair(knex, 'CAdup1');
    const signals = { risk: { score: 2 } };
    await knex('spam_verdicts').insert([
      { call_log_id: winner.id, verdict: 'not_spam', signals, classifier_version: 'v3' },
      { call_log_id: loser.id, verdict: 'not_spam', signals, classifier_version: 'v3' },
      // Non-colliding version on the loser must survive and be repointed.
      { call_log_id: loser.id, verdict: 'not_spam', signals, classifier_version: 'v4' },
    ]);

    await migration.up(knex);

    const calls = await knex('call_log').where({ twilio_call_sid: 'CAdup1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(winner.id);
    const verdicts = await knex('spam_verdicts').orderBy('classifier_version');
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((v) => v.call_log_id === winner.id)).toBe(true);
    expect(verdicts.map((v) => v.classifier_version)).toEqual(['v3', 'v4']);
  });

  test('genuinely differing colliding rows throw for manual resolution — nothing guessed', async () => {
    const { winner, loser } = await seedDupPair(knex, 'CAdup2');
    await knex('spam_verdicts').insert([
      { call_log_id: winner.id, verdict: 'not_spam', signals: { a: 1 }, classifier_version: 'v3' },
      { call_log_id: loser.id, verdict: 'spam', signals: { a: 1 }, classifier_version: 'v3' },
    ]);

    await expect(migration.up(knex)).rejects.toThrow(/collide on \(call_log_id, classifier_version\).*"verdict".*resolve by hand/);
    // Failed migration leaves rows in place for the manual pass.
    expect(await knex('call_log').where({ twilio_call_sid: 'CAdup2' })).toHaveLength(2);
    expect(await knex('spam_verdicts')).toHaveLength(2);
  });

  test('partial unique index: only predicate-matching rows collide; others repoint untouched', async () => {
    const { winner, loser } = await seedDupPair(knex, 'CAdup3');
    await knex('open_items').insert([
      { call_log_id: winner.id, reason_code: 'callback', status: 'open' },
      { call_log_id: loser.id, reason_code: 'callback', status: 'open' },      // collides → merged
      { call_log_id: loser.id, reason_code: 'callback', status: 'resolved' },  // pred miss → survives
    ]);

    await migration.up(knex);

    const items = await knex('open_items').orderBy('status');
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.call_log_id === winner.id)).toBe(true);
    expect(items.map((i) => i.status)).toEqual(['open', 'resolved']);
  });

  test('no duplicates → child rows untouched and the unique backstop index lands', async () => {
    const [only] = await knex('call_log')
      .insert({ twilio_call_sid: 'CAsingle', status: 'completed' })
      .returning('*');
    await knex('spam_verdicts').insert(
      { call_log_id: only.id, verdict: 'not_spam', signals: {}, classifier_version: 'v3' }
    );

    await migration.up(knex);

    expect(await knex('spam_verdicts')).toHaveLength(1);
    const { rows } = await knex.raw(
      `SELECT indexname FROM pg_indexes WHERE schemaname = ? AND indexname = 'call_log_twilio_call_sid_unique'`,
      [SCHEMA]
    );
    expect(rows).toHaveLength(1);
  });
});
