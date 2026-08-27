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

// A SUBMITTED Codex review object (GET /pulls/{n}/reviews shape) pinned to
// the head — round-completion evidence for the P2-only merge bar.
function codexReview(over = {}) {
  return {
    user: { login: CODEX },
    state: 'COMMENTED',
    commit_id: HEAD,
    submitted_at: '2026-07-17T02:10:00Z',
    body: '',
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
    let notIn = null;
    let olderThanMs = null;
    return {
      where(c) { crit = c; return this; },
      whereNotIn(col, vals) { notIn = { col, vals }; return this; },
      // Emulates `updated_at < NOW() - (? * interval '1 millisecond')` — the
      // staleness predicate the sentinel release asserts atomically in SQL
      // (comparing a round-tripped timestamp cannot work: NOW() is microsecond
      // precision, the pg driver truncates to ms).
      whereRaw(sql, params = []) {
        if (/updated_at < NOW\(\)/.test(sql)) olderThanMs = params[0];
        return this;
      },
      async first() { const r = tables[table].find((x) => match(x, crit)); return r ? { ...r } : null; },
      async update(patch) {
        const rows = tables[table].filter((x) => match(x, crit)
          && (!notIn || !notIn.vals.includes(x[notIn.col]))
          && (olderThanMs === null
            || (Date.now() - (x.updated_at ? new Date(x.updated_at).getTime() : 0)) > olderThanMs));
        rows.forEach((r) => Object.assign(r, patch));
        return rows.length;
      },
      insert(row) {
        const exec = (ignoreConflict) => {
          const dup = row.pr_number !== undefined
            && tables[table].some((x) => x.pr_number === row.pr_number);
          if (dup) {
            if (ignoreConflict) return [0];
            throw new Error('duplicate key value violates unique constraint');
          }
          tables[table].push({ ...row });
          return [1];
        };
        return {
          onConflict: () => ({ ignore: async () => exec(true) }),
          then: (res, rej) => Promise.resolve().then(() => exec(false)).then(res, rej),
        };
      },
    };
  }
  // Emulates the two raw statements these tests reach.
  db.raw = async (sql, params) => {
    // armPushHold: insert-or-arm; a GENUINE unsynced hold is kept, while a
    // hold that already equals synced_sha (completed, release lost) is replaced by
    // the fresh sentinel; terminal rows untouched.
    if (/sync_pending_sha = CASE/.test(sql)) {
      const [n, branch, sentinel] = params;
      tables.codex_remediation_state = tables.codex_remediation_state || [];
      const t = tables.codex_remediation_state;
      const row = t.find((x) => x.pr_number === n);
      if (!row) {
        t.push({
          pr_number: n, branch, status: 'remediating', rounds: 0,
          sync_pending_sha: sentinel, updated_at: new Date(),
        });
        return { rowCount: 1 };
      }
      if (row.status === 'merged' || row.status === 'closed') return { rowCount: 0 };
      row.branch = branch;
      row.status = 'remediating';
      const genuineHold = row.sync_pending_sha != null
        && row.sync_pending_sha !== (row.synced_sha ?? null);
      row.sync_pending_sha = genuineHold ? row.sync_pending_sha : sentinel;
      row.updated_at = new Date();
      return { rowCount: 1 };
    }
    const [n, status] = params;
    tables.codex_remediation_state = tables.codex_remediation_state || [];
    const t = tables.codex_remediation_state;
    const row = t.find((x) => x.pr_number === n);
    if (!row) {
      t.push({ pr_number: n, status, rounds: 0 });
      return { rowCount: 1 };
    }
    // merged permanent; closed only upgradeable to merged
    if (row.status === 'merged') return { rowCount: 0 };
    if (row.status === 'closed' && status !== 'merged') return { rowCount: 0 };
    row.status = status;
    return { rowCount: 1 };
  };
  db._tables = tables;
  return db;
}

