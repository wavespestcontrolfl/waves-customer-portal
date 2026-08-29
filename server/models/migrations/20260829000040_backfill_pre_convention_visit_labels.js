/**
 * Backfill pre-convention visit labels (owner GO 2026-08-29, service-name
 * audit). Companion to 20260829000010: that migration relabeled open visits
 * still carrying the ten SHIPPED pre-rename catalog names; this one covers
 * the older generation of labels stamped before those names existed —
 * unlinked legacy series ("Quarterly Pest Control", "Lawn Care", "General
 * Pest Control (Quarterly)", …) and linked rows whose snapshot predates the
 * current catalog name. Prod pre-read 2026-08-29: 214 unlinked + 11 linked
 * open rows across ~65 customers, every one with a reminder row.
 *
 * Same invariants as 20260829000010:
 *  1. Historical immutability — only OPEN visits relabel (NULL status is
 *     open; `rescheduled` is a live rebook state and relabels). Terminal
 *     visits keep the label they closed under.
 *  2. Conflict-safe rollback — per-row compare-and-set both directions,
 *     with the observed labels AND the population identity (cadence /
 *     linkage) recorded in a system_settings state row, so down() never
 *     reverses a row the owner re-cadenced or linked in the meantime
 *     (GH codex #3599 r1 P2). Every snapshot copy reverts only when its
 *     component visit's OWN reversal succeeded (r3 P2) — the visit and its
 *     copies never tell a mixed story.
 *
 * Leg A (unlinked): a (label, recurring_pattern) pair maps to exactly one
 *   current catalog name; the pair is the cadence evidence, so no guess is
 *   involved. A mapping whose target name is missing from the active
 *   catalog is skipped (fail closed), never written blind.
 * Leg B (linked): the row already knows its service; the label syncs from
 *   services.name — but ONLY for labels on the known-stale whitelist, so a
 *   deliberate custom label is never clobbered. The whitelist is further
 *   filtered AT RUN TIME against the active catalog: a whitelisted label
 *   that is itself a current catalog name is a linkage conflict, not a
 *   stale snapshot, and is left for the owner (r1 P2; prod pre-read: no
 *   collision today — insurance against a future catalog edit). Rows whose
 *   label is any other valid catalog name contradicting their service_id
 *   are likewise excluded — flagged in the audit instead.
 * Add-ons (r3 P1): scheduled_service_addons.service_name is copied
 *   verbatim into invoice line items, reminder labels and recurring
 *   children. Under an OPEN parent (row-locked), a linked add-on syncs
 *   from services.name under the same whitelist; a name-only add-on maps
 *   through the (label, PARENT cadence) pair — the parent's
 *   recurring_pattern is the add-on's cadence evidence.
 *
 * Snapshot fanout (r1 P1, r2 P1/P2, r3 P1/P2) — the customer-facing copies
 *   000010 sweeps, each by the same mechanism, for every relabeled visit
 *   and every open parent of a relabeled add-on:
 *   - appointment_reminders.service_type: the label the public appointment
 *     page PREFERS (appointment-public.js resolveServiceLabel) and the
 *     72h/24h senders render. The visit's own row plus same-slot siblings
 *     (the merger stores the combined label on the EARLIER visit's row)
 *     swap component-wise, so a merged "A & B" keeps its other component.
 *     Siblings are selected under the merger's own live predicate
 *     (appointment-reminders.js buildMergedServiceLabel): not cancelled,
 *     not a windowless placeholder, and either legacy-unlinked or linked
 *     to a sendable visit — a parked historical row is never rewritten.
 *   - self_booked_appointments.service_type: /api/booking/status/:code
 *     renders its own copy; exact-or-qualified swap.
 *   - Pre-minted DRAFT/SCHEDULED invoices: completion reuses them and a
 *     schedule-queued invoice delivers its stored labels later
 *     (invoice-email.js renders invoice.service_type). Title /
 *     service_type / line-item snapshots swap under an updated_at::text
 *     CAS; invoices on a frozen (non-open) payer statement are an issued
 *     document and stay. UNATTACHED drafts (bill-by-invoice accepts leave
 *     scheduled_service_id NULL) are matched by their own labels, but ONLY
 *     for labels with exactly one target across the whole relabel — a bare
 *     "Pest Control" or "Lawn Care" without a visit's cadence is a guess.
 *
 * Deliberately out of scope: backfilling service_id linkage on legacy rows
 * (would activate per-service closeout/report requirements — separate
 * owner decision), and terminal series parents — they keep their
 * closed-under label per Invariant 1, so a child generated FROM a terminal
 * parent (admin-schedule.js copies parent.service_type verbatim) is still
 * born with the old label. Closing that requires the generator to resolve
 * the catalog name at insert time — follow-up, not a data backfill.
 */

const STATE_KEY = 'migration.20260829000040.state';

// Copied from 20260829000010 (migrations are frozen artifacts — no import).
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];
const MUTABLE_INVOICE_STATUSES = ['draft', 'scheduled'];
// The merger's sendable set (appointment-reminders.js buildMergedServiceLabel).
const SENDABLE_VISIT_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

