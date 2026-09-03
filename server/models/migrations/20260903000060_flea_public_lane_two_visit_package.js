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
 *    kept. Audit row written (down() never reverses it — see below).
 *
 * 2. service_completion_profiles.flea_tick — followup_policy 'none' →
 *    'alert' with default_followup_days 14: the same follow-up contract the
 *    other two-visit programs carry (cockroach_control, bed_bug_treatment),
 *    so closing out the initial visit raises the follow_up_needed bell for
 *    the package's second visit instead of nothing. 20260825000011 refused
 *    to alias flea_package onto this row precisely because it had no
 *    follow-up policy; this is what makes the alias below honest.
 *    CUTOVER IS DETERMINISTIC (a deferred flip has no consumer once knex
 *    marks the migration done): the policy flips now. A flea_tick
 *    appointment already on the books under the single-visit contract keeps
 *    everything that contract carries — the ALERT policy only PARKS a
 *    dismissible follow_up_needed card at closeout; the $0 included follow-up
 *    child is booked solely by a staff tap on that card
 *    (POST /:serviceId/schedule-followup), never automatically, and billing
 *    is untouched (followup_included stays false). The count of such open
 *    jobs is recorded in the migration state and logged so the office knows
 *    which cards to dismiss. Prod 2026-09-03 carries 0 open flea_tick jobs.
 *
 * 3. services.flea_tick — engine_keys ['flea_knockdown_single'] (stamped by
 *    20260825000011, an engine key nothing prices any more) → ['flea_package']
 *    so accepted package lines — public AND admin-sold — stamp service_id and
 *    route to the typed flea completion profile above. Same guarded pattern
 *    as 20260826000003: table lock across the check-then-stamp span, another
 *    active owner of the key elsewhere skips the stamp (no duplicate owners
 *    for the linker to refuse), the retired key is replaced IN PLACE so an
 *    operator-added alias on the row survives, ownership RECORDED by row id
 *    (with the exact before/after arrays) in system_settings, and down()
 *    reverses only recorded rows, value-guarded.
 *    The description said "full yard broadcast … interior as an add-on", the
 *    reverse of the package (interior + follow-up; yard as the add-on);
 *    rewritten to match.
 *
 * THE CUTOVER IS EXPLICITLY IRREVERSIBLE (GH codex #3845 r3 P0 + pre-push
 * P0s): every partial rollback re-creates an incoherent contract — restoring
 * the single offer / key re-enables a product whose single visits would then
 * close out under the package follow-up policy, while restoring the profile
 * strips issued package estimates of their follow-up contract. down()
 * therefore only clears the migration state and warns; the pricing offer,
 * the engine key, the description and the profile stay as up() left them.
 * A code rollback must be paired with a NEW migration that re-seeds the
 * single offer on purpose, never with this down().
 *
 * Prod 2026-09-03 (read-only): 0 estimates ever carried the single key; no
 * row claims flea_package.
 */
const FLEA_CONFIG_KEY = 'onetime_flea';
const SINGLE_OFFER_KEY = 'flea_knockdown_single';
// Stamp 20260903000060, not 000050: main already carries a 000050 migration
// (backfill_sole_property_anchor) whose system_settings state row is its
// rollback ownership record — sharing the stamp would share the state key,
// and up() below would overwrite that record while down() would delete it.
const MIGRATION_TAG = 'migration:20260903000060';
const STATE_KEY = 'migration.20260903000060.state';
const UP_REASON = 'Remove the single-visit flea knockdown offer — flea is sold only as the two-visit package (owner ruling 2026-09-03)';

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
// Terminal statuses: a job in one of these was never / will never be
// completed under the old contract, so it cannot inherit the new policy.
const CLOSED_JOB_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

