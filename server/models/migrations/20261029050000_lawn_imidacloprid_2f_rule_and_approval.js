// Watering rule, EPA identity and report approval for Quali-Pro Imidacloprid 2F T&O, which the garage count added on
// 2026-10-28 at 23:18 ET (owner 2026-10-28, "make sure every product has it").
//
// The row came in with no EPA number, label link, watering rule or report approval. Report facts need a valid EPA number
// for an insecticide, so approval alone would not carry the rule, and a lawn visit that logs it would get no watering
// text and an office alert. The label is EPA 66222-203, "Quali-Pro Imidacloprid 2F Turf & Ornamental Insecticide",
// EPA-stamped 2013-12-03 (the newest on PPLS). It names residential lawns, and its turf line is word for word Dominion
// 2L's: "Irrigation or rainfall must occur within 24 hours after application to move the active ingredient through the
// thatch." So the rule is Dominion 2L's (0.25 inch within 24 hours, rain counts, the label's direction; the amount is the
// owner's, as Merit 2F). Its "Do not mow ... until after sufficient irrigation or rainfall" has no day count, so no mow
// hold. Report copy is Merit 2F's (same active ingredient), verbatim from the production catalog; the group is 4A.
//
// Every write is guarded per field: a value is written only while the column is still NULL (the approval flag only while
// it is false), so a value the garage count or an admin writes first stands. validateRule runs before the rule is
// written. One audit_log row per write, with before and after. Down is a documented no-op (waves-db SKILL); the audit
// rows keep every before value.
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261029050000_lawn_imidacloprid_2f_rule_and_approval';
const LOG = '[lawn-imidacloprid-2f-20261029]';
const NAME = 'Quali-Pro Imidacloprid 2F T&O';

const RULE = {
  mode: 'water_in',
  water_in_inches: 0.25,
  water_in_by_hours: 24,
  rain_counts: true,
  label_window: 'directs',
  source: 'owner',
  label_note: 'Label (EPA 66222-203, stamped 2013-12-03): "Irrigation or rainfall must occur within 24 hours after application to move the active ingredient through the thatch." No amount. Owner: 0.25 inch within 24 hours (as Dominion 2L and Merit 2F).',
  verified_at: '2026-10-28T00:00:00.000Z',
  verified_by: 'label-check-2026-10-28',
};

// Merit 2F's approved copy, verbatim.
const FIELDS = {
  epa_reg_number: { when: 'null', value: '66222-203' },
  label_url: { when: 'null', value: 'https://www3.epa.gov/pesticides/chem_search/ppls/066222-00203-20131203.pdf' },
  post_application_watering: { when: 'null', value: RULE },
  approved_for_service_report: { when: 'false', value: true },
  service_report_summary: { when: 'null', value: 'A systemic insecticide taken up by the plant and moved through its tissue, so sap-feeding and soil pests take it in as they feed — including pests concealed where sprays cannot reach. Protection builds over days and keeps working for weeks.' },
  customer_precaution_summary: { when: 'null', value: 'Per the product label: keep people and pets off treated areas until sprays have dried.' },
  reentry_summary: { when: 'null', value: 'Stay off treated areas until the application has dried.' },
  moa_group: { when: 'null', value: 'Group 4A' },
};

const dbValue = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value);

async function audit(knex, canAudit, row, column, before, after) {
  if (!canAudit) return;
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${column}`,
    resource_type: 'products_catalog',
    resource_id: String(row.id),
    metadata: { migration: MIGRATION, product: row.name, column, before, after },
    critical: true,
    trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const columns = [];
  for (const column of Object.keys(FIELDS)) {
    if (await knex.schema.hasColumn('products_catalog', column)) columns.push(column);
    else console.log(`${LOG} products_catalog.${column} does not exist: field skipped`);
  }
  const rows = await knex('products_catalog').where({ name: NAME }).select('id', 'name', ...columns);
  if (!rows.length) console.log(`${LOG} no catalog row: nothing to do`);
  for (const row of rows) {
    for (const column of columns) {
      const { when, value } = FIELDS[column];
      const open = when === 'null' ? row[column] == null : row[column] === false;
      if (!open) {
        console.log(`${LOG} ${column} already set: left as it is`);
        continue;
      }
      if (column === 'post_application_watering' && !validateRule(value).valid) continue;
      const where = knex('products_catalog').where({ id: row.id });
      if (when === 'null') where.whereNull(column);
      else where.where(column, false);
      const updated = await where.update({ [column]: dbValue(value), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, column, when === 'null' ? null : false, value);
    }
  }
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.NAME = NAME;
exports.FIELDS = FIELDS;
