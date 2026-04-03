/**
 * Migration 036 — CSR Coach System
 *
 * Tables:
 *  - csr_call_scores         (per-call scoring + lead grading)
 *  - ai_follow_up_tasks      (AI-generated follow-up tasks with verification)
 *  - csr_performance_periods (biweekly performance + bonus tracking)
 */

exports.up = function (knex) {
  return knex.schema

    // ── Call Scores ───────────────────────────────────────────────
    .createTable('csr_call_scores', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
      t.string('csr_name');
      t.date('call_date');
      t.string('call_direction').defaultTo('inbound'); // inbound, outbound
      t.string('call_source'); // google_ads, organic, referral, existing_customer

      // 15-point scoring
      t.integer('total_score'); // 0-15 (10 core + 5 rescue)
      t.integer('core_score');  // 0-10
      t.integer('rescue_score'); // 0-5
      t.jsonb('point_details'); // { greeting: 1, empathy: 1, problem_capture: 1, ... }

      // 5 skill dimensions
      t.decimal('control_score', 4, 2);
      t.decimal('warmth_score', 4, 2);
      t.decimal('clarity_score', 4, 2);
      t.decimal('objection_handling_score', 4, 2);
      t.decimal('closing_strength_score', 4, 2);

      // Outcome
      t.string('call_outcome'); // booked, estimate_sent, callback_scheduled, not_booked, voicemail, no_answer
      t.text('call_summary');
      t.text('coaching_notes'); // AI coaching feedback
      t.jsonb('better_phrasings'); // suggested better responses

      // Lead grading (separate from CSR performance)
      t.integer('lead_quality_score'); // 1-10
      t.string('lead_intent'); // urgent, price_shopping, researching, referral_warm, repeat_customer, tire_kicker
      t.string('lead_source_quality'); // high, medium, low
      t.string('loss_reason'); // bad_lead, csr_missed_script, pricing, no_availability, customer_shopping, after_hours, no_answer
      t.boolean('is_first_call_from_lead').defaultTo(false);
      t.decimal('estimated_job_value', 10, 2);

      // Follow-up
      t.boolean('follow_up_task_created').defaultTo(false);

      t.text('transcript_snippet'); // relevant portion of call/sms
      t.jsonb('metadata');
      t.timestamps(true, true);

      t.index('csr_name');
      t.index('call_date');
      t.index('call_outcome');
    })

    // ── Follow-Up Tasks ───────────────────────────────────────────
    .createTable('ai_follow_up_tasks', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('call_score_id').references('id').inTable('csr_call_scores').onDelete('SET NULL');
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
      t.string('assigned_to'); // CSR name or 'Adam'
      t.string('task_type'); // call_back, send_sms, send_estimate, schedule_inspection, escalate_to_adam
      t.text('recommended_action'); // AI-generated specific script
      t.text('context_summary');
      t.timestamp('deadline');
      t.string('status').defaultTo('pending'); // pending, in_progress, completed, expired, verified
      t.boolean('action_verified').defaultTo(false);
      t.string('verification_method'); // sms_log_match, call_log_match, manual_confirm
      t.boolean('job_booked_from_followup').defaultTo(false);
      t.timestamp('completed_at');
      t.timestamps(true, true);

      t.index('status');
      t.index('assigned_to');
      t.index('deadline');
    })

    // ── Performance Periods (biweekly) ────────────────────────────
    .createTable('csr_performance_periods', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.date('period_start');
      t.date('period_end');
      t.string('csr_name');
      t.decimal('first_call_booking_rate', 8, 2);
      t.decimal('avg_script_score', 8, 2);
      t.decimal('follow_up_action_rate', 8, 2);
      t.integer('total_calls_scored').defaultTo(0);
      t.integer('total_bookings').defaultTo(0);
      t.integer('total_follow_ups_assigned').defaultTo(0);
      t.integer('total_follow_ups_completed').defaultTo(0);
      t.integer('total_follow_ups_booked').defaultTo(0);
      t.string('bonus_category'); // best_booking_rate, best_script_score, best_followup_rate
      t.decimal('bonus_amount', 8, 2);
      t.timestamps(true, true);

      t.unique(['period_start', 'csr_name']);
    });
};

exports.down = function (knex) {
  return knex.schema
    .dropTableIfExists('csr_performance_periods')
    .dropTableIfExists('ai_follow_up_tasks')
    .dropTableIfExists('csr_call_scores');
};
