// @vitest-environment jsdom
// When an out-of-date staff tab reloads by itself (owner 2026-11-19, option A):
// at a page move, on staff pages in a browser, once per live build (up to two
// more tries when a reload came back on the old page), only after a recent
// answer from the new server, and never while work holds it.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const platform = vi.hoisted(() => ({ wavesAdmin: false }));
vi.mock('../native/platform', () => ({ isWavesAdminApp: () => platform.wavesAdmin }));

import { installPortalVersionWatch, noteServerAnswer, resetPortalVersionForTests } from './portalVersion';
import { registerReloadHold } from './reloadHolds';
import { countDeviceWrite } from './deviceWrites';
import { RECENT_ANSWER_MS, WRITE_WAIT_MS, reloadBlockers, reloadDueAtMove, reloadForNewBuild } from './portalReload';
import { adminFetch } from '../utils/admin-fetch';

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

  test('a move to the /admin index is not a page move, as it only redirects; the move on to the page it lands on decides', () => {
    liveBuild('bbb222bbb222');
    expect(reloadDueAtMove('/admin', NOW, '/admin/pipeline')).toBe(false);
    expect(reloadDueAtMove('/admin/', NOW, '/admin/pipeline')).toBe(false);
    expect(reloadDueAtMove('/Admin', NOW, '/admin/pipeline')).toBe(false);
    // The dashboard landing reloads. Today, for a technician or with Field
    // view on, does not.
    expect(reloadDueAtMove('/admin/dashboard', NOW, '/admin')).toBe(true);
    expect(reloadDueAtMove('/admin/today', NOW, '/admin')).toBe(false);
  });

  test('never on customer pages, the field pages or in Waves Admin', () => {
    liveBuild('bbb222bbb222');
    expect(reloadDueAtMove('/billing', NOW)).toBe(false);
    expect(reloadDueAtMove('/admin/today', NOW)).toBe(false);
    expect(reloadDueAtMove('/admin/today/visit/1', NOW)).toBe(false);
    // Nor at a move away from a field page: a time-clock punch there can
    // still be waiting for the location.
    expect(reloadDueAtMove('/admin/pipeline', NOW, '/admin/today')).toBe(false);
    expect(reloadDueAtMove('/admin/pipeline', NOW, '/admin/today/truck-check')).toBe(false);
    expect(reloadDueAtMove('/admin/pipeline', NOW, '/admin/dashboard')).toBe(true);
    platform.wavesAdmin = true;
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(false);
  });

  test('never without a recent answer from the new server (no signal)', () => {
    liveBuild('bbb222bbb222', NOW - RECENT_ANSWER_MS - 1);
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(false);
  });

  test('up to three tries per live build, as a reload can come back on the old page, and never without session storage', () => {
    liveBuild('bbb222bbb222');
    sessionStorage.setItem('portal-reloaded-for', JSON.stringify({ build: 'bbb222bbb222', tries: 2 }));
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(true);
    sessionStorage.setItem('portal-reloaded-for', JSON.stringify({ build: 'bbb222bbb222', tries: 3 }));
    expect(reloadDueAtMove('/admin/pipeline', NOW)).toBe(false);
    sessionStorage.setItem('portal-reloaded-for', JSON.stringify({ build: 'old000old000', tries: 3 }));
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

describe('reloadBlockers', () => {
  test('a request still open blocks every reload button: a read as request, a save as saving', async () => {
    const pending = [];
    const target = { fetch: () => new Promise((resolve) => pending.push(resolve)) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      const read = target.fetch('/api/admin/discounts/stacking');
      expect(reloadBlockers()).toEqual(['request']);
      const save = target.fetch('/api/admin/schedule/1/invoice', { method: 'POST' });
      expect(reloadBlockers()).toEqual(['saving']);
      pending.forEach((resolve) => resolve({ headers: new Headers() }));
      await Promise.all([read, save]);
      expect(reloadBlockers()).toEqual([]);
    } finally {
      uninstall();
    }
  });

  test('a browser that reports itself offline blocks every reload button, named after held work', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(reloadBlockers()).toEqual(['offline']);
    holding = true;
    expect(reloadBlockers()).toEqual(['test-hold', 'offline']);
  });
});

describe('reloadForNewBuild', () => {
  test('reloads and counts the try; a reload that came back on the old page tries again, three times at most', async () => {
    liveBuild('bbb222bbb222', Date.now());
    const reload = vi.fn();
    await expect(reloadForNewBuild({ reload })).resolves.toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem('portal-reloaded-for'))).toEqual({ build: 'bbb222bbb222', tries: 1 });
    await expect(reloadForNewBuild({ reload })).resolves.toBeNull();
    await expect(reloadForNewBuild({ reload })).resolves.toBeNull();
    expect(reload).toHaveBeenCalledTimes(3);
    await expect(reloadForNewBuild({ reload })).resolves.toBe('reloaded');
    expect(reload).toHaveBeenCalledTimes(3);
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
    expect(reloadBlockers()).toEqual(['saving']);
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

  test('waits for a read that leads to a write, as when the checkout reads the discount setting before it posts the invoice, then reloads', async () => {
    vi.useFakeTimers();
    const pending = [];
    const target = { fetch: () => new Promise((resolve) => pending.push(resolve)) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      liveBuild('bbb222bbb222', Date.now());
      const checkout = (async () => {
        const res = await target.fetch('/api/admin/discounts/stacking');
        await res.json();
        return target.fetch('/api/admin/schedule/1/invoice', { method: 'POST' });
      })();
      const reload = vi.fn();
      const done = reloadForNewBuild({ reload });
      pending[0]({ headers: new Headers(), json: async () => ({ enabled: true }) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(pending).toHaveLength(2);
      expect(reload).not.toHaveBeenCalled();
      pending[1]({ headers: new Headers() });
      await checkout;
      await vi.advanceTimersByTimeAsync(400);
      await expect(done).resolves.toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });

  test('waits through the pause before a retry after a 429 answer, as adminFetch counts it as the write still on its way, then reloads', async () => {
    vi.useFakeTimers();
    const answers = [
      new Response(null, { status: 429, headers: { 'Retry-After': '1' } }),
      new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ];
    const network = vi.fn(async () => answers.shift());
    vi.stubGlobal('fetch', network);
    const uninstall = installPortalVersionWatch();
    try {
      liveBuild('bbb222bbb222', Date.now());
      const save = adminFetch('/admin/dispatch/1/status', { method: 'POST', body: '{}' });
      const reload = vi.fn();
      const done = reloadForNewBuild({ reload });
      await vi.advanceTimersByTimeAsync(600);
      expect(network).toHaveBeenCalledTimes(1);
      expect(reloadBlockers()).toEqual(['saving']);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      await expect(save).resolves.toEqual({ ok: true });
      expect(network).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(400);
      await expect(done).resolves.toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
      vi.unstubAllGlobals();
    }
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
      await vi.advanceTimersByTimeAsync(400);
    });

    test('work that outlasts a full wait makes no later move wait again, until all work settles', async () => {
      expect(reloadDueAtMove('/admin/pipeline', Date.now())).toBe(true);
      const reload = vi.fn();
      const done = reloadForNewBuild({ reload });
      await vi.advanceTimersByTimeAsync(WRITE_WAIT_MS + 400);
      await expect(done).resolves.toBe('saving');
      // The same save is still open: the next move opens its page at once,
      // with no second 10 s wait.
      expect(reloadDueAtMove('/admin/dashboard', Date.now())).toBe(false);
      finishSave();
      await vi.advanceTimersByTimeAsync(400);
      // Once it settles, a move is due again, also while new work is open.
      let finishWrite;
      countDeviceWrite(new Promise((resolve) => { finishWrite = resolve; }));
      expect(reloadDueAtMove('/admin/dashboard', Date.now())).toBe(true);
      finishWrite();
      await vi.advanceTimersByTimeAsync(0);
      expect(reload).not.toHaveBeenCalled();
    });
  });
});
