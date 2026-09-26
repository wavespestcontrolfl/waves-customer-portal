/**
 * Rodent trapping: $350 covers 2 visits; visit 3+ is a $95 catalog row
 * (owner ruling 2026-09-26, replacing the 2026-08-26 unlimited callbacks).
 *
 *  1. pricing_config.rodent_trapping: included_followups 'unlimited' → 1
 *     (setup + 1 trap check), row renamed. Read-modify-write; the prior
 *     data rides the audit row so down() restores it.
 *  2. services.rodent_trapping + rodent_trapping_followup copy: the
 *     "unlimited callbacks" descriptions/notes from 20260826000001 /
 *     20260826000006 are rewritten. rodent_trapping_followup STAYS $0 — it
 *     is the included visit-2 check (and the grandfathered check for jobs
 *     sold before 2026-09-27).
 *  3. NEW services row rodent_trap_check_additional ("Rodent Trap Check -
 *     Additional", $95 fixed). Deliberately NOT a re-service/callback key
 *     and its name avoids the always-free "follow-up" / "re-service" /
 *     "revisit" terms (no-cost-visit-types.js), so a completed visit bills
 *     like any priced one-time visit and a WaveGuard member is not zeroed.
 *  4. Its service_completion_profiles row is cloned from
 *     rodent_trapping_followup's live profile, so the tech completes it
 *     with the same rodent_trapping form (trap_visit_type etc.).
 *
 * Every copy change is value-guarded: a row an admin has edited since the
 * prior migration is left alone, and down() only reverts what up() recorded
 * changing (state in system_settings, same pattern as 20260826000006).
 * Rollback never destroys service identity: a $95 row that visits already
 * reference is kept and deactivated (not deleted), and a re-run of up()
 * revives that same row.
 */
const MIGRATION_TAG = 'migration:20260927000001';
const STATE_KEY = 'migration.20260927000001.state';
// Set by a rollback that had to keep the referenced $95 row (deactivated).
const KEPT_KEY = 'migration.20260927000001.kept_service_id';
const UP_REASON = 'Rodent trapping: $350 covers setup + 1 trap check; extra checks are the $95 Rodent Trap Check - Additional row (owner ruling 2026-09-26)';

const NEW_KEY = 'rodent_trap_check_additional';
const ADDITIONAL_CHECK_PRICE = 95;

// 20260826000001 values.
const PRIOR_ROW_NAME = 'Rodent Trapping (Standard — flat $350, unlimited callbacks)';
const PRIOR_TRAPPING_DESCRIPTION = 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup plus unlimited callbacks/checks for the same active trapping job.';
// 20260826000006 values.
const PRIOR_FOLLOWUP_DESCRIPTION = 'Included callback/check for the same active trapping job — no charge. The Standard trapping plan includes unlimited callbacks; this row exists so the visit can be scheduled and reported, never billed.';
const PRIOR_FOLLOWUP_NOTES = 'Included callback under the Standard trapping plan (unlimited callbacks for the active job). Never billed; no packs.';

const ROW_NAME = 'Rodent Trapping (Standard — flat $350, setup + 1 trap check)';
const TRAPPING_DESCRIPTION = 'Interior snap trap and glue board placement for active rodent activity. Includes the setup visit plus 1 trap check for the same active trapping job; additional trap checks are $95 each.';
const FOLLOWUP_DESCRIPTION = 'The included trap check (visit 2) for the same active trapping job — no charge. Book visit 3 and later as Rodent Trap Check - Additional. Jobs sold before 9/27/2026 keep all their checks included.';
const FOLLOWUP_NOTES = 'Included visit-2 check under the Standard trapping plan, and every check on a job sold before 2026-09-27 (grandfathered). Never billed.';

const NEW_SERVICE_ROW = {
  service_key: NEW_KEY,
  name: 'Rodent Trap Check - Additional',
  short_name: 'Extra Trap Check',
  description: 'Additional trap check (visit 3 and later) for an active rodent trapping job, beyond the setup visit and 1 check included in the $350 trapping plan.',
  internal_notes: 'Book for visit 3+ of a trapping job sold on or after 2026-09-27. Billed to members too. Not bundle-discounted. Never a callback.',
  category: 'rodent',
  billing_type: 'one_time',
  default_duration_minutes: 30,
  min_duration_minutes: 20,
  max_duration_minutes: 45,
  pricing_type: 'fixed',
  base_price: ADDITIONAL_CHECK_PRICE,
  price_range_min: ADDITIONAL_CHECK_PRICE,
  price_range_max: ADDITIONAL_CHECK_PRICE,
  is_taxable: true,
  tax_service_key: 'pest_control',
  requires_license: true,
  license_category: 'GHP',
  customer_visible: false,
  booking_enabled: false,
  icon: '🪤',
  color: '#78716c',
  sort_order: 47,
  is_active: true,
  is_archived: false,
};

