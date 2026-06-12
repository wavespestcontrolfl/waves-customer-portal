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
 * SELF-HEALING REWRITE (this file never ran successfully in any environment,
 * so editing it in place is safe — knex has no record of it): the original
 * version asserted count===1 per key and aborted on any mismatch. That
 * blocked every deploy, because live catalogs have drifted per environment
 * (prod lacks an active pest_initial_cleanout profile; staging lacks
 * mosquito_event) — admin catalog edits mean no fixed allowlist holds
 * everywhere. Per-key resolution is now deterministic:
 *
 *  - active project_required row, expected pointer       → FLIP
 *  - active service_report row already at target pointer → ALREADY (idempotent)
 *  - no profile row, but the services row exists         → HEAL: insert the
 *    profile directly in its cut-over shape (seed defaults derived from the
 *    services row, mirroring the 20260521000005 one_time branch)
 *  - no profile row AND no services row, or inactive row → ABSENT: warn and
 *    skip — this environment has no such service to cut over (runtime only
 *    resolves active rows, so an inactive profile is inert either way)
 *  - anything else (unexpected mode or pointer)          → THROW: genuine
 *    drift that needs human eyes; transaction rolls back, nothing flips
 *
 * Every key's outcome is logged so the deploy log records exactly what each
 * environment had. Explicit allowlist only — no pattern sweeps.
 *
 * Deliberately EXCLUDED (stay project_required):
 *  - general_appointment     — generic catch-all; the pest-treatment findings
 *                              schema (required activity gauge) is wrong-frame.
 *  - waveguard_initial_setup — recurring-program onboarding, not a specialty
 *                              one-time; revisit with the recurring flow.
 *  - trend types (cockroach/flea/rodent/wildlife/bed bug) — Phase 1b/2.
 *  - termite_*               — Phase 3, after FS 482.226 / FAC 5E-14 signoff.
 */

