// DEV-ONLY web shim for @capacitor/app (CAP_SHIM=1). Dynamic-imported only on
// native, so these no-ops never run on web — they just satisfy Vite's resolver.
export const App = {
  addListener: async () => ({ remove() {} }),
  removeAllListeners: async () => {},
  getInfo: async () => ({ name: 'web', version: '0', build: '0' }),
  getLaunchUrl: async () => undefined,
  exitApp: async () => {},
};
export default { App };
