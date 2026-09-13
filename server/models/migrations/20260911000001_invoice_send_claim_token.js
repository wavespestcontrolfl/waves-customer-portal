// Closes the recurring claim-token class (Codex #4131 rounds 15/16/18):
// processScheduledSends' own preclaim restore used to match on the exact
// updated_at its status flip wrote — an optimistic-concurrency token that
// ANY later writer on the row (account-credit application, an email
// delivery stamp, anything else that touches invoices mid-claim) silently
// invalidates just by updating an unrelated column. A partial credit apply
// that leaves both delivery channels failing is round 18's example: the
// restore then matches zero rows and the invoice is stranded 'sending' for
// the 10-minute stale-claim sweep instead of retrying.
//
// send_claim_token is a dedicated, single-purpose identity for "this exact
// preclaim episode" — set once when the row flips to 'sending' and matched
// (never re-derived from updated_at) when giving the claim back. No other
// writer in the codebase reads or writes this column, so no future one can
// invalidate the match by accident.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (await knex.schema.hasColumn('invoices', 'send_claim_token')) return;
  await knex.schema.alterTable('invoices', (table) => {
    table.uuid('send_claim_token').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'send_claim_token'))) return;
  await knex.schema.alterTable('invoices', (table) => table.dropColumn('send_claim_token'));
};
