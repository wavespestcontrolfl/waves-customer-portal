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

// Signup-lane rows (directory / citation / social) are claimed by the signup
// runner, not the outreach worker, and legitimately coexist per location
// (two (domain, location) listings for one directory). They are NOT an open
// outreach conversation, so the outreach-lane claim ignores them; the
// recovery lane (lanes: 'all') still sees every row.
const { SIGNUP_TYPES } = require('./link-prospect-worker');

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

// Canonical board form of a Waves target page. The board's unique key is
// textual (target_domain, target_page) and existing rows use both
// https://wavespestcontrol.com/... and https://www.wavespestcontrol.com/...
// (always with a trailing slash), so: lookups try every variant, inserts use
// one canonical spelling (homepage bare — the 150-row majority — pages www).
function targetPathOf(url) {
  const raw = String(url || '').split('#')[0].split('?')[0];
  let path = '/';
  try { path = new URL(raw).pathname || '/'; } catch { path = raw.replace(/^https?:\/\/[^/]+/, '') || '/'; }
  path = path.replace(/\/+$/, '');
  return path ? `${path}/` : '/';
}
function targetPageOf(url) {
  const path = targetPathOf(url);
  return path === '/' ? 'https://wavespestcontrol.com/' : `https://www.wavespestcontrol.com${path}`;
}
function targetPageVariants(url) {
  const path = targetPathOf(url);
  const bare = path.replace(/\/$/, '');
  const out = new Set();
  for (const host of ['https://wavespestcontrol.com', 'https://www.wavespestcontrol.com', 'http://wavespestcontrol.com', 'http://www.wavespestcontrol.com']) {
    out.add(`${host}${path}`);
    if (bare) out.add(`${host}${bare}`);
  }
  return [...out];
}

/**
 * findPlacementRow(q, domain, targetPage, { excludeId }) → the board row for
 * this placement under ANY spelling of either half of the key — canonical
 * host for target_domain, every page variant for target_page — or null. The
 * unique index is textual, so a raw-pair check lets www.example.com + a
 * non-www page coexist with a canonical-equivalent row; every writer's
 * "does this placement already exist" check goes through here.
 */
async function findPlacementRow(q, domain, targetPage, { excludeId = null, columns = ['id', 'status', 'target_page'] } = {}) {
  const key = canonicalProspectDomain(domain);
  if (!key) return null;
  let qb = byDomain(q('seo_link_prospects'), key).whereIn('target_page', targetPageVariants(targetPage));
  if (excludeId) qb = qb.whereNot('id', excludeId);
  return (await qb.first(...columns)) || null;
}

async function lockProspectDomain(trx, domain) {
  const key = canonicalProspectDomain(domain);
  if (!key) return null;
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${LOCK_PREFIX}${key}`]);
  return key;
}

/**
 * claimProspectDomain(trx, domain, { statuses, lanes }) → { domain, inFlight }
 * lanes: 'outreach' (default) ignores signup-lane rows; 'all' sees every row.
 * Lock the canonical domain inside `trx`, then return the first board row for
 * that domain whose status is in `statuses` (null when the domain is free).
 * The caller inserts only when `inFlight` is null.
 */
async function claimProspectDomain(trx, domain, { statuses = ACTIVE_OUTREACH_STATUSES, lanes = 'outreach' } = {}) {
  const key = await lockProspectDomain(trx, domain);
  if (!key) return { domain: key, inFlight: null };
  const set = new Set(statuses);
  let qb = byDomain(trx('seo_link_prospects'), key).whereIn('status', [...set]);
  if (lanes === 'outreach') qb = qb.whereRaw(`COALESCE(link_type, '') NOT IN (${SIGNUP_TYPES.map(() => '?').join(', ')})`, [...SIGNUP_TYPES]);
  const row = await qb.first('id', 'status', 'target_page');
  // Belt and braces for test doubles / stale readers: only a row in the set counts.
  return { domain: key, inFlight: row && set.has(row.status) ? row : null };
}

module.exports = { lockProspectDomain, claimProspectDomain, findPlacementRow, canonicalProspectDomain, byDomain, TARGET_DOMAIN_CANONICAL_SQL, targetPathOf, targetPageOf, targetPageVariants, ACTIVE_OUTREACH_STATUSES, IN_FLIGHT_STATUSES, LOCK_PREFIX };
