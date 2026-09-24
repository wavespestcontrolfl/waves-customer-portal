// Supersedes the ungated rewrite in 20260924000012 (pushed migrations are
// frozen). That migration swapped the "How we calculate" copy to text that
// names the six-band scale (None … High) whenever the copy was still the old
// default — even where 20260924000011 had kept a customized label set. Put
// the old copy back on any row whose labels are not the six-band set, so
// the explanation never names labels the report doesn't use. `down` is a
// no-op: re-applying 000012's ungated rewrite is 000012's own business.

const labelsMigration = require('./20260924000011_pest_pressure_six_band_labels');
const explanationMigration = require('./20260924000012_pest_pressure_direct_rating_explanation');

const { NEW_LABELS, sameLabels, parseLabels } = labelsMigration._internal;
const { OLD_TEXT, NEW_TEXT } = explanationMigration._internal;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pest_pressure_configs'))) return;
  const rows = await knex('pest_pressure_configs')
    .where({ customer_explanation_text: NEW_TEXT })
    .select('id', 'labels');
  for (const row of rows) {
    if (sameLabels(parseLabels(row.labels), NEW_LABELS)) continue;
    await knex('pest_pressure_configs')
      .where({ id: row.id })
      .update({ customer_explanation_text: OLD_TEXT, updated_at: knex.fn.now() });
  }
};

exports.down = async function down() {};
