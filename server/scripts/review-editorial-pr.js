#!/usr/bin/env node
/**
 * Trusted CI entry point. Reads PR documents as data; never executes PR code.
 * Called by wavespestcontrol-astro/.github/workflows/editorial-evidence-review.yml
 * on article PR events and twice-hourly stale-evidence recovery.
 */
const gh = require('../services/content-astro/github-client');
const editorial = require('../services/content/editorial-evidence');
const fm = require('../services/content-astro/frontmatter');
const Joi = require('joi');

// Both event-driven review and scheduled recovery use the same immutable reads
// and signature policy; malformed sidecars never acquire a grandfather pass.
async function readArticles(pr) {
  const { owner, repo } = gh.env();
  const contract = require('../../packages/editorial-evidence/index.cjs');
  const changed = await gh.ghFetchPaginated(`/repos/${owner}/${repo}/pulls/${pr.number}/files`);
  const files = [];
  for (const file of changed.filter((item) => item.status !== 'removed' && editorial.applicable(item.filename))) {
    const original = await gh.getFile(file.filename, pr.head.sha);
    if (!original?.content) throw new Error(`Cannot read ${file.filename} at the reviewed head`);
    const evidence = await gh.getFile(contract.evidencePath(file.filename), pr.head.sha);
    let manifest;
    try { manifest = JSON.parse(evidence?.content); } catch { /* fresh review required */ }
    // Verify under the same frontmatter-derived domain the signer used; an
    // unresolvable domain never verifies and falls through to a fresh review.
    const domain = editorial.evidenceDomain(original.content);
    const input = { document: original.content, path: file.filename, domain, manifest,
      publicKey: process.env.EDITORIAL_REVIEW_PUBLIC_KEY };
    const fresh = Boolean(domain) && contract.verifyManifest(input).pass;
    // Freshness is the only relaxed property: this second verification still
    // authenticates the signature, exact document bytes, path, domain, policy,
    // sources, and every required passing check.
    const previouslyVerified = Boolean(domain) && contract.verifyManifest({ ...input, requireFresh: false }).pass;
    files.push({ path: file.filename, previousPath: file.previous_filename || null,
      status: file.status, document: original.content,
      fresh, previouslyVerified });
  }
  return files;
}

// Grade metadata changes against the immutable base revision on every
// unsigned/tampered article. A branch name can never waive policy.
async function baseMetaDescription(pr, file) {
  if (file.status === 'added') return '';
  const basePath = file.previousPath || file.path;
  const baseFile = await gh.getFile(basePath, pr.base.sha);
  if (!baseFile?.content) throw new Error(`Cannot read ${basePath} at the reviewed base`);
  let baseParsed;
  try { baseParsed = fm.parse(baseFile.content); }
  catch (err) { throw new Error(`Cannot parse ${basePath} at the reviewed base: ${err.message}`); }
  const baseMeta = baseParsed.data?.metaDescription ?? baseParsed.data?.meta_description;
  return typeof baseMeta === 'string' ? baseMeta : '';
}

// Repair + existing-policy validation for an unsigned/tampered article.
// Returns the (possibly repaired) document and any repair commit it produced.
async function validateAndRepair(pr, file) {
  const originalMetaDescription = await baseMetaDescription(pr, file);
  const parsed = fm.parse(file.document);
  let document = file.document;
  const commits = [];
  // Reserve content/* body repairs for the portal's mirror workflow to
  // avoid changing article bytes without updating its DB-backed state.
  if (!pr.head.ref.startsWith('content/')) {
    const draft = await editorial.prepareDraft({ frontmatter: parsed.data, body: parsed.content }, { page_type: 'supporting-blog' });
    if (draft.body.trim() !== parsed.content.trim()) {
      // A repair can add or remove the visible FAQ; FAQPage must follow it.
      const { schemaTypesForContent } = require('../services/content-astro/astro-publisher')._internals;
      const baseTypes = (Array.isArray(parsed.data.schema_types) ? parsed.data.schema_types : []).filter((type) => type !== 'FAQPage');
      document = fm.stringify({ ...parsed.data, schema_types: schemaTypesForContent(draft.body, baseTypes) }, draft.body);
      commits.push({ path: file.path, content: document });
    }
  }
  const check = await require('../services/content/codex-remediation').validateFixedBlogFile(document, {
    originalMetaDescription, requireFactCheck: true,
  });
  if (check.requiresHumanReview) throw new Error('Document is outside the autonomous publishing policy; leave unpublished');
  if (!check.ok) throw new Error(`Document failed existing publishing checks: ${check.reason}`);
  return { document, commits };
}

