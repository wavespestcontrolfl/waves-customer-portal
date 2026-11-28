// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ native: true, platform: 'android', pluginAvailable: true }));
const StatusBar = vi.hoisted(() => ({
  setStyle: vi.fn(async () => {}),
  setBackgroundColor: vi.fn(async () => {}),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: vi.fn(() => env.pluginAvailable) },
}));
vi.mock('./platform', () => ({
  isNativeApp: () => env.native,
  nativePlatform: () => env.platform,
}));
vi.mock('@capacitor/status-bar', () => ({
  StatusBar,
  Style: { Light: 'LIGHT', Dark: 'DARK', Default: 'DEFAULT' },
}));

import { CUSTOMER_STATUS_BAR_COLOR, initNativeChrome } from './nativeChrome';

beforeEach(() => {
  env.native = true;
  env.platform = 'android';
  env.pluginAvailable = true;
  vi.clearAllMocks();
});

describe('initNativeChrome', () => {
  it('sets dark icons (Style.Light) and light glass background color on Android', async () => {
    expect(await initNativeChrome()).toBe(true);
    expect(StatusBar.setStyle).toHaveBeenCalledWith({ style: 'LIGHT' });
    expect(StatusBar.setBackgroundColor).toHaveBeenCalledWith({ color: CUSTOMER_STATUS_BAR_COLOR });
  });

  it('sets Style.Light on iOS without calling Android-only setBackgroundColor', async () => {
    env.platform = 'ios';
    expect(await initNativeChrome()).toBe(true);
    expect(StatusBar.setStyle).toHaveBeenCalledWith({ style: 'LIGHT' });
    expect(StatusBar.setBackgroundColor).not.toHaveBeenCalled();
  });

  it('is a safe no-op on web and on older binaries without the StatusBar plugin', async () => {
    env.native = false;
    expect(await initNativeChrome()).toBe(false);
    expect(StatusBar.setStyle).not.toHaveBeenCalled();

    env.native = true;
    env.pluginAvailable = false;
    expect(await initNativeChrome()).toBe(false);
    expect(StatusBar.setStyle).not.toHaveBeenCalled();
  });
});
