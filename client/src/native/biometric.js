import { isNativeApp } from './platform';

/**
 * Face ID / Touch ID app-lock helper (native only).
 *
 * Fails OPEN (returns true = unlocked) whenever biometry can't actually run: on
 * the web, when the native plugin isn't present in this build, when biometry is
 * unavailable, or when nothing is enrolled. This matters because the shell loads
 * the LIVE portal (capacitor.config.json) — a web deploy of this code can run
 * inside an OLDER installed binary that doesn't yet bundle the BiometricAuth
 * native plugin, and we must never trap a logged-in customer behind a lock they
 * can't clear. Only an explicit failed/cancelled biometric PROMPT (plugin
 * present and actually ran) returns false (stay locked).
 */
let biometryUnavailable = false;

export async function authenticateBiometric(reason = 'Unlock Waves') {
  if (!isNativeApp()) return true;
  if (biometryUnavailable) return true;

  // Load the plugin. Missing in this build (older binary, newer web code) → open.
  let BiometricAuth;
  try {
    ({ BiometricAuth } = await import('@aparajita/capacitor-biometric-auth'));
  } catch {
    biometryUnavailable = true;
    return true;
  }

  // Probe availability. A throw here means the native plugin isn't implemented
  // in this build (or biometry is unusable) → fail open, don't lock out.
  try {
    const info = await BiometricAuth.checkBiometry();
    if (!info?.isAvailable) {
      biometryUnavailable = true;
      return true;
    }
  } catch {
    biometryUnavailable = true;
    return true;
  }

  // Plugin present and biometry available — now an explicit prompt. Only a real
  // cancel/failure keeps the app locked.
  try {
    await BiometricAuth.authenticate({
      reason,
      cancelTitle: 'Cancel',
      iosFallbackTitle: 'Use Passcode',
      allowDeviceCredential: true, // passcode fallback so the user is never stuck
    });
    return true;
  } catch {
    return false;
  }
}
