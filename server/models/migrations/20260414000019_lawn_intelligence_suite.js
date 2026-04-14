/**
 * Migration 008 — Lawn Assessment Intelligence Suite
 *
 * Covers all 16 improvement features:
 * 1. FAWN weather context on assessments + outcomes
 * 2. Photo quality gating (quality_gate_passed column)
 * 3. Product efficacy (materialized view-like table)
 * 4. Protocol performance scoring
 * 5. Contradiction detection log
 * 6. Tech field knowledge (no schema — uses existing)
 * 7. Assessment notification tracking
 * 8. Lawn health timeline (no schema — uses existing photos)
 * 9. Seasonal expectation (no schema — computed from existing)
 * 10. Neighbor comparison aggregates
 * 11. Lawn health → customer health signal
 * 12. Assessment completion rate tracking
 * 13. ROI calculator (no schema — computed from existing)
 * 14. Auto-generate service reports linkage
 * 15. Tech calibration scoring
 * 16. Customer satisfaction → outcome validation (wire existing field)
 * 17. Baseline photo re-capture protocol
 */

exports.up = async function (knex) {

  // ── 1. FAWN weather context ─────────────────────────────────
  if (await knex.schema.hasTable('lawn_assessments')) {
    const cols = ['fawn_temp_f', 'fawn_humidity_pct', 'fawn_rainfall_7d', 'fawn_soil_temp_f', 'fawn_station'];
    for (const col of cols) {
      if (!(await knex.schema.hasColumn('lawn_assessments', col))) {
        await knex.schema.alterTable('lawn_assessments', t => {
          if (col === 'fawn_station') t.string(col, 100);
          else t.decimal(col, 6, 2);
        });
      }
    }
  }

  if (await knex.schema.hasTable('treatment_outcomes')) {
    const cols = ['fawn_temp_f', 'fawn_humidity_pct', 'fawn_rainfall_7d', 'fawn_soil_temp_f'];
    for (const col of cols) {
      if (!(await knex.schema.hasColumn('treatment_outcomes', col))) {
        await knex.schema.alterTable('treatment_outcomes', t => {
          t.decimal(col, 6, 2);
        });
      }
    }
  }

  // ── 2. Photo quality gating ─────────────────────────────────
  if (await knex.schema.hasTable('lawn_assessment_photos')) {
    if (!(await knex.schema.hasColumn('lawn_assessment_photos', 'quality_gate_passed'))) {
      await knex.schema.alterTable('lawn_assessment_photos', t => {
        t.boolean('quality_gate_passed').defaultTo(true);
        t.jsonb('quality_issues').defaultTo('[]'); // ['blurry','too_dark','low_coverage','feet_visible']
      });
    }
  }

  // ── 3. Product efficacy aggregates ──────────────────────────
  if (!(await knex.schema.hasTable('product_efficacy'))) {
    await knex.schema.createTable('product_efficacy', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('product_name', 300).notNullable();
      t.string('product_slug', 200).notNullable();
      t.integer('application_count').defaultTo(0);
      t.integer('customer_count').defaultTo(0);

      // Average deltas
      t.decimal('avg_delta_turf', 6, 2);
      t.decimal('avg_delta_weed', 6, 2);
      t.decimal('avg_delta_color', 6, 2);
      t.decimal('avg_delta_fungus', 6, 2);
      t.decimal('avg_delta_thatch', 6, 2);
      t.decimal('avg_delta_overall', 6, 2);

      // By season
      t.jsonb('peak_stats');     // { count, avgDelta }
      t.jsonb('shoulder_stats');
      t.jsonb('dormant_stats');

      // By grass track
      t.jsonb('track_stats');    // { A: { count, avgDelta }, B: ... }

      // Satisfaction correlation
      t.decimal('avg_satisfaction', 3, 2);
      t.integer('satisfaction_count').defaultTo(0);

      // Ranking
      t.integer('efficacy_rank');
      t.decimal('efficacy_score', 5, 2); // composite 0-100

      t.timestamp('last_computed').defaultTo(knex.fn.now());
      t.timestamps(true, true);

      t.unique('product_slug');
      t.index('efficacy_rank');
      t.index('application_count');
    });
  }

  // ── 4. Protocol performance scoring ─────────────────────────
  if (!(await knex.schema.hasTable('protocol_performance'))) {
    await knex.schema.createTable('protocol_performance', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('grass_track', 20).notNullable();
      t.integer('customer_count').defaultTo(0);
      t.integer('outcome_count').defaultTo(0);

      // Aggregate deltas
      t.decimal('avg_delta_turf', 6, 2);
      t.decimal('avg_delta_weed', 6, 2);
      t.decimal('avg_delta_color', 6, 2);
      t.decimal('avg_delta_fungus', 6, 2);
      t.decimal('avg_delta_thatch', 6, 2);
      t.decimal('avg_delta_overall', 6, 2);

      // Per-visit performance
      t.jsonb('visit_performance'); // { 1: { count, avgDelta }, 2: ... }

      // Best/worst products in this track
      t.jsonb('top_products');     // [{ name, avgDelta, count }]
      t.jsonb('bottom_products');

      // Retention correlation
      t.decimal('retention_rate_6mo', 5, 4);
      t.decimal('avg_satisfaction', 3, 2);

      t.decimal('protocol_score', 5, 2); // composite 0-100
      t.timestamp('last_computed').defaultTo(knex.fn.now());
      t.timestamps(true, true);

      t.unique('grass_track');
    });
  }

  // ── 5. Contradiction detection log ──────────────────────────
  if (!(await knex.schema.hasTable('knowledge_contradictions'))) {
    await knex.schema.createTable('knowledge_contradictions', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      t.uuid('kb_entry_id').references('id').inTable('knowledge_base').onDelete('SET NULL');
      t.uuid('wiki_entry_id').references('id').inTable('knowledge_entries').onDelete('SET NULL');

      t.string('contradiction_type', 50); // claim_vs_data, outdated_claim, conflicting_entries
      t.text('kb_claim');                  // what Claudeopedia says
      t.text('wiki_evidence');             // what outcome data shows
      t.text('description');
      t.decimal('severity', 3, 2).defaultTo(0.5); // 0.00-1.00

      t.string('status', 20).defaultTo('open'); // open, reviewed, resolved, dismissed
      t.string('resolved_by', 100);
      t.text('resolution_notes');
      t.timestamp('resolved_at');

      t.timestamps(true, true);

      t.index('status');
      t.index(['kb_entry_id']);
      t.index(['wiki_entry_id']);
    });
  }

  // ── 7. Assessment notification tracking ─────────────────────
  if (await knex.schema.hasTable('lawn_assessments')) {
    if (!(await knex.schema.hasColumn('lawn_assessments', 'notification_sent'))) {
      await knex.schema.alterTable('lawn_assessments', t => {
        t.boolean('notification_sent').defaultTo(false);
        t.timestamp('notification_sent_at');
      });
    }
  }

  // ── 10. Neighbor comparison aggregates ──────────────────────
  if (!(await knex.schema.hasTable('neighborhood_benchmarks'))) {
    await knex.schema.createTable('neighborhood_benchmarks', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('segment_key', 200).notNullable().unique(); // e.g. "lakewood-ranch|st-augustine" or "34202|st-augustine"
      t.string('segment_type', 30).notNullable(); // zip, subdivision, city, county
      t.string('segment_name', 200);
      t.string('grass_type', 50);

      t.integer('customer_count').defaultTo(0);
      t.integer('assessment_count').defaultTo(0);

      // Percentile boundaries
      t.integer('p25_overall');
      t.integer('p50_overall');
      t.integer('p75_overall');
      t.integer('avg_overall');

      // Average improvement for customers on program >90 days
      t.decimal('avg_improvement', 6, 2);
      t.integer('improvement_count').defaultTo(0);

      // Average starting score for new customers
      t.integer('avg_starting_score');

      t.timestamp('last_computed').defaultTo(knex.fn.now());
      t.timestamps(true, true);

      t.index('segment_type');
    });
  }

  // ── 12. Assessment completion rate ──────────────────────────
  if (!(await knex.schema.hasTable('assessment_completion_tracking'))) {
    await knex.schema.createTable('assessment_completion_tracking', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.date('service_date').notNullable();
      t.uuid('technician_id');
      t.string('technician_name', 100);

      t.integer('lawn_services_scheduled').defaultTo(0);
      t.integer('assessments_started').defaultTo(0);
      t.integer('assessments_confirmed').defaultTo(0);
      t.decimal('completion_rate', 5, 4);

      t.timestamp('last_computed').defaultTo(knex.fn.now());
      t.timestamps(true, true);

      t.unique(['service_date', 'technician_id']);
      t.index('service_date');
    });
  }

  // ── 14. Auto-generated report linkage ───────────────────────
  if (await knex.schema.hasTable('lawn_assessments')) {
    if (!(await knex.schema.hasColumn('lawn_assessments', 'report_id'))) {
      await knex.schema.alterTable('lawn_assessments', t => {
        t.uuid('report_id'); // links to service_reports
        t.boolean('report_auto_generated').defaultTo(false);
      });
    }
  }

  // ── 15. Tech calibration scoring ────────────────────────────
  if (!(await knex.schema.hasTable('tech_calibration'))) {
    await knex.schema.createTable('tech_calibration', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('assessment_id').notNullable().references('id').inTable('lawn_assessments').onDelete('CASCADE');
      t.uuid('technician_id');

      // AI proposed scores
      t.integer('ai_turf_density');
      t.integer('ai_weed_suppression');
      t.integer('ai_color_health');
      t.integer('ai_fungus_control');
      t.integer('ai_thatch_level');

      // Tech confirmed scores (after override)
      t.integer('tech_turf_density');
      t.integer('tech_weed_suppression');
      t.integer('tech_color_health');
      t.integer('tech_fungus_control');
      t.integer('tech_thatch_level');

      // Deltas (positive = tech scored higher than AI)
      t.integer('delta_turf');
      t.integer('delta_weed');
      t.integer('delta_color');
      t.integer('delta_fungus');
      t.integer('delta_thatch');
      t.decimal('avg_delta', 6, 2);

      // Was this override validated by a subsequent assessment?
      t.boolean('outcome_validated');
      t.string('outcome_verdict', 20); // tech_correct, ai_correct, inconclusive

      t.timestamps(true, true);

      t.index('technician_id');
      t.index('assessment_id');
    });
  }

  // ── 17. Baseline photo re-capture ───────────────────────────
  if (await knex.schema.hasTable('lawn_assessments')) {
    if (!(await knex.schema.hasColumn('lawn_assessments', 'needs_baseline_photos'))) {
      await knex.schema.alterTable('lawn_assessments', t => {
        t.boolean('needs_baseline_photos').defaultTo(false);
      });
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('tech_calibration');
  await knex.schema.dropTableIfExists('assessment_completion_tracking');
  await knex.schema.dropTableIfExists('neighborhood_benchmarks');
  await knex.schema.dropTableIfExists('knowledge_contradictions');
  await knex.schema.dropTableIfExists('protocol_performance');
  await knex.schema.dropTableIfExists('product_efficacy');

  const laCols = ['fawn_temp_f','fawn_humidity_pct','fawn_rainfall_7d','fawn_soil_temp_f','fawn_station',
    'notification_sent','notification_sent_at','report_id','report_auto_generated','needs_baseline_photos'];
  if (await knex.schema.hasTable('lawn_assessments')) {
    for (const col of laCols) {
      if (await knex.schema.hasColumn('lawn_assessments', col)) {
        await knex.schema.alterTable('lawn_assessments', t => t.dropColumn(col));
      }
    }
  }

  const toCols = ['fawn_temp_f','fawn_humidity_pct','fawn_rainfall_7d','fawn_soil_temp_f'];
  if (await knex.schema.hasTable('treatment_outcomes')) {
    for (const col of toCols) {
      if (await knex.schema.hasColumn('treatment_outcomes', col)) {
        await knex.schema.alterTable('treatment_outcomes', t => t.dropColumn(col));
      }
    }
  }

  if (await knex.schema.hasTable('lawn_assessment_photos')) {
    for (const col of ['quality_gate_passed', 'quality_issues']) {
      if (await knex.schema.hasColumn('lawn_assessment_photos', col)) {
        await knex.schema.alterTable('lawn_assessment_photos', t => t.dropColumn(col));
      }
    }
  }
};
