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

## Verification

Unit tests cover baseline-versus-time semantics, exact-date/model/city matching,
outages, gate changes and bounded reads during pool exhaustion. `pest-forecast-history-postgres.test.js` applies the
migration in a random isolated schema, exercises concurrent immutable saves,
date/JSON reads, cancellation of exhausted-pool reads, and blocked SQL cleanup. It requires the explicit
`PEST_FORECAST_TEST_DATABASE_URL`; the CI PostgreSQL job runs it. A skipped
suite is not migration/DB verification.

Local verification on 2026-10-02: 146 backend unit/regression checks, three
initial PostgreSQL integration checks in a disposable local PostgreSQL 16 cluster,
101 React comparison/report checks and four standalone embed checks passed. The
local cluster contained only test fixtures and was stopped afterward. This
does not validate real-world prediction accuracy. The expanded four-test
PostgreSQL suite also passed against Railway codex-dev PostgreSQL 16.15,
including queued-acquisition cleanup and blocked-query cancellation. No extra
test schemas remained. Railway PR preview migration and deployment succeeded;
production rollout remains a separate step.

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
