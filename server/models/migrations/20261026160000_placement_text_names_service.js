/**
 * The recurring placement text names the service (owner 2026-10-26).
 *
 * A customer with two series (a quarterly pest visit and a monthly mosquito
 * visit) got "your next Waves visit is Friday, Oct 30, 12:00 PM - 2:00 PM" for
 * her MOSQUITO visit and took it as her PEST visit moving. The owner approved
 * this exact wording on 2026-10-26:
 *
 *   Hi {first_name}, your next Waves {service_name} is {start_date}{window_text}.
 *
 *   You'll get a reminder before each visit.
 *
 * {service_name} is the same customer-facing name the appointment reminders
 * use (appointment-reminders buildServiceLabel). When the visit has no clean
 * name the sender fills in the word "visit", so the text reads as it did
 * before. appointment_series_rescheduled is unchanged on purpose.
 *
 * "before" is the body 20261006220000_sms_template_tighten left. Exact-body
 * CAS on sms_templates and sms_template_variants, same contract as that
 * migration: a row an administrator has edited is left alone. The template's
 * `variables` list is the allowlist the admin editor checks a saved body
 * against, so it gains service_name together with the body (only when the
 * body swap itself applied). down() reverses the swap under the same guard.
 */
const KEY = 'appointment_recurring_placement_confirmed';
const BEFORE = "Hi {first_name}, your next Waves visit is {start_date}{window_text}.\n\nYou'll get a reminder before each visit.";
const AFTER = "Hi {first_name}, your next Waves {service_name} is {start_date}{window_text}.\n\nYou'll get a reminder before each visit.";
const VARIABLE = 'service_name';

const MIGRATION = '20261026160000_placement_text_names_service';

function parseVariables(value) {
  if (Array.isArray(value)) return value.slice();
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  return null;
}

async function swap(knex, from, to, { addVariable }) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  for (const table of tables) {
    const columns = table === 'sms_templates' ? ['id', 'template_key', 'body', 'variables'] : ['id', 'template_key', 'body'];
    const rows = await knex(table).where({ template_key: KEY }).select(columns);
    for (const row of rows) {
      if (row.body !== from) continue; // an admin edit already changed it - leave it alone
      const update = { body: to, updated_at: knex.fn.now() };
      if (table === 'sms_templates') {
        const current = parseVariables(row.variables);
        if (current) {
          const next = addVariable
            ? (current.includes(VARIABLE) ? current : [...current, VARIABLE])
            : current.filter((name) => name !== VARIABLE);
          update.variables = JSON.stringify(next);
        }
      }
      // Exact-body CAS protects an administrator save racing this migration.
      const changed = await knex(table).where({ id: row.id, body: from }).update(update);
      if (changed && hasAudit) {
        const { recordAuditEvent } = require('../../services/audit-log');
        await recordAuditEvent({
          actor_type: 'system', action: 'sms_template.delivery_copy_updated',
          resource_type: table, resource_id: String(row.id),
          metadata: { migration: MIGRATION, template_key: row.template_key },
          critical: true, trx: knex,
        });
      }
    }
  }
}

exports.up = async function up(knex) {
  await swap(knex, BEFORE, AFTER, { addVariable: true });
};

exports.down = async function down(knex) {
  await swap(knex, AFTER, BEFORE, { addVariable: false });
};

exports._KEY = KEY;
exports._BEFORE = BEFORE;
exports._AFTER = AFTER;
