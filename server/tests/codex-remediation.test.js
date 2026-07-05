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
      blog_posts: [{ id: 1, publish_status: 'publishing', astro_pr_number: 5, astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches', category: 'pest-control', tag: 'Rodents', title: 'T', city: 'Sarasota', keyword: 'k' }],
    });
    const gh = makeGh();
    const r = await maybeRemediateBlogPost({ id: 1, astro_pr_number: 5, astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches' }, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(db._tables.blog_posts[0].publish_status).toBe('pending_review');
  });

  test('autonomous lane remediates from the PR object (.mdx) once the run gates re-pass', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    const run = { id: 'run-1', action_type: 'new_supporting_blog' };
    // getPr returns the same open PR
    gh.getPr = async () => pr;
    let revalidatedWith = null;
    const r = await maybeRemediateAutonomousPr(pr, run, {
      db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
      validateAutonomousRunGates: async (md, r2) => { revalidatedWith = r2; return { ok: true }; },
    });
    expect(r.remediated).toBe(true);
    expect(revalidatedWith).toBe(run);
    expect(gh._calls.putFile[0].path).toBe('src/content/blog/pest-control/roaches.mdx');
    expect(gh._calls.putFile[0].branch).toBe('content/autonomous-x');
  });

  test('autonomous lane with a failing gate re-run -> park, nothing committed', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    gh.getPr = async () => pr;
    const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
      db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
      validateAutonomousRunGates: async () => ({ ok: false, reason: 'uniqueness gate: near-duplicate' }),
    });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/lane gates/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('autonomous lane with NO run row -> park (fail closed), runner never loaded', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    gh.getPr = async () => pr;
    // No injected validator: the real validateAutonomousRunGates must bail on
    // the missing run BEFORE requiring the autonomous-runner module.
    const r = await maybeRemediateAutonomousPr(pr, null, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/run row unavailable/);
    expect(gh._calls.putFile).toHaveLength(0);
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

  test('validateFixedBlogFile rejects a non-blog file', async () => {
    expect((await rem.validateFixedBlogFile('just some text, no frontmatter')).ok).toBe(false);
  });
});

describe('round-4 hardening', () => {
  const prev = process.env.AUTONOMOUS_CODEX_REMEDIATION;
  afterEach(() => { process.env.AUTONOMOUS_CODEX_REMEDIATION = prev; });

  test('maybeRemediateBlogPost re-fetches the row (PR number + topic) from db', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    let captured = null;
    const db = makeDb({ blog_posts: [{ id: 1, astro_pr_number: 5, astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches', category: 'pest-control', tag: 'Rodents', title: 'Roof Rats', city: 'Sarasota', keyword: 'roof rats' }] });
    const gh = makeGh();
    const capturingValidate = (md, opts) => { captured = opts; return { ok: true }; };
    const r = await maybeRemediateBlogPost({ id: 1 }, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: capturingValidate });
    expect(r.remediated).toBe(true);
    expect(captured.service).toEqual(['pest-control', 'Rodents']);
    expect(captured.factContext.title).toBe('Roof Rats');
  });

  test('immutableFrontmatterChanged detects slug/canonical/domains edits', () => {
    const orig = '---\nslug: /a/\ncanonical: https://x/a/\ndomains:\n  - hub\n---\nbody';
    expect(rem.immutableFrontmatterChanged(orig, orig)).toBe(false);
    expect(rem.immutableFrontmatterChanged(orig, orig.replace('/a/', '/b/'))).toBe(true);
  });

  test('fix that changes routing frontmatter -> park', async () => {
    const db = makeDb();
    const orig = '---\nslug: /pest-control/x/\n---\nbody';
    const changed = '---\nslug: /pest-control/y/\n---\nbody';
    const gh = makeGh({ fileContent: orig });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall(changed), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/frontmatter/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('null LLM fix retries under the limit and parks at it', async () => {
    const nullCall = async () => ({ ok: false, reason: 'no_key' });
    const db1 = makeDb();
    const r1 = await runRemediationForPr(CTX, { db: db1, gh: makeGh(), callAnthropic: nullCall, validateFixedBlogFile: PASS });
    expect(r1.skipped).toBe(true); expect(r1.reason).toMatch(/will retry/);
    expect(db1._tables.codex_remediation_state[0].rounds).toBe(1);

    const db2 = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: MAX_ROUNDS - 1, status: 'remediating' }] });
    const r2 = await runRemediationForPr(CTX, { db: db2, gh: makeGh(), callAnthropic: nullCall, validateFixedBlogFile: PASS });
    expect(r2.parked).toBe(true); expect(r2.reason).toMatch(/max attempts/);
  });
});

