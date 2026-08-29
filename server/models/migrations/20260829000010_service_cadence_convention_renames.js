/**
 * Catalog cadence-convention renames (owner rulings 2026-08-28, scope v4):
 * standard cadence-based catalog rows are named "<Cadence> <Family> Service"
 * with the canonical vocabulary Semiannual · Quarterly · Bi-Monthly ·
 * Every 6 Weeks · Monthly · Seasonal · Annual. Ten rows change (RENAMES);
 * rows already on the convention (quarterly/monthly pest, seasonal mosquito,
 * every Tree & Shrub row, quarterly rodent bait) are untouched. The rodent
 * family is "Rodent Bait Station", not "Rodent Monitoring".
 *
 * Same fan-out contract as 20260825000010 (copied, not imported — migrations
 * are frozen artifacts): a row is renamed ONLY while it still carries the
 * shipped name (admin edits are owner data), every dependent label snapshot
 * is relabeled with ownership recorded in a system_settings state row, and
 * down() reverses a field only while it still equals what up() wrote.
 *
 * Invariant 1 — historical immutability: open visits relabel; terminal
 *   visits (completed/cancelled/skipped/no_show), their invoices, reports,
 *   reminders and completion snapshots keep the label they closed under.
 *   `rescheduled` is a live rebook state and relabels.
 * Invariant 2 — conflict-safe rollback: compare-and-set on every table.
 *
 * Runtime side of the same PR: PR #3578's catalog-name cache learns every
 * name ever stamped on a linked visit, so history keeps displaying the old
 * label verbatim; the booking literals in slot-reservation.js already equal
 * the new names (parity test in service-cadence-convention.test.js).
 */

const STATE_KEY = 'migration.20260829000010.state';
const ALIAS_MARKER = 'alias added by migration:20260829000010 (cadence convention)';

const RENAMES = [
  ['pest_general_bimonthly', 'General Pest Control Service (Bi-Monthly)', 'Bi-Monthly Pest Control Service'],
  ['pest_general_semiannual', 'General Pest Control Service (Semiannual)', 'Semiannual Pest Control Service'],
  ['lawn_care_quarterly', 'Lawn Care Program — Quarterly', 'Quarterly Lawn Care Service'],
  ['lawn_care_recurring', 'Lawn Care Program Service', 'Bi-Monthly Lawn Care Service'],
  ['lawn_care_6week', 'Lawn Care Program — Every 6 Weeks', 'Every 6 Weeks Lawn Care Service'],
  ['lawn_care_monthly', 'Lawn Care Program — Monthly', 'Monthly Lawn Care Service'],
  ['mosquito_monthly', 'Mosquito Control Service (Monthly)', 'Monthly Mosquito Control Service'],
  ['rodent_monitoring', 'Rodent Monitoring Service (Monthly)', 'Monthly Rodent Bait Station Service'],
  ['termite_active_bait_quarterly', 'Termite Active Bait Station Service (Quarterly)', 'Quarterly Termite Active Bait Station Service'],
  ['termite_active_annual', 'Termite Active Annual Bait Station Service', 'Annual Termite Active Bait Station Service'],
];

// Visits in these states are history — their invoices/reports keep the
// label they closed under (Invariant 1). `rescheduled` is a pending-rebook
// state that can revive, so it relabels.
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

