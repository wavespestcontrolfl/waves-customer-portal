/**
 * Remove the seeded "Yelp — write a review" row from the link library
 * (owner ruling 2026-09-29: review requests are neutral — Google only, no
 * selective or platform-shopping solicitation). Matches on url, so a row an
 * operator renamed still goes and no other link is touched. The Facebook and
 * app/social rows are out of scope.
 *
 * down() re-inserts the row exactly as 20260831000001_link_library seeded it
 * (idempotent on the unique url index).
 */
const YELP_ROW = {
  name: 'Yelp — write a review',
  url: 'https://www.yelp.com/writeareview/biz/waves-pest-control-bradenton-6',
  clause: 'Review us on Yelp here',
  category: 'reviews',
  keywords: 'yelp review write stars',
  source: 'manual',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('link_library'))) return;
  await knex('link_library').where({ url: YELP_ROW.url }).del();
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('link_library'))) return;
  await knex('link_library').insert(YELP_ROW).onConflict('url').ignore();
};

exports.YELP_ROW = YELP_ROW;