function makeGh(over = {}) {
  const calls = { putFile: [], comments: [] };
  const gh = {
    // Post-push revalidation compares the live PR head to the pushed commit —
    // after a putFile the fake PR's head is the pushed sha, like GitHub's.
    async getPr() {
      return {
        state: 'open',
        head: { sha: calls.putFile.length ? 'newcommit999aaa' : HEAD, ref: 'content/blog-x' },
      };
    },
    async listPrReviewComments() { return over.reviewComments || [finding()]; },
    async listIssueComments() { return over.issueComments || []; },
    async listPrReviews() { return over.reviews || []; },
    async getFile() { return { content: over.fileContent ?? 'ORIGINAL BODY', sha: 'file-sha-1' }; },
    async putFile(args) { calls.putFile.push(args); return { commit: { sha: 'newcommit999aaa' } }; },
    // Post-push flows read the pushed commit; tests on the PINNED lanes
    // pass over.preHead so the r17 pre-push parent recheck sees the pinned
    // parent before the push.
    async getBranchSha() { return calls.putFile.length ? 'newcommit999aaa' : (over.preHead || 'newcommit999aaa'); },
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
    expect(parseCodexFindings([finding()], HEAD)).toEqual([{ path: 'src/content/blog/pest-control/roaches.md', line: 42, body: 'Fix the broken link.', created_at: null }]);
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
    // Pushed-round proof for the P2-only merge bar (round 9): only the
    // success path records the pushed commit SHA.
    expect(st.last_push_sha).toBe('newcommit999aaa');
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

  test('same-head park with a non-"moved past" reason → stays parked (human hold)', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'parked', parked_head_sha: HEAD, park_reason: `portal row sync failed after fix commit ${HEAD.slice(0, 7)}: boom` }] });
    const gh = makeGh();
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true); expect(r.reason).toBe('parked');
    expect(gh._calls.putFile).toHaveLength(0);
    expect(db._tables.codex_remediation_state[0].status).toBe('parked');
  });

  test('same-head "moved past" park + ref agrees → contradiction re-arm and run the round (PR #383 wedge)', async () => {
    // The park claimed another push superseded ours, but the live head IS the
    // push we parked against AND the branch ref confirms it — the claim was a
    // stale read. Must re-arm, not sit parked forever.
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 0, status: 'parked', parked_head_sha: HEAD, park_reason: 'pr head moved past the remediation push (abc1234 → 9999999); sync withheld' }] });
    const gh = makeGh({ reviewComments: [], issueComments: [], gh: { getBranchSha: async () => HEAD } });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    // Re-armed with no findings for this head → posts the review request the
    // withheld round never sent.
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/requested codex review/);
    expect(gh._calls.comments).toHaveLength(1);
    expect(gh._calls.comments[0].body).toContain(HEAD);
    const row = db._tables.codex_remediation_state[0];
    expect(row.status).toBe('active');
    expect(row.park_reason).toBeNull();
    expect(row.parked_head_sha).toBeNull();
  });

  test('same-head "moved past" park but ref shows a THIRD sha → stays parked (stale getPr of a real parallel push)', async () => {
    // Park recorded our push B; a real parallel C landed; this tick's getPr
    // stalely reports B. The ref disagreeing with the observed head means the
    // observation is untrustworthy — hold the park; the next tick sees C and
    // the ordinary head-advance re-arm carries it.
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 0, status: 'parked', parked_head_sha: HEAD, park_reason: 'pr head moved past the remediation push (abc1234 → 9999999); sync withheld' }] });
    const gh = makeGh({ reviewComments: [], issueComments: [], gh: { getBranchSha: async () => 'parallel777push' } });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true); expect(r.reason).toBe('parked');
    expect(gh._calls.putFile).toHaveLength(0);
    expect(gh._calls.comments).toHaveLength(0);
    expect(db._tables.codex_remediation_state[0].status).toBe('parked');
  });

  test('same-head "moved past" park + getBranchSha failure → stays parked (fail closed)', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 0, status: 'parked', parked_head_sha: HEAD, park_reason: 'pr head moved past the remediation push (abc1234 → 9999999); sync withheld' }] });
    const gh = makeGh({ reviewComments: [], issueComments: [], gh: { getBranchSha: async () => { throw new Error('gh 500'); } } });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true); expect(r.reason).toBe('parked');
    expect(db._tables.codex_remediation_state[0].status).toBe('parked');
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

  test('stale post-push getPr head + ref confirms our push → round completes (no park)', async () => {
    // The post-push getPr serves the PRE-push head (read-after-write lag
    // behind our own putFile — PR #383); the branch ref says our commit is
    // the head, and the mandatory state re-read has caught up.
    const db = makeDb();
    let getPrCalls = 0;
    const gh = makeGh({ gh: {
      getPr: async () => {
        getPrCalls += 1;
        if (getPrCalls === 2) return { state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } }; // stale post-push read
        return { state: 'open', head: { sha: getPrCalls === 1 ? HEAD : 'newcommit999aaa', ref: 'content/blog-x' } };
      },
    } });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
    expect(gh._calls.comments).toHaveLength(1); // re-review request posted
    expect(db._tables.codex_remediation_state[0].status).toBe('remediating');
    expect(db._tables.codex_remediation_state[0].rounds).toBe(1);
  });

  test('ref confirms our push but the state re-read shows a NEWER head → park stamped with OUR push', async () => {
    // A concurrent push C lands between the ref confirmation and the state
    // re-read: syncing our B would mirror content the merge won't take.
    const db = makeDb();
    let getPrCalls = 0;
    const gh = makeGh({ gh: {
      getPr: async () => {
        getPrCalls += 1;
        if (getPrCalls === 1) return { state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } };
        if (getPrCalls === 2) return { state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } }; // stale post-push read
        return { state: 'open', head: { sha: 'parallel777push', ref: 'content/blog-x' } }; // re-read sees C
      },
    } });
    const onRemediated = jest.fn();
    const r = await runRemediationForPr({ ...CTX, onRemediated }, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/moved past the remediation push/);
    expect(onRemediated).not.toHaveBeenCalled();
    expect(gh._calls.comments).toHaveLength(0);
    expect(db._tables.codex_remediation_state[0].parked_head_sha).toBe('newcommit999aaa');
  });

  test('genuine parallel push (ref shows a third sha) → park stamped with OUR push', async () => {
    const db = makeDb();
    // First getPr (round start) serves the head Codex reviewed; the post-push
    // read sees the parallel push, and so does the authoritative branch ref.
    let getPrCalls = 0;
    const gh = makeGh({ gh: {
      getPr: async () => ({ state: 'open', head: { sha: getPrCalls++ === 0 ? HEAD : 'parallel777push', ref: 'content/blog-x' } }),
      getBranchSha: async () => 'parallel777push',
    } });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/moved past the remediation push/);
    expect(gh._calls.comments).toHaveLength(0); // sync + re-review withheld
    const row = db._tables.codex_remediation_state[0];
    expect(row.status).toBe('parked');
    expect(row.parked_head_sha).toBe('newcommit999aaa'); // our push → head-advance re-arm fires next tick
  });

  test('ref confirms our push but the PR closed behind it → terminal stamp, sync + comment skipped', async () => {
    // The stale snapshot that misreported the head may misreport state too:
    // the post-push getPr says {open, head A} (stale), the ref proves our
    // push B is the tip, and the mandatory state re-read shows the PR closed.
    const db = makeDb();
    let getPrCalls = 0;
    const gh = makeGh({ gh: {
      getPr: async () => {
        getPrCalls += 1;
        if (getPrCalls <= 2) return { state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } };
        return { state: 'closed', head: { sha: 'newcommit999aaa', ref: 'content/blog-x' } };
      },
    } });
    const onRemediated = jest.fn();
    const r = await runRemediationForPr({ ...CTX, onRemediated }, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true);
    expect(r.reason).toContain('post-push check');
    expect(onRemediated).not.toHaveBeenCalled();
    expect(gh._calls.comments).toHaveLength(0);
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === CTX.prNumber).status).toBe('closed');
  });

  test('stale getPr head + getBranchSha failure → park (fail closed; contradiction re-arm recovers)', async () => {
    const db = makeDb();
    const gh = makeGh({ gh: {
      getPr: async () => ({ state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } }),
      getBranchSha: async () => { throw new Error('gh 500'); },
    } });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/moved past the remediation push/);
    expect(db._tables.codex_remediation_state[0].parked_head_sha).toBe('newcommit999aaa');
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
    // onRemediated re-pins draft_payload.autopublish_head_sha (r12) — the
    // run row must exist for the post-push stamp.
    const db = makeDb({ autonomous_runs: [{ id: 'run-1', action_type: 'new_supporting_blog', draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678' }) }] });
    const gh = makeGh({ preHead: 'abc1234def5678', reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    const run = { id: 'run-1', action_type: 'new_supporting_blog' };
    // getPr returns the same open PR
    gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
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
    const db = makeDb({ autonomous_runs: [{ id: 'run-1', action_type: 'new_supporting_blog', draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678' }) }] });
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
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
    const db = makeDb({ autonomous_runs: [{ id: 'run-1', reviewer_notes: 'prior note', draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678' }) }] });
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
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
    gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
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

  test('frontmatterFixViolation detects slug/canonical/domains edits', () => {
    const orig = '---\nslug: /a/\ncanonical: https://x/a/\ndomains:\n  - hub\n---\nbody';
    expect(rem.frontmatterFixViolation(orig, orig).violation).toBeNull();
    expect(rem.frontmatterFixViolation(orig, orig.replace('/a/', '/b/')).violation).toMatch(/"slug"/);
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
    // The failed attempt spends a round but must NOT record a pushed
    // remediation SHA — the P2-only merge bar keys off it (round 9).
    expect(db1._tables.codex_remediation_state[0].last_push_sha).toBeUndefined();

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

  // Owner directive 2026-08-26: the autonomous caller may thread a scoped
  // namedCompetitorAutopublish eligibility (TRUE-intercept marker + both
  // gates) — the named-competitor park then does not fire and the fix
  // pushes. Absent/false keeps the park (test above).
  test('namedCompetitorAutopublish eligibility threaded by the caller lets an intercept fix continue past the named-competitor park', async () => {
    const gh = makeGh();
    const r = await runRemediationForPr({ ...CTX, namedCompetitorAutopublish: true }, {
      db: makeDb(), gh, callAnthropic: makeCall('FIXED'),
      validateFixedBlogFile: () => ({ ok: true, requiresHumanReview: true }),
    });
    expect(r.parked).toBeUndefined();
    expect(gh._calls.putFile).toHaveLength(1);
  });

  test('maybeRemediateAutonomousPr derives that eligibility from the brief TRUE-intercept marker (integration, hook r3 P1)', async () => {
    const prevGate = process.env.AUTONOMOUS_CODEX_REMEDIATION;
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const fg = require('../config/feature-gates');
    const realIsEnabled = fg.isEnabled;
    jest.spyOn(fg, 'isEnabled').mockImplementation((g) => (
      (g === 'namedCompetitorAutopublish' || g === 'namedCompetitorComparison') ? true : realIsEnabled(g)));
    try {
      const HEAD_SHA = 'abc1234def5678';
      const runRow = { id: 'run-1', action_type: 'new_supporting_blog', opportunity_id: 'opp-1', brief_id: 'brief-1', draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678' }) };
      const harness = (intercept) => {
        const db = makeDb({
          autonomous_runs: [runRow],
          opportunity_queue: [{ id: 'opp-1', bucket: 'operator_intercept', service: 'pest' }],
          // Eligibility reads the brief row's RAW persisted marker (r13).
          content_briefs: [{ id: 'brief-1', action_type: 'new_supporting_blog', gsc_signal: { bucket: 'operator_intercept', intercept } }],
        });
        const gh = makeGh({ preHead: 'abc1234def5678', reviewComments: [finding({ path: 'src/content/blog/pest-control/x.mdx' })] });
        const pr = { number: 7, state: 'open', head: { sha: HEAD_SHA, ref: 'content/autonomous-x' } };
        gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
        const call = maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
          db, gh, callAnthropic: makeCall('FIXED'),
          // Named-competitor content in the fix: only the threaded
          // eligibility lets it continue past the park.
          validateFixedBlogFile: () => ({ ok: true, requiresHumanReview: true }),
          validateAutonomousRunGates: async () => ({ ok: true }),
          autonomousRunner: {
            _loadReviewedBrief: async () => ({
              action_type: 'new_supporting_blog',
              gsc_signal: { bucket: 'operator_intercept', intercept },
              voice_constraints: { operator_brief: { working_title: 'X' } },
            }),
            _deriveGuardrailOptions: async () => ({ service: 'pest', domains: null }),
          },
        });
        return call.then((result) => ({ result, db }));
      };

      const { result: eligible, db: eligibleDb } = await harness(true);
      expect(eligible.remediated).toBe(true);
      // No verdict persistence (PR r3 P2): the poller's merge gate
      // re-evaluates the current head itself.
      const stamped = eligibleDb._tables.autonomous_runs.find((x) => x.id === 'run-1');
      expect(stamped.comparison_table_result).toBeUndefined();

      // Category/spoke seed shape (shared bucket + operator_brief, no
      // TRUE-intercept marker) still parks.
      const { result: seed } = await harness(false);
      expect(seed.parked).toBe(true);
      expect(seed.reason).toMatch(/named-competitor/);
    } finally {
      fg.isEnabled.mockRestore();
      process.env.AUTONOMOUS_CODEX_REMEDIATION = prevGate;
    }
  });

  test('a fix that INTRODUCES a named competitor persists its flagged verdict atomically with the head pin (PR r13 P1)', async () => {
    const prevGate = process.env.AUTONOMOUS_CODEX_REMEDIATION;
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const fg = require('../config/feature-gates');
    const realIsEnabled = fg.isEnabled;
    jest.spyOn(fg, 'isEnabled').mockImplementation((g) => (
      (g === 'namedCompetitorAutopublish' || g === 'namedCompetitorComparison') ? true : realIsEnabled(g)));
    try {
      // Competitor-FREE original verdict on the run; the FIX's fresh gate
      // run flags requiresHumanReview.
      const db = makeDb({
        autonomous_runs: [{
          id: 'run-1', action_type: 'new_supporting_blog', opportunity_id: 'opp-1', brief_id: 'brief-1',
          comparison_table_result: JSON.stringify({ pass: true, findings: [], requiresHumanReview: false }),
          draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678' }),
        }],
        opportunity_queue: [{ id: 'opp-1', bucket: 'operator_intercept', service: 'pest' }],
        content_briefs: [{ id: 'brief-1', action_type: 'new_supporting_blog', gsc_signal: { intercept: true } }],
      });
      const gh = makeGh({ preHead: 'abc1234def5678', reviewComments: [finding({ path: 'src/content/blog/pest-control/x.mdx' })] });
      const pr = { number: 7, state: 'open', head: { sha: 'abc1234def5678', ref: 'content/autonomous-x' } };
      gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
      const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
        db, gh, callAnthropic: makeCall('FIXED'),
        validateFixedBlogFile: () => ({ ok: true, requiresHumanReview: true }),
        validateAutonomousRunGates: async () => ({ ok: true, comparisonResult: { pass: true, findings: [], requiresHumanReview: true } }),
        autonomousRunner: {
          _loadReviewedBrief: async () => ({ action_type: 'new_supporting_blog', gsc_signal: { intercept: true } }),
          _deriveGuardrailOptions: async () => ({ service: 'pest', domains: null }),
        },
      });
      expect(r.remediated).toBe(true);
      const row = db._tables.autonomous_runs.find((x) => x.id === 'run-1');
      // The flagged verdict and the new head pin landed in ONE update —
      // merge governance now treats the run as governed.
      expect(JSON.parse(row.comparison_table_result)).toMatchObject({ requiresHumanReview: true });
      expect(JSON.parse(row.draft_payload).autopublish_head_sha).toBe('newcommit999aaa');
    } finally {
      fg.isEnabled.mockRestore();
      process.env.AUTONOMOUS_CODEX_REMEDIATION = prevGate;
    }
  });

  // P2: frontmatter outside the whitelist is immutable — not just slug/canonical/domains.
  test('frontmatterFixViolation flags any non-whitelisted key change (title/hero path/author/date/added key)', () => {
    const orig = '---\ntitle: Roof Rats\nhero_image: /images/blog/x/hero.webp\nauthor: Adam\npublished: "2026-07-01"\n---\nbody text';
    expect(rem.frontmatterFixViolation(orig, orig).violation).toBeNull();
    expect(rem.frontmatterFixViolation(orig, orig.replace('Roof Rats', 'Rats')).violation).toMatch(/"title"/);
    // a STRING hero_image (bare path) counts as a path change, never an alt fix
    expect(rem.frontmatterFixViolation(orig, orig.replace('/images/blog/x/hero.webp', '/images/blog/x/other.webp')).violation).toMatch(/hero_image/);
    expect(rem.frontmatterFixViolation(orig, orig.replace('Adam', 'Ghost Writer')).violation).toMatch(/"author"/);
    expect(rem.frontmatterFixViolation(orig, orig.replace('"2026-07-01"', '"2026-07-05"')).violation).toMatch(/"published"/);
    expect(rem.frontmatterFixViolation(orig, orig.replace('---\nbody', 'og_image: /og.png\n---\nbody')).violation).toMatch(/"og_image"/);
    // body-only edit with identical frontmatter is allowed
    expect(rem.frontmatterFixViolation(orig, orig.replace('body text', 'fixed body text')).violation).toBeNull();
  });

  test('whitelist: a valid meta_description rewrite passes and is surfaced in `changed`', () => {
    const orig = '---\nslug: /pest-control/x/\nmeta_description: Too short and it ends with and\n---\nbody';
    const fixedMeta = 'A no-panic Southwest Florida guide to spider identification covering the widow species and the recluse myth. Learn more on the Waves blog.';
    const fixed = orig.replace('Too short and it ends with and', fixedMeta);
    const res = rem.frontmatterFixViolation(orig, fixed, [{ body: 'Complete the truncated meta description' }]);
    expect(res.violation).toBeNull();
    expect(res.changed.meta_description).toBe(fixedMeta);
    // The same delta WITHOUT a finding targeting the field is rejected —
    // an LLM must not smuggle SERP copy changes past a body-only round.
    expect(rem.frontmatterFixViolation(orig, fixed, [{ body: 'Fix the broken link.' }]).violation).toMatch(/no finding in this round targets it/);
  });

  test('whitelist: a meta_description rewrite outside the 115–160 schema bound parks', () => {
    const orig = '---\nslug: /pest-control/x/\nmeta_description: Old value that is being replaced entirely by the fix\n---\nbody';
    expect(rem.frontmatterFixViolation(orig, orig.replace('Old value that is being replaced entirely by the fix', 'Way too short'), [{ body: 'Complete the truncated meta description' }]).violation)
      .toMatch(/115–160/);
    expect(rem.frontmatterFixViolation(orig, orig.replace('Old value that is being replaced entirely by the fix', 'x'.repeat(200)), [{ body: 'Complete the truncated meta description' }]).violation)
      .toMatch(/115–160/);
  });

  test('whitelist: hero_image.alt rewrite passes; hero_image.src change parks; empty alt parks', () => {
    const orig = '---\nslug: /x/\nhero_image:\n  src: /images/blog/x/hero.webp\n  alt: Wrong species described here\n---\nbody';
    const altFix = rem.frontmatterFixViolation(orig, orig.replace('Wrong species described here', 'Large glossy dark-mahogany cockroach on a driveway'), [{ body: 'Hero alt does not match the image' }]);
    expect(altFix.violation).toBeNull();
    expect(altFix.changed.hero_alt).toBe('Large glossy dark-mahogany cockroach on a driveway');
    expect(rem.frontmatterFixViolation(orig, orig.replace('/images/blog/x/hero.webp', '/images/blog/x/new.webp')).violation)
      .toMatch(/hero_image\.src/);
    expect(rem.frontmatterFixViolation(orig, orig.replace('Wrong species described here', '""'), [{ body: 'Hero alt does not match the image' }]).violation)
      .toMatch(/alt rewrite invalid/);
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

  test('sync-failure park stamps the NEW head so our own push cannot re-arm it', async () => {
    const db = makeDb();
    const gh = makeGh();
    await runRemediationForPr(
      { ...CTX, onRemediated: async () => { throw new Error('db down'); } },
      { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS },
    );
    // The park verdict applies to the commit we just pushed, not the pre-push head.
    expect(db._tables.codex_remediation_state[0].parked_head_sha).toBe('newcommit999aaa');
    // Next tick, the PR head IS that pushed commit — the park must hold.
    // The pushed head has no Codex review and (by design of the sync-failure
    // park) no re-review request, so the parked review-signal insurance posts
    // the request while the park stands — without it this exact state
    // wedged astro #395 at codex_review_pending for 30h (2026-07-22).
    const gh2 = makeGh({ gh: { getPr: async () => ({ state: 'open', head: { sha: 'newcommit999aaa', ref: 'content/blog-x' } }) } });
    const r2 = await runRemediationForPr(CTX, { db, gh: gh2, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe('parked (requested codex review for unreviewed head)');
    expect(gh2._calls.comments).toHaveLength(1);
    expect(gh2._calls.comments[0].body).toContain('newcommit999aaa');
    expect(db._tables.codex_remediation_state[0].status).toBe('parked');
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
    const gh = makeGh({ preHead: 'abc1234def5678', reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
    let checked = false;
    const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
      db: makeDb({ autonomous_runs: [{ id: 'run-1', action_type: 'new_supporting_blog', draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678' }) }] }),
      gh,
      callAnthropic: makeCall('FIXED'),
      validateFixedBlogFile: PASS,
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

describe('operator-FAQ exception (intercept posts on FAQ-blocked services)', () => {
  // Real content-guardrails end-to-end: a termite intercept post ships WITH a
  // FAQ by owner mandate (2026-06-11), so the pre-commit gate must honor the
  // same narrow exception the publish path does — without it every fix on
  // such a post P0s on the PRE-EXISTING FAQ and the PR parks (PR #368).
  const TERMITE_FM = {
    title: 'Sentricon in Southwest Florida',
    slug: '/termite/sentricon-swfl/',
    meta_description: 'How termite bait stations work in Southwest Florida sandy soil, and what a monitored bait program actually covers for SWFL homeowners.',
    primary_keyword: 'sentricon',
    secondary_keywords: [],
    category: 'termite',
    post_type: 'location',
    service_areas_tag: ['Sarasota'],
    related_services: [],
    spoke_links: [],
    author: { name: 'Adam Benetti', role: 'Owner', fdacs_license: 'JB1234', bio_url: '/about/authors/adam-benetti' },
    technically_reviewed_by: { name: 'Adam Benetti', credential: 'Certified Operator', fdacs_license: 'JB1234', bio_url: '/about/authors/adam-benetti' },
    published: '2026-07-10',
    updated: '2026-07-10',
    technically_reviewed: '2026-07-10',
    fact_checked: '2026-07-10',
    review_cadence: 'quarterly',
    reading_time_min: 3,
    hero_image: { src: '/images/blog/termite/sentricon-swfl/hero.webp', alt: 'Bait station along a home perimeter' },
    og_image: '/images/blog/termite/sentricon-swfl/hero.webp',
    canonical: 'https://www.wavespestcontrol.com/termite/sentricon-swfl/',
    schema_types: ['Article', 'FAQPage'],
    disclosure: { type: 'pricing-transparency' },
    domains: ['wavespestcontrol.com'],
    tracking: { domains: ['wavespestcontrol.com'] },
  };
  // JSON is valid YAML, so a stringified object is a parseable frontmatter block.
  const FAQ_MD = `---\n${JSON.stringify(TERMITE_FM, null, 2)}\n---\nBait stations target the colony itself.\n\n## Frequently Asked Questions\n\n### How long does bait last?\n\nStations stay in service as long as they are monitored.`;
  const gateDeps = { factCheckEvaluate: async () => ({ pass: true }) };

  test('validateFixedBlogFile: termite post with a pre-existing FAQ blocks without the flag, passes with it', async () => {
    const strict = await rem.validateFixedBlogFile(FAQ_MD, {}, gateDeps);
    expect(strict.ok).toBe(false);
    expect(strict.reason).toMatch(/FAQ_BLOCKED_SERVICE/);

    const excepted = await rem.validateFixedBlogFile(FAQ_MD, { operatorFaqException: true }, gateDeps);
    expect(excepted.ok).toBe(true);
  });

  test('validateFixedBlogFile BLOCKS a remediation that introduces a semantic compliance violation', async () => {
    // Remediation rewrites body and meta AFTER the publisher's compliance gate
    // ran, so a fix can introduce exactly the semantic-only violation the
    // deterministic guard cannot express, and the new head commits on a clean
    // Codex follow-up (Codex PR #3295 r4).
    const deps = {
      factCheckEvaluate: async () => ({ pass: true }),
      complianceEvaluate: async () => ({
        pass: false,
        findings: [{
          severity: 'P0',
          code: 'REENTRY_SAFETY_CLAIM',
          message: '"safe for pets and works after it dries" — dry clause governs "works"',
        }],
      }),
    };
    const r = await rem.validateFixedBlogFile(FAQ_MD, { operatorFaqException: true }, deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/compliance REENTRY_SAFETY_CLAIM/);
  });

  test('validateFixedBlogFile sends the editable META to the compliance gate, not just the body', async () => {
    let seenBody = null;
    const deps = {
      factCheckEvaluate: async () => ({ pass: true }),
      complianceEvaluate: async ({ body }) => { seenBody = body; return { pass: true }; },
    };
    await rem.validateFixedBlogFile(FAQ_MD, { operatorFaqException: true }, deps);
    expect(seenBody).toContain('Bait stations target the colony itself.');
    expect(seenBody).toContain(TERMITE_FM.meta_description);
    // The meta strings are field VALUES: they must arrive AFTER the marker
    // that withdraws the gate's body-markup comment exemption (Codex PR
    // #3302 r1 — "<!-- pet-safe -->" in an alt text is rendered copy).
    const { META_SECTION_MARKER } = require('../services/content/compliance-gate');
    expect(seenBody).toContain(META_SECTION_MARKER);
    expect(seenBody.indexOf(META_SECTION_MARKER)).toBeGreaterThan(seenBody.indexOf('Bait stations'));
    expect(seenBody.indexOf(TERMITE_FM.meta_description)).toBeGreaterThan(seenBody.indexOf(META_SECTION_MARKER));
  });

  test('validateFixedBlogFile forwards guardContext.operatorBriefText to the preflight comparison gate (hook r9 P1)', async () => {
    const gateMod = require('../services/content/comparison-table-gate');
    const spy = jest.spyOn(gateMod, 'evaluate').mockReturnValue({ pass: true, findings: [], requiresHumanReview: false });
    try {
      const deps = { factCheckEvaluate: async () => ({ pass: true }), complianceEvaluate: async () => ({ pass: true }) };
      const opText = 'Authorized competitor: HomeTeam Taexx (https://pestdefense.com/taexx/)';
      const r = await rem.validateFixedBlogFile(FAQ_MD, { operatorFaqException: true, guardContext: { operatorBriefText: opText } }, deps);
      expect(r.ok).toBe(true);
      expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operatorBriefText: opText }));
    } finally {
      spy.mockRestore();
    }
  });

  test('runRemediationForPr threads ctx.operatorFaqException into the content-gate re-run', async () => {
    let optsSeen = null;
    const spy = (md, opts) => { optsSeen = opts; return { ok: true }; };
    const r = await runRemediationForPr(
      { ...CTX, operatorFaqException: true },
      { db: makeDb(), gh: makeGh(), callAnthropic: makeCall('FIXED'), validateFixedBlogFile: spy },
    );
    expect(r.remediated).toBe(true);
    expect(optsSeen.operatorFaqException).toBe(true);
  });

  test('autonomous lane derives the flag from the run opportunity/brief via the runner derivation', async () => {
    const prevGate = process.env.AUTONOMOUS_CODEX_REMEDIATION;
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    try {
      const db = makeDb({
        autonomous_runs: [{ id: 'run-1', action_type: 'new_supporting_blog', opportunity_id: 'opp-1', draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678' }) }],
        opportunity_queue: [{ id: 'opp-1', bucket: 'operator_intercept', service: 'termite' }],
      });
      const gh = makeGh({ preHead: 'abc1234def5678', reviewComments: [finding({ path: 'src/content/blog/termite/x.mdx' })] });
      const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
      gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
      let optsSeen = null;
      const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
        db, gh, callAnthropic: makeCall('FIXED'),
        validateFixedBlogFile: (md, opts) => { optsSeen = opts; return { ok: true }; },
        validateAutonomousRunGates: async () => ({ ok: true }),
        autonomousRunner: {
          _loadReviewedBrief: async () => ({ voice_constraints: { operator_brief: { faq_required: true } } }),
          _deriveGuardrailOptions: async () => ({ service: 'termite', domains: null, operatorFaqException: true }),
        },
      });
      expect(r.remediated).toBe(true);
      expect(optsSeen.operatorFaqException).toBe(true);
    } finally {
      process.env.AUTONOMOUS_CODEX_REMEDIATION = prevGate;
    }
  });

  test('autonomous lane derivation failure stays false (fail closed, remediation still runs)', async () => {
    const prevGate = process.env.AUTONOMOUS_CODEX_REMEDIATION;
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    try {
      const db = makeDb({
        autonomous_runs: [{ id: 'run-1', action_type: 'new_supporting_blog', opportunity_id: 'opp-1', draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678' }) }],
        opportunity_queue: [{ id: 'opp-1', bucket: 'operator_intercept', service: 'termite' }],
      });
      const gh = makeGh({ preHead: 'abc1234def5678', reviewComments: [finding({ path: 'src/content/blog/termite/x.mdx' })] });
      const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
      gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
      let optsSeen = null;
      const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
        db, gh, callAnthropic: makeCall('FIXED'),
        validateFixedBlogFile: (md, opts) => { optsSeen = opts; return { ok: true }; },
        validateAutonomousRunGates: async () => ({ ok: true }),
        autonomousRunner: {
          _loadReviewedBrief: async () => { throw new Error('briefs table unavailable'); },
          _deriveGuardrailOptions: async () => ({ operatorFaqException: true }),
        },
      });
      expect(r.remediated).toBe(true);
      expect(optsSeen.operatorFaqException).toBe(false);
    } finally {
      process.env.AUTONOMOUS_CODEX_REMEDIATION = prevGate;
    }
  });
});

describe('validateAutonomousRunGates', () => {
  const MD = '---\ntitle: T\n---\nFixed body text';
  const RUN = {
    id: 'run-1',
    action_type: 'new_supporting_blog',
    opportunity_id: 'opp-1',
    brief_id: 'brief-1',
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

  test('run-context comparison requiresHumanReview passes for an opted-in TRUE-intercept run (owner directive 2026-08-26)', async () => {
    const fg = require('../config/feature-gates');
    const realIsEnabled = fg.isEnabled;
    jest.spyOn(fg, 'isEnabled').mockImplementation((g) => (
      (g === 'namedCompetitorAutopublish' || g === 'namedCompetitorComparison') ? true : realIsEnabled(g)));
    try {
      const deps = goodDeps();
      // The canonical TRUE-intercept marker — bucket/operator_brief alone
      // must NOT qualify (category/spoke seeds share those). Eligibility
      // reads the brief row's RAW persisted gsc_signal (r13), so the db
      // carries the marker brief.
      deps.db._tables.content_briefs = [{ id: 'brief-1', action_type: 'new_supporting_blog', gsc_signal: { intercept: true } }];
      deps.autonomousRunner._loadReviewedBrief = async () => ({
        page_type: 'supporting-blog', action_type: 'new_supporting_blog', gsc_signal: { intercept: true },
      });
      deps.comparisonTableGate.evaluate = () => ({ pass: true, findings: [], requiresHumanReview: true });
      const r = await rem.validateAutonomousRunGates(MD, RUN_REF, deps);
      expect(r.ok).toBe(true);
      // No verdict persistence anywhere in this validator (PR r3 P2: the
      // poller's merge gate re-evaluates the current head itself).
      const row = deps.db._tables.autonomous_runs.find((x) => x.id === 'run-1');
      expect(row.comparison_table_result).toBeUndefined();
    } finally {
      fg.isEnabled.mockRestore();
    }
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

describe('frontmatter whitelist round trip (meta_description + hero_image.alt)', () => {
  const prev = process.env.AUTONOMOUS_CODEX_REMEDIATION;
  afterEach(() => { process.env.AUTONOMOUS_CODEX_REMEDIATION = prev; });

  const VALID_META = 'A no-panic Southwest Florida guide to spider identification covering the widow species and the recluse myth. Learn more on the Waves blog.';

  test('a fix that completes meta_description + hero alt PUSHES instead of parking (scheduler lane) and mirrors the row columns', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const orig = '---\ntitle: T\nmeta_description: Truncated ending with and\nhero_image:\n  src: /images/blog/x/hero.webp\n  alt: Old alt\n---\nBODY';
    const fixedMd = orig.replace('Truncated ending with and', VALID_META).replace('Old alt', 'Accurate new alt text');
    const db = makeDb({
      blog_posts: [{ id: 1, publish_status: 'publishing', astro_pr_number: 5, astro_branch_name: 'content/blog-x', slug: 'pest-control/roaches', category: 'pest-control', tag: 'Rodents', title: 'T', city: 'Sarasota', keyword: 'k', content: 'BODY', meta_description: 'Truncated ending with and', hero_image_alt: 'Old alt' }],
    });
    const gh = makeGh({ fileContent: orig, reviewComments: [finding({ body: 'Complete the truncated meta description' }), finding({ body: 'Hero image alt is inaccurate' })] });
    const r = await maybeRemediateBlogPost({ id: 1 }, { db, gh, callAnthropic: makeCall(fixedMd), validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
    expect(gh._calls.putFile).toHaveLength(1);
    // Mirrored so a later republish (which rebuilds frontmatter from the
    // row) can't resurrect the flagged values.
    expect(db._tables.blog_posts[0].meta_description).toBe(VALID_META);
    expect(db._tables.blog_posts[0].hero_image_alt).toBe('Accurate new alt text');
  });

  test('autonomous lane mirrors the whitelisted fix into draft_payload (social caption source), other keys untouched', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const orig = '---\ntitle: T\nmeta_description: Truncated ending with and\n---\nBODY';
    const fixedMd = orig.replace('Truncated ending with and', VALID_META);
    const db = makeDb({
      autonomous_runs: [{ id: 'run-1', action_type: 'new_supporting_blog', draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678', type: 'draft', frontmatter: { canonical: 'https://x/a/', meta_description: 'Truncated ending with and' } }) }],
    });
    const gh = makeGh({ preHead: 'abc1234def5678', reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx', body: 'Complete the truncated meta description' })], fileContent: orig });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
    const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
      db, gh, callAnthropic: makeCall(fixedMd), validateFixedBlogFile: PASS,
      validateAutonomousRunGates: async () => ({ ok: true }),
    });
    expect(r.remediated).toBe(true);
    const payload = JSON.parse(db._tables.autonomous_runs[0].draft_payload);
    expect(payload.frontmatter.meta_description).toBe(VALID_META);
    expect(payload.frontmatter.canonical).toBe('https://x/a/');
  });

  test('an UNPARSEABLE draft_payload withholds remediation entirely — the parent pin cannot be verified (PR r15 P1)', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const orig = '---\ntitle: T\nmeta_description: Truncated ending with and\n---\nBODY';
    const fixedMd = orig.replace('Truncated ending with and', VALID_META);
    const db = makeDb({
      autonomous_runs: [{ id: 'run-1', action_type: 'new_supporting_blog', draft_payload: 'not json {' }],
    });
    const gh = makeGh({ preHead: 'abc1234def5678', reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx', body: 'Complete the truncated meta description' })], fileContent: orig });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
    const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
      db, gh, callAnthropic: makeCall(fixedMd), validateFixedBlogFile: PASS,
      validateAutonomousRunGates: async () => ({ ok: true }),
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/foreign parent/);
    expect(gh._calls.putFile).toHaveLength(0);
    expect(db._tables.autonomous_runs[0].draft_payload).toBe('not json {'); // untouched
  });

  test('a FOREIGN parent head (pin mismatch) withholds remediation — a one-file fix must not bless unrelated changes (PR r15 P1)', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      autonomous_runs: [{ id: 'run-1', action_type: 'new_supporting_blog', draft_payload: JSON.stringify({ autopublish_head_sha: 'publisherpin111' }) }],
    });
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
      db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
      validateAutonomousRunGates: async () => ({ ok: true }),
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/foreign parent/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('a head that MOVES between the parent check and the refetch is withheld (TOCTOU, PR r16 P1)', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      autonomous_runs: [{ id: 'run-1', action_type: 'new_supporting_blog', draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678' }) }],
    });
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    // Caller's snapshot matches the pin, but the refetched PR shows a NEWER
    // foreign head.
    const pr = { number: 7, state: 'open', head: { sha: 'abc1234def5678', ref: 'content/autonomous-x' } };
    gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: 'foreignpush999' } });
    const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
      db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
      validateAutonomousRunGates: async () => ({ ok: true }),
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/moved off the pinned parent/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('a BRANCH tip that advances during the LLM/gate passes is caught right before the push (PR r17 P1)', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      autonomous_runs: [{ id: 'run-1', action_type: 'new_supporting_blog', draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678' }) }],
    });
    const gh = makeGh({ reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: 'abc1234def5678', ref: 'content/autonomous-x' } };
    gh.getPr = async () => pr;
    // The refetched PR still shows the pinned head, but by push time the
    // live branch has a foreign tip.
    gh.getBranchSha = async () => 'foreigntip42';
    const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
      db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
      validateAutonomousRunGates: async () => ({ ok: true }),
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/advanced off the pinned parent/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('a competitor-REMOVING fix keeps the bypass marker STICKY — the persisted verdict stays flagged (PR r15 P1)', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      autonomous_runs: [{
        id: 'run-1', action_type: 'new_supporting_blog',
        comparison_table_result: JSON.stringify({ pass: true, findings: [], requiresHumanReview: true }),
        draft_payload: JSON.stringify({ autopublish_head_sha: 'abc1234def5678' }),
      }],
    });
    const gh = makeGh({ preHead: 'abc1234def5678', reviewComments: [finding({ path: 'src/content/blog/pest-control/roaches.mdx' })] });
    const pr = { number: 7, state: 'open', head: { sha: HEAD, ref: 'content/autonomous-x' } };
    gh.getPr = async () => ({ ...pr, head: { ...pr.head, sha: gh._calls.putFile.length ? 'newcommit999aaa' : pr.head.sha } });
    const r = await maybeRemediateAutonomousPr(pr, { id: 'run-1', action_type: 'new_supporting_blog' }, {
      db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
      // The fix REMOVES every competitor mention — fresh verdict is clean.
      validateAutonomousRunGates: async () => ({ ok: true, comparisonResult: { pass: true, findings: [], requiresHumanReview: false } }),
    });
    expect(r.remediated).toBe(true);
    const row = db._tables.autonomous_runs.find((x) => x.id === 'run-1');
    // Sticky: the run stays governed even though the fix is competitor-free.
    expect(JSON.parse(row.comparison_table_result)).toMatchObject({ requiresHumanReview: true });
    expect(JSON.parse(row.draft_payload).autopublish_head_sha).toBe('newcommit999aaa');
  });

  test('an out-of-bound meta_description rewrite still parks end-to-end', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const orig = '---\ntitle: T\nmeta_description: Truncated ending with and\n---\nBODY';
    const fixedMd = orig.replace('Truncated ending with and', 'Too short.');
    const gh = makeGh({ fileContent: orig, reviewComments: [finding({ body: 'Complete the truncated meta description' })] });
    const r = await runRemediationForPr(CTX, { db: makeDb(), gh, callAnthropic: makeCall(fixedMd), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/beyond the whitelist/);
    expect(gh._calls.putFile).toHaveLength(0);
  });
});

describe('validateAutonomousRunGates revalidates REWRITTEN frontmatter (Codex r1 on #2757)', () => {
  test('gates receive the fixed meta_description + hero alt, not the stale stored payload values', async () => {
    const db = makeDb({
      autonomous_runs: [{
        id: 'run-1',
        action_type: 'new_supporting_blog',
        opportunity_id: 'opp-1',
        facts_sufficiency: null,
        draft_payload: JSON.stringify({
          type: 'draft',
          body: 'OLD',
          meta_description: 'Truncated ending with and',
          frontmatter: { canonical: 'https://x/a/', meta_description: 'Truncated ending with and', hero_image: { src: '/images/blog/x/hero.webp', alt: 'Old alt' } },
        }),
      }],
      opportunity_queue: [{ id: 'opp-1' }],
    });
    const seen = {};
    const capture = (name) => (arg) => {
      seen[name] = arg && arg.draft ? arg.draft : arg;
      return name === 'seo'
        ? { passed: true, skipped: false, findings: [] }
        : { pass: true, ok: true, findings: [] };
    };
    const fixedMd = [
      '---',
      "title: T",
      "meta_description: A no-panic Southwest Florida guide to spider identification covering the widow species and the recluse myth. Learn more on the Waves blog.",
      'hero_image:',
      '  src: /images/blog/x/hero.webp',
      '  alt: Accurate new alt',
      '---',
      'FIXED BODY',
    ].join('\n');
    const res = await rem.validateAutonomousRunGates(fixedMd, { id: 'run-1' }, {
      db,
      autonomousRunner: {
        _loadReviewedBrief: async () => ({ page_type: 'supporting-blog' }),
        _deriveGuardrailOptions: async () => ({}),
        _loadBlogCorpus: async () => [],
      },
      contentGuardrails: { evaluate: capture('guardrails') },
      comparisonTableGate: { evaluate: capture('comparison') },
      uniquenessGate: { evaluateBlog: (draft) => { seen.uniq = draft; return { ok: true }; } },
      qualityGate: { evaluate: (draft) => { seen.quality = draft; return { ok: true }; } },
      seoCompletionGate: { evaluate: capture('seo') },
      aiVisibilityGate: { evaluateStatic: () => ({ passed: true, findings: [] }) },
    });
    expect(res.ok).toBe(true);
    // Every gate sees the REWRITTEN metadata.
    for (const d of [seen.guardrails, seen.uniq, seen.quality, seen.seo]) {
      expect(d.meta_description).toMatch(/^A no-panic Southwest Florida guide/);
      expect(d.frontmatter.meta_description).toMatch(/^A no-panic Southwest Florida guide/);
      expect(d.frontmatter.hero_image.alt).toBe('Accurate new alt');
      expect(d.frontmatter.hero_image.src).toBe('/images/blog/x/hero.webp');
      expect(d.body).toBe('FIXED BODY');
    }
  });
});

describe('whitelist hardening round 2 (Codex r2 on #2757)', () => {
  const prev = process.env.AUTONOMOUS_CODEX_REMEDIATION;
  afterEach(() => { process.env.AUTONOMOUS_CODEX_REMEDIATION = prev; });

  test('an image/path finding does NOT authorize an alt rewrite (alt-specific wording required)', () => {
    const orig = '---\nslug: /x/\nhero_image:\n  src: /images/blog/x/hero.webp\n  alt: Old alt\n---\nbody';
    const fixed = orig.replace('Old alt', 'New alt text');
    // "hero image"/"hero art" findings are about the asset, not the alt.
    expect(rem.frontmatterFixViolation(orig, fixed, [{ body: 'Replace the misleading roach hero image' }]).violation)
      .toMatch(/no finding in this round targets it/);
    expect(rem.frontmatterFixViolation(orig, fixed, [{ body: 'Use accurate smokybrown hero art' }]).violation)
      .toMatch(/no finding in this round targets it/);
    // Alt-specific wording still authorizes.
    expect(rem.frontmatterFixViolation(orig, fixed, [{ body: 'The hero alt describes the wrong species' }]).violation).toBeNull();
    expect(rem.frontmatterFixViolation(orig, fixed, [{ body: 'heroAlt claims a red spider' }]).violation).toBeNull();
  });

  test('hero_image.alt over 255 chars parks (mirror column is varchar(255))', () => {
    const orig = '---\nslug: /x/\nhero_image:\n  src: /images/blog/x/hero.webp\n  alt: Old alt\n---\nbody';
    const fixed = orig.replace('Old alt', 'A'.repeat(260));
    expect(rem.frontmatterFixViolation(orig, fixed, [{ body: 'hero alt is wrong' }]).violation)
      .toMatch(/>255 chars/);
  });

  test('scheduler lane: rewritten meta failing the title/meta spam check parks before push', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const VALID_META = 'A no-panic Southwest Florida guide to spider identification covering the widow species and the recluse myth. Learn more on the Waves blog.';
    const orig = '---\ntitle: T\nmeta_description: Truncated ending with and\n---\nBODY';
    const fixedMd = orig.replace('Truncated ending with and', VALID_META);
    const gh = makeGh({ fileContent: orig, reviewComments: [finding({ body: 'Complete the truncated meta description' })] });
    const r = await runRemediationForPr(
      { ...CTX, factContext: { title: 'T', city: 'Sarasota', keyword: 'k', tag: 'Rodents' } },
      {
        db: makeDb(), gh, callAnthropic: makeCall(fixedMd), validateFixedBlogFile: PASS,
        titleMetaSpamGate: { evaluateTitleMetaSpam: () => ({ ok: false, hard_failures: [{ code: 'near_me_stuffing' }] }) },
        contentQualityGate: { _internals: { checkRedactionPassed: () => ({ ok: true }) } },
      },
    );
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/metadata quality checks: title\/meta spam: near_me_stuffing/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('scheduler lane: rewritten meta failing the PII check parks before push', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const VALID_META = 'A no-panic Southwest Florida guide to spider identification covering the widow species and the recluse myth. Learn more on the Waves blog.';
    const orig = '---\ntitle: T\nmeta_description: Truncated ending with and\n---\nBODY';
    const fixedMd = orig.replace('Truncated ending with and', VALID_META);
    const gh = makeGh({ fileContent: orig, reviewComments: [finding({ body: 'Complete the truncated meta description' })] });
    const r = await runRemediationForPr(
      { ...CTX, factContext: { title: 'T', city: 'Sarasota', keyword: 'k', tag: 'Rodents' } },
      {
        db: makeDb(), gh, callAnthropic: makeCall(fixedMd), validateFixedBlogFile: PASS,
        titleMetaSpamGate: { evaluateTitleMetaSpam: () => ({ ok: true, hard_failures: [], soft_failures: [] }) },
        contentQualityGate: { _internals: { checkRedactionPassed: () => ({ ok: false, reason: 'email_in_meta_description' }) } },
      },
    );
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/pii: email_in_meta_description/);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('validateRewrittenMeta passes clean copy through the REAL spam + PII gates', () => {
    const VALID_META = 'A no-panic Southwest Florida guide to spider identification covering the widow species and the recluse myth. Learn more on the Waves blog.';
    const res = rem.validateRewrittenMeta(VALID_META, { title: 'Florida Spiders: Which Ones Matter', city: 'Sarasota', keyword: 'florida spiders', tag: 'pest-control' });
    expect(res.ok).toBe(true);
    // A legacy title with pre-existing spam issues must NOT park a clean
    // meta rewrite — the whitelist can never change the title, so only the
    // rewritten meta is graded (Codex r3 on #2757).
    const spammyTitle = 'Best Pest Control Near Me Sarasota | Pest Control Sarasota | ' + 'Pest Control '.repeat(6);
    const resLegacy = rem.validateRewrittenMeta(VALID_META, { title: spammyTitle, city: 'Sarasota', keyword: 'pest control', tag: 'pest-control' });
    expect(resLegacy.ok).toBe(true);
    // And a meta carrying an obvious non-Waves email fails the real gate.
    const bad = 'Email john.doe@gmail.com for spider help across Sarasota, Bradenton and Venice — identification, prevention and treatment for Southwest Florida homes.';
    const resBad = rem.validateRewrittenMeta(bad, { title: 'T', city: 'Sarasota', keyword: 'k', tag: 'pest-control' });
    expect(resBad.ok).toBe(false);
  });
});

// PR left the open state → its remediation row must stop reading as a live
// park. markPrTerminal is fail-soft bookkeeping called from finalizeMerged/
// finalizeClosed (autonomous poller) and applyMergeEffect (scheduler/admin
// mergeAstro path).
describe('markPrTerminal', () => {
  test('retires a parked row to merged; already-terminal rows stay put', async () => {
    const db = makeDb({
      codex_remediation_state: [
        { pr_number: 377, status: 'parked', park_reason: 'x', rounds: 2 },
        { pr_number: 375, status: 'closed' },
      ],
    });
    const r1 = await rem.markPrTerminal(377, 'merged', db);
    expect(r1.updated).toBe(1);
    expect(db._tables.codex_remediation_state.find((r) => r.pr_number === 377).status).toBe('merged');

    // closed → merged is the one sanctioned terminal upgrade (a reopened
    // PR can merge); merged stays permanent.
    const r2 = await rem.markPrTerminal(375, 'merged', db);
    expect(r2.updated).toBe(1);
    expect(db._tables.codex_remediation_state.find((r) => r.pr_number === 375).status).toBe('merged');
    expect((await rem.markPrTerminal(377, 'closed', db)).updated).toBe(0);
    expect(db._tables.codex_remediation_state.find((r) => r.pr_number === 377).status).toBe('merged');
  });

  test('tombstones a missing row so an in-flight round cannot recreate live telemetry', async () => {
    const db = makeDb({ codex_remediation_state: [] });
    await rem.markPrTerminal(999, 'merged', db);
    expect(db._tables.codex_remediation_state).toHaveLength(1);
    expect(db._tables.codex_remediation_state[0]).toMatchObject({ pr_number: 999, status: 'merged' });
    // …and the racing round's first saveState now loses to the tombstone.
    const { saveState } = rem._internals;
    expect(await saveState(db, 999, { status: 'remediating', branch: 'b' })).toBe(false);
    expect(db._tables.codex_remediation_state[0].status).toBe('merged');
  });

  test('rejects junk input and never throws (fail-soft)', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 1, status: 'active' }] });
    expect((await rem.markPrTerminal('not-a-number', 'merged', db)).updated).toBe(0);
    expect((await rem.markPrTerminal(1, 'exploded', db)).updated).toBe(0);
    const throwingDb = () => { throw new Error('db down'); };
    throwingDb.raw = async () => { throw new Error('db down'); };
    await expect(rem.markPrTerminal(1, 'merged', throwingDb)).resolves.toMatchObject({ updated: 0 });
  });
});

// Terminal rows must be immutable to saveState: a remediation round that
// began while the PR was open can finish AFTER markPrTerminal and would
// otherwise write status back to remediating/parked (codex r-local finding).
describe('saveState vs terminal rows', () => {
  const { saveState } = rem._internals;

  test('saveState cannot overwrite a merged/closed row', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 42, status: 'merged', rounds: 1 }] });
    const wrote = await saveState(db, 42, { status: 'remediating', branch: 'b' });
    expect(wrote).toBe(false);
    expect(db._tables.codex_remediation_state[0]).toMatchObject({ status: 'merged', rounds: 1 });
  });

  test('saveState still writes normally to non-terminal rows and inserts fresh ones', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 43, status: 'active', rounds: 0 }] });
    expect(await saveState(db, 43, { status: 'remediating' })).toBe(true);
    expect(db._tables.codex_remediation_state[0].status).toBe('remediating');
    expect(await saveState(db, 44, { status: 'active', rounds: 0 })).toBe(true);
    expect(db._tables.codex_remediation_state).toHaveLength(2);
  });

  test('a round whose PR went terminal aborts BEFORE gh.putFile', async () => {
    // The PR merged after this round's getPr but before its state write —
    // the terminal row must stop the round with nothing pushed.
    const db = makeDb({ codex_remediation_state: [{ pr_number: CTX.prNumber, status: 'merged', rounds: 1 }] });
    const gh = makeGh();
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true);
    expect(r.reason).toContain('terminal');
    expect(gh._calls.putFile).toHaveLength(0);
    expect(db._tables.codex_remediation_state[0].status).toBe('merged');
  });
});

// codex r-local final: the PR can merge/close between the pre-push guard and
// gh.putFile — the push is inert, but post-commit sync would mirror content
// into portal state that never landed in main. The post-push revalidation
// must catch it.
describe('post-push PR revalidation', () => {
  test('PR merged during the push → sync and comment are skipped, row stamped merged', async () => {
    const db = makeDb();
    let calls = 0;
    const gh = makeGh({
      gh: {
        async getPr() {
          calls += 1;
          // First call (round entry): open. Second call (post-push): merged.
          if (calls === 1) return { state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } };
          return { state: 'closed', merged: true, merged_at: '2026-07-16T00:00:00Z', head: { sha: 'newcommit999aaa' } };
        },
      },
    });
    const onRemediated = jest.fn();
    const r = await runRemediationForPr(
      { ...CTX, onRemediated },
      { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS },
    );
    expect(r.skipped).toBe(true);
    expect(r.reason).toContain('post-push check');
    expect(onRemediated).not.toHaveBeenCalled();
    expect(gh._calls.comments).toHaveLength(0);
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === CTX.prNumber).status).toBe('merged');
  });

  test('PR head moved past our push (parallel update) → sync and comment are skipped', async () => {
    const db = makeDb();
    let calls = 0;
    const gh = makeGh({
      gh: {
        async getPr() {
          calls += 1;
          if (calls === 1) return { state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } };
          return { state: 'open', head: { sha: 'someoneelses111', ref: 'content/blog-x' } };
        },
        // A REAL parallel push moves the branch ref too — the ref no longer
        // reads our commit (a ref still at our push is the stale-getPr case).
        async getBranchSha() { return 'someoneelses111'; },
      },
    });
    const onRemediated = jest.fn();
    const r = await runRemediationForPr(
      { ...CTX, onRemediated },
      { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS },
    );
    expect(r.parked).toBe(true);
    expect(r.reason).toContain('head moved');
    expect(onRemediated).not.toHaveBeenCalled();
    expect(gh._calls.comments).toHaveLength(0);
    // Parked on OUR pushed head — the newer head re-arms on the next tick.
    const row = db._tables.codex_remediation_state.find((x) => x.pr_number === CTX.prNumber);
    expect(row.status).toBe('parked');
    expect(row.parked_head_sha).toBe('newcommit999aaa');
  });

  test('a GitHub error during revalidation fails CLOSED — parks with sync withheld', async () => {
    const db = makeDb();
    let calls = 0;
    const gh = makeGh({
      gh: {
        async getPr() {
          calls += 1;
          if (calls === 1) return { state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } };
          throw new Error('gh 502');
        },
      },
    });
    const onRemediated = jest.fn();
    const r = await runRemediationForPr(
      { ...CTX, onRemediated },
      { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS },
    );
    expect(r.parked).toBe(true);
    expect(r.reason).toContain('revalidation failed');
    expect(onRemediated).not.toHaveBeenCalled();
    expect(gh._calls.comments).toHaveLength(0);
    const row = db._tables.codex_remediation_state.find((x) => x.pr_number === CTX.prNumber);
    expect(row.status).toBe('parked');
    // Parked on the PUSHED head so our own commit can't self-re-arm the loop.
    expect(row.parked_head_sha).toBe('newcommit999aaa');
  });
});

// PRs can be REOPENED: a 'closed' tombstone must not permanently disable
// remediation for a PR that is verifiably open again (codex r-local).
describe('closed-tombstone reopen re-arm', () => {
  test('a remediation round on a reopened PR re-arms the closed row and proceeds', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      codex_remediation_state: [{ pr_number: CTX.prNumber, status: 'closed', rounds: 2, park_reason: 'x' }],
    });
    const gh = makeGh();
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
    expect(r.round).toBe(1); // fresh rounds after re-arm
    const row = db._tables.codex_remediation_state.find((x) => x.pr_number === CTX.prNumber);
    expect(row.status).toBe('remediating');
  });
});

describe('p2OnlyMergeEligible (P2-only merge bar)', () => {
  const prevP2 = process.env.AUTONOMOUS_CODEX_P2_MERGE;
  afterEach(() => {
    if (prevP2 === undefined) delete process.env.AUTONOMOUS_CODEX_P2_MERGE;
    else process.env.AUTONOMOUS_CODEX_P2_MERGE = prevP2;
  });

  const p2Body = (title) => `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  ${title}**\n\ndetail`;
  const p1Body = (title) => `**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  ${title}**\n\ndetail`;

  test('all-P2 findings for the head + >=1 round spent + submitted review → eligible', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD }] });
    const gh = makeGh({
      reviewComments: [finding({ body: p2Body('a') }), finding({ body: p2Body('b') })],
      reviews: [codexReview()],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(true);
    expect(r.p2Count).toBe(2);
    expect(r.rounds).toBe(1);
  });

  test('any P1 among the findings blocks', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 2, status: 'remediating', last_push_sha: HEAD }] });
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('a') }), finding({ body: p1Body('b') })] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/blocking findings/);
  });

  test('an unbadged finding fails CLOSED as P1', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD }] });
    const gh = makeGh({ reviewComments: [finding({ body: 'Fix this broken link please.' })] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
  });

  test('no remediation round spent yet → not eligible (P2s get one fix pass first)', async () => {
    const db = makeDb();
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('a') })] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/no remediation round/);
  });

  test('no findings tied to the current head → not eligible (pending/clean is the normal path)', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD }] });
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('stale'), commit_id: 'oldhead000' })] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/no findings/);
  });

  test('AUTONOMOUS_CODEX_P2_MERGE=false disables the bar', async () => {
    process.env.AUTONOMOUS_CODEX_P2_MERGE = 'false';
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD }] });
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('a') })] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/disabled/);
  });
});

