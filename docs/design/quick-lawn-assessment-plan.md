# Quick Lawn Assessment — Implementation Plan

Status: **DRAFT PLAN — not yet built.** Maps the "Quick Lawn Assessment / three-mode" product
stance onto the existing codebase. Nothing here is committed as a decision until the open
questions in §12 are answered.

---

## 1. TL;DR — this is an *extend*, not a build

Two discoveries change the framing of the original stance:

1. **The lawn assessment system already exists and is mature.** There is a full dual-vision
   (Claude + Gemini) AI scoring pipeline, baseline tracking, seasonal normalization, treatment-
   outcome correlation, customer-safe snapshots, recommendation cards, and analytics — all
   production. We are adding a *lightweight, baseline-excluded mode* to a real system, not
   inventing `lawn_assessments`.

2. **The report-delivery rails already exist and are mature.** Tokenized public links, SMS (with
   a full consent/suppression layer), SendGrid email, and cached/retried PDF rendering are all
   built for the existing "service report v1." The stance's instinct to defer sending to v1.5
   (because of "consent, delivery logs, opt-out, recipient validation") is no longer necessary —
   those are already solved. **Sending can ship in v1**, with a mandatory confirmation step.

So the real work is six focused changes:

1. Let `lawn_assessments` exist **detached** (nullable customer, add `lead_id`, add an "unassigned" state).
2. Add **classification + lifecycle** fields (`assessment_source`, `assessment_subject_type`, `status`, `baseline_policy`).
3. **Gate the existing baseline / outcome / snapshot / analytics machinery** on `baseline_policy` so quick assessments never pollute history.
4. Add a **tech quick-capture UI** (capture → AI feedback → decide).
5. Add a **tokenized customer-facing report** for quick assessments (reuse delivery rails).
6. Add **admin visibility** for quick assessments.

---

## 2. Ground truth — what exists today

### Core table (`lawn_assessments`, migration `20260401000072_lawn_assessments.js`)

Base columns (later migrations also added `service_id`, `service_record_id`, FAWN weather fields,
`notification_sent`, `report_id` — confirm the live set before writing the migration):

| Column | Notes |
|---|---|
| `id` uuid PK | |
| **`customer_id` uuid `NOT NULL`** | FK → `customers`, `ON DELETE CASCADE` (line 13). **This is the blocker for "no contact" mode.** |
| `technician_id` uuid nullable | FK → `technicians` |
| `service_date` date `NOT NULL` | |
| `season` | peak \| shoulder \| dormant |
| `photos` jsonb | `[{ url, filename, uploadedAt }]` |
| `claude_raw`, `gemini_raw`, `composite_scores`, `adjusted_scores`, `divergence_flags` | AI payloads |
| `turf_density`, `weed_suppression`, `color_health`, `fungus_control`, `thatch_level` | 0–100 display scores |
| `observations` text | |
| `is_baseline` bool default false | |
| `confirmed_by_tech` bool default false, `confirmed_at` | tech review gate |

Related tables: `lawn_baseline_resets` (audit), `lawn_assessment_photos` (photo metadata + quality
gate + `s3_key`), `customer_turf_profiles` (**1:1 per customer** — agronomic context),
`treatment_outcomes` (pre/post deltas), `lawn_health_scores` (summary), the intelligence suite
(`product_efficacy`, `protocol_performance`, `neighborhood_benchmarks`, `tech_calibration`), and
`property_health_snapshots` + `property_recommendation_cards` + events (customer-safe outputs).

### AI flow (`server/services/lawn-assessment.js`, `server/services/lawn-intelligence.js`)

`MODELS.VISION` (Sonnet 4.6, temp 0.2) + Gemini 2.5 Flash fallback → per-photo quality gate →
dual-vision analysis → multi-photo averaging → seasonal normalization → weighted overall score.
**Already runs on uploaded photos with no completed service required** — it just currently
*requires a `customerId`*.

### Routes (`server/routes/admin-lawn-assessment.js`)

`/assess` (requires `customerId` + `photos`, line 484–485), `/:assessmentId/snapshot`,
`/history/:customerId`, `/baseline/:customerId`, `/latest/:customerId`, `/service/:serviceId`,
`/reset-baseline`, `/confirm/:assessmentId`, `/override/:assessmentId`, `/customers`, plus
recommendation/snapshot endpoints. **Baseline auto-set logic is at lines 608–646.**

### Delivery rails (all reusable, all mature)

