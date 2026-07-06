'use strict';

/**
 * Replace the fake sample phone "(941) 555-0000" with the real support
 * number in email_template_fixtures payloads (owner directive 2026-07-05).
 * Fixtures only power admin previews — customer sends resolve the real
 * constant at send time — but previews must never show a number that
 * doesn't work.
 *
 * Read-modify-write across every fixture row; only rows containing the
 * fake number are touched.
 */

const FAKE = '(941) 555-0000';
const REAL = '(941) 297-5749';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_template_fixtures'))) return;
  const rows = await knex('email_template_fixtures').select('id', 'payload');
  const now = new Date();
  for (const row of rows) {
    const raw = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
    if (!raw || !raw.includes(FAKE)) continue;
    await knex('email_template_fixtures').where({ id: row.id }).update({
      payload: raw.split(FAKE).join(REAL),
      updated_at: now,
    });
  }
};

exports.down = async function down(knex) {
  // No down: restoring a fake phone number serves nothing.
  if (!knex) return;
};
