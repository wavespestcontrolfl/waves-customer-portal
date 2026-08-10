/**
 * Un-archive Seasonal Mosquito Control so it reaches the catalog (owner
 * directive 2026-08-10: "I just don't see seasonal mosquito service … I
 * thought we created this").
 *
 * WHY 20260805000010 DID NOT ALREADY DO THIS. That migration carried the
 * 2026-08-05 activation directive and shipped in #3277, but its first guard
 * is a loud skip on `is_archived === true` ("admin-owned deactivation wins")
 * — and it returns BEFORE both the activation and the cadence fix. The
 * `services` catalog has exactly one hand-deactivation path,
 * `DELETE /api/admin/services/:id` → `service-library.deactivateService`,
 * which writes `is_active: false` and `is_archived: true` in the SAME
 * statement (`updateService` does likewise whenever `is_archived` goes
 * true). So the "deactivated by hand in prod" state 20260805000010 was
 * written against is NECESSARILY archived, and the guard it added for
 * admin-owned archives swallowed the very row it was written to activate.
 * It ran on deploy, logged its warning, and changed nothing. Symptom: the
 * appointment editor's picker (`/admin/schedule/services-dropdown`, which
 * selects `where is_active = true`) shows Mosquito (2) — monthly and
 * one-time only — while `priceMosquito` keeps recommending the `seasonal9`
 * tier, so an accepted seasonal quote still has no active row to book
 * against.
 *
 * The archived-skip was the right DEFAULT and stays in place for every
 * other row; this migration carries the owner's explicit decision for THIS
 * one, which is what 20260805000010 said was missing ("un-archiving would
 * be a different decision nobody made"). The safety precondition is
 * unchanged and still met: the estimate converter seeds the seasonal_feb_oct
 * 9-visit series (#3173, 2026-07-27), so activation can no longer sell a
 * program that books one visit and never seeds the other eight.
 *
 * Consequences the owner confirmed 2026-08-10 (fully sellable): an active
 * row with `booking_enabled` is offered by `loadBookableCallServices`
 * (call booking) and, with `customer_visible`, by the public MCP surface —
 * both intended, since the pricing engine already quotes this program.
 *
 * FIELDS. Un-archive and activate, plus the cadence drift 20260805000010
 * never reached: the row still carries `frequency = 'monthly'` with
 * `visits_per_year = 9`, an inconsistent pair the schedule-lines payloads
 * and the knowledge index would republish once the row is live.
 * 'seasonal_feb_oct' is the token every consumer already normalizes
 * (recurring-appointment-seeder `normalizeRecurringPattern`, the edit
 * modal's `inferServiceCadence`, `EDIT_FREQUENCIES`). `visits_per_year` is
 * already 9 and is not touched. Note the Service Library's own "Restore
 * service" button sends only `{is_archived: false, is_active: true}` — it
 * cannot fix the cadence, so the restore has to happen here to land both.
 *
 * Ownership is RECORDED, not inferred (20260805000010 / 20260730160000
 * pattern): up() persists the RAW prior value of exactly the fields it
 * changed as a system_settings row; down() restores only what that record
 * proves this migration touched — and only while the field still holds the
 * value up() wrote — then deletes the record. No record → down() is a
 * no-op. The expected prior value rides in each update predicate and
 * ownership derives from the returning set, so an admin edit committing
 * between our read and the row lock wins the race and is never overwritten
 * or claimed. A row already correct (20260805000010 having found it
 * un-archived, or an admin having restored it by hand) makes this a
 * recordless no-op in every field.
 */
const STATE_KEY = 'migration.20260810000020.state';
const SERVICE_KEY = 'mosquito_seasonal';
const SEEDED_FREQUENCY = 'monthly';
const SEASONAL_FREQUENCY = 'seasonal_feb_oct';
// Sellability flags. Seeded true (20260507000002) and untouched by both
// archive paths, so these are expected to be no-ops — they are asserted
// rather than assumed so "fully sellable" cannot depend on a flag nobody
// checked. Guarded by hasColumn: a missing column must not throw, because
// migrations are Railway's pre-deploy command and one failure blocks EVERY
// deploy.
const SELLABLE_FLAGS = ['booking_enabled', 'customer_visible'];

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
    description: 'Rollback ownership record for 20260810000020 (mosquito_seasonal un-archive + activation + cadence fix). Deleted by down().',
  });
}

// Flip `column` to true only while it still holds the exact value read into
// `row`, recording the raw prior. NULL needs whereNull — `= NULL` never
// matches — and is recorded as null so down() restores the real prior state.
async function claimTrue(knex, row, column, prior) {
  if (row[column] === true) return;
  let guard = knex('services').where({ service_key: SERVICE_KEY });
  guard = (row[column] === null || row[column] === undefined)
    ? guard.whereNull(column)
    : guard.where({ [column]: row[column] });
  const ret = await guard.update({ [column]: true, updated_at: knex.fn.now() }, ['id']);
  if (Array.isArray(ret) && ret.length) {
    prior[column] = row[column] === undefined ? null : row[column];
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  // FOR UPDATE: holds off a concurrent admin edit until the migration
  // commits, so the decisions below can't run against a row that just
  // changed under them.
  const row = await knex('services').where({ service_key: SERVICE_KEY }).forUpdate().first();
  if (!row) {
    console.warn(`[mosquito-seasonal-unarchive] services row for ${SERVICE_KEY} not found — nothing to un-archive`);
    return;
  }

  const prior = {};

  // Un-archive, then activate. Both are independently guarded: a row that
  // 20260805000010 already activated (never archived) still gets nothing
  // done to it here.
  if (row.is_archived === true) {
    const ret = await knex('services')
      .where({ service_key: SERVICE_KEY, is_archived: true })
      .update({ is_archived: false, updated_at: knex.fn.now() }, ['id']);
    if (Array.isArray(ret) && ret.length) prior.is_archived = true;
  }

  await claimTrue(knex, row, 'is_active', prior);

  // Cadence drift — only while the row still carries the exact seeded
  // value; a frequency an admin tuned to anything else is theirs.
  if (row.frequency === SEEDED_FREQUENCY) {
    const ret = await knex('services')
      .where({ service_key: SERVICE_KEY, frequency: SEEDED_FREQUENCY })
      .update({ frequency: SEASONAL_FREQUENCY, updated_at: knex.fn.now() }, ['id']);
    if (Array.isArray(ret) && ret.length) prior.frequency = SEEDED_FREQUENCY;
  }

  for (const flag of SELLABLE_FLAGS) {
    if (!(await knex.schema.hasColumn('services', flag))) continue;
    await claimTrue(knex, row, flag, prior);
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
  for (const column of ['is_active', ...SELLABLE_FLAGS]) {
    if (!(column in prior)) continue;
    if (!(await knex.schema.hasColumn('services', column))) continue;
    await knex('services')
      .where({ service_key: SERVICE_KEY, [column]: true })
      .update({
        [column]: prior[column] === undefined ? null : prior[column],
        updated_at: knex.fn.now(),
      });
  }

  if (prior.is_archived === true) {
    await knex('services')
      .where({ service_key: SERVICE_KEY, is_archived: false })
      .update({ is_archived: true, updated_at: knex.fn.now() });
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
