// DEV-ONLY web shim for @capacitor/share (CAP_SHIM=1). Native sharing is
// gated off on the web; this module exists solely for local browser QA.
export const Share = {
  canShare: async () => ({ value: false }),
  share: async () => { throw new Error('web-shim: sharing unavailable'); },
};
export default { Share };
