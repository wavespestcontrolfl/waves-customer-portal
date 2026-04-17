/**
 * Migration — Create pricing_engine_proposals table
 *
 * v4.3 Session 1, Step 1c. Infrastructure for Session 9's approval-queue
 * connection to pricing_config. Created now so the table exists before
 * Session 9 wires it up; nothing writes to it yet in Session 1.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('pricing_engine_proposals');
  if (hasTable) return;

  await knex.schema.createTable('pricing_engine_proposals', (t) => {
    t.increments('id').primary();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.string('status', 20).notNullable().defaultTo('pending');
    t.string('trigger_source', 30).notNullable();
    t.uuid('product_id').references('id').inTable('products_catalog');
    t.string('config_key', 100).notNullable();
    t.decimal('current_value', 12, 4);
    t.decimal('proposed_value', 12, 4).notNullable();
    t.jsonb('evidence');
    t.jsonb('price_impact');
    t.string('reviewed_by', 100);
    t.timestamp('reviewed_at');
    t.text('review_notes');
    t.integer('changelog_id').references('id').inTable('pricing_changelog');

    t.index('status', 'idx_proposals_status');
    t.index('product_id', 'idx_proposals_product');
    t.index('created_at', 'idx_proposals_created_at');
  });

  // Status CHECK constraint
  await knex.raw(`
    ALTER TABLE pricing_engine_proposals
    ADD CONSTRAINT pricing_engine_proposals_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded'))
  `);

  // Generated column for pct_change — Postgres syntax
  // (knex doesn't have a clean cross-DB generated column API; using raw SQL)
  await knex.raw(`
    ALTER TABLE pricing_engine_proposals
    ADD COLUMN pct_change NUMERIC GENERATED ALWAYS AS (
      CASE WHEN current_value > 0
        THEN ((proposed_value - current_value) / current_value) * 100
        ELSE NULL
      END
    ) STORED
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('pricing_engine_proposals');
};
