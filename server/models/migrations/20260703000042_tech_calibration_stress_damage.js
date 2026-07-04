/**
 * Add stress_damage to the tech-calibration record.
 *
 * The lawn completion screen now lets the tech correct a single consolidated
 * "Stress" score (stress_damage) instead of separate Fungus/Thatch chips. The
 * tech-calibration table only tracked ai/tech deltas for the five legacy metrics,
 * so a Stress-only correction recorded as a zero delta on the (now unchanged)
 * fungus/thatch columns. Add ai_/tech_ columns for stress_damage so
 * recordTechCalibration captures the real correction. Additive + nullable; older
 * rows keep NULL.
 */

exports.up = async function up(knex) {
  const hasAi = await knex.schema.hasColumn('tech_calibration', 'ai_stress_damage');
  const hasTech = await knex.schema.hasColumn('tech_calibration', 'tech_stress_damage');
  if (hasAi && hasTech) return;
  await knex.schema.alterTable('tech_calibration', (table) => {
    if (!hasAi) table.integer('ai_stress_damage');
    if (!hasTech) table.integer('tech_stress_damage');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('tech_calibration', (table) => {
    table.dropColumn('ai_stress_damage');
    table.dropColumn('tech_stress_damage');
  });
};
