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
  const next = new Map();
  for (const row of rows) {
    if (row.name) next.set(row.name.trim().toLowerCase(), row.name.trim());
    // short_name is an alias for the same catalog identity — display the full name.
    if (row.short_name && row.name) next.set(row.short_name.trim().toLowerCase(), row.name.trim());
  }
  byLower = next;
  return next.size;
}

const REFRESH_MS = 10 * 60 * 1000;

function startCatalogNameRefresh(logger = console) {
  const run = () => refreshCatalogNames()
    .then((n) => logger.info?.(`[service-catalog-names] primed ${n} names`))
    .catch((err) => logger.error?.(`[service-catalog-names] refresh failed: ${err.message}`));
  void run();
  setInterval(run, REFRESH_MS).unref();
}

// Test seam — lets normalizer tests exercise the pass-through without a DB.
function __setCatalogNamesForTest(names = []) {
  byLower = new Map(names.map((n) => [n.trim().toLowerCase(), n.trim()]));
}

module.exports = { canonicalCatalogName, refreshCatalogNames, startCatalogNameRefresh, __setCatalogNamesForTest };