// (stale label, recurring_pattern) → current catalog name. The pattern is
// load-bearing: "Pest Control" alone is ambiguous, "Pest Control" +
// quarterly is not. Prod pre-read row counts in the PR body.
const UNLINKED_MAPPING = [
  ['Quarterly Pest Control', 'quarterly', 'Quarterly Pest Control Service'],
  ['Pest Control', 'quarterly', 'Quarterly Pest Control Service'],
  ['General Pest Control (Quarterly)', 'quarterly', 'Quarterly Pest Control Service'],
  ['General Pest Control', 'quarterly', 'Quarterly Pest Control Service'],
  ['General Pest Control (Semiannual)', 'semiannual', 'Semiannual Pest Control Service'],
  ['General Pest Control (Bi-Monthly)', 'bimonthly', 'Bi-Monthly Pest Control Service'],
  ['Pest Control', 'monthly', 'Monthly Pest Control Service'],
  ['Lawn Care', 'monthly_nth_weekday', 'Monthly Lawn Care Service'],
  ['Lawn Care', 'every_6_weeks', 'Every 6 Weeks Lawn Care Service'],
  ['Lawn Care Service', 'bimonthly', 'Bi-Monthly Lawn Care Service'],
];

// Labels that carry their cadence in the text — the only ones an UNATTACHED
// draft (no visit, no linkage) can be relabeled from without guessing.
// Each must map to exactly one target above; the sweep re-checks that.
const UNATTACHED_LABELS = [
  'Quarterly Pest Control',
  'General Pest Control (Quarterly)',
  'General Pest Control (Semiannual)',
  'General Pest Control (Bi-Monthly)',
];

// Linked rows relabel from their own services.name, but only while carrying
// one of these known-stale generics (never a deliberate custom label, and
// never a label that is itself a current catalog name — that's a linkage
// conflict for the owner, not a snapshot to overwrite; enforced at run time
// against the active catalog, see activeCatalogNames()).
const LINKED_STALE_LABELS = [
  'Pest Control',
  'Pest Control Service',
  'General Pest Control',
  'General Pest Control (Quarterly)',
  'Quarterly Pest Control',
  'Lawn Care Service',
  'Lawn Care Visit',
];

function openVisitStatus(q) {
  return q.where((b) => b.whereNull('status').orWhereNotIn('status', TERMINAL_VISIT_STATUSES));
}

async function activeCatalogNames(knex) {
  const rows = await knex('services').where({ is_active: true }).select('name');
  return new Set(rows.map((r) => r.name).filter((n) => typeof n === 'string'));
}

function mappingTarget(label, pattern) {
  const hit = UNLINKED_MAPPING.find(([l, p]) => l === label && p === pattern);
  return hit ? hit[2] : null;
}

// ---- label helpers (copied from 000010; same matching contracts) --------

// Exact label OR its cadence-qualified form ("<name> (Quarterly)"),
// qualifier preserved. Null when the value is not this label.
function swapRenamedPrefix(value, fromName, toName) {
  const s = String(value || '');
  if (!(s === fromName || s.startsWith(`${fromName} (`))) return null;
  return toName + s.slice(fromName.length);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Component-wise swap on a possibly-combined label: the FULL old name is
// matched at list-delimiter/edge boundaries (an optional "(Qualifier)"
// rides along), so it swaps whether it stands alone or inside a merged
// list, while a longer name that merely starts with it never matches.
function swapComponent(value, fromName, toName, boundary) {
  if (typeof value !== 'string' || !value) return null;
  const whole = swapRenamedPrefix(value, fromName, toName);
  if (whole) return whole;
  const re = new RegExp(`(^|${boundary})${escapeRe(fromName)}(\\s*\\([^()]*\\))?(?=$|${boundary})`, 'g');
  const next = value.replace(re, (m, pre, qualifier) => pre + toName + (qualifier || ''));
  return next === value ? null : next;
}

// Reminder labels merge with " & " / ", " / ", and ".
const REMINDER_BOUNDARY = '(?:,\\s+and\\s+|,\\s+|\\s+&\\s+)';
function relabelReminderComponent(value, fromName, toName) {
  return swapComponent(value, fromName, toName, REMINDER_BOUNDARY);
}
// Invoice titles / line descriptions also combine with " + " and " — ".
const TITLE_BOUNDARY = '(?:\\s+\\+\\s+|\\s+—\\s+|,\\s+and\\s+|,\\s+|\\s+&\\s+)';
function swapRenamedTitle(value, fromName, toName) {
  return swapComponent(value, fromName, toName, TITLE_BOUNDARY);
}

function parseLineItems(raw) {
  let items = raw;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { items = null; }
  }
  return Array.isArray(items) ? items : null;
}

// Forward swap on an invoice snapshot's title, service_type, and line-item
// descriptions/categories; returns the patch (only the fields that change).
function relabelInvoiceSnapshot(inv, fromName, toName) {
  const patch = {};
  const nextTitle = swapRenamedTitle(inv.title, fromName, toName);
  if (nextTitle) patch.title = nextTitle;
  const nextServiceType = swapRenamedPrefix(inv.service_type, fromName, toName);
  if (nextServiceType) patch.service_type = nextServiceType;
  const items = parseLineItems(inv.line_items);
  if (items) {
    let itemsChanged = false;
    const next = items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const out = { ...item };
      const nd = swapRenamedTitle(out.description, fromName, toName);
      if (nd) { out.description = nd; itemsChanged = true; }
      const nc = swapRenamedPrefix(out.category, fromName, toName);
      if (nc) { out.category = nc; itemsChanged = true; }
      return out;
    });
    if (itemsChanged) patch.line_items = JSON.stringify(next);
  }
  return Object.keys(patch).length ? patch : null;
}

