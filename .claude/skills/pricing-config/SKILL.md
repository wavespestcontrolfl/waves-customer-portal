---
name: pricing-config
description: Use for ANY change to pricing values, brackets, fees, or discounts. Pricing is DB-authoritative — editing constants.js alone is inert and the change will silently not ship. This is the checklist that makes a pricing change real.
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
   class: `TechEstimatorPage` keeps static option tables (e.g. `TS_OPTS`).
   Use ripgrep (recursive `grep` is banned in this monorepo):

   ```
   rg -n "<the old value or constant name>" client/src server/services
   ```

5. **Verify after deploy** — confirm the migration ran and the live
   estimator (`/pest-control-calculator/` flow or admin estimate builder)
   shows the new value.

## Related guardrails

- Marketing pages never hardcode dollar amounts — link to
  `/pest-control-calculator/` instead.
- Services without a catalog price stay blank — never default to $0.00.
- The $99 WaveGuard setup fee is pest-recurring-only — never on
  lawn/T&S/mosquito/termite-only estimates.
