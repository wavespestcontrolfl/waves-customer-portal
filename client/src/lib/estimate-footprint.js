// Which selections price WITHOUT the home / lot footprint, so the estimator may generate them
// before a property lookup (or with no square feet). The policy, in one table:
//   - the services below are each priced from their own inputs (bed bug from its treatment
//     scope, pre-slab from slab sq ft, Bora-Care from attic/raw-wood sq ft or surface linear
//     ft, recurring foam from drill points and cadence), and only when they are the ONLY
//     selected service;
//   - area add-ons alone (a web sweep takes no area; a tiered add-on carries its own treated
//     area), which isAreaAddOnOnly reads from the add-on list.
import { isAreaAddOnOnly } from "./areaAddOns";

export const FOOTPRINT_FREE_ONLY_SERVICES = Object.freeze(["BEDBUG", "PRESLAB", "BORACARE", "FOAM_RECURRING"]);

export function isFootprintFreeSelection(selectedServices, areaAddOns) {
  const selected = Array.isArray(selectedServices) ? selectedServices : [];
  const onlyOneOfTheTable = selected.length === 1 && FOOTPRINT_FREE_ONLY_SERVICES.includes(selected[0]);
  return onlyOneOfTheTable || isAreaAddOnOnly(selected, areaAddOns);
}
