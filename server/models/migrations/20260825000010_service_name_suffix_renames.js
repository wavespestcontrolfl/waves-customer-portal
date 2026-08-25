/**
 * Catalog service renames — every customer-facing service name ends in
 * "Service" (owner directive 2026-08-25), and the drill-and-foam pair gets
 * its plain-English identity:
 *
 *   Drill-and-Foam Termite    → Termite Foam Service
 *   Recurring Foam Treatment  → Recurring Termite Foam Service
 *
 * plus 17 suffix renames (see RENAMES).
 *
 * This follows the catalog-rename fanout pattern established by
 * 20260730160000_roach_catalog_rename_archive (14 codex rounds), applied
 * per rename: a row is renamed ONLY while it still carries the shipped
 * name (admin edits are owner data), and every dependent label snapshot
 * that would otherwise render/deliver the old name independently is
 * relabeled with per-write ownership recorded in a `system_settings`
 * state row so down() reverses exactly what up() did:
 *
 *   - scheduled_services.service_type on OPEN visits (terminal statuses
 *     are history and keep the label their invoices/reports rendered);
 *   - linked self_booked_appointments (booking status API renders its copy);
 *   - scheduled_service_addons.service_name under OPEN parents;
 *   - draft/scheduled invoice snapshots (title / service_type / exact-match
 *     line-item labels; AMOUNTS NEVER TOUCHED; frozen payer statements
 *     skipped; optimistic updated_at::text CAS — lock-free, see exemplar);
 *   - appointment_reminders.service_type (component-wise on merged labels);
 *   - service_completion_profiles.service_name_snapshot;
 *   - protocol_template_service_types gains new-name aliases (marker-noted;
 *     down deletes ONLY marker rows).
 *
 * Prod verified 2026-08-25 (read-only): all 19 rows still carry shipped
 * names; open-visit population under old labels is 4 rows (all
 * "Cockroach Treatment"); the alias table carries no old-name rows.
 *
 * Runtime bridging for labels that still carry the OLD form (engine lines,
 * older code paths) ships in the same PR: the " Service" append candidate
 * and the foam legacy aliases in service-completion-profiles.
 */

const STATE_KEY = 'migration.20260825000010.state';
const ALIAS_MARKER = 'alias added by migration:20260825000010 (catalog rename)';

const RENAMES = [
  // service_key, shipped name (from), new name (to)
  ['foam_drill', 'Drill-and-Foam Termite', 'Termite Foam Service'],
  ['foam_recurring', 'Recurring Foam Treatment', 'Recurring Termite Foam Service'],
  ['cockroach_control', 'Cockroach Treatment', 'Cockroach Treatment Service'],
  ['german_roach', 'German Roach Cleanout', 'German Roach Cleanout Service'],
  ['german_roach_initial', 'German Roach Initial (3-Visit)', 'German Roach Initial Service (3-Visit)'],
  ['pest_termite_bait_quarterly', 'Quarterly Pest + Termite Bait Station', 'Quarterly Pest + Termite Bait Station Service'],
  ['lawn_tree_shrub_combo', 'Lawn + Tree & Shrub', 'Lawn + Tree & Shrub Service'],
  ['dethatching', 'Lawn Dethatching', 'Lawn Dethatching Service'],
  ['lawn_pest_knockdown', 'Lawn Pest Knockdown', 'Lawn Pest Knockdown Service'],
  ['plugging', 'Lawn Plugging', 'Lawn Plugging Service'],
  ['top_dressing', 'Lawn Top Dressing', 'Lawn Top Dressing Service'],
  ['bora_care', 'Bora-Care Wood Treatment', 'Bora-Care Wood Treatment Service'],
  ['trap_only_retainer_monthly', 'Monthly Trap-Only Retainer', 'Monthly Trap-Only Retainer Service'],
  ['trap_only_retainer_plus', 'Plus Trap-Only Retainer', 'Plus Trap-Only Retainer Service'],
  ['trap_only_retainer_standard', 'Standard Trap-Only Retainer', 'Standard Trap-Only Retainer Service'],
  ['rodent_guarantee', 'Rodent Guarantee', 'Rodent Guarantee Service'],
  ['rodent_wire_mesh', 'Rodent Wire Mesh Exclusion', 'Rodent Wire Mesh Exclusion Service'],
  ['rodent_bird_box', 'Roof-entry cover / bird box', 'Roof-Entry Cover / Bird Box Service'],
  ['bed_bug_treatment', 'Bed Bug Treatment', 'Bed Bug Treatment Service'],
];

