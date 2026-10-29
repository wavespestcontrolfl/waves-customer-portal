// Watering rule, report approval and report copy for LESCO Atrazine 0.92% 20-0-20, the weed & feed the garage count
// added on 2026-10-29 at 02:55 ET (owner 2026-10-29, option a on the decision page: "the text says to water in within
// 1 hour, and the report prints the label's line").
//
// The label (EPA 10404-96, accepted 2021-11-10; SiteOne bag label #HPST00105) says for residential turf: "This product
// must be watered in immediately after application. Watering-in must be performed by the commercial applicator or the
// commercial applicator must provide the following instructions to the resident or owner in writing: -This product must
// be watered in immediately. - Do not enter or allow others (including children or pets) to enter the treated areas
// (except those involved in the watering) until the watering-in is complete and the surface is dry." No amount and no
// hours. 20261029140000 filled its label fields and left this out, because the same-day rule the other "immediately"
// labels carry words a deadline of 11 PM tonight.
//
// - Rule: about 0.25 inch within 1 hour of the visit (the owner's figures), as a label-directed window, so a hold
//   never pushes it later. The text reads "Water in today's treatment with about ¼ inch by 12 PM today." for an 11 AM
//   visit. Beside a product that must stay dry for a time, the two directions clash and the visit gets no watering
//   text and an office alert (lawn-watering-instruction.js water_in_conflict), as the decision page said.
// - Report copy: the precaution line carries the label's written instruction; the re-entry line is the approved
//   wording of Dylox 6.2 G Granular (a granule watered in the same day), verbatim from the production catalog; the
//   summary is the one new line the decision page showed. Service line "lawn".
//
// Every write is guarded per field: a value is written only while the column is still NULL (the approval flag only while
// it is false), so a value an admin writes first stands. validateRule runs before the rule is written. One audit_log row
// per write, with before and after. Down is a documented no-op (waves-db SKILL); the audit rows keep every before value.
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

// audit_log.action is varchar(96): `migration:<name>:<column>` must fit, so the name stays short.
const MIGRATION = '20261029150000_lawn_atrazine_rule_and_approval';
const LOG = '[lawn-atrazine-rule-20261029]';
const NAME = 'LESCO Atrazine 0.92% 20-0-20 25% PolyPlus OPTI45 6% Fe Post-Emergent Herbicide Plus Fertilizer';
const JSON_COLUMNS = new Set(['post_application_watering', 'service_lines']);

const RULE = {
  mode: 'water_in',
  water_in_inches: 0.25,
  water_in_by_hours: 1,
  label_window: 'directs',
  source: 'owner',
  label_note: 'Label (EPA 10404-96, accepted 2021-11-10), residential turf: "This product must be watered in immediately after application." The applicator waters it in or gives the resident that instruction in writing. No amount, no hours. Owner (2026-10-29): about 0.25 inch within 1 hour.',
  verified_at: '2026-10-29T00:00:00.000Z',
  verified_by: 'label-check-2026-10-29',
};

const FIELDS = {
  post_application_watering: { when: 'null', value: RULE },
  approved_for_service_report: { when: 'false', value: true },
  service_report_summary: { when: 'null', value: 'A granular weed and feed for St. Augustine and centipede lawns. It controls many broadleaf and grassy weeds, both those already growing and those sprouting from seed, and feeds the lawn at the same time.' },
  customer_precaution_summary: { when: 'null', value: 'This product must be watered in immediately. Granules on sidewalks or driveways are swept back into the turf. Keep people and pets off treated areas until the watering-in is complete and the surface is dry.' },
  // Dylox 6.2 G Granular's approved wording, verbatim from the production catalog 2026-10-29.
  reentry_summary: { when: 'null', value: 'Stay off treated areas until the product has been watered in and the turf is dry.' },
  service_lines: { when: 'null', value: ['lawn'] },
};

const dbValue = (column, value) => (JSON_COLUMNS.has(column) ? JSON.stringify(value) : value);

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
      if (column === 'post_application_watering' && !validateRule(value).valid) {
        console.log(`${LOG} rule rejected by validateRule: not written`);
        continue;
      }
      const where = knex('products_catalog').where({ id: row.id });
      if (when === 'null') where.whereNull(column);
      else where.where(column, false);
      const updated = await where.update({ [column]: dbValue(column, value), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, column, when === 'null' ? null : false, value);
    }
  }
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.NAME = NAME;
exports.FIELDS = FIELDS;
