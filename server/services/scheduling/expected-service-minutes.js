/**
 * Expected service minutes — the ONE place that turns a service identity
 * (a scheduled_services row's service_key_snapshot/service_type, or a
 * find-time candidate's own service) into "how long the tech is actually
 * expected to be on site", for the travel-gap padding formula
 * (scheduling/travel-gap.js requiredGapMinutes).
 *
 * Expected minutes = the midpoint of the catalog's min/max duration when
 * BOTH are set (quarterly pest 30-60 minutes -> 45), else
 * default_duration_minutes, else the WINDOW LENGTH itself (no catalog
 * signal -> zero padding -> the legacy drive+buffer gap, byte-identical).
 * Always clamped to <= the window length: a catalog default longer than the
 * customer's own window can never manufacture negative padding.
 *
 * Looked up by service_key first (a service_key_snapshot stamp, or a
 * find-time candidate's own serviceKey), then by services.name =
 * scheduled_services.service_type (the identity every older row carries,
 * per owner ruling 2026-09-23), then by services.category (a real catalog
 * key field — pest_control / lawn_care / mosquito / termite / rodent /
 * tree_shrub / …) for a caller that only knows a broad family, never a
 * cadence-specific key or exact catalog name (an ordinary /book funnel
 * selection, a combined-visit hold's reservation_service_mix engine keys —
 * Codex r3 P2/P1). The category credit AVERAGES the min/max midpoint across
 * every catalog row in that category with a usable range — a deliberately
 * coarse, conservative signal, never as precise as an exact key/name match.
 * Falls back to the window length when nothing resolves, or when no catalog
 * row/db handle is available at all — a missing signal never blocks a slot,
 * it only loses the padding credit.
 *
 * One in-memory catalog cache (TTL, like every other scheduling cache in
 * this directory): callers PRELOAD once per request/pass with
 * expectedServiceMinutes()/ensureCatalogLoaded(), then read synchronously
 * with expectedMinutesSync() for every candidate/stop pair without a query
 * per pair.
 */

const CATALOG_TTL_MS = 5 * 60 * 1000;

let catalogCache = null; // { byKey: Map<string, row>, byName: Map<string, row>, expiresAt }

function buildCatalogIndex(rows) {
  const byKey = new Map();
  const byName = new Map();
  const byCategory = new Map();
  const nameCounts = new Map();
  for (const row of (rows || [])) {
    if (!row) continue;
    if (row.service_key) byKey.set(String(row.service_key), row);
    if (row.name) {
      const name = String(row.name).trim().toLowerCase();
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      byName.set(name, row);
    }
    if (row.category) {
      const category = String(row.category).trim().toLowerCase();
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push(row);
    }
  }
  // services.name is NOT unique across active/inactive rows (migration
  // 20260829000060 treats such matches as ambiguous) — a duplicated name
  // resolves to NOTHING here rather than to whichever row came last, so a
  // legacy row without service_key_snapshot never borrows the wrong
  // service's padding (Codex r2 P1). Window-length fallback instead.
  for (const [name, count] of nameCounts) if (count > 1) byName.delete(name);
  return { byKey, byName, byCategory, expiresAt: Date.now() + CATALOG_TTL_MS };
}

/**
 * Populate (or refresh, past TTL) the shared catalog cache. Safe to call
 * often — a warm cache is a no-op. Fails open: a query error leaves any
 * existing cache in place (or an empty one on first load), never throws.
 */
async function ensureCatalogLoaded(conn) {
  if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache;
  if (!conn) return catalogCache;
  try {
    const rows = await selectCatalog(conn);
    catalogCache = buildCatalogIndex(rows);
  } catch {
    catalogCache = catalogCache || buildCatalogIndex([]);
  }
  return catalogCache;
}

// "Fails open" is only true OUTSIDE a transaction: a query that errors
// inside a caller's transaction (a reserve/commit under the date lock)
// leaves that transaction aborted, and every later statement — the commit
// itself — fails with "current transaction is aborted" (CI, combined-visit
// capacity suite, whose services fixture has no duration columns). Inside a
// transaction the read runs under a SAVEPOINT (knex nests a transaction on
// a trx as one), so a failed preload rolls back to the savepoint and the
// caller's transaction stays usable.
function selectCatalog(conn) {
  const read = (c) => c('services').select(
    'service_key', 'name', 'category', 'default_duration_minutes',
    'min_duration_minutes', 'max_duration_minutes',
  );
  if (conn.isTransaction && typeof conn.transaction === 'function') {
    return conn.transaction((savepoint) => read(savepoint));
  }
  return read(conn);
}

function clampToWindow(minutes, windowMinutes) {
  return Math.max(0, Math.min(minutes, windowMinutes));
}

