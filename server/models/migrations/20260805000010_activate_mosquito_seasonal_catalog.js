/**
 * Activate Seasonal Mosquito Control in the service catalog (owner directive
 * 2026-08-05).
 *
 * `services.mosquito_seasonal` was seeded active (20260507000002) and later
 * deactivated by hand in prod — no migration records that flip. The
 * deactivation was correct at the time: the estimate converter had no
 * mosquito branch in supportsConverterFollowUpSeeding, so an accepted
 * 9-visit seasonal program booked its FIRST visit and never seeded the other
 * eight — "billed for a series they do not get". The parity migration
 * (20260724130000) documented the activation as deferred on exactly that
 * precondition ("Seasonal mosquito therefore needs converter series support
 * … BEFORE the catalog row is activated").
 *
 * That precondition was satisfied on 2026-07-27 (#3173): the converter seeds
 * seasonal_feb_oct 9-visit series (forced-cadence resolution included, so
 * the tier map's every_6_weeks frequency can't dodge the gate), the
 * recurring seeder owns the Feb–Oct date walk with Nov–Jan suppression and
 * season clamping, and an off-season reserved first visit 409s the accept.
 * The parity migration's NOT-DONE note is stale — shipped migrations are
 * never edited, so this migration is where the supersession is recorded.
 * This performs the deferred activation, under migration provenance this
 * time.
 *
 * Also corrects seeded cadence drift: the row carries frequency='monthly'
 * with visits_per_year=9 — an inconsistent pair that the schedule-lines
 * payloads and the knowledge index would republish once the row is active.
 * 'seasonal_feb_oct' is the token every consumer already normalizes
 * (recurring-appointment-seeder normalizeRecurringPattern, the client
 * modal's inferServiceCadence, the admin-customers catalog fixture). The
 * two fixes are guarded independently: a FRESH database's row is born
 * active (is_active column default) but still carries the seeded 'monthly',
 * and must receive the frequency fix alone.
 *
 * Ownership is RECORDED, not inferred (20260730160000 pattern): up()
 * persists the RAW prior value of exactly the fields it changed as a
 * system_settings state row; down() restores only what that record proves
 * this migration touched — and only while the field still holds the value
 * up() wrote — then deletes the record. No record → down() is a no-op. The
 * expected prior value rides in each update predicate and ownership derives
 * from the returning set, so an admin edit committing between our read and
 * the row lock wins the race and is never overwritten or claimed.
 *
 * An ARCHIVED row is loud-skipped ("admin-owned deactivation wins",
 * 20260718300000 convention): the owner's directive covers this row in its
 * known inactive-not-archived state; un-archiving would be a different
 * decision nobody made.
 */
const STATE_KEY = 'migration.20260805000010.state';
const SERVICE_KEY = 'mosquito_seasonal';
const SEEDED_FREQUENCY = 'monthly';
const SEASONAL_FREQUENCY = 'seasonal_feb_oct';

async function loadState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row || !row.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function saveState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  await knex('system_settings').where({ key: STATE_KEY }).del();
  await knex('system_settings').insert({
    key: STATE_KEY,
    value: JSON.stringify(state),
    category: 'migration_state',
    description: 'Rollback ownership record for 20260805000010 (mosquito_seasonal catalog activation + cadence fix). Deleted by down().',
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  // FOR UPDATE: holds off a concurrent admin edit until the migration
  // commits, so the decisions below can't run against a row that just
  // changed under them.
  const row = await knex('services').where({ service_key: SERVICE_KEY }).forUpdate().first();
  if (!row) {
    console.warn(`[mosquito-seasonal-activate] services row for ${SERVICE_KEY} not found — nothing to activate`);
    return;
  }
  if (row.is_archived === true) {
    console.warn(`[mosquito-seasonal-activate] ${SERVICE_KEY} is ARCHIVED — leaving it alone (admin decision; activation authority covers the inactive-not-archived state only)`);
    return;
  }

  const prior = {};

  // Activation — act only on a row not affirmatively active (prod holds
  // false; a NULL reads as inactive in every { is_active: true } filter).
  // The read state rides in the update predicate (whereNull for NULL —
  // `= NULL` never matches) and the claim derives from the returning set.
  if (row.is_active !== true) {
    let guard = knex('services').where({ service_key: SERVICE_KEY });
    guard = (row.is_active === null || row.is_active === undefined)
      ? guard.whereNull('is_active')
      : guard.where({ is_active: row.is_active });
    const ret = await guard.update({ is_active: true, updated_at: knex.fn.now() }, ['id']);
    if (Array.isArray(ret) && ret.length) {
      prior.is_active = row.is_active === undefined ? null : row.is_active;
    }
  }

  // Cadence drift — only while the row still carries the exact seeded
  // value; a frequency an admin tuned to anything else is theirs.
  if (row.frequency === SEEDED_FREQUENCY) {
    const ret = await knex('services')
      .where({ service_key: SERVICE_KEY, frequency: SEEDED_FREQUENCY })
      .update({ frequency: SEASONAL_FREQUENCY, updated_at: knex.fn.now() }, ['id']);
    if (Array.isArray(ret) && ret.length) prior.frequency = SEEDED_FREQUENCY;
  }

  // No record when nothing changed — down() then correctly answers for
  // nothing.
  if (Object.keys(prior).length) await saveState(knex, { prior });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  // No ownership record → this up() either never ran to completion or has
  // nothing to answer for. Restore nothing rather than guess.
  const state = await loadState(knex);
  if (!state || !state.prior || typeof state.prior !== 'object') return;
  const { prior } = state;

  // Restore only fields up() recorded changing, and only while they still
  // carry the value it wrote — a later admin edit survives rollback. The
  // expected value rides in the update predicate, same race guard as up().
  if ('is_active' in prior) {
    await knex('services')
      .where({ service_key: SERVICE_KEY, is_active: true })
      .update({
        is_active: prior.is_active === undefined ? null : prior.is_active,
        updated_at: knex.fn.now(),
      });
  }
  if ('frequency' in prior && typeof prior.frequency === 'string') {
    await knex('services')
      .where({ service_key: SERVICE_KEY, frequency: SEASONAL_FREQUENCY })
      .update({ frequency: prior.frequency, updated_at: knex.fn.now() });
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
