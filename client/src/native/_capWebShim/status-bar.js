// DEV-ONLY web shim for @capacitor/status-bar (CAP_SHIM=1). Native-only at runtime.
export const Style = {
  Dark: 'DARK',
  Light: 'LIGHT',
  Default: 'DEFAULT',
};
export const StatusBar = {
  setStyle: async () => {},
  setBackgroundColor: async () => {},
  setOverlaysWebView: async () => {},
};
export default { StatusBar, Style };
