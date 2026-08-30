/**
 * Backlink Manager v2 — step 2 "Enrich" (plan §4 step 3, §14 cost note).
 *
 * ONE DataForSEO bulk_ranks call + ONE bulk_spam_score call per batch of
 * ≤1000 registry domains (credit discipline), results cached on
 * `seo_link_domains.enrichment` with `enriched_at` so a domain is never
 * re-spent on unless `force`. Behind GATE_SEO_INTELLIGENCE — the gate is
 * checked here BEFORE any selection-sized API work (cheap prefilter), and
 * `dataforseo.request()` short-circuits again underneath.
 *
 * `competitors_linked` (distinct competitors per domain from
 * seo_competitor_backlinks) costs nothing and is written even when gated.
 *
 * Nothing here sends, moves money, or inserts registry rows.
 */

const { isEnabled } = require('../../config/feature-gates');
const { canonicalProspectDomain } = require('./prospect-domain-lock');

const BULK_MAX = 1000;
// One enrich run at a time across instances and the admin job: a SESSION
// advisory lock on a dedicated pooled connection (utils/cron-lock.runExclusive)
// — released in finally, never held inside a transaction, so a stalled
// DataForSEO request can hold at most that one connection. An overlapping run
// is SKIPPED (`skipped: 'lease_held'`), never queued.
const ENRICH_LOCK_KEY = 'link-registry-enrich';
const defaultExclusive = (name, fn) => require('../../utils/cron-lock').runExclusive(name, fn, { recordHealth: false });
// §4 enrich = rank, spam, referring domains, traffic — one bulk call each per
// batch (≤1000 targets). enrichment JSON caches every raw item under its key.
const BULK_CALLS = Object.freeze([
  ['bulk_ranks', 'bulkRanks'],
  ['bulk_spam_score', 'bulkSpamScore'],
  ['bulk_referring_domains', 'bulkReferringDomains'],
  ['bulk_traffic', 'bulkTrafficEstimation'],
]);

const items = (resp) => {
  const r = resp && resp.tasks && resp.tasks[0] && resp.tasks[0].result;
  if (!r) return null; // null/absent result = whole-call failure (gate, auth, transport)
  if (Array.isArray(r) && r[0] && Array.isArray(r[0].items)) return r[0].items;
  return Array.isArray(r) ? r : null;
};

const intOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** Select the candidates: explicit ids, else un-enriched (or everything when force). owner_seed first.
 * enriched_at is re-checked INSIDE the per-batch lock (enrichDomains) unless force — selection is advisory. */
async function selectDomains(db, { domainIds, limit, force }) {
  let q = db('seo_link_domains').select('id', 'domain', 'discovery_priority', 'enriched_at');
  if (Array.isArray(domainIds)) {
    if (domainIds.length === 0) return [];
    q = q.whereIn('id', domainIds);
  } else if (!force) {
    q = q.whereNull('enriched_at');
  }
  q = q.orderByRaw("CASE WHEN discovery_priority = 'owner_seed' THEN 0 ELSE 1 END").orderBy('created_at', 'asc');
  if (limit != null && limit > 0) q = q.limit(limit);
  return q;
}

/**
 * competitorsLinked(db, hosts) → Map<canonicalHost, distinctCompetitorCount>
 * One query for the batch; raw source_domain spellings (www.) are folded onto
 * the canonical host in JS. No credits.
 */
async function competitorsLinked(db, hosts) {
  const counts = new Map();
  if (!hosts.length) return counts;
  const variants = [...new Set(hosts.flatMap((h) => [h, `www.${h}`]))];
  const rows = await db('seo_competitor_backlinks').distinct('source_domain', 'competitor_domain').whereIn('source_domain', variants);
  const sets = new Map();
  for (const r of rows || []) {
    const host = canonicalProspectDomain(r.source_domain);
    const comp = canonicalProspectDomain(r.competitor_domain);
    if (!host || !comp) continue;
    if (!sets.has(host)) sets.set(host, new Set());
    sets.get(host).add(comp);
  }
  for (const [host, set] of sets) counts.set(host, set.size);
  return counts;
}

/**
 * enrichDomains(db, { domainIds, limit, force, dryRun, now, dataforseo })
 *   → { dryRun, gated, selected, enriched, skippedClaimed, failed, calls, skipped? }
 *
 * - skipped: 'lease_held' when another enrich run holds the session lock
 *   (overlapping scheduler / admin runs never spend twice and never queue).
 *
 * - gated: no API call; competitors_linked still written (not dryRun).
 * - dryRun: selection + counts only; zero writes, zero API calls.
 * - Per batch of ≤1000: one call per BULK_CALLS entry (rank, spam, referring
 *   domains, traffic). A thrown DataForSEO
 *   error propagates before any write for that batch. A null response (the
 *   client swallows transport/auth failures into null) is a batch failure:
 *   every domain in it lands in `failed` and keeps enriched_at NULL so the
 *   next run retries. A domain absent from a non-null response gets
 *   enriched_at + `{ missing: true }` so we never re-spend on it.
 */
