/**
 * Migration 102 — Enhanced Compliance: DACS reporting columns + tech license tracking
 */
exports.up = async function (knex) {
  // ── Enhance property_application_history with DACS-required fields ──
  const hasPAH = await knex.schema.hasTable('property_application_history');
  if (hasPAH) {
    const cols = [
      ['epa_registration_number', (t) => t.string('epa_registration_number', 50)],
      ['target_pest', (t) => t.string('target_pest', 200)],
      ['application_method', (t) => t.string('application_method', 50)],
      ['dilution_rate', (t) => t.string('dilution_rate', 100)],
      ['restricted_use', (t) => t.boolean('restricted_use').defaultTo(false)],
      ['applicator_license', (t) => t.string('applicator_license', 50)],
      ['application_site', (t) => t.string('application_site', 50)],
      ['category', null], // already exists in base migration — skip
    ];

    for (const [col, builder] of cols) {
      if (!builder) continue;
      const has = await knex.schema.hasColumn('property_application_history', col);
      if (!has) {
        await knex.schema.alterTable('property_application_history', builder);
      }
    }

    // quantity_unit may already exist — check before adding
    const hasQU = await knex.schema.hasColumn('property_application_history', 'quantity_unit');
    if (!hasQU) {
      await knex.schema.alterTable('property_application_history', (t) => {
        t.string('quantity_unit', 20);
      });
    }
  }

  // ── Add license fields to technicians ──
  const hasTechs = await knex.schema.hasTable('technicians');
  if (hasTechs) {
    const techCols = [
      ['fl_applicator_license', (t) => t.string('fl_applicator_license', 50)],
      ['license_expiry', (t) => t.date('license_expiry')],
      ['license_categories', (t) => t.jsonb('license_categories')],
    ];

    for (const [col, builder] of techCols) {
      const has = await knex.schema.hasColumn('technicians', col);
      if (!has) {
        await knex.schema.alterTable('technicians', builder);
      }
    }
  }
};

exports.down = async function (knex) {
  const hasPAH = await knex.schema.hasTable('property_application_history');
  if (hasPAH) {
    const dropCols = ['epa_registration_number', 'target_pest', 'application_method',
      'dilution_rate', 'restricted_use', 'applicator_license', 'application_site'];
    for (const col of dropCols) {
      const has = await knex.schema.hasColumn('property_application_history', col);
      if (has) {
        await knex.schema.alterTable('property_application_history', (t) => t.dropColumn(col));
      }
    }
  }

  const hasTechs = await knex.schema.hasTable('technicians');
  if (hasTechs) {
    for (const col of ['fl_applicator_license', 'license_expiry', 'license_categories']) {
      const has = await knex.schema.hasColumn('technicians', col);
      if (has) {
        await knex.schema.alterTable('technicians', (t) => t.dropColumn(col));
      }
    }
  }
};