// A rename applies to the exact catalog label AND its cadence-qualified
// form ("<name> (Quarterly)" from older engine output) —
// the qualifier is preserved through the swap (codex #3484 r6 P2).
function labelMatchesRename(value, fromName) {
  const s = String(value || '');
  return s === fromName || s.startsWith(`${fromName} (`);
}
function swapRenamedPrefix(value, fromName, toName) {
  const s = String(value || '');
  if (!labelMatchesRename(s, fromName)) return null;
  return toName + s.slice(fromName.length);
}

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
// Invoice TITLES are formatted ("<label> — one-time service", multi-service
// " + "-joined) — swap the renamed label as a bounded SEGMENT, preserving
// the surrounding format (codex #3484 r9 P2). Falls back to the exact/
// qualified prefix swap for plain titles.
function swapRenamedTitle(value, fromName, toName) {
  const whole = swapRenamedPrefix(value, fromName, toName);
  if (whole) return whole;
  if (typeof value !== 'string' || !value) return null;
  const escaped = fromName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = '(?:\\s+\\+\\s+|\\s+—\\s+|,\\s+and\\s+|,\\s+|\\s+&\\s+)';
  const re = new RegExp(`(^|${boundary})${escaped}(\\s*\\([^()]*\\))?(?=$|${boundary})`, 'g');
  const next = value.replace(re, (m, pre, qualifier) => pre + toName + (qualifier || ''));
  return next === value ? null : next;
}

function relabelInvoiceSnapshot(inv, fromName, toName) {
  // Exact label OR its cadence-qualified form, qualifier preserved — same
  // matching contract as the visit/reminder relabels (codex pre-push P1).
  const swap = (v) => swapRenamedPrefix(v, fromName, toName);
  const patch = {};
  const changed = { title: false, service_type: false, items: [] };
  const nextTitle = swapRenamedTitle(inv.title, fromName, toName);
  if (nextTitle) { patch.title = nextTitle; changed.title = true; }
  const nextServiceType = swap(inv.service_type);
  if (nextServiceType) { patch.service_type = nextServiceType; changed.service_type = true; }
  const items = parseLineItems(inv.line_items);
  if (items) {
    let itemsChanged = false;
    const next = items.map((item, i) => {
      if (!item || typeof item !== 'object') return item;
      const out = { ...item };
      const rec = { i, description: false, category: false };
      const nd = swap(out.description);
      if (nd) { out.description = nd; rec.description = true; itemsChanged = true; }
      const nc = swap(out.category);
      if (nc) { out.category = nc; rec.category = true; itemsChanged = true; }
      if (rec.description || rec.category) changed.items.push(rec);
      return out;
    });
    if (itemsChanged) patch.line_items = JSON.stringify(next);
  }
  return Object.keys(patch).length ? { patch, changed } : null;
}

