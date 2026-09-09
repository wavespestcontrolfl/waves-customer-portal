/**
 * Every active, non-deleted customer row (property profile) on the same
 * account as the signed-in customer — the primary profile plus each
 * additional property. Accepts the authenticated request (or any object
 * carrying accountId / customerId / customer) and returns the ids ordered
 * primary first. Shared by the notification and schedule routes so the
 * account-scoped reads agree on what "my properties" means.
 *
 * Two property models coexist (docs/multi-property-model.md):
 *   - sibling PROFILES: a second `customers` row sharing account_id (the
 *     frozen customer_accounts pattern; what accountPropertyIds returns);
 *   - SAVED PROPERTIES: `customer_properties` rows under one customer (what
 *     admin booking, estimates and lawn history read).
 * Under GATE_APP_PROPERTY_SCOPE the app reads the UNION of both —
 * accountSavedProperties — and the session names the selected saved
 * property (req.propertyId, validated by middleware/auth). resolveSessionScope
 * + scopeVisitsToProperty give every property-aware read one rule.
 */
const db = require('../models/db');
const { gateEnvValue } = require('../config/feature-gates');

function appPropertyScopeEnabled() {
  return gateEnvValue('GATE_APP_PROPERTY_SCOPE');
}

function accountIdOf(req) {
  return req.accountId || req.customer?.account_id || req.customerId;
}

async function accountPropertyIds(req, knex = db) {
  const accountId = accountIdOf(req);
  const rows = await knex('customers')
    .where({ active: true })
    .whereNull('deleted_at')
    .where(function () {
      this.where({ account_id: accountId }).orWhere({ id: accountId });
    })
    .orderBy('is_primary_profile', 'desc')
    .select('id');
  return rows.map((r) => r.id);
}

// Appointment delivery preferences belong to the account's primary profile.
// Delivery decisions must request onError:'throw'; an unknown owner cannot
// authorize a different profile's preference. Routes retain their legacy fallback.
async function resolvePrimaryProfileId(req, knex = db, { onError = 'fallback' } = {}) {
  const accountId = req.accountId || req.customer?.account_id || req.customerId;
  if (!accountId) return req.customerId;
  const primary = await knex('customers')
    .where({ account_id: accountId, is_primary_profile: true })
    .first('id')
    .catch((err) => {
      if (onError === 'throw') throw err;
      return null;
    });
  return primary?.id || req.customerId;
}

// ---------------------------------------------------------------------------
// Saved-property (customer_properties) scope — GATE_APP_PROPERTY_SCOPE
// ---------------------------------------------------------------------------

const PROFILE_COLUMNS = [
  'id', 'account_id', 'profile_label', 'is_primary_profile', 'active', 'waveguard_tier',
  'address_line1', 'address_line2', 'city', 'state', 'zip',
];

// Same profile set and order as GET /auth/properties' sibling list, so the
// two lists agree on which profile comes first.
async function accountProfiles(req, knex = db) {
  const accountId = accountIdOf(req);
  return knex('customers')
    .where({ active: true })
    .whereNull('deleted_at')
    .where(function () {
      this.where({ account_id: accountId }).orWhere({ id: accountId });
    })
    .orderBy('is_primary_profile', 'desc')
    .orderBy('profile_label', 'asc')
    .orderBy('created_at', 'asc')
    .select(PROFILE_COLUMNS);
}

function addressOf(row) {
  return {
    line1: row?.address_line1 || null,
    line2: row?.address_line2 || null,
    city: row?.city || null,
    state: row?.state || null,
    zip: row?.zip || null,
  };
}

// One selectable entry = (profile, saved property). A profile with no saved
// property row yet (no address on file, so the lazy primary could not be
// created) still lists once, keyed to the profile, so the customer can reach
// it exactly as the sibling list allows today.
function savedPropertyEntry(profile, property) {
  return {
    key: `${profile.id}:${property ? property.id : 'profile'}`,
    customerId: profile.id,
    propertyId: property ? property.id : null,
    isPrimaryProfile: profile.is_primary_profile === true,
    profileLabel: profile.profile_label || (profile.is_primary_profile === true ? 'Primary' : 'Service property'),
    isPrimaryProperty: property ? property.is_primary === true : true,
    label: property?.label || null,
    relationship: property?.relationship || null,
    occupancyType: property?.occupancy_type || null,
    tier: profile.waveguard_tier || null,
    address: addressOf(property || profile),
  };
}

