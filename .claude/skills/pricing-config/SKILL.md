---
name: pricing-config
description: Use for ANY change to pricing values, brackets, fees, or discounts — pricing is DB-authoritative, so editing constants.js alone silently ships nothing.
---

# Pricing changes are DB-authoritative

`server/services/pricing-engine/db-bridge.js` (`syncConstantsFromDB`) loads
`pricing_config` rows OVER the in-code constants at runtime. In any
environment that carries the row (prod does), **editing
`server/services/pricing-engine/constants.js` alone changes nothing.**

## Checklist for a pricing change

1. **constants.js** — update the in-code default (keeps fresh envs correct).
2. **Migration** — update the `pricing_config` row. Read-modify-write so
   admin edits to other keys in the same row survive; insert a
   `pricing_config_audit` row with reason + changelog identity. Exemplar:
   `server/models/migrations/20260611000003_pest_footprint_1750_bracket.js`.
3. **Admin seed** — if the value is admin-editable, make sure the admin
   seed/panel (`client/src/components/admin/PricingLogicPanel.jsx`) reflects
   the new shape.
4. **Client mirrors** — search for static copies in the client estimators and
   update them manually; they do NOT read pricing_config. Known offender
   class: `client/src/lib/estimateEngine.js` keeps static price mirrors
   (e.g. `oneTimeMosquitoLadderPrice`).
   Use ripgrep (recursive `grep` is banned in this monorepo):

   ```
   rg -n "<the old value or constant name>" client/src server/services
   ```

5. **Verify after deploy** — confirm the migration ran and the live
   estimator (`/pest-control-calculator/` flow or admin estimate builder)
   shows the new value.

## Migration / engine traps

- `pricing_changelog.version_from/to` is varchar(10) and holds ENGINE
  versions only; `category` has a CHECK constraint
  (bug/leak/rule/cost/architecture/documentation/infrastructure).
- Engine input is FLAT — `generateEstimate({ homeSqFt, ... })`, never
  `{ property: { ... } }`; the sqft adapter key is `attachedGarage`
  (not `hasAttachedGarage`).
- A pricing migration's `down()` keys off its OWN audit row, never a
  blanket revert. Direct prod `pricing_config` UPDATEs are blocked —
  always ship via migration.
- Regression baselines regenerate via
  `cd server && CAPTURE_BASELINE=1 npx jest tests/pricing-engine.regression.test.js`
  (the suite lives in the `server` workspace), then hand-apply the delta
  to `pricing-engine.baseline.json`.
- Known client-mirror sites:
  `client/src/lib/estimateEngine.js` (mosquito ×2 blocks),
  `EstimateToolViewV2.jsx` (approx preview), `PortalPage`, `EstimatePage.jsx`.
  Mosquito price changes must sync ALL of them in the SAME PR, and the
  pre-push suite set must include `client-estimate-engine-pricing-drift`
  + `mosquito-estimator-adapter`.

## Standing owner rulings (dated — don't relitigate)

- **Pricing floors** (2026-07-17 disarmed every margin/program floor):
  residential recurring lawn prices off the market table
  (`GATE_LAWN_COST_PLUS_LIST` is OFF in production, owner 2026-11-06), and
  the lawn 35% margin is a review line only: discounts apply in full (owner
  2026-11-02). **Lawn $55 minimum after discounts** (owner 2026-11-06,
  `lawn_pricing_v2.minimumPerVisitAfterDiscount`, live since 2026-11-11; a
  value of 0 turns it off with no deploy): every 9x/12x lawn
  customer pays at least $55 an application after the WaveGuard tier % and a
  typed percent or dollar discount; the LIST (crossed-out) price is raised
  so the full discount still shows. New quotes only:
  saved quotes replay with the stamped `pricingMetadata` value (0 when
  unstamped). The cost-plus list-side $55 minimum is retired (0). The owner
  ruled a 35% floor for T&S; it is not built (it waits on the T&S protocol).
  Every other margin/program floor stays disarmed and report-only: do not
  flag "below floor" outside lawn, and do not add a floor without an owner
  ruling. The owner-set one-time list minimums stay
  live and re-apply after the 15% recurring-customer perk: one-time mosquito
  $199 (`ONE_TIME.mosquito.floor`, owner 2026-10-25) and, for quotes made
  BEFORE 2026-11-26, one-time pest $199 (`ONE_TIME.pest.floor`, the live
  `onetime_pest.floor`). **New one-time pest quotes are the exception**
  (owner 2026-11-26, "only new estimtes"): their 1.8x multiple, 10% first-visit
  minimum and $199 floor are CODE constants (`ONE_TIME.pest.newRule`), not
  Settings, so an edit can never move the price on a link already sent; a
  change of those numbers is a new code rule with its own stamp
  (`pricingMetadata.legacyOneTimePestBuffer`). The `onetime_pest` row's
  `floor` and `multiplier` now price only quotes made before 11-26 and
  apartment/condo (bedroom-priced) quotes; new house quotes use a fixed
  $199 / 1.8x / 10% minimum.
