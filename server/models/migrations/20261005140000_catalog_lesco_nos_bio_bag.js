// Catalog row for the fertilizer bag the lawn route carries (owner 2026-10-05,
// "add the bag"): LESCO 24-0-11 50% NOS 30% BIO 3% Fe MOP, 50 lb granular.
//
// The catalog already holds a generic "LESCO 24-0-11" row. The new row is a
// copy of it under the bag's own name, so the analysis, formulation, unit
// cost and turf species carry over, with the 50% slow-release nitrogen the
// name states. The copied price is the generic row's: needs_pricing is set so
// the owner confirms it. No label link, SDS link or label rate is written;
// this blend's label has not been read. The row is for recording what was
// applied; the lawn protocol sources still plan their own 24-0-11.
//
// Insert-only and idempotent: a row with this name is never written twice and
// never overwritten. If the generic row is missing (a fresh database) the bag
// is created from its stated facts alone.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261005140000_catalog_lesco_nos_bio_bag';
const SOURCE_NAME = 'LESCO 24-0-11';
const NAME = 'LESCO 24-0-11 50% NOS 30% BIO 3% Fe MOP';
const NOTE = 'Row copied from "LESCO 24-0-11" on 2026-10-05 (owner: add the bag). The price is the generic row\'s; confirm it. No label or SDS link yet: this blend\'s documents have not been read.';
// The generic row's label and SDS links point at the 50% PolyPlus OPTI blend
// (20260703000002), a different formulation: never carried to this bag.
const NEVER_COPIED = ['id', 'name', 'sku', 'siteone_sku', 'created_at', 'updated_at', 'inventory_on_hand', 'inventory_unit', 'monthly_usage_estimate', 'monthly_cost_estimate', 'active', 'label_url', 'sds_url', 'label_verified_at', 'label_verified_by'];
const FERTILIZER_EPA_SENTINEL = 'Not EPA-registered fertilizer';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (await knex('products_catalog').whereRaw('lower(name) = lower(?)', [NAME]).first('id')) return;

  const columns = await knex('products_catalog').columnInfo();
  const has = (column) => Object.prototype.hasOwnProperty.call(columns, column);
  const source = await knex('products_catalog').whereRaw('lower(name) = lower(?)', [SOURCE_NAME]).orderByRaw('active desc nulls last, created_at asc').first();

  const row = {};
  if (source) {
    for (const [column, value] of Object.entries(source)) {
      if (NEVER_COPIED.includes(column) || value === null) continue;
      // pg returns json/jsonb columns parsed; they go back in as JSON text.
      row[column] = typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value;
    }
  } else {
    Object.assign(row, { category: 'fertilizer', formulation: 'granular', container_size: '50 lb', active: true });
    if (has('analysis_n')) Object.assign(row, { analysis_n: 24, analysis_p: 0, analysis_k: 11 });
  }
  row.name = NAME;
  // The generic row may be the inactive side of the 20260712000051 dedupe: the bag is active regardless.
  row.active = true;
  if (has('epa_reg_number') && !row.epa_reg_number) row.epa_reg_number = FERTILIZER_EPA_SENTINEL;
  if (has('slow_release_n_pct')) row.slow_release_n_pct = 50;
  if (has('needs_pricing')) row.needs_pricing = true;
  if (has('label_source_note')) row.label_source_note = NOTE;

  const [inserted] = await knex('products_catalog').insert(row).returning(['id']);
  const id = inserted && (inserted.id || inserted);
  if (id && (await knex.schema.hasTable('audit_log'))) {
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:seeded`,
      resource_type: 'products_catalog',
      resource_id: String(id),
      metadata: { migration: MIGRATION, product: NAME, copiedFrom: source ? String(source.id) : null },
      critical: true,
      trx: knex,
    });
  }
};

// Non-destructive: product foreign keys cascade or null out history, so a
// rollback retires the row (inactive) and never deletes it.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  await knex('products_catalog').whereRaw('lower(name) = lower(?)', [NAME]).update({ active: false });
};
