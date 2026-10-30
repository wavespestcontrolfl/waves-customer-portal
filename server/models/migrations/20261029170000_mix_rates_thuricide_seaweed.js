// Label mix rates for Thuricide BT Caterpillar Control and Blue Planet Nutrients Liquid Seaweed (owner 2026-10-29,
// "do all these" about "Missing lawn rates: their labels give none"; Fable advised).
//
// Neither label gives a rate per 1,000 sq ft for the use Waves makes of it, so the per-1,000 fields stay empty
// (20261029060000). Both labels give a mix rate per gallon of water, and the catalog keeps a per-gallon label rate in
// default_rate + default_unit '<unit>/gal' (job-card.js perGallonRate; client product-rate-prefill.js), as LESCO
// Manicure 6FL, Reliant and Bloom City Clean Kelp do. dilution_rate keeps the label's own wording in short form; it
// prints on application records (routes/documents.js).
//   - Thuricide BT (EPA 70051-106-829; Southern Ag label): "Shade Trees & Ornamentals: Mix 2 fluid ounces per 3 gallons
//     of water (4 teaspoons per gallon)". 2 fl oz / 3 gal = 0.67 fl oz per gallon. That is its tree and shrub use; the
//     label's only area figure (1,000 sq ft) is spray coverage for fruits and vegetables.
//   - Blue Planet Liquid Seaweed (not EPA-registered; the maker's quart label): "Mix ½–2 tsp (2–10 ml) per gallon of
//     water" (root feed) and "Mix ½ tsp (≈2 ml) per gallon of water." (foliar). ½ to 2 tsp = 0.08 to 0.33 fl oz per
//     gallon, the same conversion as the Southern Ag copper row (1-2 tsp/gal = 0.17-0.33).
// Units are fl oz, never tsp (shared/rate-units.json has no tsp) and never mL (owner ruling 2026-09-27: an mL unit
// blanks the rate on the completion form).
//
// The rate and its unit are written together, and only while the rate is empty AND the unit is the admin-insert
// placeholder 'oz', so a rate an admin typed under 'oz' never gets a new unit under it. default_unit seeds the
// completion prefill only: usage is logged in the unit the technician submits and deducted in inventory_unit
// (complete-scheduled-service.js baseQuantityUnit). Both rows already carry label_verified_at, so the job card and tech
// tools show the rate. dilution_rate and label_source_url (the page the label was read from) are fill-if-NULL. One
// audit_log row per changed column, with before, after and the label line. Down is a documented no-op (waves-db
// SKILL); the audit rows keep every before value.
const { recordAuditEvent } = require('../../services/audit-log');

// audit_log.action is varchar(96): `migration:<name>:<column>` must fit, so the name stays short.
const MIGRATION = '20261029170000_mix_rates_thuricide_seaweed';
const LOG = '[mix-rates-20261029]';

const ITEMS = [
  {
    name: 'Thuricide BT Caterpillar Control',
    rate: '0.67',
    unit: 'fl_oz/gal',
    dilution: '2 fl oz/3 gal (4 tsp/gal)',
    sourceUrl: 'https://southernag.com/wp-content/uploads/2020/06/THURICIDE-LABEL-.pdf',
    label: 'Shade Trees & Ornamentals: Mix 2 fluid ounces per 3 gallons of water (4 teaspoons per gallon)',
  },
  {
    name: 'Blue Planet Nutrients Liquid Seaweed .3-.2-1',
    rate: '0.08-0.33',
    unit: 'fl_oz/gal',
    dilution: '0.5-2 tsp/gal',
    sourceUrl: 'https://blueplanetnutrients.ecwid.com/Liquid-Seaweed-Quart-p15764135',
    label: 'Mix ½–2 tsp (2–10 ml) per gallon of water (root feed); Mix ½ tsp (≈2 ml) per gallon of water. (foliar)',
  },
];
const PLACEHOLDER_UNIT = 'oz';
const COLUMNS = ['default_rate', 'default_unit', 'dilution_rate', 'label_source_url'];

async function audit(knex, canAudit, row, column, before, after, label) {
  if (!canAudit) return;
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${column}`,
    resource_type: 'products_catalog',
    resource_id: String(row.id),
    metadata: { migration: MIGRATION, product: row.name, column, before, after, label },
    critical: true,
    trx: knex,
  });
}

async function applyItem(knex, canAudit, have, item) {
  const rows = await knex('products_catalog').where({ name: item.name }).select('id', 'name', ...have);
  if (!rows.length) console.log(`${LOG} ${item.name}: no catalog row: nothing to do`);
  for (const row of rows) {
    if (have.includes('default_rate') && have.includes('default_unit')) {
      if (row.default_rate == null && row.default_unit === PLACEHOLDER_UNIT) {
        const updated = await knex('products_catalog').where({ id: row.id }).whereNull('default_rate')
          .where('default_unit', PLACEHOLDER_UNIT)
          .update({ default_rate: item.rate, default_unit: item.unit, updated_at: knex.fn.now() });
        if (updated) {
          await audit(knex, canAudit, row, 'default_rate', null, item.rate, item.label);
          await audit(knex, canAudit, row, 'default_unit', PLACEHOLDER_UNIT, item.unit, item.label);
        }
      } else {
        console.log(`${LOG} ${item.name}: rate or unit already set (${row.default_rate} ${row.default_unit}): left as it is`);
      }
    }
    for (const [column, value] of [['dilution_rate', item.dilution], ['label_source_url', item.sourceUrl]]) {
      if (!have.includes(column)) continue;
      if (row[column] != null) { console.log(`${LOG} ${item.name}: ${column} already set: left as it is`); continue; }
      const updated = await knex('products_catalog').where({ id: row.id }).whereNull(column)
        .update({ [column]: value, updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, column, null, value, item.label);
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const have = [];
  for (const column of COLUMNS) {
    if (await knex.schema.hasColumn('products_catalog', column)) have.push(column);
    else console.log(`${LOG} products_catalog.${column} does not exist: skipped`);
  }
  for (const item of ITEMS) await applyItem(knex, canAudit, have, item);
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.ITEMS = ITEMS;