// Reviews one stale/unsigned article, returning its evidence-carrying commits.
async function reviewFile(pr, file) {
  let document = file.document;
  const commits = [];
  // A still-valid signature over these exact bytes proves the legacy
  // publishing policy already ran. Expiry alone requires a new independent
  // review/signature, not a context-free replay of those older gates.
  if (!file.previouslyVerified) {
    const repaired = await validateAndRepair(pr, file);
    document = repaired.document;
    commits.push(...repaired.commits);
  }
  commits.push(...await editorial.filesForDocument({ document, path: file.path }));
  return commits;
}

// Read/validate/repair phase. All-or-nothing: a failed article never rides
// another article's evidence commit, so failures are collected, not thrown.
async function reviewFiles(pr, files) {
  const commits = [];
  const failures = [];
  for (const file of files.filter((item) => !item.fresh)) {
    try { commits.push(...await reviewFile(pr, file)); }
    catch (err) { failures.push({ path: file.path, reason: err.message }); }
  }
  return { commits, failures };
}

// Atomic-commit phase: re-verify the PR hasn't moved since review started,
// then land every evidence/repair commit in one push.
async function commitReviewedFiles(pr, number, commits) {
  const current = await gh.getPr(number);
  if (current?.state !== 'open' || current.head?.sha !== pr.head.sha || current.head?.ref !== pr.head.ref
      || current.base?.sha !== pr.base.sha) throw new Error('PR changed during review; retry on the new head or base');
  return gh.commitFiles({ branch: pr.head.ref, expectedHeadSha: pr.head.sha,
    message: 'chore(content): attach verified editorial evidence', files: commits });
}

async function reviewPr(number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('A positive PR number is required');
  if (!editorial.enabled()) return { skipped: 'gate_disabled' };
  const pr = await gh.getPr(number);
  const { owner, repo } = gh.env();
  Joi.assert(pr, Joi.object({ state: Joi.valid('open').required(),
    head: Joi.object({ sha: Joi.string().required(), ref: Joi.string().required(),
      repo: Joi.object({ full_name: Joi.valid(`${owner}/${repo}`).required() }).unknown().required(),
    }).unknown().required(),
    base: Joi.object({ ref: Joi.valid(gh.env().defaultBranch).required(),
      sha: Joi.string().required() }).unknown().required(),
  }).unknown().required(), 'Only open, same-repository PRs against the default branch are supported');
  const files = await readArticles(pr);
  const { commits, failures } = await reviewFiles(pr, files);
  if (failures.length) return { pass: false, deferred: true, failures };
  if (!commits.length) return { pass: true, unchanged: true };
  const result = await commitReviewedFiles(pr, number, commits);
  return { pass: true, commit: result.commit.sha, requiresFreshBuild: true };
}

if (require.main === module) {
  const argument = process.argv.find((value) => value.startsWith('--pr='));
  const work = process.argv.includes('--refresh-stale') ? refreshStale() : retryReview(Number(argument?.slice(5)));
  work.then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.pass === false) process.exitCode = 1;
  }).catch((err) => { process.stderr.write(err.message + '\n'); process.exitCode = 1; });
}
async function refreshStale({ now = Date.now() } = {}) {
  if (!editorial.enabled()) return { skipped: 'gate_disabled' };
  const { owner, repo } = gh.env();
  const prs = await gh.ghFetchPaginated(`/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=asc`);
  // Rotate the bounded work window every scheduled tick. Repeated failures
  // cannot occupy the first three slots forever and starve older/newer PRs.
  prs.sort((a, b) => a.number - b.number);
  const offset = prs.length ? (Math.floor(now / 1800000) * 3) % prs.length : 0;
  const ordered = [...prs.slice(offset), ...prs.slice(0, offset)];
  const results = [];
  for (const pr of ordered) {
    if (results.length >= 3) break;
    if (pr.head?.repo?.full_name !== `${owner}/${repo}` || pr.base?.ref !== gh.env().defaultBranch) continue;
    try {
      const files = await readArticles(pr);
      if (files.some((file) => !file.fresh)) results.push({ pr: pr.number, ...await retryReview(pr.number) });
    } catch (err) {
      results.push({ pr: pr.number, pass: false, deferred: true, failures: [{ reason: err.message }] });
    }
  }
  return { pass: results.every((result) => result.pass), results };
}
// Bounded automatic retries cover source/provider outages and a moving PR head.
// Exhaustion leaves the article unpublished; no approval notification is sent.
async function retryReview(number, { review = reviewPr, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { result = await review(number); }
    catch (err) { result = { pass: false, deferred: true, failures: [{ reason: err.message }] }; }
    if (result.pass !== false) return result;
    if (attempt < 2) await wait(15000 * (attempt + 1));
  }
  return { ...result, attempts: 3, exhausted: true };
}
module.exports = { reviewPr, retryReview, refreshStale };