describe('p2OnlyMergeEligible — same-head re-request handling (Codex round-2 P1)', () => {
  const p2At = (title, created_at) => finding({
    body: `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  ${title}**\n\ndetail`,
    created_at,
  });

  test('findings older than the latest same-head re-request do NOT qualify (pending review)', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD }] });
    const gh = makeGh({
      reviewComments: [p2At('old finding', '2026-07-17T01:00:00Z')],
      issueComments: [
        { body: `@codex review \`${HEAD}\``, created_at: '2026-07-17T00:50:00Z' },
        // usage-limit bounce → operator re-requested for the SAME head
        { body: `@codex review \`${HEAD}\``, created_at: '2026-07-17T02:00:00Z' },
      ],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/no response yet/);
  });

  test('findings posted after the latest same-head request + completed round qualify', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD }] });
    const gh = makeGh({
      reviewComments: [p2At('fresh finding', '2026-07-17T02:10:00Z')],
      issueComments: [{ body: `@codex review \`${HEAD}\``, created_at: '2026-07-17T02:00:00Z' }],
      reviews: [codexReview({ submitted_at: '2026-07-17T02:11:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(true);
    expect(r.p2Count).toBe(1);
  });

  test('undated findings fail closed when a request timestamp exists', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD }] });
    const gh = makeGh({
      reviewComments: [p2At('undated finding', null)],
      issueComments: [{ body: `@codex review \`${HEAD}\``, created_at: '2026-07-17T02:00:00Z' }],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
  });
});

