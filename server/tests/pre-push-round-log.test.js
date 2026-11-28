// The pre-push hook's round log (scripts/hooks/pre-push: round_log_mark,
// round_log_unmarked_why, write_round_log). Each pushed commit gets one JSON
// line in codex-review-rounds-YYYY-MM.jsonl in the clone's COMMON git dir:
// "audited" with its counts, or "unaudited" with the reason. Only a commit
// git proves has no diff against the base is left out. So a branch that
// takes ten local audit rounds can be told from one that takes one, and a
// push that passed with no audit is on record.
// Credible regressions this pins:
// - the log changing the hook's exit code (it runs from the EXIT trap, and
//   that code is the push verdict), or a failed write printing or blocking;
// - a block on one branch of a two-branch push booked to the other branch;
// - a push with nothing to audit counted as a round;
// - a push that skipped the audit, or met no auditor, leaving no line (an
//   outage would look like a quiet week);
// - a linked worktree writing its own private file;
// - a month file rewritten (a second worktree's line can be lost), or the
//   files growing without limit.
// Runs the real hook against throwaway repos with a fake `codex` on PATH:
// no model call, no network.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', '..', 'scripts', 'hooks', 'pre-push');
const ZERO = '0'.repeat(40);
const MONTH_FILE = /^codex-review-rounds-\d{4}-\d{2}\.jsonl$/;
const MARKER = 'ROUND_LOG_MARKED_COMMIT';
const CLEAN = JSON.stringify({ summary: 'Clean.', findings: [] });
const BLOCKING = JSON.stringify({
  summary: 'One P0, two P1.',
  findings: [
    { priority: 'P0', file: 'a.js', line: 1, title: 'p0', description: 'd' },
    { priority: 'P1', file: 'a.js', line: 2, title: 'p1', description: 'd' },
    { priority: 'P1', file: 'a.js', line: 3, title: 'p1 again', description: 'd' },
  ],
});

let root; let work; let fakeBin; let baseSha; let sha; let markedSha; let orphanSha; let partialSha;

// One environment for every git command and every hook run in this file. It keeps the machine out of the
// fixture: no global or system git config (a developer's core.hooksPath, diff.external or aliases), and none of
// git's own GIT_* variables (jest can run inside a git hook, where GIT_DIR points at the real repository).
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...extra };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv({
      GIT_AUTHOR_NAME: 'round-log-test', GIT_AUTHOR_EMAIL: 'round-log@example.invalid',
      GIT_COMMITTER_NAME: 'round-log-test', GIT_COMMITTER_EMAIL: 'round-log@example.invalid',
    }),
  }).trim();
}

// One hook run, as git would start it. `pushes` = [local ref, sha, destination ref] for each ref of the push;
// the default is `git push origin feature`. An empty list is git's run for a push with every ref up to date.
function runHook({ cwd = work, env = {}, pushes, timeout } = {}) {
  const tuples = pushes || [['refs/heads/feature', sha, 'refs/heads/feature']];
  const base = cleanEnv();
  for (const key of ['SKIP_CODEX_REVIEW', 'CODEX_REVIEW_ROUND_LOG', 'CODEX_REVIEW_BASE', 'CODEX_REVIEW_MAX_DIFF_BYTES', 'CODEX_REVIEW_BLOCK_ROUNDS']) delete base[key];
  const result = spawnSync('bash', [HOOK, 'origin', 'unused-url'], {
    cwd, encoding: 'utf8', timeout,
    input: tuples.map(([localRef, localSha, remoteRef]) => `${localRef} ${localSha} ${remoteRef} ${ZERO}\n`).join(''),
    env: { ...base, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, SKIP_CLAUDE_FALLBACK: '1', FAKE_CODEX_VERDICT: CLEAN, ...env },
  });
  return { status: result.status, stderr: String(result.stderr || ''), timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT') };
}

const gitDir = () => path.join(work, '.git');
const monthFiles = (dir = gitDir()) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => MONTH_FILE.test(name)).sort() : []);
// Every logged line in a directory, oldest month file first.
const rounds = (dir = gitDir()) => monthFiles(dir)
  .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean))
  .map((line) => JSON.parse(line));