// Visits in these states are history — their invoices/reports keep the
// label they closed under (same list as 20260730160000).
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
// null when nothing matches; otherwise { patch, changed } naming each field /
// item-index touched, so rollback owns EXACTLY those.
function relabelInvoiceSnapshot(inv, fromName, toName) {
  const patch = {};
  const changed = { title: false, service_type: false, items: [] };
  if (inv.title === fromName) { patch.title = toName; changed.title = true; }
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

// Inverse restricted to a recorded `changed` map (see exemplar).
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

// Component-wise swap on possibly-merged reminder labels ("A & B",
// "A, B, and C"). NOT the exemplar's tokenizer: splitting on the list
// delimiters cannot see a component that itself CONTAINS one — and this
// migration renames "Lawn + Tree & Shrub", whose " & " would shatter into
// non-matching tokens even as the reminder's sole service (codex pre-push
// P1). Instead the FULL old name is matched with delimiter/edge boundaries
// on both sides, so it swaps whether it stands alone or sits inside a
// merged list, while a longer name that merely starts with it ("… Care")
// never matches.
function relabelReminderServiceType(value, fromName, toName) {
  if (typeof value !== 'string' || !value) return null;
  if (value === fromName) return toName;
  const escaped = fromName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = '(?:,\\s+and\\s+|,\\s+|\\s+&\\s+)';
  const re = new RegExp(`(^|${boundary})${escaped}(?=$|${boundary})`, 'g');
  const next = value.replace(re, (m, pre) => pre + toName);
  return next === value ? null : next;
}

// Frozen (non-open) payer statements among these invoices' links — their
// lines render from invoices.service_type, so relabeling would change an
// issued document. DELIBERATELY LOCK-FREE (exemplar, codex #3108 r13).
async function frozenPayerStatementIds(knex, invoices) {
  const stmtIds = [...new Set(invoices.map((inv) => inv.payer_statement_id).filter(Boolean))];
  if (!stmtIds.length || !(await knex.schema.hasTable('payer_statements'))) return new Set();
  const rows = await knex('payer_statements').whereIn('id', stmtIds).select('id', 'status');
  return new Set(rows.filter((r) => r.status !== 'open').map((r) => r.id));
}

async function loadState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

async function saveState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  await knex('system_settings').where({ key: STATE_KEY }).del();
  await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
}

const updatedIdList = (ret) => (Array.isArray(ret) ? ret : [])
  .map((r) => (r && typeof r === 'object' ? r.id : r))
  .filter(Boolean);

