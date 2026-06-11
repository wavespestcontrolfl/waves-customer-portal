/**
 * Specialty services → Service Report V1: Phase-1b shadow pilot.
 *
 * Flips ONE trend-type key — rodent_trapping — to the typed completion flow
 * at delivery_mode='internal_only': the typed CompletionPanel activates,
 * activity scores persist, follow-up CTA books $0 trap checks, and the V1
 * report renders + stores (token/PDF), but NO customer SMS/email goes out.
 * This proves the trend machinery (gauge, visit sequence, trend words,
 * progress framing, included follow-ups) on a controlled surface before
 * Phase 2 flips the broad trend batch (contract §Phase-1b; plan rev 3.1).
 *
 * Scope is deliberately the single core key: trap checks booked through the
 * completion CTA clone the source visit's service, so the whole visit chain
 * stays on rodent_trapping. Sibling keys (rodent_trapping_followup,
 * rodent_inspection, sanitation/exclusion variants) stay project_required
 * until Phase 2.
 *
 * Graduation to customer sends = a later one-line flip to auto_send after
 * the shadow reports are owner-approved. Rollback = knex down (restores
 * project_required + auto_send exactly).
 */

const KEY = 'rodent_trapping';
const PROJECT_TYPE = 'rodent_trapping';

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('service_completion_profiles');
  if (!hasTable) throw new Error('service_completion_profiles table missing — shadow cutover cannot run');

  const count = await knex('service_completion_profiles')
    .where({
      service_key: KEY,
      project_type: PROJECT_TYPE,
      completion_mode: 'project_required',
      active: true,
    })
    .update({
      completion_mode: 'service_report',
      delivery_mode: 'internal_only',
      updated_at: knex.fn.now(),
    });
  if (count !== 1) {
    throw new Error(
      `[phase1b-shadow] expected exactly 1 active project_required row for ${KEY}, ` +
      `matched ${count} — aborting, nothing flipped`,
    );
  }
  console.log(`[phase1b-shadow] ${KEY} flipped to service_report + internal_only (no customer sends)`);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('service_completion_profiles');
  if (!hasTable) return;

  await knex('service_completion_profiles')
    .where({ service_key: KEY, project_type: PROJECT_TYPE, completion_mode: 'service_report' })
    .update({
      completion_mode: 'project_required',
      delivery_mode: 'auto_send',
      updated_at: knex.fn.now(),
    });
  console.log(`[phase1b-shadow] rolled back — ${KEY} restored to project_required/auto_send`);
};