async function loadState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

async function saveState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const value = JSON.stringify(state);
  const updated = await knex('system_settings').where({ key: STATE_KEY }).update({ value });
  if (!updated) await knex('system_settings').insert({ key: STATE_KEY, value });
}

async function readSetting(knex, key) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key }).first();
  return row ? row.value : null;
}

async function writeSetting(knex, key, value) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const updated = await knex('system_settings').where({ key }).update({ value });
  if (!updated) await knex('system_settings').insert({ key, value });
}

async function existingColumns(knex, table, row) {
  const out = {};
  for (const [col, val] of Object.entries(row)) {
    if (await knex.schema.hasColumn(table, col)) out[col] = val;
  }
  return out;
}

exports.up = async function up(knex) {
  // A re-run must not overwrite the recorded state (down() would lose what
  // the first run changed).
  if (await loadState(knex)) return;
  const state = { tag: MIGRATION_TAG };

  // 1. pricing_config.rodent_trapping
  if (await knex.schema.hasTable('pricing_config')) {
    const row = await knex('pricing_config').where({ config_key: 'rodent_trapping' }).first();
    const data = row && (typeof row.data === 'string' ? JSON.parse(row.data) : row.data);
    if (row && data && typeof data === 'object' && data.included_followups === 'unlimited') {
      const newData = { ...data, included_followups: 1 };
      const renamed = row.name === PRIOR_ROW_NAME;
      await knex('pricing_config').where({ config_key: 'rodent_trapping' }).update({
        ...(renamed ? { name: ROW_NAME } : {}),
        data: JSON.stringify(newData),
        updated_at: knex.fn.now(),
      });
      if (await knex.schema.hasTable('pricing_config_audit')) {
        await knex('pricing_config_audit').insert({
          config_key: 'rodent_trapping',
          old_value: JSON.stringify(data),
          new_value: JSON.stringify(newData),
          changed_by: MIGRATION_TAG,
          reason: UP_REASON,
        });
      }
      state.pricing = { includedFollowupsChanged: true, renamed };
    }
  }

  if (!(await knex.schema.hasTable('services'))) {
    await saveState(knex, state);
    return;
  }

  // 2. Copy on the two existing rows (value-guarded).
  const copyChanges = [];
  const trapping = await knex('services').where({ service_key: 'rodent_trapping' }).first('id', 'description');
  if (trapping && trapping.description === PRIOR_TRAPPING_DESCRIPTION) {
    await knex('services').where({ id: trapping.id }).update({ description: TRAPPING_DESCRIPTION, updated_at: knex.fn.now() });
    copyChanges.push({ key: 'rodent_trapping', field: 'description' });
  }
  const followup = await knex('services').where({ service_key: 'rodent_trapping_followup' }).first();
  if (followup) {
    const patch = {};
    if (followup.description === PRIOR_FOLLOWUP_DESCRIPTION) {
      patch.description = FOLLOWUP_DESCRIPTION;
      copyChanges.push({ key: 'rodent_trapping_followup', field: 'description' });
    }
    if (followup.internal_notes === PRIOR_FOLLOWUP_NOTES) {
      patch.internal_notes = FOLLOWUP_NOTES;
      copyChanges.push({ key: 'rodent_trapping_followup', field: 'internal_notes' });
    }
    if (Object.keys(patch).length) {
      await knex('services').where({ id: followup.id }).update({ ...patch, updated_at: knex.fn.now() });
    }
  }
  state.copyChanges = copyChanges;

  // 3. The $95 row.
  const existing = await knex('services').where({ service_key: NEW_KEY }).first('id', 'is_active');
  const keptId = await readSetting(knex, KEPT_KEY);
  if (existing && existing.is_active === false && keptId === String(existing.id)) {
    // Kept (deactivated) by an earlier rollback because visits reference it:
    // bring the same identity back rather than seeding a second row. A row
    // an admin deactivated is never touched.
    await knex('services').where({ id: existing.id }).update({ is_active: true, updated_at: knex.fn.now() });
    await knex('system_settings').where({ key: KEPT_KEY }).del();
    state.reactivatedServiceId = existing.id;
  }
  if (!existing) {
    const insertRow = await existingColumns(knex, 'services', NEW_SERVICE_ROW);
    const [inserted] = await knex('services').insert(insertRow).returning('id');
    state.insertedServiceId = inserted?.id ?? inserted ?? null;
  }

  // 4. Completion profile cloned from the follow-up's live profile.
  if (await knex.schema.hasTable('service_completion_profiles')) {
    const hasProfile = await knex('service_completion_profiles').where({ service_key: NEW_KEY }).first('service_key');
    const source = await knex('service_completion_profiles').where({ service_key: 'rodent_trapping_followup' }).first();
    if (!hasProfile && source) {
      const { id, created_at: _c, updated_at: _u, ...rest } = source;
      await knex('service_completion_profiles').insert({
        ...rest,
        service_key: NEW_KEY,
        service_name_snapshot: NEW_SERVICE_ROW.name,
        billing_type: 'one_time',
        notes: `Cloned from rodent_trapping_followup (${MIGRATION_TAG}).`,
      });
      state.profileInserted = true;
    } else if (!hasProfile) {
      console.warn(`[${MIGRATION_TAG}] rodent_trapping_followup completion profile ABSENT — ${NEW_KEY} has no profile`);
    }
  }

  await saveState(knex, state);
};

