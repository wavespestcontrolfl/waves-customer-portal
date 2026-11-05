/**
 * Rescheduled text links the self-serve reschedule page (owner 2026-11-04:
 * "for texts that say need a different time, shouldnt we be linking the
 * reschedule links for sms templates").
 *
 * appointment_rescheduled ended "Need a different time? Reply here." with no
 * link, while the 72h reminder carries "Reschedule here: <link>" and the
 * booking confirmation and 24h reminder link the appointment page. Both
 * senders (admin-schedule sendRescheduleNoticeForVisit, appointment-reminders
 * handleReschedule) now pass {different_time_line} from reschedule-link.js
 * rescheduledTextLine: "Need a different time? Reschedule here: <link>" when
 * a link can be made, else the old "Need a different time? Reply here.".
 *
 * Exact-body CAS on sms_templates and sms_template_variants, same contract as
 * 20260928070000: a body an administrator has edited is left alone. The base
 * row gains 'different_time_line' in its variables list whatever its body, so
 * an edited template can adopt it without the editor's "unknown placeholder"
 * refusal (the gap 20260928131000 had to close for {window}).
 *
 * Ships one release after the senders (step 1 of 2). Railway runs
 * migrations as the pre-deploy step while the previous release still
 * serves; that release already fills {different_time_line}, so no live
 * release renders this body with the placeholder unresolved (getTemplate
 * would refuse the text).
 */
const KEY = 'appointment_rescheduled';
const VARIABLE = 'different_time_line';
const BEFORE = 'Hi {first_name}, your {service_type} with Waves is now {day}, {date}, {window}.\n\nNeed a different time? Reply here.';
const AFTER = 'Hi {first_name}, your {service_type} with Waves is now {day}, {date}, {window}.\n\n{different_time_line}';

const MIGRATION = '20261105010000_rescheduled_text_reschedule_link';

function withVariable(variables) {
  let list = variables;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return variables; }
  }
  if (!Array.isArray(list) || list.includes(VARIABLE)) return variables;
  return JSON.stringify([...list, VARIABLE]);
}

async function swapBodies(knex, table, from, to, hasAudit) {
  const rows = await knex(table).where({ template_key: KEY, body: from }).select('id');
  for (const row of rows) {
    const changed = await knex(table).where({ id: row.id, body: from }).update({ body: to, updated_at: knex.fn.now() });
    if (changed && hasAudit) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system', action: 'sms_template.delivery_copy_updated',
        resource_type: table, resource_id: String(row.id),
        metadata: { migration: MIGRATION, template_key: KEY },
        critical: true, trx: knex,
      });
    }
  }
}

async function swapAll(knex, from, to) {
  const hasAudit = await knex.schema.hasTable('audit_log');
  await swapBodies(knex, 'sms_templates', from, to, hasAudit);
  if (await knex.schema.hasTable('sms_template_variants')) await swapBodies(knex, 'sms_template_variants', from, to, hasAudit);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await swapAll(knex, BEFORE, AFTER);
  if (!(await knex.schema.hasColumn('sms_templates', 'variables'))) return;
  const rows = await knex('sms_templates').where({ template_key: KEY }).select('id', 'variables');
  for (const row of rows) {
    const next = withVariable(row.variables);
    if (next !== row.variables) {
      await knex('sms_templates').where({ id: row.id }).update({ variables: next, updated_at: knex.fn.now() });
    }
  }
};

// Back to the reply line only where the body is still this migration's own
// copy (an edited body stays). The variables entry stays: an unused allowed
// placeholder is harmless, and an edited body may already use it.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await swapAll(knex, AFTER, BEFORE);
};
exports._BEFORE = BEFORE;
exports._AFTER = AFTER;
exports._withVariable = withVariable;