describe('p2OnlyMergeEligible — timestamp-tie fail-closed (Codex round-3 P2)', () => {
  test('a finding stamped in the SAME second as the re-request does not qualify', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD }] });
    const gh = makeGh({
      reviewComments: [finding({ body: '**<sub><sub>![P2 Badge](x)</sub></sub>  tie**\n\nd', created_at: '2026-07-17T02:00:00Z' })],
      issueComments: [{ body: `@codex review \`${HEAD}\``, created_at: '2026-07-17T02:00:00Z' }],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/no response yet/);
  });
});

// Round-8 (Codex P1): Codex can flush inline comments INCREMENTALLY while a
// review round is still generating. A lone current-head P2 posted after the
// request must NOT arm the P2-only bar by itself — only a completed round
// (submitted codex review pinned to the head, or the top-level completion
// summary embedding the head SHA) may.
describe('p2OnlyMergeEligible — round-completion evidence (Codex round-8 P1)', () => {
  const p2At = (title, created_at) => finding({
    body: `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  ${title}**\n\ndetail`,
    created_at,
  });
  const REQUEST = { body: `@codex review \`${HEAD}\``, created_at: '2026-07-17T02:00:00Z' };
  const baseDb = () => makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD }] });

  test('a lone post-request P2 with NO submitted review or summary is still pending — not eligible', async () => {
    const gh = makeGh({
      reviewComments: [p2At('incremental first finding', '2026-07-17T02:10:00Z')],
      issueComments: [REQUEST],
      reviews: [],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: baseDb(), gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not completed/);
  });

  test('codex top-level completion summary with an abbreviated (10-char) reviewed-commit SHA completes the round', async () => {
    const gh = makeGh({
      reviewComments: [p2At('finding', '2026-07-17T02:10:00Z')],
      issueComments: [
        REQUEST,
        { user: { login: CODEX }, body: `Codex Review: Didn't find any major issues beyond the inline notes.\n\nReviewed commit: ${HEAD.slice(0, 10)}`, created_at: '2026-07-17T02:12:00Z' },
      ],
      reviews: [],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: baseDb(), gh });
    expect(r.eligible).toBe(true);
    expect(r.p2Count).toBe(1);
  });

  test('a submitted review pinned to a DIFFERENT head is not completion evidence', async () => {
    const gh = makeGh({
      reviewComments: [p2At('finding', '2026-07-17T02:10:00Z')],
      issueComments: [REQUEST],
      reviews: [codexReview({ commit_id: 'ffff999000aaa', submitted_at: '2026-07-17T02:12:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: baseDb(), gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not completed/);
  });

  test('a usage-limit bounce embedding the head SHA is a failed round, not completion', async () => {
    const gh = makeGh({
      reviewComments: [p2At('finding', '2026-07-17T02:10:00Z')],
      issueComments: [
        REQUEST,
        { user: { login: CODEX }, body: `You've reached your Codex usage limits. Reviewed commit: ${HEAD.slice(0, 10)}`, created_at: '2026-07-17T02:12:00Z' },
      ],
      reviews: [],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: baseDb(), gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not completed/);
  });

  test('a completion summary stamped in the SAME second as the request fails closed', async () => {
    const gh = makeGh({
      reviewComments: [p2At('finding', '2026-07-17T02:10:00Z')],
      issueComments: [
        REQUEST,
        { user: { login: CODEX }, body: `Codex Review complete. Reviewed commit: ${HEAD.slice(0, 10)}`, created_at: '2026-07-17T02:00:00Z' },
      ],
      reviews: [],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: baseDb(), gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not completed/);
  });

  test('a PENDING review object is not completion evidence', async () => {
    const gh = makeGh({
      reviewComments: [p2At('finding', '2026-07-17T02:10:00Z')],
      issueComments: [REQUEST],
      reviews: [codexReview({ state: 'PENDING', submitted_at: '2026-07-17T02:12:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: baseDb(), gh });
    expect(r.eligible).toBe(false);
  });

  test('a non-codex (human) review at the head is not codex completion evidence', async () => {
    const gh = makeGh({
      reviewComments: [p2At('finding', '2026-07-17T02:10:00Z')],
      issueComments: [REQUEST],
      reviews: [codexReview({ user: { login: 'adam' }, submitted_at: '2026-07-17T02:12:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: baseDb(), gh });
    expect(r.eligible).toBe(false);
  });

  test('review lookup unavailable fails CLOSED', async () => {
    const gh = makeGh({
      reviewComments: [p2At('finding', '2026-07-17T02:10:00Z')],
      issueComments: [REQUEST],
      gh: { listPrReviews: undefined },
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: baseDb(), gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/review lookup unavailable/);
  });
});

// Round-9 hardening:
//   P1 — a P0/P1 tied to the CURRENT head posted BEFORE a same-head
//        re-request is still an unresolved blocker; the request-timestamp
//        filter may only gate pending detection, never severity blocking.
//   P2 — rounds also counts failed attempts (no push); the bar additionally
//        requires the recorded SHA of an actually-pushed remediation commit.
describe('p2OnlyMergeEligible — round-9 hardening (Codex findings)', () => {
  const sevAt = (sev, title, created_at) => finding({
    body: `**<sub><sub>![${sev} Badge](https://img.shields.io/badge/${sev}-x?style=flat)</sub></sub>  ${title}**\n\ndetail`,
    created_at,
  });
  const REQUESTS = [
    { body: `@codex review \`${HEAD}\``, created_at: '2026-07-17T00:50:00Z' },
    // usage-limit bounce → operator re-requested for the SAME head
    { body: `@codex review \`${HEAD}\``, created_at: '2026-07-17T02:00:00Z' },
  ];
  const armedDb = () => makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD }] });

  test('a pre-re-request same-head P1 still blocks even when the re-review only adds P2s', async () => {
    const gh = makeGh({
      reviewComments: [
        sevAt('P1', 'older same-head blocker', '2026-07-17T01:00:00Z'),
        sevAt('P2', 'fresh nit', '2026-07-17T02:10:00Z'),
      ],
      issueComments: REQUESTS,
      reviews: [codexReview({ submitted_at: '2026-07-17T02:11:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: armedDb(), gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/blocking findings/);
  });

  test('pre-re-request same-head P2s stay counted (all-P2 head remains eligible)', async () => {
    const gh = makeGh({
      reviewComments: [
        sevAt('P2', 'older nit', '2026-07-17T01:00:00Z'),
        sevAt('P2', 'fresh nit', '2026-07-17T02:10:00Z'),
      ],
      issueComments: REQUESTS,
      reviews: [codexReview({ submitted_at: '2026-07-17T02:11:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: armedDb(), gh });
    expect(r.eligible).toBe(true);
    expect(r.p2Count).toBe(2);
  });

  test('rounds spent WITHOUT a recorded pushed remediation → not eligible (failed-attempt rounds)', async () => {
    // The no-valid-fix retry path increments rounds but never pushes —
    // last_push_sha stays unset and the bar must stay closed.
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 2, status: 'remediating' }] });
    const gh = makeGh({
      reviewComments: [sevAt('P2', 'nit', '2026-07-17T02:10:00Z')],
      issueComments: [REQUESTS[1]],
      reviews: [codexReview({ submitted_at: '2026-07-17T02:11:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/no pushed remediation commit/);
  });

  test('a STALE last_push_sha (≠ current head) does not vouch for the head — not eligible', async () => {
    // Park re-arm resets rounds but keeps last_push_sha as history. A
    // pre-park push plus a failed-attempt round on the NEW head must not
    // open the bar: the head under review must BE the recorded push.
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: 'stalepush000' }] });
    const gh = makeGh({
      reviewComments: [sevAt('P2', 'nit', '2026-07-17T02:10:00Z')],
      issueComments: [REQUESTS[1]],
      reviews: [codexReview({ submitted_at: '2026-07-17T02:11:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not the last pushed remediation commit/);
  });
});

// Round-10 (Codex P1): Codex can submit the round's REVIEW OBJECT with a
// usage-limit bounce in its body after an inline P2 already streamed in.
// That review is the round's failure artifact — treating it as completion
// evidence would let a partial round merge before its P0/P1s surfaced. The
// usage-limit rejection must cover review bodies exactly like issue-comment
// bodies.
describe('p2OnlyMergeEligible — usage-limit review bodies (Codex round-10 P1)', () => {
  const p2At = (title, created_at) => finding({
    body: `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  ${title}**\n\ndetail`,
    created_at,
  });
  const REQUEST = { body: `@codex review \`${HEAD}\``, created_at: '2026-07-17T02:00:00Z' };
  const armedDb = () => makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD }] });

  test('a submitted head-pinned review whose body is the usage-limit bounce is NOT completion evidence', async () => {
    const gh = makeGh({
      reviewComments: [p2At('partial-round P2', '2026-07-17T02:10:00Z')],
      issueComments: [REQUEST],
      reviews: [codexReview({ body: "You've reached your Codex usage limits.", submitted_at: '2026-07-17T02:12:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: armedDb(), gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not completed/);
  });

  test('the long-form bounce phrasing is rejected too', async () => {
    const gh = makeGh({
      reviewComments: [p2At('partial-round P2', '2026-07-17T02:10:00Z')],
      issueComments: [REQUEST],
      reviews: [codexReview({ body: `You've reached your Codex usage limits. Reviewed commit: ${HEAD.slice(0, 10)}`, submitted_at: '2026-07-17T02:12:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: armedDb(), gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not completed/);
  });

  test('a normal submitted review body still completes the round (no over-rejection)', async () => {
    const gh = makeGh({
      reviewComments: [p2At('finding', '2026-07-17T02:10:00Z')],
      issueComments: [REQUEST],
      reviews: [codexReview({ body: 'Codex Review: two inline notes, nothing blocking.', submitted_at: '2026-07-17T02:12:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: armedDb(), gh });
    expect(r.eligible).toBe(true);
    expect(r.p2Count).toBe(1);
  });

  test('an empty-body submitted review still completes (round-8 default shape intact)', async () => {
    const gh = makeGh({
      reviewComments: [p2At('finding', '2026-07-17T02:10:00Z')],
      issueComments: [REQUEST],
      reviews: [codexReview({ submitted_at: '2026-07-17T02:12:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: armedDb(), gh });
    expect(r.eligible).toBe(true);
  });

  test('a later clean completion summary recovers a usage-limit review round', async () => {
    const gh = makeGh({
      reviewComments: [p2At('finding', '2026-07-17T02:10:00Z')],
      issueComments: [
        REQUEST,
        { user: { login: CODEX }, body: `Codex Review complete. Reviewed commit: ${HEAD.slice(0, 10)}`, created_at: '2026-07-17T02:20:00Z' },
      ],
      reviews: [codexReview({ body: "You've reached your Codex usage limits.", submitted_at: '2026-07-17T02:12:00Z' })],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: armedDb(), gh });
    expect(r.eligible).toBe(true);
  });
});

describe('parked review-signal insurance (astro #394/#395 wedge, 2026-07-22)', () => {
  const parkedDb = () => makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'parked', parked_head_sha: HEAD, park_reason: 'fix changed frontmatter beyond the whitelist: meta_description changed but no finding in this round targets it' }] });

  test('same-head park + unreviewed head + ref confirms → posts a review request, park stands', async () => {
    const db = parkedDb();
    const gh = makeGh({ reviewComments: [], issueComments: [], reviews: [], gh: { getBranchSha: async () => HEAD } });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('parked (requested codex review for unreviewed head)');
    expect(gh._calls.comments).toHaveLength(1);
    expect(gh._calls.comments[0].body).toMatch(/@codex review/);
    expect(gh._calls.comments[0].body).toContain(HEAD);
    expect(gh._calls.putFile).toHaveLength(0);
    expect(db._tables.codex_remediation_state[0].status).toBe('parked');
  });

  test('request already posted for the head → plain parked hold, no duplicate request', async () => {
    const db = parkedDb();
    const gh = makeGh({ reviewComments: [], issueComments: [{ body: `@codex review\n\nRequesting Codex review for head \`${HEAD}\`` }], reviews: [], gh: { getBranchSha: async () => HEAD } });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true); expect(r.reason).toBe('parked');
    expect(gh._calls.comments).toHaveLength(0);
  });

  test('submitted review object for the head (new Codex format) counts as responded → plain parked hold', async () => {
    const db = parkedDb();
    const gh = makeGh({
      reviewComments: [],
      issueComments: [],
      reviews: [{ user: { login: 'chatgpt-codex-connector[bot]' }, state: 'COMMENTED', commit_id: HEAD, body: '### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** `abc1234def`', submitted_at: '2026-07-22T17:17:28Z' }],
      gh: { getBranchSha: async () => HEAD },
    });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true); expect(r.reason).toBe('parked');
    expect(gh._calls.comments).toHaveLength(0);
  });

  test('branch ref disagrees with the observed head → no request (stale read), parked hold', async () => {
    const db = parkedDb();
    const gh = makeGh({ reviewComments: [], issueComments: [], reviews: [], gh: { getBranchSha: async () => 'parallel777push' } });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true); expect(r.reason).toBe('parked');
    expect(gh._calls.comments).toHaveLength(0);
  });

  test('inline findings exist for the head → insurance no-ops, parked hold', async () => {
    const db = parkedDb();
    const gh = makeGh({ gh: { getBranchSha: async () => HEAD } });
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('X'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true); expect(r.reason).toBe('parked');
    expect(gh._calls.comments).toHaveLength(0);
  });
});

describe('p2OnlyMergeEligible — remediation-declined parks open the bar (2026-07-22 wedge)', () => {
  const p2Body = (title) => `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  ${title}**\n\ndetail`;
  const p1Body = (title) => `**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  ${title}**\n\ndetail`;
  const parkedDb = (reason, over = {}) => makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 0, status: 'parked', parked_head_sha: HEAD, park_reason: reason, ...over }] });

  test('whitelist park on the current head + all-P2 completed round → eligible (declined)', async () => {
    const db = parkedDb('fix changed frontmatter beyond the whitelist: hero_image.alt changed but no finding in this round targets it');
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('a') })], reviews: [codexReview()] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(true);
    expect(r.declined).toBe(true);
    expect(r.p2Count).toBe(1);
  });

  test('no-change park (false-positive findings) → eligible (declined)', async () => {
    const db = parkedDb('remediation produced no change (likely false-positive findings)');
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('a') })], reviews: [codexReview()] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(true);
    expect(r.declined).toBe(true);
  });

  test('declined park + any P1 finding still blocks', async () => {
    const db = parkedDb('fix changed frontmatter beyond the whitelist: meta_description changed but no finding in this round targets it');
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('a') }), finding({ body: p1Body('b') })], reviews: [codexReview()] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/blocking findings/);
  });

  test('infrastructure park (sync failure) does NOT open the bar — human hold', async () => {
    const db = parkedDb(`portal row sync failed after fix commit ${HEAD.slice(0, 7)}: boom`);
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('a') })], reviews: [codexReview()] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
  });

  test('a declined park on an OLDER head does not count for the current head', async () => {
    const db = parkedDb('fix changed frontmatter beyond the whitelist: x', { parked_head_sha: 'older9999999' });
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('a') })], reviews: [codexReview()] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
  });
});

describe('P3 badges are recognized as nonblocking (Codex round-1 on the declined-parks bar)', () => {
  const p2Body = (t) => `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  ${t}**\n\nd`;
  const p3Body = (t) => `**<sub><sub>![P3 Badge](https://img.shields.io/badge/P3-lightgrey?style=flat)</sub></sub>  ${t}**\n\nd`;

  test('findingSeverity parses a P3 badge as P3, not unbadged-P1', () => {
    expect(rem.findingSeverity(p3Body('nit'))).toBe('P3');
    expect(rem.findingSeverity('no badge at all')).toBe('P1');
  });

  test('declined park + P2/P3-only round → eligible (the astro #395 shape)', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 0, status: 'parked', parked_head_sha: HEAD, park_reason: 'remediation produced no change (likely false-positive findings)' }] });
    const gh = makeGh({
      reviewComments: [finding({ body: p2Body('a') }), finding({ body: p3Body('b') }), finding({ body: p3Body('c') })],
      reviews: [codexReview()],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(true);
    expect(r.p2Count).toBe(3);
  });
});

describe('validateRewrittenMeta enforces the blog meta contract (owner rule 2026-07-29)', () => {
  const CTX = { title: 'T', city: 'Sarasota', keyword: 'k', tag: 'pest-control' };

  test('a rewritten meta carrying a phone token (any grammar) parks', () => {
    for (const tok of ['{{cityPhone}}', '{{ cityPhone }}', '{{tel}}']) {
      const r = rem.validateRewrittenMeta(`Spider identification for Southwest Florida homes with the species that matter. Call ${tok} for details. Learn more.`, CTX);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/blog_meta_must_not_carry_phone/);
    }
  });

  test('a salesy rewritten meta parks', () => {
    const r = rem.validateRewrittenMeta('Spider identification for Southwest Florida homes — request a quote today and our local team will handle the widow species that matter fast.', CTX);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blog_meta_salesy/);
  });

  test('a rewritten meta without a final soft CTA does NOT park (owner ruling 2026-07-30: CTA is a nudge, never a blocker)', () => {
    const r = rem.validateRewrittenMeta('A no-panic Southwest Florida guide to spider identification covering the widow species, the recluse myth, and the harmless mosquito eaters.', CTX);
    expect(r.ok).toBe(true);
  });

  test('sales terms in the final sentence still park (Codex P1: not demoted with the CTA)', () => {
    const r = rem.validateRewrittenMeta('A no-panic Southwest Florida guide to spider identification covering the widow species and the recluse myth. Learn more about saving big with Waves.', CTX);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blog_meta_sales_copy/);
  });

  test('bare 10-digit phone in a rewritten meta still parks (Codex r4)', () => {
    const r = rem.validateRewrittenMeta('A Southwest Florida guide to spider identification covering the widow species and myths. Call 9412972606 for identification help today.', CTX);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blog_meta_must_not_carry_phone/);
  });
});

// ── astro #409 (2026-07-27): the pre-push park classes the bar didn't know ──
// PR #409 sat 2 days with 3 P2s. Round 1 pushed a fix; a stale getPr read
// parked it "moved past" its own push WITHOUT recording the round; the
// contradiction check re-armed with rounds reset to 0; the next round's fix
// tripped a guardrails false positive and parked "fix failed content gates" —
// a THIRD pre-push class the accepted-reasons whitelist didn't list. Net
// effect: two LLM rounds spent, state row reading rounds=0 /
// last_push_sha=null, and a P2-only head that could never merge.
describe('p2OnlyMergeEligible — pre-push parks open the bar (astro #409)', () => {
  const p2Body = (t) => `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  ${t}**\n\nd`;
  const p1Body = (t) => `**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  ${t}**\n\nd`;
  const parked = (reason, over = {}) => makeDb({
    codex_remediation_state: [{ pr_number: 5, rounds: 0, status: 'parked', parked_head_sha: HEAD, park_reason: reason, ...over }],
  });
  const allP2 = () => makeGh({ reviewComments: [finding({ body: p2Body('a') })], reviews: [codexReview()] });

  test('the exact #409 park reason opens the bar', async () => {
    const db = parked('fix failed content gates: guardrails UNKNOWN_INTERNAL_ROUTE');
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh: allP2() });
    expect(r.eligible).toBe(true);
    expect(r.declined).toBe(true);
  });

  // Allow-by-default is the point: these are pre-push verdicts nobody
  // enumerated, and each one used to starve the bar exactly like #409.
  test.each([
    ['schema-shape park', 'fix changes the body-derived schema types (frontmatter schema is frozen)'],
    ['MDX token park', 'fix introduces an MDX-breaking token ({{brandName}})'],
    ['meta-quality park', 'rewritten meta_description failed metadata quality checks: too short'],
    ['unresolvable target park', 'could not resolve target markdown file'],
    ['missing file park', 'file not found on branch: src/content/blog/x.mdx'],
    ['round-limit park', 'exhausted 3 remediation rounds'],
  ])('%s opens the bar (head is still the reviewed content)', async (_label, reason) => {
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: parked(reason), gh: allP2() });
    expect(r.eligible).toBe(true);
  });

  test('a P1 alongside the P2s still blocks a pre-push park', async () => {
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('a') }), finding({ body: p1Body('b') })], reviews: [codexReview()] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db: parked('fix failed content gates: x'), gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/blocking findings/);
  });

  // The divergence hold is the one thing that must NOT fail open — and it has
  // to survive last_push_sha == head, which is now the normal state for a
  // post-push park (bookkeeping moved to push time).
  test.each([
    ['moved-past', `pr head moved past the remediation push (${HEAD.slice(0, 7)} → other12); sync withheld`],
    ['revalidation-failed', `post-push PR revalidation failed (fix commit ${HEAD.slice(0, 7)} pushed, sync withheld): gh 502`],
    ['row-sync-failed', `portal row sync failed after fix commit ${HEAD.slice(0, 7)}: boom`],
  ])('%s park still blocks even with last_push_sha == head', async (_label, reason) => {
    const db = parked(reason, { rounds: 1, last_push_sha: HEAD });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh: allP2() });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/branch-mutating/);
  });

  test('a pre-push park on an OLDER head does not count for the current head', async () => {
    const db = parked('fix failed content gates: x', { parked_head_sha: 'older9999999' });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh: allP2() });
    expect(r.eligible).toBe(false);
  });

  test('isPostPushPark classifies only the three branch-mutating reasons', () => {
    expect(rem.isPostPushPark('pr head moved past the remediation push (a → b)')).toBe(true);
    expect(rem.isPostPushPark('post-push PR revalidation failed (fix commit abc pushed)')).toBe(true);
    expect(rem.isPostPushPark('portal row sync failed after fix commit abc: boom')).toBe(true);
    expect(rem.isPostPushPark('fix failed content gates: guardrails UNKNOWN_INTERNAL_ROUTE')).toBe(false);
    expect(rem.isPostPushPark('remediation produced no change (likely false-positive findings)')).toBe(false);
    expect(rem.isPostPushPark(null)).toBe(false);
  });
});

