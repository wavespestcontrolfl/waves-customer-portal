// The pre-push hook's round log (scripts/hooks/pre-push: round_log_row,
// round_log_unaudited_push, write_round_log). Each pushed commit that has
// something to audit gets one JSON line in codex-review-rounds-YYYY-MM.jsonl
// in the clone's COMMON git dir: "audited" with its counts, or "unaudited"
// with the reason. So a branch that takes ten local audit rounds can be told
// from one that takes one, and a push that passed with no audit is on record.
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

let root; let work; let fakeBin; let baseSha; let sha; let markedSha;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'round-log-test', GIT_AUTHOR_EMAIL: 'round-log@example.invalid',
      GIT_COMMITTER_NAME: 'round-log-test', GIT_COMMITTER_EMAIL: 'round-log@example.invalid',
    },
  }).trim();
}

// One hook run, as git would start it. `pushes` = [local ref, sha, destination ref] for each ref of the push;
// the default is `git push origin feature`.
function runHook({ cwd = work, env = {}, pushes } = {}) {
  const tuples = pushes || [['refs/heads/feature', sha, 'refs/heads/feature']];
  const base = { ...process.env };
  for (const key of ['SKIP_CODEX_REVIEW', 'CODEX_REVIEW_ROUND_LOG', 'CODEX_REVIEW_BASE', 'CODEX_REVIEW_MAX_DIFF_BYTES']) delete base[key];
  const result = spawnSync('bash', [HOOK, 'origin', 'unused-url'], {
    cwd, encoding: 'utf8',
    input: tuples.map(([localRef, localSha, remoteRef]) => `${localRef} ${localSha} ${remoteRef} ${ZERO}\n`).join(''),
    env: { ...base, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, SKIP_CLAUDE_FALLBACK: '1', FAKE_CODEX_VERDICT: CLEAN, ...env },
  });
  return { status: result.status, stderr: String(result.stderr || '') };
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
  // FAKE_CODEX_MARKED_VERDICT, so one push can carry a clean commit and a blocked one.
  fs.writeFileSync(path.join(fakeBin, 'codex'), [
    '#!/usr/bin/env bash',
    'out=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--output-last-message" ]; then out="$2"; shift; fi',
    '  shift',
    'done',
    'prompt="$(cat)"',
    '[ "${FAKE_CODEX_EXIT:-0}" = "0" ] || { echo "ERROR: fake codex failure" >&2; exit "$FAKE_CODEX_EXIT"; }',
    'verdict="$FAKE_CODEX_VERDICT"',
    `case "$prompt" in *${MARKER}*) verdict="\${FAKE_CODEX_MARKED_VERDICT:-$FAKE_CODEX_VERDICT}" ;; esac`,
    'printf \'%s\' "$verdict" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 });
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
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
    // PATH without the fake codex. The system folders hold git and the shell tools; jq is linked in when it lives elsewhere.
    const systemDirs = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const inSystemDirs = (tool) => systemDirs.some((dir) => fs.existsSync(path.join(dir, tool)));
    expect(inSystemDirs('codex')).toBe(false);
    const tools = path.join(root, 'tools');
    fs.mkdirSync(tools);
    if (!inSystemDirs('jq')) {
      const found = process.env.PATH.split(path.delimiter).map((dir) => path.join(dir, 'jq')).find((file) => fs.existsSync(file));
      fs.symlinkSync(fs.realpathSync(found), path.join(tools, 'jq'));
    }
    const run = runHook({
      pushes: [['refs/heads/main', baseSha, 'refs/heads/same-as-main'], ['refs/heads/feature', sha, 'refs/heads/feature']],
      env: { PATH: [tools, ...systemDirs].join(path.delimiter) },
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
    // A directory sits where the month file goes, so the append fails for any user, root too. Both this month's
    // name and the next one's: a run across midnight UTC on the last day of a month must not pass by luck.
    const blockedDir = path.join(root, 'blocked');
    fs.mkdirSync(blockedDir);
    const monthName = (date) => `codex-review-rounds-${date.toISOString().slice(0, 7)}.jsonl`;
    const names = [...new Set([monthName(new Date()), monthName(new Date(Date.now() + 36 * 3600 * 1000))])];
    for (const name of names) fs.mkdirSync(path.join(blockedDir, name));
    const blocked = runHook({ env: { CODEX_REVIEW_ROUND_LOG: blockedDir, FAKE_CODEX_VERDICT: BLOCKING } });
    expect(blocked.stderr).toContain('blocking push');
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).not.toMatch(/[Ii]s a directory|Permission denied|codex-review-rounds/);
    expect(fs.readdirSync(blockedDir).sort()).toEqual([...names].sort());
    for (const name of names) expect(fs.readdirSync(path.join(blockedDir, name))).toEqual([]);
    expect(monthFiles()).toEqual([]);
  }, 120000);

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
