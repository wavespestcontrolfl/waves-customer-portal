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
 * Per-key resolution follows the self-healed 20260611000012 pattern —
 * environment catalogs are admin-mutable, so no fixed-count assertion:
 * flip / already / heal (insert when the services row exists) / absent
 * (loud skip) / throw on unexpected mode or pointer.
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

  const row = await knex('service_completion_profiles')
    .where({ service_key: KEY })
    .first();

  if (row && !row.active) {
    console.warn(`[phase1b-shadow] ${KEY}: profile row is INACTIVE in this environment — skipping (runtime ignores inactive rows)`);
    return;
  }

  if (row && row.completion_mode === 'service_report' && row.project_type === PROJECT_TYPE) {
    if (row.delivery_mode !== 'internal_only') {
      await knex('service_completion_profiles')
        .where({ service_key: KEY })
        .update({ delivery_mode: 'internal_only', updated_at: knex.fn.now() });
    }
    console.log(`[phase1b-shadow] ${KEY}: already service_report — delivery_mode ensured internal_only`);
    return;
  }

  if (row && row.completion_mode === 'project_required' && row.project_type === PROJECT_TYPE) {
    await knex('service_completion_profiles')
      .where({ service_key: KEY })
      .update({
        completion_mode: 'service_report',
        delivery_mode: 'internal_only',
        updated_at: knex.fn.now(),
      });
    console.log(`[phase1b-shadow] ${KEY} flipped to service_report + internal_only (no customer sends)`);
    return;
  }

  if (row) {
    throw new Error(
      `[phase1b-shadow] ${KEY}: unexpected profile state ` +
      `(mode=${row.completion_mode}, pointer=${row.project_type}) — aborting`,
    );
  }

  const service = await knex('services')
    .where({ service_key: KEY })
    .first('service_key', 'name', 'category', 'billing_type', 'requires_follow_up', 'follow_up_interval_days');
  if (!service) {
    console.warn(`[phase1b-shadow] ${KEY}: no profile row and no services row in this environment — skipping (nothing to cut over)`);
    return;
  }

  await knex('service_completion_profiles').insert({
    service_key: KEY,
    service_name_snapshot: service.name || null,
    category: service.category || null,
    billing_type: service.billing_type || null,
    completion_mode: 'service_report',
    delivery_mode: 'internal_only',
    project_type: PROJECT_TYPE,
    creates_service_record: true,
    portal_visibility: 'token_only',
    portal_attach_policy: 'recurring_customer',
    followup_policy: service.requires_follow_up ? 'alert' : 'none',
    default_followup_days: service.follow_up_interval_days || null,
    active: true,
    notes: 'Profile healed at Phase-1b shadow cutover (20260611000016): services row existed without a completion profile.',
  });
  console.log(`[phase1b-shadow] ${KEY}: profile healed directly into service_report + internal_only`);
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
