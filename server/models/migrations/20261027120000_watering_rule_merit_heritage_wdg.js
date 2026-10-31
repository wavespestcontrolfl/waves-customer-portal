// Watering rules for Merit 2F and Heritage WDG, and Heritage WDG approved for
// service reports (owner 2026-10-27, reply "go" to the watering-alert scope
// page).
//
// The alert: on 2026-10-26 a same-day lawn visit logged LESCO Dimension 18-0-10,
// Merit 2F and Heritage WDG. The customer got no watering text, and the office
// got "Lawn watering text not sent: Merit 2F has no watering rule". One product
// with no rule cancels the whole text. Two catalog rows were the cause:
//   - "Merit 2F" had post_application_watering NULL (approved for reports).
//   - "Heritage WDG" had post_application_watering NULL and was NOT approved for
//     service reports. An unapproved product freezes no report facts, so a rule
//     stored on it could never reach the visit's instruction
//     (report-data.js approvedReportProductFacts). It is approved here, with
//     report copy in the wording of the approved fungicides
//     (20261023120000_lawn_catalog_report_approvals_and_identity).
//
// Label lines (what the label says):
//   Merit 2F (Envu 2025 specimen, EPA 101563-60): "For optimum control, if
//   rainfall does not occur within 24 hours after application, irrigate to move
//   the active ingredient through the thatch." No amount. It also says "Do not
//   mow turf or lawn area until after sufficient irrigation or rainfall has
//   occurred", which has no day count, so mow_hold_days is not touched.
//   Heritage WDG (EPA 100-1093, EPA-stamped 2016-03-31): no watering line for
//   leaf and patch diseases. Its "Do not allow entry into treatment area until
//   area that was treated with Heritage Fungicide is dry." is a re-entry line.
//   Fairy ring: "water in immediately with 1/8 to 1/4 inches of irrigation."
//   Root dysfunction: "Irrigate with 0.1 to 0.2 inches within 24 hours after
//   application to facilitate movement into the root zone." (as Heritage G,
//   20261022160000). The label's group line reads "GROUP 11 FUNGICIDE".
//
// Owner's lines (what the owner set, source 'owner'): Merit 2F 0.25 inch within
// 24 hours, rain counts (the label gives no amount). Heritage WDG base rule: no
// watering until the spray has dried, as Artavia 2 SC (same azoxystrobin).
// The two by_target entries (fairy ring, root dysfunction) are the label's own
// figures; the amounts are the top of each label range, as Heritage G.
//
// Every write is guarded per field: a value is written only while the column is
// still NULL (the approval flag only while it is false). A missing row or an
// already-set field is a logged no-op, never an overwrite, so any later admin
// edit stands. validateRule runs before any rule is written. One audit_log row
// per write, with before and after.
// Down is a documented no-op (waves-db SKILL: a data-correction migration never
// reverts on rollback); the audit rows keep every before value.
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261027120000_watering_rule_merit_heritage_wdg';
const LOG = '[watering-merit-heritage-20261027]';
const VERIFIED = { verified_at: '2026-10-27T00:00:00.000Z', verified_by: 'label-check-2026-10-26' };

// Same text as 20261023120000's FUNGICIDE_SUMMARY.
const FUNGICIDE_SUMMARY = 'A fungicide that protects turf and plants from fungal disease; it is absorbed into or coats the plant tissue to stop disease organisms from establishing and spreading.';

const MERIT_RULE = {
  mode: 'water_in',
  water_in_inches: 0.25,
  water_in_by_hours: 24,
  rain_counts: true,
  label_window: 'best_results',
  source: 'owner',
  label_note: 'Label (Envu 2025 specimen, EPA 101563-60): "For optimum control, if rainfall does not occur within 24 hours after application, irrigate to move the active ingredient through the thatch." No amount. Owner (2026-10-27): 0.25 inch within 24 hours.',
  ...VERIFIED,
};

// label_window is for a short window only: validateRule rejects it with water_in_same_day, so the
// same-day fairy-ring entry carries none.
const HERITAGE_WDG_RULE = {
  mode: 'hold',
  hold_until: 'dry',
  by_target: [
    {
      match: ['fairy ring'],
      mode: 'water_in',
      water_in_inches: 0.25,
      water_in_by_hours: 24,
      water_in_same_day: true,
      label_note: 'Label: "water in immediately with 1/8 to 1/4 inches of irrigation."',
    },
    {
      match: ['root dysfunction'],
      mode: 'water_in',
      water_in_inches: 0.2,
      water_in_by_hours: 24,
      label_window: 'directs',
      label_note: 'Label: "Irrigate with 0.1 to 0.2 inches within 24 hours after application to facilitate movement into the root zone."',
    },
  ],
  source: 'owner',
  label_note: 'Label (EPA 100-1093, EPA-stamped 2016-03-31): no watering line for leaf and patch diseases; its "Do not allow entry into treatment area until area that was treated with Heritage Fungicide is dry." is a re-entry line. Owner (2026-10-27): no watering until the spray has dried, as Artavia 2 SC (same azoxystrobin).',
  ...VERIFIED,
};

// { name, fields: { column: { when, value } } }. 'null' = write while the column is NULL;
// 'false' = write while the column is false.
const ITEMS = [
  {
    name: 'Merit 2F',
    fields: {
      post_application_watering: { when: 'null', value: MERIT_RULE },
    },
  },
  {
    name: 'Heritage WDG',
    fields: {
      approved_for_service_report: { when: 'false', value: true },
      post_application_watering: { when: 'null', value: HERITAGE_WDG_RULE },
      service_report_summary: { when: 'null', value: FUNGICIDE_SUMMARY },
      customer_precaution_summary: { when: 'null', value: 'Per the product label: keep people and pets off treated areas until the spray has dried.' },
      reentry_summary: { when: 'null', value: 'Stay off treated areas until the application has dried.' },
      moa_group: { when: 'null', value: 'Group 11' },
    },
  },
];

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

async function applyItem(knex, canAudit, item) {
  const columns = [];
  for (const column of Object.keys(item.fields)) {
    if (await knex.schema.hasColumn('products_catalog', column)) columns.push(column);
    else console.log(`${LOG} ${item.name}: products_catalog.${column} does not exist: field skipped`);
  }
  const rows = await knex('products_catalog').where({ name: item.name }).select('id', 'name', ...columns);
  if (!rows.length) console.log(`${LOG} ${item.name}: no catalog row: nothing to do`);
  for (const row of rows) {
    for (const column of columns) {
      const { when, value } = item.fields[column];
      const stored = row[column];
      const open = when === 'null' ? stored == null : stored === false;
      if (!open) {
        console.log(`${LOG} ${item.name}: ${column} already set: left as it is`);
        continue;
      }
      if (column === 'post_application_watering' && !validateRule(value).valid) {
        console.log(`${LOG} ${item.name}: rule rejected by validateRule: not written`);
        continue;
      }
      const where = knex('products_catalog').where({ id: row.id });
      if (when === 'null') where.whereNull(column);
      else where.where(column, false);
      const updated = await where.update({ [column]: dbValue(value), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, column, when === 'null' ? null : false, value);
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  for (const item of ITEMS) await applyItem(knex, canAudit, item);
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.ITEMS = ITEMS;
exports.MERIT_RULE = MERIT_RULE;
exports.HERITAGE_WDG_RULE = HERITAGE_WDG_RULE;
exports.FUNGICIDE_SUMMARY = FUNGICIDE_SUMMARY;
