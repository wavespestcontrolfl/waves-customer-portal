/**
 * Per-job explicit self-pay override.
 *
 * The third-party payer resolution order is
 *   scheduled_services.payer_id ?? customers.payer_id ?? self
 * which leaves no way to say "for THIS visit the customer pays directly" on an
 * account that has a default payer — a blank per-job override always inherits
 * the account default (known Phase-1 gap, Codex round 2). Example: a rental
 * whose invoices default to the property manager, but one visit is billed to
 * the occupant.
 *
 * self_pay_override = TRUE pins the visit to self-pay: resolveForInvoice skips
 * the customers.payer_id fallback. A concrete per-job payer_id still wins over
 * the flag (the write path keeps them mutually exclusive), so the flag can
 * never hide an explicitly-routed Bill-To.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'self_pay_override'))) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.boolean('self_pay_override').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (await knex.schema.hasColumn('scheduled_services', 'self_pay_override')) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('self_pay_override');
    });
  }
};
