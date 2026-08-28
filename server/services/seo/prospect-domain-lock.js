/**
 * The ONE per-domain admission mechanism for seo_link_prospects, used by every
 * writer (lost-link recovery insert + reopen, the admin manual add, the
 * strategy agent's create_link_prospects, the local-opportunity promoter, the
 * deep-harvest script).
 *
 * The board's unique key is the textual (target_domain, target_page) pair, so
 * two rows for one site — another Waves page, another spelling — never
 * conflict; both are claimable and the outreach worker would email one inbox
 * twice. claimProspectDomain() is the guard: inside the caller's transaction it
 * takes the domain's advisory lock (transaction-scoped, released at
 * commit/rollback) and then probes the board for a row already in flight for
 * that canonical domain on ANY page. Lock first, probe second: a competing
 * writer either committed before the probe (and is seen) or is still queued
 * behind the lock (and will see this writer's row). A lock alone would only
 * serialize the writers; the probe under it is what enforces the invariant.
 *
 * Which statuses exclude a new row is the caller's choice:
 *   - ACTIVE_OUTREACH_STATUSES (default) — prospect / contacted / negotiating:
 *     a conversation is open (or about to be) with that site's inbox. A site
 *     that already links to us (placed/live/indexed) can legitimately be
 *     pitched for a second page, so generic writers are not blocked by it.
 *   - IN_FLIGHT_STATUSES — the above plus placed / live / indexed: the
 *     recovery lane never files a recovery beside ANY board row (if a link is
 *     live there is nothing to recover; a stale live row defers instead).
 * The key string is stable — tests pin it.
 */

const LOCK_PREFIX = 'lost_recovery:';

const ACTIVE_OUTREACH_STATUSES = Object.freeze(['prospect', 'contacted', 'negotiating']);
const IN_FLIGHT_STATUSES = Object.freeze([...ACTIVE_OUTREACH_STATUSES, 'placed', 'live', 'indexed']);

// Canonical host: lower-cased, scheme/www/mail stripped, no path or port.
// Every writer hashes the same string for the same site.
function canonicalProspectDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^(www|mail)\./, '').replace(/[/:].*$/, '');
}

// SQL twin of canonicalProspectDomain() for the board's target_domain column,
// which the admin route stores verbatim (www.example.com, a full URL, mixed
// case): every board lookup compares the canonical host, never the raw
// spelling. No bare '?' (knex binding slot).
const TARGET_DOMAIN_CANONICAL_SQL = "split_part(split_part(regexp_replace(regexp_replace(regexp_replace(lower(btrim(target_domain)), '^https://', ''), '^http://', ''), '^(www|mail)\\.', ''), '/', 1), ':', 1)";
const byDomain = (q, domain) => q.whereRaw(`${TARGET_DOMAIN_CANONICAL_SQL} = ?`, [domain]);

async function lockProspectDomain(trx, domain) {
  const key = canonicalProspectDomain(domain);
  if (!key) return null;
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${LOCK_PREFIX}${key}`]);
  return key;
}

/**
 * claimProspectDomain(trx, domain, { statuses }) → { domain, inFlight }
 * Lock the canonical domain inside `trx`, then return the first board row for
 * that domain whose status is in `statuses` (null when the domain is free).
 * The caller inserts only when `inFlight` is null.
 */
async function claimProspectDomain(trx, domain, { statuses = ACTIVE_OUTREACH_STATUSES } = {}) {
  const key = await lockProspectDomain(trx, domain);
  if (!key) return { domain: key, inFlight: null };
  const set = new Set(statuses);
  const row = await byDomain(trx('seo_link_prospects'), key).whereIn('status', [...set]).first('id', 'status', 'target_page');
  // Belt and braces for test doubles / stale readers: only a row in the set counts.
  return { domain: key, inFlight: row && set.has(row.status) ? row : null };
}

module.exports = { lockProspectDomain, claimProspectDomain, canonicalProspectDomain, byDomain, TARGET_DOMAIN_CANONICAL_SQL, ACTIVE_OUTREACH_STATUSES, IN_FLIGHT_STATUSES, LOCK_PREFIX };
