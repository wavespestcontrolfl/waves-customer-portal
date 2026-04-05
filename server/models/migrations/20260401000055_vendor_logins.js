/**
 * Migration 055 — Vendor login credentials + remove TruGreen
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('vendors', t => {
    t.string('login_username');
    t.string('login_email');
    t.text('login_password_encrypted');
    t.string('account_number');
    t.string('login_url', 500);
  });

  // Remove TruGreen (competitor reference — not a vendor)
  await knex('vendors').where({ name: 'TruGreen' }).del();
};

exports.down = async function (knex) {
  await knex.schema.alterTable('vendors', t => {
    t.dropColumn('login_username');
    t.dropColumn('login_email');
    t.dropColumn('login_password_encrypted');
    t.dropColumn('account_number');
    t.dropColumn('login_url');
  });
};
