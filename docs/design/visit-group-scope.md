# Visit groups — one stop, two services, one message, one payment

**Date:** 2026-08-29 (rev 3 + live-UI pass, same day) · **Status:** scope for owner sign-off. **Not approved
to build.** No code changes in this doc.
**Branch:** `docs/visit-group-scope` (worktree `~/wt-visit-group`, off main `571ed7be8`).
**Scope page:** https://claude.ai/code/artifact/5c963058-a2ff-469f-be99-96150178b8c2 ·
**Screen renders:** https://claude.ai/code/artifact/351e2b0b-b25b-41da-b28e-e500b85fe905 (9 screens — tech route card, Complete Visit sheet, rodent exceptions, accepted; customer texts, visit page self-pay / partial + older balance / paid; dispatch card).

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
service_visits
  id                 uuid pk
  customer_id        uuid → customers
  property_id        uuid → customer_properties (nullable, mirrors rows)
  scheduled_date     date
  window_start       time      ← intended stop (rev 2): same tech twice in a day ≠ one visit
  technician_id      uuid → technicians (nullable until dispatch)
  status             text CHECK: open | closing | closed | dissolved
  closed_at · close_reason   (all_resolved | operator | row_cancelled …)
  summary_token      text unique   — customer visit-summary page (§5)
  completion_sms_status / completion_message_id / completion_email_id
  review_request_id / autopay_status / payment_intent_id
  created_by         converter | seeder | admin:<id> | dispatch
  created_at / updated_at

visit_completion_packets                       ← rev 2 (§3)
  id · visit_id · idempotency_key unique · payload jsonb · status
  (accepted | processing | done | failed) · child_results jsonb · error · timestamps

scheduled_services
  + visit_id  uuid → service_visits (nullable, indexed)

service_records.structured_notes
  completionSmsStatus += 'covered_by_visit' · visitMessageId   ← never 'sent' on a child
