/**
 * Seed City of Clearwater and Wellen Park event sources when absent.
 *
 * 20260927120000_event_source_repairs_20260927 repairs both sources by
 * feed_url, but no earlier migration ever inserts them (prod's rows were
 * added by hand), so on a database built only from migrations that repair
 * matched zero rows. This inserts each in its repaired shape when missing.
 * onConflict('feed_url').ignore() leaves an existing operator-managed row
 * untouched, and Wellen Park is skipped while its pre-repair RSS row still
 * exists so a later run of the repair can rename it without a duplicate.
 */

const SOURCES = [
  {
    name: 'City of Clearwater — Events',
    url: 'https://www.myclearwater.com/Events-and-Meetings',
    feed_url: 'https://www.myclearwater.com/Events-and-Meetings',
    feed_type: 'scrape',
    coverage_geo: '{clearwater,pinellas}',
    priority_tier: 2,
    enabled: true,
    scrape_config: JSON.stringify({ contentSelector: '.events-list-container', maxHtmlChars: 30000 }),
  },
  {
    name: 'Wellen Park — Events',
    url: 'https://wellenpark.com/events/',
    feed_url: 'https://wellenpark.com/events/',
    feed_type: 'scrape',
    coverage_geo: '{wellen-park,north-port,venice}',
    priority_tier: 2,
    enabled: true,
    scrape_config: JSON.stringify({ contentSelector: 'section.featured-events-slider', maxHtmlChars: 40000 }),
  },
];

const WELLEN_OLD_FEED_URL = 'https://wellenpark.com/events/feed/';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  const oldWellen = await knex('event_sources').where({ feed_url: WELLEN_OLD_FEED_URL }).first('id');
  const rows = SOURCES.filter((s) => !(oldWellen && s.feed_url === 'https://wellenpark.com/events/'));
  if (rows.length) await knex('event_sources').insert(rows).onConflict('feed_url').ignore();
};

// Documented no-op (waves-db seed rollback rule): up() cannot tell whether a
// row predates it, and deleting a source cascades into events_raw history.
exports.down = async function down() {};