// Invoice rollback is an EXACT prior/written chain per field, not an inverse
// string swap: two different stale components can map to the SAME target
// ("Quarterly Pest Control" and "Pest Control" both → "Quarterly Pest
// Control Service"), after which a swap back cannot tell them apart.
// line_items compare structurally and KEY-ORDER-INSENSITIVELY: jsonb does
// not preserve object key order on a round trip, and the driver may hand
// back an object where up() wrote a string (r9 P2).
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sameSnapshotValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const pa = parseLineItems(a);
  const pb = parseLineItems(b);
  return pa !== null && pb !== null && canonicalJson(pa) === canonicalJson(pb);
}

// Frozen (non-open) payer statements among these invoices' links — their
// lines render from invoices.service_type, so relabeling would change an
// issued document. Deliberately lock-free (000010 exemplar).
async function frozenPayerStatementIds(knex, invoices) {
  const stmtIds = [...new Set(invoices.map((inv) => inv.payer_statement_id).filter(Boolean))];
  if (!stmtIds.length || !(await knex.schema.hasTable('payer_statements'))) return new Set();
  const rows = await knex('payer_statements').whereIn('id', stmtIds).select('id', 'status');
  return new Set(rows.filter((r) => r.status !== 'open').map((r) => r.id));
}

function invoiceCas(knex, inv) {
  const q = knex('invoices').where({ id: inv.id }).whereIn('status', MUTABLE_INVOICE_STATUSES);
  return inv.updated_at_cas == null
    ? q.whereNull('updated_at')
    : q.whereRaw('updated_at::text = ?', [inv.updated_at_cas]);
}

const INVOICE_COLS = ['id', 'title', 'line_items', 'service_type', 'scheduled_service_id', 'payer_statement_id'];

// Relabel one invoice under CAS + frozen-statement guard; records on success.
async function relabelInvoice(knex, inv, frozen, from, to, state, { predicate, addonIds } = {}) {
  if (inv.payer_statement_id && frozen.has(inv.payer_statement_id)) return;
  const patch = relabelInvoiceSnapshot(inv, from, to);
  if (!patch) return;
  let cas = invoiceCas(knex, inv);
  if (predicate) cas = predicate(cas);
  const count = await cas.update({ ...patch, updated_at: knex.fn.now() });
  if (!count) return;
  // Record exactly what this pass replaced and wrote, per field, plus the
  // timestamp THIS write stamped: down() compares against that, never
  // against a value re-read at rollback time (which would be the owner's
  // later edit and would let the rollback clobber it — r4 P2).
  // line_items is jsonb: the driver hands back a decoded array, and handing
  // an array straight back to an update would be encoded as a Postgres
  // ARRAY, not JSON (r6 P2) — store the prior as the JSON text down() will
  // write, exactly as up() wrote its own value.
  const prior = {};
  for (const field of Object.keys(patch)) {
    const v = inv[field];
    prior[field] = v == null ? null : (field === 'line_items' && typeof v !== 'string' ? JSON.stringify(v) : v);
  }
  const after = await knex('invoices').where({ id: inv.id }).first(knex.raw('updated_at::text AS updated_at_cas'));
  state.invoices.push({
    id: inv.id,
    from,
    to,
    prior,
    written: patch,
    visit_id: inv.scheduled_service_id || null,
    // Add-ons whose relabel put this component here: the copy reverts only
    // in step with them too (r8 P2).
    addon_ids: addonIds && addonIds.length ? [...addonIds] : [],
    written_at: after ? after.updated_at_cas : null,
  });
  // Later passes see this pass's result (the CAS timestamp and the labels).
  Object.assign(inv, patch, after ? { updated_at_cas: after.updated_at_cas } : {});
}

// ---- snapshot fanout ---------------------------------------------------

const REMINDER_COLS = ['id', 'service_type', 'customer_id', 'appointment_time', 'scheduled_service_id'];

// Same-slot sibling reminders under the merger's live predicate: not
// cancelled, not a windowless placeholder, and legacy-unlinked or linked
// to a sendable visit. A parked historical row is never a target.
async function liveSiblingReminders(knex, rem, hasPreclosedCol) {
  const where = { customer_id: rem.customer_id, appointment_time: rem.appointment_time, cancelled: false };
  if (hasPreclosedCol) where.windows_preclosed = false;
  const rows = await knex('appointment_reminders').where(where).select(...REMINDER_COLS);
  const linkedIds = [...new Set(rows.map((r) => r.scheduled_service_id).filter(Boolean))];
  const sendable = new Set(
    linkedIds.length
      ? (await knex('scheduled_services').whereIn('id', linkedIds).select('id', 'status'))
        .filter((v) => SENDABLE_VISIT_STATUSES.includes(v.status))
        .map((v) => v.id)
      : []
  );
  return rows.filter((r) => !r.scheduled_service_id || sendable.has(r.scheduled_service_id));
}

// Fan one (from → to) relabel out to the customer-facing copies of the
// given visits. Each record carries its COMPONENT visit(s) so down() can
// gate on that visit's own reversal.
const slotKey = (rem) => `${rem.customer_id}␟${rem.appointment_time}`;

