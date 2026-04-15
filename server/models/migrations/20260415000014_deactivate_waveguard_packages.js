/**
 * Deactivate the WaveGuard Bronze/Silver/Gold/Platinum packages per owner
 * request — packages are no longer surfaced in the Service Library UI.
 * Row data is preserved (is_active = false) in case of future rehydration.
 */
exports.up = async function (knex) {
  await knex('service_packages').update({ is_active: false, updated_at: knex.fn.now() });
};

exports.down = async function (knex) {
  await knex('service_packages').update({ is_active: true, updated_at: knex.fn.now() });
};
