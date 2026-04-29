/**
 * Close the scheduled_services tracking-token forward leak and TZ
 * inconsistency from 20260422000009.
 *
 * Three changes, all schema-layer so no application code has to remember
 * to call into a token-generation helper:
 *
 *   1. Mopup any NULL track_view_token rows for today/future
 *      customer-linked services that slipped through paths inserted
 *      between 20260422000009 and now (none of the 8 INSERT callsites
 *      under server/ generate a token explicitly; the comment in
 *      slot-reservation.js claiming a DB default existed was wrong).
 *   2. Add a column DEFAULT so every future insert auto-generates a
 *      token. Closes the forward leak with zero callsite changes.
 *   3. DROP and re-add track_token_expires_at as a GENERATED ALWAYS
 *      STORED column with a TZ-correct expression. The previous
 *      timestamptz cast in the original 20260422000009 backfill
 *      interpreted (scheduled_date + window_end) as the session
 *      timezone (UTC on Railway), shifting expiry 4-5h late. The
 *      generated column anchors the computation to America/New_York
 *      explicitly and removes any opportunity for an application path
 *      to compute it differently.
 *
 * Side effect worth flagging in the commit message: existing
 * track_token_expires_at values get recomputed by the GENERATED
 * expression on column add. Rows whose expiry was set by the buggy
 * timestamptz cast will shift 4-5h. For tracking links this is a fix,
 * not a regression — the new value is the one we always intended.
 */

exports.up = async function up(knex) {
  // 1. Mopup. Mirrors the original 20260422000009 backfill scope but
  // adds the customer_id IS NOT NULL filter — open availability slots
  // and draft holds don't surface a customer-facing /track link.
  await knex.raw(`
    UPDATE scheduled_services
       SET track_view_token = encode(gen_random_bytes(32), 'hex')
     WHERE track_view_token IS NULL
       AND scheduled_date >= CURRENT_DATE
       AND customer_id IS NOT NULL
  `);

  // 2. Forward-leak fix. Every new row gets a token via column DEFAULT;
  // no INSERT callsite has to remember to set it.
  await knex.raw(`
    ALTER TABLE scheduled_services
      ALTER COLUMN track_view_token
      SET DEFAULT encode(gen_random_bytes(32), 'hex')
  `);

  // 3. TZ-correct expiry as a GENERATED column. Drop+re-add since the
  // existing column is non-generated. No application data lost — expiry
  // is fully derivable from scheduled_date + window_end, which the row
  // already has. Generated column auto-recomputes on row update if the
  // service date or window changes.
  await knex.raw('ALTER TABLE scheduled_services DROP COLUMN track_token_expires_at');
  await knex.raw(`
    ALTER TABLE scheduled_services
      ADD COLUMN track_token_expires_at TIMESTAMPTZ
      GENERATED ALWAYS AS (
        ((scheduled_date::timestamp + COALESCE(window_end, TIME '23:59:59'))
         AT TIME ZONE 'America/New_York')
        + INTERVAL '1 day'
      ) STORED
  `);
};

exports.down = async function down() {
  // Schema improvements; not undoing. The DEFAULT and GENERATED column
  // are strictly better behavior; reverting would re-introduce the
  // forward leak and TZ inconsistency this migration fixed.
};
