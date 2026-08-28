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
// agent_state is an AGGREGATE over the domain's placements, recomputed by the bridge job / on every placement transition:
//   ready_to_acquire = ≥1 placement stamped AUTO_* or approved and still 'prospect'   (stays/returns here while ANY authorized placement is pending — e.g. a second GBP location)
//   acquiring        = ≥1 placement leased OR `placed` (submitted, awaiting the Judge's verification) and none pending-unleased
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
t.string('currency').notNullable().defaultTo('unknown'); // CHECK (currency IN ('USD','unknown','foreign')) — 'foreign' = a confirmed non-USD marker (never automated; §6.3 ⇒ OWNER_MANUAL_PAYMENT), 'unknown' = no/uncertain marker (⇒ price-entry card) — set by the investigator's currency gate (§5); an AUTOMATED reservation exists only for 'USD' — 'foreign' stays a VALID path routed to OWNER_MANUAL_PAYMENT (manual settlement only), 'unknown' parks for price entry; a payment input for revision_payment and every payment hash/snapshot
t.jsonb('merchant_binding');                      // CANONICAL, revisioned (part of revision_payment): { checkout_origin, processor: { host, merchant_account_id }, issuer_merchant_descriptor } as observed by the investigator on the checkout chain; nullable: a paid path MAY qualify without a valid binding — it then can only ever be decided payment=OWNER_MANUAL_PAYMENT (§6.3) and never reaches an automated reservation (fail-closed there); when present, the reservation copies THIS field into the purchase's immutable merchant_binding — never the descriptive `investigation` blob — integer cents, parsed ONCE by the investigator from the quoted price text (kept verbatim in `investigation`); never decimal, never re-parsed downstream
t.boolean('account_required').notNullable(); t.boolean('email_verification').notNullable(); t.boolean('payment_required').notNullable();
t.boolean('legal_attestation').notNullable();     // signed agreement / vendor terms / W-9 etc.
t.text('legal_terms_hash');                       // sha256 of the canonicalized agreement/attestation text the investigator fetched (URL kept in `investigation.legal_terms_url`); REQUIRED when legal_attestation=true (§6.3 validity: true + null hash ⇒ INVALID); part of every dimension's inputs hash and approval snapshot; the runner re-fetches and re-hashes the agreement IMMEDIATELY before any accept/sign step and refuses on mismatch (attempt `outcome='terms_changed'`, approval invalidated reason 'terms_changed', placement → awaiting_owner with a fresh card showing the diff)
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
t.numeric('confidence', 3, 2);                    // 0–1 — CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)); the investigator's JSON schema and the §6.3 validity step assert the same range (a value outside [0,1] ⇒ INVALID), so a malformed confidence can never clear a floor
t.integer('revision').notNullable().defaultTo(1);  // display/global counter: +1 whenever ANY in-place authority- or approval-relevant field changes (acquisition_type / submission_url changes supersede the row instead — see above)
t.integer('revision_payment').notNullable().defaultTo(1);        // +1 only on payment inputs: estimated_cost_cents, renewal_cost_cents, renewal_period, currency, payment_required, legal_attestation, legal_terms_hash, merchant_binding
t.integer('revision_communication').notNullable().defaultTo(1);  // +1 only on communication inputs: link_type, expected_rel, legal_attestation, legal_terms_hash (recipient/draft live on the approval hash)
t.integer('revision_execution').notNullable().defaultTo(1);      // +1 only on execution inputs: account_required, email_verification, agent_completable, legal_attestation, legal_terms_hash
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
// the new path and, in the SAME transaction, marks the matched old one superseded_by it, invalidates every open approval on the old path (reason 'path_superseded'),
// repoints its placements (path_id → new, authority cleared → the bridge job re-decides), and voids any `reserved`
// purchase on it — UNLESS a placement has a post-exposure purchase open (`submitting`/`close_pending`/`ambiguous`) OR an active execution/communication lease with an attempt in `submitting`/`sending`/`submit_ambiguous`/`send_error` (an external action may already be past its final authority check):
// that placement stays PINNED to the old path: the old path is marked `superseded_by` = new path immediately (so no
// NEW work can start on it), and the placement records `pending_path_id` = new path (durable FK on seo_link_prospects,
// nullable) instead of being repointed; purchases/reconciliation are explicitly permitted to complete against a
// superseded path (state-locked transitions check the purchase's own path_id, not "non-superseded"). When the
// purchase settles, the settlement transaction repoints `path_id := pending_path_id`, clears it, and lets the bridge
// re-decide; it writes the paid term from the purchase's snapshot ONLY when the settlement is a charge
// (`charged` / `reconciled_charged` / `manual_charged`) — `reconciled_not_charged` completes the repoint and frees a
// new generation but never grants a term. After a restart the sweep finds every
// placement with a non-null pending_path_id and no open purchase and finishes the repoint. Old terms can therefore never execute AND a settling checkout never lands on a
// different path. Changes to the other authority-relevant fields edit in place and bump `revision` (§ below).
// Either way, nothing can execute under the old terms: claim requires a non-superseded path whose revision AND
// identity match the approval.
```

### 3.3 `seo_link_prospects` — placements (existing; additive columns)

```js
t.uuid('domain_id').references('seo_link_domains.id');
t.uuid('path_id').references('seo_link_acquisition_paths.id');
t.string('parked_from_status');  // the status a row held before parking as awaiting_owner/watching; restored on approval/resume (§7)
t.string('renewal_status');      // CHECK (renewal_status IS NULL OR renewal_status IN ('active','lapsed')) — paid placements only; 'lapsed' = the renewal job declined to re-authorize (§6.3); placement-level, never the domain
t.timestamp('renewal_recheck_at'); // when the verifier/renewal job next re-examines a lapsed placement (placement-level counterpart of the domain's watch_recheck_at)
t.uuid('credential_id');         // → seo_link_credentials: the account this placement acts under (explicit; never inferred from domain)
t.uuid('pending_path_id');       // → seo_link_acquisition_paths: the replacement path a superseded placement will be repointed to once its open post-exposure purchase settles (§3.2)
t.string('location_key').notNullable().defaultTo('-'); // GBP location for per-location signup placements (Bradenton, Sarasota, …); '-' = not location-scoped. Replaces the runner's quality_signals.location identity (backfilled). Unique key becomes (target_domain, target_page, location_key); findPlacementRow takes the location; outreach lanes always '-'
t.string('authority');            // SUMMARY only (the most restrictive dimension, for lists/cards); the binding record is seo_link_placement_authorities
t.text('source_detail');
t.date('paid_through');           // end of the term the last `charged` purchase bought (ET calendar day, copied from the purchase row)
t.date('renews_at');              // = the settling purchase row's own `paid_through` (date, ET); written on `charged`, `reconciled_charged` AND `manual_charged` (its immutable terms_snapshot — never the path's current renewal_period); written atomically when a purchase reaches `charged` (i.e. after close confirmation) OR `reconciled_charged` (initial or renewal); cleared when the listing lapses; read by the renewal job
t.boolean('recurring_merchant').notNullable().defaultTo(false);
```
New statuses: **`awaiting_owner`** (parked on an owner decision: payment / membership / legal),
**`watching`** (unactionable today, rechecked) and **`ready_for_credentials`** (a
model-observed provider handed off at the credential boundary, §12; leasable ONLY by the
`deterministic_runner` via `claim(?mode=credentials)`). `PROSPECT_STATUSES` in
`admin-backlink-agent-v2.js` is the contract — all three are added there, in the step-1
status migration/constraint, the domain guard (`ready_for_credentials` joins
`IN_FLIGHT_STATUSES` beside `watching`), the board's status filters and the tests; the
worker's generic `claim()` never leases any of the three.
Both statuses join the board's domain guard in the SAME PR (step 1): `awaiting_owner` is added
to `ACTIVE_OUTREACH_STATUSES` in `prospect-domain-lock.js` — a parked outreach placement is
still the domain's one conversation, so `claimProspectDomain()` refuses a second writer that
proposes the same canonical host for another target page while one is parked (otherwise both
could be approved and contact the same inbox); `watching` is added to `IN_FLIGHT_STATUSES`
only (the recovery lane sees it; it is not an open conversation), and resuming a `watching`
row (restoring `parked_from_status`) is a board admission that runs through the same guard
exactly like the PATCH reopen — refused while another row for the domain is in active
outreach. `prospect-domain-lock.test.js` pins both sets.

### 3.3b `seo_link_placement_authorities` — one row per required dimension

```js
t.uuid('id').primary(); t.uuid('prospect_id').notNullable();
t.string('dimension').notNullable();   // CHECK (dimension IN ('execution','payment','communication'))
t.string('level').notNullable();       // CHECK (level IN (the §6.1 enum EXCEPT OWNER_OVERRIDE)) — the underlying decision; a waiver is referenced, never stamped as the level
t.uuid('approval_id');                 // NULL while an OWNER_* decision is pending (the bridge writes the row, the placement parks in awaiting_owner, the click creates the approval and fills this in); REQUIRED for CLAIMABILITY of any OWNER_* row (and a row with `floor_waiver_id` additionally needs that waiver valid), not for the row's existence; the referenced approval's `dimension` AND `instance_key` must equal this row's (enforced in the approval transaction)
t.uuid('floor_waiver_id');             // → seo_link_floor_waivers when this dimension was decided under a floor waiver (§6.3 1b); `level` still holds the UNDERLYING decision — never OWNER_OVERRIDE — and the claim checks the waiver's validity in addition to the level
t.text('decision_inputs_hash').notNullable(); t.integer('path_revision').notNullable(); // the hash covers only THIS dimension's inputs; path_revision = the path's revision_<dimension>
t.string('instance_key').notNullable().defaultTo('-:1'); // the ACTION INSTANCE this row governs: `${kind}:${generation}` — kind '-' = initial acquisition/send, a renewal's renewal_period_key, or 'followup'; generation starts at 1 and the bridge opens `${kind}:${n+1}` when the previous instance ended in a NON-successful terminal outcome (`failed`/`skipped`/`send_error` reconciled as not sent) and a retry is warranted (re-investigation or owner "retry") — each new instance is a NEW row that must be decided and, if OWNER_*, freshly approved; satisfaction never carries across instances; a successful instance (`placed`/`sent`) never gets a successor of the same kind
t.timestamp('decided_at').notNullable(); t.timestamp('satisfied_at');                  // set when THIS instance's action completed (e.g. communication '-' after `sent`) — a satisfied instance is never re-decided; the next instance starts unsatisfied
t.unique(['prospect_id', 'dimension', 'instance_key']);
```
The bridge job writes one row per dimension the path touches — the dimensions are
mutually exclusive by path type except for payment: **communication** for outreach/content
types (their only non-payment dimension: the send click's `outreach_send` approval satisfies
it), **execution** for every other type (self-service, account, business-claim, membership,
vendor registration, human steps), and **payment** in addition whenever `payment_required`.
An outreach placement therefore never carries an execution row, so the 56 drafts and their
follow-ups need exactly the communication authority (plus payment only if paid). The locked claim and every
irreversible step (submit, send, mint) load ALL rows for the placement. The dimension
**owning the current action** (payment for mint, communication for send/follow-up, execution
for submit/create-account) must be `AUTO_*` (gate on, re-run decision agreeing) or `OWNER_*`
with a valid, **unconsumed, action-matching** approval. **An approval's scope is the whole
action instance, not a single step:** the execution/`acquire` approval covers every step of
one acquisition (create-account → email verification → resume → submit) and is consumed
ONLY by the terminal outcome of the final submit (`placed`/`pending`/`failed`/`skipped`);
intermediate steps verify it is valid and unconsumed but never consume it, and
`satisfied_at` on the execution instance is set only after that final submit. Likewise the
payment/`purchase` approval spans reserve → mint → submit and is consumed on the purchase's
settlement; the communication approval on the send's terminal outcome. Every OTHER required dimension is a **durable prerequisite**: its row must be
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
(price, renewal, payment/legal flags → payment; recipient/draft → communication; type/URL →
supersession, all dimensions). A dimension INSTANCE with `satisfied_at` set is validated by nothing further — it is done;
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
t.string('provider').notNullable();   // CHECK (provider IN ('deterministic_runner','openai_cua','claude_cu','stagehand','grok','hermes','human')) — `hermes` = the legacy shared HERMES_SERVICE_TOKEN identity (§12): investigation/draft reports only, no payment/credential capability
t.text('idempotency_key');            // for irreversible external mutations (`create_account`, `resume`/verification activation, `submit`): `${prospect_id}:${action}:${generation}`; partial UNIQUE where not null — a second lease that reaches the same mutation finds the existing row (ON CONFLICT DO NOTHING + re-select) and — because a DB row cannot prove whether the external call took effect — treats it as **`mutation_ambiguous`** (outcome, added to the enum): the runner first RECONCILES per action before anything is re-sent (`create_account`: probe the login/‘email already registered’ path or the inbox for the welcome mail; verification activation: reload the account and read its verified state; `submit`: the existing profile/listing probe the Judge uses) and only retries the external call when reconciliation PROVES the first one did not take effect; an unprovable state stays `mutation_ambiguous` for the owner card — a crashed mutation is therefore never repeated blindly
t.string('acquisition_type_snapshot'); // the path's acquisition_type AT the attempt (with path_id, the durable learning key — a placement repointed to a superseding path keeps its successful attempt's own path/type)
t.string('action').notNullable();     // investigate | create_account | complete_form | submit | resume | outreach_send | manual_payment (human settlement only) | price_entry (owner price-entry card only, outcome price_entered)
t.string('outcome').notNullable();    // CHECK (outcome IN (
                                      //   'slot_reserved','slot_released','submitting','submit_ambiguous', -- submission lifecycle (§13); slot_released = a reserved slot given back on lease expiry (ET-day rollover re-slots the same row in place, §13) — audit-only, NEVER counted by the cap query; the same row returns to slot_reserved on the instance's next lease
                                      //   'placed','pending','drafted','sent','failed','skipped','blocked','captcha',
                                      //   'needs_owner','human_step_done','ready_for_payment','ready_for_credentials',
                                      //   'no_payment_required','price_changed','instrument_unavailable','auto_renew_unavoidable',
                                      //   'payment_ambiguous','mint_not_started','terms_changed','send_error','budget_month_rollover','manual_charged','price_entered','mutation_ambiguous','sandbox_replay' )) -- budget_month_rollover = the §6.3 rollover void (a `submit` attempt row records it in the same transaction as the void); manual_charged = the human settlement form's `human` attempt (action `manual_payment`, provider `human`), inserted in the same transaction as the terminal `manual_charged` purchase row — the only outcome a manual settlement may record; send_error = the retained sender's ambiguous Gmail failure (may have reached Gmail before timing out; reconciled by the sender flow as sent / not sent) — the ONE complete enum; every state named anywhere in this plan is here
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
t.text('touch_key').notNullable();   // `${source}:${source_ref || normalized source_detail || '-'}` — non-null so a recurring feeder is idempotent (Postgres UNIQUE treats NULLs as distinct)
t.timestamp('seen_at').notNullable().defaultTo(knex.fn.now());
t.unique(['domain_id', 'touch_key']);
```
`seo_link_domains.source` is first-touch attribution and is never overwritten; every feeder
(including a repeat of the first) inserts a row here. §8 reports and learns per source from
this table (a domain discovered by three feeders credits all three; "first-touch" and
"any-touch" are both reportable) — **but only touches recorded BEFORE the placement was
acquired** (`seen_at` < the timestamp of the successful acquisition attempt — the same `seo_link_attempts` row the §8 learning join uses; `first_live_at` is only the fallback when no attempt exists, i.e. never for executed placements — and never `existing_backlink`, which is observational):
a feeder that merely notices a link after it converted earns no attribution and cannot
bias `P(live at D30 | source, path)`. Recursive lineage follows `source_ref` chains here.

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
(`backlink-agent/email-verifier.js`) is reused for `email_verification=true` paths.

