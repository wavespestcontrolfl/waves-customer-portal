// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { initNativeLinks, sameOriginUrl } from './nativeLinks';

const loc = { origin: 'https://portal.wavespestcontrol.com' };

describe('nativeLinks', () => {
  it('initNativeLinks is an inert no-op on web — must never touch location', async () => {
    const before = window.location.href;
    await expect(initNativeLinks()).resolves.toBeUndefined();
    expect(window.location.href).toBe(before);
  });

  it('sameOriginUrl accepts portal universal links and preserves path/query/hash', () => {
    expect(sameOriginUrl('https://portal.wavespestcontrol.com/l/abc123', loc).pathname).toBe('/l/abc123');
    const url = sameOriginUrl('https://portal.wavespestcontrol.com/pay/tok?src=sms#top', loc);
    expect(`${url.pathname}${url.search}${url.hash}`).toBe('/pay/tok?src=sms#top');
  });

  it('refuses foreign hosts and garbage — webview must not be steerable', () => {
    expect(sameOriginUrl('https://evil.example.com/pay/tok', loc)).toBeNull();
    // Same registrable domain but different host is still a different origin.
    expect(sameOriginUrl('https://www.wavespestcontrol.com/app', loc)).toBeNull();
    expect(sameOriginUrl('http://portal.wavespestcontrol.com/pay', loc)).toBeNull();
    expect(sameOriginUrl('not a url', loc)).toBeNull();
    expect(sameOriginUrl('', loc)).toBeNull();
    expect(sameOriginUrl(null, loc)).toBeNull();
  });

  it('refuses protocol-relative smuggling via a same-origin double-slash path', () => {
    // pathname is //evil.example/login — location.assign(path) would treat it
    // as scheme-relative and leave the origin (codex P1 on #2496).
    expect(sameOriginUrl('https://portal.wavespestcontrol.com//evil.example/login', loc)).toBeNull();
    expect(sameOriginUrl('https://portal.wavespestcontrol.com//evil.example', loc)).toBeNull();
  });
});
