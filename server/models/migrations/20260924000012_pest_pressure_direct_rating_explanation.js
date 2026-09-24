// Pest Pressure "How we calculate" copy for the direct technician score
// (owner ruling 2026-09-24, follows 20260924000011). The old default said
// every score blends five weighted inputs; a technician's rating is now the
// score itself. Only a config row whose text is still the old default is
// rewritten — edited copy is left alone. `down` reverses only exact rows.

const SECOND_PARAGRAPH = 'For monthly services, we review activity since the last visit. For bi-monthly services, we review the past two months. For quarterly services, we review the past three months. Future reports compare scores over time to show whether pest pressure is improving, stable, or increasing.';

const OLD_TEXT = `Pest Pressure is a 0–5 score that estimates the current level of pest activity at your property. The score combines reported activity, technician observations, re-service history, recurring issue areas, and property risk factors such as entry points, moisture, sanitation, or harborage conditions.\n\n${SECOND_PARAGRAPH}`;

const NEW_TEXT = `Pest Pressure is a 0–5 score of the pest activity at your property: 0 means none, 1 very low, 2 low, 3 moderate, 4 elevated, and 5 high. When your technician rates activity during the visit, that rating is your score. Otherwise the score combines reported activity, technician observations, re-service history, recurring issue areas, and property risk factors such as entry points, moisture, sanitation, or harborage conditions.\n\n${SECOND_PARAGRAPH}`;

async function swapText(knex, from, to) {
  if (!(await knex.schema.hasTable('pest_pressure_configs'))) return;
  await knex('pest_pressure_configs')
    .where({ customer_explanation_text: from })
    .update({ customer_explanation_text: to, updated_at: knex.fn.now() });
}

exports.up = (knex) => swapText(knex, OLD_TEXT, NEW_TEXT);
exports.down = (knex) => swapText(knex, NEW_TEXT, OLD_TEXT);
exports._internal = { OLD_TEXT, NEW_TEXT };
