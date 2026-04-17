# Session 2 — Import Audit

**Step A output.** Captured before any code changes. Every call site classified.

---

## API path verification

- `server/index.js:282` mounts `admin-pricing-config` at `/api/admin/pricing-config`
- `server/routes/admin-pricing-config.js:304` defines `router.post('/estimate', …)`
- **Full URL:** `${PROD_URL}/api/admin/pricing-config/estimate` ✅ resolves

Response shape: `{ estimate: { summary, waveGuard, lineItems, … } }`. The regression harness must unwrap `.estimate` before reading `summary.recurringAnnualAfterDiscount` etc. (Canonical's `postEstimate` reads the raw body — needs patching.)

---

## Client call sites — `estimateEngine.js`

| # | File:Line | Symbol | Classification | Migration |
|---|-----------|--------|---------------|-----------|
| 1 | `client/src/pages/admin/EstimatePage.jsx:2` | `calculateEstimate` | **QUOTE_COMPUTATION** | Replace line 708 `calculateEstimate(inputs)` with `await pricingEngineClient.generateEstimate(inputs)`. Add 400ms debounce + loading indicator. |
| 2 | `client/src/pages/admin/EstimatePage.jsx:2` | `fmt`, `fmtInt` | **PURE_FORMATTER** | Extract to `client/src/lib/pricingFormatters.js`. ~40+ JSX usages; just swap the import. |
| 3 | `client/src/pages/admin/EstimatePage.jsx:644` | — | **N/A** (code comment, not import) | No action. |
| 4 | `client/src/pages/EstimateViewPage.jsx:4` | `calculateEstimate` | **QUOTE_COMPUTATION** | Replace with `pricingEngineClient.generateEstimate`. Add debounce + loading state. |
| 5 | `client/src/lib/pricingEngineClient.js:48` | re-export `fmt, fmtInt` | **BARREL RE-EXPORT** | Point re-export at `./pricingFormatters` instead. (Or remove once all callers import from the new location.) |

No dynamic imports found. No barrel re-exports other than row 5.

### ⚠️ Latent bug in `pricingEngineClient.js`

`pricingEngineClient.generateEstimate` (line 31-37) destructures `{ estimate }` from `await adminFetch(...)`. But `adminFetch` (line 27 of `adminFetch.js`) **returns a raw `Response` object** — callers must invoke `.json()` themselves (other consumers like `ExpenseCapture.jsx`, `JobFormSection.jsx`, `JobCostCard.jsx` all do this).

**The wrapper has never been end-to-end tested.** Shipping Session 2 as-canonical would break EstimatePage at migration time. Fix required before Step D:

```js
export async function generateEstimate(input) {
  const r = await adminFetch('/admin/pricing-config/estimate', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  });
  if (!r.ok) throw new Error(`Estimate failed: ${r.status}`);
  const { estimate } = await r.json();
  return estimate;
}
```

Same fix for `quickQuote`. Adds 2 lines each.

---

## Server call sites — `pricing-engine-v2.js`

| # | File:Line | Call | Classification |
|---|-----------|------|---------------|
| 1 | `server/routes/property-lookup-v2.js:1093` | `calculateEstimate(profile, selectedServices, options)` | **QUOTE_COMPUTATION** — non-trivial migration (see below) |
| 2 | `server/routes/admin-pricing-config.js:120` | `v2.invalidatePricingConfigCache()` | **DEAD_CODE** once v2 file is deleted — remove the `const v2 = require(...)` block |
| 3 | `server/routes/admin-pricing-config.js:278` | `v2.invalidatePricingConfigCache()` | **DEAD_CODE** (same as row 2) |
| 4 | `server/services/pricing-engine-v2.js:94` | self-reference in `console.error` | Deleted with the file |

No `pricingEngineV2` (camelCase) references found.

### 🛑 Non-trivial migration: `property-lookup-v2.js /calculate-estimate`

This is the real blocker for Step G.

**What it does:** `POST /api/admin/estimator/calculate-estimate` — called by EstimatePage (line 631 of EstimatePage.jsx) for the "property lookup → estimate" flow. Accepts `{ profile, selectedServices, options }`, returns a tier-array-shaped response like:

```js
{
  recurring: {
    lawn:  { tiers: [{ perApp, visits, annual, monthly, label, recommended }, ...] },
    pest:  { tiers: [{ perApp, freq, annual, monthly, label, recommended }, ...] },
    treeShrub: { tiers: [...] },
    mosquito:  { tiers: [...] },
    rodentBait: { tiers: [...] },
  },
  waveguard: { tier, discount, qualifyingCount, ... },
  totals: { ... },
}
```

The client then does its own mapping at lines 1096-1129 to build a `R` ("results") object with `R.lawn[]`, `R.pestTiers[]`, etc.

**v2's deprecation header (lines 10-15) documents this exact blocker:**

> DO NOT add new features here. Add them to pricing-engine/modifiers.js or pricing-engine/service-pricing.js. Migration blocker: Add tier-array emission to pricing-engine/service-pricing.js for lawn/pest/treeShrub/mosquito/rodentBait (basic/standard/enhanced/premium). Then swap property-lookup-v2 require() and delete this file.

**Good news — tier emission already exists in the modular engine** at the individual-pricer level:
- `service-pricing.js:99` — pest emits `{ tiers }`
- `service-pricing.js:200` — lawn emits `{ tiers }`
- `service-pricing.js:367` — rodent emits `{ tiers }`
- Tree & shrub and mosquito also emit tier data

But `generateEstimate()` (line 390 of estimate-engine.js) **does NOT forward the tier arrays** to its output. It collapses each service to a single `lineItem` with one price.

**Migration options:**

1. **Call individual servicePricing functions directly from property-lookup-v2.** Build the tiered response shape in the route by calling `priceLawn`, `pricePest`, etc. (these ARE exported via `...servicePricing` spread in `pricing-engine/index.js`). Moderate refactor — ~1-2 hours.

2. **Add a tier-array adapter to the modular engine.** Extend `generateEstimate` (or add a `generateTieredEstimate`) that forwards the `tiers` array from each service pricer into the top-level output. Cleanest architecturally. ~2-3 hours plus output-shape design.

3. **Leave `pricing-engine-v2.js` alive for `property-lookup-v2.js` only.** Deletes the two DEAD_CODE cache-invalidation callers. Leaves v2 as an intentionally-scoped legacy for the `/calculate-estimate` route. Defer full deletion to a future session.

**Session 2's canonical assumes Option 1 or 2 is in scope.** Option 3 contradicts the canonical's "v2 removed" deliverable.

---

## Summary table — action plan

| File | Action |
|------|--------|
| `client/src/lib/pricingEngineClient.js` | **Fix latent bug** (missing `.json()`). Update re-export path. |
| `client/src/lib/pricingFormatters.js` | **Create** — extract `fmt`, `fmtInt` from estimateEngine. |
| `client/src/pages/admin/EstimatePage.jsx` | Swap `calculateEstimate` → `pricingEngineClient.generateEstimate`. Debounce + loading. Update formatter import. |
| `client/src/pages/EstimateViewPage.jsx` | Same migration as EstimatePage (smaller scope — no lookup flow). |
| `client/src/lib/estimateEngine.js` | **Delete** after client migrations complete. |
| `server/routes/property-lookup-v2.js` | **Non-trivial migration** — decide Option 1 / 2 / 3 before proceeding. |
| `server/routes/admin-pricing-config.js` | Remove v2 cache-invalidation blocks at lines 119-124 and 277-282. The modular engine's `syncConstantsFromDB()` call (still present in same blocks) stays. |
| `server/services/pricing-engine-v2.js` | **Delete** — pending property-lookup-v2 migration decision. |

---

## Scope decisions — locked

**pricingEngineClient bug fix:** folded into Step D. Zero runtime impact today (wrapper has no callers); becomes load-bearing when Step D wires it into EstimatePage. Fix ships with the commit that depends on it. Applied to both `generateEstimate` and `quickQuote`.

**property-lookup-v2 migration: Option 3 — defer to new Session 11.** v2's specialty-service pricing (bedbug, exclusion, boracare, preslab, foam, stinging, plug, one-time lawn) is ~40-50% of the 1,450-line file and has no v1 equivalent. Porting is 6-10 hours and amounts to re-implementing v2 inside v1. Session 11 will do that port cleanly on top of a stable v1 foundation (post Sessions 3-10).

Session 2 in-scope:

- Delete `client/src/lib/estimateEngine.js` ✅
- Migrate `EstimatePage.jsx` fallback path (line 708) + `EstimateViewPage.jsx` to `pricingEngineClient`
- Remove the 2 DEAD_CODE v2 cache-invalidation blocks in `admin-pricing-config.js`
- Update `pricing-engine-v2.js` `@deprecated` header to reference Session 11
- Ship 12-case v1 regression suite + baseline
- **NEW:** Ship parallel 12-case v2 regression suite + baseline (covers Virginia's hot path through Sessions 3-10)
- Changelog entry documenting what shipped + what was deferred

Session 2 out-of-scope (→ Session 11):

- Delete `server/services/pricing-engine-v2.js`
- Rewrite `property-lookup-v2.js` to not depend on v2
- Port v2 specialty/one-time services, urgency multipliers, recurring-customer discount, fieldVerify/notes into v1's `generateEstimate`

---

## Additional finding — v2 commercial overrides are dead code

v2's `calculateEstimate` destructures `commBuildingType`, `commPestFreq`, `commLawnFreq`, `commAfterHours` at `pricing-engine-v2.js:150-154` but **never references them anywhere else in the file.** The only commercial logic present (line 208: `if (ptl.includes('commercial'))`) operates on `profile.propertyType`, not on these options.

No client caller passes these options either — grep for `commBuildingType` / `commercialOverride` in `client/src/` returns zero matches. `EstimatePage.jsx:423` handles `propertyType === 'Commercial'` as a label but doesn't route through the dead options.

**Implication:** v2's commercial overrides are a ghost pathway — code that exists but does nothing. Skip v2 regression case for commercial (Case 13 originally proposed dropped). Session 11 should design commercial pricing fresh rather than revive unreachable scaffolding.

---

## Action plan (revised)

| File | Session 2 action |
|------|------------------|
| `client/src/lib/pricingEngineClient.js` | Fix `.json()` + `.ok` bug in `generateEstimate` + `quickQuote`. Point `fmt`/`fmtInt` re-export at new `pricingFormatters.js`. |
| `client/src/lib/pricingFormatters.js` | **Create** — extract `fmt`, `fmtInt` from estimateEngine. |
| `client/src/pages/admin/EstimatePage.jsx` | Fallback path (line 708): `calculateEstimate(inputs)` → `await pricingEngineClient.generateEstimate(input)` with 400ms debounce + loading indicator. Update formatter import. |
| `client/src/pages/EstimateViewPage.jsx` | Same migration (smaller surface — no fallback logic). |
| `client/src/lib/estimateEngine.js` | **Delete** after client migrations complete. |
| `server/routes/admin-pricing-config.js` | Remove the v2 `require(...)` + `v2.invalidatePricingConfigCache()` calls at lines 119-124 and 277-282. Keep `modular.syncConstantsFromDB()`. |
| `server/services/pricing-engine-v2.js` | Update `@deprecated` header to reference Session 11. Do NOT delete. |
| `server/routes/property-lookup-v2.js` | **No changes.** Keeps calling v2. Full migration in Session 11. |
| `server/tests/pricing-engine.regression.test.js` | **Create** — 12 cases vs `/api/admin/pricing-config/estimate`. |
| `server/tests/pricing-engine-v2.regression.test.js` | **Create** — 12 cases vs `/api/admin/estimator/calculate-estimate`. |
| `server/tests/pricing-engine.baseline.json` | **Create** — captured from prod pre-session. |
| `server/tests/pricing-engine-v2.baseline.json` | **Create** — captured from prod pre-session. |

---

## Post-capture findings (2026-04-17)

### Anomaly 1 — Platinum WaveGuard discount captured at 0.20, not 0.18

Prod's current Platinum discount is 20%, not the 18% the original build brief assumed. Baseline captured as-is (current state is the truth).

**Implication for Session 6:** the "restore Platinum from 18% → 20%" line item is a **no-op**. Other Session 6 work (lawn Enhanced/Premium cap removal, discount engine simplification) still required.

**Root cause not investigated.** Most likely: stale doc → brief pipeline, or a prior admin-UI edit of `pricing_config` without a changelog entry. Governance note: going forward, every pricing change (including manual admin-UI edits) must land a `pricing_changelog` row.

See `server/tests/BASELINE-NOTES.md` for full context.

### Anomaly 2 — v2 termite `tmBait` omits HexPro (`hi`) in prod

Prod currently emits `tmBait = { ai, ti, bmo, pmo }` — no `hi` (HexPro install) field.

At baseline capture time, `server/routes/property-lookup-v2.js:1159` had an uncommitted local diff adding `hi: tb.hexpro?.install || 0` to the emission. **Reverted** — baseline matches prod behavior.

**Why not ship the `hi` addition in Session 2:** it's a feature change, not a migration. Adding a new field to the lookup response requires UI work on EstimatePage (render HexPro install price, quote assembly handling) and a Virginia workflow change. Out of Session 2 scope.

**Deferred to Session 11** (v2 retirement) for business decision: is HexPro omission a bug (engine computes at `pricing-engine-v2.js:929-938`, route drops during response shaping) or an intentional hide from the lookup flow?