// { key, from: expected current pointer(s), to: pointer after cutover }.
// `from` may be an array when environments have drifted: canonical pre-cutover
// pointer FIRST, accepted drift states after. up() accepts any listed value;
// down() restores the canonical (first) pointer — never a drift value.
// mosquito_one_time and palm_injection are pointer corrections: they fell into
// the generic pest fallback at profile seeding. mosquito_one_time's work
// content (areas treated, breeding sources) belongs to the mosquito_event
// report family — the generic schema's required activity gauge doesn't fit
// mosquito work. palm_injection similarly drifted to pest_inspection in
// environments where the catalog seeded before the palm_injection profile
// type was registered.
const PHASE1_KEYS = [
  { key: 'pest_inspection', from: 'pest_inspection', to: 'pest_inspection' },
  { key: 'new_customer_inspection', from: 'pest_inspection', to: 'pest_inspection' },
  { key: 'mosquito_event', from: ['mosquito_event', 'pest_inspection'], to: 'mosquito_event' },
  { key: 'mosquito_one_time', from: ['one_time_pest_treatment', 'pest_inspection'], to: 'mosquito_event' },
  { key: 'palm_injection', from: ['palm_injection', 'pest_inspection'], to: 'palm_injection' },
  { key: 'lawn_aeration', from: 'one_time_lawn_treatment', to: 'one_time_lawn_treatment' },
  { key: 'lawn_care_one_time', from: 'one_time_lawn_treatment', to: 'one_time_lawn_treatment' },
  { key: 'lawn_fungicide', from: 'one_time_lawn_treatment', to: 'one_time_lawn_treatment' },
  { key: 'lawn_insect_control', from: 'one_time_lawn_treatment', to: 'one_time_lawn_treatment' },
  { key: 'lawn_inspection', from: 'one_time_lawn_treatment', to: 'one_time_lawn_treatment' },
  { key: 'bee_wasp_removal', from: 'one_time_pest_treatment', to: 'one_time_pest_treatment' },
  { key: 'fire_ant', from: 'one_time_pest_treatment', to: 'one_time_pest_treatment' },
  { key: 'mud_dauber_removal', from: 'one_time_pest_treatment', to: 'one_time_pest_treatment' },
  { key: 'pest_initial_cleanout', from: 'one_time_pest_treatment', to: 'one_time_pest_treatment' },
  { key: 'pest_re_service', from: 'one_time_pest_treatment', to: 'one_time_pest_treatment' },
  { key: 'tick_control', from: 'one_time_pest_treatment', to: 'one_time_pest_treatment' },
];

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('service_completion_profiles');
  if (!hasTable) throw new Error('service_completion_profiles table missing — cutover cannot run');

  await knex.transaction(async (trx) => {
    const outcomes = { flipped: [], healed: [], already: [], absent: [] };

    for (const { key, from, to } of PHASE1_KEYS) {
      const row = await trx('service_completion_profiles')
        .where({ service_key: key })
        .first();

      if (row && !row.active) {
        console.warn(`[phase1-cutover] ${key}: profile row is INACTIVE in this environment — skipping (runtime ignores inactive rows)`);
        outcomes.absent.push(key);
        continue;
      }

      if (row && row.completion_mode === 'service_report' && row.project_type === to) {
        outcomes.already.push(key);
        continue;
      }

      const fromList = Array.isArray(from) ? from : [from];
      if (row && row.completion_mode === 'project_required' && fromList.includes(row.project_type)) {
        await trx('service_completion_profiles')
          .where({ service_key: key })
          .update({ completion_mode: 'service_report', project_type: to, updated_at: trx.fn.now() });
        outcomes.flipped.push(key);
        continue;
      }

      if (row) {
        // Unexpected mode or pointer — genuine per-environment drift this
        // migration must not paper over.
        throw new Error(
          `[phase1-cutover] ${key}: unexpected profile state ` +
          `(mode=${row.completion_mode}, pointer=${row.project_type}, expected ${fromList.join('|')}→${to}) ` +
          `— aborting, nothing flipped`,
        );
      }

      const service = await trx('services')
        .where({ service_key: key })
        .first('service_key', 'name', 'category', 'billing_type', 'requires_follow_up', 'follow_up_interval_days');
      if (!service) {
        console.warn(`[phase1-cutover] ${key}: no profile row and no services row in this environment — skipping (nothing to cut over)`);
        outcomes.absent.push(key);
        continue;
      }

      // Profile row missing but the service exists (the 20260521000005 seed
      // ran before this service existed here, or the row was removed).
      // Insert directly in the cut-over shape, seed defaults matching that
      // migration's one_time branch.
      await trx('service_completion_profiles').insert({
        service_key: key,
        service_name_snapshot: service.name || null,
        category: service.category || null,
        billing_type: service.billing_type || null,
        completion_mode: 'service_report',
        project_type: to,
        creates_service_record: true,
        portal_visibility: 'token_only',
        portal_attach_policy: 'recurring_customer',
        followup_policy: service.requires_follow_up ? 'alert' : 'none',
        default_followup_days: service.follow_up_interval_days || null,
        active: true,
        notes: 'Profile healed at Phase-1 cutover (20260611000012): services row existed without a completion profile.',
      });
      outcomes.healed.push(key);
    }

    const total = outcomes.flipped.length + outcomes.healed.length
      + outcomes.already.length + outcomes.absent.length;
    if (total !== PHASE1_KEYS.length) {
      throw new Error(`[phase1-cutover] accounted for ${total}/${PHASE1_KEYS.length} keys — aborting`);
    }
    console.log(
      `[phase1-cutover] flipped=${outcomes.flipped.length} healed=${outcomes.healed.length} ` +
      `already=${outcomes.already.length} absent=${outcomes.absent.length}` +
      (outcomes.healed.length ? ` | healed: ${outcomes.healed.join(', ')}` : '') +
      (outcomes.absent.length ? ` | absent: ${outcomes.absent.join(', ')}` : ''),
    );
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('service_completion_profiles');
  if (!hasTable) return;

  await knex.transaction(async (trx) => {
    for (const { key, from, to } of PHASE1_KEYS) {
      // Healed rows (inserted by up()) also revert to project_required here —
      // they become valid pre-cutover rows the environment was missing, which
      // is the safe direction for a rollback.
      // Array-valued `from` lists the canonical pointer first, then accepted
      // drift states; restore the canonical one — writing the array itself
      // would corrupt the string column, and restoring a drift value would
      // re-create the drift up() exists to absorb.
      const rollbackPointer = Array.isArray(from) ? from[0] : from;
      await trx('service_completion_profiles')
        .where({ service_key: key, project_type: to, completion_mode: 'service_report' })
        .update({ completion_mode: 'project_required', project_type: rollbackPointer, updated_at: trx.fn.now() });
    }
    console.log('[phase1-cutover] rolled back — Phase-1 keys restored to project_required');
  });
};
