// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  customerAppUrl,
  initNativeLinks,
  navigateToCustomerUrl,
  sameOriginUrl,
} from './nativeLinks';

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

  it('accepts customer push paths but rejects foreign, privileged, and ambiguous destinations', () => {
    expect(customerAppUrl('/?tab=documents', loc).href)
      .toBe('https://portal.wavespestcontrol.com/?tab=documents');
    expect(customerAppUrl('https://portal.wavespestcontrol.com/pay/token', loc).pathname).toBe('/pay/token');

    expect(customerAppUrl('https://evil.example/pay/token', loc)).toBeNull();
    expect(customerAppUrl('//evil.example/pay/token', loc)).toBeNull();
    expect(customerAppUrl('/admin/customers', loc)).toBeNull();
    expect(customerAppUrl('/tech', loc)).toBeNull();
    expect(customerAppUrl('/api/billing', loc)).toBeNull();
    expect(customerAppUrl('evil.example/login', loc)).toBeNull();
  });

  it('navigates only after validation and preserves query/hash', () => {
    const assign = vi.fn();
    const navigationLocation = {
      ...loc,
      pathname: '/',
      search: '',
      hash: '',
      assign,
    };

    expect(navigateToCustomerUrl('/report/token?from=push#photos', navigationLocation)).toBe(true);
    expect(assign).toHaveBeenCalledWith('https://portal.wavespestcontrol.com/report/token?from=push#photos');

    expect(navigateToCustomerUrl('https://evil.example/phish', navigationLocation)).toBe(false);
    expect(navigateToCustomerUrl('/admin', navigationLocation)).toBe(false);
    expect(assign).toHaveBeenCalledTimes(1);
  });
});
