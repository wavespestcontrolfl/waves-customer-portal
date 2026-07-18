/**
 * Migration — allow 'ai_report' in operator_inbox_items.source
 *
 * The portal "report AI content" route (PR #2542, MS Store policy 11.16)
 * mirrors accepted reports into the operator inbox so they surface on the
 * admin agent hub. The original source CHECK only allowed call/email/sms,
 * so the mirror insert would throw in prod (and be swallowed by its
 * best-effort catch) — extend the constraint.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('operator_inbox_items'))) return;
  await knex.raw(`
    ALTER TABLE operator_inbox_items
      DROP CONSTRAINT IF EXISTS operator_inbox_items_source_check
  `);
  await knex.raw(`
    ALTER TABLE operator_inbox_items
      ADD CONSTRAINT operator_inbox_items_source_check
      CHECK (source IN ('call', 'email', 'sms', 'ai_report'))
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('operator_inbox_items'))) return;
  // ai_report rows are best-effort mirrors (ai_escalations stays the durable
  // record) — remove them so the narrower original constraint can re-apply.
  await knex('operator_inbox_items').where({ source: 'ai_report' }).del();
  await knex.raw(`
    ALTER TABLE operator_inbox_items
      DROP CONSTRAINT IF EXISTS operator_inbox_items_source_check
  `);
  await knex.raw(`
    ALTER TABLE operator_inbox_items
      ADD CONSTRAINT operator_inbox_items_source_check
      CHECK (source IN ('call', 'email', 'sms'))
  `);
};
