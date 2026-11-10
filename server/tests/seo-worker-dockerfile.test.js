/**
 * deploy/seo-worker.Dockerfile — the seo-pipeline-worker's build on Railway.
 *
 * The worker moved off Nixpacks because Nixpacks pins Node 24 to 24.10.0,
 * older than the 24.22.1 security floor (CVE-2026-111497). The file must keep
 * the worker a worker: it starts the worker script and never the portal (the
 * 2026-10-22 incident ran a second portal with crons), it installs no browser
 * (the worker never had one, so its Playwright paths fail closed), and it
 * stops on an unpatched Node before npm ci.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'deploy', 'seo-worker.Dockerfile'), 'utf8');
const instructions = dockerfile.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));

const SEO_WORKER_SERVICE_ID = '5cc1acab-c32a-4a33-9ed5-b53d0ce0c15a';
const PORTAL_SERVICE_ID = '1134d775-0e2a-48f3-b9a7-06b290821abf';

describe('deploy/seo-worker.Dockerfile', () => {
  test('starts the seo worker script, never the portal server', () => {
    const cmd = instructions.filter((line) => /^(CMD|ENTRYPOINT)\b/.test(line));
    expect(cmd).toEqual(['CMD ["node", "server/scripts/run-seo-pipeline-worker.js"]']);
    expect(fs.existsSync(path.join(ROOT, 'server', 'scripts', 'run-seo-pipeline-worker.js'))).toBe(true);
    expect(instructions.join('\n')).not.toMatch(/server\/index\.js|npm start/);
  });

  test('stops on a Node older than the patched floor, before npm ci', () => {
    expect(instructions[0]).toMatch(/^FROM node:24-/);
    const check = instructions.findIndex((line) => line.includes("require('./scripts/dev/runtime').checkRuntime('/app')"));
    expect(check).toBeGreaterThan(instructions.findIndex((line) => line.startsWith('COPY . .')));
    expect(check).toBeLessThan(instructions.findIndex((line) => line.includes('npm ci --include=dev')));
  });

  test('keeps the Nixpacks steps the worker uses and adds no browser or client build', () => {
    expect(dockerfile).toMatch(/NODE_ENV=production/);
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bffmpeg\b/);
    expect(dockerfile).toMatch(/npm ci --include=dev/);
    expect(dockerfile).toMatch(/ffmpeg -hide_banner -version/);
    const steps = instructions.join('\n');
    expect(steps).not.toMatch(/playwright install|chromium|google-chrome/i);
    expect(steps).not.toMatch(/npm run build/);
  });

  test("names the npm cache mount for the seo worker's own service", () => {
    expect(dockerfile).toContain(`id=s/${SEO_WORKER_SERVICE_ID}-/root/.npm`);
    expect(dockerfile).not.toContain(PORTAL_SERVICE_ID);
  });
});
