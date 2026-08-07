/**
 * Backfill appointment_reminders.service_type for rows that inherited the
 * estimate's raw service_interest category instead of the accepted service
 * name (canonicalServiceTypeForProfile fall-through — e.g. "Termite" for an
 * accepted Pre-Slab Termiticide Treatment, which the 72h reminder rendered
 * as "Your Termite is this Monday").
 *
 * Scope: future, non-cancelled reminders whose stored label exactly equals
 * the source estimate's service_interest (or the 'Estimate service' default)
 * and whose scheduled_service notes carry a single-service "Accepted service
 * mix: X." line. Mapped canonical labels ("Quarterly Pest Control") and
 * multi-service mixes are untouched — the same rule the runtime helper
 * (estimateBackedServiceName in services/appointment-reminders.js) applies
 * to new registrations. Verified against prod 2026-08-07: matches exactly 1
 * row (a 2026-08-10 Pre-Slab visit whose 24h reminder had not yet sent).
 */

const SERVICE_MIX_NOTE_RE = /(?:^|\n)Accepted service mix:[ \t]*([^\n]+?)\.?[ \t]*(?:\n|$)/;

function acceptedMixServiceName(notes) {
  const match = SERVICE_MIX_NOTE_RE.exec(String(notes || ''));
  if (!match) return null;
  const cleaned = match[1]
    .replace(/\b\d+x\s+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned || /[&+,]/.test(cleaned)) return null;
  if (cleaned.length > 100) return `${cleaned.slice(0, 97).trimEnd()}...`;
  return cleaned;
}

exports.up = async function up(knex) {
  const hasReminders = await knex.schema.hasTable('appointment_reminders');
  const hasServices = await knex.schema.hasTable('scheduled_services');
  const hasEstimates = await knex.schema.hasTable('estimates');
  if (!hasReminders || !hasServices || !hasEstimates) return;

  const rows = await knex('appointment_reminders as ar')
    .join('scheduled_services as s', 's.id', 'ar.scheduled_service_id')
    .join('estimates as e', 'e.id', 's.source_estimate_id')
    .where('ar.cancelled', false)
    .where('ar.appointment_time', '>', knex.fn.now())
    .where('s.notes', 'like', '%Accepted service mix:%')
    .select('ar.id', 'ar.service_type', 's.notes', 'e.service_interest');

  for (const row of rows) {
    const stored = String(row.service_type || '').trim();
    const interest = String(row.service_interest || '').trim();
    if (!stored) continue;
    if (stored !== interest && stored !== 'Estimate service') continue;
    const next = acceptedMixServiceName(row.notes);
    if (!next || next === stored) continue;
    await knex('appointment_reminders')
      .where({ id: row.id })
      .update({ service_type: next, updated_at: knex.fn.now() });
  }
};

// Data backfill of a display label whose prior values are the bug being
// fixed — restoring them would re-break pending reminder SMS, so down is a
// deliberate no-op.
exports.down = async function down() {};
