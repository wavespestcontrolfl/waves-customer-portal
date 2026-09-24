// Supersedes 20260924000013 for customized label sets (pushed migrations are
// frozen). 000013 put the old "How we calculate" copy back wherever the
// labels are not the six-band set — but that copy says every score blends
// five inputs, which is false for a technician-rated visit. Give those rows
// label-neutral copy that keeps the direct-rating sentence without naming
// any label. Edited copy is never touched; `down` reverses exact rows only.

const labelsMigration = require('./20260924000011_pest_pressure_six_band_labels');
const explanationMigration = require('./20260924000012_pest_pressure_direct_rating_explanation');

const { NEW_LABELS, sameLabels, parseLabels } = labelsMigration._internal;
const { OLD_TEXT } = explanationMigration._internal;

const SECOND_PARAGRAPH = 'For monthly services, we review activity since the last visit. For bi-monthly services, we review the past two months. For quarterly services, we review the past three months. Future reports compare scores over time to show whether pest pressure is improving, stable, or increasing.';

const NEUTRAL_TEXT = `Pest Pressure is a 0–5 score of the pest activity at your property, from 0 (none) to 5 (the most activity). When your technician rates activity during the visit, that rating is your score. Otherwise the score combines reported activity, technician observations, re-service history, recurring issue areas, and property risk factors such as entry points, moisture, sanitation, or harborage conditions.\n\n${SECOND_PARAGRAPH}`;

async function swap(knex, from, to) {
  if (!(await knex.schema.hasTable('pest_pressure_configs'))) return;
  const rows = await knex('pest_pressure_configs')
    .where({ customer_explanation_text: from })
    .select('id', 'labels');
  for (const row of rows) {
    if (sameLabels(parseLabels(row.labels), NEW_LABELS)) continue;
    await knex('pest_pressure_configs')
      .where({ id: row.id })
      .update({ customer_explanation_text: to, updated_at: knex.fn.now() });
  }
}

exports.up = (knex) => swap(knex, OLD_TEXT, NEUTRAL_TEXT);
exports.down = (knex) => swap(knex, NEUTRAL_TEXT, OLD_TEXT);
exports._internal = { NEUTRAL_TEXT };
