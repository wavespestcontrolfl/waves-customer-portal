/**
 * The LESCO Crosscheck Plus catalog row gets the label and copy fields production's row carries. Every repo-built database
 * gets that row from migration 20261119010000 (step 0), which runs after the name-keyed catalog backfills that wrote
 * production's row (20260711500000, 20260712100000, 20260723000001), so it lacks them: no rotation group for the Group 3A
 * warnings, no label ceiling for the recap's over-label warning, no label link, and column defaults that keep it out of
 * customer report copy. Values: production's row (read 2026-11-18) and the SiteOne D00001542 label.
 *
 * On any row named LESCO Crosscheck Plus, each FILL_IF_NULL column is written only while it is NULL: the EPA number (label
 * page 1; the job card finds the rain and wind rules by it), moa_group (bifenthrin, IRAC Group 3A), the label's lawn rate
 * range 0.18 to 1.0 fl oz per 1,000 sq ft (pages 40-41), the label and SDS links, target pests, service lines, and the three
 * report copy lines both bifenthrin rows carry.
 *
 * On the row step 0 added (its seed event in audit_log) only, each SEEDED_ROW column is written only while it still holds the
 * seed's value, a column default or the seed's own spelling: rate_unit 'fl oz' becomes the catalog's 'fl_oz', the row becomes
 * portal visible and approved for service reports (report copy reads only approved rows), and its label check is dated
 * 2026-11-18 (every fact on that row is the label's). Another row keeps those columns: there they are an office choice.
 *
 * Production does not change: its row holds every FILL_IF_NULL value, and it has no seeded row. One audit_log row per catalog
 * row written, with before and after. With no audit_log table nothing is written. Down is a documented no-op (waves-db: a data
 * fill never reverts on rollback); the audit rows keep every before value.
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261119010200_crosscheck_catalog_label_fill';
const CROSSCHECK = 'LESCO Crosscheck Plus';
const SEED_ACTION = 'migration:20261119010000_house_bifenthrin_crosscheck:seed';
const SITEONE = 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO';

// [column, value]: written only while the column is NULL.
const FILL_IF_NULL = [
  ['epa_reg_number', '10404-120'],
  ['moa_group', 'Group 3A'],
  ['min_label_rate_per_1000', 0.18],
  ['max_label_rate_per_1000', 1.0],
  ['label_url', `${SITEONE}/labelAsset/d00001542-label/d00001542-label.pdf`],
  ['sds_url', `${SITEONE}/safetyDataSheet/d00001542-sds/d00001542-sds.pdf`],
  ['target_pests', ['Fire ants', 'Big-headed ants', 'Southern chinch bugs', 'Fleas', 'Ticks']],
  ['service_lines', ['pest', 'lawn']],
  ['service_report_summary', 'A residual contact insecticide applied where pests travel, harbor, and enter; pests crossing the treated zone are controlled over time, maintaining a protective barrier between visits.'],
  ['customer_precaution_summary', 'Per the product label: keep people and pets off treated areas until sprays have dried.'],
  ['reentry_summary', 'Stay off treated areas until the application has dried.'],
];
// [column, the seeded row's value, value]: the row step 0 added only, written only while the column still holds that value.
const SEEDED_ROW = [
  ['rate_unit', 'fl oz', 'fl_oz'],
  ['customer_visibility', 'internal_only', 'portal_only'],
  ['content_status', 'draft', 'approved_for_portal'],
  ['approved_for_service_report', false, true],
  ['label_verified_at', null, '2026-11-18T12:00:00.000Z'],
  ['label_verified_by', null, 'label-check-2026-11-18'],
];
const JSON_COLUMNS = new Set(['target_pests', 'service_lines']);

async function presentColumns(knex) {
  const present = new Set();
  for (const [column] of [...FILL_IF_NULL, ...SEEDED_ROW]) {
    if (await knex.schema.hasColumn('products_catalog', column)) present.add(column);
  }
  return present;
}

async function addedByStep0(knex, id) {
  const event = await knex('audit_log').where({ action: SEED_ACTION, resource_type: 'products_catalog', resource_id: String(id) }).first();
  return Boolean(event);
}

// What up() writes on one row: column -> { before, after }. Pure.
function planFill(row, seeded, present) {
  const changes = {};
  for (const [column, value] of FILL_IF_NULL) {
    if (present.has(column) && row[column] == null) changes[column] = { before: null, after: value };
  }
  if (!seeded) return changes;
  for (const [column, seedValue, value] of SEEDED_ROW) {
    const holdsSeedValue = seedValue == null ? row[column] == null : row[column] === seedValue;
    if (present.has(column) && holdsSeedValue) changes[column] = { before: seedValue, after: value };
  }
  return changes;
}

// Each column only while it still holds its before value, so a concurrent edit is never overwritten.
async function writeChanges(knex, id, changes) {
  const written = {};
  for (const [column, change] of Object.entries(changes)) {
    const query = knex('products_catalog').where({ id });
    const guarded = change.before == null ? query.whereNull(column) : query.where({ [column]: change.before });
    const value = JSON_COLUMNS.has(column) ? JSON.stringify(change.after) : change.after;
    if (await guarded.update({ [column]: value, updated_at: knex.fn.now() })) written[column] = change;
  }
  return written;
}

async function audit(knex, row, written) {
  const before = {};
  const after = {};
  for (const [column, change] of Object.entries(written)) {
    before[column] = change.before;
    after[column] = change.after;
  }
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:fill`,
    resource_type: 'products_catalog',
    resource_id: String(row.id),
    metadata: { migration: MIGRATION, product: row.name, before, after },
    critical: true,
    trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('audit_log'))) return;
  const present = await presentColumns(knex);
  const rows = await knex('products_catalog').where({ name: CROSSCHECK }).select('*');
  for (const row of rows) {
    const written = await writeChanges(knex, row.id, planFill(row, await addedByStep0(knex, row.id), present));
    if (Object.keys(written).length) await audit(knex, row, written);
  }
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.FILL_IF_NULL = FILL_IF_NULL;
exports.SEEDED_ROW = SEEDED_ROW;
