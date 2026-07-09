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

  test('no findings, never remediated, no request for head → posts the initial review request', async () => {
    const db = makeDb();
    const gh = makeGh({ reviewComments: [], issueComments: [] });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/requested codex review/);
    expect(gh._calls.putFile).toHaveLength(0);
    expect(gh._calls.comments).toHaveLength(1);
    expect(gh._calls.comments[0].body).toMatch(/@codex review/);
    expect(gh._calls.comments[0].body).toContain(HEAD);
  });

  test('no findings, never remediated, request already covers head → wait without re-posting', async () => {
    const db = makeDb();
    const gh = makeGh({ reviewComments: [], issueComments: [{ body: `@codex review \`${HEAD}\`` }] });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/awaiting codex review/);
    expect(gh._calls.comments).toHaveLength(0);
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

  test('parked at the CURRENT head → skip', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'parked', parked_head_sha: HEAD }] });
    const gh = makeGh();
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true); expect(r.reason).toBe('parked');
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('park persists reason + the head the verdict applied to', async () => {
    const db = makeDb();
    const gh = makeGh({ fileContent: 'ORIGINAL BODY' });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('ORIGINAL BODY'), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    const row = db._tables.codex_remediation_state[0];
    expect(row.status).toBe('parked');
    expect(row.park_reason).toMatch(/no change/);
    expect(row.parked_head_sha).toBe(HEAD.toLowerCase());
  });

  test('parked at an OLDER head → re-arm with fresh rounds and run the round', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: MAX_ROUNDS, status: 'parked', parked_head_sha: 'older9999999', park_reason: 'exhausted rounds' }] });
    const gh = makeGh();
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
    expect(r.round).toBe(1); // rounds reset on re-arm
    const row = db._tables.codex_remediation_state[0];
    expect(row.park_reason).toBeNull();
    expect(row.parked_head_sha).toBeNull();
  });

  test('legacy parked row (no parked_head_sha) → re-arms once', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'parked' }] });
    const gh = makeGh();
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
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

  test('autonomous lane park annotates the run reviewer_notes with the reason', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({ autonomous_runs: [{ id: 'run-1', reviewer_notes: 'prior note' }] });
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    gh.getPr = async () => pr;
    const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
      db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
      validateAutonomousRunGates: async () => ({ ok: false, reason: 'uniqueness gate: near-duplicate' }),
    });
    expect(r.parked).toBe(true);
    const run = db._tables.autonomous_runs[0];
    expect(run.reviewer_notes).toContain('prior note');
    expect(run.reviewer_notes).toContain('Codex remediation parked PR #7');
    expect(run.reviewer_notes).toContain('uniqueness gate: near-duplicate');
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
    const db = makeDb({ blog_posts: [{ id: 1, publish_status: 'publishing', astro_pr_number: 5, astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches', category: 'pest-control', tag: 'Rodents', title: 'Roof Rats', city: 'Sarasota', keyword: 'roof rats' }] });
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
      blog_posts: [{ id: 1, publish_status: 'publishing', astro_pr_number: 5, astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches', category: 'pest-control', tag: 'Rodents', title: 'T', city: 'Sarasota', keyword: 'k', content: 'OLD BODY' }],
    });
    const gh = makeGh({ fileContent: orig });
    const r = await maybeRemediateBlogPost({ id: 1 }, { db, gh, callAnthropic: makeCall(fixedMd), validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
    expect(db._tables.blog_posts[0].content).toBe('NEW FIXED BODY');
  });

  // r9/r11: two layers guard the sync. The pre-push check skips BEFORE the
  // branch write when the row already left the claim; the CAS covers the
  // narrower putFile→sync window and parks.
  test('row already out of the publishing claim -> pre-push check skips before any branch write', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const orig = '---\ntitle: T\n---\nOLD BODY';
    const fixedMd = '---\ntitle: T\n---\nNEW FIXED BODY';
    // publish_status already moved to pending_review (stale-publishing sweep).
    const db = makeDb({
      blog_posts: [{ id: 1, publish_status: 'pending_review', astro_pr_number: 5, astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches', category: 'pest-control', tag: 'Rodents', title: 'T', city: 'Sarasota', keyword: 'k', content: 'CURRENT BODY' }],
    });
    const gh = makeGh({ fileContent: orig });
    const r = await maybeRemediateBlogPost({ id: 1 }, { db, gh, callAnthropic: makeCall(fixedMd), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/pre-push check failed/);
    expect(gh._calls.putFile).toHaveLength(0); // branch never touched
    expect(db._tables.blog_posts[0].content).toBe('CURRENT BODY'); // untouched
  });

  test('row moved DURING the branch write -> CAS miss -> park, content untouched', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const orig = '---\ntitle: T\n---\nOLD BODY';
    const fixedMd = '---\ntitle: T\n---\nNEW FIXED BODY';
    const db = makeDb({
      blog_posts: [{ id: 1, publish_status: 'publishing', astro_pr_number: 5, astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches', category: 'pest-control', tag: 'Rodents', title: 'T', city: 'Sarasota', keyword: 'k', content: 'CURRENT BODY' }],
    });
    const gh = makeGh({ fileContent: orig });
    // The sweep lands in the window between the pre-push check and the sync.
    const origPut = gh.putFile.bind(gh);
    gh.putFile = async (args) => { db._tables.blog_posts[0].publish_status = 'pending_review'; return origPut(args); };
    const r = await maybeRemediateBlogPost({ id: 1 }, { db, gh, callAnthropic: makeCall(fixedMd), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/no longer matches the publishing claim/);
    expect(db._tables.blog_posts[0].content).toBe('CURRENT BODY'); // untouched
    expect(gh._calls.comments).toHaveLength(0); // no re-review request
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

describe('round-10 hardening (Codex findings on 82ec5608)', () => {
  const prev = process.env.AUTONOMOUS_CODEX_REMEDIATION;
  afterEach(() => { process.env.AUTONOMOUS_CODEX_REMEDIATION = prev; });

  // P2: frontmatter-only output with a dropped body must be rejected by the
  // SHARED gate path — downstream gates scan nothing on an empty body.
  test('validateFixedBlogFile rejects an empty remediated body', async () => {
    const r = await rem.validateFixedBlogFile('---\ntitle: T\n---\n');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/empty body/);
  });

  // P2: the park-path disarm uses the same CAS as the content sync — a row
  // swept + republished against a NEW PR mid-remediation is a fresh claim
  // this stale round must not disarm.
  test('park after the row was repointed at a new PR leaves the fresh publishing claim armed', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      codex_remediation_state: [{ pr_number: 5, rounds: MAX_ROUNDS, status: 'remediating' }],
      blog_posts: [{ id: 1, publish_status: 'publishing', astro_pr_number: 5, astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches', category: 'pest-control', tag: 'Rodents', title: 'T', city: 'Sarasota', keyword: 'k' }],
    });
    const gh = makeGh();
    // Simulate the sweep + republish landing AFTER maybeRemediateBlogPost's
    // row re-fetch: the first GitHub call mutates the row to a new PR/branch.
    gh.getPr = async () => {
      db._tables.blog_posts[0].astro_pr_number = 9;
      db._tables.blog_posts[0].astro_branch_name = 'content/blog-x-v2';
      return { state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } };
    };
    const r = await maybeRemediateBlogPost({ id: 1 }, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true); // the round-limit park itself still happens
    const row = db._tables.blog_posts[0];
    expect(row.publish_status).toBe('publishing'); // fresh claim NOT disarmed
    expect(row.astro_publish_error).toBeUndefined(); // no stale error stamped
  });
});

describe('round-11 hardening (Codex findings on 145dcee5)', () => {
  const prev = process.env.AUTONOMOUS_CODEX_REMEDIATION;
  afterEach(() => { process.env.AUTONOMOUS_CODEX_REMEDIATION = prev; });

  // P2: last-instant pre-push guard — a queue/claim move during the LLM round
  // must block the branch write without spending a round or touching state.
  test('prePushCheck false or throwing -> skip, no branch write, no state spent', async () => {
    const gh1 = makeGh();
    const db1 = makeDb();
    const r1 = await runRemediationForPr(
      { ...CTX, prePushCheck: async () => false },
      { db: db1, gh: gh1, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS },
    );
    expect(r1.skipped).toBe(true);
    expect(r1.reason).toMatch(/pre-push check failed/);
    expect(gh1._calls.putFile).toHaveLength(0);
    expect(db1._tables.codex_remediation_state || []).toHaveLength(0); // no round spent

    const gh2 = makeGh();
    const r2 = await runRemediationForPr(
      { ...CTX, prePushCheck: async () => { throw new Error('queue lookup failed'); } },
      { db: makeDb(), gh: gh2, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS },
    );
    expect(r2.skipped).toBe(true);
    expect(gh2._calls.putFile).toHaveLength(0);
  });

  test('autonomous lane passes deps.prePushCheck through to the push guard', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    gh.getPr = async () => pr;
    let checked = false;
    const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
      db: makeDb(), gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
      validateAutonomousRunGates: async () => ({ ok: true }),
      prePushCheck: async () => { checked = true; return false; },
    });
    expect(checked).toBe(true);
    expect(r.skipped).toBe(true);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  // P2: a fix that introduces an un-interpolated {{token}} into an .mdx body
  // would strand the PR on a failed MDX preview build — park instead.
  test('.mdx fix introducing a {{token}} -> park; .md is not token-guarded', async () => {
    const db = makeDb();
    const ghMdx = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const r1 = await runRemediationForPr(CTX, { db, gh: ghMdx, callAnthropic: makeCall('Call {{cityPhone}} today.'), validateFixedBlogFile: PASS });
    expect(r1.parked).toBe(true);
    expect(r1.reason).toMatch(/MDX-breaking token/);
    expect(r1.reason).toMatch(/cityPhone/);
    expect(ghMdx._calls.putFile).toHaveLength(0);

    // Same content on a .md target commits fine ({{tokens}} are legit there).
    const ghMd = makeGh();
    const r2 = await runRemediationForPr(CTX, { db: makeDb(), gh: ghMd, callAnthropic: makeCall('Call {{cityPhone}} today.'), validateFixedBlogFile: PASS });
    expect(r2.remediated).toBe(true);
  });
});

describe('validateAutonomousRunGates', () => {
  const MD = '---\ntitle: T\n---\nFixed body text';
  const RUN = {
    id: 'run-1',
    action_type: 'new_supporting_blog',
    opportunity_id: 'opp-1',
    draft_payload: JSON.stringify({ body: 'original body', url: 'https://hub/blog/x/', title: 'T' }),
  };
  // Callers pass whatever their poll SELECT included — the validator must
  // re-fetch the full row, so tests pass a bare {id} ref and stub the table.
  const RUN_REF = { id: 'run-1' };
  const goodDeps = (runRow = RUN) => ({
    db: makeDb({
      opportunity_queue: [{ id: 'opp-1', bucket: 'standard', service: 'pest' }],
      autonomous_runs: [runRow],
    }),
    autonomousRunner: {
      _loadReviewedBrief: async () => ({ page_type: 'supporting-blog', action_type: 'new_supporting_blog' }),
      _loadBlogCorpus: async () => [],
      _deriveGuardrailOptions: async () => ({ service: 'pest', domains: null, primaryKeyword: null }),
    },
    contentGuardrails: { evaluate: () => ({ pass: true, findings: [] }) },
    comparisonTableGate: { evaluate: () => ({ pass: true, findings: [], requiresHumanReview: false }) },
    uniquenessGate: { evaluateBlog: () => ({ ok: true }) },
    qualityGate: { evaluate: () => ({ ok: true }) },
    seoCompletionGate: { evaluate: () => ({ passed: true, findings: [], summary: { p0: 0, p1: 0 } }) },
    aiVisibilityGate: { evaluateStatic: () => ({ passed: true }) },
  });

  test('all gates pass -> ok', async () => {
    expect((await rem.validateAutonomousRunGates(MD, RUN_REF, goodDeps())).ok).toBe(true);
  });

  test('fail closed: missing run / row not in db / non-blog action / empty stored draft / missing brief', async () => {
    expect((await rem.validateAutonomousRunGates(MD, null, goodDeps())).ok).toBe(false);
    expect((await rem.validateAutonomousRunGates(MD, { id: 'ghost' }, goodDeps())).reason).toMatch(/not found/);
    expect((await rem.validateAutonomousRunGates(MD, RUN_REF, goodDeps({ ...RUN, action_type: 'refresh_existing_page' }))).ok).toBe(false);
    expect((await rem.validateAutonomousRunGates(MD, RUN_REF, goodDeps({ ...RUN, draft_payload: '{}' }))).ok).toBe(false);
    const noBrief = goodDeps(); noBrief.autonomousRunner._loadReviewedBrief = async () => null;
    expect((await rem.validateAutonomousRunGates(MD, RUN_REF, noBrief)).ok).toBe(false);
  });

  test('each failing gate fails the re-run with a named reason', async () => {
    const d1 = goodDeps(); d1.uniquenessGate.evaluateBlog = () => ({ ok: false, error: 'near-duplicate of published post' });
    expect((await rem.validateAutonomousRunGates(MD, RUN_REF, d1)).reason).toMatch(/uniqueness/);
    const d2 = goodDeps(); d2.qualityGate.evaluate = () => ({ ok: false, failures: ['cta_above_fold'] });
    expect((await rem.validateAutonomousRunGates(MD, RUN_REF, d2)).reason).toMatch(/quality/);
    const d3 = goodDeps(); d3.seoCompletionGate.evaluate = () => ({ passed: false, findings: [{ severity: 'P0', code: 'P0_MISSING_BODY' }] });
    expect((await rem.validateAutonomousRunGates(MD, RUN_REF, d3)).reason).toMatch(/seo-completion/);
    const d4 = goodDeps(); d4.aiVisibilityGate.evaluateStatic = () => ({ passed: false, findings: [{ code: 'P0_NOINDEX' }] });
    expect((await rem.validateAutonomousRunGates(MD, RUN_REF, d4)).reason).toMatch(/visibility/);
    const d5 = goodDeps(); d5.autonomousRunner._loadBlogCorpus = async () => { throw new Error('corpus unavailable'); };
    expect((await rem.validateAutonomousRunGates(MD, RUN_REF, d5)).reason).toMatch(/corpus unavailable/);
  });

  test('a skipped SEO verdict on a supporting blog is a failure, not a pass', async () => {
    const d = goodDeps(); d.seoCompletionGate.evaluate = () => ({ passed: true, skipped: 'not_supporting_blog' });
    expect((await rem.validateAutonomousRunGates(MD, RUN_REF, d)).ok).toBe(false);
  });

  test('gates evaluate the FIXED body swapped into the stored draft', async () => {
    const deps = goodDeps();
    const seen = {};
    deps.uniquenessGate.evaluateBlog = (draft) => { seen.uniq = draft.body; return { ok: true }; };
    deps.aiVisibilityGate.evaluateStatic = ({ url, html }) => { seen.url = url; seen.html = html; return { passed: true }; };
    expect((await rem.validateAutonomousRunGates(MD, RUN_REF, deps)).ok).toBe(true);
    expect(seen.uniq).toBe('Fixed body text');
    expect(seen.html).toBe('Fixed body text');
    expect(seen.url).toBe('https://hub/blog/x/');
  });

  // r7: content-policy gates re-run with the RUN's context, not just the four
  // quality gates — brief-derived FAQ-blocked topics and operatorBriefText.
  test('run-context guardrails failure -> fail with codes; guard options come from the runner derivation', async () => {
    const deps = goodDeps();
    let optionsSeen = null;
    deps.autonomousRunner._deriveGuardrailOptions = async () => ({ service: ['pest', 'Rodents'], domains: null });
    deps.contentGuardrails.evaluate = (draft, options) => { optionsSeen = options; return { pass: false, findings: [{ severity: 'P0', code: 'FAQ_BLOCKED_SERVICE' }] }; };
    const r = await rem.validateAutonomousRunGates(MD, RUN_REF, deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/run-context guardrails/);
    expect(r.reason).toMatch(/FAQ_BLOCKED_SERVICE/);
    expect(optionsSeen.service).toEqual(['pest', 'Rodents']);
  });

  test('run-context comparison requiresHumanReview -> fail (named-competitor sign-off)', async () => {
    const deps = goodDeps();
    deps.comparisonTableGate.evaluate = () => ({ pass: true, findings: [], requiresHumanReview: true });
    const r = await rem.validateAutonomousRunGates(MD, RUN_REF, deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/named-competitor/);
  });

  test('missing opportunity row -> fail closed (no guardrail context)', async () => {
    const deps = goodDeps();
    deps.db = makeDb({ opportunity_queue: [], autonomous_runs: [RUN] });
    const r = await rem.validateAutonomousRunGates(MD, RUN_REF, deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/opportunity row unavailable/);
  });

  // r8: claims-ledger gate re-runs on the rewritten body for facts-gated runs.
  describe('facts-gated claims-ledger re-validation', () => {
    const FACTS_RUN = {
      ...RUN,
      facts_sufficiency: JSON.stringify({ applicable: true, sufficient: true, city_id: 'sarasota', service_id: 'pest', county: 'Sarasota' }),
    };

    test('validator failure -> fail with P0/P1 codes; inputs mirror the runner call', async () => {
      const deps = goodDeps(FACTS_RUN);
      let seen = null;
      deps.claimsLedgerValidator = {
        validate: async (draft, ctx, opts) => {
          seen = { body: draft.body, ctx, opts };
          return { pass: false, findings: [{ severity: 'P0', code: 'CLAIM_UNSUPPORTED_BY_FACT' }] };
        },
      };
      const r = await rem.validateAutonomousRunGates(MD, RUN_REF, deps);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/claims-ledger/);
      expect(r.reason).toMatch(/CLAIM_UNSUPPORTED_BY_FACT/);
      expect(seen.body).toBe('Fixed body text'); // the REWRITTEN body, not the stored one
      expect(seen.ctx).toEqual({ city: 'sarasota', service: 'pest', county: 'Sarasota' });
      expect(seen.opts).toEqual({ options: { missingLedgerSeverity: 'P1' } });
    });

    test('validator pass -> continues to the remaining gates (ok)', async () => {
      const deps = goodDeps(FACTS_RUN);
      deps.claimsLedgerValidator = { validate: async () => ({ pass: true, findings: [] }) };
      expect((await rem.validateAutonomousRunGates(MD, RUN_REF, deps)).ok).toBe(true);
    });

    test('validator throwing or unavailable -> fail closed', async () => {
      const d1 = goodDeps(FACTS_RUN);
      d1.claimsLedgerValidator = { validate: async () => { throw new Error('facts db down'); } };
      expect((await rem.validateAutonomousRunGates(MD, RUN_REF, d1)).reason).toMatch(/facts db down/);
      const d2 = goodDeps(FACTS_RUN);
      d2.claimsLedgerValidator = {}; // no validate fn
      expect((await rem.validateAutonomousRunGates(MD, RUN_REF, d2)).reason).toMatch(/validator unavailable/);
    });

    test('non-facts-gated run skips the gate (no validator needed)', async () => {
      const deps = goodDeps(); // RUN has no facts_sufficiency; no validator injected
      expect((await rem.validateAutonomousRunGates(MD, RUN_REF, deps)).ok).toBe(true);
    });

    // r9 P1: pollPending's SELECT omits facts_sufficiency — the validator must
    // re-fetch the full row so a partial poller row can't un-gate the check.
    test('partial poller row (facts_sufficiency not selected) still triggers the gate', async () => {
      const deps = goodDeps(FACTS_RUN);
      let invoked = false;
      deps.claimsLedgerValidator = { validate: async () => { invoked = true; return { pass: true, findings: [] }; } };
      const partialPollerRow = { id: 'run-1', action_type: 'new_supporting_blog', draft_payload: FACTS_RUN.draft_payload };
      const r = await rem.validateAutonomousRunGates(MD, partialPollerRow, deps);
      expect(r.ok).toBe(true);
      expect(invoked).toBe(true);
    });
  });

  // r7: the SEO P1 canary limit applies to remediated bodies too — the gate
  // can pass with P1s (dropped CTA / service link) the runner would refuse.
  test('AUTONOMOUS_CONTENT_MAX_P1_FINDINGS caps P1s on the rewritten body', async () => {
    const prevMax = process.env.AUTONOMOUS_CONTENT_MAX_P1_FINDINGS;
    process.env.AUTONOMOUS_CONTENT_MAX_P1_FINDINGS = '0';
    try {
      const deps = goodDeps();
      deps.seoCompletionGate.evaluate = () => ({ passed: true, findings: [{ severity: 'P1', code: 'P1_MISSING_CONVERSION_CTA' }], summary: { p0: 0, p1: 1 } });
      const r = await rem.validateAutonomousRunGates(MD, RUN_REF, deps);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/seo canary/);
      // and with the limit unset it passes (gate itself passed)
      delete process.env.AUTONOMOUS_CONTENT_MAX_P1_FINDINGS;
      expect((await rem.validateAutonomousRunGates(MD, RUN_REF, deps)).ok).toBe(true);
    } finally {
      if (prevMax === undefined) delete process.env.AUTONOMOUS_CONTENT_MAX_P1_FINDINGS;
      else process.env.AUTONOMOUS_CONTENT_MAX_P1_FINDINGS = prevMax;
    }
  });
});

describe('schema-shape consistency (r7)', () => {
  const FAQ_BODY = 'Intro paragraph.\n\n## Frequently Asked Questions\n\n### Do roaches bite people?\n\nRarely.\n';
  const PLAIN_BODY = 'Intro paragraph, no FAQ section here.\n';

  test('schemaShapeChanged: FAQ section removed or added -> true; body edit without schema impact -> false', () => {
    const withFaq = `---\ntitle: T\n---\n${FAQ_BODY}`;
    const noFaq = `---\ntitle: T\n---\n${PLAIN_BODY}`;
    expect(rem.schemaShapeChanged(withFaq, noFaq)).toBe(true);
    expect(rem.schemaShapeChanged(noFaq, withFaq)).toBe(true);
    expect(rem.schemaShapeChanged(withFaq, withFaq.replace('Rarely.', 'Almost never.'))).toBe(false);
    expect(rem.schemaShapeChanged(noFaq, noFaq.replace('Intro', 'Opening'))).toBe(false);
  });

  test('fix that changes the derived schema set -> park (frontmatter schema is frozen)', async () => {
    const gh = makeGh({ fileContent: `---\ntitle: T\n---\n${FAQ_BODY}` });
    const r = await runRemediationForPr(CTX, {
      db: makeDb(), gh, callAnthropic: makeCall(`---\ntitle: T\n---\n${PLAIN_BODY}`), validateFixedBlogFile: PASS,
    });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/schema types/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('schema derivation unavailable -> fails closed (treated as changed)', () => {
    expect(rem.schemaShapeChanged('---\nt: 1\n---\nbody', '---\nt: 1\n---\nbody2', { schemaTypesForContent: null })).toBe(false);
    // explicit injectable that throws → changed
    expect(rem.schemaShapeChanged('a', 'b', { schemaTypesForContent: () => { throw new Error('boom'); } })).toBe(true);
  });
});

describe('deterministic date-restamp carve-out', () => {
  const fmLib = require('../services/content-astro/frontmatter');
  const { etDateString } = require('../utils/datetime-et');
  const { isDateStampFinding, restampFrontmatterDates } = rem;
  const TODAY = etDateString();
  const DATED_MD = [
    '---',
    'title: Roaches',
    "published: '1970-01-01'",
    "updated: '1970-01-01'",
    "technically_reviewed: '1970-01-01'",
    "fact_checked: '1970-01-01'",
    '---',
    '',
    'BODY TEXT',
    '',
  ].join('\n');
  const dateFinding = (body) => finding({ path: 'src/content/blog/pest-control/roaches.mdx', body });
  const NEW_PUBLISH_CTX = { ...CTX, restampPublished: true };

  test('isDateStampFinding classifies date-stamp findings, not body findings', () => {
    expect(isDateStampFinding({ body: 'Use a non-future publish date. These dates are set to July 7.' })).toBe(true);
    expect(isDateStampFinding({ body: 'Use current dates before publishing' })).toBe(true);
    expect(isDateStampFinding({ body: 'Replace the placeholder 1970-01-01 dates in the frontmatter' })).toBe(true);
    expect(isDateStampFinding({ body: 'Fix the broken link.' })).toBe(false);
    expect(isDateStampFinding({ body: 'The updated copy overstates the guarantee.' })).toBe(false);
    expect(isDateStampFinding({})).toBe(false);
  });

  test('restampFrontmatterDates restamps all four date fields to today ET on a new publish, preserving everything else', () => {
    const r = restampFrontmatterDates(DATED_MD, { includePublished: true });
    expect(r.changed).toBe(true);
    const parsed = fmLib.parse(r.markdown);
    for (const k of ['published', 'updated', 'technically_reviewed', 'fact_checked']) expect(parsed.data[k]).toBe(TODAY);
    expect(parsed.data.title).toBe('Roaches');
    expect(parsed.content).toContain('BODY TEXT');
  });

  test('restampFrontmatterDates leaves `published` alone by default (refresh lanes must not rewrite publication dates)', () => {
    const r = restampFrontmatterDates(DATED_MD);
    expect(r.changed).toBe(true);
    const parsed = fmLib.parse(r.markdown);
    expect(parsed.data.published).toBe('1970-01-01');
    for (const k of ['updated', 'technically_reviewed', 'fact_checked']) expect(parsed.data[k]).toBe(TODAY);
  });

  test('restampFrontmatterDates is a no-op on current dates and on files without frontmatter', () => {
    expect(restampFrontmatterDates(DATED_MD.replace(/1970-01-01/g, TODAY), { includePublished: true }).changed).toBe(false);
    expect(restampFrontmatterDates('plain body, no frontmatter').changed).toBe(false);
  });

  test('a datetime `modified` field restamps to noon today ET', () => {
    const md = `---\ntitle: X\nmodified: '2026-01-01T12:00:00'\n---\nBODY`;
    const r = restampFrontmatterDates(md);
    expect(r.changed).toBe(true);
    expect(fmLib.parse(r.markdown).data.modified).toBe(`${TODAY}T12:00:00`);
  });

  test('pure date findings → deterministic restamp commit with NO LLM call', async () => {
    const db = makeDb();
    let llmCalled = false;
    const gh = makeGh({ fileContent: DATED_MD, reviewComments: [dateFinding('Use a non-future publish date. These dates are wrong.')] });
    const r = await runRemediationForPr(NEW_PUBLISH_CTX, {
      db, gh,
      callAnthropic: async () => { llmCalled = true; return { ok: true, text: 'SHOULD NOT RUN' }; },
      validateFixedBlogFile: PASS,
    });
    expect(r.remediated).toBe(true);
    expect(llmCalled).toBe(false);
    const committed = fmLib.parse(gh._calls.putFile[0].content);
    expect(committed.data.published).toBe(TODAY);
    expect(committed.data.fact_checked).toBe(TODAY);
    expect(committed.content).toContain('BODY TEXT');
    expect(gh._calls.comments[0].body).toMatch(/@codex review/);
  });

  test('without the new-publish assertion the restamp never touches `published`', async () => {
    const gh = makeGh({ fileContent: DATED_MD, reviewComments: [dateFinding('Use current dates before publishing.')] });
    const r = await runRemediationForPr(CTX, {
      db: makeDb(), gh,
      callAnthropic: async () => { throw new Error('LLM must not run on a pure-date round'); },
      validateFixedBlogFile: PASS,
    });
    expect(r.remediated).toBe(true);
    const committed = fmLib.parse(gh._calls.putFile[0].content);
    expect(committed.data.published).toBe('1970-01-01');
    expect(committed.data.updated).toBe(TODAY);
    expect(committed.data.fact_checked).toBe(TODAY);
  });

  test('mixed findings → dates restamped in code, only body findings sent to the LLM', async () => {
    const db = makeDb();
    const prompts = [];
    const baseline = restampFrontmatterDates(DATED_MD, { includePublished: true }).markdown;
    const gh = makeGh({
      fileContent: DATED_MD,
      reviewComments: [dateFinding('Use current dates before publishing.'), dateFinding('Fix the broken link.')],
    });
    const call = async ({ text }) => { prompts.push(text); return { ok: true, text: baseline.replace('BODY TEXT', 'FIXED BODY') }; };
    const r = await runRemediationForPr(NEW_PUBLISH_CTX, { db, gh, callAnthropic: call, validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Fix the broken link.');
    expect(prompts[0]).not.toContain('Use current dates');
    const committed = fmLib.parse(gh._calls.putFile[0].content);
    expect(committed.data.published).toBe(TODAY);
    expect(committed.content).toContain('FIXED BODY');
  });

  test('an LLM frontmatter change beyond the restamp still parks (body-only contract intact)', async () => {
    const baseline = restampFrontmatterDates(DATED_MD).markdown;
    const p = fmLib.parse(baseline);
    const evil = fmLib.stringify({ ...p.data, title: 'Hacked' }, p.content.replace('BODY TEXT', 'FIXED BODY'));
    const gh = makeGh({
      fileContent: DATED_MD,
      reviewComments: [dateFinding('Use current dates before publishing.'), dateFinding('Fix the broken link.')],
    });
    const r = await runRemediationForPr(CTX, { db: makeDb(), gh, callAnthropic: makeCall(evil), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/frontmatter/);
  });

  test('date findings with already-current dates fall through to the LLM false-positive park path', async () => {
    const current = DATED_MD.replace(/1970-01-01/g, TODAY);
    const gh = makeGh({ fileContent: current, reviewComments: [dateFinding('Use current dates before publishing.')] });
    const r = await runRemediationForPr(CTX, { db: makeDb(), gh, callAnthropic: makeCall(current), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/no change/);
  });

  test('scheduler lane syncs restamped dates into the blog_posts row alongside the body', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    try {
      const db = makeDb({
        blog_posts: [{
          id: 1, publish_status: 'publishing', astro_pr_number: 5,
          astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches',
          category: 'pest-control', tag: 'Roaches', title: 'T', city: 'Sarasota', keyword: 'k',
          publish_date: '1970-01-01', technically_reviewed_at: '1970-01-01', fact_checked_at: '1970-01-01',
        }],
      });
      const gh = makeGh({
        fileContent: DATED_MD,
        reviewComments: [finding({ body: 'Use current dates before publishing.' })],
      });
      const r = await rem.maybeRemediateBlogPost({ id: 1 }, {
        db, gh,
        callAnthropic: async () => { throw new Error('LLM must not run on a pure-date round'); },
        validateFixedBlogFile: PASS,
      });
      expect(r.remediated).toBe(true);
      const row = db._tables.blog_posts[0];
      expect(row.publish_date).toBe(TODAY);
      expect(row.technically_reviewed_at).toBe(TODAY);
      expect(row.fact_checked_at).toBe(TODAY);
      expect(row.content).toContain('BODY TEXT');
    } finally {
      delete process.env.AUTONOMOUS_CODEX_REMEDIATION;
    }
  });
});
