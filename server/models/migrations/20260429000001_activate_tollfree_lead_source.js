/**
 * Flip +18559260203 from "AI Agent (unused — not published)" /
 * is_active=false → active toll-free customer line.
 *
 * Background: the original 20260425000003 seed marked this number as a
 * dormant AI-agent placeholder because no repo references existed at
 * the time. Operator confirmed on 2026-04-29 it is in fact the active
 * toll-free customer line (855 area). With is_active=false the row was
 * being filtered out of the Dashboard "Calls by Source" widget
 * (admin-dashboard.js:763), surfacing toll-free calls under
 * "Unmapped — +18559260203" instead of the right label.
 *
 * Idempotent: only updates the row if it exists. Down is a no-op since
 * the original metadata was wrong, not a desired state to restore.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;

  const row = await knex('lead_sources')
    .where({ twilio_phone_number: '+18559260203' })
    .first();

  if (!row) return;

  await knex('lead_sources')
    .where({ id: row.id })
    .update({
      name: 'Toll-Free Customer Line',
      source_type: 'tollfree',
      channel: 'direct',
      is_active: true,
      notes: 'Toll-free 855 number for customer support / chat. Operator-confirmed active 2026-04-29.',
      updated_at: knex.fn.now(),
    });
};

exports.down = async function down() {};