```

Rules:
- A group is **only ever created explicitly**: converter same-trip seeding, the recurring
  seeder landing a row on a date+window where the customer already has an open groupable row
  at the same property, or an admin action. Same-customer-same-date is never inferred.
- `visit_id` is the identity. A new row may **join** an open visit only when all hold:
  same customer · same property · same scheduled date · same or overlapping window / intended
  route stop · compatible technician (null joins; a conflicting assignment splits) · both
  service types flagged **groupable** in the catalog (`services.groupable`, default true for
  recurring residential programs, false for one-time projects, inspections, and anything the
  owner marks). Admins can group compatible rows or split one out regardless.
- One open row is not a group — it auto-dissolves and behaves exactly as today. Cancel/skip
  leaves the group; the last remaining row dissolves it.
- Reschedule (R3): moving one grouped row moves the group through the #3562 collective-move
  choke point (`series_moves` with a `visit_group` scope); "just this service" splits it.
  Auto-dispatch / route-tier moves treat the group as one unit.
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
2. Persists a `visit_completion_packets` row and returns **202 accepted**. The tech is back
   on the route. Retries with the same key return the same packet.
3. A worker processes children in server-controlled order by calling the per-row completion
   logic — which requires **extracting the `/complete` handler body into a callable
   service** (`server/services/dispatch-complete.js`), with the route becoming a thin
   wrapper. Each child call carries a derived key (`<packet>:<rowId>`) so the existing
   idempotency claim (`admin-dispatch.js:5236`) makes per-child replay safe. Report, PDF,
   invoice mint, record: unchanged.
4. When every child is terminal the visit closes (§4). A child failure marks the packet
   `failed` with `child_results`, retries with backoff, and after exhaustion parks an admin
   bell ("Visit closeout needs attention") — the visit stays `closing`, no customer message
   goes out, and the tech is never asked to re-enter data.

Why 202 + worker rather than one transaction: the per-row completion already spans ~12
nested transactions plus Stripe, PDF, and SMS side effects; it cannot be made atomic, so the
honest guarantee is *packet accepted exactly once, children processed exactly once each*.

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

**Outcomes per service section (rev 2, #5)** — `not_required` removed:

| Outcome | Record | Invoice | Report | Follow-up | Visit message | Closes visit |
|---|---|---|---|---|---|---|
| `completed` → sheet **Completed** | yes | yes (full) | full | no | "complete" | yes |
| `partially_completed` → sheet **Follow-up needed** — **derived** from section data (8 of 10 stations inspected, 2 marked inaccessible ⇒ partial; the tech never picks the status separately) | yes | yes (full unless office adjusts — R4 open) | full, exceptions listed | yes — inaccessible items → follow-up row via existing incomplete-visit seeding | "completed, but we couldn't access all …" + next steps | yes |
| `unable_to_complete` → sheet **Incomplete** (reason required) | yes, marked incomplete | **no** (existing incomplete path) | brief, reason | yes — reschedule | "we couldn't perform …, we'll contact you" | yes |
| `customer_declined` → sheet **Customer declined** | yes, declined note | no | omitted | no (office bell) | omitted from message | yes |
| `cancelled_by_office` | no | no (void if minted) | none | office decides | omitted | yes (row leaves group) |

---

## 4. Customer comms — the visit is the source of truth

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
3. One review request, subject to the existing customer caps (fixes today's auto-path
   double-ask as a side effect).
4. Stamps `service_visits.completion_*` and each child's `covered_by_visit`.

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
| Appointment reminders (72h/24h, confirm link) | per row | once per visit; `dedupeKey` gains `visit_id`; appointment page lists both services | `appointment-reminders.js:192` |
| En-route / tracker SMS | per row | once per visit | `track-transitions.js` |
| Completion SMS / email | per row | once per visit (above) | `admin-dispatch.js:11911-12395` |
| Payment request | in completion SMS | in the summary page only | §5 |
| Payment receipt | **one per invoice** on combined pay | one visit receipt (new `visit_receipt` email; per-invoice receipts suppressed under a visit PI) | `pay-combined.js:8, :883` |
| Payment failure | per PI | once per visit payment attempt | `stripe-webhook.js:788` |
| Late-payment reminder | account-level clock (#3575), names every open invoice | one reminder referencing the **visit balance** ("August 29 visit · $173"), never two invoice lines read as two bills | `invoice-followups.js:1616` |
| Collections call / Sandy task | one per customer account | one account task; Sandy's script names the visit, not the child invoices | `collections-*` (#3575) |
| Review request | per record (auto path uncapped) | at most once per visit, customer caps apply | `review-request.js:515-526` |

---

## 5. Customer visit-summary page — ships with the message

`/visit/:token` + `GET /api/public/visit/:token`, token = `service_visits.summary_token`, same
header posture as `/report/:token` (noindex, no-referrer, no-store), same rate-limit shape as
`reports-public.js`. **Activation is a conjunction (rev 3):** grouped completion comms run only
when `GATE_VISIT_GROUPS` **and** `GATE_VISIT_SUMMARY_PAGE` are both on (a conjunction accessor
in `feature-gates.js`, like `isPrepayCardAndChargeEnabled`); with the page gate off, grouped
visits still close but fall back to per-row completion texts — never a multi-link SMS.

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
OTHER ACCOUNT BALANCE (only when present)
  Previous balance         $128.00   [Pay full balance of $301]
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
primary button: *Pay $173* can never silently become $301. An older balance renders as a
separate block with its own *Pay full balance* action (that path may use the existing combined
sibling selection). Mint, ledger, void-on-cancel, dunning, and Sandy's account-level language
are untouched. Copy says "today's charges / today's total", never "invoice".

**Receipts.** One visit receipt per successful visit payment; the per-invoice receipts the
combined settle enqueues today (`:883`) are suppressed when the PI carries a `visit_id`.
Ledger rows and invoice `receipt_url`s stay per invoice.

**Autopay (rev 2).** Grouped autopay customers are **not parked for office review as the
normal path**. Release rule (R7): visit groups are created only for self-pay customers until
grouped autopay ships; the group closer then finalises both invoices, charges one PaymentIntent
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
| **1 — model + grouping** | `service_visits` + `visit_completion_packets` migrations, converter stamp, seeder join rule (self-pay only), admin group/split, collective-move scope, grouped route card, en-route/on-site fan-out, reminder dedupe | `GATE_VISIT_GROUPS` — **stays off** until Phase 2 is merged; creates no groups | — |
| **2 — one packet, one message, one page** | `/complete` body extracted to `dispatch-complete.js`; visit-complete endpoint + packet worker; exception-driven CompletionPanel; `visit-close.js`; `visit_complete*` templates; single review ask; `/visit/:token` page + visit-scoped payment + visit receipt; **portal billing history grouped by visit**; late-payment/collections copy names the visit; stuck-visit sweep | `GATE_VISIT_GROUPS` + `GATE_VISIT_SUMMARY_PAGE` (conjunction = launch) | 1 |
| **3 — grouped autopay** | closer charge via visit allocation, receipts, failure notice, `autopay_log` codes; seeder join rule extends to autopay customers | `GATE_VISIT_GROUP_AUTOPAY` | 2 |
| later | retire `COMBINED_SERVICE_ROUTES` + combo catalog rows **only after Phase 3** (summary, self-pay, and grouped autopay at parity — retiring earlier would push autopay combo customers from one automatic charge into office review); combined visit PDF only if customers ask | — | 3 |

Phase 2 is several PRs (extraction · endpoint+worker · panel · close+templates · page+payment)
but one gate: the launch is the moment closeout, close, page, SMS, email, and payment all work
together. Contract tests per PR: packet idempotency, child-order + failure parking, outcome
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
Phase 1 (model + grouping, gate off, cheap) so groups start being stamped as bundles are sold;
hold Phase 2 until future multi-row days reach ~10 per 120d or the owner GOes on sales direction.

---

## 9. Rulings (owner rev-2 positions recorded; open items marked)

| # | Question | Position |
|---|---|---|
| R1 | Group identity | explicit `visit_id`; auto-join needs same property + date + overlapping window/stop + compatible tech + groupable types — **ruled (rev 3)** |
| R2 | Billing | two internal invoices for v1; portal groups them visually by visit; payment visit-scoped; never say "invoice" — **ruled** |
| R3 | Rescheduling one grouped row | group moves as a unit; "just this service" splits — **open** |
| R4 | Section outcomes | table in §3 — **ruled**; the per-outcome billing column (does `partially_completed` bill in full?) is **open** |
| R5 | SMS shape | one link, short copy per §4 — **ruled** |
| R6 | Summary page greets by name? | no name on page; first name in SMS only — **open** |
| R7 | Autopay rollout | self-pay only until grouped autopay ships — **ruled** |
| R8 | Retire combined routes + combo rows | only after summary + self-pay + grouped autopay reach parity (after Phase 3) — **ruled (rev 3)** |
| R9 | Build blockers | one packet endpoint · page + message same gate · visit-scoped payment — **ruled** |

## 10. Explicitly out of scope

One parent invoice; any change to report content, companion sections, or completion profiles;
same-day inference at completion; tech-facing hold/skip toggle; historical backfill; combined
visit PDF; a "Download all reports" bundle.
