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
// they were completed under. `rescheduled` rows are superseded by a newer
// visit row and read as non-live history throughout the lifecycle code.
// Everything else is open work the rename must reach before its invoice is
// built.
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'];

function parseLineItems(raw) {
  let items = raw;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { items = null; }
  }
  return Array.isArray(items) ? items : null;
}

// Exact-match label swap on an invoice snapshot's title, service_type, and
// line-item description/category strings. AMOUNTS ARE NEVER TOUCHED. Returns
// null when nothing matches (an admin-edited title/line stays theirs);
// otherwise { patch, changed } where `changed` names each field / item-index
// this swap touched, so rollback owns EXACTLY those (a field that already
// carried the target value beforehand is never claimed).
function relabelInvoiceSnapshot(inv, fromName, toName) {
  const patch = {};
  const changed = { title: false, service_type: false, items: [] };
  if (inv.title === fromName) { patch.title = toName; changed.title = true; }
  // service_type is its own rendered snapshot (pay/receipt APIs, invoice
  // emails, PDFs) — same exact-match rule.
  if (inv.service_type === fromName) { patch.service_type = toName; changed.service_type = true; }
  const items = parseLineItems(inv.line_items);
  if (items) {
    let itemsChanged = false;
    const next = items.map((item, i) => {
      if (!item || typeof item !== 'object') return item;
      const out = { ...item };
      const rec = { i, description: false, category: false };
      if (out.description === fromName) { out.description = toName; rec.description = true; itemsChanged = true; }
      if (out.category === fromName) { out.category = toName; rec.category = true; itemsChanged = true; }
      if (rec.description || rec.category) changed.items.push(rec);
      return out;
    });
    if (itemsChanged) patch.line_items = JSON.stringify(next);
  }
  return Object.keys(patch).length ? { patch, changed } : null;
}

// Inverse of relabelInvoiceSnapshot restricted to a recorded `changed` map:
// reverts only the fields / item-indexes up() claimed, and only where the
// current value is still the one up() wrote.
function rollbackInvoiceSnapshot(inv, changed, fromName, toName) {
  const patch = {};
  if (changed.title && inv.title === fromName) patch.title = toName;
  if (changed.service_type && inv.service_type === fromName) patch.service_type = toName;
  const items = parseLineItems(inv.line_items);
  if (items && Array.isArray(changed.items) && changed.items.length) {
    let itemsChanged = false;
    const next = items.map((item, i) => {
      const rec = changed.items.find((r) => r && r.i === i);
      if (!rec || !item || typeof item !== 'object') return item;
      const out = { ...item };
      if (rec.description && out.description === fromName) { out.description = toName; itemsChanged = true; }
      if (rec.category && out.category === fromName) { out.category = toName; itemsChanged = true; }
      return out;
    });
    if (itemsChanged) patch.line_items = JSON.stringify(next);
  }
  return Object.keys(patch).length ? patch : null;
}

// Reminder labels persist in several list formats: a single name, a pair
// "A & B" (buildServiceLabel / the sibling merger), Oxford "A, B, and C"
// (three or more services), and merged "A, B & C". Tokenize on every
// separator (", and " before ", " so the Oxford form splits correctly),
// swap exact-matching COMPONENTS only, and rejoin with the original
// separators — a name that itself contains " & " (Wasp & Hornet Control)
// splits into non-matching tokens and rejoins byte-identical.
function relabelReminderServiceType(value, fromName, toName) {
  if (typeof value !== 'string' || !value) return null;
  const tokens = value.split(/(\s+&\s+|,\s+and\s+|,\s+)/);
  const next = tokens.map((t, i) => (i % 2 === 0 && t === fromName ? toName : t)).join('');
  return next === value ? null : next;
}

