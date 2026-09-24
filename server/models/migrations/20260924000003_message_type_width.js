// Widen messages.message_type and sms_log.message_type from varchar(30) to
// varchar(64) (call-agent audit 2026-09-23 side finding).
//
// Four live types are longer than 30 characters —
// estimate_accepted_annual_prepay, estimate_accepted_onetime_manual_resend,
// estimate_add_service_request_received, service_resolution_confirmation —
// so recordTouchpoint fails "value too long for type character varying(30)"
// and those texts never reach the conversation thread.
//
// Widening a varchar is a catalog-only change in Postgres (no table rewrite,
// no long lock). No views depend on either column (checked in production
// 2026-09-24). Fires ZERO customer communications.
//
// `down` is a deliberate no-op: narrowing back to 30 fails the moment a
// longer row exists, and the narrow column is the bug being fixed.
const TABLES = ['messages', 'sms_log'];

exports.up = async function up(knex) {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, 'message_type'))) continue;
    await knex.raw('ALTER TABLE ?? ALTER COLUMN message_type TYPE varchar(64)', [table]);
  }
};

exports.down = async function down() {};
