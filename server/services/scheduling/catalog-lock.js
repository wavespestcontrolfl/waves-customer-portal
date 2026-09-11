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

// Bounded wait (codex #4369 r5 P1): PostgreSQL's default lock_timeout is
// unlimited and no application transaction sets one, so a reader queued
// behind a long catalog writer — the pre-deploy migration scanning and
// updating visits — would hold its transaction and pool connection until
// the writer finished, and the catalog_unavailable catches in the
// reservation, adoption and conversion paths would never see a lock error
// to translate. The timeout is transaction-local (SET LOCAL) and restored
// right after the acquisition so the caller's later statements keep their
// own budget; a timed-out LOCK aborts the (sub)transaction, which the
// callers already map to the recoverable 409.
const CATALOG_LOCK_WAIT_MS = 2000;
const LOCK_TIMEOUT_VALUE = /^[0-9]+(ms|s|min|h|d)?$/;

async function withLockWait(conn, ms, acquire) {
  const prior = await conn.raw("SELECT current_setting('lock_timeout') AS value");
  const previousRaw = String(prior?.rows?.[0]?.value ?? '0').trim();
  const previous = LOCK_TIMEOUT_VALUE.test(previousRaw) ? previousRaw : '0';
  await conn.raw(`SET LOCAL lock_timeout = '${ms}ms'`);
  await acquire();
  await conn.raw(`SET LOCAL lock_timeout = '${previous}'`);
}

async function lockCatalogIdentity(conn) {
  if (!conn?.isTransaction) {
    throw Object.assign(new Error('lockCatalogIdentity requires an open transaction'), { code: 'TRANSACTION_REQUIRED' });
  }
  await withLockWait(conn, CATALOG_LOCK_WAIT_MS, () => conn.raw(CATALOG_SHARE_LOCK_SQL));
}

// Writer side of the same scheme, for the ONE writer that pre-locks a
// services ROW before its write: deactivateService reads the row FOR UPDATE,
// checks references, then UPDATEs. A capacity reader holding SHARE later
// inserts a scheduled_services row whose service_id FK takes FOR KEY SHARE on
// that same service row — blocked by the writer's FOR UPDATE — while the
// writer's UPDATE waits for ROW EXCLUSIVE behind the reader's SHARE: a
// deadlock through the FK lock (codex #4369 r4 P1). Taking ROW EXCLUSIVE up
// front, before any row lock, puts the writer behind every in-flight
// certification and ahead of every later one, so it never holds a row lock
// a SHARE holder is waiting on. Writers that write without a prior row lock
// need nothing: their UPDATE/INSERT/DELETE takes ROW EXCLUSIVE first anyway.
const CATALOG_WRITE_LOCK_SQL = 'LOCK TABLE services IN ROW EXCLUSIVE MODE';

async function lockCatalogForWrite(conn) {
  if (!conn?.isTransaction) {
    throw Object.assign(new Error('lockCatalogForWrite requires an open transaction'), { code: 'TRANSACTION_REQUIRED' });
  }
  await conn.raw(CATALOG_WRITE_LOCK_SQL);
}

module.exports = { lockCatalogIdentity, lockCatalogForWrite, CATALOG_SHARE_LOCK_SQL, CATALOG_WRITE_LOCK_SQL, CATALOG_LOCK_WAIT_MS };