async function fanOutRename(knex, serviceKey, fromName, toName) {
  const rec = {
    renamed: false,
    visitIds: [],
    // self-booking id → linked visit id; addon id → parent visit id. The
    // linkage rides in the record so down() can guard each reversal on the
    // linked visit still being open (codex pre-push r2 P1 #3).
    selfBookings: {},
    addons: {},
    addonParentVisitIds: [],
    invoices: {},
    reminders: {},
    profileSnapshotUpdated: false,
  };

  const row = await knex('services').where({ service_key: serviceKey }).first('id', 'name');
  if (row && row.name === fromName) {
    const count = await knex('services')
      .where({ id: row.id, name: fromName })
      .update({ name: toName, updated_at: knex.fn.now() });
    rec.renamed = count > 0;
  }
  // Snapshot relabels run only when THIS migration owns the catalog name —
  // under an admin-edited catalog row the old labels are the admin's story
  // and relabeling snapshots underneath would desync them (exemplar r12).
  if (!rec.renamed) return rec;

  // Protocol aliases: exact-string routing rows. Marker-noted inserts so
  // down() deletes ONLY rows this migration created — a pre-existing
  // new-name alias (admin-created) is never claimed.
  if (await knex.schema.hasTable('protocol_template_service_types')) {
    await knex.raw(
      `INSERT INTO protocol_template_service_types (protocol_template_id, service_type, notes)
       SELECT protocol_template_id, ?, ?
       FROM protocol_template_service_types
       WHERE service_type = ?
       ON CONFLICT (protocol_template_id, service_type) DO NOTHING`,
      [toName, ALIAS_MARKER, fromName]
    );
  }

  // Open-visit label snapshots. Direct service_type updates fire no
  // customer comms. Linked rows first, then legacy rows with no catalog
  // link still carrying the exact shipped label.
  const visitsByBooking = new Map();
  if (await knex.schema.hasTable('scheduled_services')) {
    const linked = await knex('scheduled_services')
      .where({ service_type: fromName, service_id: row.id })
      .whereNotIn('status', TERMINAL_VISIT_STATUSES)
      .select('id', 'self_booking_id');
    const legacy = await knex('scheduled_services')
      .where({ service_type: fromName })
      .whereNull('service_id')
      .whereNotIn('status', TERMINAL_VISIT_STATUSES)
      .select('id', 'self_booking_id');
    const visits = [...linked, ...legacy];
    if (visits.length) {
      // Updates are scoped to the ids the SELECT saw (plus the same value/
      // status predicates so drift between read and write isn't claimed) —
      // a visit inserted between the two statements under READ COMMITTED
      // must not be renamed-but-unrecorded, or its linked self-booking
      // would keep the old label (codex pre-push r2 P1 #1).
      const updatedLinked = linked.length
        ? await knex('scheduled_services')
          .whereIn('id', linked.map((v) => v.id))
          .where({ service_type: fromName, service_id: row.id })
          .whereNotIn('status', TERMINAL_VISIT_STATUSES)
          .update({ service_type: toName }, ['id'])
        : [];
      const updatedLegacy = legacy.length
        ? await knex('scheduled_services')
          .whereIn('id', legacy.map((v) => v.id))
          .where({ service_type: fromName })
          .whereNull('service_id')
          .whereNotIn('status', TERMINAL_VISIT_STATUSES)
          .update({ service_type: toName }, ['id'])
        : [];
      rec.visitIds = [...updatedIdList(updatedLinked), ...updatedIdList(updatedLegacy)];
      const updatedSet = new Set(rec.visitIds);
      visits.forEach((v) => {
        if (v.self_booking_id && updatedSet.has(v.id)) visitsByBooking.set(v.id, v.self_booking_id);
      });
    }
  }

  // Self-booking snapshots (booking status API renders its own copy).
  if (visitsByBooking.size && (await knex.schema.hasTable('self_booked_appointments'))) {
    const sbRows = await knex('self_booked_appointments')
      .whereIn('id', [...visitsByBooking.values()])
      .where({ service_type: fromName })
      .select('id');
    const bookingToVisit = new Map([...visitsByBooking].map(([visitId, sbId]) => [sbId, visitId]));
    for (const sb of sbRows) {
      const count = await knex('self_booked_appointments')
        .where({ id: sb.id, service_type: fromName })
        .update({ service_type: toName });
      if (count) rec.selfBookings[sb.id] = bookingToVisit.get(sb.id) || null;
    }
  }

  // Add-on label snapshots under OPEN parents (invoice generation and
  // reminder registration render service_name verbatim). Parents are
  // row-locked so a concurrent completion serializes behind the relabel.
  if (await knex.schema.hasTable('scheduled_service_addons')) {
    // Linked rows plus legacy NAME-ONLY rows (service_id is nullable and
    // name-only add-ons are first-class existing data) — their label is
    // copied verbatim into recurring children and invoices/reminders, so
    // skipping them leaves customers on the pre-rename name (codex #3484
    // r1 P2). Same linked+legacy split as the visit relabel above.
    const linkedAddons = await knex('scheduled_service_addons')
      .where({ service_id: row.id, service_name: fromName })
      .select('id', 'scheduled_service_id');
    const legacyAddons = await knex('scheduled_service_addons')
      .where({ service_name: fromName })
      .whereNull('service_id')
      .select('id', 'scheduled_service_id');
    const addons = [...linkedAddons, ...legacyAddons];
    const parentIds = [...new Set(addons.map((a) => a.scheduled_service_id).filter(Boolean))];
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
      const ret = await knex('scheduled_service_addons')
        .whereIn('id', targets.map((a) => a.id))
        .where({ service_name: fromName })
        .update({ service_name: toName }, ['id']);
      const updatedAddonSet = new Set(updatedIdList(ret));
      for (const a of targets) {
        if (updatedAddonSet.has(a.id)) rec.addons[a.id] = a.scheduled_service_id;
      }
      rec.addonParentVisitIds = [...new Set(Object.values(rec.addons).filter(Boolean))];
    }
  }

  const snapshotVisitIds = [...new Set([...rec.visitIds, ...rec.addonParentVisitIds])];

  // Pre-minted DRAFT/SCHEDULED invoices for the relabeled visits —
  // completion reuses them, and a schedule-queued invoice delivers from its
  // stored labels later. Sent/viewed/paid/void invoices are history.
  // Optimistic updated_at::text CAS, no locks (exemplar r12–r14).
  if (snapshotVisitIds.length && (await knex.schema.hasTable('invoices'))) {
    const drafts = await knex('invoices')
      .whereIn('scheduled_service_id', snapshotVisitIds)
      .whereIn('status', ['draft', 'scheduled'])
      .select('id', 'title', 'line_items', 'service_type', 'scheduled_service_id', 'payer_statement_id',
        knex.raw('updated_at::text AS updated_at_cas'));
    const frozenIds = await frozenPayerStatementIds(knex, drafts);
    for (const inv of drafts) {
      if (inv.payer_statement_id && frozenIds.has(inv.payer_statement_id)) continue;
      const result = relabelInvoiceSnapshot(inv, fromName, toName);
      if (!result) continue;
      let casQuery = knex('invoices')
        .where({ id: inv.id })
        .whereIn('status', ['draft', 'scheduled']);
      casQuery = inv.updated_at_cas == null
        ? casQuery.whereNull('updated_at')
        : casQuery.whereRaw('updated_at::text = ?', [inv.updated_at_cas]);
      const count = await casQuery.update({ ...result.patch, updated_at: knex.fn.now() });
      if (!count) continue;
      rec.invoices[inv.id] = { ...result.changed, scheduled_service_id: inv.scheduled_service_id };
    }
  }

  // Reminder registrations render their own service_type in the 72h/24h
  // senders. Sweep same-slot sibling rows too: the reminder merger can
  // store the combined label on the EARLIER visit's row (exemplar r5).
  if (snapshotVisitIds.length && (await knex.schema.hasTable('appointment_reminders'))) {
    const linked = await knex('appointment_reminders')
      .whereIn('scheduled_service_id', snapshotVisitIds)
      .select('id', 'service_type', 'customer_id', 'appointment_time', 'scheduled_service_id');
    const targets = new Map(linked.map((r) => [r.id, r]));
    for (const rem of linked) {
      if (rem.customer_id == null || rem.appointment_time == null) continue;
      const siblings = await knex('appointment_reminders')
        .where({ customer_id: rem.customer_id, appointment_time: rem.appointment_time })
        .select('id', 'service_type', 'customer_id', 'appointment_time', 'scheduled_service_id');
      for (const sib of siblings) {
        if (!targets.has(sib.id)) targets.set(sib.id, sib);
      }
    }
    for (const rem of targets.values()) {
      const next = relabelReminderServiceType(rem.service_type, fromName, toName);
      if (next === null) continue;
      const count = await knex('appointment_reminders')
        .where({ id: rem.id, service_type: rem.service_type })
        .update({ service_type: next, updated_at: knex.fn.now() });
      // The linked visit rides in the record so down() can honor the
      // completed-history invariant for reminders too (codex #3484 P2).
      if (count) {
        rec.reminders[rem.id] = {
          prior: rem.service_type,
          written: next,
          scheduled_service_id: rem.scheduled_service_id || null,
        };
      }
    }
  }

  // Completion-profile snapshot (typed report labels read it).
  if (await knex.schema.hasTable('service_completion_profiles')) {
    const updated = await knex('service_completion_profiles')
      .where({ service_key: serviceKey, service_name_snapshot: fromName })
      .update({ service_name_snapshot: toName });
    rec.profileSnapshotUpdated = updated > 0;
  }

  return rec;
}

