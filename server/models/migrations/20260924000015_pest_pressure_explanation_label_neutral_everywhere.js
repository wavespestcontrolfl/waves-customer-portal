// Supersedes 20260924000012's six-band copy (pushed migrations are frozen).
// That copy names which label each integer maps to, but past reports keep
// the label_name they were scored with (a pre-change 4.0 still reads
// "High"), and every report shows the ACTIVE explanation — so the copy
// contradicted older reports. Move every row still on 000012's text to the
// label-neutral copy 000014 introduced (now also the code default). Edited
// copy is never touched; `down` reverses exact rows only.

const { _internal: { NEW_TEXT: SIX_BAND_TEXT } } = require('./20260924000012_pest_pressure_direct_rating_explanation');
const { _internal: { NEUTRAL_TEXT } } = require('./20260924000014_pest_pressure_label_neutral_explanation');

async function swap(knex, from, to) {
  if (!(await knex.schema.hasTable('pest_pressure_configs'))) return;
  await knex('pest_pressure_configs')
    .where({ customer_explanation_text: from })
    .update({ customer_explanation_text: to, updated_at: knex.fn.now() });
}

exports.up = (knex) => swap(knex, SIX_BAND_TEXT, NEUTRAL_TEXT);
exports.down = (knex) => swap(knex, NEUTRAL_TEXT, SIX_BAND_TEXT);
