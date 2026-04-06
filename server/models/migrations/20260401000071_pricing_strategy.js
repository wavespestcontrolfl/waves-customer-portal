/**
 * Migration 071 — Pricing Strategy (Hormozi Money Model)
 *
 * Creates tables for offer packages (Grand Slam Offers),
 * upsell/downsell automation rules, and customer LTV tracking.
 */
exports.up = async function (knex) {

  // ── Offer Packages (Grand Slam Offers) ────────────────────────
  if (!(await knex.schema.hasTable('offer_packages'))) {
    await knex.schema.createTable('offer_packages', t => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.string('name', 100).notNullable();
      t.text('description');
      t.string('target_market', 100);
      t.jsonb('core_services');                   // array of included service names
      t.jsonb('bonuses');                          // [{ name, value, cost, description }]
      t.string('guarantee_type', 30).defaultTo('unconditional'); // unconditional | conditional | better_than_money_back
      t.text('guarantee_text');
      t.string('scarcity_type', 30).defaultTo('none');           // none | capacity | seasonal | limited_time
      t.text('scarcity_text');
      t.text('urgency_text');
      t.decimal('anchor_price', 10, 2);           // "without us" sticker price
      t.decimal('offer_price', 10, 2);            // actual price
      t.decimal('perceived_value', 10, 2);        // stacked total value
      t.string('status', 20).defaultTo('active');
      t.decimal('conversion_rate', 5, 2);         // tracked %
      t.timestamps(true, true);
    });
  }

  // ── Upsell / Downsell Rules ───────────────────────────────────
  if (!(await knex.schema.hasTable('upsell_rules'))) {
    await knex.schema.createTable('upsell_rules', t => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.string('name', 100).notNullable();
      t.string('trigger_event', 30).notNullable(); // estimate_accepted | estimate_declined | service_completed | 30_day_active
      t.jsonb('condition');                         // { services_count_lt, tier_not, ... }
      t.string('offer_type', 20).notNullable();    // upsell | downsell | cross_sell | addon
      t.string('offer_service', 100);              // service to offer
      t.decimal('discount_pct', 5, 2);
      t.text('message_template');
      t.boolean('enabled').defaultTo(true);
      t.integer('times_triggered').defaultTo(0);
      t.integer('times_converted').defaultTo(0);
      t.timestamp('created_at').defaultTo(knex.fn.now());
    });
  }

  // ── Customer Lifetime Value ───────────────────────────────────
  if (!(await knex.schema.hasTable('customer_ltv'))) {
    await knex.schema.createTable('customer_ltv', t => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('customer_id').notNullable()
        .references('id').inTable('customers').onDelete('CASCADE');
      t.decimal('acquisition_cost', 10, 2);        // ad spend / referral cost
      t.string('acquisition_source', 50);           // google_ads | referral | organic | nextdoor
      t.date('first_service_date');
      t.decimal('total_revenue', 10, 2).defaultTo(0);
      t.integer('total_services').defaultTo(0);
      t.decimal('monthly_recurring', 10, 2).defaultTo(0);
      t.decimal('estimated_ltv', 10, 2).defaultTo(0);
      t.decimal('ltv_to_cac_ratio', 6, 2);
      t.string('churn_risk', 20).defaultTo('low'); // low | medium | high
      t.timestamp('last_calculated');
      t.timestamp('created_at').defaultTo(knex.fn.now());

      t.unique('customer_id');
      t.index('churn_risk');
      t.index('acquisition_source');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('customer_ltv');
  await knex.schema.dropTableIfExists('upsell_rules');
  await knex.schema.dropTableIfExists('offer_packages');
};
