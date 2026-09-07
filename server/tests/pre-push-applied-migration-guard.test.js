// The pre-push hook's applied-migration guard (scripts/hooks/pre-push):
// a migration file that already exists on the remote branch has been run by
// that branch's Railway preview (or prod, for main), and knex tracks by
// filename — so a push that modifies, renames, or deletes it must be
// BLOCKED, while adding a new file or touching non-migration code passes.
// Encodes #3998 rounds r7 and r10–r14, where in-place edits to a
// correction migration were silent no-ops on the preview for four rounds.
// Runs real git against throwaway repos; SKIP_CODEX_REVIEW=1 keeps the
// LLM audit out of it (the guard runs regardless of that hatch).
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOKS_DIR = path.resolve(__dirname, '..', '..', 'scripts', 'hooks');
const MIGRATIONS = path.join('server', 'models', 'migrations');

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...env,
      GIT_AUTHOR_NAME: 'guard-test', GIT_AUTHOR_EMAIL: 'guard@example.invalid',
      GIT_COMMITTER_NAME: 'guard-test', GIT_COMMITTER_EMAIL: 'guard@example.invalid',
      SKIP_CODEX_REVIEW: '1',
    },
  });
}

function pushResult(cwd, env = {}, target = 'HEAD:main') {
  try {
    git(cwd, ['push', 'origin', target], env);
    return { ok: true, stderr: '' };
  } catch (e) {
    return { ok: false, stderr: String(e.stderr || '') };
  }
}

function writeAndCommit(cwd, files, message) {
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) {
      fs.rmSync(path.join(cwd, rel));
    } else {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), body);
    }
  }
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message]);
}

