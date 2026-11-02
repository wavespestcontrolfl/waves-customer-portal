// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeAskForAppRating } from './appRating';

const native = vi.hoisted(() => ({
  isNative: true,
  platform: 'ios',
  available: true,
  request: vi.fn(),
  requestReview: vi.fn(),
}));
vi.mock('./platform', () => ({
  isNativeApp: () => native.isNative,
  nativePlatform: () => native.platform,
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: (name) => name === 'InAppReview' && native.available },
}));
vi.mock('../utils/api', () => ({ default: { request: (...a) => native.request(...a) } }));
vi.mock('@capacitor-community/in-app-review', () => ({
  InAppReview: { requestReview: (...a) => native.requestReview(...a) },
}));

// 10:00 ET on consecutive days.
const DAY_1 = new Date('2026-11-02T15:00:00Z');
const DAY_2 = new Date('2026-11-03T15:00:00Z');
const DAY_3 = new Date('2026-11-04T15:00:00Z');

beforeEach(() => {
  native.isNative = true;
  native.platform = 'ios';
  native.available = true;
  native.request.mockReset().mockResolvedValue({ ask: true });
  native.requestReview.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
});

describe('store rating pop-up (GATE_APP_RATING_PROMPT)', () => {
  it('never asks on the first day the phone runs the app, then asks the server and the store from day two', async () => {
    expect(await maybeAskForAppRating({ now: DAY_1 })).toBe(false);
    expect(native.request).not.toHaveBeenCalled();

    expect(await maybeAskForAppRating({ now: DAY_2 })).toBe(true);
    expect(native.request).toHaveBeenCalledTimes(1);
    expect(native.request).toHaveBeenCalledWith('/customer/app-rating/claim', {
      method: 'POST',
      body: JSON.stringify({ platform: 'ios' }),
    });
    expect(native.requestReview).toHaveBeenCalledTimes(1);
  });

  it('checks the server at most once a day', async () => {
    await maybeAskForAppRating({ now: DAY_1 });
    native.request.mockResolvedValue({ ask: false });
    expect(await maybeAskForAppRating({ now: DAY_2 })).toBe(false);
    expect(await maybeAskForAppRating({ now: DAY_2 })).toBe(false);
    expect(native.request).toHaveBeenCalledTimes(1);
    await maybeAskForAppRating({ now: DAY_3 });
    expect(native.request).toHaveBeenCalledTimes(2);
    expect(native.requestReview).not.toHaveBeenCalled();
  });

  it('sends the Android platform from an Android phone', async () => {
    native.platform = 'android';
    await maybeAskForAppRating({ now: DAY_1 });
    expect(await maybeAskForAppRating({ now: DAY_2 })).toBe(true);
    expect(native.request.mock.calls[0][1].body).toBe(JSON.stringify({ platform: 'android' }));
  });

  it.each([
    ['the web portal', () => { native.isNative = false; }],
    ['an older app build without the plugin', () => { native.available = false; }],
  ])('does nothing in %s', async (_label, setUp) => {
    setUp();
    await maybeAskForAppRating({ now: DAY_1 });
    expect(await maybeAskForAppRating({ now: DAY_2 })).toBe(false);
    expect(native.request).not.toHaveBeenCalled();
    expect(native.requestReview).not.toHaveBeenCalled();
  });

  it.each([
    ['the server says no', () => native.request.mockResolvedValue({ ask: false })],
    ['the server call fails', () => native.request.mockRejectedValue(new Error('offline'))],
  ])('does not ask the store when %s', async (_label, setUp) => {
    await maybeAskForAppRating({ now: DAY_1 });
    setUp();
    expect(await maybeAskForAppRating({ now: DAY_2 })).toBe(false);
    expect(native.requestReview).not.toHaveBeenCalled();
  });

  it('drops the ask when the screen stops being quiet during the server round trip', async () => {
    await maybeAskForAppRating({ now: DAY_1 });
    let quiet = true;
    native.request.mockImplementation(async () => { quiet = false; return { ask: true }; });
    expect(await maybeAskForAppRating({ now: DAY_2, stillQuiet: () => quiet })).toBe(false);
    expect(native.request).toHaveBeenCalledTimes(1);
    expect(native.requestReview).not.toHaveBeenCalled();
  });

  it('swallows a store failure', async () => {
    native.requestReview.mockRejectedValue(new Error('no window scene'));
    await maybeAskForAppRating({ now: DAY_1 });
    expect(await maybeAskForAppRating({ now: DAY_2 })).toBe(false);
  });

  it('never asks when storage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      expect(await maybeAskForAppRating({ now: DAY_2 })).toBe(false);
      expect(native.request).not.toHaveBeenCalled();
    } finally {
      getItem.mockRestore();
    }
  });
});
