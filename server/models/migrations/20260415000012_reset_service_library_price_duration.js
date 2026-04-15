/**
 * Reset every service in the service library to:
 *   base_price = 0.00
 *   default_duration_minutes = 60
 *
 * Per owner request: pricing and duration will be driven elsewhere;
 * the library should display placeholder $0.00 / 60 min for every service.
 */
exports.up = async function (knex) {
  await knex('services').update({
    base_price: 0,
    default_duration_minutes: 60,
    updated_at: knex.fn.now(),
  });
};

exports.down = async function () {
  // No-op — original per-service values are not preserved.
};
