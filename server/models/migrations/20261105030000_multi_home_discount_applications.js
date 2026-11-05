// Multi-home family build, PR 2 (owner ruling 2026-08-06: the 10% Multi-Home Discount applies to EVERY home in a
// multi-home group; owner 2026-11-04: homes on separate profiles linked as "Same family" count as one group).
//
// multi_home_discount_applications is the ledger of what services/multi-home-discount-apply.js did, per recurring
// series, when a home's plan started with the Multi-Home Discount. One row per (source estimate, target series).
//
//   source_estimate_id   the accepted recurring estimate whose plan carries the Multi-Home Discount
//   source_customer_id   the profile that accepted it
//   target_customer_id   the profile that owns the other home's series (the source profile itself for a second
//                        property on the same profile, or another profile of the "Same family" link)
//   target_property_id   the other home's saved property when the series carries one (nullable: older series do not)
//   series_root_id       scheduled_services.id of the series parent (the root every child visit points at). No FK on
//                        purpose: a deleted visit must not erase the record of what was done to it
//   status               applied             the discount was written to the series from first_visit_date on
//                        held                something blocked it; hold_reason names it; retried on later ticks
//                        already_discounted  nothing to do: the series already carries (or was sold with) the
//                                            Multi-Home Discount, so a second 10% must not be added
//   hold_reason          short code while status = held (copy lives in the service, never shown raw to a customer)
//   first_visit_id/_date the first upcoming visit that now carries the discount (status = applied)
//   price_before/_after  the per-visit price of that visit before and after (status = applied)
//   attempts             how many runs touched this row
//   applied_at           when the discount was written (status = applied)
//   detail               small json with the evidence (visit count, the preset id, the reason an already_discounted
//                        row needed nothing)
//
// PR 3 (the customer email) reads this table: it may send once every target of a source estimate is applied or
// already_discounted. Nothing here sends anything. A pushed migration is frozen: add a new one to change it.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('multi_home_discount_applications')) return;
  await knex.schema.createTable('multi_home_discount_applications', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('source_estimate_id').notNullable().references('id').inTable('estimates').onDelete('CASCADE');
    t.uuid('source_customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('target_customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('target_property_id').nullable().references('id').inTable('customer_properties').onDelete('SET NULL');
    t.uuid('series_root_id').notNullable();
    t.text('status').notNullable().defaultTo('held');
    t.text('hold_reason').nullable();
    t.uuid('first_visit_id').nullable();
    t.date('first_visit_date').nullable();
    t.decimal('price_before', 10, 2).nullable();
    t.decimal('price_after', 10, 2).nullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('applied_at', { useTz: true }).nullable();
    t.jsonb('detail').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['source_estimate_id', 'series_root_id'], { indexName: 'multi_home_discount_applications_source_series_uniq' });
    t.index(['target_customer_id'], 'multi_home_discount_applications_target_idx');
  });
  await knex.raw(`ALTER TABLE multi_home_discount_applications
    ADD CONSTRAINT multi_home_discount_applications_status_chk
    CHECK (status IN ('applied', 'held', 'already_discounted'))`);
  await knex.raw(`ALTER TABLE multi_home_discount_applications
    ADD CONSTRAINT multi_home_discount_applications_applied_chk
    CHECK (status <> 'applied' OR (applied_at IS NOT NULL AND price_before IS NOT NULL AND price_after IS NOT NULL))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('multi_home_discount_applications');
};
