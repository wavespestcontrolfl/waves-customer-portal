// Catalog-identity advisory lock — serializes duration-authority catalog
// READS against catalog WRITES (create / update / archive in
// service-library.js) for the one case a row lock cannot cover: an ABSENT
// match.
//
// A reservation or acceptance that certifies capacity re-resolves the
// service's catalog row and holds every MATCHED row FOR SHARE until the outer
// transaction commits, so an admin edit cannot overtake a validated
// allowance. When the lookup finds NO row (unmapped engine key, cadence with
// no active row) there is nothing to row-lock: under READ COMMITTED an admin
// can activate or map a longer-duration row after that SELECT and before the
// outer commit, and a version-2 hold carrying the 60-minute fallback
// graduates against a policy it never saw (codex #4344 P1, posted after
// merge). Readers take this lock SHARED before the lookup and hold it to
// their commit; catalog writers take it EXCLUSIVE before their write. Shared
// holders never block each other, so concurrent bookings are unaffected; a
// catalog write waits out in-flight certifications (milliseconds).
//
// Lock order: readers reach this lock AFTER rung 1 / tech-day fences and
// their estimate + hold row locks, and BEFORE any services row lock (the
// FOR SHARE reads follow it). Writers take ONLY this lock, EXCLUSIVE, before
// their services row lock, and hold no scheduling lock — so a writer never
// holds anything a reader could be waiting on: no lock-order cycle.
//
// xact-scoped: `conn` MUST already be inside a transaction. A missing
// transaction throws rather than silently no-op'ing — a no-op would recreate
// the exact race this exists to close.
const CATALOG_LOCK_NAMESPACE = 'slot-reserve';
const CATALOG_LOCK_KEY = 'catalog-identity';

async function lockCatalogIdentity(conn, { exclusive = false } = {}) {
  if (!conn?.isTransaction) {
    throw Object.assign(new Error('lockCatalogIdentity requires an open transaction'), { code: 'TRANSACTION_REQUIRED' });
  }
  const sql = exclusive
    ? 'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))'
    : 'SELECT pg_advisory_xact_lock_shared(hashtext(?), hashtext(?::text))';
  await conn.raw(sql, [CATALOG_LOCK_NAMESPACE, CATALOG_LOCK_KEY]);
}

module.exports = { lockCatalogIdentity, CATALOG_LOCK_NAMESPACE, CATALOG_LOCK_KEY };
