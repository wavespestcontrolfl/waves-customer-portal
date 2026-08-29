# Visit groups — one stop, two services, one message, one payment

**Date:** 2026-08-29 · **Status:** scope for owner sign-off. No code changes in this doc.
**Branch:** `docs/visit-group-scope` (worktree `~/wt-visit-group`, off main `571ed7be8`).

**Direction (owner, 2026-08-29):** when two services are scheduled at one property for the
same stop — the worked example is Quarterly Pest Control + Rodent Bait Stations — the
customer gets **two service reports, one text, one payment**, and the tech works **one
stop**. Internally every service keeps its own record. This is Option B from the 08-28
discussion, restructured as an explicit *visit group* rather than a same-day sibling
heuristic with a tech-side "hold text" toggle (both rejected in the owner's memo).

---

## 0. What exists today — verified against `origin/main` @ 571ed7be8

Every customer-facing and money-moving rail is keyed on a **single `scheduled_services`
row**. There is no visit/stop/group concept anywhere in the schema (exhaustive
`createTable` scan of all 1,273 migrations; `visit_group|visitGroup|stop_group` has zero
hits in `server/` and `client/`).

| Rail | Keyed on | Anchor | Consequence for two rows |
|---|---|---|---|
| Completion handler | one row | `server/routes/admin-dispatch.js:4293` `POST /:serviceId/complete` (one function, runs to :12872) | tech completes twice |
| Service record + report + PDF | one record per row | `:7137` service_record insert · `:9878-9887` report token/URL · `:10001` PDF job | two reports — **wanted** |
| Invoice mint | advisory lock `['schedule.invoice.mint', svc.id]` | `server/services/scheduled-invoice-mint.js:40-56`; FK `invoices.scheduled_service_id` (`20260420000002`) | two invoices |
| Invoice lines | primary + `scheduled_service_addons` | `server/services/invoice.js:539-658` | n/a (add-ons are the *other* multi-service model — see §1) |
| Completion SMS | per row; `service_complete*` templates | render `:11911-12041` · send `:12118` · state machine `service_records.structured_notes.completionSmsStatus` (`sending/deferred/blocked/failed/sent`, `:12076-12323`) | **two texts** |
| Completion email | idempotency key derived from service_record | `server/services/service-report/email-delivery.js:177-185` | two emails |
| Review request | dedupe per `service_record_id`; per-customer caps apply on the **manual** path only | `server/services/review-request.js:515-526` | **auto path can double-ask today** |
| Autopay at completion | per invoice; refuses when no single accepted per-visit amount | `admin-dispatch.js:11086-11102` (`acceptedPerVisit == null → office review`), charge `:11171` | two charges, or two office-review parks |
| Combined pay page | any open self-pay invoices, one PaymentIntent, per-invoice allocation in PI metadata | `server/services/pay-combined.js:1-41`; gate `payIncludeBalance` = `GATE_PAY_INCLUDE_BALANCE` (`server/config/feature-gates.js:251`); cap 8 siblings `:55` | **one payment already works** (gate must be on in prod — verify) |
| Tech route | one card per row; `en_route → on_site` per row | `client/src/pages/tech/TechHomePage.jsx:13-24`, `:192`; `server/routes/tech-track.js:305` en-route, `:461` on-site; tracker SMS via `server/services/track-transitions.js` | two En Route taps, two "on the way" texts |
| Customer appointment page | per row (`reschedule_token`) | `/api/public/appointment/:token` (AGENTS.md ~L1057) | two confirm links |

**Grouping precedents that already exist** (none is a visit group, but each is a shape to copy):
`recurring_parent_id` (series), `parent_service_id` (callback child, `20260401000106:13`),
`series_moves` + the collective-move choke point (#3562, `20260828000030`),
`visit_billing_dispositions` (FK → scheduled_services, `20260619000001:27-30`), and the
"distinct visit dates, not rows" collapse in `server/services/review-reply/grounding.js:194-200`.

**Scheduling already knows "same trip".** At estimate accept the converter seeds standalone
supplement rows (e.g. the rodent bait row) onto the reserved pest slot — same date, window,
tech, zone — `server/services/estimate-converter.js:4578-4597` (`sameTrip`). That is the
natural place to stamp a group id, so grouping is *declared at scheduling*, never inferred.

**History that bounds this lane.**
- 2026-06-12: combined completions shipped (`docs/design/combined-service-completions.md`) —
  ONE row named "Pest & Rodent Control" with a rodent companion section, one report.
- 2026-07-04/12: owner retired `pest_rodent_quarterly` and the pest+rodent auto-combine
  (`20260712600000_retire_pest_rodent_combined.js`; converter comment
  `estimate-converter.js:247-251`). Rodent bait now schedules as its own row
  (`STANDALONE_SUPPLEMENT_ROUTES`, `:321-327`).
- 2026-08-28: owner on the remaining combo rows (`lawn_tree_shrub_combo`,
  `pest_termite_bait_quarterly`): "I want to remove all of these" — ruling pending, with
  "then combos schedule as separate visits, same trip" as the recommended follow-through.

This lane is the follow-through: **separate rows, same trip, grouped.** It does not reverse
the July decision; it completes it.

---

## 1. Why a row-level group and not `scheduled_service_addons`

The codebase already has a "multiple services in one stop" model: one row plus add-on lines
(`20260602000002_addon_duration.js:1-9` — lines share the row's tech/route stop; invoice lines
are built primary + add-ons). Using it here would be the smaller change **but it cannot meet
the requirement**: one row = one service_record = one report, one completion profile, one
cadence. Rodent bait as an add-on line has no findings section of its own (stations, activity,
consumption), no rodent report, no rodent service history, and no independent quarterly
series. The June combined-service mechanism (companion sections) solves the findings half but
still yields one report and forces matched cadences, which is exactly what the owner retired.

So the group lives **above** rows: each service keeps its row, record, report, invoice, and
cadence; the group carries the *shared* things — the stop, the closeout, the customer message,
the payment experience. Add-ons remain the model for true line items on one service
(e.g. an interior treatment on the pest visit). Both coexist; a grouped row may still carry
add-ons.

---

## 2. Data model

New table **`service_visits`** (the group) + one nullable FK on `scheduled_services`.

```
service_visits
  id                 uuid pk
  customer_id        uuid → customers
  property_id        uuid → customer_properties (nullable, mirrors rows)
  scheduled_date     date
  technician_id      uuid → technicians (nullable; assignment may lag)
  status             text CHECK: open | closed | dissolved
  closed_at          timestamptz
  close_reason       text  (all_resolved | operator | row_cancelled …)
  summary_token      text unique  (customer visit-summary page, §5)
  comms              jsonb  { completionSmsStatus, completionSmsAt, emailStatus,
                              reviewRequestId, autopayStatus … }  — group-level one-shots
  created_by         text  (converter | seeder | admin:<id> | dispatch)
  created_at / updated_at

scheduled_services
  + visit_id  uuid → service_visits (nullable, indexed)
```

Rules:
- A group is **only ever created explicitly** — by the converter's same-trip seeding, by the
  recurring seeder when it lands a row on a date where the customer already has an open
  grouped/groupable row at the same property, or by an admin action. Same-customer-same-date
  is never a runtime inference (the memo's objection stands: multi-property customers,
  two techs, AM visit + PM callback, a rescheduled row that happens to share a date).
- Group key = **customer + property + scheduled_date + technician** (technician may be null
  until dispatch; assigning a tech to one row assigns the group).
- A group with one open row is not a group — it auto-dissolves (rows keep working exactly as
  today). Cancelling/skipping a row leaves the group; the last remaining row dissolves it.
- `status` is derived from rows and materialized only at close; the close rule is in §4.
- Migration: `server/models/migrations/2026MMDD…_service_visits.js`, idempotent guards,
  reversible `down` (drop FK column, drop table). **No backfill** of historical rows —
  deploy-forward, like every recent lane. Status strings on `scheduled_services` are untouched
  (the CHECK-constraint P0 does not apply).

Reschedule policy (owner ruling R3): moving one grouped row **moves the group** by default
through the collective-move choke point from #3562 (`series_moves` recorded with a
`visit_group` scope), with a "just this service" override that splits the row out of the
group. Auto-dispatch / route-tier moves operate on the group as one unit.

---

## 3. Tech experience — one stop

- **Route card.** `GET /api/admin/schedule` day view returns rows; the server adds `visitId`
  and the client renders one card per group: "123 Main St · 2 services · ~55 min" with the
  service names listed. Duration = sum of the rows' `estimated_duration_minutes` (already the
  per-row whole-visit total; `admin-schedule.js:3691` sums the same way for windows).
  Admin dispatch (`DispatchPageV2.jsx:342 ServiceCardV2`) gets the same grouped card;
  the JobDrawer shows the rows as sections.
