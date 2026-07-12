# Universal One-Time Services — UI & Reports Scope

Scoping proposal (2026-07-12, drafted for owner review — not yet ratified; no
DECISIONS.md entry until PRs ship). Owner direction: "move into a universal UI
and flow for one-time services — rodent control, everything except WDO
inspections — and maybe even include WDO in the same type of UI experience,
but still capture what we've set up with the FDACS form. The project lookup UI
isn't as pretty, and the post-service reports aren't as clean as the React
post-service reports for recurring pest." Owner clarification (same day):
"we're basically migrating all the projects into the recurring past-service
UI, but keeping a lot of the fields we consistently have for the projects."

That clarification is exactly the architecture: the typed findings registry
IS the project fields, carried over (and upgraded to tap-to-fill sectioned
checklists per the owner's June specs) — nothing captured today is lost by
the migration. The two carve-outs are WDO + pre-treat cert, which get the
same *experience* while keeping their legal pipeline (§4).

**Bottom line:** the platform already has the universal flow — the Specialty →
Service Report V1 program (contract: `docs/design/specialty-service-completion-contract.md`,
PRs 0–5 + Phase 1b/2 cutovers, June 2026). Most one-time services already
complete through the standard appointment lifecycle + typed CompletionPanel +
Service Report V1. What's left is (1) graduating the rodent shadow, (2) cutting
over four straggler types, (3) replacing the legacy Projects admin UI — the
"not pretty" lookup, (4) building the one-time report UIs up from the
recurring-pest report's parts (timeline, recap-video slot, designed cards)
over the typed fields, (5) a decision on how far WDO joins, (6) finishing
multi-service appointments — one visit, one completion, one embedded report
(the companion mechanism exists; booking routing and ad-hoc add-ons don't),
and (7) the comms-context AI toggle ("Include recent customer
calls/texts/emails in AI draft") on every completion surface, with
service-scoped time windows so it never drags in year-old irrelevant threads.

---

## 1. Current state (verified against migrations + profile code)

`service_completion_profiles` is the routing table: `completion_mode`
(`service_report` = universal flow, `project_required`/`special_project` =
legacy Projects flow) + `delivery_mode` (`auto_send` / `internal_only` /
`disabled`).

### Already universal — typed completion + Service Report V1, customer-visible

| Family | Keys | Since |
|---|---|---|
| Phase-1 pilot (16 keys) | pest_inspection, new_customer_inspection, mosquito_event, mosquito_one_time, palm_injection, lawn_aeration, lawn_care_one_time, lawn_fungicide, lawn_insect_control, lawn_inspection, bee_wasp_removal, fire_ant, mud_dauber_removal, pest_initial_cleanout, pest_re_service, tick_control | `20260611000012` |
| Flea | flea_tick | `20260612000013` |
| Roach knockdown | pest_initial_palmetto_knockdown, pest_initial_german_knockdown | `20260612000011` |
| Tree & Shrub | tree_shrub_program, tree_shrub_6week | `20260612000010` |
| Termite bait (graduated) | termite bait-station keys | `20260612000023` |
| Combined services | pest_termite_bait_quarterly (companion auto_send), lawn_tree_shrub_combo | `20260612000031` |

### Typed but SHADOWED (`internal_only`) — customers currently get NO report

| Family | Keys | Blocker |
|---|---|---|
| Rodent trapping | rodent_trapping | Owner review of stored shadow reports (`20260611000016`) |
| Rodent family (11 keys) | rodent_exclusion, rodent_exclusion_only, rodent_sanitation_light/standard/heavy, rodent_trapping_exclusion/_sanitation/_exclusion_sanitation/_followup, rodent_inspection, rodent_general_one_time | Rides the rodent shadow (`20260612000012`) |
| Rodent bait | rodent_bait_setup, rodent_bait_quarterly + `pest_rodent_quarterly` companion | Same shadow (explicitly held out of the termite-bait graduation, `20260612000023`) |

(The six termite bait/monitoring keys already graduated to auto_send on the
owner's FS 482.226 / FAC 5E-14 bait-lane signoff — `20260612000023`.)

**This is the sharpest customer-facing gap.** At cutover (2026-06-12) the old
project-flow report sends for these keys STOPPED (disclosed trade). Every rodent
visit since then has produced a staff-only report. Graduation is a one-line
per-key migration + the `pest_rodent_quarterly` companion flip (recipe:
`docs/design/combined-service-completions.md` §Graduation) — gated only on the
owner reviewing the stored reports.

### Still on the legacy Projects flow (`project_required`)

| Key(s) | Why | Path to universal |
|---|---|---|
| wildlife_trapping | Typed sectioned form EXISTS (dark since feat/service-sectioned-findings); cutover migration never shipped | Cutover migration (Phase-2 pattern) |
| bed_bug_treatment | Owner copy approval pending (service is customer_visible:false) | Approve copy → cutover migration |
| cockroach_control | Multi-visit German program service; 2026-07-03 fix pointed it at the better `cockroach` project form but left it project_required | Cutover migration (typed `cockroach` flow is already live for the knockdown keys) |
| general_appointment | Deliberately excluded — generic catch-all, required activity gauge is wrong-frame | Owner decision: minimal no-gauge typed form, or stays |
| waveguard_initial_setup | Deliberately excluded — recurring-program onboarding, not a one-time | Likely stays |
| termite_inspection; termite_spot_treatment, termite_pretreatment (`project_required` → termite_treatment); termite_trenching, termite_liquid (`special_project` → termite_treatment) | Phase 3 — compliance-gated (typed termite_treatment form is Tier 3, full mandated fields) | FS 482 review → cutover |
| **wdo_inspection** | Excluded IN CODE (`V1_EXCLUDED_PROJECT_TYPES`, service-completion-profiles.js:15) — FDACS-13645 legal machinery | §4 below |
| termite_slab_pretreat → pre_treatment_termite_certificate | Same compliance posture as WDO (`COMPANION_EXCLUDED_TYPES`; on-page FBC Certificate of Compliance render) | Follows WDO decision |

Also note `PROJECT_CREATION_KEPT_TYPES` (owner directive 2026-07-04): flea +
rodent_trapping stay creatable as standalone documentation projects even
though their appointment completions are typed. Any Projects-UI replacement
must keep an ad-hoc documentation entry point.

## 2. Why the project lookup "isn't as pretty" — admin UI current state

The universal flow's admin surfaces are already V2 (typed completions happen in
DispatchPageV2 / the mobile appointment sheet; results land in Customer 360
service history). The Projects lane never got the V2 pass:

| Surface | File | State |
|---|---|---|
| `/admin/projects` (nav "Projects", the lookup) | `client/src/pages/admin/ProjectsPage.jsx` | 3,324 lines, **160 inline `style={{}}`, 0 Tailwind, 0 `components/ui`**. Three palettes collide: a hand-rolled zinc `D` (:26-40), an `ESTIMATE_*` blue set (:43-48), and hardcoded customer-preview blues/gold inside `CustomerProjectReportPreview` (:737-964). Hand-rolled `ProjectRow` (:1318), `FilterSelect` with an inline-SVG chevron (:1293), ad-hoc status pills (:50-54). Destructive actions use native `confirm()`/`window.prompt()` (send :1593-1607). Only `AdminCommandHeader` is shared with V2. |
| Create Project modal (tech + admin) | `client/src/components/tech/CreateProjectModal.jsx` | 1,558 lines, own `P`/`PALETTES` inline system, 0 Tailwind. Shared by TechHomePage (dark) and ProjectsPage (light). |
| Findings field renderer | `client/src/components/tech/ProjectFindingFieldInput.jsx` | 939 lines, inline styles (also reused by the typed CompletionPanel — keep). |
| WDO extras | `WdoIntelligenceBar.jsx` (494), `WdoSignaturePad.jsx` (185) | Inline styles, WDO-only. |

Contrast: `CustomersPageV2.jsx` — 161 Tailwind classNames, `components/ui`
primitives, semantic tokens (`text-ink-primary`, `border-hairline`, `text-13`),
9 inline styles. The Projects page reads as a different app inside the V2
shell, and its two-step flow (tech saves draft → admin reviews in ProjectsPage
→ manual Send) is itself the legacy UX the typed pipeline replaced with
auto-send.

What still NEEDS the Projects lane after the stragglers cut over: WDO +
pre-treat cert (compliance), ad-hoc documentation projects
(`PROJECT_CREATION_KEPT_TYPES`: flea, rodent_trapping), Phase-3-pending termite
keys, and read access to historical sent/closed project records.

**Tech-side flow gap:** `/tech` (TechHomePage) does not open the typed
completion at all — `typedFindingsNotice()` (TechHomePage.jsx:83-85, branch
:543-583) shows an alert telling the tech to "complete through the Dispatch
completion form." The real form is `CompletionPanel`/`TypedFindingsSection`
exported from SchedulePage and rendered by DispatchPageV2 + the mobile
appointment sheet. Workable because the only tech is the owner with admin
access, but it is the opposite of a universal flow: the tech home surface
bounces exactly the services this program made routine.

## 3. Why the reports "aren't as clean" — three report tiers today

| Tier | Services | Page / route | Data | Polish |
|---|---|---|---|---|
| **A — Recurring V1** | recurring pest / lawn / tree & shrub | `ReportViewPage.jsx` (8,314 lines) at `/report/:token` | `service_records` V1 via `report-data.js` | Rich V2 sections (`components/report/pestV2|lawnV2|treeShrubV2`), pressure/activity cards, coverage map, timeline, recap video |
| **B — Typed specialty** | the cut-over one-time types | **same** `ReportViewPage.jsx`, same token pipeline, auto-delivered | same V1 + `service_data.typedReportSnapshot` | Deliberately simpler: `TodaysResultCard` (:2251) + `TypedFindingsCard` — a bare `<dl>` key/value list (:2278) + `ActivityCard` for trend types. Contract-correct content, visually thinner than Tier A |
| **C — Projects** | WDO, pre-treat cert, stragglers (§1), all legacy sends | separate `ProjectReportViewPage.jsx` (1,245 lines) at `/report/project/:token` | `projects.findings` (WDO: as-sent snapshot) | Flat "At a glance" + findings key/value list + photo grid + optional AI narrative. No gauge, no timeline, no V2 cards. Inline style objects, no `.report-card` CSS system |

The hard fork: `project-completion.js:480-484` NULLs `report_template_version`
+ `report_view_token` on project-backed completions — a project record can
never render as a V1 report. Delivery diverges the same way: V1 auto-delivers
at completion (queue at `admin-dispatch.js:5620`, email builds `/report/{token}`);
projects wait for a manual admin Send from ProjectsPage.

So "not as clean as the React reports" is two distinct gaps:
1. **Tier C exists at all** for routine work (stragglers §1) and rodent
   customers currently get *nothing* (shadow). Fixed by finishing
   cutover/graduation — those types then ride the exact Tier A page and
   auto-delivery.
2. **Tier B is visually thinner than Tier A** — same page, same tokens, but a
   bare definition list where pest/lawn get designed V2 sections, no visit
   timeline, and the recap-video pipeline is gated pest-only. Closed by
   Phase D: card polish + timeline + recap-video parity composed from the
   Tier-A parts (content and section order stay contract-bound: Today's
   Result first, no pressure cards, banned-words machinery untouched).

Customer portal note: `ServicesTab` (PortalPage.jsx:2680-2720) already
branches on `isProjectCompletion` — project rows get "View project report"
link-only treatment, V1 rows get the full "View report" + PDF affordances.
As A+B land, one-time services converge on the V1 affordances automatically;
the project branch remains only for WDO/cert and historical records.

## 4. WDO — how far it joins the universal experience

WDO is the one type excluded **in code**, not just data
(`V1_EXCLUDED_PROJECT_TYPES`, `server/services/service-completion-profiles.js:15`),
because its completion is load-bearing legal machinery for a FDACS-13645
filing used in real-estate closings:

- Licensee e-signature gate with freshness + content-hash binding
  (`projects.wdo_signature`; Rule 5E-14.142 F.A.C.), blank-ink server check.
- The genuine FDACS-13645 AcroForm filled + flattened via pdf-lib
  (`server/services/pdf/wdo-report-pdf.js`), photo addendum pages, continuation
  pages.
- Exact emailed bytes archived to S3 **before** send (`wdo_sent_filings`,
  fail-closed); the public token page serves the as-sent snapshot, never live
  findings.
- Email is mandatory (the PDF rides email; 422 `email_required`), third-party
  report copies to realtor/title from `report_sent_to` (report-only, never the
  pay link), Section-2 contradiction/completeness gates, combined
  report+invoice send with dry-run preview and FOR-UPDATE dedupe.
- Field intelligence: property-specs + treatment/permit-history lookups
  (`WdoIntelligenceBar`), cached on `projects.property_profile` / `wdo_history`.

**Recommendation: unify the EXPERIENCE, not the pipeline.** "Same type of UI
experience while still capturing the FDACS form" is achievable without routing
WDO through the typed `/complete` path:

- **Option W1 (recommended): universal shell, compliance core intact.**
  (a) The V2 one-time services surface (§5 Phase C) includes WDO jobs in the
  same list/lookup/detail experience — V2-styled WDO detail with the signature
  status, Section gates, filings archive, and combined-send actions presented
  through `components/ui` primitives instead of `confirm()`/`prompt()`.
  (b) The tech flow enters from the appointment (En Route → Complete → WDO
  form) instead of "go create a project," reusing the existing
  CreateProjectModal→ProjectFindingFieldInput capture restyled, with the
  FDACS 23-field schema, WdoIntelligenceBar, and signature pad unchanged.
  (c) The customer/third-party token page gets the §3 report-shell polish; the
  signed FDACS PDF stays THE artifact, presented inside the clean React
  wrapper. All server gates, archive semantics, and `V1_EXCLUDED_PROJECT_TYPES`
  stay exactly as-is.
- **Option W2 (not recommended now): full merge into typed completion.**
  Would require replicating signature gating, as-sent archiving,
  email-mandatory delivery, and third-party copy routing inside the Service
  Report V1 pipeline — high compliance risk, and the customer-visible outcome
  is identical to W1. Revisit only if maintaining two completion pipelines
  becomes a real cost after Phases A–C ship.

`pre_treatment_termite_certificate` follows the same W1 treatment (it shares
the compliance posture via `COMPANION_EXCLUDED_TYPES`).

Cleanup rider (either option): the tech quick-estimator's flat WDO $125
(`client/src/pages/tech/TechEstimatorPage.jsx:57`) disagrees with the invoice
tiers $150/$200/$250 on `structure_sqft` (`admin-projects.js:2079-2083`) —
reconcile with the owner (pricing change ⇒ pricing-config checklist).

## 5. Proposed phases

Ordered by customer impact per unit of risk. A/B are days-scale (migrations +
reviews); C/D are the UI builds. Each PR follows waves-ship; UI PRs follow the
strict 1:1 visual-refresh rule (no behavior changes riding restyles) and
ui-verify before review.

### Phase A — Graduate the shadow (biggest report win, near-zero code)
1. Owner reviews stored `internal_only` rodent reports (staff report view).
   Gate from the owner spec: exclusion/sanitation conditional modules must
   tell their own story — never flatten to "rodent service completed."
2. Graduation migration: flip `delivery_mode → auto_send` for the rodent
   family + rodent_trapping + rodent_bait keys, AND the `pest_rodent_quarterly`
   companion entry (recipe in `combined-service-completions.md`; pattern
   `20260612000023`). Stored shadow reports keep their frozen posture.
3. Progress-SMS template (`service_report_v1_progress`) goes live with real
   traffic — verify on the first graduated trap-check.

### Phase B — Cut over the stragglers (flow universality)
1. `wildlife_trapping` → typed cutover migration (sectioned form already
   built; auto_send — wildlife customers currently get project sends).
2. `cockroach_control` → flip to `service_report` + `cockroach` findings
   (typed flow already live for the knockdown keys; German-species follow-up
   trigger already in machinery).
3. `bed_bug_treatment` → owner approves customer copy → cutover
   (`customer_visible` flip is a separate owner decision).
4. `general_appointment` / `waveguard_initial_setup` → owner call (§6 Q4);
   default: leave as-is, they are not customer-report lanes.
5. Termite Phase 3 — termite_inspection + the termite_treatment keys
   (spot_treatment, pretreatment, trenching, liquid) — blocked on the
   FS 482.226 / FS 482.2265 / FAC 5E-14 review for the inspection/remedial
   lanes. Precedent exists: the owner already signed off the bait-station
   lane on 2026-06-12 (`20260612000023`), so this is a review of the two
   remaining lanes, not a from-scratch exercise.

### Phase C — Universal one-time services admin surface (the "pretty" fix)
Replace the legacy Projects lookup with a V2 surface, strict-1:1 on data and
endpoints (`/api/admin/projects/*` unchanged):
1. **PR C1 — list/lookup:** `/admin/projects` master list on Tailwind +
   `components/ui` (shared Badge/Card/Select, `border-hairline`, zinc ramp;
   status pills via shared primitives; kill the SVG-data-URI chevron).
2. **PR C2 — detail:** project detail pane on V2 primitives; native
   `confirm()`/`prompt()` → Dialog primitives. WDO detail keeps signature
   pad, gates, filings archive, combined send (visual-only).
3. **PR C3 — create/capture:** restyle `CreateProjectModal` +
   `ProjectFindingFieldInput` (both themes; the field renderer is shared with
   the typed CompletionPanel — verify both surfaces with ui-verify).
4. Keep: ad-hoc documentation creation (flea, rodent_trapping), historical
   record access. Naming can shift from "Projects" to "Jobs"/"One-Time
   Services" if the owner wants — nav label only, no route/file renames.
5. **PR C4 — tech entry unification (behavior PR, never rides a restyle):**
   TechHomePage stops alert-bouncing typed jobs (§2) — open the same mobile
   completion sheet (or deep-link into the dispatch completion for that
   service) so field completion is one flow regardless of surface.

Sizing: C1/C2 are the big lifts (a 3,324-line page split across two strict-1:1
PRs), C3 medium (1,558 + 939 lines, two themes), C4 small.

Note the picker shrinks by itself: `appointmentManagedProjectTypes` already
removes fully-cutover types from the Create Project Report modal, so after
Phases A+B the create path naturally reduces to WDO ("New WDO"), pre-treat
cert, Phase-3-pending termite, and the kept ad-hoc documentation types —
today's 9-type picker (owner screenshot 2026-07-12) is the straggler list in
UI form.

### Phase D — Report convergence & feature parity (the "clean reports" fix)
Owner direction (2026-07-12): build the one-time report UIs by **taking parts
from the recurring-pest report** — service report timeline "and stuff like
that," with the video recap available "just in case we want the same
features" — over the typed project fields as the data. So Phase D is
composition from Tier-A parts, not invention:

1. **D1 — typed card pass:** bring `TodaysResultCard` / `TypedFindingsCard` /
   `ActivityCard` up to the pestV2/lawnV2 visual standard (designed cards
   instead of a bare `<dl>`). Presentation-only: contract §8 section order,
   snapshot immutability, and customer copy untouched; golden-fixture
   rendering tests pass unchanged.
2. **D2 — visit timeline for typed families:** adapt the Tier-A timeline
   treatment (`ServiceTimelineSection` / `LawnVisitTimeline` pattern) to
   typed reports — completed visits with dates + each visit's Today's Result
   headline, strongest for trend programs (trap checks, German roach
   follow-ups) where `service_activity_scores` history already exists and
   `ActivityCard` already shows the gauge trend. Trend types first, then
   evaluate for one-shot types (a one-visit timeline is noise).
3. **D3 — video recap parity (the "just in case"):** the report page already
   has the `RecapVideoCard` slot; the recap pipeline is currently pest-only
   at three gates — `serviceLine === 'pest'` (reports-public.js:1106), the
   Remotion composition (`video/src/VisitRecap.jsx` is pest-themed), and the
   during-visit capture affordance (`TechRecapCapture`, flag `pest-recap-v1`,
   active pest jobs only). Parity = per-family gate allowlist + a typed
   composition fed from the snapshot (Today's Result headline, activity
   trend, photos) + widening the capture affordance. Sized M–L; sequenced
   after D2, per-family opt-in so it lights up only where the owner wants it.

D component work is independent of the cutover migrations — D1/D2 can start
in parallel with Phase B.

**Contract amendment note:** the PR-0 contract's §8 "Never" list (Pest
Pressure card, pressure trend, lawn program cards) stays banned on typed
reports. Timeline and recap video are additions the contract didn't
contemplate — this doc, owner-directed, is the amendment of record; update
`specialty-service-completion-contract.md` §8 when D2/D3 ship.
2. `ProjectReportViewPage` (`/report/project/:token`) remains for WDO,
   pre-treat cert, Phase-3-pending termite, and historical sends: restyle to
   the current customer-facing shell standard (glass navy per
   `waves-customer-facing-design-brief.md`) so the last legacy-looking
   customer artifact matches the V1 report feel. Snapshot/as-sent semantics
   untouched.
3. WDO token page presents the signed FDACS PDF inside that shell (W1c).

### Phase E — Multi-service appointments (owner ask 2026-07-12)

Owner: "sometimes we have multiple services tied within one appointment —
quarterly pest control and a rodent bait station check. Add on services or
have it automatically inputted, so when we press complete it sends a
quarterly pest control and a rodent bait station report embedded into one
React UI. Could be lawn care and tree & shrub. Could be multiple things."

**What already exists (live in prod):** the companion mechanism
(`docs/design/combined-service-completions.md`, cutover `20260612000031`) is
exactly this — a `service_completion_profiles.companion_types` declaration
makes the tech complete ONCE, with one `TypedFindingsSection` per companion
under the primary form (mobile + desktop), and the customer gets ONE report
with the primary content first and one section per companion below. Three
combined catalog keys shipped, matching the owner's two examples verbatim:

| service_key | name | companion | delivery today |
|---|---|---|---|
| `pest_rodent_quarterly` | Pest & Rodent Control | rodent_bait_station | **internal_only** — rides the rodent shadow; flips in the Phase-A graduation |
| `pest_termite_bait_quarterly` | Quarterly Pest + Termite Bait Station | termite_bait_station | auto_send |
| `lawn_tree_shrub_combo` | Lawn + Tree & Shrub | tree_shrub | auto_send |

`20260615000001` already linked the real prod "Pest & Rodent Control Service"
appointment rows to the combined key, so those completions resolve the
combined profile today. Net: the owner's pest+rodent example works end-to-end
right now EXCEPT the rodent section is staff-only until Phase A graduates the
rodent family — one more reason A is the lever.

**What's missing (the actual Phase E work):**

1. **E1 — booking/estimate routing to combined keys.** Declared a follow-up
   in the combined doc and still open: the estimate converter emits one
   scheduled service per recurring line, so a customer sold pest + rodent
   bait gets two separate visits/reports unless someone hand-picks the
   combined key. Work: converter maps qualifying estimate pairs
   (pest+rodent_bait, pest+termite_bait, lawn+tree_shrub) into ONE combined
   scheduled service (cadence/billing decisions per pair), plus an admin
   affordance to re-type an existing customer's paired services onto the
   combined key (the Harris case — recorded as an owner decision in the
   combined doc).
2. **E2 — ad-hoc add-on sections at completion.** Today `/complete` is
   strict by design: submitted companion types must be declared on the
   profile (409 `companion_type_mismatch`), so a tech who also checked bait
   stations during a plain quarterly visit can't add that section on the
   fly. Work: an "Add service section" affordance in the CompletionPanel
   drawing from a SERVER-side allowlist (profile-is-authoritative principle
   holds; the client never invents sections — plausible allowlist: typed
   families the customer has active programs/history for, owner to ratify),
   validated exactly like companions, delivery = the family's standalone
   graduation state. Design decisions: billing (an added billable section
   must still hit the billing pre-gate vs. add-ons are always
   $0-included — owner call) and whether the added section also satisfies a
   sibling scheduled service (see E3) or is purely documentation.
3. **E3 — same-day sibling auto-fold ("automatically inputted").** When the
   same customer has two SEPARATELY-booked services on the same day, offer
   "Complete together" at completion open: fold the sibling in as a section,
   complete both `scheduled_services`, deliver ONE report, dedupe the
   completion SMS/email. The hard part is bookkeeping, not UI: each service
   resolves its own billing disposition (the 409 `completion_billing_required`
   pre-gate must run per component), the sibling's `service_records` row must
   point at the shared report, and invoice merge vs. two invoices is an owner
   decision. E1 removes most of the need (recurring pairs book combined);
   E3 covers the irregular remainder.

Sequencing: E1 first (mechanism fully exists; converter + re-type only),
then E3, then E2 — or fold E2 into E3 as the "unscheduled extra work"
variant. Phase-D enrichment applies to companion sections too: v1
deliberately keeps photos/AI summary/follow-up CTA primary-only
(disclosed-for-ratification in the combined doc) — ratify or revise when D1
ships.

### Phase F — Comms context on every completion (owner ask 2026-07-12)

Owner: the "Include recent customer calls/texts/emails in AI draft" feature
(screenshot: the project form's RECOMMENDATIONS / NOTES → AI draft) "should
be in all complete service sections… but limited to the specific service,
and limited [in time] for recurring — we don't want to be pulling in data
that's not relevant from a year ago."

**Current state:** two near-duplicate builders, neither windowed nor
service-scoped:

- `getCustomerCommunicationContext(customerId)`
  (`server/routes/admin-projects.js:726`) — feeds the project ai-write. Last
  **3 calls (`call_log` synopsis/notes/transcription) + 4 texts (`sms_log`)
  + 3 emails (`emails`)** for the customer, merged newest-first, top 6
  lines. No date floor: a sparse-comms customer's "most recent 3 calls" can
  reach back a year — exactly the owner's complaint.
- `loadFindingsRecapCommsContext(customerId)`
  (`server/routes/admin-dispatch.js:6066`) — the typed completion's
  recommendations AI draft (`POST /:serviceId/findings-recap/draft`,
  opt-in via `includeCustomerComms === true` at :6381, modeled on the
  projects one). Same shape, same limitations.
- Missing entirely from the recurring surfaces: the CompletionPanel
  "Generate AI report" draft and the ServiceRecapModal draft have no comms
  toggle at all.

**Scope:**

1. **F1 — one shared builder** (`server/services/completion-comms-context.js`
   or similar): same three channels, but window-first —
   - recurring service: since the customer's **last completed visit of the
     same service line** (the inter-visit window), with a hard cap;
   - one-time/project: since the **job's origin** (estimate accepted /
     booking created), with a hard cap;
   - never uncapped most-recent-N. Cap values are owner-ratified numbers,
     not guesses.
   Service relevance v1 = window + a service-line hint in the prompt with an
   explicit "ignore unrelated topics" instruction — NOT a hard keyword
   prefilter (which would drop "ants in the kitchen" texts that never name
   the service). Drafts stay tech-reviewed, so model-side relevance is
   acceptable at v1; revisit a purpose/link prefilter if noise shows up.
2. **F2 — wire everywhere:** replace both existing builders with F1
   (projects ai-write + findings-recap draft), and ADD the opt-in checkbox +
   context to the recurring CompletionPanel AI report draft and the
   ServiceRecapModal draft. One consistent label everywhere.
3. **F3 — guardrails unchanged:** opt-in per draft; context feeds AI drafts
   only (tech reviews before anything customer-facing); banned-claims
   validation stays; the profile-authoritative ownership gating on the
   draft endpoints (the Codex P1 pattern at admin-dispatch.js:6366) extends
   to any new draft endpoint.

### Explicitly out of scope
- Any pricing value change (WDO fee reconciliation is flagged, not changed).
- The typed-report content system (snapshots, copy maps, banned words) — it
  is the standard; nothing here edits customer copy machinery.
- Multi-visit "Programs" admin card (open trapping/German chains with trend +
  next follow-up in Customer 360) — genuinely useful, but new capability;
  listed as a candidate follow-up, not part of this scope.

## 6. Open questions for the owner

1. **Rodent graduation (unblocks Phase A):** have the stored shadow reports
   been reviewed? Graduate the whole family at once, or trapping first and
   exclusion/sanitation a week later?
2. **Bed bug copy:** approve the customer-facing wording so the cutover can
   ship? (Zero-state copy is contract-fixed and owner-reviewed in fixtures.)
3. **cockroach_control:** flip the multi-visit German program to typed now
   (recommended — knockdown keys already prove the flow), or hold?
4. **general_appointment / waveguard_initial_setup:** leave on the project
   flow (default), or build a minimal no-gauge typed form for
   general_appointment?
5. **Termite Phase 3:** who performs the FS 482 / FAC 5E-14 compliance review
   and when? This is the long pole for full universality.
6. **WDO:** confirm W1 (universal shell, compliance core intact) over W2
   (full pipeline merge). Also: same treatment for pre-treat certs?
7. **Naming:** keep "Projects" in the nav, or rename the surface (label-only)
   to "One-Time Services" / "Jobs"?
8. **WDO fee mismatch:** tech estimator $125 vs $150/$200/$250 invoice tiers —
   which is right?
9. **Tech entry (C4):** open the completion sheet directly on /tech, or is
   the dispatch-tab habit fine as-is?
10. **D2/D3 rollout:** timeline — trend types only, or all typed families?
    Video recap — which family first (rodent trap checks are the natural
    fit: multi-visit story + existing activity history), and is the
    during-visit capture affordance wanted beyond pest jobs?
11. **Combined booking (E1):** should the estimate converter auto-combine
    the three known pairs? And the Harris case — re-type the existing
    separate pest + rodent rows onto `pest_rodent_quarterly`?
12. **Add-ons/auto-fold billing (E2/E3):** when a section is added at
    completion (ad hoc or same-day fold), is it always $0-included, or does
    it bill its own service price (pre-gate per component)? One merged
    invoice or one per service?
13. **Comms context (F1):** ratify the window caps (proposal: recurring =
    since last completed visit of the service line, capped at 120 days;
    one-time = since job origin, capped at 180 days), and should the
    checkbox default to checked or unchecked?
