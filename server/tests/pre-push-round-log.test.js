// The pre-push hook's round log (scripts/hooks/pre-push, log_audit_round):
// each run that reaches the LLM audit appends one JSON line to
// codex-review-rounds.jsonl in the clone's COMMON git dir, so a branch that
// takes ten local audit rounds can be told from one that takes one.
// Credible regressions this pins: the log changing the hook's exit code (it
// runs from the EXIT trap, and that code is the push verdict), a failed
// write printing or blocking, a linked worktree writing its own private
// file, and the file growing without limit.
// Runs the real hook against throwaway repos with a fake `codex` on PATH:
// no model call, no network.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', '..', 'scripts', 'hooks', 'pre-push');
const ZERO = '0'.repeat(40);
const CLEAN = JSON.stringify({ summary: 'Clean.', findings: [] });
const BLOCKING = JSON.stringify({
  summary: 'One P0, two P1.',
  findings: [
    { priority: 'P0', file: 'a.js', line: 1, title: 'p0', description: 'd' },
    { priority: 'P1', file: 'a.js', line: 2, title: 'p1', description: 'd' },
    { priority: 'P1', file: 'a.js', line: 3, title: 'p1 again', description: 'd' },
  ],
});

let root; let work; let fakeBin; let sha;

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

// One hook run, as git would start it for `git push origin feature`.
function runHook({ cwd = work, env = {}, pushedSha = sha } = {}) {
  const base = { ...process.env };
  for (const key of ['SKIP_CODEX_REVIEW', 'CODEX_REVIEW_ROUND_LOG', 'CODEX_REVIEW_BASE', 'CODEX_REVIEW_MAX_DIFF_BYTES']) delete base[key];
  const result = spawnSync('bash', [HOOK, 'origin', 'unused-url'], {
    cwd, encoding: 'utf8',
    input: `refs/heads/feature ${pushedSha} refs/heads/feature ${ZERO}\n`,
    env: { ...base, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, SKIP_CLAUDE_FALLBACK: '1', FAKE_CODEX_VERDICT: CLEAN, ...env },
  });
  return { status: result.status, stderr: String(result.stderr || '') };
}

const logFile = () => path.join(work, '.git', 'codex-review-rounds.jsonl');
const rounds = (file = logFile()) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

beforeAll(() => {
  // The hook itself needs jq; without it the hook passes the push before the audit and these cases prove nothing.
  execFileSync('jq', ['--version'], { stdio: 'ignore' });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'round-log-'));
  const remote = path.join(root, 'remote.git');
  work = path.join(root, 'work');
  fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  // Stands in for `codex exec`: writes the verdict the test chose to the file the hook names.
  fs.writeFileSync(path.join(fakeBin, 'codex'), [
    '#!/usr/bin/env bash',
    'out=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--output-last-message" ]; then out="$2"; shift; fi',
    '  shift',
    'done',
    'cat >/dev/null',
    '[ "${FAKE_CODEX_EXIT:-0}" = "0" ] || { echo "ERROR: fake codex failure" >&2; exit "$FAKE_CODEX_EXIT"; }',
    'printf \'%s\' "$FAKE_CODEX_VERDICT" > "$out"',
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
  git(work, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(work, 'a.js'), 'module.exports = 2;\n');
  git(work, ['commit', '-q', '-am', 'change']);
  sha = git(work, ['rev-parse', 'HEAD']);
}, 120000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(logFile(), { force: true });
});

describe('pre-push round log', () => {
  test('a clean audit passes the push and logs one round', () => {
    const run = runHook();
    expect(run.stderr).toContain('clean — push allowed');
    expect(run.status).toBe(0);
    const [round, ...rest] = rounds();
    expect(rest).toEqual([]);
    expect(round).toMatchObject({
      ref: 'refs/heads/feature', sha, refs: 1, audited: 1, unaudited: 0, p0: 0, p1: 0, auditors: ['codex'], exit: 0,
    });
    expect(round.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number.isInteger(round.seconds)).toBe(true);
  }, 120000);

  test('a P0 still blocks the push with exit 1, and the round records the counts and that exit', () => {
    const run = runHook({ env: { FAKE_CODEX_VERDICT: BLOCKING } });
    expect(run.stderr).toContain('blocking push');
    expect(run.status).toBe(1);
    expect(rounds()).toEqual([expect.objectContaining({ audited: 1, p0: 1, p1: 2, exit: 1 })]);
  }, 120000);

  test('an audit that could not run is logged as un-audited, not as a clean round', () => {
    const run = runHook({ env: { FAKE_CODEX_EXIT: '3' } });
    expect(run.stderr).toContain('UN-AUDITED');
    expect(run.status).toBe(0);
    expect(rounds()).toEqual([expect.objectContaining({ audited: 0, unaudited: 1, p0: 0, auditors: [], exit: 0 })]);
  }, 120000);

  test('a linked worktree appends to the same file as the main checkout', () => {
    const linked = path.join(root, 'linked');
    git(work, ['worktree', 'add', '-q', '-b', 'feature-two', linked, sha]);
    expect(runHook().status).toBe(0);
    expect(runHook({ cwd: linked }).status).toBe(0);
    expect(rounds()).toHaveLength(2);
    expect(fs.existsSync(path.join(work, '.git', 'worktrees', 'linked', 'codex-review-rounds.jsonl'))).toBe(false);
  }, 120000);

  test('a push that skips the audit, and CODEX_REVIEW_ROUND_LOG=off, log nothing', () => {
    expect(runHook({ env: { SKIP_CODEX_REVIEW: '1' } }).status).toBe(0);
    expect(runHook({ env: { CODEX_REVIEW_ROUND_LOG: 'off' } }).status).toBe(0);
    expect(rounds()).toEqual([]);
    expect(fs.existsSync(path.join(work, 'off'))).toBe(false);
  }, 120000);

  test('a log that cannot be written changes neither the verdict nor the output', () => {
    const missing = path.join(root, 'no-such-dir', 'rounds.jsonl');
    const clean = runHook({ env: { CODEX_REVIEW_ROUND_LOG: missing } });
    expect(clean.status).toBe(0);
    expect(clean.stderr).not.toMatch(/No such file|rounds\.jsonl/);
    const blocked = runHook({ env: { CODEX_REVIEW_ROUND_LOG: missing, FAKE_CODEX_VERDICT: BLOCKING } });
    expect(blocked.status).toBe(1);
    expect(fs.existsSync(missing)).toBe(false);
    expect(rounds()).toEqual([]);
  }, 120000);

  test('past 4 MB the file keeps the newest 8000 rounds, the new one last', () => {
    const file = path.join(root, 'big.jsonl');
    const old = `${JSON.stringify({ ts: '2026-01-01T00:00:00Z', ref: 'refs/heads/old', pad: 'x'.repeat(200) })}\n`;
    fs.writeFileSync(file, old.repeat(20000));
    expect(fs.statSync(file).size).toBeGreaterThan(4194304);
    expect(runHook({ env: { CODEX_REVIEW_ROUND_LOG: file } }).status).toBe(0);
    const kept = rounds(file);
    expect(kept).toHaveLength(8000);
    expect(kept[kept.length - 1]).toMatchObject({ ref: 'refs/heads/feature', sha });
    expect(kept[0].ref).toBe('refs/heads/old');
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }, 120000);
});
