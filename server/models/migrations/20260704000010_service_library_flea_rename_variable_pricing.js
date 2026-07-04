/**
 * Owner-directed service-library changes (2026-07-04):
 *
 *  1. Rebrand the `flea_tick` service "Flea & Tick Yard Treatment Service"
 *     -> "Flea Control Service" (flea-only copy). service_key stays
 *     `flea_tick` so every existing reference/join holds.
 *
 *  2. Convert EVERY service to variable, no-preset pricing:
 *       pricing_type      = 'variable'
 *       base_price        = NULL
 *       price_range_min   = NULL
 *       price_range_max   = NULL
 *
 *     Pricing is quote/estimate-driven; the library should not advertise a
 *     preset price. base_price is cleared to NULL (not 0) on purpose: the
 *     scheduling fallback in routes/admin-schedule.js
 *     (`base_price != null ? base_price : estimatedPrice`) would treat a
 *     literal 0 as a real $0 charge, whereas NULL keeps it on the estimate.
 *
 * NOTE: the sweeping pricing change is NOT automatically reversible — down()
 * restores the flea_tick label only; prior per-service prices/ranges cannot
 * be recovered from this migration.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  // 1) "Flea & Tick Yard Treatment Service" -> "Flea Control Service" (flea-only)
  //    ("Service" is part of the stored name; "Specialty" is the category badge.)
  await knex('services')
    .where({ service_key: 'flea_tick' })
    .update({
      name: 'Flea Control Service',
      short_name: 'Flea',
      description: 'Full yard broadcast for flea control. Interior treatment available as an add-on.',
      updated_at: knex.fn.now(),
    });

  // 2) Every service -> variable pricing with no preset price or range
  await knex('services').update({
    pricing_type: 'variable',
    base_price: null,
    price_range_min: null,
    price_range_max: null,
    updated_at: knex.fn.now(),
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  // Only the flea rebrand is reversible here. Prior per-service pricing
  // (pricing_type / base_price / ranges) is not restored — it was not
  // captured before the blanket update in up().
  await knex('services')
    .where({ service_key: 'flea_tick' })
    .update({
      name: 'Flea & Tick Yard Treatment Service',
      short_name: 'Flea/Tick',
      description: 'Full yard broadcast for flea and tick control. Interior treatment available as add-on.',
      updated_at: knex.fn.now(),
    });
};
