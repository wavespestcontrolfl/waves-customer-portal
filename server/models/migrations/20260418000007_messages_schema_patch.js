/**
 * Migration 2026-04-18 #7 — messages column patch (PR 2 prep).
 *
 * Adds three legacy fields the unified `messages` schema didn't model in
 * PR 1 but that the inbox UI consumes:
 *   - is_read       — admin "unread" badge in dashboard inbox + count.
 *                     sms_log had it; messages didn't.
 *   - message_type  — outbound SMS template tag (manual, reminder,
 *                     estimate, review, scheduled, etc.). Used by the
 *                     stats endpoint's GROUP BY breakdown.
 *   - ai_summary    — AI-generated call summary (from call_log.call_summary).
 *                     Distinct from `body` (which holds raw transcript).
 *
 * Indexes are partial / targeted — `is_read` is only ever queried on
 * inbound rows, so the index is partial to keep it small.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('messages', (t) => {
    t.boolean('is_read').defaultTo(false);
    t.string('message_type', 30);
    t.text('ai_summary');
  });

  await knex.raw(`
    CREATE INDEX messages_unread_inbox
      ON messages (channel, created_at DESC)
      WHERE direction = 'inbound' AND (is_read = false OR is_read IS NULL)
  `);
  await knex.raw(`
    CREATE INDEX messages_message_type
      ON messages (message_type)
      WHERE message_type IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS messages_message_type');
  await knex.raw('DROP INDEX IF EXISTS messages_unread_inbox');
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('ai_summary');
    t.dropColumn('message_type');
    t.dropColumn('is_read');
  });
};
