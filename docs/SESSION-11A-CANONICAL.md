# Session 11a — v2 Backend Retirement Canonical

**Scope locked** per decision session:
- **Q1 Split:** 11a (backend) ships first, validates 24-48h against Virginia's real use, then 11b (frontend) ships separately
- **Q3 Rename:** property-lookup-v2.js rename is CONDITIONAL on caller count — Claude Code counts in Step 1; ≤10 callers → rename in this session, >10 → punt to a future housekeeping session
- **Q4 Mapper:** v2-legacy-mapper.js retires with v2 (delete both in same commit)
- **Q6 Regression:** port v2 fixtures to v1 suite, keep v2 suite running through 11b validation, retire v2 suite after 11b ships clean. v2 suite becomes HTTP-only post-deletion (module-level v2 import breaks at LOCAL)

**Effort:** 2-3 hours focused work + 24-48h passive validation window before 11b starts.

**Environment:** Production. Single-instance Railway. Fresh admin token.

**Risk profile:** Highest of any session in the v4.3 build. v2 is Virginia's primary quoting path. If Session 11a breaks, Virginia cannot quote customers. Mitigations are built into the step order (validation gates before delete, rollback plan before push, the 24-48h window as canary).

---

## Scope-lock summary (post Step 2a audit)

Seven decisions locked going into execution:

1. **11a/11b split** confirmed — backend retirement ships 11a, validates 24-48h against Virginia's real use, then 11b lands frontend
2. **property-lookup-v2 rename:** proceed. Step 1c caller count was 1 module-level require (`server/index.js:57`) + 2 client fetch paths (`EstimatePage.jsx:396`, `:631`) — well under the ≤10 threshold. Rename to `property-lookup.js`. Mount path `/api/admin/estimator` unchanged, client URLs unchanged.
3. **v2-legacy-mapper retires with v2** — delete both in the same commit
4. **Regression strategy:** port 6 unique v2 fixtures to v1 suite (skip 8 duplicates); keep v2 suite HTTP-only through 11b validation; retire v2 suite after 11b ships clean
5. **Orchestration audit (Step 2a) results:** 6 gaps surfaced where v2 has dispatch or semantic logic that v1 lacks — not just 1 (preSlab) as initially estimated. Full table below in Step 2a.
6. **Scope:** Option A — fix all 6 gaps. Engine-first then adapter execution order.
7. **Execution timing:** fresh next session. Scope locked in the decision session; byte-parity engine work executes against this amended canonical when attention and context are at their best.

---

## Trust floor established by prior sessions

Sessions 1 through 10 all shipped. Specific state Session 11a depends on:

- **Engine code:** constants.js, service-pricing.js, discount-engine.js, estimate-engine.js, property-calculator.js, modifiers.js, db-bridge.js, index.js all at post-Session-10 state
- **Regression baselines:** v1 13/13 and v2 14/14 both byte-identical against prod HTTP, confirmed by Session 10's final HTTP regression
- **LOCAL=1 harness:** correctness-gated per Session 10 (dotenv load, knexfile test env, boot assertions for pricing_config fields and Silver discount sentinel)
- **Seed script:** `npm run seed:pricing` mirrors prod pricing_config + discounts into local
- **pricing_changelog:** id=11 landed as Session 10's final entry
- **Stashes:** two stashes present (stripe-mistake-session3-removed, session-9-WIP-era). model-registry work landed as commit 5b5be63 earlier.
- **Uncommitted ambient:** 7 admin route mods + .mcp.json + untracked .claude artifacts. NONE touch pricing engine.

Session 11a begins from this foundation.

---

## Prompt to paste into Claude Code

Paste as one unit.

---

Session 11a: v2 backend engine retirement. Canonical scope-locked per Session 11 pre-canonical decisions.

**What retires in 11a:**
- `server/services/pricing-engine-v2.js` (~1,447 lines)
- `server/services/pricing-engine/v2-legacy-mapper.js`
- Any server-side imports of pricing-engine-v2 (routes, intelligence bar tools, etc.)
- v2 regression suite's LOCAL-mode capability (suite becomes HTTP-only)
- Conditional: `server/routes/property-lookup-v2.js` may rename to `property-lookup.js` based on Step 1's caller count

