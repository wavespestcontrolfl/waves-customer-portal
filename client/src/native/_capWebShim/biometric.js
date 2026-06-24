// DEV-ONLY web shim for @aparajita/capacitor-biometric-auth (CAP_SHIM=1). Native-only at runtime.
export const BiometricAuth = {
  authenticate: async () => {},
  checkBiometry: async () => ({ isAvailable: false, biometryType: 0 }),
  addResumeListener: () => ({ remove() {} }),
};
export const BiometryErrorType = { biometryNotAvailable: 'biometryNotAvailable', userCancel: 'userCancel' };
export default { BiometricAuth, BiometryErrorType };
