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
| Worker contract | `GET /api/integrations/backlink-worker/claim`, `POST …/report` (`link-prospect-worker.js`, `hermes-auth.js`, `GATE_HERMES_WORKER`, `HERMES_SERVICE_TOKEN`) | The `claim → act → report` boundary. Route shape and report semantics kept; AUTHENTICATION IS REPLACED in step 1 — `hermes-auth.js` bearer + `HERMES_SERVICE_TOKEN` retired, per-provider HMAC request signing (§12) — with an ORDERED ROLLOUT because the callers are not all in this repo (`waves-outreach-drafter-skill.md` is; the `waves-backlink-worker` signup skill lives in the external Hostinger Hermes dashboard and cannot be changed atomically with a server deploy): (a) step 1 ships HMAC verification and ACCEPTS BOTH credentials for the `hermes` identity only — a bearer-authenticated request is capability-limited exactly like the HMAC `hermes` key (claim/report, no payment or credential capability) and every accepted request — INCLUDING an empty claim — writes a `seo_link_worker_requests` row (§3.4c: key id, provider, `auth_scheme` 'hmac' | 'bearer', endpoint, result) before the handler runs, so no accepted poll can go unrecorded; (b) the same PR ships the signing helper (`docs/hermes/sign-request.py`: `LINK_WORKER_SECRET_HERMES` from a mounted secret file, canonical target + raw-body hash, timestamp + nonce) and updates the in-repo drafter skill; the dashboard signup skill is migrated by hand from the same helper and VERIFIED by `seo_link_worker_requests` showing its claims arriving as `auth_scheme='hmac'`; (c) bearer acceptance on the backlink route is removed by a follow-up PR only after `seo_link_worker_requests` shows zero `auth_scheme='bearer'` rows for 7 consecutive days (empty claims included — a polling worker with nothing to do still writes rows); the `HERMES_SERVICE_TOKEN` env is NOT unset by that PR — `hermesAuth` is shared with `integrations-vendor-price-worker.js` and `integrations-vendor-login-worker.js` (503 when the env is unset), which get their own signed credential and their own audit rows first; the env goes only when every `hermesAuth` mount shows 7 bearer-free days (§14 step 1b) — a dated milestone in §14, never a same-PR delete — and v2 puts providers behind it (§7) |
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
// agent_state is an AGGREGATE over the domain's placements, recomputed by the bridge job / on every placement transition:
//   ready_to_acquire = ≥1 placement stamped AUTO_* or approved and still 'prospect'   (stays/returns here while ANY authorized placement is pending — e.g. a second GBP location)
//   acquiring        = ≥1 placement leased, `placed` (submitted, awaiting the Judge's verification), `contacted`/`negotiating` (pitch out, reply/checkout pending), or parked at a handoff (`ready_for_credentials`/`ready_for_payment`) and none pending-unleased — every active intermediate status keeps the domain claimable for its follow-on payment/credential/follow-up work
//   acquired         = ≥1 placement live/indexed and no authorized placement pending
//   watching         = NO placement live/indexed, none authorized-pending, and ≥1 placement lapsed (renewal not re-authorized) or lost with a recheck scheduled — never set directly by a single placement's lapse
// Claimability is decided per PLACEMENT (§7): the registry must merely not be new/investigating/not_reproducible/rejected/watching.
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
t.integer('estimated_cost_cents'); t.integer('renewal_cost_cents'); t.string('renewal_period'); // annual|monthly|none
t.uuid('currency_attestation_id');               // → seo_link_currency_attestations (immutable owner USD attestation, §6.1); a payment input; the live currency guard accepts it only while unrevoked and only for the identical merchant_binding hash
t.string('fee_scope');                            // CHECK (fee_scope IS NULL OR fee_scope IN ('per_location','account_wide')); REQUIRED (NOT NULL via CHECK) when payment_required — investigator output; a payment input for revision_payment and every payment hash/snapshot (§7 bridge: account_wide ⇒ one purchase shared by the payment group). A re-investigation that CHANGES fee_scope after placements exist is an in-place payment revision PLUS an atomic REGROUP: with no purchase in any state for the group, the bridge re-assigns `payment_group_id` for every sibling in one transaction (per_location ⇒ each its own id; account_wide ⇒ the first placement's id) and re-decides the payment dimension; once any purchase exists the change is NOT applied automatically — the payment dimension of every affected placement parks `awaiting_owner` with a fee-scope review card (`OWNER_INPUT_REQUIRED` flavour) and the owner's review click performs the regroup, so the group-keyed duplicate guard can neither block a legitimately separate fee nor allow a duplicate account-wide charge
t.string('currency').notNullable().defaultTo('unknown'); // CHECK (currency IN ('USD','unknown','foreign')) — 'foreign' = a confirmed non-USD marker (never automated; §6.3 ⇒ OWNER_MANUAL_PAYMENT), 'unknown' = no/uncertain marker (⇒ price-entry card) — set by the investigator's currency gate (§5); an AUTOMATED reservation exists only for 'USD' — 'foreign' stays a VALID path routed to OWNER_MANUAL_PAYMENT (manual settlement only), 'unknown' parks for price entry; a payment input for revision_payment and every payment hash/snapshot
t.jsonb('merchant_binding');                      // CANONICAL, revisioned (part of revision_payment): { checkout_origin, processor: { host, merchant_account_id }, issuer_merchant_descriptor } as observed by the investigator on the checkout chain; nullable: a paid path MAY qualify without a valid binding — it then can only ever be decided payment=OWNER_MANUAL_PAYMENT (§6.3) and never reaches an automated reservation (fail-closed there); when present, the reservation copies THIS field into the purchase's immutable merchant_binding — never the descriptive `investigation` blob — integer cents, parsed ONCE by the investigator from the quoted price text (kept verbatim in `investigation`); never decimal, never re-parsed downstream
t.boolean('account_required').notNullable(); t.boolean('email_verification').notNullable(); t.boolean('payment_required').notNullable();
t.boolean('legal_attestation').notNullable();     // signed agreement / vendor terms / W-9 etc.
t.boolean('terms_accepted_by_send').notNullable().defaultTo(false); // investigator output (required in its JSON schema): true only when sending the outreach email ITSELF legally accepts the agreement, in which case accept_terms gates outreach_send too (§3.3b); a communication input — in revision_communication, the communication decision hash and approval snapshot, re-validated at the send claim
t.boolean('execution_after_send').notNullable().defaultTo(true); // investigator output (required in its JSON schema; asserted a literal boolean by §6.3 validity): on an EXECUTION-BEARING outreach path (communication AND an `acquire` instance — `account_required` or a form/`content_submission` submit) it ORDERS the two required actions for the §7 claim predicate and the §3.3b prerequisite graph — true = the publisher's form/account step follows the pitch (`mode=send` first), false = the submission precedes the pitch (`mode=acquire` first, the initial send is a LATE SEND on a Judge-owned row, §6.4); ignored (always stored, never consulted) on every other path. A communication AND execution input — in revision_communication AND revision_execution, both dimensions' decision hashes and approval snapshots, re-validated at the send and acquire claims (a flip after an authority row exists invalidates both dimensions like any other in-place input change — but ONLY while NEITHER ordered action of the current cycle has completed: once the send has a terminal `sent` or the acquire's submit succeeded, an in-place flip is REFUSED and the re-investigation instead SUPERSEDES the path (§ supersession below), whose instance rotation/carry rules migrate the placement — a completed cycle's lifecycle status is never re-interpreted under the opposite ordering)
t.text('legal_terms_hash');                       // sha256 of the canonicalized agreement/attestation text the investigator fetched (URL kept in `investigation.legal_terms_url`); REQUIRED when legal_attestation=true (§6.3 validity: true + null hash ⇒ INVALID); part of every dimension's inputs hash and approval snapshot; the runner re-fetches and re-hashes the agreement IMMEDIATELY before any accept/sign step and refuses on mismatch (attempt `outcome='terms_changed'`, approval invalidated reason 'terms_changed', placement → awaiting_owner with a fresh card showing the diff; the `terms:n` execution instance is ENDED (`end_outcome='terms_changed'`) and `terms:n+1` opened in the same transaction, so the retry writes a NEW attempt row (`…:accept_terms:terms:${n+1}`) instead of colliding with the proven-pre-mutation `terms_changed` row and being misread as `mutation_ambiguous` — and, in the SAME transaction, the newly fetched canonical terms are persisted through a trusted path revision: `legal_terms_hash` + `investigation.legal_terms_url` updated, `revision_payment`/`revision_communication`/`revision_execution` bumped as the hash is an input of each, so the replacement card and any approval created from it bind the NEW hash and the next attempt's re-fetch matches)
t.boolean('agent_completable').notNullable();     // investigator's judgement: can the runner finish alone
t.boolean('baseline').notNullable().defaultTo(false); // existing-backlink import placeholder (§4): descriptive only, never executable
t.string('provider_override');                    // per-path OWNER override of policy.preferred_provider (CHECK against the provider enum); written ONLY by an audited owner edit — the benchmark/learning job writes its recommendation to `investigation.provider_recommendation` (advisory) and never switches providers itself; claim uses COALESCE(path.provider_override, policy.preferred_provider); payment steps ignore it (deterministic_runner only)
// All authority-relevant flags are NOT NULL: the investigator must answer each explicitly (its JSON schema requires them);
// §6.3's validity step also asserts they are literal booleans and consistent with the type (paid_listing/membership/
// association/sponsorship ⇒ payment_required; self_service_free ⇒ NOT payment_required; not_reproducible/unknown ⇒ INVALID).
t.string('expected_rel');                         // dofollow | nofollow | sponsored | unknown
t.string('expected_indexability');                // indexable | noindex | unknown
t.string('expected_persistence');                 // durable | rotating | unknown  (+ learned D30 in §8)
t.string('link_type').notNullable();              // board lane the placement will carry; CHECK (link_type IN CLAIMABLE_LINK_TYPES — editorial|resource|guest_post|haro|directory|citation|social) so a path can never qualify with a lane the worker cannot lease (§6.3 validity also asserts it)
t.numeric('confidence', 3, 2);                    // 0–1 — CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)); pg returns NUMERIC as a STRING — every reader (§6.3 validity, floors, scorer) normalizes with `Number(path.confidence)` before `Number.isFinite`/comparisons (a shared `readPath()` accessor does it once; tests assert the string '0.70' passes); the investigator's JSON schema and the §6.3 validity step assert the same range (a value outside [0,1] ⇒ INVALID), so a malformed confidence can never clear a floor
t.integer('revision').notNullable().defaultTo(1);  // display/global counter: +1 whenever ANY in-place authority- or approval-relevant field changes (acquisition_type / submission_url changes supersede the row instead — see above)
t.integer('revision_payment').notNullable().defaultTo(1);        // +1 only on payment inputs: estimated_cost_cents, renewal_cost_cents, renewal_period, currency, currency_attestation_id (+ its row hash), fee_scope, payment_required, legal_attestation, legal_terms_hash, merchant_binding
t.integer('revision_communication').notNullable().defaultTo(1);  // +1 only on communication inputs: link_type, expected_rel, legal_attestation, legal_terms_hash, terms_accepted_by_send, execution_after_send (recipient/draft live on the approval hash)
t.integer('revision_execution').notNullable().defaultTo(1);      // +1 only on execution inputs: account_required, email_verification, agent_completable, legal_attestation, legal_terms_hash, execution_after_send
// Approvals and authority rows bind to THEIR dimension's revision (§3.3b/§3.6b); a price change bumps revision_payment
// only, so a satisfied communication approval is untouched. Purely descriptive fields (confidence, investigation, last_investigated_at, authority_last_decided) do not bump it. Approvals bind to it (§3.6b) and the authority job re-decides on every bump.
t.string('authority_last_decided');               // informational copy of the latest §6 decision; NOT versioned, NOT approval-bound — the binding stamp lives on the placement
t.jsonb('investigation');                         // evidence: pages fetched, form fields seen, price text, quotes
t.timestamp('last_investigated_at');
t.timestamps(true, true);
t.text('path_key').notNullable();                 // `${acquisition_type}:${normalized submission_url || '-'}` — non-null, so re-investigation upserts instead of duplicating (Postgres UNIQUE treats NULLs as distinct)
t.uuid('superseded_by');                          // → the path row that replaced this one (explicit predecessor match only — §3.2 identity rule); a superseded path is never claimable; credentials/sessions keyed to the old path are rebound to the new one in the same transaction (same account) or left for a fresh account when the investigator says the login changed
t.timestamp('superseded_at');
// uniqueness applies to ACTIVE paths only: partial unique index ON (domain_id, path_key) WHERE superseded_by IS NULL —
// a superseded row keeps its key for history, and a path seen again later (A → B → A) is a NEW active row
// (fresh id, revision 1, no approvals carried; the superseded A's approvals stay invalidated)
// IDENTITY vs REVISION: acquisition_type and submission_url ARE the identity (path_key). Several ACTIVE paths per
// domain are normal (a directory listing AND a sponsorship); a newly observed type/URL is simply ADDED alongside them.
// Supersession happens ONLY when the investigator explicitly matches a predecessor (`replaces_path_id`: it observed the
// old submission_url gone/redirected/renamed to the new one, or the same form under a new URL). In that case it inserts
// the new path and, in the SAME transaction, marks the matched old one superseded_by it, invalidates every OPEN approval on the old path (reason 'path_superseded') — a SATISFIED instance is carried across ONLY when its completion is path-independent — a sent communication, a settled payment (the money left; §6.3 path_retry governs re-fees) — re-linked to the new path with `carried_from_path_id` kept for audit (the §3.6b current-path check applies only to open, unsatisfied instances); a satisfied `accept_terms` instance is carried only when the new path's `legal_terms_hash` EQUALS the accepted one, otherwise it is ended (`end_outcome='terms_changed'`) and a fresh `terms:n+1` instance opened so B's terms are approved and accepted before B's final submit, so an already-sent pitch still satisfies the later paid checkout/follow-up prerequisite and a `contacted` placement never needs to re-enter the initial send flow —
// repoints its placements (path_id → new; every OPEN, UNSATISFIED authority instance on the old path is ENDED (`end_outcome='path_superseded'`) and a NEW generation of the same kind opened atomically — so mutation idempotency keys (`…:create_account:${instance_key}`) rotate with the path and path B never mistakes A's `account_created` row for its own; satisfied instances are carried, see below → the bridge job re-decides the new generation), and voids any `reserved`
// purchase on it — UNLESS a placement has a post-exposure purchase open (`submitting`/`close_pending`/`ambiguous`) OR ANY attempt in `submitting`/`sending`/`mutating`/`submit_ambiguous`/`send_error`/`mutation_ambiguous` that is not yet reconciled — lease state is irrelevant (the shipped sender clears `claimed_at` before calling Gmail, so post-report ambiguity has no lease; the unresolved external action is what pins):
// that placement stays PINNED to the old path: the old path is marked `superseded_by` = new path immediately (so no
// NEW work can start on it), and the placement records `pending_path_id` = new path (durable FK on seo_link_prospects,
// nullable) instead of being repointed; purchases/reconciliation are explicitly permitted to complete against a
// superseded path (state-locked transitions check the purchase's own path_id, not "non-superseded"). When the
// purchase settles AND no pinning attempt remains unreconciled (`submitting`/`sending`/`mutating`/`submit_ambiguous`/`send_error`/`mutation_ambiguous` — issuer settlement proves only the money side; a concurrent ambiguous submit/mutation may still have taken effect on the OLD path), the resolving transaction — the settlement, or the later attempt reconciliation, whichever clears the LAST pin — repoints `path_id := pending_path_id`, clears it, and lets the bridge
// re-decide; it writes the paid term from the purchase's snapshot ONLY when the settlement is a charge
// (`charged` / `reconciled_charged` / `manual_charged`) — `reconciled_not_charged` completes the repoint and frees a
// new generation but never grants a term. After a restart the sweep finds every
// placement with a non-null pending_path_id, no open purchase AND no active or ambiguous execution/communication attempt (`submitting`/`sending`/`mutating`/`submit_ambiguous`/`send_error`/`mutation_ambiguous` unreconciled) and finishes the repoint. Old terms can therefore never execute AND a settling checkout never lands on a
// different path. Changes to the other authority-relevant fields edit in place and bump `revision` (§ below).
// Either way, nothing can execute under the old terms: claim requires a non-superseded path whose revision AND
// identity match the approval.
```

### 3.3 `seo_link_prospects` — placements (existing; additive columns)

**`pending` is NOT a status.** The retained moderated-submission flow (§7) stores a pending
submission as `status='placed'` with the existing `pending:true` flag and no `live_url`; wherever
this document says "`placed` (pending-flagged or not)" it means that single status value, and no
status constraint, `PROSPECT_STATUSES` entry, `CLAIM_MODE_STATUSES` set or transition ever
names a `pending` status. The four statuses v2 ADDS are exactly `awaiting_owner`, `watching`,
`ready_for_credentials`, `ready_for_payment`.

```js
t.uuid('domain_id').references('seo_link_domains.id');
t.uuid('path_id').references('seo_link_acquisition_paths.id');
t.string('parked_from_status');  // the status a row held before parking as awaiting_owner/watching; restored on approval/resume (§7)
t.timestamp('conversation_closed_at'); // durable outreach-conversation closure (§13 recipient guard): stamped when the placement goes lost/rejected, or when it is live/indexed AND its communication lifecycle is COMPLETE — and in EVERY case only once no send is `sending` or unreconciled `send_error` (Gmail may have delivered; the Sent-folder reconcile must finish first — the reconciling transaction stamps the deferred closure) — every required send has a terminal outcome (in particular an execution_after_send=false path whose late initial send has not yet happened keeps the conversation OPEN through Judge promotion, §7) and no follow-up is due/drafted/sending — or when the lane completes with no reply window left (follow-up sent/skipped + 45 ET days since last send, no inbound match); the recipient guard and its partial unique index require it NULL, so a finished conversation releases the inbox; cleared in exactly ONE case: atomically in the transaction that opens a verified-loss RECOVERY cycle on this same placement (§3.3b reopens its authority instances — the reopened outreach lane must retake the inbox guard like any open conversation); otherwise never — a new conversation is a new placement
t.string('leased_provider'); t.string('lease_mode'); t.string('lease_action'); // CLAIM BINDING (§7 report guard): written with the lease token in the claim transaction, cleared with it on report/expiry sweep; /report is accepted only from leased_provider with an outcome valid for lease_mode/lease_action
t.text('handoff_lease_token');   // the token of the lease that reported ready_for_credentials/ready_for_payment — lets the successor claim re-bind that lease's slot_reserved attempt (§7); cleared when the successor claim commits
t.uuid('payment_group_id');      // paid placements only: the group whose purchases cover this placement — for fee_scope='per_location' = the placement's own id; for 'account_wide' = the FIRST placement's id on the shared account (§7); every purchase, payment-authority satisfaction, renewal and duplicate guard is keyed by THIS, never by prospect_id alone
t.string('renewal_status');      // CHECK (renewal_status IS NULL OR renewal_status IN ('active','lapsed')) — paid placements only; 'lapsed' = the renewal job declined to re-authorize (§6.3); placement-level, never the domain
t.timestamp('renewal_recheck_at'); // when the verifier/renewal job next re-examines a lapsed placement (placement-level counterpart of the domain's watch_recheck_at)
t.uuid('credential_id');         // → seo_link_credentials: the account this placement acts under (explicit; never inferred from domain)
t.uuid('pending_path_id');       // → seo_link_acquisition_paths: the replacement path a superseded placement will be repointed to once its open post-exposure purchase settles (§3.2)
t.string('location_key').notNullable().defaultTo('-'); // GBP location for per-location signup placements (Bradenton, Sarasota, …); '-' = not location-scoped. Replaces the runner's quality_signals.location identity (backfilled). Unique key becomes (target_domain, target_page, location_key) by EXPAND → CONTRACT, never a swap: step 1 (as #3577 already shipped) ADDS the three-column unique BESIDE the legacy (target_domain, target_page) one and every v2 writer upserts constraint-agnostically (`ON CONFLICT DO NOTHING` + re-read via findPlacementRow, no named conflict target); the remaining legacy writers that still emit `ON CONFLICT (target_domain, target_page)` — `lost-link-recovery.js`, `local-opportunity-promoter.js`, the runner's alreadyPlacedAt/quality_signals.location fallback, the PATCH probe — are migrated to an explicit/default `location_key` and the constraint-agnostic form in step 2 BEFORE the contract migration, which drops the two-column constraint only after those writers are deployed and old pods have drained (a named conflict target with no matching unique constraint is a Postgres error, and both are recurring jobs); findPlacementRow takes the location; outreach lanes always '-'
t.string('authority');            // SUMMARY only (the most restrictive dimension, for lists/cards); the binding record is seo_link_placement_authorities
t.text('source_detail');
t.date('paid_through');           // end of the term the last `charged` purchase bought (ET calendar day, copied from the purchase row)
t.date('renews_at');              // = the settling purchase row's own `paid_through` (date, ET); written on `charged`, `reconciled_charged`, `manual_charged` AND the settled zero-total completion (`voided`/`no_payment_required` with `settled_at`, §6.3) (its immutable terms_snapshot — never the path's current renewal_period); written atomically when a purchase reaches `charged` (i.e. after close confirmation) OR `reconciled_charged` (initial or renewal); cleared when the listing lapses; read by the renewal job
t.boolean('recurring_merchant').notNullable().defaultTo(false);
```
New statuses: **`awaiting_owner`** (parked on an owner decision: payment / membership / legal),
**`watching`** (unactionable today, rechecked) and **`ready_for_credentials`** (a
model-observed provider handed off at the credential boundary, §12; leasable ONLY by the
`deterministic_runner` via `claim(?mode=credentials)`) and **`ready_for_payment`** (the card boundary on a paid EXECUTION path — `paid_listing`/`membership`/… — reached by any provider: a durable handoff status, leasable ONLY by the `deterministic_runner` via `claim(?mode=payment)`, which for execution paths accepts this status exactly as it accepts `contacted`/`negotiating` for paid outreach, reserves the `initial` purchase at that moment and resumes the persisted session; the four statuses ship together). `PROSPECT_STATUSES` in
`admin-backlink-agent-v2.js` is the contract — all FOUR are added there, in the step-1
status migration/constraint, the domain guard (`ready_for_credentials` AND `ready_for_payment` join
`IN_FLIGHT_STATUSES` beside `watching` — so a paid execution placement parked at the card boundary still holds its domain against another placement/payment group — and `ready_for_credentials` also joins `ACTIVE_OUTREACH_STATUSES` beside `awaiting_owner`, so an outreach placement parked at the credential boundary still holds the domain's one conversation against a second writer — covered in `prospect-domain-lock.test.js`; signup lanes keep their location-aware coexistence), the board's status filters and the tests; the
worker's generic `claim()` never leases any of the three.
Both statuses join the board's domain guard in the SAME PR (step 1): `awaiting_owner` is added
to `ACTIVE_OUTREACH_STATUSES` in `prospect-domain-lock.js` — a parked outreach placement is
still the domain's one conversation, so `claimProspectDomain()` refuses a second writer that
proposes the same canonical host for another target page while one is parked (otherwise both
could be approved and contact the same inbox); `watching` is added to `IN_FLIGHT_STATUSES`
only (the recovery lane sees it; it is not an open conversation), and resuming a `watching`
row (restoring `parked_from_status`) is a board admission that runs through the same guard
exactly like the PATCH reopen — refused while ANOTHER row for the domain is in active
outreach; `claimProspectDomain()` gains an `excludeId` predicate (the row being resumed is
excluded from the in-flight probe, the advisory lock is kept) since with `watching` in
`IN_FLIGHT_STATUSES` the probe would otherwise always match the resumed row itself. `prospect-domain-lock.test.js` pins both sets.

### 3.3b `seo_link_placement_authorities` — one row per required dimension

```js
t.uuid('id').primary(); t.uuid('prospect_id').notNullable();
t.string('dimension').notNullable();   // CHECK (dimension IN ('execution','payment','communication'))
t.string('level').notNullable();       // CHECK (level IN (the §6.1 enum EXCEPT OWNER_OVERRIDE)) — the underlying decision; a waiver is referenced, never stamped as the level
t.uuid('approval_id');                 // NULL while an OWNER_* decision is pending (the bridge writes the row, the placement parks in awaiting_owner, the click creates the approval and fills this in); REQUIRED for CLAIMABILITY of any OWNER_* row (and a row with `floor_waiver_id` additionally needs that waiver valid), not for the row's existence; the referenced approval's `dimension` AND `instance_key` must equal this row's (enforced in the approval transaction)
t.uuid('purchase_id');                 // payment dimension only: → seo_link_purchases — the purchase whose settlement satisfies THIS row (per_location: the placement's own purchase; account_wide: the group's purchase, so every sibling row points at the same id); set when the purchase is reserved for this kind/generation; CHECK ((dimension = 'payment') OR purchase_id IS NULL); settlement satisfies exactly the authority rows whose purchase_id = the settled purchase id — never by prospect or group alone, so a void/retry/renewal can't satisfy the wrong instance
t.uuid('floor_waiver_id');             // → seo_link_floor_waivers when this dimension was decided under a floor waiver (§6.3 1b); `level` still holds the UNDERLYING decision — never OWNER_OVERRIDE — and the claim checks the waiver's validity in addition to the level
t.text('decision_inputs_hash').notNullable(); t.integer('path_revision').notNullable(); // the hash covers only THIS dimension's inputs; path_revision = the path's revision_<dimension>
t.string('instance_key').notNullable().defaultTo('-:1'); // the ACTION INSTANCE this row governs: `${kind}:${generation}` — kind '-' = initial acquisition/send, a renewal's renewal_period_key, or 'followup'; generation starts at 1 and the bridge opens `${kind}:${n+1}` when the previous instance ended in a NON-successful terminal outcome (`failed`/`skipped`/`send_error` reconciled as not sent) and a retry is warranted (re-investigation or owner "retry") — OR when the Judge records a VERIFIED LOSS of a successfully acquired placement (the retained `lost-link-recovery.js` reopen — EXTENDED in step 4: its `NON_OUTREACH_TYPES` skip at `lost-link-recovery.js:111-116` is removed so lost `SIGNUP_TYPES` rows (directory/citation/social, paid listings) are routed back to the runner through the same reopen instead of being ignored): the reopen starts a new recovery cycle with a fresh, unsatisfied instance for EVERY required authority row, each under its ORIGINAL action kind (`-:${n+1}` for acquire/send, `terms:${n+1}` for accept_terms, and — ONLY when the investigator's post-loss pass establishes that restoration requires a new fee — a fresh payment instance for `reacquisition`; when the purchased term is still active and the publisher restores without charge, the satisfied payment instance is PRESERVED untouched and only the execution/communication instances reopen, so a no-fee restoration is never blocked on an unsatisfiable payment prerequisite) — never collapsed to one `-` row, so the partial unique (prospect, dimension, instance_kind) holds and no required action is left without authority, so the replacement draft/acquisition needs its own decision and approval — each new instance is a NEW row that must be decided and, if OWNER_*, freshly approved; satisfaction never carries across instances; a successful instance (`placed`/`sent`) never gets a successor of the same kind EXCEPT through a verified loss (`end_outcome='lost'`), a completed human checkpoint (`end_outcome='human_step_done'`, §7) or a charged path that failed before going live (`end_outcome='path_failed_after_charge'`, §6.3 path_retry), each of which CLOSES it (`ended_at`, `satisfied_at` kept as history) in the same transaction that opens the successor generation — so there is never more than one open row per (prospect, dimension, kind)
t.timestamp('decided_at').notNullable(); t.timestamp('satisfied_at'); t.string('satisfied_reason'); // satisfied_at set when THIS instance's action completed; satisfied_reason = how (`sent`/`placed`/`charged`/`manual_charged`/`no_payment_required`/`human_step_done`/`group_purchase`), CHECK ((satisfied_at IS NULL) = (satisfied_reason IS NULL))
t.text('accepted_terms_hash');         // accept_terms instances only: the legal_terms_hash that was actually accepted, written in the same transaction that sets satisfied_at (CHECK (accepted_terms_hash IS NULL OR dimension = 'execution')); every final-submit claim compares it with the path's CURRENT legal_terms_hash and refuses on mismatch (§3.3b reopen applies)
t.timestamp('ended_at'); t.string('end_outcome'); // TERMINAL marker for an instance that finished WITHOUT success (failed/skipped/reconciled-not-sent/voided/superseded-by-next-generation) — written when the next generation is opened; the claim contract and the bridge's stale-row scan read ONLY rows with ended_at IS NULL (the current instance per (prospect, dimension, kind) — partial UNIQUE on that triple WHERE ended_at IS NULL), so an old failed instance never blocks or is re-decided (e.g. communication '-' after `sent`) — a satisfied instance is never re-decided; the next instance starts unsatisfied
t.string('instance_kind').notNullable().defaultTo('-'); // the `${kind}` half of instance_key, persisted explicitly ('-', a renewal_period_key, 'followup', 'terms') so the open-instance invariant is indexable
t.uuid('path_id');                     // → seo_link_acquisition_paths (SET NULL): the path this instance was DECIDED on. The registry mover never touches authority rows, so a supersession it applies after the bridge ran (at a lease release) is rotated by the next bridge run from this column — an unsatisfied instance whose path_id ≠ the placement's path ends `superseded` and the next generation opens; a satisfied instance is path-independent and keeps its original path_id for audit
t.unique(['prospect_id', 'dimension', 'instance_key']);   // full history
// partial UNIQUE (prospect_id, dimension, instance_kind) WHERE ended_at IS NULL — exactly ONE open (current) instance per kind; the claim contract, approval attach and the bridge's stale scan read only ended_at IS NULL rows
```
The bridge job writes one row per dimension the path touches — the dimensions are
mutually exclusive by path type except for payment: **communication** for outreach/content
types (their only non-payment dimension: the send click's `outreach_send` approval satisfies
it and NOTHING else), **execution** for every other type (self-service, account,
business-claim, membership, vendor registration, human steps), **payment** in addition
whenever `payment_required`, and — for a `legal_attestation=true` path of ANY type, outreach
included — a separate **execution-dimension `accept_terms` authority row** (level per `policy.legal_attestation_requires_owner`: `OWNER_LEGAL` by default, else the normal `AUTO_*`/`OWNER_*` execution rules) whose approval, when owner-gated, is
bound to `legal_terms_hash`; the send approval never satisfies it (§3.6b). An outreach
placement therefore carries execution rows exactly per its REQUIRED ACTIONS — an `acquire`
instance when it must create an account or submit a form, an `accept_terms` instance when
it must sign — and none otherwise, so the 56 drafts and their follow-ups (plain email
pitches) need exactly the communication authority (plus payment only if paid). The locked claim and every
irreversible step (submit, send, mint) load ALL rows for the placement. The dimension
**owning the current action** (payment for mint, communication for send/follow-up, execution
for submit/create-account) must be `AUTO_*` (gate on, re-run decision agreeing) or `OWNER_*`
with a valid, **unconsumed, action-matching** approval. **An approval's scope is the whole
action instance, not a single step:** the execution/`acquire` approval covers every step of
one acquisition (create-account → email verification → resume → submit) and is consumed
ONLY by the terminal outcome of the final submit (`placed` (pending-flagged or not)/`failed`/`skipped`);
intermediate steps verify it is valid and unconsumed but never consume it, and
`satisfied_at` on the execution instance is set only after that final submit. Likewise the
payment/`purchase` approval spans reserve → mint → submit and is consumed on the purchase's
settlement; the communication approval on the send's terminal outcome. Prerequisites form a DIRECTED graph per action, never "every other dimension in both directions" (that would deadlock an account-required or legal outreach path): prerequisites are STEP-granular within `acquire`: the guarded preparation steps (`create_account`, verification activation, form discovery/fill, checkout preparation up to `ready_for_payment`) need only the `acquire` execution authority itself; `accept_terms` (when present) is required immediately before the FINAL `submit` step — and, when sending the email itself legally accepts the terms (`terms_accepted_by_send=true`), NOT as a prerequisite of the send but CO-TRANSACTIONALLY with it — exactly the acceptance-by-submit pattern: the send claim requires the `accept_terms` instance to be AUTHORIZED (its own approval bound to `legal_terms_hash`, plus the communication approval) and one state-locked, idempotent send transaction satisfies BOTH instances only after Gmail confirms the send; a `send_error` leaves both unsatisfied and both are settled together by the existing Sent-folder reconciliation (sent ⇒ both satisfied; not sent ⇒ neither); for the common case where the agreement checkbox exists only on the final form/checkout, the initial pitch and follow-up send on communication authority alone and the terms instance gates the later submit (the authority + approval bound to `legal_terms_hash` are unchanged) — either as its own prior external mutation (a separate agreement page) OR, for checkbox-plus-submit flows where the terms are accepted BY the submission, as a state-locked co-transactional pair exactly like mint → submit: the `accept_terms` instance (its own authority + approval bound to `legal_terms_hash`, unchanged) is marked satisfied in the SAME transaction that records the `submit` attempt's success, never before the merchant has received it — an authenticated site may legitimately need the account to exist before terms can be accepted, so `accept_terms` may run after `create_account`; `outreach_send` and `acquire` are independent of each other (a pitch never waits for the form submission and vice versa); a non-deferred `purchase` must be settled — or co-transactional (mint → submit inside one purchase lease) — immediately before the final `submit` only, never before preparation and never before a send; `outreach_followup` requires the send satisfied; `renewal` requires the original purchase satisfied. Each listed prerequisite is a **durable prerequisite** that must be COMPLETED, not merely authorized: its open instance must carry `satisfied_at` (authority permits an action; only satisfaction proves it happened — execution never runs under an approved-but-unsettled payment, and nothing submits before `accept_terms` is satisfied), except the explicitly DEFERRED prerequisites (§ below: payment on outreach paths until `ready_for_payment`) and co-transactional pairs whose ordering is state-locked in one transaction (mint → submit inside the purchase lease). Its authority row must additionally be
`AUTO_*` or `OWNER_*` with an approval that is valid and not invalidated (consumed is fine —
the communication approval consumed by the send still satisfies the later mint of the same
paid outreach placement, and vice versa) — with ONE ordering exception: a payment dimension
decided `OWNER_MANUAL_PAYMENT` (or any payment dimension on a paid OUTREACH path, whose
purchase is only reservable once the publisher exposes a checkout, §7 `mode=payment`) is a
**deferred** prerequisite for the communication send — the initial send and follow-up
proceed on communication authority alone, and the payment dimension becomes a hard
prerequisite only from `ready_for_payment` onward (`OWNER_MANUAL_PAYMENT` parks the placement
`awaiting_owner` at that point, never before). Execution/communication prerequisites are
never deferred. **Invalidation is scoped per dimension by construction:** each dimension has its own path
revision (`revision_payment` / `revision_communication` / `revision_execution`, §3.2) and its
own inputs hash, so a change invalidates only the approvals of the dimension it belongs to
(price, renewal, payment flags → payment; recipient/draft → communication; `legal_attestation`/`legal_terms_hash` → EVERY dimension that lists them — payment, communication AND execution — since all three revisions bump on a terms change (regression tests for all three); type/URL →
supersession, all dimensions). A dimension INSTANCE with `satisfied_at` set is validated by nothing further — it is done — with ONE exception: a satisfied `accept_terms` instance is bound to the hash it accepted (`accepted_terms_hash` stored on the row), and an in-place revision that changes `legal_terms_hash` before the final submit applies the same hash-sensitive reopen as supersession (the instance is ended `terms_changed`, `terms:n+1` opened, the placement re-parked for the new agreement) — acceptance of an old agreement never satisfies a newly discovered one — and when the acceptance was SEND-BOUND (`terms_accepted_by_send=true`) and the accepting email has already gone out, the successor instance is NOT send-bound (the satisfied communication instance stays satisfied; no second initial email is ever auto-sent): it opens as a standalone `mode=terms` `acceptTerms()` instance when the path exposes an acceptance surface, otherwise the placement parks `awaiting_owner` with the OWNER_LEGAL diff card and the owner accepts or re-negotiates by hand;
but satisfaction is per action instance: a renewal (`instance_key` = `${renewal_period_key}:${generation}`)
and the follow-up (`instance_key` = `followup:${generation}`) are new rows — generation-bearing
exactly like the initial `-:${generation}`, so a failed renewal/follow-up can open generation
2 under the unique key — that require their own decision and, when `OWNER_*`, their own
fresh, action-matching approval (claims and approval hashes use the full generation-bearing key) — a consumed approval never satisfies a
later instance, and an unsatisfied later instance never blocks the durable prerequisite that
an earlier one already satisfied (e.g. the initial send stays satisfied while the renewal's
payment instance is pending). A completed communication attempt (`sent`) is a satisfied prerequisite for
the rest of that placement's life — a later price change never demands re-approving, let
alone re-sending, a message that already went out. Any row at `DENY`/`INVALID`, or a required
dimension with no row, blocks. A paid guest post thus cannot execute on a payment approval
alone, nor send on an outreach approval alone.

### 3.4 `seo_link_attempts` — every execution, whoever performed it

```js
t.uuid('id').primary(); t.uuid('prospect_id'); t.uuid('path_id');
t.string('provider').notNullable();   // CHECK (provider IN ('deterministic_runner','openai_cua','claude_cu','stagehand','grok','hermes','human')) — `hermes` = the Hermes worker's capability-limited HMAC identity (`LINK_WORKER_SECRET_HERMES`, §12 — the bearer accepted for `hermes` during the ordered rollout maps to this SAME record and is not a separate identity): investigation/draft reports only, no payment/credential capability
t.text('idempotency_key');            // for irreversible external mutations (`create_account`, `activate_verification`, `resume`, `submit`, `accept_terms` — each action its own key; `resume` additionally carries the handoff it resumes from — `${prospect_id}:resume:${instance_key}:${handoff}` with handoff ∈ {credentials, payment, human_step}, plus the generation of that handoff — so the credential-boundary resume and the later card-boundary resume of one acquisition never collide): `${prospect_id}:${action}:${instance_key}` where `instance_key` is the §3.3b action-instance identity (`-:1`, `annual:1`, `2027:1`, `followup:1`, `terms:1`) — so an initial acquisition submit and a renewal submit never share a key; partial UNIQUE where not null — a second lease that reaches the same mutation finds the existing row (ON CONFLICT DO NOTHING + re-select) and — because a DB row cannot prove whether the external call took effect — treats it as **`mutation_ambiguous`** (outcome, added to the enum): the runner first RECONCILES per action before anything is re-sent (`create_account`: probe the login/‘email already registered’ path or the inbox for the welcome mail; verification activation: reload the account and read its verified state; `submit`: the existing profile/listing probe the Judge uses) and only retries the external call when reconciliation PROVES the first one did not take effect; an unprovable state stays `mutation_ambiguous` for the owner card — a crashed mutation is therefore never repeated blindly
t.string('acquisition_type_snapshot'); // the path's acquisition_type AT the attempt (with path_id, the durable learning key — a placement repointed to a superseding path keeps its successful attempt's own path/type)
t.timestamp('first_live_at');         // stamped by the Judge the first time it verifies the placement live AFTER this acquisition attempt (initial and every reacquisition cycle alike; the placement's own first_live_at is never rewritten) — the per-cycle D30/D90 window opens here (§8)
t.string('action').notNullable();     // investigate | create_account | complete_form | submit | accept_terms (the standalone/guarded agreement acceptance — §3.2 legal_terms_hash lifecycle, `mode=terms` and the pre-submit acceptance alike) | activate_verification (clicking/confirming the email-verification link — its own action, so its key never collides with a later session resume) | resume (authenticated session resume) | mint (AUDIT-ONLY: the sweep's issuer-lookup observation, outcomes mint_not_started / payment_ambiguous; no idempotency key, never a mutation) | outreach_send | outreach_followup | manual_payment (human settlement only) | price_entry (owner price-entry card only, outcome price_entered) | create_account ⇒ pre-call outcome `mutating` (the durable row written under the guarded phase BEFORE the external call, the generic in-flight state for every non-submit, non-send mutation — create_account, resume/verification, accept_terms), success outcome `account_created`; activate_verification ⇒ `mutating` → `verified`; resume (authenticated session resume, its own key) ⇒ `mutating` → `verified`; a crash leaves `mutating`, which the next lease treats as `mutation_ambiguous` (reconcile-then-retry, never blind repeat) — each success closes its idempotency row so the next step is unambiguous | accept_terms (the guarded legal-acceptance mutation: its own idempotency_key `${prospect_id}:accept_terms:terms:${generation}` — never aliased to resume; outcomes `mutating` before the external acceptance call, `terms_accepted` on success, `mutation_ambiguous` on an unproven crash (reconciled by re-reading the account's agreement state), `terms_changed` when the live hash ≠ legal_terms_hash)
t.string('outcome').notNullable();    // CHECK (outcome IN (
                                      //   'slot_reserved','slot_released','submitting','submit_ambiguous', -- submission lifecycle (§13);
                                      //   'sending',                                                   -- outreach send in flight: the send claim writes an `outreach_send`/`outreach_followup` attempt with outcome='sending' under the sender lock BEFORE calling Gmail (mirrors the retained outreach_status='sending'); the same lock flips it to 'sent' / 'send_error' on the result — so the supersession pin and restart sweep (§3.2) see an active attempt during the external call; slot_released = a reserved slot given back on lease expiry (ET-day rollover re-slots the same row in place, §13) — audit-only, NEVER counted by the cap query; the same row returns to slot_reserved on the instance's next lease
                                      //   'placed','pending','drafted','sent','failed','skipped','blocked','captcha',
                                      //   'needs_owner','human_step_done','ready_for_payment','ready_for_credentials',
                                      //   'no_payment_required','price_changed','instrument_unavailable','auto_renew_unavoidable',
                                      //   'payment_ambiguous','mint_not_started','terms_changed','send_error','budget_month_rollover','manual_charged','price_entered','mutation_ambiguous','terms_accepted','account_created','verified','mutating','sandbox_replay',
                                      //   'close_pending','charged','ambiguous','voided','reconciled_charged','reconciled_not_charged' -- payment/renewal REPORT outcomes (§7 matrix): the purchase ROW (§3.7) is the authoritative money state machine; the co-transactional attempt row persists the reported outcome verbatim for the every-execution audit (report outcome = attempt outcome, one-to-one — no mapping table) )) -- budget_month_rollover = the §6.3 rollover void (a `submit` attempt row records it in the same transaction as the void); manual_charged = the human settlement form's `human` attempt (action `manual_payment`, provider `human`), inserted in the same transaction as the terminal `manual_charged` purchase row — the only outcome a manual settlement may record; send_error = the retained sender's ambiguous Gmail failure (may have reached Gmail before timing out; reconciled by the sender flow as sent / not sent) — the ONE complete enum; every state named anywhere in this plan is here
