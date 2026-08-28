/**
 * One advisory lock per canonical board domain, shared by EVERY writer of
 * seo_link_prospects (lost-link recovery, the admin manual add, the strategy
 * agent's create_link_prospects, the local-opportunity promoter).
 *
 * Why one lock for all of them: the board's unique key is the textual
 * (target_domain, target_page) pair, but the recovery lane's invariant is
 * DOMAIN-wide — never file a recovery prospect beside a row already in flight
 * for that domain on any Waves page. Recovery enforces that with a re-check
 * under this lock; the re-check only excludes writers that take the SAME lock.
 * A manual or strategy insert for the same domain on another page that did not
 * lock would land between the re-check and the recovery insert, leaving two
 * claimable rows → parallel outreach to one inbox.
 *
 * Transaction-scoped (pg_advisory_xact_lock): released at commit/rollback, so
 * a caller MUST take it inside the transaction that does the check + insert.
 * The key string is stable — tests pin it.
 */

const LOCK_PREFIX = 'lost_recovery:';

// Same canonical host as lost-link-recovery's normalizeDomain() and its SQL
// twin TARGET_DOMAIN_CANONICAL_SQL: lower-cased, scheme/www/mail stripped, no
// path or port. Every writer hashes the same string for the same site.
function canonicalProspectDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^(www|mail)\./, '').replace(/[/:].*$/, '');
}

async function lockProspectDomain(trx, domain) {
  const key = canonicalProspectDomain(domain);
  if (!key) return null;
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${LOCK_PREFIX}${key}`]);
  return key;
}

module.exports = { lockProspectDomain, canonicalProspectDomain, LOCK_PREFIX };
