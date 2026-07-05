const rem = require('../services/content/codex-remediation');

const {
  parseCodexFindings,
  pickTargetPath,
  buildReviewRequestBody,
  reviewRequestedForHead,
  stripCodeFence,
  atRoundLimit,
  runRemediationForPr,
  maybeRemediateBlogPost,
  maybeRemediateAutonomousPr,
  MAX_ROUNDS,
} = rem;

const CODEX = 'chatgpt-codex-connector[bot]';
const HEAD = 'abc1234def5678';

function finding(over = {}) {
  return {
    user: { login: CODEX },
    commit_id: HEAD,
    path: 'src/content/blog/pest-control/roaches.md',
    line: 42,
    body: 'Fix the broken link.',
    ...over,
  };
}

const match = (row, crit) => Object.entries(crit).every(([k, v]) => row[k] === v);

// In-memory knex stub over named tables. Supports where/first/insert/update.
function makeDb(initial = {}) {
  const tables = {};
  for (const [t, rows] of Object.entries(initial)) tables[t] = rows.map((r) => ({ ...r }));
  function db(table) {
    tables[table] = tables[table] || [];
    let crit = {};
    return {
      where(c) { crit = c; return this; },
      async first() { const r = tables[table].find((x) => match(x, crit)); return r ? { ...r } : null; },
      async update(patch) { const rows = tables[table].filter((x) => match(x, crit)); rows.forEach((r) => Object.assign(r, patch)); return rows.length; },
      async insert(row) { tables[table].push({ ...row }); return [1]; },
    };
  }
  db._tables = tables;
  return db;
}

function makeGh(over = {}) {
  const calls = { putFile: [], comments: [] };
  const gh = {
    async getPr() { return { state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } }; },
    async listPrReviewComments() { return over.reviewComments || [finding()]; },
    async listIssueComments() { return over.issueComments || []; },
    async getFile() { return { content: over.fileContent ?? 'ORIGINAL BODY', sha: 'file-sha-1' }; },
    async putFile(args) { calls.putFile.push(args); return { commit: { sha: 'newcommit999aaa' } }; },
    async getBranchSha() { return 'newcommit999aaa'; },
    async createIssueComment(n, body) { calls.comments.push({ n, body }); if (over.commentThrows) throw new Error('gh 502'); return {}; },
  };
  Object.assign(gh, over.gh || {});
  gh._calls = calls;
  return gh;
}

const makeCall = (text) => async () => ({ ok: true, text });
const PASS = () => ({ ok: true });

const CTX = { prNumber: 5, branch: 'content/blog-x', slug: 'pest-control/roaches' };

describe('parseCodexFindings', () => {
  test('keeps Codex findings on the current head', () => {
    expect(parseCodexFindings([finding()], HEAD)).toEqual([{ path: 'src/content/blog/pest-control/roaches.md', line: 42, body: 'Fix the broken link.' }]);
  });
  test('drops non-Codex authors + wrong-commit + empty body', () => {
    expect(parseCodexFindings([finding({ user: { login: 'human' } })], HEAD)).toEqual([]);
    expect(parseCodexFindings([finding({ commit_id: 'zzz9999' })], HEAD)).toEqual([]);
    expect(parseCodexFindings([finding({ body: '  ' })], HEAD)).toEqual([]);
  });
  test('drops unattributable comment when head known; keeps on original_commit_id', () => {
    expect(parseCodexFindings([finding({ commit_id: null, original_commit_id: null })], HEAD)).toEqual([]);
    expect(parseCodexFindings([finding({ commit_id: 'other', original_commit_id: HEAD })], HEAD)).toHaveLength(1);
  });
});

describe('pickTargetPath', () => {
  test('prefers a blog .md finding path', () => {
    expect(pickTargetPath([{ path: 'astro.config.mjs' }, { path: 'src/content/blog/x/y.md' }])).toBe('src/content/blog/x/y.md');
  });
  test('accepts .mdx (autonomous posts)', () => {
    expect(pickTargetPath([{ path: 'src/content/blog/pest-control/roaches.mdx' }])).toBe('src/content/blog/pest-control/roaches.mdx');
  });
  test('falls back to the slug-derived .md path', () => {
    expect(pickTargetPath([{ path: null }], '/pest-control/roaches/')).toBe('src/content/blog/pest-control/roaches.md');
  });
});

describe('helpers', () => {
  test('buildReviewRequestBody embeds head + @codex review', () => {
    const b = buildReviewRequestBody('deadbeef');
    expect(b).toMatch(/@codex review/); expect(b).toContain('deadbeef');
  });
  test('reviewRequestedForHead detects a matching @codex review comment', () => {
    expect(reviewRequestedForHead([{ body: '@codex review on head `abc1234`' }], HEAD)).toBe(true);
    expect(reviewRequestedForHead([{ body: 'unrelated' }], HEAD)).toBe(false);
  });
  test('stripCodeFence removes a ```markdown fence', () => { expect(stripCodeFence('```markdown\nhello\n```')).toBe('hello\n'); });
  test('atRoundLimit respects MAX_ROUNDS', () => { expect(atRoundLimit(MAX_ROUNDS)).toBe(true); expect(atRoundLimit(MAX_ROUNDS - 1)).toBe(false); });
});

