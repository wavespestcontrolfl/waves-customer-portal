// Pest Insider blog links: the reviewed fact -> post list, and the live
// check a send runs before it lets a fact lead.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { POSTS, POST_URLS, SITE, postUrl, checkLivePosts, validatePosts } = require('../services/pest-insider/posts');
const { FACTS } = require('../services/pest-insider/facts');

const MAIN = FACTS.filter((f) => !f.reserve);
const [FIRST] = Object.keys(POSTS);
const entry = (over = {}) => ({ path: '/pest-control/some-post/', file: 'src/content/blog/pest-control/some-post.md', states: 'One sentence.', ...over });

describe('the reviewed post list', () => {
  test('every entry names a main fact and a post path on the website', () => {
    expect(Object.keys(POSTS).length).toBeGreaterThan(0);
    for (const [id, post] of Object.entries(POSTS)) {
      expect(MAIN.map((f) => f.id)).toContain(id);
      expect(postUrl(id)).toBe(`${SITE}${post.path}`);
      expect(POST_URLS).toContain(postUrl(id));
    }
    expect(postUrl('Z99')).toBeNull();
    expect(Object.isFrozen(POSTS) && Object.isFrozen(POSTS[FIRST])).toBe(true);
  });

  test('the link allowlist lists each post once and cannot be widened', () => {
    expect(new Set(POST_URLS).size).toBe(POST_URLS.length);
    expect(POST_URLS).toEqual([...new Set(Object.keys(POSTS).map(postUrl))]);
    expect(() => POST_URLS.push('https://www.example.com/post/')).toThrow(TypeError);
    expect(POST_URLS).not.toContain('https://www.example.com/post/');
  });

  test.each([
    ['an unknown fact', { Z99: entry() }, /Z99: is not a main fact/],
    ['a reserve fact', { [FACTS.find((f) => f.reserve).id]: entry() }, /is not a main fact/],
    ['a path with a query string', { [MAIN[0].id]: entry({ path: '/pest-control/some-post/?email=a@b.co' }) }, /path must be/],
    ['a path with no category', { [MAIN[0].id]: entry({ path: '/some-post/' }) }, /path must be/],
    ['a path with capitals', { [MAIN[0].id]: entry({ path: '/pest-control/Some-Post/' }) }, /path must be/],
    ['a path with no closing slash', { [MAIN[0].id]: entry({ path: '/pest-control/some-post' }) }, /path must be/],
    ['a file outside the blog', { [MAIN[0].id]: entry({ file: 'src/pages/index.astro' }) }, /file must be/],
    ['a states line on two lines', { [MAIN[0].id]: entry({ states: 'One.\nTwo.' }) }, /states must be one line/],
    ['an empty states line', { [MAIN[0].id]: entry({ states: ' ' }) }, /states must be one line/],
  ])('refuses %s', (_label, posts, message) => {
    expect(() => validatePosts({ posts })).toThrow(message);
  });

  test('refuses a file with no posts map', () => {
    expect(() => validatePosts({})).toThrow(/no posts map/);
    expect(() => validatePosts({ posts: [] })).toThrow(/no posts map/);
  });

  // The website repo is on the owner's Mac, not in CI. Where it is, each
  // entry is held to the post on the website's main branch: the file is
  // there, its slug is the entry's path, it is not a draft, and the states
  // line is copied from it exactly.
  const SITE_REPO = path.join(os.homedir(), 'wavespestcontrol-astro');
  const siteRepoHere = fs.existsSync(path.join(SITE_REPO, '.git'));
  // Inside a git hook (the pre-push audit) GIT_DIR and friends name the
  // portal repo, and they win over `git -C`: drop every GIT_* variable so
  // git finds the website repo (pre-push r2).
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  (siteRepoHere ? test : test.skip)('every states line is copied exactly from its post on the website repo (when it is on this machine)', () => {
    const problems = [];
    for (const [id, post] of Object.entries(POSTS)) {
      let source;
      try {
        source = execFileSync('git', ['-C', SITE_REPO, 'show', `origin/main:${post.file}`], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        problems.push(`${id}: ${post.file} is not on the website repo's origin/main (fetch it?)`);
        continue;
      }
      const front = source.split(/^---\s*$/m)[1] || '';
      if (!new RegExp(`^slug:\\s*["']?${post.path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["']?\\s*$`, 'm').test(front)) problems.push(`${id}: slug is not ${post.path}`);
      if (/^draft:\s*true\s*$/m.test(front)) problems.push(`${id}: the post is a draft`);
      if (!source.includes(post.states)) problems.push(`${id}: states line not found in ${post.file}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('checkLivePosts', () => {
  // four facts with four different posts (D02 and D03 share one)
  const ids = Object.keys(POSTS).filter((id, i, all) => all.findIndex((x) => postUrl(x) === postUrl(id)) === i).slice(0, 4);
  const answers = (byUrl) => jest.fn(async (url) => {
    const a = byUrl[url];
    if (a instanceof Error) throw a;
    return { status: a, body: { cancel: jest.fn(async () => {}) } };
  });

  test('only a post that answers 200 itself is live: a redirect, a 404 or a network error is not', async () => {
    expect(ids).toHaveLength(4);
    const fetchImpl = answers({
      [postUrl(ids[0])]: 200,
      [postUrl(ids[1])]: 301,
      [postUrl(ids[2])]: 404,
      [postUrl(ids[3])]: new Error('getaddrinfo ENOTFOUND'),
    });
    await expect(checkLivePosts({ factIds: ids, fetchImpl })).resolves.toEqual([ids[0]]);
    for (const [, opts] of fetchImpl.mock.calls) {
      expect(opts).toMatchObject({ method: 'GET', redirect: 'manual' });
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test('asks only for facts with a reviewed post, and every reviewed post by default', async () => {
    const fetchImpl = answers(Object.fromEntries(Object.keys(POSTS).map((id) => [postUrl(id), 200])));
    await expect(checkLivePosts({ factIds: ['Z99', FIRST, FIRST], fetchImpl })).resolves.toEqual([FIRST]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();
    await expect(checkLivePosts({ fetchImpl })).resolves.toEqual(Object.keys(POSTS));
    expect(fetchImpl).toHaveBeenCalledTimes(POST_URLS.length);
  });

  test('facts that share a post get one request and the same answer (pre-push r1)', async () => {
    const byUrl = new Map();
    for (const id of Object.keys(POSTS)) byUrl.set(postUrl(id), [...(byUrl.get(postUrl(id)) || []), id]);
    const [url, shared] = [...byUrl].find(([, list]) => list.length > 1);
    // a second request would answer differently: the check must not make one
    let calls = 0;
    const fetchImpl = jest.fn(async () => {
      calls += 1;
      if (calls > 1) throw new Error('timeout');
      return { status: 200, body: { cancel: jest.fn(async () => {}) } };
    });
    await expect(checkLivePosts({ factIds: shared, fetchImpl })).resolves.toEqual(shared);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(url);
  });

  test('a post that does not answer in time is not live', async () => {
    const fetchImpl = jest.fn((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    }));
    await expect(checkLivePosts({ factIds: [FIRST], fetchImpl, timeoutMs: 20 })).resolves.toEqual([]);
  });
});
