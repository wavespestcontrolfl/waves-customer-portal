// Commercial suite sizing (owner ruling 2026-09-25,
// server/services/commercial-suite-size/): where the size of ONE suite of a
// larger building came from, in words. One list for every place that shows
// it (the Home Sq Ft note and the property card), so they cannot disagree.
// A web-search leg is never a size source (AGENTS.md: an LLM proposes
// intent, it never picks a price/size field).
export const COMMERCIAL_SUITE_SOURCE_LABELS = {
  listing_verified_text: "a public listing for this suite",
  license_seats: "state restaurant license",
  verified: "tech-verified measurement",
  suite_type_default: "typical size for this business type",
};

// The suite size the lookup applied (profile.suiteSize, set by the server's
// applyResolvedSuiteSize), or null when the lookup sized no suite.
export function sizedSuite(profile) {
  const suite = profile?.suiteSize;
  return suite && Number(suite.value) > 0 ? suite : null;
}