// The session's current selection among the entries: the validated claim
// (req.propertyId) when it names one of the signed-in profile's entries, else
// that profile's primary, else its first entry.
function selectedEntryFor(req, entries) {
  const mine = entries.filter((e) => String(e.customerId) === String(req.customerId));
  const byClaim = req.propertyId ? mine.find((e) => String(e.propertyId) === String(req.propertyId)) : null;
  const chosen = byClaim || mine.find((e) => e.isPrimaryProperty) || mine[0] || null;
  return chosen
    ? { key: chosen.key, customerId: chosen.customerId, propertyId: chosen.propertyId }
    : { key: null, customerId: req.customerId, propertyId: null };
}

async function accountSavedProperties(req, knex = db) {
  // Lazy require: customer-properties pulls in the stamped-address and
  // dedupe modules; route tests mock this module wholesale.
  const customerProperties = require('./customer-properties');
  // C4 cancelled read-only session (authenticateAllowInactive): list ONLY
  // the signed-in profile — the same fallback as the sibling list in
  // routes/auth.js. The active-only profile query would drop the cancelled
  // customer's own row and offer sibling switches that /select-property
  // (an active-only route) cannot honor.
  const profiles = req.customer && req.customer.active !== true
    ? [req.customer]
    : await accountProfiles(req, knex);
  const entries = [];
  for (const profile of profiles) {
    // Same lazy primary the admin list makes (ensurePrimaryProperty): a
    // profile created by a path that skipped the property table still lists
    // its one address. Best-effort — a failure lists the profile itself.
    // ACTIVE profiles only (codex #4199 r1 P2): a cancelled read-only
    // session must not create a property row after cancellation.
    if (profile.active === true) {
      await customerProperties.ensurePrimaryProperty(profile.id).catch(() => {});
    }
    // A failed READ propagates (pre-push codex P1): swallowing it would
    // answer 200 with the profile missing and `selected` wrong, and the
    // client could never tell it needs to retry. Only the lazy WRITE above is
    // best-effort — the list is still correct for the rows that exist.
    const rows = await customerProperties.listProperties(profile.id);
    if (!rows.length) {
      // No ACTIVE rows. A profile that has NEVER had a property row (no
      // address to build one from) still lists once, keyed to the profile.
      // A profile whose rows were all RETIRED by the office is left out
      // (codex #4199 r1 P2): listing its mirrored address would make a
      // deliberately retired address selectable again, and selecting it
      // would resolve to a zero-property scope showing customer-wide visits.
      const everHadRow = await knex('customer_properties').where({ customer_id: profile.id }).first('id');
      if (!everHadRow) entries.push(savedPropertyEntry(profile, null));
      continue;
    }
    for (const row of rows) entries.push(savedPropertyEntry(profile, row));
  }
  const selected = selectedEntryFor(req, entries);
  // C4 cancelled read-only session: exactly ONE entry — the current selection
  // (or the primary). /auth/select-property is not a cancelled read, so a
  // picker would only offer switches that 401; and resolveSessionScope leaves
  // a cancelled session unscoped, so its reads stay customer-wide as today.
  if (req.customer && req.customer.active !== true && selected.key) {
    const only = entries.filter((e) => e.key === selected.key);
    return { properties: only, selected };
  }
  return { properties: entries, selected };
}

