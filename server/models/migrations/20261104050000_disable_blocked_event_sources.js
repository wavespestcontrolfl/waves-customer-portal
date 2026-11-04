/**
 * Event-source health alert of 2026-11-03 09:03Z ("Event sources unhealthy"):
 * three scrape sources fail every pull. Evidence is the prod event_sources
 * and events_raw rows, read 2026-11-04; the sites were not re-probed.
 *
 * DISABLED:
 *   - Sarasota Chamber (business.sarasotachamber.com/community-calendar) and
 *     Venice Area Chamber (business.venicechamber.com/chamber-events): both
 *     GrowthZone sites answer HTTP 403 to every pull since 2026-10-23 (last
 *     success 10-22 on both; 12 and 10 failures in a row). Two chambers on
 *     one platform turning 403 on the same day is a host-side block, not a
 *     config fault, and the owner rule is official feeds only (no UA
 *     spoofing, no bot-wall workaround). Low newsletter value: Venice has 0
 *     approved events of 56 pulled; Sarasota 14 approved of 149, one ever at
 *     the 75-point floor.
 *   - Marie Selby Botanical Gardens (selby.org/events): page.goto fails with
 *     net::ERR_HTTP2_PROTOCOL_ERROR on every pull since 2026-10-31 (last
 *     success 10-30). The connection is reset at navigation, before any
 *     page loads, so no selector or HTML-budget change can help. 19
 *     approved of 89, none ever at the 75-point floor.
 *
 * Disabled by exact feed_url, only while still enabled; one audit_log row per
 * source. Re-enable (operator update by feed_url) once an official feed for
 * the source is verified from the prod network.
 */
const { recordAuditEvent } = require('../../services/audit-log');

// audit_log.action is varchar(96): `migration:<name>:enabled` must fit.
const MIGRATION = '20261104050000_disable_blocked_event_sources';

const DISABLE_FEED_URLS = [
  'https://business.sarasotachamber.com/community-calendar',
  'https://business.venicechamber.com/chamber-events',
  'https://selby.org/events',
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

// Documented no-op (waves-db data-correction rule): up() touches only rows
// that were still enabled, and the audit rows keep each before value, so a
// blanket re-enable could undo an operator's later change.
exports.down = async function down() {};
