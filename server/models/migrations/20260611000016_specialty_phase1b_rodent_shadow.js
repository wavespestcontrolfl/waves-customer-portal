/**
 * Specialty services → Service Report V1: Phase-1b shadow pilot.
 *
 * Flips ONE trend-type key — rodent_trapping — to the typed completion flow
 * at delivery_mode='internal_only': the typed CompletionPanel activates,
 * activity scores persist, follow-up CTA books $0 trap checks, and the V1
 * report renders + stores by token (PDF render deferred until auto_send —
 * the headless renderer cannot carry staff auth), and NO customer SMS/email.
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
 * ROLLBACK FIDELITY: up() stamps the action it took into the row's notes
 * ([phase1b_action=...]), and down() restores ONLY what up() changed —
 * flipped rows revert, healed rows are deleted, delivery-forced rows get
 * their prior delivery_mode back. Rows up() never touched are untouched
 * by down() too.
 *
 * Graduation to customer sends = a later one-line flip to auto_send after
 * the shadow reports are owner-approved.
 */

const KEY = 'rodent_trapping';
const PROJECT_TYPE = 'rodent_trapping';
const ACCEPTED_TYPES = [PROJECT_TYPE, 'rodent_exclusion'];
const MARKER_RE = / ?\[phase1b_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[phase1b_action=${action}]`;
}

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

  if (row && row.completion_mode === 'service_report' && ACCEPTED_TYPES.includes(row.project_type)) {
    if (row.delivery_mode !== 'internal_only') {
      // Record the prior delivery_mode so down() can restore exactly it.
      await knex('service_completion_profiles')
        .where({ service_key: KEY })
        .update({
          delivery_mode: 'internal_only',
          notes: withMarker(row.notes, `delivery_forced:${row.delivery_mode || 'auto_send'}`),
          updated_at: knex.fn.now(),
        });
      console.log(`[phase1b-shadow] ${KEY}: already service_report — delivery_mode ${row.delivery_mode} → internal_only (prior recorded)`);
    } else {
      console.log(`[phase1b-shadow] ${KEY}: already service_report + internal_only — no-op`);
    }
    return;
  }

  if (row && row.completion_mode === 'project_required' && ACCEPTED_TYPES.includes(row.project_type)) {
    await knex('service_completion_profiles')
      .where({ service_key: KEY })
      .update({
        completion_mode: 'service_report',
        delivery_mode: 'internal_only',
        notes: withMarker(row.notes, 'flipped'),
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
    notes: withMarker(
      'Profile healed at Phase-1b shadow cutover (20260611000016): services row existed without a completion profile.',
      'healed',
    ),
  });
  console.log(`[phase1b-shadow] ${KEY}: profile healed directly into service_report + internal_only`);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('service_completion_profiles');
  if (!hasTable) return;

  const row = await knex('service_completion_profiles')
    .where({ service_key: KEY })
    .first();
  if (!row) return;

  const marker = /\[phase1b_action=([^\]]*)\]/.exec(String(row.notes || ''));
  if (!marker) {
    console.log(`[phase1b-shadow] down: ${KEY} carries no phase1b action marker — leaving untouched`);
    return;
  }
  const action = marker[1];
  const strippedNotes = String(row.notes || '').replace(MARKER_RE, '').trim() || null;

  if (action === 'healed') {
    await knex('service_completion_profiles').where({ service_key: KEY }).del();
    console.log(`[phase1b-shadow] down: deleted healed ${KEY} row (did not exist pre-migration)`);
    return;
  }

  if (action === 'flipped') {
    await knex('service_completion_profiles')
      .where({ service_key: KEY })
      .update({
        completion_mode: 'project_required',
        delivery_mode: 'auto_send',
        notes: strippedNotes,
        updated_at: knex.fn.now(),
      });
    console.log(`[phase1b-shadow] down: ${KEY} restored to project_required/auto_send`);
    return;
  }

  if (action.startsWith('delivery_forced:')) {
    const prior = action.slice('delivery_forced:'.length) || 'auto_send';
    await knex('service_completion_profiles')
      .where({ service_key: KEY })
      .update({ delivery_mode: prior, notes: strippedNotes, updated_at: knex.fn.now() });
    console.log(`[phase1b-shadow] down: ${KEY} delivery_mode restored to ${prior} (mode untouched)`);
    return;
  }

  console.warn(`[phase1b-shadow] down: unrecognized action marker "${action}" on ${KEY} — leaving untouched`);
};
