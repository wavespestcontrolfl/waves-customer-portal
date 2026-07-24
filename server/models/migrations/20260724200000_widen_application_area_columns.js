/**
 * Per-product treatment areas go multi-select (owner 2026-07-24): the
 * completion panel's per-product "Treatment area" picker now allows more
 * than one area per product, stored as a comma-joined label list
 * ("Kitchen, Bathrooms") in the same field. Two landing columns were
 * created varchar(50), which fits a single chip label but not a joined
 * list (the full pest chip set joined is ~120 chars) — an oversized value
 * would throw "value too long for type character varying(50)" and 500 the
 * completion route (service_products) or silently drop the compliance
 * ledger row (property_application_history, inserted per product at
 * completion).
 *
 * 255 rather than text keeps a visible bound: these are short label
 * lists from a controlled chip vocabulary, not payloads.
 */

exports.up = async function up(knex) {
  if (
    (await knex.schema.hasTable('service_products'))
    && (await knex.schema.hasColumn('service_products', 'application_area'))
  ) {
    await knex.schema.alterTable('service_products', (t) => {
      t.string('application_area', 255).alter();
    });
  }
  if (
    (await knex.schema.hasTable('property_application_history'))
    && (await knex.schema.hasColumn('property_application_history', 'application_site'))
  ) {
    await knex.schema.alterTable('property_application_history', (t) => {
      t.string('application_site', 255).alter();
    });
  }
};

exports.down = async function down(knex) {
  // A plain shrink would throw on any stored multi-area list. Project the
  // list down to its first area (the pre-multi-select shape) before
  // narrowing, so the alter can't fail.
  if (
    (await knex.schema.hasTable('service_products'))
    && (await knex.schema.hasColumn('service_products', 'application_area'))
  ) {
    await knex.raw(`
      UPDATE service_products
      SET application_area = left(trim(split_part(application_area, ',', 1)), 50)
      WHERE application_area IS NOT NULL AND length(application_area) > 50
    `);
    await knex.schema.alterTable('service_products', (t) => {
      t.string('application_area', 50).alter();
    });
  }
  if (
    (await knex.schema.hasTable('property_application_history'))
    && (await knex.schema.hasColumn('property_application_history', 'application_site'))
  ) {
    await knex.raw(`
      UPDATE property_application_history
      SET application_site = left(trim(split_part(application_site, ',', 1)), 50)
      WHERE application_site IS NOT NULL AND length(application_site) > 50
    `);
    await knex.schema.alterTable('property_application_history', (t) => {
      t.string('application_site', 50).alter();
    });
  }
};
