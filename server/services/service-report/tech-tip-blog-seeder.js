/**
 * tech-tip-blog-seeder.js — the blog post behind a tech tip, or the topic
 * that writes one (owner 2026-10-24, "tips with facts": combine the tip's
 * link with the blog; if no post fills in, create one through the autonomous
 * blog queue).
 *
 * Every registry tip with a `blog` (tip-library) names the Waves post that
 * says more on its subject (`path`) and the phrase to write it from
 * (`topic`). The picker route pairs a tip with its post only while that post
 * is live on the hub (report-blog-post liveBlogPostsByPath). This seeder
 * sweeps the gaps: each `blog.path` with no live post has its `topic` sent to
 * the autonomous blog queue through the SAME path the office's "Suggest a
 * post" uses (report-blog-suggestion suggestReportBlogPost), so every rule
 * that protects that queue still holds — the phrase must be a topic, every
 * word one the site already uses, a topic held already answers
 * already_queued, one the chain skipped stays skipped — and the chain's own
 * gates (targeting, uniqueness, guardrails, fact check, publish caps) run on
 * the post. Differences from a person's suggestion: no actor (so no per-person
 * daily cap and no advisory lock; the registry is the author), and the row
 * carries `tech_tip_id` so the queue says which tip wanted it.
 *
 * The picker route stays read-only (admin-dispatch-tech-tips.test.js), so
 * the write lives here, run by an operator (server/scripts/seed-tech-tip-blogs.js,
 * dry-run by default) and idempotent: a tip whose post is live writes
 * nothing, and a topic already in the queue writes nothing. Dark behind
 * GATE_TECH_TIP_SOURCES (techTipSourcesLive): seedAll refuses to write while
 * the gate is off; a dry run still scans.
 */
const { TIPS } = require('./tip-library');
const { liveBlogPostsByPath } = require('./report-blog-post');
const { suggestReportBlogPost } = require('./report-blog-suggestion');
const featureGates = require('../../config/feature-gates');

// Every tip that names a post, with the post when it is live.
async function scan(knex) {
  const linking = TIPS.filter((tip) => tip.blog && tip.blog.path);
  const live = await liveBlogPostsByPath(knex, linking.map((tip) => tip.blog.path));
  return linking.map((tip) => ({
    tipId: tip.id,
    path: tip.blog.path,
    topic: String(tip.blog.topic || '').trim(),
    post: live.get(tip.blog.path) || null,
  }));
}

/**
 * Scan, then queue a topic for each tip whose post is not live. Answers the
 * scan rows, each with `outcome`: 'live' (nothing to do), 'no_topic' (the
 * tip names no phrase), 'dry_run', or the suggestion service's own answer
 * ('queued', 'already_queued', 'covered', 'declined', or its error). Two tips
 * sharing one topic queue it once. Writes nothing while the gate is off
 * (outcome 'gate_off').
 */
async function seedAll(knex, { dryRun = false } = {}) {
  const rows = await scan(knex);
  const gateOn = featureGates.techTipSourcesLive();
  const seen = new Map();
  for (const row of rows) {
    if (row.post) { row.outcome = 'live'; continue; }
    if (!row.topic) { row.outcome = 'no_topic'; continue; }
    if (dryRun) { row.outcome = 'dry_run'; continue; }
    if (!gateOn) { row.outcome = 'gate_off'; continue; }
    const key = row.topic.toLowerCase();
    if (!seen.has(key)) {
      const answer = await suggestReportBlogPost(knex, { phrase: row.topic, tipId: row.tipId });
      seen.set(key, answer.status || answer.error || 'unknown');
    }
    row.outcome = seen.get(key);
  }
  const summary = {
    scanned: rows.length,
    live: rows.filter((row) => row.outcome === 'live').length,
    gaps: rows.filter((row) => row.outcome !== 'live').length,
    queued: rows.filter((row) => row.outcome === 'queued').length,
  };
  return { rows, summary };
}

module.exports = { scan, seedAll };
