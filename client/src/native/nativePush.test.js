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
    register: vi.fn(async () => { if (state.listeners.registration) await state.listeners.registration({ value: 'test-native-device' }); }),
  };
  return { state, PushNotifications };
});

const navigateToCustomerUrl = vi.hoisted(() => vi.fn());

vi.mock('./platform', () => ({
  isNativeApp: () => true,
  nativePlatform: () => 'ios',
}));
vi.mock('./nativeLinks', () => ({ navigateToCustomerUrl }));
vi.mock('../utils/api', async (importOriginal) => ({ ...await importOriginal(), default: { request: vi.fn(async () => ({})) } }));
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: nativeMocks.PushNotifications,
}));
vi.mock('@capacitor/app', () => ({ App: {
  addListener: vi.fn(async (name, callback) => { nativeMocks.state.listeners[name] = callback; return { remove: vi.fn() }; }),
} }));

import api from '../utils/api';
import {
  flushNativePushToken,
  initNativePush,
  nativePushPermissionState,
  nativePushConnectionState,
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
    localStorage.setItem('waves_token', 'test-customer-session');
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

  it('does not report ready when OS permission succeeds but server registration fails', async () => {
    localStorage.setItem('waves_token', 'test-customer-session');
    api.request.mockRejectedValueOnce(new Error('offline'));
    await expect(requestNativePushPermission()).resolves.toBe('registration_unavailable');
  });

  it('does not report a signed-out registration as connected', async () => {
    await expect(requestNativePushPermission()).resolves.toBe('registration_unavailable');
  });

  it('waits for the registration event and backend confirmation', async () => {
    localStorage.setItem('waves_token', 'test-customer-session');
    nativeMocks.PushNotifications.register.mockImplementationOnce(async () => {});
    let completed = false;
    const enrollment = requestNativePushPermission().then((result) => { completed = true; return result; });
    await vi.waitFor(() => expect(nativeMocks.PushNotifications.register).toHaveBeenCalled());
    expect(completed).toBe(false);
    let accept;
    api.request.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    const registration = nativeMocks.state.listeners.registration({ value: 'confirmed-device' });
    await vi.waitFor(() => expect(accept).toBeTypeOf('function'));
    expect(completed).toBe(false);
    accept({ success: true });
    await registration;
    await expect(enrollment).resolves.toBe('granted');
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

it('accepts server registration after a refresh rotates the same customer session', async () => {
  const jwt = (expiry, customerId = 'fixture-customer', sessionId = 'fixture-session') => `h.${btoa(JSON.stringify({ customerId, sessionId, exp: expiry }))}.s`;
  localStorage.setItem('waves_token', jwt(1));
  nativeMocks.state.permission = 'granted';
  api.request.mockImplementationOnce(async () => {
    localStorage.setItem('waves_token', jwt(2));
    return { success: true };
  });
  await expect(requestNativePushPermission()).resolves.toBe('granted');
  api.request.mockImplementationOnce(async () => {
    localStorage.setItem('waves_token', jwt(3, 'other-customer', 'other-session'));
    return { success: true };
  });
  await expect(requestNativePushPermission()).resolves.toBe('registration_unavailable');
});

it('revokes the remembered token when connection checking finds permission was removed', async () => {
  localStorage.setItem('waves_token', 'test-customer-session');
  nativeMocks.state.permission = 'granted';
  await expect(requestNativePushPermission()).resolves.toBe('granted');
  nativeMocks.state.permission = 'denied';
  api.request.mockResolvedValueOnce({ deactivated: 1 });
  await expect(nativePushConnectionState()).resolves.toBe('denied');
  expect(api.request).toHaveBeenLastCalledWith('/push/native-unsubscribe', expect.objectContaining({ method: 'POST' }));
  expect(localStorage.getItem('waves_native_push_token')).toBeNull();
});

it('revokes permission on native foreground even when the settings page is closed', async () => {
  localStorage.setItem('waves_token', 'test-customer-session');
  nativeMocks.state.permission = 'granted';
  await initNativePush();
  nativeMocks.state.permission = 'denied';
  api.request.mockResolvedValueOnce({ deactivated: 1 });
  nativeMocks.state.listeners.appStateChange({ isActive: true });
  await vi.waitFor(() => expect(localStorage.getItem('waves_native_push_token')).toBeNull());
  expect(api.request).toHaveBeenLastCalledWith('/push/native-unsubscribe', expect.objectContaining({ method: 'POST' }));
});
