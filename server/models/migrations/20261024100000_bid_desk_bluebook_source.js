/**
 * Bid Desk: bid_opportunities.source gains 'bluebook' (a contractor's invite through The Blue Book Network's ONETEAM,
 * read from its fixed template).
 *
 * down() files any bluebook rows back under 'email_subject' (what a Blue Book invite was before this change), so the
 * old source check holds and no bid is lost.
 */
const BIDS = 'bid_opportunities';
const OLD_SOURCES = ['buildingconnected', 'procore', 'gov_email', 'email_subject', 'manual', 'sam_gov'];
const NEW_SOURCES = [...OLD_SOURCES, 'bluebook'];
const list = (values) => values.map((value) => `'${value}'`).join(', ');

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE ${BIDS} DROP CONSTRAINT IF EXISTS bid_opportunities_source_check`);
  await knex.raw(`ALTER TABLE ${BIDS} ADD CONSTRAINT bid_opportunities_source_check CHECK (source IN (${list(NEW_SOURCES)}))`);
};

exports.down = async function down(knex) {
  await knex(BIDS).where({ source: 'bluebook' }).update({ source: 'email_subject' });
  await knex.raw(`ALTER TABLE ${BIDS} DROP CONSTRAINT IF EXISTS bid_opportunities_source_check`);
  await knex.raw(`ALTER TABLE ${BIDS} ADD CONSTRAINT bid_opportunities_source_check CHECK (source IN (${list(OLD_SOURCES)}))`);
};
