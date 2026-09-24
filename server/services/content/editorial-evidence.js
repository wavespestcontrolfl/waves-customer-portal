/** Autonomous editorial checks. Only this trusted service signs review results. */
const { gateEnvValue } = require('../../config/feature-gates');
const fm = require('../content-astro/frontmatter');

const DOMAIN = 'wavespestcontrol.com';
const DOMAIN_CONTEXT = { hostname: DOMAIN, tokens: {
  brandName: 'Waves Pest Control', brandShort: 'Waves',
  siteUrl: 'https://www.wavespestcontrol.com', email: 'contact@wavespestcontrol.com',
  primaryCity: null,
} };
const enabled = () => gateEnvValue('GATE_EDITORIAL_EVIDENCE');
const applicable = (path) => /^src\/content\/blog\/.+\.mdx?$/.test(String(path));

function sourceUrls(document, brief = {}) {
  // Public citation URLs only; the transport independently checks DNS/IP/redirects.
  const text = `${fm.parse(document).content}\n${JSON.stringify(brief.required_sources || [])}\n${JSON.stringify(brief.facts_pack || [])}`;
  return [...new Set((text.match(/https:\/\/[^\s<>"'\]})]+/g) || [])
    .map((url) => url.replace(/[.,;]+$/, ''))
    .filter((url) => {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
        return !require('../content-astro/spoke-sites').SPOKE_SITE_KEYS.includes(host)
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
  return require('./editorial-review').review({ document, title: parsed.data.title || parsed.data.metaTitle || '',
    domain: DOMAIN_CONTEXT, sourceUrls: sourceUrls(document, brief), factsPack: brief.facts_pack || null });
}

// Repairs happen BEFORE existing schema, claims, privacy and SEO gates. A final
// independent review below still checks the exact bytes emitted by the publisher.
async function prepareDraft(draft, brief = {}) {
  if (!enabled() || !['supporting-blog', 'customer-question'].includes(brief.page_type)
      && brief.action_type !== 'new_supporting_blog') return draft;
  const original = fm.stringify(draft.frontmatter || {}, draft.body || '');
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
        title: fm.parse(document).data.title || '', domain: DOMAIN_CONTEXT });
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
  const manifest = contract.createManifest({ document, path, domain: DOMAIN, checks: result.checks,
    sources: result.sources, reviewedAt: result.reviewedAt, model: result.model,
    privateKey: process.env.EDITORIAL_REVIEW_PRIVATE_KEY });
  const verified = contract.verifyManifest({ document, path, domain: DOMAIN, manifest,
    publicKey: process.env.EDITORIAL_REVIEW_PUBLIC_KEY });
  if (!verified.pass) throw reviewError({ checks: [{ name: 'source_support', status: 'error', findings: [{ action: 'Editorial signature verification failed.' }] }] });
  return [{ path: contract.evidencePath(path), content: JSON.stringify(manifest, null, 2) + '\n' }];
}

// Check the immutable PR head, never a mutable branch name. Required even if a
// PR was created before this gate was enabled or remediation edited the article.
async function assertPrEvidence(pr) {
  if (!enabled()) return;
  const gh = require('../content-astro/github-client');
  const { owner, repo } = gh.env();
  const files = await gh.ghFetchPaginated(`/repos/${owner}/${repo}/pulls/${pr.number}/files`);
  const contract = require('../../../packages/editorial-evidence/index.cjs');
  for (const file of files) {
    if (file.status === 'removed' || !applicable(file.filename)) continue;
    if (!pr.head?.sha) throw reviewError(null);
    const document = await gh.getFile(file.filename, pr.head.sha);
    const evidence = await gh.getFile(contract.evidencePath(file.filename), pr.head.sha);
    let manifest;
    try { manifest = JSON.parse(evidence?.content); } catch { throw reviewError(null); }
    const result = contract.verifyManifest({ document: document?.content, path: file.filename,
      domain: DOMAIN, manifest, publicKey: process.env.EDITORIAL_REVIEW_PUBLIC_KEY });
    if (!document || !result.pass) throw reviewError(null);
  }
}

module.exports = { enabled, applicable, prepareDraft, filesForDocument, assertPrEvidence, sourceUrls, reviewError };
