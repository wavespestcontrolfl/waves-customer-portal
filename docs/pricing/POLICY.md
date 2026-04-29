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
**Used by:** `discount-engine.validateEstimateDiscounts`, the `/margin-check`
admin route, and the WaveGuard tier discount safety gate in
`estimate-engine.js`.

**Meaning.** Every recurring line item must keep at least 35% contribution
margin (revenue minus fully-allocated COGS: labor + materials + drive +
admin annual) **after** all stacked discounts. Falling below 35% triggers
a margin warning surfaced in the estimate output and on the `/margin-check`
operator tool.

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

### `MARGIN_TARGET_TS = 0.43`
**Where:** `constants.js` `GLOBAL.MARGIN_TARGET_TS`, used by
`service-pricing.priceTreeShrub` as the divisor when back-calculating
price from cost.

**Why higher than the global floor.** Tree & Shrub material costs are the
most volatile in the catalog (chemical spot pricing changes month-to-month
on imidacloprid, propiconazole, paclobutrazol). The 43% target builds in
an 8-point cushion above the 35% floor specifically to absorb material
swings without re-pricing the whole bracket.

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
`tree_shrub`, `mosquito`, `termite_bait`. **Not qualifiers:**
`palm_injection`, `rodent_bait` (they're billed but don't bump the tier).

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
   - `rodent_bait`: $50 setup credit for any WaveGuard member
   - `bed_bug_chemical` / `bed_bug_heat`: $50 flat WaveGuard credit
   - `bora_care`, `pre_slab_termidor`, `german_roach_initial`,
     `pest_initial_roach`: no discount, no credit. These are non-waivable
     cost-recovery line items.
4. **Promo codes + tier**: stackable, *uncapped*. The 25% composite cap
   that existed pre-v4.3 was removed because it interacted badly with
   military / referral / new-customer flat credits. **The protection is
   `MARGIN_FLOOR` — every stacked combo gets validated against it.**
   If a promo + tier combination drops a line below 35%, the validator
   warns and the operator must intervene.

**Open question (v4.4 backlog).** Do we want to formalize an explicit
composite cap separate from the margin floor? Pro: simpler customer-facing
explanation. Con: margin-floor enforcement already does the right thing
case-by-case. Decision deferred.

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
— Zone multipliers (`ZONES.A/B/C/D`) handle the geographic spread.

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

### `PEST.base = 117`, `PEST.floor = 89`
**Meaning.** `base` is the unmodified pest control per-visit price for a
typical 2,000 sqft footprint. `floor` is the absolute minimum after
all footprint/feature/property-type adjustments — no estimate goes below
this regardless of property size.

**Rationale.**
- `base` is the operator's v4.3 anchor, set against (a) average per-visit
  COGS in 2026 ($45–55) yielding ~55-58% baseline margin and (b)
  competitive parity with TruGreen / Massey within the 1,800–2,200 sqft
  band.
- `floor` exists because tiny properties (sub-1,200 sqft condos, mobile
  homes) had pre-floor prices in the $70s, which doesn't cover loaded
  visit cost (drive + 20 min on-site + chemical + admin allocation).
  $89 is the calculated break-even at `MARGIN_FLOOR`.

### Lawn brackets — `LAWN_BRACKETS`
**Where:** `constants.js`, separately for `st_augustine`, `bermuda`,
`zoysia`, `bahia`. Each track has 12 size brackets × 4 service tiers
(basic 4x/yr, standard 6x/yr, enhanced 9x/yr, premium 12x/yr).

**Rationale.** Bracketing is by lawn square footage with shade-adjusted
turf factor (a 5,000 sqft heavily shaded lawn behaves like a 4,000 sqft
sunny lawn for chemical and mowing time). The tier-pricing structure
matches industry norms but the absolute $/visit numbers are calibrated
to SWFL-specific factors:
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
**Lot category × tier matrix.** Visits per year vary by tier
(`bronze=12, silver=12, gold=15, platinum=17`). These tier visits
intentionally don't all match — Platinum gets more visits, not just a
discount on the same number — because the value prop at the top tier
is a more aggressive treatment cadence during peak SWFL mosquito
season (June–September).

### Other services
Termite, rodent, palm, and specialty values follow the same pattern:
calibrated against actual COGS at `MARGIN_FLOOR`, with industry-comparable
absolute $ numbers within the SWFL market band. When updating any of
them, the same playbook applies (re-derive from cost, update DB seed
and constant, run margin-check).

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
- Composite discount cap policy decision (formalize cap, or stay
  margin-floor-driven only).
- Per-service margin targets — Tree & Shrub uses 43% but the rest
  effectively use the global 35% floor as a target. Should other
  high-volatility services (e.g., specialty bed-bug heat) get explicit
  per-service targets above the floor?
- Frequency-discount curves for pest (`v1` 0.85/0.70 vs `v2` 0.88/0.78).
  Currently `v2` is live. Is `v1` retired permanently or still a fallback?
- Initial fees / setup fees: `PEST.initialFee = $99`, rodent setup $199,
  german roach setup $100. Are these calibrated against acquisition cost
  recovery or against a typical CAC payback target?
