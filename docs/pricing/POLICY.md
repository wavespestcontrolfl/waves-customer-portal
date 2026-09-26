# Pricing Policy

Operating policy for the Waves pricing engine. Documents the **why** behind
load-bearing constants in `server/services/pricing-engine/constants.js` and
records how each value is meant to move.

This file is the canonical home for pricing rationale. Code-side TODOs that
say "document policy in v4.4" should resolve here, not in the code.

> **Source of truth.** When this document and `constants.js` disagree, the
> *engine* wins (it's what bills customers). File a docs PR; don't sneak
> rationale into a constant comment as a back-channel update.

---

## Margin policy

### `MARGIN_FLOOR = 0.35`
**Where:** `constants.js` `GLOBAL.MARGIN_FLOOR`
**Used by:** margin reporting, the `/margin-check` admin route, and pricing
review signals in the estimate engine. `validateEstimateDiscounts` is a
retired no-op; the pricing engine does not reject discount combinations.

**Meaning.** 35% is the reporting threshold for recurring contribution margin
(revenue minus fully-allocated COGS: labor + materials + drive + admin annual)
after pricing-engine discounts. Falling below 35% is surfaced for operator
review; enforcement is disarmed by default under the 2026-07-17 owner ruling.

**Rationale.**
- 30% leaves no headroom for cost shocks (chemical price spikes, fuel,
  overtime). One bad quarter at 30% baseline can dip below break-even.
- 40% prices Waves out of the SWFL competitive band on the small-property
  end (sub-2,000 sqft pest, sub-3,000 sqft lawn). Customer acquisition
  cost goes up faster than per-job margin earns it back.
- 35% gives the operator (Adam, in the field) a 5-point buffer to
  hand-discount on the spot for high-value referrals or tough customers
  without the line dropping below break-even.

**How to change it.** Don't move `MARGIN_FLOOR` lightly. If margin pressure
is real, the right lever is usually one of:
1. Raise base prices (`PEST.base`, `LAWN_BRACKETS`, `MOSQUITO.basePrices`).
2. Tune `LABOR_RATE` if loaded labor cost has actually shifted.
3. Cap stacked discounts (composite cap removed in v4.3 — see "Discount
   stacking" below).

If a change is unavoidable, raise/lower in 0.025 (2.5pp) increments and
re-run `/admin/pricing-config/margin-check` against representative property
profiles before shipping.

### `MARGIN_TARGET_TS = 0.45`
**Where:** `constants.js` `GLOBAL.MARGIN_TARGET_TS`, used by
`service-pricing.priceTreeShrub` as the default admin-inclusive margin target.

**Why higher than the global floor.** Tree & Shrub material costs are the
most volatile in the catalog. The 45% target builds in a 10-point cushion
above the 35% reporting floor to absorb material swings without re-pricing
the whole bracket. The current default formula is
`price = (annualDirectCost + ADMIN_ANNUAL) / (1 - marginTarget)`, subject to
the existing tier list-price floor. The resulting displayed margin includes
the annual admin allocation.

### Tree & Shrub program cadence (tiers)
**Where:** `constants.js` `TREE_SHRUB.tiers`, `recommendedTier`.

| Tier | Visits/yr | Monthly floor | Status |
|---|---|---|---|
| **Standard** | **6** | **$35** | **mandated default** |
| Enhanced | 9 | $48 | live upsell (un-retired 2026-07-23), never auto-recommended |
| ~~Light~~ | ~~4~~ | ~~$22~~ | retired for new sales 2026-09-24 (grandfathered quarterly plans only) |
| ~~Premium~~ | ~~12~~ | — | retired (→ Standard) |

Material is the bottom-up `TREE_SHRUB.materialModel` (v4.6), not a flat
$/sqft rate.

**Meaning.** The 6-visit Standard program is the mandated default and the only
auto-recommended tier — it matches the `six_x` cadence in the "10/10 SWFL Tree
& Shrub Protocol" (`server/config/protocols.json`). Enhanced (9x, every 6
weeks) is a customer-selectable upsell. Light (4x, protocol `four_x`) was
retired for new sales by owner directive 2026-09-24:
`TREE_SHRUB.tiers.light.hidden` drops it from every offering surface and
`RETIRED_SALE_SERVICE_KEYS` (`retired-sale-catalog.js`) keeps the
`tree_shrub_quarterly` catalog row out of sales and agent catalogs. The engine
still prices an explicit `light` request only to replay the grandfathered
quarterly plan.

**History — v4.5 retirement and later reactivation.** The engine had sold a
9-visit Enhanced default (and a deprecated 12-visit Premium), charging labor +
amortized material for visits that were never scheduled. The default also
auto-escalated on any single signal, including the conservative unknown-bed-
area fallback. v4.5 retired both tiers and mapped their legacy requests to
Standard. Enhanced was later reactivated as an explicit customer-selectable
upsell; Premium remains retired and maps to Standard. At the v4.5 cadence
change, the then-current 0.43 direct-cost-ratio setting was left unchanged;
v4.6 later replaced that model with the current 45% admin-inclusive margin
target.

**How to change.** Visit cadence is a customer-facing program contract: a tier
change needs a `pricing_changelog` entry and a baseline regen
(`CAPTURE_BASELINE=1`). To lower list prices further without touching cadence,
the lever is `marginTarget`; lowering it lowers list price and target margin.
Move it in a separate, deliberate step and re-run `/margin-check`.

---

## WaveGuard tiers

### Tier discount table
**Where:** `constants.js` `WAVEGUARD.tiers`. **This is the single source
of truth.** Any other file that mentions tier discounts (the audit found
`estimate-converter.js`, `client/src/lib/estimateEngine.js`, and
`server/routes/admin-pricing-strategy.js` all duplicating it with
inconsistent Platinum values) must import from here, not redefine.

| Tier | Min recurring services | Discount on recurring |
|---|---|---|
| Bronze | 1 | 0% |
| Silver | 2 | 10% |
| Gold | 3 | 15% |
| Platinum | 4+ | **20%** |

**Qualifying services** for tier counting: `lawn_care`, `pest_control`,
`tree_shrub`, `mosquito`, `termite_bait`, `rodent_bait` (joined
2026-08-29, owner directive). **Not a qualifier:** `palm_injection`
(billed but doesn't bump the tier).

**Rationale for the curve.**
- Bronze 0% is intentional. Bronze isn't a discount — it's the
  "you're a recurring customer, here's the brand promise" tier. Saving
  the discount for 2+ services creates a real incentive to bundle.
- 10/15/20 spacing (5pp per tier) matches industry-typical bundling
  ladders (TruGreen, Massey both run similar ramps). Anything tighter
  doesn't move customers; anything wider blows margin at Platinum.
- Platinum at 20% is the calculated max where a 4-service bundle still
  clears `MARGIN_FLOOR` for the typical SWFL property profile (1,800 sqft
  home, 8,000 sqft lot, Zone A). Tested via `/margin-check` against the
  sample basket.

**How to change it.**
- Adding a 5th tier or moving the existing thresholds is a customer-facing
  contract change. It needs a `pricing_changelog` entry, an
  `affected_services` audit, and a 60-day grandfather window for active
  customers (existing estimates keep their stamped `pricing_version`).
- Changing percentages: same process, plus run `/margin-check` at every
  tier across all qualifying-service combinations before approving.

### Discount stacking
**Where:** `discount-engine.getEffectiveDiscount`.

Rules in v4.3:
1. **Recurring services** get the WaveGuard tier discount (Bronze 0% →
   Platinum 20%).
2. **One-time services** never see the tier discount. Recurring customers
   get a flat 15% perk (`recurringCustomerOneTimePerk`) on one-time
   services instead. The two never combine on the same line item.
3. **Excluded services** (`WAVEGUARD.excludedFromPercentDiscount`) get
   no percentage discount. Some get a fixed flat credit:
   - `palm_injection`: $10/palm/yr for Gold+ members
   - `rodent_bait` left this list 2026-08-29 (owner directive): it now
     tier-counts AND takes the tier %. Footprint-bracket pricing,
     $79–$129 per application (quarterly) with an up-to-N station allowance
     (ladder extends +1 station/+$10 per 1,000 sf above 6,750);
     commercial uses the same brackets but stays flat. A $99 one-time
     setup applies only to non-WaveGuard members (no other qualifying
     recurring service).
   - `bed_bug`, `bed_bug_chemical`, `bed_bug_heat`: no percentage discount
     and no flat credit
   - `bora_care`, `pre_slab_termidor`, `german_roach_initial`,
     `pest_initial_roach`: no discount, no credit. These are non-waivable
     cost-recovery line items.
4. **Scope of this helper:** `getEffectiveDiscount` chooses the applicable
   WaveGuard tier discount for a recurring line or the recurring-customer
   one-time perk. It has no promo-code input and does not stack or validate
   promo combinations. Database-backed promo records are handled by the
   separate application discount service at its integration boundary.
   `validateEstimateDiscounts` is retired and returns no warnings; margin
   reporting remains the operator signal described above.

**Open question (v4.4 backlog).** Do we want to formalize an explicit
composite cap and validation policy in the application discount integration?
The pricing-engine helper does not currently enforce either. Decision
deferred.

---

## Urgency multipliers

**Where:** `constants.js` `URGENCY`.

| Tier | Standard | After hours |
|---|---|---|
| NONE | 1.00× | — |
| SOON | 1.25× | 1.50× |
| URGENT | 1.50× | 2.00× |

**What "soon" / "urgent" / "after hours" mean.**
- **SOON**: customer wants service within 48 hours, displaces a routine
  visit on the route. We bump the route, but it's still a normal day.
- **URGENT**: customer wants service same-day, requires breaking a tech
  off a planned route or assigning the on-call tech. Driving cost and
  schedule disruption is real.
- **AFTER HOURS**: weekend, holiday, or tech off-shift. Tech is paid
  premium time; we charge premium pricing to recover that and to
  discourage non-emergency requests outside the normal window.

**Rationale for the values.**
- 1.25× / 1.50× for SOON: covers the route disruption (one displaced
  customer's window slides, sometimes with a $15–25 reschedule perk)
  plus the 15-20 minute window-recovery overhead. 1.20× wouldn't break
  even on a typical $100 visit.
- 1.50× / 2.00× for URGENT: tech overtime + lost routing efficiency on
  the displaced visits. 2.00× after-hours is approximately 1.5× labor
  premium × 1.33× margin recovery — calibrated to the actual cost
  delta, not a pricing-power play.

**How to change it.** These are customer-facing on the estimate. Move
slowly. Consider if the underlying cost has actually shifted (chemical
delivery surcharges, tech wage changes) before tweaking.

---

## Loaded labor rate

### `LABOR_RATE = 35.00 ($/hr)`
**Where:** `constants.js` `GLOBAL.LABOR_RATE`. Used by every service that
has a labor component (pest, lawn, tree & shrub, palm, mosquito, termite,
rodent, plus all specialty services).

**What "loaded" means.** Direct hourly wage **plus** payroll tax,
workers' comp, vehicle (truck cost amortized + fuel), insurance,
benefits. Roughly 1.55× the gross hourly wage for the operator's
current cost stack.

**How to update.** When base wages change or the truck/insurance line
moves materially:
1. Recompute the loaded number (HR + accounting).
2. Update `pricing_config.global_labor_rate` in the DB via the admin
   pricing config UI. The engine reads via `db-bridge.syncConstantsFromDB`.
3. The hardcoded `35.00` in `constants.js` is the **fallback** — it
   stays in sync with the DB seed. Update both in the same PR.
4. Re-run `/margin-check` after the change. A $1/hr increase in loaded
   labor moves margin on a typical pest visit by ~1.5pp.

---

## Drive time + admin overhead

### `DRIVE_TIME = 20 (minutes/visit)` and `ADMIN_ANNUAL = 51 ($/service/yr)`

**`DRIVE_TIME`**: average drive time per route stop, measured across the
operator's actual SWFL routes (Manatee + Sarasota + Charlotte). Used to
compute the labor cost contribution from drive in
`service-pricing.js`. This is a fleet average, not a per-property value
— service zones remain routing/metadata labels and do not change price.

**`ADMIN_ANNUAL`**: $51 per service per year for billing, scheduling,
CRM, and dispatch overhead. Allocated annually because the underlying
costs (Stripe fees on recurring billing, Twilio SMS, hosting) are
recurring fixed costs spread across active customers.

**How to update.** Both values are infrastructure cost allocations. They
move when:
- Fleet drive time shifts (new tech, route expansion, new spoke market).
- Admin tooling cost changes materially (e.g., a new SaaS subscription
  that materially increases per-service overhead).

Re-derive from operator records, update `pricing_config`, and re-run
`/margin-check`.

---

## Base service prices

### `PEST.base = 112`, `PEST.floor = 89`
**Meaning.** `base` is the unmodified pest control per-visit price for a
typical 2,000 sqft footprint. `floor` is the quarterly/property-adjusted base
floor before cadence and discounts. Post-discount program-floor enforcement
is disarmed by default, so the discounted candidate may fall below that
reference and is returned with reporting flags. Explicitly re-arming
`pricing_config.pest_base.enforce_floor_post_discount` restores enforcement.

**Rationale.**
- `base` is the operator's v4.3 anchor ($117), set against (a) average
  per-visit COGS in 2026 ($45–55) yielding ~55-58% baseline margin and (b)
  competitive parity with TruGreen / Massey within the 1,800–2,200 sqft
  band — minus the $5 light-tree-density fold (owner ruling 2026-08-03:
  tree density is not a pest-pricing input; every pest quote prices as
  light tree density, replacing the retired `trees_light: -5` modifier;
  migration `20260803150000`).
- `floor` exists because tiny properties (sub-1,200 sqft condos, mobile
  homes) had pre-floor prices in the $70s, which doesn't cover loaded
  visit cost (drive + 20 min on-site + chemical + admin allocation).
  $89 is the calculated break-even at `MARGIN_FLOOR`.

### Pest roach pricing
**Meaning.** Recurring pest no longer charges a recurring roach percentage
premium. `PEST.roachModifier.german`, `.regular`, and `.none` are all
`0`; the `roachType` field is retained so callers can request the correct
first-visit line.

**Current behavior.**
- Recurring pest with regular/native roach selected auto-adds
  `pest_initial_roach`; its admin-editable display name defaults to
  **Cockroach Treatment Service**.
- Recurring pest with German roach selected auto-adds
  `pest_initial_roach`; its admin-editable display name defaults to
  **German Cockroach Treatment**.
- The initial knockdown is a fixed first-visit cost-recovery fee, not a
  one-time service discount target. It is not waived by annual prepay and
  is excluded from recurring-customer one-time percentage discounts.
- Standalone regular roach uses the higher standalone native-roach scale.
- Standalone German roach is the separate German Roach Cleanout program,
  priced by infestation severity (see German Roach Cleanout below).

**Brackets.**
- Recurring native roach initial: `$119` under 1,500 sqft, `$139` from
  1,500-2,500 sqft, `$169` over 2,500 sqft.
- Recurring German roach initial: `$169` under 1,500 sqft, `$199` from
  1,500-2,500 sqft, `$249` over 2,500 sqft.
- Standalone regular roach: `$202.50` under 1,500 sqft, `$239` from
  1,500-2,500 sqft, `$289` over 2,500 sqft.

**German Roach Cleanout (`german_roach`).** Severity-based, all-in flat
pricing — footprint/square-footage is not a factor and there is no separate
setup charge (the tier price is the full customer total). Severity drives both
price and the number of return visits needed to break the breeding cycle:
- Light: `$350`, 2 visits.
- Medium (`moderate`): `$450`, 3 visits.
- Heavy: `$550`, 4 visits.

Severity `severe` collapses into the Heavy tier; a missing/invalid severity
defaults to Light. Like the initial knockdown fees, the cleanout is excluded
from percentage discounts (`noRecurringDiscount`).

**Rationale.** Roach work is a heavier first visit, not a clean recurring
percentage premium. A fixed initial fee recovers the product and labor cost
even if the customer churns before the old percentage modifier would have
paid back the visit-1 burden.

### Pest pool cage pricing
Pool cage pest pricing is intentionally conservative while the production
calibration report gathers actual on-site time:

| Pool cage size | Per-visit pest adjustment |
|---|---:|
| Small | `$5` |
| Medium/default | `$8` |
| Large | `$12` |
| Oversized | `$18` |

These values are additive property adjustments. Production minutes remain
shadow-only until calibrated against Bouncie/time-tracking actuals.

### Lawn brackets — `LAWN_BRACKETS`
**Where:** `constants.js`, separately for `st_augustine`, `bermuda`,
`zoysia`, `bahia`. Each code-default track has 20 size rows and three source
columns: Standard 6x/yr, Enhanced 9x/yr, and Premium 12x/yr. Basic 4x is
retired. Standard 6x remains an internal pricing anchor but is hidden from new
residential offers by default; new offers present Enhanced 9x and Premium 12x.

**Rationale.** Bracketing is by raw lawn square footage. Shade affects the
agronomic protocol and product selection, but it is not a pricing input. The
tier-pricing structure matches industry norms but the absolute $/visit
numbers are calibrated to SWFL-specific factors:
- St. Augustine dominates the local turf mix (>70% of yards) and is the
  most chemical-intensive (chinch bug + brown patch). Highest baseline.
- Bermuda is rarer locally; less intensive treatment.
- Zoysia is premium turf with lower bug pressure but higher fertility
  needs — middle pricing.
- Bahia is low-input pasture grass; lowest pricing.

**How to change.** Update via the admin `/admin/pricing-config/lawn-brackets`
UI. Changes write to the `lawn_pricing_brackets` table and bust the
in-memory cache. Run `/margin-check` after any bracket move.

### Mosquito tier prices — `MOSQUITO.basePrices`
**Treatable-area × program matrix.** The current programs are `seasonal9`
(9 visits/year) and `monthly12` (12 visits/year). WaveGuard tier aliases are
separate from cadence: Bronze maps to `seasonal9`, while Silver, Gold, and
Platinum map to `monthly12`.

### Other services
Termite, rodent, palm, and specialty values follow the same pattern:
calibrated against actual COGS at `MARGIN_FLOOR`, with industry-comparable
absolute $ numbers within the SWFL market band. When updating any of
them, the same playbook applies (re-derive from cost, update DB seed
and constant, run margin-check).

Termite bait hardware is the exception to "update the constant": since
2026-09-09 the Trelona station cost and the replacement-cartridge cost are
read from the inventory catalog (`products_catalog` rows named in
`TERMITE.systems.trelona.catalogProductName` /
`TERMITE.cartridges.catalogProductName`) on every pricing sync — approved
vendor best price only, sanity-banded to [0.5×, 2×] of the config value,
fail-open to the config value, source stamped on the line as
`materialCostSource`. A vendor price change reaches quotes without a
deploy; `pricing_config.termite_install.link_station_costs_to_catalog =
false` is the kill switch. The $24.00 constant / config value is the
fallback, not the price of record. Cartridge inputs (`cartridge_cost`,
`cartridges_per_station`, `cartridge_replacement_rate`,
`follow_up_visit_reserve`) are REPORT-ONLY: they feed the termite line's
`costs` block and `scripts/audit-estimator-pricing.js --termite-plan`,
never a price.

---

## Pricing version + audit trail

### `pricing_version` column on `estimates`
Every estimate row stamps the engine version it was priced under
(currently `v4.2`, with v4.3 mid-rollout). When pricing changes, existing
estimates keep their stamped version — they aren't re-priced
retroactively. Customers and admins can always look up "what was
quoted on date X under what rules" by joining `estimates.pricing_version`
to `pricing_changelog`.

### `pricing_changelog` table
Every approved pricing change should land here with `version_from`,
`version_to`, `category` (bug | leak | rule | cost | architecture |
documentation | infrastructure), `affected_services`, `before_value`,
`after_value`, and `rationale`. This is the canonical "why did this
change" log, separate from `pricing_config_audit` which only logs
field-level edits.

### `pricing_engine_proposals` (approval queue)
For pending changes that haven't been approved yet. Operator (or
intelligence) submits a proposal; admin reviews via
`/admin/pricing-proposals`; approval triggers `applyConfigUpdate` (which
uses Postgres `jsonb_set` on `pricing_config`) and creates a
`pricing_changelog` entry.

---

## Open documentation TODOs (v4.4 backlog)

The following items are documented at a working level above but may
benefit from deeper write-ups:
- Composite discount cap policy decision at the application discount
  integration boundary; the pricing-engine helper does not enforce one.
- Per-service margin rationale — Tree & Shrub uses an explicit 45%
  admin-inclusive target, the global 35% value is a reporting threshold, and
  some specialty pricers use their own margin divisors. Document why each
  service-specific target/divisor differs where the current write-up is thin.
- Frequency-discount curves for pest (`v1` 0.85/0.70 vs `v2` 0.88/0.78).
  `v2` is the current code default; `v1` remains for explicit-version replay.
- Initial fees / setup fees: `PEST.initialFee = $99`, rodent setup $99
  (non-WaveGuard members only, 2026-08-29).
  (German Roach Cleanout no longer carries a separate setup charge — its
  severity-tier price is all-in.) Are these calibrated against acquisition
  cost recovery or against a typical CAC payback target?