// Where ONE stale label was relabeled to DIFFERENT targets within a single
// snapshot's scope — two same-slot visits both stored as "Pest Control"
// (one quarterly, one monthly), or two same-named add-ons on one parent
// with different linkages — a component swap can only advertise whichever
// pass runs first (the merger dedupes identical labels). Those snapshots
// FAIL CLOSED: untouched, and listed in state.divergent for the owner
// (r8 P1). Built once over every relabel group before any fanout.
async function buildDivergence(knex, groups) {
  const perVisit = new Map(); // visitId → Map(from → Set(to))
  const note = (map, key, from, to) => {
    if (!map.has(key)) map.set(key, new Map());
    const byFrom = map.get(key);
    if (!byFrom.has(from)) byFrom.set(from, new Set());
    byFrom.get(from).add(to);
  };
  const perBooking = new Map(); // self_booking_id → Map(from → Set(to)), across ALL groups (r9 P2)
  for (const { from, to, visits } of groups.values()) {
    for (const v of visits) {
      note(perVisit, v.id, from, to);
      if (v.self_booking_id) note(perBooking, v.self_booking_id, from, to);
    }
  }
  const perSlot = new Map(); // slotKey → Map(from → Set(to))
  if (perVisit.size && (await knex.schema.hasTable('appointment_reminders'))) {
    const rows = await knex('appointment_reminders')
      .whereIn('scheduled_service_id', [...perVisit.keys()])
      .select('scheduled_service_id', 'customer_id', 'appointment_time');
    for (const r of rows) {
      if (r.customer_id == null || r.appointment_time == null) continue;
      for (const [from, tos] of perVisit.get(r.scheduled_service_id) || []) {
        for (const to of tos) note(perSlot, slotKey(r), from, to);
      }
    }
  }
  const divergent = (map, key, from) => ((map.get(key) || new Map()).get(from) || new Set()).size > 1;
  return {
    atVisit: (visitId, from) => divergent(perVisit, visitId, from),
    atSlot: (key, from) => divergent(perSlot, key, from),
    atBooking: (sbId, from) => divergent(perBooking, sbId, from),
  };
}

async function fanOutSnapshots(knex, { from, to, visits }, state, divergence) {
  const visitIds = [...new Set(visits.map((v) => v.id))];
  // Add-ons whose relabel brought each visit into this group (an add-on-only
  // parent carries no relabel of its own) — every copy records them so it
  // reverts only in step with the add-on too (r8 P2).
  const addonIdsByVisit = new Map();
  for (const v of visits) {
    if (!v.addon_id) continue;
    if (!addonIdsByVisit.has(v.id)) addonIdsByVisit.set(v.id, new Set());
    addonIdsByVisit.get(v.id).add(v.addon_id);
  }
  const addonIdsFor = (ids) => [...new Set(ids.flatMap((id) => [...(addonIdsByVisit.get(id) || [])]))];
  const skipDivergent = (scope, key) => {
    state.divergent.push({ scope, key, from });
  };

  if (await knex.schema.hasTable('appointment_reminders')) {
    const hasPreclosedCol = await knex.schema.hasColumn('appointment_reminders', 'windows_preclosed');
    const linked = await knex('appointment_reminders')
      .whereIn('scheduled_service_id', visitIds)
      .select(...REMINDER_COLS);
    // Every visit a target represents rides in its record: a sibling row
    // reached from two same-slot visits sharing this mapping (the merger
    // dedupes identical labels) reverts only when ALL of them do (r7 P2).
    const targets = new Map();
    const addTarget = (rem, visitId) => {
      if (!targets.has(rem.id)) targets.set(rem.id, { rem, visitIds: new Set() });
      if (visitId) targets.get(rem.id).visitIds.add(visitId);
    };
    for (const rem of linked) addTarget(rem, rem.scheduled_service_id);
    for (const rem of linked) {
      if (rem.customer_id == null || rem.appointment_time == null) continue;
      for (const sib of await liveSiblingReminders(knex, rem, hasPreclosedCol)) addTarget(sib, rem.scheduled_service_id);
    }
    for (const { rem, visitIds: sources } of targets.values()) {
      const next = relabelReminderComponent(rem.service_type, from, to);
      if (next === null) continue;
      if (rem.customer_id != null && rem.appointment_time != null && divergence.atSlot(slotKey(rem), from)) {
        skipDivergent('reminder_slot', rem.id);
        continue;
      }
      const count = await knex('appointment_reminders')
        .where({ id: rem.id, service_type: rem.service_type })
        .update({ service_type: next, updated_at: knex.fn.now() });
      if (count) {
        state.reminders.push({
          id: rem.id, prior: rem.service_type, written: next, from, to, visit_ids: [...sources], addon_ids: addonIdsFor([...sources]),
        });
      }
    }
  }

  // Self-booking snapshots — a booking can link several visits; down()
  // gates on ALL of them reverting. Exact prior/written, like every other
  // copy: an owner edit that keeps the new prefix ("(Custom)" qualifier)
  // is theirs, never rewritten (r8 P2).
  const bookingToVisits = new Map();
  for (const v of visits) {
    if (!v.self_booking_id) continue;
    if (!bookingToVisits.has(v.self_booking_id)) bookingToVisits.set(v.self_booking_id, []);
    bookingToVisits.get(v.self_booking_id).push(v.id);
  }
  if (bookingToVisits.size && (await knex.schema.hasTable('self_booked_appointments'))) {
    const sbRows = await knex('self_booked_appointments')
      .whereIn('id', [...bookingToVisits.keys()])
      .select('id', 'service_type');
    for (const sb of sbRows) {
      const next = swapRenamedPrefix(sb.service_type, from, to);
      if (!next) continue;
      const linkedVisits = bookingToVisits.get(sb.id);
      // Scope = EVERY relabeled visit sharing this booking, across all
      // groups — not just this group's (r9 P2).
      if (divergence.atBooking(sb.id, from)) { skipDivergent('self_booking', sb.id); continue; }
      const count = await knex('self_booked_appointments')
        .where({ id: sb.id, service_type: sb.service_type })
        .update({ service_type: next });
      if (count) state.selfBookings.push({ id: sb.id, from, to, prior: sb.service_type, written: next, visit_ids: linkedVisits });
    }
  }

  // Pre-minted DRAFT/SCHEDULED invoices for the relabeled visits.
  if (await knex.schema.hasTable('invoices')) {
    const drafts = await knex('invoices')
      .whereIn('scheduled_service_id', visitIds)
      .whereIn('status', MUTABLE_INVOICE_STATUSES)
      .select(...INVOICE_COLS, knex.raw('updated_at::text AS updated_at_cas'));
    const frozen = await frozenPayerStatementIds(knex, drafts);
    for (const inv of drafts) {
      if (divergence.atVisit(inv.scheduled_service_id, from)) { skipDivergent('invoice', inv.id); continue; }
      await relabelInvoice(knex, inv, frozen, from, to, state, { addonIds: addonIdsFor([inv.scheduled_service_id]) });
    }
  }
}

