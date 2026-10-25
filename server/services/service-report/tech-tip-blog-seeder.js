/**
 * tech-tip-blog-seeder.js — queue the Waves post a tip's subject still lacks
 * (tips with facts, owner 2026-10-24, decisions 2 and 3).
 *
 * A tip's `blog` (tip-library) may name its live post (`path`) and the phrase
 * a new post would be written from (`topic`). A tip with a topic and no live
 * post is a gap. Every queued topic is written and published by the
 * autonomous blog chain, so an operator hand-picks at most five gaps a run
 * (decision 3), and each goes through the office's own "Suggest a post"
 * (report-blog-suggestion suggestReportBlogPost): the phrase must be a topic,
 * every word one the site's live posts use, and a topic a live post covers,
 * the queue holds, or the chain already turned down writes nothing. A post
 * titled for one town covers no tip's subject (`generalOnly`), so a town-only
 * subject still gets its general post (decision 2). The dry
 * run, the default, asks the same checks and writes nothing. Writes need
 * GATE_BLOG_SEARCH_SUGGEST, the queue's own switch.
 *
 * Run by an operator: server/scripts/seed-tech-tip-blogs.js.
 */
const { TIPS } = require('./tip-library');
const { liveBlogPostsByPath } = require('./report-blog-post');
const { suggestReportBlogPost } = require('./report-blog-suggestion');
const featureGates = require('../../config/feature-gates');

const MAX_PICKS = 5;

// Every tip with a topic, and its post when that is live.
async function scan(knex) {
  const withTopic = TIPS.filter((tip) => tip.blog?.topic);
  const live = await liveBlogPostsByPath(knex, withTopic.map((tip) => tip.blog.path).filter(Boolean));
  return withTopic.map((tip) => ({
    tipId: tip.id,
    topic: tip.blog.topic,
    path: tip.blog.path || null,
    post: (tip.blog.path && live.get(tip.blog.path)) || null,
  }));
}

/**
 * The tips with a topic (or the hand-picked ones), each with `outcome`:
 * 'live' when its post is up, else the queue's answer to its topic —
 * 'would_queue' on a dry run, 'queued', 'already_queued', 'covered',
 * 'declined', or a refusal such as 'not_a_topic'. `only` hand-picks at most
 * five tips; `execute` writes, and needs a hand-pick and
 * GATE_BLOG_SEARCH_SUGGEST. Two tips sharing a topic ask once.
 */
async function seedTechTipBlogs(knex, { only = [], execute = false } = {}) {
  const picks = [...new Set(only.map((id) => String(id).trim()).filter(Boolean))];
  if (picks.length > MAX_PICKS) throw new Error(`hand-pick at most ${MAX_PICKS} tips a run (got ${picks.length})`);
  if (execute && !picks.length) throw new Error('--execute needs --only <tipId,...>: every queued topic is written and published');
  if (execute && !featureGates.blogSearchSuggestLive()) throw new Error('GATE_BLOG_SEARCH_SUGGEST is off: the blog queue takes no suggestions');
  const rows = await scan(knex);
  const byId = new Map(rows.map((row) => [row.tipId, row]));
  const unknown = picks.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`no topic on tip(s) ${unknown.join(', ')}`);
  const chosen = picks.length ? picks.map((id) => byId.get(id)) : rows;
  const answers = new Map();
  for (const row of chosen) {
    if (row.post) { row.outcome = 'live'; continue; }
    const key = row.topic.toLowerCase();
    if (!answers.has(key)) {
      const answer = await suggestReportBlogPost(knex, { phrase: row.topic, tipId: row.tipId, dryRun: !execute, generalOnly: true });
      answers.set(key, answer.status || answer.error || 'unknown');
    }
    row.outcome = answers.get(key);
  }
  return chosen;
}

module.exports = { seedTechTipBlogs, MAX_PICKS };
