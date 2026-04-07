exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;

  const cols = await knex('call_log').columnInfo();

  await knex.schema.alterTable('call_log', t => {
    if (!cols.processing_status) t.string('processing_status', 30).nullable();
    if (!cols.ai_extraction) t.jsonb('ai_extraction').nullable();
    if (!cols.ai_summary) t.text('ai_summary').nullable();
    if (!cols.classification) t.string('classification', 50).nullable();
    if (!cols.recording_sid) t.string('recording_sid', 100).nullable();
  });
};

exports.down = async function (knex) {
  const cols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', t => {
    if (cols.processing_status) t.dropColumn('processing_status');
    if (cols.ai_extraction) t.dropColumn('ai_extraction');
    if (cols.ai_summary) t.dropColumn('ai_summary');
    if (cols.classification) t.dropColumn('classification');
    if (cols.recording_sid) t.dropColumn('recording_sid');
  });
};
