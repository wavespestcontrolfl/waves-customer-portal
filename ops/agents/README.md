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
| `affiliate-baseline.js` | READ-ONLY | Captures the **search/traffic half** of the affiliate pilot's pre-activation baseline (`docs/affiliate-links-pilot.md`), per candidate URL: GSC clicks/impressions/CTR/position, the top queries each page ranks for, GA4 sessions/users, session-weighted bounce rate, pageviews, and GA4 key events (session duration is omitted — it cannot be weighted correctly at the available grain). Window defaults to 90 days; `--end` defaults to a 3-day GSC lag. Filtered to the blog lane and flagged against the pilot's excluded topic classes. Queries `searchanalytics` directly rather than the service's `syncPages()`, so it never writes `gsc_pages`. GA4 rows are summed per path (`getTopPages` splits one path across title changes). Warns on row-cap truncation, `--url` values that matched nothing, and pages missing GA4 sessions. **PARTIAL — not sufficient to activate links:** estimate starts, calls, CTA clicks and geography are not captured (GA4 key events are a leading indicator, not portal-side conversions), so the documented stop rule cannot be evaluated from this alone. `--json` stores a reproducible snapshot; re-running the same `--end` reproduces it. |
| `retention-purge.js` | MUTATES (dry-run default) | Dismisses all `pending_approval` retention outreach drafts (`status` → `rejected`), audit-tagged and reversible. |
| `backfill-plan-rate-ledger.js` | MUTATES (dry-run default) | One-time seed of `customer_plan_rates` before flipping GATE_PLAN_RATE_LEDGER: single-family customers get their family component, multi-family/unclassifiable park as `unattributed` and print a review list. Scalars never change. |
| `railway-var-cleanup.sh` | MUTATES (dry-run default) | Deletes named Railway service variables one at a time, with confirmation of what exists first. |
| `churn-residue-backfill.js` | MUTATES (dry-run default) | One-off wind-down of churned/inactive accounts still carrying billing residue (tier/rate/lane/autopay/retries/ledger/stale series flags) — guarded, locked, self-compensating; run in a quiet booking window (PR #3618). |
| `check-payers-report.js` | READ-ONLY | Lists customers who regularly pay by check (`invoices.payment_method = 'check'`, last N months, ≥M checks) with check share, last check date and whether `pays_by_check` is already active, then prints the exact `collections-flag.js` command per unflagged regular. Ids + initials only. |
| `collections-flag.js` | MUTATES (dry-run default) | Sets or releases one `collections_flags` row on a customer (`pays_by_check`, `do_not_call`, `do_not_collect`, …) — the owner's durable "never call / never collect" instruction the contact policy enforces. Prints active flags first; idempotent; release stamps `released_at`. |
| `sms-notification-backlog-reset.js` | MUTATES (dry-run default) | One-time reset of the inbound-SMS notification backlog: marks reaction/courtesy-closer messages read, clears `inbound_sms` bells whose thread has no unread message, optional `--stale-days=N` sweep. Tagged + reversible. |
| `completion-lane-coverage.js` | READ-ONLY | B0 catalog coverage audit: classifies every active service into a completion lane via `server/config/completion-lane-registry.js` and exits 1 on defects (generic fall-throughs, unlisted stragglers, no-decision keys). |
| `completion-charge-why.js` | READ-ONLY | Replays the appointment-card completion-charge lane for ONE visit (`--visit=<scheduled_service_id>`) and names the first condition that blocked the auto-charge — gate off, excluded billing lane, backfill closeout, a paid sibling invoice, a live payer, no chargeable Auto Pay method, no `/secure` lane row, hold-rail exclusion, sticky `accepted_amount = 0`, over-cap invoice, or a recorded `charge_failed`. Checks run in production's nesting order, so an Auto Pay blocker is never masked by a cap comparison production never reached. Also prints the office bells raised and which completion SMS actually sent. Exit 0 = every condition verified and passing, 1 = blocker found, 2 = inconclusive (something — usually the portal-side gate — could not be verified, so the lane is never reported clean on an unchecked condition). Auto Pay is evaluated with the production `autopay-eligibility` helpers so the ET pause window and card-expiry rules cannot drift. |
| `mcp-stdio.js` | READ-ONLY | stdio ↔ HTTP bridge for the portal's `/api/mcp` MCP knowledge server, so stdio-transport MCP clients (e.g. `claude mcp add`) can use the read-only knowledge tools. Needs `MCP_SERVICE_TOKEN`; endpoint stays gated behind `GATE_MCP_READ_TOOLS`. |
| `bounce-rescue-backfill.js` | MUTATES (dry-run default) | Runs the email bounce→transcript rescue over every active bounce suppression (tier-A/B evidence auto-applies, decode tiers become ACT:-emailed suggestions), or applies one suggested rescue by ledger id via `--apply=<id> --execute`. |
| `stamp-billing-mode.js` | MUTATES (dry-run default) | Stamps an explicit `customers.billing_mode` on owner-ruled NULL-mode rows (`--mode-map <uuid>=<lane>`, rulings on the command line — no identifiers in the repo). Execute re-asserts preconditions under `FOR UPDATE` (lane still NULL, rate cents pinned via `--expect-rate`, real stage, and the profile editor's lane prerequisites — fee/term/priced-visits — fail closed) per-customer and writes an `audit_log` row. `monthly_rate` is never touched. |
| `spam-block-orphan-filter-sweep.js` | MUTATES (dry-run default) | Deletes the orphaned Gmail auto-trash filters the blocked_email_senders dedupe migration ledgered in `blocked_email_senders_dedupe_orphans` (a migration cannot call the Gmail API); 404s stamp as already-gone, failures stay in the ledger for a rerun. |
| `compliance-gate-eval.js` | READ-ONLY | Calibration harness for the semantic compliance gate (`server/services/content/compliance-gate.js`). Replays the labelled corpus that 23 Codex review rounds left in `server/tests/content-guardrails.test.js` — labels read from the test assertions, never from running the regex gate, which would be circular — and reports recall/precision plus which cases each layer catches alone. Makes LIVE LLM calls (never in CI); no DB access and no customer records. **Activation run is `--document --all`** — `--document` embeds each fixture in a production-sized (~900-word) article with title and meta, and is required before flipping `GATE_COMPLIANCE`; without it the harness sends isolated sentences, which cannot measure long-document recall or offered-vs-discussed context. Also `--all`, `--limit N`, `--concurrency N`, `--code REENTRY_SAFETY_CLAIM\|BANNED_TOPIC`. |
| `repoint-orphaned-card-hold.js` | MUTATES (dry-run default) | Sweeps `estimate_card_holds` rows stranded `held` on cancelled/rescheduled visits (the operator cancel+recreate reschedule pattern) and repoints one hold to the successor visit under FOR-UPDATE preconditions (same customer, same estimate lineage via `source_estimate_id`, one-time, live target). Optional `--charge --execute --invoice=<id>` then runs the runtime `chargeCardHoldOnCompletion` rail (claim + frozen accepted_amount cap re-enforced under the charge lock + visit-binding re-check + surcharge/ledger/receipt) for an already-completed visit — moves real money, owner-run only. The runtime lane (`GATE_CARD_HOLD_RESCHEDULE_ADOPT`) only DETECTS stranded holds at future completions and bells the office pointing here — this script is the sole mover. |
| `archive-catalog-service.js` | MUTATES (dry-run default) | Archives ONE owner-approved Service Library row (`--key` must be in the script's APPROVED_KEYS map, currently `rodent_monitoring`) through `service-library.deactivateService` — the admin Archive button's exact guard (open visits by id and by live label, add-ons, package items, discount rules) and `service_catalog.archive` audit row. Dry run prints the row + references and whether archive would be refused; refused runs exit 1 with the reference list. |
| `listen-transcripts.js` | MUTATES (dry-run default) | `/listen`: mines the operator's own Claude Code + Codex session transcripts (last `--hours`) for blog-post ideas. `extract` keeps user/assistant prose only (tool results + thinking dropped), runs `pii-redactor` before the FAST-tier LLM pass, applies the canonical geo / compliance gates, withholds turns carrying credentials or low-confidence redactions, and writes a category-seed manifest only when `--out` names a path; `seed --file [--only=ids] --execute` validates it through `category-seed-seeder.loadManifest`, re-runs the targeting rulings on the (possibly hand-edited) manifest, flags rows already queued or already live, and seeds the rest at `pending_review` so the owner must release each one from the content review queue. Outbound blog content only — never customer comms. |
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
