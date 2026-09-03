/**
 * Backlink Manager v2 — step 4b follow-up: who rejected the domain.
 *
 * `seo_link_domains.rejected_by` ('owner' | 'bridge' | NULL). The registry
 * Reject action stamps 'owner'; the authority bridge stamps 'bridge' when its
 * §3.1 aggregate rejects (every blocking decision DENY). The bridge lifts ONLY
 * its own rejection once the inputs improve — the owner's ruling stands until
 * Reopen / Watch (which clear the marker) or an "Acquire anyway" waiver.
 * Additive and reversible.
 */
const TABLE = 'seo_link_domains';
const COL = 'rejected_by';
const CHECK = 'seo_link_domains_rejected_by_check';
const REJECTED_BY = ['owner', 'bridge'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(TABLE, COL))) {
    await knex.schema.alterTable(TABLE, (t) => { t.string(COL); });
    await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (${COL} IS NULL OR ${COL} IN (${REJECTED_BY.map((v) => `'${v}'`).join(', ')}))`);
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn(TABLE, COL)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COL); });
  }
};
