// Series-template price/service overrides for the Edit-appointment
// "apply to this and following" lane (GATE_EDIT_APPT_PRICE_SERVICE_SCOPE).
//
// The series PARENT row is the copy-source for every extension writer
// (completion auto-extend, visit-count top-up, recurring-alert extend/
// convert), but on an established plan that row is usually a COMPLETED
// visit — rewriting its price/service columns to carry a series-wide change
// forward would falsify the first visit's record. Instead the propagation
// stamps the changed primary-line fields here (jsonb, allowlisted keys
// only) and the extension writers overlay them over the parent row while
// the gate is on. NULL = no overrides, extensions copy the parent exactly
// as before this column existed.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (await knex.schema.hasColumn('scheduled_services', 'recurring_template_overrides')) return;
  await knex.schema.alterTable('scheduled_services', (table) => {
    table.jsonb('recurring_template_overrides').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'recurring_template_overrides'))) return;
  await knex.schema.alterTable('scheduled_services', (table) => {
    table.dropColumn('recurring_template_overrides');
  });
};
