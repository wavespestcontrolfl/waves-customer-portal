// estimate_id for setup_fee_claims (codex #3591 r70 P1): the accept-side
// mints (standard, invoice-mode, estimate-accept prepay) can bill the
// rodent bait-station setup BEFORE any series exists — invoice-mode
// commercial acceptance never auto-schedules — so their claim is anchor-less
// and, until now, findable only through an annual_prepay_terms row. A
// later booking from that accepted estimate could not see the invoice-mode
// claim and stamped the same setup onto the new series (one collected by
// the invoice, another by the first completion). The claim now carries the
// estimate it was billed for; NULL for direct-series mints. No backfill.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('setup_fee_claims'))) return;
  if (!(await knex.schema.hasColumn('setup_fee_claims', 'estimate_id'))) {
    await knex.schema.alterTable('setup_fee_claims', (t) => {
      t.uuid('estimate_id').nullable()
        .references('id').inTable('estimates').onDelete('SET NULL');
      t.index(['estimate_id'], 'idx_setup_fee_claims_estimate_id');
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('setup_fee_claims'))) return;
  if (await knex.schema.hasColumn('setup_fee_claims', 'estimate_id')) {
    await knex.schema.alterTable('setup_fee_claims', (t) => {
      t.dropIndex(['estimate_id'], 'idx_setup_fee_claims_estimate_id');
      t.dropColumn('estimate_id');
    });
  }
};