**What stays in 11a:**
- Full v1 engine (may get additions from v2-only path ports)
- v2 regression fixtures (ported into v1 suite + v2 suite kept HTTP-only during validation window)
- Client-side: EstimatePage.jsx, EstimateViewPage.jsx, estimateEngine.js — ALL untouched. 11b handles these.

**Standing rules:**
- Pre-commit `git diff --cached` on every commit
- LOCAL=1 regression before every push (correctness-gated per Session 10)
- HTTP regression after every deploy
- Customer-impact query + sign-off before destructive actions
- Changelog INSERT uses sequence-sync setval
- Verify-before-documenting (no fabricated rationale)
- Version_to bumps to 'v4.3' on Session 11b — this session stays 'v4.2'

---

### Step 0 — Pre-flight and state verification

```bash
# Starting state verification
git status
git stash list
git log --oneline -10
cat docs/SESSION-9-HALT-NOTES.md 2>/dev/null | head -5 || echo "halt note not committed (expected — yesterday's procedure didn't execute)"

# Confirm Railway single-instance
railway status 2>&1 | grep -i replica

# Fresh regression baseline before ANY changes
LOCAL=1 npx jest server/tests/pricing-engine.regression.test.js
LOCAL=1 npx jest server/tests/pricing-engine-v2.regression.test.js

# HTTP parallel check
PROD_URL=https://portal.wavespestcontrol.com ADMIN_TOKEN=$ADMIN_TOKEN npx jest server/tests/pricing-engine.regression.test.js
PROD_URL=https://portal.wavespestcontrol.com ADMIN_TOKEN=$ADMIN_TOKEN npx jest server/tests/pricing-engine-v2.regression.test.js
```

Expected: 27/27 LOCAL + 27/27 HTTP. If anything fails, STOP and report.

**Customer-impact query (standing rule):**

```sql
SELECT COUNT(*) FROM estimates WHERE created_at >= NOW() - INTERVAL '7 days';
SELECT COUNT(*) FROM estimates WHERE created_at >= NOW() - INTERVAL '24 hours';
```

Report counts. This is for context — active quote volume during the 11a-to-11b validation window.

### Step 1 — Inventory (read-only, no code changes)

Three inventories run in this step. Each gets reported before Step 2 begins.

**Inventory 1a — v2-only paths in pricing-engine-v2.js that don't exist in v1:**

```bash
# High-level function list from v2
grep -n "^function \|^async function \|^exports\.\|^module\.exports" server/services/pricing-engine-v2.js

# Cross-reference against v1 modules
for f in server/services/pricing-engine/*.js; do
  echo "=== $f ==="
  grep -n "^function \|^async function \|^exports\.\|^module\.exports" "$f"
done
```

Identify functions in v2 that have NO counterpart in v1. Categories to look for specifically:
- Specialty services: boraCare, preslab, bedBug, stinging wasp, exclusion, trenching, flea, wdo, plugging, foam, germanRoach
- One-time service urgency handling (afterHours, urgency tiers)
- Rodent trapping (distinct from rodent bait)
- Roach severity modifier paths

Report a clear list: `v2-only functions that need porting to v1` vs `v2-only functions that retire without replacement` vs `v1-equivalent exists`.

**Inventory 1b — server-side v2 callers:**

```bash
grep -rn "require.*pricing-engine-v2\|import.*pricing-engine-v2\|pricing-engine-v2'" \
  server/ \
  --include="*.js" \
  --include="*.mjs"
```

Report every file that imports pricing-engine-v2. Group by: route handlers, intelligence bar tools, agent tools, other.

**Inventory 1c — property-lookup-v2 caller count (for Q3 rename decision):**

```bash
# Count both code imports AND string references (URLs, docs)
grep -rn "property-lookup-v2\|property_lookup_v2" \
  --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" \
  --include="*.md" --include="*.json" \
  . | wc -l

# Show the actual callers for context
grep -rn "property-lookup-v2\|property_lookup_v2" \
  --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" \
  . | head -30
```

Report the count. If ≤10, Q3 decision = rename in this session. If >10, Q3 decision = punt to housekeeping.

**Hold after Step 1 inventories. Report all three findings. I'll review before authorizing Step 2.**

This check-in matters: inventory results determine the size of Steps 2 and 3. If v2 has 5 orphan functions that need porting, Step 2 is small. If v2 has 20, Step 2 is a meaningful subproject.