### 3.6b Approvals — `seo_link_approvals` (immutable terms snapshot)

Every `OWNER_*` decision is an approval row that freezes exactly what was approved (a floor-waiver click is NOT an approval row — it is audited in its own table, `seo_link_floor_waivers`, §6.3 1b, and never authorizes an action instance); execution is bound to it and it dies if anything it froze changes.

```js
t.uuid('id').primary(); t.uuid('prospect_id').notNullable(); t.uuid('path_id').notNullable();
t.integer('path_revision').notNullable();     // the path's revision_<dimension of this approval's action> at approval time (§3.2) — never the global counter
t.text('decision_inputs_hash').notNullable(); // hash of THIS approval's dimension inputs only (same sets as the authority rows): payment = {estimated_cost_cents, renewal_cost_cents, renewal_period, currency, payment_required, legal_attestation, legal_terms_hash, merchant_binding}; communication = {link_type, expected_rel, legal_attestation, legal_terms_hash, recipient, subject/body hash}; execution = {account_required, email_verification, agent_completable, legal_attestation, legal_terms_hash, submission_url}; plus, for every dimension, the shared quality floors {spam_score, score, confidence} AND the `instance_key` (so the hash itself differs per generation). A mismatch at claim time invalidates the approval; a change outside the dimension's set never does
t.boolean('money_action').notNullable();      // = (dimension = 'payment'); CHECK (money_action = (dimension = 'payment')) — same-row, so the money CHECKs below can see it; execution and communication approvals never carry payment terms
t.string('decision').notNullable();           // CHECK (decision IN ('approved','rejected','watch'))
t.string('authority').notNullable();          // CHECK (authority IN (the §6.1 OWNER_* levels EXCEPT OWNER_OVERRIDE/OWNER_MANUAL_PAYMENT/OWNER_INPUT_REQUIRED)) — the OWNER_* level being granted; a floor waiver is never an approval row (it has no dimension/action/instance — `seo_link_floor_waivers` is its only record)
t.integer('approved_amount_cents');           // the amount the owner approved; same-row CHECK (NOT (money_action AND decision = 'approved') OR (approved_amount_cents IS NOT NULL AND approved_amount_cents > 0)) — a paid APPROVAL without a ceiling cannot exist, while a `rejected`/`watch` decision on a payment card is an audit row with no approved terms: CHECK (decision = 'approved' OR (approved_amount_cents IS NULL AND max_payable_cents IS NULL)) (a CHECK cannot read the path row, hence the copied flag; the insert also verifies the copied flag equals the path's current value inside the approval transaction)
t.integer('max_payable_cents');               // IMMUTABLE absolute ceiling = approved_amount_cents + policy.owner_price_tolerance_cents AS OF APPROVAL; CHECK (NOT (money_action AND decision = 'approved') OR (max_payable_cents IS NOT NULL AND approved_amount_cents IS NOT NULL AND max_payable_cents >= approved_amount_cents)) — written NULL-safe because a CHECK whose expression is NULL passes; the final-total guard compares against THIS only — a later policy change never widens an existing approval
t.jsonb('terms_snapshot').notNullable();      // PER DIMENSION — exactly the fields of this approval's `decision_inputs_hash` set (§3.6b), nothing from another dimension: payment approvals snapshot estimated_cost_cents (the quoted initial amount), currency (always 'USD' — the approval insert refuses otherwise), renewal_period, renewal_cost_cents, payment_required, legal_attestation, legal_terms_hash (+ the agreement URL — the exact terms the owner read) and, for payment approvals, the COMPLETE canonical merchant_binding from the path (§3.2: checkout_origin, processor.host, processor.merchant_account_id, issuer_merchant_descriptor) the owner approved — a processor host alone never appears here; copied, never referenced
t.string('dimension').notNullable();          // CHECK (dimension IN ('execution','payment','communication')) — the authority dimension this approval satisfies
t.string('action').notNullable();             // CHECK (action IN ('acquire','purchase','renewal','outreach_send','outreach_followup')) AND CHECK ((dimension='execution' AND action='acquire') OR (dimension='payment' AND action IN ('purchase','renewal')) OR (dimension='communication' AND action IN ('outreach_send','outreach_followup'))) — an approval authorizes exactly one action in exactly one dimension; a paid membership has an execution/acquire approval AND a separate payment/purchase approval
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

`POST /api/admin/backlink-agent/opportunities/bulk`  (admin auth; also called internally)

Accepts raw text: domains, URLs, an X post URL, a competitor backlink URL, a pasted list,
CSV rows. Steps, all idempotent:

1. **Normalize** — extract hosts/URLs from the text; `canonicalProspectDomain()` for the host;
   keep the URL as a *submission_url hint*. **Resolvers run first** for URLs that are
   *references to* opportunities rather than opportunities: an X post URL (`x.com`/
   `twitter.com/<user>/status/<id>`) is resolved through the existing `backlink-agent/x-poller`
   URL extraction (tweet entities → expanded URLs) **with redirect expansion moved behind the
   SSRF-safe fetcher** — `x-poller.resolveUrl` today does a raw `fetch(redirect:'follow')`
   and is replaced by `contact-finder.fetchPage`'s pinned resolver (every hop validated
   against private/metadata ranges, hop count bounded, no body needed) as part of step 2 and each
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
`domain_id`/`path_id`. No claim-predicate change ships before this backfill has run; the
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
  so the baselines are real rows, not a flag: the placement is `seo_link_prospects`
  (`source='existing_backlink'`, `status='live'`, `live_url=source_url`,
  `backlink_id`, `first_live_at = seo_backlinks.first_seen`, `target_page` =
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
  `findPlacementRow`/`path_key`; excluded from acquisition (nothing to acquire) and from the
  Source×funnel *acquired* counts (reported separately as "existing").
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
  `price-scan/extract.parsePriceText()` (strict: a range, a percentage, a promo badge or an
  empty string parses to null; it does not validate currency, which is why the gate precedes
  it) → `Math.round(n * 100)` integer cents. `currency` (NOT NULL, CHECK IN ('USD','unknown','foreign') — the ONE enum, identical in the migration, the investigator JSON schema and the tests)
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
`OWNER_FREE` · `OWNER_ACCOUNT` · `OWNER_OUTREACH` · `OWNER_PAYMENT` · `OWNER_MANUAL_PAYMENT` (payment only ever outside the system) · `OWNER_MEMBERSHIP` · `OWNER_LEGAL` · `OWNER_HUMAN_STEP` · `OWNER_INPUT_REQUIRED` (payment dimension only: the path is otherwise valid but its price is unparseable or its currency is UNKNOWN (`currency='unknown'` — a bare `$` or no marker); a CONFIRMED non-USD quote (`currency='foreign'`) is NEVER routed here — it is `OWNER_MANUAL_PAYMENT`, because an owner entry cannot change a merchant's checkout currency — parked `awaiting_owner` with a PRICE-ENTRY card, never a purchase approval; the owner's entry writes `estimated_cost_cents`/`renewal_cost_cents` + `currency='USD'` (the owner attests the checkout is USD; the live-checkout currency check still runs before reservation and submit) on the path as an owner-sourced revision (bumps `revision_payment`, recorded as a `human` attempt `outcome='price_entered'`), after which the bridge re-decides normally — an entered price is an INPUT, never an approval) · `OWNER_OVERRIDE` (the audit label of a floor-waiver row in `seo_link_floor_waivers` only — never a dimension level and never an approval row, §6.3 1b) · `DENY` · `INVALID`

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
auto_submission_daily_cap    = 0         (form/profile submissions per ET day across ALL providers; a submission SLOT is reserved atomically inside the locked claim — a `seo_link_attempts` row with outcome='slot_reserved' for the ET day — and the cap counts slot_reserved + submitting + submit_ambiguous + completed submissions for that `slot_day` (in-flight and unresolved work holds its slot until a terminal, reconciled outcome; `slot_released` rows never count); re-checked before submit; 0 ⇒ no automated submissions)
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
`execution` (every non-outreach type: free/account/claim/membership/human-step — never
both communication and execution on one placement). A paid guest post therefore needs
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
if any of (account_required, email_verification, payment_required, legal_attestation, agent_completable) is not a literal boolean → INVALID
if flags inconsistent with acquisition_type (see §3.2) → INVALID
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

# 2a. EXECUTION dimension — only for non-outreach types
if path.acquisition_type not in OUTREACH_TYPES:
    execution =
        OWNER_HUMAN_STEP  if not path.agent_completable                                                   # a human must act; never AUTO_*
        else OWNER_LEGAL  if path.legal_attestation and policy.legal_attestation_requires_owner
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
                                    and d30_conf ≥ auto_paid_min_d30_confidence
                                    and (month_spend_cents + amount_cents) ≤ monthly_paid_budget_cents
        else OWNER_PAYMENT

# 2c. COMMUNICATION dimension — only for outreach/content types (guest posts / content always pass the outreach mandate)
if path.acquisition_type in OUTREACH_TYPES:
    communication =
        OWNER_LEGAL if path.legal_attestation and policy.legal_attestation_requires_owner                    # a signed agreement / vendor terms is never accepted under AUTO_OUTREACH; the owner's legal approval (action outreach_send) is the only send authority
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
unique key enforces, so a second GBP location is never suppressed by the first — runs the
§6.3 decision, stamps `authority` on the **placement**
(the path only receives the informational `authority_last_decided`, which does not bump its
revision — so approval never invalidates itself), and then **recomputes the registry aggregate across ALL of the domain's placements** (§3.1):
`ready_to_acquire` if any placement is authorized and pending; `acquiring`/`acquired` per the
aggregate rules; `rejected` ONLY when no placement is authorized, pending, awaiting the owner
or acquired (a single `DENY` beside an approved sibling never rejects the domain); `INVALID`
on every placement → back to `investigating`. Per-placement outcomes are stored on the
placement (`OWNER_*` → `awaiting_owner` + card — EXCEPT a communication dimension decided
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
honoured only for the exact failure the owner looked at) AND the dimension's own approval
must be valid as for any `OWNER_*` — so a row whose confidence dropped or whose domain's spam
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
t.string('purchase_kind').notNullable().defaultTo('initial'); // CHECK (purchase_kind IN ('initial','renewal')) — each renewal is its own separately authorized purchase
t.integer('generation').notNullable().defaultTo(1); // bumps only when the prior generation of the SAME kind/period ended voided / reconciled_not_charged
t.string('renewal_period_key');                     // for renewals: the period being bought, e.g. '2027' or '2026-11' — null for initial; CHECK ((purchase_kind = 'initial' AND renewal_period_key IS NULL) OR (purchase_kind = 'renewal' AND renewal_period_key ~ '^[0-9]{4}(-[0-9]{2})?$')) — a renewal can never carry a null/empty key, so idempotency keys, approvals and instance keys never collapse onto ':renewal:null:'
t.jsonb('terms_snapshot').notNullable();            // IMMUTABLE copy taken at reservation and re-confirmed at submitting from the checkout page: renewal_period, renewal_cost_cents, term_start (as displayed), term_end / paid_through (computed from term_start + renewal_period), auto_renew_disabled, legal terms shown — renewal scheduling reads ONLY this row, never the (mutable, supersedable) path
t.date('term_start'); t.date('paid_through');       // CALENDAR terms as `date` columns (the merchant states a day, not an instant) — parsed once from the checkout text into an ET calendar day via the datetime-et utilities; the renewal job compares with `etDateString(now)`, never with a UTC timestamp, so DST/midnight can't shift a renewal
t.string('idempotency_key').notNullable().unique(); // initial: `${prospect_id}:initial:${generation}` (path-INDEPENDENT — a placement is paid for once, whatever path it was moved to); renewal: `${prospect_id}:renewal:${renewal_period_key}:${generation}` — never month-scoped
t.integer('amount_cents').notNullable();            // reserved amount, integer cents (never decimal); CHECK (amount_cents > 0)
t.string('currency').notNullable();                 // the currency of amount_cents/final_cents — ALWAYS 'USD': CHECK (currency = 'USD'); automated rows copy it from the path at reservation (a reservation cannot exist in any other currency, and the pre-mint/pre-submit read verifies the live checkout currency against it); a manual settlement's amount_cents/final_cents = the USD amount actually settled on the owner's own statement/receipt (what budgets and cost reporting count)
t.string('original_currency'); t.integer('original_minor_units'); // FOREIGN MANUAL SETTLEMENTS ONLY (currency='foreign' paths): the merchant's currency (ISO 4217) and the charged amount in its minor units as shown on the receipt, for audit — CHECK ((original_currency IS NULL) = (original_minor_units IS NULL)) AND CHECK (original_currency IS NULL OR state = 'manual_charged'); never used for budgets, which read the USD settled amount only; no conversion is ever computed by the system — the owner enters both figures from the receipt
t.integer('final_cents');                           // the checkout's final total incl. tax/fees, read before submitting; CHECK (final_cents IS NULL OR final_cents >= 0)
t.string('authority').notNullable();                // CHECK (authority IN (the §6.1 enum))
t.string('authority_class').notNullable();          // CHECK (authority_class IN ('auto','owner')) — stamped at insert from `authority` (AUTO_PAID_WITHIN_POLICY ⇒ 'auto'; every OWNER_* and manual settlement ⇒ 'owner'); the §6.3 month_spend_cents query filters on it so the AUTO and OWNER budgets never mix
t.string('state').notNullable();                    // CHECK (state IN ('reserved','voided','submitting','close_pending','charged','ambiguous','reconciled_charged','reconciled_not_charged','manual_charged')) — the complete enum; the budget/duplicate guards enumerate exactly these, so no other value can ever exist. `manual_charged` = an owner-paid purchase (OWNER_MANUAL_PAYMENT or auto_renew_unavoidable) recorded by the human settlement: inserted terminal in one transaction with the `human` attempt under the `link_budget:<YYYY-MM>` advisory lock with the same `idempotency_key` (`${prospect_id}:initial:${generation}` / renewal key — a double-submitted form is a no-op) and the all-time open/settled DUPLICATE guard: the settlement is REFUSED (409) while the placement has ANY `reserved`/`submitting`/`close_pending`/`ambiguous` purchase (an automated purchase must be conclusively settled or voided first) or an already-settled purchase for the same kind/period — but it is NEVER refused by the budget: the money already left, so a completed settlement is always recorded (it counts toward the owner budget going forward) and any overage is reported as a `budget_overage` notification, not a rejection; for a `currency='foreign'` path the form requires the receipt's original currency + minor units AND the USD amount settled on the owner's statement (`original_currency`/`original_minor_units` + `amount_cents`), so a foreign charge enters the ledger truthfully instead of being mislabeled USD, with amount/final_cents, receipt as merchant_ref, terms_snapshot and paid_through — it counts in the owner budget, the duplicate guard and cost reporting, and the paid term is written from it, never from the attempt alone
                                                    // reserved → voided (pre-exposure only) | reserved → submitting → close_pending → charged | submitting → ambiguous → reconciled_charged | reconciled_not_charged
t.uuid('approval_id');                              // → seo_link_approvals (dimension='payment', action = 'purchase' for purchase_kind='initial', 'renewal' for 'renewal') when authority is OWNER_*; CHECK: required unless authority = AUTO_PAID_WITHIN_POLICY OR state = 'manual_charged' (a manual settlement records a payment the owner already made — the settlement form click IS the owner's act; no pre-payment approval row exists or is required)
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
```

