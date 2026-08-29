/**
 * leads.service_key — the catalog product a website lead chose, as an
 * identity, not prose (quote-to-estimate alignment C2, owner rulings
 * 2026-08-29). service_interest stays the human-readable snapshot
 * ("WDO Inspection Service"); legacy leads simply carry NULL. Nullable,
 * additive, inert to older code.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('leads'))) return;
  if (!(await knex.schema.hasColumn('leads', 'service_key'))) {
    await knex.schema.alterTable('leads', (t) => {
      t.string('service_key', 80).nullable();
      t.index(['service_key'], 'leads_service_key_idx');
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('leads'))) return;
  if (await knex.schema.hasColumn('leads', 'service_key')) {
    await knex.schema.alterTable('leads', (t) => {
      t.dropIndex(['service_key'], 'leads_service_key_idx');
      t.dropColumn('service_key');
    });
  }
};