// Open flea_tick appointments sold before this cutover (single-visit
// contract) — recorded + logged so their closeout cards are known to be
// dismissible (see header).
async function openLegacyFleaJobs(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return 0;
  const row = await knex('scheduled_services as ss')
    .join('services as s', 's.id', 'ss.service_id')
    .where('s.service_key', SERVICE_KEY)
    .whereNotIn('ss.status', CLOSED_JOB_STATUSES)
    .count('* as n')
    .first();
  return Number(row?.n) || 0;
}

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
    // Row lock across the read-modify-write: the admin pricing writer
    // serializes on FOR UPDATE, so an admin save racing this migration can
    // never be overwritten with a stale snapshot (GH codex #3845 r1 P1).
    const row = await knex('pricing_config').where({ config_key: FLEA_CONFIG_KEY }).forUpdate().first();
    const data = parseData(row?.data);
    if (row && Array.isArray(data.offers) && data.offers.some((o) => offerKeyOf(o) === SINGLE_OFFER_KEY)) {
      const offers = data.offers.filter((o) => offerKeyOf(o) !== SINGLE_OFFER_KEY);
      await writeFleaConfig(knex, data, { ...data, offers }, UP_REASON);
    }
  }

  const state = { profile: null, stamped: [] };

  if (await knex.schema.hasTable('service_completion_profiles')) {
    // Profiles are keyed by service_key (no surrogate id).
    // Row lock + compare-and-set: an admin edit racing this migration is
    // never overwritten (same posture as the pricing row above).
    const profile = await knex('service_completion_profiles')
      .where({ service_key: SERVICE_KEY })
      .forUpdate()
      .first('followup_policy', 'default_followup_days');
    if (profile && (!profile.followup_policy || profile.followup_policy === 'none')) {
      const openJobs = await openLegacyFleaJobs(knex);
      if (openJobs > 0) {
        console.warn(`[migration 20260903000060] ${openJobs} open flea_tick job(s) were sold as single visits: their closeout will park a follow_up_needed card — dismiss it; nothing books or bills without a staff tap.`);
      }
      const count = await knex('service_completion_profiles')
        .where({ service_key: SERVICE_KEY })
        .where((qb) => qb.whereNull('followup_policy').orWhere({ followup_policy: profile.followup_policy || 'none' }))
        .update({ followup_policy: FOLLOWUP_POLICY, default_followup_days: FOLLOWUP_DAYS, updated_at: knex.fn.now() });
      if (count) state.profile = {
        service_key: SERVICE_KEY,
        followup_policy: profile.followup_policy || null,
        default_followup_days: profile.default_followup_days ?? null,
        openLegacyJobsAtCutover: openJobs,
      };
    }
  }

  if (await knex.schema.hasTable('services') && await knex.schema.hasColumn('services', 'engine_keys')) {
    // Serialize the owner-check → stamp span against concurrent admin edits
    // (same reasoning as 20260825000011 / 20260826000003).
    await knex.raw('LOCK TABLE services IN SHARE ROW EXCLUSIVE MODE');
    // The retired key is replaced IN PLACE inside the array — an operator-
    // added alias on the same row survives, and the package still resolves
    // (GH codex #3845 r2 P0). Ownership records the exact before/after
    // arrays so down() restores the row only while it still carries what
    // up() wrote.
    const svc = await knex('services')
      .where({ service_key: SERVICE_KEY })
      .whereRaw('engine_keys @> ?::jsonb', [JSON.stringify(OLD_ENGINE_KEYS)])
      .first('id', 'description', 'engine_keys');
    const before = svc ? parseData(svc.engine_keys) : null;
    if (svc && Array.isArray(before) && !(await activeOwnerElsewhere(knex, svc.id, NEW_ENGINE_KEYS))) {
      const after = [...new Set(before.map((k) => (k === SINGLE_OFFER_KEY ? NEW_ENGINE_KEYS[0] : k)))];
      const count = await knex('services')
        .where({ id: svc.id })
        .whereRaw('engine_keys = ?::jsonb', [JSON.stringify(before)])
        .update({
          engine_keys: JSON.stringify(after),
          ...(svc.description === OLD_DESCRIPTION ? { description: NEW_DESCRIPTION } : {}),
          updated_at: knex.fn.now(),
        });
      if (count) state.stamped.push({ id: svc.id, before, after, description: svc.description === OLD_DESCRIPTION });
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
  // Irreversible by design (see header): nothing is restored. The state row
  // is cleared so a deliberate re-seed migration starts from a clean record.
  console.warn('[migration 20260903000060] rollback is a no-op by design: the flea two-visit cutover (pricing offer, catalog key, completion profile) is irreversible — re-seed the single-visit offer with a new migration if the product returns.');
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.REMAP = REMAP;
