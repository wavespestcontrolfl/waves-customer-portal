# Future-only gratitude SMS replies

This feature ships disabled. Review and disabled deployment are authorized;
activation, historical backfill, and customer communication are excluded.
A future launch is a separate operation.

The new `gratitude_reply` intent recognizes short, standalone thanks, including
known spelling variants. The agent drafts using the existing context and verifier.
The sender independently requires a recent service report, receipt, completed-service
message, or the specific bank-payment acknowledgement template. Open questions,
operational requests, complaints, promised follow-ups, media, incomplete context,
ambiguous customer identity, and subsequent messages cause it to abstain.

The only accepted copy is `Our pleasure, <verified first name>!`, or `Our pleasure!`
when the account's name is unsuitable. A model variation cannot be sent. The name
comes from the current matched account, never from text signed by a staff member.

## Delivery boundary

- Live webhooks mark candidate drafts with `live_webhook` provenance and
  `gratitude_v1`. Historical/backfill drafts do not get that stamp.
- Candidates remain `shadow`; the drafter cannot send or publish a suggestion.
- The existing five-minute scheduler evaluates candidates at least two minutes
  after receipt, typically two to seven minutes later. They expire after ten minutes.
- `GATE_SMS_GRATITUDE_REPLIES` defaults off. Broad `GATE_SMS_AUTO_SEND` alone cannot
  enable this intent. Conversely, gratitude's gate does not enable other intents.
- `SMS_GRATITUDE_ACTIVATED_AT` must be an explicit ISO timestamp with timezone.
  An inbound must be strictly newer than that cutoff. When restarting this lane,
  set a fresh cutoff to exclude messages from the disabled interval.
- The executor reloads the draft, source message, customer and same-endpoint
  context. It rechecks under the shared thread lock, uses the existing unique
  send claim and holding reservation, and checks for newer inbound/manual replies.
  The canonical sender invokes its final activity/timing check at the provider handoff,
  after its own contact, line and template lookups. A message
  arriving after that final observation cannot cancel an already-starting send.
- It does not park or resolve operational suggestions/tasks. Open service
  requests, call/SMS commitments, triage, operator inbox items and review
  decisions block it.
- Existing provider suppression, opt-out, idempotency and profile pinning remain
  in force. Gratitude has its own synthetic qualification exam, described below;
  every other intent retains the existing live graduation requirements.

No migration or new outbound queue is required. Missing intent mode means shadow.

## Replay and tests

Run the offline policy replay with a private Twilio JSONL export:

```sh
node server/scripts/replay-sms-gratitude.js --input /private/messages.jsonl --output /private/gratitude-replay.json
```

The script has no database, provider or LLM access. It evaluates each inbound
at receipt plus two minutes, using only history available by that time. Output
contains private source identifiers and previews, so keep it outside the repository.
Names inferred for previews are explicitly unverified and never send-eligible.
A bounded export has a 24-hour warm-up before history can be treated as complete.
Accepted/queued/scheduled/sending outbounds cannot establish closure and remain blockers.

The September 24 scope export contained 16,504 SMS records, including 4,693
inbound messages. The policy evaluated all 4,693: four preview candidates and
4,689 exclusions. Manual inspection of all four found a report/payment closing.
Of the 51 selected scope examples, three were accepted and 48 excluded;
all 42 examples labeled mixed content, unresolved work, burst, or reaction were
excluded. The other six were possible positives that the conservative policy
declined. The 51 examples were never a list of messages to send.

These are policy results, not live LLM performance or verified customer-account
decisions. The offline export does not establish current open tasks or consent.
Automated delivery tests mock providers; database verification uses synthetic data.

Context and candidate SELECT queries executed and planned successfully on isolated
PostgreSQL using relevant repository migrations and minimal unrelated foreign-key
stubs. Checks covered phone identity, timestamp precision, pending work, duplicate
sweep rows, transactional claim/reservation creation, and idempotent retry. The
qualification ledger checks covered duplicate refusal, stale recovery, failed lock
handling, execution ownership and newest-run supersession. A two-session local
PostgreSQL proof confirmed that stale recovery cannot overwrite a completed run.
Rollback-only local PostgreSQL cases also verified receipt preservation and
reconciliation for accepted, failed, undelivered and canceled reservations.
Each temporary database was stopped. This does not establish deployed schema,
full migration-chain correctness or actual provider delivery.

## Qualification without customer messages

An administrator starts the fixed synthetic exam with
`POST /api/admin/agents/gratitude-qualification`. The response identifies the durable
run in the existing decision ledger. `GET /api/admin/agents/gratitude-qualification`
reports whether the latest run qualifies. Both endpoints require administrator
authentication. Request bodies cannot replace fixtures or submit passing results.

The exam calls the actual drafter and verifier on frozen synthetic conversations,
using both existing exam model routes. It never creates a customer draft or enters
the delivery path. Positive cases must produce the exact allowed reply with safe
raw actions, no missing information and a converged verifier. Every positive
verifier response must report the pinned primary model; fallback or missing
model telemetry fails qualification. Negative cases must return an empty reply
with safe raw actions and remain ineligible after deterministic context checks. A complete result set
is required. This measures the fixed reply, not general conversational autonomy.

A pass is tied to policy and fixture hashes, relevant source code, the rendered
system prompt, both drafting models, verifier configuration and the effective
voice profile actually applied to the prompt. Agent Control shows exam records
in the SMS area and sealed-evaluation lane, distinguishing grading failures from
execution failures. Changed pins, failed or incomplete runs, and unavailable evidence
block qualification. The latest run supersedes older passes. Historical replay
and mocked tests do not qualify production. Exam records do not invent customer
acceptance or human approval.

## Before a future launch

Keep the feature off until all code is reviewed and deployed. Run the no-send
qualification exam on the deployed revision and inspect its result. Explicitly
configure only `gratitude_reply` using the existing intent-mode control after it
qualifies. Passing an exam does not change its mode, gate or activation cutoff.
The existing shadow-drafting and cron gates must also be enabled for candidates
to be created and evaluated; the general SMS auto-send gate can remain off.
The prompt is `house_voice_v11`; evidence for older prompt versions is stale.

Choose the activation cutoff at actual launch, not at build time and not from
historical test dates. A rollout date alone never activates this feature.
