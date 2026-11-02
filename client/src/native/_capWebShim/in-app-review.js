// DEV-ONLY web shim for @capacitor-community/in-app-review (CAP_SHIM=1). The
// store rating pop-up is gated off on the web; this module exists solely for
// local browser QA.
export const InAppReview = {
  requestReview: async () => { throw new Error('web-shim: in-app review unavailable'); },
};
export default { InAppReview };