// The roach line's DISPLAY name is DB-authoritative: db-bridge syncs
// pricing_config over the in-code constants, so the constants.js label
// updated in this PR is inert wherever pest_base carries a display block
// (prod does — verified read-only 2026-08-25). Guarded read-modify-write,
// same contract as everything else here: only a display name still carrying
// the shipped value is touched, and an audit row records the change.
const ROACH_DISPLAY_VARIANTS = ['regular', 'regular_standalone'];
const ROACH_DISPLAY_FROM = 'Cockroach Treatment';
const ROACH_DISPLAY_TO = 'Cockroach Treatment Service';

async function renameRoachDisplayNames(knex, fromName, toName) {
  if (!(await knex.schema.hasTable('pricing_config'))) return [];
  // FOR UPDATE inside the migration transaction: this is a whole-object
  // read-modify-write, so an admin pricing save landing between the read
  // and the update would be silently overwritten without the lock
  // (established pricing-config migration pattern; codex pre-push P0).
  const row = await knex('pricing_config')
    .where({ config_key: 'pest_base' })
    .forUpdate()
    .first();
  if (!row) return [];
  // Serialize the pre-change snapshot BEFORE any mutation: pg returns
  // jsonb as an object, so `row.data` and the working copy would alias —
  // the audit row would record identical old/new (codex pre-push P1).
  const oldSerialized = typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
  let data;
  try { data = JSON.parse(oldSerialized); } catch { return []; }
  const display = data?.initial_roach?.display;
  if (!display || typeof display !== 'object') return [];
  const changed = [];
  for (const variant of ROACH_DISPLAY_VARIANTS) {
    if (display[variant] && display[variant].name === fromName) {
      display[variant] = { ...display[variant], name: toName };
      changed.push(variant);
    }
  }
  if (!changed.length) return [];
  await knex('pricing_config')
    .where({ config_key: 'pest_base' })
    .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'pest_base',
      old_value: oldSerialized,
      new_value: JSON.stringify(data),
      changed_by: 'migration:20260825000010',
      reason: `Roach display name(s) [${changed.join(', ')}] "${fromName}" → "${toName}" (catalog rename parity)`,
    });
  }
  return changed;
}