exports.down = async function down(knex) {
  const state = await loadState(knex);
  if (!state) return;

  // Non-destructive rollback: once the $95 row is referenced (booked,
  // completed, invoiced), its id is the service identity of real visits —
  // deleting or re-seeding it would orphan them. A referenced row and its
  // completion profile are kept and only deactivated; an unused row is
  // removed with its profile.
  let keepInsertedRow = false;
  const ownedServiceId = state.insertedServiceId || state.reactivatedServiceId;
  if (ownedServiceId && await knex.schema.hasTable('services')) {
    const row = await knex('services').where({ id: ownedServiceId, service_key: NEW_KEY }).first('id');
    if (row) {
      for (const table of ['scheduled_services', 'scheduled_service_addons', 'service_records']) {
        if (keepInsertedRow) break;
        if (await knex.schema.hasColumn(table, 'service_id')) {
          keepInsertedRow = Boolean(await knex(table).where({ service_id: row.id }).first('service_id'));
        }
      }
      if (keepInsertedRow) {
        await knex('services').where({ id: row.id }).update({ is_active: false, updated_at: knex.fn.now() });
        await writeSetting(knex, KEPT_KEY, String(row.id));
      } else {
        if (state.profileInserted && await knex.schema.hasTable('service_completion_profiles')) {
          await knex('service_completion_profiles').where({ service_key: NEW_KEY }).del();
        }
        await knex('services').where({ id: row.id }).del();
      }
    }
  }

  if (await knex.schema.hasTable('services')) {
    for (const change of state.copyChanges || []) {
      const [from, to] = change.key === 'rodent_trapping'
        ? [TRAPPING_DESCRIPTION, PRIOR_TRAPPING_DESCRIPTION]
        : change.field === 'description'
          ? [FOLLOWUP_DESCRIPTION, PRIOR_FOLLOWUP_DESCRIPTION]
          : [FOLLOWUP_NOTES, PRIOR_FOLLOWUP_NOTES];
      await knex('services')
        .where({ service_key: change.key, [change.field]: from })
        .update({ [change.field]: to, updated_at: knex.fn.now() });
    }
  }

  if (state.pricing?.includedFollowupsChanged && await knex.schema.hasTable('pricing_config')) {
    const row = await knex('pricing_config').where({ config_key: 'rodent_trapping' }).first();
    const data = row && (typeof row.data === 'string' ? JSON.parse(row.data) : row.data);
    if (row && data && Number(data.included_followups) === 1) {
      const restored = { ...data, included_followups: 'unlimited' };
      await knex('pricing_config').where({ config_key: 'rodent_trapping' }).update({
        ...(state.pricing.renamed && row.name === ROW_NAME ? { name: PRIOR_ROW_NAME } : {}),
        data: JSON.stringify(restored),
        updated_at: knex.fn.now(),
      });
      if (await knex.schema.hasTable('pricing_config_audit')) {
        await knex('pricing_config_audit').insert({
          config_key: 'rodent_trapping',
          old_value: JSON.stringify(data),
          new_value: JSON.stringify(restored),
          changed_by: MIGRATION_TAG,
          reason: 'Rollback: restore unlimited trap checks (20260927000001)',
        });
      }
    }
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.NEW_KEY = NEW_KEY;
exports.ADDITIONAL_CHECK_PRICE = ADDITIONAL_CHECK_PRICE;
