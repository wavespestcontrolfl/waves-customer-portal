/**
 * Event-source health alert of 2026-11-10 09:03Z ("Event sources unhealthy"):
 * Ringling Museum, 3 consecutive failed pulls, each an HTTP 403 from
 * https://www.ringling.org/events/type/all/. Evidence is the prod
 * event_sources, events_raw and notifications rows, read 2026-11-10; the
 * site was not re-probed.
 *
 * DISABLED: Ringling Museum (scrape). The 403 is the site's Cloudflare bot
 * protection answering the declared bot User-Agent. The 2026-09-27 repair
 * left the source on because the 403s were intermittent: it still pulled on
 * most days, and no alert named it between 2026-07-27 and now. That changed
 * after the last good pull on 2026-11-07: every pull since is a 403, the
 * first 3-in-a-row streak in 15 weeks. Nothing changed on our side (the
 * ingestion code has no commit in that window), so the host tightened its
 * block. The only config that gets past it is a browser User-Agent, which is
 * evasion (owner rule 2026-09-27: official feeds only, never work around a
 * block).
 *
 * Low newsletter value: 184 events all time and one ever at the 75-point
 * floor; in the last 60 days 53 events and 1 approved, the lowest yield of
 * any enabled source that approved anything.
 *
 * Disabled by exact feed_url, only while still enabled; one audit_log row.
 * Re-enable (operator update by feed_url) once an official feed for the
 * museum's calendar is verified from the prod network.
 */
const { recordAuditEvent } = require('../../services/audit-log');

// audit_log.action is varchar(96): `migration:<name>:enabled` must fit.
const MIGRATION = '20261110100000_disable_ringling_event_source';

const DISABLE_FEED_URLS = [
  'https://www.ringling.org/events/type/all/',
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
