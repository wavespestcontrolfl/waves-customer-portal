/** Autonomous editorial checks. Only this trusted service signs review results. */
const { gateEnvValue } = require('../../config/feature-gates');
const fm = require('../content-astro/frontmatter');
const { SPOKE_SITE_KEYS, HUB_SITE_KEYS, spokeSiteOrigin } = require('../content-astro/spoke-sites');

const DOMAIN = 'wavespestcontrol.com';
const DOMAIN_CONTEXT = { hostname: DOMAIN, tokens: {
  brandName: 'Waves Pest Control', brandShort: 'Waves',
  siteUrl: 'https://www.wavespestcontrol.com', email: 'contact@wavespestcontrol.com',
  primaryCity: null,
} };
const enabled = () => gateEnvValue('GATE_EDITORIAL_EVIDENCE');
const applicable = (path) => /^src\/content\/blog\/.+\.mdx?$/.test(String(path));
// Kept local to avoid exporting publisher internals through its existing
// load-time cycle. This mirrors publishRefresh's four-field blog allowlist.
const REFRESH_REVIEW_META_FIELDS = ['title', 'metaTitle', 'meta_description', 'metaDescription'];

// Resolve the review/signing domain from an article's OWN frontmatter
// `domains` (astro-publisher's stampBlogDomains — see resolveSpokeTarget /
// blogOriginForSpoke in spoke-routing.js) rather than assuming the hub: when
// SPOKE_BLOG_NETWORK_ENABLED routes a post to a single spoke, its domains is
// `[spokeKey]` and review/evidence must bind to that spoke's own hostname +
// siteUrl, never the hub's. Hub-only or absent `domains` (every publisher
// path except a live spoke route) resolves to the hub. Anything ambiguous —
// more than one non-hub domain, or a domain outside the fleet — returns
// null so every caller fails closed instead of reviewing/signing a document
// under the wrong site.
function resolveDomainContext(domains) {
  const list = Array.isArray(domains) ? domains.filter((d) => typeof d === 'string' && d.trim()) : [];
  if (list.length === 0 || list.every((d) => HUB_SITE_KEYS.includes(d))) return DOMAIN_CONTEXT;
  if (list.length === 1 && SPOKE_SITE_KEYS.includes(list[0])) {
    const hostname = list[0];
    return { hostname, tokens: { ...DOMAIN_CONTEXT.tokens, siteUrl: spokeSiteOrigin(hostname) || `https://www.${hostname}` } };
  }
  return null;
}

// Same resolution, read from the article's own bytes — every verification
// point trusts the domain the document itself declares (at the exact ref
// being checked) rather than an assumption carried in from elsewhere.
function domainContextFromDocument(document) {
  let domains;
  try { domains = fm.parse(document).data?.domains; } catch { return null; }
  return resolveDomainContext(domains);
}

// Trim a trailing ')' only while it is UNMATCHED by an earlier '(' in the
// same URL (markdown/parenthetical wrapping, e.g. "(see https://a.org/x)"
// or the closing paren of a markdown link), so a balanced pair that is part
// of the URL itself (e.g. ".../report_(2026)") is preserved.
function trimTrailingUrlNoise(url) {
  let out = url;
  for (;;) {
    if (/[.,;]$/.test(out)) { out = out.slice(0, -1); continue; }
    if (out.endsWith(')')) {
      const opens = (out.match(/\(/g) || []).length;
      const closes = (out.match(/\)/g) || []).length;
      if (closes > opens) { out = out.slice(0, -1); continue; }
    }
    break;
  }
  return out;
}