- **Pest above the 5,500 sq ft footprint table** (owner 2026-11-26, new quotes
  only): +$8 per visit at quarterly for each 1,000 sq ft above 5,500,
  pro-rated, no cap (8,000 = $148, 10,000 = $164); bi-monthly, monthly and
  one-time pest follow the quarterly price. The $8 and the 5,500 start
  point are CODE constants (`PEST.aboveTablePer1000`, `PEST.aboveTableStartSqFt`),
  not Settings rows, so an edit of the `pest_footprint` table never moves the
  premium on a sent quote; a change of it is a new code rule with its own stamp. Quotes
  made before it keep the flat top (`pricingMetadata.legacyPestAboveTable`,
  an unstamped priced estimate reads the same). The `pest_footprint` row still
  ends at 5,500; editing it does not change the above-table step.
- **Whole-home sizing** (owner 2026-11-26 "whole home", new quotes only; no
  gate, ships live): the cockroach treatment bracket (`pest_initial_roach`,
  stand-alone and plan-added), the bed bug size step and the rodent guarantee
  tier read the home's TOTAL living area, as flea does, not the ground-floor
  footprint (two-story 2,800 sq ft: cockroach $289, was $202.50). One-time
  pest and the recurring pest plan stay on the footprint. No Settings row
  changed: the brackets (`pest_base.initial_roach`, the bed bug size
  modifiers, the guarantee tiers) are the same tables read with a larger
  size. Quotes made before it keep the footprint
  (`pricingMetadata.legacyWholeHomeSizing`; an unstamped priced estimate, or
  inputs-only asking for one of the three, reads the same). Plan-wide stamp:
  a service added to a legacy estimate stays on the footprint. A browser-priced
  save naming a cockroach or guarantee row needs the stamp `false` unless the
  stored estimate is legacy (409 otherwise: a cached page cannot save a new
  footprint-priced quote).
- **Specialty prices of 2026-11-26 (evening, new quotes only; no gate, ships live)**: three CODE constants, not
  Settings, behind ONE estimate stamp `pricingMetadata.legacySpecialty1126` (true = priced before; a priced
  estimate with no stamp, or inputs-only asking for bed bug, mosquito or a stinging insect, reads true and keeps
  its old price). (1) Bed bug chemical: room 1 as before (cost ratio or the $400 minimum, with the severity, prep,
  occupancy, story, footprint and urgency factors), each added room a flat $349
  (`BED_BUG.chemical.addedRoomPrice`) on that FINAL price; added rooms take no factor. (2) Mosquito above 2 acres (87,120 sq ft): priced, the 2-acre
  per-visit price plus $85 per added acre, pro-rated, no cap; monthly keeps its ratio to seasonal; one-time
  mosquito keeps its own ladder. (3) Wasp / hornet / yellow jacket level 2 is $275 (`SPECIALTY.wasp.tiers`, was
  $250; `legacyTiers` keeps it): level 2 plus the $75 small removal = $350. Yellow jackets price through the
  same `priceStingingInsect` levels as every species. A change of these numbers is a new code rule with its own stamp.
- **One-time mosquito ladder** (owner 2026-10-25): starts at $199 and each
  extra 5,000 sq ft adds a little less than the one before. Keep the
  per-segment slope non-increasing, over-acre step included, when repricing.
- **Lawn IS WaveGuard-tier-discountable** (2026-07-28): the old
  "lawn non-discountable" rule is DEAD — never re-flag
  `discount-engine.js` lawn eligibility.
- **Lawn 12x/app never exceeds 9x/app**: runtime cap
  `min(prev, floor(enh × 12/9))` (`LAWN_PRICING_V2_LADDER_CAP` + client
  lawnLookup mirror).
- **Quarterly lawn and the basic/4-app tier are retired for NEW sales**
  (accept-time 409 `retired_lawn_cadence_selection`); legacy plans keep
  billing as sold.
- **Pest cadence curve** (quarterly 1.00 / bi-monthly 0.88 / monthly 0.78)
  applies to RECURRING pest only — one-time pest anchors on the
  undiscounted quarterly base. The curve is code-only; the old
  `pricing_config.pest_frequency` row is inert/removed — never rewire it
  or add an admin editor for it.
- **Mosquito recurring rate is settled** (2026-07-26, +10% ≈ 60% margin) —
  never re-cut it.
- **≥5-unit condo/association stacks price as Multifamily COMMERCIAL**;
  don't lower `AGGREGATE_MIN_UNITS` (5).

## Related guardrails

- Marketing pages never hardcode dollar amounts — link to
  `/pest-control-calculator/` instead.
- Services without a catalog price stay blank — never default to $0.00.
- The $99 WaveGuard membership fee applies to SOLO recurring pest or SOLO
  recurring mosquito only (bundle = no fee; never on lawn/T&S/termite) —
  see waves-billing invariant 9 for the code authority.
