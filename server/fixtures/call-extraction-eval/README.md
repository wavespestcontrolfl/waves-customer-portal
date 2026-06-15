# Call Extraction Eval Fixtures

Reviewed call fixtures are a lightweight replay set for the call recording
pipeline. They store call ids, expected routing shape, and the reason the call
matters. They do not store transcript text, customer names, phone numbers, or
addresses.

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