- **En Route / Arrived once.** `POST /api/tech/services/:id/en-route` and `/on-site` fan out
  to every row in the group inside one transaction (each row's CAS still runs — a row that
  cannot transition reports back, the others proceed). The tracker "on the way" SMS is a
  group-level one-shot: `track-transitions.js` fires for the first row only; sibling rows
  carry `track_state` for the board but suppress the send. Deliberately **not** the
  reverse (one row en-route, others pending): dispatch and the customer tracker must agree.
- **One completion wizard, per-service sections.** The `CompletionPanel`
  (`SchedulePage.jsx:9401`, mobile + desktop variants) opens for the group: a shared header
  (property access, general note, overall photos) then one section per row, each rendering
  exactly what that row's completion profile renders today (typed findings, chips, gauge,
  materials, recommendations). Draft autosave is keyed per row, so nothing is lost if the
  tech leaves the sheet.
- **Finish Visit** submits the rows in order to the existing `/complete` handler — one call
  per row, sequenced by the client, each carrying `visitId` and a `visitClose: true|false`
  flag on the last call. The handler is 8,580 lines; this keeps validation, report build,
  invoice mint, and PDF exactly as they are and adds only comms suppression (§4).
  Per-section outcomes: `completed`, `unable_to_complete` (reason required; the existing
  incomplete-visit path and follow-up seeding handle it), `not_required`. A whole-group
  reschedule is the existing route-shift modal (`TechHomePage.jsx:1275-1378`) acting on the
  group.
