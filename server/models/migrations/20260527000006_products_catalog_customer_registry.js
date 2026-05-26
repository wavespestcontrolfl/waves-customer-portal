// Extends products_catalog with customer-facing content fields and
// visibility controls for the Product Registry feature.
//
// These fields power three surfaces:
//   1. Admin: operators author customer-facing copy per product
//   2. Portal: richer product info on service history (portal_summary)
//   3. Public: Astro /products-and-safety/ page consumes approved products
//
// customer_visibility gates which surface a product appears on.
// content_status tracks editorial workflow (draft → approved → retired).
// All new columns are nullable — existing products start as internal_only/draft.

const NEW_COLUMNS = [
  // ── Visibility + workflow ────────────────────────────────────────
  ['string',  'customer_visibility',      [20]],
  ['string',  'content_status',           [20]],

  // ── Customer-facing content ──────────────────────────────────────
  ['string',  'common_name',              [150]],
  ['text',    'public_summary'],
  ['text',    'portal_summary'],
  ['text',    'customer_safety_summary'],
  ['text',    'pet_kid_guidance_text'],

  // ── Structured classification ────────────────────────────────────
  ['jsonb',   'target_pests'],
  ['jsonb',   'application_zones'],
];

const VISIBILITY_VALUES = ['internal_only', 'portal_only', 'public'];
const STATUS_VALUES = ['draft', 'approved_for_portal', 'approved_for_public', 'retired'];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [method, name, args] of NEW_COLUMNS) {
    if (await knex.schema.hasColumn('products_catalog', name)) continue;
    await knex.schema.alterTable('products_catalog', (t) => {
      if (args && args.length) {
        t[method](name, ...args);
      } else {
        t[method](name);
      }
    });
  }

  // Set defaults for the two workflow columns
  await knex.raw(`
    ALTER TABLE products_catalog
    ALTER COLUMN customer_visibility SET DEFAULT 'internal_only'
  `);
  await knex.raw(`
    ALTER TABLE products_catalog
    ALTER COLUMN content_status SET DEFAULT 'draft'
  `);

  // CHECK constraints
  await knex.raw(`
    ALTER TABLE products_catalog
    ADD CONSTRAINT products_catalog_customer_visibility_check
    CHECK (
      customer_visibility IS NULL
      OR customer_visibility IN (${VISIBILITY_VALUES.map((s) => `'${s}'`).join(', ')})
    )
  `);

  await knex.raw(`
    ALTER TABLE products_catalog
    ADD CONSTRAINT products_catalog_content_status_check
    CHECK (
      content_status IS NULL
      OR content_status IN (${STATUS_VALUES.map((s) => `'${s}'`).join(', ')})
    )
  `);
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  await knex.raw(`
    ALTER TABLE products_catalog
    DROP CONSTRAINT IF EXISTS products_catalog_customer_visibility_check
  `);
  await knex.raw(`
    ALTER TABLE products_catalog
    DROP CONSTRAINT IF EXISTS products_catalog_content_status_check
  `);

  for (const [, name] of [...NEW_COLUMNS].reverse()) {
    if (await knex.schema.hasColumn('products_catalog', name)) {
      await knex.schema.alterTable('products_catalog', (t) => {
        t.dropColumn(name);
      });
    }
  }
};
