/**
 * Intake skeleton (plan v2 §4, step 1): normalize → dedupe → upsert. No
 * resolvers (X posts are reported `unresolved`, never persisted as x.com), no
 * enrichment, no investigation queueing — those are steps 2–3. Idempotent: the
 * same paste twice adds nothing the second time.
 */

const { canonicalProspectDomain } = require('./prospect-domain-lock');
const { LINK_SOURCES, isNeverTargetHost } = require('./link-registry');
const registry = require('./link-registry');

// Anything that looks like a host or URL. Emails are stripped first so
// `joe@example.com` does not contribute `example.com`.
const TOKEN_RE = /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:\/[^\s,;"'<>()[\]{}]*)?/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const X_POST_RE = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/\s]+\/status\/\d+/i;

function hasPath(token) {
  const t = token.replace(/^https?:\/\//, '');
  const rest = t.replace(/^[^/]+/, '');
  return rest.replace(/^\/+/, '').replace(/\/+$/, '').length > 0;
}

/**
 * parseOpportunities(text) → { candidates: [{ domain, url }], unresolved: [postUrl], dropped: [{ token, reason }] }
 * Pure. `url` is a submission-url HINT (kept only when the token carried a path).
 */
function parseOpportunities(text) {
  const src = String(text || '').replace(EMAIL_RE, ' ');
  const seen = new Map();
  const unresolved = [];
  const dropped = [];
  for (const raw of src.match(TOKEN_RE) || []) {
    const token = raw.replace(/[.,;:!?)]+$/, '');
    if (X_POST_RE.test(token)) { if (!unresolved.includes(token)) unresolved.push(token); continue; }
    const domain = canonicalProspectDomain(token);
    if (!domain || !domain.includes('.')) { dropped.push({ token, reason: 'not_a_host' }); continue; }
    if (isNeverTargetHost(domain)) { dropped.push({ token, reason: 'never_target' }); continue; }
    const url = hasPath(token) ? (token.startsWith('http') ? token : `https://${token}`) : null;
    const prev = seen.get(domain);
    if (!prev) seen.set(domain, { domain, url });
    else if (!prev.url && url) prev.url = url;
  }
  return { candidates: [...seen.values()], unresolved, dropped };
}

function touchDetail(batchDetail, url) {
  const base = String(batchDetail || '').trim();
  if (!url) return base || null;
  return base ? `${base} ${url}` : url;
}

/**
 * intake(db, { text, source, sourceDetail, sourceRef, dryRun })
 *   → { inserted, touched, existing, candidates, unresolved, dropped, dryRun }
 * Upserts every candidate through ensureDomain() inside one transaction. dryRun
 * reports what WOULD be upserted (which candidates already exist) with no writes.
 */
async function intake(db, { text, source = 'list_import', sourceDetail = null, sourceRef = null, dryRun = false } = {}) {
  if (!LINK_SOURCES.includes(source)) throw Object.assign(new Error(`invalid source '${source}'`), { code: 'invalid_source' });
  const parsed = parseOpportunities(text);
  const base = { ...parsed, source, sourceDetail, dryRun: !!dryRun, inserted: 0, touched: 0, existing: 0 };
  if (!parsed.candidates.length) return base;

  if (dryRun) {
    const hosts = parsed.candidates.map((c) => c.domain);
    const known = await db('seo_link_domains').whereIn('domain', hosts).select('domain');
    const knownSet = new Set(known.map((k) => k.domain));
    base.existing = hosts.filter((h) => knownSet.has(h)).length;
    base.inserted = hosts.length - base.existing;
    base.candidates = parsed.candidates.map((c) => ({ ...c, existing: knownSet.has(c.domain) }));
    return base;
  }

  const results = await db.transaction(async (trx) => {
    const out = [];
    for (const c of parsed.candidates) {
      // A pasted URL is a submission-url HINT: persisted on the touch's
      // source_detail (and, for a new host, the first-touch detail) so the
      // investigator (step 3) can recover it — never on the domain's identity.
      const r = await registry.ensureDomain(trx, {
        domain: c.domain, source, sourceDetail: touchDetail(sourceDetail, c.url), sourceRef,
      });
      out.push({ ...c, id: r.id, existing: !r.created, touched: r.touched });
    }
    return out;
  });
  base.candidates = results;
  base.inserted = results.filter((r) => !r.existing).length;
  base.existing = results.length - base.inserted;
  base.touched = results.filter((r) => r.touched).length;
  return base;
}

module.exports = { parseOpportunities, intake, _internals: { TOKEN_RE, X_POST_RE, hasPath, touchDetail } };
