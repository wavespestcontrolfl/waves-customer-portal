# Visit groups — one stop, two services, one message, one payment

**Date:** 2026-08-29 (rev 5) · **Status:** **APPROVED TO BUILD** (owner, 08-29 evening: rev-5 review
findings adopted as recommendations, R3/R4/R6 ruled by adopting them, no shadow phase). No code
changes in this doc.
**Branch:** `docs/visit-group-scope` (worktree `~/wt-visit-group`, off main `571ed7be8`).
**Scope page:** https://claude.ai/code/artifact/5c963058-a2ff-469f-be99-96150178b8c2 ·
**Screen renders:** https://claude.ai/code/artifact/351e2b0b-b25b-41da-b28e-e500b85fe905 (9 screens — tech route card, Complete Visit sheet, rodent exceptions, accepted; customer texts, visit page self-pay / partial + older balance / paid; dispatch card).

**Rev 5 changes (owner's second review, all adopted):** (1) gates stop *new* groups and never
change an existing visit's behaviour (`behavior_version`, `communication_mode`); (2) "exactly once"
replaced by dedup-by-key + at-least-once children + a durable `visit_effects` outbox for every
external action; (3) one outcome string split into `execution_status` · `service_mode` ·
`follow_up_required` · `customer_concern` · `billing_disposition`, R4 ruled (partial ⇒
`hold_for_review`, never exposed or auto-charged until disposed); (4) dissolution only while the
visit is untouched — after any reminder/route event/packet/report/invoice/link/payment the visit is
preserved even with one child; (5) schema carries window end, route-stop key, lifecycle timestamps,
a family-based compatibility policy, and an open-visit uniqueness rule under a lock; (6) the visit
owns the technician — reassigning one row is an explicit *Split* action; (7) arrival/times/backdate/
time-on-site/access/overall note/shared photos are visit-level; (8) review ask needs a real
customer cap + visit dedupe + eligibility rule; (9) the account, not the visit, owns dunning and
collections; (10) all comms go through the effects ledger; (11) the public page shows this visit
only — other balances route to the authenticated portal; token stored hashed + revocable; (12)
payment mode re-read at close, `billing_strategy` chosen then, never two charges; (13) packet items
normalised into `visit_completion_packet_items`, `202` returns `packet_id`.

**Product promise (owner, rev 2):** *One stop. One route card. One closeout. Two service
reports. One summary link. One payment.* Not necessarily one literal invoice record.

**Rev 2 changes (owner review of rev 1):** (1) the phone sends ONE visit-completion packet,
not one `/complete` per row; (2) the closeout is exception-driven, not two stacked forms;
(3) the summary page and the one-message release ship behind the same gate; (4) payment is
visit-scoped, never the first invoice's generic pay link; (5) group key includes the intended
stop/window, outcomes gain `partially_completed` / `customer_declined` / `cancelled_by_office`
and lose `not_required`, each outcome has a defined billing/report/comms/close effect; (6) the
visit is the source of truth for every comms rail — children are `covered_by_visit`, and the
pre-launch audit covers reminders, tracking, receipts, failures, dunning, review. Autopay
customers are not grouped until grouped autopay ships.

**Rev 3 changes (owner verdict memo):** activation is a gate **conjunction** (groups AND
summary page); `partially_completed` is **derived** from section data (8 of 10 stations ⇒
partial, no separate status pick); join criteria add *same or overlapping window* and
*explicitly groupable service types*; the comms audit adds late-payment reminders and
collections tasks; the **customer portal billing history groups invoices by visit** (new
surface, Phase 2); R8 retires the combined routes only after grouped autopay parity
(Phase 3), not after Phase 2. Rev 3 renders added: the collapsed pre-Finish review and the
portal history.

**Live-UI pass (08-29, mobile, every completion lane rendered in dev):** the completion sheet
is already de-pilled (#3516) and collapses optional findings (#3536). Real vocabulary the
grouped sheet must reuse: uppercase 11px eyebrows; 48px/12px-radius inputs; `Select...`
dropdowns; `Select one or more...` multi-selects; `− — +` steppers (stations, traps,
captures); a **More detail (optional) ▸** collapsed block per lane; outline pills only for
actions (Generate AI report · Trace where we sprayed / Outline the treated lawn · Add photos);
black pill footer. **Visit Outcome options today:** `Completed · Inspection only · Customer
declined · Follow-up needed · Customer concern · Incomplete` — the outcome table in §3 maps
onto these instead of inventing new strings. The sheet already carries per-visit toggles
**"Send completion SMS to customer"** and **"Review request suppressed"** plus Backdated
closeout / Time on site / Re-entry countdown / Next scheduled visit; under a group the two
comms toggles move to the visit level (office-only), the rest stay per service. The
`lawn_tree_shrub_combo` lane already renders a second **"TREE & SHRUB SERVICE"** section under
the lawn primary — the companion-section pattern the grouped sheet extends. Project lanes
(one-time pest, WDO, pre-treat certificate) open a different "Complete Service Report" form
and are **not groupable** (`services.groupable = false`).

---

## 0. What exists today — verified against `origin/main` @ 571ed7be8

Every customer-facing and money-moving rail is keyed on a **single `scheduled_services`
row**. There is no visit/stop/group concept anywhere in the schema (exhaustive
`createTable` scan of all 1,273 migrations; `visit_group|visitGroup|stop_group` has zero
hits in `server/` and `client/`).

| Rail | Keyed on | Anchor | Consequence for two rows |
|---|---|---|---|
| Completion handler | one row; already claims an `Idempotency-Key` per call | `server/routes/admin-dispatch.js:4293` `POST /:serviceId/complete` (one function to :12872; idempotency claim `:5236`; ~12 nested transactions + Stripe/PDF/SMS side effects — **not** one atomic transaction) | tech completes twice |
| Service record + report + PDF | one record per row | `:7137` service_record insert · `:9878-9887` report token/URL · `:10001` PDF job | two reports — **wanted** |
| Invoice mint | advisory lock `['schedule.invoice.mint', svc.id]` | `server/services/scheduled-invoice-mint.js:40-56`; FK `invoices.scheduled_service_id` (`20260420000002`) | two invoices |
| Invoice lines | primary + `scheduled_service_addons` | `server/services/invoice.js:539-658` | n/a (add-ons are the *other* multi-service model — §1) |
| Completion SMS | per row; `service_complete*` templates | render `:11911-12041` · send `:12118` · `service_records.structured_notes.completionSmsStatus` (`sending/deferred/blocked/failed/sent`, `:12076-12323`) | **two texts** |
| Completion email | idempotency key derived from service_record | `server/services/service-report/email-delivery.js:177-185` | two emails |
| Review request | dedupe per `service_record_id`; per-customer caps on the **manual** path only | `server/services/review-request.js:515-526` | **auto path can double-ask today** |
| Autopay at completion | per invoice; refuses when no single accepted per-visit amount | `admin-dispatch.js:11086-11102`, charge `:11171` | two charges, or two office-review parks |
| Combined pay page | any open self-pay invoices, one PaymentIntent, per-invoice allocation; **each invoice keeps its own receipt** | `server/services/pay-combined.js:1-41` (`:8`); gate `payIncludeBalance` = `GATE_PAY_INCLUDE_BALANCE` (`feature-gates.js:251`); cap 8 `:55` | one payment works; may pull in unrelated invoices; N receipts |
| Appointment reminders | per row (`dedupeKey` + `scheduled_service_id`) | `server/services/appointment-reminders.js:192,764` | two reminder texts |
| Tech route + tracker | one card per row; `en_route → on_site` per row; tracker SMS via `track-transitions.js` | `client/src/pages/tech/TechHomePage.jsx:13-24`, `:192`; `server/routes/tech-track.js:305`, `:461` | two En Route taps, two "on the way" texts |
| Dunning | account-level clock per customer (#3575) | `server/services/invoice-followups.js:1616-1629` | already deduped across invoices |
| Customer appointment page | per row (`reschedule_token`) | `/api/public/appointment/:token` (AGENTS.md ~L1057) | two confirm links |

**Grouping precedents** (none is a visit group, each is a shape to copy): `recurring_parent_id`
(series), `parent_service_id` (callback child, `20260401000106:13`), `series_moves` + the
collective-move choke point (#3562, `20260828000030`), `visit_billing_dispositions`
(`20260619000001:27-30`), and the "distinct visit dates, not rows" collapse in
`server/services/review-reply/grounding.js:194-200`.

**Scheduling already knows "same trip".** At estimate accept the converter seeds standalone
supplement rows (the rodent bait row) onto the reserved pest slot — same date, window, tech,
zone — `server/services/estimate-converter.js:4578-4597` (`sameTrip`). That is where the
group id is stamped: grouping is *declared at scheduling*, never inferred.

**History that bounds this lane.** 06-12 combined completions shipped
(`docs/design/combined-service-completions.md`) — ONE row "Pest & Rodent Control", companion
section, one report. 07-04/12 owner retired `pest_rodent_quarterly` and the pest+rodent
auto-combine (`20260712600000_retire_pest_rodent_combined.js`; `estimate-converter.js:247-251`);
rodent bait schedules as its own row (`STANDALONE_SUPPLEMENT_ROUTES`, `:321-327`). 08-28 owner
on the remaining combo rows: "I want to remove all of these" (ruling pending). This lane
completes that direction — it never recombines pest and rodent into one scheduled service.

---

## 1. Why a row-level group and not `scheduled_service_addons`

The codebase already has a "multiple services in one stop" model: one row plus add-on lines
(`20260602000002_addon_duration.js:1-9`; invoice lines built primary + add-ons). It is the
smaller change and **cannot meet the requirement**: one row = one service_record = one report,
one completion profile, one cadence. Rodent bait as an add-on has no station findings, no
rodent report, no rodent history, no independent quarterly series. The June companion-section
mechanism fixes the findings half but still yields one report and forces matched cadences —
exactly what was retired.

So the group lives **above** rows: each service keeps its row, record, report, invoice, and
cadence; the group carries the shared things — the stop, the closeout, the customer message,
the payment experience. Add-ons remain the model for true line items on one service; a grouped
row may still carry them.

---

## 2. Data model

```
service_visits                                  ← rev 5 shape
  id                 uuid pk
  customer_id        uuid → customers
  property_id        uuid → customer_properties (nullable, mirrors rows)
  scheduled_date     date
  window_start       time
  window_end         time
  stop_base_key      text  NOT NULL   — `<property_id>:<date>:<window_start>` (or the dispatch
                                        stop id once routed); the identity of "one physical stop"
  stop_seq           int   NOT NULL DEFAULT 1 — a split creates seq 2, 3 … under the same lock
  route_stop_key     text  GENERATED = stop_base_key || ':' || stop_seq
  technician_id      uuid → technicians (nullable until dispatch; the VISIT owns assignment,
                                        children inherit — §2 rule 6)
  group_family       text   — recurring_property_service | lawn_tree_shrub | pest_rodent …
  status             text CHECK: open | closing | closed | dissolved
  behavior_version   int    NOT NULL DEFAULT 1   — frozen at creation; gates never rewrite it
  communication_mode text   NOT NULL DEFAULT 'grouped'
  billing_strategy   text   — chosen at CLOSE, not at creation: self_pay_visit_page |
                              grouped_autopay (Phase 3) | office_review
  billing_hold       bool   — true while any child is hold_for_review (§3)
  en_route_at · arrived_at · completion_submitted_at · closed_at · close_reason
                     (all_resolved | operator | row_cancelled | legacy_completion …)
  summary_token_hash text unique   — sha256 of the 64-hex bearer (§5). Minted at LINK ISSUE
                                     (visit close, or office "Reissue link"), not at creation:
                                     the raw token exists only inside the outgoing message /
                                     the office's reissue response; the hash is written in the
                                     same transaction that claims the completion effect
  summary_token_issued_at · summary_token_revoked_at
  summary_token_enc     bytea — the raw bearer encrypted at rest (AES-256-GCM, key =
                                `VISIT_TOKEN_KEK` env, same pattern as stored card/ACH secrets)
                                so a retried or crashed link-bearing effect (SMS, email,
                                reissue) can render the URL; NULLed once every link-bearing
                                effect is terminal. Lookups always go through the hash.
  review_request_id · payment_intent_id
  created_by         converter | seeder | admin:<id> | dispatch
  created_at / updated_at

  UNIQUE INDEX (stop_base_key, stop_seq)            — across ALL lifecycle states, not partial
  — creation, auto-join and split all run under advisory lock `['visit.stop', stop_base_key]`:
    auto-join looks up OPEN visits for the base key and joins the lowest seq that satisfies
    the join rules; creation and split allocate `max(seq)+1` over every historical row for
    that base, in one transaction, so `route_stop_key` is an immutable identity for the life
    of the row and a late scheduler or retry can never re-mint a closed/dissolved visit's key. Nullable technician_id is NOT part of the identity (NULLs don't collide
    in a unique index).

visit_effects                                   ← rev 5: ONE durable outbox for every external
  id · visit_id · effect_type                      action, replacing per-column comms state
     (reminder_72h | reminder_24h | tracker_en_route | tracker_arrived | completion_sms |
      completion_email | review_ask | visit_payment | visit_receipt | payment_failure)
  dedupe_key · status (pending | claimed | sent | failed | suppressed | unknown_delivery) ·
  provider_id
  (Twilio SID / SendGrid id / Stripe PI id) · attempts · scheduled_at · sent_at ·
  payload_version · last_error
  UNIQUE (visit_id, effect_type, dedupe_key)
  — handoff rule (rev 5b): the worker CLAIMS the row (status `claimed`, `claimed_at`) in its
    own committed transaction BEFORE any provider call. Stripe effects pass `dedupe_key` as
    `Idempotency-Key` (true provider dedupe). Email effects pass it as
    `email_messages.idempotency_key`, which `email-delivery.js:177-185` already treats as an
    at-most-once ledger. SMS has no provider dedupe: the send writes the `sms_log` row with
    the dedupe key first, then calls Twilio, then stores `twilio_sid`. On retry, a row found
    `claimed` with no `provider_id` is **never re-sent** — it is marked `unknown_delivery`
    and parks an admin bell ("visit message may not have reached the customer — resend?").
    Customer-facing messages are therefore **at-most-once**; only money (Stripe) is
    retried-to-success. A lost text costs one office click; a duplicate text is impossible.

visit_completion_packets                       ← rev 2 (§3), normalised rev 5
  id · visit_id · idempotency_key unique · request_hash (sha256 over visit_id + canonical
  payload) · payload jsonb (immutable, as submitted) · status (accepted | processing | done |
  failed) · error · timestamps

visit_completion_packet_items                   ← rev 5
  packet_id · scheduled_service_id · derived_idempotency_key · status (pending | processing |
  done | failed) · attempt_count · started_at · completed_at · service_record_id · invoice_id ·
  last_error
  UNIQUE (packet_id, scheduled_service_id)
  — per-child claims, retry counts, admin repair and "one child stuck while the other is done"
    all read from here; `202` returns `packet_id` and the phone clears its local draft only
    after receiving it.
  — same key + same request_hash ⇒ return the existing packet (202/200 replay); same key +
  different hash (other visit or changed payload) ⇒ **409 idempotency_conflict**, nothing
  stored — the request-hash rule the per-row `/complete` claim already enforces
  (`admin-dispatch.js:5236`), so a stale key on a fresh visit can never look accepted.

scheduled_services
  + visit_id  uuid → service_visits (nullable, indexed)

service_records.structured_notes
  completionSmsStatus += 'covered_by_visit' · visitMessageId   ← never 'sent' on a child

services
  + groupable   bool  (default true recurring residential programs)
  + group_family text — two rows join only when families are compatible (policy table in
                        code, not a boolean product): pest_rodent × pest_rodent,
                        recurring_property_service × recurring_property_service …
```

Rules:
- A group is **only ever created explicitly**: converter same-trip seeding, the recurring
  seeder landing a row on a date+window where the customer already has an open groupable row
  at the same property, or an admin action. Same-customer-same-date is never inferred.
- `visit_id` is the identity. A new row may **join** an open visit only when all hold:
  same customer · same property · same scheduled date · same or overlapping window / intended
  route stop (`route_stop_key`) · technician null or equal to the visit's · both service
  types **groupable** with **compatible `group_family`** (§2 schema). Admins can group
  compatible rows or split one out regardless.
- **Dissolution (rev 5).** A visit may dissolve to a plain row ONLY while all hold: `status =
  open` · no `visit_effects` row sent or claimed (no reminder, no tracker) · `en_route_at`
  and `arrived_at` null · no packet accepted · no service record / invoice / report on any
  child · no summary link issued · no payment attempt. After any of those, the visit is
  preserved even when one child remains — it becomes a historical one-service visit with the
  same token, message and payment path. Cancel/split of a child is **rejected (409)** while a
  packet for the visit is `accepted`/`processing`.
- **Membership freeze (rev 5d).** Split and Separate are allowed only while the visit is
  `open` AND no child has a service record, invoice, report, or payment attempt AND no
  summary link has been issued AND no packet is accepted/processing. Reminder/tracker effects
  having been sent do NOT block a split (both resulting visits are preserved, each keeps its
  own history and the customer simply gets the later messages per visit). After any record /
  invoice / link / payment, membership is **frozen**: a child can be cancelled or marked
  `cancelled_by_office` in place (row leaves the group logically, visit preserved) but never
  moved to another visit — there is no transfer protocol in this lane.
- **Technician (rev 5, item 6).** The visit owns `technician_id`; child rows inherit it on
  dispatch and on every row-level edit. Changing the tech on ONE row is not allowed silently —
  the admin gets *Split this service into a separate visit and assign another technician*,
  an explicit action subject to the membership freeze above. Auto-dispatch assigns at the
  visit level.
- Reschedule (R3, **ruled rev 5**): moving one grouped row moves the group through the #3562
  collective-move choke point (`series_moves` with a `visit_group` scope); "just this
  service" is the explicit split action above. Auto-dispatch / route-tier moves treat the
  group as one unit.
- Migrations in `server/models/migrations/`, idempotent, reversible, no backfill. No new
  `scheduled_services` status strings.

---

## 3. Tech experience — one stop, one packet

**Route card.** "123 Main St · 2 services · ~55 min", services listed; duration = sum of the
rows' `estimated_duration_minutes`. `[En Route] [Arrived] [Complete Visit]`. Same grouped card
on the dispatch board (`DispatchPageV2.jsx:342`), rows as sections in the JobDrawer.

**En Route / Arrived once.** `/en-route` and `/on-site` fan out to every row in one
transaction (each row's CAS still runs); the tracker "on the way" SMS is a visit one-shot.

**One completion request (rev 2, build blocker #1).**
`POST /api/tech/service-visits/:visitId/complete` (admin mirror under `/api/admin/dispatch`)
with one payload: shared visit details, one section per child with its outcome and findings,
one `Idempotency-Key`. The server:
1. Validates the packet shape and every child section **synchronously** (typed findings,
   chips, required-when rules — the same validators `/complete` runs, so the tech sees a
   422 naming the section while still on the screen).
2. Persists a `visit_completion_packets` row + one `visit_completion_packet_items` row per
   child and returns **202 accepted `{ packet_id }`**. The tech is back on the route; the app
   clears its local draft only once `packet_id` arrives. Retries with the same key + same
   request hash return the same packet.
3. A worker processes children in server-controlled order by calling the per-row completion
   logic — which requires **extracting the `/complete` handler body into a callable
   service** (`server/services/dispatch-complete.js`), with the route becoming a thin
   wrapper. Each child call carries a derived key (`<packet>:<rowId>`) so the existing
   idempotency claim (`admin-dispatch.js:5236`) makes per-child replay safe. Report, PDF,
   invoice mint, record: unchanged.
4. When every child item is terminal the visit closes (§4). A child failure marks its item
   `failed` (attempt_count, last_error), retries with backoff, and after exhaustion parks an admin
   bell ("Visit closeout needs attention") — the visit stays `closing`, no customer message
   goes out, and the tech is never asked to re-enter data.

Why 202 + worker rather than one transaction: the per-row completion already spans ~12
nested transactions plus Stripe, PDF, and SMS side effects; it cannot be made atomic. **The
guarantee (rev 5):** *the packet is deduplicated by its idempotency key; child processing is
at-least-once with idempotent effects that produce an effectively-once customer and accounting
result.* Every external action (SMS, email, review ask, Stripe charge, receipt) is a
`visit_effects` row with its own durable dedupe key used as the provider idempotency key, so a
crash between "SMS sent" and "row marked sent" retries into the provider's dedupe, not into a
second text. The advisory lock orders workers; the ledger makes retries safe.

**Exception-driven closeout (rev 2, #2).** Not two stacked forms:
- Shared block once: access, overall visit note, shared photos. Each photo carries a tag set
  — *Overall visit / Quarterly Pest Control / Rodent Bait Stations* — uploaded once, attached
  to each tagged service record.
- Each service starts **collapsed** with its routine preset first — *Routine service
  completed* / *All stations inspected — no exceptions* — then *Record findings or
  exceptions* expands the existing typed section for that row's completion profile.
- **Preload facts, never claims.** Rodent preloads station count, names/locations, prior
  inaccessible stations, prior activity, last bait condition (from the previous
  `rodent_bait_station` snapshot and `service_activity_scores`). The tech still confirms.
- Required unanswered items are highlighted; completed sections collapse; sticky *Finish
  Visit*; drafts autosave per child (existing completion-draft mechanism) and survive app
  close or signal loss.
- Speed standard for a routine paired visit: the second service adds one confirmation tap
  plus any real exceptions — no second arrival, lookup, note, photo, navigation, or closeout.

**No tech-side messaging controls.** The office keeps one exception action: *Separate these
services into different visits*.

**Field levels (rev 5, item 7).** Visit-level, entered once: arrival · start/finish time ·
backdated closeout timestamp · total time on site · access · overall note · shared photos.
Service-level: findings · materials · areas treated · station results · service-specific
recommendations · next scheduled service · re-entry restriction. Labour per service record
is a **default split from planned durations** (manual adjust optional) — never two
time-on-site entries for one stop. Re-entry: the summary page shows the **most restrictive**
instruction; each report keeps its own.

**Outcome model per service section (rev 5, item 3)** — one sheet pick used to carry three
questions; they are now separate fields on the section (and on the service record):

```
execution_status   completed | partially_completed (DERIVED from section data, never picked)
                   | unable_to_complete | customer_declined | cancelled_by_office
service_mode       treatment | inspection_only            (sheet "Inspection only")
follow_up_required bool + reason + recommended_due_date   (sheet "Follow-up needed")
customer_concern   bool + note                            (sheet "Customer concern")
billing_disposition full | adjusted | waived | hold_for_review
```

Sheet vocabulary stays: *Completed · Inspection only · Customer declined · Follow-up needed ·
Customer concern · Incomplete* map onto the fields above (Incomplete ⇒ `unable_to_complete`;
Follow-up needed ⇒ `follow_up_required=true` on whatever execution status the data derives).

| execution_status | Record | Invoice / billing_disposition (R4 **ruled**) | Report | Follow-up | Visit message | Closes visit |
|---|---|---|---|---|---|---|
| `completed` | yes | yes · `full` | full | only if `follow_up_required` | "complete" | yes |
| `partially_completed` (derived: e.g. 8 of 10 stations inspected) | yes | minted but **`hold_for_review`**: not shown on the visit page, not auto-charged, `service_visits.billing_hold=true`; office disposes full / adjusted / waived from the closeout-needs-attention bell, then the page + message update | full, exceptions listed | yes (inaccessible items → follow-up row via existing incomplete-visit seeding) | "completed, but we couldn't access all …; we'll confirm today's charges" | yes |
| `unable_to_complete` (reason required) | yes, marked incomplete | **no** (existing incomplete path) | brief, reason | yes — reschedule | "we couldn't perform …, we'll contact you" | yes |
| `customer_declined` | yes, declined note | no | omitted | no (office bell) | omitted from message | yes |
| `cancelled_by_office` | no | no (void if minted) | none | office decides | omitted | yes (row leaves group; visit preserved per §2) |

R4 ruling (rev 5): "full unless the office adjusts" created a race (page shows $173, customer
pays, office reduces later) — so a partial service **never bills before disposition**. Grouped
autopay (Phase 3) must not charge while `billing_hold` is true.

---

## 4. Customer comms — the visit owns the appointment; the account owns the money owed

**Ownership (rev 5, item 9).** The visit is the source of truth for: appointment reminders,
tracker, completion SMS/email, reports, review ask, and the **visit** payment/receipt. The
**account** (#3575) stays the source of truth for dunning and collections — a customer with
an August 29 visit ($173), an August 3 one-time service ($199) and a July invoice ($128) gets
ONE account reminder that groups charges by visit, and Sandy gets one account task.

When a child completes under a packet, `/complete` **never sends**: SMS, email, and review
enrollment are suppressed and the record is stamped `completionSmsStatus = 'covered_by_visit'`
+ `visitMessageId` once the visit sends (dispatch badges treat `covered_by_visit` as delivered;
analytics count one message). Report, PDF, invoice, record unchanged.

**Visit close** — `server/services/visit-close.js`, advisory lock on `visit_id`, invoked by
the packet worker after the last child and by any sibling transition that resolves the group.
Closes only when every child is terminal; then:
1. One SMS from a new DB template family `visit_complete` / `visit_complete_partial` /
   `visit_complete_prepaid`, vars `first_name`, `service_count`, `visit_url` (schemeless
   portal short link, 08-01 rule). **One link only.** Quiet-hours deferral reuses
   `dispatch-completion-deferred.js` at the visit level.
2. One email (`visit_summary`) with a button per report and the charges block.
3. One review request — **eligibility (rev 5, item 8):** every customer-visible child
   `execution_status = completed` AND no `customer_concern` AND no `follow_up_required` AND no
   `billing_hold` AND a **new customer-level automatic cap** permits (today the caps are
   manual-only, `review-request.js:515-526`; the grouped path adds a real per-customer
   window) AND no prior `visit_effects(review_ask)` for this visit. Anchored by
   `review_requests.visit_id` (new nullable column; `service_record_id` stays for per-row asks).
4. All four are `visit_effects` rows; marks child records `covered_by_visit` +
   `visitMessageId` once the completion effect is `sent`.

Copy (owner, rev 2):
- Two services: *Hi James, today's 2 services are complete. View both reports, today's
  charges, and next steps: {short_link}*
- One service (dissolved group — existing template untouched).
- Partial: *Hi James, today's pest-control service was completed, but we couldn't access all
  rodent stations. View the report and next steps: {short_link}*

**Stuck visits.** Nightly sweep lists visits `open`/`closing` after the visit date with a
completed child → admin bell with *Close & send* / *Separate*. Never composes or sends.

**Pre-launch comms audit — every rail, once per visit (rev 2, #6):**

| Rail | Today | Grouped rule | Where |
|---|---|---|---|
| Appointment reminders (72h/24h, confirm link) | per row | once per visit via `visit_effects(reminder_72h/24h)`; appointment page lists both services | `appointment-reminders.js:192` |
| En-route / tracker SMS | per row | once per visit via `visit_effects(tracker_*)` | `track-transitions.js` |
| Completion SMS / email | per row | once per visit (above) | `admin-dispatch.js:11911-12395` |
| Payment request | in completion SMS | in the summary page only | §5 |
| Payment receipt | **one per invoice** on combined pay | one visit receipt (new `visit_receipt` email; per-invoice receipts suppressed under a visit PI) | `pay-combined.js:8, :883` |
| Payment failure | per PI | once per visit payment attempt | `stripe-webhook.js:788` |
| Late-payment reminder | account-level clock (#3575), names every open invoice | **stays account-level**: one reminder with the account balance, lines grouped by visit ("August 29 visit · $173 / August 3 service · $199 / Previous balance · $128") — never two invoice lines read as two bills | `invoice-followups.js:1616` |
| Collections call / Sandy task | one per customer account | unchanged: one account task; Sandy's script groups by visit | `collections-*` (#3575) |
| Review request | per record (auto path uncapped) | at most once per visit, real customer cap + eligibility rule above | `review-request.js:515-526` |

---

## 5. Customer visit-summary page — ships with the message

`/visit/:token` + `GET /api/public/visit/:token`, token = the 64-hex bearer whose sha256 is
`service_visits.summary_token_hash` (minted when the link is issued — §2).

**Bearer-token contract (rev 4 — security-critical, mirrors `pay-statement.js`).** The route
family exposes reports, today's charges, a receipt and a payment write with no auth, so the
token *is* the credential:
- The token = 32 bytes from `crypto.randomBytes` encoded as **64 hex chars**, generated when
  the link is issued (close / reissue), stored only as its sha256 (`UNIQUE`), never derived
  from ids or dates, never logged. Reissue rotates the hash; the old link becomes a 404.
- Format gate `^[0-9a-f]{64}$` runs **before any DB access**; malformed and unknown tokens both
  return a generic **404** (no distinguishing body/status), exactly like
  `loadStatementByToken`. A dissolved or cancelled visit is also a 404.
- **No gate check on token resolution** — `GATE_VISIT_GROUPS` is a *creation* gate only
  (§5 Gates). Before any visit exists the route is unreachable in practice (every token is a
  404); once links are issued they resolve regardless of the gate's current value. Router-wide
  per-IP limiter (60/min, same shape as `statementPayLimiter`), plus a tighter limiter on the
  payment POSTs, applied after the format gate.
- Privacy headers on every GET/POST outcome including errors: `X-Robots-Tag: noindex`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store` (same posture as `/report/:token`).
- The page shows no customer name, email, phone, or full address (R6 **ruled rev 5**: no
  name; street only, as on the report page) — the link is forwardable by design.
- **Scope of what the token unlocks (rev 5, item 11):** services, reports, charges and
  payment status **of this visit only**. Other account balances are never itemised here: the
  page shows *"An additional balance is on your account"* with a link into the authenticated
  customer portal (Billing tab), which already has combined pay. No *Pay full balance* on the
  public page.
- Token stored as `summary_token_hash` (sha256), revocable (`summary_token_revoked_at` ⇒ 404,
  office action *Reissue link*), excluded from analytics URLs, permanent otherwise.
- Build blocker: the family `/api/public/visit/:token` (+ `/pay`, `/pay/quote`, `/pay/finalize`,
  `/receipt`) is **added to the public-by-token allowlist in `AGENTS.md`** in the same PR that
  introduces the route (new public routes outside that list are P0).

**Gates (rev 5, item 1 — replaces the rev-3/4 conjunction + fallback).** One master gate,
`GATE_VISIT_GROUPS`, is **one coordinated activation**: it is flipped on only when the grouping,
packet, close, page, SMS, email and payment PRs are all deployed (the page route itself is
served whenever a visit exists — it is not separately gated, so an issued link can never die).
Rules:
- Gate **off** ⇒ **no new groups are created** (converter, seeder, admin all stamp nothing).
- **Existing visits keep the behaviour they were created under** (`behavior_version`,
  `communication_mode = grouped`): the grouped route card, packet endpoint, close, message and
  page keep working for them. An active group **never** falls back to per-row texts.
- Issued `/visit/:token` links keep working after any gate change.
- Emergency: if the grouped closer cannot complete (worker failure, provider outage), the
  visit parks in `closing` with an admin bell — it never emits per-row messages as a fallback.
- The legacy per-row `/complete` **refuses** any row with a non-null `visit_id` whose visit
  is not `dissolved` — `open`, `closing` and `closed` alike (409 *"complete this visit from
  the visit sheet"*), checked under the row's existing idempotency claim so it cannot race
  the packet worker. The only way back to per-row completion is the admin's *Separate these
  services* action, which dissolves/splits atomically and only while §2's dissolution
  conditions hold (never while a packet is accepted/processing). A visit is therefore never
  closed twice and never speaks twice.

**Portal billing history (rev 3, new surface).** The customer portal Billing tab
(`client/src/pages/PortalPage.jsx` `BillingTab` :5105, Payment History card) groups invoices
by `visit_id`: one row *"August 29 visit · 2 services · Paid · $173"* with *View visit* /
*View receipt*; the two invoice numbers appear only inside the expanded details. Ungrouped
invoices render exactly as today. Same rule on the Invoices link card (:13037).

```
TODAY'S VISIT · AUGUST 29
Quarterly Pest Control            Completed                 [View report]
Rodent Bait Stations              10 expected · 8 inspected · 2 inaccessible   [View report]
TODAY'S CHARGES
  Quarterly Pest Control   $128.00
  Rodent Bait Stations      $45.00
  Today's total            $173.00
[Pay $173]                                       after payment: Paid · $173 · [View receipt]
(only when present) An additional balance is on your account · [Open your portal]
```

Permanent link: later visits to it show both reports, payment status, receipt, and follow-up
status for any partial/unable service. Report links are the rows' existing `/report/:token`
URLs — nothing about the reports changes. Glass-UI tokens. No customer name on the page (R6).

---

## 6. Billing — visit-scoped payment, two internal invoices

**v1: two internal invoices, one customer payment, visit-scoped (rev 2, #4 — build blocker).**
`POST /api/public/visit/:token/pay` selects **exactly the invoice ids belonging to the
visit** and reuses the combined-PI machinery (`buildAllocation`/`encodeAllocation`
`pay-combined.js:270-300`, `verifyAllocationLocked` `:339`, `settleCombinedPaymentIntent`
`:788`). The generic balance-inclusion behaviour (`payIncludeBalance`) is **not** used for the
primary button: *Pay $173* can never silently become $301. An older balance is only
*announced* on the public page and paid from the authenticated portal (rev 5, item 11). Mint, ledger, void-on-cancel, dunning, and Sandy's account-level language
are untouched. Copy says "today's charges / today's total", never "invoice".

**Surcharge seam (rev 4 — money-critical).** The visit token cannot reach the invoice-token
`/update-amount`, `/quote`, `/finalize` routes, so the visit surface ships its **own** equivalent
seams, modelled on `pay-statement.js:148-166`: `POST /api/public/visit/:token/pay` (create the
combined PI with the locked allocation), `POST …/pay/quote` (surcharge quote for the chosen
payment method), `POST …/pay/finalize` (re-verify the allocation with `verifyAllocationLocked`,
then apply the surcharge and confirm). The displayed total, the PI amount, the PI metadata and
the payment-row surcharge are all derived from **one** `computeChargeAmount(..., { funding })`
result per finalize; nothing recomputes independently. **Billing-hold enforcement (rev 5c):**
`/pay`, `/pay/quote`, `/pay/finalize` and the webhook settle all run under the visit advisory
lock and **refuse (409 `visit_billing_hold`)** unless `service_visits.billing_hold = false`
AND every selected child has a terminal billable `billing_disposition` (`full` | `adjusted`;
`waived` invoices are excluded from the allocation, `hold_for_review` blocks the whole
visit) — the check is inside `verifyAllocationLocked` for visit PIs, not only in the UI, so a
direct POST can never charge an undisposed amount. Disposition changes after a PI exists
invalidate the locked allocation (the existing update-amount degrade path). Card funding is never charged base-only,
and the PI amount always equals what the ledger records (AGENTS.md surcharge / PI-agreement
rules). ACH/bank funding takes the no-surcharge branch of the same call. The kill-switch sweep
in `pay-combined.js:703` applies to visit PIs unchanged.

**Receipts.** One visit receipt per successful visit payment; the per-invoice receipts the
combined settle enqueues today (`:883`) are suppressed when the PI carries a `visit_id`.
Ledger rows and invoice `receipt_url`s stay per invoice.

**Autopay (rev 2, hardened rev 5 item 12).** Grouping is **independent of payment mode**;
`billing_strategy` is chosen at CLOSE by re-reading the customer's current payment mode. Rules:
child invoices under a `visit_id` are **never autocharged individually** (the per-row autopay
closer skips them). Before Phase 3, a visit whose customer is on autopay at close takes the
safe path: **suppress autocharge, send the visit payment page** (`billing_strategy =
self_pay_visit_page`, `autopay_log` code `visit_autopay_deferred`), plus an office bell — never
a split after the tech used the grouped sheet, never two charges. Seeder still prefers self-pay
customers for auto-join until Phase 3 (R7), but enrolment changes after scheduling are handled
by the close-time rule, not by dissolving the visit. Once Phase 3 ships; the group closer then finalises both invoices, charges one PaymentIntent
with the saved card, allocates across both invoices, sends one receipt, one failure notice.
`autopay_log` codes `visit_charge_success` / `visit_charge_failed`. Office review remains the
fallback only for exceptions (cap unresolved, card unusable) — never the steady state.

**Not in this lane:** one parent invoice with two service lines. Only if commercial accounts
or accounting genuinely require it.

---

## 7. Phases and gates

| Phase | Ships | Gate | Depends on |
|---|---|---|---|
| **0 — sizing + rulings** | prod count (§8), R1–R9 | — | owner |
| **1 — model + grouping** | `service_visits` + `visit_effects` + packets/items migrations, `services.groupable/group_family`, converter stamp, seeder join rule, admin group/split (explicit tech split), collective-move scope, grouped route card, en-route/on-site fan-out, reminder/tracker effects | `GATE_VISIT_GROUPS` **off** — no groups exist, so nothing observable; no shadow phase (owner, rev 5) | — |
| **2 — one packet, one message, one page** | `/complete` body extracted to `dispatch-complete.js`; visit-complete endpoint + packet worker; exception-driven CompletionPanel with outcome fields; `visit-close.js` over the effects ledger; `visit_complete*` templates; review eligibility + cap; `/visit/:token` page (visit-only) + visit-scoped pay/quote/finalize + visit receipt; billing_hold disposition bell; **portal billing history grouped by visit**; account reminders grouped by visit; stuck-visit sweep | `GATE_VISIT_GROUPS` = one coordinated activation after the last Phase-2 PR deploys | 1 |
| **3 — grouped autopay** | closer charge via visit allocation, receipts, failure notice, `autopay_log` codes; seeder join rule extends to autopay customers | `GATE_VISIT_GROUP_AUTOPAY` | 2 |
| later | retire `COMBINED_SERVICE_ROUTES` + combo catalog rows **only after Phase 3** (summary, self-pay, and grouped autopay at parity — retiring earlier would push autopay combo customers from one automatic charge into office review); combined visit PDF only if customers ask | — | 3 |

Phase 2 is several PRs (extraction · endpoint+worker · panel · close+templates · page+payment)
but one gate: the launch is the moment closeout, close, page, SMS, email, and payment all work
together. Phase 1 and 2 are built back-to-back now (owner, rev 5) — no shadow/measurement
phase; the sizing (§8) is recorded for the record, not as a gate. Contract tests per PR: packet idempotency, child-order + failure parking, outcome
table effects, close rule, template presence, visit-scoped allocation, receipt suppression,
comms-audit rails.

---

## 8. Sizing — prod read Adam runs

Classifier blocks prod reads from the session. `~/visit-pairs-2026-08-29.js` (read-only): open
same-date pairs next 120d, share of same tech + window, top service pairs, completed same-day
pairs last 90d.

```
! cd ~ && export DATABASE_PUBLIC_URL="$(railway variables -s Postgres --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).DATABASE_PUBLIC_URL))')" && NODE_PATH=~/wt-body-images/node_modules node ~/visit-pairs-2026-08-29.js
```

**Result (prod, run by owner 2026-08-29):**

| read | value |
|---|---|
| Future multi-row days, next 120d | **2 days · 4 rows · 2 customers** (2 same tech, 1 same window) |
| Past multi-row days, all completed, last 180d | **10 days · 10 customers** (~1 every 18 days) |
| Top future pair | Every 6 Weeks Lawn Care × Quarterly Pest (1) — no pest × rodent pair on the calendar yet |
| Completed same-day pairs last 90d | 6, of which **1** had both rows invoiced |

**Reading:** at today's volume a visit group would fire roughly **once every 2–3 weeks**, and the
motivating pair (quarterly pest + rodent bait) does not yet appear — rodent bait only became its
own row on 07-12 and the calendar has not caught up. The 6→1 both-invoiced gap says most
same-day pairs are already being billed as one line or comped, i.e. the "two invoices, one
payment" problem is currently small in count but real when it occurs. Phase-2's largest cost
(extracting the 8,580-line `/complete` body into a service) is a fixed cost that does not shrink
with volume; the value case rests on the sales direction (rodent bait as an add-on row, combo-row
retirement per 08-28 ruling) rather than on current calendar counts. Recommendation: build
Phase 1 first. **Owner decision (rev 5): build Phases 1 and 2 now, no shadow phase** — the
sales direction (rodent bait / termite bait-station rows alongside quarterly pest, combo-row
retirement) is the volume driver, and the first real paired stop is already on the calendar.

---

## 9. Rulings (owner rev-2 positions recorded; open items marked)

| # | Question | Position |
|---|---|---|
| R1 | Group identity | explicit `visit_id`; auto-join needs same property + date + overlapping window/stop + compatible tech + groupable types — **ruled (rev 3)** |
| R2 | Billing | two internal invoices for v1; portal groups them visually by visit; payment visit-scoped; never say "invoice" — **ruled** |
| R3 | Rescheduling one grouped row | group moves as a unit; "just this service" = explicit split action — **ruled (rev 5)** |
| R4 | Section outcomes + billing | fields split (execution / mode / follow-up / concern / billing_disposition); `partially_completed` ⇒ `hold_for_review`, never exposed or auto-charged before office disposition — **ruled (rev 5)** |
| R5 | SMS shape | one link, short copy per §4 — **ruled** |
| R6 | Summary page greets by name? | no name on page; first name in SMS only — **ruled (rev 5)** |
| R7 | Autopay rollout | self-pay only until grouped autopay ships — **ruled** |
| R8 | Retire combined routes + combo rows | only after summary + self-pay + grouped autopay reach parity (after Phase 3) — **ruled (rev 3)** |
| R9 | Build blockers | one packet endpoint · page + message one activation · visit-scoped payment — **ruled** |
| R10 | Rev-5 review (13 items) | all adopted as written in this doc — **ruled (owner, 08-29)** |

## 10. Explicitly out of scope

One parent invoice; any change to report content, companion sections, or completion profiles;
same-day inference at completion; tech-facing hold/skip toggle; historical backfill; combined
visit PDF; a "Download all reports" bundle.
