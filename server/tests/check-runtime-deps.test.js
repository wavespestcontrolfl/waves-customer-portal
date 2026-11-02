// scripts/check-runtime-deps.js — the pre-deploy check that refuses a new production image
// without ffmpeg or Playwright's Chromium (2026-11-02 build-line-limit fix). Only a truly
// missing binary may fail a deploy; anything else is logged and passes.
const { checkFfmpeg, checkChromium, run } = require('../../scripts/check-runtime-deps');

const quiet = { log: () => {}, error: () => {} };
const okExec = () => Buffer.from('');
const playwrightWith = (path) => () => ({ chromium: { executablePath: () => path } });

describe('checkFfmpeg', () => {
  test('ffmpeg -version runs -> present', () => {
    const calls = [];
    const r = checkFfmpeg({ exec: (bin, args) => { calls.push([bin, args]); }, env: {} });
    expect(r).toEqual({ name: 'ffmpeg', ok: true });
    expect(calls).toEqual([['ffmpeg', ['-version']]]);
  });

  test('FFMPEG_PATH wins over PATH, as the app resolves it', () => {
    const calls = [];
    checkFfmpeg({ exec: (bin) => { calls.push(bin); }, env: { FFMPEG_PATH: '/opt/ffmpeg' } });
    expect(calls).toEqual(['/opt/ffmpeg']);
  });

  test('ENOENT = missing binary -> fails', () => {
    const r = checkFfmpeg({ exec: () => { throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }); }, env: {} });
    expect(r).toEqual({ name: 'ffmpeg', ok: false, reason: 'ffmpeg not found' });
  });

  test('a timeout or non-zero exit is NOT a missing binary -> passes with a warning', () => {
    const timedOut = checkFfmpeg({ exec: () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }, env: {} });
    expect(timedOut.ok).toBe(true);
    expect(timedOut.warning).toMatch(/ETIMEDOUT/);
    const killed = checkFfmpeg({ exec: () => { throw Object.assign(new Error('killed'), { signal: 'SIGTERM' }); }, env: {} });
    expect(killed.ok).toBe(true);
    expect(killed.warning).toMatch(/SIGTERM/);
  });
});

describe('checkChromium', () => {
  test('executable exists -> present', () => {
    const r = checkChromium({ loadPlaywright: playwrightWith('/root/.cache/ms-playwright/chromium/chrome'), exists: () => true });
    expect(r).toEqual({ name: 'chromium', ok: true });
  });

  test('executable path missing on disk -> fails and names the path', () => {
    const r = checkChromium({ loadPlaywright: playwrightWith('/root/.cache/ms-playwright/chromium/chrome'), exists: () => false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('executable missing at /root/.cache/ms-playwright/chromium/chrome');
  });

  test('playwright not installed -> fails', () => {
    const r = checkChromium({ loadPlaywright: () => { throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }); }, exists: () => true });
    expect(r).toEqual({ name: 'chromium', ok: false, reason: 'playwright not installed (MODULE_NOT_FOUND)' });
  });

  test('never launches a browser', () => {
    const launch = jest.fn();
    checkChromium({ loadPlaywright: () => ({ chromium: { executablePath: () => '/x', launch } }), exists: () => true });
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('run', () => {
  const present = { exec: okExec, env: {}, loadPlaywright: playwrightWith('/x'), exists: () => true };

  test('both present -> exit 0, one "present" line each', async () => {
    const lines = [];
    const code = await run({ argv: [], log: (l) => lines.push(l), error: (l) => lines.push(l), ...present });
    expect(code).toBe(0);
    expect(lines).toEqual(['[runtime-deps] ffmpeg: present', '[runtime-deps] chromium: present']);
  });

  test('either missing -> exit 1 and an error line naming it', async () => {
    const errors = [];
    const code = await run({ argv: [], log: () => {}, error: (l) => errors.push(l), ...present, exists: () => false });
    expect(code).toBe(1);
    expect(errors).toEqual(['[runtime-deps] MISSING chromium: executable missing at /x']);
  });

  test('without --pdf no browser starts (the pre-deploy form)', async () => {
    const launch = jest.fn();
    const code = await run({ argv: [], ...quiet, ...present, loadPlaywright: () => ({ chromium: { executablePath: () => '/x', launch } }) });
    expect(code).toBe(0);
    expect(launch).not.toHaveBeenCalled();
  });

  test('--pdf launches Chromium and prints a PDF (the CI form)', async () => {
    const close = jest.fn();
    const browser = { newPage: async () => ({ setContent: async () => {}, pdf: async () => Buffer.alloc(4000) }), close };
    const launch = jest.fn(async () => browser);
    const code = await run({ argv: ['--pdf'], ...quiet, ...present, loadPlaywright: () => ({ chromium: { executablePath: () => '/x', launch } }) });
    expect(code).toBe(0);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('--pdf launch failure -> exit 1', async () => {
    const launch = jest.fn(async () => { throw new Error('libnss3.so: cannot open shared object file'); });
    const errors = [];
    const code = await run({ argv: ['--pdf'], log: () => {}, error: (l) => errors.push(l), ...present, loadPlaywright: () => ({ chromium: { executablePath: () => '/x', launch } }) });
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/MISSING chromium-pdf: libnss3\.so/);
  });

  test('--pdf is skipped when a binary is already missing', async () => {
    const launch = jest.fn();
    const code = await run({ argv: ['--pdf'], ...quiet, ...present, exists: () => false, loadPlaywright: () => ({ chromium: { executablePath: () => '/x', launch } }) });
    expect(code).toBe(1);
    expect(launch).not.toHaveBeenCalled();
  });
});
