/**
 * Pest Insider blog posts: the reviewed link from a lead fact to the live
 * blog post that tells its full story ("Read the full story on our blog").
 *
 * Loaded from server/data/pest-insider-posts-v1.json. Each entry maps a main
 * fact id to a post on the website: `path` is the post's own slug (its URL
 * path), `file` is the post's source file in the website repo, and `states`
 * is the passage (one line, a sentence or two) copied exactly from that file
 * which states the fact's claim, the evidence that the post covers the fact (a test checks it against the
 * website repo when that repo is on the machine). A fact with no entry has
 * no post yet, so it cannot lead an issue.
 *
 * An entry is reviewed once, but a post can move or go down later, so a
 * send checks its links first: checkLivePosts() asks the website for each
 * post, and only a post that answers 200 itself (no redirect) counts as
 * live. The builder lets a fact lead only when the caller names it in
 * `livePostFactIds`, the result of that check for this send.
 */
'use strict';

const data = require('../../data/pest-insider-posts-v1.json');
const { FACTS } = require('./facts');

/** The website: every link the Pest Insider body carries points here. */
const SITE = 'https://www.wavespestcontrol.com';

// "/<category>/<slug>/": lowercase words joined by hyphens, nothing else, so
// a path cannot carry a query string, an address, a code or a merge tag.
const POST_PATH = /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const POST_FILE = /^src\/content\/blog\/[a-z0-9-]+\/[a-z0-9-]+\.mdx?$/;
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

function entryProblem(id, entry, mainIds) {
  if (!mainIds.has(id)) return 'is not a main fact in the fact bank';
  if (!entry || typeof entry !== 'object') return 'entry is not an object';
  if (!POST_PATH.test(String(entry.path))) return 'path must be "/<category>/<slug>/"';
  if (!POST_FILE.test(String(entry.file))) return 'file must be src/content/blog/<category>/<name>.md(x)';
  if (!isText(entry.states) || /[\r\n]/.test(entry.states)) return 'states must be one line of text';
  return null;
}

function validatePosts(raw) {
  if (!raw || typeof raw.posts !== 'object' || raw.posts === null || Array.isArray(raw.posts)) {
    throw new Error('pest-insider posts: the file has no posts map');
  }
  const mainIds = new Set(FACTS.filter((f) => !f.reserve).map((f) => f.id));
  const posts = {};
  for (const [id, entry] of Object.entries(raw.posts)) {
    const problem = entryProblem(id, entry, mainIds);
    if (problem) throw new Error(`pest-insider posts: ${id}: ${problem}`);
    posts[id] = Object.freeze({ path: entry.path, file: entry.file, states: entry.states });
  }
  return Object.freeze(posts);
}

// Frozen like the fact bank: the link is reviewed copy too.
const POSTS = validatePosts(data);

/** The full URL of a fact's reviewed post, or null when it has none. */
const postUrl = (factId) => (Object.prototype.hasOwnProperty.call(POSTS, factId) ? `${SITE}${POSTS[factId].path}` : null);

/**
 * Every reviewed post URL, once each; the renderer links no other blog page.
 * A frozen array, not a Set: a frozen Set still takes add(), so a caller
 * could widen the allowlist.
 */
const POST_URLS = Object.freeze([...new Set(Object.keys(POSTS).map(postUrl))]);

// One GET; only a 200 answered by the post itself (no redirect) is live.
async function answersLive(url, fetchImpl, timeoutMs) {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'WavesPestInsider/1 (link check)' },
    });
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Asks the website for each fact's post and returns the ids whose post
 * answered 200 itself. A redirect, any other status, a network error or a
 * timeout means "not live": the issue then leads with another fact. Each
 * post is asked once per check, so facts that share a post (D02 and D03)
 * always get the same answer.
 * @param {{ factIds?: string[], fetchImpl?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<string[]>}
 */
async function checkLivePosts({ factIds = Object.keys(POSTS), fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const answers = new Map();
  const live = [];
  for (const id of new Set(factIds)) {
    const url = postUrl(id);
    if (!url) continue;
    if (!answers.has(url)) answers.set(url, await answersLive(url, fetchImpl, timeoutMs));
    if (answers.get(url)) live.push(id);
  }
  return live;
}

module.exports = { POSTS, POST_URLS, SITE, postUrl, checkLivePosts, validatePosts };
