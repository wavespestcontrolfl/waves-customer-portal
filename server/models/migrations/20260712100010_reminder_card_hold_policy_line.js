/**
 * Card-on-file spec Phase 1 (docs/card-on-file-booking-build-spec.md):
 * appointment reminders for card-hold bookings must state the fee policy —
 * free-reschedule cutoff + fee amount — as dispute evidence as much as UX.
 *
 * Data-only: appends the {card_hold_policy_line} placeholder to the
 * reminder_72h and reminder_24h template BODIES (before any trailing
 * "— Waves" signature so the clause reads inside the message, else at the
 * end). The clause itself is code-built from the FROZEN hold row
 * (estimate-card-holds.cardHoldReminderLine) and resolves to '' for
 * non-card-hold bookings, so existing reminders render byte-identical —
 * the placeholder never survives to trip getTemplate's unresolved-
 * placeholder suppression because every render site passes the variable
 * (appointment-reminders 72h/24h + twilio.js sendServiceReminder).
 *
 * Idempotent both ways: up skips rows already carrying the placeholder;
 * down strips it. Owner-customized bodies are preserved — this only
 * appends/removes the placeholder token. The `variables` JSON list is
 * updated for the admin template editor's reference.
 */

const KEYS = ['reminder_72h', 'reminder_24h'];
const PLACEHOLDER = '{card_hold_policy_line}';
const VAR_NAME = 'card_hold_policy_line';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const key of KEYS) {
    const row = await knex('sms_templates').where({ template_key: key }).first();
    if (!row || typeof row.body !== 'string' || row.body.includes(PLACEHOLDER)) continue;
    let body;
    const signatureIdx = row.body.lastIndexOf('\n\n— Waves');
    const inlineSignatureIdx = signatureIdx >= 0 ? signatureIdx : row.body.lastIndexOf(' — Waves');
    if (inlineSignatureIdx >= 0) {
      body = `${row.body.slice(0, inlineSignatureIdx)}${PLACEHOLDER}${row.body.slice(inlineSignatureIdx)}`;
    } else {
      body = `${row.body}${PLACEHOLDER}`;
    }
    const update = { body, updated_at: knex.fn.now() };
    // Keep the admin editor's variable list accurate (column-guarded shape:
    // stored as a JSON string array by the seed migrations).
    try {
      const vars = typeof row.variables === 'string' ? JSON.parse(row.variables) : row.variables;
      if (Array.isArray(vars) && !vars.includes(VAR_NAME)) {
        update.variables = JSON.stringify([...vars, VAR_NAME]);
      }
    } catch { /* leave variables untouched on unparseable shapes */ }
    await knex('sms_templates').where({ id: row.id }).update(update);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const key of KEYS) {
    const row = await knex('sms_templates').where({ template_key: key }).first();
    if (!row || typeof row.body !== 'string' || !row.body.includes(PLACEHOLDER)) continue;
    const update = { body: row.body.split(PLACEHOLDER).join(''), updated_at: knex.fn.now() };
    try {
      const vars = typeof row.variables === 'string' ? JSON.parse(row.variables) : row.variables;
      if (Array.isArray(vars) && vars.includes(VAR_NAME)) {
        update.variables = JSON.stringify(vars.filter((v) => v !== VAR_NAME));
      }
    } catch { /* leave variables untouched */ }
    await knex('sms_templates').where({ id: row.id }).update(update);
  }
};
