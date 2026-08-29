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

const { CADENCE_CONVENTION_RENAMES, counterpartServiceName, legacyCatalogName } = require('../config/service-name-aliases');

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
    // SAVEPOINT (nested trx) when the caller handed us a transaction — the
    // same posture as customerPrefersNoWeekends: a failed optional catalog
    // read would otherwise leave the caller's trx ABORTED in Postgres
    // despite the catch below (try/catch in a trx ≠ fail-open), and the
    // child insert right after it would 25P02 instead of falling back to
    // the parent label (codex #3604 r4 P1).
    const read = (dbh) => resolveFromCatalog(dbh, parent, verbatim);
    return conn.isTransaction && typeof conn.transaction === 'function'
      ? await conn.transaction((sp) => read(sp))
      : await read(conn);
  } catch (err) {
    try {
      require('./logger').warn(`[service-catalog-names] child identity resolution failed for parent ${parent.id || '?'} — using the parent label verbatim: ${err.message}`);
    } catch { /* logger unavailable in a pure-util context */ }
    return verbatim;
  }
}

async function resolveFromCatalog(conn, parent, verbatim) {
  {
    // Inside a transaction the chosen catalog row is share-locked through
    // the child insert: the Service Library renames with a plain UPDATE and
    // shares no lock with this read, so without it a rename landing between
    // this SELECT and the insert would stamp the retired name next to the
    // renamed row's id (codex #3604 r5 P2). The savepoint that runs this
    // read releases into the outer transaction, which keeps the lock.
    const stable = (q) => (conn.isTransaction && typeof q.forShare === 'function' ? q.forShare() : q);
    if (parent.service_id) {
      const row = await stable(conn('services').where({ id: parent.service_id })).first('id', 'name', 'service_key');
      return row && row.name
        ? { service_type: row.name, service_id: row.id, service_key: row.service_key || null }
        : verbatim;
    }
    // DURABLE snapshot evidence outranks any label bridging — exactly as
    // lookupServiceForScheduledService orders it (id → service_key_snapshot
    // → name). An unlinked parent whose snapshot names service A while its
    // label maps to B must never birth a B-linked child carrying A's
    // snapshot (codex #3604 r2 P0). Snapshot naming no active row → verbatim.
    const snapshotKey = String(parent.service_key_snapshot || '').trim();
    if (snapshotKey) {
      const byKey = await stable(conn('services')
        .where({ service_key: snapshotKey, is_active: true }))
        .select('id', 'name', 'service_key');
      return byKey.length === 1 && byKey[0].name
        ? { service_type: byKey[0].name, service_id: byKey[0].id, service_key: byKey[0].service_key || null }
        : verbatim;
    }
    const label = String(parent.service_type || '').trim();
    if (!label) return verbatim;
    // Bridge the label to a catalog name:
    //  - cadence-qualified pre-rename labels ("Lawn Care Program Service
    //    (Quarterly)") are the population 000010 relabels with the qualifier
    //    preserved and canonicalCatalogName resolves by BASE — the catalog
    //    never carries the qualifier, so the base is what is looked up
    //    (codex #3604 r6 P1);
    //  - the rename bridge is BIDIRECTIONAL (counterpartServiceName), the
    //    same contract service-completion-profiles uses: with 000010 rolled
    //    back while this code is deployed, a parent stamped with the new
    //    spelling must resolve to the restored old row (r6 P1). In the
    //    normal direction the counterpart is the retired spelling, which
    //    no active row carries, so the exact-name branch below decides.
    // The FULL label is bridged first — several renamed names carry their
    // own parenthetical ("General Pest Control Service (Bi-Monthly)"); only
    // a label no alias knows falls back to its base.
    const bridge = (l) => counterpartServiceName(l) || legacyCatalogName(l, parent.recurring_pattern) || null;
    let base = label;
    let candidate = bridge(label);
    if (!candidate) {
      const qualified = /^(.*\S)(\s*\([^()]*\))$/.exec(label);
      if (qualified) {
        base = qualified[1];
        candidate = bridge(base);
      }
    }
    if (!candidate) candidate = base;
    // services.name is not unique and the Service Library can reactivate an
    // old spelling as its own row: the parent's exact label is evidence too.
    // Both spellings are read in ONE statement so the decision comes from
    // one catalog snapshot (a rename committing between two reads could
    // otherwise link from a stale row — r2 P2). Both live → conflicting
    // evidence → verbatim, unlinked. Only the old spelling lives → it is the
    // exact-name match.
    const names = candidate.toLowerCase() === base.toLowerCase() ? [candidate] : [candidate, base];
    const rows = await stable(conn('services')
      .whereRaw(`lower(name) IN (${names.map(() => 'lower(?)').join(', ')})`, names)
      .where({ is_active: true }))
      .select('id', 'name', 'service_key');
    const mapped = rows.filter((r) => String(r.name).toLowerCase() === candidate.toLowerCase());
    const exact = names.length === 2 ? rows.filter((r) => String(r.name).toLowerCase() === base.toLowerCase()) : [];
    if (mapped.length && exact.length) return verbatim;
    const hit = mapped.length ? mapped : exact;
    if (hit.length !== 1) return verbatim;
    return { service_type: hit[0].name, service_id: hit[0].id, service_key: hit[0].service_key || null };
  }
}

module.exports = {
  canonicalCatalogName,
  refreshCatalogNames,
  startCatalogNameRefresh,
  resolveSeriesChildIdentity,
  __setCatalogNamesForTest,
};
