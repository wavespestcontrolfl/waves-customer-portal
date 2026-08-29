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

const { CADENCE_CONVENTION_RENAMES } = require('../config/service-name-aliases');

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

module.exports = { canonicalCatalogName, refreshCatalogNames, startCatalogNameRefresh, __setCatalogNamesForTest };
