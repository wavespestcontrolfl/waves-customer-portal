// @vitest-environment jsdom
// The tab learns that a newer build is live from staff API answers. The
// regressions that matter: a late answer from the old server during a deploy
// flipping the tab back, a page without the build tag (dev) acting out of
// date, the watch reading answers it should not, and a save that is still on
// its way not counted (the reload must wait for it).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  heardFromServerWithin,
  installPortalVersionWatch,
  newerBuild,
  noteServerAnswer,
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

  test('returns the answer untouched and removes itself only while it is outermost', async () => {
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
