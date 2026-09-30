'use strict';

/**
 * Plan pause restart text moves to its own template key (Codex #5354 r6
 * P1). The pause now skips visits, so the text names the FIRST VISIT BACK,
 * which can be weeks after the return date. During a deploy overlap or a
 * rollback, the previous code still renders plan_hold_resume_reminder with
 * the return date (and, on main, reads it as "Invalid Date"); keeping that
 * key sendable would let it text a new-format pause the wrong date and
 * stamp it as reminded. So:
 *  - plan_hold_restart_first_visit is seeded (guarded insert) with the
 *    {visit_date} body the new sender supplies;
 *  - plan_hold_resume_reminder is deactivated, so an old sender's required
 *    render fails closed (no text, no stamp) instead of sending a wrong
 *    date. A missed text is retried by the new lifecycle; a wrong one is
 *    not recoverable.
 * GSM-7, one segment at long-side lengths.
 */
const NEW_KEY = 'plan_hold_restart_first_visit';
const OLD_KEY = 'plan_hold_resume_reminder';
const BODY = 'Hello {first_name}! Your Waves {service} visits start again on {visit_date}. Want a different date, or to cancel instead? Reply here.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  const existing = await knex('sms_templates').where({ template_key: NEW_KEY }).first('id');
  if (!existing) {
    const row = { template_key: NEW_KEY, name: 'Plan Pause Restart (first visit back)', body: BODY };
    if (cols.category) row.category = 'automations';
    if (cols.variables) row.variables = JSON.stringify(['first_name', 'service', 'visit_date']);
    if (cols.sort_order) row.sort_order = 124;
    if (cols.is_active) row.is_active = true;
    if (cols.created_at) row.created_at = new Date();
    if (cols.updated_at) row.updated_at = new Date();
    await knex('sms_templates').insert(row);
  }
  if (cols.is_active) {
    await knex('sms_templates').where({ template_key: OLD_KEY }).update({ is_active: false, updated_at: knex.fn.now() });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  if (cols.is_active) await knex('sms_templates').where({ template_key: OLD_KEY }).update({ is_active: true, updated_at: knex.fn.now() });
  await knex('sms_templates').where({ template_key: NEW_KEY, body: BODY }).del();
};

exports._copy = { NEW_KEY, OLD_KEY, BODY };
