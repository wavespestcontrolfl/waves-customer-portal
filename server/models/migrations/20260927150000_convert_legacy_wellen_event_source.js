/**
 * Convert a surviving legacy Wellen Park RSS source.
 *
 * 20260927120000 renamed the dead Wellen Park archive RSS feed to the dated
 * /events/ page, and 20260927140000 seeds the repaired row when absent but
 * skips it while the legacy RSS row exists. If that legacy row survives
 * (restored or re-inserted after 20260927120000 ran), knex never re-runs the
 * repair, so convert it here: rename it to the events page when no repaired
 * row exists, otherwise disable it so the dead RSS feed stops pulling.
 */

const WELLEN_OLD_FEED_URL = 'https://wellenpark.com/events/feed/';
const WELLEN_NEW_FEED_URL = 'https://wellenpark.com/events/';
const WELLEN_SCRAPE_CONFIG = JSON.stringify({ contentSelector: 'section.featured-events-slider', maxHtmlChars: 40000 });

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  const legacy = await knex('event_sources').where({ feed_url: WELLEN_OLD_FEED_URL }).first('id');
  if (!legacy) return;

  const repaired = await knex('event_sources').where({ feed_url: WELLEN_NEW_FEED_URL }).first('id');
  if (repaired) {
    await knex('event_sources').where({ id: legacy.id })
      .update({ enabled: false, updated_at: knex.fn.now() });
    return;
  }
  await knex.raw(
    `UPDATE event_sources
     SET feed_url = ?, feed_type = 'scrape',
         scrape_config = COALESCE(scrape_config, '{}'::jsonb) || ?::jsonb,
         consecutive_failures = 0, consecutive_zero_yields = 0, last_error = NULL,
         updated_at = now()
     WHERE id = ?`,
    [WELLEN_NEW_FEED_URL, WELLEN_SCRAPE_CONFIG, legacy.id],
  );
};

// Documented no-op (waves-db data-correction rule): up() does not record the
// prior state, and restoring a dead RSS feed has no value.
exports.down = async function down() {};
