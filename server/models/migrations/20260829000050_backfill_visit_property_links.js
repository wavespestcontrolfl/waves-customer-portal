/**
 * Visit → property linkage backfill for multi-property customers, plus
 * duplicate-property retirement.
 *
 * Owner report 2026-08-29: the daily schedule audit listed 9 upcoming open
 * visits with `property_id` NULL on customers that own MORE than one active
 * property. Dispatch then guesses the primary — which may be the wrong house
 * (the 08-27 shape). Prod read-only check of all 9: every visit's booked
 * address (its service_address_* stamp, else the customer mirror) keys to
 * EXACTLY ONE of that customer's active properties, so the link is
 * deterministic and needs no judgment call.
 *
 * Leg A — link: for every OPEN visit (non-terminal status) with property_id
 *   NULL whose customer has ≥2 active properties, compute the same
 *   addressKey() the property service stores in customer_properties.address_key
 *   (identical normalization — no JS/SQL drift) over the visit's effective
 *   address and set property_id when exactly one active property matches.
 *   Ambiguous (0 or 2+ matches) rows are left alone for the admin picker.
 *   Terminal visits are history and are never touched.
 *
 * Leg B — retire duplicates: the same prod read found one customer whose
 *   "second property" is the SAME street + ZIP as the primary, entered again
 *   with a different city spelling (so the per-customer active-address unique
 *   index did not catch it), no label, occupancy unknown, and referenced by
 *   nothing OPEN (a cancelled/completed visit is history and its link survives
 *   retirement). Such rows are deactivated (active=false — the row is kept, never
 *   deleted; admin edits are owner data) ONLY when: not primary, label NULL,
 *   occupancy_type 'unknown', same city-less address key as the primary, and
 *   zero OPEN scheduled_services references and zero estimates / service_visits
 *   references.
 *   `label` must be strictly NULL — any non-NULL value is treated as intent.
 *
 * Ownership is recorded in a system_settings state row so down() reverses
 * exactly what up() wrote (value-guarded per row: a link an admin changed
 * since, or a property re-activated since, is left as the admin left it).
 * Idempotent: a second up() with the state row present is a no-op.
 */

const { addressKey } = require('../../services/customer-properties');

const STATE_KEY = 'migration.20260829000050.state';
// Same terminal set as 20260825000010 — `rescheduled` can revive.
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

// OPEN = not terminal, INCLUDING legacy NULL-status rows (a bare NOT IN
// drops NULLs — same predicate as 20260829000010; codex #3601 r1 P1).
const openVisitStatus = (q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_VISIT_STATUSES);

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

// City-less key: street + unit + ZIP. Two rows that differ ONLY in the city
// spelling ("Nokomis" vs "North Venice" for one ZIP) collapse together.
function streetZipKey(row) {
  return addressKey({ address_line1: row.address_line1, address_line2: row.address_line2, zip: row.zip });
}

// Field-level fallbacks, mirroring the dispatch readers' per-column
// COALESCE(service_address_*, customers.*) (codex #3601 r1 P1): a partial
// stamp (street only) still keys against the mirror's city/ZIP. The UNIT
// follows the stamped street when one exists — a stamped street with no
// unit means "no unit", never the mirror's unit (unit-divergence behavior).
function visitAddressKey(visit, customer) {
  const stamped = !!visit.service_address_line1;
  const line1 = visit.service_address_line1 || customer.address_line1;
  const line2 = stamped ? visit.service_address_line2 : customer.address_line2;
  const city = visit.service_address_city || customer.city;
  const zip = visit.service_address_zip || customer.zip;
  if (!line1) return null;
  return addressKey({ address_line1: line1, address_line2: line2, city, zip });
}

// Property ids with a LIVE reference — a live-referenced property is never
// retired, whatever its shape. A visit in a terminal status is history: its
// link survives retirement untouched (active=false keeps the row, and the FK
// only nulls on DELETE), so it does not block. Estimates and service_visits
// references block regardless of status (prod pre-read 08-29: zero of each).
async function liveReferencedPropertyIds(knex, ids) {
  const out = new Set();
  if (await knex.schema.hasColumn('scheduled_services', 'property_id')) {
    const rows = await knex('scheduled_services')
      .whereIn('property_id', ids)
      .where(openVisitStatus)
      .select('property_id');
    for (const r of rows) if (r.property_id) out.add(r.property_id);
  }
  for (const table of ['estimates', 'service_visits']) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, 'property_id'))) continue;
    const rows = await knex(table).whereIn('property_id', ids).select('property_id');
    for (const r of rows) if (r.property_id) out.add(r.property_id);
  }
  return out;
}

