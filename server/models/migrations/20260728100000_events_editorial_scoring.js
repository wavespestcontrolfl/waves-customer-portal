/**
 * Editorial scoring columns for events_raw (owner spec 2026-07-28).
 *
 * Auto-curation now persists a structured assessment per examined event:
 * the deterministic 0–100 editorial score, its factor/penalty breakdown,
 * hard-policy rejection codes, audience tags, novelty classification, and
 * the model's cited evidence. The proof diagnostics panel and the
 * portfolio selector read these; nothing existing writes them, so the
 * columns are purely additive.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('events_raw');
  if (!hasTable) return;

  const addIfMissing = async (name, adder) => {
    const has = await knex.schema.hasColumn('events_raw', name);
    if (!has) await knex.schema.alterTable('events_raw', adder);
  };

  await addIfMissing('editorial_score', (t) => t.smallint('editorial_score'));
  await addIfMissing('score_breakdown', (t) => t.jsonb('score_breakdown'));
  await addIfMissing('rejection_codes', (t) => t.jsonb('rejection_codes'));
  await addIfMissing('audience_tags', (t) => t.jsonb('audience_tags'));
  await addIfMissing('novelty_type', (t) => t.string('novelty_type', 30));
  await addIfMissing('editorial_evidence', (t) => t.jsonb('editorial_evidence'));

  // Requeue the legacy tier-1 ingestion auto-approvals for scoring. Left
  // alone they would bypass the new score/rejection-code floor for the
  // rest of the ingestion horizon — the autopilot selects any approved
  // row.
  //
  // Identification is as tight as the schema allows: NULL provenance +
  // never examined + the source is priority-tier 1 — ONLY tier-1
  // ingestion ever auto-approved, so tier-2/3 rows with NULL provenance
  // are manual Event Inbox approvals and are NOT touched. A manual
  // approval OF a tier-1-source event is indistinguishable from the
  // auto-approve path (neither admin route stamps provenance); those few
  // are requeued too, marked with the note below, re-scored by the next
  // 6:15 curation run, and one click in the Event Inbox restores any the
  // operator still wants. Only future events move; past rows are inert.
  await knex('events_raw')
    .where({ admin_status: 'approved' })
    .whereNull('approved_via')
    .whereNull('curated_at')
    .whereNull('merged_into')
    .where('start_at', '>=', knex.fn.now())
    .whereIn('source_id', knex('event_sources').select('id').where('priority_tier', 1))
    .update({
      admin_status: 'pending',
      curation_note: 'Requeued for editorial scoring (2026-07-28 rubric)',
      updated_at: knex.fn.now(),
    });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('events_raw');
  if (!hasTable) return;

  // The legacy-approval requeue is one-way by design: re-approving the
  // demoted rows without scores would resurrect the floor bypass this
  // migration exists to close. Down only removes the columns.

  const dropIfPresent = async (name) => {
    const has = await knex.schema.hasColumn('events_raw', name);
    if (has) await knex.schema.alterTable('events_raw', (t) => t.dropColumn(name));
  };

  await dropIfPresent('editorial_evidence');
  await dropIfPresent('novelty_type');
  await dropIfPresent('audience_tags');
  await dropIfPresent('rejection_codes');
  await dropIfPresent('score_breakdown');
  await dropIfPresent('editorial_score');
};
