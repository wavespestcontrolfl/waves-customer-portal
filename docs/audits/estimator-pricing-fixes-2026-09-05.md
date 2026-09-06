# Estimator pricing audit fixes — September 5, 2026

Implementation worktree: `/Users/wavespestcontrol/wt-estimator-pricing-correctness`.
Branch: `fix/estimator-pricing-correctness`, based on `a2bb0bc49b9f6a1ebb776af29ee58a3d1439c9cf`.
User authorization: “ok go” following the full estimator audit. The subsequent instruction “create a pr and tag codex” authorizes publishing the branch for review. No merge, deployment, production DB connection, customer communication or money movement is part of this change. The original workspace's unrelated changes remain intact.

## Implemented

- Invalid monetary results are rejected before discounts and mapping. Invalid turf area/spacing, stinging tiers and one-time lawn treatment keys return pricing validation errors. The engine also rejects nonfinite results from retained specialty calculators.
- One-time lawn validation preserves the `fertilizer` token produced by the call intent schema and lead mapper by normalizing it to `fert`. `estimator-pricing-correctness.test.js` feeds the schema's treatment enum and the lead mapper's fertilization output through the real pricing engine, guarding producer/validator compatibility.
- Pricing validation errors use the existing `failClosed` mechanism, so the authoritative save path cannot persist a client-supplied price after the engine rejects the calculation. Other existing engine-error behavior is unchanged.
- Numeric-nine Tree & Shrub fields use the existing service-specific cadence resolver for 42-day followups and annual-prepay coverage. Contradictory fields/counts refuse coverage. Count-only legacy T&S remains office-scheduled; inconsistent count-only nine prepay is rejected. Mosquito's seasonal calendar and generic numeric cadence inference remain intact.
- Large-sanitation scope advisories now survive mapping via existing review reasons/warnings. The current over-50-cu-ft threshold and quoted amounts are preserved.
- TreeAge annualized values retain cents on new estimates. An example three-palm event stays $255; its annualized amount is $127.50. Saved pre-fix quotes retain their $128 annual basis. The existing shared replay mechanism derives the rounding mode from saved output; new saves strip input-claimed rounding modes. Both raw and mapped historical shapes are tested. Removal/restore reuses the server-recorded removal provenance, including pre-stamp events, so removing the palm result cannot erase its historical rounding basis. Repeated remove/restore cycles cover historical and cent-preserving quotes. This is a calculation correction, not a table/configuration reprice.
- Raw engine year-one and year-two summary totals retain cents rather than rounding to whole dollars, so the palm example agrees across raw output, quick quotes and mapped totals.
- Pricing age modifiers now read the Eastern calendar year.
- Trap-only retainers carry staff-review reasons for the payment schedule and monitoring appointments. This is an explicit limitation marker, **not automatic retainer billing or scheduling**; current quoted first charges are preserved.
- A legacy rodent combo advertising more stations than its priced bracket allowance carries a scope-review reason. This does not invent an extra-station charge or alter existing package prices.
- The existing independent audit now expects cent-preserving palm annualization and correctly distinguishes intentional property-only palm replay from current service-line palm reserves.

## Verification

- 25 Jest suites, **740 passed, zero failures/skips**, clean exit. Includes the pricing-engine family, new correctness/cadence regressions, per-application billing, saved-price replay, and authoritative save/persistence tests. Seven summary-only expectations in each baseline now equal their independently recorded recurring annual amounts; line prices, discounts and other baseline values were not regenerated.
- Full synthetic sweep: **115 baseline variants, 2,001 scenarios, zero nonfinite quote outputs**. Outcomes: 1,858 returned, 113 validation throws, 30 intentional/no-line outcomes. Every fully specified baseline still returns. The only baseline line-item monetary change is the intended new TreeAge annualization; historical rounding replay is tested separately.
- Independent calculator: **1,844 rows, 1,783 matches, 61 engine-only observations, zero mismatches or missing expected prices**, exit 0. One stale invariant finding no longer creates a discrepancy row. Its remaining P2 input/model observations are not claimed resolved.
- `check:domain-rules`: clean, 1,925 files scanned.
- ESLint: zero errors; legacy warnings remain in the large existing modules. No new dependencies or UI files changed.
- `git diff --check`: clean.
- Fertilizer compatibility regression: the schema and lead-mapper cases reproduced the validation failure before the fix; six suites / 1,226 tests passed afterward, including estimator-engine, lead automation, authoritative save and both independent golden suites. Domain checks passed. These checks used the unchanged lockfile's installed dependencies from an existing isolated checkout, with production DB variables unset.

Commands:

```sh
env -u DATABASE_URL -u PROD_URL LOCAL=1 node_modules/.bin/jest --rootDir server --runInBand --silent --json --outputFile /tmp/waves-pricing-final-jest.json 'tests/pricing-engine' tests/estimator-pricing-correctness.test.js tests/estimate-tree-shrub-numeric-cadence.test.js tests/estimate-server-authoritative-pricing.test.js tests/admin-estimate-persistence.test.js tests/per-application-billing.test.js tests/estimate-floor-signal-replay.test.js tests/estimate-service-opt-out.test.js tests/estimate-service-opt-out-round1.test.js
node scripts/audit-estimator-pricing.js --json /tmp/waves-pricing-fixed-independent.json --md /tmp/waves-pricing-fixed-independent.md
node scripts/check-domain-rules.js
```

No DB integration, migrations, rendered-page verification or payment lifecycle verification was performed. The production-mirroring `seed:pricing` command was not run because AGENTS.md prohibits this session from connecting to production. Tests use in-code defaults and mocked persistence; deployed DB overrides remain unverified.

## Outstanding work and next step

1. **Lawn economic redesign:** the audit's $68.40/$64.80/$62.10 Silver candidate is not a full-grid profitability fix. Approved material-cost and typical travel-time inputs are still needed before finalizing a replacement grid. The owner has been asked for these inputs. No lawn table, discount, fee or DB configuration has changed; floors remain disarmed.
2. **Retainer lifecycle:** define and implement the actual monthly agreement, consented billing, monitoring schedule and renewal behavior through the existing billing/scheduling mechanisms. Review metadata does not solve this architecture gap. Current first-charge fields must not be repurposed as the annual amount collected at acceptance.
3. **Broader costs and fallback inputs:** actual material units, field/drive time, callback costs, live overrides and producer-specific handling of missing measurements remain as qualified in the audit. No assumed supplier costs were substituted for evidence.
4. **Release:** review this local change before an authorized merge/deploy. Validate saved-quote replay and relevant DB/payment interactions in dev/preview before claiming operational verification.
