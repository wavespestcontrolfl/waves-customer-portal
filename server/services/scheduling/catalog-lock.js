// Catalog table SHARE lock — serializes duration-authority catalog READS
// against EVERY catalog WRITE for the one case a row lock cannot cover: an
// ABSENT match.
//
// A reservation or acceptance that certifies capacity re-resolves the
// service's catalog row and holds every MATCHED row FOR SHARE until the outer
// transaction commits, so an admin edit cannot overtake a validated
// allowance. When the lookup finds NO row (unmapped engine key, cadence with
// no active row) there is nothing to row-lock: under READ COMMITTED a writer
// can activate or map a longer-duration row after that SELECT and before the
// outer commit, and a version-2 hold carrying the 60-minute fallback
// graduates against a policy it never saw (codex #4344 P1, posted after
// merge).
//
// Enforced by the DATABASE, not by writer discipline (codex #4369 r1 P1):
// `LOCK TABLE services IN SHARE MODE` conflicts with ROW EXCLUSIVE — the lock
// every INSERT / UPDATE / DELETE on `services` takes implicitly — and with
// the SHARE ROW EXCLUSIVE lock the engine-key migrations take explicitly. So
// service-library's admin writes AND Railway pre-deploy migrations (which run
// while previous instances are still live, railway.toml) wait out any
// in-flight certification, with no advisory-lock convention for a writer to
// forget. SHARE does not conflict with SHARE or with the ROW SHARE lock a
// FOR SHARE read takes, so concurrent bookings never block each other.
// Held to the outer commit; released with it.
//
// Lock order: readers reach this lock AFTER rung 1 / tech-day fences and
// their estimate + hold row locks, and BEFORE any services row lock (the
// FOR SHARE reads follow it). Writers hold no scheduling lock before their
// services write, so a writer never holds anything a reader could be
// waiting on: no lock-order cycle.
//
// xact-scoped: `conn` MUST already be inside a transaction. A missing
// transaction throws rather than silently no-op'ing — a no-op would recreate
// the exact race this exists to close.
const CATALOG_SHARE_LOCK_SQL = 'LOCK TABLE services IN SHARE MODE';

async function lockCatalogIdentity(conn) {
  if (!conn?.isTransaction) {
    throw Object.assign(new Error('lockCatalogIdentity requires an open transaction'), { code: 'TRANSACTION_REQUIRED' });
  }
  await conn.raw(CATALOG_SHARE_LOCK_SQL);
}

module.exports = { lockCatalogIdentity, CATALOG_SHARE_LOCK_SQL };