describe('round-5 hardening (Codex findings on 2ef3b27)', () => {
  const prev = process.env.AUTONOMOUS_CODEX_REMEDIATION;
  afterEach(() => { process.env.AUTONOMOUS_CODEX_REMEDIATION = prev; });

  // P1: pass:true + requiresHumanReview:true must never auto-continue — the
  // astro_requires_human_merge / named_competitor_review stamps predate the fix.
  test('fix that introduces named-competitor content (requiresHumanReview) -> park', async () => {
    const gh = makeGh();
    const r = await runRemediationForPr(CTX, {
      db: makeDb(), gh, callAnthropic: makeCall('FIXED'),
      validateFixedBlogFile: () => ({ ok: true, requiresHumanReview: true }),
    });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/named-competitor/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  // P2: the ENTIRE frontmatter is immutable — not just slug/canonical/domains.
  test('immutableFrontmatterChanged flags any key change (title/hero/author/date/added key)', () => {
    const orig = '---\ntitle: Roof Rats\nhero_image: /images/blog/x/hero.webp\nauthor: Adam\npublished: "2026-07-01"\n---\nbody text';
    expect(rem.immutableFrontmatterChanged(orig, orig)).toBe(false);
    expect(rem.immutableFrontmatterChanged(orig, orig.replace('Roof Rats', 'Rats'))).toBe(true);
    expect(rem.immutableFrontmatterChanged(orig, orig.replace('/images/blog/x/hero.webp', '/images/blog/x/other.webp'))).toBe(true);
    expect(rem.immutableFrontmatterChanged(orig, orig.replace('Adam', 'Ghost Writer'))).toBe(true);
    expect(rem.immutableFrontmatterChanged(orig, orig.replace('"2026-07-01"', '"2026-07-05"'))).toBe(true);
    expect(rem.immutableFrontmatterChanged(orig, orig.replace('---\nbody', 'og_image: /og.png\n---\nbody'))).toBe(true);
    // body-only edit with identical frontmatter is allowed
    expect(rem.immutableFrontmatterChanged(orig, orig.replace('body text', 'fixed body text'))).toBe(false);
  });

  test('fix that changes non-routing frontmatter (title) -> park', async () => {
    const orig = '---\ntitle: A\nslug: /pest-control/x/\n---\nbody';
    const changed = '---\ntitle: B\nslug: /pest-control/x/\n---\nbody';
    const gh = makeGh({ fileContent: orig });
    const r = await runRemediationForPr(CTX, { db: makeDb(), gh, callAnthropic: makeCall(changed), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/frontmatter/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  // P2: lane gate re-run hook — a throwing hook parks, never commits.
  test('revalidateFix that throws -> park with the error surfaced', async () => {
    const gh = makeGh();
    const r = await runRemediationForPr(
      { ...CTX, revalidateFix: async () => { throw new Error('blog_corpus_loader_unavailable'); } },
      { db: makeDb(), gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS },
    );
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/blog_corpus_loader_unavailable/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  // P2: scheduler lane must mirror the committed body into blog_posts.content.
  test('scheduler lane syncs blog_posts.content with the fixed BODY after commit', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const orig = '---\ntitle: T\n---\nOLD BODY';
    const fixedMd = '---\ntitle: T\n---\nNEW FIXED BODY';
    const db = makeDb({
      blog_posts: [{ id: 1, astro_pr_number: 5, astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches', category: 'pest-control', tag: 'Rodents', title: 'T', city: 'Sarasota', keyword: 'k', content: 'OLD BODY' }],
    });
    const gh = makeGh({ fileContent: orig });
    const r = await maybeRemediateBlogPost({ id: 1 }, { db, gh, callAnthropic: makeCall(fixedMd), validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
    expect(db._tables.blog_posts[0].content).toBe('NEW FIXED BODY');
  });

  test('row sync failure AFTER the commit -> park, review NOT re-requested', async () => {
    const gh = makeGh();
    const r = await runRemediationForPr(
      { ...CTX, onRemediated: async () => { throw new Error('db down'); } },
      { db: makeDb(), gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS },
    );
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/row sync failed/);
    expect(gh._calls.putFile).toHaveLength(1); // the commit DID land on the branch
    expect(gh._calls.comments).toHaveLength(0); // but Codex re-review was not requested
  });
});

describe('validateAutonomousRunGates', () => {
  const MD = '---\ntitle: T\n---\nFixed body text';
  const RUN = {
    id: 'run-1',
    action_type: 'new_supporting_blog',
    draft_payload: JSON.stringify({ body: 'original body', url: 'https://hub/blog/x/', title: 'T' }),
  };
  const goodDeps = () => ({
    autonomousRunner: {
      _loadReviewedBrief: async () => ({ page_type: 'supporting-blog', action_type: 'new_supporting_blog' }),
      _loadBlogCorpus: async () => [],
    },
    uniquenessGate: { evaluateBlog: () => ({ ok: true }) },
    qualityGate: { evaluate: () => ({ ok: true }) },
    seoCompletionGate: { evaluate: () => ({ passed: true, findings: [] }) },
    aiVisibilityGate: { evaluateStatic: () => ({ passed: true }) },
  });

  test('all gates pass -> ok', async () => {
    expect((await rem.validateAutonomousRunGates(MD, RUN, goodDeps())).ok).toBe(true);
  });

  test('fail closed: missing run / non-blog action / empty stored draft / missing brief', async () => {
    expect((await rem.validateAutonomousRunGates(MD, null, goodDeps())).ok).toBe(false);
    expect((await rem.validateAutonomousRunGates(MD, { id: 'r', action_type: 'refresh_existing_page' }, goodDeps())).ok).toBe(false);
    expect((await rem.validateAutonomousRunGates(MD, { id: 'r', action_type: 'new_supporting_blog', draft_payload: '{}' }, goodDeps())).ok).toBe(false);
    const noBrief = goodDeps(); noBrief.autonomousRunner._loadReviewedBrief = async () => null;
    expect((await rem.validateAutonomousRunGates(MD, RUN, noBrief)).ok).toBe(false);
  });

  test('each failing gate fails the re-run with a named reason', async () => {
    const d1 = goodDeps(); d1.uniquenessGate.evaluateBlog = () => ({ ok: false, error: 'near-duplicate of published post' });
    expect((await rem.validateAutonomousRunGates(MD, RUN, d1)).reason).toMatch(/uniqueness/);
    const d2 = goodDeps(); d2.qualityGate.evaluate = () => ({ ok: false, failures: ['cta_above_fold'] });
    expect((await rem.validateAutonomousRunGates(MD, RUN, d2)).reason).toMatch(/quality/);
    const d3 = goodDeps(); d3.seoCompletionGate.evaluate = () => ({ passed: false, findings: [{ severity: 'P0', code: 'P0_MISSING_BODY' }] });
    expect((await rem.validateAutonomousRunGates(MD, RUN, d3)).reason).toMatch(/seo-completion/);
    const d4 = goodDeps(); d4.aiVisibilityGate.evaluateStatic = () => ({ passed: false, findings: [{ code: 'P0_NOINDEX' }] });
    expect((await rem.validateAutonomousRunGates(MD, RUN, d4)).reason).toMatch(/visibility/);
    const d5 = goodDeps(); d5.autonomousRunner._loadBlogCorpus = async () => { throw new Error('corpus unavailable'); };
    expect((await rem.validateAutonomousRunGates(MD, RUN, d5)).reason).toMatch(/corpus unavailable/);
  });

  test('a skipped SEO verdict on a supporting blog is a failure, not a pass', async () => {
    const d = goodDeps(); d.seoCompletionGate.evaluate = () => ({ passed: true, skipped: 'not_supporting_blog' });
    expect((await rem.validateAutonomousRunGates(MD, RUN, d)).ok).toBe(false);
  });

  test('gates evaluate the FIXED body swapped into the stored draft', async () => {
    const deps = goodDeps();
    const seen = {};
    deps.uniquenessGate.evaluateBlog = (draft) => { seen.uniq = draft.body; return { ok: true }; };
    deps.aiVisibilityGate.evaluateStatic = ({ url, html }) => { seen.url = url; seen.html = html; return { passed: true }; };
    expect((await rem.validateAutonomousRunGates(MD, RUN, deps)).ok).toBe(true);
    expect(seen.uniq).toBe('Fixed body text');
    expect(seen.html).toBe('Fixed body text');
    expect(seen.url).toBe('https://hub/blog/x/');
  });
});
