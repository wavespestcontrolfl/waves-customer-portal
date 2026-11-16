'use strict';

/**
 * GATE_LAWN_PREVISIT_LINE (owner 2026-11-14): the 24-hour reminder text of a lawn treatment visit carries one fixed lawn sentence
 * (services/lawn-previsit-line.js) in the {lawn_prep_line} placeholder. These are the two rows that carry it, one for each rung of the
 * appointment-page ladder (appointment-reminders.js renderAppointmentPageTemplate): reminder_24h_lawn_v2 (GATE_APPOINTMENT_PAGE on,
 * link-first) and reminder_24h_lawn (the base row). Nothing reads them while the gate is off. A missing, disabled or unrenderable
 * lawn row sends today's reminder_24h rows instead (a customer always gets a message).
 *
 * Seeds each row only when its key is absent, so a re-run, or a row an administrator made or edited first, is never overwritten; each
 * seeded row writes one audit event. Texts say "Waves", never "Waves Pest Control" (owner 2026-11-04); GSM-7 only (straight apostrophes).
 * {card_hold_policy_line} starts with its own blank line, and {appointment_line} ends with one; the render tidy-up collapses the rest.
 *
 * Idempotent. down() leaves the rows (they may carry edits and sends; with the gate off nothing reads them).
 */

const MIGRATION_ID = '20261114120000_lawn_previsit_sms_templates';
const REASON = 'Lawn pre-visit line in the 24-hour reminder (owner 2026-11-14, GATE_LAWN_PREVISIT_LINE)';

const SMS_TEMPLATES = [
  {
    key: 'reminder_24h_lawn_v2',
    name: '24-Hour Reminder - Lawn Visit (Link-First)',
    baseKeys: ['reminder_24h_v2', 'reminder_24h'],
    category: 'service',
    body: 'Hi {first_name}, your Waves {service_type} is tomorrow, {window}.\n\n{lawn_prep_line}\n\n{appointment_line}{card_hold_policy_line}',
    variables: ['first_name', 'service_type', 'window', 'lawn_prep_line', 'appointment_line', 'card_hold_policy_line'],
  },
  {
    key: 'reminder_24h_lawn',
    name: '24-Hour Reminder - Lawn Visit',
    baseKeys: ['reminder_24h'],
    category: 'service',
    body: "Hi {first_name}, your {service_type} with Waves is tomorrow, {window}. We'll text you when your tech is on the way.\n\n{lawn_prep_line}{card_hold_policy_line}",
    variables: ['first_name', 'service_type', 'window', 'lawn_prep_line', 'card_hold_policy_line'],
  },
];

async function seedSms(knex, t) {
  if (await knex('sms_templates').where({ template_key: t.key }).first('id')) return null;
  let base = null;
  for (const key of t.baseKeys) {
    base = await knex('sms_templates').where({ template_key: key }).first('category', 'sort_order');
    if (base) break;
  }
  const row = {
    template_key: t.key,
    name: t.name,
    category: base?.category || t.category,
    body: t.body,
    variables: JSON.stringify(t.variables),
    sort_order: Number.isFinite(Number(base?.sort_order)) ? Number(base.sort_order) + 1 : 99,
    is_active: true,
  };
  const [inserted] = await knex('sms_templates').insert(row).returning(['id', 'body', 'is_active']);
  return inserted || null;
}

async function audit(knex, id, key, body) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action: 'sms_template.seeded', resource_type: 'sms_template', resource_id: String(id), critical: true, trx: knex,
    metadata: { migration: MIGRATION_ID, template_key: key, reason: REASON, changes: { created: { before: null, after: { body, is_active: true } } } },
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  await knex.transaction(async (trx) => {
    for (const t of SMS_TEMPLATES) {
      const row = await seedSms(trx, t);
      if (row && hasAudit) await audit(trx, row.id, t.key, t.body);
    }
  });
};

exports.down = async function down() {
  // The template rows stay (documented no-op: they may carry edits and sends; with the gate off nothing reads them).
};

exports._test = { SMS_TEMPLATES };
