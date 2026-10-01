import React from 'react';
import { POISON_CONTROL_PHONE_DISPLAY, POISON_CONTROL_PHONE_TEL } from '../../constants/business';

// F.S. 482.2265(1)(b): a customer may ask for the ID card number of the
// person applying the pesticide — owner 2026-09-26: print it instead, in
// the same block as Poison Control. The server withholds a blank number or
// one that had expired by the service date, so null means "don't print".
export function applicatorIdLine(technicianName, fdacsId) {
  const id = String(fdacsId || '').trim();
  if (!id) return null;
  const name = String(technicianName || '').trim();
  return name ? `Applicator: ${name} · FDACS ID card #${id}` : `Applicator FDACS ID card #${id}`;
}

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
