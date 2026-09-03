/**
 * Flea is sold ONLY as the two-visit Flea Elimination Package — public lane
 * included (owner rulings 2026-09-03: "flea should be two visits"; PR #3831
 * removed the single knockdown from the admin tool, this migration removes
 * it from the public lane and the engine config, and gives the catalog row
 * the package's follow-up contract).
 *
 * Three DB-authoritative rows move:
 *
 * 1. pricing_config.onetime_flea — db-bridge.syncConstantsFromDB overlays
 *    `offers` onto constants.SPECIALTY.flea, so the constants.js change in
 *    this PR is inert in prod until the single-visit offer leaves the row.
 *    Read-modify-write: only the `flea_knockdown_single` entry is dropped;
 *    every other key (admin-tuned prices, exterior tiers, guarantee) is
 *    kept. Audit row written; down() keys off it.
 *
 * 2. service_completion_profiles.flea_tick — followup_policy 'none' →
 *    'alert' with default_followup_days 14: the same follow-up contract the
 *    other two-visit programs carry (cockroach_control, bed_bug_treatment),
 *    so closing out the initial visit raises the follow_up_needed bell for
 *    the package's second visit instead of nothing. 20260825000011 refused
 *    to alias flea_package onto this row precisely because it had no
 *    follow-up policy; this is what makes the alias below honest.
 *
 * 3. services.flea_tick — engine_keys ['flea_knockdown_single'] (stamped by
 *    20260825000011, an engine key nothing prices any more) → ['flea_package']
 *    so accepted package lines — public AND admin-sold — stamp service_id and
 *    route to the typed flea completion profile above. Same guarded pattern
 *    as 20260826000003: table lock across the check-then-stamp span, another
 *    active owner of the key elsewhere skips the stamp (no duplicate owners
 *    for the linker to refuse), only the exact seeded value is touched (an
 *    admin-edited engine_keys survives), ownership RECORDED by row id in
 *    system_settings, and down() reverses only recorded rows, value-guarded.
 *    The description said "full yard broadcast … interior as an add-on", the
 *    reverse of the package (interior + follow-up; yard as the add-on);
 *    rewritten to match.
 *
 * Prod 2026-09-03 (read-only): 0 estimates ever carried the single key; no
 * row claims flea_package.
 */
const FLEA_CONFIG_KEY = 'onetime_flea';
const SINGLE_OFFER_KEY = 'flea_knockdown_single';
const MIGRATION_TAG = 'migration:20260903000050';
const STATE_KEY = 'migration.20260903000050.state';
const UP_REASON = 'Remove the single-visit flea knockdown offer — flea is sold only as the two-visit package (owner ruling 2026-09-03)';
const DOWN_REASON = 'Rollback: restore the single-visit flea knockdown offer (20260903000050)';

const SERVICE_KEY = 'flea_tick';
const OLD_ENGINE_KEYS = [SINGLE_OFFER_KEY];
const NEW_ENGINE_KEYS = ['flea_package'];
// Exported so the accept-path contract test composes the LIVE seeded view
// (20260810000002 + 20260825000011 seeds, with this remap applied).
const REMAP = { service_key: SERVICE_KEY, from: OLD_ENGINE_KEYS, to: NEW_ENGINE_KEYS };
const OLD_DESCRIPTION = 'Full yard broadcast for flea control. Interior treatment available as an add-on.';
const NEW_DESCRIPTION = 'Two-visit flea elimination package: interior treatment plus a follow-up at the egg-hatch window. Yard treatment available as an add-on.';
const FOLLOWUP_POLICY = 'alert';
const FOLLOWUP_DAYS = 14;

function parseData(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function offerKeyOf(offer) {
  return offer?.offerKey || offer?.offer_key || null;
}

async function writeFleaConfig(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: FLEA_CONFIG_KEY })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: FLEA_CONFIG_KEY,
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

