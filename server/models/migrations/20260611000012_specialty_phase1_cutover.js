/**
 * Specialty services → Service Report V1: Phase-1 cutover (PR 5).
 *
 * Flips the Phase-1 pilot allowlist from completion_mode='project_required'
 * to 'service_report' — the profile row is the feature flag (contract:
 * docs/design/specialty-service-completion-contract.md §2), so this migration
 * IS the cutover: from deploy, these types complete through the typed
 * CompletionPanel and render/send Service Report V1 instead of opening a
 * Projects form. delivery_mode stays auto_send (staged pilot, pure auto-send;
 * per-profile delivery_mode + SPECIALTY_REPORT_DELIVERY_DISABLED env are the
 * kill switches).
 *
 * Explicit allowlist only — no pattern sweeps. The count assertion throws
 * (rolling back the transaction) if prod rows drift from this list, so a
 * mismatch fails the deploy loudly instead of flipping a partial set.
 *
 * Deliberately EXCLUDED (stay project_required):
 *  - general_appointment     — generic catch-all; the pest-treatment findings
 *                              schema (required activity gauge) is wrong-frame.
 *  - waveguard_initial_setup — recurring-program onboarding, not a specialty
 *                              one-time; revisit with the recurring flow.
 *  - trend types (cockroach/flea/rodent/wildlife/bed bug) — Phase 1b/2.
 *  - termite_*               — Phase 3, after FS 482.226 / FAC 5E-14 signoff.
 */

// service_key → expected current project_type pointer (verified against the
// full migration replay; the WHERE below also asserts it at run time).
const PHASE1_KEYS = {
  pest_inspection: 'pest_inspection',
  new_customer_inspection: 'pest_inspection',
  mosquito_event: 'mosquito_event',
  palm_injection: 'palm_injection',
  lawn_aeration: 'one_time_lawn_treatment',
  lawn_care_one_time: 'one_time_lawn_treatment',
  lawn_fungicide: 'one_time_lawn_treatment',
  lawn_insect_control: 'one_time_lawn_treatment',
  lawn_inspection: 'one_time_lawn_treatment',
  bee_wasp_removal: 'one_time_pest_treatment',
  fire_ant: 'one_time_pest_treatment',
  mud_dauber_removal: 'one_time_pest_treatment',
  pest_initial_cleanout: 'one_time_pest_treatment',
  pest_re_service: 'one_time_pest_treatment',
  tick_control: 'one_time_pest_treatment',
};

// One pointer correction rides along: mosquito_one_time fell into the generic
// pest fallback at profile seeding, but its work content (areas treated,
// breeding sources) is the mosquito_event report family — and the generic
// schema's required activity gauge doesn't fit mosquito work.
const REPOINTED_KEYS = {
  mosquito_one_time: { from: 'one_time_pest_treatment', to: 'mosquito_event' },
};

const EXPECTED_TOTAL = Object.keys(PHASE1_KEYS).length + Object.keys(REPOINTED_KEYS).length;

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('service_completion_profiles');
  if (!hasTable) throw new Error('service_completion_profiles table missing — cutover cannot run');

  await knex.transaction(async (trx) => {
    let flipped = 0;

    for (const [serviceKey, projectType] of Object.entries(PHASE1_KEYS)) {
      const count = await trx('service_completion_profiles')
        .where({
          service_key: serviceKey,
          project_type: projectType,
          completion_mode: 'project_required',
          active: true,
        })
        .update({ completion_mode: 'service_report', updated_at: trx.fn.now() });
      if (count !== 1) {
        throw new Error(
          `[phase1-cutover] expected exactly 1 active project_required row for ` +
          `${serviceKey} (${projectType}), matched ${count} — aborting, nothing flipped`,
        );
      }
      flipped += count;
    }

    for (const [serviceKey, { from, to }] of Object.entries(REPOINTED_KEYS)) {
      const count = await trx('service_completion_profiles')
        .where({
          service_key: serviceKey,
          project_type: from,
          completion_mode: 'project_required',
          active: true,
        })
        .update({ completion_mode: 'service_report', project_type: to, updated_at: trx.fn.now() });
      if (count !== 1) {
        throw new Error(
          `[phase1-cutover] expected exactly 1 active project_required row for ` +
          `${serviceKey} (${from}), matched ${count} — aborting, nothing flipped`,
        );
      }
      flipped += count;
    }

    if (flipped !== EXPECTED_TOTAL) {
      throw new Error(`[phase1-cutover] flipped ${flipped}, expected ${EXPECTED_TOTAL} — aborting`);
    }
    console.log(`[phase1-cutover] ${flipped} profiles flipped to service_report (delivery_mode untouched)`);
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('service_completion_profiles');
  if (!hasTable) return;

  await knex.transaction(async (trx) => {
    for (const [serviceKey, projectType] of Object.entries(PHASE1_KEYS)) {
      await trx('service_completion_profiles')
        .where({ service_key: serviceKey, project_type: projectType, completion_mode: 'service_report' })
        .update({ completion_mode: 'project_required', updated_at: trx.fn.now() });
    }
    for (const [serviceKey, { from, to }] of Object.entries(REPOINTED_KEYS)) {
      await trx('service_completion_profiles')
        .where({ service_key: serviceKey, project_type: to, completion_mode: 'service_report' })
        .update({ completion_mode: 'project_required', project_type: from, updated_at: trx.fn.now() });
    }
    console.log('[phase1-cutover] rolled back — Phase-1 keys restored to project_required');
  });
};