### Step 2a — Orchestration audit (DONE in decision session)

**Status:** Complete. Audit ran against v2 `calculateEstimate` dispatch vs v1 `generateEstimate` dispatch. Results locked below.

Six gaps surfaced where v2 has dispatch or semantic logic that v1 lacks. Initial 1a inventory framing ("no v2-only math") was incomplete — dispatch gaps and semantic gaps count.

| # | Gap | v2 path | v1 status | Class |
|---|-----|---------|-----------|-------|
| 1 | `preSlab` | `calcPreSlab` → `pricePreSlabTermidor(slabSqFt, volumeDiscount)` | `pricePreSlabTermidor` exists at `service-pricing.js:659` but NO `services.preSlab` branch in orchestrator | Dispatch |
| 2 | bedbug BOTH method | `calcBedbug` returns `{name, methods: [{method, price, detail}...]}` when method='both' | `priceBedBug(rooms, method, footprint)` handles 'heat' and 'chemical'; falls through for 'both' | Semantic |
| 3 | ROACH REGULAR | `calcRoach` REGULAR branch: `max(150, pestResult.perApp × 1.15 × 1.30)` | No REGULAR path in `priceGermanRoach`; no separate `priceRegularRoach` | Semantic |
| 4 | roachModifier wiring | v2 routes `roachModifier='GERMAN'` → german roach service automatically | v1 has `services.germanRoach` branch but no auto-fire from a modifier field | Dispatch (adapter-fixable) |
| 5 | global urgency/afterHours/recurringCustomer | v2 `applyOT` global multiplier reaches every service | v1 uses per-service `applyUrgency` at each pricing call — needs fan-out at adapter | Contract (adapter-fixable) |
| 6 | manualDiscount | v2 calcEstimate applies manualDiscount at top level | v1 has no manualDiscount knob — either engine-level add OR adapter post-process | Contract |

Gaps 1-3 are engine changes (Step 2d). Gaps 4-6 are adapter-level (Step 2b). Gap 5 must land before gap 3's byte-parity test can run.

### Step 2d — Engine changes (three sub-steps, each its own commit, byte-parity gated)

**Gated by Step 1 sign-off.**

Engine work lands first so the adapter in Step 2b has a complete v1 surface to translate against. Each sub-step is a standalone commit with a byte-parity test against v2 output on a specific input before moving on.

