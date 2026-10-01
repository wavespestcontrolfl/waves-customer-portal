/**
 * PR #5119 Codex r5: legacy sms_patch_proposals rows (written before the
 * prompt_version column existed) are backfilled to house_voice_v11 so the
 * version-scoped proposer watermark still sees them.
 */
const migration = require('../models/migrations/20260928050000_sms_patch_proposals_backfill_prompt_version');

function fakeKnex() {
  const calls = [];
  const knex = (table) => {
    const b = { table };
    b.whereNull = (col) => { calls.push(['whereNull', table, col]); return b; };
    b.update = async (patch) => { calls.push(['update', table, patch]); return 4; };
    return b;
  };
  knex.calls = calls;
  return knex;
}

test('up backfills ONLY NULL prompt_version rows to house_voice_v11', async () => {
  const knex = fakeKnex();
  await migration.up(knex);
  expect(knex.calls).toEqual([
    ['whereNull', 'sms_patch_proposals', 'prompt_version'],
    ['update', 'sms_patch_proposals', { prompt_version: 'house_voice_v11' }],
  ]);
});

test('down is a no-op (the backfill is irreversible by design)', async () => {
  const knex = fakeKnex();
  await migration.down(knex);
  expect(knex.calls).toEqual([]);
});
