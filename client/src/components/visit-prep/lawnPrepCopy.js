// =========================================================================
// "Before your lawn visit" card on the public appointment page: every
// customer-facing word, in one place (owner-approved 2026-11-14). The three
// lines come from the owner-approved lawn guide ("Before every visit" in
// server/services/estimate-service-details.js); the page opens on any day
// before the visit, so the sprinkler line names no day.
//
// Rules this copy keeps: no safety claims, no hour or minute figures (a
// number of days is fine), plain words, first-person plural. The card never
// shows a pet name: the payload only says whether pets are on file.
//
// The pets ask and its link show only while no pet is on file. Owner
// 2026-11-14: "if they have added their pets we should not include the link
// to pets", before and after the visit.
// =========================================================================

// The portal's Pets section (PortalPage opens the Property tab and scrolls to #pets). A same-origin link;
// the customer signs in there if needed.
export const LAWN_PREP_PETS_HREF = '/?tab=property#pets';

export const LAWN_PREP_COPY = Object.freeze({
  heading: 'Before your lawn visit',
  lines: Object.freeze([
    'Keep sprinklers off the night before and the morning of your visit. We treat a dry lawn.',
    'Mowing due? Mow at least 2 days before your visit, and wait 2 days after.',
    'Clear the lawn: toys, hoses, pet bowls and pet waste. Unlock the gate. Keep pets and kids inside while we treat.',
  ]),
  petsHeading: 'Your pets',
  noPets: Object.freeze({
    text: 'Tell us about your pets, so we can plan each visit around them.',
    button: 'Add your pets',
  }),
});