function expectedFromCatalogRow(row, windowMinutes) {
  const min = Number(row?.min_duration_minutes);
  const max = Number(row?.max_duration_minutes);
  if (Number.isFinite(min) && min > 0 && Number.isFinite(max) && max > 0) {
    return clampToWindow((min + max) / 2, windowMinutes);
  }
  const def = Number(row?.default_duration_minutes);
  if (Number.isFinite(def) && def > 0) return clampToWindow(def, windowMinutes);
  return windowMinutes;
}

function catalogRowFor(serviceKey, serviceType) {
  if (!catalogCache) return null;
  if (serviceKey && catalogCache.byKey.has(String(serviceKey))) return catalogCache.byKey.get(String(serviceKey));
  if (serviceType) return catalogCache.byName.get(String(serviceType).trim().toLowerCase()) || null;
  return null;
}

// A broad family (services.category — pest_control / lawn_care / mosquito /
// termite / rodent / tree_shrub / …), never a single cadence-specific row:
// average the min/max midpoint across every row in that category with a
// usable range, each independently clamped to the window first. No rows
// with a range -> no signal (caller falls back to the window length).
function expectedFromCategoryRows(rows, windowMinutes) {
  const withRange = (rows || []).filter((row) => {
    const min = Number(row?.min_duration_minutes);
    const max = Number(row?.max_duration_minutes);
    return Number.isFinite(min) && min > 0 && Number.isFinite(max) && max > 0;
  });
  if (!withRange.length) return null;
  const total = withRange.reduce((sum, row) => sum + expectedFromCatalogRow(row, windowMinutes), 0);
  return clampToWindow(total / withRange.length, windowMinutes);
}

/**
 * Synchronous lookup against whatever is currently cached — a caller that
 * never preloaded (or whose preload failed) degrades to the window length:
 * no catalog signal, no padding, exactly the legacy gap.
 */
function expectedMinutesSync({ serviceKey = null, serviceType = null, category = null, windowMinutes } = {}) {
  const win = Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : 60;
  const row = catalogRowFor(serviceKey, serviceType);
  if (row) return expectedFromCatalogRow(row, win);
  if (category && catalogCache?.byCategory?.has(String(category).trim().toLowerCase())) {
    const fromCategory = expectedFromCategoryRows(catalogCache.byCategory.get(String(category).trim().toLowerCase()), win);
    if (fromCategory != null) return fromCategory;
  }
  return win;
}

/**
 * A whole visit's expected minutes from its service profile (the shape
 * estimate-slot-availability / slot-reservation carry: [{ catalogServiceKey,
 * engineKey, label, service, durationMinutes }]) — the SUM of every member's
 * own credit, each clamped to its own duration (else the visit window),
 * the sum clamped to the visit window. Reading only services[0] against the
 * whole window would credit a combined visit's other members' work toward
 * travel (push-audit P1, mirroring the version-2 allocation rule in
 * occupancy.js). No services -> the window length (zero padding).
 */
function expectedMinutesForServicesSync(services, windowMinutes) {
  const win = Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : 60;
  const list = Array.isArray(services) ? services.filter(Boolean) : [];
  if (!list.length) return win;
  let total = 0;
  for (const service of list) {
    const own = Number(service.durationMinutes) > 0 ? Math.min(Number(service.durationMinutes), win) : win;
    total += expectedMinutesSync({
      serviceKey: service.catalogServiceKey || service.engineKey || service.serviceKey || null,
      serviceType: service.label || service.service || service.serviceType || null,
      // A standard recurring/one-time estimate profile's own family lives
      // in `service` (estimate-slot-availability.js: "`service` is the
      // category") — pest_control / lawn_care / mosquito / tree_shrub, the
      // same vocabulary a combined-visit hold's reservation_service_mix
      // engine keys use. Tried as `serviceType` above too (for an exact
      // catalog-name match), but a bare family key like 'pest_control'
      // never matches a cadence-specific catalog name, so without this it
      // fell through to zero credit at accept-time profile validation
      // while /extend's mix-based lookup (candidateExpectedMinutesFromRow)
      // resolved a real one — an extend-succeeds/accept-409 identity
      // mismatch (Codex r4 P1). An explicit `.category` still wins.
      category: service.category || service.service || null,
      windowMinutes: own,
    });
  }
  return clampToWindow(total, win);
}

async function expectedMinutesForServices(conn, services, windowMinutes) {
  await ensureCatalogLoaded(conn);
  return expectedMinutesForServicesSync(services, windowMinutes);
}

/** Preload-then-read convenience for a single one-off lookup. */
async function expectedServiceMinutes(conn, opts = {}) {
  await ensureCatalogLoaded(conn);
  return expectedMinutesSync(opts);
}

function clearExpectedServiceMinutesCache() {
  catalogCache = null;
}

module.exports = {
  expectedServiceMinutes,
  expectedMinutesSync,
  expectedMinutesForServices,
  expectedMinutesForServicesSync,
  ensureCatalogLoaded,
  clearExpectedServiceMinutesCache,
  _internals: { expectedFromCatalogRow, expectedFromCategoryRows, buildCatalogIndex },
};