// Inverse restricted to a recorded `changed` map (see exemplar), with the
// same qualified-label handling as the forward swap.
function rollbackInvoiceSnapshot(inv, changed, fromName, toName) {
  const swap = (v) => swapRenamedPrefix(v, fromName, toName);
  const patch = {};
  if (changed.title) {
    const t = swapRenamedTitle(inv.title, fromName, toName);
    if (t) patch.title = t;
  }
  if (changed.service_type) {
    const st = swap(inv.service_type);
    if (st) patch.service_type = st;
  }
  const items = parseLineItems(inv.line_items);
  if (items && Array.isArray(changed.items) && changed.items.length) {
    let itemsChanged = false;
    const next = items.map((item, i) => {
      const rec = changed.items.find((r) => r && r.i === i);
      if (!rec || !item || typeof item !== 'object') return item;
      const out = { ...item };
      if (rec.description) {
        const nd = swap(out.description);
        if (nd) { out.description = nd; itemsChanged = true; }
      }
      if (rec.category) {
        const nc = swap(out.category);
        if (nc) { out.category = nc; itemsChanged = true; }
      }
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
  if (labelMatchesRename(value, fromName)) return swapRenamedPrefix(value, fromName, toName);
  const escaped = fromName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = '(?:,\\s+and\\s+|,\\s+|\\s+&\\s+)';
  // Optional cadence qualifier on the component ("… (Quarterly)") is
  // preserved through the swap (codex #3484 r6 P2).
  const re = new RegExp(`(^|${boundary})${escaped}(\\s*\\([^()]*\\))?(?=$|${boundary})`, 'g');
  const next = value.replace(re, (m, pre, qualifier) => pre + toName + (qualifier || ''));
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
    // Exact label OR cadence-qualified form ("<name>
    // (Quarterly)") — the qualifier survives the swap (codex #3484 r6 P2).
    const qualified = `${fromName} (%`;
    const linked = await knex('scheduled_services')
      .where({ service_id: row.id })
      .whereRaw('(service_type = ? OR service_type LIKE ?)', [fromName, qualified])
      .whereNotIn('status', TERMINAL_VISIT_STATUSES)
      .select('id', 'service_type', 'self_booking_id');
    const legacy = await knex('scheduled_services')
      .whereNull('service_id')
      .whereRaw('(service_type = ? OR service_type LIKE ?)', [fromName, qualified])
      .whereNotIn('status', TERMINAL_VISIT_STATUSES)
      .select('id', 'service_type', 'self_booking_id');
    // Per-row CAS updates scoped to the id + observed label + status AND
    // the population's catalog-identity predicate (codex pre-push r10 P1:
    // an admin repointing service_id between read and write must not have
    // the label overwritten and claimed) — a row appearing between read
    // and write is never renamed-but-unrecorded (r2 P1 #1).
    const relabelVisit = async (v, identityScope) => {
      const next = swapRenamedPrefix(v.service_type, fromName, toName);
      if (!next) return;
      const count = await identityScope(
        knex('scheduled_services')
          .where({ id: v.id, service_type: v.service_type })
          .whereNotIn('status', TERMINAL_VISIT_STATUSES)
      ).update({ service_type: next });
      if (count) {
        rec.visitIds.push(v.id);
        if (v.self_booking_id) visitsByBooking.set(v.id, v.self_booking_id);
      }
    };
    for (const v of linked) await relabelVisit(v, (q) => q.where({ service_id: row.id }));
    for (const v of legacy) await relabelVisit(v, (q) => q.whereNull('service_id'));
  }

  // Self-booking snapshots (booking status API renders its own copy) —
  // same exact-or-qualified matching as the visit relabel.
  if (visitsByBooking.size && (await knex.schema.hasTable('self_booked_appointments'))) {
    const sbRows = await knex('self_booked_appointments')
      .whereIn('id', [...visitsByBooking.values()])
      .select('id', 'service_type');
    // EVERY relabeled visit per booking (a booking can link several rows —
    // pre-push codex P1): down() gates the booking's reversal on ALL of
    // them still being open, never on one arbitrary sibling.
    const bookingToVisits = new Map();
    for (const [visitId, sbId] of visitsByBooking) {
      if (!bookingToVisits.has(sbId)) bookingToVisits.set(sbId, []);
      bookingToVisits.get(sbId).push(visitId);
    }
    for (const sb of sbRows) {
      const next = swapRenamedPrefix(sb.service_type, fromName, toName);
      if (!next) continue;
      const count = await knex('self_booked_appointments')
        .where({ id: sb.id, service_type: sb.service_type })
        .update({ service_type: next });
      if (count) rec.selfBookings[sb.id] = bookingToVisits.get(sb.id) || [];
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
    const addonQualified = `${fromName} (%`;
    const linkedAddons = await knex('scheduled_service_addons')
      .where({ service_id: row.id })
      .whereRaw('(service_name = ? OR service_name LIKE ?)', [fromName, addonQualified])
      .select('id', 'scheduled_service_id', 'service_name');
    const legacyAddons = await knex('scheduled_service_addons')
      .whereNull('service_id')
      .whereRaw('(service_name = ? OR service_name LIKE ?)', [fromName, addonQualified])
      .select('id', 'scheduled_service_id', 'service_name');
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
    // Same population-scoped CAS as the visit relabel (codex r10 P1).
    const relabelAddon = async (a, identityScope) => {
      if (!openParentIds.has(a.scheduled_service_id)) return;
      const next = swapRenamedPrefix(a.service_name, fromName, toName);
      if (!next) return;
      const count = await identityScope(
        knex('scheduled_service_addons').where({ id: a.id, service_name: a.service_name })
      ).update({ service_name: next });
      if (count) rec.addons[a.id] = a.scheduled_service_id;
    };
    for (const a of linkedAddons) await relabelAddon(a, (q) => q.where({ service_id: row.id }));
    for (const a of legacyAddons) await relabelAddon(a, (q) => q.whereNull('service_id'));
    rec.addonParentVisitIds = [...new Set(Object.values(rec.addons).filter(Boolean))];
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

  // UNATTACHED draft/scheduled invoices (bill-by-invoice accepts persist
  // with NULL scheduled_service_id — estimate-public leaves acceptLinkedSsId
  // null on newly selected slots), matched by their own labels since no
  // visit links them (codex #3484 r12 P2). Same CAS + frozen-statement
  // guards; recorded with a null visit so down() reverts them under the
  // still-draft guard alone.
  if (await knex.schema.hasTable('invoices')) {
    const unattached = await knex('invoices')
      .whereNull('scheduled_service_id')
      .whereIn('status', ['draft', 'scheduled'])
      .where(function labelMatch() {
        this.whereRaw('(title = ? OR title LIKE ? OR service_type = ? OR service_type LIKE ? OR line_items::text LIKE ?)',
          [fromName, `${fromName} %`, fromName, `${fromName} (%`, `%"${fromName}"%`]);
      })
      .select('id', 'title', 'line_items', 'service_type', 'payer_statement_id',
        knex.raw('updated_at::text AS updated_at_cas'));
    const frozenUnattached = await frozenPayerStatementIds(knex, unattached);
    for (const inv of unattached) {
      if (rec.invoices[inv.id]) continue;
      if (inv.payer_statement_id && frozenUnattached.has(inv.payer_statement_id)) continue;
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
      rec.invoices[inv.id] = { ...result.changed, scheduled_service_id: null };
    }
  }

  // Reminder registrations render their own service_type in the 72h/24h
  // senders. Sweep same-slot sibling rows too: the reminder merger can
  // store the combined label on the EARLIER visit's row (exemplar r5).
  if (snapshotVisitIds.length && (await knex.schema.hasTable('appointment_reminders'))) {
    const linked = await knex('appointment_reminders')
      .whereIn('scheduled_service_id', snapshotVisitIds)
      .select('id', 'service_type', 'customer_id', 'appointment_time', 'scheduled_service_id');
    // Each target carries its COMPONENT visit — the renamed visit that put
    // it in the sweep. A sibling-swept merged reminder is owned by a
    // DIFFERENT visit; recording that owner would let down() revert the
    // renamed component after ITS visit completed (codex #3484 r6 P2).
    const targets = new Map(linked.map((r) => [r.id, { rem: r, sourceVisitId: r.scheduled_service_id || null }]));
    for (const rem of linked) {
      if (rem.customer_id == null || rem.appointment_time == null) continue;
      const siblings = await knex('appointment_reminders')
        .where({ customer_id: rem.customer_id, appointment_time: rem.appointment_time })
        .select('id', 'service_type', 'customer_id', 'appointment_time', 'scheduled_service_id');
      for (const sib of siblings) {
        if (!targets.has(sib.id)) {
          targets.set(sib.id, { rem: sib, sourceVisitId: rem.scheduled_service_id || null });
        }
      }
    }
    for (const { rem, sourceVisitId } of targets.values()) {
      const next = relabelReminderServiceType(rem.service_type, fromName, toName);
      if (next === null) continue;
      const count = await knex('appointment_reminders')
        .where({ id: rem.id, service_type: rem.service_type })
        .update({ service_type: next, updated_at: knex.fn.now() });
      // The component visit rides in the record so down() can honor the
      // completed-history invariant for reminders too (codex #3484 P2).
      if (count) {
        rec.reminders[rem.id] = {
          prior: rem.service_type,
          written: next,
          scheduled_service_id: sourceVisitId,
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

// A re-run must not forget what the FIRST run changed: the record that
// actually renamed the row wins (a rename can only succeed once).
function mergeOwnershipState(prior, next) {
  if (!prior || typeof prior !== 'object') return next;
  const merged = { renames: {} };
  const keys = new Set([
    ...Object.keys(prior.renames || {}),
    ...Object.keys(next.renames || {}),
  ]);
  for (const key of keys) {
    const a = (prior.renames || {})[key];
    const b = (next.renames || {})[key];
    merged.renames[key] = (b && b.renamed) ? b : (a && a.renamed) ? a : (b || a);
  }
  return merged;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const state = { renames: {} };
  for (const [serviceKey, fromName, toName] of RENAMES) {
    state.renames[serviceKey] = await fanOutRename(knex, serviceKey, fromName, toName);
  }
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
      // Per-row reversal: cadence-qualified labels restore with their
      // qualifier intact, still value-guarded and open-only.
      const revertRows = await knex('scheduled_services')
        .whereIn('id', rec.visitIds)
        .whereNotIn('status', TERMINAL_VISIT_STATUSES)
        .select('id', 'service_type');
      for (const v of revertRows) {
        const restored = swapRenamedPrefix(v.service_type, toName, fromName);
        if (!restored) continue;
        await knex('scheduled_services')
          .where({ id: v.id, service_type: v.service_type })
          .whereNotIn('status', TERMINAL_VISIT_STATUSES)
          .update({ service_type: restored });
      }
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
      // Recorded value is a LIST of linked visit ids (a scalar from an
      // older state row is tolerated); the booking reverts only while
      // every linked visit is still open.
      const linkedVisits = (v) => (Array.isArray(v) ? v : v ? [v] : []);
      const sbTerminal = await terminalVisitIdSet(
        [...new Set(Object.values(selfBookings).flatMap(linkedVisits))]
      );
      const revertible = sbIds.filter((id) => linkedVisits(selfBookings[id]).every((visitId) => !sbTerminal.has(visitId)));
      if (revertible.length) {
        // Per-row: cadence-qualified copies restore with their qualifier.
        const sbRows = await knex('self_booked_appointments')
          .whereIn('id', revertible)
          .select('id', 'service_type');
        for (const sb of sbRows) {
          const restored = swapRenamedPrefix(sb.service_type, toName, fromName);
          if (!restored) continue;
          await knex('self_booked_appointments')
            .where({ id: sb.id, service_type: sb.service_type })
            .update({ service_type: restored });
        }
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
        // Per-row: cadence-qualified names restore with their qualifier.
        const addonRows = await knex('scheduled_service_addons')
          .whereIn('id', revertible)
          .select('id', 'service_name');
        for (const a of addonRows) {
          const restored = swapRenamedPrefix(a.service_name, toName, fromName);
          if (!restored) continue;
          await knex('scheduled_service_addons')
            .where({ id: a.id, service_name: a.service_name })
            .update({ service_name: restored });
        }
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
      // Same FOR UPDATE posture as the self-booking/add-on reversals
      // (codex #3484 r11 P2): an unlocked read can see a visit as open
      // while its completion commits, leaving the completed report on the
      // new label with its invoice restored to the old one — the lock
      // serializes the reversal behind that completion.
      const terminalVisitIds = await terminalVisitIdSet(linkedVisitIds);
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
        // Component-wise reversal on the CURRENT value (codex pre-push P1):
        // a merged reminder whose OTHER renamed component is kept (its
        // visit completed) can never equal this pass's recorded `written`
        // whole-string — reverting just this pass's component leaves the
        // kept component in place, and only rows up() recorded are touched.
        const current = await knex('appointment_reminders')
          .where({ id })
          .first('id', 'service_type');
        if (!current) continue;
        const restored = relabelReminderServiceType(current.service_type, toName, fromName);
        if (restored === null) continue;
        await knex('appointment_reminders')
          .where({ id, service_type: current.service_type })
          .update({ service_type: restored, updated_at: knex.fn.now() });
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

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

// Consumed by service-cadence-convention.test.js (literal ⇄ catalog parity)
// and the migration round-trip test.
exports.RENAMES = RENAMES;
exports.TERMINAL_VISIT_STATUSES = TERMINAL_VISIT_STATUSES;
