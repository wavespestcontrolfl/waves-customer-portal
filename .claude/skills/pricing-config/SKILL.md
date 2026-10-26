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

- **Pricing floors** (2026-07-17 disarmed every margin/program floor; owner
  2026-10-09 re-armed one, for lawn): a residential recurring lawn plan
  lists at cost / 0.55 with a $55-a-visit minimum, and WaveGuard tier and
  manual discounts on the lawn line stop at a 35% collected margin
  (`GATE_LAWN_COST_PLUS_LIST`, ON in production since 2026-10-26). The
  owner ruled the same 35% floor for T&S; it is not built (it waits on the
  T&S protocol). Every other margin/program floor stays disarmed and
  report-only: do not flag "below floor" outside lawn, and do not add a
  floor without an owner ruling. The owner-set one-time list minimums stay
  live and re-apply after the 15% recurring-customer perk: one-time pest
  $199 (`ONE_TIME.pest.floor`) and one-time mosquito $199
  (`ONE_TIME.mosquito.floor`, owner 2026-10-25).
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
