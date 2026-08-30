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
const ENRICH_LOCK_KEY = 'seo_link_enrich'; // pg_advisory_xact_lock(hashtext(key)) around every paid batch

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
 *   → { dryRun, gated, selected, enriched, failed, calls }
 *
 * - gated: no API call; competitors_linked still written (not dryRun).
 * - dryRun: selection + counts only; zero writes, zero API calls.
 * - Per batch of ≤1000: one bulkRanks + one bulkSpamScore. A thrown DataForSEO
 *   error propagates before any write for that batch. A null response (the
 *   client swallows transport/auth failures into null) is a batch failure:
 *   every domain in it lands in `failed` and keeps enriched_at NULL so the
 *   next run retries. A domain absent from a non-null response gets
 *   enriched_at + `{ missing: true }` so we never re-spend on it.
 */
async function enrichDomains(db, { domainIds = null, limit = 500, force = false, dryRun = false, now = new Date(), dataforseo = require('./dataforseo') } = {}) {
  const rows = await selectDomains(db, { domainIds, limit, force });
  const gated = !isEnabled('seoIntelligence');
  const out = { dryRun, gated, selected: rows.length, enriched: 0, skippedClaimed: 0, failed: [], calls: 0 };
  if (!rows.length) return out;

  const hosts = rows.map((r) => canonicalProspectDomain(r.domain)).filter(Boolean);
  const linked = await competitorsLinked(db, [...new Set(hosts)]);
  if (dryRun) {
    out.wouldCall = gated ? 0 : chunk(rows, BULK_MAX).length * 2;
    return out;
  }

  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  for (const candidates of chunk(rows, BULK_MAX)) {
    await db.transaction(async (trx) => {
      const patches = [];
      let batch = candidates;

      if (gated) {
        for (const r of batch) {
          const host = canonicalProspectDomain(r.domain);
          patches.push({ id: r.id, patch: { competitors_linked: linked.get(host) || 0, updated_at: now } });
        }
      } else {
        // Credit discipline: one enrich run at a time across instances and the
        // admin job. The transaction-scoped advisory lock is held through the
        // paid calls, and the batch is re-checked INSIDE it, so two overlapping
        // runs can never both see enriched_at IS NULL for the same domain.
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [ENRICH_LOCK_KEY]);
        if (!force) {
          const still = await trx('seo_link_domains').select('id').whereIn('id', batch.map((r) => r.id)).whereNull('enriched_at');
          const open = new Set((still || []).map((r) => r.id));
          out.skippedClaimed += batch.filter((r) => !open.has(r.id)).length;
          batch = batch.filter((r) => open.has(r.id));
        }
        if (!batch.length) return;
        const targets = [...new Set(batch.map((r) => canonicalProspectDomain(r.domain)).filter(Boolean))];

        // Both calls complete (or throw) BEFORE any write for this batch.
        const ranksResp = await dataforseo.bulkRanks(targets);
        out.calls += 1;
        const spamResp = await dataforseo.bulkSpamScore(targets);
        out.calls += 1;
        const ranks = items(ranksResp);
        const spam = items(spamResp);
        if (!ranks || !spam) {
          for (const r of batch) out.failed.push({ id: r.id, domain: r.domain, reason: !ranks ? 'bulk_ranks_no_response' : 'bulk_spam_score_no_response' });
          // still write the free signal
          for (const r of batch) patches.push({ id: r.id, patch: { competitors_linked: linked.get(canonicalProspectDomain(r.domain)) || 0, updated_at: now } });
        } else {
          const byHostRank = new Map();
          for (const it of ranks) { const h = canonicalProspectDomain(it && it.target); if (h) byHostRank.set(h, it); }
          const byHostSpam = new Map();
          for (const it of spam) { const h = canonicalProspectDomain(it && it.target); if (h) byHostSpam.set(h, it); }

          for (const r of batch) {
            try {
              const host = canonicalProspectDomain(r.domain);
              const rk = byHostRank.get(host) || null;
              const sp = byHostSpam.get(host) || null;
              const patch = { competitors_linked: linked.get(host) || 0, enriched_at: now, updated_at: now };
              if (!rk && !sp) {
                patch.enrichment = JSON.stringify({ missing: true, fetched_at: nowIso });
              } else {
                const enrichment = { fetched_at: nowIso };
                if (rk) {
                  enrichment.bulk_ranks = rk;
                  // bulk_ranks items are { target, rank } on the one_hundred scale
                  // (dataforseo.bulkRanks); referring_domains / organic_traffic
                  // have no source in this pass and stay untouched.
                  const dr = intOrNull(rk.rank);
                  if (dr != null) patch.domain_rating = dr;
                } else enrichment.bulk_ranks = { missing: true };
                if (sp) {
                  enrichment.bulk_spam_score = sp;
                  const ss = intOrNull(sp.spam_score);
                  if (ss != null) patch.spam_score = ss;
                } else enrichment.bulk_spam_score = { missing: true };
                patch.enrichment = JSON.stringify(enrichment);
              }
              patches.push({ id: r.id, patch });
            } catch (err) {
              out.failed.push({ id: r.id, domain: r.domain, reason: `map_error: ${err.message}` });
            }
          }
        }
      }

      for (const { id, patch } of patches) await trx('seo_link_domains').where({ id }).update(patch);
      out.enriched += patches.filter((p) => p.patch.enriched_at).length;
    });
  }
  return out;
}

module.exports = { enrichDomains, competitorsLinked, BULK_MAX, ENRICH_LOCK_KEY, _test: { items, selectDomains } };
