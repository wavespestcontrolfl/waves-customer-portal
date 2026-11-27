/**
 * Event-source health alert of 2026-11-27 09:03Z ("Event sources unhealthy"):
 * Clearwater Marine Aquarium — Events, 3 consecutive failed pulls, each
 * "timeout of 15000ms exceeded" on https://www.cmaquarium.org/events/?ical=1.
 * Evidence is the prod event_sources, events_raw and notifications rows, read
 * 2026-11-27; the site was not re-probed.
 *
 * DISABLED: Clearwater Marine Aquarium — Events (ical). The last good pull
 * was 2026-11-24 (5 events); every daily pull since timed out. This is the
 * first alert that ever named the source. Nothing changed on our side: the
 * shared 15 s HTTP timeout serves every feed, and only this host stopped
 * answering inside it.
 *
 * Low newsletter value: 39 events all time, 7 approved, none ever featured.
 * The venue is in Pinellas County, north of the service area.
 *
 * Disabled by exact feed_url, only while still enabled; one audit_log row.
 * Re-enable (operator update by feed_url) once the feed answers again from
 * the prod network.
 */
const { recordAuditEvent } = require('../../services/audit-log');

// audit_log.action is varchar(96): `migration:<name>:enabled` must fit.
const MIGRATION = '20261128090000_disable_clearwater_aquarium_event_source';

const DISABLE_FEED_URLS = [
  'https://www.cmaquarium.org/events/?ical=1',
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
