#!/usr/bin/env node
/**
 * READ-ONLY. Replays the same-question rule (topic-targeting-gate
 * evaluateSameQuestion, GATE_SAME_QUESTION_CHECK) over recent new-supporting-
 * blog runs and prints what it WOULD have blocked and which live page it
 * names as the owner. SELECT statements only: no insert, update, delete,
 * queue write or GitHub write; the gate flag is not read.
 *
 * Per run it takes the brief's target_keyword (fallback: the operator
 * working_title, then the slug; the queue row's query when no brief was
 * composed) and judges it against the CURRENT live blog corpus, with two
 * corrections so the replay matches what the runner would have seen:
 *   - the run's own published post is excluded (it is live now, it was not
 *     then), and
 *   - posts dated on a LATER calendar day (ET) than the run are excluded when
 *     their frontmatter carries a date (the 10-20 millipede run must not
 *     "match" the 10-28 post, nor a post dated the next day).
 *
 * Usage:
 *   node server/scripts/same-question-replay.js                  # last 14 days, blocks + summary
 *   node server/scripts/same-question-replay.js --days=30 --all  # also list runs that would not block
 *   node server/scripts/same-question-replay.js --days=30 --json
 *   node server/scripts/same-question-replay.js --limit=500
 *
 * Corpus: ASTRO_REPO_DIR when set (a local checkout), else the live GitHub
 * Astro repo (read-only), the loader the topic-targeting gate itself uses.
 * Prod: railway run -- node server/scripts/same-question-replay.js --days=30
 */

const gate = require('../services/content/topic-targeting-gate');

const DATE_KEYS = ['date', 'publish_date', 'publishDate', 'pubDate', 'published_at', 'datePublished', 'created'];

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) { out[a] = true; continue; }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) out[body] = true; else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

function intFlag(args, name, fallback) {
  if (args[name] === undefined) return fallback;
  if (args[name] === true || !/^\d+$/.test(String(args[name])) || Number(args[name]) < 1) {
    console.error(`same-question-replay: --${name} must be a positive integer (got ${JSON.stringify(args[name])})`);
    process.exit(1);
  }
  return Number(args[name]);
}

// A post's frontmatter date as a calendar day (YYYY-MM-DD), or null when it
// has none. A date-only value is taken as written; a timestamp is read in ET
// like every other date in the portal.
function postDate(body) {
  try {
    const { parse } = require('../services/content-astro/frontmatter');
    const { etDateString } = require('../utils/datetime-et');
    const data = parse(String(body || '')).data || {};
    for (const key of DATE_KEYS) {
      const v = data[key];
      if (v == null) continue;
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
      const d = v instanceof Date ? v : new Date(String(v));
      if (!Number.isFinite(d.getTime())) continue;
      // yaml reads a bare date as UTC midnight: that is the day as written.
      const utcMidnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
      return utcMidnight ? d.toISOString().slice(0, 10) : etDateString(d);
    }
  } catch { /* undated posts always count */ }
  return null;
}

/**
 * Pure: the keyword a run would have been judged on.
 * run: { target_keyword, opp_query, voice_constraints }
 */
