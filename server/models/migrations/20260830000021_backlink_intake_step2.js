/**
 * Backlink Manager v2 — step 2: bulk intake
 * (docs/design/backlink-manager-plan.md §3.4d intake items, §4 step 5 baseline mapping).
 *
 * Additive and reversible. Creates:
 *   - seo_link_intake_items — raw references (post URLs, shorteners, CSV cells,
 *     gap rows) parked BEFORE resolution; one row per (source, normalized raw_url);
 *     the intake sweep claims pending/unresolved rows by (state, next_retry_at).
 *   - seo_link_placement_backlinks — one-to-many (prospect_id → seo_backlinks.id)
 *     so every inbound seo_backlinks row from a host to a page keeps its identity
 *     beside the ONE representative placement (backlink_id UNIQUE).
 *
 * Enum literals below are FROZEN copies of services/seo/link-registry.js —
 * server/tests/backlink-intake-step2-migration.test.js pins them equal. A
 * changed enum is a NEW migration that swaps the CHECK, never an edit here.
 */

const LINK_SOURCES = ['owner_seed', 'list_import', 'competitor_gap', 'competitor_clone', 'recursive', 'x', 'google_search', 'dataforseo', 'strategy_agent', 'existing_backlink', 'lost_recovery', 'local_opportunity', 'legacy_unknown'];
const INTAKE_ITEM_STATES = ['pending', 'unresolved', 'resolved', 'dropped'];
const INTAKE_DROP_REASONS = ['never_a_target', 'retry_exhausted', 'invalid_url', 'own_domain'];

const quoted = (arr) => arr.map((v) => `'${v}'`).join(', ');
const check = (table, name, expr) => `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr})`;
const inSet = (col, arr, { nullable = false } = {}) => (nullable ? `${col} IS NULL OR ${col} IN (${quoted(arr)})` : `${col} IN (${quoted(arr)})`);

exports.up = async function (knex) {
  // ---- §3.4d intake items --------------------------------------------------
  if (!(await knex.schema.hasTable('seo_link_intake_items'))) {
    await knex.schema.createTable('seo_link_intake_items', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('source').notNullable(); t.text('source_detail'); t.uuid('source_ref');
      t.text('raw_url').notNullable();
      t.text('item_key').notNullable();
      t.string('state').notNullable().defaultTo('pending');
      t.integer('attempts').notNullable().defaultTo(0);
      t.timestamp('next_retry_at');
      t.text('last_error');
      t.text('resolved_url'); t.text('resolved_host');
      t.uuid('domain_id').references('id').inTable('seo_link_domains').onDelete('SET NULL');
      t.uuid('source_row_id');
      t.string('drop_reason');
      t.timestamp('first_seen_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['item_key']);
      t.index(['state', 'next_retry_at']);
      t.index(['domain_id']);
    });
    await knex.raw(check('seo_link_intake_items', 'seo_link_intake_items_source_check', inSet('source', LINK_SOURCES)));
    await knex.raw(check('seo_link_intake_items', 'seo_link_intake_items_state_check', inSet('state', INTAKE_ITEM_STATES)));
    await knex.raw(check('seo_link_intake_items', 'seo_link_intake_items_drop_reason_check', inSet('drop_reason', INTAKE_DROP_REASONS, { nullable: true })));
  }

  // ---- §4 step 5 placement ↔ inbound link mapping --------------------------
  if (!(await knex.schema.hasTable('seo_link_placement_backlinks'))) {
    await knex.schema.createTable('seo_link_placement_backlinks', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('prospect_id').notNullable().references('id').inTable('seo_link_prospects').onDelete('CASCADE');
      t.uuid('backlink_id').notNullable().references('id').inTable('seo_backlinks').onDelete('CASCADE');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.unique(['backlink_id']);
      t.index(['prospect_id']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_link_placement_backlinks');
  await knex.schema.dropTableIfExists('seo_link_intake_items');
};
