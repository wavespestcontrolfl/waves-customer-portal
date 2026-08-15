// call_log has no uniqueness on twilio_call_sid, and the /voice insert was
// not serialized with the /call-status inbound fallback — an instantly-
// terminal call (no-answer/busy) whose status callback beat the /voice
// delivery double-inserted the SID (14 sub-second race pairs in prod, all
// bare rows: no recording/transcript/extraction). Merge each duplicate group
// into one canonical row, re-point any FK references, delete the merged-away
// rows, then add the partial unique index as the permanent backstop for the
// now-serialized webhook writers.
//
// Nothing is discarded: scalar linkage (customer link, terminal status,
// duration, outcome) and metadata keys are folded into the kept row first,
// and FK references are moved, not orphaned. The only unresolvable shape —
// two rows for one SID BOTH carrying recording/transcript/extraction
// artifacts — throws, deliberately failing the migration for manual
// resolution rather than guessing which call history to keep.

const TERMINAL_CALL_STATUSES = ['completed', 'no-answer', 'busy', 'failed', 'canceled'];

function hasArtifacts(row) {
  return Boolean(row.recording_sid || row.transcription || row.ai_extraction || row.ai_extraction_enriched);
}

function asMetaObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;

  const dupGroups = await knex('call_log')
    .select('twilio_call_sid')
    .whereNotNull('twilio_call_sid')
    .groupBy('twilio_call_sid')
    .havingRaw('count(*) > 1');

  if (dupGroups.length > 0) {
    // FK set discovered live from pg_constraint so a future referencing table
    // can never be silently orphaned by this migration running elsewhere.
    const { rows: fks } = await knex.raw(`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.confrelid = 'call_log'::regclass AND c.contype = 'f'
    `);

    for (const group of dupGroups) {
      const rows = await knex('call_log')
        .where('twilio_call_sid', group.twilio_call_sid)
        .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }]);

      // Canonical row: the artifact-bearing one if exactly one exists,
      // otherwise the first-created. Two artifact-bearing rows = unresolvable.
      const withArtifacts = rows.filter(hasArtifacts);
      if (withArtifacts.length > 1) {
        throw new Error(
          `[migration call_log_twilio_sid_unique] twilio_call_sid ${group.twilio_call_sid} has ${withArtifacts.length} rows carrying recording/transcript/extraction artifacts — resolve by hand before this migration can dedupe.`
        );
      }
      const winner = withArtifacts[0] || rows[0];
      const losers = rows.filter((r) => r.id !== winner.id);

      // Fold every non-redundant scalar into the winner. Terminal status wins
      // over a transient one ('ringing'/'in-progress' from the /voice leg);
      // duration takes the largest observed value; metadata keeps the
      // winner's values on shared keys and adopts keys only a loser wrote.
      const loserTerminal = losers.map((r) => r.status).find((s) => TERMINAL_CALL_STATUSES.includes(s));
      const mergedStatus = TERMINAL_CALL_STATUSES.includes(winner.status)
        ? winner.status
        : (loserTerminal || winner.status);
      const durations = rows.map((r) => r.duration_seconds).filter((d) => d !== null && d !== undefined);
      const mergedDuration = durations.length > 0 ? Math.max(...durations) : null;
      const mergedMeta = Object.assign(
        {},
        ...losers.map((r) => asMetaObject(r.metadata)),
        asMetaObject(winner.metadata)
      );
      const firstLoserValue = (col) => losers.map((r) => r[col]).find((v) => v !== null && v !== undefined);

      await knex('call_log').where({ id: winner.id }).update({
        customer_id: winner.customer_id || firstLoserValue('customer_id') || null,
        status: mergedStatus,
        duration_seconds: mergedDuration,
        answered_by: winner.answered_by || firstLoserValue('answered_by') || null,
        call_outcome: winner.call_outcome || firstLoserValue('call_outcome') || null,
        metadata: JSON.stringify(mergedMeta),
        updated_at: knex.fn.now(),
      });

      const loserIds = losers.map((r) => r.id);
      for (const fk of fks) {
        await knex.raw(
          `UPDATE "${fk.tbl}" SET "${fk.col}" = ? WHERE "${fk.col}" = ANY(?::uuid[])`,
          [winner.id, loserIds]
        );
      }
      await knex('call_log').whereIn('id', loserIds).del();
    }
  }

  // No skip path: if a duplicate somehow survives, index creation throws and
  // the migration retries on the next deploy instead of being marked applied
  // without its backstop.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS call_log_twilio_call_sid_unique
    ON call_log (twilio_call_sid)
    WHERE twilio_call_sid IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;
  // Merged-away race-artifact rows are not restorable; down only removes the index.
  await knex.raw('DROP INDEX IF EXISTS call_log_twilio_call_sid_unique');
};