- **Token links** — `ensureReportToken()` (`server/routes/reports-public.js:888`), 32-hex plaintext
  token, public `GET /api/reports/:token`, rate-limited (20/min). *No expiry today.* Keyed on
  `service_records` — quick assessments have no service record, so they need their **own** token.
- **SMS** — `sendCustomerMessage({ purpose, ... })` (`server/services/messaging/send-customer-message.js:105`)
  with `messaging_suppression`, opt-out keywords, landline rejection, and audit logs **already enforced**.
- **Email** — `EmailTemplateLibrary.sendTemplate(...)` / `sendgrid.sendOne(...)` with PDF MIME
  attachment + delivery logs (`server/services/sendgrid-mail.js`, `.../service-report/email-delivery.js`).
- **PDF** — `getOrRenderServiceReportPdf()` with S3 storage, caching, async retry queue.

### Tech portal (`client/src/components/TechLayout.jsx`, `client/src/App.jsx`)

Bottom-nav app: Route / Field Estimator / Protocols. Pages in `client/src/pages/tech/`, lazy-routed
under `<Route path="/tech">`. Photo capture already exists for service photos (resize-to-1600 +
S3). The tech Intelligence Bar is **read-only** — so this feature is a **dedicated tech page hitting
REST endpoints**, not an IB tool.

---

## 3. Corrections to the original stance

| Stance assumed | Reality | Impact |
|---|---|---|
| "Extend the existing lawn assessment model" (open question whether it exists) | It exists and is mature | Confirmed extend. Far less to build; far more to *not break*. |
| Greenfield table with ~25 fields | ~half already exist as columns/related tables | Map fields to existing first; only add what's missing. |
| `property_id` as a first-class link | **Properties are not first-class** — `customer_turf_profiles` is 1:1 per customer | **Defer `property_id`.** Use `customer_id` (+ optional `turf_profile_id` later). |
| `report_token_hash` | Existing tokens are **plaintext + unique + rate-limited**, not hashed | Decision in §12 — recommend matching the existing plaintext convention. |
| Sending is risky → defer to v1.5 | Consent/suppression/logs **already built** | Sending can be v1 (with confirmation). |
| Photos blocked without a record | Lawn photos use their **own** path, not gated `service_photos` | Quick-capture photos are easy. |

---

## 4. Data model — extend `lawn_assessments`

One migration that **alters** the existing table (no new core table). Map every stance field to
*existing*, *new*, or *deferred*:

