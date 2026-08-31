# Call Extraction Eval Fixtures

Reviewed call fixtures are a lightweight replay set for the call recording
pipeline. They store call ids, expected routing shape, and the reason the call
matters. They do not store transcript text, customer names, phone numbers, or
addresses.

## Two layers per case

- `expect` — pass/fail routing assertions (auto-route held, flag present,
  scheduling status, …). Any failure fails the weekly run.
- `gold` — the per-field **answer key** added 2026-08-31: reviewer-confirmed
  values for the enum/boolean/date fields in `GOLD_FIELDS`
  (`server/scripts/replay-call-extraction-variance.js`). An array value means
  any of those values is correct. Every scored field feeds
  `summary.goldAccuracy` (overall + per field), which the weekly eval logs and
  includes in its regression email. Only `high`-severity fields
  (`is_voicemail`, `is_spam`, `call_nature`, `scheduling_status`,
  `agent_committed_booking`, `schedule_date`, `schedule_window_start`,
  `quote_promised`) fail the run on a miss; `medium`/`low` misses only lower
  the reported accuracy.

Rules for labeling:

- Gold values come from the reviewer's `reviewed_outcome` note (or an owner
  re-review), never from what the current model happens to output. If the note
  does not settle a field, leave it unlabeled — the fixture test rejects free
  text and unknown fields, and `GOLD_FIELDS` deliberately contains no
  name/phone/email/address keys, so PII cannot enter the answer key.
- To label a new field, read the candidate off the weekly `--jsonl` output:
  every result carries `current.fields` (the same redacted view), so the
  candidate sheet never needs transcript access.
- Set `gold_reviewed_at` when you add or change a case's gold block.

Comparing models: point `CALL_EXTRACTION_PROVIDER` / `CALL_EXTRACTION_MODEL`
at the challenger and run the manual command below — the per-field table is
the bake-off scorecard (the 2026-07-18 bake-off only had pass/fail).

Run the scheduled eval path against production data from inside the Railway
service:

```sh
node server/scripts/run-call-extraction-replay-eval.js --json
```

The production scheduler runs the same eval weekly on Monday at 3:40 AM ET
when `GATE_CALL_REPLAY_EVAL=true`. Repeated fixture/replay failures create one
admin `eval_regression` notification; a pass-on-retry is reported as flaky and
does not alert.

For raw per-call JSONL while debugging, run:

```sh
node server/scripts/replay-call-extraction-variance.js \
  --fixture=server/fixtures/call-extraction-eval/reviewed-calls.json \
  --jsonl
```

Use `--include-values` only for manual review when PII is appropriate.
