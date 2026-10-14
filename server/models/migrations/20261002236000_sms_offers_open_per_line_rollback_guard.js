/**
 * Rollback guard for 20261002235000_sms_offers_open_per_line. That
 * migration's down restores the old one-open-per-(phone, kind) index, which
 * fails once two Waves lines each hold an open offer of one kind. Migrations
 * roll back newest first, so this file's down runs before it and leaves at
 * most one open offer per phone and kind: the latest sent stays open, the
 * others are superseded by it (closed at its send time). Up does nothing.
 */

const TABLE = 'sms_offers';

exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`
    WITH ranked AS (
      SELECT id,
        FIRST_VALUE(id) OVER w AS keep_id,
        FIRST_VALUE(sent_at) OVER w AS keep_sent_at,
        ROW_NUMBER() OVER w AS rn
      FROM ${TABLE}
      WHERE status = 'open'
      WINDOW w AS (PARTITION BY phone_last10, kind ORDER BY sent_at DESC, id DESC)
    )
    UPDATE ${TABLE} o
    SET status = 'superseded', superseded_by = r.keep_id, closed_at = r.keep_sent_at, updated_at = now()
    FROM ranked r
    WHERE o.id = r.id AND r.rn > 1
  `);
};
