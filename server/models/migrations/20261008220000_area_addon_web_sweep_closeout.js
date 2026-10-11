/**
 * Web Sweep (area_addon_web_sweep): explicit labor-only closeout requirements.
 *
 * 20261008200000 inserted the row without closeout columns, so its
 * closeout_requirements_source is an inferred one and
 * service-closeout-requirements infers the rules from the category. The web
 * sweep is pest_control by family, which infers "application log" and
 * "customer notice" required: an honestly completed sweep, which applies no
 * product, would stay pending forever on no_application_rows.
 *
 * Sets the labor-only posture explicitly (service report only) and stamps a
 * non-inferred source so the values are read as written. The five chemical
 * add-ons keep the inferred application-log and notice requirements.
 *
 * Only a row still on an inferred source is changed (an operator edit stamps
 * 'manual' and is theirs); down() reverts only a row still carrying this
 * migration's marker.
 */

const SERVICE_KEY = 'area_addon_web_sweep';
const SOURCE_MARKER = 'area_addon_labor_only_v1';
const INFERRED_SOURCES = ['inferred_v1', 'default', 'fallback_inference'];
const REQUIRED_COLUMNS = [
  'requires_service_report', 'requires_application_log', 'required_photo_count',
  'requires_customer_signature', 'requires_customer_notice', 'closeout_requirements_source',
];

exports.SERVICE_KEY = SERVICE_KEY;
exports.SOURCE_MARKER = SOURCE_MARKER;

async function hasCloseoutColumns(knex) {
  if (!(await knex.schema.hasTable('services'))) return false;
  const cols = await knex('services').columnInfo();
  return REQUIRED_COLUMNS.every((col) => cols[col]);
}

exports.up = async function up(knex) {
  if (!(await hasCloseoutColumns(knex))) return;
  const updated = await knex('services')
    .where({ service_key: SERVICE_KEY })
    .where((builder) => {
      builder.whereNull('closeout_requirements_source').orWhereIn('closeout_requirements_source', INFERRED_SOURCES);
    })
    .update({
      requires_service_report: true,
      requires_application_log: false,
      required_photo_count: 0,
      requires_customer_signature: false,
      requires_customer_notice: false,
      closeout_requirements_source: SOURCE_MARKER,
      updated_at: knex.fn.now(),
    });
  if (!updated) console.warn(`[web-sweep-closeout] ${SERVICE_KEY}: row absent or already edited - skipped`);
};

exports.down = async function down(knex) {
  if (!(await hasCloseoutColumns(knex))) return;
  await knex('services')
    .where({ service_key: SERVICE_KEY, closeout_requirements_source: SOURCE_MARKER })
    .update({ closeout_requirements_source: 'inferred_v1', updated_at: knex.fn.now() });
};
