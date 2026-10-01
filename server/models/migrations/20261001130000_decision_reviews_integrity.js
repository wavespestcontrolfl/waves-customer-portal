/**
 * decision_reviews: one integrity contract, in full.
 *
 * Codex #5476 r1–r5 widened this table's constraints one column at a time
 * (hash NOT NULL → label → labeled_by/at → hash format → JSON-null label).
 * This migration states the whole contract once and retires the piecemeal
 * constraints and the r1 'unknown-' sentinel:
 *   - package_hash is a sha256 hex digest (64 lowercase hex chars), nothing else;
 *   - a confirmed_error / confirmed_correct row has a label that is a JSON
 *     object (not the JSON literal null), a non-blank labeled_by, and labeled_at.
 * Guards first: rows that cannot satisfy the hash rule (the r1 sentinel, or any
 * stray value) are deleted — they never identified package content and were
 * never evidence; confirmed rows missing provenance are demoted to unreviewed.
 * The earlier migrations are frozen (pushed), hence a new file.
 */
const TABLE = 'decision_reviews';
const HASH_RE = '^[0-9a-f]{64}$';
const DROP = ['decision_reviews_confirmed_requires_label_check', 'decision_reviews_confirmed_provenance_check'];
const HASH_CHECK = 'decision_reviews_package_hash_format_check';
const PROV_CHECK = 'decision_reviews_confirmed_label_provenance_check';

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex(TABLE).whereRaw(`package_hash !~ '${HASH_RE}'`).del();
  await knex(TABLE)
    .whereIn('label_status', ['confirmed_error', 'confirmed_correct'])
    .whereRaw("(label IS NULL OR jsonb_typeof(label) <> 'object' OR labeled_by IS NULL OR btrim(labeled_by) = '' OR labeled_at IS NULL)")
    .update({ label_status: 'unreviewed', labeled_by: null, labeled_at: null });
  for (const name of DROP) await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${name}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${HASH_CHECK} CHECK (package_hash ~ '${HASH_RE}')`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${PROV_CHECK} CHECK (label_status NOT IN ('confirmed_error','confirmed_correct') OR (label IS NOT NULL AND jsonb_typeof(label) = 'object' AND labeled_by IS NOT NULL AND btrim(labeled_by) <> '' AND labeled_at IS NOT NULL))`);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${PROV_CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${HASH_CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT decision_reviews_confirmed_provenance_check CHECK (label_status NOT IN ('confirmed_error','confirmed_correct') OR (label IS NOT NULL AND labeled_by IS NOT NULL AND labeled_at IS NOT NULL))`);
};
