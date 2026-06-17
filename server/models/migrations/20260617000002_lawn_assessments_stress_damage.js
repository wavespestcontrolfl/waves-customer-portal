/**
 * Add lawn_assessments.stress_damage (0-100) — the consolidated, customer-facing
 * Stress/Damage score: the worst (lowest-health) of disease / insect / drought /
 * mechanical / thatch.
 *
 * Additive on purpose. fungus_control and thatch_level stay populated so the
 * Lawn Diagnostic tool, lawn-health trends, and snapshot are untouched; the
 * customer report + admin scorecards just present the four consolidated
 * categories (Color / Density / Weed Cleanliness / Stress+Damage). Nullable —
 * pre-existing rows derive a value on read from min(fungus_control, thatch_level).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessments'))) return;
  if (!(await knex.schema.hasColumn('lawn_assessments', 'stress_damage'))) {
    await knex.schema.alterTable('lawn_assessments', (t) => {
      t.integer('stress_damage').nullable(); // 0-100, higher = healthier
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessments'))) return;
  if (await knex.schema.hasColumn('lawn_assessments', 'stress_damage')) {
    await knex.schema.alterTable('lawn_assessments', (t) => {
      t.dropColumn('stress_damage');
    });
  }
};
