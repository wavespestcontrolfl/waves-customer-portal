/**
 * Mosquito Misting System completion posture: move the profile
 * 20260924000020 inserted from the generic `service_report` shape to the
 * consultation posture (Codex round-1 P1 on PR #4762).
 *
 * 20260924000020 was already PUSHED and ran on the preview DB at commit
 * f196b81130 — it is FROZEN: an edit there is a silent no-op on any
 * environment that already migrated (see docs/development.md / the
 * migration-guard policy). This migration is the correction, applied as a
 * follow-up flip instead of editing the frozen file.
 *
 * Why the flip: a plain `service_report`/no-`project_type` profile on an
 * unlisted one-time catalog key classifies as
 * `generic_report_one_time_key:defect` under the completion-lane registry
 * (`server/config/completion-lane-registry.js`, `classifyCatalogRow`,
 * `completion-lane-coverage-contract.test.js`) AND would auto-send a
 * customer Service Report the moment this row is ever completed — wrong
 * for a lead-only, unpriced identity whose "visit," if ever scheduled, is
 * an unpriced on-site design assessment, not a finished treatment.
 *
 * Posture chosen: `completion_mode` 'internal_only' with NO `project_type`
 * — the consultation posture the Waves Assessment (20260619000002) and the
 * billing riders (20260712400000) use, the only shape
 * resolveCompletionDeliveryPosture honors to suppress the generic report
 * auto-send. The key is registered in the completion-lane registry's
 * ASSESSMENT_EXPERIENCE_KEYS (separate commit, not this frozen migration).
 * ONE_TIME_GENERIC_BY_DESIGN was considered and rejected: that list is the
 * owner-approved auto-send lane for a specific, unrelated ruling (the
 * untyped pest/lawn one-time families, 2026-07-30/07-31) — adding this
 * unrelated, unpriced, not-yet-bookable key to it would be an unapproved
 * policy change, not a reuse of an existing decision.
 *
 * Guardrails (never overwrite an admin edit):
 *  - Only flips a profile that still carries EXACTLY the shape
 *    20260924000020 inserted: notes === its PROFILE_MARKER verbatim, AND
 *    completion_mode/project_type/delivery_mode/portal_visibility/
 *    portal_attach_policy all match its insert literally. Any drift (an
 *    admin edited a field, or replaced the row) is left untouched.
 *  - Already-consultation (this migration already ran, or the shape was
 *    reached some other way) is a no-op.
 *  - A services row that exists with NO completion profile at all (an
 *    environment where 20260924000020's own insert-profile pass was
 *    skipped — its profile insert requires the row to be explicitly
 *    is_active at that moment) gets the consultation profile inserted
 *    fresh.
 *  - Prior field values are recorded in this migration's OWN
 *    system_settings state key (not 20260924000020's, which is frozen and
 *    unconditionally clears its own state on every down() run — no signal
 *    survives there to build on). down() restores exactly what up()
 *    changed: the prior field values for a flip, or deletes the profile
 *    row this migration inserted from nothing — and only while the row
 *    still matches the shape this migration left it in (an admin edit
 *    since the flip owns the row and is left alone).
 *
 * Roll-forward note (Codex round-1 P2 on PR #4762): the companion
 * "down() retains a referenced row, then a later up() reactivates it"
 * fix cannot live here either. 20260924000020's frozen down() always
 * deletes its own state key — even when it retained+deactivated the
 * services row for a live reference — so there is no signal left behind
 * for this migration to detect "this row is inactive BECAUSE 20260924000020
 * retained it" versus "an admin deliberately deactivated it" (the latter is
 * an explicit, load-bearing invariant elsewhere in this migration family —
 * see 20260924000020's and 20260811000010's own is_active checks). Blindly
 * reactivating any inactive mosquito_misting_system row would risk
 * resurrecting a row an admin intentionally turned off. Left uncovered by
 * design; not a silent gap.
 */

const SERVICE_KEY = 'mosquito_misting_system';
// 20260924000020's PROFILE_MARKER, verbatim — the ONLY notes value its own
// insert ever writes.
const PRIOR_MARKER = '[mosquito_misting_catalog_action=inserted]';
// This migration's own marker, for the "no profile existed" insert-fresh case.
const INSERTED_MARKER = '[mosquito_misting_posture_action=inserted]';
const STATE_KEY = 'migration.20260924000030.state';

// The EXACT shape 20260924000020 inserts (service_report/generic/auto_send).
const PRIOR_SHAPE = {
  completion_mode: 'service_report',
  project_type: null,
  delivery_mode: 'auto_send',
  portal_visibility: 'token_only',
  portal_attach_policy: 'recurring_customer',
};

// The consultation posture (Waves Assessment / billing-rider pattern).
const CONSULTATION_SHAPE = {
  completion_mode: 'internal_only',
  project_type: null,
  delivery_mode: 'disabled',
  portal_visibility: 'internal_only',
  portal_attach_policy: 'never',
};

