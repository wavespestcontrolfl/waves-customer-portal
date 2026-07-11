/**
 * Disable the Bradenton Area CVB event source.
 *
 * The source was repointed (20260611000015) at the generic WP REST CPT
 * endpoint /wp-json/wp/v2/event, but that payload carries only post
 * publish/modified timestamps — no event start dates — so the extraction
 * correctly drops every item: 9 consecutive "successful" pulls with 0
 * events, nagging the source-health alert. The public /events/ page is
 * JS-rendered with no discoverable data endpoint (verified 2026-07-11),
 * so there is no clean automated path today. Disabling follows the same
 * mechanism as the 20260611000015 / 20260622000001 repair passes.
 */
const CVB_FEED_URL = 'https://www.bradentongulfislands.com/wp-json/wp/v2/event?per_page=100';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  await knex('event_sources')
    .where({ feed_url: CVB_FEED_URL })
    .update({ enabled: false, updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  await knex('event_sources')
    .where({ feed_url: CVB_FEED_URL })
    .update({ enabled: true, updated_at: knex.fn.now() });
};