**Standing rules for 2d:**
- Preserve v2's mathematical behavior exactly — no "improvements" during the port
- Each sub-step produces byte-identical output to v2 on at least one v2 regression fixture before commit
- LOCAL=1 regression passes after each commit (v1 13/13, v2 14/14 — v1 capabilities grow but v1 suite isn't extended until Step 3)

**Step 2d-1 — preSlab orchestrator branch (gap #1)**

`pricePreSlabTermidor(slabSqFt, volumeDiscount)` already exists at `server/services/pricing-engine/service-pricing.js:659`. Only the dispatch wiring is missing.

- Add `services.preSlab` branch to `server/services/pricing-engine/estimate-engine.js` `generateEstimate`
- Input shape: `{ slabSqFt, preslabWarranty }` (or match what v2 calcPreSlab reads from profile)
- Route to `pricePreSlabTermidor(slabSqFt, volumeDiscount)` with v2-matching volumeDiscount resolution
- Byte-parity gate: run against `preslab_2000sf_basic_warranty` fixture inputs; v1 output must match v2 output exactly before commit

Commit:
```
feat(pricing-v1): add preSlab dispatch branch to generateEstimate

Part of Session 11a v2 retirement (gap #1 of 6). pricePreSlabTermidor
was already present in service-pricing.js but unwired in the v1
orchestrator. Adds services.preSlab branch in estimate-engine.js.

Byte-parity verified against v2 on preslab_2000sf_basic_warranty
fixture inputs. No math change.
```

**Step 2d-2 — priceBedBug 'both' method + shape adaptation (gap #2)**

v2's calcBedbug returns a composite shape when method='both': `{name: 'Bed Bug', methods: [{method: 'heat', price, detail}, {method: 'chemical', price, detail}]}`. v1's `priceBedBug` handles single-method calls and returns a flat `{name, price, detail}`.

- Extend `priceBedBug(rooms, method, footprint)` at `server/services/pricing-engine/service-pricing.js:684` to accept 'both'
- When method='both', internally call the heat and chemical branches and return the v2 composite shape
- Single-method calls continue to return the flat shape — do not break existing v1 regression cases
- Byte-parity gate: run against `bedbug_3rooms_both_methods` fixture inputs; v1 output must match v2 output exactly before commit

Commit:
```
feat(pricing-v1): extend priceBedBug to support 'both' method

Part of Session 11a v2 retirement (gap #2 of 6). v2's calcBedbug
returns a composite {methods:[...]} shape when method='both'; v1's
priceBedBug previously only handled single-method calls.

Extends the function without changing single-method behavior.
Byte-parity verified against v2 on bedbug_3rooms_both_methods
fixture inputs.
```

**Step 2d-3 — priceRegularRoach (or priceGermanRoach roachType extension) (gap #3)**

v2's calcRoach REGULAR branch formula: `max(150, pestResult.perApp × 1.15 × 1.30)`. This is recurring-pest-per-app-dependent — the orchestrator must compute pest first when roachType='REGULAR', then feed pest's perApp into the roach price.

Implementation choice (either is acceptable; use the one that keeps v1 modular style cleanest):
- Option A: new `priceRegularRoach(pestPerApp)` function in service-pricing.js, called from a new roachType branch in `services.germanRoach` dispatch
- Option B: extend `priceGermanRoach(property)` to accept a roachType param and dispatch internally

Orchestration note: `estimate-engine.js` must sequence pest pricing BEFORE regular roach when roachType='REGULAR', then pass pest.perApp into the roach call. If pest isn't selected, v2's behavior at runtime for REGULAR-only quotes is a source-read item before porting — match v2 exactly.

**Byte-parity gate depends on Step 2b-2 completing first** (global options fan-out). REGULAR's output depends on pest.perApp which depends on urgency/afterHours/recurringCustomer being properly fanned out to the pest service. Do not run this sub-step's byte-parity test until 2b-2 lands.

Commit:
```
feat(pricing-v1): add ROACH REGULAR path with pest-perApp dependency

Part of Session 11a v2 retirement (gap #3 of 6). v2's calcRoach
REGULAR branch computes max(150, pestPerApp × 1.15 × 1.30) and
requires pest to be priced first. Adds the REGULAR path to v1 and
sequences pest-before-roach in generateEstimate when roachType='REGULAR'.

Byte-parity verified against v2 on <fixture_name> after Step 2b-2
landed the adapter-level global options fan-out.
```

**After all 2d commits, re-run LOCAL regression:**

```bash
LOCAL=1 npx jest server/tests/pricing-engine.regression.test.js
LOCAL=1 npx jest server/tests/pricing-engine-v2.regression.test.js
```

Both should still pass — v1 has new engine capabilities but v1 regression hasn't been extended yet, so v1 is still 13/13. v2 is still 14/14. No regressions introduced by engine additions.

### Step 2b — Adapter at property-lookup-v2.js:1094 (four sub-steps)

The adapter is the `POST /calculate-estimate` handler. It currently calls v2's `calculateEstimate(profile, selectedServices, options)` and runs the result through `v2-legacy-mapper.mapV2ToLegacyShape`. Session 11a replaces v2 with v1's `generateEstimate(input)` — adapter translates v2's call shape to v1's input shape and handles the three contract-level differences surfaced in Step 2a.

Adapter sub-steps can land as one commit or four — preference for smaller commits if any sub-step needs revision. Each sub-step is tested at HTTP against a real request payload before moving on.

**Step 2b-1 — v2 call-shape → v1 input-shape translation**

- v2 signature: `calculateEstimate(profile, selectedServices, options)` — three args
- v1 signature: `generateEstimate(input)` — single input object
- Adapter builds v1 input from profile + selectedServices + options; maps v2's `selectedServices` keys to v1's `services.{pest, lawn, ...}` structure

**Step 2b-2 — global urgency/afterHours/recurringCustomer fan-out (gap #5)**

- v2 applied `urgency`/`afterHours`/`recurringCustomer` as globals via `applyOT`
- v1 expects per-service `applyUrgency` at each service input
- Adapter fans global options out: writes `urgency`/`afterHours`/`recurringCustomer` into every `services.X` the quote includes
- **MUST land before Step 2d-3 byte-parity test** — REGULAR's formula depends on pest.perApp which in turn depends on these globals reaching the pest service

**Step 2b-3 — roachModifier='GERMAN' auto-fire → services.germanRoach + $100 initial (gap #4)**

- v2 reads `roachModifier='GERMAN'` from options and automatically fires the german roach service
- v1 has `services.germanRoach` but no auto-fire
- Adapter inspects `options.roachModifier`; if 'GERMAN', injects `services.germanRoach = {...}` into the v1 input, including the $100 initial one-time charge v2 attached
- Confirm the $100 initial by reading v2's calcRoach GERMAN branch before implementing (standing rule: verify code before documenting/porting)

**Step 2b-4 — manualDiscount handling (gap #6)**

- Decide between two implementations:
  - **Adapter post-process** (recommended if v1's current post-pipeline structure allows): compute v1 estimate, then apply manualDiscount to the final subtotal in the adapter before returning
  - **Engine-level**: add a `manualDiscount` field to v1 input shape and apply inside `generateEstimate`'s total-assembly step
- Preference is adapter post-process to keep v1 engine surface area stable; engine-level is acceptable if adapter-level causes rounding or ordering drift from v2

Commit pattern for 2b (one commit per sub-step, or one bundled commit if all land cleanly together):

```
refactor(property-lookup): swap v2 engine for v1 via adapter

Part of Session 11a v2 retirement. property-lookup-v2.js:1094
handler now calls v1 generateEstimate via an adapter that:
  - translates v2's (profile, selectedServices, options) call shape
    into v1's single-input shape (gap adapter-1)
  - fans global urgency/afterHours/recurringCustomer out to every
    selected service (gap #5)
  - auto-fires services.germanRoach when options.roachModifier='GERMAN'
    with the $100 initial one-time charge (gap #4)
  - applies manualDiscount at adapter post-process (gap #6)

v2-legacy-mapper still in place this commit — deletion happens
in Step 5 alongside v2 engine deletion.

Byte-parity verified against v2 on all 14 v2 regression fixtures
via HTTP.
```

**After Step 2b lands, re-run full regression:**

```bash
LOCAL=1 npx jest server/tests/pricing-engine.regression.test.js
LOCAL=1 npx jest server/tests/pricing-engine-v2.regression.test.js
PROD_URL=https://portal.wavespestcontrol.com ADMIN_TOKEN=$ADMIN_TOKEN npx jest server/tests/pricing-engine-v2.regression.test.js
```

v2 HTTP regression is the critical signal — it hits the `/calculate-estimate` route, which now internally runs v1 via the adapter. Byte-parity against v2's prior output confirms the adapter + v1 engine additions together reproduce v2's behavior.

**Sequencing note (critical):**

Step 2b-2 (global options fan-out) MUST precede any test of Step 2d-3 (ROACH REGULAR). REGULAR's byte-parity depends on pest.perApp which depends on urgency/afterHours/recurringCustomer reaching the pest service. Recommended order: 2d-1 → 2d-2 → 2b-1 → 2b-2 → 2d-3 → 2b-3 → 2b-4.

### Step 3 — Port v2 regression fixtures to v1 suite

Copy each fixture from `server/tests/pricing-engine-v2.regression.test.js` into `server/tests/pricing-engine.regression.test.js`, adapted to v1's input shape.

**Adaptation notes:**
- v2 uses different input shape for some fields (per v2-legacy-mapper.js); consult that file for the translation
- Expected output values come from the v2 baseline JSON — these become the v1 baseline for the ported case
- Case naming: prefix with `v1_ported_from_v2_` so origin is legible
- If a ported case fails because v1's ported function doesn't match v2's output, STOP — the Step 2 port has a bug, fix before proceeding

**After port:**

```bash
LOCAL=1 npx jest server/tests/pricing-engine.regression.test.js
```

Expected: v1 now has 13 + (number ported) cases, all pass. Capture new baseline:

```bash
CAPTURE_BASELINE=1 LOCAL=1 npx jest server/tests/pricing-engine.regression.test.js
```

Commit:

```
test(regression): port v2 fixtures to v1 suite

Part of Session 11a v2 retirement. Copies <N> regression fixtures
from pricing-engine-v2.regression.test.js into v1 suite, adapted
to v1 input shape. v1 suite now covers <specialties/one-time/etc>
previously only tested against v2.

v2 suite stays in place (HTTP-only post-delete) through 11b
validation window per Q6 decision.
```

### Step 4 — property-lookup-v2 rename (CONDITIONAL on Step 1 count)

**If Step 1c showed ≤10 callers:**

```bash
# Move the file
git mv server/routes/property-lookup-v2.js server/routes/property-lookup.js

# Update every caller
grep -rl "property-lookup-v2\|property_lookup_v2" \
  --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" \
  . | xargs sed -i 's/property-lookup-v2/property-lookup/g; s/property_lookup_v2/property_lookup/g'

# Verify no stragglers
grep -rn "property-lookup-v2\|property_lookup_v2" . 2>/dev/null
# Expected: no output (or only in .git/)
```

Commit:

```
refactor(routes): rename property-lookup-v2 to property-lookup

Part of Session 11a. The '-v2' suffix referred to the pricing
engine version, but property-lookup's RentCast+satellite+Claude
Vision enrichment is unrelated to pricing engine versioning.
With v2 pricing engine retiring in this session, the misleading
suffix retires too.

<N> caller updates. No behavioral change.
```

**If Step 1c showed >10 callers:** skip Step 4. Leave the rename for a future housekeeping session. Note the deferral in the changelog rationale.

### Step 5 — The deletion (v2 + v2-legacy-mapper)

This is the irreversible step. Before running, verify current state:

```bash
# Confirm all prior commits clean
git status
git log --oneline -10

# Re-run both regressions one more time — final pre-delete verify
LOCAL=1 npx jest server/tests/pricing-engine.regression.test.js
PROD_URL=https://portal.wavespestcontrol.com ADMIN_TOKEN=$ADMIN_TOKEN npx jest server/tests/pricing-engine.regression.test.js

# For the v2 suite — confirm it still passes BEFORE we delete v2
LOCAL=1 npx jest server/tests/pricing-engine-v2.regression.test.js
PROD_URL=https://portal.wavespestcontrol.com ADMIN_TOKEN=$ADMIN_TOKEN npx jest server/tests/pricing-engine-v2.regression.test.js
```

If anything fails, STOP. This is the last chance to catch regressions before v2 code is gone.

**Before the delete — create a safety tarball:**

```bash
tar czf ~/Downloads/waves-customer-portal-pre-v2-delete-$(date +%Y%m%d-%H%M%S).tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  /home/claude/waves4/waves-customer-portal
```

Filename includes `pre-v2-delete` for recoverability.

**Update v2 regression suite to be HTTP-only:**

The suite's `require('../services/pricing-engine-v2')` at module top will throw once v2 deletes. Fix before delete:

```javascript
// At top of pricing-engine-v2.regression.test.js, guard the require
let pricingEngineV2 = null;
if (!process.env.PROD_URL) {
  // LOCAL mode: v2 engine no longer exists post-Session-11a
  describe.skip('v2 LOCAL regression (post-Session-11a: HTTP-only)', () => {
    it('skipped: v2 engine retired, see Session 11a changelog id=12', () => {});
  });
  return;
}
// HTTP mode proceeds normally (calls prod routes, not v2 module directly)
```

Wait — actually, review whether the v2 regression suite actually imports the module or only hits HTTP. Inspect first:

```bash
grep -n "require\|import" server/tests/pricing-engine-v2.regression.test.js | head -10
```

If the suite only does HTTP calls (no direct module import), no code change needed — HTTP-only works automatically post-delete. If it imports the module for LOCAL mode, apply the skip guard above.

Commit the guard change separately BEFORE the delete commit:

```
test(v2-regression): HTTP-only skip guard for LOCAL mode

Session 11a prepares v2 retirement. Next commit deletes the v2
engine module; the v2 regression suite's LOCAL mode requires the
module to be present. This commit guards the LOCAL path to skip
cleanly when v2 is absent, preserving HTTP mode as the validation
signal during the 24-48h window between 11a and 11b.
```

**Then the delete commit:**

```bash
git rm server/services/pricing-engine-v2.js
git rm server/services/pricing-engine/v2-legacy-mapper.js

# Update every server-side import from Step 1b's inventory
# (handled one-by-one per the route/tool listing)
```

For each caller file from Inventory 1b:
- Change `require('../services/pricing-engine-v2')` → use v1 via `require('../services/pricing-engine')`
- Change function calls to match v1's API
- If v2 was called differently (e.g., direct function vs `calculateEstimate`), adapt

Commit:

```
feat(pricing): retire v2 monolith engine

Part of Session 11a. Deletes server/services/pricing-engine-v2.js
(<v2 line count> lines) and server/services/pricing-engine/v2-legacy-mapper.js.
Updates <N> server-side callers to use v1 modular engine via
server/services/pricing-engine/index.js.

v1 now covers all paths previously only in v2 (ported in earlier
commits this session). v2 regression suite remains active in
HTTP-only mode for the 24-48h validation window before Session 11b.

Client-side untouched this session — EstimatePage, EstimateViewPage,
and estimateEngine.js retire in Session 11b after validation.

Refs session-11-pre-canonical.md.
```

### Step 6 — Validation before push

```bash
# LOCAL regression — should pass on v1 (now with ported cases)
LOCAL=1 npx jest server/tests/pricing-engine.regression.test.js

# v2 LOCAL should skip cleanly
LOCAL=1 npx jest server/tests/pricing-engine-v2.regression.test.js

# HTTP regression — against CURRENT prod (still has v2 until we deploy)
PROD_URL=https://portal.wavespestcontrol.com ADMIN_TOKEN=$ADMIN_TOKEN npx jest server/tests/pricing-engine.regression.test.js
PROD_URL=https://portal.wavespestcontrol.com ADMIN_TOKEN=$ADMIN_TOKEN npx jest server/tests/pricing-engine-v2.regression.test.js
```

**Check-in point:** report all four results. Hold for my sign-off before push. This is the last gate before v2 goes away in prod.

### Step 7 — Push and Railway deploy

```bash
git push origin main
# Railway auto-deploys
```

Wait ~90 seconds for deploy to settle.

### Step 8 — Post-deploy HTTP regression

```bash
PROD_URL=https://portal.wavespestcontrol.com ADMIN_TOKEN=$ADMIN_TOKEN npx jest server/tests/pricing-engine.regression.test.js
PROD_URL=https://portal.wavespestcontrol.com ADMIN_TOKEN=$ADMIN_TOKEN npx jest server/tests/pricing-engine-v2.regression.test.js
```

**Expected:** both pass. v1 suite validates v1's full coverage including ported paths. v2 suite still passes because it's still hitting the same HTTP routes, but those routes now internally route to v1.

If v2 HTTP suite fails post-deploy, something about the v1 port isn't matching v2's output exactly. Investigate before changelog. Do NOT write the changelog while regression is red.

### Step 9 — Manual smoke test

Open the admin estimate page in a browser. Create a realistic estimate for a test customer (or a real one — just don't save/send). Confirm:
- Property lookup works (RentCast + satellite + Claude Vision)
- Pricing calculates correctly
- All service categories produce expected numbers
- WaveGuard tier computes correctly
- Nothing is obviously broken

If anything looks wrong, STOP and investigate. Virginia uses this page daily.

### Step 10 — Changelog id=12

```sql
BEGIN;

-- Pre-condition guards
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pricing_changelog WHERE id = 11) THEN
    RAISE EXCEPTION 'Pre-condition failed: id=11 missing (Session 10 should have landed).';
  END IF;
  IF EXISTS (SELECT 1 FROM pricing_changelog WHERE id = 12) THEN
    RAISE EXCEPTION 'Pre-condition failed: id=12 already exists.';
  END IF;
END $$;

-- Sequence-sync (Session 8.5 carry-forward)
SELECT setval(
  pg_get_serial_sequence('pricing_changelog', 'id'),
  (SELECT MAX(id) FROM pricing_changelog),
  true
);

INSERT INTO pricing_changelog (
  version_from, version_to, changed_by, category, summary,
  affected_services, before_value, after_value, rationale
) VALUES (
  'v4.2', 'v4.2',  -- v4.3 bump happens in 11b, NOT here
  'claude-code-session-11a',
  'infrastructure',
  'Session 11a: v2 backend engine retirement. Deleted pricing-engine-v2.js + v2-legacy-mapper.js. All v2-only paths ported into v1 modular engine. All server-side callers updated to v1. v2 regression suite runs HTTP-only through the 24-48h validation window before Session 11b.',
  '["v2_backend_retirement", "pricing_engine_v1_expansion"]'::jsonb,
  '<before_value JSONB>'::jsonb,
  '<after_value JSONB>'::jsonb,
  $RAT$<full rationale — see template below>$RAT$
);

-- Post-insert sanity
DO $$
DECLARE new_id integer;
BEGIN
  SELECT id INTO new_id FROM pricing_changelog WHERE changed_by = 'claude-code-session-11a' ORDER BY id DESC LIMIT 1;
  IF new_id <> 12 THEN RAISE EXCEPTION 'Post-insert sanity failed: expected id=12, got id=%', new_id; END IF;
END $$;

-- Verification
SELECT id, version_from, version_to, changed_by, category, summary FROM pricing_changelog WHERE id = 12;

COMMIT;
```

**Rationale content:**

- What 11a did (v2 deletion, port, caller updates, rename if happened)
- Why split from 11b (validation window rationale)
- Specific v2-only functions ported (enumerate)
- Specific callers updated (enumerate if reasonable, otherwise count + categorize)
- Whether property-lookup-v2 renamed (with caller count)
- v2 regression suite HTTP-only mode (with skip-guard commit)
- Commit SHAs for: prep commits, ports, rename (if done), skip guard, delete, caller updates
- 11b gating: 24-48h validation window begins on push; Virginia's daily use is the primary canary; 11b starts no earlier than [date+1 day]
- Trust floor references: Session 8.5 reconciled pricing_config, Session 10 restored LOCAL=1 correctness-gating, Session 11a lands against that foundation

**Show me the filled-in SQL before INSERT.** Standing rule — given today's track record of catching issues in final INSERTs, one more read-through is cheap insurance.

### Step 11 — Session 11a complete report

After changelog lands, emit closeout report:

- All commit SHAs
- Regression results (LOCAL + HTTP, pre and post deploy)
- Inventory results from Step 1 (v2-only functions, caller count for rename, HTTP-only v2 suite state)
- Tarball path
- Changelog id=12 confirmation
- Validation window start timestamp — this is when the 24-48h clock starts
- Next: HOLD. Do NOT start 11b. 11b canonical gets written after validation window completes.

---

## What to do if something unexpected happens

- **Step 0 regression fails at start:** state is not as expected. Halt, investigate what changed since Session 10 closeout.
- **Step 1 inventory surfaces more v2-only paths than expected (>10):** scope is bigger than planned. Report, don't plow through. Decide: split 11a further, or accept the larger scope.
- **Step 2 port produces non-byte-identical output:** the port has a bug. Don't ship approximation — fix until byte-identical or flag the specific case for halt.
- **Step 4 rename: caller count is ambiguous (e.g., includes .md docs):** prefer the conservative count (code callers only). 10+ code callers = punt rename.
- **Step 5 pre-delete regression fails:** DO NOT DELETE. Investigate the failure. If failure is in a ported case, the port is wrong. If failure is a pre-existing issue we missed, same action — don't proceed.
- **Step 6 post-delete LOCAL regression fails:** v1 is now missing coverage. Either the port was wrong (fix) or a caller update broke something (find it). Do NOT push until LOCAL is green.
- **Step 8 post-deploy HTTP regression fails:** v2 routes are still responding in prod but returning wrong values. Rollback via Railway's previous deployment while investigating. This is a customer-impact incident — treat with urgency.
- **Step 9 smoke test shows UI breakage:** EstimatePage is client-side and 11a shouldn't have touched it, but if it breaks because of a server-side route change, that's a caller-update bug from Step 5. Investigate.

## Validation window guidance (between 11a and 11b)

During the 24-48h window before 11b starts:

- Monitor HTTP regression runs periodically (once every 4-6 hours is fine) — any drift indicates v1 port has a subtle bug
- Virginia's daily use creates real quote volume — if she reports any "this number looks wrong" observation, investigate immediately
- DO NOT touch pricing code during the window — that invalidates the validation
- Ambient non-pricing work is fine (timezone migration, admin route edits, etc.)
- 11b starts only after window completes AND all signals green

---

Do not proceed to Session 11b. Await explicit sign-off.