// The signed-in profile's property scope for one request:
//   { customerId, enabled, multi, property }
// enabled=false (gate off) → callers keep today's customer-wide reads.
// multi=false (0–1 active properties) → same: no property predicate at all,
// so single-home customers are byte-for-byte unaffected.
// property = the validated claim's row, else the primary, else the first.
async function resolveSessionScope(req, knex = db) {
  const customerId = req.customerId;
  // Gate off — or a C4 cancelled read-only session (req.customerInactive):
  // no property scoping at all, today's customer-wide reads.
  if (!appPropertyScopeEnabled() || req.customerInactive === true) {
    return { customerId, enabled: false, multi: false, property: null };
  }
  const customerProperties = require('./customer-properties');
  await customerProperties.ensurePrimaryProperty(customerId).catch(() => {});
  const rows = await knex('customer_properties')
    .where({ customer_id: customerId, active: true })
    .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'created_at', order: 'asc' }])
    .select('id', 'is_primary', 'label', 'relationship', 'occupancy_type', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude');
  const property = (req.propertyId && rows.find((r) => String(r.id) === String(req.propertyId)))
    || rows.find((r) => r.is_primary === true)
    || rows[0]
    || null;
  return { customerId, enabled: true, multi: rows.length > 1, property };
}

// The visit rule. A property's visits are the customer's visits stamped with
// that property, plus UNSTAMPED visits when the property is the primary —
// the same reading dispatch applies to a row with property_id NULL. Applied
// only when the scope is enabled AND the customer has 2+ active properties.
function scopeVisitsToProperty(qb, scope, alias = 'scheduled_services') {
  qb.where(`${alias}.customer_id`, scope.customerId);
  return applyPropertyPredicate(qb, scope, alias);
}

// The property half of the visit rule alone — for queries that already carry
// their own customer predicate (the schedule list, confirm/reschedule
// lookups, the tracking canonical query). No-op unless the scope is enabled
// AND the customer has 2+ active properties, so gate-off and single-home
// queries stay byte-identical to today's.
function applyPropertyPredicate(qb, scope, alias = 'scheduled_services') {
  if (!scope || !scope.enabled || !scope.multi || !scope.property) return qb;
  const column = `${alias}.property_id`;
  const { id, is_primary: isPrimary } = scope.property;
  return qb.where(function () {
    this.where(column, id);
    if (isPrimary === true) this.orWhereNull(column);
  });
}

// Distribute visit rows (ordered date asc, window asc) onto the unified
// entries and keep each entry's FIRST visit: Map<entry.key, visit>. Same
// reading as the visit rule — a profile with one entry owns every visit of
// that customer; on a multi-property profile a stamped visit belongs to the
// entry with that property, an unstamped one to the PRIMARY entry only (a
// profile whose primary was retired has no owner for them — exactly what
// applyPropertyPredicate shows), and a visit stamped to a property that is
// no longer listed belongs to nobody.
function assignVisitsToEntries(entries, visits) {
  const byCustomer = new Map();
  for (const entry of entries) {
    const key = String(entry.customerId);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(entry);
  }
  const next = new Map();
  for (const visit of visits) {
    const mine = byCustomer.get(String(visit.customer_id)) || [];
    if (!mine.length) continue;
    let target = null;
    if (mine.length === 1) target = mine[0];
    else if (visit.property_id) target = mine.find((e) => String(e.propertyId) === String(visit.property_id)) || null;
    else target = mine.find((e) => e.isPrimaryProperty) || null;
    if (target && !next.has(target.key)) next.set(target.key, visit);
  }
  return next;
}

// The session's EFFECTIVE property selection — what the middleware actually
// honored (a retired property, a foreign claim or the gate being off all
// read as null), for GET /auth/me. The client trusts THIS, never the raw
// token claim, when it cannot read the list (codex #4207 r1e).
function sessionPropertyScopePayload(req) {
  const enabled = appPropertyScopeEnabled() && req.customerInactive !== true;
  return { enabled, propertyId: enabled && req.propertyId ? String(req.propertyId) : null };
}

module.exports = {
  accountPropertyIds,
  resolvePrimaryProfileId,
  appPropertyScopeEnabled,
  sessionPropertyScopePayload,
  accountSavedProperties,
  resolveSessionScope,
  scopeVisitsToProperty,
  applyPropertyPredicate,
  assignVisitsToEntries,
  _test: { savedPropertyEntry, selectedEntryFor },
};
