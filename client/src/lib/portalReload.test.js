// @vitest-environment jsdom
// When an out-of-date staff tab reloads by itself (owner 2026-11-19, option A):
// at a page move, on staff pages in a browser, once per live build, only after
// a recent answer from the new server, and never while work holds it.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const platform = vi.hoisted(() => ({ wavesAdmin: false }));
vi.mock('../native/platform', () => ({ isWavesAdminApp: () => platform.wavesAdmin }));

import { installPortalVersionWatch, noteServerAnswer, resetPortalVersionForTests } from './portalVersion';
import { registerReloadHold } from './reloadHolds';
import { countDeviceWrite } from './deviceWrites';
import { RECENT_ANSWER_MS, WRITE_WAIT_MS, reloadBlockers, reloadDueAtMove, reloadForNewBuild, staffReloadBlocker } from './portalReload';

const NOW = 1_000_000;
let holding = false;
registerReloadHold('test-hold', () => holding);

function liveBuild(build, heardAt = NOW) {
  noteServerAnswer(new Headers({ 'X-Portal-Build': build, 'X-Portal-Boot': '2000' }), heardAt);
}

beforeEach(() => {
  resetPortalVersionForTests();
  document.head.insertAdjacentHTML('beforeend', '<meta name="portal-build" content="aaa111aaa111">');
  sessionStorage.clear();
  platform.wavesAdmin = false;
  holding = false;
});

afterEach(() => {
  document.head.querySelectorAll('meta[name="portal-build"]').forEach((el) => el.remove());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('reloadDueAtMove', () => {
  test('a move to a staff page in an out-of-date tab is due a reload', () => {
    liveBuild('bbb222bbb222');
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(true);
  });

  test('never while the tab runs the live build', () => {
    liveBuild('aaa111aaa111');
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(false);
  });

  test('never on customer pages, the field pages or in Waves Admin', () => {
    liveBuild('bbb222bbb222');
    expect(reloadDueAtMove('/billing', NOW)).toBe(false);
    expect(reloadDueAtMove('/admin/today', NOW)).toBe(false);
    expect(reloadDueAtMove('/admin/today/visit/1', NOW)).toBe(false);
    platform.wavesAdmin = true;
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(false);
  });

  test('never without a recent answer from the new server (no signal)', () => {
    liveBuild('bbb222bbb222', NOW - RECENT_ANSWER_MS - 1);
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(false);
  });

  test('once per live build, and never without session storage', () => {
    liveBuild('bbb222bbb222');
    sessionStorage.setItem('portal-reloaded-for', 'bbb222bbb222');
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(false);
    sessionStorage.setItem('portal-reloaded-for', 'old000old000');
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(false);
  });

  test('never while registered work holds it', () => {
    liveBuild('bbb222bbb222');
    holding = true;
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(false);
  });
});

describe('offline', () => {
  test('a tab the browser reports offline is not due, and never reloads or records the build', async () => {
    liveBuild('bbb222bbb222', Date.now());
    expect(reloadDueAtMove('/admin/pipeline')).toBe(true);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(reloadDueAtMove('/admin/pipeline')).toBe(false);
    const reload = vi.fn();
    await expect(reloadForNewBuild({ reload })).resolves.toBe('offline');
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('portal-reloaded-for')).toBeNull();
  });
});

describe('staffReloadBlocker', () => {
  test('names held work on staff pages only, for the stale-chunk reload', () => {
    holding = true;
    expect(staffReloadBlocker('/admin/communications')).toBe('test-hold');
    expect(staffReloadBlocker('/admin/today')).toBe('test-hold');
    expect(staffReloadBlocker('/billing')).toBeNull();
    holding = false;
    expect(staffReloadBlocker('/admin/communications')).toBeNull();
  });

  test('a browser that reports itself offline blocks every reload button, named after held work, and keeps a staff tab', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(reloadBlockers()).toEqual(['offline']);
    expect(staffReloadBlocker('/admin/today')).toBe('offline');
    expect(staffReloadBlocker('/billing')).toBeNull();
    holding = true;
    expect(reloadBlockers()).toEqual(['test-hold', 'offline']);
    expect(staffReloadBlocker('/admin/today')).toBe('test-hold');
  });
});

describe('reloadForNewBuild', () => {
  test('reloads once and records the build', async () => {
    liveBuild('bbb222bbb222', Date.now());
    const reload = vi.fn();
    await expect(reloadForNewBuild({ reload })).resolves.toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('portal-reloaded-for')).toBe('bbb222bbb222');
    await expect(reloadForNewBuild({ reload })).resolves.toBe('reloaded');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('waits for a write to the device storage that the closing page started, then reloads', async () => {
    vi.useFakeTimers();
    liveBuild('bbb222bbb222', Date.now());
    let finishWrite;
    countDeviceWrite(new Promise((resolve) => { finishWrite = resolve; }));
    const reload = vi.fn();
    const done = reloadForNewBuild({ reload });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
    expect(staffReloadBlocker('/admin/dispatch')).toBe('saving');
    finishWrite();
    await vi.advanceTimersByTimeAsync(400);
    await expect(done).resolves.toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a hold that starts as the old page closes still stops it', async () => {
    liveBuild('bbb222bbb222', Date.now());
    holding = true;
    const reload = vi.fn();
    await expect(reloadForNewBuild({ reload })).resolves.toBe('test-hold');
    expect(reload).not.toHaveBeenCalled();
  });

  test('does not reload after the user moved on', async () => {
    liveBuild('bbb222bbb222', Date.now());
    const reload = vi.fn();
    await expect(reloadForNewBuild({ reload, current: () => false })).resolves.toBe('moved');
    expect(reload).not.toHaveBeenCalled();
  });

  describe('with a save on its way', () => {
    let finishSave;
    let uninstall;
    beforeEach(() => {
      vi.useFakeTimers();
      const target = { fetch: () => new Promise((resolve) => { finishSave = () => resolve({ headers: new Headers() }); }) };
      uninstall = installPortalVersionWatch({ target });
      target.fetch('/api/admin/estimates', { method: 'POST' });
      liveBuild('bbb222bbb222', Date.now());
    });
    afterEach(() => uninstall());

    test('waits for it, then reloads', async () => {
      const reload = vi.fn();
      const done = reloadForNewBuild({ reload });
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).not.toHaveBeenCalled();
      finishSave();
      await vi.advanceTimersByTimeAsync(400);
      await expect(done).resolves.toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    test('a wait that outlasts the 5-minute signal ends with no reload', async () => {
      liveBuild('bbb222bbb222', Date.now() - RECENT_ANSWER_MS + 2000);
      const reload = vi.fn();
      const done = reloadForNewBuild({ reload });
      await vi.advanceTimersByTimeAsync(3000);
      finishSave();
      await vi.advanceTimersByTimeAsync(400);
      await expect(done).resolves.toBe('no-signal');
      expect(reload).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('portal-reloaded-for')).toBeNull();
    });

    test('gives up after 10 seconds', async () => {
      const reload = vi.fn();
      const done = reloadForNewBuild({ reload });
      await vi.advanceTimersByTimeAsync(WRITE_WAIT_MS + 400);
      await expect(done).resolves.toBe('saving');
      expect(reload).not.toHaveBeenCalled();
      finishSave();
    });
  });
});
