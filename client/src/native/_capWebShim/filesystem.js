// DEV-ONLY web shim for @capacitor/filesystem (CAP_SHIM=1). Native file
// writes are gated by Capacitor.isNativePlatform(), so these exports only
// prevent Vite from pre-bundling the real native plugin during browser QA.
export const Directory = { Cache: 'CACHE' };
export const Encoding = { UTF8: 'utf8' };
export const Filesystem = {
  writeFile: async () => { throw new Error('web-shim: filesystem unavailable'); },
  deleteFile: async () => {},
  getUri: async () => { throw new Error('web-shim: filesystem unavailable'); },
};
export default { Directory, Encoding, Filesystem };