async function activeOwnerElsewhere(knex, excludeId, engineKeys) {
  for (const key of engineKeys) {
    const owner = await knex('services')
      .whereNot({ id: excludeId })
      .where({ is_active: true })
      .whereRaw('engine_keys @> ?::jsonb', [JSON.stringify([key])])
      .first('id');
    if (owner) return true;
  }
  return false;
}

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

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pricing_config')) {
    const row = await knex('pricing_config').where({ config_key: FLEA_CONFIG_KEY }).first();
    const data = parseData(row?.data);
    if (row && Array.isArray(data.offers) && data.offers.some((o) => offerKeyOf(o) === SINGLE_OFFER_KEY)) {
      const offers = data.offers.filter((o) => offerKeyOf(o) !== SINGLE_OFFER_KEY);
      await writeFleaConfig(knex, data, { ...data, offers }, UP_REASON);
    }
  }

  const state = { profile: null, stamped: [] };

  if (await knex.schema.hasTable('service_completion_profiles')) {
    // Profiles are keyed by service_key (no surrogate id).
    const profile = await knex('service_completion_profiles')
      .where({ service_key: SERVICE_KEY })
      .first('followup_policy', 'default_followup_days');
    if (profile && (!profile.followup_policy || profile.followup_policy === 'none')) {
      await knex('service_completion_profiles')
        .where({ service_key: SERVICE_KEY })
        .update({ followup_policy: FOLLOWUP_POLICY, default_followup_days: FOLLOWUP_DAYS, updated_at: knex.fn.now() });
      state.profile = { service_key: SERVICE_KEY, followup_policy: profile.followup_policy || null, default_followup_days: profile.default_followup_days ?? null };
    }
  }

  if (await knex.schema.hasTable('services') && await knex.schema.hasColumn('services', 'engine_keys')) {
    // Serialize the owner-check → stamp span against concurrent admin edits
    // (same reasoning as 20260825000011 / 20260826000003).
    await knex.raw('LOCK TABLE services IN SHARE ROW EXCLUSIVE MODE');
    const svc = await knex('services')
      .where({ service_key: SERVICE_KEY })
      .whereRaw('engine_keys = ?::jsonb', [JSON.stringify(OLD_ENGINE_KEYS)])
      .first('id', 'description');
    if (svc && !(await activeOwnerElsewhere(knex, svc.id, NEW_ENGINE_KEYS))) {
      const count = await knex('services')
        .where({ id: svc.id })
        .whereRaw('engine_keys = ?::jsonb', [JSON.stringify(OLD_ENGINE_KEYS)])
        .update({
          engine_keys: JSON.stringify(NEW_ENGINE_KEYS),
          ...(svc.description === OLD_DESCRIPTION ? { description: NEW_DESCRIPTION } : {}),
          updated_at: knex.fn.now(),
        });
      if (count) state.stamped.push({ id: svc.id, description: svc.description === OLD_DESCRIPTION });
    }
  }

  // A repeated up() finds everything already moved and records nothing —
  // never overwrite the first run's ownership record.
  const prior = await loadState(knex);
  await saveState(knex, {
    profile: state.profile || prior?.profile || null,
    stamped: [...new Map([...(prior?.stamped || []), ...state.stamped].filter((r) => r && r.id).map((r) => [r.id, r])).values()],
  });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('pricing_config_audit')) {
    const ownUp = await knex('pricing_config_audit')
      .where({ config_key: FLEA_CONFIG_KEY, changed_by: MIGRATION_TAG, reason: UP_REASON })
      .orderBy('id', 'desc')
      .first('old_value');
    const row = await knex('pricing_config').where({ config_key: FLEA_CONFIG_KEY }).first();
    if (ownUp && row) {
      const before = parseData(ownUp.old_value);
      const single = (before.offers || []).find((o) => offerKeyOf(o) === SINGLE_OFFER_KEY);
      const data = parseData(row.data);
      if (single && Array.isArray(data.offers) && !data.offers.some((o) => offerKeyOf(o) === SINGLE_OFFER_KEY)) {
        await writeFleaConfig(knex, data, { ...data, offers: [single, ...data.offers] }, DOWN_REASON);
      }
    }
  }

  const state = await loadState(knex);
  if (!state) return;

  if (state.profile && await knex.schema.hasTable('service_completion_profiles')) {
    // Value-guarded: an admin edit since up() survives the rollback.
    await knex('service_completion_profiles')
      .where({ service_key: SERVICE_KEY, followup_policy: FOLLOWUP_POLICY, default_followup_days: FOLLOWUP_DAYS })
      .update({
        followup_policy: state.profile.followup_policy || 'none',
        default_followup_days: state.profile.default_followup_days,
        updated_at: knex.fn.now(),
      });
  }

  if (await knex.schema.hasTable('services') && await knex.schema.hasColumn('services', 'engine_keys')) {
    for (const rec of (Array.isArray(state.stamped) ? state.stamped : [])) {
      if (!rec || !rec.id) continue;
      await knex('services')
        .where({ id: rec.id, service_key: SERVICE_KEY })
        .whereRaw('engine_keys = ?::jsonb', [JSON.stringify(NEW_ENGINE_KEYS)])
        .update({
          engine_keys: JSON.stringify(OLD_ENGINE_KEYS),
          ...(rec.description ? { description: OLD_DESCRIPTION } : {}),
          updated_at: knex.fn.now(),
        });
    }
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.REMAP = REMAP;
