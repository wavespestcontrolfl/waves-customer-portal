/**
 * Guard the Wellen Park feed_url rename in 20260927120000.
 *
 * That repair renames the legacy archive RSS row
 * (https://wellenpark.com/events/feed/) to the dated events page
 * (https://wellenpark.com/events/). When a database already holds BOTH
 * URLs, the rename violates event_sources.feed_url's unique constraint and
 * aborts the migration batch. The repair file is frozen (already pushed and
 * run on the preview database), so this file is stamped just before it and
 * runs first wherever the batch is still pending: when both rows exist, the
 * legacy row moves aside to a unique marker URL and is disabled, keeping its
 * id and every events_raw row that references it. The repair's rename then
 * matches nothing and the existing destination row stays authoritative.
 * Anywhere 20260927120000 already ran, this is a no-op (no legacy row, or
 * no destination row).
 */

const WELLEN_OLD_FEED_URL = 'https://wellenpark.com/events/feed/';
const WELLEN_NEW_FEED_URL = 'https://wellenpark.com/events/';
const LEGACY_MARKER_URL = 'https://wellenpark.com/events/feed/#legacy-disabled-20260927';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  const legacy = await knex('event_sources').where({ feed_url: WELLEN_OLD_FEED_URL }).first('id');
  const destination = await knex('event_sources').where({ feed_url: WELLEN_NEW_FEED_URL }).first('id');
  if (!legacy || !destination) return;

  await knex('event_sources').where({ id: legacy.id }).update({
    feed_url: LEGACY_MARKER_URL,
    enabled: false,
    updated_at: knex.fn.now(),
  });
};

// Documented no-op (waves-db data-correction rule): restoring the legacy URL
// would recreate the unique-constraint collision this guard exists to avoid.
exports.down = async function down() {};
