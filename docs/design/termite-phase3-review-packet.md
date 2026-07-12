# Termite Phase 3 — Compliance Review Packet (Q5)

Prepared 2026-07-12 for the owner's FS 482.226 / FS 482.2265 / FAC 5E-14
review of the two remaining termite lanes. Signing off unlocks the Phase-3
cutover migration: the five keys below leave the legacy Projects flow and
complete through the universal typed flow with auto-send customer reports.
Until then they stay `project_required` / `special_project`
(registry: `PENDING_COMPLIANCE_REVIEW_KEYS`).

## What you are reviewing

Two lanes, five catalog keys:

| Lane | Keys | Typed form that would take over |
|---|---|---|
| Inspection | `termite_inspection` | `termite_inspection` (Tier-1 style) |
| Remedial / preventive treatment | `termite_spot_treatment`, `termite_pretreatment`, `termite_trenching`, `termite_liquid` | `termite_treatment` |

**NOT in scope:** `wdo_inspection` and `termite_slab_pretreat` (pre-treat
certificate). Ratified Q6/W1: they keep the FDACS-13645 / FBC certificate
legal machinery permanently. Real-estate-transaction inspections NEVER ride
the typed flow — the typed `termite_inspection` form itself says
"Standalone termite inspection (not for real-estate transactions — use WDO
for those)."

## Precedent — what your 2026-06-12 bait-lane signoff covered

You signed off the **bait-station lane** (six termite bait keys) on
FS 482.226 / FAC 5E-14 (`20260612000023`, graduated to auto_send). That
review established: routine termite bait monitoring under a service
contract may report through the typed pipeline with non-prescribed forms.
This review extends the same judgment to (a) standalone diagnostic
inspections and (b) remedial/preventive treatments.

## Regulatory checklist

### FS 482.226 — WDO inspection reports
([flsenate.gov/Laws/Statutes/2025/482.226](https://www.flsenate.gov/Laws/Statutes/2025/482.226))

Key mandates, per the statute:
- Reports for **real-estate transactions** must be on the
  **department-prescribed form** (FDACS-13645) — that lane stays on the WDO
  pipeline, untouched.
- "Routine maintenance contract reports may use non-prescribed forms" —
  this is the clause the typed pipeline relies on (same basis as the bait
  signoff).
- When a WDO **inspection** is performed for a fee: report must include
  licensee name + inspection date, property address, visible accessible
  areas NOT inspected and why, inaccessible areas, evidence of previous
  treatment/infestation, identity of organisms found, visible damage, and
  the notice-affixed statement.
- **Notice stickers:** inspection notice ≥3×5 in, durable ≥3 years, posted
  adjacent to attic/crawl access, with licensee name/address/date;
  treatment notices additionally name the pesticide and target organism.
- If treatment is provided: pesticide names + treatment conditions in the
  report.

**Review question 1:** does the typed `termite_inspection` form (fields
below) capture everything a NON-transaction diagnostic inspection report
must state under 482.226, given the WDO lane handles all transaction
inspections? Note the typed form has no "areas not inspected / why" or
"notice affixed" fields today — decide whether those must be added before
cutover, or whether the routine-maintenance clause makes them optional for
this lane.

### FS 482.2265 — consumer information + posted notice
([flsenate.gov/Laws/Statutes/2025/482.2265](https://www.flsenate.gov/Laws/Statutes/2025/482.2265))

Mandates on-request disclosure (business name/ID, pesticide brand + common
name, label safety info) and the ≥4×5-in weatherproof posted notice for
lawn/exterior foliage applications. Trenching/liquid perimeter work can
trigger the posted-notice duty.

**Review question 2:** field practice already covers the physical notice —
confirm nothing in the typed report needs to ASSERT notice posting, or ask
for a "notice posted" checkbox on `termite_treatment`.

### FAC 5E-14 (Ch. 482 implementing rules)
([flrules.org Chapter 5E-14](https://www.flrules.org/gateway/ChapterHome.asp?Chapter=5E-14))

- **5E-14.106** — pesticide use per label: limitations, precautions.
- **5E-14.142** — forms; the WDO signature protocol (13645 carries
  licensee/cardholder signature + date) — WDO lane only, unchanged.

**Review question 3:** the `termite_treatment` form captures products used,
gallons/amount, linear feet/stations, method, target organism (fields
below). Is that sufficient application-record detail for a preventive/
remedial termiticide application under 5E-14, or should percent-solution /
EPA reg no. fields be added before cutover? (The product application log
system — `requires_application_log` on the catalog row — also records
applications; decide which system is the record of authority for these
visits.)

## The exact typed forms (verbatim from `server/services/project-types.js`)

### `termite_inspection`
- Areas inspected (textarea)
- Termite species (if found): None observed / Eastern subterranean /
  Formosan / Drywood / Dampwood / Unknown — sample collected
- Activity status: No activity / Old-inactive damage / Active infestation
- Infestation extent (textarea)
- Recommended treatment (textarea)
- Photo categories: exterior, foundation, garage, attic, crawlspace,
  evidence, other

### `termite_treatment`
- Target termite / WDO: Subterranean / Formosan subterranean / Drywood /
  Unknown-preventive
- Areas treated (textarea)
- Treatment method: Spot treatment / Liquid perimeter / Trenching / Bait
  station setup / Cartridge replacement / Wood treatment / Other
- Products used (textarea)
- Linear feet / stations (textarea)
- Gallons / amount applied (textarea)
- Follow-up / warranty plan (textarea)
- Photo categories: foundation, trench, drill_point, station, damage,
  treatment_area, before, after, other

## Sign-off

Answer the three review questions; any "add field first" answer becomes a
small form PR before the cutover migration. Then say the word and the
Phase-3 cutover migration ships (same self-healed pattern as the Phase-B
straggler cutovers, `PENDING_COMPLIANCE_REVIEW_KEYS` empties, and the B0
registry/audit enforce the end state).

- [ ] Q1 inspection-lane fields sufficient (or list additions)
- [ ] Q2 posted-notice handling confirmed (or add checkbox)
- [ ] Q3 treatment-record fields sufficient (or list additions)
- [ ] Owner signoff to cut over: ______ (date)
