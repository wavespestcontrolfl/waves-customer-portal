const rem = require('../services/content/codex-remediation');

const {
  parseCodexFindings,
  pickTargetPath,
  buildReviewRequestBody,
  stripCodeFence,
  atRoundLimit,
  runRemediationRound,
  maybeRemediate,
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

// Minimal chainable knex stub sharing one row + recording updates.
function makeDb(row) {
  const state = { row: row ? { ...row } : null, updates: [] };
  function db() {
    return {
      where() { return this; },
      async first() { return state.row ? { ...state.row } : null; },
      async update(patch) { state.updates.push(patch); if (state.row) Object.assign(state.row, patch); return 1; },
    };
  }
  db._state = state;
  return db;
}

function makeGh(over = {}) {
  const calls = { putFile: [], comments: [] };
  const gh = {
    async getPr() { return { state: 'open', head: { sha: HEAD } }; },
    async listPrReviewComments() { return over.reviewComments || [finding()]; },
    async getFile() { return { content: over.fileContent ?? 'ORIGINAL BODY', sha: 'file-sha-1' }; },
    async putFile(args) { calls.putFile.push(args); return { commit: { sha: 'newcommit999aaa' } }; },
    async getBranchSha() { return 'newcommit999aaa'; },
    async createIssueComment(n, body) { calls.comments.push({ n, body }); return {}; },
  };
  Object.assign(gh, over.gh || {});
  gh._calls = calls;
  return gh;
}

function makeCall(text) {
  return async () => ({ ok: true, text });
}

const basePost = {
  id: 1, slug: 'pest-control/roaches', astro_pr_number: 5, astro_branch_name: 'content/blog-roaches-x1',
  codex_remediation_rounds: 0, codex_remediation_status: 'none',
};

describe('parseCodexFindings', () => {
  test('keeps Codex findings on the current head with path/line/body', () => {
    const out = parseCodexFindings([finding()], HEAD);
    expect(out).toEqual([{ path: 'src/content/blog/pest-control/roaches.md', line: 42, body: 'Fix the broken link.' }]);
  });
  test('drops non-Codex authors', () => {
    expect(parseCodexFindings([finding({ user: { login: 'some-human' } })], HEAD)).toEqual([]);
  });
  test('drops findings tied to a different commit', () => {
    expect(parseCodexFindings([finding({ commit_id: 'zzz9999' })], HEAD)).toEqual([]);
  });
  test('drops a finding with no commit id when the head is known', () => {
    expect(parseCodexFindings([finding({ commit_id: null, original_commit_id: null })], HEAD)).toEqual([]);
  });
  test('keeps findings when no head is provided', () => {
    expect(parseCodexFindings([finding({ commit_id: null })], null)).toHaveLength(1);
  });
  test('matches on original_commit_id', () => {
    expect(parseCodexFindings([finding({ commit_id: 'other999', original_commit_id: HEAD })], HEAD)).toHaveLength(1);
  });
  test('drops empty-body comments', () => {
    expect(parseCodexFindings([finding({ body: '  ' })], HEAD)).toEqual([]);
  });
});

describe('pickTargetPath', () => {
  test('prefers a blog .md finding path', () => {
    expect(pickTargetPath([{ path: 'astro.config.mjs' }, { path: 'src/content/blog/x/y.md' }], {}))
      .toBe('src/content/blog/x/y.md');
  });
  test('falls back to the slug-derived path', () => {
    expect(pickTargetPath([{ path: null }], { slug: '/pest-control/roaches/' }))
      .toBe('src/content/blog/pest-control/roaches.md');
  });
});

describe('helpers', () => {
  test('buildReviewRequestBody embeds the new head + @codex review', () => {
    const b = buildReviewRequestBody('deadbeef');
    expect(b).toMatch(/@codex review/);
    expect(b).toContain('deadbeef');
  });
  test('stripCodeFence removes a ```markdown fence', () => {
    expect(stripCodeFence('```markdown\nhello\n```')).toBe('hello\n');
  });
  test('atRoundLimit respects MAX_ROUNDS', () => {
    expect(atRoundLimit(MAX_ROUNDS)).toBe(true);
    expect(atRoundLimit(MAX_ROUNDS - 1)).toBe(false);
  });
});

describe('runRemediationRound', () => {
  test('findings under limit → pushes a fix, re-requests review, bumps round', async () => {
    const db = makeDb({ ...basePost });
    const gh = makeGh();
    const r = await runRemediationRound({ id: 1 }, { db, gh, callAnthropic: makeCall('FIXED BODY') });
    expect(r.remediated).toBe(true);
    expect(r.round).toBe(1);
    expect(gh._calls.putFile).toHaveLength(1);
    expect(gh._calls.putFile[0].path).toBe('src/content/blog/pest-control/roaches.md');
    expect(gh._calls.putFile[0].branch).toBe('content/blog-roaches-x1');
    expect(gh._calls.comments[0].body).toMatch(/@codex review/);
    expect(gh._calls.comments[0].body).toContain('newcommit999aaa');
    const upd = db._state.updates.at(-1);
    expect(upd.codex_remediation_rounds).toBe(1);
    expect(upd.codex_remediation_status).toBe('remediating');
  });

  test('no fresh findings → waits (skip), no round burned, no park', async () => {
    const db = makeDb({ ...basePost });
    const gh = makeGh({ reviewComments: [] });
    const r = await runRemediationRound({ id: 1 }, { db, gh, callAnthropic: makeCall('X') });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/awaiting/);
    expect(gh._calls.putFile).toHaveLength(0);
    expect(db._state.updates).toHaveLength(0);
  });

  test('fresh findings at the round limit → park', async () => {
    const db = makeDb({ ...basePost, codex_remediation_rounds: MAX_ROUNDS });
    const gh = makeGh();
    const r = await runRemediationRound({ id: 1 }, { db, gh, callAnthropic: makeCall('FIXED') });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/exhausted/);
    expect(gh._calls.putFile).toHaveLength(0);
    expect(db._state.row.codex_remediation_status).toBe('parked');
  });

  test('fix produces no change → park (false-positive findings)', async () => {
    const db = makeDb({ ...basePost });
    const gh = makeGh({ fileContent: 'ORIGINAL BODY' });
    const r = await runRemediationRound({ id: 1 }, { db, gh, callAnthropic: makeCall('ORIGINAL BODY') });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/no change/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('already parked → skip', async () => {
    const db = makeDb({ ...basePost, codex_remediation_status: 'parked' });
    const gh = makeGh();
    const r = await runRemediationRound({ id: 1 }, { db, gh, callAnthropic: makeCall('FIXED') });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('parked');
  });

  test('closed PR → skip', async () => {
    const db = makeDb({ ...basePost });
    const gh = makeGh({ gh: { getPr: async () => ({ state: 'closed' }) } });
    const r = await runRemediationRound({ id: 1 }, { db, gh, callAnthropic: makeCall('FIXED') });
    expect(r.skipped).toBe(true);
  });
});

describe('maybeRemediate flag gate', () => {
  const prev = process.env.AUTONOMOUS_CODEX_REMEDIATION;
  afterEach(() => { process.env.AUTONOMOUS_CODEX_REMEDIATION = prev; });

  test('disabled → skip without touching GitHub', async () => {
    delete process.env.AUTONOMOUS_CODEX_REMEDIATION;
    const db = makeDb({ ...basePost });
    const gh = makeGh();
    const r = await maybeRemediate({ id: 1 }, { db, gh, callAnthropic: makeCall('FIXED') });
    expect(r).toEqual({ skipped: true, reason: 'disabled' });
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('enabled → runs a round', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({ ...basePost });
    const gh = makeGh();
    const r = await maybeRemediate({ id: 1 }, { db, gh, callAnthropic: makeCall('FIXED BODY') });
    expect(r.remediated).toBe(true);
  });
});
