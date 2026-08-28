# Backlink Manager — Design Plan v2

**Status:** Plan of record (supersedes the 2026-05-30 v1 below the fold — see §15)
**Owner:** Adam
**Date:** 2026-08-28
**Surface:** `/admin/seo → Backlinks → Agent` (existing `BacklinkAgentPanel`) + `Link Building`

> **The objective is not to discover backlinks or submit forms. The objective is to
> autonomously acquire and retain high-quality referring domains, subject to explicit
> quality, budget, and authority policies.**

---

## 0. Why a v2

v1 (May) built the intelligence/control plane and it works: the prospect board, the
verifier/indexer, the strategist feed, the DataForSEO gap feeder, the claim/report worker
contract, the approval-gated outreach sender, and — as of PR #3544 — canonical link identity,
one board-admission guard for every writer, and a ledger-durable loss/alert/recovery loop.

What never crossed into production is **execution**: the Hermes (Nous, Docker) worker was
never deployed and has never claimed a row; the Playwright v1 signup worker has 12 queue items
pending since April and 0 profiles; 56 drafted outreach emails have waited since June behind a
manual send valve that v1 §9 designed to stay closed "until proven"; every paid or
account-requiring path dead-ends at `needs_account` / `paid` with nobody holding it.

The historical failure mode is therefore specific: **Waves has repeatedly built discovery
and strategy; it has not shipped the part that acts.** v2 does not add another discovery
engine or strategist. It adds the four things that let execution run unattended under policy:
a domain registry with *acquisition paths*, an investigator that fills them, an authority
policy that decides who may act, and a D30 learning loop that tells the policy what worked.

Everything already shipped is a **dependency**, not work to redo (§1).

---

## 1. Shipped components (dependencies)