- **Reserve before exposing credentials.** The decision in §6.3 does NOT read a sum of past
  attempts. It runs inside one transaction: `pg_advisory_xact_lock(hashtext('link_budget:<YYYY-MM>'))`
  → `month_spend_cents = COALESCE(SUM(COALESCE(final_cents, amount_cents)), 0) WHERE budget_month = <ET month> AND authority_class = <'auto' | 'owner', the class of the purchase being reserved> AND state IN (reserved, submitting, close_pending, charged, ambiguous, reconciled_charged, manual_charged)` (`authority_class` is a NOT NULL column on the purchase row, CHECK IN ('auto','owner'), stamped at reservation from the stamped payment authority — `AUTO_PAID_WITHIN_POLICY` ⇒ `auto`, every `OWNER_*` and `manual_charged` ⇒ `owner`; the canonical query and its regression test carry this predicate, so an owner-approved charge never consumes the AUTO budget nor vice versa) (the outer COALESCE matters: SUM over zero rows is NULL, and the first purchase of a month must compare against 0 — empty-ledger test required) — every state in which the card has been, or may be, used consumes budget; only `voided` and `reconciled_not_charged` release it
  → the budget compared is the one for the purchase's authority: `AUTO_PAID_WITHIN_POLICY`
  reserves against `monthly_paid_budget_cents` over AUTO purchases; `OWNER_*` purchases reserve
  against `owner_monthly_budget_cents` over owner-approved purchases (null ⇒ only the
  approval's `max_payable_cents` and the issuer program limit apply) — an owner approval is
  never blocked by the automatic-spend budget being 0
  → **open/settled-purchase check — all-time, per PLACEMENT, path-independent**: if ANY row
  for `(prospect_id, purchase_kind, renewal_period_key)` — any `path_id`, superseded or not —
  is in `reserved`, `submitting`, `close_pending`, `ambiguous`, `charged`,
  `reconciled_charged` or `manual_charged` → no new reservation (409) — a manually recorded
  initial purchase or renewal blocks a second one exactly like an automated charge
  (regression test: manual settlement, then a reservation attempt for the same
  placement/period ⇒ 409). Supersession (§3.2) carries settled
  purchases with the placement; it never frees a second `initial`. A placement that
  was paid for in March can never be paid for again as `initial` in April; only an explicit
  `renewal` for a *new* period can be reserved, and `claim()` never leases a placement with an
  open (`reserved`/`submitting`/`ambiguous`) purchase of any kind. Otherwise `generation` =
  1 + the highest ended generation (`voided` / `reconciled_not_charged`) for that key — both this lookup and the all-time open/settled duplicate check match `purchase_kind` and `renewal_period_key IS NOT DISTINCT FROM ?` (initial rows carry NULL; plain `=` would never find an initial purchase and would strand every retry at generation 1 — initial-purchase regression test required) → if `budget_cents = budgetFor(authority)` (`monthly_paid_budget_cents` for
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
  kill switch (`GATE_LINK_AUTHORITY` UNCONDITIONALLY — every automated mint/submit, owner-approved included, §§7/12; `GATE_LINK_PAYMENTS`; `GATE_LINK_AUTO_PAID` only for `AUTO_PAID_WITHIN_POLICY`) — any change since
  reservation ⇒ the row is `voided` (no card was ever minted) and re-parked. A gate flipped
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
  `outcome='no_payment_required'` BEFORE any mint (no card exists), the placement proceeds
  through the free-path steps (the worker completes the checkout without a card), and the
  investigator re-marks the path's `payment_required`/cost on its next pass. `final_cents=0`
  never enters `submitting`.
- **Final total is validated before `submitting`.** The provider must read the checkout's
  final total (price + tax + fees + renewal terms as displayed) and report it as
  `final_cents` — a safe non-negative integer, else the transition is refused — BEFORE the
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
  `submitting_at` nulled, attempt recorded `mint_not_started`) — no instrument ever existed,
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
  evidence and price, and creates a `purchase_kind='renewal'` reservation for that period
  under the same lock/budget/idempotency rules — or lets **that placement** lapse
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
  The paid term written on `charged`/`reconciled_charged` advances `renews_at`. A renewal never charges
  without its own reservation and, where the merchant does not support one-off renewal, its
  own reservation; there is no owner-approval exception for auto-renew-only merchants.
- **A reservation is charged against the month it is submitted in.** The
  `reserved → submitting` transition (under the budget lock) first compares the row's
  `budget_month` with the current ET month; if the month has rolled over since reservation,
  the row is `voided` and a `seo_link_attempts` row with `outcome='budget_month_rollover'` (enum member, §3.4) is written in the same transaction — the purchase row itself carries no outcome column. Because a voided purchase advances
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
  never substitute for it): `reconciled_charged` when a
  capture exists; `reconciled_not_charged` **only when (a) the issuer's full settlement/presentment
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
`status='contacted'`, `outreach_status='sent'` (as shipped), so a follow-up is modelled on
its own columns — `follow_up_due_at` (= sent + 10d), `follow_up_status`
(`none|due|drafted|sending|sent|send_error|skipped` — the same in-flight/ambiguous machine
as the first send: `sending` under the claim, `send_error` when Gmail may have accepted but
the response was lost, cleared only by the existing Sent-folder `reconcileSendError`
path, never retried before it), `follow_up_send_token` (its own idempotency claim, same
advisory-lock shape as the first send), `follow_up_attempted_at` (stamped at claim time under
the same lock exactly like `outreach_attempted_at`; the retained `dailySendCount` is extended
to count it — `(outreach_attempted_at >= since)::int + (follow_up_attempted_at >= since)::int +
prior attempts` — so a follow-up consumes the policy cap and the hard cap like an initial
send and initial + follow-up sends can never exceed the daily limit). A due follow-up is
**drafted before it can be sent**, exactly like the first message: `mode=draft` ALSO leases
`contacted` rows with `follow_up_status='due'` (draft-only, grants nothing beyond composing
the follow-up; `outcome='drafted'` flips `due → drafted` and stores the draft + its hash on
the placement), the draft passes `comms-lint` and the §6.4 classifier, and the bridge then
evaluates `AUTO_OUTREACH` on THAT draft or parks the placement for a `communication/outreach_followup`
approval whose `action_hash` binds it. Only then is it leased with
`claim(?type=outreach&mode=followup)`, whose predicate accepts `contacted` rows with
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
  CLAIM MODE — `prospect` for initial acquisition / `mode=draft` / the initial `mode=send`;
  `contacted`/`negotiating` for `mode=payment` and `mode=followup`; `placed`/`live`/`indexed`
  for `mode=renewal` (each mode's extra predicate is defined where the mode is) — the
  `prospect` restriction is never applied to the later-stage modes; registry
  `agent_state` in (`ready_to_acquire`, `acquiring`, `acquired`) — claimability is a
  placement property, so a second location's placement is leasable after the first was
  acquired; and — for every mode EXCEPT `mode=draft`, which is exempt from this authority
  clause by construction (the draft-lease bullet below defines its own predicate; every
  other clause and the bans on irreversible actions still apply to it) — the placement's
  stamped `authority` is an `AUTO_*` level
  **or** an `OWNER_*` level with a recorded approval row (a dimension decided under a floor
  waiver is leasable exactly as its underlying level would be — its `floor_waiver_id` waiver
  must still be valid, and a waiver never promotes the level) — except
  `OWNER_MANUAL_PAYMENT`, which is never leasable for any payment claim (no reservation, no
  mint: the owner pays outside the system and records the charge through the manual
  settlement form, which atomically inserts a `manual_charged` purchase row + a `human`
  attempt and only then writes the paid term; the placement's non-payment dimensions proceed
  normally), and
  `OWNER_HUMAN_STEP`, which is never leasable to an automated provider: its row stays
  `awaiting_owner` until a human completes the human part and records a **resume checkpoint**
  (a `human` attempt with `outcome='human_step_done'` + the resulting session/state), after
  which the investigator re-marks the remainder `agent_completable=true` and the bridge
  re-decides; the path's lane
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
  as the pre-mint check does, so a renewal that fills the remaining budget is not double-counted); and the provider identity — DERIVED SERVER-SIDE from the authenticated worker credential, never read from a query/body value (§12: one distinct service token per provider, `LINK_WORKER_TOKEN_<PROVIDER>`, resolved by `hermes-auth.js` to a fixed `{ provider, capabilities }` record; the legacy shared `HERMES_SERVICE_TOKEN` maps to the `hermes` provider with NO payment/credential capability) — carries the capability the step needs (payment and credential steps → the `deterministic_runner` identity only). A caller-supplied `provider` field is ignored (logged as a mismatch if it disagrees with the token). A row
  the policy has not authorized cannot be leased by any caller.
