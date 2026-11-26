import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({ isNativeApp: () => true }));
const pluginAvailable = vi.fn(() => true);
vi.mock('@capacitor/core', () => ({ Capacitor: { isPluginAvailable: (n) => pluginAvailable(n) } }));

afterEach(() => { vi.useRealTimers(); pluginAvailable.mockImplementation(() => true); vi.resetModules(); vi.doUnmock('@aparajita/capacitor-biometric-auth'); });

it('asks for the phone code, never opens, when the Face ID plugin probe throws', async () => {
  vi.doMock('@aparajita/capacitor-biometric-auth', () => ({
    BiometricAuth: { checkBiometry: vi.fn(async () => { throw new Error('not implemented'); }), authenticate: vi.fn() },
    BiometryErrorType: {},
  }));
  const { authenticateBiometric, NEEDS_PHONE_CODE } = await import('./biometric');
  expect(await authenticateBiometric()).toBe(NEEDS_PHONE_CODE);
  // Remembered for this app run: the next lock asks again, still no open.
  expect(await authenticateBiometric()).toBe(NEEDS_PHONE_CODE);
});

it('still opens when the device has no Face ID enrolled', async () => {
  vi.doMock('@aparajita/capacitor-biometric-auth', () => ({
    BiometricAuth: { checkBiometry: vi.fn(async () => ({ isAvailable: false, code: 'biometryNotEnrolled' })), authenticate: vi.fn() },
    BiometryErrorType: { biometryLockout: 'biometryLockout' },
  }));
  const { authenticateBiometric } = await import('./biometric');
  expect(await authenticateBiometric()).toBe(true);
});

it('stays locked when the customer cancels the prompt', async () => {
  vi.doMock('@aparajita/capacitor-biometric-auth', () => ({
    BiometricAuth: { checkBiometry: vi.fn(async () => ({ isAvailable: true })), authenticate: vi.fn(async () => { throw new Error('cancel'); }) },
    BiometryErrorType: {},
  }));
  const { authenticateBiometric } = await import('./biometric');
  expect(await authenticateBiometric()).toBe(false);
});

it('asks for the phone code when the app build has no native Face ID side', async () => {
  pluginAvailable.mockImplementation(() => false);
  const checkBiometry = vi.fn();
  vi.doMock('@aparajita/capacitor-biometric-auth', () => ({ BiometricAuth: { checkBiometry, authenticate: vi.fn() }, BiometryErrorType: {} }));
  const { authenticateBiometric, NEEDS_PHONE_CODE } = await import('./biometric');
  expect(await authenticateBiometric()).toBe(NEEDS_PHONE_CODE);
  expect(pluginAvailable).toHaveBeenCalledWith('BiometricAuthNative');
  expect(checkBiometry).not.toHaveBeenCalled();
});

it('asks for the phone code when the probe never answers', async () => {
  vi.doMock('@aparajita/capacitor-biometric-auth', () => ({
    BiometricAuth: { checkBiometry: vi.fn(() => new Promise(() => {})), authenticate: vi.fn() },
    BiometryErrorType: {},
  }));
  const { authenticateBiometric, NEEDS_PHONE_CODE } = await import('./biometric');
  // Load the plugin first, then stall the probe on a fake clock.
  await import('@aparajita/capacitor-biometric-auth');
  vi.useFakeTimers();
  const result = authenticateBiometric();
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(500);
  expect(await result).toBe(NEEDS_PHONE_CODE);
});
