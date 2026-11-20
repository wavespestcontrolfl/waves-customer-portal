// @vitest-environment jsdom
// The tab learns that a newer build is live from staff API answers. The
// regressions that matter: a late answer from the old server during a deploy
// flipping the tab back, a page without the build tag (dev) acting out of
// date, the watch reading answers it should not, and a save that is still on
// its way not counted (the reload must wait for it).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  countRequestWait,
  heardFromServerWithin,
  installPortalVersionWatch,
  newerBuild,
  noteServerAnswer,
  requestsInFlight,
  resetPortalVersionForTests,
  subscribePortalVersion,
  writesInFlight,
} from './portalVersion';

const answer = (build, boot) => new Headers({ 'X-Portal-Build': build, 'X-Portal-Boot': String(boot) });

function setPageBuild(build) {
  document.head.querySelectorAll('meta[name="portal-build"]').forEach((el) => el.remove());
  if (build) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'portal-build');
    meta.setAttribute('content', build);
    document.head.appendChild(meta);
  }
}

beforeEach(() => {
  resetPortalVersionForTests();
  setPageBuild('aaa111aaa111');
});

afterEach(() => setPageBuild(null));

describe('newerBuild', () => {
  test('names the live build once an answer carries one this page did not load', () => {
    expect(newerBuild()).toBeNull();
    noteServerAnswer(answer('aaa111aaa111', 1000));
    expect(newerBuild()).toBeNull();
    noteServerAnswer(answer('bbb222bbb222', 2000));
    expect(newerBuild()).toBe('bbb222bbb222');
  });

  test('a late answer from the server that started earlier never moves the tab back', () => {
    noteServerAnswer(answer('bbb222bbb222', 2000), 100000);
    noteServerAnswer(answer('aaa111aaa111', 1000), 130000);
    expect(newerBuild()).toBe('bbb222bbb222');
  });

  test('a server that started later cannot hold the tab once it goes quiet', () => {
    // An old-build server restarts during a rollout (boot 3000), answers, then
    // drains; the new deployment (boot 2000) keeps answering.
    noteServerAnswer(answer('bbb222bbb222', 2000), 100000);
    noteServerAnswer(answer('aaa111aaa111', 3000), 101000);
    noteServerAnswer(answer('bbb222bbb222', 2000), 130000);
    expect(newerBuild()).toBeNull();
    noteServerAnswer(answer('bbb222bbb222', 2000), 161000);
    expect(newerBuild()).toBe('bbb222bbb222');
  });

  test('a page without the build tag is never out of date', () => {
    setPageBuild(null);
    resetPortalVersionForTests();
    noteServerAnswer(answer('bbb222bbb222', 2000));
    expect(newerBuild()).toBeNull();
  });

  test('answers without both stamps are ignored', () => {
    noteServerAnswer(new Headers({ 'X-Portal-Build': 'bbb222bbb222' }));
    noteServerAnswer(new Headers({ 'X-Portal-Boot': '2000' }));
    expect(newerBuild()).toBeNull();
    expect(heardFromServerWithin(60000)).toBe(false);
  });

  test('tells subscribers when the live build changes, not on every answer', () => {
    const listener = vi.fn();
    subscribePortalVersion(listener);
    noteServerAnswer(answer('bbb222bbb222', 2000));
    noteServerAnswer(answer('bbb222bbb222', 2000));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('knows how long ago the newest server answered', () => {
    noteServerAnswer(answer('bbb222bbb222', 2000), 10000);
    expect(heardFromServerWithin(5000, 14000)).toBe(true);
    expect(heardFromServerWithin(5000, 16000)).toBe(false);
  });
});

describe('installPortalVersionWatch', () => {
  let target;
  let uninstall;
  afterEach(() => uninstall?.());

  test('reads the stamps on same-origin API answers only', async () => {
    target = { fetch: vi.fn(async () => ({ ok: true, headers: answer('bbb222bbb222', 2000) })) };
    uninstall = installPortalVersionWatch({ target });
    await target.fetch('https://elsewhere.example/api/admin/x');
    await target.fetch('/assets/index.js');
    expect(newerBuild()).toBeNull();
    await target.fetch('/api/admin/notifications/unread-count');
    expect(newerBuild()).toBe('bbb222bbb222');
  });

  test('counts an API write until its answer arrives, also when it fails', async () => {
    const pending = [];
    target = { fetch: vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))) };
    uninstall = installPortalVersionWatch({ target });
    const read = target.fetch('/api/admin/leads');
    const save = target.fetch('/api/admin/estimates', { method: 'POST' });
    const request = new Request(`${window.location.origin}/api/admin/estimates/1`, { method: 'PUT' });
    const put = target.fetch(request);
    expect(writesInFlight()).toBe(2);
    pending[1].resolve({ headers: new Headers() });
    await save;
    expect(writesInFlight()).toBe(1);
    pending[2].reject(new Error('offline'));
    await expect(put).rejects.toThrow('offline');
    expect(writesInFlight()).toBe(0);
    pending[0].resolve({ headers: new Headers() });
    await read;
  });

  test('counts every API request until its answer arrives, and each read of its body until it settles, so a check before a send never shows zero to a timer', async () => {
    const pending = [];
    target = { fetch: vi.fn(() => new Promise((resolve) => pending.push(resolve))) };
    uninstall = installPortalVersionWatch({ target });
    const timerSees = () => new Promise((resolve) => { setTimeout(() => resolve(requestsInFlight()), 0); });
    let finishBody;
    // The mobile checkout: read the discount setting, then post the invoice.
    const checkout = (async () => {
      const res = await target.fetch('/api/admin/discounts/stacking');
      const setting = await res.json();
      return target.fetch('/api/admin/schedule/1/invoice', { method: 'POST', body: JSON.stringify(setting) });
    })();
    expect(requestsInFlight()).toBe(1);
    expect(writesInFlight()).toBe(0);
    pending[0]({ headers: new Headers(), json: () => new Promise((resolve) => { finishBody = resolve; }) });
    expect(await timerSees()).toBe(1);
    finishBody({ enabled: true });
    expect(await timerSees()).toBe(1);
    expect(writesInFlight()).toBe(1);
    pending[1]({ headers: new Headers() });
    await checkout;
    expect(requestsInFlight()).toBe(0);
  });

  test('a body read that fails ends its count, a copy of an answer counts its own read, and other answers are not counted', async () => {
    let failRead;
    let finishCopy;
    const copy = { json: () => new Promise((resolve) => { finishCopy = resolve; }) };
    target = {
      fetch: vi.fn(async (url) => (String(url).startsWith('/api/')
        ? { headers: new Headers(), json: () => new Promise((_resolve, reject) => { failRead = reject; }), clone: () => copy }
        : { headers: new Headers(), json: async () => ({}) })),
    };
    uninstall = installPortalVersionWatch({ target });
    const res = await target.fetch('/api/admin/leads');
    const read = res.json();
    const copied = res.clone().json();
    expect(requestsInFlight()).toBe(2);
    failRead(new Error('not JSON'));
    await expect(read).rejects.toThrow('not JSON');
    expect(requestsInFlight()).toBe(1);
    finishCopy({});
    await copied;
    expect(requestsInFlight()).toBe(0);
    const asset = await target.fetch('/assets/manifest.json');
    const assetRead = asset.json();
    expect(requestsInFlight()).toBe(0);
    await assetRead;
  });

  test('a wait that belongs to a request counts as it, a write as a write, until it settles, failed or not; other requests are not counted', async () => {
    let endRetryWait;
    const retryWait = countRequestWait(new Promise((resolve) => { endRetryWait = resolve; }), '/api/admin/dispatch/1/status', { method: 'POST' });
    expect([requestsInFlight(), writesInFlight()]).toEqual([1, 1]);
    const readWait = countRequestWait(Promise.reject(new Error('stopped')), '/api/admin/dashboard');
    expect([requestsInFlight(), writesInFlight()]).toEqual([2, 1]);
    await expect(readWait).rejects.toThrow('stopped');
    expect([requestsInFlight(), writesInFlight()]).toEqual([1, 1]);
    endRetryWait();
    await retryWait;
    expect([requestsInFlight(), writesInFlight()]).toEqual([0, 0]);
    await countRequestWait(Promise.resolve(), 'https://elsewhere.example/api/x', { method: 'POST' });
    expect([requestsInFlight(), writesInFlight()]).toEqual([0, 0]);
  });

  test('returns the same answer and removes itself only while it is outermost', async () => {
    const response = { ok: true, headers: new Headers() };
    const original = vi.fn(async () => response);
    target = { fetch: original };
    uninstall = installPortalVersionWatch({ target });
    await expect(target.fetch('/api/admin/x')).resolves.toBe(response);
    const later = vi.fn();
    target.fetch = later;
    uninstall();
    expect(target.fetch).toBe(later);
    target.fetch = original;
  });
});