// The round record must exist the moment the commit does. Every park between
// the push and the old end-of-function write used to discard it, which both
// un-bounded LLM spend (MAX_ROUNDS never arrives) and hid the pushed commit
// from the P2 bar.
describe('round bookkeeping is written at push time (astro #409)', () => {
  test('a post-push revalidation park still records rounds + last_push_sha', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    // Healthy on the pre-push state check, 502 on the post-push revalidation —
    // that window is the one the old end-of-function write lost the round in.
    const gh = makeGh();
    gh.getPr = async () => {
      if (gh._calls.putFile.length) throw new Error('gh 502');
      return { state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } };
    };
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.parked).toBe(true);
    expect(r.reason).toMatch(/revalidation failed/);
    const row = db._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(row.rounds).toBe(1);
    expect(row.last_push_sha).toBe('newcommit999aaa');
  });

  test('a portal-row-sync park still records the round', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh();
    const r = await runRemediationForPr(
      { ...CTX, onRemediated: async () => { throw new Error('row sync boom'); } },
      { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS },
    );
    expect(r.parked).toBe(true);
    const row = db._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(row.rounds).toBe(1);
    expect(row.last_push_sha).toBe('newcommit999aaa');
  });

  test('a PRE-push park records no round (nothing was committed)', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh();
    const r = await runRemediationForPr(CTX, {
      db, gh, callAnthropic: makeCall('FIXED'),
      validateFixedBlogFile: () => ({ ok: false, reason: 'guardrails UNKNOWN_INTERNAL_ROUTE' }),
    });
    expect(r.parked).toBe(true);
    const row = db._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(row.rounds || 0).toBe(0);
    expect(row.last_push_sha ?? null).toBeNull();
    expect(gh._calls.putFile).toHaveLength(0);
  });
});