- **Draft leases are separate from send authority (no claim-before-draft deadlock).** The
  drafter (`backlink-outreach-drafter.js`) claims with `?type=outreach&mode=draft`: a draft
  lease requires only a `prospect` row on a `qualified`/`ready_to_acquire` domain in an
  outreach lane — OR, for the §6.4 follow-up lane, a `contacted` row with
  `outreach_status='sent'` and `follow_up_status='due'` whatever the domain's aggregate state
  (`acquiring`/`acquired` are normal there) — and grants NOTHING beyond research + composing
  a draft (report `outcome='drafted'`, never a send; for the follow-up lane it flips
  `due → drafted`). Send authority is decided afterwards: once the draft
  exists and passes `comms-lint` and the §6.4 classifier, the bridge job evaluates
  `AUTO_OUTREACH` on that draft; only a `mode=send` lease — which requires the stamped
  `AUTO_OUTREACH` (or an approval) — may call the sender. Drafting therefore never needs
  authority, and authority is never granted without a lint-clean draft to grant it for.
- **Paid outreach after the send: `claim(?mode=payment)`.** Once a paid outreach placement
  is `contacted`/`negotiating` and the publisher exposes a checkout, the payment step is
  leased through a payment-specific predicate keyed to the placement's open, unleased
  `initial` reservation — created ONLY at that moment (the runner/owner marks the placement
  `ready_for_payment` when the publisher exposes a checkout), never at bridge time, so a
  publisher who never replies holds no budget and no open-purchase guard; a pre-checkout
  reservation does not exist by construction:
  placement in (`contacted`, `negotiating`), communication dimension `satisfied_at` set,
  payment dimension authorized, no `submitting`/`ambiguous` purchase; the initial send is
  never claimable again through this mode. The `deterministic_runner` is the only eligible
  provider (payment boundary).
