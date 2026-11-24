'use strict';

/**
 * visit_text_recipients.track_token: the visit-only recipient's OWN map-only tracker credential
 * (owner 2026-11-24, "yes he gets it": the en-route text carries a tracker link).
 *
 * The holder's tracker token (scheduled_services.track_view_token) must never reach the recipient: after the
 * visit it opens the report, the invoice and the cards, and through the report the other visits' links.
 * So the recipient gets a token of their own, minted when their en-route text is built, which resolves to a
 * reduced, map-only view of that one visit (routes/track-public.js). Same shape as track_view_token: 64
 * lowercase hex characters. Nullable: most rows never get an en-route text. Unique so one token names one row.
 * The row goes with its visit (ON DELETE CASCADE), and so does the link.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('visit_text_recipients'))) return;
  await knex.raw('ALTER TABLE visit_text_recipients ADD COLUMN IF NOT EXISTS track_token varchar(64)');
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_visit_text_recipients_track_token
      ON visit_text_recipients (track_token)
      WHERE track_token IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS uq_visit_text_recipients_track_token');
  await knex.raw('ALTER TABLE visit_text_recipients DROP COLUMN IF EXISTS track_token');
};
