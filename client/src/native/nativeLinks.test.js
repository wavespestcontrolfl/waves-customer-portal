// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { initNativeLinks, sameOriginPath } from './nativeLinks';

describe('nativeLinks', () => {
  it('initNativeLinks is an inert no-op on web — must never touch location', async () => {
    const before = window.location.href;
    await expect(initNativeLinks()).resolves.toBeUndefined();
    expect(window.location.href).toBe(before);
  });

  it('sameOriginPath maps a portal universal link to its in-app path', () => {
    const loc = { origin: 'https://portal.wavespestcontrol.com' };
    expect(sameOriginPath('https://portal.wavespestcontrol.com/l/abc123', loc)).toBe('/l/abc123');
    expect(
      sameOriginPath('https://portal.wavespestcontrol.com/pay/tok?src=sms#top', loc),
    ).toBe('/pay/tok?src=sms#top');
  });

  it('sameOriginPath refuses foreign hosts and garbage — webview must not be steerable', () => {
    const loc = { origin: 'https://portal.wavespestcontrol.com' };
    expect(sameOriginPath('https://evil.example.com/pay/tok', loc)).toBeNull();
    // Same registrable domain but different host is still a different origin.
    expect(sameOriginPath('https://www.wavespestcontrol.com/app', loc)).toBeNull();
    expect(sameOriginPath('http://portal.wavespestcontrol.com/pay', loc)).toBeNull();
    expect(sameOriginPath('not a url', loc)).toBeNull();
    expect(sameOriginPath('', loc)).toBeNull();
    expect(sameOriginPath(null, loc)).toBeNull();
  });
});
