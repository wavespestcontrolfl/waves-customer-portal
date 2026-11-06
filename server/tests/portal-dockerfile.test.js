/**
 * deploy/portal.Dockerfile — the portal's production build on Railway.
 *
 * The build sees only the ARGs the file declares (Railway injects every
 * other variable at runtime). A VITE_ name the client reads but the file
 * does not declare builds as undefined in the bundle, and a Railway marker
 * that check-domain-rules reads but the file does not declare turns a stale
 * gate index from a warning into a failed production build. The file also
 * keeps the steps of the Nixpacks plan it replaced.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DOCKERFILE = path.join(ROOT, 'deploy', 'portal.Dockerfile');
const CLIENT_SOURCES = [path.join(ROOT, 'client', 'src'), path.join(ROOT, 'client', 'index.html'), path.join(ROOT, 'client', 'vite.config.js')];

const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
const instructions = dockerfile.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
const declaredArgs = new Set(instructions.map((line) => line.match(/^ARG\s+([A-Z0-9_]+)/)).filter(Boolean).map((m) => m[1]));

function sourceFiles(entry) {
  if (!fs.existsSync(entry)) return [];
  if (fs.statSync(entry).isFile()) return [entry];
  return fs.readdirSync(entry, { withFileTypes: true }).flatMap((dirent) => {
    const full = path.join(entry, dirent.name);
    if (dirent.isDirectory()) return dirent.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(jsx?|tsx?|mjs|cjs|html)$/.test(dirent.name) && !/\.test\./.test(dirent.name) ? [full] : [];
  });
}

function namesIn(files, pattern) {
  const names = new Set();
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

function prebuildScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const prebuild = pkg.scripts.prebuild || '';
  return [...prebuild.matchAll(/npm run ([\w:-]+)/g)]
    .map((m) => pkg.scripts[m[1]] || '')
    .flatMap((cmd) => [...cmd.matchAll(/node\s+(\S+\.c?js)/g)].map((m) => path.join(ROOT, m[1])));
}

describe('deploy/portal.Dockerfile', () => {
  test('declares every VITE_ name the client build reads', () => {
    const readByClient = namesIn(CLIENT_SOURCES.flatMap(sourceFiles), /\b(VITE_[A-Z0-9_]+)\b/g);
    expect(readByClient.size).toBeGreaterThan(0);
    const missing = [...readByClient].filter((name) => !declaredArgs.has(name)).sort();
    expect(missing).toEqual([]);
  });

  test('declares every Railway variable the prebuild checks read', () => {
    const scripts = prebuildScripts();
    expect(scripts.length).toBeGreaterThan(0);
    const readByChecks = namesIn(scripts, /process\.env\.(RAILWAY_[A-Z0-9_]+)/g);
    expect(readByChecks.has('RAILWAY_GIT_COMMIT_SHA')).toBe(true);
    const missing = [...readByChecks].filter((name) => !declaredArgs.has(name)).sort();
    expect(missing).toEqual([]);
  });

  test('keeps the steps of the Nixpacks plan it replaced', () => {
    expect(instructions[0]).toMatch(/^FROM node:24-/);
    expect(dockerfile).toMatch(/NODE_ENV=production/);
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bffmpeg\b/);
    expect(dockerfile).toMatch(/npm ci --include=dev/);
    expect(dockerfile).toMatch(/npm run build && npx playwright install --with-deps chromium/);
    expect(dockerfile).toMatch(/ffmpeg -hide_banner -version/);
    expect(dockerfile).toMatch(/page\.pdf\(\)/);
  });

  test('.dockerignore leaves out only unneeded context and keeps what the build reads', () => {
    const lines = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(lines).toEqual(expect.arrayContaining(['.git', '**/node_modules', 'waves-customer-portal.tar.gz', '!.env.example']));
    // Nothing the build or runtime reads may be excluded: no source tree, no
    // lockfile, no deploy folder, no scripts the prebuild checks run.
    const needed = ['server', 'client', 'shared', 'packages', 'scripts', 'deploy', 'docs', 'package.json', 'package-lock.json', 'nixpacks.toml', '.nvmrc', '.env.example'];
    for (const entry of needed) {
      const excluded = lines.filter((l) => !l.startsWith('!')).some((l) => l.replace(/^\*\*\//, '').replace(/\/$/, '') === entry);
      expect(excluded).toBe(false);
    }
    // No tracked file may be excluded other than .git itself and the tarball.
    const { execFileSync } = require('child_process');
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString().split('\n').filter(Boolean);
    const hits = tracked.filter((file) => file.split('/').some((seg) => seg === 'node_modules' || seg === 'coverage' || seg === '.idea' || seg === '.vscode' || /^\.env(\..+)?$/.test(seg) && file !== '.env.example' || /\.log$/.test(seg) || seg === '.DS_Store' || seg === '.nyc_output'));
    expect(hits).toEqual([]);
  });

  test('is not a root Dockerfile, which the seo-pipeline-worker would also pick up', () => {
    expect(fs.existsSync(path.join(ROOT, 'Dockerfile'))).toBe(false);
  });
});
