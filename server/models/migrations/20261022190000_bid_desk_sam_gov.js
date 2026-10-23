/**
 * Bid Desk, PR 2 (GATE_BID_DESK_SAM, dark): federal bids read from the official SAM.gov Opportunities API.
 *
 * bid_opportunities.source gains 'sam_gov'.
 * bid_opportunities.external_id   the SAM.gov noticeId; (source, external_id) is unique, so a re-read changes nothing
 * bid_opportunities.external_url  the notice's public SAM.gov page, shown on the Bid Desk page
 *
 * down() removes only what up() added (any sam_gov rows are deleted first, so the old source check holds).
 */
const BIDS = 'bid_opportunities';
const OLD_SOURCES = ['buildingconnected', 'procore', 'gov_email', 'email_subject', 'manual'];
const NEW_SOURCES = [...OLD_SOURCES, 'sam_gov'];
const list = (values) => values.map((value) => `'${value}'`).join(', ');

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE ${BIDS} DROP CONSTRAINT IF EXISTS bid_opportunities_source_check`);
  await knex.raw(`ALTER TABLE ${BIDS} ADD CONSTRAINT bid_opportunities_source_check CHECK (source IN (${list(NEW_SOURCES)}))`);
  if (!(await knex.schema.hasColumn(BIDS, 'external_id'))) {
    await knex.schema.alterTable(BIDS, (t) => {
      t.text('external_id').nullable();
      t.text('external_url').nullable();
    });
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS bid_opportunities_external ON ${BIDS} (source, external_id) WHERE external_id IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS bid_opportunities_external`);
  await knex(BIDS).where({ source: 'sam_gov' }).del();
  if (await knex.schema.hasColumn(BIDS, 'external_id')) {
    await knex.schema.alterTable(BIDS, (t) => {
      t.dropColumn('external_id');
      t.dropColumn('external_url');
    });
  }
  await knex.raw(`ALTER TABLE ${BIDS} DROP CONSTRAINT IF EXISTS bid_opportunities_source_check`);
  await knex.raw(`ALTER TABLE ${BIDS} ADD CONSTRAINT bid_opportunities_source_check CHECK (source IN (${list(OLD_SOURCES)}))`);
};
