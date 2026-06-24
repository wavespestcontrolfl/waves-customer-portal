// DEV-ONLY web shim for @capacitor/core, activated by CAP_SHIM=1 in vite.config.js.
// Lets the full app boot in a local checkout that lacks the native Capacitor deps.
// On web, isNativePlatform() is false, so every native code path is already gated off.
export const Capacitor = {
  isNativePlatform: () => false,
  getPlatform: () => 'web',
  isPluginAvailable: () => false,
  Plugins: {},
  registerPlugin: () => ({}),
};
export default { Capacitor };
