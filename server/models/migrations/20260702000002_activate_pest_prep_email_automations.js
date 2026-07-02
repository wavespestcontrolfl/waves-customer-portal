/**
 * Activate the prep.bed_bug / prep.cockroach email template automations and
 * harden their exit conditions.
 *
 * Both were seeded as draft in 20260518000001 while nothing emitted the
 * appointment.booked trigger. The appointment tagger now emits that trigger
 * for cockroach / bed bug bookings, so flip the two automations live.
 *
 * Exit conditions gain appointment.closed (completed / cancelled /
 * rescheduled / skipped / no_show, mirroring ASSIGNMENT_TERMINAL_STATUSES)
 * and appointment.past, so a run queued at booking is re-checked against the
 * live appointment at send time and never delivers prep guidance after (or
 * for) a dead visit.
 *
 * Preserves operator edits: status only changes when still draft, and
 * stop_if values are merged into the existing exit_conditions rather than
 * overwritten.
 */

const AUTOMATION_KEYS = ['prep.bed_bug', 'prep.cockroach'];
const REQUIRED_STOP_IF = ['appointment.cancelled', 'appointment.closed', 'appointment.past'];

exports.AUTOMATION_KEYS = AUTOMATION_KEYS;
exports.REQUIRED_STOP_IF = REQUIRED_STOP_IF;

function parseExitConditions(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_template_automations'))) return;

  const rows = await knex('email_template_automations')
    .whereIn('automation_key', AUTOMATION_KEYS);

  for (const row of rows) {
    const updates = {};
    if (row.status === 'draft') updates.status = 'active';

    const exit = parseExitConditions(row.exit_conditions);
    const stopIf = Array.isArray(exit.stop_if) ? exit.stop_if : [];
    const merged = [...new Set([...stopIf, ...REQUIRED_STOP_IF])];
    if (merged.length !== stopIf.length) {
      updates.exit_conditions = JSON.stringify({ ...exit, stop_if: merged });
    }

    if (Object.keys(updates).length) {
      await knex('email_template_automations')
        .where({ automation_key: row.automation_key })
        .update({ ...updates, updated_at: knex.fn.now() });
    }
  }
};

exports.down = async function down() {
  // Intentionally no-op. Rows may have been active (or carried operator-set
  // exit conditions) before this migration ran, so a blanket active -> draft
  // rewrite could disable automations this migration never touched.
};
