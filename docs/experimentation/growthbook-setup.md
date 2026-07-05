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
`customers`, `booking_intents` (the booking-abandon-recovery conversion
metric queries it).

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

Each metric returns `estimate_id` + a `timestamp`. **All column names below were
verified against the live prod schema (read-only) on 2026-07-05** and match the
metrics created in GrowthBook (`met_19g6rmr7kl1tp` accepted /
`met_19g6rmr7klxod` deposit / `met_19g6qmr7klxwz` self-booked /
`met_19g6rmr7klyc0` revenue). Set the metric **conversion window to "none"** —
the default 72h is shorter than the estimate follow-up cadence.

Schema facts that shaped these queries: `invoices` and `scheduled_services`
have **no `estimate_id` column** (join through `customer_id`);
`self_booked_appointments` **does** have `estimate_id`; the deposit paid signal
is `estimate_deposits.received_at IS NOT NULL` (statuses `received`/`credited`
both carry it).

**`Estimate Accepted`** — binomial, PRIMARY:
```sql
SELECT id AS estimate_id, accepted_at AS timestamp
FROM estimates
WHERE accepted_at IS NOT NULL
```

**`Estimate Deposit Paid`** — binomial (secondary):
```sql
SELECT estimate_id, received_at AS timestamp
FROM estimate_deposits
WHERE received_at IS NOT NULL
```

**`Self-Booked From Estimate`** — binomial (secondary):
```sql
SELECT estimate_id, created_at AS timestamp
FROM self_booked_appointments
WHERE estimate_id IS NOT NULL
```

**`Customer Invoice Revenue (post-estimate)`** — revenue (secondary,
**directional only**: invoices carry no estimate reference, so this attributes
ANY paid invoice of the estimate's customer after exposure):
```sql
SELECT e.id AS estimate_id, i.paid_at AS timestamp, i.total::float AS value
FROM invoices i
JOIN estimates e ON e.customer_id = i.customer_id
WHERE i.paid_at IS NOT NULL
```

## 4. Phase 1 experiment — estimate view v1 vs v2 (holdback)

**Why a holdback:** v2 (React "glass") already rolled out (`use_v2_view` default
`true` + backfilled), so there is no live v1 control. To *grade* the redesign we
hold a slice back to the legacy server-HTML renderer and compare.

Create a **boolean feature** `estimate-view-v2` (default `true` = React v2).
Add an **Experiment rule**:
- **Tracking key: MUST be `estimate-view`.** GrowthBook defaults a rule's
  tracking key to the *feature id* (`estimate-view-v2`) unless you set it. The
  server logs exposures and does sticky replay under the constant
  `estimate-view` (`ESTIMATE_VIEW_EXPERIMENT`), and the assignment query groups
  on it — a mismatch means exposures never line up with the analysis. (The
  server logs a warning if GrowthBook reports a different key.)
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

## 5. Phase 2 — booking-abandon recovery measured rollout

The first `GATE_*` migrated to a measured rollout. The GrowthBook feature
`booking-abandon-recovery` (boolean, default `true`) holds back a slice of
abandoners from BOTH recovery touches (SMS + email) so the program's true lift
on bookings is measurable.

**Mechanics** (`server/services/booking-abandon-recovery.js`):
- Unit = the abandoner's **phone last-10** (person-level — the same key the
  send-dedup uses), `unit_type='phone'` in `experiment_exposures`.
- Intent-to-treat: assigned at candidacy, before quiet-hours/reply-pause
  filters, so both arms measure from the same point. A held-back person gets
  neither touch (both stage flags claimed).
- Fail-open to SEND: gate off, missing/short phone, GrowthBook unreachable, or
  feature absent → today's behavior. `GATE_BOOKING_ABANDON_RECOVERY` remains
  the hard kill switch for the whole program.

**GrowthBook setup** (mirrors §2/§4, new unit):
1. Data source → add identifier type `phone` + a second assignment query
   (UI-only, like the first):
```sql
SELECT
  unit_id        AS phone,
  exposed_at     AS timestamp,
  experiment_key AS experiment_id,
  variation_id   AS variation_id
FROM experiment_exposures
WHERE unit_type = 'phone'
```
2. Metric **`Booking Intent Converted`** — binomial, identifier `phone`,
   window "none":
```sql
SELECT RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) AS phone,
       converted_at AS timestamp
FROM booking_intents
WHERE converted_at IS NOT NULL AND phone IS NOT NULL
```
3. Feature `booking-abandon-recovery` (boolean, default `true`) + experiment
   rule — **tracking key MUST be `booking-abandon-recovery`**, hash attribute
   `id`, variations `false` (held back) / `true` (recovery runs). Recommended
   split: **20% holdback / 80% treatment** — control forgoes real recovery
   touches, so keep it small.

## 6. Phase 2 — client-side React SDK

`client/src/lib/growthbook.js` + `GrowthBookProvider` in `App.jsx`. **Dark by
default**: without `VITE_GROWTHBOOK_CLIENT_KEY` at build time the instance is
null and nothing changes. To activate, set on the Railway client build:

| Var | Value |
|-----|-------|
| `VITE_GROWTHBOOK_CLIENT_KEY` | the same `sdk-…` client key (safe to embed) |
| `VITE_GROWTHBOOK_API_HOST` | optional, defaults to `https://cdn.growthbook.io` |

- Unit = anonymous visitor id (`waves_exp_uid` in localStorage), hashed on
  attribute `id`. Exposures POST to `POST /api/public/experiments/exposure`
  (gated by `GATE_GROWTHBOOK`, per-route rate limit, only live tracking keys
  accepted, `unit_type='anon'`).
- **Server-owned experiment keys (`estimate-view`, `booking-abandon-recovery`)
  are refused by that endpoint** — client exposures can never poison the
  server's sticky-replay rows.
- Client experiments need their own `anon` identifier type + assignment query
  (`WHERE unit_type = 'anon'`) in the data source when the first one ships.
- In components: `useFeatureIsOn('<feature>')` / `useFeatureValue('<feature>',
  fallback)` from `@growthbook/growthbook-react`.

## 7. Phase 3 (next)

- **Experiment #2 — glass theme on/off** (the live redesign question). `?glass=1`
  today (`EstimateViewPage.jsx`) is a client-side CSS layer *inside* v2. Turning
  it into a proper 50/50 experiment is the sanctioned way to launch it. Cleanest
  wiring keeps assignment server-side and passes it to the client via the
  existing `GET /:token/data` response (`experiment.glass`), so React just reads
  a field — no client GrowthBook SDK required for the decision.
- **Marketing (Astro)** — client-side GrowthBook JS SDK in an island, hashing on
  the existing PostHog cross-subdomain `distinct_id`, gated by `waves_consent`;
  POST exposures to a portal endpoint so they land in the same warehouse.
