import { isNativeApp } from './platform';

/**
 * Face ID / Touch ID app-lock helper (native only).
 *
 * Fail-OPEN is deliberate but NARROW — only when biometry could never run here:
 * on the web, when the native plugin isn't in this build (the shell loads the
 * LIVE portal, so newer web code can run inside an older binary), or when the
 * device has no biometry / nothing enrolled. We must not trap a logged-in
 * customer behind a lock the build/device can't satisfy.
 *
 * CRUCIALLY, biometric LOCKOUT (too many failed attempts) is NOT fail-open — that
 * would reward failed attempts by opening the app. On lockout we still require an
 * explicit unlock via the device passcode (allowDeviceCredential). Only an
 * explicit cancelled/failed prompt keeps the app locked.
 */
let biometryUnavailable = false;

export async function authenticateBiometric(reason = 'Unlock Waves') {
  if (!isNativeApp()) return true;
  if (biometryUnavailable) return true;

  // Load the plugin. Missing in this build (older binary, newer web code) → open.
  let BiometricAuth;
  let BiometryErrorType;
  try {
    ({ BiometricAuth, BiometryErrorType } = await import('@aparajita/capacitor-biometric-auth'));
  } catch {
    biometryUnavailable = true;
    return true;
  }

  // Probe availability. A throw here means the plugin isn't implemented in this
  // build → fail open.
  let info;
  try {
    info = await BiometricAuth.checkBiometry();
  } catch {
    biometryUnavailable = true;
    return true;
  }

  if (!info?.isAvailable) {
    // "Never had biometry" (unsupported / not enrolled) → fail open so a customer
    // without Face ID isn't trapped. But LOCKOUT (too many failed attempts) must
    // NOT open — fall through to a passcode prompt instead.
    const code = info?.code;
    const lockedOut = (BiometryErrorType && code === BiometryErrorType.biometryLockout)
      || /lockout/i.test(`${code ?? ''} ${info?.reason ?? ''}`);
    if (!lockedOut) {
      biometryUnavailable = true;
      return true;
    }
    // locked out → continue to authenticate() with the device-credential fallback.
  }

  // Prompt: biometric when available, else (lockout) the OS falls back to the
  // device passcode via allowDeviceCredential. Only an explicit cancel/fail
  // keeps the app locked.
  try {
    await BiometricAuth.authenticate({
      reason,
      cancelTitle: 'Cancel',
      iosFallbackTitle: 'Use Passcode',
      allowDeviceCredential: true,
    });
    return true;
  } catch {
    return false;
  }
}