// Statement ids among these invoices' payer_statement_id links whose
// statement is no longer 'open' — i.e. frozen issued billing documents.
// Locks EVERY referenced statement row (not just already-frozen ones) for
// the migration transaction: finalizeStatement starts by locking the
// statement row, so a concurrent finalization serializes behind our commit
// instead of freezing a statement whose invoice we are mid-relabel
// (codex #3108 r11).
async function frozenPayerStatementIds(knex, invoices) {
  const stmtIds = [...new Set(invoices.map((inv) => inv.payer_statement_id).filter(Boolean))];
  if (!stmtIds.length || !(await knex.schema.hasTable('payer_statements'))) return new Set();
  const rows = await knex('payer_statements')
    .whereIn('id', stmtIds)
    .forUpdate()
    .select('id', 'status');
  return new Set(rows.filter((r) => r.status !== 'open').map((r) => r.id));
}

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
    description: 'Rollback ownership record for 20260730160000 (roach catalog rename + archive). Deleted by down().',
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const state = {
    renamedFields: [],
    archived: {},
    backfilledVisitIds: [],
    relabeledSelfBookingIds: [],
    relabeledAddonIds: [],
    addonParentVisitIds: [],
    relabeledInvoices: {},
    relabeledReminders: {},
    profileSnapshotUpdated: false,
  };

  // Rename — only fields still carrying the shipped values (an admin rename
  // in the Service Library wins). The expected old value rides IN the update
  // predicate and ownership derives from the returning set, so an admin edit
  // committing between our read and the row lock wins the race too and is
  // never overwritten or claimed (codex #3108 r9).
  // FOR UPDATE: the catalogCarriesNewName decision below (which gates every
  // snapshot backfill) reads this row — locking it holds off a concurrent
  // admin rename until the migration commits, so the backfills can't run
  // against a catalog name that just changed under them (codex #3108 r10).
  const row = await knex('services').where({ service_key: RENAME_KEY }).forUpdate().first();
  if (row) {
    if (row.name === OLD_NAME) {
      const ret = await knex('services')
        .where({ service_key: RENAME_KEY, name: OLD_NAME })
        .update({ name: NEW_NAME, updated_at: knex.fn.now() }, ['id']);
      if (Array.isArray(ret) && ret.length) state.renamedFields.push('name');
    }
    if (row.short_name === OLD_SHORT_NAME) {
      const ret = await knex('services')
        .where({ service_key: RENAME_KEY, short_name: OLD_SHORT_NAME })
        .update({ short_name: NEW_NAME, updated_at: knex.fn.now() }, ['id']);
      if (Array.isArray(ret) && ret.length) state.renamedFields.push('short_name');
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
    // Same race guard as the rename: the read state rides in the update
    // predicate (whereNull for NULL flags — `= NULL` never matches) and the
    // claim derives from the returning set, so an admin archiving/editing
    // the row concurrently wins and is never claimed.
    let guard = knex('services').where({ service_key: kd.service_key });
    for (const col of ['is_active', 'is_archived', 'booking_enabled', 'customer_visible']) {
      guard = (kd[col] === null || kd[col] === undefined)
        ? guard.whereNull(col)
        : guard.where({ [col]: kd[col] });
    }
    const ret = await guard.update({ ...ARCHIVE_PATCH, updated_at: knex.fn.now() }, ['id']);
    if (!Array.isArray(ret) || !ret.length) continue;
    state.archived[kd.service_key] = {
      is_active: kd.is_active === undefined ? null : kd.is_active,
      is_archived: kd.is_archived === undefined ? null : kd.is_archived,
      booking_enabled: kd.booking_enabled === undefined ? null : kd.booking_enabled,
      customer_visible: kd.customer_visible === undefined ? null : kd.customer_visible,
    };
  }

  // Snapshot backfills apply ONLY when the catalog row actually carries the
  // intended new name — either this migration just renamed it, or an admin
  // had already renamed it to exactly that value. If the admin renamed it to
  // a CUSTOM value, their label owns invoices/reports too; writing the
  // migration's hardcoded label would contradict the admin-wins rule.
  const catalogCarriesNewName = state.renamedFields.includes('name')
    || (row && row.name === NEW_NAME);

  // Open-visit label snapshots. Direct service_type updates fire no customer
  // communications (no scheduling columns move). Scoped to visits actually
  // LINKED to the cockroach_control row — services.name is not unique, so a
  // label-only predicate could sweep another catalog entry's appointments.
  // Legacy rows with a NULL service_id relabel on the exact label match
  // (policy: the label IS the identity for pre-service_id rows; prod-verified
  // 2026-07-31 that no other catalog row shares the name and every current
  // roach visit carries the cockroach_control id).
  const selfBookingIdsByVisit = new Map();
  if (catalogCarriesNewName && row && (await knex.schema.hasTable('scheduled_services'))) {
    const linked = await knex('scheduled_services')
      .where({ service_type: OLD_NAME, service_id: row.id })
      .whereNotIn('status', TERMINAL_VISIT_STATUSES)
      .select('id', 'self_booking_id');
    const legacy = await knex('scheduled_services')
      .where({ service_type: OLD_NAME })
      .whereNull('service_id')
      .whereNotIn('status', TERMINAL_VISIT_STATUSES)
      .select('id', 'self_booking_id');
    const visits = [...linked, ...legacy];
    const ids = visits.map((v) => v.id);
    if (ids.length) {
      // Full expected prior state rides ON the update — status (a visit
      // completing concurrently keeps its completion-artifact label, codex
      // r7) AND service_type (an admin switching the visit's service
      // concurrently keeps their edit, codex r10) — and the RECORDED ids
      // come from the returning set, so a skipped visit is neither recorded
      // nor has its snapshots queued (codex r8).
      const updatedRows = await knex('scheduled_services')
        .whereIn('id', ids)
        .where({ service_type: OLD_NAME })
        .whereNotIn('status', TERMINAL_VISIT_STATUSES)
        .update({ service_type: NEW_NAME }, ['id']);
      const updatedIds = (Array.isArray(updatedRows) ? updatedRows : [])
        .map((r) => (r && typeof r === 'object' ? r.id : r))
        .filter(Boolean);
      state.backfilledVisitIds = updatedIds;
      const updatedSet = new Set(updatedIds);
      visits.forEach((v) => {
        if (v.self_booking_id && updatedSet.has(v.id)) selfBookingIdsByVisit.set(v.id, v.self_booking_id);
      });
    }
  }

  // Self-booking snapshots: the booking flow writes the same label to the
  // linked self_booked_appointments row, and /api/booking/status exposes
  // that copy directly (codex #3108 r7).
  if (selfBookingIdsByVisit.size && (await knex.schema.hasTable('self_booked_appointments'))) {
    const sbRows = await knex('self_booked_appointments')
      .whereIn('id', [...selfBookingIdsByVisit.values()])
      .where({ service_type: OLD_NAME })
      .select('id');
    for (const sb of sbRows) {
      await knex('self_booked_appointments')
        .where({ id: sb.id, service_type: OLD_NAME })
        .update({ service_type: NEW_NAME });
      state.relabeledSelfBookingIds.push(sb.id);
    }
  }

  // Pre-minted DRAFT invoices for the backfilled visits (codex #3108 r3):
  // completion REUSES a pre-minted invoice instead of rebuilding it
  // (scheduled-invoice-mint), so a draft minted before this migration would
  // complete under the old label after catalog and visit both renamed.
  // Draft AND scheduled — a schedule-queued invoice is unsent and delivers
  // from its stored title/service_type/line_items later (codex #3108 r9);
  // sent/viewed/paid/void/prepaid invoices are customer-visible or terminal
  // history and keep their snapshot. Labels only (title + exact-match
  // line-item description/category); amounts, totals, and every other
  // invoice field are never touched.
  // Cockroach-as-ADD-ON rows carry their own service_name snapshot
  // (admin-schedule snapshots the catalog name; invoice generation and
  // reminder registration render it verbatim), so an OPEN parent visit with
  // the roach add-on must relabel too (codex #3108 r5). Same scoping as
  // visits: linked to the cockroach_control row, exact old label, open
  // parent only.
  if (catalogCarriesNewName && row && (await knex.schema.hasTable('scheduled_service_addons'))) {
    const addons = await knex('scheduled_service_addons')
      .where({ service_id: row.id, service_name: OLD_NAME })
      .select('id', 'scheduled_service_id');
    const parentIds = [...new Set(addons.map((a) => a.scheduled_service_id).filter(Boolean))];
    // Row-lock the open parents for the migration transaction (knex wraps
    // up() in one): a concurrent completion of a locked parent serializes
    // behind our commit instead of racing the add-on relabel on an MVCC
    // snapshot that still saw the parent as open (codex #3108 r8).
    const openParentIds = new Set(
      parentIds.length && (await knex.schema.hasTable('scheduled_services'))
        ? (await knex('scheduled_services')
          .whereIn('id', parentIds)
          .whereNotIn('status', TERMINAL_VISIT_STATUSES)
          .forUpdate()
          .select('id')).map((v) => v.id)
        : []
    );
    const targets = addons.filter((a) => openParentIds.has(a.scheduled_service_id));
    if (targets.length) {
      // Expected prior value in the predicate + returning-derived record,
      // like every other write in this migration.
      const ret = await knex('scheduled_service_addons')
        .whereIn('id', targets.map((a) => a.id))
        .where({ service_name: OLD_NAME })
        .update({ service_name: NEW_NAME }, ['id']);
      const updatedAddonIds = (Array.isArray(ret) ? ret : [])
        .map((r) => (r && typeof r === 'object' ? r.id : r))
        .filter(Boolean);
      const updatedAddonSet = new Set(updatedAddonIds);
      state.relabeledAddonIds = updatedAddonIds;
      state.addonParentVisitIds = [...new Set(
        targets.filter((a) => updatedAddonSet.has(a.id)).map((a) => a.scheduled_service_id)
      )];
    }
  }

  // Invoices and reminders relabel for BOTH primary cockroach visits and
  // open parents of a relabeled cockroach add-on.
  const snapshotVisitIds = [...new Set([...state.backfilledVisitIds, ...state.addonParentVisitIds])];

  if (snapshotVisitIds.length && (await knex.schema.hasTable('invoices'))) {
    // Lock ORDER matters (codex #3108 r12): voidInvoice and the other
    // statement writers take the STATEMENT lock first, then the invoice —
    // taking invoice locks first here is a textbook AB/BA deadlock, and a
    // deadlock abort of a migration fails the whole deploy. So: unlocked
    // pre-read to learn the statement links → lock statements → THEN lock
    // and re-read the invoices (patches derive from the locked read; a
    // concurrent InvoiceService.update also locks the row, codex r11).
    const preRead = await knex('invoices')
      .whereIn('scheduled_service_id', snapshotVisitIds)
      .whereIn('status', ['draft', 'scheduled'])
      .select('id', 'payer_statement_id');
    // A draft already accrued to a FROZEN payer statement (anything not
    // 'open' is a finalized/issued billing document) stays untouched —
    // statement lines load live from invoices.service_type, so relabeling
    // would change a rendered issued document (codex #3108 r8).
    const frozenStatementIds = await frozenPayerStatementIds(knex, preRead);
    const drafts = preRead.length
      ? await knex('invoices')
        .whereIn('id', preRead.map((r) => r.id))
        .whereIn('status', ['draft', 'scheduled'])
        .forUpdate()
        .select('id', 'title', 'line_items', 'service_type', 'scheduled_service_id', 'payer_statement_id')
      : [];
    const checkedStmtIds = new Set(preRead.map((r) => r.payer_statement_id).filter(Boolean));
    for (const inv of drafts) {
      // Skip frozen-statement invoices AND any that accrued to a statement
      // in the pre-read → locked-read gap (that statement isn't locked or
      // status-checked — conservative skip).
      if (inv.payer_statement_id
        && (frozenStatementIds.has(inv.payer_statement_id) || !checkedStmtIds.has(inv.payer_statement_id))) continue;
      const result = relabelInvoiceSnapshot(inv, OLD_NAME, NEW_NAME);
      if (!result) continue;
      // Status rechecked ON the update (a scheduled-send claim flips the
      // status to 'sending' and delivers — that invoice is history, codex
      // #3108 r10), and the record only claims an invoice the update
      // actually hit.
      const count = await knex('invoices')
        .where({ id: inv.id })
        .whereIn('status', ['draft', 'scheduled'])
        .update(result.patch);
      if (!count) continue;
      // Per-field ownership: rollback reverts only these fields/item-indexes.
      state.relabeledInvoices[inv.id] = {
        ...result.changed,
        scheduled_service_id: inv.scheduled_service_id,
      };
    }
  }

  // Persisted reminder registrations render their own service_type verbatim
  // in the 72h/24h SMS senders — relabel rows linked to the backfilled
  // visits (exact-matching parts of possibly '&'-merged labels), recording
  // each row's prior + written value for exact rollback. Direct updates
  // send nothing; the senders are crons that read at send time.
  if (snapshotVisitIds.length && (await knex.schema.hasTable('appointment_reminders'))) {
    const linked = await knex('appointment_reminders')
      .whereIn('scheduled_service_id', snapshotVisitIds)
      .select('id', 'service_type', 'customer_id', 'appointment_time');
    // When a cockroach visit registered SECOND into a shared customer/time
    // slot, the reminder merger stores the combined label on the EARLIER
    // visit's OWNER row and suppresses the cockroach-linked row with a
    // pristine label (codex #3108 r5) — sweep same-slot sibling rows so the
    // deliverable owner relabels too. Slot fan-out is per linked reminder;
    // counts here are single digits.
    const targets = new Map(linked.map((r) => [r.id, r]));
    for (const rem of linked) {
      if (rem.customer_id == null || rem.appointment_time == null) continue;
      const siblings = await knex('appointment_reminders')
        .where({ customer_id: rem.customer_id, appointment_time: rem.appointment_time })
        .select('id', 'service_type', 'customer_id', 'appointment_time');
      for (const sib of siblings) {
        if (!targets.has(sib.id)) targets.set(sib.id, sib);
      }
    }
    for (const rem of targets.values()) {
      const next = relabelReminderServiceType(rem.service_type, OLD_NAME, NEW_NAME);
      if (next === null) continue;
      // Expected prior value in the predicate; claim only what was hit.
      const count = await knex('appointment_reminders')
        .where({ id: rem.id, service_type: rem.service_type })
        .update({ service_type: next, updated_at: knex.fn.now() });
      if (!count) continue;
      state.relabeledReminders[rem.id] = { prior: rem.service_type, written: next };
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
  // carry the value it wrote (a later admin rename survives rollback). The
  // expected value rides in the update predicate — same concurrent-admin
  // race guard as up() (codex #3108 r9).
  const row = await knex('services').where({ service_key: RENAME_KEY }).first();
  let catalogNameReverted = false;
  if (row) {
    if ((state.renamedFields || []).includes('name') && row.name === NEW_NAME) {
      const count = await knex('services')
        .where({ service_key: RENAME_KEY, name: NEW_NAME })
        .update({ name: OLD_NAME, updated_at: knex.fn.now() });
      catalogNameReverted = count > 0;
    }
    if ((state.renamedFields || []).includes('short_name') && row.short_name === NEW_NAME) {
      await knex('services')
        .where({ service_key: RENAME_KEY, short_name: NEW_NAME })
        .update({ short_name: OLD_SHORT_NAME, updated_at: knex.fn.now() });
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
  // Snapshot reversals run ONLY when the catalog name itself reverted
  // (codex #3108 r12): when an admin pre-renamed the catalog (or re-renamed
  // it after up()), the catalog keeps its name through rollback — reverting
  // the visit/invoice/reminder/profile snapshots underneath it would desync
  // completion reports (dispatch prefers completionProfile.serviceName).
  const ids = catalogNameReverted && Array.isArray(state.backfilledVisitIds) ? state.backfilledVisitIds : [];
  if (ids.length && (await knex.schema.hasTable('scheduled_services'))) {
    await knex('scheduled_services')
      .whereIn('id', ids)
      .where({ service_type: NEW_NAME })
      .whereNotIn('status', TERMINAL_VISIT_STATUSES)
      .update({ service_type: OLD_NAME });
  }

  // Reverse the recorded invoice relabels — per recorded field only, still
  // draft/scheduled only (an invoice sent/paid since up() is history under
  // the label it went out with), and only while the LINKED VISIT is still open:
  // a visit completed since up() keeps its new label (visit rollback above
  // skips terminal rows), and its deliberately-still-draft invoice must
  // agree with the completed visit and report, not flip back.
  const relabeledInvoices = catalogNameReverted && state.relabeledInvoices && typeof state.relabeledInvoices === 'object'
    ? state.relabeledInvoices
    : {};
  const invoiceIds = Object.keys(relabeledInvoices);
  if (invoiceIds.length && (await knex.schema.hasTable('invoices'))) {
    const linkedVisitIds = [...new Set(
      Object.values(relabeledInvoices).map((rec) => rec && rec.scheduled_service_id).filter(Boolean)
    )];
    const terminalVisitIds = new Set(
      linkedVisitIds.length && (await knex.schema.hasTable('scheduled_services'))
        ? (await knex('scheduled_services')
          .whereIn('id', linkedVisitIds)
          .forUpdate()
          .select('id', 'status')).filter((v) => TERMINAL_VISIT_STATUSES.includes(v.status)).map((v) => v.id)
        : []
    );
    // Same statement-before-invoice lock ORDER as up() (codex r12 — the
    // reverse order deadlocks against voidInvoice), then the same row locks
    // for patch derivation.
    const preRead = await knex('invoices')
      .whereIn('id', invoiceIds)
      .whereIn('status', ['draft', 'scheduled'])
      .select('id', 'payer_statement_id');
    // Same frozen-statement rule on the way back: a draft that accrued to a
    // finalized statement since up() is part of an issued document now.
    const frozenStatementIds = await frozenPayerStatementIds(knex, preRead);
    const checkedStmtIds = new Set(preRead.map((r) => r.payer_statement_id).filter(Boolean));
    const drafts = preRead.length
      ? await knex('invoices')
        .whereIn('id', preRead.map((r) => r.id))
        .whereIn('status', ['draft', 'scheduled'])
        .forUpdate()
        .select('id', 'title', 'line_items', 'service_type', 'scheduled_service_id', 'payer_statement_id')
      : [];
    for (const inv of drafts) {
      const rec = relabeledInvoices[inv.id];
      if (!rec) continue;
      if (terminalVisitIds.has(rec.scheduled_service_id) || terminalVisitIds.has(inv.scheduled_service_id)) continue;
      if (inv.payer_statement_id
        && (frozenStatementIds.has(inv.payer_statement_id) || !checkedStmtIds.has(inv.payer_statement_id))) continue;
      const patch = rollbackInvoiceSnapshot(inv, rec, NEW_NAME, OLD_NAME);
      if (!patch) continue;
      await knex('invoices')
        .where({ id: inv.id })
        .whereIn('status', ['draft', 'scheduled'])
        .update(patch);
    }
  }

  // Revert the recorded self-booking relabels — only rows still carrying
  // what up() wrote, and only while the linked visit is still open (the
  // visit rollback above keeps terminal rows on the new label).
  const selfBookingIds = catalogNameReverted && Array.isArray(state.relabeledSelfBookingIds) ? state.relabeledSelfBookingIds : [];
  if (selfBookingIds.length && (await knex.schema.hasTable('self_booked_appointments'))
    && (await knex.schema.hasTable('scheduled_services'))) {
    const openLinkedSb = new Set(
      (await knex('scheduled_services')
        .whereIn('self_booking_id', selfBookingIds)
        .whereNotIn('status', TERMINAL_VISIT_STATUSES)
        .forUpdate()
        .select('self_booking_id')).map((v) => v.self_booking_id)
    );
    const revertSb = selfBookingIds.filter((id) => openLinkedSb.has(id));
    if (revertSb.length) {
      await knex('self_booked_appointments')
        .whereIn('id', revertSb)
        .where({ service_type: NEW_NAME })
        .update({ service_type: OLD_NAME });
    }
  }

  // Revert the recorded add-on relabels — same policy as visits: a parent
  // that went terminal since up() completed under the new label, and its
  // add-on snapshot stays with it.
  const addonIds = catalogNameReverted && Array.isArray(state.relabeledAddonIds) ? state.relabeledAddonIds : [];
  if (addonIds.length && (await knex.schema.hasTable('scheduled_service_addons'))) {
    const addons = await knex('scheduled_service_addons')
      .whereIn('id', addonIds)
      .where({ service_name: NEW_NAME })
      .select('id', 'scheduled_service_id');
    const parentIds = [...new Set(addons.map((a) => a.scheduled_service_id).filter(Boolean))];
    const terminalParents = new Set(
      parentIds.length && (await knex.schema.hasTable('scheduled_services'))
        // FOR UPDATE mirrors up()'s parent lock: a parent completing
        // concurrently serializes behind the rollback commit instead of
        // snapshotting the new label while we revert its add-on (codex r11).
        ? (await knex('scheduled_services')
          .whereIn('id', parentIds)
          .forUpdate()
          .select('id', 'status')).filter((v) => TERMINAL_VISIT_STATUSES.includes(v.status)).map((v) => v.id)
        : []
    );
    const revertIds = addons.filter((a) => !terminalParents.has(a.scheduled_service_id)).map((a) => a.id);
    if (revertIds.length) {
      await knex('scheduled_service_addons')
        .whereIn('id', revertIds)
        .update({ service_name: OLD_NAME });
    }
  }

  // Restore reminder labels to their recorded prior value — only where the
  // row still carries exactly what up() wrote.
  const relabeledReminders = catalogNameReverted && state.relabeledReminders && typeof state.relabeledReminders === 'object'
    ? state.relabeledReminders
    : {};
  if (Object.keys(relabeledReminders).length && (await knex.schema.hasTable('appointment_reminders'))) {
    for (const [id, rec] of Object.entries(relabeledReminders)) {
      if (!rec || typeof rec.prior !== 'string' || typeof rec.written !== 'string') continue;
      await knex('appointment_reminders')
        .where({ id, service_type: rec.written })
        .update({ service_type: rec.prior, updated_at: knex.fn.now() });
    }
  }

  if (catalogNameReverted && state.profileSnapshotUpdated && (await knex.schema.hasTable('service_completion_profiles'))) {
    await knex('service_completion_profiles')
      .where({ service_key: RENAME_KEY, service_name_snapshot: NEW_NAME })
      .update({ service_name_snapshot: OLD_NAME });
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