| Component | Where | Role in v2 |
|---|---|---|
| Prospect board | `seo_link_prospects` (migration `20260530000010` + 3 alters) | **Placement** row = (domain, Waves page); lifecycle `prospect → contacted → negotiating → placed → live → indexed / lost / rejected` |
| Board admission guard | `server/services/seo/prospect-domain-lock.js` (#3544) | `claimProspectDomain` (advisory lock + lane-aware domain probe), `findPlacementRow` (canonical host + page spellings), `targetPageOf/Variants`. **Every writer goes through it**, including v2 intake. |
| Verifier / indexer | `link-prospect-verifier.js`, `link-prospect-indexer.js` | The Judge. Promotes `placed → live → indexed` from crawl / DataForSEO / GSC; demotes on definitive absence; scan-tracked evidence only (#3544) |
| Inbound monitor + ledger | `backlink-monitor.js`, `seo_backlinks`, `seo_backlink_events` (#3544) | Verified loss (2 misses + crawl), canonical identity, `merged` twins, durable admin-bell alerts, `lost_recovery` prospects |
| Gap feeder | `competitor-gap-miner.js`, `competitor-discovery.js` → `seo_competitor_backlinks` | 7,553 unreviewed rows = the largest raw inventory; v2 ingests it (§4) |
| Local opportunity feed | `local-opportunity-prospector/promoter.js` | Stays; writes through the guard |
| Scorer + lane classifier | `prospect-scorer.js` (relevance, lead value, contactability gate, `CLAIMABLE_LINK_TYPES`), `signup-classifier.js` | Quality score. v2 adds path + persistence terms (§8) |
| Worker contract | `GET /api/integrations/backlink-worker/claim`, `POST …/report` (`link-prospect-worker.js`, `hermes-auth.js`, `GATE_HERMES_WORKER`, `HERMES_SERVICE_TOKEN`) | The `claim → act → report` boundary. Kept verbatim; v2 puts providers behind it (§7) |
| Deterministic signup runner | `signup-runner.js`, `signup-evidence.js`, `GATE_SIGNUP_RUNNER`, `SIGNUP_RUNNER_ALLOWLIST`, `HERMES_SIGNUP_EMAIL` (chromium in the prod image) | First `BrowserAgentProvider` implementation (§7) |
| Outreach drafter + sender | `backlink-outreach-drafter.js` (`GATE_OUTREACH_DRAFTER`), `link-prospect-outreach.js` (`GATE_LINK_OUTREACH`, `LINK_OUTREACH_DAILY_CAP`, Gmail `contact@`, idempotent send, `send_error` reconcile), `comms-lint.js` | The `OutreachProvider` (§7) under the bounded mandate (§6.4) |
| Strategist | `backlink-strategy-agent*.js`, `create_link_prospects` / `list_prospects` | Stays on demand; becomes one more *source* into the registry |
| SSRF-safe fetch | `contact-finder.fetchPage()` | The only page fetcher the investigator may use |
| Admin UI | `BacklinkAgentPanel` (Agent sub-tab), Link Building board, outreach approvals | Extended, not replaced (§11) |

---

## 2. Architecture — Brain / Books / Hands / Judge

```
 BRAIN                       BOOKS (Postgres = truth)             HANDS                          JUDGE
 discovery feeds             seo_link_domains                     BrowserAgentProvider           link-prospect-verifier
 path investigator     →     seo_link_acquisition_paths     →     OutreachProvider          →    link-prospect-indexer
 scorer + persistence        seo_link_prospects (placements)      deterministic runner            backlink-monitor
 authority policy            attempts / evidence / costs          (claim → act → report)          D30 survival + ledger
                             authority decisions, D30 outcomes
```

**Governing principle:** *Agents propose and execute acquisition actions; Postgres owns
truth; verification — never agent self-report — determines success.*

Invariants carried from v1: the board is the single funnel; a worker's report moves a row to
`placed` at most; only the Judge promotes to `live`/`indexed`; every board write goes through
`prospect-domain-lock`; DataForSEO spend stays behind `GATE_SEO_INTELLIGENCE`.

Dropped from v1: the Hermes (Nous, Docker) worker as *the* hands; the X poller as a primary
source; "paid" and "needs account" as workflow states; the manual outreach valve as a permanent
design choice.

---

## 3. Data model

### 3.1 `seo_link_domains` — the registry (one row per canonical host)

```js
t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
t.text('domain').notNullable().unique();          // canonicalProspectDomain(): lower, no scheme/www/port/path
t.string('source').notNullable();                 // FIRST-TOUCH provenance (§3.5) — never overwritten
t.text('source_detail');                          // first-touch detail: 'backlinks_csv_2026_08', gap id, seed note
t.uuid('source_ref');                             // first-touch ref (registry row for recursive, gap id, …)
t.string('discovery_priority').notNullable().defaultTo('normal'); // owner_seed | normal
t.integer('domain_rating'); t.integer('organic_traffic'); t.integer('spam_score');
t.integer('referring_domains'); t.integer('competitors_linked');
t.jsonb('enrichment');                            // raw DataForSEO summary, cached
t.timestamp('enriched_at');
t.uuid('best_path_id');                           // → seo_link_acquisition_paths
t.string('agent_state').notNullable().defaultTo('new');
// new → investigating → qualified → ready_to_acquire → acquiring → acquired → watching | not_reproducible | rejected
t.integer('score');                               // Waves Link Score (§8), recomputed on enrichment/D30
t.text('score_reasons');                          // human-readable why (shown on the registry row)
t.timestamp('watch_recheck_at');                  // for agent_state='watching'
t.text('notes'); t.string('owner');
t.timestamps(true, true);
t.index(['agent_state']); t.index(['source']);
```

### 3.2 `seo_link_acquisition_paths` — **the central abstraction**

A domain is not useful until Waves knows *how* to get a link from it. One domain may expose
several ways; each is a row.

```js
t.uuid('id').primary(); t.uuid('domain_id').notNullable().references('seo_link_domains.id');
t.string('acquisition_type').notNullable();
//  self_service_free | self_service_account | paid_listing | membership | association |
//  sponsorship | vendor_registration | business_claim | resource_outreach |
//  editorial_outreach | partnership | content_submission | not_reproducible | unknown
t.text('submission_url');
t.integer('estimated_cost_cents'); t.integer('renewal_cost_cents'); t.string('renewal_period'); // annual|monthly|none — integer cents, parsed ONCE by the investigator from the quoted price text (kept verbatim in `investigation`); never decimal, never re-parsed downstream
t.boolean('account_required'); t.boolean('email_verification'); t.boolean('payment_required');
t.boolean('legal_attestation');                   // signed agreement / vendor terms / W-9 etc.
t.boolean('agent_completable');                   // investigator's judgement: can the runner finish alone
t.string('expected_rel');                         // dofollow | nofollow | sponsored | unknown
t.string('expected_indexability');                // indexable | noindex | unknown
t.string('expected_persistence');                 // durable | rotating | unknown  (+ learned D30 in §8)
t.string('link_type');                            // board lane the placement will carry (CLAIMABLE_LINK_TYPES)
t.numeric('confidence', 3, 2);                    // 0–1
t.string('authority');                            // decided authority level (§6), stamped by policy
t.jsonb('investigation');                         // evidence: pages fetched, form fields seen, price text, quotes
t.timestamp('last_investigated_at');
t.timestamps(true, true);
t.text('path_key').notNullable();                 // `${acquisition_type}:${normalized submission_url || '-'}` — non-null, so re-investigation upserts instead of duplicating (Postgres UNIQUE treats NULLs as distinct)
t.unique(['domain_id', 'path_key']);
```

### 3.3 `seo_link_prospects` — placements (existing; additive columns)

```js
t.uuid('domain_id').references('seo_link_domains.id');
t.uuid('path_id').references('seo_link_acquisition_paths.id');
t.string('authority');            // authority level under which this placement was/will be acted on
t.text('source_detail');
t.timestamp('paid_through');      // end of the term the last `charged` purchase bought
t.timestamp('renews_at');         // = paid_through; written ONLY when a purchase reaches `charged` (initial or renewal) from path.renewal_period + the term start shown at checkout; cleared when the listing lapses; read by the renewal job
t.boolean('recurring_merchant').notNullable().defaultTo(false);
```
New statuses: **`awaiting_owner`** (parked on an owner decision: payment / membership / legal)
and **`watching`** (unactionable today, rechecked). `PROSPECT_STATUSES` in
`admin-backlink-agent-v2.js` is the contract; the worker's `claim()` never leases either.

### 3.4 `seo_link_attempts` — every execution, whoever performed it

```js
t.uuid('id').primary(); t.uuid('prospect_id'); t.uuid('path_id');
t.string('provider').notNullable();   // deterministic_runner | openai_cua | claude_cu | stagehand | grok | human
t.string('action').notNullable();     // investigate | create_account | complete_form | submit | resume | outreach_send
t.string('outcome').notNullable();    // placed | drafted | failed | skipped | needs_owner | captcha | blocked
t.integer('cost_cents'); t.integer('duration_ms'); t.boolean('sandbox').notNullable().defaultTo(false);
t.text('evidence_url'); t.jsonb('detail');    // sanitized: never credentials, never full page bodies
t.timestamps(true, true);
```
`signup-evidence.js` writes here for the deterministic runner (its current ledger folds in).

### 3.4b `seo_link_domain_sources` — every touch, normalized

```js
t.uuid('id').primary(); t.uuid('domain_id').notNullable();
t.string('source').notNullable(); t.text('source_detail'); t.uuid('source_ref');
t.text('touch_key').notNullable();   // `${source}:${source_ref || normalized source_detail || '-'}` — non-null so a recurring feeder is idempotent (Postgres UNIQUE treats NULLs as distinct)
t.timestamp('seen_at').notNullable().defaultTo(knex.fn.now());
t.unique(['domain_id', 'touch_key']);
```
`seo_link_domains.source` is first-touch attribution and is never overwritten; every feeder
(including a repeat of the first) inserts a row here. §8 reports and learns per source from
this table (a domain discovered by three feeders credits all three; "first-touch" and
"any-touch" are both reportable), and recursive lineage follows `source_ref` chains here.

### 3.5 Provenance enum (`seo_link_domains.source`, `seo_link_domain_sources.source`)

`owner_seed` · `list_import` · `competitor_gap` · `competitor_clone` · `recursive` ·
`x` · `google_search` · `dataforseo` · `strategy_agent` · `existing_backlink` ·
`lost_recovery` · `local_opportunity`

`owner_seed` means **investigate immediately**, not **qualified**: it bypasses the cheap
prefilter and the contactability gate, never the score; the row shows its reasons and an
*Acquire anyway* override. Bulk lists are `list_import` + `source_detail` — never `owner_seed`.

### 3.6 Credentials — `seo_link_credentials` (+ `seo_link_sessions`)

`self_service_account` paths create accounts. Credentials — and resumable browser state
(cookies/tokens, §7) — are stored encrypted at rest with a **dedicated, stable, versioned key**
(`LINK_CREDENTIALS_KEY_V1`, `…_V2` …; each row carries `key_version`; rotation = add the next key,
re-encrypt lazily on read, retire the old key when no rows reference it). Never derived from
`JWT_SECRET` or any session/app secret — rotating those must not brick stored logins, and no
other code path should hold this key. Rows are scoped per `domain_id`, readable only by the
runner's create/resume path, and **never** written to `seo_link_attempts.detail`, logs,
evidence, or LLM prompts.
The dedicated inbox is `HERMES_SIGNUP_EMAIL` (exists); its IMAP verifier
(`backlink-agent/email-verifier.js`) is reused for `email_verification=true` paths.

### 3.7 Purchases — `seo_link_purchases`

The spend ledger with atomic monthly reservation and ambiguity-safe states; defined with the
money mechanics in §6.3.

### 3.8 Policy — `seo_link_policy` (single row, admin-editable, env-overridable)

See §6.2. Defaults ship conservative (everything owner-gated) and are loosened by Adam in the
Policy panel, not by code.

---

## 4. Intake — one pipeline for every source

`POST /api/admin/backlink-agent/opportunities/bulk`  (admin auth; also called internally)

Accepts raw text: domains, URLs, an X post URL, a competitor backlink URL, a pasted list,
CSV rows. Steps, all idempotent:

1. **Normalize** — extract hosts/URLs from the text; `canonicalProspectDomain()` for the host;
   keep the URL as a *submission_url hint*. **Resolvers run first** for URLs that are
   *references to* opportunities rather than opportunities: an X post URL (`x.com`/
   `twitter.com/<user>/status/<id>`) is resolved through the existing `backlink-agent/x-poller`
   URL extraction (tweet entities → expanded URLs → redirect-resolved final hosts) and each
   resolved host enters as `source='x'`, `source_detail=<post URL>`; the post host itself is
   never a candidate. A competitor backlink URL contributes its host. Hosts on a fixed
   never-a-target list (`x.com`, `twitter.com`, `google.com`, `t.co`, URL shorteners, Waves'
   own domains) are dropped, not parked. If the X API is unavailable the post is parked in
   intake as `unresolved` and retried, never turned into an `x.com` domain.
2. **Dedupe** — against `seo_link_domains.domain` and, for placement hints, via
   `findPlacementRow`. Existing rows are *updated* (a `seo_link_domain_sources` row is
   added for the new touch; first-touch `source` is untouched; priority raised if the new
   source is `owner_seed`), never duplicated.
3. **Enrich** — DataForSEO bulk summary (rank, traffic, spam, referring domains) in one call
   per batch; `competitors_linked` from `seo_competitor_backlinks`. Behind
   `GATE_SEO_INTELLIGENCE`; cached in `enrichment`.
4. **Queue for investigation** — `agent_state='investigating'`; `owner_seed` first.

**Feeders that call the same endpoint** (as jobs, not UI):
- **Competitor-gap ingestion** — every `seo_competitor_backlinks` domain not yet in the
  registry (the 7,553). Weekly after the Sunday scan; `source='competitor_gap'`.
- **Existing profile** — `seo_backlinks` active domains → `source='existing_backlink'`,
  `agent_state='acquired'` (so recursive discovery and D30 have a baseline).
- **Lost recovery** — `lost-link-recovery.js` files its recovery prospect *and* ensures a
  registry row (`source='lost_recovery'`).
- **Strategist / local opportunity** — unchanged writers; they additionally upsert the domain.
- **Recursive discovery (§9)** — `source='recursive'`.

**UI (Agent tab):** one box — *"Add backlink opportunities — paste domains, URLs, X posts, or
an entire list"* → **Analyze opportunities**. No `target_page`; the scorer's topic mapping
picks the money page when the placement is created.

---

## 5. Path investigator — the bridge from "known" to "reproducible"

A job, not a chat: for each `investigating` domain, answer **"Can Waves reproduce a link
here, and how?"** and write one or more `seo_link_acquisition_paths` rows.

- **Inputs:** the domain, its enrichment, the submission-URL hints, and — for
  `competitor_gap` rows — the competitor's actual source URL (the page the link lives on).
- **Fetch:** `contact-finder.fetchPage()` only (SSRF-pinned; refuses private hosts; bounded
  bytes). Candidate pages: the hint, the competitor page, and a fixed probe list
  (`/submit`, `/add-listing`, `/join`, `/membership`, `/members`, `/vendors`,
  `/sponsors`, `/advertise`, `/directory`, `/resources`, `/contact`, `/signup`, `/register`)
  — capped at ~8 fetches per domain.
- **Reasoning:** one `WORKHORSE`-tier call through `server/services/llm/call.js` (never a
  hardcoded model id) with a strict JSON schema = the path fields in §3.2 plus
  `confidence` and `reasons`. Price/renewal text is quoted verbatim into `investigation`.
  `not_reproducible` is a first-class answer (a competitor's editorial mention, a
  private partnership) and closes the domain honestly instead of leaving it "unknown".
- **Outputs:** paths + `best_path_id` (highest expected value per §8) + `agent_state`
  (`qualified` / `not_reproducible` / `watching` when the path exists but is closed today).
- **Cost discipline:** ~8 fetches + 1 LLM call per domain; batch of N per run
  (`LINK_INVESTIGATOR_BATCH`, default 50); `owner_seed` jumps the queue. Re-investigate on
  `watch_recheck_at`, on a failed attempt, or after 90 days.

This step is what turns the gap table into an **acquisition inventory**. Nothing enters the
acquisition queue without a path row with `confidence ≥ policy.min_path_confidence`.

---

## 6. Acquisition authority — permission, separated from quality

### 6.1 Levels (`authority` on path + placement)

`AUTO_FREE` · `AUTO_ACCOUNT` · `AUTO_OUTREACH` · `AUTO_PAID_WITHIN_POLICY` ·
`OWNER_ACCOUNT` · `OWNER_PAYMENT` · `OWNER_MEMBERSHIP` · `OWNER_LEGAL` · `OWNER_OVERRIDE` · `DENY`

**Paid is an attribute of a path; it is not a workflow state.** The level is *computed* from
the path's attributes and the policy at decision time, then stamped for the audit trail.

### 6.2 Policy (`seo_link_policy`, Policy panel on the Agent tab)

```text
auto_account_creation        = true
auto_outreach_min_score      = 80
auto_outreach_daily_cap      = 10        (≤ LINK_OUTREACH_DAILY_CAP, the hard ceiling; enforced INSIDE the sender's lock, §6.4)
owner_price_tolerance_cents  = 0
monthly_paid_budget_cents    = 50000     ($500 — every money field is integer cents, end to end)
max_auto_purchase_cents      = 5000      ($50)
auto_paid_min_score          = 80
auto_paid_min_d30_confidence = 0.6
min_score                    = 60        (floor for ANY action, auto or owner-routed)
membership_requires_owner    = true
legal_attestation_requires_owner = true
min_path_confidence          = 0.6
max_spam_score               = 10
```

### 6.3 Decision (pure function, unit-tested; recorded on the placement)

```
# 1. Fail-closed quality floors — evaluated FIRST, before any AUTO_* or OWNER_* branch.
#    A row that fails a floor is DENY regardless of who would have acted; owner override is
#    the explicit "Acquire anyway" click, which stamps authority=OWNER_OVERRIDE, never DENY→AUTO.
#    MISSING is failing: every required signal must be a finite number (not null/NaN/undefined).
if not all finite(domain.spam_score, score, path.confidence, amount_cents if path.payment_required) → DENY
if domain.spam_score > policy.max_spam_score
   or path.confidence < policy.min_path_confidence
   or score < policy.min_score
   or path.acquisition_type in (not_reproducible, unknown) → DENY
# 2. Authority (only reached by rows that passed every floor)
if path.legal_attestation and policy.legal_attestation_requires_owner → OWNER_LEGAL
if path.acquisition_type in (membership, association, sponsorship) and policy.membership_requires_owner → OWNER_MEMBERSHIP
if path.payment_required:
    if amount_cents ≤ max_auto_purchase_cents and score ≥ auto_paid_min_score and d30_conf ≥ auto_paid_min_d30_confidence
       and (month_spend_cents + amount_cents) ≤ monthly_paid_budget_cents → AUTO_PAID_WITHIN_POLICY
    else → OWNER_PAYMENT
if path.acquisition_type in (resource_outreach, editorial_outreach, partnership):
    → AUTO_OUTREACH if score ≥ auto_outreach_min_score and draft passes §6.4, else OWNER_* per reason
if path.account_required → AUTO_ACCOUNT if auto_account_creation else awaiting_owner (OWNER_ACCOUNT)
else → AUTO_FREE
```
The function is pure and unit-tested with a table of (path, domain, policy) → level cases,
including one per floor proving DENY beats every AUTO_* and OWNER_* branch, and one per
required signal proving null / NaN / undefined → DENY (an unenriched domain can never be
acted on, by anyone, until enrichment and investigation have run).

`OWNER_*` → placement `awaiting_owner` + an admin-bell card (existing `NotificationService`,
`bell: true`) showing domain, path, cost/renewal, DR/traffic/spam, competitors linked,
expected rel, D30 confidence, and **Approve** / **Reject** / **Watch**. Approval is a portal
click (never email-reply — repo rule: email approval is never extended to money movement).
On approve the runner resumes the same path with the stored session.

**Money mechanics — `seo_link_purchases` (the spend ledger; budget is reserved, never
inferred).** Every paid step, auto or owner-approved, is a row:

```js
t.uuid('id').primary(); t.uuid('prospect_id').notNullable(); t.uuid('path_id').notNullable();
t.string('budget_month').notNullable();             // 'YYYY-MM' in America/New_York — `etDateString(now).slice(0, 7)` (server/utils/datetime-et.js); never the UTC month
t.string('purchase_kind').notNullable().defaultTo('initial'); // initial | renewal — each renewal is its own separately authorized purchase
t.integer('generation').notNullable().defaultTo(1); // bumps only when the prior generation of the SAME kind/period ended voided / reconciled_not_charged
t.string('renewal_period_key');                     // for renewals: the period being bought, e.g. '2027' or '2026-11' — null for initial
t.string('idempotency_key').notNullable().unique(); // `${prospect_id}:${path_id}:${purchase_kind}:${renewal_period_key || '-'}:${generation}` — NOT month-scoped: a placement's initial purchase is unique for all time
t.integer('amount_cents').notNullable();            // reserved amount, integer cents (never decimal)
t.integer('final_cents');                           // the checkout's final total incl. tax/fees, read before submitting
t.string('authority').notNullable();
t.string('state').notNullable();                    // reserved → submitting → charged | voided | ambiguous → reconciled_charged | reconciled_not_charged
t.text('merchant_idempotency_key');                 // sent to the merchant/checkout where supported (= idempotency_key)
t.timestamp('submitting_at');
t.text('merchant_ref');                             // merchant order/receipt id ONLY — never card data
t.text('issuer_card_id'); t.string('card_last4', 4); // opaque issuer identifier of the single-use card + last4; the PAN is NEVER persisted anywhere
t.text('evidence_url'); t.timestamp('reserved_at'); t.timestamp('settled_at');
```

- **Reserve before exposing credentials.** The decision in §6.3 does NOT read a sum of past
  attempts. It runs inside one transaction: `pg_advisory_xact_lock(hashtext('link_budget:<YYYY-MM>'))`
  → `month_spend_cents = SUM(COALESCE(final_cents, amount_cents)) WHERE budget_month = <ET month> AND state IN (reserved, submitting, charged, ambiguous, reconciled_charged)` — every state in which the card has been, or may be, used consumes budget; only `voided` and `reconciled_not_charged` release it
  → **open/settled-purchase check — all-time, not per month**: if ANY row for
  `(prospect_id, path_id, purchase_kind, renewal_period_key)` is in `reserved`, `submitting`,
  `ambiguous`, `charged` or `reconciled_charged` → no new reservation (409). A placement that
  was paid for in March can never be paid for again as `initial` in April; only an explicit
  `renewal` for a *new* period can be reserved, and `claim()` never leases a placement with an
  open (`reserved`/`submitting`/`ambiguous`) purchase of any kind. Otherwise `generation` =
  1 + the highest ended generation (`voided` / `reconciled_not_charged`) for that key → if `month_spend_cents + amount_cents ≤
  monthly_paid_budget_cents` insert the `reserved` row (the unique `idempotency_key` makes a
  concurrent duplicate a no-op) → commit. All money is integer cents. So a pre-submission failure (voided) can be retried
  in the same month as a new generation, while anything that may have reached the merchant
  never can. Only a committed
  reservation unlocks the card details to the provider. Two workers can never both pass the
  check; the lock is per ET budget month (`link_budget:<budget_month>`), so the policy month
  rolls over at midnight Eastern, not 4–5 hours early at UTC midnight.
- **Final total is validated before `submitting`.** The provider must read the checkout's
  final total (price + tax + fees + renewal terms as displayed) and report it as
  `final_cents` BEFORE the card is exposed. The `reserved → submitting` transition runs under
  the same `link_budget:<budget_month>` advisory lock and: refuses (→ `voided`,
  `outcome='price_changed'`) if `final_cents > max_auto_purchase_cents` for a row whose stamped
  authority is exactly `AUTO_PAID_WITHIN_POLICY` (regression test: a checkout total raised above
  the ceiling after reservation is refused), or if
  the renewal terms differ from the path; otherwise reserves the delta
  (`final_cents − amount_cents`, if positive) against the month under the same budget check —
  no room → `voided`; else commits `submitting` with `final_cents` as the consuming amount.
  An owner-approved purchase whose final total exceeds the approved amount by more than
  `policy.owner_price_tolerance_cents` (default 0) is also refused and re-parked with the new
  total. The provider can never charge an amount the ledger has not reserved.
- **Renewals are separate purchases; a merchant can never charge outside the ledger.** A
  reservation covers exactly one charge, and the instrument enforces it: each purchase is paid
  with a **single-use virtual card number** (issuer-generated per reservation; the ledger
  stores only the issuer's opaque `issuer_card_id` + `card_last4` — the PAN/CVV are fetched
  from the issuer at `submitting` time, handed to the provider in memory for that one
  checkout, and never written to the ledger, attempts, evidence, sessions, logs or prompts)
  that is **closed immediately after `charged`/`voided`/reconciliation** — so an
  armed auto-renewal, a merchant retry, or a stored-card charge has no live number to hit.
  The provider still selects the non-recurring option or disables auto-renew where offered
  and reports `auto_renew_disabled`. If the issuer cannot mint single-use numbers, purchases
  on merchants that only sell auto-renewing terms are **refused outright** (`voided`,
  `outcome='auto_renew_unavoidable'`), including for owner-approved rows — the owner may buy
  such a listing manually outside the system and record it as a `human` attempt with its own
  renewal date. No purchase is ever left depending on a future job to prevent a charge.
  Intentional renewals are produced by a **renewal job** that, `renewal_lead_days` (default 21)
  before a paid placement's `renews_at`, re-runs the §6.3 decision on the *current* D30
  evidence and price, and creates a `purchase_kind='renewal'` reservation for that period
  under the same lock/budget/idempotency rules — or lets the listing lapse
  (`agent_state='watching'`) if the policy no longer authorizes it. A renewal never charges
  without its own reservation and, where the merchant does not support one-off renewal, its
  own owner approval.
- **A reservation is charged against the month it is submitted in.** The
  `reserved → submitting` transition (under the budget lock) first compares the row's
  `budget_month` with the current ET month; if the month has rolled over since reservation,
  the row is `voided` and a fresh reservation is attempted under the **new** month's lock and
  budget (same idempotency rules, new `budget_month`) before anything continues — a
  reservation can never consume last month's ledger while the card is used this month, so the
  two months' ceilings cannot stack.
- **`submitting` before the external call — non-retryable.** Immediately after that
  validation (the last point at which nothing has been charged) the row is `submitting`
  (conditional on the lease and prior state; `submitting_at = now`). Only a `submitting` row
  exposes the card to the provider. Where the merchant supports it the
  `merchant_idempotency_key` is sent with the checkout. From `submitting` the ONLY
  transitions are `charged` (success reported with `merchant_ref`), `voided` (provider
  proves the merchant rejected before capture), or `ambiguous`.
- **Crash = ambiguous, never re-submit.** A worker that dies after `submitting` leaves the
  row in `submitting`; the hourly lease-expiry sweep moves any `submitting` row older than the
  lease TTL to `ambiguous` and marks its attempt `payment_ambiguous`. `claim()` never leases a
  placement whose purchase is `submitting` or `ambiguous`, so a reclaimed lease cannot
  re-submit the same checkout. A reported timeout/disconnect after submission →
  `ambiguous` directly.
- **Ambiguity is reconciled, not retried.** `ambiguous` rows count against the month's
  budget and are cleared only by `reconcile` (card-issuer transaction lookup by
  `merchant_idempotency_key`/amount/time, or the owner card) → `reconciled_charged` /
  `reconciled_not_charged`. A `reserved` row whose attempt fails *before* `submitting` is
  `voided` in the same report and releases its budget.
- **Lease safety.** Every purchase transition is conditional on the lease AND on the exact
  prior state (`reserved→submitting`, `submitting→charged|voided|ambiguous`); a stale lease
  or a wrong prior state affects 0 rows and returns 409.
- **Instrument.** One dedicated **virtual card with a hard monthly limit** is the only payment
  method the runner can use; the bank's limit is a second, independent ceiling — it is not the
  policy. Owner-approved purchases above `max_auto_purchase_cents` go through the same reservation
  after the click. `seo_link_attempts.cost_cents` mirrors `final_cents` for reporting only.

### 6.4 Bounded outreach mandate (replaces v1 §9's permanent manual valve)

Auto-send when **all** hold: authority `AUTO_OUTREACH`; score ≥ `auto_outreach_min_score`;
`comms-lint` clean; recipient is a business inbox (never a customer); the draft contains no
reciprocal promise, payment, discount, guarantee, or unusual commitment (drafter classifier +
lint rule); the recipient passes the fail-closed customer exclusion (§13); and the day's sends <
`auto_outreach_daily_cap`. Anything else → the existing approval queue. Sender, idempotency
and `send_error` reconciliation are the shipped `link-prospect-outreach.js`; its one change
is that the cap check inside its existing advisory-lock claim transaction enforces
`min(policy.auto_outreach_daily_cap, LINK_OUTREACH_DAILY_CAP)` for auto-sends (owner-approved
sends keep the hard cap only) — the policy cap is never checked outside that lock, so
concurrent auto-sends cannot exceed it. Follow-ups (one, +10 days, only if no
reply) go through the same gate.

The 56 drafts from June are the first batch through this mandate (self-disqualifying and
national-magazine drafts fail the lint/score floor; the Sunrise cluster dedupes by domain
under `claimProspectDomain`).

---

## 7. Hands — providers behind the existing contract

`claim → act → report` stays exactly as shipped (`/api/integrations/backlink-worker/*`):
`claim` leases `prospect` rows (`FOR UPDATE SKIP LOCKED`), `report` moves to `placed` /
`drafted` / `failed` / `skipped` and now also `needs_owner`, requires `live_url` for `placed`,
rejects stale leases. **The board does not care which provider did the work.**

```ts
interface BrowserAgentProvider {
  investigate(domain, hints): PathCandidate[]          // optional; the investigator may delegate
  createAccount(path, identity, inbox): Session
  completeForm(path, identity, session): FormResult
  submit(path, session): SubmitResult                  // returns live_url when known
  resumeSession(path, session, ownerDecision?): SubmitResult
  captureEvidence(session): { evidence_url }
}
interface OutreachProvider { draft(prospect, research): Draft; send(draft): SendResult; followUp(prospect): Draft }
```

Implementations, in order:
1. **`deterministic_runner`** — the existing `signup-runner.js` (Playwright + form filler),
   extended for `account_required`, `email_verification` (IMAP verifier), `payment_required`
   (virtual card, only under `AUTO_PAID_WITHIN_POLICY` or after owner approval), and
   **resumable sessions** (persisted browser state per `domain_id`).
2. **`openai_cua` / `claude_cu` / `stagehand` / `grok`** — same interface, run in the
   benchmark (§10). A provider never receives credentials it does not need and never
   receives the Waves identity beyond the canonical NAP packet the contract already sends.
3. `human` — Adam completing a step from the owner card; recorded as an attempt like any other.

Provider selection per attempt is a policy field (`preferred_provider`, plus per-path override
learned from attempt outcomes). Outreach: `OutreachProvider` = drafter + `link-prospect-outreach`.

---

## 8. Judge — verification, D30, and the learning loop

- **Verification** is unchanged and authoritative: verifier (crawl + DataForSEO, scan-tracked
  rows only), indexer (`site:` SERP), profile cross-link, `first_live_at`, `is_dofollow` read
  from live `rel`. A provider report never sets `live`.
- **D30 survival** = placement `live`/`indexed` at `first_live_at + 30d` (and again at D90).
  Derived nightly from `last_live_check` + `seo_backlink_events`; stored on the placement
  (`d30_live`, `d90_live`) — this is the only success metric that counts.
- **Learning:** nightly aggregate `persistence` and `index_rate` per `(source, acquisition_type)`
  and per `domain` into `seo_link_learning` (small table, replaced each night). The scorer reads
  them:

```
Expected Link Value  ≈ quality(DR, traffic, spam, relevance)
                       × P(index | path, domain)
                       × P(live at D30 | source, path)
Acquisition Efficiency ≈ Expected Link Value / (cash cost + agent cost + owner effort)
```
Normalized 0–100; no fake-dollar SEO valuation. `best_path_id`, queue order, and the
authority thresholds all read Expected Link Value, so the system answers *"where do the next
$100 and the next 10 agent actions go?"* from evidence. Reporting (Agent tab): Source ×
qualified × acquired × indexed × live-D30 × median DR × cost per D30 domain; the same by path.

---

## 9. Recursive discovery

After a domain reaches `acquired` (or is ingested as `existing_backlink`) with a best path
of `acquisition_type` in (`self_service_free`, `self_service_account`, `paid_listing`,
`business_claim`, `membership`, `association`, `vendor_registration`) — i.e. any
listing-style placement where other businesses are visible: read its co-listed businesses from
the placement page (`fetchPage`), take the strongest N (DataForSEO bulk rank), run
domain-intersection on them, and feed common referring domains into intake as
`source='recursive'`, `source_ref = originating seo_link_domains.id` (UUID, per §3.1),
`source_detail = originating domain` (display). Capped per week; behind
`GATE_LINK_RECURSIVE_DISCOVERY` and `GATE_SEO_INTELLIGENCE`. The lineage lets the Source table show which seeds *generated*
durable links, not just which produced one.

---

## 10. Provider benchmark

Two phases, because an acquisition action is irreversible and the board allows one
conversation/placement per domain:
1. **Replay phase (non-submitting, technically enforced):** every provider runs
   `investigate()` and `completeForm()` on the same domains inside a **replay sandbox** that
   is non-mutating by construction, not by HTTP method: the browser context's request
   interception allows ONLY requests it can classify as read-only — top-level navigations
   recorded during the investigator's own crawl, same-origin GETs for static assets
   (script/style/image/font) — and **fails closed on everything else** (any POST/PUT/PATCH/
   DELETE, any GET to a URL not in the recorded read set, form submissions by any method,
   `sendBeacon`, WebSocket, third-party XHR), answering with a synthetic 204 and recording the
   blocked request as replay evidence. Where a provider cannot run under that interception
   it runs against a **no-egress fixture** (the investigator's saved page snapshots served
   locally) instead. So page JavaScript, GET-action confirmation links, autosaves and agent
   mis-clicks cannot create an account, send a message or start a checkout; the identity
   packet is a **non-production
   test identity and inbox** (never the canonical NAP, never `HERMES_SIGNUP_EMAIL`); no card
   is minted; the session is discarded. Outputs (fields, path, evidence) are scored against
   the investigator's ground truth and each other. Replay attempts are `sandbox=true`.
2. **Cohort phase (live):** qualified domains are split into **disjoint, matched cohorts**
   (stratified by path type, DR band, lane), one cohort per provider; exactly one provider
   performs the irreversible action for any domain, through the normal guard/ledger. D30 is
   measured per cohort.
Score:
verified dofollow + indexed + live at D30 (40, cohort phase), no human step (20), correct
fields (10, replay phase), time (10), cost (10), recovery from UI change (5), evidence quality
(5). Results are rows in `seo_link_attempts` (replay rows flagged `sandbox=true` and excluded
from D30/learning); the Agent tab shows the table. No provider is chosen by preference —
`preferred_provider` follows the numbers.

---

## 11. UI — Agent tab (existing panel, extended)

1. **Add opportunities** box (§4) + list import (CSV upload = same endpoint).
2. **Registry** table: domain, DR/traffic/spam, competitors linked, best path (type · cost ·
   expected rel), score + reasons, agent state, provenance; row → paths + attempts + evidence;
   *Acquire anyway* / *Watch* / *Reject*.
3. **Owner queue**: `awaiting_owner` cards (§6.3) — Approve / Reject / Watch.
4. **Policy** panel (§6.2) — the only place thresholds change; every change is logged.
5. **Outcomes**: Source × funnel × D30 and Path × funnel × D30 (§8); provider benchmark (§10).
Link Building board and outreach approvals remain as shipped.

---

## 12. Gates, env, kill switches

Existing: `GATE_SEO_INTELLIGENCE` (all DataForSEO spend), `GATE_BACKLINK_AGENT`,
`GATE_HERMES_WORKER` + `HERMES_SERVICE_TOKEN` (claim/report), `GATE_SIGNUP_RUNNER` +
`SIGNUP_RUNNER_ALLOWLIST`, `GATE_OUTREACH_DRAFTER`, `GATE_LINK_OUTREACH` +
`LINK_OUTREACH_DAILY_CAP`, `HERMES_SIGNUP_EMAIL`.

New, all **default OFF in prod**: `GATE_LINK_INVESTIGATOR` (investigator job),
`GATE_LINK_AUTHORITY` (the policy engine may grant any `AUTO_*`; off ⇒ everything
`awaiting_owner`), `GATE_LINK_AUTO_PAID` (separately arms `AUTO_PAID_WITHIN_POLICY`),
`GATE_LINK_RECURSIVE_DISCOVERY`. The runner's allowlist is superseded by the registry's
`ready_to_acquire` set once `GATE_LINK_AUTHORITY` is on (the registry *is* the allowlist);
until then `SIGNUP_RUNNER_ALLOWLIST` stays authoritative. Kill for any lane = unset its gate;
budget kill = the virtual card's limit.

---

## 13. Guardrails (must ship with each step)

- **SSRF** — every fetch through `contact-finder.fetchPage()`; providers run in their own
  sandbox and receive URLs, never portal network access.
- **Comms** — outreach targets are businesses. Today `link-prospect-outreach` only validates
  recipient *syntax*; step 4 adds a **fail-closed customer-recipient exclusion** before any
  auto-send: the recipient email (and its domain, when the domain is a customer's own) is
  checked against `customers` / `customer_contacts` / lead records inside the send claim, a
  match or a lookup error routes the draft to the approval queue, and the check is unit-tested.
  The June drafts are released only through this path.
- **PII / secrets** — credentials encrypted, never in attempts/evidence/logs/prompts;
  Twilio/Gmail errors logged by code only; identity packet = canonical NAP only.
- **Footprint** — daily caps on sends and submissions; one conversation per inbox
  (`claimProspectDomain`); signup lanes coexist per location by design; no templated blasts.
- **ToS / CAPTCHA** — a CAPTCHA or explicit-consent step is `outcome='captcha'` →
  `awaiting_owner` (never solved by an agent); paid-link-only "sponsored" slots are stored
  with `expected_rel='sponsored'` and scored accordingly.
- **Money** — only the dedicated virtual card; hard limit at the bank; every charge is an
  attempt row with cost; owner approval is a portal click.
- **Truth** — a provider report is a claim; the Judge promotes; `merged`/`lost` semantics
  from #3544 apply to everything acquired.

---

## 14. Build order (PR boundaries)

1. **Registry + paths + provenance + statuses** — migrations for §3.1–3.5, `awaiting_owner`/
   `watching`, `domain_id/path_id/authority` on prospects, intake endpoint skeleton
   (normalize/dedupe/upsert only). Docs-tested with contract tests on the guard.
2. **Bulk intake** — paste box + CSV import + competitor-gap ingestion job + existing-profile
   baseline. `Backlinks.csv` enters here as `list_import` / `backlinks_csv_2026_08`.
3. **Path investigator** — job + schema-validated LLM call + probe list + cost caps;
   `GATE_LINK_INVESTIGATOR`. Run it over the full gap ingestion; ship the Registry view.
4. **Authority policy** — `seo_link_policy`, decision function + tests, owner cards,
   Policy panel; `GATE_LINK_AUTHORITY`. Bounded outreach mandate (§6.4) lands here and
   releases the June drafts through it.
5. **Runner extension** — account creation + IMAP verification + resumable sessions +
   payment step (virtual card) + `needs_owner` outcome; `GATE_LINK_AUTO_PAID`.
6. **Provider interface + benchmark** — `BrowserAgentProvider`, adapters, benchmark table.
7. **D30 loop** — `d30_live/d90_live`, `seo_link_learning`, scorer terms, Outcomes view.
8. **Recursive discovery** — `GATE_LINK_RECURSIVE_DISCOVERY`.
9. **Budget optimization** — queue ordering by Acquisition Efficiency; monthly report.

Each step is dark-shipped behind its gate, reversible, and independently useful. Steps 1–3
move no money and send no communications, but they are not free: step 1 runs migrations at
deploy (additive, reversible); step 2 writes registry rows and spends DataForSEO credits
(`GATE_SEO_INTELLIGENCE`; intake ships with a `dryRun` that reports what it would upsert);
step 3 spends fetches + LLM calls (`GATE_LINK_INVESTIGATOR`, batch-capped, `dryRun` first).
Production enablement is explicit per gate, in that order, after each step's review.

---

## 15. What v1 got right (retained by reference)

- §2 invariants and "verify, don't trust" — unchanged.
- §4 reconciliation jobs (verifier 04:30 ET, indexer 05:00 ET, profile cross-link) — unchanged.
- §14 dual-ROI target taxonomy: Tier 1 realtor / inspector / property-manager / complementary-
  service partnerships (WDO wedge); Tier 2 local media + HARO with seasonal hooks and the Pest
  Pressure engine as the linkable asset; Tier 3 chambers / sponsorships; Tier 4 NPMA / FPMA /
  UF-IFAS / BBB; Tier 5 citations. Tiers now inform *quality* and `link_type`; they no longer
  decide *permission* — §6 does.
- `link_type` enum, board columns, Link Building smart views — unchanged.

Superseded: v1 §5 (Hermes Docker worker), §9's permanent manual send valve, §11 Playwright
cutover (replaced by the provider race), v1 open decisions 2–3.

## 16. Open decisions

1. Reconciliation source for `ambiguous` purchases: card-issuer transaction API vs. owner
   card only — decide at step 5 (issuer choice in 2 below determines it).
2. Virtual card issuer for the acquisition budget — must support single-use per-purchase
   numbers with a hard monthly program limit (§6.3); Adam.
3. `auto_outreach_daily_cap` starting value (proposal: 10; hard ceiling stays
   `LINK_OUTREACH_DAILY_CAP=12`) — Adam, at step 4.
4. Whether `OWNER_MEMBERSHIP` cards should batch weekly (one digest) or ring per card — Adam.
