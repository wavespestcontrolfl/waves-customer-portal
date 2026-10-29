// Watering rule and report approval for the herbicide surfactant the garage count added on 2026-10-28 (owner 2026-10-28,
// "make sure every product has it").
//
// "Southern Ag Surfactant for Herbicides (Non-Ionic)" was added to the catalog at 22:21 ET with no watering rule and no
// report approval, after 20261029030000 covered the evening's other lawn products. A lawn visit that logs it with a
// herbicide would get no watering text and an office alert. It is a tank-mix spray adjuvant, so it takes the rule and the
// report copy of its approved sister, LESCO 90/10 Nonionic Surfactant (verbatim from the production catalog): no watering
// change of its own, the herbicide in the mix sets the watering rule. (The bed bug concentrate added at the same time is
// not a lawn product.)
//
// Every write is guarded per field: a value is written only while the column is still NULL (the approval flag only while
// it is false), so any admin edit stands. validateRule runs before the rule is written. One audit_log row per write, with
// before and after. Down is a documented no-op (waves-db SKILL); the audit rows keep every before value.
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261029040000_lawn_surfactant_rule_and_approval';
const LOG = '[lawn-surfactant-20261029]';
const NAME = 'Southern Ag Surfactant for Herbicides (Non-Ionic)';

const RULE = {
  mode: 'none',
  source: 'owner',
  label_note: 'Tank-mix surfactant: the herbicide in the mix sets the watering rule (as LESCO 90/10 Nonionic Surfactant).',
  verified_at: '2026-10-28T00:00:00.000Z',
  verified_by: 'label-check-2026-10-28',
};

// LESCO 90/10 Nonionic Surfactant's approved copy, verbatim.
const FIELDS = {
  post_application_watering: { when: 'null', value: RULE },
  approved_for_service_report: { when: 'false', value: true },
  service_report_summary: { when: 'null', value: 'A nonionic spray adjuvant mixed with treatment products to improve spray coverage and adhesion on waxy leaves and stems. It is an additive, not a pesticide.' },
  customer_precaution_summary: { when: 'null', value: 'Used only as part of a spray mix — the precautions of the products it is mixed with apply.' },
  reentry_summary: { when: 'null', value: 'Stay off treated areas until the application has dried.' },
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
