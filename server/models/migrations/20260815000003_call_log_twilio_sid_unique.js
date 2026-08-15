// call_log has no uniqueness on twilio_call_sid, and the /voice insert was
// not serialized with the /call-status inbound fallback — an instantly-
// terminal call (no-answer/busy) whose status callback beat the /voice
// delivery double-inserted the SID (14 sub-second race pairs in prod, all
// bare rows: no recording/transcript/extraction). Dedupe those artifacts,
// then add the partial unique index as the permanent backstop for the
// now-serialized webhook writers.
//
// Dedupe is deliberately conservative: only later-created rows that are BARE
// (no recording, transcription, or extraction) and referenced by no FK are
// deleted. If an unexpected dup survives, the index is SKIPPED with a loud
// log instead of failing the migration — a blocked deploy is worse than a
// missing backstop (the advisory-lock serialization holds either way).

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;

  // Loser candidates: per duplicated SID, everything after the first-created
  // row, provided the row is bare.
  const { rows: losers } = await knex.raw(`
    SELECT id FROM (
      SELECT id, recording_sid, transcription, ai_extraction, ai_extraction_enriched,
             row_number() OVER (PARTITION BY twilio_call_sid ORDER BY created_at, id) AS rn
      FROM call_log
      WHERE twilio_call_sid IN (
        SELECT twilio_call_sid FROM call_log
        WHERE twilio_call_sid IS NOT NULL
        GROUP BY twilio_call_sid HAVING count(*) > 1
      )
    ) d
    WHERE rn > 1
      AND recording_sid IS NULL AND transcription IS NULL
      AND ai_extraction IS NULL AND ai_extraction_enriched IS NULL
  `);
  let loserIds = losers.map((r) => r.id);

  if (loserIds.length > 0) {
    // Drop any candidate another table points at — discovered live from
    // pg_constraint so a future FK can never be silently orphaned by this
    // migration re-running in another environment.
    const { rows: fks } = await knex.raw(`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.confrelid = 'call_log'::regclass AND c.contype = 'f'
    `);
    for (const fk of fks) {
      if (loserIds.length === 0) break;
      const { rows: referenced } = await knex.raw(
        `SELECT DISTINCT "${fk.col}" AS id FROM "${fk.tbl}" WHERE "${fk.col}" = ANY(?::uuid[])`,
        [loserIds]
      );
      const referencedIds = new Set(referenced.map((r) => r.id));
      loserIds = loserIds.filter((id) => !referencedIds.has(id));
    }
    if (loserIds.length > 0) {
      await knex('call_log').whereIn('id', loserIds).del();
    }
  }

  const { rows: remaining } = await knex.raw(`
    SELECT twilio_call_sid FROM call_log
    WHERE twilio_call_sid IS NOT NULL
    GROUP BY twilio_call_sid HAVING count(*) > 1
  `);
  if (remaining.length > 0) {
     
    console.warn(
      `[migration call_log_twilio_sid_unique] ${remaining.length} duplicated twilio_call_sid value(s) survived the conservative dedupe (non-bare or FK-referenced) — SKIPPING the unique index. Resolve by hand, then re-create: CREATE UNIQUE INDEX call_log_twilio_call_sid_unique ON call_log (twilio_call_sid) WHERE twilio_call_sid IS NOT NULL;`
    );
    return;
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS call_log_twilio_call_sid_unique
    ON call_log (twilio_call_sid)
    WHERE twilio_call_sid IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;
  // Deleted race-artifact rows are not restorable; down only removes the index.
  await knex.raw('DROP INDEX IF EXISTS call_log_twilio_call_sid_unique');
};