| Stance field | Decision | Implementation |
|---|---|---|
| `customer_id` nullable | **ALTER** | drop `NOT NULL` (backfill-safe; existing rows already populated) |
| `lead_id` | **NEW** | `uuid` nullable, FK → `leads(id)` `ON DELETE SET NULL` |
| `assessment_source` | **NEW** | `quick_capture` \| `standard_customer_assessment` \| `admin_created`; backfill existing → `standard_customer_assessment` |
| `assessment_subject_type` | **NEW** | `unassigned` \| `lead` \| `customer`; backfill existing → `customer` |
| `status` | **NEW** | `draft` \| `analyzing` \| `reviewed` \| `ready` \| `sent` \| `archived`; backfill existing → `reviewed` |
| `baseline_policy` | **NEW** | `excluded` \| `eligible` \| `promoted`; backfill existing → `eligible` (preserves today's behavior) |
| `contact_snapshot_json`, `address_snapshot_json` | **NEW** | jsonb nullable (for unassigned/lead drafts) |
| `created_by_user_id` | **NEW** | uuid nullable (admin actor; distinct from `technician_id`) |
| `report_view_token`, `report_status`, `report_expires_at`, `last_sent_at` | **NEW** | token surface on the assessment itself (no service record to hang it on) |
| `promoted_to_snapshot_id`, `promoted_at`, `promoted_by_user_id` | **NEW** | promotion audit → `property_health_snapshots` |
| `archived_at` | **NEW** | timestamp nullable |
| `ai_status` | **NEW (light)** | `pending` \| `complete` \| `failed` (derive/track AI run) |
| `ai_analysis_json` | **EXISTING** | `claude_raw` / `gemini_raw` / `composite_scores` / `adjusted_scores` |
| `recommendation_json` | **EXISTING** | `property_recommendation_cards` (standard); quick stores lightweight inline |
| `final_assessment_json` | **EXISTING** | the display-score columns |
| `human_review_status` / `_by` / `_at` | **PARTIAL** | reuse `confirmed_by_tech` / `confirmed_at`; add explicit review status only if needed |
| `property_id` | **DEFER** | properties not first-class |

Backfill defaults are chosen so **every existing row keeps behaving exactly as today**
(`source=standard`, `subject=customer`, `baseline_policy=eligible`, `status=reviewed`).

---

## 5. Lifecycle + hard gates (server-enforced)

```
[start] ──► draft (unassigned, no contact)
   │            │  run AI  ▼
   │        analyzing ──► reviewed / ready
   │                          │ attach ▼
   │            ┌─────────────┴─────────────┐
   │       subject=lead                 subject=customer
   │       lead_id set                  customer_id set
   │            └─────────────┬─────────────┘
   │                  generate / send report ▼
   │                          sent
   └───────────────────────► archived (any state)

separate axis:  baseline_policy:  excluded ──(explicit promote)──► promoted
```

**Gates (enforced in the route layer, not just UI):**

- **Run AI feedback** — allowed in `draft` with **zero contact**. This is the "internal quick check."
- **Generate or send a report** — require **all** of:
  - `status ∈ {reviewed, ready}`, AND
  - `customer_id` present **OR** `lead_id` present, AND
  - channel consent (already enforced by `sendCustomerMessage` suppression for existing
    customers; for a **new lead** require name + address + email/phone + explicit consent flag).
- **Baseline inclusion** — `quick_capture` is created `baseline_policy = excluded` and **stays
  excluded** until an explicit promote call.

---

## 6. Baseline isolation — the critical correctness work

This is the highest-risk part: every place the existing system silently folds an assessment into
history must be gated on `baseline_policy ∈ {eligible, promoted}`. Inventory:

1. **First-assessment auto-baseline** — `admin-lawn-assessment.js:608–646`. Skip when `excluded`.
2. **`treatment_outcomes` pre/post linkage** — exclude `quick_capture`.
3. **Snapshot + recommendation generation** (`/:id/snapshot`, `emitHealthSignal` ~line 928) —
   don't auto-run for quick assessments.
4. **`lawn_health_scores` summary** — exclude.
5. **History/trend reads** (`/history/:customerId`, `/latest/:customerId`, `/baseline/:customerId`) —
   filter excluded out of the trend, or return them under a separate `quick: []` key.
6. **Analytics** (`product_efficacy`, `protocol_performance`, `neighborhood_benchmarks`,
   `tech_calibration` in `assessment-analytics.js`) — exclude `quick_capture`.

**Promotion** (`POST /quick/:id/promote`) is the *only* path that flips `excluded → promoted`, and
only then may it build a snapshot (`promoted_to_snapshot_id`) and feed history. Promotion semantics
(reset baseline? who can do it?) are **business logic → see §12, do not guess.**

---

## 7. Endpoints (extend `admin-lawn-assessment.js` + tech access)

- `POST /admin/lawn-assessment/quick` — **new.** Customer optional. Creates a `draft`/`unassigned`
  row, uploads photos (keyed by assessment id when no customer), runs the existing AI pipeline,
  returns feedback. *Recommend a new endpoint rather than overloading `/assess`* so the
  customer-required invariant on `/assess` stays intact.
- `POST /admin/lawn-assessment/quick/:id/attach` — `{ target: 'customer' | 'existing_lead' | 'new_lead', customer_id?, lead fields? }`.
  Sets `assessment_subject_type` + linkage, writes contact snapshot, creates a lead via the
  existing lead-create path when `new_lead`.
- `POST /admin/lawn-assessment/quick/:id/report` — `{ channels: ['link'|'sms'|'email'] }`. Enforces
  §5 gates, mints token, renders/sends via existing rails.
- `POST /admin/lawn-assessment/quick/:id/promote` — explicit, business-logic-gated.
- `POST /admin/lawn-assessment/quick/:id/archive`.
- `GET /admin/lawn-assessment/quick` (list/filter) + `GET /admin/lawn-assessment/quick/:id`.
- `GET /api/reports/lawn/:token` — **new public surface** for quick lawn reports (or generalize
  `reports-public.js`; recommend a dedicated lightweight surface — §12).

Tech access uses the **same REST endpoints** under tech auth (not the read-only Intelligence Bar).

---

## 8. Tech UI (the field entry point)

- New page `client/src/pages/tech/TechQuickAssessmentPage.jsx`; lazy route under `/tech`
  (e.g. `/tech/lawn`), added in `client/src/App.jsx` and surfaced via `TechLayout` nav or a
  `TechHomePage` quick action.
- Screens: **Start** (optional customer lookup / lead fields / or skip) → **Capture** (reuse the
  resize-to-1600 + upload pattern from `LawnAssessmentPanel.jsx`) → **AI feedback** (scores, weed
  pressure, color/health, fungus indicators, photo-quality warnings, next steps) → **Decision**
  (Save internally / Create lead / Link customer / Generate report / Send / Archive).
- Style: tech portal is **legacy/Tier-2** — Montserrat headings + `D` dark palette, matching
  `TechHomePage`. **Not** the admin V2 monochrome system.

---

## 9. Admin visibility

- A filter/tab in the lawn-assessment admin surface showing `source` / `status` /
  `baseline_policy`; allow review, promote, archive, resend.
- Customer 360 shows quick assessments as **baseline-excluded** items (visible for context, not in
  the trend line).

---

## 10. Customer-facing report

- Reuse `sendCustomerMessage` with a new `purpose` (e.g. `lawn_quick_report`), a SendGrid template,
  and PDF rendering. Add the report **token on the assessment row** (no service record exists).
- New public report view — customer-facing **warm** tone per `docs/design/waves-customer-facing-design-brief.md`
  (do **not** apply admin monochrome to a customer surface).
- Consent: existing-customer sends are covered by suppression; new-lead sends require the §5
  consent capture.

---

## 11. Phasing

**V1 (recommended scope):** tech quick-capture → AI feedback → attach lead/customer → tokenized
shareable link + PDF → baseline-excluded → admin list. **Include SMS/email send in v1** (rails are
mature) behind a mandatory confirmation step. Link/PDF is the hard floor if we want to trim.

**V1.5:** promotion-to-baseline UX polish, quick→customer conversion analytics, neighborhood-
benchmark opt-in, MMS preview, and de-duplication with the service-report rail.

---

## 12. Decisions to confirm (with recommendations)

1. **Nullable `customer_id` + backfill** — OK to alter the populated table and backfill existing
   rows to `source=standard / subject=customer / baseline_policy=eligible / status=reviewed`?
   *(Rec: yes — backfill makes it a no-op for existing data.)*
2. **Token style** — plaintext + unique + rate-limited (matches existing convention) vs the
   stance's `report_token_hash`. *(Rec: match existing plaintext convention; add `report_expires_at`
   as the only new behavior.)*
