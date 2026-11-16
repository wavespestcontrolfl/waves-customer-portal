/**
 * Event-source health alert of 2026-11-07 09:03Z ("Event sources unhealthy"):
 * Bay News 9 — On The Town pulls succeed but yield 0 events for 7 runs.
 * Evidence is the prod event_sources, events_raw and llm_dispatch_log rows,
 * read 2026-11-07; the site was not re-probed.
 *
 * DISABLED: Bay News 9 — On The Town (news-mode RSS). The feed is not broken:
 * the 11-07 pull fetched it and sent ~12k tokens of articles to the Claude
 * extraction, which found no dated event. It is a Tampa news feed that rarely
 * carries one. All time it yielded 36 events (about one a week, with quiet
 * gaps of 13 to 40 days), 4 approved, none at the 75-point floor; in the last
 * 60 days 15 events and 0 approved. So the daily paid extraction call buys
 * nothing for the newsletter, and the zero-yield alert re-fires on every
 * normal quiet week. The 2026-09-27 repair left it on as "an ordinary quiet
 * feed"; six more weeks of data say it adds no value.
 *
 * Disabled by exact feed_url, only while still enabled; one audit_log row.
 * Re-enable (operator update by feed_url) if the newsletter later wants
 * Tampa-area news.
 */
const { recordAuditEvent } = require('../../services/audit-log');

// audit_log.action is varchar(96): `migration:<name>:enabled` must fit.
const MIGRATION = '20261107100000_disable_bay_news_9_event_source';

const DISABLE_FEED_URLS = [
  'https://www.baynews9.com/services/contentfeed.fl%7Ctampa%7Con-the-town.hero.rss',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');

  const rows = await knex('event_sources')
    .whereIn('feed_url', DISABLE_FEED_URLS)
    .where({ enabled: true })
    .select('id', 'name', 'feed_url');
  for (const row of rows) {
    const changed = await knex('event_sources')
      .where({ id: row.id, enabled: true })
      .update({ enabled: false, updated_at: knex.fn.now() });
    if (!changed || !canAudit) continue;
    // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:enabled`,
      resource_type: 'event_sources',
      resource_id: String(row.id),
      metadata: {
        migration: MIGRATION, source: row.name, feed_url: row.feed_url, column: 'enabled', before: true, after: false,
      },
      critical: true,
      trx: knex,
    });
  }
};

// Documented no-op (waves-db data-correction rule): up() touches only a row
// that was still enabled, and the audit row keeps its before value, so a
// blanket re-enable could undo an operator's later change.
exports.down = async function down() {};
