import { isNativeApp } from './platform';

/**
 * Face ID / Touch ID app-lock helper (native only).
 *
 * Results: true = unlocked, false = still locked (cancel/fail), NEEDS_PHONE_CODE =
 * the Face ID plugin is missing from this build (the shell loads the LIVE portal,
 * so newer web code can run inside an older binary) or its probe threw. Owner
 * 11-26: the fallback there is the phone number code sign-in, never an open app.
 *
 * Fail-OPEN stays only on the web and when the device has no biometry / nothing
 * enrolled.
 *
 * CRUCIALLY, biometric LOCKOUT (too many failed attempts) is NOT fail-open — that
 * would reward failed attempts by opening the app. On lockout we still require an
 * explicit unlock via the device passcode (allowDeviceCredential). Only an
 * explicit cancelled/failed prompt keeps the app locked.
 */
export const NEEDS_PHONE_CODE = 'needs-phone-code';

let biometryUnavailable = false;
let pluginBroken = false;

export async function authenticateBiometric(reason = 'Unlock Waves') {
  if (!isNativeApp()) return true;
  if (pluginBroken) return NEEDS_PHONE_CODE;
  if (biometryUnavailable) return true;

  // Load the plugin. Missing in this build (older binary, newer web code) →
  // phone code sign-in.
  let BiometricAuth;
  let BiometryErrorType;
  try {
    ({ BiometricAuth, BiometryErrorType } = await import('@aparajita/capacitor-biometric-auth'));
  } catch {
    pluginBroken = true;
    return NEEDS_PHONE_CODE;
  }

  // Probe availability. A throw here means the plugin isn't implemented in this
  // build → phone code sign-in.
  let info;
  try {
    info = await BiometricAuth.checkBiometry();
  } catch {
    pluginBroken = true;
    return NEEDS_PHONE_CODE;
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