// A same-head re-arm must not hand out a fresh round budget. #409's stale
// 'moved past' park re-armed on the SAME head with rounds reset to 0, so the
// loop re-ran round "1" indefinitely and the bar saw no round spent.
describe('same-head contradiction re-arm preserves the round count (astro #409)', () => {
  test("stale 'moved past' re-arm keeps rounds; a NEW head resets them", async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    // Parked on the sha the branch ref still reports as the tip → the park's
    // premise ("something moved past us") is contradicted, so it re-arms.
    const stale = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 2, status: 'parked', last_push_sha: 'newcommit999aaa',
        parked_head_sha: 'newcommit999aaa',
        park_reason: 'pr head moved past the remediation push (newcomm → older1); sync withheld',
      }],
    });
    // Findings must be pinned to the re-armed head, or the round no-ops on
    // "no fresh findings" and never exercises the round counter.
    const gh = makeGh({
      reviewComments: [finding({ commit_id: 'newcommit999aaa' })],
      gh: { getPr: async () => ({ state: 'open', head: { sha: 'newcommit999aaa', ref: 'content/blog-x' } }) },
    });
    await runRemediationForPr(CTX, { db: stale, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    const row = stale._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(row.rounds).toBe(3); // 2 preserved + this round, NOT reset to 0 then 1

    // Contrast: a genuinely NEW head is what earns a fresh budget.
    const advanced = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 2, status: 'parked', parked_head_sha: 'oldhead111',
        park_reason: 'fix failed content gates: guardrails UNKNOWN_INTERNAL_ROUTE',
      }],
    });
    await runRemediationForPr(CTX, { db: advanced, gh: makeGh(), callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    const row2 = advanced._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(row2.rounds).toBe(1); // reset, then this round
  });
});

// park_phase replaces prose-matching as the merge-safety boundary (Codex P1 on
// this change). Whether a P2-only head may merge must not hinge on a park_reason
// string prefix: rename a reason or add a post-push failure path and a
// branch-mutating park would silently read as pre-push.
describe('park_phase is the structured merge-safety boundary', () => {
  const p2Body = (t) => `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  ${t}**\n\nd`;
  const allP2 = () => makeGh({ reviewComments: [finding({ body: p2Body('a') })], reviews: [codexReview()] });
  const row = (over) => makeDb({
    codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'parked', parked_head_sha: HEAD, ...over }],
  });

  test('park_phase=post_push blocks even when the reason prose looks pre-push', async () => {
    const db = row({ park_phase: 'post_push', park_reason: 'totally renamed reason nobody enumerated' });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh: allP2() });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/branch-mutating/);
  });

  test('park_phase=pre_push opens the bar even when the prose looks post-push', async () => {
    const db = row({ park_phase: 'pre_push', park_reason: 'portal row sync failed after fix commit abc: misleading' });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh: allP2() });
    expect(r.eligible).toBe(true);
  });

  test('an UNKNOWN phase fails closed (treated as branch-mutating)', async () => {
    const db = row({ park_phase: 'some_future_phase', park_reason: 'fix failed content gates: x' });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh: allP2() });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/branch-mutating/);
  });

  test('NULL phase (legacy row) falls back to the reason prefix, both ways', async () => {
    const pre = row({ park_phase: null, park_reason: 'fix failed content gates: guardrails UNKNOWN_INTERNAL_ROUTE' });
    expect((await rem.p2OnlyMergeEligible(5, HEAD, { db: pre, gh: allP2() })).eligible).toBe(true);
    const post = row({ park_phase: null, park_reason: `portal row sync failed after fix commit ${HEAD.slice(0, 7)}: boom` });
    expect((await rem.p2OnlyMergeEligible(5, HEAD, { db: post, gh: allP2() })).eligible).toBe(false);
  });

  test('isPostPushPark prefers the column over the prose, and fails closed on unknowns', () => {
    expect(rem.isPostPushPark({ park_phase: 'post_push', park_reason: 'fix failed content gates: x' })).toBe(true);
    expect(rem.isPostPushPark({ park_phase: 'pre_push', park_reason: 'portal row sync failed after fix commit a: b' })).toBe(false);
    expect(rem.isPostPushPark({ park_phase: 'nonsense' })).toBe(true);
    expect(rem.isPostPushPark({ park_phase: null, park_reason: 'post-push PR revalidation failed (x)' })).toBe(true);
    expect(rem.isPostPushPark({ park_phase: null, park_reason: 'remediation produced no change' })).toBe(false);
    expect(rem.isPostPushPark('post-push PR revalidation failed (x)')).toBe(true); // legacy string arg
  });
});

