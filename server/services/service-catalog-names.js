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

let byLower = new Map();

function canonicalCatalogName(text) {
  if (!text) return null;
  return byLower.get(String(text).trim().toLowerCase()) || null;
}

async function refreshCatalogNames(conn = require('../models/db')) {
  const rows = await conn('services').select('name', 'short_name');
  // Names stamped on visits FROM the catalog (service_id set) are catalog
  // identities too — an in-place rename must not strip historical rows of
  // their match and drop them onto the lossy regex map (codex P1).
  const historical = await conn('scheduled_services')
    .whereNotNull('service_id')
    .distinct('service_type');
  const next = new Map();
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
  byLower = new Map(names.map((n) => [n.trim().toLowerCase(), n.trim()]));
}

module.exports = { canonicalCatalogName, refreshCatalogNames, startCatalogNameRefresh, __setCatalogNamesForTest };
