exports.up = async function (knex) {
  await knex.schema.alterTable('call_log', t => {
    t.text('ai_extraction');         // JSON: extracted customer info, appointment details
    t.text('call_summary');          // AI-generated call summary
    t.string('sentiment', 20);       // positive/neutral/negative/frustrated
    t.string('lead_quality', 10);    // hot/warm/cold/spam
    t.string('processing_status', 30); // pending/processed/voicemail/spam/extraction_failed/no_transcription
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('call_log', t => {
    t.dropColumn('ai_extraction');
    t.dropColumn('call_summary');
    t.dropColumn('sentiment');
    t.dropColumn('lead_quality');
    t.dropColumn('processing_status');
  });
};