// A repeated up() (manual re-run, partial-failure retry) finds the catalog
// already renamed, so its fresh records say renamed:false with empty
// snapshot lists — writing those over the first run's record would erase
// rollback ownership (codex pre-push P1). Per rename key the run that
// actually renamed the row wins (a rename can only succeed once); the
// roach-display variant list is unioned.
function mergeOwnershipState(prior, next) {
  if (!prior || typeof prior !== 'object') return next;
  const merged = { renames: {}, roachDisplayChanged: [] };
  const keys = new Set([
    ...Object.keys(prior.renames || {}),
    ...Object.keys(next.renames || {}),
  ]);
  for (const key of keys) {
    const a = (prior.renames || {})[key];
    const b = (next.renames || {})[key];
    merged.renames[key] = (b && b.renamed) ? b : (a && a.renamed) ? a : (b || a);
  }
  merged.roachDisplayChanged = [...new Set([
    ...(Array.isArray(prior.roachDisplayChanged) ? prior.roachDisplayChanged : []),
    ...(Array.isArray(next.roachDisplayChanged) ? next.roachDisplayChanged : []),
  ])];
  return merged;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const state = { renames: {} };
  for (const [serviceKey, fromName, toName] of RENAMES) {
    state.renames[serviceKey] = await fanOutRename(knex, serviceKey, fromName, toName);
  }
  state.roachDisplayChanged = await renameRoachDisplayNames(knex, ROACH_DISPLAY_FROM, ROACH_DISPLAY_TO);
  const prior = await loadState(knex);
  await saveState(knex, mergeOwnershipState(prior, state));
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  // No ownership record → up() never completed or has nothing to answer
  // for. Restore nothing rather than guess.
  const state = await loadState(knex);
  if (!state || !state.renames) return;

  // Unwind in REVERSE rename order: a reminder label containing TWO renamed
  // components was rewritten once per rename, and each recorded `written`
  // value embeds every EARLIER rename's output — forward iteration would
  // miss the first predicate and leave the label half-reverted (codex
  // pre-push r2 P1 #2).
  for (const [serviceKey, fromName, toName] of [...RENAMES].reverse()) {
    const rec = state.renames[serviceKey];
    if (!rec) continue;

    // Revert the catalog name only if up() renamed it AND it still carries
    // the written value (a later admin rename survives rollback).
    let catalogNameReverted = false;
    if (rec.renamed) {
      const count = await knex('services')
        .where({ service_key: serviceKey, name: toName })
        .update({ name: fromName, updated_at: knex.fn.now() });
      catalogNameReverted = count > 0;
    }
    // Snapshot reversals run ONLY when the catalog name itself reverted —
    // otherwise the visits/invoices/reminders must keep agreeing with the
    // catalog's current (admin-owned) story (exemplar r12).
    if (!catalogNameReverted) continue;

    if (Array.isArray(rec.visitIds) && rec.visitIds.length
      && (await knex.schema.hasTable('scheduled_services'))) {
      await knex('scheduled_services')
        .whereIn('id', rec.visitIds)
        .where({ service_type: toName })
        .whereNotIn('status', TERMINAL_VISIT_STATUSES)
        .update({ service_type: fromName });
    }

    // Self-booking and add-on reversals gate on their LINKED visit/parent
    // still being open — a visit completed since up() keeps its new
    // historical label everywhere (visit, invoice, AND these snapshots),
    // never a mixed story (codex pre-push r2 P1 #3).
    // Row-lock the linked visits while deciding revertibility (codex #3484
    // r2 P2): an unlocked read can see a parent as open while a concurrent
    // completion is capturing the new label — the lock serializes down()
    // behind that completion, mirroring up()'s forUpdate on open parents.
    const terminalVisitIdSet = async (visitIds) => new Set(
      visitIds.length && (await knex.schema.hasTable('scheduled_services'))
        ? (await knex('scheduled_services')
          .whereIn('id', visitIds)
          .forUpdate()
          .select('id', 'status'))
          .filter((v) => TERMINAL_VISIT_STATUSES.includes(v.status))
          .map((v) => v.id)
        : []
    );

    const selfBookings = rec.selfBookings && typeof rec.selfBookings === 'object' ? rec.selfBookings : {};
    const sbIds = Object.keys(selfBookings);
    if (sbIds.length && (await knex.schema.hasTable('self_booked_appointments'))) {
      const sbTerminal = await terminalVisitIdSet(
        [...new Set(Object.values(selfBookings).filter(Boolean))]
      );
      const revertible = sbIds.filter((id) => {
        const visitId = selfBookings[id];
        return !visitId || !sbTerminal.has(visitId);
      });
      if (revertible.length) {
        await knex('self_booked_appointments')
          .whereIn('id', revertible)
          .where({ service_type: toName })
          .update({ service_type: fromName });
      }
    }

    const addons = rec.addons && typeof rec.addons === 'object' ? rec.addons : {};
    const addonIds = Object.keys(addons);
    if (addonIds.length && (await knex.schema.hasTable('scheduled_service_addons'))) {
      const addonTerminal = await terminalVisitIdSet(
        [...new Set(Object.values(addons).filter(Boolean))]
      );
      const revertible = addonIds.filter((id) => {
        const parentId = addons[id];
        return !parentId || !addonTerminal.has(parentId);
      });
      if (revertible.length) {
        await knex('scheduled_service_addons')
          .whereIn('id', revertible)
          .where({ service_name: toName })
          .update({ service_name: fromName });
      }
    }

    const invoiceRecs = rec.invoices && typeof rec.invoices === 'object' ? rec.invoices : {};
    const invoiceIds = Object.keys(invoiceRecs);
    if (invoiceIds.length && (await knex.schema.hasTable('invoices'))) {
      // Only while the linked visit is still open — a visit completed since
      // up() keeps its label, and its invoice must agree with the report.
      const linkedVisitIds = [...new Set(
        Object.values(invoiceRecs).map((r) => r && r.scheduled_service_id).filter(Boolean)
      )];
      const terminalVisitIds = new Set(
        linkedVisitIds.length && (await knex.schema.hasTable('scheduled_services'))
          ? (await knex('scheduled_services')
            .whereIn('id', linkedVisitIds)
            .whereIn('status', TERMINAL_VISIT_STATUSES)
            .select('id')).map((v) => v.id)
          : []
      );
      const invoices = await knex('invoices')
        .whereIn('id', invoiceIds)
        .whereIn('status', ['draft', 'scheduled'])
        .select('id', 'title', 'line_items', 'service_type', 'payer_statement_id',
          knex.raw('updated_at::text AS updated_at_cas'));
      const frozenIds = await frozenPayerStatementIds(knex, invoices);
      for (const inv of invoices) {
        const changed = invoiceRecs[inv.id];
        if (!changed) continue;
        if (changed.scheduled_service_id && terminalVisitIds.has(changed.scheduled_service_id)) continue;
        if (inv.payer_statement_id && frozenIds.has(inv.payer_statement_id)) continue;
        const patch = rollbackInvoiceSnapshot(inv, changed, toName, fromName);
        if (!patch) continue;
        let casQuery = knex('invoices')
          .where({ id: inv.id })
          .whereIn('status', ['draft', 'scheduled']);
        casQuery = inv.updated_at_cas == null
          ? casQuery.whereNull('updated_at')
          : casQuery.whereRaw('updated_at::text = ?', [inv.updated_at_cas]);
        await casQuery.update({ ...patch, updated_at: knex.fn.now() });
      }
    }

    const reminderRecs = rec.reminders && typeof rec.reminders === 'object' ? rec.reminders : {};
    if (Object.keys(reminderRecs).length && (await knex.schema.hasTable('appointment_reminders'))) {
      // Completed-history invariant applies to reminders too (codex #3484
      // P2): a reminder whose linked visit completed since up() keeps the
      // new label in agreement with the visit/invoice/add-on snapshots.
      const reminderTerminal = await terminalVisitIdSet(
        [...new Set(Object.values(reminderRecs)
          .map((r) => r && r.scheduled_service_id)
          .filter(Boolean))]
      );
      for (const [id, r] of Object.entries(reminderRecs)) {
        if (!r || typeof r.written !== 'string' || typeof r.prior !== 'string') continue;
        if (r.scheduled_service_id && reminderTerminal.has(r.scheduled_service_id)) continue;
        await knex('appointment_reminders')
          .where({ id, service_type: r.written })
          .update({ service_type: r.prior, updated_at: knex.fn.now() });
      }
    }

    if (rec.profileSnapshotUpdated && (await knex.schema.hasTable('service_completion_profiles'))) {
      await knex('service_completion_profiles')
        .where({ service_key: serviceKey, service_name_snapshot: toName })
        .update({ service_name_snapshot: fromName });
    }

    if (await knex.schema.hasTable('protocol_template_service_types')) {
      // Only rows this migration created — identified by the notes marker.
      await knex('protocol_template_service_types')
        .where({ service_type: toName, notes: ALIAS_MARKER })
        .del();
    }
  }

  // Roach display reversal: only the variants up() recorded changing, and
  // only while they still carry the written value.
  if (Array.isArray(state.roachDisplayChanged) && state.roachDisplayChanged.length
    && (await knex.schema.hasTable('pricing_config'))) {
    // Same lock + pre-mutation snapshot rules as up() (codex pre-push
    // P0/P1): whole-object rewrite under FOR UPDATE, audit from the
    // serialized original.
    const row = await knex('pricing_config')
      .where({ config_key: 'pest_base' })
      .forUpdate()
      .first();
    const oldSerialized = row
      ? (typeof row.data === 'string' ? row.data : JSON.stringify(row.data))
      : null;
    let data = null;
    if (oldSerialized) {
      try { data = JSON.parse(oldSerialized); } catch { data = null; }
    }
    const display = data?.initial_roach?.display;
    if (display && typeof display === 'object') {
      const reverted = [];
      for (const variant of state.roachDisplayChanged) {
        if (display[variant] && display[variant].name === ROACH_DISPLAY_TO) {
          display[variant] = { ...display[variant], name: ROACH_DISPLAY_FROM };
          reverted.push(variant);
        }
      }
      if (reverted.length) {
        await knex('pricing_config')
          .where({ config_key: 'pest_base' })
          .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
        if (await knex.schema.hasTable('pricing_config_audit')) {
          await knex('pricing_config_audit').insert({
            config_key: 'pest_base',
            old_value: oldSerialized,
            new_value: JSON.stringify(data),
            changed_by: 'migration:20260825000010',
            reason: `rollback: roach display name(s) [${reverted.join(', ')}] restored to "${ROACH_DISPLAY_FROM}"`,
          });
        }
      }
    }
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

// Consumed by estimate-gap-catalog-rows-migration.test.js to compose the
// shipped 20260808080000 names with this migration's renames.
exports.RENAMES = RENAMES;