t.integer('cost_cents'); t.integer('duration_ms'); t.boolean('sandbox').notNullable().defaultTo(false); // sandbox rows use outcome='sandbox_replay'
t.date('slot_day');                   // ET calendar day this submission slot counts against (set on slot_reserved; re-reserved on day rollover — §13); index (slot_day, outcome) for the cap count
t.text('lease_token');                // the claim lease that holds this slot — the SAME ISO `claimed_at` token the retained claim/report contract already returns (text, not a new UUID); the sweep releases only slot_reserved rows whose lease expired
t.text('evidence_url'); t.jsonb('detail');    // sanitized: never credentials, never full page bodies
t.timestamps(true, true);
```
The deterministic runner writes here (`signup-runner.js` `recordAttempt`; `signup-evidence.js`
only stores the screenshot it references). Its current ledger (`seo_signup_attempts`,
migration `20260622000010`) is **backfilled idempotently in step 1**, and the cutover is
expand/contract in that same PR: `seo_link_attempts` carries `legacy_attempt_id` (uuid,
partial UNIQUE where not null) and the backfill is ONE pure, re-runnable function
(`INSERT … ON CONFLICT (legacy_attempt_id) DO NOTHING`, keyed by the legacy row id) that
runs (a) in the migration, pre-deploy, (b) as a catch-up at the start of every
`signup-runner` `run()` and once at boot, and (c) as a **gate-independent recurring
catch-up** — the same function under `runExclusive('link-registry-catchup')` on the existing
6-hourly scheduler tick, unconditionally, whether or not the runner gate is on — so a legacy
row written by an OLD pod during the rolling deploy (after the migration, after the new pod's
boot catch-up, before the old pod drains) is picked up within 6h by a pod that never runs the
runner, never lost. ONE cleanup milestone: the catch-up and the legacy table are removed
TOGETHER by a later cleanup migration after step 5 (see below) — never by the step-2
contract migration, which touches only the placement unique index. The same deploy moves `recordAttempt` and every reader of
`seo_signup_attempts` to `seo_link_attempts`; there is no dual-write. (Today the runner is
gated OFF in prod with 0 legacy attempts, so the race is theoretical — the catch-up makes the
cutover correct regardless.) Mapping — `blocked_account` →
`needs_owner`, `blocked_payment` → `needs_owner`, `blocked_price_changed` → `price_changed`,
`blocked_captcha` → `captcha`, `submitted` → `placed`, `failed`/`error` → `failed`, anything
else → `failed`; `action` (NOT NULL) = `submit` for every legacy row (the legacy runner only
ever recorded whole submission attempts; the verbatim legacy step, if any, goes to
`detail.legacy_step`); `cost_cents` = the legacy cost (`t.decimal('cost_usd')`) converted
deterministically as `Math.round(Number(cost) * 100)` when it is a finite number, else null
(never a float column, never truncation) — with the verbatim legacy outcome kept in
`detail.legacy_outcome` and `provider='deterministic_runner'`, so historical attempts and costs appear in the Outcomes/
provider reports and the CHECK enum holds. `seo_signup_attempts` is then left in place with
no writer, as read-only history; the catch-up and the legacy table are removed together by a
later cleanup migration once step 5's provider work no longer needs to compare against it.

### 3.4b `seo_link_domain_sources` — every touch, normalized

```js
t.uuid('id').primary(); t.uuid('domain_id').notNullable();
t.string('source').notNullable(); t.text('source_detail'); t.uuid('source_ref');
t.uuid('placement_id');               // seo_link_prospects.id — set when the touch is bound to a specific placement's recovery cycle (below); NULL for a plain domain touch
t.uuid('loss_event_id');              // seo_backlink_events.id of the verified loss that opened that placement's recovery cycle; NULL outside a recovery cycle
t.text('touch_key').notNullable();   // `${source}:${source_ref || normalized source_detail || '-'}:${cycle_key}` — `cycle_key` is PER PLACEMENT CYCLE, never derived from "the domain's current cycle" (a domain with several placements — different pages / GBP locations — can have several open recovery cycles at once): '0' for a touch outside any recovery cycle, else `${placement_id}:${loss_event_id}`. Binding: a touch whose URL/page/location hint resolves via `findPlacementRow` to a placement with an open recovery cycle is bound to THAT placement's loss event; a touch with no placement hint on a domain with open recovery cycles is recorded once per open cycle (one row per placement in recovery, each with its own `placement_id`/`loss_event_id`) plus nothing else — never against a cycle chosen by recency. So a recurring feeder is idempotent WITHIN a cycle (Postgres UNIQUE treats NULLs as distinct, hence a non-null key) and §8 joins a reacquisition and its D30 result to the touches that carry ITS `loss_event_id`, so placement A's rediscovery can never be credited to placement B's loss
t.timestamp('seen_at').notNullable().defaultTo(knex.fn.now());
t.unique(['domain_id', 'touch_key']);
```
`seo_link_domains.source` is first-touch attribution and is never overwritten; every feeder
(including a repeat of the first) inserts a row here. §8 reports and learns per source from
this table (a domain discovered by three feeders credits all three; "first-touch" and
"any-touch" are both reportable) — **but only touches recorded BEFORE the placement was
acquired** (`seen_at` < the timestamp of the placement's FIRST successful acquisition attempt — the original conversion, never a later recovery cycle's attempt, so a feeder that noticed the link while it was already live earns nothing even after a loss and reacquisition; a recovery cycle's touches are attributed only to touches recorded between the verified loss and that cycle's successful attempt — the §8 learning join uses the same attempt rows; `first_live_at` is only the fallback when no attempt exists, i.e. never for executed placements — and never `existing_backlink`, which is observational):
a feeder that merely notices a link after it converted earns no attribution and cannot
bias `P(live at D30 | source, path)`. §8 learning joins DISTINCT `(acquisition_attempt_id, source)` — a
placement counts once per source PER ACQUISITION CYCLE however many touch rows that source recorded in the cycle's window (the rows stay
for provenance), so repeatedly-noticed domains are not overweighted. Recursive lineage follows `source_ref` chains here.

### 3.4c `seo_link_worker_requests` — request-level worker-auth audit (ships with HMAC, step 1)

```js
t.uuid('id').primary();
t.string('key_id').notNullable();      // the verified credential id (HMAC key id, or 'hermes-bearer' for the transitional bearer)
t.string('provider').notNullable();    // the fixed provider record the credential mapped to (§12) — CHECK against the provider enum
t.string('auth_scheme').notNullable(); // CHECK (auth_scheme IN ('hmac','bearer'))
t.string('method').notNullable(); t.text('path').notNullable(); t.jsonb('query'); // canonical target as verified (mode/type/location …)
t.string('endpoint').notNullable();    // CHECK (endpoint IN ('claim','report','vendor_price','vendor_login')) — the two vendor worker routes that share hermesAuth write rows here too once signed (§14 step 1b), so the bearer-retirement query covers every mount
t.string('result').notNullable().defaultTo('authenticated'); // CHECK (result IN ('authenticated','empty_claim','leased','report_accepted','report_rejected')) — inserted as 'authenticated' immediately after verification, finalized by the handler; a row that stays 'authenticated' (handler crashed/timed out) still counts as an accepted bearer request for retirement; an EMPTY claim is a row too
t.uuid('prospect_id'); t.uuid('attempt_id'); t.text('nonce');
t.timestamp('received_at').notNullable().defaultTo(knex.fn.now());
t.index(['auth_scheme','received_at']); t.index(['provider','received_at']);
```
One row per ACCEPTED authentication on `/api/integrations/*-worker` claim/report — written inside
the route in two steps: the row is INSERTED with `result='authenticated'` immediately after
signature/bearer verification and before the handler (its own short transaction, committed even if
the handler later fails), then UPDATED by the handler to its outcome (an empty claim, a lease, an
accepted or rejected report) — so a legacy worker that keeps polling with bearer auth and receives
nothing still leaves a row, and a handler failure leaves the `authenticated` row rather than none. `seo_link_attempts` is NOT the
audit (it exists only for execution actions and never for an empty claim). Rejected
authentications (bad signature, replayed nonce, stale timestamp) are counted in the existing
`auth_failures` metric, not here — the table records who was LET IN. The §1/§14 bearer
retirement condition is exactly `SELECT count(*) FROM seo_link_worker_requests WHERE
auth_scheme='bearer' AND received_at >= now() - interval '7 days'` = 0 (query in the step-1b PR
description with its output); the Hermes signup-skill migration is verified by the same table
showing that skill's claims arriving as `auth_scheme='hmac'`. Retention: 90 days (sweep).

### 3.4d `seo_link_intake_items` — raw references before resolution (step 2)

```js
t.uuid('id').primary();
t.string('source').notNullable(); t.text('source_detail'); t.uuid('source_ref'); // §3.5 provenance, as the touch will carry it
t.text('raw_url').notNullable();       // the reference exactly as received (post URL, shortener link, CSV cell, gap row URL)
t.text('item_key').notNullable();      // `${source}:${normalized raw_url}` — UNIQUE; a re-fed reference updates `last_seen_at`, never duplicates the ITEM — but every feed of an already-`resolved` item still upserts the CURRENT provenance touch through the guard (a `seo_link_domain_sources` row for this `source_ref`/`source_detail`, with §3.4b's per-recovery-cycle binding), so the per-touch/per-cycle attribution contract holds while URL resolution stays idempotent
t.string('state').notNullable().defaultTo('pending'); // CHECK (state IN ('pending','unresolved','resolved','dropped'))
t.integer('attempts').notNullable().defaultTo(0); t.timestamp('next_retry_at'); t.text('last_error');
t.text('resolved_url'); t.text('resolved_host'); t.uuid('domain_id'); t.uuid('source_row_id'); // set on `resolved` (→ seo_link_domains / seo_link_domain_sources)
t.string('drop_reason');               // CHECK (drop_reason IS NULL OR drop_reason IN ('never_a_target','retry_exhausted','invalid_url','own_domain'))
t.timestamp('first_seen_at').notNullable().defaultTo(knex.fn.now()); t.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
t.unique(['item_key']); t.index(['state','next_retry_at']);
```
The §4 pipeline's step 1 writes here BEFORE normalization for every reference that needs a
resolver (X posts, shorteners, redirecting URLs); a directly-parseable host may skip the row.
Resolution is the SSRF-safe `fetchPage` `resolveOnly`/`finalUrl` path; success writes
`resolved_*`, inserts the domain + touch through the guard and marks `resolved`; a resolver
failure marks `unresolved` and schedules the retry (the intake sweep claims `state IN
('pending','unresolved') AND (next_retry_at IS NULL OR next_retry_at <= now())` under
`FOR UPDATE SKIP LOCKED`); a resolved host on the never-a-target list marks `dropped` with
`drop_reason` — the raw row remains as the audit of what was fed and why it went nowhere.

### 3.5 Provenance enum (`seo_link_domains.source`, `seo_link_domain_sources.source`)

`owner_seed` · `list_import` · `competitor_gap` · `competitor_clone` · `recursive` ·
`x` · `google_search` · `dataforseo` · `strategy_agent` · `existing_backlink` ·
`lost_recovery` · `local_opportunity` · `legacy_unknown` (backfill fallback only)

`owner_seed` means **investigate immediately**, not **qualified**: it bypasses the cheap
prefilter and the contactability gate, never the score; the row shows its reasons and an
*Acquire anyway* override. Bulk lists are `list_import` + `source_detail` — never `owner_seed`.

### 3.6 Credentials — `seo_link_credentials` (+ `seo_link_sessions`)

`self_service_account` paths create accounts. Credentials — and resumable browser state
(cookies/tokens, §7) — are stored encrypted at rest with a **dedicated, stable, versioned key**
(`LINK_CREDENTIALS_KEY_V1`, `…_V2` …; each row carries `key_version`; rotation = add the next key,
re-encrypt lazily on read, retire the old key when no rows reference it). Never derived from
`JWT_SECRET` or any session/app secret — rotating those must not brick stored logins, and no
other code path should hold this key. Rows are scoped by **account identity**, not by
domain: `account_key` = `${domain_id}:${path_id}:${location_key}` by default (one account per
path per location — the same key as the resumable session), unique; a site that genuinely
serves several locations/paths from ONE login is modelled explicitly with a shared row
(`shared_account=true`, `account_key='${domain_id}:shared'`) that the placement references
via `credential_id` — the runner never picks a credential by domain alone, so two paths or
locations can neither select nor overwrite each other's login. Readable only by the
runner's create/resume path, and **never** written to `seo_link_attempts.detail`, logs,
evidence, or LLM prompts.
The dedicated inbox is `HERMES_SIGNUP_EMAIL` (exists); its IMAP verifier
(`backlink-agent/email-verifier.js`) is reused for `email_verification=true` paths — REFACTORED in step 5 (the runner extension, with the sessions/attempt flow it writes into — the build order in §14 governs; an earlier draft said step 3), not called as-is: today it is gated by `backlinkAgent`, reads `BACKLINK_AGENT_EMAIL` and writes only the retired `backlink_agent_queue`; the step-5 change points its IMAP read at the v2 inbox (`HERMES_SIGNUP_EMAIL`), gates it on the runner gate, and persists a found verification link into the v2 flow — the placement's `activate_verification` attempt/idempotency row + persisted session (§3.3b/§12) — so a verification message actually advances the acquisition instead of updating a table nothing reads.

### 3.6b Approvals — `seo_link_approvals` (immutable terms snapshot)

Every `OWNER_*` decision is an approval row that freezes exactly what was approved (a floor-waiver click is NOT an approval row — it is audited in its own table, `seo_link_floor_waivers`, §6.3 1b, and never authorizes an action instance); execution is bound to it and it dies if anything it froze changes.

```js
t.uuid('id').primary(); t.uuid('prospect_id').notNullable(); t.uuid('path_id').notNullable();
t.integer('path_revision').notNullable();     // the path's revision_<dimension of this approval's action> at approval time (§3.2) — never the global counter
t.text('decision_inputs_hash').notNullable(); // hash of THIS approval's dimension inputs only (same sets as the authority rows): payment = {estimated_cost_cents, renewal_cost_cents, renewal_period, currency, currency_attestation_id + attestation row hash, fee_scope, payment_required, legal_attestation, legal_terms_hash, merchant_binding}; communication = {link_type, expected_rel, legal_attestation, legal_terms_hash, terms_accepted_by_send, execution_after_send, recipient, subject/body hash}; execution = {account_required, email_verification, agent_completable, legal_attestation, legal_terms_hash, execution_after_send, submission_url}; plus, for every dimension, the shared quality floors {spam_score, score, confidence} AND the `instance_key` (so the hash itself differs per generation). A mismatch at claim time invalidates the approval; a change outside the dimension's set never does
t.boolean('money_action').notNullable();      // = (dimension = 'payment'); CHECK (money_action = (dimension = 'payment')) — same-row, so the money CHECKs below can see it; execution and communication approvals never carry payment terms
t.string('decision').notNullable();           // CHECK (decision IN ('approved','rejected','watch'))
t.string('authority').notNullable();          // CHECK (authority IN (the §6.1 OWNER_* levels EXCEPT OWNER_OVERRIDE/OWNER_MANUAL_PAYMENT/OWNER_INPUT_REQUIRED)) — the OWNER_* level being granted; a floor waiver is never an approval row (it has no dimension/action/instance — `seo_link_floor_waivers` is its only record)
t.integer('approved_amount_cents');           // the amount the owner approved; same-row CHECK (NOT (money_action AND decision = 'approved') OR (approved_amount_cents IS NOT NULL AND approved_amount_cents > 0)) — a paid APPROVAL without a ceiling cannot exist, while a `rejected`/`watch` decision on a payment card is an audit row with no approved terms: CHECK (decision = 'approved' OR (approved_amount_cents IS NULL AND max_payable_cents IS NULL)) (a CHECK cannot read the path row, hence the copied flag; the insert also verifies the copied flag equals the path's current value inside the approval transaction)
t.integer('max_payable_cents');               // IMMUTABLE absolute ceiling = approved_amount_cents + policy.owner_price_tolerance_cents AS OF APPROVAL; CHECK (NOT (money_action AND decision = 'approved') OR (max_payable_cents IS NOT NULL AND approved_amount_cents IS NOT NULL AND max_payable_cents >= approved_amount_cents)) — written NULL-safe because a CHECK whose expression is NULL passes; the final-total guard compares against THIS only — a later policy change never widens an existing approval
t.jsonb('terms_snapshot').notNullable();      // PER DIMENSION — exactly the fields of this approval's `decision_inputs_hash` set (§3.6b), nothing from another dimension: payment approvals snapshot estimated_cost_cents (the quoted initial amount), currency (always 'USD' — the approval insert refuses otherwise), currency_attestation_id + row hash when the USD evidence is an owner attestation, fee_scope, renewal_period, renewal_cost_cents, payment_required, legal_attestation, legal_terms_hash (+ the agreement URL — the exact terms the owner read) and, for payment approvals, the COMPLETE canonical merchant_binding from the path (§3.2: checkout_origin, processor.host, processor.merchant_account_id, issuer_merchant_descriptor) the owner approved — a processor host alone never appears here; copied, never referenced
t.string('dimension').notNullable();          // CHECK (dimension IN ('execution','payment','communication')) — the authority dimension this approval satisfies
t.string('action').notNullable();             // CHECK (action IN ('acquire','accept_terms','purchase','renewal','outreach_send','outreach_followup')) AND CHECK ((dimension='execution' AND action IN ('acquire','accept_terms')) OR (dimension='payment' AND action IN ('purchase','renewal')) OR (dimension='communication' AND action IN ('outreach_send','outreach_followup'))) — `accept_terms` = accepting/signing an agreement or vendor terms (its own execution-dimension instance `terms:<generation>`, action_hash = the exact `legal_terms_hash`; an outreach path with `legal_attestation` therefore carries communication/outreach_send AND execution/accept_terms — permission to send an email is never permission to sign) — an approval authorizes exactly one action in exactly one dimension; a paid membership has an execution/acquire approval AND a separate payment/purchase approval
t.text('instance_key').notNullable();         // the §3.3b ACTION INSTANCE this approval authorizes (`${kind}:${generation}`, e.g. '-:1', '-:2', 'annual:1', 'followup:1'); must EQUAL the `seo_link_placement_authorities.instance_key` it is attached to (checked in the approval transaction, together with `approval.authority === authorities.level` for that dimension — an approval issued for a different OWNER_* level never satisfies the row; the locked claim re-checks the same equality; regression test required) and the instance the claim is leasing (checked in the locked claim) — an approval for generation 1 can never satisfy generation 2 after `voided`/`reconciled_not_charged`/`failed`; the owner approves each retry generation afresh
t.text('action_hash');                        // outreach_send/followup: sha256 of (recipient email, subject, body) of the draft the owner saw; renewal: the renewal_period_key — the send claim recomputes it and refuses on mismatch (an edited/replaced draft is a new approval)
t.string('approved_by').notNullable(); t.timestamp('approved_at').notNullable();
t.timestamp('invalidated_at'); t.text('invalidated_reason'); // set when THIS dimension's path revision advances or any term in THIS approval's (per-dimension) snapshot differs — a price change never invalidates an outreach approval
t.timestamp('consumed_at');                   // set when the leased execution reports a terminal outcome
```
`seo_link_acquisition_paths` gains `revision` (integer; bump rule in §3.2). The claim predicate
accepts an `OWNER_*` row (waived or not) only with an approval that is `approved`, not
invalidated, **unconsumed for the dimension instance that owns the current action** (a
consumed approval on a prior, satisfied dimension instance is a durable prerequisite, §3.3b),
whose `path_id` is the placement's current, non-superseded path,
whose `path_revision` equals that path's current `revision_<dimension>` (per-dimension —
a price change bumps `revision_payment` only) AND whose
`decision_inputs_hash` equals the hash of the current inputs (an owner approved *these*
numbers, not whatever they became), and whose `instance_key` equals the authority row's `instance_key` for the action instance being leased (the same equality is enforced when the approval is attached — a generation-2 purchase after `voided` or `reconciled_not_charged` needs its own approval, never generation 1's), and whose `dimension`+`action` match the step being leased (execution/acquire for
submit, payment/purchase|renewal for mint, communication/outreach_send|followup for send)
with `action_hash` matching the current draft (send) / follow-up draft (followup, which needs
its own approval) / period (renewal) — an owner-approved send can only send the exact text and
recipient that was approved;
the final-total guard compares `final_cents` to the approval's immutable `max_payable_cents`
and refuses when the approval lacks one (it cannot, by CHECK, for a paid path — the guard is
still written null-safe: null ⇒ refuse). Any
path write re-validates open approvals and invalidates the ones whose snapshot no longer
matches — the row returns to `awaiting_owner` with a fresh card.

### 3.7 Purchases — `seo_link_purchases`

The spend ledger with atomic monthly reservation and ambiguity-safe states; defined with the
money mechanics in §6.3.

### 3.8 Policy — `seo_link_policy` (single row; the DB row is authoritative)

The database row is the ONLY source of authority/spend thresholds; every change is an
audited Policy-panel edit (`seo_link_policy_audit`: who, when, field, old → new). Environment
variables may only **tighten**: an env value is applied when it is more restrictive than the
row (lower cap, lower budget, `false` for a switch) and never when it would loosen; the
effective override is recorded on the decision (`policy_effective` snapshot in the placement
authority row's inputs hash) so an audit can see which limit actually applied. The `GATE_*`
kill switches remain env-only by design (they only ever turn lanes off).

See §6.2. Defaults ship conservative (everything owner-gated) and are loosened by Adam in the
Policy panel, not by code.

---

## 4. Intake — one pipeline for every source

`POST /api/admin/backlink-agent/opportunities/bulk` is a thin admin-auth wrapper over the intake SERVICE `server/services/seo/link-registry-intake.js` (`ingestOpportunities({ items, source, sourceDetail, dryRun, actor })`, the module #3577 introduced). Scheduled server jobs — the weekly competitor-gap ingestion, the existing-profile baseline, `lost-link-recovery.js`, the X poller replacement, the recursive-discovery job — call the SERVICE directly with a job actor (`actor = { kind: 'job', name }`, recorded in `source_detail`); they never call the HTTP route, which keeps the router-wide admin auth on `admin-backlink-agent-v2.js` intact (a scheduler has no `waves_admin_token` bearer to present) and never needs a bypass. The route does nothing the service does not: parse the pasted text, pass `actor = { kind: 'admin', id }`, return the same idempotent result

Accepts raw text: domains, URLs, an X post URL, a competitor backlink URL, a pasted list,
CSV rows. Steps, all idempotent:

1. **Normalize** — extract hosts/URLs from the text; `canonicalProspectDomain()` for the host;
   keep the URL as a *submission_url hint*. **Resolvers run first** for URLs that are
   *references to* opportunities rather than opportunities: an X post URL (`x.com`/
   `twitter.com/<user>/status/<id>`) is resolved through the existing `backlink-agent/x-poller`
   URL extraction (tweet entities → expanded URLs) **with redirect expansion moved behind the
   SSRF-safe fetcher** — `x-poller.resolveUrl` today does a raw `fetch(redirect:'follow')`
   and is replaced by `contact-finder.fetchPage`'s pinned resolver EXTENDED in step 2 to expose
   the validated `finalUrl` (today it returns only status/body metadata) and a bodyless
   `resolveOnly` mode (HEAD/early-abort — every hop validated against private/metadata ranges,
   hop count bounded); the X feeder consumes `finalUrl`, never the shortener host, and each
   resolved host enters as `source='x'`, `source_detail=<post URL>`; the post host itself is
   never a candidate. A competitor backlink URL contributes its host. Hosts on a fixed
   never-a-target list (`x.com`, `twitter.com`, `google.com`, `t.co`, URL shorteners, Waves'
   own domains) are dropped, not parked. Every reference URL is FIRST recorded as a
   durable raw intake item — `seo_link_intake_items` (§3.4d; idempotent on `item_key` =
   `${source}:${normalized raw_url}`) — and only then resolved; if the X API or the redirect
   resolver is unavailable the item stays `state='unresolved'` with `attempts`/`next_retry_at`/
   `last_error` and the intake sweep retries it (backoff, capped at 7 days, then `dropped` with
   the reason), never turned into an `x.com` domain and never discarded silently: the
   never-a-target rule applies to the RESOLVED host, and an item whose only known host is on
   that list has simply not resolved yet.
2. **Dedupe** — against `seo_link_domains.domain` and, for placement hints, via
   `findPlacementRow`. Existing rows are *updated* (a `seo_link_domain_sources` row is
   added for the new touch; first-touch `source` is untouched; priority raised if the new
   source is `owner_seed`), never duplicated.
3. **Enrich** — DataForSEO bulk summary (rank, traffic, spam, referring domains) in one call
   per batch; `competitors_linked` from `seo_competitor_backlinks`. Behind
   `GATE_SEO_INTELLIGENCE`; cached in `enrichment`.
4. **Queue for investigation** — `agent_state='investigating'`; `owner_seed` first.

**Legacy board backfill (step 1, runs with the migration, idempotent).** Every existing
`seo_link_prospects` row — including the 56 June drafts — gets a registry domain (canonical
host; rows are GROUPED by canonical host and the registry's first-touch `source` is taken
deterministically from the legacy row with the earliest `created_at` (id as tie-break);
EVERY legacy row — the first-touch one included — also gets its `seo_link_domain_sources`
touch with `seen_at` = the legacy row's original `created_at` (never `now()`), so the
learning table's pre-acquisition rule (`seen_at < first_live_at`) sees historical
attribution as historical; `source` = that row's legacy
value **mapped to the §3.5 enum** — `manual` → `owner_seed`,
`strategy_agent` → `strategy_agent`, `lost_recovery` → `lost_recovery`,
`competitor_gap` → `competitor_gap`, `local_opportunity_<date>` → `local_opportunity`,
`deep_harvest_<date>` → `competitor_gap`, `signup_agent` → `x` (its rows came from the X
poller queue), and anything else → `legacy_unknown` (a neutral enum member added for this
purpose); `existing_backlink` is reserved for rows actually imported from `seo_backlinks`.
The verbatim legacy value is kept in `source_detail` as `legacy:<value>`; the enum is a
CHECK, so the mapping is exhaustive with that fallback) and a path
(`acquisition_type` mapped from `link_type`: outreach lanes → `resource_outreach`/
`editorial_outreach`, directory/citation/social → `self_service_account`; the path's
NOT NULL `link_type` is the legacy value when it is already in `CLAIMABLE_LINK_TYPES`, else
**normalized before the insert** — null, `forum`, `comment`, `unknown` and any other value →
`resource`, the descriptive lane (the verbatim value kept as `legacy_link_type:<value>` in
`source_detail`), and the prospect row's own `link_type` is backfilled to the same normalized
value in the same migration so placement and path agree — the migration never writes a path
that would fail the §3.2 CHECK, so it cannot abort deployment on a legacy null; `submission_url =
target_url`; explicit booleans; `agent_completable` = the lane's worker exists; `confidence`
low; `last_investigated_at = null` so the investigator refreshes it) and is linked via
`domain_id`/`path_id`. The backfill is the same shape as the `seo_signup_attempts` one (§3.4): ONE pure re-runnable function keyed by prospect id (`WHERE domain_id IS NULL`), run in the migration AND as the gate-independent 6-hourly `link-registry-catchup`, so a prospect inserted by an old pod or a not-yet-migrated writer during the phased rollout is registered within 6h and never silently excluded by the step-4 predicate; `domain_id`/`path_id` become NOT NULL only in a LATER contract migration — a deploy AFTER the one that ships the registry-aware writers, once every old pod has drained and the catch-up reports zero backfilled rows for a full 24h (migrations run pre-deploy, so a constraint shipped in the same PR as the writers would be active while old pods still write legacy-shaped rows); until then the columns stay nullable and the 6-hourly catch-up owns the gap. No claim-predicate change ships before this backfill has run; the
step-4 predicate treats a legacy row exactly like a new one (it still needs investigation →
bridge → authority before any send).

**Feeders that call the same endpoint** (as jobs, not UI):
- **Competitor-gap ingestion** — EVERY `seo_competitor_backlinks` domain (the 7,553) through
  the deduping intake: an unknown host inserts a registry row, a known host only adds the
  idempotent `competitor_gap` touch to `seo_link_domain_sources` — so any-touch attribution
  and D30 learning for this source are never lost to prior discovery. Weekly after the
  Sunday scan.
- **Existing profile** — every active, scan-tracked `seo_backlinks` row → a registry domain
  (`source='existing_backlink'`, `agent_state='acquired'`) **plus** a placement and a path,
  so the baselines are real rows, not a flag: ONE representative placement per
  `(target_domain, target_page, location_key)` — placements stay unique on that key — chosen
  deterministically (dofollow preferred, else the earliest active nofollow — ordering by `is_dofollow DESC NULLS LAST, first_seen ASC, id ASC` (`is_dofollow` is nullable — the GSC importer writes null — and `DESC` alone would sort unknown-rel rows first) — so a nofollow-only referring domain still gets its representative and mappings),
  while EVERY inbound `seo_backlinks` row from that host to that page is kept in a new
  one-to-many `seo_link_placement_backlinks (prospect_id, backlink_id UNIQUE)` mapping so no
  link identity is dropped or overwritten; the placement is `seo_link_prospects`
  (`source='existing_backlink'`, `status='live'`, `live_url` = the representative's
  `source_url`, `backlink_id` = the representative's id, `first_live_at = seo_backlinks.first_seen`
  of the representative, `target_page` =
  `targetPageOf(target_url)`, `is_dofollow` from the row) — the verifier/indexer then treat
  it like any placement — but **D30/D90 are never inferred from age**: for an imported link
  they are set only by the §8 sampled rule (a recorded observation inside the D30/D90
  window with no loss event before it, following `merged → detail.into` to the survivor); an import whose cutoffs predate scan coverage stays
  `null` (= unknown, excluded from learning) — a link that vanished and returned, or
  predates scan coverage, must not teach the scorer that its path "survives"; the path is
  `seo_link_acquisition_paths` with `acquisition_type` mapped from the link's classified
  `link_type` (directory/citation → `self_service_free` or `self_service_account`,
  editorial/resource → `editorial_outreach`/`resource_outreach`, else `unknown` pending the
  investigator), `submission_url=source_url`, `confidence` low until investigated, and set
  as `best_path_id` so recursive discovery (§9) can qualify it. A baseline path is written
  with **every required field explicit** so the schema holds without invented authority:
  `account_required=false`, `email_verification=false`, `payment_required=false`,
  `legal_attestation=false`, `agent_completable=false` (⇒ it can never receive an `AUTO_*`
  level), `link_type` = the classified type normalized into the CHECKed lane set (`forum`/`comment`/
`unknown` from `classifyLinkType` → `resource` as the descriptive lane; never left outside
the CHECK), `confidence=0.1`, `last_investigated_at=null`
  and `baseline=true` (new boolean; a baseline path is non-executable by definition — the
  §6.3 validity step already returns `INVALID` on a null `last_investigated_at`, and the
  investigator replaces it with a real path on the first pass). Idempotent via
  `findPlacementRow`/`path_key` for the placement and the UNIQUE `backlink_id` for the mapping (a re-run adds newly seen links to the mapping and never re-picks the representative while it is live; per-link verification and loss events read the mapping, and §8 D30 sampling is per placement following the representative); excluded from acquisition (nothing to acquire) and from the
  Source×funnel *acquired* counts (reported separately as "existing").
- **Legacy signup queue** — the 12 pending `backlink_agent_queue` items (consumed today by
  `backlink-agent/signup-worker.js`) are imported in step 1 by an idempotent
  queue-to-registry intake that runs as the SAME recurring, gate-independent catch-up used for
  legacy prospects/attempts (§3.4: at boot and every 6h under `runExclusive`, and before every
  runner claim) rather than once — a rolling deploy can leave an old pod enqueueing a row after
  the first import — (keyed by `legacy_queue_id`, ON CONFLICT DO NOTHING; `source` =
  the row's `backlink_agent_queue.source` mapped EXHAUSTIVELY to the §3.5 enum — `x_feed`
  (X poller) → `x`, `manual` (admin route) → `owner_seed`, `strategy_agent` → `strategy_agent`,
  `competitor_gap` → `competitor_gap`, `web_discovery` and any other/NULL value →
  `legacy_unknown` — so only the rows an admin typed in get the `owner_seed` prefilter bypass
  and priority, automated discoveries keep their real source for §8 learning, and the verbatim
  value is kept as `source_detail=legacy_queue:<id>:<source>` (`legacy:<value>` form as in the
  prospect backfill), the row's
  status/provenance kept in `investigation.legacy_queue`); the legacy worker's scheduler entry
  is removed in the same PR (new pods stop consuming the queue), but the queue's writers drain
  with the rolling deploy and the table is dropped only by the later cleanup migration, after
  the catch-up has reported zero un-imported rows across a full deploy cycle — so nothing is ever
  stranded in the old queue.
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
- **Fetch:** `contact-finder.fetchPage()` only — HARDENED in step 1 before any bulk intake or
  investigation runs through it, because today it is neither pinned nor bounded (it checks DNS,
  then lets `node-fetch` resolve the host AGAIN — a rebinding TOCTOU — and calls `res.text()`
  before slicing, so responses are fully buffered): the step-1 change gives it an IP-pinning,
  public-only dispatcher (connect to the validated address, `Host` header preserved, every
  redirect hop re-validated the same way — or route it through the §13 egress proxy) and a
  streaming byte cap that aborts the socket at 600 KB, plus a per-hop count bound and
  timeout; `finalUrl` and the bodyless `resolveOnly` mode (§4) ride on the same hardened core. Candidate pages: the hint, the competitor page, and a fixed probe list
  (`/submit`, `/add-listing`, `/join`, `/membership`, `/members`, `/vendors`,
  `/sponsors`, `/advertise`, `/directory`, `/resources`, `/contact`, `/signup`, `/register`)
  — capped at ~8 fetches per domain.
- **Reasoning:** one `WORKHORSE`-tier call through `server/services/llm/call.js` (never a
  hardcoded model id) with a strict JSON schema = the path fields in §3.2 **except every
  `*_cost_cents` field** — the model never emits an amount: it returns the quoted price and
  renewal text verbatim (`price_text`, `renewal_price_text`, each with the page URL it was read
  from) and the investigator derives `estimated_cost_cents` / `renewal_cost_cents`
  deterministically: a **currency gate first** — `currency='USD'` requires an AUTHORITATIVE
  USD code: `USD`/`US$` in the quote itself, OR the checkout/processor metadata the
  investigator observed (`priceCurrency`/`currency` in the offer JSON-LD or the processor's
  session/`currency` field, recorded in `investigation.currency_evidence`); a **bare `$` is
  NOT proof of USD** (Canadian, Australian and other merchants show local prices with the same
  symbol) and yields `currency='unknown'` — price-entry card, never automation; `€`, `£`,
  `CAD`, `A$`, `C$`, `MXN`, any other ISO code or non-USD symbol ⇒ `currency='foreign'`, cents
  null; no marker ⇒ `currency='unknown'`, cents null. The same authoritative USD check is
  repeated against the LIVE checkout before reservation and again before submit (§6.3) — then the shipped
  a NEW `price-scan/extract.parsePriceTextCents()` — the shipped `parsePriceText()` keeps every strictness rule (a range, a percentage, a promo badge, a unit price or an empty string parses to null; it does not validate currency, which is why the gate precedes it) but converts through binary floats (`Math.round(n * 100) / 100`, extract.js:66), losing the original digits, so the plan adds a sibling reusing the SAME rejection rules and single-number match that converts the MATCHED DECIMAL TOKEN directly to integer minor units: strip thousands separators, split on the decimal point, `Number(dollars)*100 + Number((fraction ?? '').padEnd(2,'0') || '0')` (a whole-dollar token like `USD 95` has no fraction — it defaults to '00' → 9500, table-tested), and a token with more than 2 fractional digits returns null BEFORE any Number conversion (→ the price-entry card) — table tests include 10.075; `parsePriceText()` itself is untouched (its price-scan callers tolerate drift; the backlink pipeline never calls it) — so the approved amount, budget reservation, card ceiling and checkout total can never disagree by a cent. `currency` (NOT NULL, CHECK IN ('USD','unknown','foreign') — the ONE enum, identical in the migration, the investigator JSON schema and the tests)
  is a column on the path, copied into every approval `terms_snapshot` and stamped on every
  purchase row; §6.3 never automates a `payment_required` path whose `currency ≠ 'USD'`
  (no conversion is ever performed): `currency='foreign'` ⇒ `OWNER_MANUAL_PAYMENT` (stays
  foreign, manual-only, forever); `currency='unknown'` ⇒ `OWNER_INPUT_REQUIRED` (price-entry
  card) — the ONE rule, restated identically in §6.1 and the §6.3 pseudocode, and the pre-mint/pre-submit final-total read verifies the LIVE checkout currency is
  USD as well as `final_cents` (any other currency ⇒ `voided`, `outcome='price_changed'`).
  An unparseable or non-USD quote leaves the cents null, which §6.3 turns into
  `OWNER_INPUT_REQUIRED` for the payment dimension of a `payment_required` path when the
  currency is merely UNKNOWN (a price-entry card, §6.1; a CONFIRMED non-USD quote goes to
  `OWNER_MANUAL_PAYMENT` instead — the owner cannot change a merchant's checkout currency — never the non-overrideable INVALID, which would send the row back to
  investigation with no owner affordance) until an owner enters the USD amount —
  a hallucinated or mis-scaled number can therefore never reach authority, an approval, or a
  budget reservation — plus
  `confidence` and `reasons`, and — for any `payment_required` path — the `merchant_binding`
  (checkout origin + processor host + processor merchant/account id read from the observed
  checkout chain; a paid path without a resolvable recipient identity is written with a null
  binding and qualifies normally — its payment dimension can only ever be
  `OWNER_MANUAL_PAYMENT`, §6.3). Price/
  renewal text is quoted verbatim into `investigation`.
  `not_reproducible` is a first-class answer (a competitor's editorial mention, a
  private partnership) and closes the domain honestly instead of leaving it "unknown".
- **Outputs:** paths + `best_path_id` (highest expected value per §8) + `agent_state`
  (`qualified` / `not_reproducible` / `watching` when the path exists but is closed today).
- **Cost discipline:** ~8 fetches + 1 LLM call per domain; batch of N per run
  (`LINK_INVESTIGATOR_BATCH`, default 50); `owner_seed` jumps the queue. Re-investigate on
  `watch_recheck_at`, on a failed attempt, or after 90 days. The selector is path-based, not
  only domain-based: it also takes every path with `last_investigated_at IS NULL` (baseline
  imports on `acquired` domains included) and re-investigates it without touching the
  domain's aggregate `agent_state`, so an imported baseline gets its promised first pass and
  can become a real, reproducible path for recursive discovery.

This step is what turns the gap table into an **acquisition inventory**. Nothing enters the
acquisition queue without a path row with `confidence ≥ policy.min_path_confidence`.

---

## 6. Acquisition authority — permission, separated from quality

### 6.1 Levels (`authority` on path + placement)

`AUTO_FREE` · `AUTO_ACCOUNT` · `AUTO_OUTREACH` · `AUTO_PAID_WITHIN_POLICY` ·
`OWNER_FREE` · `OWNER_ACCOUNT` · `OWNER_OUTREACH` · `OWNER_PAYMENT` · `OWNER_MANUAL_PAYMENT` (payment only ever outside the system) · `OWNER_MEMBERSHIP` · `OWNER_LEGAL` · `OWNER_HUMAN_STEP` · `OWNER_INPUT_REQUIRED` (payment dimension only: the path is otherwise valid but its price is unparseable or its currency is UNKNOWN (`currency='unknown'` — a bare `$` or no marker); a CONFIRMED non-USD quote (`currency='foreign'`) is NEVER routed here — it is `OWNER_MANUAL_PAYMENT`, because an owner entry cannot change a merchant's checkout currency — parked `awaiting_owner` with a PRICE-ENTRY card, never a purchase approval; the owner's entry writes `estimated_cost_cents`/`renewal_cost_cents` + `currency='USD'` (the owner's entry is an ATTESTATION that this merchant's checkout is USD, stored as a dedicated IMMUTABLE audited row in `seo_link_currency_attestations` (id, path_id, merchant_binding snapshot + its hash, attested_by/at, invalidated_at) referenced by `path.currency_attestation_id` — never inside the mutable `investigation` JSON — and, because it can unlock automated money movement, it is a payment input: its id+hash are part of `revision_payment`, the payment `decision_inputs_hash`, the approval snapshot and the pre-mint/pre-submit validation (the live check re-reads the row, requires `invalidated_at IS NULL`, and requires its merchant-binding hash to equal the path's CURRENT canonical `merchant_binding` hash) — it is the authoritative USD evidence the live-checkout guard accepts for THIS merchant binding when the checkout itself shows only a bare `$`; the guard still voids on any explicit non-USD marker on the live page, on a merchant-binding change (which invalidates the attestation), and on every amount/merchant check as before) on the path as an owner-sourced revision (bumps `revision_payment`, recorded as a `human` attempt `outcome='price_entered'`), after which the bridge re-decides normally — an entered price is an INPUT, never an approval) · `OWNER_OVERRIDE` (the audit label of a floor-waiver row in `seo_link_floor_waivers` only — never a dimension level and never an approval row, §6.3 1b) · `DENY` · `INVALID`

`INVALID` (data/money validity, missing investigation) is not overrideable by anyone;
`DENY` (quality policy) is overrideable only by the owner's explicit click, which is recorded.

**Paid is an attribute of a path; it is not a workflow state.** The level is *computed* from
the path's attributes and the policy at decision time, then stamped for the audit trail.

### 6.2 Policy (`seo_link_policy`, Policy panel on the Agent tab)

```text
# SHIPPED DEFAULTS — every AUTO capability is OFF/null until the owner edits it in the
# Policy panel (each edit is an audited row). Enabling GATE_LINK_AUTHORITY with these
# defaults changes nothing: every row still routes to the owner.
auto_free_acquisition        = false     (false ⇒ AUTO_FREE never granted; free self-service paths route to OWNER_ACCOUNT-style parking)
auto_account_creation        = false
auto_outreach_min_score      = null      (null ⇒ AUTO_OUTREACH never granted)
auto_outreach_daily_cap      = 0         (≤ LINK_OUTREACH_DAILY_CAP, the hard ceiling; enforced INSIDE the sender's lock, §6.4)
auto_submission_daily_cap    = 0         (form/profile submissions per ET day across ALL providers; a submission SLOT is reserved atomically inside the locked claim — a `seo_link_attempts` row with outcome='slot_reserved' for the ET day — and the cap counts slot_reserved + submitting + submit_ambiguous + `mutation_ambiguous` rows with `action='submit'` + completed submissions for that `slot_day` (in-flight and unresolved work holds its slot until a terminal, reconciled outcome; `slot_released` rows never count); re-checked before submit; 0 ⇒ no automated submissions)
owner_price_tolerance_cents  = 0
presentment_window_days      = 10        (minimum wait after last card exposure — `card_exposed_at` — before an ambiguous purchase may be reconciled as not charged; may only be raised)
monthly_paid_budget_cents    = 0         (AUTO spend only; 0 ⇒ AUTO_PAID_WITHIN_POLICY never granted; every money field is integer cents, end to end)
owner_monthly_budget_cents   = null      (OWNER-approved spend; null ⇒ no software cap beyond each approval's max_payable_cents and the issuer program limit; set to cap total approved spend per ET month)
max_auto_purchase_cents      = 0
auto_paid_min_score          = null
auto_paid_min_d30_confidence = null
min_score                    = 60        (floor for ANY action, auto or owner-routed)
membership_requires_owner    = true
legal_attestation_requires_owner = true
min_path_confidence          = 0.6
max_spam_score               = 10
preferred_provider           = 'deterministic_runner'   (CHECK against the provider enum; the benchmark winner is written here by an audited owner edit)

# Suggested first working values (owner sets them; recorded here only as the proposal):
#   auto_free_acquisition=true · auto_account_creation=true · auto_submission_daily_cap=10 (required — 0 blocks every runner submission) · auto_outreach_min_score=80 · auto_outreach_daily_cap=10 ·
#   monthly_paid_budget_cents=50000 · max_auto_purchase_cents=5000 · auto_paid_min_score=80 ·
#   auto_paid_min_d30_confidence=0.6
```

### 6.3 Decision (pure function, unit-tested; recorded on the placement)

**Payment and communication are independent authorities.** The decision returns a SET of
required authorities, one per dimension the path touches: `payment` (when
`payment_required`), `communication` (when the path is an outreach/content type), and
`execution` — derived from the path's REQUIRED ACTIONS, not its label: every non-outreach type (free/account/claim/membership/human-step) AND any outreach/content path whose flags require execution steps (`account_required=true`, a form/`content_submission` submit, or `legal_attestation=true` → the `accept_terms` instance): such a path carries communication (the message) AND — only when `account_required` or a form/`content_submission` submit exists — an `acquire` execution instance (account creation + submit) AND — only when `legal_attestation=true` — a SEPARATE `accept_terms` execution instance (a plain resource/editorial/partnership path whose sole execution flag is `legal_attestation` gets `accept_terms` ALONE, no `acquire`; exactly what the §6.3 2a pseudocode emits) — up to three rows, each decided and approved separately — a send approval is never permission to create an account or submit a form, and approving the agreement never authorizes the submission; the legal case, §3.3b: the function then emits BOTH the communication decision AND
an execution decision for that instance — `OWNER_LEGAL` when
`policy.legal_attestation_requires_owner` (default true), else the normal execution rules
(`AUTO_ACCOUNT`/`AUTO_FREE` per policy, the acceptance still bound to `legal_terms_hash`) —
never the general `acquire` execution row). A paid guest post therefore needs
BOTH an `AUTO_PAID_WITHIN_POLICY`/`OWNER_PAYMENT` decision AND an
`AUTO_OUTREACH`/`OWNER_OUTREACH` decision with its exact-draft approval; the claim,
reservation and send/submit steps require every dimension's gate/approval to be satisfied
before the irreversible action, and `DENY`/`INVALID` in any dimension wins. The pseudocode
below is written per dimension; the set is stored in `seo_link_placement_authorities`
(§3.3b) and the placement's `authority` column is only the most restrictive level, for display.

```
# 1a. VALIDITY — non-overrideable. Not policy: data and money that cannot be acted on by
#     anyone, including the owner. "Acquire anyway" never reaches these rows.
if not all finite(domain.spam_score, score, path.confidence) → INVALID        # unenriched / uninvestigated
if path.acquisition_type in (not_reproducible, unknown) → INVALID             # nothing to execute
if path.last_investigated_at is null → INVALID
if path.link_type not in CLAIMABLE_LINK_TYPES → INVALID              # the shipped claim() filters on these lists; an unclaimable lane never gets authority
if any of (account_required, email_verification, payment_required, legal_attestation, agent_completable, terms_accepted_by_send, execution_after_send) is not a literal boolean → INVALID   # every NOT NULL authority input of §3.2; table-tested per field
if flags inconsistent with acquisition_type (see §3.2) → INVALID
if path.execution_after_send == false and path.terms_accepted_by_send == true → INVALID   # deadlock: the submit would require accept_terms, which only the (post-submit) late send performs — send-accepted terms force send-first ordering; re-investigation must flip one flag
if path.payment_required and (not (Number.isSafeInteger(amount_cents) and amount_cents > 0) or path.currency !== 'USD'):
    if path.currency is a CONFIRMED non-USD currency (investigator read an explicit €/£/CAD/… marker, stored as currency='foreign'):
        payment dimension → OWNER_MANUAL_PAYMENT   # the merchant's checkout currency cannot be changed by an owner entry; the live-checkout guard would void every attempt — the owner pays outside the system
    else payment dimension → OWNER_INPUT_REQUIRED   # unmarked/uncertain/unparseable quote only: no conversion, ever; NOT INVALID — the placement parks awaiting_owner with a price-entry card (§6.1) so the owner can supply the USD amount; every other dimension still evaluates; no AUTO_* or purchase approval can exist until the entry lands
if path.legal_attestation and not validLegalTermsHash(path.legal_terms_hash) → INVALID   # 64 lowercase hex chars; an attestation with no bound agreement text is never actionable (§3.2)
# 1b. QUALITY POLICY floors — fail-closed, evaluated before any AUTO_* or OWNER_* branch.
#     A row that fails one is DENY regardless of who would have acted. The ONLY way past DENY
#     is the owner's explicit "Acquire anyway" click, which does NOT stamp an authority: it
#     writes an immutable FLOOR WAIVER (`seo_link_floor_waivers`: domain/path, the exact
#     floors waived with their values, inputs hash, approved_by/at; invalidated when those
#     inputs change). With a valid waiver the floors are treated as passed and the NORMAL
#     per-dimension decision below runs, so every dimension still gets its own AUTO_*/OWNER_*
#     level and its own action-matching approval; a waived row can still never become AUTO_*
#     for a dimension whose AUTO switch is off. The waiver is stored INDEPENDENTLY of the
#     level: the authority row records the UNDERLYING per-dimension level (OWNER_HUMAN_STEP
#     stays OWNER_HUMAN_STEP, OWNER_MANUAL_PAYMENT stays OWNER_MANUAL_PAYMENT, an AUTO_* level
#     only when its switch grants it) plus `floor_waiver_id` → `seo_link_floor_waivers`;
#     OWNER_OVERRIDE is never written as a dimension level and never as an approval row — it is
#     the audit label of the `seo_link_floor_waivers` row alone (approved_by/at, floors, inputs hash,
#     invalidated_at), which authorizes no action instance. Claimability therefore always consults the
#     underlying level: a waived human-step or manual-payment dimension is exactly as
#     unleasable as an unwaived one.
if domain.spam_score > policy.max_spam_score
   or path.confidence < policy.min_path_confidence
   or score < policy.min_score → DENY