3. **`property_id`** — defer (properties aren't first-class)? *(Rec: defer.)*
4. **New `/quick` endpoint** vs reusing `/assess`. *(Rec: new endpoint.)*
5. **Public report route** — dedicated `/api/reports/lawn/:token` vs generalizing the service-report
   route. *(Rec: dedicated lightweight surface.)*
6. **Promotion semantics (BUSINESS LOGIC — needs your call, not guessing):** when a quick
   assessment is promoted, does it (a) become the new baseline, (b) just join the trend without
   touching baseline, or (c) require a separate `/reset-baseline`? And **who** can promote — techs,
   or admin-only? *(Rec to validate: admin-only; promotion joins history but does **not** auto-reset
   baseline — baseline reset stays the explicit existing action.)*

---

## 13. File-by-file change list

**Backend**
- `server/models/migrations/<new>_quick_lawn_assessments.js` — alter `lawn_assessments` (§4) + backfill.
- `server/routes/admin-lawn-assessment.js` — new `/quick*` endpoints; gate baseline auto-set (608–646) on `baseline_policy`.
- `server/services/lawn-assessment.js` / `lawn-intelligence.js` — allow customer-less AI run; skip snapshot/outcome side-effects when `excluded`.
- `server/services/assessment-analytics.js` — exclude `quick_capture` from aggregates.
- `server/routes/reports-public.js` (or new `reports-lawn-public.js`) — public quick-report surface + token validation.
- Report send: new `purpose` in messaging + SendGrid template key + PDF render for the quick-report shape.

**Frontend**
- `client/src/pages/tech/TechQuickAssessmentPage.jsx` — new tech flow (§8).
- `client/src/App.jsx` — lazy route under `/tech`.
- `client/src/components/TechLayout.jsx` or `TechHomePage.jsx` — nav/quick-action entry.
- Admin lawn-assessment surface — quick-assessment filter/tab + promote/archive/resend.
- Customer 360 — show baseline-excluded quick assessments.
- New customer-facing quick-report view (warm tone).

**Docs**
- `docs/design/DECISIONS.md` — append an entry once the build ships (never edit old entries).