function matchesShape(row, shape) {
  return Object.entries(shape).every(([field, value]) => row[field] === value);
}

async function readState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch (e) {
    console.warn(`[mosquito-misting-posture] unreadable state row (${e.message}) — treating as absent`);
    return null;
  }
}

async function writeState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (existing) {
    await knex('system_settings').where({ key: STATE_KEY }).update({ value: JSON.stringify(state) });
  } else {
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services')) || !(await knex.schema.hasTable('service_completion_profiles'))) {
    console.warn('[mosquito-misting-posture] services / service_completion_profiles table absent — skipping');
    return;
  }

  const service = await knex('services').where({ service_key: SERVICE_KEY }).first();
  if (!service) {
    console.warn(`[mosquito-misting-posture] ${SERVICE_KEY}: services row absent — nothing to flip (20260924000020 hasn't run, or the key was removed)`);
    return;
  }

  const profile = await knex('service_completion_profiles').where({ service_key: SERVICE_KEY }).first();

  if (!profile) {
    // 20260924000020's own profile insert only ever runs while the row is
    // explicitly is_active/non-archived at that moment — an environment
    // where that gate skipped (or the profile was later deleted outright)
    // has no profile row at all. Insert the consultation posture fresh.
    await knex('service_completion_profiles').insert({
      service_key: SERVICE_KEY,
      service_name_snapshot: service.name,
      category: service.category || 'mosquito',
      billing_type: service.billing_type || 'one_time',
      ...CONSULTATION_SHAPE,
      creates_service_record: true,
      followup_policy: 'none',
      default_followup_days: null,
      active: true,
      notes: INSERTED_MARKER,
    });
    await writeState(knex, { action: 'inserted' });
    console.log(`[mosquito-misting-posture] ${SERVICE_KEY}: no profile existed — inserted the consultation posture fresh`);
    return;
  }

  if (matchesShape(profile, CONSULTATION_SHAPE)) {
    console.log(`[mosquito-misting-posture] ${SERVICE_KEY}: already the consultation posture — no-op`);
    return;
  }

  if (String(profile.notes || '') !== PRIOR_MARKER || !matchesShape(profile, PRIOR_SHAPE)) {
    console.warn(`[mosquito-misting-posture] ${SERVICE_KEY}: profile does not match the exact 20260924000020 shape (admin-edited, or already changed by something else) — leaving untouched`);
    return;
  }

  await writeState(knex, {
    action: 'flipped',
    prior: {
      completion_mode: profile.completion_mode,
      project_type: profile.project_type,
      delivery_mode: profile.delivery_mode,
      portal_visibility: profile.portal_visibility,
      portal_attach_policy: profile.portal_attach_policy,
    },
  });
  await knex('service_completion_profiles').where({ service_key: SERVICE_KEY }).update({
    ...CONSULTATION_SHAPE,
    updated_at: knex.fn.now(),
  });
  console.log(`[mosquito-misting-posture] ${SERVICE_KEY}: flipped service_report/auto_send → internal_only/disabled (consultation posture)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_completion_profiles'))) return;

  const state = await readState(knex);
  if (!state) {
    console.warn('[mosquito-misting-posture] down: no state row — up() never changed anything here');
    return;
  }

  const profile = await knex('service_completion_profiles').where({ service_key: SERVICE_KEY }).first();
  if (!profile) {
    console.warn(`[mosquito-misting-posture] down: ${SERVICE_KEY} profile is absent — nothing to restore`);
  } else if (state.action === 'inserted') {
    // Delete only if it is STILL the exact row this migration inserted
    // from nothing (marker + shape both intact) — an admin who edited or
    // replaced it since owns it now.
    if (String(profile.notes || '') === INSERTED_MARKER && matchesShape(profile, CONSULTATION_SHAPE)) {
      await knex('service_completion_profiles').where({ service_key: SERVICE_KEY }).del();
      console.log(`[mosquito-misting-posture] down: removed the profile this migration inserted from nothing`);
    } else {
      console.warn(`[mosquito-misting-posture] down: ${SERVICE_KEY} profile was admin-replaced since the insert — leaving untouched`);
    }
  } else if (state.action === 'flipped') {
    // Restore the prior fields only if the row is STILL in the shape this
    // migration flipped it to — an admin edit since the flip owns the row.
    if (matchesShape(profile, CONSULTATION_SHAPE)) {
      await knex('service_completion_profiles').where({ service_key: SERVICE_KEY }).update({
        ...state.prior,
        updated_at: knex.fn.now(),
      });
      console.log(`[mosquito-misting-posture] down: restored the prior service_report/auto_send shape`);
    } else {
      console.warn(`[mosquito-misting-posture] down: ${SERVICE_KEY} profile was admin-edited since the flip — leaving untouched`);
    }
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