// Every park call site must stamp a phase, and the phase must match where in the
// round it fired — otherwise the column silently degrades to the legacy path.
describe('park() stamps the correct phase at each call site', () => {
  test('a PRE-push gate failure stamps pre_push', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh();
    await runRemediationForPr(CTX, {
      db, gh, callAnthropic: makeCall('FIXED'),
      validateFixedBlogFile: () => ({ ok: false, reason: 'guardrails UNKNOWN_INTERNAL_ROUTE' }),
    });
    const r = db._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(r.park_phase).toBe('pre_push');
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('a POST-push revalidation failure stamps post_push', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh();
    gh.getPr = async () => {
      if (gh._calls.putFile.length) throw new Error('gh 502');
      return { state: 'open', head: { sha: HEAD, ref: 'content/blog-x' } };
    };
    await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    const r = db._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(r.park_phase).toBe('post_push');
    expect(gh._calls.putFile).toHaveLength(1);
  });

  test('a POST-push row-sync failure stamps post_push', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    await runRemediationForPr(
      { ...CTX, onRemediated: async () => { throw new Error('row sync boom'); } },
      { db, gh: makeGh(), callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS },
    );
    const r = db._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(r.park_phase).toBe('post_push');
  });

  test('a re-arm clears the phase with the rest of the park verdict', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'parked', parked_head_sha: 'oldhead111',
        park_phase: 'post_push', park_reason: 'portal row sync failed after fix commit old: boom',
      }],
    });
    await runRemediationForPr(CTX, { db, gh: makeGh(), callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    const r = db._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    // Head advanced → re-armed and this round pushed; the stale post_push must
    // not survive to keep the bar shut on a head it no longer judges.
    expect(r.park_phase ?? null).toBeNull();
    expect(r.status).toBe('remediating');
  });
});

// The WRITE side must fail closed too. isPostPushPark treats an unknown phase as
// branch-mutating, but that is useless if park() normalizes unknown/omitted
// values to the permissive 'pre_push' before they are ever persisted — a future
// post-push exit that forgets the argument would open the merge bar.
describe('park() fails closed on an omitted or unrecognized phase', () => {
  const parkFn = rem._internals.park;

  test.each([
    ['omitted', undefined],
    ['null', null],
    ['misspelled', 'post-push'],
    ['nonsense', 'later'],
  ])('phase %s is persisted as post_push', async (_label, phase) => {
    const db = makeDb();
    await parkFn(db, 5, 'some new failure path', null, HEAD, phase);
    const row = db._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(row.park_phase).toBe('post_push');
    // And the bar must actually stay shut on it.
    const gh = makeGh({
      reviewComments: [finding({ body: `**<sub><sub>![P2 Badge](x)</sub></sub>  a**\n\nd` })],
      reviews: [codexReview()],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
  });

  test('only the exact pre_push constant yields pre_push', async () => {
    const db = makeDb();
    await parkFn(db, 7, 'pre-push verdict', null, HEAD, 'pre_push');
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 7).park_phase).toBe('pre_push');
  });
});

// A concurrent merge/close tombstone must stop the round at the push-time
// bookkeeping write, before onRemediated can mirror a commit that never entered
// main into portal state.
describe('push-time bookkeeping respects a terminal row', () => {
  test('a merged tombstone stops the round before the post-commit sync', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh();
    const onRemediated = jest.fn();
    // The PR merges during the fix push: the row goes terminal right after the
    // pre-push 'remediating' save, so the push-time save loses the race.
    let pushed = false;
    const origPut = gh.putFile;
    gh.putFile = async (args) => {
      const res = await origPut(args);
      pushed = true;
      await rem.markPrTerminal(5, 'merged', db);
      return res;
    };
    const r = await runRemediationForPr({ ...CTX, onRemediated }, {
      db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
    });
    expect(pushed).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/terminal row at push-time bookkeeping/);
    expect(onRemediated).not.toHaveBeenCalled();
    expect(gh._calls.comments).toHaveLength(0);
    // The terminal stamp stands; the round did not resurrect the row.
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 5).status).toBe('merged');
  });
});

// An unsynced push is a fact about the repo, not a verdict on a head, so it must
// outlive the park that noticed it. Codex's scenario: a post-push park withholds
// onRemediated, the stale-'moved past' recovery clears the park, a later round
// parks PRE-push on the same head, and the bar would then merge a commit whose
// portal row still holds the pre-fix body.
describe('sync_pending_sha survives re-arm and blocks the bar (codex P1)', () => {
  const p2Body = (t) => `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  ${t}**\n\nd`;
  const allP2 = () => makeGh({ reviewComments: [finding({ body: p2Body('a') })], reviews: [codexReview()] });

  test('a pre-push park on a head whose push never synced still blocks', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 3, status: 'parked', parked_head_sha: HEAD,
        park_phase: 'pre_push', park_reason: 'exhausted 3 remediation rounds',
        last_push_sha: HEAD,
        sync_pending_sha: HEAD, // withheld by an earlier post-push park
      }],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh: allP2() });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/unfinished portal sync/);
  });

  test('with the sync completed, the same row IS eligible', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 3, status: 'parked', parked_head_sha: HEAD,
        park_phase: 'pre_push', park_reason: 'exhausted 3 remediation rounds',
        last_push_sha: HEAD, sync_pending_sha: null,
      }],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh: allP2() });
    expect(r.eligible).toBe(true);
  });

  // A pending sync on an EARLIER push still blocks: a human's descendant push
  // contains that commit's content, so merging it ships the fix while the portal
  // row is still pre-fix and a later republish resurrects the stale body.
  test('a pending sync on an earlier push blocks a descendant head too', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'remediating',
        last_push_sha: HEAD, sync_pending_sha: 'oldpush000111',
      }],
    });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh: allP2() });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/unfinished portal sync/);
    expect(r.reason).toMatch(/ancestor of the head under review/);
  });

  test('the push-time write stamps it, and only a completed sync clears it', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    // Withheld sync (row-sync throw) → stamped and left set.
    const withheld = makeDb();
    await runRemediationForPr(
      { ...CTX, onRemediated: async () => { throw new Error('row sync boom'); } },
      { db: withheld, gh: makeGh(), callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS },
    );
    expect(withheld._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha)
      .toBe('newcommit999aaa');

    // Completed sync → cleared.
    const ok = makeDb();
    const onRemediated = jest.fn();
    const r = await runRemediationForPr({ ...CTX, onRemediated }, {
      db: ok, gh: makeGh(), callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
    });
    expect(r.remediated).toBe(true);
    expect(onRemediated).toHaveBeenCalled();
    expect(ok._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha ?? null).toBeNull();
  });

  test('a stale-moved-past re-arm clears the park but NOT the pending sync', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 2, status: 'parked',
        parked_head_sha: 'newcommit999aaa', last_push_sha: 'newcommit999aaa',
        park_phase: 'post_push', sync_pending_sha: 'newcommit999aaa',
        park_reason: 'pr head moved past the remediation push (newcomm → older1); sync withheld',
      }],
    });
    // No findings for the re-armed head → the round no-ops, so nothing re-syncs.
    const gh = makeGh({
      reviewComments: [],
      gh: { getPr: async () => ({ state: 'open', head: { sha: 'newcommit999aaa', ref: 'content/blog-x' } }) },
    });
    await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    const row = db._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(row.park_phase ?? null).toBeNull();      // park verdict released
    expect(row.sync_pending_sha).toBe('newcommit999aaa'); // divergence hold kept
    // And the bar honors it on that head.
    const r = await rem.p2OnlyMergeEligible(5, 'newcommit999aaa', { db, gh: allP2() });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/unfinished portal sync/);
  });
});

// The hold must exist BEFORE the push, or a crash between gh.putFile returning
// and the bookkeeping write leaves an unsynced commit with no hold — and the
// 'remediating' recovery branch only re-requests review, it never re-syncs.
describe('the sync hold is taken before the push (codex P1)', () => {
  const p2Body = (t) => `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  ${t}**\n\nd`;

  test('the pre-push write stamps the in-flight sentinel', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh();
    let atPushTime = null;
    const origPut = gh.putFile;
    gh.putFile = async (args) => {
      // Observe the row as the push lands — this is the crash window.
      atPushTime = { ...db._tables.codex_remediation_state.find((x) => x.pr_number === 5) };
      return origPut(args);
    };
    await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(atPushTime.sync_pending_sha).toBe(`push_in_flight:${HEAD}`);
    expect(atPushTime.status).toBe('remediating');
  });

  test('a row left mid-window blocks the bar (simulated crash)', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'remediating',
        last_push_sha: HEAD, sync_pending_sha: 'push_in_flight',
      }],
    });
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('a') })], reviews: [codexReview()] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/in flight and never confirmed/);
  });

  // A putFile throw is ambiguous (GitHub may have committed and failed the
  // response) and an immediate ref read can still serve the OLD head, so NO
  // outcome of the push clears the hold here. Releasing it is the aged-sentinel
  // path's job, where the ref has had time to settle.
  test.each([
    ['an UNCHANGED ref', async () => HEAD],
    ['a CHANGED ref', async () => 'somethingelse999'],
    ['an UNREADABLE ref', async () => { throw new Error('ref lookup down'); }],
  ])('a push failure with %s keeps the hold (fail closed)', async (_label, getBranchSha) => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh();
    gh.putFile = async () => { throw new Error('gh 502'); };
    gh.getBranchSha = getBranchSha;
    await expect(runRemediationForPr(CTX, {
      db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
    })).rejects.toThrow('gh 502');
    const row = db._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(row.sync_pending_sha).toBe(`push_in_flight:${HEAD}`);
  });
});

// The hold has to gate EVERY merge path. p2OnlyMergeEligible only runs when the
// review is NOT clean, so a hold checked only there is invisible to the common
// case: a clean review merging normally while portal state is still pre-fix.
describe('syncPendingHold is a standalone, all-paths gate (codex P1)', () => {
  test('reports a pending hold with a diagnosable reason', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, sync_pending_sha: HEAD, status: 'remediating' }] });
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD });
    expect(h.pending).toBe(true);
    expect(h.sha).toBe(HEAD);
    expect(h.reason).toMatch(/unfinished portal sync/);
  });

  test('names an ancestor push distinctly from the head under review', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, sync_pending_sha: 'oldpush000111' }] });
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD });
    expect(h.pending).toBe(true);
    expect(h.reason).toMatch(/ancestor of the head under review/);
  });

  test('the in-flight sentinel reads as an unconfirmed push', async () => {
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, sync_pending_sha: 'push_in_flight' }] });
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD });
    expect(h.reason).toMatch(/in flight and never confirmed/);
  });

  test('no row, or a cleared column, is not a hold', async () => {
    expect((await rem.syncPendingHold(5, { db: makeDb(), headSha: HEAD })).pending).toBe(false);
    const cleared = makeDb({ codex_remediation_state: [{ pr_number: 5, sync_pending_sha: null }] });
    expect((await rem.syncPendingHold(5, { db: cleared, headSha: HEAD })).pending).toBe(false);
  });

});

// Two failure modes of the hold itself: it must not permit a merge when it can't
// be read, and it must not hold forever when nothing was ever pushed.
describe('syncPendingHold error and recovery behavior (codex P1 x2)', () => {
  test('a lookup error fails CLOSED — a merge-safety gate must not open on a blip', async () => {
    const db = () => { throw new Error('db down'); };
    db.raw = async () => ({ rowCount: 0 });
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD });
    expect(h.pending).toBe(true);
    expect(h.reason).toMatch(/could not read the remediation sync state/);
  });

  // Aged well past STALE_IN_FLIGHT_MS: no live round can still be pre-push.
  const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  test('an ABANDONED in-flight sentinel is released when the branch never moved', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, status: 'remediating', sync_pending_sha: `push_in_flight:${HEAD}`, updated_at: OLD,
      }],
    });
    // Ref still at the pre-push head → the round died before gh.putFile.
    const gh = { getBranchSha: async () => HEAD };
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD, gh, branch: 'content/blog-x' });
    expect(h.pending).toBe(false);
    // And it is cleared, so the release is durable rather than re-derived.
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha).toBeNull();
  });

  // The merge gate is not serialized against remediation, so a RECENT sentinel
  // may be a healthy round sitting in its legitimate stamp→putFile window.
  // Clearing it there could release the hold on a push that then lands.
  test('a FRESH in-flight sentinel holds and is never cleared', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, status: 'remediating', sync_pending_sha: `push_in_flight:${HEAD}`,
        updated_at: new Date().toISOString(),
      }],
    });
    let refReads = 0;
    const gh = { getBranchSha: async () => { refReads += 1; return HEAD; } };
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD, gh, branch: 'content/blog-x' });
    expect(h.pending).toBe(true);
    expect(h.reason).toMatch(/in flight/);
    expect(refReads).toBe(0); // decided on age alone, before any ref read
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha)
      .toBe(`push_in_flight:${HEAD}`);
  });

  test('a MISSING updated_at holds — "0" must not parse as the year 2000', async () => {
    const db = makeDb({
      codex_remediation_state: [{ pr_number: 5, status: 'remediating', sync_pending_sha: `push_in_flight:${HEAD}` }],
    });
    const gh = { getBranchSha: async () => HEAD };
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD, gh, branch: 'content/blog-x' });
    expect(h.pending).toBe(true);
    expect(h.reason).toMatch(/age unknown/);
  });

  test('an in-flight sentinel HOLDS when the branch moved (a push did land)', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, status: 'remediating', sync_pending_sha: `push_in_flight:${HEAD}`, updated_at: OLD,
      }],
    });
    const gh = { getBranchSha: async () => 'landedcommit123' };
    const h = await rem.syncPendingHold(5, { db, headSha: 'landedcommit123', gh, branch: 'content/blog-x' });
    expect(h.pending).toBe(true);
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha)
      .toBe(`push_in_flight:${HEAD}`);
  });

  test('an unreadable ref HOLDS (fail closed)', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, status: 'remediating', sync_pending_sha: `push_in_flight:${HEAD}`, updated_at: OLD,
      }],
    });
    const gh = { getBranchSha: async () => { throw new Error('ref lookup down'); } };
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD, gh, branch: 'content/blog-x' });
    expect(h.pending).toBe(true);
  });

  test('without a branch to reconcile against, an in-flight sentinel HOLDS', async () => {
    const db = makeDb({
      codex_remediation_state: [{ pr_number: 5, sync_pending_sha: `push_in_flight:${HEAD}` }],
    });
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD });
    expect(h.pending).toBe(true);
    expect(h.reason).toMatch(/pre-push head/);
  });

  test('a real commit SHA hold is never reconciled away by the ref check', async () => {
    const db = makeDb({
      codex_remediation_state: [{ pr_number: 5, status: 'parked', sync_pending_sha: HEAD }],
    });
    const gh = { getBranchSha: async () => HEAD };
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD, gh, branch: 'content/blog-x' });
    expect(h.pending).toBe(true);
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha).toBe(HEAD);
  });
});

