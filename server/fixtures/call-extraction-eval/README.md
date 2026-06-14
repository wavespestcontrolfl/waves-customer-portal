# Call Extraction Eval Fixtures

Reviewed call fixtures are a lightweight replay set for the call recording
pipeline. They store call ids, expected routing shape, and the reason the call
matters. They do not store transcript text, customer names, phone numbers, or
addresses.

Run against production data from inside the Railway service:

```sh
node server/scripts/replay-call-extraction-variance.js \
  --fixture=server/fixtures/call-extraction-eval/reviewed-calls.json \
  --jsonl
```

Use `--include-values` only for manual review when PII is appropriate.
