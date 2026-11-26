import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({ isNativeApp: () => true }));

afterEach(() => { vi.resetModules(); vi.doUnmock('@aparajita/capacitor-biometric-auth'); });

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
