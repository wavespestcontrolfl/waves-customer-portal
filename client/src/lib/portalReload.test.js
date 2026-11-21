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
import { RECENT_ANSWER_MS, WRITE_WAIT_MS, moveBlockerFor, noteMoveOutcome, pageLoadNote, reloadBlockerAtMove, reloadBlockers, reloadForNewBuild, resetPageLoadNoteForTests } from './portalReload';
import { adminFetch } from '../utils/admin-fetch';

const NOW = 1_000_000;
let holding = false;
registerReloadHold('test-hold', () => holding);

function liveBuild(build, heardAt = NOW) {
  noteServerAnswer(new Headers({ 'X-Portal-Build': build, 'X-Portal-Boot': '2000' }), heardAt);
}

beforeEach(() => {
  resetPortalVersionForTests();
  resetPageLoadNoteForTests();
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

describe('reloadBlockerAtMove', () => {
  test('a move to a staff page in an out-of-date tab is due a reload', () => {
    liveBuild('bbb222bbb222');
    expect(reloadBlockerAtMove('/admin/pipeline', NOW)).toBeNull();
  });

  test('never while the tab runs the live build', () => {
    liveBuild('aaa111aaa111');
    expect(reloadBlockerAtMove('/admin/pipeline', NOW)).toBe('current');
  });

  test('a move to the /admin index is not a page move, as it only redirects; the move on to the page it lands on decides', () => {
    liveBuild('bbb222bbb222');
    expect(reloadBlockerAtMove('/admin', NOW, '/admin/pipeline')).toBe('admin-index');
    expect(reloadBlockerAtMove('/admin/', NOW, '/admin/pipeline')).toBe('admin-index');
    expect(reloadBlockerAtMove('/Admin', NOW, '/admin/pipeline')).toBe('admin-index');
    expect(reloadBlockerAtMove('/%61dmin', NOW, '/admin/pipeline')).toBe('admin-index');
    // The router matches it with any number of trailing slashes too.
    expect(reloadBlockerAtMove('/admin///', NOW, '/admin/pipeline')).toBe('admin-index');
    expect(reloadBlockerAtMove('/%61dmin///', NOW, '/admin/pipeline')).toBe('admin-index');
    // The dashboard landing reloads. Today, for a technician or with Field
    // view on, does not.
    expect(reloadBlockerAtMove('/admin/dashboard', NOW, '/admin')).toBeNull();
    expect(reloadBlockerAtMove('/admin/today', NOW, '/admin')).toBe('field-page');
  });

  test('never on customer pages, the field pages or in Waves Admin', () => {
    liveBuild('bbb222bbb222');
    expect(reloadBlockerAtMove('/billing', NOW)).toBe('not-staff');
    expect(reloadBlockerAtMove('/admin/today', NOW)).toBe('field-page');
    expect(reloadBlockerAtMove('/admin/today/visit/1', NOW)).toBe('field-page');
    // Read as the routes match it: an encoded segment still opens Today.
    expect(reloadBlockerAtMove('/admin/%74oday', NOW)).toBe('field-page');
    expect(reloadBlockerAtMove('/%61dmin/dashboard', NOW)).toBeNull();
    // Nor at a move away from a field page: a time-clock punch there can
    // still be waiting for the location.
    expect(reloadBlockerAtMove('/admin/pipeline', NOW, '/admin/today')).toBe('field-page');
    expect(reloadBlockerAtMove('/admin/pipeline', NOW, '/admin/today/truck-check')).toBe('field-page');
    expect(reloadBlockerAtMove('/admin/pipeline', NOW, '/%61dmin/today')).toBe('field-page');
    expect(reloadBlockerAtMove('/admin/pipeline', NOW, '/admin/dashboard')).toBeNull();
    platform.wavesAdmin = true;
    expect(reloadBlockerAtMove('/admin/pipeline', NOW)).toBe('waves-admin');
  });

  test('never without a recent answer from the new server (no signal)', () => {
    liveBuild('bbb222bbb222', NOW - RECENT_ANSWER_MS - 1);
    expect(reloadBlockerAtMove('/admin/pipeline', NOW)).toBe('no-signal');
  });

  test('up to three tries per live build, as a reload can come back on the old page, and never without session storage', () => {
    liveBuild('bbb222bbb222');
    sessionStorage.setItem('portal-reloaded-for', JSON.stringify({ build: 'bbb222bbb222', tries: 2 }));
    expect(reloadBlockerAtMove('/admin/pipeline', NOW)).toBeNull();
    sessionStorage.setItem('portal-reloaded-for', JSON.stringify({ build: 'bbb222bbb222', tries: 3 }));
    expect(reloadBlockerAtMove('/admin/pipeline', NOW)).toBe('reloaded');
    sessionStorage.setItem('portal-reloaded-for', JSON.stringify({ build: 'old000old000', tries: 3 }));
    expect(reloadBlockerAtMove('/admin/pipeline', NOW)).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(reloadBlockerAtMove('/admin/pipeline', NOW)).toBe('storage');
  });

  test('never while registered work holds it', () => {
    liveBuild('bbb222bbb222');
    holding = true;
    expect(reloadBlockerAtMove('/admin/pipeline', NOW)).toBe('test-hold');
  });

  test('a tab that knows no newer build names current once a staff answer named its own build, and never-heard before; a page that never reloads by itself names its rule first', () => {
    expect(reloadBlockerAtMove('/admin/pipeline', NOW)).toBe('never-heard');
    expect(reloadBlockerAtMove('/admin/today', NOW)).toBe('field-page');
    liveBuild('aaa111aaa111', NOW - RECENT_ANSWER_MS - 1);
    expect(reloadBlockerAtMove('/admin/pipeline', NOW)).toBe('current');
  });
});

describe('the move note for the usage beacon', () => {
  test('names the latest move\'s blocker for the page that move opened, as the router reads it, and nothing for another page', () => {
    noteMoveOutcome('/admin/pipeline', 'card-payment');
    expect(moveBlockerFor('/admin/pipeline')).toBe('card-payment');
    expect(moveBlockerFor('/%61dmin/Pipeline')).toBe('card-payment');
    expect(moveBlockerFor('/admin/dashboard')).toBeNull();
    // Trailing slashes do not count: Settings reports /admin/settings when the
    // router opened /admin/settings/.
    noteMoveOutcome('/admin/settings/', 'card-payment');
    expect(moveBlockerFor('/admin/settings')).toBe('card-payment');
    noteMoveOutcome('/admin/settings', 'card-payment');
    expect(moveBlockerFor('/admin/settings//')).toBe('card-payment');
    expect(moveBlockerFor('/admin/settings/general')).toBeNull();
    noteMoveOutcome('/admin/dashboard', null);
    expect(moveBlockerFor('/admin/dashboard')).toBeNull();
    expect(moveBlockerFor('/admin/pipeline')).toBeNull();
  });
});

describe('offline', () => {
  test('a tab the browser reports offline is not due, and never reloads or records the build', async () => {
    liveBuild('bbb222bbb222', Date.now());
    expect(reloadBlockerAtMove('/admin/pipeline')).toBeNull();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(reloadBlockerAtMove('/admin/pipeline')).toBe('offline');
    const reload = vi.fn();
    await expect(reloadForNewBuild({ reload })).resolves.toBe('offline');
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('portal-reloaded-for')).toBeNull();
  });
});

describe('reloadBlockers', () => {
  test('a request still open blocks every reload button: a read as request, a save as saving, and both while both are open', async () => {
    const pending = [];
    const target = { fetch: () => new Promise((resolve) => pending.push(resolve)) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      const read = target.fetch('/api/admin/discounts/stacking');
      expect(reloadBlockers()).toEqual(['request']);
      const save = target.fetch('/api/admin/schedule/1/invoice', { method: 'POST' });
      expect(reloadBlockers()).toEqual(['saving', 'request']);
      pending[0]({ headers: new Headers() });
      await read;
      expect(reloadBlockers()).toEqual(['saving']);
      pending[1]({ headers: new Headers() });
      await save;
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

// A reload can come back on the old build (the service worker's saved copy).
// That page load must not read as an ordinary first page.
describe('the page-load note', () => {
  const marker = () => JSON.parse(sessionStorage.getItem('portal-reloaded-for'));
  // The page loads again: the module starts over, the tab's storage stays.
  const loadAgain = (build) => {
    document.head.querySelectorAll('meta[name="portal-build"]').forEach((el) => el.remove());
    document.head.insertAdjacentHTML('beforeend', `<meta name="portal-build" content="${build}">`);
    resetPortalVersionForTests();
    resetPageLoadNoteForTests();
  };

  test('an ordinary page load reads first-page, also in a tab whose earlier reload was already read', () => {
    expect(pageLoadNote()).toBe('first-page');
    sessionStorage.setItem('portal-reloaded-for', JSON.stringify({ build: 'bbb222bbb222', tries: 1 }));
    loadAgain('aaa111aaa111');
    expect(pageLoadNote()).toBe('first-page');
  });

  test('a reload that came back on the old build reads reload-missed for that page load only, and its try still counts', async () => {
    liveBuild('bbb222bbb222', Date.now());
    await expect(reloadForNewBuild({ reload: vi.fn() })).resolves.toBeNull();
    loadAgain('aaa111aaa111');
    expect(pageLoadNote()).toBe('reload-missed');
    // The same answer for as long as this page lives.
    expect(pageLoadNote()).toBe('reload-missed');
    expect(marker()).toEqual({ build: 'bbb222bbb222', tries: 1 });
    // The person loads the tab again later: no reload of this module came before it.
    loadAgain('aaa111aaa111');
    expect(pageLoadNote()).toBe('first-page');
  });

  test('a reload that landed on its build reads first-page', async () => {
    liveBuild('bbb222bbb222', Date.now());
    await expect(reloadForNewBuild({ reload: vi.fn() })).resolves.toBeNull();
    loadAgain('bbb222bbb222');
    expect(pageLoadNote()).toBe('first-page');
    expect(marker()).toEqual({ build: 'bbb222bbb222', tries: 1 });
  });

  // A rollout can move on between the answer and the reload: the tab on A
  // hears B and its reload lands on C. The tab updated.
  test('a reload that landed on a later build than the one it was made for reads first-page', async () => {
    liveBuild('bbb222bbb222', Date.now());
    await expect(reloadForNewBuild({ reload: vi.fn() })).resolves.toBeNull();
    loadAgain('ccc333ccc333');
    expect(pageLoadNote()).toBe('first-page');
    expect(marker()).toEqual({ build: 'bbb222bbb222', tries: 1 });
  });

  test('storage that cannot be read reads first-page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(pageLoadNote()).toBe('first-page');
  });
});

describe('reloadForNewBuild', () => {
  test('reloads and counts the try, in the same turn when no work is open; a reload that came back on the old page tries again, three times at most', async () => {
    liveBuild('bbb222bbb222', Date.now());
    const reload = vi.fn();
    const first = reloadForNewBuild({ reload });
    // No work is open, so there is no wait (waitForWork): the reload runs in
    // the gate's own effect, as before the stale-chunk reload shared the wait.
    expect(reload).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toBeNull();
    expect(JSON.parse(sessionStorage.getItem('portal-reloaded-for'))).toEqual({ build: 'bbb222bbb222', tries: 1, from: 'aaa111aaa111' });
    await expect(reloadForNewBuild({ reload })).resolves.toBeNull();
    await expect(reloadForNewBuild({ reload })).resolves.toBeNull();
    expect(reload).toHaveBeenCalledTimes(3);
    await expect(reloadForNewBuild({ reload })).resolves.toBe('reloaded');
    expect(reload).toHaveBeenCalledTimes(3);
  });

  test('a tab that cannot read its count in session storage never reloads, and names storage', async () => {
    liveBuild('bbb222bbb222', Date.now());
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const reload = vi.fn();
    await expect(reloadForNewBuild({ reload })).resolves.toBe('storage');
    expect(reload).not.toHaveBeenCalled();
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
      expect(reloadBlockerAtMove('/admin/pipeline', Date.now())).toBeNull();
      const reload = vi.fn();
      const done = reloadForNewBuild({ reload });
      await vi.advanceTimersByTimeAsync(WRITE_WAIT_MS + 400);
      await expect(done).resolves.toBe('saving');
      // The same save is still open: the next move opens its page at once,
      // with no second 10 s wait.
      expect(reloadBlockerAtMove('/admin/dashboard', Date.now())).toBe('stalled');
      finishSave();
      await vi.advanceTimersByTimeAsync(400);
      // Once it settles, a move is due again, also while new work is open.
      let finishWrite;
      countDeviceWrite(new Promise((resolve) => { finishWrite = resolve; }));
      expect(reloadBlockerAtMove('/admin/dashboard', Date.now())).toBeNull();
      finishWrite();
      await vi.advanceTimersByTimeAsync(0);
      expect(reload).not.toHaveBeenCalled();
    });
  });
});
