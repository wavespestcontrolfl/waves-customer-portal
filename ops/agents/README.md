# ops/agents — recurring operator & agent scripts

Scripts that operate the live business (prod DB reads, Railway env hygiene,
Stripe verification) and kept dying in per-session scratchpads. Anything an
operator or agent session reaches for twice gets promoted here.

**This folder is tooling, not application code.** Nothing in here is imported
by the server or client, and nothing here runs on a schedule — every script is
invoked by a human or an agent session, on purpose, from the repo root.

## Conventions (enforced — reviewers treat violations as P1)

1. Every script declares `READ-ONLY` or `MUTATES` in its header comment and in
   the index below.
2. `MUTATES` scripts are **dry-run by default** and only write when passed
   `--execute`. The dry run prints exactly what would change.
3. No secrets, tokens, customer names, or invoice numbers in filenames or file
   contents. Credentials come from the environment at runtime (`railway run`
   injects them); results print to stdout only.
4. Promotion rule: the second time a scratchpad script gets used, it moves
   here with a header comment and an index entry.

## Index

| Script | Mode | What it does |
|---|---|---|
| `pull-page-tokens.js` | READ-ONLY | Pulls one recent live token per customer-facing token-gated page type (estimate, pay, receipt, report, track, …) so those pages can be opened for visual review. |
| `retention-purge.js` | MUTATES (dry-run default) | Dismisses all `pending_approval` retention outreach drafts (`status` → `rejected`), audit-tagged and reversible. |
| `backfill-plan-rate-ledger.js` | MUTATES (dry-run default) | One-time seed of `customer_plan_rates` before flipping GATE_PLAN_RATE_LEDGER: single-family customers get their family component, multi-family/unclassifiable park as `unattributed` and print a review list. Scalars never change. |
| `railway-var-cleanup.sh` | MUTATES (dry-run default) | Deletes named Railway service variables one at a time, with confirmation of what exists first. |
| `completion-lane-coverage.js` | READ-ONLY | B0 catalog coverage audit: classifies every active service into a completion lane via `server/config/completion-lane-registry.js` and exits 1 on defects (generic fall-throughs, unlisted stragglers, no-decision keys). |
| `completion-charge-why.js` | READ-ONLY | Replays the appointment-card completion-charge lane for ONE visit (`--visit=<scheduled_service_id>`) and names the first condition that blocked the auto-charge — gate off, excluded billing lane, backfill closeout, a paid sibling invoice, a live payer, no chargeable Auto Pay method, no `/secure` lane row, hold-rail exclusion, sticky `accepted_amount = 0`, over-cap invoice, or a recorded `charge_failed`. Checks run in production's nesting order, so an Auto Pay blocker is never masked by a cap comparison production never reached. Also prints the office bells raised and which completion SMS actually sent. Exit 0 = every condition verified and passing, 1 = blocker found, 2 = inconclusive (something — usually the portal-side gate — could not be verified, so the lane is never reported clean on an unchecked condition). Auto Pay is evaluated with the production `autopay-eligibility` helpers so the ET pause window and card-expiry rules cannot drift. |
| `mcp-stdio.js` | READ-ONLY | stdio ↔ HTTP bridge for the portal's `/api/mcp` MCP knowledge server, so stdio-transport MCP clients (e.g. `claude mcp add`) can use the read-only knowledge tools. Needs `MCP_SERVICE_TOKEN`; endpoint stays gated behind `GATE_MCP_READ_TOOLS`. |
| `bounce-rescue-backfill.js` | MUTATES (dry-run default) | Runs the email bounce→transcript rescue over every active bounce suppression (tier-A/B evidence auto-applies, decode tiers become ACT:-emailed suggestions), or applies one suggested rescue by ledger id via `--apply=<id> --execute`. |
| `stamp-billing-mode.js` | MUTATES (dry-run default) | Stamps an explicit `customers.billing_mode` on owner-ruled NULL-mode rows (`--mode-map <uuid>=<lane>`, rulings on the command line — no identifiers in the repo). Execute re-asserts preconditions under `FOR UPDATE` (lane still NULL, rate cents pinned via `--expect-rate`, real stage, and the profile editor's lane prerequisites — fee/term/priced-visits — fail closed) per-customer and writes an `audit_log` row. `monthly_rate` is never touched. |
| `compliance-gate-eval.js` | READ-ONLY | Calibration harness for the semantic compliance gate (`server/services/content/compliance-gate.js`). Replays the labelled corpus that 23 Codex review rounds left in `server/tests/content-guardrails.test.js` — labels read from the test assertions, never from running the regex gate, which would be circular — and reports recall/precision plus which cases each layer catches alone. Makes LIVE LLM calls (never in CI); no DB access and no customer records. **Activation run is `--document --all`** — `--document` embeds each fixture in a production-sized (~900-word) article with title and meta, and is required before flipping `GATE_COMPLIANCE`; without it the harness sends isolated sentences, which cannot measure long-document recall or offered-vs-discussed context. Also `--all`, `--limit N`, `--concurrency N`, `--code REENTRY_SAFETY_CLAIM\|BANNED_TOPIC`. |
| `repoint-orphaned-card-hold.js` | MUTATES (dry-run default) | Sweeps `estimate_card_holds` rows stranded `held` on cancelled/rescheduled visits (the operator cancel+recreate reschedule pattern) and repoints one hold to the successor visit under FOR-UPDATE preconditions (same customer, same estimate lineage via `source_estimate_id`, one-time, live target). Optional `--charge --execute --invoice=<id>` then runs the runtime `chargeCardHoldOnCompletion` rail (claim + frozen accepted_amount cap re-enforced under the charge lock + visit-binding re-check + surcharge/ledger/receipt) for an already-completed visit — moves real money, owner-run only. The runtime lane (`GATE_CARD_HOLD_RESCHEDULE_ADOPT`) only DETECTS stranded holds at future completions and bells the office pointing here — this script is the sole mover. |
| `pricing-funnel-report.js` | READ-ONLY | Pricing funnel standing instrument: close rates DEDUPED BY CUSTOMER for pest (solo), lawn, and pest+lawn bundles, banded by size and price ($/visit; $/1k-sqft/app), with accepted-vs-expired price medians. `--since=YYYY-MM-DD` for era cuts, `--lane=pest\|lawn`. Feeds pricing decisions (owner directive 2026-08-04) and the /weekly-marketing sweep. |

## Prod read-only access recipe

The portal's `DATABASE_URL` points at `postgres.railway.internal`, which is
unreachable from a local machine (`ENOTFOUND`). For read-only prod queries:

- **Postgres:** `railway run --service Postgres node <script>` and connect via
  `process.env.DATABASE_PUBLIC_URL` (the public proxy). Node scripts here use
  `pg` with `ssl: { rejectUnauthorized: false }`.
- **Stripe:** write a Node script using `require('stripe')` +
  `process.env.STRIPE_SECRET_KEY` and run it with `railway run node <script>`
  from the repo root — the secret stays inside the subprocess. If the script
  lives outside the repo, set `NODE_PATH="$PWD/node_modules"`.
- **Deploy status:** `railway deployment list` from the repo root.
- Railway services are `waves-customer-portal`, `Postgres`, and
  `seo-pipeline-worker`.

Prod access is still gated by Railway auth (`railway login`) — these recipes
grant nothing by themselves. Keep every prod-touching script scoped to exactly
what was asked; never dump full tables or the variable store.

## Usage

```sh
# Read-only: grab one live token per public page type
railway run --service Postgres node ops/agents/pull-page-tokens.js

# Read-only: why didn't this completed one-time visit auto-charge the card on file?
railway run --service Postgres node ops/agents/completion-charge-why.js --visit=<scheduled_service_id>

# Dry-run (default), then real run, of the retention draft purge
railway run --service Postgres node ops/agents/retention-purge.js
railway run --service Postgres node ops/agents/retention-purge.js --execute

# Preview, then delete, dead Railway vars (each delete can trigger a redeploy)
ops/agents/railway-var-cleanup.sh GATE_VOICE_AGENT META_CAPI_TEST_EVENT_CODE
ops/agents/railway-var-cleanup.sh --execute GATE_VOICE_AGENT META_CAPI_TEST_EVENT_CODE
```