# 2. Authority (only reached by rows that passed every floor). Dimensions are decided
#    INDEPENDENTLY and the result is the SET {execution|communication, payment?}; no branch
#    returns early for the whole placement — an OWNER_* verdict in one dimension never
#    suppresses the payment decision for a paid path.
# Policy thresholds are compared ONLY when explicitly configured: `configured(x)` = x is a
# finite number (not null/undefined/NaN). JS compares `5 >= null` as true, so a null
# threshold must never reach a comparison — an unconfigured AUTO capability is simply absent.
# Each dimension below is a CLOSED branch: first matching rule assigns that dimension and
# nothing later in the same dimension can overwrite it; dimensions never assign each other.
OUTREACH_TYPES = (resource_outreach, editorial_outreach, partnership, content_submission)

# 2a. EXECUTION dimension — every non-outreach type, PLUS any outreach type whose required actions include
#     execution steps (account_required, a form/content submission, or legal_attestation → the accept_terms instance)
if path.acquisition_type not in OUTREACH_TYPES or path.account_required or path.acquisition_type == content_submission or path.legal_attestation:
    # TWO execution instances when both apply: `acquire` (-:n) and, independently, `accept_terms` (terms:n)
    if path.legal_attestation:
        execution[accept_terms] = OWNER_LEGAL if policy.legal_attestation_requires_owner else (AUTO_ACCOUNT if auto_account_creation === true else OWNER_ACCOUNT)
    if path.acquisition_type not in OUTREACH_TYPES or path.account_required or path.acquisition_type == content_submission:
      execution[acquire] =
        OWNER_HUMAN_STEP  if not path.agent_completable                                                   # a human must act; never AUTO_*
        else OWNER_MEMBERSHIP if path.acquisition_type in (membership, association, sponsorship) and policy.membership_requires_owner
        else (AUTO_ACCOUNT if auto_account_creation === true else OWNER_ACCOUNT) if path.account_required
        else (AUTO_FREE if auto_free_acquisition === true else OWNER_FREE)

