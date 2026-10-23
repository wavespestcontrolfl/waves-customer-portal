/**
 * Lawn v13 whole-lawn bag that changes when a trouble area is mapped (GATE_LAWN_DEC_LARGE_PATCH_K, owner 2026-10-23: "do whatever is
 * going to make the grass look its best, based on the research we did").
 *
 * Research. UF/IFAS Large Patch (SS-PLP-5): reduce nitrogen in the disease window, November to May. Lawn Care Nut (Bradenton): keep
 * feeding healthy lawns while they are still mowed. So the change applies ONLY to a lawn with a mapped LARGE PATCH (not to any other
 * disease: gray leaf spot, Pythium, dollar spot, fairy ring and rust are all "fungus" areas too; lawn-trouble-areas
 * loadActiveLargePatch asks for the target Large patch on record and fails closed when the disease is not known).
 *
 * The December visit puts down LESCO 10-0-22 at 4.5 lb per 1,000 sq ft (0.45 lb N, 0.99 lb K2O). While a large patch is mapped as
 * active the bag is LESCO Black Out 0-0-24 AM Spar-TECH (SiteOne 511512, 50 lb; 0 N, 0 P, 24% K2O) at 4.1 lb per 1,000 sq ft: the same
 * 0.99 lb K2O (4.1 x 0.24 = 0.984; the plan derives 0.99 / 0.24 = 4.125 lb) and no nitrogen. Another lane's owner-approved alternative
 * is no December nitrogen on EVERY lawn; that is a change to this rule (drop the `evidence` and the area read, and the swap applies
 * to every v13 December visit).
 *
 * ONE SOURCE. The recipe file (lawn-protocol-v13.json, December visit, `swaps.largePatchPotassium`, all three tracks) states the
 * conditional product: the line, the bag it replaces, the nitrogen target, the trigger and the technician note. This module READS
 * that block, so the overlay the plan applies and the recipe staff read cannot drift apart; `swapRecipeProblems()` is the check the
 * tests run (the three tracks agree, the replaced bag is the visit's own line, the line's rate and nitrogen agree with the target).
 * lawn-program.js lawnProtocols() hands readers the block only while the swap gate is live (like the bermuda add-ons), so with the
 * gate off no reader sees it and every output is the old one.
 *
 * An entry applies to the visit whose month number is `month`, when the visit's whole-lawn line is `from`, and when the property has an
 * ACTIVE trouble area of type `troubleType` that carries the `evidence`. `gate` names the feature-gates reader. Kept in code, not in
 * a protocol row, so a gate that is off leaves every stored row, recipe line and plan as it was.
 */
const v13 = require('./lawn-protocol-v13.json');

const SWAP_KEY = 'largePatchPotassium';
const MONTH = 'Dec';
const MONTH_NUMBER = 12;
const nameOf = (line) => String(line || '').split(' — ')[0].trim();

const december = (track) => v13[track].visits.find((visit) => visit.month === MONTH);
const block = december('st_augustine').swaps[SWAP_KEY];
const DEC_FROM = block.replaces;
const DEC_K_PRODUCT = nameOf(block.primary);

const V13_TROUBLE_PRODUCT_SWAPS = Object.freeze([
  Object.freeze({
    key: 'decLargePatchK',
    month: MONTH_NUMBER,
    troubleType: block.trigger.troubleType,
    evidence: block.trigger.evidence,
    gate: 'lawnDecLargePatchKLive',
    from: DEC_FROM,
    to: DEC_K_PRODUCT,
    // The recipe line of the swapped bag (name, then rate and tool, like every recipe line).
    line: block.primary,
    targetN: block.targetN,
    note: block.note,
    // The staged row's gates.trigger (migration 20261023121000): what marks the row as this rule's replacement bag.
    trigger: 'active_large_patch_mapped',
  }),
]);

// The key of the line note the swapped bag carries (plan gateNotes), so the Fast Complete sheet can pick that note out.
const PRODUCT_SWAP_NOTE_KEY = 'activeLargePatchPotassium';

// Is this staged protocol product only a swap rule's replacement bag (the non-default December 0-0-24 row)? Readers that list a window's
// products (the previsit brief, the customer report's protocol card) leave such a row out unless the rule's gate is live and, for the
// report, the visit actually put the bag down. `row` is a summarized protocol product (productName / protocolProductName, defaultInPlan,
// gates) or a staged row; the swap trigger in its gates counts as well as its name.
function swapOnlyRule(row, rules = V13_TROUBLE_PRODUCT_SWAPS) {
  if (!row || row.defaultInPlan === true) return null;
  const names = [row.productName, row.protocolProductName, row.product_name].map((name) => String(name || '').trim());
  return rules.find((rule) => names.includes(rule.to) || (rule.trigger && row.gates?.trigger === rule.trigger)) || null;
}

// What differs between the recipe block and the rule the plan applies, as a list of plain sentences ([] = they agree). Pure; the tests
// run it, so a recipe edit that is not matched by the overlay (or the reverse) fails the build.
function swapRecipeProblems(recipe = v13, rules = V13_TROUBLE_PRODUCT_SWAPS) {
  const problems = [];
  const rule = rules.find((entry) => entry.key === 'decLargePatchK');
  for (const [track, program] of Object.entries(recipe)) {
    const visit = program.visits.find((entry) => entry.month === MONTH);
    const swap = visit?.swaps?.[SWAP_KEY];
    if (!swap) { problems.push(`${track}: the December visit has no swaps.${SWAP_KEY}`); continue; }
    if (swap.gate !== 'GATE_LAWN_DEC_LARGE_PATCH_K') problems.push(`${track}: gate is ${swap.gate}`);
    if (!rule) { problems.push('no rule for the recipe block'); continue; }
    if (swap.replaces !== rule.from) problems.push(`${track}: replaces ${swap.replaces}, the rule replaces ${rule.from}`);
    if (nameOf(swap.primary) !== rule.to) problems.push(`${track}: the line names ${nameOf(swap.primary)}, the rule names ${rule.to}`);
    if (swap.primary !== rule.line) problems.push(`${track}: the line differs from the rule's line`);
    if (swap.targetN !== rule.targetN) problems.push(`${track}: targetN ${swap.targetN}, the rule ${rule.targetN}`);
    if (swap.note !== rule.note) problems.push(`${track}: the technician note differs`);
    if (swap.trigger?.troubleType !== rule.troubleType || swap.trigger?.evidence !== rule.evidence) problems.push(`${track}: the trigger differs`);
    // The replaced bag is the visit's own whole-lawn line, so the swap can only ever replace what the recipe puts down.
    if (nameOf(visit.primary) !== swap.replaces) problems.push(`${track}: the December primary is ${nameOf(visit.primary)}, not the bag the swap replaces`);
    // The line states the nitrogen the rule sets.
    const stated = String(swap.primary).match(/\((\d+(?:\.\d+)?) lb N,/);
    if (!stated || Number(stated[1]) !== Number(swap.targetN)) problems.push(`${track}: the line does not state ${swap.targetN} lb N`);
    // The summary names the product and its replacement, so a reader of the recipe sees the condition.
    if (!String(swap.summary).includes(rule.to) || !String(swap.summary).includes('GATE_LAWN_DEC_LARGE_PATCH_K')) problems.push(`${track}: the summary does not name the product and the gate`);
  }
  return problems;
}

module.exports = { V13_TROUBLE_PRODUCT_SWAPS, PRODUCT_SWAP_NOTE_KEY, DEC_FROM, DEC_K_PRODUCT, SWAP_KEY, swapRecipeProblems, swapOnlyRule };
