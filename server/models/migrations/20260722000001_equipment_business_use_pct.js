/**
 * business_use_pct on equipment_register — the listed-property business-use
 * fraction for depreciation (IRS Pub 946). It only bites for LISTED property
 * (vehicles), where the deductible depreciation is business_use_pct x MACRS;
 * non-vehicle assets stay 100%.
 *
 * Default 100.00: the sole service vehicle is used 100% for business (all
 * logged trips are owner-confirmed work trips), and every existing asset is a
 * business asset — so the default is correct out of the box and the P&L's new
 * MACRS computation works immediately. A CPA can lower a specific vehicle's
 * value later if any personal use exists.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('equipment_register'))) return;
  if (!(await knex.schema.hasColumn('equipment_register', 'business_use_pct'))) {
    await knex.schema.alterTable('equipment_register', (t) => {
      // 0–100; the P&L clamps defensively regardless.
      t.decimal('business_use_pct', 5, 2).notNullable().defaultTo(100);
    });
  }
  // MACRS averaging convention. Only 'half_year' is computed; buildPnlReport
  // auto-detects mid-quarter years (>40% of the year's basis placed in Q4) and
  // fails those assets closed for CPA computation, and a CPA can also set the
  // value explicitly. Default 'half_year' is correct for every current asset
  // (all placed in service in Q1).
  if (!(await knex.schema.hasColumn('equipment_register', 'depreciation_convention'))) {
    await knex.schema.alterTable('equipment_register', (t) => {
      t.string('depreciation_convention', 20).notNullable().defaultTo('half_year');
    });
  }
};

exports.down = async function down(knex) {
  for (const col of ['business_use_pct', 'depreciation_convention']) {
    if (await knex.schema.hasColumn('equipment_register', col)) {
      await knex.schema.alterTable('equipment_register', (t) => { t.dropColumn(col); });
    }
  }
};
