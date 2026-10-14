// Catalog row for the fertilizer bag the lawn route carried on 2026-10-04
// (owner 2026-10-05, "add the bag"): LESCO 24-0-11 50% NOS 30% BIO 3% Fe MOP,
// 50 lb granular. It lets a technician record the product actually applied;
// the lawn protocol sources still plan their own 24-0-11.
//
// The row is written from the bag's stated facts only. Nothing is copied from
// another product: the generic "LESCO 24-0-11" row is a different blend, with
// its own label links, vendor-pricing record and price cache. So this row has
// no price (needs_pricing), no label or SDS link and no label rate until the
// owner supplies them.
//
// Insert-only and idempotent: a row with this name (any case) is never written
// twice and never changed. down is a no-op on purpose: knex records the
// migration as applied even when the row was already there, so a rollback
// cannot prove this migration created it, and product foreign keys cascade or
// null out history on delete.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261005150000_catalog_lesco_nos_bio_bag_row';
const NAME = 'LESCO 24-0-11 50% NOS 30% BIO 3% Fe MOP';
const FACTS = {
  category: 'fertilizer',
  active_ingredient: 'Nitrogen and potash fertilizer',
  formulation: 'granular',
  container_size: '50 lb',
  active: true,
  needs_pricing: true,
  analysis_n: 24,
  analysis_p: 0,
  analysis_k: 11,
  slow_release_n_pct: 50,
  // Fertilizer rows carry this sentinel, never a guessed registration number.
  epa_reg_number: 'Not EPA-registered fertilizer',
  label_source_note: 'Added 2026-10-05 from the bag name (owner: add the bag). No price, label link or label rate yet.',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (await knex('products_catalog').whereRaw('lower(name) = lower(?)', [NAME]).first('id')) return;

  const columns = await knex('products_catalog').columnInfo();
  const row = { name: NAME };
  for (const [column, value] of Object.entries(FACTS)) {
    if (Object.prototype.hasOwnProperty.call(columns, column)) row[column] = value;
  }

  const [inserted] = await knex('products_catalog').insert(row).returning(['id']);
  const id = inserted && (inserted.id || inserted);
  if (id && (await knex.schema.hasTable('audit_log'))) {
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:seeded`,
      resource_type: 'products_catalog',
      resource_id: String(id),
      metadata: { migration: MIGRATION, product: NAME, before: null, after: FACTS },
      critical: true,
      trx: knex,
    });
  }
};

exports.down = async function down() {};
