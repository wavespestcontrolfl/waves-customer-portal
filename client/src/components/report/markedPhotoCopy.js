// Shared copy + palette for the marked-photo card.
//
// The live report and the PDF document render this card from separate
// component trees. Duplicating the wording in both is how they come to
// disagree, and every rule here is a customer-facing claim rule rather than a
// styling preference — so the two surfaces read from ONE module.
//
// Rules encoded here (docs/design/treatment-animation-scope.md):
//  - Never assert an exhaustive set. Marks are optional and foam is priced by
//    drill-point count, so "each point" or any total invites a customer to
//    tally pins against billed points.
//  - The foam caption is only truthful when EVERY mark is a foam injection;
//    the foam lanes also permit spot and wood treatment, and a wood-treated
//    point does not establish a foam injection.

// Never alert red: a treated point records work performed, not a warning.
export const MARK_KIND_COLOR = {
  foam_injection: '#0A7EC2',
  spot_treatment: '#157A5B',
  wood_treatment: '#A9690C',
};
export const MARK_DEFAULT_COLOR = '#0A7EC2';

export const MARKED_PHOTO_INTRO = 'Your technician photographed the treated area and marked points on it.';

const CAPTIONS = {
  foamPoints: 'Foam was injected at the points your technician marked on this visit.',
};
const NEUTRAL_CAPTION = 'Your technician marked the points treated on this visit.';

export function markedPhotoCaption(marks = [], captionKey = null) {
  const list = Array.isArray(marks) ? marks : [];
  const allFoam = list.length > 0 && list.every((mark) => mark.kind === 'foam_injection');
  return (allFoam && CAPTIONS[captionKey]) || NEUTRAL_CAPTION;
}

export function markColor(kind) {
  return MARK_KIND_COLOR[kind] || MARK_DEFAULT_COLOR;
}
