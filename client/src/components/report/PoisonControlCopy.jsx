import React from 'react';
import { POISON_CONTROL_PHONE_DISPLAY, POISON_CONTROL_PHONE_TEL } from '../../constants/business';

// Project types whose visit applies a product (pesticide, disinfectant) —
// their reports carry the Poison Control line. Project findings have no
// structured product list to key off, so the type is the gate.
// Inspection-only, exclusion/trapping and bait-station visits are left out:
// loading or checking a rodent/termite station is monitoring, not an
// application (owner 2026-08-29; isProductApplication applies the same rule
// on service reports). The WDO and pre-construction paper documents are
// out too (owner 2026-09-26).
export const POISON_CONTROL_PROJECT_TYPES = new Set([
  'termite_treatment',
  'one_time_pest_treatment',
  'one_time_lawn_treatment',
  'flea',
  'cockroach',
  'german_roach_knockdown',
  'palmetto_roach_knockdown',
  'bed_bug',
  'mosquito_event',
  'palm_injection',
  'tree_shrub',
  'rodent_sanitation',
]);

// One Poison Control sentence for every report surface that records a
// product application — the glass service report, its PDF document and the
// treatment project reports. Each surface supplies its own label and
// styling; the wording and the tap-to-call link live only here.
//
// Compliance copy rules (AGENTS.md): no "safe" claim and no re-entry
// figure — this only says who to call. listsProducts is true only where the
// same page prints the product names, so the "keep this report handy" line
// never points at a list that isn't there.
export default function PoisonControlCopy({ listsProducts = false, linkStyle }) {
  return (
    <>
      If someone swallows, breathes in, or gets a product on their skin or in their eyes, call
      Poison Control at{' '}
      <a href={POISON_CONTROL_PHONE_TEL} style={linkStyle}>{POISON_CONTROL_PHONE_DISPLAY}</a>
      {' '}— free and confidential, 24/7.
      {listsProducts ? ' Keep this report handy when you call; it names each product applied.' : ''}
      {' '}In a medical emergency, call 911.
    </>
  );
}
