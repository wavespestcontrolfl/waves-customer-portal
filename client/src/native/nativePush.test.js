// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeMocks = vi.hoisted(() => {
  const state = { permission: 'prompt', requestResult: 'granted', listeners: {} };
  const PushNotifications = {
    addListener: vi.fn(async (name, callback) => {
      state.listeners[name] = callback;
      return { remove: vi.fn() };
    }),
    checkPermissions: vi.fn(async () => ({ receive: state.permission })),
    requestPermissions: vi.fn(async () => ({ receive: state.requestResult })),
    register: vi.fn(async () => {}),
  };
  return { state, PushNotifications };
});

const navigateToCustomerUrl = vi.hoisted(() => vi.fn());

vi.mock('./platform', () => ({
  isNativeApp: () => true,
  nativePlatform: () => 'ios',
}));
vi.mock('./nativeLinks', () => ({ navigateToCustomerUrl }));
vi.mock('../utils/api', () => ({ default: { request: vi.fn(async () => ({})) } }));
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: nativeMocks.PushNotifications,
}));

import api from '../utils/api';
import {
  flushNativePushToken,
  initNativePush,
  nativePushPermissionState,
  requestNativePushPermission,
} from './nativePush';

beforeEach(() => {
  nativeMocks.state.permission = 'prompt';
  nativeMocks.state.requestResult = 'granted';
  navigateToCustomerUrl.mockClear();
  nativeMocks.PushNotifications.checkPermissions.mockClear();
  nativeMocks.PushNotifications.requestPermissions.mockClear();
  nativeMocks.PushNotifications.register.mockClear();
  api.request.mockClear();
  localStorage.clear();
});

describe('nativePush permission and tap handling', () => {
  it('does not prompt at startup and routes taps through the customer URL validator', async () => {
    await initNativePush();

    expect(nativeMocks.PushNotifications.checkPermissions).toHaveBeenCalledTimes(1);
    expect(nativeMocks.PushNotifications.requestPermissions).not.toHaveBeenCalled();
    expect(nativeMocks.PushNotifications.register).not.toHaveBeenCalled();

    nativeMocks.state.listeners.pushNotificationActionPerformed({
      notification: { data: { url: 'https://evil.example/phish' } },
    });
    expect(navigateToCustomerUrl).toHaveBeenCalledWith('https://evil.example/phish');
  });

  it('prompts only from the explicit request action and can report denial for recovery UI', async () => {
    nativeMocks.state.permission = 'prompt';
    await expect(requestNativePushPermission()).resolves.toBe('granted');
    expect(nativeMocks.PushNotifications.requestPermissions).toHaveBeenCalledTimes(1);
    expect(nativeMocks.PushNotifications.register).toHaveBeenCalledTimes(1);

    nativeMocks.PushNotifications.register.mockClear();
    nativeMocks.state.permission = 'denied';
    await expect(requestNativePushPermission()).resolves.toBe('denied');
    expect(nativeMocks.PushNotifications.requestPermissions).toHaveBeenCalledTimes(1);
    expect(nativeMocks.PushNotifications.register).not.toHaveBeenCalled();
    await expect(nativePushPermissionState()).resolves.toBe('denied');
  });

  it('posts a pre-login device token through the refresh-aware customer API after login', async () => {
    await initNativePush();
    nativeMocks.state.listeners.registration({ value: 'device-token-1' });
    expect(api.request).not.toHaveBeenCalled();

    localStorage.setItem('waves_token', 'customer-access');
    flushNativePushToken();

    await vi.waitFor(() => expect(api.request).toHaveBeenCalledWith('/push/native-subscribe', {
      method: 'POST',
      body: JSON.stringify({
        platform: 'ios',
        token: 'device-token-1',
        deviceInfo: 'ios · WavesApp',
      }),
    }));
  });
});
