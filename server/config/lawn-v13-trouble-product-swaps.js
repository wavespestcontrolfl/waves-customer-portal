/**
 * Lawn v13 whole-lawn bag that changes when a trouble area is mapped (GATE_LAWN_DEC_LARGE_PATCH_K, owner 2026-10-23: "do whatever is
 * going to make the grass look its best, based on the research we did").
 *
 * Research. UF/IFAS Large Patch (SS-PLP-5): reduce nitrogen in the disease window, November to May. Lawn Care Nut (Bradenton): keep
 * feeding healthy lawns while they are still mowed. So the change applies ONLY to a lawn with a mapped large patch.
 *
 * The December visit puts down LESCO 10-0-22 at 4.5 lb per 1,000 sq ft (0.45 lb N, 0.99 lb K2O). While fungus is mapped as active the
 * bag is LESCO Black Out 0-0-24 AM Spar-TECH (SiteOne 511512, 50 lb; 0 N, 0 P, 24% K2O) at 4.1 lb per 1,000 sq ft: the same 0.99 lb
 * K2O (4.1 x 0.24 = 0.984; the plan derives 0.99 / 0.24 = 4.125 lb) and no nitrogen. Another lane's owner-approved alternative is no
 * December nitrogen on EVERY lawn; that is a one-line change (drop `troubleType` here and the area read goes away).
 *
 * An entry applies to the visit whose month number is `month`, when the visit's whole-lawn line is `from`, and when the property has an
 * ACTIVE trouble area of type `troubleType` (lawn-trouble-areas TYPES; take-all is its own type and does not match). `gate` names the
 * feature-gates reader. Kept in code, not in a protocol row or the recipe file, so a gate that is off leaves every stored row, recipe
 * line and plan as it was.
 */
const DEC_FROM = 'LESCO 10-0-22 50% PolyPlus OPTI45 50% YaraRega 2% Fe 2% Mg KMAG MOP SOP Turfgrass Granular Fertilizer';
const DEC_K_PRODUCT = 'LESCO Black Out 0-0-24 AM Spar-TECH';

const V13_TROUBLE_PRODUCT_SWAPS = Object.freeze([
  Object.freeze({
    key: 'decLargePatchK',
    month: 12,
    troubleType: 'fungus',
    gate: 'lawnDecLargePatchKLive',
    from: DEC_FROM,
    to: DEC_K_PRODUCT,
    // The recipe line of the swapped bag (name, then rate and tool, like every recipe line).
    line: `${DEC_K_PRODUCT} — 4.1 lb per 1,000 sq ft (0 lb N, 0.99 lb K2O), spreader, active large patch mapped`,
    targetN: 0,
    note: 'Active large patch mapped: potassium-only bag, no nitrogen (4.1 lb per 1,000 sq ft = 0.99 lb K2O). Used in place of the LESCO 10-0-22.',
  }),
]);

// The key of the line note the swapped bag carries (plan gateNotes), so the Fast Complete sheet can pick that note out.
const PRODUCT_SWAP_NOTE_KEY = 'activeLargePatchPotassium';

module.exports = { V13_TROUBLE_PRODUCT_SWAPS, PRODUCT_SWAP_NOTE_KEY, DEC_FROM, DEC_K_PRODUCT };
