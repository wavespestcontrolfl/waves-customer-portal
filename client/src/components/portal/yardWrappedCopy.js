// =========================================================================
// Yard Wrapped: every customer-facing word the card, its share text and its
// share picture use, in one place for the owner to approve. Nothing else in
// YardWrappedCard.jsx or yardWrappedShare.js is customer copy; the numbers,
// the pest and weed names and the technician's first name come from the
// server's counts (GET /api/yard-wrapped), never composed here.
//
// Rules this copy keeps: no safety claims, no price words, no time or minute
// figures, plain words, first-person plural.
// =========================================================================

// One label per service line the server counts (service-line-configs.js ids).
export const LINE_LABELS = {
  pest: 'Pest control',
  lawn: 'Lawn care',
  mosquito: 'Mosquito control',
  tree_shrub: 'Tree & shrub care',
  termite: 'Termite',
  rodent: 'Rodent',
  palm: 'Palm care',
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const YARD_WRAPPED_COPY = {
  kicker: 'Yard Wrapped',
  title: (year) => `Your ${year} with Waves`,
  visitsValue: (n) => plural(n, 'visit', 'visits'),
  visitsNote: (year) => `at your home in ${year}`,
  lawnLabel: 'Lawn score',
  lawnValue: (first, last) => `${first} to ${last}`,
  lawnNote: (year) => `From your first lawn check of ${year} to your latest`,
  treatedLabel: 'What we treated for',
  technicianLabel: 'Your technician',
  technicianNote: (year) => `Most of your visits in ${year}`,
  photoAlt: (year) => `Your lawn in ${year}`,
  thanks: (year) => `Thank you for letting us look after your home in ${year}.`,
  shareButton: 'Share',
  copyButton: 'Copy',
  copiedStatus: 'Copied',
  copyFailedStatus: 'Could not copy. Please try again.',
  shareTitle: (year) => `My ${year} with Waves`,
  // The share text names the registered company; the website goes in the share URL.
  shareText: ({ year, businessName, total, lines, lawnScore }) => [
    `My ${year} with ${businessName}: ${plural(total, 'visit', 'visits')}`,
    lines.length ? ` (${lines.map((l) => `${l.count} ${l.label.toLowerCase()}`).join(', ')})` : '',
    lawnScore ? `. Lawn score ${lawnScore.first} to ${lawnScore.last}` : '',
    '.',
  ].join(''),
  // Words drawn on the share picture (no photo, no address, no name).
  picture: {
    kicker: 'Yard Wrapped',
    title: (year) => `My ${year} with Waves`,
    visitsWord: (n) => (n === 1 ? 'visit' : 'visits'),
    lawn: (first, last) => `Lawn score ${first} to ${last}`,
  },
};
