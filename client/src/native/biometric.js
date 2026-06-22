import { isNativeApp } from './platform';

/**
 * Face ID / Touch ID app-lock helper (native only).
 *
 * Dynamic-imports @aparajita/capacitor-biometric-auth so the web build stays
 * inert. Fails OPEN (returns true = unlocked) on the web, when the device has
 * no biometry enrolled, or when biometry is unavailable — we never want to lock
 * a customer out of their account because of a hardware/enrollment gap. Only an
 * explicit failed/cancelled biometric prompt returns false.
 */
let biometryUnavailable = false;

export async function authenticateBiometric(reason = 'Unlock Waves') {
  if (!isNativeApp()) return true;
  if (biometryUnavailable) return true;
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
    const info = await BiometricAuth.checkBiometry();
    if (!info?.isAvailable) {
      biometryUnavailable = true; // no Face ID/Touch ID enrolled — don't gate
      return true;
    }
    await BiometricAuth.authenticate({
      reason,
      cancelTitle: 'Cancel',
      iosFallbackTitle: 'Use Passcode',
      allowDeviceCredential: true, // passcode fallback so the user is never stuck
    });
    return true;
  } catch {
    // Prompt failed or was cancelled — stay locked.
    return false;
  }
}
