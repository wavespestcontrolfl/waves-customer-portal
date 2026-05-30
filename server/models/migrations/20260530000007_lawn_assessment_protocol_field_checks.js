exports.up = async function up(knex) {
  const assessmentCols = await knex('lawn_assessments').columnInfo().catch(() => ({}));
  if (Object.keys(assessmentCols).length) {
    await knex.schema.alterTable('lawn_assessments', (t) => {
      if (!assessmentCols.irrigation_status) t.string('irrigation_status', 40).nullable();
      if (!assessmentCols.thatch_measurement_in) t.decimal('thatch_measurement_in', 5, 2).nullable();
      if (!assessmentCols.chinch_count_per_sqft) t.decimal('chinch_count_per_sqft', 8, 2).nullable();
      if (!assessmentCols.chinch_float_test_done) t.boolean('chinch_float_test_done').notNullable().defaultTo(false);
      if (!assessmentCols.nematode_assay_flag) t.boolean('nematode_assay_flag').notNullable().defaultTo(false);
      if (!assessmentCols.soil_k_ppm) t.decimal('soil_k_ppm', 8, 2).nullable();
      if (!assessmentCols.large_patch_history_observed) t.boolean('large_patch_history_observed').notNullable().defaultTo(false);
      if (!assessmentCols.protocol_field_notes) t.text('protocol_field_notes').nullable();
      if (!assessmentCols.protocol_field_checks) t.jsonb('protocol_field_checks').notNullable().defaultTo('{}');
    });
  }

  const turfCols = await knex('customer_turf_profiles').columnInfo().catch(() => ({}));
  if (Object.keys(turfCols).length) {
    await knex.schema.alterTable('customer_turf_profiles', (t) => {
      if (!turfCols.last_nematode_flagged_at) t.date('last_nematode_flagged_at').nullable();
      if (!turfCols.last_protocol_assessment_id) {
        t.uuid('last_protocol_assessment_id')
          .nullable()
          .references('id')
          .inTable('lawn_assessments')
          .onDelete('SET NULL');
      }
    });
  }
};

exports.down = async function down(knex) {
  const turfCols = await knex('customer_turf_profiles').columnInfo().catch(() => ({}));
  if (Object.keys(turfCols).length) {
    await knex.schema.alterTable('customer_turf_profiles', (t) => {
      if (turfCols.last_protocol_assessment_id) t.dropColumn('last_protocol_assessment_id');
      if (turfCols.last_nematode_flagged_at) t.dropColumn('last_nematode_flagged_at');
    });
  }

  const assessmentCols = await knex('lawn_assessments').columnInfo().catch(() => ({}));
  if (Object.keys(assessmentCols).length) {
    await knex.schema.alterTable('lawn_assessments', (t) => {
      if (assessmentCols.protocol_field_checks) t.dropColumn('protocol_field_checks');
      if (assessmentCols.protocol_field_notes) t.dropColumn('protocol_field_notes');
      if (assessmentCols.large_patch_history_observed) t.dropColumn('large_patch_history_observed');
      if (assessmentCols.soil_k_ppm) t.dropColumn('soil_k_ppm');
      if (assessmentCols.nematode_assay_flag) t.dropColumn('nematode_assay_flag');
      if (assessmentCols.chinch_float_test_done) t.dropColumn('chinch_float_test_done');
      if (assessmentCols.chinch_count_per_sqft) t.dropColumn('chinch_count_per_sqft');
      if (assessmentCols.thatch_measurement_in) t.dropColumn('thatch_measurement_in');
      if (assessmentCols.irrigation_status) t.dropColumn('irrigation_status');
    });
  }
};
