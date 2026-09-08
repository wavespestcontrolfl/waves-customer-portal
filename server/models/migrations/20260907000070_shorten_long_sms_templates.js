/**
 * Trim seven long SMS defaults without altering fees, consent, links, gates,
 * or administrator copy. The legacy 24h sender already supplies {window};
 * use that existing two-hour arrival range instead of promising an exact time.
 * Full card-hold disclosures can still require three segments. Never truncate.
 */
const SWAPS = [
  [
    "reminder_72h",
    "Hello {first_name}! Your {service_type} is this {day}, {window}.\n\n{reschedule_line}{card_hold_policy_line}",
    "Hello {first_name}! {service_type}: {day}, {window}.\n\n{reschedule_line}{card_hold_policy_line}"
  ],
  [
    "reminder_24h",
    "Hello {first_name}! Reminder: your {service_type} with Waves is tomorrow at {time}. Your technician will arrive within a two-hour window and text when 15 minutes out.\n\n{reschedule_line}Questions? Reply here.{card_hold_policy_line}",
    "Hello {first_name}! {service_type}: tomorrow, {window}.\n\n{reschedule_line}{card_hold_policy_line}"
  ],
  [
    "reminder_24h_v2",
    "Hello {first_name}! Your {service_type} is tomorrow, {window}.\n\n{appointment_line}{card_hold_policy_line}",
    "Hello {first_name}! {service_type}: tomorrow, {window}.\n\n{appointment_line}{card_hold_policy_line}"
  ],
  [
    "service_complete_with_invoice",
    "Hello {first_name}! Your {service_type} report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}\n\n{past_due_line}",
    "Hello {first_name}! {service_type} report: {portal_url}\n\nInvoice: {pay_url}\n\n{past_due_line}"
  ],
  [
    "service_report_v1_with_invoice",
    "Hello {first_name}! Your {service_type} report is ready: {report_url}\n\nInvoice for today's visit: {pay_url}\n\n{past_due_line}",
    "Hello {first_name}! {service_type} report: {report_url}\n\nInvoice: {pay_url}\n\n{past_due_line}"
  ],
  [
    "secure_appointment_card_plans",
    "Hi {first_name}! To finish booking your {service_type}{date_line}, choose how to pay: prepay the year and save, or pay per application with a card on file.\n\nNothing is charged today unless you prepay: {secure_link}\n\n{cancel_fee_line}We never take card numbers by phone.",
    "Hello {first_name}! {service_type}{date_line}: prepay the year and save, or pay per application by card.\n\n{secure_link}\nNothing is charged today unless you prepay.\n\n{cancel_fee_line}We never take card numbers by phone."
  ],
  [
    "auto_sprinkler_timer",
    "Hello {first_name}! Here's a short guide for running your sprinklers by hand from your Monday watering plan - find the brand on your timer box, tap it, and follow the photos: https://www.wavespestcontrol.com/sprinkler-timers/ Stuck? Reply here with a photo of your timer and we'll point you to the right page. Reply STOP to opt out.",
    "Hello {first_name}! Run your sprinklers by hand for your Monday watering plan: https://www.wavespestcontrol.com/sprinkler-timers/ Tap your timer brand and follow the photos. Stuck? Reply with a timer photo for help. Reply STOP to opt out."
  ]
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  const swaps = new Map(SWAPS.map(([key, before, after]) => [key, { before, after }]));
  for (const table of tables) {
    const rows = await knex(table).whereIn('template_key', [...swaps.keys()]).select('*');
    for (const row of rows) {
      const key = row.template_key;
      const { before, after } = swaps.get(key);
      const updates = row.body === before ? { body: after } : {};
      const match = { id: row.id, body: row.body };
      if (table === 'sms_templates' && key === 'reminder_24h') {
        const variables = typeof row.variables === 'string' ? JSON.parse(row.variables) : row.variables || [];
        // Variants share their parent's variable list. Add the sender's
        // existing window even when the parent has custom wording, so a
        // shortened control variant remains editable in the admin UI.
        if (!variables.includes('window')) {
          updates.variables = JSON.stringify([...new Set([...variables, 'window'])]);
          match.variables = row.variables == null ? null : JSON.stringify(variables);
        }
      }
      if (!Object.keys(updates).length) continue;
      // Exact-body CAS protects an administrator save racing this migration.
      const changed = await knex(table).where(match).update({ ...updates, updated_at: knex.fn.now() });
      if (changed && hasAudit) {
        const { recordAuditEvent } = require('../../services/audit-log');
        await recordAuditEvent({
          actor_type: 'system', action: 'sms_template.delivery_copy_updated',
          resource_type: table, resource_id: String(row.id),
          metadata: { migration: '20260907000070_shorten_long_sms_templates', template_key: key, body_changed: row.body === before },
          critical: true, trx: knex,
        });
      }
    }
  }
};

exports.down = async function down() {
  // Intentionally no-op: reverting seeded copy would erase later admin edits.
};
exports._SWAPS = SWAPS;
