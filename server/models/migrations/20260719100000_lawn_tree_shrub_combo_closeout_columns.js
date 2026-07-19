/**
 * Migration — Lawn + Tree & Shrub combo: closeout requirement columns
 *
 * T&S audit 2026-07-18 (owner-authorized 07-19): the combined
 * `lawn_tree_shrub_combo` service was created (20260612000031) AFTER the
 * closeout-requirements inference migration (20260529000001) ran, so its
 * requirement columns got the bare column DEFAULTS — no application log, no
 * photos, no customer notice — instead of what the inference would derive
 * for a lawn + tree & shrub application service.
 *
 * The COMPLETION gates are unaffected (the typed tree_shrub companion is
 * mandatory at completion and carries the photo minimum + full compliance),
 * but these columns drive the admin command-center attention feed and the
 * service-library display: combo visits missing an application log or
 * photos never raised an attention item, and the catalog showed the combo
 * as requiring nothing.
 *
 * Sets the inference-correct values: application log + customer notice
 * (lawn_care/tree_shrub are application categories) and the tree & shrub
 * 2-photo minimum (matches the completion gate's photo requirement).
 *
 * Catalogs are admin-mutable: updates ONLY a row still at the untouched
 * defaults, and stamps closeout_requirements_source so down() reverts
 * exactly what up() changed. Values verified against the live prod row
 * read-only on 2026-07-19 (defaults confirmed untouched).
 */

const SERVICE_KEY = 'lawn_tree_shrub_combo';
const SOURCE_MARKER = 'combined_lane_v1';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const cols = await knex('services').columnInfo();
  if (!cols.requires_application_log || !cols.required_photo_count || !cols.requires_customer_notice) return;

  const updated = await knex('services')
    .where({ service_key: SERVICE_KEY })
    // Only the untouched default shape — an admin-edited row is theirs.
    // BOTH conditions matter: the service-library UI stamps source
    // 'manual' while an operator can deliberately save false/0/false, so
    // values alone can't prove the row is untouched (codex P2 r1). The
    // source list mirrors service-closeout-requirements INFERRED_SOURCES.
    .where({ requires_application_log: false, required_photo_count: 0, requires_customer_notice: false })
    .whereIn('closeout_requirements_source', ['inferred_v1', 'default', 'fallback_inference'])
    .update({
      requires_application_log: true,
      required_photo_count: 2,
      requires_customer_notice: true,
      closeout_requirements_source: SOURCE_MARKER,
      updated_at: knex.fn.now(),
    });
  if (!updated) {
    console.warn(`[combo-closeout] ${SERVICE_KEY}: row absent or already admin-edited — skipped`);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  await knex('services')
    .where({ service_key: SERVICE_KEY, closeout_requirements_source: SOURCE_MARKER })
    .update({
      requires_application_log: false,
      required_photo_count: 0,
      requires_customer_notice: false,
      closeout_requirements_source: 'inferred_v1',
      updated_at: knex.fn.now(),
    });
};
