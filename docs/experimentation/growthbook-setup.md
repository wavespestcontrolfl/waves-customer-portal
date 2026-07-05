# GrowthBook experimentation — setup & runbook

Phase 0 (foundation) + Phase 1 (first experiment) of the A/B-testing initiative.
GrowthBook is **warehouse-native**: it stores no events. It evaluates feature-flag
experiments locally (a deterministic hash) and computes lift by querying **our
Postgres** — the `experiment_exposures` table (who saw what) joined to the
existing conversion tables (`estimates`, `estimate_deposits`, `invoices`, …).

Everything ships **dark**. Nothing calls GrowthBook until `GATE_GROWTHBOOK=true`
AND `GROWTHBOOK_CLIENT_KEY` is set AND an experiment exists in GrowthBook. With
the gate off, every code path is byte-identical to pre-experiment behavior.

---

## 0. Key hygiene (read first)

- **`secret_admin_…`** is the GrowthBook **management/admin** secret. It is NOT
  used at runtime. Keep it out of the repo and out of any client bundle; use it
  only for provisioning via the API / Terraform, from a server-side secret store.
  It was shared in plaintext once — rotate or scope it (Settings → API Keys).
- **`sdk-…`** (an **SDK Connection Client Key**) is what runtime uses. This is
  what goes in `GROWTHBOOK_CLIENT_KEY`. Create an **unencrypted** SDK Connection
  (server-side eval reads plaintext `/api/features`).

## 1. Runtime env (Railway — portal server)

| Var | Value | Notes |
|-----|-------|-------|
| `GATE_GROWTHBOOK` | `true` to activate | Fail-closed master gate. Rollback = unset. |
| `GROWTHBOOK_CLIENT_KEY` | `sdk-…` | From the **unencrypted** SDK Connection. |
| `GROWTHBOOK_API_HOST` | `https://cdn.growthbook.io` | Default (GrowthBook Cloud). Override for self-host. |

## 2. Connect Postgres as the GrowthBook data source

GrowthBook → **Metrics and Data → Data Sources → Add → Postgres**. Use a
**read-only** role (mirror the prod-read pattern in the `waves-db` skill — the
public endpoint from the *Postgres* service, never `DATABASE_URL` in the shell).
Grant `SELECT` on `experiment_exposures`, `estimates`, `estimate_deposits`,
`invoices`, `payments`, `scheduled_services`, `self_booked_appointments`,
`customers`.

### Identifier type + Experiment Assignment Query

Add one identifier type `estimate_id`, and this assignment query. **`estimates.id`
is a UUID** (migration `20260401000013_admin_layer.js`), and `logExposure` stores
it as text in `unit_id`, so cast back to `uuid` (NOT bigint) to match the metric
queries below (which return the native `estimates.id` uuid):

```sql
SELECT
  unit_id::uuid  AS estimate_id,
  exposed_at     AS timestamp,
  experiment_key AS experiment_id,
  variation_id   AS variation_id
FROM experiment_exposures
WHERE unit_type = 'estimate'
```

`experiment_exposures` keeps ONE row per (experiment, unit) — first exposure
wins (matches GrowthBook's analysis default).

## 3. Metrics (SQL)

Each metric returns `estimate_id` + a `timestamp`. **Primary is solid; verify
the secondary column names against the live schema (read-only) before saving —
per the repo's "test your SQL" rule.**

**`estimate_accepted`** — binomial, PRIMARY:
```sql
SELECT id AS estimate_id, accepted_at AS timestamp
FROM estimates
WHERE accepted_at IS NOT NULL
```

**`estimate_deposit_paid`** — binomial (secondary; confirm the paid signal):
```sql
-- VERIFY: estimate_deposits paid indicator (ledger has deposit_credit mechanics)
SELECT estimate_id, created_at AS timestamp
FROM estimate_deposits
-- WHERE <paid condition>
```

**`booking_created`** — binomial (secondary; confirm the estimate→booking link):
```sql
-- VERIFY: how a booking references its estimate (estimate_id FK vs accept flow)
SELECT estimate_id, created_at AS timestamp
FROM scheduled_services
WHERE estimate_id IS NOT NULL
```

**`invoice_paid_revenue`** — revenue/mean (secondary; confirm estimate linkage):
```sql
-- VERIFY: invoices→estimate join (direct estimate_id, or via customer_id)
SELECT i.estimate_id, i.paid_at AS timestamp, i.amount_cents / 100.0 AS value
FROM invoices i
WHERE i.paid_at IS NOT NULL
```

**Guardrail** — `estimate_question_asked` (make sure the holdback control isn't
just confusing people into asking more questions). Confirm the events table.

## 4. Phase 1 experiment — estimate view v1 vs v2 (holdback)

**Why a holdback:** v2 (React "glass") already rolled out (`use_v2_view` default
`true` + backfilled), so there is no live v1 control. To *grade* the redesign we
hold a slice back to the legacy server-HTML renderer and compare.

Create a **boolean feature** `estimate-view-v2` (default `true` = React v2).
Add an **Experiment rule**:
- Hash attribute: `id` (the server sets `attributes.id = estimate.id`).
- Variations: `false` (legacy v1 control) / `true` (React v2 treatment).
- Split: start conservative, e.g. **10% control / 90% treatment** (or 50/50 for
  a faster read — owner's call; the control sees the old-but-fully-functional
  page).
- Metrics: primary `estimate_accepted`; secondary deposit/booking/revenue;
  guardrail as above.

**No targeting needed in GrowthBook** — the server only calls GrowthBook for the
eligible population (published, v2-by-default, not invoice/card-hold-forced, real
customer view). Forced-React and explicitly-v1 estimates never reach it.

### Activation checklist
1. Set the three env vars (§1) on the portal server. Deploy.
2. Confirm the SDK Connection is **unencrypted**; confirm `/api/features/<key>`
   returns plaintext (the service fails open to control on encrypted payloads).
3. Create the `estimate-view-v2` feature + experiment rule; start the experiment.
4. Open a real (published, non-invoice) estimate a few times from different
   devices → confirm rows land in `experiment_exposures`.
5. Watch acceptance in GrowthBook. **Rollback at any time = unset
   `GATE_GROWTHBOOK`** (instant return to 100% v2, no deploy needed if you can
   flip env + restart).

## 5. Phase 2/3 (next)

- **Experiment #2 — glass theme on/off** (the live redesign question). `?glass=1`
  today (`EstimateViewPage.jsx`) is a client-side CSS layer *inside* v2. Turning
  it into a proper 50/50 experiment is the sanctioned way to launch it. Cleanest
  wiring keeps assignment server-side and passes it to the client via the
  existing `GET /:token/data` response (`experiment.glass`), so React just reads
  a field — no client GrowthBook SDK required for the decision.
- **Gates → measured rollouts** — migrate one `GATE_*` (e.g. self-booking) to a
  GrowthBook feature with a % rollout + a linked metric; keep the env gate as the
  kill-switch backstop.
- **Marketing (Astro)** — client-side GrowthBook JS SDK in an island, hashing on
  the existing PostHog cross-subdomain `distinct_id`, gated by `waves_consent`;
  POST exposures to a portal endpoint so they land in the same warehouse.
