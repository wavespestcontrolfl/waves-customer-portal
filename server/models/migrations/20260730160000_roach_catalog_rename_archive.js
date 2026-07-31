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

// Exact-match label swap on an invoice snapshot's title + line-item
// description/category strings. AMOUNTS ARE NEVER TOUCHED. Returns null when
// nothing matches (an admin-edited title/line stays theirs).
function relabelInvoiceSnapshot(inv, fromName, toName) {
  const patch = {};
  if (inv.title === fromName) patch.title = toName;
  let items = inv.line_items;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { items = null; }
  }
  if (Array.isArray(items)) {
    let changed = false;
    const next = items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const out = { ...item };
      if (out.description === fromName) { out.description = toName; changed = true; }
      if (out.category === fromName) { out.category = toName; changed = true; }
      return out;
    });
    if (changed) patch.line_items = JSON.stringify(next);
  }
  return Object.keys(patch).length ? patch : null;
}

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
  const state = {
    renamedFields: [],
    archived: {},
    backfilledVisitIds: [],
    relabeledInvoiceIds: [],
    profileSnapshotUpdated: false,
  };

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

  // Archive — only rows affirmatively live (is_active must be true and
  // is_archived must not be true; a NULL is_archived on an active row still
  // reads as live everywhere). Record the RAW prior flag values — the
  // boolean columns are nullable, and rollback must put back exactly what
  // was there, never a coerced false.
  const knockdownRows = await knex('services').whereIn('service_key', ARCHIVE_KEYS);
  for (const kd of knockdownRows) {
    if (kd.is_active !== true || kd.is_archived === true) continue;
    state.archived[kd.service_key] = {
      is_active: kd.is_active === undefined ? null : kd.is_active,
      is_archived: kd.is_archived === undefined ? null : kd.is_archived,
      booking_enabled: kd.booking_enabled === undefined ? null : kd.booking_enabled,
      customer_visible: kd.customer_visible === undefined ? null : kd.customer_visible,
    };
    await knex('services')
      .where({ service_key: kd.service_key })
      .update({ ...ARCHIVE_PATCH, updated_at: knex.fn.now() });
  }

  // Snapshot backfills apply ONLY when the catalog row actually carries the
  // intended new name — either this migration just renamed it, or an admin
  // had already renamed it to exactly that value. If the admin renamed it to
  // a CUSTOM value, their label owns invoices/reports too; writing the
  // migration's hardcoded label would contradict the admin-wins rule.
  const catalogCarriesNewName = state.renamedFields.includes('name')
    || (row && row.name === NEW_NAME);

  // Open-visit label snapshots. Direct service_type updates fire no customer
  // communications (no scheduling columns move).
  if (catalogCarriesNewName && (await knex.schema.hasTable('scheduled_services'))) {
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

  // Pre-minted DRAFT invoices for the backfilled visits (codex #3108 r3):
  // completion REUSES a pre-minted invoice instead of rebuilding it
  // (scheduled-invoice-mint), so a draft minted before this migration would
  // complete under the old label after catalog and visit both renamed.
  // Drafts only — sent/viewed/paid/void/prepaid invoices are
  // customer-visible or terminal history and keep their snapshot. Labels
  // only (title + exact-match line-item description/category); amounts,
  // totals, and every other invoice field are never touched.
  if (state.backfilledVisitIds.length && (await knex.schema.hasTable('invoices'))) {
    const drafts = await knex('invoices')
      .whereIn('scheduled_service_id', state.backfilledVisitIds)
      .where({ status: 'draft' })
      .select('id', 'title', 'line_items');
    for (const inv of drafts) {
      const patch = relabelInvoiceSnapshot(inv, OLD_NAME, NEW_NAME);
      if (!patch) continue;
      await knex('invoices').where({ id: inv.id }).update(patch);
      state.relabeledInvoiceIds.push(inv.id);
    }
  }

  // Completion-profile snapshot (typed report labels read it via
  // serializeProfile).
  if (catalogCarriesNewName && (await knex.schema.hasTable('service_completion_profiles'))) {
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
  // it wrote, restoring each row's RECORDED prior flags verbatim — including
  // NULLs, which read differently from false in catalog queries and
  // default-visible checks.
  for (const [key, prior] of Object.entries(state.archived || {})) {
    if (!ARCHIVE_KEYS.includes(key)) continue;
    await knex('services')
      .where({ service_key: key, ...ARCHIVE_PATCH })
      .update({
        is_active: prior.is_active === undefined ? null : prior.is_active,
        is_archived: prior.is_archived === undefined ? null : prior.is_archived,
        booking_enabled: prior.booking_enabled === undefined ? null : prior.booking_enabled,
        customer_visible: prior.customer_visible === undefined ? null : prior.customer_visible,
        updated_at: knex.fn.now(),
      });
  }

  // Revert exactly the visit ids up() backfilled, where the label is still
  // the one it wrote AND the visit is still open — a visit completed since
  // up() is history now, and rewriting its label would desync it from the
  // service_records / typed-report snapshots its completion copied.
  const ids = Array.isArray(state.backfilledVisitIds) ? state.backfilledVisitIds : [];
  if (ids.length && (await knex.schema.hasTable('scheduled_services'))) {
    await knex('scheduled_services')
      .whereIn('id', ids)
      .where({ service_type: NEW_NAME })
      .whereNotIn('status', TERMINAL_VISIT_STATUSES)
      .update({ service_type: OLD_NAME });
  }

  // Reverse the recorded draft-invoice relabels — still drafts only; an
  // invoice sent/paid since up() is history under the label it went out with.
  const invoiceIds = Array.isArray(state.relabeledInvoiceIds) ? state.relabeledInvoiceIds : [];
  if (invoiceIds.length && (await knex.schema.hasTable('invoices'))) {
    const drafts = await knex('invoices')
      .whereIn('id', invoiceIds)
      .where({ status: 'draft' })
      .select('id', 'title', 'line_items');
    for (const inv of drafts) {
      const patch = relabelInvoiceSnapshot(inv, NEW_NAME, OLD_NAME);
      if (!patch) continue;
      await knex('invoices').where({ id: inv.id }).update(patch);
    }
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