- **No tech-side messaging controls.** Whether the customer gets one text is decided by
  `visit_id`, not by the tech. The office keeps a single exception action: *Separate these
  services into different visits* (splits the group).

---

## 4. Customer comms — once per visit

Inside `/complete`, when `svc.visit_id` is set and the group is not closing on this call:
- Completion SMS is **not sent**; `completionSmsStatus = 'held_visit'` (new state in the
  existing per-record machine; re-completion guards at `:11447-11455` treat it like
  `deferred`).
- Completion email enqueue is skipped; `serviceReportV1EmailStatus = 'held_visit'`.
- Review enrollment is skipped; the group closer enrolls once against the **last** record
  (fixes the existing double-ask on the auto path as a side effect).
- Report, PDF, invoice mint, service record: unchanged.

**Group close** — a small new service `server/services/visit-close.js`, invoked from the
last `/complete` (`visitClose: true`) and from any row transition that resolves the group
(cancel/skip/unable of a sibling when all others are already terminal). Under one advisory
lock keyed on `visit_id`, it:
1. Re-reads every row; closes only when every row is terminal (`completed`, `cancelled`,
   `skipped`, or completed-with-incomplete). Otherwise returns `waiting`.
2. Sends **one** SMS from a new DB template `visit_complete` (self-pay) /
   `visit_complete_prepaid` (autopay/prepaid) with vars `first_name`, `service_list`
   ("Quarterly Pest Control and Rodent Bait Station"), `visit_url` (short link, schemeless
   portal host per the 08-01 SMS rule). One link only — the summary page carries the reports
   and the pay button. Quiet-hours deferral and the deferred-send worker
   (`dispatch-completion-deferred.js`) are reused at the group level.
