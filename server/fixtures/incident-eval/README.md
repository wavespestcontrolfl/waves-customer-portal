# Incident eval corpus

Every confirmed incident in an LLM-backed component becomes a **permanent
replay case** here. The weekly cron (`incident-regression-eval`, Monday
3:20 AM ET in `server/services/scheduler.js`) replays each case through the
LIVE model and raises an admin notification on regression. Manual run:

```
node server/scripts/run-incident-eval.js            # human-readable
node server/scripts/run-incident-eval.js --json     # CI/scripting
node server/scripts/run-incident-eval.js --suite=fact-check
```

## Why live-model replay when jest already covers these

The jest tests (`fact-check-gate.test.js`,
`email-operational-sender-guard.test.js`) mock the model — they lock the code
contract and run on every PR. They cannot see the failure class that caused
both seed incidents: the **model side** moving (prompt edits, model upgrades
via `MODEL_FACTCHECK`/`MODEL_FLAGSHIP` env, provider-side drift) while the
code stays green. The fact-check gate fails open by design and the inbox
agent just takes a different switch branch, so model drift is silent until it
ships a bad post or eats real mail.

## Suites

| File | Replays | Seed incident |
|---|---|---|
| `fact-check.json` | `fact-check-gate.evaluate()` with the real publish-path inputs | 2026-06-11: gate P1-blocked the corrected Venice dollar-spot post → P0-only recalibration (PR #1561); original draft had the reversed *Clarireedia* species Codex caught (PR #212) |
| `inbox.json` | `classifyEmailContent()` + derived auto-action via `shouldSkipAutoAction()` — never executes actions | 2026-05-25→06-11: agent archived + one-click-unsubscribed Waves' own newsletters, enrolling contact@ in SendGrid suppression (PR #1654) |

## Case rules

- **Never delete a case.** Cases encode incidents; removing one un-learns it.
  If a case becomes wrong because the *intended* behavior changed, update its
  `expect` and say why in `incident`.
- **Synthetic data only** in `inbox.json` emails — no real customer names,
  addresses, or phone numbers.
- `expect` fields:
  - fact-check: `{ "pass": true|false }` — must the gate let it through?
  - inbox: `{ "category_any": [..] }` and/or `{ "no_destructive_action": true|false }`
    (destructive = spam/marketing_newsletter action that the operational-sender
    guard would not skip).
- LLM verdicts are non-deterministic: the runner retries a failing case once,
  so write cases the model should get right **twice in a row**. Don't add
  borderline cases — they train everyone to ignore the alert.

## Adding a case after an incident

1. Reproduce the incident input as faithfully as possible (real post body,
   real email shape — synthesized PII).
2. Add the case with an `incident` field that says what happened, when, and
   which PR fixed it.
3. Run `node server/scripts/run-incident-eval.js` and confirm the new case
   passes against the fixed behavior.
4. If the component also gained a code-level guard, add/extend the jest test
   too — jest locks the code, this corpus watches the model.
