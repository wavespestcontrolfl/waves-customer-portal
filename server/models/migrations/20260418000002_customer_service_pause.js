/**
 * Add service-pause flags to customers.
 *
 * Set when autopay's 3-retry ladder fully exhausts. Signals "do not continue
 * scheduling service for this customer until someone resolves billing" —
 * Virginia can unset via an admin action when the card gets updated.
 *
 *   service_paused_at     — timestamp when the pause was applied
 *   service_pause_reason  — short human-readable reason (e.g. 'autopay_final_failure')
 *
 * The monthly billing cron also skips customers with service_paused_at set
 * so we don't keep burning retries against a dead card.
 */

const COLUMNS = [
  { name: 'service_paused_at', type: 'timestamp' },
  { name: 'service_pause_reason', type: 'string', args: [60] },
];

exports.up = async function (knex) {
  for (const col of COLUMNS) {
    const has = await knex.schema.hasColumn('customers', col.name);
    if (!has) {
      await knex.schema.alterTable('customers', (t) => {
        if (col.type === 'timestamp') t.timestamp(col.name);
        else if (col.type === 'string') t.string(col.name, ...(col.args || []));
      });
    }
  }
};

exports.down = async function (knex) {
  for (const col of COLUMNS) {
    const has = await knex.schema.hasColumn('customers', col.name);
    if (has) {
      await knex.schema.alterTable('customers', (t) => t.dropColumn(col.name));
    }
  }
};
