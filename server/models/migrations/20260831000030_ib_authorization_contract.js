/**
 * Intelligence Bar authorization contract (W0B, owner rulings 7–9,
 * 2026-08-31): one approval authorizes one exact frozen effect set.
 *
 *   ib_pending_actions.contract      — server-built structured effects
 *                                      (tier, action label, effects[],
 *                                      irreversibility, customer-notify)
 *                                      rendered on the confirm card.
 *   ib_pending_actions.contract_hash — sha256 of that contract; the card
 *                                      echoes it on Confirm and the claim
 *                                      refuses a mismatch, so the operator
 *                                      can only ever approve exactly what
 *                                      was displayed.
 *
 * Idempotent; nullable so pre-existing rows (and legacy clients) keep
 * working — the claim only enforces the hash when the row carries one.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ib_pending_actions'))) return;
  if (!(await knex.schema.hasColumn('ib_pending_actions', 'contract'))) {
    await knex.schema.alterTable('ib_pending_actions', (t) => {
      t.jsonb('contract').nullable();
      t.string('contract_hash', 64).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('ib_pending_actions'))) return;
  if (await knex.schema.hasColumn('ib_pending_actions', 'contract')) {
    await knex.schema.alterTable('ib_pending_actions', (t) => {
      t.dropColumn('contract_hash');
      t.dropColumn('contract');
    });
  }
};