let root; let remote; let work;
const MIG_A = path.join(MIGRATIONS, '20260101000001_first.js');

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-guard-'));
  remote = path.join(root, 'remote.git');
  work = path.join(root, 'work');
  git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
  git(root, ['clone', '-q', remote, work]);
  git(work, ['config', 'core.hooksPath', HOOKS_DIR]);
  git(work, ['checkout', '-q', '-b', 'main']);
  writeAndCommit(work, {
    [MIG_A]: "exports.up = async () => {};\nexports.down = async () => {};\n",
    'server/index.js': "module.exports = 1;\n",
  }, 'first migration');
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('pre-push applied-migration guard', () => {
  test('a brand-new remote branch passes (nothing on the remote has run yet)', () => {
    const r = pushResult(work);
    expect(r.ok).toBe(true);
  });

  test('modifying a migration that already exists on the remote branch is BLOCKED and names the file', () => {
    writeAndCommit(work, { [MIG_A]: "exports.up = async () => { /* edited after it ran */ };\nexports.down = async () => {};\n" }, 'edit applied migration');
    const r = pushResult(work);
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.stderr).toContain('M\t' + MIG_A.split(path.sep).join('/'));
    expect(r.stderr).toMatch(/SKIP_MIGRATION_GUARD=1/);
  });

  test('SKIP_MIGRATION_GUARD=1 lets the same push through (after a hand-cleaned preview)', () => {
    const r = pushResult(work, { SKIP_MIGRATION_GUARD: '1' });
    expect(r.ok).toBe(true);
  });

  test('adding a new migration and changing non-migration code passes', () => {
    writeAndCommit(work, {
      [path.join(MIGRATIONS, '20260101000002_second.js')]: "exports.up = async () => {};\nexports.down = async () => {};\n",
      'server/index.js': "module.exports = 2;\n",
    }, 'new migration + code');
    const r = pushResult(work);
    expect(r.ok).toBe(true);
  });

  test('deleting a migration that exists on the remote branch is BLOCKED', () => {
    writeAndCommit(work, { [MIG_A]: null }, 'delete applied migration');
    const r = pushResult(work);
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.stderr).toContain('D\t' + MIG_A.split(path.sep).join('/'));
    git(work, ['reset', '-q', '--hard', 'HEAD~1']);
  });

  // A brand-new remote branch has deployed nothing itself, but every
  // migration it inherits from main has run in prod — the guard falls back
  // to the merge base with origin/main (Codex r1 P1 on #4047).
  test('a NEW remote branch that edits a migration inherited from main is BLOCKED via the merge base', () => {
    git(work, ['fetch', '-q', 'origin']);
    git(work, ['checkout', '-q', '-b', 'feature-edit', 'origin/main']);
    writeAndCommit(work, { [MIG_A]: "exports.up = async () => { /* edited on a new branch */ };\nexports.down = async () => {};\n" }, 'edit main migration on new branch');
    const r = pushResult(work, {}, 'HEAD:refs/heads/feature-edit');
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.stderr).toContain('M\t' + MIG_A.split(path.sep).join('/'));
  });

  // An existing branch that has just merged main and edits a migration main
  // brought in: its old remote tip never had the file (diff reads "added"),
  // but prod has run it — the merge base catches it (local auditor P1).
  test('an EXISTING branch that merged main and edits a main migration is BLOCKED via the merge base', () => {
    git(work, ['checkout', '-q', '-b', 'feature-old', 'origin/main']);
    writeAndCommit(work, { 'server/index.js': "module.exports = 'feature-old';\n" }, 'feature work before main moved');
    expect(pushResult(work, {}, 'HEAD:refs/heads/feature-old').ok).toBe(true);
    // main gains a migration the feature branch does not have yet.
    git(work, ['checkout', '-q', 'main']);
    const MIG_MAIN = path.join(MIGRATIONS, '20260101000004_landed_on_main.js');
    writeAndCommit(work, { [MIG_MAIN]: "exports.up = async () => {};\nexports.down = async () => {};\n" }, 'main migration');
    expect(pushResult(work).ok).toBe(true);
    git(work, ['fetch', '-q', 'origin']);
    // The feature branch merges main, then edits the migration it inherited.
    git(work, ['checkout', '-q', 'feature-old']);
    git(work, ['merge', '-q', '--no-edit', 'origin/main']);
    writeAndCommit(work, { [MIG_MAIN]: "exports.up = async () => { /* edited after prod ran it */ };\nexports.down = async () => {};\n" }, 'edit inherited migration');
    const r = pushResult(work, {}, 'HEAD:refs/heads/feature-old');
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.stderr).toContain('M\t' + MIG_MAIN.split(path.sep).join('/'));
  });

  // One commit pushed to a new branch AND an existing one: the guard is per
  // destination, so the existing branch's remote tip must still be checked
  // (local auditor P1 — SHA dedup used to drop the second tuple).
  test('one commit pushed to a new ref and an existing ref is BLOCKED when the existing ref has run the file', () => {
    git(work, ['checkout', '-q', 'main']);
    git(work, ['reset', '-q', '--hard', 'origin/main']);
    const MIG_MAIN = path.join(MIGRATIONS, '20260101000004_landed_on_main.js');
    writeAndCommit(work, { [MIG_MAIN]: "exports.up = async () => { /* edited on main */ };\nexports.down = async () => {};\n" }, 'edit main migration');
    const r = pushResult(work, {}, 'HEAD:refs/heads/brand-new-first');
    // Push both refspecs in ONE push, new branch first.
    let both;
    try {
      git(work, ['push', 'origin', 'HEAD:refs/heads/brand-new-second', 'HEAD:main']);
      both = { ok: true, stderr: '' };
    } catch (e) {
      both = { ok: false, stderr: String(e.stderr || '') };
    }
    expect(r.ok).toBe(false); // even alone, the new ref is blocked via the merge base
    expect(both.ok).toBe(false);
    expect(both.stderr).toContain('refs/heads/main');
    expect(both.stderr).toContain('M\t' + MIG_MAIN.split(path.sep).join('/'));
    git(work, ['reset', '-q', '--hard', 'origin/main']);
  });

  test('a NEW remote branch that only adds a migration passes', () => {
    git(work, ['checkout', '-q', '-b', 'feature-add', 'origin/main']);
    writeAndCommit(work, {
      [path.join(MIGRATIONS, '20260101000003_third.js')]: "exports.up = async () => {};\nexports.down = async () => {};\n",
    }, 'add migration on new branch');
    const r = pushResult(work, {}, 'HEAD:refs/heads/feature-add');
    expect(r.ok).toBe(true);
  });
});