# 2b. PAYMENT dimension — for EVERY paid path, independent of 2a/2c.
#     CLOSED to step 1's result: if step 1 already assigned the payment dimension (OWNER_INPUT_REQUIRED /
#     OWNER_MANUAL_PAYMENT for a missing, non-positive, unsafe or non-USD amount) this block is SKIPPED —
#     it never re-assigns. The automatic branch is additionally guarded on its own inputs, so even a
#     bug in the skip cannot promote a null amount (`null <= cap` is true in JS): 
if path.payment_required and payment is unassigned:
    assert Number.isSafeInteger(amount_cents) and amount_cents > 0 and path.currency === 'USD'  # else → OWNER_MANUAL_PAYMENT, never AUTO
    payment =
        OWNER_MANUAL_PAYMENT if not valid(path.merchant_binding)                                            # no resolvable recipient identity: automated purchase flow closed
        else AUTO_PAID_WITHIN_POLICY if configured(max_auto_purchase_cents) and configured(monthly_paid_budget_cents)
                                    and configured(auto_paid_min_score) and configured(auto_paid_min_d30_confidence)
                                    and max_auto_purchase_cents > 0 and monthly_paid_budget_cents > 0
                                    and amount_cents ≤ max_auto_purchase_cents and score ≥ auto_paid_min_score
                                    and Number.isFinite(d30_conf) and 0 ≤ d30_conf ≤ 1                       # null/NaN NEVER passes (`null >= 0` is true in JS); no D30 evidence ⇒ no automatic spend
                                    and Number.isFinite(auto_paid_min_d30_confidence) and 0 ≤ auto_paid_min_d30_confidence ≤ 1
                                    and d30_conf ≥ auto_paid_min_d30_confidence
                                    and (month_spend_cents + amount_cents) ≤ monthly_paid_budget_cents
        else OWNER_PAYMENT

# 2c. COMMUNICATION dimension — only for outreach/content types (guest posts / content always pass the outreach mandate)
if path.acquisition_type in OUTREACH_TYPES:
    communication =
        OWNER_LEGAL if path.legal_attestation and policy.legal_attestation_requires_owner                    # a signed agreement / vendor terms is never accepted under AUTO_OUTREACH; the owner's OWNER_LEGAL approval (action outreach_send) is the send authority, and the acceptance itself needs the separate execution/accept_terms approval bound to legal_terms_hash (or a human performs it: OWNER_HUMAN_STEP)
        else AUTO_OUTREACH if configured(auto_outreach_min_score) and configured(auto_outreach_daily_cap) and auto_outreach_daily_cap > 0
                            and score ≥ auto_outreach_min_score and a lint-clean draft EXISTS and passes §6.4 (evaluated after drafting — §7)
        else OWNER_OUTREACH   # the draft goes to the existing approval queue; the auth'd send click IS the approval row (action='outreach_send', bound to the draft hash) — no draft yet ⇒ the row simply awaits a draft lease, no card

