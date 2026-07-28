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
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('events_raw');
  if (!hasTable) return;

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