async function enrichDomains(db, { domainIds = null, limit = 500, force = false, dryRun = false, now = new Date(), dataforseo = require('./dataforseo'), exclusive = defaultExclusive } = {}) {
  const rows = await selectDomains(db, { domainIds, limit, force });
  const gated = !isEnabled('seoIntelligence');
  const out = { dryRun, gated, selected: rows.length, enriched: 0, skippedClaimed: 0, failed: [], calls: 0 };
  if (!rows.length) return out;

  const hosts = rows.map((r) => canonicalProspectDomain(r.domain)).filter(Boolean);
  const linked = await competitorsLinked(db, [...new Set(hosts)]);
  if (dryRun) {
    out.wouldCall = gated ? 0 : chunk(rows, BULK_MAX).length * BULK_CALLS.length;
    return out;
  }

  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  const stamp = (v) => (v == null ? null : new Date(v).getTime());
  const freeSignal = (r) => ({ competitors_linked: linked.get(canonicalProspectDomain(r.domain)) || 0, updated_at: now });

  if (gated) {
    // No credits, no lock: competitors_linked is a free signal.
    for (const batch of chunk(rows, BULK_MAX)) {
      await db.transaction(async (trx) => {
        for (const r of batch) await trx('seo_link_domains').where({ id: r.id }).update(freeSignal(r));
      });
    }
    return out;
  }

  const ran = await exclusive(ENRICH_LOCK_KEY, async () => {
    for (const candidates of chunk(rows, BULK_MAX)) {
      // 1. Freshness check — a row is spent on only if its enriched_at is
      //    still what selection saw (NULL normally; the same stamp for a
      //    forced refresh). Plain read: the session lock serializes runs.
      const current = await db('seo_link_domains').select('id', 'enriched_at').whereIn('id', candidates.map((r) => r.id));
      const seen = new Map((current || []).map((r) => [r.id, stamp(r.enriched_at)]));
      const fresh = (r) => seen.has(r.id) && seen.get(r.id) === (force ? stamp(r.enriched_at) : null);
      out.skippedClaimed += candidates.filter((r) => !fresh(r)).length;
      const batch = candidates.filter(fresh);
      if (!batch.length) continue;
      const targets = [...new Set(batch.map((r) => canonicalProspectDomain(r.domain)).filter(Boolean))];

      // 2. All four bulk calls complete (or throw) OUTSIDE any transaction and
      //    BEFORE any write — §4 enrich = rank, spam, referring domains,
      //    traffic. A null response from ANY of them fails the whole batch:
      //    enriched_at stays NULL so the next run retries; nothing partial is
      //    ever marked done.
      const responses = {};
      for (const [key, method] of BULK_CALLS) {
        responses[key] = items(await dataforseo[method](targets));
        out.calls += 1;
        if (!responses[key]) break; // the batch already failed — never pay for calls whose results would be discarded
      }
      const patches = [];
      const missingCall = BULK_CALLS.find(([key]) => !responses[key]);
      if (missingCall) {
        for (const r of batch) out.failed.push({ id: r.id, domain: r.domain, reason: `${missingCall[0]}_no_response` });
        for (const r of batch) patches.push({ row: r, patch: freeSignal(r) }); // still write the free signal
      } else {
        const byHost = {};
        for (const [key] of BULK_CALLS) {
          byHost[key] = new Map();
          for (const it of responses[key]) { const h = canonicalProspectDomain(it && it.target); if (h) byHost[key].set(h, it); }
        }
        for (const r of batch) {
          try {
            const host = canonicalProspectDomain(r.domain);
            const hit = Object.fromEntries(BULK_CALLS.map(([key]) => [key, byHost[key].get(host) || null]));
            const patch = { ...freeSignal(r), enriched_at: now };
            // A forced refresh REPLACES the metric set: anything the fresh fetch does
            // not carry is cleared, never left as a stale value beside a new enriched_at.
            if (force) Object.assign(patch, { domain_rating: null, spam_score: null, referring_domains: null, organic_traffic: null });
            if (BULK_CALLS.every(([key]) => !hit[key])) {
              patch.enrichment = JSON.stringify({ missing: true, fetched_at: nowIso });
            } else {
              const enrichment = { fetched_at: nowIso };
              for (const [key] of BULK_CALLS) enrichment[key] = hit[key] || { missing: true };
              const dr = hit.bulk_ranks ? intOrNull(hit.bulk_ranks.rank) : null; // one_hundred scale (dataforseo.bulkRanks)
              if (dr != null) patch.domain_rating = dr;
              const ss = hit.bulk_spam_score ? intOrNull(hit.bulk_spam_score.spam_score) : null;
              if (ss != null) patch.spam_score = ss;
              const rd = hit.bulk_referring_domains ? intOrNull(hit.bulk_referring_domains.referring_domains) : null;
              if (rd != null) patch.referring_domains = rd;
              const organic = hit.bulk_traffic && hit.bulk_traffic.metrics && hit.bulk_traffic.metrics.organic;
              const traffic = organic ? intOrNull(organic.etv) : null;
              if (traffic != null) patch.organic_traffic = traffic;
              patch.enrichment = JSON.stringify(enrichment);
            }
            patches.push({ row: r, patch });
          } catch (err) {
            out.failed.push({ id: r.id, domain: r.domain, reason: `map_error: ${err.message}` });
          }
        }
      }

      // 3. Persist, conditionally: each write lands only while the row still
      //    carries the stamp the freshness check saw (a short transaction —
      //    nothing external runs inside it).
      await db.transaction(async (trx) => {
        for (const { row, patch } of patches) {
          const was = seen.get(row.id);
          let q = trx('seo_link_domains').where({ id: row.id });
          q = was == null ? q.whereNull('enriched_at') : q.where({ enriched_at: new Date(was) });
          const n = await q.update(patch);
          if (!n) { out.skippedClaimed += 1; continue; }
          if (patch.enriched_at) out.enriched += 1;
        }
      });
    }
    return out;
  });
  if (ran && ran.skipped) return { ...out, skipped: ran.reason || true };
  return out;
}

module.exports = { enrichDomains, competitorsLinked, BULK_MAX, BULK_CALLS, ENRICH_LOCK_KEY, _test: { items, selectDomains } };