describe('runRemediationForPr', () => {
  test('fresh findings under limit → push fix, persist state, re-request review', async () => {
    const db = makeDb();
    const gh = makeGh();
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED BODY'), validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
    expect(r.round).toBe(1);
    expect(gh._calls.putFile[0].path).toBe('src/content/blog/pest-control/roaches.md');
    expect(gh._calls.putFile[0].branch).toBe('content/blog-x');
    expect(gh._calls.comments[0].body).toContain('newcommit999aaa');
    const st = db._tables.codex_remediation_state[0];
    expect(st.rounds).toBe(1); expect(st.status).toBe('remediating');
  });

  test('.mdx finding path is edited (not the slug .md fallback)', async () => {
    const db = makeDb();
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
    expect(gh._calls.putFile[0].path).toBe('src/content/blog/pest-control/roaches.mdx');
  });

  test('no findings, never remediated → wait', async () => {
    const db = makeDb();
    const gh = makeGh({ reviewComments: [] });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('no findings while remediating + review request missing → re-requests (recovery)', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating' }] });
    const gh = makeGh({ reviewComments: [], issueComments: [] });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.reason).toMatch(/recovered/);
    expect(gh._calls.comments).toHaveLength(1);
  });

  test('no findings while remediating + review already requested → wait, no comment', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating' }] });
    const gh = makeGh({ reviewComments: [], issueComments: [{ body: `@codex review \`${HEAD}\`` }] });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.reason).toMatch(/awaiting/);
    expect(gh._calls.comments).toHaveLength(0);
  });

  test('fresh findings at the round limit → park (onPark fired)', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: MAX_ROUNDS, status: 'remediating' }] });
    const gh = makeGh();
    let parked = false;
    const r = await runRemediationForPr({ ...CTX, onPark: async () => { parked = true; } }, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(parked).toBe(true);
    expect(gh._calls.putFile).toHaveLength(0);
    expect(db._tables.codex_remediation_state[0].status).toBe('parked');
  });

  test('fix produces no change → park', async () => {
    const db = makeDb();
    const gh = makeGh({ fileContent: 'ORIGINAL BODY' });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('ORIGINAL BODY'), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/no change/);
  });

  test('already parked → skip', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'parked' }] });
    const r = await runRemediationForPr(CTX, { db, gh: makeGh(), callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true); expect(r.reason).toBe('parked');
  });

  test('closed PR → skip', async () => {
    const gh = makeGh({ gh: { getPr: async () => ({ state: 'closed' }) } });
    const r = await runRemediationForPr(CTX, { db: makeDb(), gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true);
  });

  test('state is persisted BEFORE the review comment (comment failure cannot strand)', async () => {
    const db = makeDb();
    const gh = makeGh({ commentThrows: true });
    await expect(runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS })).rejects.toThrow();
    // putFile happened and the round was recorded even though the comment threw.
    expect(gh._calls.putFile).toHaveLength(1);
    expect(db._tables.codex_remediation_state[0].rounds).toBe(1);
    expect(db._tables.codex_remediation_state[0].status).toBe('remediating');
  });
});

describe('lane entry points', () => {
  const prev = process.env.AUTONOMOUS_CODEX_REMEDIATION;
  afterEach(() => { process.env.AUTONOMOUS_CODEX_REMEDIATION = prev; });

  test('disabled → skip without touching GitHub', async () => {
    delete process.env.AUTONOMOUS_CODEX_REMEDIATION;
    const gh = makeGh();
    const r = await maybeRemediateBlogPost({ id: 1, astro_pr_number: 5, astro_branch_name: 'b', slug: 'x' }, { db: makeDb(), gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r).toEqual({ skipped: true, reason: 'disabled' });
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('scheduler park disarms the publishing claim → pending_review', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      codex_remediation_state: [{ pr_number: 5, rounds: MAX_ROUNDS, status: 'remediating' }],
      blog_posts: [{ id: 1, publish_status: 'publishing' }],
    });
    const gh = makeGh();
    const r = await maybeRemediateBlogPost({ id: 1, astro_pr_number: 5, astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches' }, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(db._tables.blog_posts[0].publish_status).toBe('pending_review');
  });

  test('autonomous lane remediates from the PR object (.mdx)', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    // getPr returns the same open PR
    gh.getPr = async () => pr;
    const r = await maybeRemediateAutonomousPr(pr, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
    expect(gh._calls.putFile[0].path).toBe('src/content/blog/pest-control/roaches.mdx');
    expect(gh._calls.putFile[0].branch).toBe('content/autonomous-x');
  });
});

describe('content-gate + truncation + marker safety', () => {
  test('fix that fails the content gates -> park (not committed)', async () => {
    const db = makeDb();
    const gh = makeGh();
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: () => ({ ok: false, reason: 'guardrails HARDCODED_PRICE' }) });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/content gates/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('truncated LLM output (stop_reason max_tokens) -> no commit', async () => {
    const db = makeDb();
    const gh = makeGh();
    const truncated = async () => ({ ok: true, text: 'partial...', response: { stop_reason: 'max_tokens' } });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: truncated, validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('status marked remediating BEFORE the push (survives a putFile failure)', async () => {
    const db = makeDb();
    const gh = makeGh({ gh: { putFile: async () => { throw new Error('gh 500'); } } });
    await expect(runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS })).rejects.toThrow();
    expect(db._tables.codex_remediation_state[0].status).toBe('remediating');
  });

  test('validateFixedBlogFile rejects a non-blog file', () => {
    expect(rem.validateFixedBlogFile('just some text, no frontmatter').ok).toBe(false);
  });
});