3. Enqueues **one** email (`visit_summary` template) linking the same page.
4. Enrolls **one** review request.
5. Records everything in `service_visits.comms` and mirrors `sent` onto each child
   record's `completionSmsStatus` so dispatch's existing SMS badge stays truthful.

**Partial outcome copy.** The template branches on the resolved sections, never on a timer:
"Today's pest-control service is complete. We couldn't reach the rodent stations (gate
locked) and will contact you to reschedule. View today's report: {visit_url}". The unable
row's follow-up is created by the existing incomplete-visit machinery.

**Stuck groups.** A nightly sweep (existing sweep pattern) lists groups still `open` after
the visit date with at least one completed row → admin bell "Visit not closed" with a
one-click *Close & send* / *Separate*. The sweep never composes or sends the customer
message on its own.

---

## 5. Customer visit-summary page

`/visit/:token` (SPA) + `GET /api/public/visit/:token`, token = `service_visits.summary_token`,
same header posture as `/report/:token` (noindex, no-referrer, no-store), same rate-limit
shape as `reports-public.js`. Dark behind `GATE_VISIT_SUMMARY_PAGE` (404 when off).

```
Today's Visit — Aug 29
Quarterly Pest Control            [View report]
Rodent Bait Stations · 10 checked [View report]
Charges
  Quarterly Pest Control   $128.00
  Rodent Bait Stations      $45.00
  Today's total            $173.00      [Pay $173.00]   ← self-pay
  (autopay: "Charged to card ending 4242 · View receipt")
```

- Report links are the rows' existing `/report/:token` URLs (staff-viewer + suppression
  rules unchanged). Nothing about the reports themselves changes.
- The Pay button opens `/pay` for the first row's invoice; with `payIncludeBalance` on, that
  page already itemizes the sibling and charges one PaymentIntent. Copy on the summary says
  "today's total" — never "invoice", because two invoice numbers still exist.
- Glass-UI tokens (customer-surface rule), no customer name in the payload beyond first
  name in the SMS (the appointment page precedent greets nobody; ruling R6 decides whether
  the summary page does).

---

## 6. Billing

