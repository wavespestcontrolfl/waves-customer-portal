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

let root; let remote; let work; let other; let preMainSha;
const MIG_A = path.join(MIGRATIONS, '20260101000001_first.js');
// Deployed on main AFTER the first commit; preMainSha is the commit before
// it, so the stale-branch cases can branch from a point that lacks it.
const MIG_MAIN = path.join(MIGRATIONS, '20260101000004_landed_on_main.js');
// Every fixture migration gets a distinct body: the guard treats a
// byte-identical file under another name as a copy knex would run again,
// and real migrations are never identical.
const migBody = (name) => `exports.up = async () => { /* ${name} */ };\nexports.down = async () => {};\n`;
// The branch the edit/hatch/add/delete cases push to, with its OWN
// migration its preview has run. main never carries a re-edited
// migration (a real main never does — the hatch is for a hand-cleaned
// preview), so the stale cases branching from preMainSha still match
// main's copy of MIG_A, and the hatch-edited MIG_P is not main's file.
const PREVIEW = 'HEAD:refs/heads/preview';
const MIG_P = path.join(MIGRATIONS, '20260101000005_preview_own.js');

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-guard-'));
  remote = path.join(root, 'remote.git');
  work = path.join(root, 'work');
  git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
  git(root, ['clone', '-q', remote, work]);
  git(work, ['config', 'core.hooksPath', HOOKS_DIR]);
  git(work, ['checkout', '-q', '-b', 'main']);
  writeAndCommit(work, {
    [MIG_A]: migBody('first'),
    'server/index.js': "module.exports = 1;\n",
  }, 'first migration');
  // Seed the remote here, not in a test: every case below assumes
  // origin/main, MIG_MAIN and the preview branch exist, and a case run
  // alone with `-t` must still find them.
  git(work, ['push', '-q', 'origin', 'HEAD:main']);
  preMainSha = git(work, ['rev-parse', 'HEAD']).trim();
  writeAndCommit(work, { [MIG_MAIN]: migBody('landed_on_main') }, 'main migration');
  git(work, ['push', '-q', 'origin', 'HEAD:main']);
  git(work, ['fetch', '-q', 'origin']);
  git(work, ['checkout', '-q', '-b', 'preview']);
  writeAndCommit(work, { [MIG_P]: migBody('preview_own') }, 'preview branch migration');
  git(work, ['push', '-q', 'origin', PREVIEW]);
  // A second clone stands in for "another developer's machine".
  other = path.join(root, 'other');
  git(root, ['clone', '-q', remote, other]);
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('pre-push applied-migration guard', () => {
  test('a brand-new remote branch passes (nothing on the remote has run yet)', () => {
    const r = pushResult(work, {}, 'HEAD:refs/heads/fresh-branch');
    expect(r.ok).toBe(true);
  });

  test('modifying a migration that already exists on the remote branch is BLOCKED and names the file', () => {
    git(work, ['checkout', '-q', 'preview']);
    writeAndCommit(work, { [MIG_P]: "exports.up = async () => { /* edited after it ran */ };\nexports.down = async () => {};\n" }, 'edit applied migration');
    const r = pushResult(work, {}, PREVIEW);
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.stderr).toContain('M\t' + MIG_P.split(path.sep).join('/'));
    expect(r.stderr).toMatch(/SKIP_MIGRATION_GUARD=1/);
  });

  test('SKIP_MIGRATION_GUARD=1 lets the same push through (after a hand-cleaned preview)', () => {
    git(work, ['checkout', '-q', 'preview']);
    const r = pushResult(work, { SKIP_MIGRATION_GUARD: '1' }, PREVIEW);
    expect(r.ok).toBe(true);
  });

  test('adding a new migration and changing non-migration code passes', () => {
    git(work, ['checkout', '-q', 'preview']);
    writeAndCommit(work, {
      [path.join(MIGRATIONS, '20260101000002_second.js')]: migBody('second'),
      'server/index.js': "module.exports = 2;\n",
    }, 'new migration + code');
    const r = pushResult(work, {}, PREVIEW);
    expect(r.ok).toBe(true);
  });

  test('deleting a migration that exists on the remote branch is BLOCKED', () => {
    git(work, ['checkout', '-q', 'preview']);
    writeAndCommit(work, { [MIG_P]: null }, 'delete applied migration');
    const r = pushResult(work, {}, PREVIEW);
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.stderr).toContain('D\t' + MIG_P.split(path.sep).join('/'));
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
    // Branched before main gained MIG_MAIN, pushed, then merges main.
    git(work, ['checkout', '-q', '-b', 'feature-old', preMainSha]);
    writeAndCommit(work, { 'server/index.js': "module.exports = 'feature-old';\n" }, 'feature work before main moved');
    expect(pushResult(work, {}, 'HEAD:refs/heads/feature-old').ok).toBe(true);
    // The feature branch merges main, then edits the migration it inherited.
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

  // A stale branch that cherry-picks a migration main has already deployed
  // (instead of merging main): the merge base predates the file, so both
  // ancestry diffs read "added" — the $BASE-tip check catches the edit
  // (Codex on #4047, e1aa9a5 round). An unedited cherry-pick must pass.
  test('a STALE branch that cherry-picks a deployed main migration and edits it is BLOCKED via the base tip', () => {
    git(work, ['fetch', '-q', 'origin']);
    git(work, ['checkout', '-q', '-b', 'stale-edit', preMainSha]);
    writeAndCommit(work, { [MIG_MAIN]: "exports.up = async () => { /* squashed in, then edited */ };\nexports.down = async () => {};\n" }, 'cherry-pick + edit');
    const r = pushResult(work, {}, 'HEAD:refs/heads/stale-edit');
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.stderr).toContain('vs origin/main tip: M\t' + MIG_MAIN.split(path.sep).join('/'));
  });

  test('a STALE branch carrying a byte-identical copy of a main migration passes', () => {
    const mainBody = git(work, ['show', 'origin/main:' + MIG_MAIN.split(path.sep).join('/')]);
    git(work, ['checkout', '-q', '-b', 'stale-identical', preMainSha]);
    writeAndCommit(work, { [MIG_MAIN]: mainBody }, 'identical cherry-pick');
    const r = pushResult(work, {}, 'HEAD:refs/heads/stale-identical');
    expect(r.ok).toBe(true);
  });

  test('a NEW remote branch that only adds a migration passes', () => {
    git(work, ['checkout', '-q', '-b', 'feature-add', 'origin/main']);
    writeAndCommit(work, {
      [path.join(MIGRATIONS, '20260101000003_third.js')]: migBody('third'),
    }, 'add migration on new branch');
    const r = pushResult(work, {}, 'HEAD:refs/heads/feature-add');
    expect(r.ok).toBe(true);
  });

  // A stale branch that carries a byte-identical copy of a deployed main
  // migration under a NEW filename: the tip diff reads R100, and knex
  // would run the copy a second time (Codex on #4047, 1260e6d round).
  test('a STALE branch that re-stamps a deployed main migration under a new name is BLOCKED via the base tip', () => {
    git(work, ['fetch', '-q', 'origin']);
    const MIG_RESTAMPED = path.join(MIGRATIONS, '20260101000009_landed_on_main_restamped.js');
    const mainBody = git(work, ['show', 'origin/main:' + MIG_MAIN.split(path.sep).join('/')]);
    git(work, ['checkout', '-q', '-b', 'stale-restamp', preMainSha]);
    writeAndCommit(work, { [MIG_RESTAMPED]: mainBody }, 'cherry-pick + re-stamp');
    const r = pushResult(work, {}, 'HEAD:refs/heads/stale-restamp');
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.stderr).toContain('vs origin/main tip: R100\t' + MIG_MAIN.split(path.sep).join('/') + '\t' + MIG_RESTAMPED.split(path.sep).join('/'));
  });

  // main advanced from ANOTHER clone since this clone last fetched: the
  // local origin/main predates the deployed migration, so without a fetch
  // the tip check would read the edited copy as "added" (Codex on #4047,
  // 1260e6d round). The hook fetches $BASE from its remote first.
  test('a branch that edits a migration main deployed AFTER this clone last fetched is BLOCKED (the hook refreshes origin/main)', () => {
    const MIG_X = path.join(MIGRATIONS, '20260101000010_landed_elsewhere.js');
    git(other, ['checkout', '-q', 'main']);
    git(other, ['pull', '-q', '--ff-only', 'origin', 'main']);
    writeAndCommit(other, { [MIG_X]: migBody('landed_elsewhere') }, 'main migration from another clone');
    git(other, ['push', '-q', 'origin', 'HEAD:main']);
    const remoteMain = git(remote, ['rev-parse', 'main']).trim();
    // No fetch in `work`: its origin/main is now stale.
    expect(git(work, ['rev-parse', 'origin/main']).trim()).not.toBe(remoteMain);
    git(work, ['checkout', '-q', '-b', 'stale-fetch', 'origin/main']);
    writeAndCommit(work, { [MIG_X]: "exports.up = async () => { /* edited copy of a migration main deployed */ };\nexports.down = async () => {};\n" }, 'edited copy of an unfetched main migration');
    const r = pushResult(work, {}, 'HEAD:refs/heads/stale-fetch');
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.stderr).toContain('vs origin/main tip: M\t' + MIG_X.split(path.sep).join('/'));
    expect(git(work, ['rev-parse', 'origin/main']).trim()).toBe(remoteMain);
  });

  // An up-to-date branch that KEEPS the deployed migration and adds a
  // byte-identical copy under a new timestamp: a plain diff reads "added";
  // exact-match copy detection reads C100, and knex would run it again
  // (Codex on #4047, 70bddb3 round).
  test('a branch that keeps a deployed main migration and adds a byte-identical copy is BLOCKED (C100)', () => {
    const MIG_COPY = path.join(MIGRATIONS, '20260101000011_landed_on_main_copy.js');
    git(work, ['fetch', '-q', 'origin']);
    git(work, ['checkout', '-q', '-b', 'copy-kept', 'origin/main']);
    writeAndCommit(work, { [MIG_COPY]: git(work, ['show', 'origin/main:' + MIG_MAIN.split(path.sep).join('/')]) }, 'copy of a deployed migration');
    const r = pushResult(work, {}, 'HEAD:refs/heads/copy-kept');
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.stderr).toContain('C100\t' + MIG_MAIN.split(path.sep).join('/') + '\t' + MIG_COPY.split(path.sep).join('/'));
  });

  // The destination branch was advanced from another clone (its preview
  // ran a migration) and this clone never fetched that tip: the hook
  // fetches it before diffing, so a force-push that drops the file is
  // blocked via the remote tip (Codex on #4047, 70bddb3 round).
  test('a force-push over a destination tip this clone never fetched is BLOCKED after the hook fetches it', () => {
    const MIG_S = path.join(MIGRATIONS, '20260101000012_ran_on_shared_preview.js');
    git(other, ['checkout', '-q', '-B', 'shared', 'origin/main']);
    writeAndCommit(other, { [MIG_S]: migBody('ran_on_shared_preview') }, 'migration on shared, from another clone');
    git(other, ['push', '-q', '-f', 'origin', 'HEAD:refs/heads/shared']);
    const sharedTip = git(remote, ['rev-parse', 'refs/heads/shared']).trim();
    // Not fetched in `work`: the tip object is unknown here.
    expect(() => git(work, ['cat-file', '-e', sharedTip + '^{commit}'])).toThrow();
    git(work, ['checkout', '-q', '-B', 'shared-local', 'origin/main']);
    writeAndCommit(work, { 'server/index.js': "module.exports = 'rewrites shared';\n" }, 'unrelated work that would replace shared');
    const r = pushResult(work, {}, '+HEAD:refs/heads/shared');
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.stderr).toContain('D\t' + MIG_S.split(path.sep).join('/'));
  });

  // CODEX_REVIEW_BASE moves only the LLM audit; the guard's notion of
  // "deployed" stays origin/main (Codex on #4047, 70bddb3 round).
  test('CODEX_REVIEW_BASE pointing at a pre-migration branch does not move the guard off origin/main', () => {
    git(work, ['fetch', '-q', 'origin']);
    git(work, ['checkout', '-q', '-B', 'audit-base-decoy', preMainSha]);
    git(work, ['push', '-q', 'origin', 'HEAD:refs/heads/audit-base-decoy']);
    git(work, ['fetch', '-q', 'origin']);
    git(work, ['checkout', '-q', '-b', 'stale-with-override', preMainSha]);
    writeAndCommit(work, { [MIG_MAIN]: "exports.up = async () => { /* edited under an audit-base override */ };\nexports.down = async () => {};\n" }, 'cherry-pick + edit');
    const r = pushResult(work, { CODEX_REVIEW_BASE: 'origin/audit-base-decoy' }, 'HEAD:refs/heads/stale-with-override');
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('vs origin/main tip: M\t' + MIG_MAIN.split(path.sep).join('/'));
  });

  // Tooling that runs the hook with nothing on stdin: the guard still
  // checks HEAD against origin/main (Codex on #4047, 70bddb3 round).
  test('invoked without stdin, the hook guards HEAD against origin/main', () => {
    git(work, ['fetch', '-q', 'origin']);
    git(work, ['checkout', '-q', '-b', 'head-fallback', 'origin/main']);
    writeAndCommit(work, { [MIG_MAIN]: "exports.up = async () => { /* edited, hook run by tooling */ };\nexports.down = async () => {};\n" }, 'edit on HEAD');
    let failed = null;
    try {
      execFileSync('bash', [path.join(HOOKS_DIR, 'pre-push'), 'origin'], {
        cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SKIP_CODEX_REVIEW: '1' },
      });
    } catch (e) { failed = e; }
    expect(failed).not.toBeNull();
    expect(String(failed.stderr)).toMatch(/\[migration-guard\] BLOCKED/);
    expect(String(failed.stderr)).toContain('HEAD -> ?');
    expect(String(failed.stderr)).toContain('M\t' + MIG_MAIN.split(path.sep).join('/'));
  });

  // main repaired a migration in place (the hatch's legitimate case: its
  // deploy had failed before migrating) and a branch merges main forward:
  // the branch's old remote tip has the pre-repair file, so the remote
  // diff reads M — but the content is main's, not the branch's edit
  // (#4078 was pushed with the hatch for exactly this). A further edit on
  // the branch is still blocked via the origin/main tip.
  test('a branch that merges main forward and inherits a migration main repaired in place passes; editing it further is BLOCKED', () => {
    const MIG_R = path.join(MIGRATIONS, '20260101000013_repaired_on_main.js');
    const migRel = MIG_R.split(path.sep).join('/');
    // main lands MIG_R; the branch is pushed carrying it.
    git(other, ['checkout', '-q', 'main']);
    git(other, ['pull', '-q', '--ff-only', 'origin', 'main']);
    writeAndCommit(other, { [MIG_R]: migBody('repaired_on_main') }, 'migration that will need a repair');
    git(other, ['push', '-q', 'origin', 'HEAD:main']);
    git(work, ['fetch', '-q', 'origin']);
    git(work, ['checkout', '-q', '-b', 'merge-forward', 'origin/main']);
    writeAndCommit(work, { 'server/index.js': "module.exports = 'merge-forward';\n" }, 'feature work');
    expect(pushResult(work, {}, 'HEAD:refs/heads/merge-forward').ok).toBe(true);
    // main repairs MIG_R in place (from a clone without the hook).
    const repaired = "exports.up = async () => { /* repaired on main after a failed deploy */ };\nexports.down = async () => {};\n";
    writeAndCommit(other, { [MIG_R]: repaired }, 'repair migration in place');
    git(other, ['push', '-q', 'origin', 'HEAD:main']);
    // The branch merges main forward: HEAD now carries the repair, and the
    // branch's remote tip still has the pre-repair file.
    git(work, ['fetch', '-q', 'origin']);
    git(work, ['merge', '-q', '--no-edit', 'origin/main']);
    expect(git(work, ['show', 'HEAD:' + migRel])).toBe(repaired);
    const r = pushResult(work, {}, 'HEAD:refs/heads/merge-forward');
    expect(r.stderr).not.toMatch(/\[migration-guard\] BLOCKED/);
    expect(r.ok).toBe(true);
    // Editing the inherited file on the branch is the branch's edit.
    writeAndCommit(work, { [MIG_R]: "exports.up = async () => { /* edited on the branch after the merge */ };\nexports.down = async () => {};\n" }, 'edit inherited repair');
    const r2 = pushResult(work, {}, 'HEAD:refs/heads/merge-forward');
    expect(r2.ok).toBe(false);
    expect(r2.stderr).toMatch(/\[migration-guard\] BLOCKED/);
    expect(r2.stderr).toContain('vs origin/main tip: M\t' + migRel);
  });
});