return { execution | communication, payment? }   # the complete set; a paid membership carries BOTH OWNER_MEMBERSHIP and its payment verdict
```
The function is pure and unit-tested with a table of (path, domain, policy) → level cases,
including one per policy floor proving DENY beats every AUTO_* and OWNER_* branch, one per
required signal proving null / NaN / undefined → INVALID, one proving `legal_attestation=true`
with a null/malformed `legal_terms_hash` → INVALID, one proving a waived OWNER_HUMAN_STEP
dimension is still recorded as OWNER_HUMAN_STEP (unleasable), and one proving a floor waiver is
refused on INVALID (an unenriched or uninvestigated domain, or invalid money, can never be
acted on by anyone until enrichment and investigation have run).

**Bridge — how an investigated domain becomes claimable (part of step 4).** A nightly
`link-authority` job takes (a) every `qualified` domain with a `best_path_id` and (b) every
existing placement whose authority rows are STALE — their `decision_inputs_hash` or
`path_revision_<dimension>` no longer matches the current inputs, or the policy/spend/D30
inputs changed since `decided_at` — whatever the domain's aggregate state (when it
re-decides a placement that already holds an open purchase — `reserved`/`submitting`/
`close_pending`/`ambiguous` — the §6.3 budget input `month_spend_cents` EXCLUDES that
placement's own open reservation, exactly as the pre-mint check and the renewal claim do, so
a purchase that filled the remaining budget is never double-counted into a downgrade); and,
per domain, inside one transaction under `claimProspectDomain`/`findPlacementRow`: chooses the Waves
money page for the placement (scorer topic mapping → `targetPageOf`; homepage for
listing-style paths) and, for signup-lane paths, **one placement per GBP location**
(`location_key`, from `config/locations.js` — the existing runner's per-location identity,
preserved), creates the `seo_link_prospects` row (`domain_id`, `path_id`,
`source` = the domain's first-touch source, `link_type` = the path's lane) if none exists
for that **(domain, page, location_key)** — the same triple `findPlacementRow` matches and the
unique key enforces, so a second GBP location is never suppressed by the first — with the
path's `fee_scope` (investigator output, CHECK IN ('per_location','account_wide'); required when
`payment_required`) deciding how payment is modelled: `account_wide` (one membership/association
fee covering every profile on the shared account) creates only the PAYMENT GROUP (`payment_group_id` = the first placement's id) and links every sibling to it via
`seo_link_prospects.payment_group_id` — NO purchase row exists at bridge time (a purchase needs a positive amount, a state and, when owner-gated, an approval; for paid outreach nothing is reserved until the publisher exposes a checkout, §7) — the ONE shared purchase is reserved in the locked checkout-time reservation and its id is then attached as `purchase_id` to every sibling's payment authority row; every sibling still gets its OWN payment authority
row (the claim contract loads per-placement authorities, unchanged) with `level` copied
from the group's decision — and a sibling created LATER (a new GBP location after the group's purchase already settled) is linked to that settled purchase (`purchase_id`) and its payment instance marked `satisfied_at` (`satisfied_reason='group_purchase'`) in the bridge transaction that creates it ONLY IF that purchase's immutable `terms_snapshot.fee_scope = 'account_wide'` (the scope the money bought — a purchase settled while the path was `per_location`, e.g. before an owner's fee-scope regroup, covers one location only and satisfies no sibling; the bridge then opens the group's SCOPE-EXPANSION payment instance instead — `purchase_kind='scope_expansion'`, keyed `${payment_group_id}:scope_expansion:${prior_purchase_id}:${generation}` with `prior_purchase_id` → the per-location settled purchase (FK + CHECK paired with the kind, like `failed_purchase_id`), so the all-time duplicate guard (which matches `purchase_kind`) rightly refuses a second `initial` yet admits this one; its approval action is `purchase`, its settlement must read `terms_snapshot.fee_scope='account_wide'` from the live checkout, and that settlement satisfies every sibling the prior purchase did not cover (regression tests cover both regroup directions — account_wide→per_location needs no new kind: each later location opens its own initial purchase in its own group)) AND its paid term is still ACTIVE at bridge time, both read from the SETTLED PURCHASE ROW (never from the new sibling, whose own `paid_through`/`renews_at` are still NULL and would make an expired term look non-expiring): the group's latest settled purchase (the SETTLED-PURCHASE predicate of §6.3: `state IN ('charged','reconciled_charged','manual_charged')` — the three terminal paid states of the §7 transition table, `charged` being the normal automated success — OR the settled zero-total completion `voided` + `void_reason='no_payment_required'` + `settled_at`; any `purchase_kind`) has `paid_through IS NULL` (its immutable `terms_snapshot.renewal_period = 'one_time'` — a non-expiring fee) OR `paid_through >= etDateString(now)` (both are ET calendar `date` values compared as dates via `server/utils/datetime-et.js`, never `date >= now()` — a timestamp comparison can expire the term during its final ET day), AND the group anchor placement's `renewal_status` (§3.3 — the placement whose id is `payment_group_id`) is not `lapsed`; a sibling added after the purchased term ended is NOT satisfied by the stale purchase — the bridge instead opens the group's renewal payment instance (or a new initial one if the membership was never renewable), which takes the ordinary §3.3b/§6.3 route (owner approval where the level requires it, budget reservation, one shared renewal purchase whose settlement satisfies every sibling) — since the all-time guard rightly refuses a second initial purchase for the group and `purchase_id` → the group's purchase, and the settlement
of that one purchase marks `satisfied_at` on EVERY row in the group in the same transaction, and every OTHER sibling already parked in `ready_for_payment` for this group is RESUMED without a checkout: the acquire predicate (`claim(?mode=acquire)`, §7) admits a `ready_for_payment` placement whose payment instance is `satisfied_at IS NOT NULL` — the SATISFIED-GROUP RESUME — re-binding its retained `slot_reserved` submit attempt through `handoff_lease_token` (§3.3) so the successor performs the final submit exactly like a $0 completion, leaving `ready_for_payment` for Judge verification on the `placed` (pending-flagged or not) report; such a lease can never mint (a mint requires an open purchase reservation, and a satisfied group has none), and `mode=payment` — which requires an open reservation — never leases them
(a sibling's payment row is never independently approvable or reservable — its card is the
group's; the §3.3b approval rule is therefore GROUP-scoped for the payment dimension: a
sibling's `approval_id` references the group's approval, whose `prospect_id` is the group
anchor placement, and the attach/claim equality check accepts an approval whose
`prospect_id = payment_group_id` of the placement being leased, with dimension/action/
instance/hash/level equality unchanged — one owner click, valid for every row it covers) (the purchase/duplicate guard and renewal are keyed by
the group; siblings' payment dimension is satisfied by the group's settled purchase and never
reserves), while `per_location` keeps a purchase per placement — runs the
§6.3 decision, stamps `authority` on the **placement**
(the path only receives the informational `authority_last_decided`, which does not bump its
revision — so approval never invalidates itself), and then **recomputes the registry aggregate across ALL of the domain's placements** (§3.1):
`ready_to_acquire` if any placement is authorized and pending; `acquiring`/`acquired` per the
aggregate rules; `rejected` ONLY when no placement is authorized, pending, awaiting the owner
or acquired (a single `DENY` beside an approved sibling never rejects the domain); `INVALID`
on every placement → back to `investigating`. Per-placement outcomes are stored on the
placement (`OWNER_*` → `awaiting_owner` + card — EXCEPT a DEFERRED payment dimension on an outreach path (§3.3b: `OWNER_MANUAL_PAYMENT`/`OWNER_PAYMENT` before the publisher has exposed a checkout): the placement stays in its communication flow (`prospect`/`contacted`/`negotiating`, drafts and sends proceed) and is parked for the payment card only when it reaches `ready_for_payment`; EXCEPT a RENEWAL payment dimension: a `placed`/`live`/`indexed` placement keeps its Judge-owned status untouched while the renewal card is pending — the pending approval is attached to the renewal authority instance/reservation, the verifier keeps monitoring it and the renewal claim stays eligible — and EXCEPT a communication dimension decided
to ANY unsatisfied owner-gated level (`OWNER_OUTREACH` or `OWNER_LEGAL` on the communication
dimension) while no draft exists yet: that placement stays `prospect` with no card so the
draft-only claim (`mode=draft`, which leases `prospect` rows regardless of authority) can
produce the draft; the bridge re-decides once the draft exists and only then parks it
`awaiting_owner` for the send/legal approval, whose `action_hash` binds that draft — an
approval that must bind a draft is never requested before the draft exists; `DENY` → reasons + override affordance). The job is
idempotent and re-runs the decision whenever ANY §6.3 input changes — policy, path
revision, domain enrichment (`spam_score`, DR/traffic), `score`, path `confidence`, D30
evidence, month spend — for already-bridged placements too: a stale stamp is replaced (or a
fresh owner card issued) by the next run, so a loosened policy releases queued work and a
tightened one re-parks it, rather than leaving rows to fail closed forever at claim time. **A stamp is never trusted on its own:** the claim predicate and the
budget reservation both re-run the pure §6.3 decision on the *current* inputs inside their
locked transaction and refuse (409, row re-parked) unless it still supports the stamp:
for `AUTO_*` and `OWNER_*` stamps the current result must equal the stamp; for a
dimension granted under a floor waiver the waiver must still be valid (its
`overridden_floors[]` and inputs hash match the current floors/inputs — an override is
honoured only for the exact failure the owner looked at) AND — when the underlying level is `OWNER_*` — the dimension's own approval
must be valid exactly as for any unwaived `OWNER_*` row (an underlying `AUTO_*` level needs NO approval row, waived or not: the ONE rule, §3.3b/§7 — a waiver never adds an approval requirement and never removes one) — so a row whose confidence dropped or whose domain's spam
rose after stamping cannot send or spend. Approvals additionally bind to a `decision_inputs_hash` (§3.6b).

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
t.string('purchase_kind').notNullable().defaultTo('initial'); // CHECK (purchase_kind IN ('initial','renewal','reacquisition','path_retry','scope_expansion')) — each renewal / reacquisition / path_retry is its own separately authorized purchase
t.integer('generation').notNullable().defaultTo(1); // bumps only when the prior generation of the SAME kind/period ended voided / reconciled_not_charged
t.string('renewal_period_key');                     // for renewals: the period being bought, e.g. '2027' or '2026-11' — null for initial; CHECK ((purchase_kind IN ('initial','reacquisition','path_retry','scope_expansion') AND renewal_period_key IS NULL) OR (purchase_kind = 'renewal' AND renewal_period_key ~ '^[0-9]{4}(-[0-9]{2})?$')) — scope_expansion regression-tested with the null key; reacquisition rows carry `loss_event_id` (uuid, CHECK ((purchase_kind = 'reacquisition') = (loss_event_id IS NOT NULL))) — a renewal can never carry a null/empty key, so idempotency keys, approvals and instance keys never collapse onto ':renewal:null:'
t.jsonb('terms_snapshot').notNullable();            // IMMUTABLE copy taken at reservation and re-confirmed at submitting from the checkout page: renewal_period, renewal_cost_cents, term_start (as displayed), term_end / paid_through (computed from term_start + renewal_period), auto_renew_disabled, fee_scope (the scope the money actually bought, copied from the path at reservation — the late-sibling bridge proves coverage on THIS field, §6.2), legal terms shown — renewal scheduling reads ONLY this row, never the (mutable, supersedable) path
t.date('term_start'); t.date('paid_through');       // CALENDAR terms as `date` columns (the merchant states a day, not an instant) — parsed once from the checkout text into an ET calendar day via the datetime-et utilities; the renewal job compares with `etDateString(now)`, never with a UTC timestamp, so DST/midnight can't shift a renewal
t.string('idempotency_key').notNullable().unique(); // initial: `${payment_group_id}:initial:${generation}` (path-INDEPENDENT — a payment group is paid for once, whatever path it was moved to); renewal: `${payment_group_id}:renewal:${renewal_period_key}:${generation}`; reacquisition: `${payment_group_id}:reacquisition:${loss_event_id}:${generation}` — never month-scoped
t.integer('amount_cents').notNullable();            // reserved amount, integer cents (never decimal); CHECK (amount_cents > 0)
t.string('currency').notNullable();                 // the currency of amount_cents/final_cents — ALWAYS 'USD': CHECK (currency = 'USD'); automated rows copy it from the path at reservation (a reservation cannot exist in any other currency, and the pre-mint/pre-submit read verifies the live checkout currency against it); a manual settlement's amount_cents/final_cents = the USD amount actually settled on the owner's own statement/receipt (what budgets and cost reporting count)
t.string('original_currency'); t.integer('original_minor_units'); // FOREIGN MANUAL SETTLEMENTS ONLY (currency='foreign' paths): the merchant's currency (ISO 4217) and the charged amount in its minor units as shown on the receipt, for audit — CHECK ((original_currency IS NULL) = (original_minor_units IS NULL)) AND CHECK (original_currency IS NULL OR state = 'manual_charged'); never used for budgets, which read the USD settled amount only; no conversion is ever computed by the system — the owner enters both figures from the receipt
t.integer('final_cents');                           // the checkout's final total incl. tax/fees, read before submitting; CHECK (final_cents IS NULL OR final_cents >= 0)
t.integer('captured_cents');                        // the AUTHORITATIVE sum actually captured per the issuer's transaction record (all captures/adjustments on issuer_card_id summed), written by the reconciler before charged/reconciled_charged; CHECK (captured_cents IS NULL OR captured_cents >= 0); cost reporting and the budget query read COALESCE(captured_cents, final_cents, amount_cents) ONLY for terminally settled rows (charged / reconciled_charged / manual_charged — `charged` is terminal, there is no charged → reconciled edge); an open purchase reserves its full exposure GREATEST(captured_cents, final_cents|amount_cents) — see the §6.3 budget query
t.string('authority').notNullable();                // CHECK (authority IN (the §6.1 enum))
t.uuid('failed_purchase_id');                       // → seo_link_purchases (path_retry only): the charged-but-never-acquired purchase this retry replaces; CHECK ((purchase_kind = 'path_retry') = (failed_purchase_id IS NOT NULL))
t.uuid('prior_purchase_id');                        // → seo_link_purchases (scope_expansion only, §6.2): the per-location settled purchase the reviewed account-wide regroup expands past; CHECK ((purchase_kind = 'scope_expansion') = (prior_purchase_id IS NOT NULL)); idempotency key `${payment_group_id}:scope_expansion:${prior_purchase_id}:${generation}`
t.uuid('loss_event_id');                            // → seo_backlink_events (the EXISTING durable loss ledger; FK to its verified `lost` event row — no new table); CHECK ((purchase_kind = 'reacquisition') = (loss_event_id IS NOT NULL)) — the reacquisition idempotency/duplicate key component
t.uuid('payment_group_id').notNullable();           // = the placement's payment_group_id at reservation (§3.3); the idempotency keys below, the all-time duplicate guard, renewals and reacquisitions are keyed by payment_group_id, so sibling locations of an account-wide fee can never reserve or renew it twice
t.string('authority_class').notNullable();          // CHECK (authority_class IN ('auto','owner')) — stamped at insert from `authority` (AUTO_PAID_WITHIN_POLICY ⇒ 'auto'; every OWNER_* and manual settlement ⇒ 'owner'); the §6.3 month_spend_cents query filters on it so the AUTO and OWNER budgets never mix
t.string('state').notNullable();                    // CHECK (state IN ('reserved','voided','submitting','close_pending','charged','ambiguous','reconciled_charged','reconciled_not_charged','manual_charged')) — the complete enum; the budget/duplicate guards enumerate exactly these, so no other value can ever exist. `manual_charged` = an owner-paid purchase (OWNER_MANUAL_PAYMENT or auto_renew_unavoidable) recorded by the human settlement: inserted terminal in one transaction with the `human` attempt under the `link_budget:<YYYY-MM>` advisory lock with the same group-keyed `idempotency_key` (`${payment_group_id}:initial:${generation}` / renewal / reacquisition key — a double-submitted form, or a sibling location's form for the same account-wide fee, is a no-op) and the all-time open/settled DUPLICATE guard: the settlement is REFUSED (409) while the placement has ANY `reserved`/`submitting`/`close_pending`/`ambiguous` purchase (an automated purchase must be conclusively settled or voided first) or an already-settled purchase for the same kind/period — but it is NEVER refused by the budget: the money already left, so a completed settlement is always recorded (it counts toward the owner budget going forward) and any overage is reported as a `budget_overage` notification, not a rejection; for a `currency='foreign'` path the form requires the receipt's original currency + minor units AND the USD amount settled on the owner's statement (`original_currency`/`original_minor_units` + `amount_cents`), so a foreign charge enters the ledger truthfully instead of being mislabeled USD, with amount/final_cents, receipt as merchant_ref, terms_snapshot and paid_through — it counts in the owner budget, the duplicate guard and cost reporting, and the paid term is written from it, never from the attempt alone
                                                    // reserved → voided (pre-exposure only) | reserved → submitting → close_pending → charged | submitting → ambiguous → reconciled_charged | reconciled_not_charged
t.uuid('approval_id');                              // → seo_link_approvals (dimension='payment', action = 'purchase' for purchase_kind IN ('initial','reacquisition','path_retry','scope_expansion'), 'renewal' for 'renewal') when authority is OWNER_*; CHECK: required unless authority = AUTO_PAID_WITHIN_POLICY OR state = 'manual_charged' (a manual settlement records a payment the owner already made — the settlement form click IS the owner's act; no pre-payment approval row exists or is required)
t.text('merchant_idempotency_key');                 // sent to the merchant/checkout where supported (= idempotency_key)
t.timestamp('submitting_at');
t.text('merchant_ref');                             // merchant order/receipt id ONLY — never card data
t.jsonb('merchant_binding');                        // IMMUTABLE at reservation, copied from the path: { checkout_origin, processor: { host, merchant_account_id? }, issuer_merchant_descriptor? }. NULLABLE only for `manual_charged` rows (the owner paid outside the system; the receipt is the record). For AUTOMATED purchases it is REQUIRED and there is ONE enforcement mode, fail-closed: `processor.merchant_account_id` (the independently verified processor/acquirer merchant account identity captured at investigation) MUST be present and is validated immediately before mint AND before submit against the LIVE checkout (origin + the merchant/account id read from the live session/form). `issuer_merchant_descriptor` is SUPPLEMENTAL evidence only (descriptors are neither unique nor immutable) — it is used to apply an issuer lock where supported and to cross-check reconciliation, never as the binding. A processor HOST alone never binds anything; no verifiable merchant account id ⇒ the path's payment dimension is OWNER_MANUAL_PAYMENT and no automated reservation is ever created
t.text('issuer_card_id'); t.string('card_last4', 4); // opaque issuer identifier of the single-use card + last4; the PAN is NEVER persisted anywhere
t.boolean('issuer_lock_applied');                   // written ATOMICALLY with issuer_card_id from the issuer's mint response (true only when the issuer confirms a merchant lock is on the card) — defence in depth on top of the merchant-account-id binding, never a substitute for it; if the issuer program declares lock support but the mint returns without it, the post-mint failure path applies (§6.3): the card is closed immediately and the row goes `submitting → ambiguous` with `card_exposed=false`
t.timestamp('card_closed_at');                      // set the instant the card is closed at the issuer (charged/voided/ambiguous); reconciled_not_charged requires it
t.boolean('card_exposed').notNullable().defaultTo(false); // COMMITTED true (with card_exposed_at) BEFORE the worker requests PAN/CVV from the issuer — conservatively, since the fetch/hand-over and the DB write cannot be atomic: a crash anywhere after that commit (including before the card was actually used) takes the exposed/ambiguous path with the full presentment window; card_exposed=false therefore proves the card details were never even requested;
t.timestamp('card_exposed_at');                     // written ATOMICALLY in the same UPDATE that sets card_exposed=true (CHECK (card_exposed = (card_exposed_at IS NOT NULL))); the presentment window (§6.3) is measured from THIS instant — never from submitting_at, which precedes the mint; a purchase that became `ambiguous` with card_exposed=false (post-mint precondition failure, never presented) may be reconciled_not_charged as soon as the issuer confirms the card is closed with no transaction — no presentment wait, because nothing could have been presented
t.text('lease_token'); t.string('leased_by'); t.timestamp('leased_at'); t.timestamp('lease_expires_at'); // PURCHASE-level lease; token is TEXT = the retained worker contract's ISO `claimed_at` lease_token (never a second token type): every purchase transition is conditional on lease_token (the placement lease alone cannot represent renewal work while the placement is live); a claim sets it, a report/sweep clears it; a stale worker's token matches 0 rows
t.text('evidence_url'); t.timestamp('reserved_at'); t.timestamp('settled_at');
t.string('void_reason');                            // CHECK (void_reason IS NULL OR void_reason IN ('pre_exposure','budget_month_rollover','no_payment_required','free_checkout_failed')) AND CHECK ((state = 'voided') = (void_reason IS NOT NULL)) — the ONLY terminal reason the purchase row carries (execution outcomes live on seo_link_attempts); `no_payment_required` + `settled_at` is the settled zero-total completion (§6.3), every other void is not settled
```

