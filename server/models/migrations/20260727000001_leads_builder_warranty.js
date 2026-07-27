/**
 * Builder termite warranty capture on leads (owner 2026-07-26).
 *
 * New-construction homes in this market come with a builder-provided termite
 * warranty (the pre-construction treat company's coverage, typically a year,
 * renewable). When it lapses the homeowner shops for a replacement — that is
 * the moment a Waves termite program (bait + bond, purchase or rental) wins
 * the house. These two columns let a lead carry that signal so the
 * dashboard's builder_warranty_expiring alert can surface the pitch window
 * instead of Adam holding expiry dates in his head.
 *
 *   builder_warranty_provider   — who holds the coverage today. Data field:
 *                                 competitor names live HERE, never in code
 *                                 identifiers or customer-facing copy.
 *   builder_warranty_expires_on — DATE on the ET business calendar (same
 *                                 convention as termite_bonds.renews_at:
 *                                 compare against ET date strings, never
 *                                 UTC ISO slices).
 *
 * Named builder_warranty_* deliberately: `warranty_expiration` already means
 * fleet equipment (20260401000097) and `takeover` already means stale-claim
 * locks (20260719200000) — neither vocabulary is borrowed.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('leads'))) return;
  if (await knex.schema.hasColumn('leads', 'builder_warranty_expires_on')) return;

  await knex.schema.alterTable('leads', (t) => {
    t.string('builder_warranty_provider', 80);
    t.date('builder_warranty_expires_on');
  });
  // Partial index: the alert query is "which OPEN leads have an expiry in the
  // window" — the null-expiry majority never qualifies.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_leads_builder_warranty_expires ON leads(builder_warranty_expires_on) WHERE builder_warranty_expires_on IS NOT NULL'
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('leads'))) return;
  if (!(await knex.schema.hasColumn('leads', 'builder_warranty_expires_on'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_leads_builder_warranty_expires');
  await knex.schema.alterTable('leads', (t) => {
    t.dropColumn('builder_warranty_provider');
    t.dropColumn('builder_warranty_expires_on');
  });
};