exports.up = async function up(knex) {
  for (const t of ['scheduled_services', 'customer_properties', 'customers']) {
    if (!(await knex.schema.hasTable(t))) return;
  }
  if (!(await knex.schema.hasColumn('scheduled_services', 'property_id'))) return;
  if (await loadState(knex)) return; // already applied

  const state = { linked: {}, deactivated: [] };

  const props = await knex('customer_properties')
    .where({ active: true })
    .select('id', 'customer_id', 'is_primary', 'label', 'occupancy_type',
      'address_line1', 'address_line2', 'city', 'zip', 'address_key');
  const byCustomer = new Map();
  for (const p of props) {
    if (!byCustomer.has(p.customer_id)) byCustomer.set(p.customer_id, []);
    byCustomer.get(p.customer_id).push(p);
  }
  const multiIds = [...byCustomer.entries()].filter(([, list]) => list.length >= 2).map(([id]) => id);
  if (!multiIds.length) { await saveState(knex, state); return; }

  // ── Leg A: link open unlinked visits whose address keys to one property ──
  const customers = await knex('customers')
    .whereIn('id', multiIds)
    .select('id', 'address_line1', 'address_line2', 'city', 'zip');
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const visits = await knex('scheduled_services')
    .whereIn('customer_id', multiIds)
    .whereNull('property_id')
    .where(openVisitStatus)
    .select('id', 'customer_id', 'status', 'service_address_line1', 'service_address_line2',
      'service_address_city', 'service_address_zip');
  for (const v of visits) {
    const customer = customerById.get(v.customer_id);
    if (!customer) continue;
    const key = visitAddressKey(v, customer);
    if (!key) continue;
    const matches = (byCustomer.get(v.customer_id) || []).filter((p) => p.address_key === key);
    if (matches.length !== 1) continue; // ambiguous → admin picker
    const propertyId = matches[0].id;
    // CAS: only the row we observed — still unlinked, still open.
    const n = await knex('scheduled_services')
      .where({ id: v.id })
      .whereNull('property_id')
      .where(openVisitStatus)
      .update({ property_id: propertyId });
    if (n) state.linked[v.id] = propertyId;
  }

  // ── Leg B: retire unreferenced same-street duplicates of the primary ──
  const candidates = [];
  for (const customerId of multiIds) {
    const list = byCustomer.get(customerId);
    const primary = list.find((p) => p.is_primary);
    if (!primary) continue;
    const primaryKey = streetZipKey(primary);
    if (!primaryKey) continue;
    for (const p of list) {
      if (p.id === primary.id || p.is_primary) continue;
      // Strictly NULL (the admin PATCH route already stores a blank label as
      // NULL; a non-NULL value — even whitespace — is treated as intent).
      if (p.label != null) continue;
      if (p.occupancy_type !== 'unknown') continue;
      if (streetZipKey(p) !== primaryKey) continue;
      candidates.push(p);
    }
  }
  if (candidates.length) {
    const referenced = await liveReferencedPropertyIds(knex, candidates.map((p) => p.id));
    const hasEstimates = (await knex.schema.hasTable('estimates'))
      && (await knex.schema.hasColumn('estimates', 'property_id'));
    const hasServiceVisits = (await knex.schema.hasTable('service_visits'))
      && (await knex.schema.hasColumn('service_visits', 'property_id'));
    for (const p of candidates) {
      if (referenced.has(p.id)) continue;
      // Atomic re-validation (codex #3601 r1 P2): the UPDATE itself re-checks
      // every observed condition and the live references, so an admin edit
      // or a new booking between the scan and this statement wins.
      const q = knex('customer_properties')
        .where({ id: p.id, active: true, is_primary: false, occupancy_type: 'unknown', address_key: p.address_key })
        .whereNull('label')
        .whereNotExists(function openVisitRef() {
          this.select(1).from('scheduled_services')
            .whereRaw('scheduled_services.property_id = customer_properties.id')
            .where(openVisitStatus);
        });
      if (hasEstimates) {
        q.whereNotExists(function estimateRef() {
          this.select(1).from('estimates').whereRaw('estimates.property_id = customer_properties.id');
        });
      }
      if (hasServiceVisits) {
        q.whereNotExists(function serviceVisitRef() {
          this.select(1).from('service_visits').whereRaw('service_visits.property_id = customer_properties.id');
        });
      }
      const n = await q.update({ active: false, updated_at: knex.fn.now() });
      if (n) state.deactivated.push(p.id);
    }
  }

  await saveState(knex, state);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  const state = await loadState(knex);
  if (!state) return; // nothing owned → restore nothing

  // Links: clear ONLY where the visit still carries the property we wrote.
  for (const [visitId, propertyId] of Object.entries(state.linked || {})) {
    await knex('scheduled_services')
      .where({ id: visitId, property_id: propertyId })
      .update({ property_id: null });
  }

  // Duplicates: re-activate ONLY rows still inactive. The per-customer
  // active-address unique index would refuse a revival if an equal-key
  // active row appeared since — that row is the admin's, so leave ours
  // retired. Checked BEFORE the update: a failed statement would abort the
  // migration transaction and catching the JS error cannot recover it
  // (codex #3601 r1 P1).
  if (await knex.schema.hasTable('customer_properties')) {
    for (const id of state.deactivated || []) {
      const row = await knex('customer_properties').where({ id, active: false }).first();
      if (!row) continue;
      const clash = await knex('customer_properties')
        .where({ customer_id: row.customer_id, address_key: row.address_key, active: true })
        .first();
      if (clash) continue;
      await knex('customer_properties')
        .where({ id, active: false })
        .update({ active: true, updated_at: knex.fn.now() });
    }
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.STATE_KEY = STATE_KEY;
exports.TERMINAL_VISIT_STATUSES = TERMINAL_VISIT_STATUSES;
