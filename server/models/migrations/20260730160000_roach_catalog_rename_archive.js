/**
 * Roach catalog cleanup (owner directive 2026-07-30, follow-up to #3078).
 *
 * #3078 renamed the customer-facing estimate line to "Cockroach Treatment";
 * scheduling/invoice surfaces read the Service Library instead. Owner ruling:
 * the existing `cockroach_control` row IS the roach booking service (10 real
 * scheduled visits; the two `pest_initial_*_knockdown` rows have zero
 * scheduled_services / service_records ever and no live code references) —
 * so rename it for word-for-word estimate↔invoice parity and archive the two
 * orphaned knockdown rows rather than renaming them.
 *
 * Label SNAPSHOTS are renamed too (codex #3108 r1): open scheduled visits
 * carry `scheduled_services.service_type` verbatim into invoices, and the
 * completion profile's `service_name_snapshot` labels typed reports —
 * without the backfill the rename never reaches work booked before it.
 * Completed/terminal visits keep their historical label.
 *
 * Ownership is RECORDED, not inferred (codex #3108 r1): up() persists
 * exactly what it changed — which name fields, which rows it archived (with
 * their prior flags), which visit ids it backfilled — as a
 * `system_settings` state row, and down() restores ONLY what that record
 * proves this migration touched, then deletes it. No record → down() is a
 * no-op. A pre-migration admin rename/archive is therefore never reverted,
 * and a pre-hidden row is never re-exposed by rollback.
 */
const STATE_KEY = 'migration.20260730160000.state';
const RENAME_KEY = 'cockroach_control';
const OLD_NAME = 'Cockroach Control Service';
const NEW_NAME = 'Cockroach Treatment';
const OLD_SHORT_NAME = 'Cockroach Control';
const ARCHIVE_KEYS = ['pest_initial_palmetto_knockdown', 'pest_initial_german_knockdown'];
const ARCHIVE_PATCH = {
  is_active: false,
  is_archived: true,
  booking_enabled: false,
  customer_visible: false,
};
// Visits in these states are history — their invoices/reports keep the label
// they were completed under. Everything else is open work the rename must
// reach before its invoice is built.
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

async function loadState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row || !row.value) return null;
  try {
    return JSON.parse(row.value);
  } catch (err) {
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
    description: 'Rollback ownership record for 20260730160000 (roach catalog rename + archive). Deleted by down().',
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const state = { renamedFields: [], archived: {}, backfilledVisitIds: [], profileSnapshotUpdated: false };

  // Rename — only fields still carrying the shipped values (an admin rename
  // in the Service Library wins), and record which fields we touched.
  const row = await knex('services').where({ service_key: RENAME_KEY }).first();
  if (row) {
    const patch = {};
    if (row.name === OLD_NAME) { patch.name = NEW_NAME; state.renamedFields.push('name'); }
    if (row.short_name === OLD_SHORT_NAME) { patch.short_name = NEW_NAME; state.renamedFields.push('short_name'); }
    if (Object.keys(patch).length) {
      await knex('services')
        .where({ service_key: RENAME_KEY })
        .update({ ...patch, updated_at: knex.fn.now() });
    }
  }

  // Archive — only rows still fully live, recording each row's prior
  // visibility flags so down() can put back exactly what was there.
  const knockdownRows = await knex('services').whereIn('service_key', ARCHIVE_KEYS);
  for (const kd of knockdownRows) {
    if (!kd.is_active || kd.is_archived) continue;
    state.archived[kd.service_key] = {
      booking_enabled: kd.booking_enabled === true,
      customer_visible: kd.customer_visible === true,
    };
    await knex('services')
      .where({ service_key: kd.service_key })
      .update({ ...ARCHIVE_PATCH, updated_at: knex.fn.now() });
  }

  // Open-visit label snapshots. Direct service_type updates fire no customer
  // communications (no scheduling columns move).
  if (await knex.schema.hasTable('scheduled_services')) {
    const visits = await knex('scheduled_services')
      .where({ service_type: OLD_NAME })
      .whereNotIn('status', TERMINAL_VISIT_STATUSES)
      .select('id');
    const ids = visits.map((v) => v.id);
    if (ids.length) {
      await knex('scheduled_services').whereIn('id', ids).update({ service_type: NEW_NAME });
      state.backfilledVisitIds = ids;
    }
  }

  // Completion-profile snapshot (typed report labels read it via
  // serializeProfile).
  if (await knex.schema.hasTable('service_completion_profiles')) {
    const updated = await knex('service_completion_profiles')
      .where({ service_key: RENAME_KEY, service_name_snapshot: OLD_NAME })
      .update({ service_name_snapshot: NEW_NAME });
    state.profileSnapshotUpdated = updated > 0;
  }

  await saveState(knex, state);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  // No ownership record → this up() either never ran to completion or has
  // nothing to answer for. Restore nothing rather than guess.
  const state = await loadState(knex);
  if (!state) return;

  // Restore only the fields up() recorded changing, and only if they still
  // carry the value it wrote (a later admin rename survives rollback).
  const row = await knex('services').where({ service_key: RENAME_KEY }).first();
  if (row) {
    const patch = {};
    if ((state.renamedFields || []).includes('name') && row.name === NEW_NAME) patch.name = OLD_NAME;
    if ((state.renamedFields || []).includes('short_name') && row.short_name === NEW_NAME) patch.short_name = OLD_SHORT_NAME;
    if (Object.keys(patch).length) {
      await knex('services')
        .where({ service_key: RENAME_KEY })
        .update({ ...patch, updated_at: knex.fn.now() });
    }
  }

  // Re-activate only rows up() archived, only if still in the archived state
  // it wrote, restoring each row's RECORDED prior flags.
  for (const [key, prior] of Object.entries(state.archived || {})) {
    if (!ARCHIVE_KEYS.includes(key)) continue;
    await knex('services')
      .where({ service_key: key, ...ARCHIVE_PATCH })
      .update({
        is_active: true,
        is_archived: false,
        booking_enabled: prior.booking_enabled === true,
        customer_visible: prior.customer_visible === true,
        updated_at: knex.fn.now(),
      });
  }

  // Revert exactly the visit ids up() backfilled, where the label is still
  // the one it wrote.
  const ids = Array.isArray(state.backfilledVisitIds) ? state.backfilledVisitIds : [];
  if (ids.length && (await knex.schema.hasTable('scheduled_services'))) {
    await knex('scheduled_services')
      .whereIn('id', ids)
      .where({ service_type: NEW_NAME })
      .update({ service_type: OLD_NAME });
  }

  if (state.profileSnapshotUpdated && (await knex.schema.hasTable('service_completion_profiles'))) {
    await knex('service_completion_profiles')
      .where({ service_key: RENAME_KEY, service_name_snapshot: NEW_NAME })
      .update({ service_name_snapshot: OLD_NAME });
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
