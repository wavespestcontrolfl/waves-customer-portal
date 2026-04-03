/**
 * Migration 037 — Customer Intelligence Engine
 *
 * Tables:
 *  - customer_health_scores  (daily health score per customer)
 *  - customer_signals        (raw behavioral signals)
 *  - retention_outreach      (AI-generated retention outreach)
 *  - upsell_opportunities    (cross-sell recommendations)
 */

exports.up = function (knex) {
  return knex.schema

    // ── Health Scores ─────────────────────────────────────────────
    .createTable('customer_health_scores', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
      t.date('score_date');
      t.integer('health_score'); // 0-100
      t.decimal('churn_probability', 5, 3); // 0.000-1.000
      t.string('churn_risk_level'); // healthy, watch, at_risk, critical
      t.jsonb('risk_factors');
      t.jsonb('upsell_opportunities');
      t.text('next_best_action');
      t.string('engagement_trend'); // improving, stable, declining, disengaging
      t.decimal('lifetime_value_estimate', 10, 2);
      t.timestamps(true, true);

      t.index(['customer_id', 'score_date']);
      t.index('churn_risk_level');
    })

    // ── Behavioral Signals ─────────────────────────────────────��──
    .createTable('customer_signals', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
      t.string('signal_type').notNullable();
      t.string('signal_value');
      t.string('severity'); // info, warning, critical
      t.timestamp('detected_at');
      t.boolean('resolved').defaultTo(false);
      t.timestamp('resolved_at');
      t.string('resolved_by'); // auto_outreach, admin_manual, customer_action
      t.timestamps(true, true);

      t.index(['customer_id', 'resolved']);
      t.index('signal_type');
    })

    // ── Retention Outreach ────────────────────────────────────────
    .createTable('retention_outreach', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('trigger_signal_id').references('id').inTable('customer_signals').onDelete('SET NULL');
      t.string('outreach_type'); // sms, call, email, in_person_next_visit
      t.string('outreach_strategy'); // empathy_check_in, value_reminder, discount_offer, service_recovery, personal_call, pause_offer, downgrade_option
      t.text('message_content');
      t.string('status').defaultTo('pending_approval'); // pending_approval, approved, sent, completed, customer_responded, save_successful, save_failed
      t.string('approved_by');
      t.timestamp('sent_at');
      t.text('customer_response');
      t.string('outcome'); // retained, downgraded, paused, cancelled, no_response
      t.decimal('revenue_saved', 10, 2);
      t.timestamps(true, true);

      t.index(['customer_id']);
      t.index('status');
    })

    // ── Upsell Opportunities ──────────────────────────────────────
    .createTable('upsell_opportunities', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
      t.string('recommended_service');
      t.text('reason');
      t.decimal('confidence', 5, 3);
      t.decimal('estimated_monthly_value', 10, 2);
      t.decimal('estimated_close_probability', 5, 3);
      t.string('trigger'); // seasonal, service_pattern, property_type, complaint_related, conversation_detected, tier_upgrade
      t.string('status').defaultTo('identified'); // identified, pitched, accepted, declined, deferred
      t.timestamp('pitched_at');
      t.string('pitched_by');
      t.timestamp('outcome_at');
      t.timestamps(true, true);

      t.index(['customer_id', 'status']);
    });
};

exports.down = function (knex) {
  return knex.schema
    .dropTableIfExists('upsell_opportunities')
    .dropTableIfExists('retention_outreach')
    .dropTableIfExists('customer_signals')
    .dropTableIfExists('customer_health_scores');
};
