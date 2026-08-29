/**
 * series_moves.cleanup_done_at — stamped once every row the move rewound
 * (result.rewoundIds) had its technician pointer released and tracker
 * refreshed. Until then the effects reconciler keeps re-running the
 * idempotent replaySeriesMoveCleanup for the operation, so a pass that died
 * (or a swallowed clearTechCurrentJob failure) can never leave a technician
 * pinned to a moved visit permanently.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('series_moves'))) return;
  if (!(await knex.schema.hasColumn('series_moves', 'cleanup_done_at'))) {
    await knex.schema.alterTable('series_moves', (t) => {
      t.timestamp('cleanup_done_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('series_moves'))) return;
  if (await knex.schema.hasColumn('series_moves', 'cleanup_done_at')) {
    await knex.schema.alterTable('series_moves', (t) => {
      t.dropColumn('cleanup_done_at');
    });
  }
};
