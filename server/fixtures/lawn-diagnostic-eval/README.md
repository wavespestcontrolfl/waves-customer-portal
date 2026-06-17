# Lawn Diagnostic — naming-gate eval fixtures

Live-model eval for the v0.4 **naming gate** in `server/services/lawn-diagnostic-prompt.js`:
a cause may be NAMED only when its minimum-evidence signature is visible; otherwise the
finding must stay a SYMPTOM at low/unknown confidence, and the customer summary may never
upgrade a symptom into a named pest/disease.

## What's here
- `cases.json` — the case taxonomy (expected behavior per scenario). **Committed.**
- `photos/` — the real lawn photos each case runs on. **NOT committed** (see `.gitignore`).

A case whose photo files are missing is reported as **skipped**, so the harness runs today
and grows as you add photos.

## Adding a case's photos
1. Look up the case in `cases.json` and its `photos: [...]` filenames.
2. Drop matching image files into `photos/` (jpg/png/webp/heic). Use real field photos that
   genuinely exercise the scenario — e.g. for `chinch-edge-no-closeup`, a *wide* edge shot
   with **no** blade close-up; for `chinch-edge-with-closeup`, add the close-up too.
3. Re-run the eval (below). The case flips from `skipped` to `pass` / `fail` / `flaky`.

Keep photos free of people, plates, house numbers, or anything identifying — the lawn only.

## Running
```
# needs ANTHROPIC_API_KEY in the environment (it calls the live model — costs tokens)
node server/scripts/run-lawn-diagnostic-eval.js            # readable table
node server/scripts/run-lawn-diagnostic-eval.js --json     # machine-readable
node server/scripts/run-lawn-diagnostic-eval.js --case chinch-edge-no-closeup
```
Exit code is non-zero when the scored pass-rate falls below the threshold (default 0.9),
so this can later gate a manual pre-release check or a weekly cron.

## How scoring works
Per case, `runDiagnosis` is called on the photos and its findings are scored against
`expect` (e.g. `forbidNamedCause`, `maxConfidence`, `expectSymptomPrimary`,
`requireConfirmationStep`, `forbidBrandsInWording`). If the case has a `narrative` block,
the assembled contract is run through `runNarrative` and the `customer_summary` is scored
too. Model output is non-deterministic, so a failing case is retried once; **pass-on-retry
is reported as `flaky`, not a failure.** The pure scorers are unit-tested in
`server/tests/lawn-diagnostic-naming-gate-eval.test.js` (no API, runs in CI).
