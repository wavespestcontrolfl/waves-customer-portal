// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Lock Screen visit card's web side: what this iPhone reports to the server, and when it stays silent.
const native = vi.hoisted(() => ({
  platform: 'ios',
  available: true,
  status: vi.fn(),
  endAll: vi.fn(),
  addListener: vi.fn(),
  listeners: {},
  request: vi.fn(),
}));
vi.mock('./platform', () => ({ nativePlatform: () => native.platform }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: (name) => name === 'WavesVisitCard' && native.available },
  registerPlugin: () => ({ status: native.status, endAll: native.endAll, addListener: native.addListener }),
}));
vi.mock('../utils/api', () => ({ default: { request: native.request } }));

const START = 'a1b2c3d4'.repeat(8);
let reportVisitCard;
let endVisitCards;
const posted = () => native.request.mock.calls.map(([path, options]) => [path, options.method, JSON.parse(options.body)]);

beforeEach(async () => {
  native.platform = 'ios';
  native.available = true;
  native.listeners = {};
  native.status.mockReset().mockResolvedValue({ supported: true, enabled: true, osVersion: '18.5.1', startToken: START });
  native.endAll.mockReset().mockResolvedValue({ ended: 1 });
  native.addListener.mockReset().mockImplementation(async (name, callback) => { native.listeners[name] = callback; return { remove: vi.fn() }; });
  native.request.mockReset().mockResolvedValue({ ok: true, stored: true });
  // The module keeps the listener and the device token in use: start each test from a fresh copy.
  vi.resetModules();
  ({ reportVisitCard, endVisitCards } = await import('./visitCard'));
});

describe('Lock Screen visit card, web side', () => {
  it('posts this phone\'s start token and iOS version against its push registration', async () => {
    expect(await reportVisitCard('apns-device-1')).toBe(true);
    expect(posted()).toEqual([['/push/live-activity-token', 'POST', {
      deviceToken: 'apns-device-1', startToken: START, osVersion: '18.5.1', enabled: true,
    }]]);
  });

  it('with Live Activities off for the app, it says so and sends no token, so the server clears what it held', async () => {
    native.status.mockResolvedValue({ supported: true, enabled: false, osVersion: '18.5.1', startToken: START });
    native.request.mockResolvedValue({ ok: true, stored: false });
    expect(await reportVisitCard('apns-device-1')).toBe(false);
    expect(posted()[0][2]).toEqual({ deviceToken: 'apns-device-1', startToken: null, osVersion: '18.5.1', enabled: false });
  });

  it('an iPhone below iOS 17.2 reports that it cannot show the card', async () => {
    native.status.mockResolvedValue({ supported: false, enabled: false, osVersion: '16.7.2' });
    await reportVisitCard('apns-device-1');
    expect(posted()[0][2]).toEqual({ deviceToken: 'apns-device-1', startToken: null, osVersion: '16.7.2', enabled: false });
  });

  it('a start token that arrives later is posted against the same registration, and the listener is bound once', async () => {
    native.status.mockResolvedValueOnce({ supported: true, enabled: true, osVersion: '18.5.1' });
    await reportVisitCard('apns-device-1');
    await reportVisitCard('apns-device-1');
    expect(native.addListener).toHaveBeenCalledTimes(1);
    expect(posted()[0][2].startToken).toBeNull();

    native.request.mockClear();
    native.listeners.startToken({ startToken: START });
    await vi.waitFor(() => expect(native.request).toHaveBeenCalledTimes(1));
    expect(posted()[0][2]).toEqual({ deviceToken: 'apns-device-1', startToken: START, osVersion: '18.5.1', enabled: true });
  });

  it.each(['web', 'android'])('does nothing on %s', async (platform) => {
    native.platform = platform;
    expect(await reportVisitCard('device-1')).toBe(false);
    expect(await endVisitCards()).toBe(false);
    expect(native.status).not.toHaveBeenCalled();
    expect(native.endAll).not.toHaveBeenCalled();
    expect(native.request).not.toHaveBeenCalled();
  });

  it('does nothing in an app version without the plugin', async () => {
    native.available = false;
    expect(await reportVisitCard('apns-device-1')).toBe(false);
    expect(await endVisitCards()).toBe(false);
    expect(native.request).not.toHaveBeenCalled();
  });

  it('needs the device token of the push registration', async () => {
    for (const token of [undefined, null, '', 42]) expect(await reportVisitCard(token)).toBe(false);
    expect(native.request).not.toHaveBeenCalled();
  });

  it('a failing plugin or a failing request is swallowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    native.status.mockRejectedValueOnce(new Error('bridge is away'));
    expect(await reportVisitCard('apns-device-1')).toBe(false);
    native.request.mockRejectedValueOnce(new Error('offline'));
    expect(await reportVisitCard('apns-device-1')).toBe(false);
    native.endAll.mockRejectedValueOnce(new Error('bridge is away'));
    expect(await endVisitCards()).toBe(false);
    warn.mockRestore();
  });

  it('sign-out ends this app\'s cards and stops posting new start tokens', async () => {
    await reportVisitCard('apns-device-1');
    native.request.mockClear();

    expect(await endVisitCards()).toBe(true);
    expect(native.endAll).toHaveBeenCalledTimes(1);
    // A token iOS hands over after sign-out belongs to no signed-in customer.
    native.listeners.startToken({ startToken: START });
    await Promise.resolve();
    expect(native.request).not.toHaveBeenCalled();
  });
});