function sourceUrls(document, brief = {}) {
  // Public citation URLs only; the transport independently checks DNS/IP/redirects.
  // Parentheses are allowed inside the match (URLs can legitimately contain
  // them); trimTrailingUrlNoise strips only what's unmatched.
  const text = `${fm.parse(document).content}\n${JSON.stringify(brief.required_sources || [])}\n${JSON.stringify(brief.facts_pack || [])}`;
  return [...new Set((text.match(/https:\/\/[^\s<>"'\]}]+/g) || [])
    .map(trimTrailingUrlNoise)
    .filter((url) => {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
        return !SPOKE_SITE_KEYS.includes(host)
          && !/\.(?:webp|png|jpe?g|gif|svg)(?:$|\?)/i.test(parsed.pathname);
      } catch { return false; }
    }))];
}

function reviewError(result) {
  const findings = (result?.checks || []).flatMap((check) =>
    (check.findings?.length ? check.findings : check.status !== 'pass'
      ? [{ passage: '', action: `Retry the ${check.name} check; it did not complete successfully.` }] : [])
      .map((finding) => ({ severity: 'P0', code: `EDITORIAL_${check.name.toUpperCase()}`,
        message: [finding.passage, finding.detail, finding.message, finding.action].filter(Boolean).join(' — ') })));
  const error = new Error(`Editorial review did not pass: ${findings.map((f) => f.message).join('; ').slice(0, 1800) || 'review unavailable'}`);
  error.code = !result || result.checks?.some((check) => check.status === 'error')
    ? 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' : 'BLOG_EDITORIAL_REVIEW_FAILED';
  error.findings = findings.length ? findings : [{ severity: 'P0', code: 'EDITORIAL_UNAVAILABLE', message: error.message }];
  error.editorialResult = result;
  return error;
}

async function evaluate(document, brief = {}) {
  const parsed = fm.parse(document);
  const domain = resolveDomainContext(parsed.data.domains);
  if (!domain) {
    throw reviewError({ checks: [{ name: 'source_support', status: 'error',
      findings: [{ action: 'Editorial evidence domain could not be resolved from this document\'s frontmatter domains; retry once it is unambiguous.' }] }] });
  }
  return require('./editorial-review').review({ document, title: parsed.data.title || parsed.data.metaTitle || '',
    domain, sourceUrls: sourceUrls(document, brief), factsPack: brief.facts_pack || null });
}

// Repairs happen BEFORE existing schema, claims, privacy and SEO gates. A final
// independent review below still checks the exact bytes emitted by the publisher.
async function prepareDraft(draft, brief = {}) {
  if (!enabled()) return draft;
  let reviewFrontmatter = draft.frontmatter || {};
  if (brief.action_type === 'refresh_existing_page') {
    // Match publishRefresh's target precedence, then let its own resolver tell
    // us whether this is a blog. Refresh briefs deliberately use the generic
    // page_type=refresh, so trusting page_type would skip blog repairs (or,
    // conversely, applying the review to every refresh would pull service and
    // location pages into a blog-only contract).
    const target = draft.file_path || brief.target_url || brief.page_url || draft.page_url;
    let resolved;
    try {
      // Dynamic to avoid the load-time cycle: astro-publisher imports this
      // module for final evidence generation.
      const publisher = require('../content-astro/astro-publisher');
      if (!target || typeof publisher.resolveExistingAstroFileForTarget !== 'function') throw new Error('refresh target resolver unavailable');
      resolved = await publisher.resolveExistingAstroFileForTarget(target);
    } catch {
      throw reviewError(null);
    }
    if (!resolved?.path) throw reviewError(null);
    if (!applicable(resolved.path)) return draft;

    // The refresh sink is intentionally sparse: publishRefresh starts with
    // the live frontmatter and accepts only non-empty edits to fields already
    // present on that page. Review those effective bytes too, while returning
    // the original sparse draft frontmatter for the publisher to freeze.
    let liveFrontmatter;
    try {
      if (typeof resolved.file?.content !== 'string') throw new Error('resolved refresh file has no content');
      liveFrontmatter = fm.parse(resolved.file.content).data || {};
    } catch {
      throw reviewError(null);
    }
    reviewFrontmatter = { ...liveFrontmatter };
    for (const field of REFRESH_REVIEW_META_FIELDS) {
      if (liveFrontmatter[field] !== undefined
          && draft.frontmatter?.[field] !== undefined
          && String(draft.frontmatter[field]).trim()) {
        reviewFrontmatter[field] = String(draft.frontmatter[field]).trim();
      }
    }
  } else if (!['supporting-blog', 'customer-question'].includes(brief.page_type)
      && brief.action_type !== 'new_supporting_blog') return draft;
  const original = fm.stringify(reviewFrontmatter, draft.body || '');
  let document = original;
  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    result = await evaluate(document, brief);
    if (result?.pass === true) {
      const body = fm.parse(document).content;
      return { ...draft, body, editorial_review: result };
    }
    if (attempt === 0 && !result?.checks?.some((check) => check.status === 'error')) {
      const repaired = await require('./editorial-review').repair({ document,
        findings: result.checks.flatMap((check) => check.findings || []), sources: result.sources || [],
        factsPack: brief.facts_pack || null,
        // The prior evaluate() call above already resolved this same
        // document's domain successfully (it throws otherwise), so this is
        // never null here — recomputed rather than threaded through so
        // repair always reviews under the domain the current bytes declare.
        title: reviewFrontmatter.title || reviewFrontmatter.metaTitle || '', domain: domainContextFromDocument(document) });
      document = typeof repaired === 'string' ? repaired : repaired?.document;
      if (!document || JSON.stringify(fm.parse(document).data) !== JSON.stringify(fm.parse(original).data)) throw reviewError(result);
    }
  }
  throw reviewError(result);
}

async function filesForDocument({ document, path, brief = {} }) {
  if (!enabled() || !applicable(path)) return [];
  const contract = require('../../../packages/editorial-evidence/index.cjs');
  if (!process.env.EDITORIAL_REVIEW_PRIVATE_KEY || !process.env.EDITORIAL_REVIEW_PUBLIC_KEY) {
    throw reviewError({ checks: [{ name: 'source_support', status: 'error', findings: [{ action: 'Editorial signing keys are unavailable; retry after configuration recovers.' }] }] });
  }
  const result = await evaluate(document, brief);
  if (result?.pass !== true) throw reviewError(result);
  // evaluate() above already resolved this document's domain successfully,
  // so this is never null here.
  const domain = domainContextFromDocument(document).hostname;
  let manifest, verified;
  try {
    manifest = contract.createManifest({ document, path, domain, checks: result.checks,
      sources: result.sources, reviewedAt: result.reviewedAt, model: result.model,
      privateKey: process.env.EDITORIAL_REVIEW_PRIVATE_KEY });
    verified = contract.verifyManifest({ document, path, domain, manifest,
      publicKey: process.env.EDITORIAL_REVIEW_PUBLIC_KEY });
  } catch {
    // Malformed key material (corrupt env var, wrong key type) is a config
    // outage, not a content failure — classify it the same 'unavailable'
    // way as the missing-key check above rather than crashing the publish.
    throw reviewError({ checks: [{ name: 'source_support', status: 'error', findings: [{ action: 'Editorial signing keys could not be used to sign or verify; retry after configuration recovers.' }] }] });
  }
  if (!verified.pass) throw reviewError({ checks: [{ name: 'source_support', status: 'error', findings: [{ action: 'Editorial signature verification failed.' }] }] });
  return [{ path: contract.evidencePath(path), content: JSON.stringify(manifest, null, 2) + '\n' }];
}

// Check the immutable PR head, never a mutable branch name. Required even if a
// PR was created before this gate was enabled or remediation edited the article.
async function assertPrEvidence(pr) {
  if (!enabled()) return;
  const gh = require('../content-astro/github-client');
  const { owner, repo } = gh.env();
  if (!pr?.number || !pr.head?.sha) throw reviewError(null);
  // Evidence authenticates the PR head bytes, but GitHub's clean merge may
  // also carry non-overlapping edits made to the same article on the base.
  // Refresh the PR here (poller snapshots can be minutes old), derive its
  // merge base, and require every touched article's base blob to be unchanged
  // since that fork. Unrelated base movement remains mergeable.
  const current = await gh.getPr(pr.number);
  const headSha = String(pr.head.sha);
  const currentHeadSha = String(current?.head?.sha || '');
  const baseSha = String(current?.base?.sha || '');
  const baseRef = String(current?.base?.ref || '');
  if (current?.state !== 'open' || currentHeadSha !== headSha || !baseSha || !baseRef) throw reviewError(null);
  const files = await gh.ghFetchPaginated(`/repos/${owner}/${repo}/pulls/${pr.number}/files`);
  const compared = await gh.compareFiles(headSha, baseSha);
  const mergeBaseSha = String(compared?.mergeBaseSha || '');
  if (!mergeBaseSha) throw reviewError(null);
  const contract = require('../../../packages/editorial-evidence/index.cjs');
  // Head-side filenames of every applicable, non-removed article verified
  // below — callers (e.g. the PR poller) use this to know exactly which
  // articles this evidence proof covers.
  const articlePaths = [];
  for (const file of files) {
    if (file.status === 'removed' || !applicable(file.filename)) continue;
    const basePaths = [file.filename];
    if (file.status === 'renamed' && file.previous_filename) basePaths.push(file.previous_filename);
    for (const articlePath of basePaths) {
      const [atFork, atBase] = await Promise.all([
        gh.getFile(articlePath, mergeBaseSha),
        gh.getFile(articlePath, baseSha),
      ]);
      const absentAtBoth = atFork === null && atBase === null;
      const sameBlob = typeof atFork?.sha === 'string' && atFork.sha
        && typeof atBase?.sha === 'string' && atFork.sha === atBase.sha;
      if (!absentAtBoth && !sameBlob) throw reviewError(null);
    }
    const document = await gh.getFile(file.filename, headSha);
    const evidence = await gh.getFile(contract.evidencePath(file.filename), headSha);
    let manifest;
    try { manifest = JSON.parse(evidence?.content); } catch { throw reviewError(null); }
    // Domain from the article's own bytes at head — never assumed — so a
    // spoke-targeted article is verified against its own spoke, not the hub.
    const domain = document ? domainContextFromDocument(document.content)?.hostname : null;
    if (!document || !domain) throw reviewError(null);
    const result = contract.verifyManifest({ document: document.content, path: file.filename,
      domain, manifest, publicKey: process.env.EDITORIAL_REVIEW_PUBLIC_KEY });
    if (!result.pass) throw reviewError(null);
    articlePaths.push(file.filename);
  }
  return { baseSha, baseRef, articlePaths };
}

// A signing-only follow-up commit may advance an autonomous PR after the
// publisher recorded its immutable content commit. Accept that descendant
// only when the complete delta consists of fresh, valid evidence sidecars
// for the exact article bytes at the descendant head. compareFiles returns
// every renamed path and the merge base; requiring the publisher pin as the
// merge base proves strict ancestry, while requiring every listed path to
// exist at head rejects removals and renames.
async function verifyEvidenceOnlyAdvance({ pinnedSha, headSha }, deps = {}) {
  if (!enabled()) return false;
  const pinned = String(pinnedSha || '').toLowerCase();
  const head = String(headSha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(pinned) || !/^[0-9a-f]{40}$/.test(head) || pinned === head) return false;

  const gh = deps.gh || require('../content-astro/github-client');
  if (typeof gh.compareFiles !== 'function') return false;
  const compared = await gh.compareFiles(head, pinned);
  const changed = compared?.files;
  // GitHub caps a compare response at 300 files. Reject the boundary too:
  // exactly 300 gives no proof that the list was complete.
  if (String(compared?.mergeBaseSha || '').toLowerCase() !== pinned
      || !Array.isArray(changed) || changed.length === 0 || changed.length >= 300
      || new Set(changed).size !== changed.length) return false;

  const contract = require('../../../packages/editorial-evidence/index.cjs');
  for (const evidencePath of changed) {
    if (!/^content-ops\/editorial-evidence\/[0-9a-f]{64}\.json$/.test(String(evidencePath))) return false;
    const evidence = await gh.getFile(evidencePath, head);
    let manifest;
    try { manifest = JSON.parse(evidence?.content); } catch { return false; }
    const articlePath = manifest?.path;
    if (!applicable(articlePath) || contract.evidencePath(articlePath) !== evidencePath) return false;
    const article = await gh.getFile(articlePath, head);
    if (typeof article?.content !== 'string') return false;
    // Domain from the article's own bytes at head, same as assertPrEvidence.
    const domain = domainContextFromDocument(article.content)?.hostname;
    if (!domain) return false;
    const verified = contract.verifyManifest({ document: article.content, path: articlePath,
      domain, manifest, publicKey: process.env.EDITORIAL_REVIEW_PUBLIC_KEY });
    if (!verified.pass) return false;
  }
  return true;
}

module.exports = { enabled, applicable, prepareDraft, filesForDocument, assertPrEvidence,
  verifyEvidenceOnlyAdvance, sourceUrls, reviewError };
