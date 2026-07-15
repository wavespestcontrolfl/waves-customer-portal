'use strict';

/**
 * estimate_deposits.refunded_surcharge — cumulative card-surcharge dollars
 * actually RETURNED to the customer across this deposit's refunds.
 *
 * Until now every refund path returned the fee's prorated share alongside
 * the face amount, so revenue stats could scale card_surcharge by the
 * unrefunded face fraction. The cancel-signup flow refunds FACE ONLY
 * (owner ruling 2026-07-15: the captured fee stays earned), which breaks
 * that proportionality — a fully face-refunded deposit still retains its
 * fee. NULL means "no explicit record" and readers fall back to the
 * historical proration, so legacy rows report exactly as before.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('estimate_deposits', 'refunded_surcharge'))) {
    await knex.schema.alterTable('estimate_deposits', (t) => {
      t.decimal('refunded_surcharge', 10, 2).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('estimate_deposits', 'refunded_surcharge')) {
    await knex.schema.alterTable('estimate_deposits', (t) => {
      t.dropColumn('refunded_surcharge');
    });
  }
};
