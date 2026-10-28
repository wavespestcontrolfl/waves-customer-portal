// Misting layout: how much one pump can run, and the spacing rules the designer follows (GATE_MISTING_LAYOUT_DESIGNER).
//
// Source: Pynamite's published FAQ (pynamite.net/customer-service/faq-information) and owner's manuals
// (pynamite.net/customer-service/owners-manual: Cube Pro 11965, Nozzle and Riser Assembly):
//   "Nozzles/risers are typically placed 10 feet apart." "Nozzles and risers can be alternated throughout the installation."
//   (The FAQ's "Risers should be spaced out about every 8 feet" is overruled: owner 2026-10-26 "change bed-line risers
//   to 10 ft, to follow the manual".)
//   "Nozzles should be placed 2-15 feet high - typically on the 1st story eve of a structure and along the fence lines."
//   "The Cube Pro ... can easily mist up to 60 nozzles. Add an optional Zone Kit and double the misting capacity to 120 nozzles!"
// No price changes and no line item come from any of this: it only warns staff, and the customer's estimate card.
// No imports, so the customer estimate document can use it without pulling in the map engine.

export const PUMP_NOZZLE_LIMIT = 60; // Cube Pro
export const ZONE_KIT_NOZZLE_LIMIT = 120; // with the optional Zone Kit
export const RISER_SPACING_FT = 10;

/** What the pump runs: every nozzle, plus every riser (each riser carries a nozzle on top). */
export const pumpLoad = (nozzleCount, riserCount) => (Number(nozzleCount) || 0) + (Number(riserCount) || 0);

/**
 * The notice a load needs, or null. `level` is 'amber' (a Zone Kit fixes it) or 'red' (a second system is needed).
 */
export function pumpNotice(load) {
  if (load > ZONE_KIT_NOZZLE_LIMIT) return { level: 'red', text: `Over ${ZONE_KIT_NOZZLE_LIMIT} nozzles: needs a second system` };
  if (load > PUMP_NOZZLE_LIMIT) return { level: 'amber', text: `Over ${PUMP_NOZZLE_LIMIT} nozzles: needs a Pynamite Zone Kit (up to ${ZONE_KIT_NOZZLE_LIMIT})` };
  return null;
}

/** "Pump load: N of 60". */
export const pumpLoadLine = (load) => `Pump load: ${load} of ${PUMP_NOZZLE_LIMIT}`;
