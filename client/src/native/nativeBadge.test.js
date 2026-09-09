// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureNativeBadgeUpdate, clearNativeBadge } from './nativeBadge';
import { ApiClient } from '../utils/api';

const native = vi.hoisted(() => ({ platform: 'ios', available: true, setCount: vi.fn() }));
vi.mock('./platform', () => ({ nativePlatform: () => native.platform }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: () => native.available },
  registerPlugin: () => ({ setCount: native.setCount }),
}));

beforeEach(async () => {
  native.platform = 'ios';
  native.available = true;
  native.setCount.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  await clearNativeBadge();
  native.setCount.mockClear();
});

describe('native inbox badges', () => {
  it('writes a confirmed count and removes the badge at zero', async () => {
    const update = captureNativeBadgeUpdate();
    expect(await update(7)).toBe(true);
    expect(await update(0)).toBe(true);
    expect(native.setCount.mock.calls).toEqual([[{ count: 7 }], [{ count: 0 }]]);
  });

  it.each(['web', 'android'])('does nothing on %s', async (platform) => {
    native.platform = platform;
    expect(await captureNativeBadgeUpdate()(7)).toBe(false);
    expect(native.setCount).not.toHaveBeenCalled();
  });

  it('is compatible with an older iOS binary without the bridge', async () => {
    native.available = false;
    expect(await captureNativeBadgeUpdate()(7)).toBe(false);
    expect(native.setCount).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, NaN, Infinity, '3', null, undefined, 2147483648])('rejects invalid count %s without clearing', async (count) => {
    expect(await captureNativeBadgeUpdate()(count)).toBe(false);
    expect(native.setCount).not.toHaveBeenCalled();
  });

  it('ignores a response captured before sign-out', async () => {
    const update = captureNativeBadgeUpdate();
    await clearNativeBadge();
    expect(await update(9)).toBe(false);
    expect(native.setCount.mock.calls).toEqual([[{ count: 0 }]]);
  });

  it('finishes an in-flight OS write before sign-out clears it', async () => {
    let finish;
    native.setCount.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const previous = captureNativeBadgeUpdate()(9);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const clear = clearNativeBadge();
    const next = captureNativeBadgeUpdate()(2);
    finish();
    await Promise.all([previous, clear, next]);
    expect(native.setCount.mock.calls).toEqual([[{ count: 9 }], [{ count: 0 }], [{ count: 2 }]]);
  });

  it('absorbs permission/native failures and retries the next update', async () => {
    native.setCount.mockRejectedValueOnce(new Error('Badges are disabled'));
    expect(await captureNativeBadgeUpdate()(2)).toBe(false);
    expect(await captureNativeBadgeUpdate()(1)).toBe(true);
  });

  it('keeps token rotation valid but invalidates badges across properties and logout', async () => {
    const token = (customerId, sessionId, exp) => `header.${btoa(JSON.stringify({ customerId, sessionId, exp }))}.signature`;
    const client = new ApiClient();
    client.setTokens(token('fixture-a', 'session-a', 1), 'fixture-refresh');
    const update = captureNativeBadgeUpdate();
    client.setTokens(token('fixture-a', 'session-a', 2), 'rotated-refresh');
    expect(await update(3)).toBe(true);
    client.setTokens(token('fixture-b', 'session-b', 2), 'property-refresh');
    expect(await update(3)).toBe(false);
    const next = captureNativeBadgeUpdate();
    client.clearTokens();
    expect(await next(4)).toBe(false);
    expect(native.setCount).toHaveBeenLastCalledWith({ count: 0 });
  });
});
