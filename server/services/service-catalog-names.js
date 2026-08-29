/**
 * Service catalog name cache
 * server/services/service-catalog-names.js
 *
 * Sync lookup of real `services.name` / `services.short_name` identities so
 * display paths (normalizeServiceType) can pass a catalog service through
 * VERBATIM instead of collapsing it onto a regex family label ("Seasonal
 * Mosquito Control Service" → "Mosquito Barrier Treatment", owner report
 * 2026-08-28; same class as the 2026-07-30 "Waves Assessment" report).
 *
 * Archived/inactive rows are included on purpose — historical visits still
 * carry their retired catalog name and must keep displaying it.
 *
 * No DB import at module top-level: the normalizer is a pure util that many
 * tests import, and an unprimed cache simply falls back to the regex map.
 */

const { CADENCE_CONVENTION_RENAMES, renamedCatalogName, legacyCatalogName } = require('../config/service-name-aliases');

// Migration-owned rename history is always resolvable, primed or not: an
// unlinked terminal visit (service_id null, completed/cancelled) keeps its
// pre-rename label by Invariant 1, and the history query below only learns
// names from LINKED rows — without this seed those frozen labels would
// collapse to a family label after the catalog rename (codex #3579 r1 P1).
function renameSeed() {
  const m = new Map();
  for (const [from, to] of CADENCE_CONVENTION_RENAMES) {
    m.set(from.toLowerCase(), from);
    m.set(to.toLowerCase(), to);
  }
  return m;
}

let byLower = renameSeed();

function canonicalCatalogName(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const exact = byLower.get(raw.toLowerCase());
  if (exact) return exact;
  // Cadence-qualified form of a known name ("Lawn Care Program Service
  // (Quarterly)"): the rename migration relabels these with the qualifier
  // preserved, and an UNLINKED terminal visit keeps the old qualified label
  // by Invariant 1 — resolve the base and keep the qualifier verbatim
  // (pre-push codex P1).
  const m = /^(.*\S)(\s*\([^()]*\))$/.exec(raw);
  if (m) {
    const base = byLower.get(m[1].toLowerCase());
    if (base) return `${base}${m[2]}`;
  }
  return null;
}

async function refreshCatalogNames(conn = require('../models/db')) {
  const rows = await conn('services').select('name', 'short_name');
  // Names stamped on visits FROM the catalog (service_id set) are catalog
  // identities too — an in-place rename must not strip historical rows of
  // their match and drop them onto the lossy regex map (codex P1).
  const historical = await conn('scheduled_services')
    .whereNotNull('service_id')
    .distinct('service_type');
  const next = renameSeed();
  for (const row of historical) {
    if (row.service_type) next.set(row.service_type.trim().toLowerCase(), row.service_type.trim());
  }
  for (const row of rows) {
    if (row.name) next.set(row.name.trim().toLowerCase(), row.name.trim());
  }
  // short_name is NOT unique (five "Lawn Care" rows, two "Mosquito") — alias
  // it only when exactly one catalog row owns it, and never over a full name.
  const shortOwners = new Map();
  for (const row of rows) {
    if (!row.short_name || !row.name) continue;
    const key = row.short_name.trim().toLowerCase();
    shortOwners.set(key, shortOwners.has(key) ? null : row.name.trim());
  }
  for (const [key, owner] of shortOwners) {
    if (owner && !next.has(key)) next.set(key, owner);
  }
  byLower = next;
  return next.size;
}

const REFRESH_MS = 10 * 60 * 1000;
const PRIME_TIMEOUT_MS = 5000;

// Resolves once the initial prime has completed (or timed out / failed —
// boot must never hang on a display cache), then keeps refreshing.
async function startCatalogNameRefresh(logger = console) {
  const run = () => refreshCatalogNames()
    .then((n) => logger.info?.(`[service-catalog-names] primed ${n} names`))
    .catch((err) => logger.error?.(`[service-catalog-names] refresh failed: ${err.message}`));
  await Promise.race([
    run(),
    new Promise((resolve) => setTimeout(resolve, PRIME_TIMEOUT_MS).unref()),
  ]);
  setInterval(run, REFRESH_MS).unref();
}

// Test seam — lets normalizer tests exercise the pass-through without a DB.
function __setCatalogNamesForTest(names = []) {
  byLower = new Map([...renameSeed(), ...names.map((n) => [n.trim().toLowerCase(), n.trim()])]);
}

/**
 * The identity a series CHILD is born with.
 *
 * Children used to copy parent.service_type verbatim. Series parents that
 * went terminal keep the label they closed under (Invariant 1 of the label
 * backfills, 20260829000010/000040), so a parent stamped before a catalog
 * rename kept birthing children with the retired name — and the reminder,
 * invoice and booking copies made from those children inherited it.
 *
 * Resolution, fail-closed to the parent's own label + linkage:
 *  1. Linked parent → the catalog row's CURRENT name (a rename after the
 *     parent was stamped propagates to every new child), same service_id.
 *  2. Unlinked parent → the label is bridged to a current name through the
 *     rename aliases (pre-rename form → current) or the legacy
 *     (label, cadence) map, then matched against exactly ONE active catalog
 *     row by name — the child is born linked to it (service_id +
 *     service_key). No active row, or an ambiguous name (two active rows),
 *     or the row lookup failing → verbatim label, unlinked: never a name
 *     the catalog doesn't carry, never a guessed linkage.
 *
 * Read on the caller's connection so a series spawn inside a transaction
 * sees its own snapshot and never waits on a second pool slot.
 */
async function resolveSeriesChildIdentity(conn, parent) {
  const verbatim = {
    service_type: (parent && parent.service_type) || 'Service',
    service_id: (parent && parent.service_id) || null,
    service_key: null,
  };
  if (!parent || !conn) return verbatim;
  try {
    if (parent.service_id) {
      const row = await conn('services').where({ id: parent.service_id }).first('id', 'name', 'service_key');
      return row && row.name
        ? { service_type: row.name, service_id: row.id, service_key: row.service_key || null }
        : verbatim;
    }
    const label = String(parent.service_type || '').trim();
    if (!label) return verbatim;
    const candidate = renamedCatalogName(label) || legacyCatalogName(label, parent.recurring_pattern) || label;
    const activeByName = (name) => conn('services')
      .whereRaw('lower(name) = lower(?)', [name])
      .where({ is_active: true })
      .select('id', 'name', 'service_key');
    let rows = await activeByName(candidate);
    if (candidate !== label) {
      // services.name is not unique and the Service Library can reactivate
      // an old spelling as its own row: the parent's exact label is evidence
      // too. Both spellings live → conflicting evidence → verbatim, unlinked.
      // Only the old spelling lives → it is the exact-name match.
      const exact = await activeByName(label);
      if (exact.length && rows.length) return verbatim;
      if (exact.length) rows = exact;
    }
    if (rows.length !== 1) return verbatim;
    return { service_type: rows[0].name, service_id: rows[0].id, service_key: rows[0].service_key || null };
  } catch (err) {
    try {
      require('./logger').warn(`[service-catalog-names] child identity resolution failed for parent ${parent.id || '?'} — using the parent label verbatim: ${err.message}`);
    } catch { /* logger unavailable in a pure-util context */ }
    return verbatim;
  }
}

module.exports = {
  canonicalCatalogName,
  refreshCatalogNames,
  startCatalogNameRefresh,
  resolveSeriesChildIdentity,
  __setCatalogNamesForTest,
};