**v1: two internal invoices, one customer payment.** Nothing changes in mint, ledger,
receipts, void-on-cancel, dunning, or Sandy's account-level balance. The combined pay page
is the payment experience. Requires `GATE_PAY_INCLUDE_BALANCE=true` in prod (verify — it
shipped dark on #3427).

**v2 (Phase 4): one autopay charge per group.** Today the completion-side charge runs per
invoice and, for a multi-row plan with no single per-visit amount, refuses and parks for
office review (`admin-dispatch.js:11098-11102`). For grouped rows:
- `/complete` skips the completion charge (`autopay_log` `skipped_visit_group_pending`).
- The group closer, after all invoices are minted, builds the same allocation
  `pay-combined.js` uses (`buildAllocation`/`encodeAllocation`, `:270-300`), charges one
  PaymentIntent with the saved card, and settles through `settleCombinedPaymentIntent`
  (`:788`) so each invoice is paid by allocation and one receipt goes out. Cap resolution
  runs per row, then summed.
- Dark behind `GATE_VISIT_GROUP_AUTOPAY`; until it is on, grouped autopay customers park for
  office review exactly as today (one card charge, done by the office from the combined pay
  page) — never two silent charges.

**Not in this lane:** a single parent invoice with two service lines. It fights the mint
lock, the FK, void/cancel, reconciliation, and Sandy's invoice-by-invoice collections
language for no customer-visible gain over the summary page.

---

## 7. Phases

| Phase | Ships | Gate | Depends on |
|---|---|---|---|
| **0 — sizing + rulings** | prod count (§8), R1–R7 | — | owner |
| **1 — model + grouping** | `service_visits` migration, converter same-trip stamp, seeder join rule, admin group/split actions, collective-move scope, grouped route card (tech + dispatch), en-route/on-site fan-out | `GATE_VISIT_GROUPS` (off → no groups are ever created; existing rows unaffected) | — |
| **2 — one closeout, one message** | grouped CompletionPanel, `/complete` hold states, `visit-close.js`, `visit_complete*` SMS + email templates, single review ask, stuck-group sweep + bell | same gate | 1 |
| **3 — summary page** | `/visit/:token` + API, short link, Pay hand-off, glass UI | `GATE_VISIT_SUMMARY_PAGE` | 2 |
| **4 — one autopay charge** | group closer charge via combined-PI allocation, receipts, `autopay_log` codes | `GATE_VISIT_GROUP_AUTOPAY` | 3 |
| later | retire `COMBINED_SERVICE_ROUTES` + combo catalog rows (08-28 ruling), so termite-bait and T&S combos become grouped separate rows; optional combined visit PDF | — | 2 |

Phases 1–2 are one PR pair (model, then closeout) — Phase 2 is where the customer-visible
change lands, and Phase 1 alone is invisible. Each phase carries its own contract tests:
completion-lane coverage is unaffected (no new catalog key), but the `/complete` hold
states, the close rule, the SMS template presence, and the allocation math each need pinned
tests in the style of `combined-completions` / `pay-combined` suites.

---

## 8. Sizing — prod read Adam runs

The classifier blocks prod reads from this session. Script `~/visit-pairs-2026-08-29.js`
(read-only: counts customers with >1 open row on the same date over the next 120 days, how
many share tech + window, top service pairs, and completed same-day pairs in the last 90 days):

```
! cd ~ && export DATABASE_PUBLIC_URL="$(railway variables -s Postgres --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).DATABASE_PUBLIC_URL))')" && NODE_PATH=~/wt-service-convention/node_modules node ~/visit-pairs-2026-08-29.js
```

If the future count is small (a handful of customers), Phase 1's seeder join rule can start
as admin-only grouping and the converter stamp; if it is dozens, the seeder rule ships in
Phase 1.

---

## 9. Rulings needed (owner)

| # | Question | Recommendation |
|---|---|---|
| R1 | Group key: customer + property + date + tech? | Yes; tech may be null until dispatch; split on tech mismatch at assignment. |
| R2 | Two internal invoices + combined pay page = the "one invoice"? | Yes for v1; summary says "today's total", never "invoice". |
| R3 | Rescheduling one grouped row | Group moves as a unit by default (#3562 choke point); "just this service" splits it. |
| R4 | Section outcomes | `completed / unable_to_complete (reason) / not_required`; unable seeds the existing follow-up. |
| R5 | SMS shape | One link (`visit_url`); no report links or pay link in the text. Copy above. |
| R6 | Summary page greets by first name? | Follow the appointment-page precedent: no name on the page; first name only in the SMS. |
| R7 | Autopay rollout | Grouped autopay customers park for office review until Phase 4's gate is on; never two charges. |
| R8 | Retire `COMBINED_SERVICE_ROUTES` + combo rows once Phase 2 is live (pending 08-28 ruling)? | Yes — same-trip grouped rows replace them. |

---

## 10. Explicitly out of scope

- One parent invoice with multiple lines (§6).
- Changing any report content, companion sections, or completion profiles.
- Same-customer-same-date inference at completion time; any tech-facing hold/skip toggle.
- Historical backfill of groups.
- Combined visit PDF (possible later; the two PDFs already exist).