// UNATTACHED draft/scheduled invoices, matched by their own labels. Only
// labels with exactly ONE target across the whole relabel qualify — with
// no visit to supply cadence, anything else is a guess.
async function relabelUnattachedInvoices(knex, from, to, state, predicate) {
  const unattached = await knex('invoices')
    .whereNull('scheduled_service_id')
    .whereIn('status', MUTABLE_INVOICE_STATUSES)
    .whereRaw(
      '(title = ? OR title LIKE ? OR service_type = ? OR service_type LIKE ? OR line_items::text LIKE ?)',
      [from, `%${from}%`, from, `${from} (%`, `%${from}%`]
    )
    .select(...INVOICE_COLS, knex.raw('updated_at::text AS updated_at_cas'));
  // Each (from → to) pass swaps its OWN component and records its own
  // entry; a combined draft ("A + B") with two stale components is relabeled
  // once per pass, never skipped after the first (r4 P1). The per-pass
  // updated_at::text CAS is re-read fresh, so passes chain safely.
  const frozen = await frozenPayerStatementIds(knex, unattached);
  for (const inv of unattached) await relabelInvoice(knex, inv, frozen, from, to, state, { predicate });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasTable('services'))) return;

  const state = { unlinked: [], linked: [], addons: [], reminders: [], selfBookings: [], invoices: [], divergent: [] };
  const catalog = await activeCatalogNames(knex);
  // (from → to) → relabeled visits, for the snapshot fanout below.
  const groups = new Map();
  const noteRelabel = (from, to, visit) => {
    const key = JSON.stringify([from, to]);
    if (!groups.has(key)) groups.set(key, { from, to, visits: [] });
    groups.get(key).visits.push(visit);
  };

  // Write predicates that re-check the catalog at write time — the initial
  // activeCatalogNames() read is a snapshot, and the admin catalog editor
  // (service-library.js) takes no lock that conflicts with these writes:
  //  - a mapped write stamps its constant target only while an ACTIVE
  //    service still carries that name (r8 P2);
  //  - a linked write stamps the name it observed on the join only while
  //    the catalog row still carries it (r7 P2).
  const targetStillActive = (q, name) => q.whereRaw('EXISTS (SELECT 1 FROM services WHERE name = ? AND is_active = true)', [name]);
  const catalogNameStill = (q, serviceId, name) => q.whereRaw('(SELECT name FROM services WHERE id = ?) = ?', [serviceId, name]);

  // Leg A — unlinked legacy rows, mapped by (label, cadence).
  for (const [stale, pattern, target] of UNLINKED_MAPPING) {
    if (!catalog.has(target)) continue; // fail closed — never write a name the catalog doesn't carry

    const rows = await openVisitStatus(
      knex('scheduled_services')
        .whereNull('service_id')
        .where({ service_type: stale, recurring_pattern: pattern })
    ).select('id', 'self_booking_id');

    for (const r of rows) {
      // CAS scoped to id + observed label + population predicate: a row
      // relinked or completed between read and write is never renamed.
      const count = await targetStillActive(openVisitStatus(
        knex('scheduled_services')
          .where({ id: r.id, service_type: stale, recurring_pattern: pattern })
          .whereNull('service_id')
      ), target).update({ service_type: target });
      if (count) {
        state.unlinked.push({ id: r.id, from: stale, to: target, pattern });
        noteRelabel(stale, target, r);
      }
    }
  }

  // Leg B — linked rows on the known-stale whitelist sync from the catalog.
  // A whitelisted label that is itself a live catalog name is a linkage
  // conflict (owner-managed), so it drops out of the sweep here.
  const staleLabels = LINKED_STALE_LABELS.filter((label) => !catalog.has(label));
  const linkedRows = staleLabels.length
    ? await openVisitStatus(
      knex('scheduled_services as ss')
        .join('services as sv', 'sv.id', 'ss.service_id')
        .whereIn('ss.service_type', staleLabels)
        .whereRaw('ss.service_type <> sv.name')
    ).select('ss.id', 'ss.service_type', 'ss.service_id', 'ss.self_booking_id', 'sv.name as catalog_name')
    : [];

  for (const r of linkedRows) {
    const count = await catalogNameStill(openVisitStatus(
      knex('scheduled_services')
        .where({ id: r.id, service_type: r.service_type, service_id: r.service_id })
    ), r.service_id, r.catalog_name).update({ service_type: r.catalog_name });
    if (count) {
      state.linked.push({ id: r.id, from: r.service_type, to: r.catalog_name, service_id: r.service_id });
      noteRelabel(r.service_type, r.catalog_name, r);
    }
  }

  // Add-on label snapshots under OPEN parents (row-locked so a concurrent
  // completion serializes behind the relabel). Linked add-ons sync from
  // the catalog under the whitelist; name-only add-ons map through the
  // (label, parent cadence) pair. The parent joins the snapshot fanout
  // (its reminder and invoice copies carry the add-on name).
  if (await knex.schema.hasTable('scheduled_service_addons')) {
    const linkedAddons = staleLabels.length
      ? await knex('scheduled_service_addons as a')
        .join('services as sv', 'sv.id', 'a.service_id')
        .whereIn('a.service_name', staleLabels)
        .whereRaw('a.service_name <> sv.name')
        .select('a.id', 'a.scheduled_service_id', 'a.service_name', 'a.service_id', 'sv.name as catalog_name')
      : [];
    // Add-ons persist their OWN recurrence (20260526000019) and series
    // generation honors it, so a name-only add-on maps through its own
    // cadence when it has one; the parent's is only the legacy fallback
    // (r7 P1).
    const addonHasPattern = await knex.schema.hasColumn('scheduled_service_addons', 'recurring_pattern');
    const legacyAddons = await knex('scheduled_service_addons')
      .whereNull('service_id')
      .whereIn('service_name', [...new Set(UNLINKED_MAPPING.map(([l]) => l))])
      .select('id', 'scheduled_service_id', 'service_name', ...(addonHasPattern ? ['recurring_pattern'] : []));
    const parentIds = [...new Set([...linkedAddons, ...legacyAddons].map((a) => a.scheduled_service_id).filter(Boolean))];
    const openParents = new Map(
      parentIds.length
        ? (await openVisitStatus(knex('scheduled_services').whereIn('id', parentIds))
          .forUpdate()
          .select('id', 'recurring_pattern')).map((v) => [v.id, v])
        : []
    );
    const relabelAddon = async (a, to, identityScope, cadence) => {
      if (!openParents.has(a.scheduled_service_id)) return;
      const count = await identityScope(
        knex('scheduled_service_addons').where({ id: a.id, service_name: a.service_name })
      ).update({ service_name: to });
      if (count) {
        const rec = { id: a.id, from: a.service_name, to, parent_id: a.scheduled_service_id, service_id: a.service_id || null };
        // A name-only add-on's mapping rests on a cadence — its own, or the
        // parent's as the legacy fallback — recorded with its source so
        // down() re-checks exactly that (r4 P2, r7 P1).
        if (cadence) {
          rec.pattern = cadence.pattern;
          rec.pattern_source = cadence.source;
          // Whether the row had a recurring_pattern column to hold its own
          // cadence — down() re-checks "still NULL" only when it could.
          rec.own_cadence_col = addonHasPattern;
        }
        state.addons.push(rec);
        noteRelabel(a.service_name, to, { id: a.scheduled_service_id, self_booking_id: null, addon_id: a.id });
      }
    };
    for (const a of linkedAddons) {
      // Same catalog-name re-check as the linked visit write (r7 P2).
      await relabelAddon(a, a.catalog_name, (q) => catalogNameStill(q.where({ service_id: a.service_id }), a.service_id, a.catalog_name));
    }
    for (const a of legacyAddons) {
      const parent = openParents.get(a.scheduled_service_id);
      if (!parent) continue;
      const cadence = a.recurring_pattern
        ? { pattern: a.recurring_pattern, source: 'addon' }
        : { pattern: parent.recurring_pattern, source: 'parent' };
      const to = mappingTarget(a.service_name, cadence.pattern);
      if (!to || !catalog.has(to)) continue;
      // The add-on's cadence identity is part of the CAS either way: its own
      // pattern when that drove the mapping, or STILL NULL when the parent
      // fallback did (an owner assigning the add-on its own cadence in
      // between must make the write miss — r9 P2); the mapped target is
      // re-checked as still active at write time (r8 P2).
      const scope = (q) => targetStillActive(cadence.source === 'addon'
        ? q.whereNull('service_id').where({ recurring_pattern: cadence.pattern })
        : (addonHasPattern ? q.whereNull('service_id').whereNull('recurring_pattern') : q.whereNull('service_id')), to);
      await relabelAddon(a, to, scope, cadence);
    }
  }

  const divergence = await buildDivergence(knex, groups);
  for (const group of groups.values()) await fanOutSnapshots(knex, group, state, divergence);

  // Unattached drafts: only the labels that NAME their own cadence
  // (UNATTACHED_LABELS) — a draft with no visit has no cadence or linkage
  // to say which plan it is, so a bare generic ("Pest Control", "General
  // Pest Control", "Lawn Care Service") stays, and a target inferred from
  // whichever linked visits or add-ons happen to exist at migration time
  // is never used (an accidental singleton, r6 P1).
  if (await knex.schema.hasTable('invoices')) {
    for (const from of UNATTACHED_LABELS) {
      const tos = new Set(UNLINKED_MAPPING.filter(([l]) => l === from).map(([, , to]) => to));
      if (tos.size !== 1 || catalog.has(from)) continue;
      const to = [...tos][0];
      // Same fail-closed target guard as Leg A: a mapping whose target the
      // catalog doesn't carry neither relabels visits nor drafts (r5 P2).
      if (!catalog.has(to)) continue;
      await relabelUnattachedInvoices(knex, from, to, state, (q) => targetStillActive(q, to));
    }
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return;
  let state;
  try {
    state = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  } catch {
    return; // unreadable state — leave data as-is rather than guess
  }
  const list = (v) => (Array.isArray(v) ? v : []);
  const pair = (rec) => rec && typeof rec.from === 'string' && typeof rec.to === 'string';

  // Reverse only rows still carrying exactly what up() wrote AND still in
  // the population up() matched (same cadence / linkage — an owner who
  // re-cadenced or linked the row since has taken it over), and only while
  // still open (a visit completed under the new label is history). A
  // record missing its identity fields is skipped: never guess.
  const recordedVisits = new Set();
  const revertedVisits = new Set();
  for (const rec of list(state.unlinked)) {
    if (!pair(rec) || typeof rec.pattern !== 'string') continue;
    recordedVisits.add(rec.id);
    const count = await openVisitStatus(
      knex('scheduled_services')
        .where({ id: rec.id, service_type: rec.to, recurring_pattern: rec.pattern })
        .whereNull('service_id')
    ).update({ service_type: rec.from });
    if (count) revertedVisits.add(rec.id);
  }
  for (const rec of list(state.linked)) {
    if (!pair(rec) || rec.service_id == null) continue;
    recordedVisits.add(rec.id);
    const count = await openVisitStatus(
      knex('scheduled_services')
        .where({ id: rec.id, service_type: rec.to, service_id: rec.service_id })
    ).update({ service_type: rec.from });
    if (count) revertedVisits.add(rec.id);
  }

  // A snapshot copy reverts only in step with its component visit: a
  // relabeled visit must have reverted just now (so a visit the owner
  // completed, re-cadenced, linked or hand-edited keeps its copies in
  // agreement); a parent that was never relabeled itself (add-on-only)
  // must still be open. Row-locked so a concurrent completion serializes.
  const addonRecs = list(state.addons);
  const reminderRecs = list(state.reminders);
  const sbRecs = list(state.selfBookings);
  const invoiceRecs = list(state.invoices);
  const componentVisitIds = [...new Set([
    ...addonRecs.map((r) => r && r.parent_id),
    ...reminderRecs.flatMap((r) => (r && Array.isArray(r.visit_ids) ? r.visit_ids : [])),
    ...sbRecs.flatMap((r) => (r && Array.isArray(r.visit_ids) ? r.visit_ids : [])),
    ...invoiceRecs.map((r) => r && r.visit_id),
  ].filter((id) => id && !recordedVisits.has(id)))];
  const terminal = new Set();
  const parentPattern = new Map();
  if (componentVisitIds.length) {
    const visits = await knex('scheduled_services').whereIn('id', componentVisitIds).forUpdate().select('id', 'status', 'recurring_pattern');
    for (const v of visits) {
      if (TERMINAL_VISIT_STATUSES.includes(v.status)) terminal.add(v.id);
      parentPattern.set(v.id, v.recurring_pattern);
    }
  }
  const visitRevertible = (id) => (recordedVisits.has(id) ? revertedVisits.has(id) : !terminal.has(id));
  // Add-on reversals run first; a copy that carries an add-on's component
  // reverts only when that add-on's own reversal succeeded (r8 P2).
  const revertedAddons = new Set();
  const sourcesRevertible = (rec) => (
    Array.isArray(rec.visit_ids) && rec.visit_ids.length > 0 && rec.visit_ids.every(visitRevertible)
    && (rec.addon_ids || []).every((id) => revertedAddons.has(id))
  );

  if (addonRecs.length && (await knex.schema.hasTable('scheduled_service_addons'))) {
    for (const rec of addonRecs) {
      if (!pair(rec) || !rec.parent_id || !visitRevertible(rec.parent_id)) continue;
      // A name-only add-on was mapped through the parent's cadence: an
      // add-on-only parent the owner re-cadenced since no longer justifies
      // the old name (a relabeled parent already re-checked its cadence in
      // its own reversal above).
      const parentCadenceBased = rec.pattern != null && rec.pattern_source !== 'addon';
      if (parentCadenceBased && !recordedVisits.has(rec.parent_id) && parentPattern.get(rec.parent_id) !== rec.pattern) continue;
      let q = knex('scheduled_service_addons').where({ id: rec.id, service_name: rec.to });
      q = rec.service_id ? q.where({ service_id: rec.service_id }) : q.whereNull('service_id');
      // The cadence identity the forward CAS used: the add-on's OWN cadence
      // (r7 P1), or — for the parent fallback — its cadence still NULL (an
      // owner assigned one since → the add-on is theirs, r9 P2).
      if (rec.pattern_source === 'addon') q = q.where({ recurring_pattern: rec.pattern });
      else if (rec.pattern_source === 'parent' && rec.own_cadence_col) q = q.whereNull('recurring_pattern');
      const count = await q.update({ service_name: rec.from });
      if (count) revertedAddons.add(rec.id);
    }
  }

  if (reminderRecs.length && (await knex.schema.hasTable('appointment_reminders'))) {
    // Exact prior/written chain per reminder, unwound in reverse — the same
    // reason as invoices (r5 P2): two stale components converging on one
    // target ("Quarterly Pest Control & Pest Control" → "X & X") cannot be
    // told apart by an inverse component swap. Each step must find exactly
    // what it wrote (an owner edit since keeps the row as theirs) and stops
    // at the first step whose component visit is not revertible.
    const recsById = new Map();
    for (const rec of reminderRecs) {
      if (!pair(rec) || typeof rec.written !== 'string' || typeof rec.prior !== 'string') continue;
      if (!Array.isArray(rec.visit_ids) || !rec.visit_ids.length) continue;
      if (!recsById.has(rec.id)) recsById.set(rec.id, []);
      recsById.get(rec.id).push(rec);
    }
    for (const [id, recs] of recsById) {
      const current = await knex('appointment_reminders').where({ id }).first('id', 'service_type');
      if (!current) continue;
      let working = current.service_type;
      for (const rec of [...recs].reverse()) {
        if (!sourcesRevertible(rec)) break;
        if (working !== rec.written) break;
        working = rec.prior;
      }
      if (working === current.service_type) continue;
      await knex('appointment_reminders')
        .where({ id, service_type: current.service_type })
        .update({ service_type: working, updated_at: knex.fn.now() });
    }
  }

  if (sbRecs.length && (await knex.schema.hasTable('self_booked_appointments'))) {
    for (const rec of sbRecs) {
      if (!pair(rec) || typeof rec.written !== 'string' || typeof rec.prior !== 'string') continue;
      if (!sourcesRevertible(rec)) continue;
      // Exact: only a row still carrying what up() wrote reverts (r8 P2).
      await knex('self_booked_appointments')
        .where({ id: rec.id, service_type: rec.written })
        .update({ service_type: rec.prior });
    }
  }

  if (invoiceRecs.length && (await knex.schema.hasTable('invoices'))) {
    const invoices = await knex('invoices')
      .whereIn('id', invoiceRecs.map((r) => r && r.id).filter(Boolean))
      .whereIn('status', MUTABLE_INVOICE_STATUSES)
      .select(...INVOICE_COLS, knex.raw('updated_at::text AS updated_at_cas'));
    const frozen = await frozenPayerStatementIds(knex, invoices);
    // EVERY record per invoice, in write order — a combined draft touched by
    // several (from → to) passes has several (r4 P2). They unwind in reverse
    // as ONE write: the current updated_at must equal the timestamp the LAST
    // pass stamped (an owner edit since → the whole invoice is theirs), and
    // each component reverts only under its own visit guard.
    const recsById = new Map();
    for (const rec of invoiceRecs) {
      if (!rec || !pair(rec) || !rec.prior || !rec.written || typeof rec.written_at !== 'string') continue;
      if (!recsById.has(rec.id)) recsById.set(rec.id, []);
      recsById.get(rec.id).push(rec);
    }
    for (const inv of invoices) {
      const recs = recsById.get(inv.id);
      if (!recs || !recs.length) continue;
      if (inv.payer_statement_id && frozen.has(inv.payer_statement_id)) continue;
      if (inv.updated_at_cas !== recs[recs.length - 1].written_at) continue;
      // Walk the chain back: each step must find exactly what it wrote
      // (the later step's prior IS this step's written), and stops at the
      // first step whose visit guard fails — an earlier component cannot
      // be restored underneath a retained later one. In practice every
      // record of an attached invoice shares its one visit, and unattached
      // drafts have none, so this is all-or-nothing per invoice.
      const working = { ...inv };
      const patch = {};
      for (const rec of [...recs].reverse()) {
        // Unattached drafts (no visit) revert under the still-draft guard alone.
        if (rec.visit_id && !sourcesRevertible({ visit_ids: [rec.visit_id], addon_ids: rec.addon_ids })) break;
        const fields = Object.keys(rec.written);
        if (!fields.every((f) => sameSnapshotValue(working[f], rec.written[f]))) break;
        for (const f of fields) { working[f] = rec.prior[f]; patch[f] = rec.prior[f]; }
      }
      if (!Object.keys(patch).length) continue;
      await invoiceCas(knex, inv).update({ ...patch, updated_at: knex.fn.now() });
    }
  }

  await knex('system_settings').where({ key: STATE_KEY }).del();
};
