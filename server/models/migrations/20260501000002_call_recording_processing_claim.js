/**
 * Add a retry-safe processing claim for call recordings.
 *
 * processing_status remains the human-readable state.
 * processing_token/processing_started_at make the processor claim atomic so
 * webhook retries and manual admin retries do not run side effects twice.
 */
exports.up = async function (knex) {
  const cols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', (t) => {
    if (!cols.processing_token) t.string('processing_token', 80).nullable();
    if (!cols.processing_started_at) t.timestamp('processing_started_at').nullable();
  });

  const updatedCols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', (t) => {
    if (updatedCols.processing_status && updatedCols.processing_started_at) {
      t.index(['processing_status', 'processing_started_at'], 'idx_call_log_processing_claim');
    }
  }).catch(() => {});
};

exports.down = async function (knex) {
  const cols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', (t) => {
    t.dropIndex(['processing_status', 'processing_started_at'], 'idx_call_log_processing_claim');
    if (cols.processing_token) t.dropColumn('processing_token');
    if (cols.processing_started_at) t.dropColumn('processing_started_at');
  }).catch(async () => {
    const currentCols = await knex('call_log').columnInfo();
    await knex.schema.alterTable('call_log', (t) => {
      if (currentCols.processing_token) t.dropColumn('processing_token');
      if (currentCols.processing_started_at) t.dropColumn('processing_started_at');
    });
  });
};
