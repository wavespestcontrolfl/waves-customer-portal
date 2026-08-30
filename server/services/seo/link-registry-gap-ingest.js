/**
 * Backlink Manager v2 — step 2 competitor-gap feeder (plan §4 "Feeders").
 *
 * Every seo_competitor_backlinks source domain goes through the deduping
 * registry intake BY SERVICE (never HTTP): an unknown host inserts a registry
 * row with first-touch `competitor_gap`; a known host only gets the idempotent
 * `competitor_gap` touch on seo_link_domain_sources (ensureDomain ignores the
 * UNIQUE(domain_id, touch_key) repeat), so any-touch attribution and D30
 * learning for this source are never lost to prior discovery.
 *
 * Own hosts and never-target hosts are skipped with a reason. No enrichment
 * here — the scheduler wires enrichDomains after ingestion. No credits spent.
 */

const { canonicalProspectDomain } = require('./prospect-domain-lock');
const { ensureDomain, isNeverTargetHost } = require('./link-registry');
const { SPOKE_SITE_KEYS } = require('../content-astro/spoke-sites');

const SOURCE = 'competitor_gap';
const SOURCE_DETAIL = 'competitor_gap_scan';

// Same derivation as link-registry.js NEVER_TARGET_HOSTS' Waves entries: the
// hub plus every spoke key; subdomains match.
const OWN_HOSTS = Object.freeze(['wavespestcontrol.com', ...SPOKE_SITE_KEYS]);
function isOwnHost(host) {
  const h = canonicalProspectDomain(host);
  if (!h) return false;
  return OWN_HOSTS.some((n) => h === n || h.endsWith(`.${n}`));
}

/** Pure: raw source_domain strings → { candidates: [canonical], skipped: [{domain, reason}] }, deduped. */
function classifyGapDomains(rawDomains) {
  const seen = new Set();
  const skippedSeen = new Set();
  const candidates = [];
  const skipped = [];
  for (const raw of rawDomains) {
    const host = canonicalProspectDomain(raw);
    if (!host) { skipped.push({ domain: String(raw == null ? '' : raw), reason: 'invalid' }); continue; }
    if (seen.has(host) || skippedSeen.has(host)) continue;
    if (isOwnHost(host)) { skippedSeen.add(host); skipped.push({ domain: host, reason: 'own_domain' }); continue; }
    if (isNeverTargetHost(host)) { skippedSeen.add(host); skipped.push({ domain: host, reason: 'never_target' }); continue; }
    seen.add(host);
    candidates.push(host);
  }
  return { candidates, skipped };
}

/**
 * ingestCompetitorGap(db, { dryRun, since, limit, now })
 *   → { dryRun, scanned, candidates, inserted, touched, existing, skipped: [{domain, reason}] }
 *
 * - scanned: distinct raw source domains read (optionally first_seen >= since).
 * - dryRun: one whereIn on seo_link_domains to split would-insert vs existing; no writes.
 * - Otherwise every candidate goes through ensureDomain in ONE transaction.
 */
async function ingestCompetitorGap(db, { dryRun = false, since = null, limit = null, now = new Date() } = {}) {
  let q = db('seo_competitor_backlinks').distinct('source_domain');
  if (since) q = q.where('first_seen', '>=', since);
  const rows = await q;
  const raw = (rows || []).map((r) => r.source_domain);
  let { candidates, skipped } = classifyGapDomains(raw);
  if (limit != null && limit > 0) candidates = candidates.slice(0, limit);

  const out = { dryRun, scanned: raw.length, candidates: candidates.length, inserted: 0, touched: 0, existing: 0, skipped };
  if (!candidates.length) return out;

  if (dryRun) {
    const known = await db('seo_link_domains').select('domain').whereIn('domain', candidates);
    const knownSet = new Set((known || []).map((k) => k.domain));
    out.existing = candidates.filter((c) => knownSet.has(c)).length;
    out.inserted = candidates.length - out.existing;
    return out;
  }

  await db.transaction(async (trx) => {
    for (const domain of candidates) {
      const r = await ensureDomain(trx, { domain, source: SOURCE, sourceDetail: SOURCE_DETAIL, sourceRef: null, seenAt: now });
      if (r.created) out.inserted += 1;
      else {
        out.existing += 1;
        if (r.touched) out.touched += 1;
      }
    }
  });
  return out;
}

module.exports = { ingestCompetitorGap, classifyGapDomains, isOwnHost, OWN_HOSTS, SOURCE, SOURCE_DETAIL };