- **Reserve before exposing credentials.** The decision in §6.3 does NOT read a sum of past
  attempts. It runs inside one transaction: `pg_advisory_xact_lock(hashtext('link_budget:<YYYY-MM>'))`
  → `month_spend_cents = COALESCE(SUM(CASE WHEN state IN ('charged','reconciled_charged','manual_charged') THEN COALESCE(captured_cents, final_cents, amount_cents) ELSE GREATEST(COALESCE(captured_cents, 0), COALESCE(final_cents, amount_cents)) END), 0) WHERE budget_month = <ET month> AND authority_class = <'auto' | 'owner', the class of the purchase being reserved> AND state IN (reserved, submitting, close_pending, charged, ambiguous, reconciled_charged, manual_charged)` (`authority_class` is a NOT NULL column on the purchase row, CHECK IN ('auto','owner'), stamped at reservation from the stamped payment authority — `AUTO_PAID_WITHIN_POLICY` ⇒ `auto`, every `OWNER_*` and `manual_charged` ⇒ `owner`; the canonical query and its regression test carry this predicate, so an owner-approved charge never consumes the AUTO budget nor vice versa) (the outer COALESCE matters: SUM over zero rows is NULL, and the first purchase of a month must compare against 0 — empty-ledger test required) — every state in which the card has been, or may be, used consumes budget; only `voided` and `reconciled_not_charged` release it. The CASE is the point: `captured_cents` is authoritative ONLY once the purchase is terminally settled — `charged` (the normal automated success: issuer-confirmed closure AND capture for exactly `final_cents`, §7 transition table), `reconciled_charged`, `manual_charged`; an OPEN purchase (`reserved`, `submitting`, `close_pending`, `ambiguous`) reserves its FULL remaining exposure — the card ceiling `final_cents` (or `amount_cents` before a final price is known), never less than what has already been captured — because a merchant can still capture further authorized funds up to the card cap until the card is closed and reconciled, so counting only a partial capture would let a new reservation push the month past its ceiling (regression test: an `ambiguous` purchase with `captured_cents` < `final_cents` reserves `final_cents`)
  → the budget compared is the one for the purchase's authority: `AUTO_PAID_WITHIN_POLICY`
  reserves against `monthly_paid_budget_cents` over AUTO purchases; `OWNER_*` purchases reserve
  against `owner_monthly_budget_cents` over owner-approved purchases (null ⇒ only the
  approval's `max_payable_cents` and the issuer program limit apply) — an owner approval is
  never blocked by the automatic-spend budget being 0
  → **open/settled-purchase check — all-time, per PLACEMENT, path-independent**: if ANY row
  for `(payment_group_id, purchase_kind, renewal_period_key IS NOT DISTINCT FROM ?, loss_event_id IS NOT DISTINCT FROM ?, failed_purchase_id IS NOT DISTINCT FROM ?, prior_purchase_id IS NOT DISTINCT FROM ?)` — NEVER by prospect_id (sibling locations of an account-wide fee have different prospect ids and one group; a concurrent sibling-placement regression test is required) — any `path_id`, superseded or not —
  is in `reserved`, `submitting`, `close_pending`, `ambiguous`, `charged`,
  `reconciled_charged` or `manual_charged`, OR is the settled zero-total completion (`voided` +
  `void_reason='no_payment_required'` + `settled_at IS NOT NULL` — the §6.3 SETTLED-PURCHASE
  predicate; a pre-exposure/failed-free-checkout void without `settled_at` is still ignored)
  → no new reservation (409) — a manually recorded
  initial purchase or renewal blocks a second one exactly like an automated charge. A charged path whose submission is REJECTED before the link ever goes live (path A paid,
  never `placed`/`live`; the placement moves to a distinct active path B with its own fee) is
  `purchase_kind='path_retry'`, keyed to the failed purchase (`${payment_group_id}:path_retry:${failed_purchase_id}:${generation}`, `failed_purchase_id` → the settled-but-never-acquired purchase, CHECK paired with the kind; its own payment instance/approval action `purchase` — opened by a third sanctioned close/open transition: when the Judge/report records that a path's submission failed before the link ever went live and that path's payment instance was SATISFIED — by a CHARGED purchase OR by a settled zero-total completion (`voided`/`void_reason='no_payment_required'`/`settled_at`, §6.3) — the satisfied payment instance is ENDED (`end_outcome='path_failed_after_charge'` / `'path_failed_after_free'`) and a fresh unsatisfied payment instance opened in the same transaction (§3.3b), so the partial unique open-instance rule holds and the old $0 completion can never stand as payment for a replacement path whose re-investigation establishes a positive fee (`failed_purchase_id` then references the settled $0 row; a replacement path that is itself free simply completes as another zero-total completion); allowed only while the group has no live placement and the referenced purchase's path is superseded/failed — the obligation is per paid path, not per group forever). A verified
  loss that requires paying AGAIN (deleted one-time listing, restoration fee) is a further
  `purchase_kind='reacquisition'` keyed to the loss cycle (`${payment_group_id}:reacquisition:${loss_event_id}:${generation}`, `loss_event_id` = the `seo_backlink_events` verified `lost` row; approval action `purchase`, duplicate predicate = same group + same loss_event_id, generation semantics as initial; never `initial`), so a legitimate re-fee is representable while the settled-`initial` duplicate guard stays absolute
  (regression test: manual settlement, then a reservation attempt for the same
  placement/period ⇒ 409). Supersession (§3.2) carries settled
  purchases with the placement; it never frees a second `initial`. A placement that
  was paid for in March can never be paid for again as `initial` in April; only an explicit
  `renewal` for a *new* period can be reserved, and `claim()` never leases a placement with an
  open (`reserved`/`submitting`/`ambiguous`) purchase of any kind. Otherwise `generation` =
  1 + the highest ended generation (`voided` WITHOUT `settled_at` / `reconciled_not_charged` — a settled zero-total `voided` row is a completion, never a retryable generation; it is caught by the duplicate check above) for that key — both this lookup and the all-time open/settled duplicate check match `purchase_kind` and `renewal_period_key IS NOT DISTINCT FROM ?` (initial rows carry NULL; plain `=` would never find an initial purchase and would strand every retry at generation 1 — initial-purchase regression test required) → if `budget_cents = budgetFor(authority)` (`monthly_paid_budget_cents` for
  `AUTO_PAID_WITHIN_POLICY`, `owner_monthly_budget_cents` for `OWNER_*`) is null ⇒ no
  software cap (the approval's `max_payable_cents` and the issuer program limit still bound
  it), else require `month_spend_cents(authority class) + amount_cents ≤ budget_cents`; then
  insert the `reserved` row (the unique `idempotency_key` makes a
  concurrent duplicate a no-op) → commit. All money is integer cents. So a pre-submission failure (voided) can be retried
  in the same month as a new generation, while anything that may have reached the merchant
  never can. Only a committed
  reservation unlocks the card details to the provider. Two workers can never both pass the
  check; the lock is per ET budget month (`link_budget:<budget_month>`), so the policy month
  rolls over at midnight Eastern, not 4–5 hours early at UTC midnight.
- **Authority is revalidated immediately before the card exists.** The `reserved → submitting`
  transition, under the budget lock and before minting, re-runs the pure §6.3 decision on the
  *current* inputs — with `month_spend_cents` computed **excluding this purchase's own
  reservation** (the decision adds `amount_cents` itself; counting the row twice would void a
  valid at-the-limit reservation) — and re-checks the approval (`path_revision`, `decision_inputs_hash`,
  not invalidated/consumed), the placement's current non-superseded path, and every relevant
  kill switch state (`GATE_LINK_AUTHORITY` UNCONDITIONALLY — every automated mint/submit, owner-approved included, §§7/12; `GATE_LINK_PAYMENTS`; `GATE_LINK_AUTO_PAID` only for `AUTO_PAID_WITHIN_POLICY`) — a DATA change since reservation (score/spam/confidence/price/binding) ⇒ the row is `voided` (no card was ever minted) and re-parked; a kill switch that is OFF is a NON-MUTATING HOLD, not a void: the mint simply refuses and the reservation stays `reserved` with its approval intact (per the §12 gate contract — disabling changes no lifecycle state, re-enabling releases held work; the reservation's budget stays held while it waits, and the ordinary lease-expiry/rollover sweeps still apply to a hold that outlives its month, §6.3 budget_month_rollover being the only path that voids it). A gate flipped
  off, or a domain whose score/spam/confidence moved, between reservation and submission can
  never reach the merchant.
- **Payment is bound to the approved merchant.** The purchase's immutable `merchant_binding`
  (checkout origin + explicitly allowed processor hosts, captured by the investigator and
  snapshotted into the payment approval) is checked immediately before mint and again before
  submit against the live page: the checkout page's origin and every redirect hop must be
  the bound origin or an allowed processor host; anything else — a redirect elsewhere, a
  changed domain, an injected form — refuses (`voided` if pre-exposure, else `ambiguous`
  with the card closed). The recipient is bound at the **processor merchant/account level**
  (the merchant's Stripe/PayPal/etc. account identifier captured at investigation and
  re-read from the live checkout), never at the processor host and never by statement
  descriptor (descriptors are not unique merchant identities and can be set per
  transaction) — a redirect to a different merchant on the same processor fails the
  binding. Enforcement is **fail-closed on the verified merchant account id**: the broker
  must read it from the live checkout and it must equal the bound one, or no automated
  purchase is made. An issuer merchant lock, where the program supports it, is applied in
  addition as defence in depth. A merchant whose account identity cannot be verified is
  never an automated purchase: its payment dimension is `OWNER_MANUAL_PAYMENT`.
- **A verified zero total is a no-payment completion, not a purchase.** If the checkout's
  final total is `0` (waived/discounted fee), the row is `voided` with
  `void_reason='no_payment_required'` (§3.7 purchase column) BEFORE any mint (no card exists) — but it is still the
  DURABLE RECORD OF THE TERM: the row keeps its `terms_snapshot`/`term_start`/`paid_through`
  from the checkout page and, co-transactionally with the successful no-card submit below,
  gets `settled_at` stamped and writes the placement's `paid_through`/`renews_at` exactly as a
  charged purchase would. The plan's single SETTLED-PURCHASE predicate is therefore
  `state IN ('charged','reconciled_charged','manual_charged') OR (state='voided' AND
  void_reason='no_payment_required' AND settled_at IS NOT NULL)` — used by the late-sibling bridge
  (§6.2), the renewal scheduler and cost reporting (at $0) alike, so a later location added under
  a zero-total account-wide membership inherits that term instead of reopening an initial
  purchase, and the membership is renewed when its term ends (the renewal is then priced
  from the live checkout — a discount that expired is simply a non-zero renewal). A `voided`
  row WITHOUT `settled_at` (pre-exposure void, failed free checkout) is not settled — and — atomically in that
  same transaction — EVERY payment authority row covered by that purchase (the placement's own, and for an `account_wide` fee every sibling row whose `purchase_id` = this purchase — the same set the settlement path satisfies) is marked `satisfied_at`
  with `satisfied_reason='no_payment_required'` ONLY co-transactionally with the SUCCESSFUL
  COMPLETION OF THE NO-CARD CHECKOUT — the settlement transaction is the `mode=payment` /
  `mode=renewal` report with outcome `no_payment_required` (§7 matrix) and is INDEPENDENT of
  the acquisition lifecycle: on a paid OUTREACH path the placement stays `contacted`/`negotiating`
  and on a renewal it keeps its Judge-owned `live`/`indexed`, yet the purchase row is settled,
  the authorities satisfied and `paid_through`/`renews_at` written in that same report, so late
  siblings and the renewal scheduler can consume the term; ONLY on a paid EXECUTION path, where
  the card-boundary resume that completes the checkout is also the acquisition submit, does the
  same report additionally carry `placed` (pending-flagged or not) (§7) — the `placed` (pending-flagged or not) coupling is a
  property of that path kind, never a condition of settlement. If the no-card checkout does
  not complete successfully (outcome `failed`/`mutation_ambiguous` reconciled to not-completed),
  the payment instance is NOT satisfied — it is ended
  (`end_outcome='free_checkout_failed'`) and a fresh unsatisfied payment instance opened, so a
  retry that finds the waiver/discount expired must obtain its own authority/approval for the
  now-positive amount (a $0 total that DOES complete is a successful terminal outcome for the
  payment dimension, not a failure) so later
  irreversible steps see the payment prerequisite as met; the placement proceeds
  through the free-path steps (the worker completes the checkout without a card), and the
  investigator re-marks the path's `payment_required`/cost on its next pass. `final_cents=0`
  never enters `submitting`.
- **Final total AND renewal terms are validated before `submitting`.** The provider must read the checkout's
  final total (price + tax + fees + renewal terms as displayed) and report it as
  `final_cents` — a safe non-negative integer, else the transition is refused — together with
  a fail-closed **auto-renew predicate**: the transition to `submitting` (and the mint before
  it) requires `renewal_evidence` = either `one_time` (the checkout is inherently non-recurring:
  no renewal term, no subscription language, confirmed by the investigator's `renewal_period='none'`
  AND the live page) or `auto_renew_disabled` (the checkout independently shows auto-renew
  OFF / a one-off term after the provider's opt-out, read back from the page, not merely
  reported), captured into the purchase `terms_snapshot`; anything else — recurring language
  with no verifiable opt-out, an unreadable renewal block, a provider that only *says* it
  disabled it — voids the reservation with `auto_renew_unavoidable` (no card, no submit):
  closing the card would stop the next charge but not the contractual debt, so the guard is
  the only real protection — BEFORE the
  card is exposed. The `reserved → submitting` transition runs under
  the same `link_budget:<budget_month>` advisory lock and: refuses (→ `voided`,
  `outcome='price_changed'`) if `final_cents > max_auto_purchase_cents` for a row whose stamped
  authority is exactly `AUTO_PAID_WITHIN_POLICY` (regression test: a checkout total raised above
  the ceiling after reservation is refused), or if
  the renewal terms differ from the path; otherwise reserves the delta
  (`final_cents − amount_cents`, if positive) against the month under the same budget check —
  no room → `voided`; else commits `submitting` with `final_cents` as the consuming amount.
  An owner-approved purchase whose final total exceeds the approval's immutable
  `max_payable_cents` (snapshotted at approval; the live policy tolerance is never read here)
  is also refused and re-parked with the new total. The provider can never charge an amount the ledger has not reserved.
- **Renewals are separate purchases; a merchant can never charge outside the ledger.** A
  reservation covers exactly one charge, and the instrument enforces it: each purchase is paid
  with a **single-use virtual card number minted at `submitting` with an issuer-enforced
  per-card spend ceiling equal to `final_cents`** — minted **idempotently**: the issuer
  request carries the purchase's `idempotency_key` as the issuer-side idempotency key, and
  the returned `issuer_card_id` is persisted on the purchase row **before** PAN/CVV are
  fetched (two steps: mint+persist, then fetch). A crash between mint and persist is
  recoverable by construction: the hourly sweep, for any `submitting` row with a null
  `issuer_card_id`, asks the issuer for the card created under that idempotency key —
  found ⇒ persist its id and close it (the row goes `ambiguous` as usual); **not found
  (conclusive, from the issuer's idempotency lookup) ⇒ the sweep performs the ONE backward
  transition, `submitting → reserved`** (sweep-only, under the budget lock, lease cleared,
  `submitting_at` nulled, `mint_not_started` recorded as its OWN audit attempt (action `mint`, no idempotency key — it is an observation, not a mutation) while the instance's existing submit attempt row is transitioned back `submitting → slot_reserved` under the cap lock (a sanctioned retry edge alongside `slot_released → slot_reserved`, §13; the row keeps its `${prospect_id}:submit:${instance_key}` key, so the retry re-uses it instead of colliding)) — no instrument ever existed,
  so nothing can have been charged — and the placement is claimable again for a fresh
  `reserved → submitting` under the same idempotency key. A retry of the mint with the same key returns
  the same card, never a second one, so one purchase can never hold two live instruments (the merchant cannot authorize or capture
  more than the ledger approved, whatever the checkout later shows; the issuer's program-wide
  monthly limit is a second ceiling, not the control). If the issuer cannot set a per-card
  ceiling, **no automated purchase is made**. Issuer capabilities (per-card ceiling,
  merchant/descriptor lock) are **preflighted from the issuer program's declared features
  before `reserved → submitting`** — an unsupported requirement voids the row pre-mint
  (`voided`, `outcome='instrument_unavailable'`, parked for the owner). If a mint
  nonetheless returns a card without the required ceiling or lock, the **post-mint failure
  path** applies: the broker closes the card at once, the row goes `submitting → ambiguous`
  with `card_exposed=false`, and the reconciler settles it `reconciled_not_charged` on the
  issuer's closed-and-no-transaction confirmation (no presentment wait — the PAN was never
  fetched); `submitting → voided` never exists. Reconciliation compares the
  captured amount against the ceiling; a capture above `final_cents` is impossible by
  construction and any discrepancy is `ambiguous` until explained. (Issuer-generated per
  reservation; the ledger
  stores only the issuer's opaque `issuer_card_id` + `card_last4` — the PAN/CVV are fetched
  from the issuer at `submitting` time by a **trusted local payment broker** and typed into
  the checkout's card fields by that broker alone, outside any model/provider context (see
  §7 "payment boundary"); they are never written to the ledger, attempts, evidence, sessions,
  logs, prompts, screenshots or traces)
  that is **closed at the issuer BEFORE the ledger commits `charged`** (`close_pending →
  charged` requires issuer-confirmed closure + capture, §6.3), closed the instant a row goes
  `ambiguous`, and simply never minted for a pre-exposure `voided` row (nothing to close) — so an
  armed auto-renewal, a merchant retry, or a stored-card charge has no live number to hit.
  The provider still selects the non-recurring option or disables auto-renew where offered
  and reports `auto_renew_disabled`. If the issuer cannot mint single-use numbers, purchases
  on merchants that only sell auto-renewing terms are **refused outright** (`voided`,
  `outcome='auto_renew_unavoidable'`), including for owner-approved rows — the owner may buy
  such a listing manually outside the system and record it through the manual settlement
  form (`manual_charged` ledger row + `human` attempt), which sets its renewal date. No purchase is ever left depending on a future job to prevent a charge.
  Intentional renewals are produced by a **renewal job** that, `renewal_lead_days` (default 21)
  before a paid placement's `renews_at`, re-runs the §6.3 decision on the *current* D30
  evidence and price, and — for `AUTO_PAID_WITHIN_POLICY` — creates a `purchase_kind='renewal'` reservation for that period
  under the same lock/budget/idempotency rules; for `OWNER_PAYMENT` it opens only the renewal authority instance + owner card (the placement keeps its Judge-owned status), and the reservation is created inside the locked approval transaction once the owner approves (a non-AUTO `reserved` row always carries its `approval_id`) — or lets **that placement** lapse
  (placement `renewal_status='lapsed'`, `renewal_recheck_at` set — both §3.3 placement columns; its verified `live`/`indexed`
  status is untouched until the verifier proves a loss) if the policy no longer authorizes
  it. A lapse never writes the domain's `agent_state` directly: the aggregate is recomputed
  across ALL placements by the §3.1 rule, so it becomes `watching` only when no sibling
  placement is live/indexed or authorized-pending — one lapsed location never makes a
  sibling's authorized placement unclaimable or hides an independently live one. A merchant that cannot sell
  a one-off renewal stays on the refusal path above (`auto_renew_unavoidable`): the renewal job
  never mints for it, owner-approved or not; the owner renews manually outside the system and
  records it through the manual settlement form (`manual_charged` purchase row + `human`
  attempt, then the paid term). A renewal is leased
  through a **renewal-specific predicate** (`claim(?mode=renewal)`), keyed to the open,
  unleased `renewal` reservation rather than to the placement lifecycle: the placement stays
  `placed`/`live`/`indexed` and the registry stays `acquired` (their verified state is never
  rewritten), the lease binds the purchase row, the `deterministic_runner` is the only
  eligible provider, and the usual authority/approval/gate re-checks run on the reservation.
  The paid term written on any SETTLED purchase (§6.3 predicate — `charged`/`reconciled_charged`/`manual_charged` or a settled zero-total completion) advances `renews_at`. A renewal never charges
  without its own reservation and, where the merchant does not support one-off renewal, its
  own reservation; there is no owner-approval exception for auto-renew-only merchants.
- **A reservation is charged against the month it is submitted in.** The
  `reserved → submitting` transition (under the budget lock) first compares the row's
  `budget_month` with the current ET month; if the month has rolled over since reservation,
  the row is `voided` and a `seo_link_attempts` row with `outcome='budget_month_rollover'` (enum member, §3.4) is written in the same transaction — the purchase row carries no outcome column, only `void_reason` (§3.7: here `budget_month_rollover`; the attempt row carries the outcome). Because a voided purchase advances
  the generation and an approval binds to the prior `instance_key` (§3.3b), what follows
  depends on the payment authority: for `AUTO_PAID_WITHIN_POLICY` a fresh **next-generation**
  reservation is attempted immediately under the **new** month's lock and budget (same
  idempotency rules, new `budget_month`, new `generation`) before anything continues; for
  `OWNER_PAYMENT` (the ONLY owner-approved payment level — `OWNER_MEMBERSHIP` is an execution-dimension decision and never authorizes a purchase; a paid membership's purchase runs on its separate payment approval) nothing is re-reserved — the placement is re-parked
  `awaiting_owner` with a fresh-generation approval card and the prior approval is marked
  `invalidated_reason='budget_month_rollover'` (never replayed), so the owner approves the
  new instance before any card exists — a
  reservation can never consume last month's ledger while the card is used this month, so the
  two months' ceilings cannot stack.
- **`submitting` before the external call — non-retryable.** Immediately after that
  validation (the last point at which nothing has been charged) the row is `submitting`
  (conditional on the lease and prior state; `submitting_at = now`). Only a `submitting` row
  exposes the card to the provider. Where the merchant supports it the
  `merchant_idempotency_key` is sent with the checkout. From `submitting` the worker's ONLY
  transitions are `close_pending` (success reported with `merchant_ref`; the card is not yet
  confirmed closed) or `ambiguous`; the sweep additionally owns `submitting → reserved` (issuer
  conclusively confirms no card was ever minted) — the **authoritative transition table** is
  the "Lease safety" bullet below and nothing else in this document adds to it — **every
  unsuccessful or unclear post-exposure result is `ambiguous`**, including a merchant
  "declined"/"error" page (a merchant can authorize and fail at the application layer, then
  capture later). `voided` exists only for failures **before** the card was exposed
  (`reserved` state). Nothing that saw the card can release budget or start a new generation
  except through `reconciled_not_charged` (card closed + issuer-confirmed no capture/pending).
- **Crash = ambiguous, never re-submit; a crash before the card was exposed = voided.** A
  worker that dies after `submitting` leaves the row in `submitting`; the hourly lease-expiry
  sweep moves any `submitting` row older than the lease TTL to `ambiguous` (closing the card
  first, as above) and marks its attempt `payment_ambiguous`. The same sweep moves any
  `reserved` row whose lease has expired — no card was ever minted or exposed in that state —
  to `voided` (conditional on `state='reserved'` and the expired lease), releasing its budget
  and unblocking the placement for a new generation; a stranded reservation can never hold
  budget or a placement forever. `claim()` never leases a
  placement whose purchase is `submitting` or `ambiguous`, so a reclaimed lease cannot
  re-submit the same checkout. A reported timeout/disconnect after submission →
  `ambiguous` directly.
- **Ambiguity is reconciled, not retried — and the card is frozen first.** The moment a
  row becomes `ambiguous` (reported timeout, or the sweep on an abandoned `submitting`), the
  worker/sweep **closes the single-use card at the issuer immediately** — before any
  reconciliation, before any budget accounting changes — and records `card_closed_at`. A
  merchant retry or late capture therefore has no live instrument to hit. `ambiguous` rows
  keep consuming the month's budget until `reconcile` settles them on **issuer evidence
  only** (the issuer's transaction record for `issuer_card_id` — fetched by API or attached
  by the owner from the issuer portal; the owner card can present and confirm that evidence,
  never substitute for it): `reconciled_charged` only when the issuer record shows a capture AND the card is CLOSED AND the issuer record shows NO remaining pending / authorized / clearing amount on it after the presentment window (`card_exposed_at` + the issuer's presentment period, §3.7) — a partial capture beside a still-open authorization or a not-yet-cleared capture is NOT terminal: the row stays `ambiguous`, keeps reserving its full `final_cents` exposure in the §6.3 budget query (the CASE counts `captured_cents` only for terminal rows), and is re-examined by the reconciler each sweep until the remainder either clears (then summed) or expires — AND the reconciler has
  summed every capture/adjustment on the card into `captured_cents` and validated it —
  `captured_cents ≤ max_payable_cents` (owner) / the per-card ceiling (auto) — settling on
  the money actually taken, never on the checkout total; a partial, adjusted or multiple
  capture whose sum exceeds the ceiling stays `ambiguous` and parks an owner card (the issuer
  ceiling should have made this impossible, so it is an incident, not a settlement); `reconciled_not_charged` **only when (a) the issuer's full settlement/presentment
  window (`policy.presentment_window_days`, default 10, ≥ the issuer's documented late-
  presentment allowance) has elapsed since the LAST card exposure (`card_exposed_at`, stamped atomically with `card_exposed=true` — NOT `submitting_at`, which is set before the mint, so a delayed or resumed mint can never shorten the wait), AND
  (b) an authoritative issuer check after that window confirms the card is irrevocably
  closed and shows no captured, pending, authorized or clearing transaction** — that is the
  precondition for releasing the budget and allowing a new generation, never a lookup that
  merely found nothing yet (an offline/delayed presentment can appear days after closure).
  Until then the row stays `ambiguous` and keeps consuming budget. A `reserved` row whose attempt fails *before* `submitting` is
  `voided` in the same report and releases its budget.
- **Authoritative transition table** (the CHECK enum + these edges are the whole machine):
  `reserved → voided` (worker/sweep, pre-exposure) · `reserved → submitting` (worker, after
  pre-mint revalidation) · `submitting → reserved` (sweep only, issuer-confirmed no card) ·
  `submitting → close_pending` (worker, merchant success) · `submitting → ambiguous` (worker
  or sweep; includes every post-mint precondition failure — lock/ceiling missing — with
  `card_exposed=false`) · `close_pending → charged` (worker/sweep, issuer-confirmed closure + capture) ·
  `close_pending → ambiguous` (sweep) · `ambiguous → reconciled_charged | reconciled_not_charged`
  (reconciler only). No other edge exists; tests enumerate this table.
- **Lease safety.** Every purchase transition is conditional on the **purchase row's own
  `lease_token`** (set by the claim that took it — placement claim for an initial purchase,
  renewal claim for a renewal — expiring with `lease_expires_at`) AND on the exact prior
  state. **The sweep and the reconciler own their own lease:** under the budget lock they
  take over any purchase whose worker lease is expired or cleared (`leased_by='reconciler'`,
  fresh token) and then perform the state-locked transitions the worker can no longer do
  (`submitting→ambiguous|reserved`, `close_pending→charged|ambiguous`,
  `ambiguous→reconciled_*`) — a purchase is never stranded for want of a dead worker's token,
  and a late report from that worker still matches 0 rows (`reserved→voided`, `reserved→submitting`, `submitting→reserved` [sweep only,
  issuer-confirmed no card], `submitting→close_pending|ambiguous`,
  `close_pending→charged` only with `card_closed_at`, `close_pending→ambiguous`,
  `ambiguous→reconciled_*` by the reconciler only); `submitting→voided` does not exist. A
  stale lease or a wrong prior state affects 0 rows and returns 409.
- **Instrument.** A dedicated **issuer account/program** (with its own hard monthly program
  limit) that **mints one capped single-use card per purchase** is the only payment source
  the runner can use; the runner never holds a reusable card number, so a stored-card retry,
  a renewal, or any charge without a fresh reservation has no instrument to hit. The
  program's monthly limit is a second, independent ceiling — it is not the policy. Owner-
  approved purchases above `max_auto_purchase_cents` go through the same reservation and
  the same per-purchase minting after the click. `seo_link_attempts.cost_cents` mirrors `final_cents` for reporting only.

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
concurrent auto-sends cannot exceed it. Follow-ups (one, +10 days, only if no reply) go
through the same gate as a **distinct claimable step**: the first send leaves the row
`status='contacted'`, `outreach_status='sent'` (as shipped) — EXCEPT the LATE SEND of an
execution-bearing path with `execution_after_send=false` (§7), which runs after the acquisition
already moved the row to `placed` (pending-flagged or not): that send transition writes ONLY the outreach
columns (`outreach_status='sent'`, `outreach_sent_at`, `follow_up_due_at`, `follow_up_status='none'`)
and NEVER `status` — the Judge owns `status` from `placed` onward (a demotion to `contacted`
would drop the row from the verifier's `status='placed'` selection, §8) and the guard's
`applyReportTransition` refuses a `status` write from a send/followup report on a row whose
status is `placed` (pending-flagged or not)/`live`/`indexed` (contract test). The conversation lifecycle is
therefore carried by the OUTREACH COLUMNS, not by `status`: every follow-up predicate below
selects `outreach_status='sent'` + `follow_up_status` on rows whose `status` is `contacted`
OR — only when the joined path has `execution_after_send=false` — `placed` (pending-flagged or not)/`live`/`indexed`
(the guard's `FOLLOW_UP_STATUSES(path)` helper returns that set; a follow-up on a Judge-owned
row is claimable and never demotes it either), so a follow-up is modelled on
its own columns — `follow_up_due_at` (= sent + 10d), `follow_up_status`
(`none|due|drafted|sending|sent|send_error|skipped` — the same in-flight/ambiguous machine
as the first send: `sending` under the claim, `send_error` when Gmail may have accepted but
the response was lost, cleared only by the existing Sent-folder `reconcileSendError`
path, never retried before it), `follow_up_send_token` (its own idempotency claim, same
advisory-lock shape as the first send), `follow_up_attempted_at` (stamped at claim time under
the same lock exactly like `outreach_attempted_at`; the retained `dailySendCount` is extended
to count it — `COALESCE((outreach_attempted_at >= since)::int, 0) + COALESCE((follow_up_attempted_at >= since)::int, 0) +
prior attempts` (both terms COALESCEd exactly like the shipped expression — a NULL follow-up timestamp must not null the whole row and drop the initial send from SUM) — so a follow-up consumes the policy cap and the hard cap like an initial
send and initial + follow-up sends can never exceed the daily limit). A due follow-up is
**drafted before it can be sent**, exactly like the first message: `mode=draft` ALSO leases
rows in `FOLLOW_UP_STATUSES(path)` (§6.4 above — `contacted`, plus the Judge-owned statuses on an `execution_after_send=false` path) with `follow_up_status='due'` (draft-only, grants nothing beyond composing
the follow-up; `outcome='drafted'` flips `due → drafted` and stores the draft + its hash on
the placement), the draft passes `comms-lint` and the §6.4 classifier, and the bridge then
evaluates `AUTO_OUTREACH` on THAT draft or parks the placement for a `communication/outreach_followup`
approval whose `action_hash` binds it. Only then is it leased with
`claim(?type=outreach&mode=followup)`, whose predicate accepts rows in `FOLLOW_UP_STATUSES(path)` (the same helper as the draft lease and the §7 map — `contacted`, plus the Judge-owned statuses on an `execution_after_send=false` path) with
`outreach_status='sent'`, `follow_up_status='drafted'` and a send authority valid for the
follow-up instance (`followup:1`) bound to that draft's hash — text that was never linted or
approved can never be sent. One follow-up per placement, ever. It runs **with a
fail-closed reply check**: today the sender stores only a
Gmail thread reference and detects nothing, so step 4 adds, inside the locked send claim, a
Gmail thread reconciliation (`threads.get` on `outreach_thread_ref`; any message not from
`contact@` = a reply) and skips the follow-up on a reply, a bounce, or a lookup
error/timeout (parked for the owner, never sent by default). A follow-up is never sent
without a successful lookup proving silence.

The 56 drafts from June are the first batch through this mandate (self-disqualifying and
national-magazine drafts fail the lint/score floor; the Sunrise cluster dedupes by domain
under `claimProspectDomain`).

---

## 7. Hands — providers behind the existing contract

`claim → act → report` keeps its shape (`/api/integrations/backlink-worker/*`,
`FOR UPDATE SKIP LOCKED`, lease token, `live_url` required for `placed`, stale leases
rejected). **The board does not care which provider did the work.** Two contract changes
land with the authority step (§14 step 4), in one PR, with the route/worker tests updated
together:
- **Claim predicate is authority-aware, atomic and UNCONDITIONAL.** Today `claim()` filters
  only on prospect status/type. From step 4 it always joins the registry — no gate turns the
  old predicate back on; `GATE_LINK_AUTHORITY` is the GLOBAL automation kill switch — required for EVERY automated claim and every irreversible automated action whatever the stamped level (`AUTO_*` or owner-approved `OWNER_*` alike; only the human settlement form and owner-side UI actions are outside it) — and leases a row only when ALL hold inside the same locked select: placement status matches the
  CLAIM MODE — `prospect` for initial acquisition / `mode=draft` / the initial `mode=send` — EXCEPT on an execution-bearing outreach path (communication AND an `acquire` instance, §6.2: `account_required` or a form/`content_submission` submit), where the two required actions are ORDERED by the path's `execution_after_send` flag (investigator-set, default true: the publisher's form/account step follows the pitch): with it true, `mode=send` claims at `prospect` and `mode=acquire` claims at `contacted`/`negotiating` ONLY after the communication instance's send has a terminal `sent` (the acquire predicate joins the satisfied send, so a status change by the send never strands the acquire); with it false, `mode=acquire` claims at `prospect` and the initial `mode=send` claims at `placed` (pending-flagged or not) OR `live`/`indexed` (the Judge may promote the submitted placement before the send is leased — the late send is never stranded by promotion; the send predicate joins the successful submit, not the status) as a LATE SEND that writes outreach columns only and leaves the Judge-owned `status` untouched (§6.4), its follow-up leasing on the same Judge-owned statuses; each ordering is a single directed edge in the §3.3b prerequisite graph and the placement-status set for each later-stage mode is listed in the guard's `CLAIM_MODE_STATUSES` map with the mode-specific tests; `execution_after_send` is a PERSISTED, REVISIONED path column (§3.2: NOT NULL, investigator JSON-schema output, in `revision_communication` and `revision_execution` and both dimensions' hashes/snapshots) — the claim reads it from the path row joined in the locked select, never from untracked investigation JSON, and the send/acquire authority rows bind to the revision that carried it;
  `contacted`/`negotiating` (paid outreach) or `ready_for_payment` (paid execution paths) for `mode=payment` — plus, for a PAID OUTREACH placement only, the Judge-owned `placed` (pending-flagged or not)/`live`/`indexed` when its payment instance is still unsatisfied and its reservation open (the §8 reconciliation can promote the row while the fee awaits the owner; the paid term must still settle, and settlement never touches the Judge-owned status per the §7 matrix), `FOLLOW_UP_STATUSES(path)` (§6.4: `contacted`, plus the Judge-owned `placed` (pending-flagged or not)/`live`/`indexed` when the path's `execution_after_send=false`) for `mode=followup` and for the follow-up `mode=draft` lease, and `contacted`/`negotiating`/`prospect` — plus the Judge-owned `placed` (pending-flagged or not)/`live`/`indexed` when the OPEN `accept_terms` instance belongs to a renewal or a terms-changed reopening on a live paid placement (§3.3b ends the satisfied instance on a `legal_terms_hash` change; the successor must be leasable without demoting the row) — for `mode=terms` (a standalone `accept_terms` instance exposed after the initial email — leased only by the `deterministic_runner`, executes the guarded `acceptTerms()` phase, reports `terms_accepted`/`terms_changed`/`mutation_ambiguous`); `placed`/`live`/`indexed`
  for `mode=renewal` (each mode's extra predicate is defined where the mode is) — the
  `prospect` restriction is never applied to the later-stage modes; registry
  `agent_state` in (`ready_to_acquire`, `acquiring`, `acquired`) — `mode=draft` ALSO accepts `qualified` (an owner-gated outreach placement without a draft stays `qualified` until the draft exists; the draft-lease bullet below is the authority on that mode's predicate) — claimability is a
  placement property, so a second location's placement is leasable after the first was
  acquired; and — for every mode EXCEPT `mode=draft`, which is exempt from this authority
  clause by construction (the draft-lease bullet below defines its own predicate; every
  other clause and the bans on irreversible actions still apply to it) — the OPEN
  `seo_link_placement_authorities` row for the CURRENT action's dimension + instance
  (`ended_at IS NULL`; the placement's summary `authority` column is display-only and is
  never consulted for authorization) has `level` = an `AUTO_*` level
  **or** an `OWNER_*` level with the approval row whose dimension/action/instance_key/hash/
  level all match THAT row (§3.6b — an approval for another dimension never leases this step,
  and an owner-gated unrelated dimension never blocks an automatic step whose own
  prerequisites are satisfied) (a dimension decided under a floor
  waiver is leasable exactly as its underlying level would be — its `floor_waiver_id` waiver
  must still be valid, and a waiver never promotes the level) — except
  `OWNER_MANUAL_PAYMENT`, which is never leasable for any payment claim (no reservation, no
  mint: the owner pays outside the system and records the charge through the manual
  settlement form, which atomically — in ONE transaction — inserts a `manual_charged`
  purchase row + a `human` attempt, writes the paid term, marks the payment authority
  instance `satisfied_at = now` (the settlement click is its satisfaction; no approval row),
  and restores the placement from `awaiting_owner` to `parked_from_status` (or to `placed`
  when the settlement itself completes the acquisition) so it continues toward verification
  instead of stranding; the placement's non-payment dimensions proceed
  normally), and
  `OWNER_HUMAN_STEP`, which is never leasable to an automated provider WHILE UNSATISFIED: its row stays
  `awaiting_owner` until a human completes the human part and records a **resume checkpoint**
  (a `human` attempt with `outcome='human_step_done'` + the resulting session/state), after
  which the bridge re-decides THAT placement only: §6.3 receives the placement's satisfied human-step instance as a durable prerequisite (`satisfied_at` on the `OWNER_HUMAN_STEP` authority row), treats the human part as done, and decides the REMAINDER of the INTERRUPTED action — same dimension and instance kind as the human-step row (`-:n+2` for an acquire, `terms:n+2` for an `accept_terms`, `followup:n+2` on the communication dimension for a follow-up CAPTCHA) — for this placement alone as if `agent_completable=true` (`AUTO_*` or `OWNER_*` per policy) — the satisfied `OWNER_HUMAN_STEP` row `<kind>:n+1` is ENDED in the same transaction (`ended_at`, `end_outcome='human_step_done'`, `satisfied_at` kept as history — the second sanctioned successor of a satisfied instance besides verified loss, §3.3b) so the partial unique index on open instances holds, so the claim predicate can lease it — the human step recorded as satisfied on the placement's own authority instance/session (`human_step_done` attempt + `satisfied_at`) — the shared path-level `agent_completable` flag is NEVER changed by a checkpoint (a sibling location's session has not completed it, and a recurring human-only step must recur); only an independent investigator pass may re-mark the path itself; the path's lane
  gate is on (**`GATE_LINK_AUTHORITY` for EVERY automated claim, `AUTO_*` and owner-approved alike — the kill switch is checked at
  claim and again immediately before EVERY irreversible external action — submit, send, mint, account creation, verification-link activation, and accepting/signing legal terms — under the same locked revalidation (authority row + approval + gate), never
  only at stamping**; `GATE_SIGNUP_RUNNER` for signup lanes, `GATE_LINK_OUTREACH` for outreach
  SEND claims only (`mode=send`/`mode=followup`) — `mode=draft` is exempt from the send gate
  exactly as it is from the authority clause and requires `GATE_OUTREACH_DRAFTER` instead (the
  shipped drafter gate is intentionally independent of the send valve, `feature-gates.js`, so
  drafts exist for owner review before sending is armed), `GATE_LINK_PAYMENTS` for the PAYMENT-dimension claims only — reservation, `mode=payment`,
  `mode=renewal`, mint and payment submit — never for a send or a free/account execution
  step on a path that happens to be paid (communication and payment are independent), and
  additionally `GATE_LINK_AUTO_PAID` only when the stamped payment authority is
  `AUTO_PAID_WITHIN_POLICY`; an owner-approved `OWNER_PAYMENT` row (the only owner-approved payment level; `OWNER_MEMBERSHIP` is execution-only) needs
  the payments gate, not the auto-paid gate); no `submitting`/`close_pending`/
  `ambiguous` purchase exists for the placement and no `reserved` purchase is bound to another lease
  (an unleased `renewal` reservation is claimable by the runner, §6.3 — and the claim's re-run of
  the §6.3 decision computes `month_spend_cents` EXCLUDING the reservation being claimed, exactly
  as the pre-mint check does, so a renewal that fills the remaining budget is not double-counted); and the provider identity — DERIVED SERVER-SIDE from the authenticated worker credential, never read from a query/body value (§12: per-provider HMAC REQUEST SIGNING — `LINK_WORKER_SECRET_<PROVIDER>` signs the CANONICAL REQUEST `timestamp + nonce + method + canonical-target + body-sha256`, where body-sha256 is computed over the RAW request bytes: the global `express.json()` at `server/index.js:455` (which consumes the stream before the worker router mounts at `:718`) gains a `verify` hook that stores `req.rawBody` for paths under `/api/integrations/*-worker` only — the same pattern the raw-body-sensitive webhook routes use — so the router-level HMAC check hashes the original bytes and never a re-serialized `req.body`; for a bodyless request (the existing `GET …/claim`, where the parser's verify hook never runs) body-sha256 is the SHA-256 of the empty byte sequence, on both sides; whenever a body IS present (`content-length > 0` / a body-bearing method) the captured raw bytes are required and a request without them is rejected (contract tests: a signed bodyless GET verifies; whitespace/key-order variants of one POST body verify against the sender's hash) and where canonical-target = pathname + '?' + EVERY query parameter sorted by key and percent-encoded (`mode`, `type`, `location` … included — a claim's authority is selected by its query, so a captured GET can never be replayed with a different `mode`); the server rebuilds the canonical target from the received URL before verifying (contract test: same signature with a changed query ⇒ 401); the server verifies the signature, rejects timestamps outside ±5 min and any replayed nonce — consumed ATOMICALLY via `seo_link_worker_nonces (key_id, nonce, signed_ts, seen_at; PRIMARY KEY (key_id, nonce))` — `signed_ts` = the request's signed timestamp, persisted so cleanup runs strictly on `signed_ts + skew < now()`, never on `seen_at` with INSERT-FIRST: the request inserts its nonce and a unique-violation rejects it before any handler runs (never SELECT-then-INSERT, so two concurrent copies of one signed claim cannot both pass); each row stores the SIGNED timestamp and is retained until `signed_ts + skew` has passed (≥ 2×skew from first receipt — a future-dated request stays signature-valid for nearly 10 min, so a 5-min sweep from `seen_at` would allow replay after deletion; the sweep deletes only rows whose signed timestamp can no longer validate) with a future-dated replay-after-sweep test; table ships in the step-1 migration with a concurrent-replay test, and only AFTER verification maps the key id to a fixed `{ provider, capabilities }` record — the AGENTS.md rule that every `/api/integrations/*-worker` mount carries its own signed auth; the `hermes` identity migrates to its own HMAC credential `LINK_WORKER_SECRET_HERMES` in step 1 as well — `HERMES_SERVICE_TOKEN` bearer auth is NOT removed in the same PR: per the ordered rollout of record (§1 row, §12, §14 step 1b) it stays accepted for the `hermes` record only, capability-limited identically and recorded as `auth_scheme='bearer'` in `seo_link_worker_requests` (§3.4c — every accepted claim/report, empty claims included), because the external Hostinger signup worker cannot be updated atomically with a server deploy; the follow-up PR removes bearer acceptance on this route after that table shows 7 days of zero bearer rows, and the env is unset only once the vendor price/login worker routes that share `hermesAuth` are signed too (§14 step 1b) (AGENTS.md: every `/api/integrations/*-worker` route is HMAC-signed — the bearer is a bounded transition, never a retained scope) — and its capability set stays non-payment, non-credential) — carries the capability the step needs (payment and credential steps → the `deterministic_runner` identity only). A caller-supplied `provider` field is ignored (logged as a mismatch if it disagrees with the token). A row
  the policy has not authorized cannot be leased by any caller.
- **Draft leases are separate from send authority (no claim-before-draft deadlock).** The
  drafter (`backlink-outreach-drafter.js`) claims with `?type=outreach&mode=draft`: a draft
  lease requires only a `prospect` row in an outreach lane whose domain is `qualified`,
  `ready_to_acquire`, `acquiring` or `acquired` (a second placement on a domain whose first
  is already live still needs its own draft — the placement's eligibility, not the
  aggregate, decides) — OR, for the §6.4 follow-up lane, a row in `FOLLOW_UP_STATUSES(path)` (`contacted`, plus the Judge-owned `placed` (pending-flagged or not)/`live`/`indexed` on an `execution_after_send=false` path) with
  `outreach_status='sent'` and `follow_up_status='due'` whatever the domain's aggregate state
  (`acquiring`/`acquired` are normal there) — and grants NOTHING beyond research + composing
  a draft (report `outcome='drafted'`, never a send; for the follow-up lane it flips
  `due → drafted`). Send authority is decided afterwards: once the draft
  exists and passes `comms-lint` and the §6.4 classifier, the bridge job evaluates
  `AUTO_OUTREACH` on that draft; only a `mode=send` lease — which requires the stamped
  `AUTO_OUTREACH` (or an approval) — may call the sender. Drafting therefore never needs
  authority, and authority is never granted without a lint-clean draft to grant it for.
- **Paid outreach after the send: `claim(?mode=payment)`.** Once a paid outreach placement
  is `contacted`/`negotiating` — or already Judge-promoted to `placed` (pending-flagged or not)/`live`/`indexed` with its payment instance still unsatisfied (the reconciliation can find the link before the publisher exposes the checkout; readiness marking and the locked checkout-time RESERVATION are allowed from those statuses under the same unsatisfied-instance condition, so a fee that arrives after promotion can still be reserved, leased and settled without touching the Judge-owned status) — and the publisher exposes a checkout, the payment step is
  leased through a payment-specific predicate keyed to the placement's open, unleased
  `initial` — or, on the GROUP ANCHOR after a reviewed fee-scope regroup (§6.2), `scope_expansion` — reservation — created ONLY at that moment (the runner/owner marks the placement
  `ready_for_payment` when the publisher exposes a checkout), never at bridge time, so a
  publisher who never replies holds no budget and no open-purchase guard; a pre-checkout
  reservation does not exist by construction:
  placement in (`contacted`, `negotiating`) — or in (`placed` (pending-flagged or not), `live`, `indexed`) with the payment instance still unsatisfied (the reconciliation-promoted case above; the claim never touches the Judge-owned status) — communication dimension `satisfied_at` set,
  payment dimension authorized, no `submitting`/`ambiguous` purchase; the initial send is
  never claimable again through this mode. The `deterministic_runner` is the only eligible
  provider (payment boundary).
- **`pending` submissions are kept.** The shipped report path for a moderated directory
  (`outcome='placed'` with `pending:true` and no `live_url` — `link-prospect-worker.js`) is
  retained unchanged: the placement moves to `placed` without a `live_url`, the daily
  verifier's domain reconcile (`reconcileByDomain`) discovers the URL on approval, and the
  row is excluded from re-claim while `placed`. `live_url` is required only for a
  non-pending `placed` report, exactly as today.
- **Reports are bound to the claim.** The lease persists `leased_provider`, `lease_mode`
  and `lease_action` on the placement (with the lease token); `/report` is accepted only
  when the reporting identity (HMAC, §12) equals `leased_provider`, the token matches, AND
  the outcome is in the **mode-specific outcome matrix** (draft ⇒ `drafted`/`skipped`/`failed`
  only; send/followup ⇒ `sent`/`send_error`/`skipped`/`failed`; renewal ⇒ the
  purchase outcomes only; the INITIAL `mode=payment` on a PAID OUTREACH path (`contacted`/`negotiating`, checkout exposed by the publisher, §7) ⇒ the purchase
  outcomes only (`close_pending`→`charged`, `ambiguous`, `voided`/`no_payment_required` …) — a `scope_expansion` reservation (§6.2, leased through this same `mode=payment` on the group anchor whatever its Judge-owned status) uses this SAME purchase-outcomes-only branch, never any status write, and its settlement satisfies the siblings the prior per-location purchase did not cover — with the conversation lifecycle UNCHANGED — the placement stays `contacted`/`negotiating` and moves to `placed` only on the publisher's confirmation captured by the inbound matcher or a follow-up report, never by the payment report — while a `no_payment_required` outcome here (and on `mode=renewal`, whose row keeps its Judge-owned `live`/`indexed`) SETTLES the zero-total purchase in this same report transaction (§6.3: `settled_at`, authorities satisfied, `paid_through`/`renews_at`) with no `placed` (pending-flagged or not) write; the INITIAL `mode=payment` on a paid EXECUTION path ⇒ the purchase
  outcomes AND — ONLY on an outcome that proves the submission reached the merchant: `close_pending` (the checkout completed; it settles to `charged`) or the successfully completed zero-total checkout (`voided`/`no_payment_required` with `settled_at`) — atomically with that purchase transition, `placed` (pending-flagged or not) (the card-boundary
  resume performs the final submission — it is both the purchase and the acquisition submit —
  so the placement leaves `ready_for_payment` for Judge verification in the same report; a
  failed/ambiguous/voided-without-settlement/`price_changed`/`instrument_unavailable` outcome
  NEVER writes `placed` — the row stays `ready_for_payment` on its unsatisfied instance);
  terms ⇒ `terms_accepted`/`terms_changed`/`mutation_ambiguous`/`captcha` (§13: ends `terms:n`, opens the OWNER_HUMAN_STEP successor)/`failed`/`skipped` only (never `placed`, a purchase outcome or a handoff); credentials/acquire ⇒ the execution outcomes incl. handoffs; a draft
  lease can never report `placed` or a handoff) — enforced atomically in the report
  transaction with the capability check, so no lease can corrupt another mode's lifecycle.
- **`needs_owner` is a report OUTCOME, not a status.** The report route's outcome allowlist
  gains `needs_owner` (and `payment_ambiguous`, `ready_for_payment`, `ready_for_credentials`,
  `price_changed`, `captcha`); `ready_for_payment` on a paid execution path atomically sets `status='ready_for_payment'` (§3.3; outreach paths keep `contacted`/`negotiating` and only flag the checkout) and releases the lease; `ready_for_credentials` atomically sets the placement
  `status='ready_for_credentials'` (a §3.3 status; `parked_from_status` kept), releases the
  lease — and, for BOTH handoff outcomes, the instance's `slot_reserved` submission attempt is
  NOT released: it is re-bound to the successor in the follow-on `mode=credentials`/`mode=payment`
  claim transaction (`UPDATE seo_link_attempts SET lease_token = <new token> WHERE id = ? AND
  outcome = 'slot_reserved' AND lease_token = <handoff's token>` under the cap lock, the
  handoff's token stored on the placement as `handoff_lease_token`), so the successor lease
  can advance the same slot to `submitting` without waiting for the expiry sweep and the
  resumable session is never lost — and is reclaimed ONLY through `claim(?mode=credentials)` whose predicate accepts
  that status, requires the provider to be the `deterministic_runner`, and re-runs the
  authority/approval/gate checks — the runner resumes from the persisted session and
  continues as a credentialed execution; `needs_owner` atomically maps the placement to `status='awaiting_owner'`
  (+ the owner card) and stores the status it parked from in `parked_from_status`;
  `claim()` excludes `awaiting_owner`/`watching`, and approval restores `parked_from_status`
  (`prospect` for a fresh acquisition, `contacted`/`negotiating` for a paid outreach
  placement whose payment step needed the owner — which then flows to `mode=payment`, never
  back through the send claim) with the approval recorded — so an owner-gated row is neither
  rejected by the route nor reclaimed by another worker.

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

**Credential boundary (same rule as payment).** Passwords, verification tokens, and
authenticated session state are secrets: every credentialed step — account creation, login,
IMAP verification-link click, session resume — is executed only by the `deterministic_runner`
through a **credential broker** (fills login/verification fields via Playwright locators in
an observation-free context, exactly like the payment broker; no LLM, no screenshot, no
trace). A model-observed provider may run only non-credentialed steps (investigation,
pre-login form discovery, filling public fields with the canonical NAP) and hands off with
`outcome='ready_for_credentials'`; it is never resumed inside an authenticated session. In
EVERY discovery/fill stage — model-observed or deterministic, live or benchmark — the
browser context runs under the §13 read-only request interception (mutating requests
blocked and logged); mutating requests are unblocked ONLY inside a **guarded mutation
phase** — `submit()`, and, for the deterministic runner alone, `createAccount()`,
`activateVerification()` (the verification link's GET is treated as mutating and allowed
only here) and `acceptTerms()` (the standalone agreement acceptance, `mode=terms`) — each of which is entered only after the locked authority/approval/gate recheck,
a durable attempt row (`slot_reserved → submitting` for submit; `create_account`/`resume`
attempts with their own persisted `idempotency_key` `${prospect_id}:${action}:${instance_key}` (§3.4, partial UNIQUE) for the
credentialed operations, so a crash mid-phase resumes the existing row rather than repeats the external call), and is re-blocked
when the phase returns — so a mis-click or page script during `completeForm` can never POST
around the submission guard or the daily cap, and account creation cannot be blocked by the
policy that protects it.

**Payment boundary (P0 — PAN/CVV never cross into a model context).** Only the
`deterministic_runner` may execute a `submit()` that involves payment, and even it does not
see card data: a **payment broker** — a small trusted module in the runner process with no
LLM, no screenshot, no trace — fetches the single-use card from the issuer, fills the card
fields directly via Playwright locators, and clears them from memory after submission. Any
provider whose reasoning observes page state (DOM, screenshots, accessibility tree, prompts,
traces — i.e. every cloud CUA implementation) is restricted to non-payment steps; for a
paid path it may prepare the checkout up to the payment form, then hands off to the broker
(`outcome='ready_for_payment'`) and is never resumed on that page until the broker has
submitted and the card is closed. **`charged` is committed only on issuer-confirmed
capture AND closure:** a successful submission lands in `close_pending`; the broker closes
the card; `close_pending → charged` requires BOTH `card_closed_at` (issuer-confirmed) AND an
issuer-confirmed **captured** transaction on that card for exactly `final_cents` (a closed
card proves nothing about capture — an authorization can still settle later, or never). A
pending/missing capture keeps the row `close_pending` (non-terminal: consumes budget, blocks
the placement, retried by the hourly sweep — close, then poll capture — up to the issuer's
settlement window); a capture for a different amount, a second authorization, or the window
expiring without capture → `ambiguous` for reconciliation. If the close call fails or the
worker dies in between, the same sweep drives it. The merchant token can therefore never outlive the
ledger's view of the purchase. The broker performs the payment in a **separate,
observation-free browser context**: tracing, video, screenshots, DOM snapshots, HAR/network
recording, accessibility dumps, console capture and every provider hook are **disabled on
that context before the card is fetched**, and nothing in that context is ever attached to
an attempt, evidence or log — there is no post-capture redaction because nothing is
captured; the only artefacts are the merchant's order id and the issuer's capture record.
Evidence for a paid placement is taken afterwards from a fresh context on the confirmation
page, with the card already closed. A provider without a technically enforced secret-input
boundary is never granted payment execution; this is a hard rule, not a configuration.

Implementations, in order:
1. **`deterministic_runner`** — the existing `signup-runner.js` (Playwright + form filler),
   extended for `account_required`, `email_verification` (IMAP verifier), `payment_required`
   (via the payment broker only, under `AUTO_PAID_WITHIN_POLICY` or after owner approval), and
   **resumable sessions** (persisted browser state keyed by `(domain_id, path_id,
   location_key)` — never by domain alone, so two locations or two account paths on one
   site can't resume each other's cookies or half-filled form; a shared-account site that
   hosts several location profiles is modelled as one session key with the profile selected
   explicitly per placement, serialized by a **durable session lease** — a `lease_token`/
   `lease_expires_at` on the `seo_link_credentials` row (§3.3b account identity), taken inside
   the placement claim and held for the whole external execution, released on the report; a
   second placement on the same shared account is not leasable while the session lease is
   held. The transaction-scoped `claimProspectDomain` admission lock (released at commit,
   `prospect-domain-lock.js`) is NOT relied on for this).
2. **`openai_cua` / `claude_cu` / `stagehand` / `grok`** — same interface, run in the
   benchmark (§10), **non-payment, non-credentialed steps only** (credential + payment
   boundaries above). A provider never
   receives credentials it does not need and never receives the Waves identity beyond the
   canonical NAP packet the contract already sends.
3. `human` — Adam completing a step from the owner card; recorded as an attempt like any other.

**Provider selection is a STEP-5 concern, deferred until a second approved provider has a
concrete need the runner cannot meet** (AGENTS.md: extend the existing mechanism first) —
steps 1–4 hard-code `deterministic_runner` for every step, and none of the override /
preference / cohort / fallback schema below ships before then. When it does: provider
selection per attempt = `COALESCE(path.provider_override, policy.preferred_provider)`
for non-credentialed, non-payment steps only — with ONE precedence above both during a live §10 benchmark: `seo_link_benchmark_cohorts (domain_id, provider, benchmark_id; UNIQUE (domain_id, benchmark_id))`, an explicit audited cohort assignment the claim predicate honours (disjoint cohorts by DOMAIN — every placement of a domain, all its locations and shared-account profiles included, belongs to one provider, so D30/cost/recovery outcomes are never cross-contaminated; the owner override and global preference are untouched, exactly as §10 promises) — restricted to live `BrowserAgentProvider` implementations that support the current action (CHECK on both columns: never `hermes` or `human`, which hold no execution-capable worker token; an unsupported choice falls through to the next preference, then the runner); **credentialed steps (account creation, email
verification, login, authenticated resume) and payment steps always resolve to
`deterministic_runner`** regardless of preference — a `ready_for_credentials` / `ready_for_payment`
hand-off is therefore always picked up by the runner, never re-offered to the provider
that cannot complete it. Outreach: `OutreachProvider` = drafter + `link-prospect-outreach`.

---

## 8. Judge — verification, D30, and the learning loop

- **Verification** is authoritative: verifier (crawl + DataForSEO, scan-tracked rows only),
  indexer (`site:` SERP), `first_live_at`, `is_dofollow` read from live `rel`. A provider
  report never sets `live`. **The inbound-profile cross-link is NOT shipped** (v1 §4.3 listed
  it, but `backlink-monitor.js` never touches the board and the verifier scans only rows with
  a `live_url` or `status='placed'`): step 4 adds a post-scan reconciliation that, after each
  Sunday scan, matches new/active scan-tracked `seo_backlinks` to `contacted`/`negotiating`
  placements — AND to `awaiting_owner` placements whose `parked_from_status` is `contacted`/`negotiating`
  and `outreach_status='sent'` (a publisher can post the link while the follow-up approval or
  exposed checkout waits on the owner; a match there moves the row to `placed` directly, the
  owner card stays open only for the payment dimension if one is pending, and a communication-only
  card is auto-resolved as `superseded_by_placement`) — by canonical domain + target-page variants AND the location/profile identity (the
  backlink's `source_url` matched against each candidate placement's own profile URL /
  account identity, §3.3b) — when the domain-page match is not unique across `location_key`s
  and no profile identity resolves it, it REFUSES to reconcile and parks an owner card instead
  of moving every sibling — and moves the one matched placement to `placed` with
  `live_url`/`backlink_id` (the verifier then promotes to `live`/`indexed`), so a publisher
  who posts the link without any worker report still lands in D30 and source reporting.
- **D30 survival** = a **sampled observation at the cutoff**, not an inference from
  neighbours: the daily verifier records an explicit `d30_sample` (and `d90_sample`) check
  for each placement within a bounded window `[cutoff, cutoff + 3 days]`; `d30_live=true`
  only if that sampled crawl/reconcile found the link active AND no `lost` event exists
  between the sample's `cycle_first_live_at` (§8 per-cycle sample row — NEVER the placement's original `first_live_at`, which the retained recovery flow preserves and which precedes the very loss that started a reacquisition cycle) and the sample on the row's lineage — a `merged` event is NOT a
  loss: it retires a duplicate spelling into a survivor, so the sample and the loss check
  follow `detail.into` to the surviving canonical row; `false` if the sample found it gone
  (or a loss event precedes the sample); `null` (unknown, excluded from learning) if no sample was
  taken inside the window — bracketing observations days apart never stand in for the
  sample, because a link can vanish and return between scans without a two-miss loss
  event. **Sampling is its own job, due-first and uncapped:** a nightly `link-d30-sampler`
  (before the 04:30 ET verifier) selects every placement whose D30/D90 window is open and
  unsampled, drains that set in batches, and records the sample; the retained verifier's
  200-row `last_live_check` rotation is not relied on for it, so growth of the board never
  starves the only success metric. The same rule replaces the imported-baseline test in §4 (imports predating scan
  coverage stay `null`). Stored PER ACQUISITION CYCLE, not once per placement: `seo_link_d30_samples (prospect_id, acquisition_attempt_id, horizon CHECK IN ('d30','d90'), cycle_first_live_at, live boolean, sampled_at; UNIQUE (acquisition_attempt_id, horizon) WHERE acquisition_attempt_id IS NOT NULL, plus a partial UNIQUE (prospect_id, horizon) WHERE acquisition_attempt_id IS NULL for imported baselines, which have no attempt)` — one immutable row per horizon per cycle, each with its own `sampled_at` proving it was observed inside its cutoff window — the cutoff is the cycle's own first-live, PERSISTED BEFORE ANY SAMPLING as `seo_link_attempts.first_live_at` on the acquisition attempt (§3.4) at the moment the Judge first verifies the placement live after that attempt — so the nightly sampler selects on attempts (`first_live_at` set, horizon due, no sample row for that attempt+horizon) and never on the placement's original `first_live_at`; `cycle_first_live_at` on the sample row is a copy taken when the sample is recorded (the Judge's verification after THAT successful attempt; the retained verifier only initializes `first_live_at` when null and `lost-link-recovery` preserves it, so a reacquisition needs its own row), and the §8 learning join reads the sample through `acquisition_attempt_id`, so a recovery provider/path is credited only with its own cycle's outcome; the placement's `d30_live`/`d90_live` columns mirror the LATEST cycle for display — this is
  the only success metric that counts.
- **Learning:** nightly aggregate `persistence` and `index_rate` per `(source, acquisition_type)`
  and per `domain` into `seo_link_learning` (small table, replaced each night). The
  per-`(source, acquisition_type)` aggregate reads ONLY placements whose acquisition Waves
  executed — it JOINS each sampled placement to its successful `seo_link_attempts` row and
  credits the outcome to THAT attempt's `path_id`/`acquisition_type_snapshot` (never to the
  placement's current path, which §3.2 may have repointed to a superseding path after the
  acquisition); rows with `source='existing_backlink'`, placements whose acquiring path has
  `baseline=true`, and placements with no successful attempt at all are excluded — they may
  feed the per-`domain` aggregate (a statement about the host, not the path), so an imported
  baseline with a real sampled D30 never credits an acquisition type Waves never used, and a
  genuine outcome is never discarded because its path was later replaced. The scorer reads them:

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
from D30/learning); the Agent tab shows the table with a recommended provider. The
benchmark is **advisory**: it never changes `preferred_provider` or any `provider_override`
— the owner selects the provider through the audited Policy panel edit, so account
sessions and credentials never move to a different provider without that action.

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
`GATE_HERMES_WORKER` + `HERMES_SERVICE_TOKEN` (claim/report — from step 1 every provider, `hermes` included, authenticates with per-provider HMAC request signing; `HERMES_SERVICE_TOKEN` stays accepted for the `hermes` identity only (same capability limits, `auth_scheme` logged) through the ordered rollout in §1; the §14 step-1b follow-up removes bearer acceptance from the BACKLINK route only after 7 days of zero bearer rows there — the ENV ITSELF is unset by a separate later PR, only once the vendor price/login worker routes that share `hermesAuth` (503 when the env is unset) are on their own signed credential and every `hermesAuth` mount shows 7 bearer-free days (§1/§14). `LINK_WORKER_SECRET_<PROVIDER>` (timestamp + nonce replay protection, capabilities derived only after signature verification), and only the `deterministic_runner` key carries payment/credential capability), `GATE_SIGNUP_RUNNER` +
`SIGNUP_RUNNER_ALLOWLIST`, `GATE_OUTREACH_DRAFTER`, `GATE_LINK_OUTREACH` +
`LINK_OUTREACH_DAILY_CAP`, `HERMES_SIGNUP_EMAIL`.

New, all **default OFF in prod**: `GATE_LINK_INVESTIGATOR` (investigator job),
`GATE_LINK_AUTHORITY` (the policy engine may grant any `AUTO_*`, AND every automated claim
and every irreversible step re-checks it regardless of the stamped level; **off ⇒ the claim route grants no automated lease
at all, owner-approved rows included and in-flight `AUTO_*` work stops before its next irreversible action** — the gate
changes NO lifecycle status: pending `AUTO_*` placements simply stay `prospect` and are
refused by the claim predicate while it is off (the Agent tab shows them as "held by
GATE_LINK_AUTHORITY"), so re-enabling the gate releases them with no restoration step and
nothing is ever stranded; verified and terminal statuses are Judge-owned history and are
never touched by a gate; NO automated lease of any authority level — owner-approved included — is granted while it is off, and in-flight owner-approved work also stops before its next irreversible action; only human actions (the settlement form, owner UI clicks) continue), `GATE_LINK_AUTO_PAID`
(separately arms `AUTO_PAID_WITHIN_POLICY` — never required for owner-approved payments),
`GATE_LINK_PAYMENTS` (the payment-lane kill switch: off ⇒ no purchase of any authority is
minted or submitted; owner-approved rows wait), `GATE_LINK_RECURSIVE_DISCOVERY`. From step 4
the registry's `ready_to_acquire` + stamped authority is the *only* allowlist: the
authority-aware claim predicate is unconditional (not gated), and `SIGNUP_RUNNER_ALLOWLIST`
is retired in that PR: its domains are migrated into registry rows/paths (`source_detail=
'signup_runner_allowlist'`) in `awaiting_owner` — **no approval is synthesized**; each gets a
fresh owner card (the prior allowlisting is shown on it as context) so every override has a
real click and an immutable snapshot behind it. Kill for any lane =
unset its gate; budget kill = the issuer program's limit.

---

## 13. Guardrails (must ship with each step)

- **SSRF** — every server-side fetch through `contact-finder.fetchPage()`; providers run in
  their own sandbox and receive URLs, never portal network access — AND every LIVE browser
  navigation and subrequest (deterministic runner, credential/payment brokers and every
  model-observed provider alike) runs under **browser-level request interception with per-hop
  validation**: each request — top-level navigations, every redirect hop, subresources,
  fetch/XHR, websockets — is refused unless the scheme is http(s) and the host is not on the
  deny list; and, because interception alone is NOT an SSRF boundary (a pre-check resolution
  does not bind Chromium's own later lookup — a rebinding host can answer public to the guard
  and internal to the browser), the sandbox has **no direct egress**: every browser socket
  goes through a network-enforced egress proxy (`--proxy-server`, with the sandbox subnet
  firewalled so the proxy is the only route out and loopback/RFC1918/link-local/CGNAT/
  multicast/metadata 169.254.169.254/sandbox-internal ranges are unroutable) that resolves the
  destination itself and connects ONLY to the address it validated as public unicast — the
  actual socket destination is what is checked, per hop, redirects included. A blocked
  request fails the step (`outcome='blocked'`, evidence recorded) rather than being silently
  dropped. The same interception layer carries the §12 mutating-request policy; a provider
  that cannot run under it (no CDP/route hook) or outside the proxied sandbox is not eligible
  for live steps at all.
- **Comms** — outreach targets are businesses. Today `link-prospect-outreach` only validates
  recipient *syntax*; step 4 adds a **fail-closed customer-recipient exclusion** before any
  auto-send: the recipient email (and its domain, when the domain is a customer's own) is
  checked inside the send claim against every real contact source — `customers.email` plus
  **every** slot in `SERVICE_CONTACT_SLOTS` from `services/customer-contact.js` (today
  `service_contact_email`, `service_contact2_email`, `service_contact3_email`; the lookup is
  BUILT from that export so a new slot is covered automatically), `notification_prefs.billing_email` (a sendable customer address per `customer-email-fanout.js`), and `leads.email` — the check runs
  inside EVERY send claim — auto-send, owner-approved send, follow-up — not only before an
  auto-send: an identified customer recipient is a **hard block** (`skipped`,
  `reason='customer_recipient'`, row parked with the reason; no approval can send it), while a
  lookup error/timeout or an ambiguous match (name-only, shared business domain) routes the
  draft to the approval queue with the match shown — and the approval BINDS that evidence:
  `terms_snapshot.recipient_review = { recipient, match_kind, matched_ids, lookup_hash }`; the
  owner-approved send claim re-runs the lookup and, when the result is the SAME ambiguous
  match the owner reviewed (equal `lookup_hash`), the approval resolves it and the send
  proceeds; an exact customer match stays a hard block regardless of approval, and a lookup
  error at send time stays fail-closed (parked again). Unit-tested per slot (slot 3 included)
  rather than against a hand-written column list.
  The June drafts are released only through this path.
- **PII / secrets** — credentials encrypted, never in attempts/evidence/logs/prompts;
  Twilio/Gmail errors logged by code only; identity packet = canonical NAP only.
- **Footprint** — daily caps on sends (§6.4, inside the sender lock) and on submissions
  (`auto_submission_daily_cap`: the locked claim **reserves a slot** — an attempt row
  `outcome='slot_reserved'` for the ET day, written under ONE shared cross-domain advisory
  lock `pg_advisory_xact_lock(hashtext('link_submission_cap:<ET day>'))` taken inside the
  claim transaction around count-and-insert (and around the day-rollover re-reservation) —
  the prospect/domain locks and `FOR UPDATE SKIP LOCKED` serialize different prospects
  against nothing, so only this global lock makes the cap a cap — and counted with completed
  submissions, so several leased providers cannot all observe room
  before any attempt is recorded; re-checked immediately before every submit. **Submission
  is idempotency-guarded like a purchase:** the slot row carries its ET date
  (`slot_day = etDateString(now)`); immediately before the irreversible call, under the same
  advisory lock, the provider compares `slot_day` with the current ET day — if the day rolled
  over, the SAME pre-submission attempt row is re-slotted IN PLACE under the new day's
  `link_submission_cap:<ET day>` lock — `UPDATE … SET slot_day = <new day> WHERE id = ? AND
  outcome = 'slot_reserved' AND lease_token = ?` after the new day's count shows room (no room
  ⇒ the row becomes `skipped`, never submitted); no second row is ever inserted for the same
  action instance, so the §3.4 partial-unique `idempotency_key` (one row per
  `${prospect_id}:${action}:${instance_key}`) is never violated and the instance-bound approval
  stays valid — and only then flips the attempt `slot_reserved → submitting` (durable,
  conditional on the lease). The only edges out of `slot_reserved` are `submitting` (worker,
  under the lock), `skipped` (no room after rollover) and `slot_released` (the sweep on lease
  expiry only — conditional on `outcome='slot_reserved'`, so a row that already advanced is
  never released; a released instance's next lease re-reserves by updating that same row back
  to `slot_reserved` with a fresh `slot_day`, never by inserting); a `submitting` attempt is never released by the sweep — if the worker dies before
  reporting, the sweep parks it as `submit_ambiguous`, the placement is excluded from
  re-claim, and reconciliation (the daily verifier / domain reconcile finding the profile, or
  the owner card) settles it; only a `slot_reserved` attempt whose lease expired is released (→ `slot_released`). The runner's
  `batchSize`/`runExclusive` only serialize one invocation and are not the limit);
  one conversation per inbox — enforced by a durable RECIPIENT-level guard, not the domain lock: `claimProspectDomain` locks only the canonical domain, so the send claim additionally takes `pg_advisory_xact_lock(hashtext('link_outreach_inbox:' || lower(recipient)))` and refuses when any other placement with that recipient is `contacted`/`negotiating`, `awaiting_owner` with `parked_from_status IN ('contacted','negotiating')` or `outreach_status='sent'` (a conversation parked for a checkout or follow-up approval is still open), in a send in-flight (`sending`), OR holds an unreconciled `send_error` (the message may have been delivered — the placement is still `prospect`, so the status alone is not enough; the predicate reads `outreach_status IN ('sending','send_error')` too) — and EVERY branch of the guard additionally requires `conversation_closed_at IS NULL`: a durable closure stamp (new §3.3 column) written when the conversation is over — the placement reaches `live`/`indexed` WITH its communication lifecycle complete (Judge promotion after a reconciled/placed outreach — the promoting transaction stamps it only when every required send is terminal and no follow-up is pending; a pending late send on an `execution_after_send=false` path keeps the conversation open, the closure then stamped by that send/follow-up lifecycle finishing), goes `lost`/`rejected`, or its outreach lane completes with no reply window left (follow-up `sent`/`skipped` AND 45 ET days since the last send with no inbound match; a reply reopens nothing — a new conversation is a new placement). The partial unique index on `lower(outreach_to_email)` — the shipped recipient column on `seo_link_prospects` — covers those statuses AND those outreach_status values AND `conversation_closed_at IS NULL`, so it stays durable across pods while a finished conversation releases the inbox for a later placement — and a verified-loss recovery cycle on the SAME placement clears the stamp in its opening transaction, re-entering the guard (§3.3); signup lanes coexist per location by design; no templated blasts.
- **ToS / CAPTCHA** — a CAPTCHA or explicit-consent step is `outcome='captcha'` →
  `awaiting_owner` (never solved by an agent) AND, in the same report transaction, the
  current execution instance is ENDED (`end_outcome='captcha'`) and a NEW
  `OWNER_HUMAN_STEP` instance of the SAME action kind as the interrupted one (`-:n+1` for an
  acquire, `terms:n+1` for an `accept_terms`, `followup:n+1` …) opened for that placement
  alone — the instance the §7 resume protocol consumes (`human_step_done` → satisfied →
  `<kind>:n+2` decided for the remainder of that same action; CAPTCHA completion is never
  treated as acceptance of an agreement), so the original automatic authority is never reused across the
  checkpoint; paid-link-only "sponsored" slots are stored
  with `expected_rel='sponsored'` and scored accordingly.
- **Money** — single-use per-purchase virtual cards with an issuer-enforced ceiling; PAN/CVV
  handled only by the local payment broker, never by a model-observed provider; every charge
  is a ledger row + attempt; owner approval is a portal click.
- **Truth** — a provider report is a claim; the Judge promotes; `merged`/`lost` semantics
  from #3544 apply to everything acquired.

---

## 14. Build order (PR boundaries)

1. **Registry + paths + provenance + statuses** — migrations for §3.1–3.5, `awaiting_owner`/
   `watching`/`ready_for_credentials`/`ready_for_payment` (status enum/constraint, `PROSPECT_STATUSES`, domain-guard sets, board filters + guard regression tests — all four), `domain_id/path_id/authority` + claim-binding columns (`leased_provider`/`lease_mode`/`lease_action`/`handoff_lease_token`) on prospects, per-provider HMAC worker auth (§12) accepting bearer alongside for `hermes` only + the `seo_link_worker_requests` request audit table (§3.4c, written for every accepted claim/report incl. empty claims), TOGETHER WITH the Hermes signing helper + the in-repo drafter skill cut over (the external dashboard signup skill is migrated by hand and verified via `auth_scheme` — §1); **step 1b (follow-up, dated):** remove bearer acceptance from the backlink worker route after `seo_link_worker_requests` shows 7 days of zero `auth_scheme='bearer'` rows (§3.4c query pasted in the PR) — but `HERMES_SERVICE_TOKEN` itself is NOT unset there: the shared `hermesAuth` middleware also guards `integrations-vendor-price-worker.js` and `integrations-vendor-login-worker.js` (both `router.use(hermesAuth)`, and `hermes-auth.js` returns 503 whenever the env is unset), so the env is unset only by a LATER PR after those two routes are on their own signed credentials (`LINK_WORKER_SECRET_HERMES_VENDOR`, the same HMAC helper, their callers migrated by hand in the dashboard and verified by `seo_link_worker_requests` rows tagged `endpoint IN ('vendor_price','vendor_login')` — the audit table's `endpoint` CHECK is widened for them) and the 7-day zero-bearer window holds across ALL `hermesAuth` mounts, never the backlink route alone (contract test: unsetting the env with any bearer-only route mounted fails boot); intake SERVICE (`link-registry-intake.js`, called directly by jobs) + its thin admin endpoint
   (normalize/dedupe/upsert only); `seo_signup_attempts` backfill + atomic `recordAttempt`
   cutover to `seo_link_attempts` (§3.4). Docs-tested with contract tests on the guard.
2. **Bulk intake** — paste box + CSV import + competitor-gap ingestion job + existing-profile
   baseline; `seo_link_intake_items` (§3.4d) + the resolver retry sweep land here, before the X feeder. `Backlinks.csv` enters here as `list_import` / `backlinks_csv_2026_08`.
3. **Path investigator** — job + schema-validated LLM call + probe list + cost caps;
   `GATE_LINK_INVESTIGATOR`. Run it over the full gap ingestion; ship the Registry view.
4. **Authority policy** — `seo_link_policy`, decision function + tests, owner cards,
   Policy panel; `GATE_LINK_AUTHORITY`; shipped as four PRs (owner ruling 2026-09-02/03): 1 = policy row +
   decision + panel (#3765); 2a-i = `seo_link_floor_waivers` + `seo_link_approvals` schema + the §3.3b
   instance columns (dark, nothing reads them); 2a-ii = the nightly
   bridge (gated: selection-only while the gate is off; ONE bell per run, never per card; every bridged
   placement targets the homepage until a topic is persisted on the domain; spend = 0 and D30 = null
   until steps 5/7); 2b = Owner-queue cards + Approve/Reject/Watch/Acquire-anyway; 3 = the outreach
   mandate; 4 = claim re-check, `mode=payment`, allowlist retirement; the post-scan inbound cross-link for outreach
   placements (§8 — not shipped today) and the `mode=payment` claim (§7). Bounded outreach mandate (§6.4) lands here and
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
- §4 reconciliation jobs (verifier 04:30 ET, indexer 05:00 ET) — unchanged. The v1 "profile
  cross-link" was never built; it is scheduled in step 4 (§8, §14), not retained.
- §14 dual-ROI target taxonomy: Tier 1 realtor / inspector / property-manager / complementary-
  service partnerships (WDO wedge); Tier 2 local media + HARO with seasonal hooks and the Pest
  Pressure engine as the linkable asset; Tier 3 chambers / sponsorships; Tier 4 NPMA / FPMA /
  UF-IFAS / BBB; Tier 5 citations. Tiers now inform *quality* and `link_type`; they no longer
  decide *permission* — §6 does.
- `link_type` enum, board columns, Link Building smart views — unchanged.

Superseded: v1 §5 (Hermes Docker worker), §9's permanent manual send valve, §11 Playwright
cutover (replaced by the provider race), v1 open decisions 2–3.

## 16. Open decisions

1. HOW issuer evidence reaches the reconciler for `ambiguous` purchases — issuer transaction
   API (automated) vs. owner-assisted inspection of the issuer's own transaction record
   (pasted/attached into the owner card) — decide at step 5. Issuer evidence itself is
   **mandatory** either way: `reconciled_not_charged` is never a human judgment without the
   issuer's confirmation of closure + no captured/pending authorization (§6.3).
2. Virtual card issuer for the acquisition budget — must support single-use per-purchase
   numbers with a hard monthly program limit (§6.3); Adam.
3. `auto_outreach_daily_cap` starting value (proposal: 10; hard ceiling stays
   `LINK_OUTREACH_DAILY_CAP=12`) — Adam, at step 4.
4. Whether `OWNER_MEMBERSHIP` cards should batch weekly (one digest) or ring per card — Adam.


### Free execution integration

Authority-bound leases, durable submission caps, provider ownership, final mutation checks and held evidence are implemented for free deterministic submissions. Submit-first and send-first ordering reuse the existing communication lifecycle. Backlink matching ships separately. Live rollout remains an owner step.

### Verified outreach matching

Completed backlink scans can match fresh target-specific outreach evidence. Ambiguous identity requires an audited owner assignment; a backlink cannot be assigned to two active sibling placements. Matching retires an unsent follow-up and leaves live/indexed verification to the verifier. Execution leases ship separately.
