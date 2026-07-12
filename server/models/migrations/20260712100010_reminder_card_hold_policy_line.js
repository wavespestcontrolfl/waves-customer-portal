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

function appendPlaceholder(body) {
  const blockSignatureIdx = body.lastIndexOf('\n\n— Waves');
  const inlineSignatureIdx = blockSignatureIdx >= 0 ? blockSignatureIdx : body.lastIndexOf(' — Waves');
  if (inlineSignatureIdx >= 0) {
    return `${body.slice(0, inlineSignatureIdx)}${PLACEHOLDER}${body.slice(inlineSignatureIdx)}`;
  }
  return `${body}${PLACEHOLDER}`;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const key of KEYS) {
    const row = await knex('sms_templates').where({ template_key: key }).first();
    if (!row || typeof row.body !== 'string' || row.body.includes(PLACEHOLDER)) continue;
    const update = { body: appendPlaceholder(row.body), updated_at: knex.fn.now() };
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
  // A/B variant bodies render IN PLACE OF the base body (getTemplate prefers
  // variant.body), so an active variant without the placeholder would keep
  // omitting the disclosure for exactly the sends the experiment covers
  // (Codex #2677 round-1). Every variant row gets the same idempotent append
  // — inactive ones too, so promoting one later can't lose the disclosure.
  if (await knex.schema.hasTable('sms_template_variants')) {
    const variants = await knex('sms_template_variants').whereIn('template_key', KEYS);
    for (const v of variants) {
      if (typeof v.body !== 'string' || v.body.includes(PLACEHOLDER)) continue;
      await knex('sms_template_variants').where({ id: v.id })
        .update({ body: appendPlaceholder(v.body), updated_at: knex.fn.now() });
    }
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
  if (await knex.schema.hasTable('sms_template_variants')) {
    const variants = await knex('sms_template_variants').whereIn('template_key', KEYS);
    for (const v of variants) {
      if (typeof v.body !== 'string' || !v.body.includes(PLACEHOLDER)) continue;
      await knex('sms_template_variants').where({ id: v.id })
        .update({ body: v.body.split(PLACEHOLDER).join(''), updated_at: knex.fn.now() });
    }
  }
};