// The autonomous mirror is fail-soft by design (a caption isn't worth parking a
// pushed fix over) and its documented degradation is a title-only card. But the
// poller reads draft_payload.frontmatter.meta_description directly, so a FAILED
// mirror left the pre-fix description in place and published exactly the copy
// Codex flagged. These drive the real mirror function, not a copy of it.
describe('mirrorFrontmatterToDraftPayload', () => {
  const { mirrorFrontmatterToDraftPayload: mirror } = rem;

  // Minimal autonomous_runs stub; failUpdates makes the first N updates throw.
  const makeRunDb = (payload, { failUpdates = 0 } = {}) => {
    const rows = [{ id: 'run-1', draft_payload: payload === null ? null : JSON.stringify(payload) }];
    let updates = 0;
    const db = () => {
      let crit = {};
      return {
        where(c) { crit = c; return this; },
        async first() { return rows.find((r) => r.id === crit.id) || null; },
        async update(patch) {
          updates += 1;
          if (updates <= failUpdates) throw new Error('update boom');
          const r = rows.find((x) => x.id === crit.id);
          if (r) Object.assign(r, patch);
          return 1;
        },
      };
    };
    db._payload = () => (rows[0].draft_payload ? JSON.parse(rows[0].draft_payload) : rows[0].draft_payload);
    db._updates = () => updates;
    return db;
  };

  test('a successful mirror writes the fixed values', async () => {
    const db = makeRunDb({ frontmatter: { meta_description: 'PRE-FIX', title: 'T' } });
    await mirror(db, 'run-1', 9, { meta_description: 'FIXED copy' });
    expect(db._payload().frontmatter.meta_description).toBe('FIXED copy');
    expect(db._payload().frontmatter.title).toBe('T');
  });

  test('hero_alt merges into hero_image without dropping siblings', async () => {
    const db = makeRunDb({ frontmatter: { hero_image: { src: '/a.webp', alt: 'old' } } });
    await mirror(db, 'run-1', 9, { hero_alt: 'new alt' });
    expect(db._payload().frontmatter.hero_image).toEqual({ src: '/a.webp', alt: 'new alt' });
  });

  test('a FAILED mirror removes the stale excerpt so the share degrades to title-only', async () => {
    const db = makeRunDb({ frontmatter: { meta_description: 'PRE-FIX copy Codex flagged', title: 'T' } }, { failUpdates: 1 });
    await mirror(db, 'run-1', 9, { meta_description: 'FIXED copy' });
    const stored = db._payload();
    expect(stored.frontmatter.meta_description).toBeUndefined(); // no pre-fix copy left to publish
    expect(stored.frontmatter.title).toBe('T');                 // rest of the payload survives
    expect(db._updates()).toBe(2);                              // failed write, then the clear
  });

  test('it never throws even when BOTH writes fail', async () => {
    const db = makeRunDb({ frontmatter: { meta_description: 'PRE-FIX' } }, { failUpdates: 2 });
    await expect(mirror(db, 'run-1', 9, { meta_description: 'FIXED' })).resolves.toBeUndefined();
  });

  test('a hero_alt-only failure does not touch meta_description', async () => {
    const db = makeRunDb({ frontmatter: { meta_description: 'KEEP ME', hero_image: { alt: 'old' } } }, { failUpdates: 1 });
    await mirror(db, 'run-1', 9, { hero_alt: 'new' });
    expect(db._payload().frontmatter.meta_description).toBe('KEEP ME');
    expect(db._updates()).toBe(1); // no clear attempted — nothing stale to clear
  });

  test('no changes, no row, and a null payload are all no-ops', async () => {
    const db = makeRunDb({ frontmatter: { meta_description: 'X' } });
    await mirror(db, 'run-1', 9, null);
    await mirror(db, 'run-1', 9, {});
    expect(db._updates()).toBe(0);
    const empty = makeRunDb(null);
    await mirror(empty, 'run-1', 9, { meta_description: 'Y' });
    expect(empty._updates()).toBe(0);
  });
});

// The release decision is made against a snapshot, so the clear must be a
// compare-and-set. A fresh round can stamp a new sentinel and start pushing between
// the read and the write; a blanket clear would erase that LIVE hold, and if the new
// push landed and crashed before recording its SHA, a later clean review could merge
// unsynchronized content.
describe('the stale-sentinel release is a compare-and-set', () => {
  const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  test('a sentinel refreshed under us is NOT cleared', async () => {
    const rows = [{
      pr_number: 5, status: 'remediating', sync_pending_sha: `push_in_flight:${HEAD}`, updated_at: OLD,
    }];
    let firstRead = true;
    const db = () => {
      let crit = {};
      let olderThanMs = null;
      return {
        where(c) { crit = c; return this; },
        whereRaw(sql, params = []) {
          if (/updated_at < NOW\(\)/.test(sql)) olderThanMs = params[0];
          return this;
        },
        async first() {
          const row = rows.find((r) => r.pr_number === crit.pr_number);
          if (!row) return null;
          const snap = { ...row };
          if (firstRead) {
            firstRead = false;
            // A new round stamps a fresh sentinel right after this read.
            row.sync_pending_sha = 'push_in_flight:newerhead999';
            row.updated_at = new Date().toISOString();
          }
          return snap;
        },
        async update(patch) {
          const row = rows.find((r) => r.pr_number === crit.pr_number
            && (crit.sync_pending_sha === undefined || r.sync_pending_sha === crit.sync_pending_sha)
            && (olderThanMs === null
              || (Date.now() - new Date(r.updated_at).getTime()) > olderThanMs));
          if (!row) return 0; // CAS lost — sentinel changed or row was refreshed
          Object.assign(row, patch);
          return 1;
        },
      };
    };
    const gh = { getBranchSha: async () => HEAD };
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD, gh, branch: 'content/blog-x' });
    expect(h.pending).toBe(true);
    expect(h.reason).toMatch(/changed while it was being evaluated/);
    // The newer round's hold survived untouched.
    expect(rows[0].sync_pending_sha).toBe('push_in_flight:newerhead999');
  });

  test('an unchanged row IS cleared (the CAS matches)', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, status: 'remediating', sync_pending_sha: `push_in_flight:${HEAD}`, updated_at: OLD,
      }],
    });
    const gh = { getBranchSha: async () => HEAD };
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD, gh, branch: 'content/blog-x' });
    expect(h.pending).toBe(false);
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha).toBeNull();
  });
});

// Arming a push must PRESERVE an existing unsynced-push hold. Overwriting it lost
// real state: push B never syncs, a human advances the branch to C, remediation's
// push from C fails before committing, and the fresh in-flight sentinel is later
// reconciled away as "nothing landed" — forgetting B, letting C merge, and letting a
// rebuild resurrect pre-B portal content.
describe('armPushHold preserves an existing sync hold', () => {
  test('an existing real-SHA hold survives arming a new round', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'parked', parked_head_sha: 'oldhead111',
        park_phase: 'post_push', sync_pending_sha: 'unsyncedpushB',
        park_reason: 'portal row sync failed after fix commit unsynce: boom',
      }],
    });
    let atPushTime = null;
    const gh = makeGh();
    const origPut = gh.putFile;
    gh.putFile = async (args) => {
      atPushTime = { ...db._tables.codex_remediation_state.find((x) => x.pr_number === 5) };
      return origPut(args);
    };
    await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    // B's hold was NOT replaced by the in-flight sentinel while arming.
    expect(atPushTime.sync_pending_sha).toBe('unsyncedpushB');
    expect(atPushTime.status).toBe('remediating');
  });

  test('with no existing hold, arming stamps the in-flight sentinel', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const gh = makeGh();
    let atPushTime = null;
    const origPut = gh.putFile;
    gh.putFile = async (args) => {
      atPushTime = { ...db._tables.codex_remediation_state.find((x) => x.pr_number === 5) };
      return origPut(args);
    };
    await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(atPushTime.sync_pending_sha).toBe(`push_in_flight:${HEAD}`);
  });

  test('a terminal row refuses the arm, so nothing is pushed', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({ codex_remediation_state: [{ pr_number: 5, rounds: 1, status: 'merged' }] });
    const gh = makeGh();
    const r = await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.skipped).toBe(true);
    expect(gh._calls.putFile).toHaveLength(0);
  });

  test('a confirmed push replaces the hold with the new commit', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'parked', parked_head_sha: 'oldhead111',
        sync_pending_sha: 'unsyncedpushB', park_phase: 'pre_push',
      }],
    });
    // No onRemediated → nothing to sync → the hold clears on the success path,
    // which is what resolves B too (the sync mirrors the full current body).
    const r = await runRemediationForPr(CTX, { db, gh: makeGh(), callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(r.remediated).toBe(true);
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha).toBeNull();
  });
});

// A real-SHA hold on a 'remediating' row is AMBIGUOUS: the release write may have
// failed after a completed sync, or the process may have died before the sync ran at
// all. The recovery branch must not guess — a blind replay cleared the hold while
// syncing nothing (autonomous PRs resolve no markdown) and dropped the metadata
// delta, turning a safe stalled merge into a silent stale-content publish.
describe('the awaiting-re-review branch never clears a sync hold', () => {
  test('a held row is left held, and the review request still goes out', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'remediating',
        last_push_sha: HEAD, sync_pending_sha: HEAD,
      }],
    });
    // No findings for the head → the recovery branch runs.
    const gh = makeGh({ reviewComments: [], issueComments: [] });
    const onRemediated = jest.fn();
    const r = await runRemediationForPr({ ...CTX, onRemediated }, {
      db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
    });
    expect(r.skipped).toBe(true);
    expect(onRemediated).not.toHaveBeenCalled();          // no blind replay
    expect(gh._calls.putFile).toHaveLength(0);            // nothing pushed
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha).toBe(HEAD);
  });

  test('the hold keeps blocking the merge gate while it stands', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'remediating', last_push_sha: HEAD, sync_pending_sha: HEAD,
      }],
    });
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD, branch: 'content/blog-x' });
    expect(h.pending).toBe(true);
  });
});

// synced_sha makes a lost release recoverable WITHOUT a replay. Ordering is the
// point: it is written before the hold is cleared, so "synced_sha === pending" is
// exactly "the sync finished, only the release was lost".
describe('synced_sha recovers a lost hold release', () => {
  const p2Body = (t) => `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  ${t}**\n\nd`;

  test('the merge gate clears a hold whose sync is recorded complete', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'remediating',
        last_push_sha: HEAD, sync_pending_sha: HEAD, synced_sha: HEAD,
      }],
    });
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD, branch: 'content/blog-x' });
    expect(h.pending).toBe(false);
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha).toBeNull();
  });

  // This is the case that would otherwise wedge forever: a clean review never
  // re-enters remediation, so the gate itself has to do the recovery.
  test('recovery works even though remediation would never run again', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'remediating', sync_pending_sha: HEAD, synced_sha: HEAD,
      }],
    });
    const first = await rem.syncPendingHold(5, { db, headSha: HEAD, branch: 'content/blog-x' });
    expect(first.pending).toBe(false);
    // Idempotent: a second pass sees no hold at all.
    const second = await rem.syncPendingHold(5, { db, headSha: HEAD, branch: 'content/blog-x' });
    expect(second.pending).toBe(false);
  });

  test('a synced_sha for a DIFFERENT commit does not release the hold', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'remediating', sync_pending_sha: HEAD, synced_sha: 'someothercommit',
      }],
    });
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD, branch: 'content/blog-x' });
    expect(h.pending).toBe(true);
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha).toBe(HEAD);
  });

  test('a successful round records synced_sha alongside clearing the hold', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb();
    const onRemediated = jest.fn();
    const r = await runRemediationForPr({ ...CTX, onRemediated }, {
      db, gh: makeGh(), callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS,
    });
    expect(r.remediated).toBe(true);
    const row = db._tables.codex_remediation_state.find((x) => x.pr_number === 5);
    expect(row.synced_sha).toBe('newcommit999aaa');
    expect(row.sync_pending_sha).toBeNull();
  });

  test('the bar is unblocked once the gate has recovered the hold', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'remediating',
        last_push_sha: HEAD, sync_pending_sha: HEAD, synced_sha: HEAD,
      }],
    });
    const gh = makeGh({ reviewComments: [finding({ body: p2Body('a') })], reviews: [codexReview()] });
    const r = await rem.p2OnlyMergeEligible(5, HEAD, { db, gh });
    expect(r.eligible).toBe(true);
  });
});

// Arming must replace an ALREADY-SYNCED hold (completed sync, lost release) with the
// fresh sentinel. A plain COALESCE preserved it, and the deferred recovery — which
// clears when pending == synced — would then erase the hold guarding the new push.
describe('arming replaces a completed hold but preserves a genuine one', () => {
  test('an already-synced hold is replaced by the fresh sentinel', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'parked', parked_head_sha: 'oldhead111',
        sync_pending_sha: 'completedX', synced_sha: 'completedX', park_phase: 'pre_push',
      }],
    });
    const gh = makeGh();
    let atPushTime = null;
    const origPut = gh.putFile;
    gh.putFile = async (args) => {
      atPushTime = { ...db._tables.codex_remediation_state.find((x) => x.pr_number === 5) };
      return origPut(args);
    };
    await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    // Fresh sentinel, NOT the completed hold — so the imminent push is guarded and
    // the deferred recovery can no longer match (pending !== synced).
    expect(atPushTime.sync_pending_sha).toBe(`push_in_flight:${HEAD}`);
  });

  test('a genuine UNSYNCED hold is still preserved', async () => {
    process.env.AUTONOMOUS_CODEX_REMEDIATION = 'true';
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'parked', parked_head_sha: 'oldhead111',
        sync_pending_sha: 'unsyncedB', synced_sha: 'somethingelse', park_phase: 'pre_push',
      }],
    });
    const gh = makeGh();
    let atPushTime = null;
    const origPut = gh.putFile;
    gh.putFile = async (args) => {
      atPushTime = { ...db._tables.codex_remediation_state.find((x) => x.pr_number === 5) };
      return origPut(args);
    };
    await runRemediationForPr(CTX, { db, gh, callAnthropic: makeCall('FIXED'), validateFixedBlogFile: PASS });
    expect(atPushTime.sync_pending_sha).toBe('unsyncedB');
  });

  test('the deferred release is a CAS — a re-armed row is not cleared', async () => {
    const db = makeDb({
      codex_remediation_state: [{
        pr_number: 5, rounds: 1, status: 'remediating',
        sync_pending_sha: `push_in_flight:${HEAD}`, synced_sha: 'completedX',
        updated_at: new Date().toISOString(),
      }],
    });
    // pending is a fresh sentinel, synced names an older commit → no release, and
    // the fresh in-flight hold stands (age gate holds it too).
    const h = await rem.syncPendingHold(5, { db, headSha: HEAD, branch: 'content/blog-x' });
    expect(h.pending).toBe(true);
    expect(db._tables.codex_remediation_state.find((x) => x.pr_number === 5).sync_pending_sha)
      .toBe(`push_in_flight:${HEAD}`);
  });
});
