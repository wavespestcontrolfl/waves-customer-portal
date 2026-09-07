# Lawn material audit

`audit:waveguard-materials` reads the active product catalog and aliases and
reconciles them with the existing `protocols.json` lawn programs. It writes no
catalog data, budgets, customer prices or generated pricing tables.

This is a reference/catalog diagnostic. It does not read or reconcile the
database-owned `lawn_protocol_windows` and `lawn_protocol_products` operating
layer. `operatingLayerVerified` is always `false`; a complete reference
calculation is not a complete field-execution cost reconciliation.

Use the dedicated development/preview database setup in [Development and
QA](development.md). For a local agent run, launch with the managed environment
so the checkout's legacy `.env` and inherited provider credentials stay excluded:

```sh
node - <<'NODE'
const { spawnSync } = require('node:child_process');
const { readContext, childEnvironment } = require('./scripts/dev/context');
const result = spawnSync(process.execPath, [
  'server/scripts/audit-waveguard-protocol-material-costs.js', '--cadences', '--json',
], { env: childEnvironment(readContext(), { database: true }), stdio: 'inherit' });
process.exit(result.status ?? 1);
NODE
```

For an already isolated development environment, the equivalent command is
`npm run audit:waveguard-materials -- --cadences --json`. Omit `--json` for a
console table; omit `--cadences` for the existing per-window comparison.

## Reading the cadence report

The report uses the shared 4,500-sqft reference and the sold 6/9/12 application
counts. Standard maps to bronze protocol flags, enhanced to enhanced, and premium
to premium. It averages the flagged windows and multiplies by the sold count;
this allowance normalization does not select or validate a treatment calendar.

| Field | Meaning |
| --- | --- |
| `currentAnnualBudget` | Repository allowance from `@waves/lawn-cost-floor`; deployed pricing overrides are not verified. |
| `reconstructedStaticAnnualAllowance` | Protocol scheduled-material allowances scaled from 10,000 sqft, plus the conditional reserve already at the 4,500-sqft reference, normalized to the sold count. Missing allowances remain `null`. |
| `catalogSelectedSubtotal` | Available catalog-derived costs under first-year, normal-weed-pressure selection. Retained even when evidence is incomplete. |
| `catalogSelectedAnnual` | The selected subtotal only when no calculation issues remain; otherwise `null`. |
| `issues` | Unmatched products, unresolved combined-product lines, missing rates or positive costs, unresolved pricing, missing inventory prices, unverifiable units, missing static allowances, or missing calendar flags. |

Premium-only eligibility and conditional selection use the existing plan engine.
Unselected rescue work is excluded from the catalog subtotal, so it is not the
same scope as the static allowance, which includes conditional reserves.
The matcher resolves one product per reference line. Selected lines joining
materials with `+` remain incomplete until the ingredients are independently
resolved; numeric annotations such as `(FRAC 11+3)` and plus signs inside the
matched product's canonical name or alias do not trigger that issue.

Plain `oz` stays ambiguous. Explicit `fl_oz` is recognized as volume; weight and
volume families must agree between the application and its selected cost source.
Application and per-unit cost strings must also be supported by the cost engine's
unit converter; a recognizable package description such as `lb bag` is not a
convertible per-unit cost string.
This check does not establish purchased-package identity or supplier freshness.
The report always states `supplierCostsVerified: false`.

In cadence mode, exit status **2** means at least one calculation is incomplete,
**1** means execution failed, and **0** means no calculation issues were found.
Status 0 does not validate supplier prices, pesticide rates, calendar suitability,
operating-layer parity, field consumption, travel/labor timing or profitability. Complete those checks
before using the output to propose new prices. The legacy per-window mode retains
its reporting-only exit behavior.
