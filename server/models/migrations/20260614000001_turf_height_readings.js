/**
 * Turf height-of-cut readings — one per lawn service visit (1:1 with
 * service_records). Manual gauge reading is the source of truth; ocr_* columns
 * are populated asynchronously by the dual-model cross-check (PR2) and stay null
 * until then. Tamper-evidence reuses service-report/photo-chain.js — no
 * hand-rolled hash columns here. Targets are config-driven in code
 * (services/service-report/turf-height.js); min/max are snapshotted at capture.
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('turf_height_readings');
  if (exists) return;

  await knex.schema.createTable('turf_height_readings', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('service_record_id').notNullable().unique()
      .references('id').inTable('service_records');
    t.uuid('customer_id').notNullable()
      .references('id').inTable('customers');
    t.text('grass_type').notNullable();                 // canonical key snapshot
    t.decimal('manual_height_in', 4, 2).notNullable();  // gauge reading (¼" steps), source of truth
    t.decimal('ocr_height_in', 4, 2);                   // dual-model consensus (PR2)
    t.jsonb('ocr_models');                              // [{model,height_in,confidence,readable}]
    t.decimal('ocr_confidence', 3, 2);                 // 0..1 consensus confidence
    t.text('verification_status').notNullable().defaultTo('pending'); // pending|verified|discrepancy|ocr_failed
    t.decimal('target_min_in', 3, 1).notNullable();     // band snapshot at capture
    t.decimal('target_max_in', 3, 1).notNullable();
    t.text('range_status').notNullable();               // in_range|below|above
    t.uuid('gauge_photo_id')                            // optional — reuses the s3_key model
      .references('id').inTable('service_photos');
    t.timestamp('measured_at', { useTz: true }).notNullable();
    t.uuid('created_by').notNullable()
      .references('id').inTable('technicians');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // App + service layer enforce the exact Turfchek increment set; the DB CHECK
  // is only a sanity floor/ceiling.
  await knex.raw(`
    ALTER TABLE turf_height_readings
    ADD CONSTRAINT ck_thr_height CHECK (manual_height_in BETWEEN 0.5 AND 8.0)
  `);

  // Trend sparkline (ordered history per customer).
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_thr_customer_time
    ON turf_height_readings (customer_id, measured_at DESC)
  `);

  // Admin review queue (OCR divergence / failure) — partial index (PR2 consumer).
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_thr_review
    ON turf_height_readings (verification_status)
    WHERE verification_status IN ('discrepancy', 'ocr_failed')
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('turf_height_readings');
};
