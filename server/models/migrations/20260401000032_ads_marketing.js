/**
 * Migration 032 — Ads & Marketing System
 *
 * Tables:
 *  - ad_campaigns (base campaign data + service-line mapping)
 *  - ad_performance_daily (daily metrics per campaign)
 *  - ad_search_terms (search term performance)
 *  - ad_service_attribution (full funnel: ad click → lead → booked → completed → revenue)
 *  - ad_targets (performance targets / thresholds)
 *  - ad_budget_log (budget change audit trail)
 *  - ad_advisor_reports (daily AI advisor output)
 */

exports.up = function (knex) {
  return knex.schema

    // ── Ad Campaigns ──────────────────────────────────────────────
    .createTable('ad_campaigns', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('platform').notNullable(); // google_ads, google_lsa, facebook, etc.
      t.string('platform_campaign_id'); // external ID
      t.string('campaign_name').notNullable();
      t.string('campaign_type'); // search, display, lsa, pmax, social
      t.string('target_area'); // Bradenton, Sarasota, Venice, Parrish, Lakewood Ranch, General
      t.string('status').defaultTo('active'); // active, paused, removed

      // Service-line mapping
      t.string('service_category'); // recurring, one_time_entry, high_ticket_specialty, lawn_seasonal
      t.jsonb('target_services'); // ['pest_quarterly', 'rodent_exclusion', 'bed_bug']
      t.string('intent_type'); // emergency, planned, preventative, branded, competitor
      t.boolean('is_branded').defaultTo(false);
      t.string('service_line'); // pest, lawn, mosquito, termite, rodent, tree_shrub, specialty

      // Budget management
      t.string('budget_mode').defaultTo('base'); // base, spent, stop
      t.decimal('daily_budget_base', 10, 2);
      t.decimal('daily_budget_current', 10, 2);
      t.decimal('monthly_budget', 10, 2);

      t.jsonb('metadata');
      t.timestamps(true, true);
    })

    // ── Daily Performance Metrics ─────────────────────────────────
    .createTable('ad_performance_daily', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('campaign_id').references('id').inTable('ad_campaigns').onDelete('CASCADE');
      t.date('date').notNullable();
      t.integer('impressions').defaultTo(0);
      t.integer('clicks').defaultTo(0);
      t.decimal('cost', 10, 2).defaultTo(0);
      t.decimal('conversions', 10, 2).defaultTo(0);
      t.decimal('conversion_value', 10, 2).defaultTo(0);
      t.decimal('ctr', 8, 4);
      t.decimal('avg_cpc', 10, 2);
      t.decimal('roas', 10, 2);
      t.decimal('impression_share', 8, 4);
      t.decimal('lost_is_budget', 8, 4); // impression share lost to budget
      t.decimal('lost_is_rank', 8, 4);   // impression share lost to rank
      t.decimal('avg_position', 8, 2);
      t.jsonb('metadata');
      t.timestamps(true, true);

      t.unique(['campaign_id', 'date']);
    })

    // ── Search Terms ──────────────────────────────────────────────
    .createTable('ad_search_terms', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('campaign_id').references('id').inTable('ad_campaigns').onDelete('CASCADE');
      t.string('search_term').notNullable();
      t.string('match_type'); // exact, phrase, broad
      t.integer('impressions').defaultTo(0);
      t.integer('clicks').defaultTo(0);
      t.decimal('cost', 10, 2).defaultTo(0);
      t.decimal('conversions', 10, 2).defaultTo(0);
      t.decimal('conversion_value', 10, 2).defaultTo(0);
      t.decimal('roas', 10, 2);
      t.string('status'); // added, excluded, none
      t.date('first_seen');
      t.date('last_seen');
      t.jsonb('metadata');
      t.timestamps(true, true);
    })

    // ── Service Attribution (full funnel) ─────────────────────────
    .createTable('ad_service_attribution', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('campaign_id').references('id').inTable('ad_campaigns').onDelete('SET NULL');
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
      t.string('service_line'); // pest, lawn, mosquito, termite, rodent, tree_shrub, specialty
      t.string('specific_service'); // quarterly_pest, rodent_exclusion, bed_bug, lawn_plugging, etc.
      t.string('service_bucket'); // recurring, one_time_entry, high_ticket_specialty, lawn_seasonal
      t.date('lead_date');
      t.string('lead_source'); // google_ads, google_lsa, organic, referral, domain_website, etc.
      t.string('lead_source_detail'); // campaign name, search term, domain
      t.string('gclid');
      t.string('utm_campaign');
      t.string('utm_term');
      t.decimal('ad_cost', 10, 2); // attributed ad cost for this lead
      t.string('funnel_stage').defaultTo('lead'); // lead, contacted, estimate_sent, estimate_viewed, booked, completed, lost
      t.decimal('estimate_amount', 10, 2);
      t.decimal('booked_amount', 10, 2);
      t.decimal('completed_revenue', 10, 2);
      t.decimal('gross_profit', 10, 2);
      t.decimal('gross_margin_pct', 8, 2);
      t.boolean('is_recurring').defaultTo(false);
      t.decimal('projected_ltv_12mo', 10, 2);
      t.integer('days_to_book');
      t.integer('days_to_complete');
      t.boolean('close_rate_contribution').defaultTo(false);
      t.timestamps(true, true);
    })

    // ── Performance Targets ───────────────────────────────────────
    .createTable('ad_targets', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.decimal('min_roas', 10, 2).defaultTo(4.0);
      t.decimal('max_cpa', 10, 2).defaultTo(40);
      t.decimal('min_conversion_rate', 8, 4).defaultTo(0.03);
      t.decimal('target_aov', 10, 2).defaultTo(120);
      t.decimal('capacity_green_max', 8, 2).defaultTo(70);    // 0-70% = green
      t.decimal('capacity_yellow_max', 8, 2).defaultTo(85);   // 71-85% = yellow
      t.decimal('capacity_orange_max', 8, 2).defaultTo(95);   // 86-95% = orange
      // 96-100%+ = red
      t.integer('max_services_per_tech').defaultTo(8);
      t.jsonb('metadata');
      t.timestamps(true, true);
    })

    // ── Budget Change Log ─────────────────────────────────────────
    .createTable('ad_budget_log', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('campaign_id').references('id').inTable('ad_campaigns').onDelete('CASCADE');
      t.string('campaign_name');
      t.string('previous_mode');
      t.string('new_mode');
      t.decimal('previous_budget', 10, 2);
      t.decimal('new_budget', 10, 2);
      t.string('reason');
      t.string('trigger'); // auto, manual, advisor
      t.decimal('capacity_pct', 8, 2);
      t.string('check_date');
      t.timestamps(true, true);
    })

    // ── AI Advisor Reports ────────────────────────────────────────
    .createTable('ad_advisor_reports', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.date('date').unique();
      t.jsonb('report_data');
      t.string('grade');
      t.integer('recommendation_count').defaultTo(0);
      t.integer('waste_alert_count').defaultTo(0);
      t.integer('applied_count').defaultTo(0);
      t.timestamps(true, true);
    })

    // ── Seed default targets ──────────────────────────────────────
    .then(() => knex('ad_targets').insert({
      min_roas: 4.0,
      max_cpa: 40,
      min_conversion_rate: 0.03,
      target_aov: 120,
      max_services_per_tech: 8,
    }));
};

exports.down = function (knex) {
  return knex.schema
    .dropTableIfExists('ad_advisor_reports')
    .dropTableIfExists('ad_budget_log')
    .dropTableIfExists('ad_targets')
    .dropTableIfExists('ad_service_attribution')
    .dropTableIfExists('ad_search_terms')
    .dropTableIfExists('ad_performance_daily')
    .dropTableIfExists('ad_campaigns');
};
