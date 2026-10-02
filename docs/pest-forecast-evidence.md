# Public pest forecast evidence

The public forecast is a seasonal/weather model. A score above the monthly
baseline does not mean pest activity increased this week. The API, embed and
pest/mosquito report cards distinguish these comparisons:

- `baseline_comparison`: above, below or near the monthly seasonal baseline.
- `week_over_week`: a modeled-score comparison with a saved forecast exactly
  seven ET calendar days earlier. Null means unavailable, never unchanged.
- `evidence.observation_validation: not_validated`: field accuracy has not
  been established. No sample count or evaluation result automatically changes
  that status or promotes public claims.

The legacy `trend` field retains its seasonal meaning for external consumers.
Owned consumers no longer render it as an observed-activity arrow. Actual
technician/customer activity trends elsewhere in service reports are separate.
The mosquito report mounts its outlook card. The retained pest seasonal-card
component remains unmounted in the current report layout, as previously decided.

## Collection and rollout

Apply migration `20261002190000_pest_forecast_snapshots` in an isolated preview
first. `GATE_PEST_FORECAST_HISTORY` opts in everywhere; the scheduler also needs
the existing `cronJobs` gate. No production migration or gate activation is
part of local verification.

Roll out the portal/API correction and the companion website embed/page copy
together. The history gate can stay off while the immediate wording fix ships;
both consumers tolerate legacy payloads during that transition.

The existing scheduler captures curated cities and the default Southwest Florida region
at 08:15 ET, with a 14:15 retry
for weather/DB gaps. Unique city/date/model keys preserve the first successful
prediction. Weather outages do not become history. A model-version change
starts a new comparable series; bump `MODEL_VERSION` when scoring, weather
interpretation or location coordinates change. Historical weather is never
reconstructed to pretend a prediction was captured earlier.

Public GETs only read history, under a 750 ms overall timeout. Expired pool
acquisitions are removed before returning; in-flight reads use the remaining
query budget and keep their connection until query cancellation finishes. Missing migration,
missing dates, a model/location mismatch, or changed weather-data coverage
leave the temporal comparison unavailable. Seven days of actual collection
must elapse before the first comparison is possible. The immediate baseline
wording correction does not depend on the history gate.

## Observation evaluation

`server/scripts/evaluate-pest-forecast.js` produces an aggregate, read-only
evaluation. It consumes completed, technician-attributed cockroach forms
with an exact German or American species selection and explicit "Live roaches"
evidence, including customer-visible cockroach sections on combined visits.
Internal-only companion sections remain excluded. It also supports legacy
one-time pest forms with one exact controlled pest choice and explicit
live-pest/active-trail evidence; that general form was
retired for new completions in July 2026. Generic pest visits do not provide
the species-specific evidence this evaluator requires and remain excluded.
Eligibility is evaluated per supported form section. Each eligible section
contributes an observation; the existing customer/city/pest/week rule collapses
the same sighting across visit sections. A multi-pest combined visit can make
`eligibleObservations` exceed `recordsReviewed`. Exclusions count records only
when none of their supported sections supplies an eligible observation.
It rejects ambiguous identity, customer-only reports, no-activity
findings, AI identification outputs and free-text guesses. The serviced city
comes from frozen report identity (or the visit's stamped address if no frozen
address exists), never the customer's current address or a ZIP approximation.
The mapping is versioned as `typed-live-pest-v1`; other form families remain
outside coverage until their evidence mapping is reviewed.

Only a forecast saved before the observation day, at most seven days earlier,
is eligible. The first customer/city/pest observation per ET week counts once,
so repeat callbacks do not inflate the sample. Output includes exclusions,
missing-history coverage, per-city/pest sample counts, mean model/baseline
scores and tied-average ranks. It emits no customer, technician, address or
service-record identifiers.

For an approved fixture/export containing `{ "records": [], "forecasts": [] }`:

```sh
node server/scripts/evaluate-pest-forecast.js --input /path/to/export.json
```

For an explicitly selected, authorized database, set
`PEST_FORECAST_EVAL_DATABASE_URL` and pass `--from YYYY-MM-DD --to YYYY-MM-DD`
(past range, at most 90 days). The script uses a READ ONLY transaction and
gives both source reads a five-second transaction-local statement timeout. It
does not load an application `.env` or default to `DATABASE_URL`. Keep input
exports private; only the aggregate result is intended for review.

These observations are a positive service-call sample, not independently
adjudicated biological truth or a random survey. They can assess how the
model ranked pests subsequently recorded on visits. They cannot establish
population accuracy, false-positive rate or probability calibration. A future
accuracy claim needs a reviewed sample including explicit inspected negatives,
adequate city/pest coverage and a temporal holdout. Do not infer negatives
from missing observations or promote claims based on training-set fit.

## Verification

Unit tests cover baseline-versus-time semantics, exact-date/model/city matching,
outages, gate changes, observation provenance, no future-data leakage and
repeat-visit deduplication, plus bounded reads during pool exhaustion.
`pest-forecast-history-postgres.test.js` applies the migration in a random
isolated schema, exercises concurrent immutable saves, date/JSON reads, the
overall read timeout, cancellation of exhausted-pool and blocked SQL reads,
and the read-only evaluation query. It requires the explicit
`PEST_FORECAST_TEST_DATABASE_URL`; the CI PostgreSQL job runs it. A skipped
suite is not migration/DB verification.

Local verification on 2026-10-02: 170 backend unit/regression checks, five
PostgreSQL integration checks in a disposable local PostgreSQL 16 cluster,
101 React comparison/report checks and four standalone embed checks passed. The
local cluster contained only test fixtures and was stopped afterward. This
does not validate real-world prediction accuracy. The expanded five-test
PostgreSQL suite also passed against Railway codex-dev PostgreSQL 16.15,
including queued-acquisition cleanup and blocked-query cancellation. No extra
test schemas remained. Railway PR preview migration and deployment succeeded.

The parent portal change (`b0171d5484`) deployed successfully on 2026-10-02,
and migration batch 1160 ran once. Both `cronJobs` and
`GATE_PEST_FORECAST_HISTORY` are enabled at runtime. Live default-location,
named-city and invalid-location API probes returned HTTP 200 with the new
evidence/comparison fields and `week_over_week: null`, as expected before
history exists. The first scheduled capture is 08:15 ET; this rollout receipt
does not claim that capture has already occurred. Verification used deployment
and live API evidence without direct production database access.

The portal production build and domain-rule checks passed. The companion
Astro worktree completed its production build (686 pages), article publishing
validation, rendered-blog validation and meta-description checks. Its embed
regressions now run in the website CI workflow.

The live mosquito outlook was rendered with synthetic report data and external
requests blocked at 1440px and 390px. Both screenshots were visually inspected:
baseline text is readable, cards retain their layout, and neither viewport has
horizontal overflow or JavaScript errors. Local artifacts:
`/tmp/forecast-ui-verification/mosquito-1440.png` and
`/tmp/forecast-ui-verification/mosquito-390.png`.