beforeAll(() => {
  // The hook itself needs jq; without it the hook passes the push before the audit and these cases prove nothing.
  execFileSync('jq', ['--version'], { stdio: 'ignore' });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'round-log-'));
  const remote = path.join(root, 'remote.git');
  work = path.join(root, 'work');
  fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  // Stands in for `codex exec`: writes a verdict to the file the hook names. A diff that holds MARKER gets
  // FAKE_CODEX_MARKED_VERDICT, so one push can carry a clean commit and a blocked one. FAKE_CODEX_FIRST is a
  // shell line it runs first: a case uses it to move the base while an audit is in progress.
  fs.writeFileSync(path.join(fakeBin, 'codex'), [
    '#!/usr/bin/env bash',
    'out=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--output-last-message" ]; then out="$2"; shift; fi',
    '  shift',
    'done',
    'prompt="$(cat)"',
    '[ "${FAKE_CODEX_EXIT:-0}" = "0" ] || { echo "ERROR: fake codex failure" >&2; exit "$FAKE_CODEX_EXIT"; }',
    '[ -z "${FAKE_CODEX_FIRST:-}" ] || eval "$FAKE_CODEX_FIRST"',
    'verdict="$FAKE_CODEX_VERDICT"',
    `case "$prompt" in *${MARKER}*) verdict="\${FAKE_CODEX_MARKED_VERDICT:-$FAKE_CODEX_VERDICT}" ;; esac`,
    'printf \'%s\' "$verdict" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 });
  git(root, ['init', '-q', '--bare', remote]);
  git(root, ['init', '-q', '-b', 'main', work]);
  // No hook of any kind runs for the fixture's own commits and pushes. The cases start the hook under test directly.
  const noHooks = path.join(root, 'no-hooks');
  fs.mkdirSync(noHooks);
  git(work, ['config', 'core.hooksPath', noHooks]);
  git(work, ['remote', 'add', 'origin', remote]);
  fs.mkdirSync(path.join(work, '.github'));
  fs.writeFileSync(path.join(work, '.github', 'codex-review-schema.json'), '{}\n');
  fs.writeFileSync(path.join(work, 'AGENTS.md'), '# rules\n');
  fs.writeFileSync(path.join(work, 'a.js'), 'module.exports = 1;\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'base']);
  git(work, ['push', '-q', 'origin', 'main']);
  git(work, ['fetch', '-q', 'origin']);
  baseSha = git(work, ['rev-parse', 'HEAD']);
  git(work, ['checkout', '-q', '-b', 'marked']);
  fs.writeFileSync(path.join(work, 'b.js'), `// ${MARKER}\nmodule.exports = 3;\n`);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'marked change']);
  markedSha = git(work, ['rev-parse', 'HEAD']);
  // A branch that shares no history with main: git cannot diff it against the base.
  git(work, ['checkout', '-q', '--orphan', 'lonely']);
  fs.writeFileSync(path.join(work, 'c.js'), 'module.exports = 4;\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'no shared history']);
  orphanSha = git(work, ['rev-parse', 'HEAD']);
  // A branch whose diff git starts and cannot finish: the text filter of its last file fails, so git prints
  // the patch of the first file and then exits with an error. The attribute is in the repo's info/attributes,
  // not in a committed .gitattributes: git reads that file from the checked-out tree, and the cases run with
  // another branch checked out.
  git(work, ['checkout', '-q', '-b', 'partial', 'main']);
  fs.writeFileSync(path.join(work, 'a-first.js'), 'module.exports = 5;\n');
  fs.writeFileSync(path.join(work, 'z-last.broken'), 'data\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'a diff that fails part way']);
  partialSha = git(work, ['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(work, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(work, '.git', 'info', 'attributes'), '*.broken diff=broken\n');
  git(work, ['config', 'diff.broken.textconv', 'false']);
  git(work, ['checkout', '-q', '-b', 'feature', 'main']);
  fs.writeFileSync(path.join(work, 'a.js'), 'module.exports = 2;\n');
  git(work, ['commit', '-q', '-am', 'change']);
  sha = git(work, ['rev-parse', 'HEAD']);
}, 120000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of monthFiles()) fs.rmSync(path.join(gitDir(), name), { force: true });
});

describe('pre-push round log', () => {
  test('a clean audit passes the push and logs one line for the commit', () => {
    const run = runHook();
    expect(run.stderr).toContain('clean — push allowed');
    expect(run.status).toBe(0);
    expect(monthFiles()).toHaveLength(1);
    const [round, ...rest] = rounds();
    expect(rest).toEqual([]);
    expect(round).toEqual({
      ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      ref: 'refs/heads/feature', refs: ['refs/heads/feature'], sha, outcome: 'audited', p0: 0, p1: 0, auditor: 'codex',
      exit: 0, seconds: expect.any(Number),
    });
    expect(monthFiles()[0]).toBe(`codex-review-rounds-${round.ts.slice(0, 7)}.jsonl`);
  }, 120000);

  test('a P0 still blocks the push with exit 1, and the line records the counts and that exit', () => {
    const run = runHook({ env: { FAKE_CODEX_VERDICT: BLOCKING } });
    expect(run.stderr).toContain('blocking push');
    expect(run.status).toBe(1);
    expect(rounds()).toEqual([expect.objectContaining({ outcome: 'audited', p0: 1, p1: 2, exit: 1 })]);
  }, 120000);

  // Owner 2026-11-27 round cap: P0s block only a branch's first 2 audited pushes; GitHub Codex decides after.
  // Regressions pinned: the cap relaxing round 2 or earlier, counting un-audited pushes or another branch's
  // rounds, relaxing a push to main, or ignoring CODEX_REVIEW_BLOCK_ROUNDS=0.
  test('after 2 audited pushes of a branch its P0s stop blocking, and earlier rounds still block', () => {
    runHook({ env: { FAKE_CODEX_EXIT: '3' } }); // un-audited: not a round
    runHook({ pushes: [['refs/heads/feature', sha, 'refs/heads/other']], env: { FAKE_CODEX_VERDICT: BLOCKING } });
    for (let round = 1; round <= 2; round += 1) {
      const run = runHook({ env: { FAKE_CODEX_VERDICT: BLOCKING } });
      expect(run.stderr).toContain('blocking push');
      expect(run.status).toBe(1);
    }
    const third = runHook({ env: { FAKE_CODEX_VERDICT: BLOCKING } });
    expect(third.stderr).toContain('round cap reached for feature (round 3)');
    expect(third.stderr).toContain('GitHub Codex decides');
    expect(third.status).toBe(0);
    expect(rounds().slice(-1)).toEqual([expect.objectContaining({ ref: 'refs/heads/feature', outcome: 'audited', p0: 1, exit: 0 })]);
    const strict = runHook({ env: { FAKE_CODEX_VERDICT: BLOCKING, CODEX_REVIEW_BLOCK_ROUNDS: '0' } });
    expect(strict.status).toBe(1);
  }, 240000);

  test('one commit pushed to two branches counts a round for each branch', () => {
    const both = { pushes: [['refs/heads/feature', sha, 'refs/heads/feature'], ['refs/heads/feature', sha, 'refs/heads/feature-copy']], env: { FAKE_CODEX_VERDICT: BLOCKING } };
    for (let round = 1; round <= 2; round += 1) expect(runHook(both).status).toBe(1);
    const third = runHook(both);
    expect(third.stderr).toContain('round cap reached for feature (round 3) feature-copy (round 3)');
    expect(third.status).toBe(0);
  }, 240000);

  test('a clean new branch in the same push does not re-arm a capped branch\'s block', () => {
    for (let round = 1; round <= 2; round += 1) runHook({ pushes: [['refs/heads/marked', markedSha, 'refs/heads/marked']], env: { FAKE_CODEX_MARKED_VERDICT: BLOCKING } });
    const mixed = runHook({
      pushes: [['refs/heads/marked', markedSha, 'refs/heads/marked'], ['refs/heads/feature', sha, 'refs/heads/feature']],
      env: { FAKE_CODEX_MARKED_VERDICT: BLOCKING },
    });
    expect(mixed.stderr).toContain('round cap reached for marked (round 3).');
    expect(mixed.status).toBe(0);
    // The capped branch with a P0 and a new branch with its own P0 still blocks: the new branch is in round 1.
    const bothBlocked = runHook({
      pushes: [['refs/heads/marked', markedSha, 'refs/heads/marked'], ['refs/heads/feature', sha, 'refs/heads/feature-new']],
      env: { FAKE_CODEX_VERDICT: BLOCKING },
    });
    expect(bothBlocked.status).toBe(1);
  }, 240000);

  test('a push to main is never relaxed by the round cap', () => {
    const toMain = { pushes: [['refs/heads/feature', sha, 'refs/heads/main']], env: { FAKE_CODEX_VERDICT: BLOCKING } };
    for (let round = 1; round <= 3; round += 1) expect(runHook(toMain).status).toBe(1);
  }, 240000);

  test('an audit that could not run is logged as un-audited, not as a clean round', () => {
    const run = runHook({ env: { FAKE_CODEX_EXIT: '3' } });
    expect(run.stderr).toContain('UN-AUDITED');
    expect(run.status).toBe(0);
    const [round, ...rest] = rounds();
    expect(rest).toEqual([]);
    expect(round).toMatchObject({ ref: 'refs/heads/feature', sha, outcome: 'unaudited', why: 'auditors_failed', p0: 0, p1: 0, exit: 0 });
    expect(round).not.toHaveProperty('auditor');
  }, 120000);

  test('a diff over the size cap is logged as un-audited with its own reason', () => {
    const run = runHook({ env: { CODEX_REVIEW_MAX_DIFF_BYTES: '1' } });
    expect(run.stderr).toContain('skipping audit for this ref');
    expect(run.status).toBe(0);
    expect(rounds()).toEqual([expect.objectContaining({ sha, outcome: 'unaudited', why: 'diff_too_large', exit: 0 })]);
  }, 120000);

  test('a push of two branches logs one line each, and the block stays on the branch that earned it', () => {
    // The blocked branch goes first: a line that carried the push's running totals would book its P0 to the clean one.
    const run = runHook({
      pushes: [['refs/heads/marked', markedSha, 'refs/heads/marked'], ['refs/heads/feature', sha, 'refs/heads/feature']],
      env: { FAKE_CODEX_MARKED_VERDICT: BLOCKING },
    });
    expect(run.status).toBe(1);
    expect(rounds()).toEqual([
      expect.objectContaining({ ref: 'refs/heads/marked', refs: ['refs/heads/marked'], sha: markedSha, outcome: 'audited', p0: 1, p1: 2, exit: 1 }),
      expect.objectContaining({ ref: 'refs/heads/feature', refs: ['refs/heads/feature'], sha, outcome: 'audited', p0: 0, p1: 0, exit: 1 }),
    ]);
  }, 120000);

  test('one commit pushed to two branches is one audit and one line that names both', () => {
    const run = runHook({ pushes: [['refs/heads/feature', sha, 'refs/heads/feature'], ['refs/heads/feature', sha, 'refs/heads/feature-copy']] });
    expect(run.status).toBe(0);
    expect(rounds()).toEqual([
      expect.objectContaining({ ref: 'refs/heads/feature', refs: ['refs/heads/feature', 'refs/heads/feature-copy'], sha, outcome: 'audited' }),
    ]);
  }, 120000);

  test('a commit with nothing to audit is not a round', () => {
    const empty = runHook({ pushes: [['refs/heads/main', baseSha, 'refs/heads/same-as-main']] });
    expect(empty.stderr).toContain('no auditable refs');
    expect(empty.status).toBe(0);
    expect(monthFiles()).toEqual([]);
    const mixed = runHook({ pushes: [['refs/heads/main', baseSha, 'refs/heads/same-as-main'], ['refs/heads/feature', sha, 'refs/heads/feature']] });
    expect(mixed.status).toBe(0);
    expect(rounds()).toEqual([expect.objectContaining({ ref: 'refs/heads/feature', sha, outcome: 'audited' })]);
  }, 120000);

  test('a run with no ref update on stdin audits HEAD and logs nothing: nothing was pushed', () => {
    const run = runHook({ pushes: [] });
    expect(run.stderr).toContain('auditing HEAD');
    expect(run.stderr).toContain('clean — push allowed');
    expect(run.status).toBe(0);
    expect(monthFiles()).toEqual([]);
  }, 120000);

  test('a commit git cannot compare with the base is logged as un-audited, not dropped as "no changes"', () => {
    // The audit loop reads a failed diff as an empty one and skips the commit. The log must not: nothing was
    // proven about this commit, and it was pushed with no audit.
    const run = runHook({ pushes: [['refs/heads/lonely', orphanSha, 'refs/heads/lonely'], ['refs/heads/feature', sha, 'refs/heads/feature']] });
    expect(run.status).toBe(0);
    expect(rounds()).toEqual([
      expect.objectContaining({ ref: 'refs/heads/lonely', sha: orphanSha, outcome: 'unaudited', why: 'diff_failed', p0: 0, p1: 0, exit: 0 }),
      expect.objectContaining({ ref: 'refs/heads/feature', sha, outcome: 'audited', exit: 0 }),
    ]);
    for (const name of monthFiles()) fs.rmSync(path.join(gitDir(), name), { force: true });
    // The same commit on a push that skips the audit: the more exact reason wins over "skipped".
    expect(runHook({ pushes: [['refs/heads/lonely', orphanSha, 'refs/heads/lonely']], env: { SKIP_CODEX_REVIEW: '1' } }).status).toBe(0);
    expect(rounds()).toEqual([expect.objectContaining({ sha: orphanSha, outcome: 'unaudited', why: 'diff_failed' })]);
  }, 120000);

  test('an audit of a diff git could not finish is logged as an audit of part of the change', () => {
    // The fixture must really give a part diff with an error, or this case proves nothing.
    const part = spawnSync('git', ['diff', '--no-color', `origin/main...${partialSha}`], { cwd: work, encoding: 'utf8', env: cleanEnv() });
    expect(part.status).not.toBe(0);
    expect(part.stdout).toContain('a-first.js');
    // The hook audits the part, as it does on main. The mark changes neither the counts nor the verdict.
    const run = runHook({ pushes: [['refs/heads/partial', partialSha, 'refs/heads/partial']], env: { FAKE_CODEX_VERDICT: BLOCKING } });
    expect(run.stderr).toContain('auditing refs/heads/partial');
    expect(run.stderr).toContain('blocking push');
    expect(run.status).toBe(1);
    const [round, ...rest] = rounds();
    expect(rest).toEqual([]);
    expect(round).toMatchObject({ ref: 'refs/heads/partial', sha: partialSha, outcome: 'audited', why: 'partial_diff', p0: 1, p1: 2, auditor: 'codex', exit: 1 });
  }, 120000);

  test('the log keeps what the loop found for a skipped commit, also when the base moves before the hook ends', () => {
    // Another worktree can fetch while an audit runs. Here the base moves to the no-history branch during the
    // audit of the third commit. Read again at exit, the first commit (no diff) would look like a failed diff
    // and get a line, and the second (a failed diff) would look like no diff and lose its line.
    const pushes = [
      ['refs/heads/main', baseSha, 'refs/heads/same-as-main'],
      ['refs/heads/lonely', orphanSha, 'refs/heads/lonely'],
      ['refs/heads/feature', sha, 'refs/heads/feature'],
    ];
    let run;
    try {
      run = runHook({ pushes, env: { FAKE_CODEX_FIRST: `git update-ref refs/remotes/origin/main ${orphanSha}` } });
      expect(git(work, ['rev-parse', 'refs/remotes/origin/main'])).toBe(orphanSha);
    } finally {
      git(work, ['update-ref', 'refs/remotes/origin/main', baseSha]);
    }
    expect(run.status).toBe(0);
    expect(rounds()).toEqual([
      expect.objectContaining({ ref: 'refs/heads/lonely', sha: orphanSha, outcome: 'unaudited', why: 'diff_failed' }),
      expect.objectContaining({ ref: 'refs/heads/feature', sha, outcome: 'audited' }),
    ]);
  }, 120000);

  test('a commit this clone does not hold is logged as un-audited', () => {
    const missingSha = 'f'.repeat(40);
    const run = runHook({ pushes: [['refs/heads/ghost', missingSha, 'refs/heads/ghost']] });
    expect(run.status).toBe(0);
    expect(rounds()).toEqual([expect.objectContaining({ ref: 'refs/heads/ghost', sha: missingSha, outcome: 'unaudited', why: 'sha_unreachable', exit: 0 })]);
  }, 120000);

  test('a linked worktree appends to the same file as the main checkout', () => {
    const linked = path.join(root, 'linked');
    git(work, ['worktree', 'add', '-q', '-b', 'feature-two', linked, sha]);
    expect(runHook().status).toBe(0);
    expect(runHook({ cwd: linked }).status).toBe(0);
    expect(rounds()).toHaveLength(2);
    expect(monthFiles()).toHaveLength(1);
    expect(monthFiles(path.join(gitDir(), 'worktrees', 'linked'))).toEqual([]);
  }, 120000);

  test('a push that skips the audit is logged as un-audited, and CODEX_REVIEW_ROUND_LOG=off logs nothing', () => {
    const skipped = runHook({ env: { SKIP_CODEX_REVIEW: '1' } });
    expect(skipped.stderr).toContain('SKIP_CODEX_REVIEW=1 set');
    expect(skipped.status).toBe(0);
    const [round, ...rest] = rounds();
    expect(rest).toEqual([]);
    expect(round).toMatchObject({ ref: 'refs/heads/feature', refs: ['refs/heads/feature'], sha, outcome: 'unaudited', why: 'skipped', p0: 0, p1: 0, exit: 0 });
    expect(round).not.toHaveProperty('auditor');
    for (const name of monthFiles()) fs.rmSync(path.join(gitDir(), name), { force: true });
    // "off" is a switch, not a directory name: a folder called off in the repo root gets no file either.
    const off = path.join(work, 'off');
    fs.mkdirSync(off);
    try {
      const run = runHook({ env: { CODEX_REVIEW_ROUND_LOG: 'off' } });
      expect(run.stderr).toContain('clean — push allowed');
      expect(run.status).toBe(0);
      expect(runHook({ env: { CODEX_REVIEW_ROUND_LOG: 'off', SKIP_CODEX_REVIEW: '1' } }).status).toBe(0);
      expect(fs.readdirSync(off)).toEqual([]);
      expect(monthFiles()).toEqual([]);
    } finally {
      fs.rmSync(off, { recursive: true, force: true });
    }
  }, 120000);

  test('a push with no auditor on PATH passes and is logged as un-audited; a commit with nothing to audit still gets no line', () => {
    // The test, not the machine, decides whether an auditor is on PATH: one folder of links to every tool in
    // the system folders (and to jq and git, wherever they live) except the two auditors. codex may be
    // installed in /usr/bin, so a PATH of the system folders themselves would not do.
    const tools = path.join(root, 'tools');
    fs.mkdirSync(tools);
    const linked = new Set(['codex', 'claude']);
    const link = (dir, name) => {
      if (linked.has(name) || !fs.existsSync(path.join(dir, name))) return;
      fs.symlinkSync(path.join(dir, name), path.join(tools, name));
      linked.add(name);
    };
    for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
      if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) link(dir, name);
    }
    for (const dir of process.env.PATH.split(path.delimiter).filter(Boolean)) for (const name of ['jq', 'git']) link(dir, name);
    expect(fs.existsSync(path.join(tools, 'codex'))).toBe(false);
    expect(fs.existsSync(path.join(tools, 'claude'))).toBe(false);
    const run = runHook({
      pushes: [['refs/heads/main', baseSha, 'refs/heads/same-as-main'], ['refs/heads/feature', sha, 'refs/heads/feature']],
      env: { PATH: tools },
    });
    expect(run.stderr).toContain('no LLM auditor on PATH');
    expect(run.status).toBe(0);
    const [round, ...rest] = rounds();
    expect(rest).toEqual([]);
    expect(round).toMatchObject({ ref: 'refs/heads/feature', sha, outcome: 'unaudited', why: 'no_auditor', p0: 0, p1: 0, exit: 0 });
  }, 120000);

  test('each other preflight exit passes the push and logs its own reason', () => {
    const withoutFile = (relative, fn) => {
      const file = path.join(work, relative);
      fs.renameSync(file, `${file}.moved`);
      try { return fn(); } finally { fs.renameSync(`${file}.moved`, file); }
    };
    const cases = [
      ['no_base', "base ref 'origin/nope' not found", () => runHook({ env: { CODEX_REVIEW_BASE: 'origin/nope' } })],
      ['no_agents_md', 'missing AGENTS.md', () => withoutFile('AGENTS.md', () => runHook())],
      ['no_schema', 'missing .github/codex-review-schema.json', () => withoutFile(path.join('.github', 'codex-review-schema.json'), () => runHook())],
    ];
    for (const [why, message, run] of cases) {
      for (const name of monthFiles()) fs.rmSync(path.join(gitDir(), name), { force: true });
      const result = run();
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain('push allowed (advisory check skipped)');
      expect(result.status).toBe(0);
      expect(rounds()).toEqual([expect.objectContaining({ ref: 'refs/heads/feature', sha, outcome: 'unaudited', why, exit: 0 })]);
    }
  }, 120000);

  test('a log that cannot be written changes neither the verdict nor the output', () => {
    const missing = path.join(root, 'no-such-dir');
    const clean = runHook({ env: { CODEX_REVIEW_ROUND_LOG: missing } });
    expect(clean.status).toBe(0);
    expect(clean.stderr).toContain('clean — push allowed');
    expect(clean.stderr).not.toMatch(/No such file|codex-review-rounds|no-such-dir/);
    expect(fs.existsSync(missing)).toBe(false);
    // A folder the user cannot write to: the append itself fails. Root can write anywhere, so root skips this part.
    if (process.getuid && process.getuid() !== 0) {
      const readOnly = path.join(root, 'read-only');
      fs.mkdirSync(readOnly, { mode: 0o555 });
      const blocked = runHook({ env: { CODEX_REVIEW_ROUND_LOG: readOnly, FAKE_CODEX_VERDICT: BLOCKING } });
      expect(blocked.stderr).toContain('blocking push');
      expect(blocked.status).toBe(1);
      expect(blocked.stderr).not.toMatch(/Permission denied|codex-review-rounds|read-only/);
      expect(fs.readdirSync(readOnly)).toEqual([]);
    }
    expect(monthFiles()).toEqual([]);
  }, 120000);

  test('the log is appended to a plain file only: a folder, a link or a pipe at its path gets nothing and holds nothing up', () => {
    // Both this month's name and the next one's: a run across midnight UTC on the last day of a month must not
    // pass by luck.
    const monthName = (date) => `codex-review-rounds-${date.toISOString().slice(0, 7)}.jsonl`;
    const names = [...new Set([monthName(new Date()), monthName(new Date(Date.now() + 36 * 3600 * 1000))])];
    const dirWith = (label, make) => {
      const dir = path.join(root, label);
      fs.mkdirSync(dir);
      for (const name of names) make(path.join(dir, name));
      return dir;
    };
    const folders = dirWith('odd-folder', (file) => fs.mkdirSync(file));
    const target = path.join(root, 'link-target.txt');
    fs.writeFileSync(target, 'untouched\n');
    const links = dirWith('odd-link', (file) => fs.symlinkSync(target, file));
    // A pipe with no reader: an append to it never returns. The run gets a time limit so that a hang fails here.
    const pipes = dirWith('odd-pipe', (file) => execFileSync('mkfifo', [file]));
    for (const dir of [folders, links, pipes]) {
      const before = fs.readdirSync(dir).sort();
      const run = runHook({ env: { CODEX_REVIEW_ROUND_LOG: dir, FAKE_CODEX_VERDICT: BLOCKING }, timeout: 60000 });
      expect(run.timedOut).toBe(false);
      expect(run.stderr).toContain('blocking push');
      expect(run.status).toBe(1);
      expect(run.stderr).not.toMatch(/[Ii]s a directory|codex-review-rounds/);
      expect(fs.readdirSync(dir).sort()).toEqual(before);
    }
    for (const name of names) expect(fs.readdirSync(path.join(folders, name))).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched\n');
    expect(monthFiles()).toEqual([]);
  }, 300000);

  test('the round-log jq programs use no jq keyword as a variable name', () => {
    // jq 1.6 rejects `$label`, `$end`, `$as` and the other keywords as variable names. The hook silences jq's
    // errors so that a log fault can never block a push, so on jq 1.6 one such name would drop every line with
    // no sign. No jq 1.6 runs in CI, so this reads the source instead.
    const source = fs.readFileSync(HOOK, 'utf8');
    const block = source.slice(source.indexOf('write_round_log() {'), source.indexOf("trap 'ROUND_LOG_RC=$?; write_round_log"));
    expect(block.length).toBeGreaterThan(500);
    const names = [...block.matchAll(/--arg ([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThanOrEqual(11);
    const keywords = ['def', 'module', 'import', 'include', 'if', 'then', 'else', 'elif', 'end', 'as', 'reduce', 'foreach', 'try', 'catch', 'label', 'and', 'or', 'not', '__loc__'];
    expect(names.filter((name) => keywords.includes(name))).toEqual([]);
    // Every `as $name` binding in the two jq programs, too.
    const bound = [...block.matchAll(/ as \$([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
    expect(bound).toEqual(['refs']);
    expect(bound.filter((name) => keywords.includes(name))).toEqual([]);
  });

  test('month files are appended to, never rewritten, and only the newest three are kept', () => {
    const dir = path.join(root, 'months');
    fs.mkdirSync(dir);
    const old = (month) => `${JSON.stringify({ ts: `${month}-15T00:00:00Z`, ref: 'refs/heads/old' })}\n`;
    for (const month of ['2001-01', '2001-02', '2001-03', '2001-04', '2001-05']) fs.writeFileSync(path.join(dir, `codex-review-rounds-${month}.jsonl`), old(month));
    fs.writeFileSync(path.join(dir, 'codex-review-rounds.jsonl'), 'not a month file\n');
    fs.writeFileSync(path.join(dir, 'codex-review-rounds-notes.txt'), 'not a month file\n');
    expect(runHook({ env: { CODEX_REVIEW_ROUND_LOG: dir } }).status).toBe(0);
    expect(runHook({ env: { CODEX_REVIEW_ROUND_LOG: dir } }).status).toBe(0);
    const kept = monthFiles(dir);
    expect(kept).toHaveLength(3);
    expect(kept.slice(0, 2)).toEqual(['codex-review-rounds-2001-04.jsonl', 'codex-review-rounds-2001-05.jsonl']);
    expect(fs.readFileSync(path.join(dir, kept[0]), 'utf8')).toBe(old('2001-04'));
    expect(fs.readFileSync(path.join(dir, kept[1]), 'utf8')).toBe(old('2001-05'));
    // The current month's file holds both runs: the second run added a line and left the first in place.
    const current = fs.readFileSync(path.join(dir, kept[2]), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(current).toEqual([expect.objectContaining({ sha, outcome: 'audited' }), expect.objectContaining({ sha, outcome: 'audited' })]);
    expect(fs.readdirSync(dir).sort()).toEqual([...kept, 'codex-review-rounds-notes.txt', 'codex-review-rounds.jsonl'].sort());
  }, 120000);
});