- **`pending` submissions are kept.** The shipped report path for a moderated directory
  (`outcome='placed'` with `pending:true` and no `live_url` — `link-prospect-worker.js`) is
  retained unchanged: the placement moves to `placed` without a `live_url`, the daily
  verifier's domain reconcile (`reconcileByDomain`) discovers the URL on approval, and the
  row is excluded from re-claim while `placed`. `live_url` is required only for a
  non-pending `placed` report, exactly as today.
- **`needs_owner` is a report OUTCOME, not a status.** The report route's outcome allowlist
  gains `needs_owner` (and `payment_ambiguous`, `ready_for_payment`, `ready_for_credentials`,
  `price_changed`, `captcha`); `ready_for_credentials` atomically sets the placement
  `status='ready_for_credentials'` (a §3.3 status; `parked_from_status` kept), releases the
  lease, and is reclaimed ONLY through `claim(?mode=credentials)` whose predicate accepts
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
phase** — `submit()`, and, for the deterministic runner alone, `createAccount()` and
`activateVerification()` (the verification link's GET is treated as mutating and allowed
only here) — each of which is entered only after the locked authority/approval/gate recheck,
a durable attempt row (`slot_reserved → submitting` for submit; `create_account`/`resume`
attempts with their own persisted `idempotency_key` `${prospect_id}:${action}:${generation}` (§3.4, partial UNIQUE) for the
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

Provider selection per attempt = `COALESCE(path.provider_override, policy.preferred_provider)`
for non-credentialed, non-payment steps only; **credentialed steps (account creation, email
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
  placements by canonical domain + target-page variants and moves them to `placed` with
  `live_url`/`backlink_id` (the verifier then promotes to `live`/`indexed`), so a publisher
  who posts the link without any worker report still lands in D30 and source reporting.
- **D30 survival** = a **sampled observation at the cutoff**, not an inference from
  neighbours: the daily verifier records an explicit `d30_sample` (and `d90_sample`) check
  for each placement within a bounded window `[cutoff, cutoff + 3 days]`; `d30_live=true`
  only if that sampled crawl/reconcile found the link active AND no `lost` event exists
  between `first_live_at` and the sample on the row's lineage — a `merged` event is NOT a
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
  coverage stay `null`). Stored on the placement (`d30_live`, `d90_live`, tri-state) — this is
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
`GATE_HERMES_WORKER` + `HERMES_SERVICE_TOKEN` (claim/report — from step 1 one of several per-provider tokens `LINK_WORKER_TOKEN_<PROVIDER>`; each resolves server-side to a fixed provider identity + capability set, and only the `deterministic_runner` token carries payment/credential capability), `GATE_SIGNUP_RUNNER` +
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
  fetch/XHR, websockets — is resolved before it is allowed and refused unless the scheme is
  http(s), the resolved IP (all A/AAAA answers, re-resolved per hop so DNS rebinding cannot
  swap it) is public unicast (no loopback, RFC1918, link-local, CGNAT, multicast, metadata
  169.254.169.254, sandbox-internal ranges) and the host is not on the deny list; a blocked
  request fails the step (`outcome='blocked'`, evidence recorded) rather than being silently
  dropped. The same interception layer carries the §12 mutating-request policy; a provider
  that cannot run under it (no CDP/route hook) is not eligible for live steps at all.
- **Comms** — outreach targets are businesses. Today `link-prospect-outreach` only validates
  recipient *syntax*; step 4 adds a **fail-closed customer-recipient exclusion** before any
  auto-send: the recipient email (and its domain, when the domain is a customer's own) is
  checked inside the send claim against every real contact source — `customers.email` plus
  **every** slot in `SERVICE_CONTACT_SLOTS` from `services/customer-contact.js` (today
  `service_contact_email`, `service_contact2_email`, `service_contact3_email`; the lookup is
  BUILT from that export so a new slot is covered automatically), and `leads.email` — the check runs
  inside EVERY send claim — auto-send, owner-approved send, follow-up — not only before an
  auto-send: an identified customer recipient is a **hard block** (`skipped`,
  `reason='customer_recipient'`, row parked with the reason; no approval can send it), while a
  lookup error/timeout or an ambiguous match (name-only, shared business domain) routes the
  draft to the approval queue with the match shown. Unit-tested per slot (slot 3 included)
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
  `${prospect_id}:${action}:${generation}`) is never violated and the instance-bound approval
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
  one conversation per inbox
  (`claimProspectDomain`); signup lanes coexist per location by design; no templated blasts.
- **ToS / CAPTCHA** — a CAPTCHA or explicit-consent step is `outcome='captcha'` →
  `awaiting_owner` (never solved by an agent); paid-link-only "sponsored" slots are stored
  with `expected_rel='sponsored'` and scored accordingly.
- **Money** — single-use per-purchase virtual cards with an issuer-enforced ceiling; PAN/CVV
  handled only by the local payment broker, never by a model-observed provider; every charge
  is a ledger row + attempt; owner approval is a portal click.
- **Truth** — a provider report is a claim; the Judge promotes; `merged`/`lost` semantics
  from #3544 apply to everything acquired.

---

## 14. Build order (PR boundaries)

1. **Registry + paths + provenance + statuses** — migrations for §3.1–3.5, `awaiting_owner`/
   `watching`, `domain_id/path_id/authority` on prospects, intake endpoint skeleton
   (normalize/dedupe/upsert only); `seo_signup_attempts` backfill + atomic `recordAttempt`
   cutover to `seo_link_attempts` (§3.4). Docs-tested with contract tests on the guard.
2. **Bulk intake** — paste box + CSV import + competitor-gap ingestion job + existing-profile
   baseline. `Backlinks.csv` enters here as `list_import` / `backlinks_csv_2026_08`.
3. **Path investigator** — job + schema-validated LLM call + probe list + cost caps;
   `GATE_LINK_INVESTIGATOR`. Run it over the full gap ingestion; ship the Registry view.
4. **Authority policy** — `seo_link_policy`, decision function + tests, owner cards,
   Policy panel; `GATE_LINK_AUTHORITY`; the post-scan inbound cross-link for outreach
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