function candidateOf(run) {
  const vc = typeof run.voice_constraints === 'string' ? safeJson(run.voice_constraints) : (run.voice_constraints || {});
  const ob = vc?.operator_brief || {};
  return {
    actionType: 'new_supporting_blog',
    pageType: 'supporting-blog',
    query: run.target_keyword || run.opp_query || null,
    title: ob.working_title || null,
    slug: ob.slug || null,
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

/**
 * Pure: replay `runs` against `corpus` ({ url, path, body }). Returns one row
 * per run: { run_id, claimed_at, outcome, keyword, tokens, would_block, reason,
 * owner_url, owner_published }.
 */
function replay(runs, corpus) {
  const index = gate.indexCorpus(corpus);
  const dateByUrl = new Map();
  for (const item of corpus) {
    if (!item || typeof item.body !== 'string') continue;
    const day = postDate(item.body);
    if (day != null) dateByUrl.set(String(item.url || '').toLowerCase(), day);
  }
  const { etDateString } = require('../utils/datetime-et');
  return runs.map((run) => {
    const runDay = run.claimed_at ? etDateString(new Date(run.claimed_at)) : null;
    const selfUrl = run.published_url ? gate._internals.normalizeSlug(run.published_url) : null;
    const posts = index.posts.filter((p) => {
      if (selfUrl && p.url === selfUrl) return false;
      const day = dateByUrl.get(String(p.url || '').toLowerCase());
      // A post dated on a LATER calendar day (ET) than the run did not exist
      // for it. A same-day post counts: a frontmatter date has no time of day.
      return !(day != null && runDay != null && day > runDay);
    });
    const cand = candidateOf(run);
    const r = gate.evaluateSameQuestion(cand, { index: { ...index, posts } });
    return {
      run_id: run.id,
      claimed_at: run.claimed_at ? new Date(run.claimed_at).toISOString() : null,
      outcome: run.outcome || null,
      skip_reason: run.skip_reason || null,
      published_url: run.published_url || null,
      keyword: cand.query || cand.title || cand.slug || null,
      tokens: r.tokens,
      would_block: r.would_block,
      reason: r.reason,
      owner_url: r.owner?.url || null,
    };
  });
}

async function loadCorpus() {
  const planner = require('../services/content/internal-link-planner');
  const astroDir = process.env.ASTRO_REPO_DIR;
  if (astroDir && planner.loadAstroCorpus) return planner.loadAstroCorpus(astroDir, { collections: ['blog'] });
  return planner.loadAstroCorpusFromGitHub({ collections: ['blog'] });
}

// SELECT only. The run, its composed brief (when one exists) and the queue
// row's query as the fallback keyword.
async function loadRuns(db, { days, limit }) {
  const since = new Date(Date.now() - days * 86400_000);
  return db('autonomous_runs as r')
    .leftJoin('content_briefs as b', 'b.id', 'r.brief_id')
    .leftJoin('opportunity_queue as o', 'o.id', 'r.opportunity_id')
    .where('r.action_type', 'new_supporting_blog')
    .where('r.claimed_at', '>=', since)
    .orderBy('r.claimed_at', 'asc')
    .limit(limit)
    .select('r.id', 'r.claimed_at', 'r.outcome', 'r.skip_reason', 'r.published_url',
      'b.target_keyword', 'b.voice_constraints', 'o.query as opp_query');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const known = new Set(['days', 'limit', 'all', 'json']);
  const unknown = Object.keys(args).filter((k) => !known.has(k));
  if (unknown.length) {
    console.error(`same-question-replay: unknown argument(s) ${unknown.map((k) => JSON.stringify(k)).join(', ')} — known: --${[...known].join(', --')}`);
    process.exit(1);
  }
  const days = intFlag(args, 'days', 14);
  const limit = intFlag(args, 'limit', 300);
  const db = require('../models/db');
  try {
    const [runs, corpus] = await Promise.all([loadRuns(db, { days, limit }), loadCorpus()]);
    if (!Array.isArray(corpus) || !corpus.length) throw new Error('empty_blog_corpus');
    const rows = replay(runs, corpus);
    const blocks = rows.filter((r) => r.would_block);
    if (args.json) {
      console.log(JSON.stringify({ days, runs: rows.length, corpus_size: corpus.length, would_block: blocks.length, rows: args.all ? rows : blocks }, null, 2));
    } else {
      console.log(`same-question replay: ${rows.length} new-blog run(s) in the last ${days} day(s) against ${corpus.length} live post(s)`);
      for (const r of (args.all ? rows : blocks)) {
        const verdict = r.would_block ? 'WOULD BLOCK' : `ok (${r.reason})`;
        console.log(`${r.claimed_at ? r.claimed_at.slice(0, 10) : '?'}  ${verdict}  "${r.keyword}"  words=${r.tokens.join('+') || '-'}${r.owner_url ? `  owner=${r.owner_url}` : ''}  run=${r.run_id} outcome=${r.outcome}${r.published_url ? ` published=${r.published_url}` : ''}`);
      }
      console.log(`Would block ${blocks.length} of ${rows.length}.`);
    }
    process.exitCode = 0;
  } catch (err) {
    console.error(`same-question-replay failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = { replay, candidateOf, postDate };
