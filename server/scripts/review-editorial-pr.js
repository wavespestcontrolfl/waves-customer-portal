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
    const input = { document: original.content, path: file.filename, domain: 'wavespestcontrol.com', manifest,
      publicKey: process.env.EDITORIAL_REVIEW_PUBLIC_KEY };
    files.push({ path: file.filename, document: original.content,
      fresh: contract.verifyManifest(input).pass });
  }
  return files;
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
    base: Joi.object({ ref: Joi.valid(gh.env().defaultBranch).required() }).unknown().required(),
  }).unknown().required(), 'Only open, same-repository PRs against the default branch are supported');
  const files = await readArticles(pr);
  const commits = [];
  const failures = [];
  for (const file of files.filter((item) => !item.fresh)) {
    try {
      let document = file.document;
      // Portal-owned PRs retain their existing remediation/mirror authority.
      // Hand-authored content can be repaired here before the same content gates.
      if (!pr.head.ref.startsWith('content/')) {
        const parsed = fm.parse(document);
        const draft = await editorial.prepareDraft({ frontmatter: parsed.data, body: parsed.content }, { page_type: 'supporting-blog' });
        if (draft.body.trim() !== parsed.content.trim()) {
          document = fm.stringify(parsed.data, draft.body);
          commits.push({ path: file.path, content: document });
        }
        const check = await require('../services/content/codex-remediation').validateFixedBlogFile(document, {
          originalMetaDescription: parsed.data.meta_description, requireFactCheck: true,
        });
        if (check.requiresHumanReview) throw new Error('Document is outside the autonomous publishing policy; leave unpublished');
        if (!check.ok) throw new Error(`Document failed existing publishing checks: ${check.reason}`);
      }
      commits.push(...await editorial.filesForDocument({ document, path: file.path }));
    } catch (err) {
      failures.push({ path: file.path, reason: err.message });
    }
  }
  // All-or-nothing. A failed article never rides another article's evidence commit.
  if (failures.length) return { pass: false, deferred: true, failures };
  if (!commits.length) return { pass: true, unchanged: true };
  const current = await gh.getPr(number);
  if (current?.state !== 'open' || current.head?.sha !== pr.head.sha || current.head?.ref !== pr.head.ref) throw new Error('PR changed during review; retry on the new head');
  const result = await gh.commitFiles({ branch: pr.head.ref, expectedHeadSha: pr.head.sha,
    message: 'chore(content): attach verified editorial evidence', files: commits });
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
