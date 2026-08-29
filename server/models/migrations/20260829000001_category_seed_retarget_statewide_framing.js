/**
 * The topic-targeting gate (owner rulings 2026-08-27) rejects statewide-only
 * framing at runner step 2d, and the exceptions-only runner skips a repeated
 * gate failure — so the curated P-set briefs pinned to "…-florida" slugs /
 * "Florida …" titles would silently leave the publishing backlog. The
 * manifest (category-seed-topics-v1.json) is retargeted to Southwest
 * Florida in the same change; this applies the same retarget to rows the
 * seeder already inserted and that are still awaiting a draft (pending /
 * skipped / expired). Rows already claimed, done or in review are left
 * alone. Idempotent (matched on dedupe_key + the OLD slug).
 */
const RETARGET = [
  ['P01', '/pest-control/tiny-ant-identification-florida/', '/pest-control/tiny-ant-identification-southwest-florida/', null],
  ['P03', '/pest-control/florida-roach-identification/', '/pest-control/roach-identification-southwest-florida/', 'Palmetto Bug, German Roach, or Smokybrown? Identifying Southwest Florida Roaches Room by Room'],
  ['P04', '/pest-control/rat-or-mouse-identification-florida/', '/pest-control/rat-or-mouse-identification-southwest-florida/', null],
  ['P05', '/pest-control/bug-bite-identification-florida/', '/pest-control/bug-bite-identification-southwest-florida/', null],
  ['P06', '/pest-control/florida-wasp-identification/', '/pest-control/wasp-identification-southwest-florida/', null],
  ['P08', '/pest-control/silverfish-earwig-booklice-identification/', '/pest-control/silverfish-earwig-booklice-identification/', 'Silverfish, Earwig, or Booklouse? The Moisture Pests Hiding in Southwest Florida Bathrooms'],
  ['P10', '/pest-control/lawn-mound-identification-florida/', '/pest-control/lawn-mound-identification-southwest-florida/', null],
  ['P11', '/pest-control/millipede-vs-centipede-florida/', '/pest-control/millipede-vs-centipede-southwest-florida/', null],
  ['P12', '/pest-control/eastern-lubber-grasshopper-florida/', '/pest-control/eastern-lubber-grasshopper-southwest-florida/', null],
];
const DEDUPE_PREFIX = 'catseed:v1:';
const UNTOUCHED = ['claimed', 'done', 'pending_review'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('opportunity_queue'))) return;
  for (const [id, oldSlug, newSlug, newTitle] of RETARGET) {
    await knex.raw(
      `UPDATE opportunity_queue
         SET signal_metadata = jsonb_set(
               CASE WHEN ? IS NULL THEN signal_metadata
                    ELSE jsonb_set(signal_metadata, '{category_brief,working_title}', to_jsonb(?::text), true) END,
               '{category_brief,slug}', to_jsonb(?::text), true),
             updated_at = now()
       WHERE dedupe_key = ?
         AND status NOT IN (${UNTOUCHED.map(() => '?').join(', ')})
         AND (signal_metadata->'category_brief'->>'slug' = ? OR (? IS NOT NULL AND signal_metadata->'category_brief'->>'working_title' <> ?))`,
      [newTitle, newTitle, newSlug, `${DEDUPE_PREFIX}${id}`, ...UNTOUCHED, oldSlug, newTitle, newTitle],
    );
  }
};

// The manifest is the source of truth; a re-seed restores whatever it says.
// Nothing to undo that a down migration could do safely.
exports.down = async function down() {};
