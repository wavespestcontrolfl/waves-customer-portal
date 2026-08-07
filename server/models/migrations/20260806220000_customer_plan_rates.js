/**
 * Per-family plan-rate ledger (owner ruling 2026-08-06, the "real fix"
 * follow-up to #3241).
 *
 * customers.monthly_rate is a single scalar, so a multi-plan customer's
 * same-family re-quote has always replaced the WHOLE rate with the new
 * quote's slice (Pest $40 + Lawn $50 member re-quotes Lawn to $60 → rate
 * becomes $60 and the Pest portion silently stops billing). This table
 * stores each plan family's monthly slice; the scalar stays the billed /
 * read figure and is recomputed as the SUM of components whenever the
 * ledger changes, so every existing reader (billing cron, MRR, membership
 * predicates) is untouched.
 *
 * family_key uses the adoption-classifier vocabulary (pest_control,
 * lawn_care, tree_shrub, mosquito, termite_bait, rodent_bait, …) plus the
 * sentinel 'unattributed' for legacy amounts that predate the ledger and
 * cannot be split (blind scalar writes also reset to a single unattributed
 * component so the sum always equals the scalar).
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('customer_plan_rates');
  if (has) return;
  await knex.schema.createTable('customer_plan_rates', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable()
      .references('id').inTable('customers').onDelete('CASCADE');
    t.string('family_key', 64).notNullable();
    t.decimal('monthly_rate', 10, 2).notNullable();
    t.uuid('source_estimate_id').nullable();
    t.string('source', 32).notNullable().defaultTo('estimate_accept');
    t.timestamp('effective_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['customer_id', 'family_key']);
    t.index(['customer_id']);
  });
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('customer_plan_rates');
  if (has) await knex.schema.dropTable('customer_plan_rates');
};
