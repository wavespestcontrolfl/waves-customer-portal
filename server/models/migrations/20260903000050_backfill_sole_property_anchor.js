/**
 * Sole-property anchor backfill for open visits (visit groups, Lane 1).
 *
 * GATE_VISIT_GROUPS has been live since 2026-08-30 and has formed zero
 * groups: automatic grouping (visit-groups.js groupRowOn) requires
 * property_id, and prod 2026-09-03 read-only sizing found 703 open
 * (pending/confirmed/en_route/on_site) rows with none — 674 of them today
 * or later — on 219 customers who each own EXACTLY ONE active property.
 * Those rows are unambiguous: the 20260829000050 linkage backfill only
 * covered multi-property customers (it keyed the visit address against
 * ≥2 candidates), so it deliberately left the sole-property rows alone.
 * Do not extend that migration; this one is the sole-property leg.
 *
 * Rule (same as customer-properties.anchorSoleProperty, which now stamps
 * spawned rows at write time): an OPEN row with property_id NULL, no
 * stamped service_address_line1 (an unstamped row resolves to the
 * customer's address by every reader's COALESCE — for a sole-property
 * customer that IS the property; a stamped row may name an address the
 * customer never registered and stays for the office picker), whose
 * customer has exactly one active property → stamp that property.
 * Terminal rows are history and are never touched. Multi-property and
 * property-less customers are out of scope (prod: 2 and 0 open rows).
 *
 * The migration only stamps property_id. It NEVER forms a group: grouping
 * runs the reminder claim logic and needs a request context; the next
 * seeder run / booking / office Combine on those customers groups them.
 * A property-only UPDATE is a no-op for the scheduled_services_sync_reminder
 * trigger (it acts on time/status changes only).
 *
 * Ownership is recorded in a system_settings state row so down() clears
 * exactly what up() wrote, value-guarded per row (a link an admin changed
 * since is left as the admin left it). Idempotent: a second up() with the
 * state row present is a no-op.
 */

const STATE_KEY = 'migration.20260903000050.state';
// Same terminal set as 20260829000050 — `rescheduled` can revive.
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

// OPEN = not terminal, INCLUDING legacy NULL-status rows.
const openVisitStatus = (q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_VISIT_STATUSES);

const CHUNK = 500;

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

exports.up = async function up(knex) {
  for (const t of ['scheduled_services', 'customer_properties']) {
    if (!(await knex.schema.hasTable(t))) return;
  }
  if (!(await knex.schema.hasColumn('scheduled_services', 'property_id'))) return;
  if (await loadState(knex)) return; // already applied

  const state = { linked: {} };
  const hasStampCol = await knex.schema.hasColumn('scheduled_services', 'service_address_line1');

  // Exactly-one rule, computed over ALL active properties (a customer with
  // two shows up twice and drops out).
  const props = await knex('customer_properties').where({ active: true }).select('id', 'customer_id');
  const count = new Map();
  const soleByCustomer = new Map();
  for (const p of props) {
    count.set(p.customer_id, (count.get(p.customer_id) || 0) + 1);
    soleByCustomer.set(p.customer_id, p.id);
  }
  const soleIds = [...count.entries()].filter(([, n]) => n === 1).map(([id]) => id);
  if (!soleIds.length) { await saveState(knex, state); return; }

  const visits = [];
  for (let i = 0; i < soleIds.length; i += CHUNK) {
    const q = knex('scheduled_services')
      .whereIn('customer_id', soleIds.slice(i, i + CHUNK))
      .whereNull('property_id')
      .where(openVisitStatus);
    if (hasStampCol) q.whereNull('service_address_line1');
    visits.push(...await q.select('id', 'customer_id'));
  }

  for (const v of visits) {
    const propertyId = soleByCustomer.get(v.customer_id);
    if (!propertyId) continue;
    // CAS: only the row we observed — still unlinked, still open, still this
    // customer, still unstamped — AND the target is still that customer's
    // ONLY active property (a property added or a customer merge between
    // the scan and this write makes the row ambiguous → leave it).
    const q = knex('scheduled_services')
      .where({ id: v.id, customer_id: v.customer_id })
      .whereNull('property_id')
      .where(openVisitStatus)
      .whereExists(function targetProperty() {
        this.select(1).from('customer_properties')
          .where({ id: propertyId, customer_id: v.customer_id, active: true });
      })
      .whereNotExists(function anotherActiveProperty() {
        this.select(1).from('customer_properties')
          .where({ customer_id: v.customer_id, active: true })
          .whereNot('id', propertyId);
      });
    if (hasStampCol) q.whereNull('service_address_line1');
    const n = await q.update({ property_id: propertyId });
    if (n) state.linked[v.id] = propertyId;
  }

  await saveState(knex, state);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  const state = await loadState(knex);
  if (!state) return; // nothing owned → restore nothing

  // Clear ONLY where the visit still carries the property we wrote.
  for (const [visitId, propertyId] of Object.entries(state.linked || {})) {
    await knex('scheduled_services')
      .where({ id: visitId, property_id: propertyId })
      .update({ property_id: null });
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.STATE_KEY = STATE_KEY;
