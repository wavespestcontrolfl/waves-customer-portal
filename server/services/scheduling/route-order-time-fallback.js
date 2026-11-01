/**
 * GATE_ROUTE_ORDER_TIME_FALLBACK (owner 2026-11-01, "build fixes", dispatch lane F1).
 *
 * When the save's route check REFUSES to place a visit (arrival_window,
 * route_unverified, ...), the visit used to keep route_order NULL, and every
 * reader of a day's stops (COALESCE(route_order, 999)) listed it last. This
 * builds the day's order from the arrival times alone: the technician's
 * numbered stops keep their order, and the visit goes in before the first of
 * them whose window starts later. Ordering only: no arrival simulation runs
 * (the check already refused). The window and co-visit rules are the ones
 * computeChronologicalRepair uses (route-reorder-window-fit.js).
 */
const { currentOrder, effectiveWindowRange, isCoVisitPair } = require('../route-reorder-window-fit');

/** The ids of the target's technician day in the order to number them: the
 *  numbered stops of `rows` in their current order (the target's own stale
 *  number dropped), then the target placed by arrival window start. A
 *  same-customer, same-window, same-pin sibling takes the target right after
 *  it. Stops with no number other than the target stay out of the list. */
function timeFallbackOrder(rows, target) {
  const mine = (rows || []).filter(row => row.technician_id === target.technician_id
    && row.reservation_expires_at == null && row.route_order != null && String(row.id) !== String(target.id));
  const candidate = currentOrder(mine);
  const range = effectiveWindowRange(target);
  const siblingIndex = candidate.findIndex(other => isCoVisitPair(effectiveWindowRange, other, target));
  let index = siblingIndex !== -1 ? siblingIndex + 1 : candidate.length;
  if (siblingIndex === -1 && range) {
    const later = candidate.findIndex(other => effectiveWindowRange(other)?.startMin > range.startMin);
    if (later !== -1) index = later;
  }
  candidate.splice(index, 0, target);
  return candidate.map(stop => stop.id);
}

module.exports = { timeFallbackOrder };
