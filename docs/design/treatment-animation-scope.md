# Treatment Animation Scope — Termite Foam, Flea, Cockroach

**Date:** 2026-08-08, revised 2026-08-09 · **Status:** scope for owner sign-off. No code changes in this doc.

**Visual mock:** https://claude.ai/code/artifact/f8082d1d-2044-4c32-94cd-20a10cabddc6 — live
animations for the satellite and cutaway options beside the two that already ship, rendered
with the real engine algorithms over a synthetic aerial.

> **Direction as of 2026-08-09 (owner):** mark up a **photo of the area actually treated**,
> the way bait station pins are marked today. This supersedes both foam options in §6 — see
> §5, which is now the recommended build.

---

## 1. What exists today — three animation rails

### Rail A — Traced Treatment Zone (path geometry)

**Capture** — `TechTreatmentZoneModal.jsx` driving `treatmentZoneSpray.js` (deliberately
React-free canvas + `requestAnimationFrame`). The tech traces on a Google Static Maps
satellite tile (zoom 21→19, 1280×960, optional rotate-to-square alignment).

Four persisted capture modes:

| `capture_mode` | Geometry | Animation |
|---|---|---|
| `perimeter` | open or closed path | spray-mist band stamped along the line, drifting puffs, mascot riding the head, then the band breathes |
| `interior` | closed footprint | perimeter band **plus** the footprint flooded with a brand-blue wash |
| `lawn_highlight` | closed loop | per-pixel turf detection inside the loop, luminous highlight, sweep reveal, then breathes |
| `lawn` | closed loop | fallback when imagery isn't pixel-readable: 3-stroke outline draws in, then pulses |

**Persistence** — `treatment_zone_maps`: `snapshot_s3_key`, `mask_s3_key`, `path_points`
(px **and** lat/lng), `closed_loop`, `linear_ft`, `capture_mode`.

**Report replay** — `TracedTreatmentZoneMap.jsx`, a separate SVG/CSS reimplementation. Mounts
only after IntersectionObserver fires on a motion-tolerant screen, so PDFs and reduced-motion
visitors keep the baked still.

**The registry** — `trace-eligibility.js` decides `{ eligible, variant, captionKey, reason }`
per lane, keyed on typed `findingsType` first and catalog `serviceKey` second. Two variants
today: `spray` and `outline`. Behind **`GATE_TRACE_ELIGIBILITY`, currently dark.**

### Rail B — Station / trap map (point geometry)

`StationMapCard.jsx`. Numbered pins over the live satellite image with staggered pop-in, a
snap flash ring, and a rat scurry on captures. Server contract in
`termite-stations.js → buildStationMapReportContext`, returning `{ available, reason }` and
pins shaped `{ id, number, label, cx, cy, status }` in **image space**.

Two hard rules worth carrying forward: pins are **all-or-nothing** (a single dropped pin
suppresses the whole map rather than publishing a summary that contradicts the findings), and
image drift is actively resolved (`resolveZoneRowsImageDrift`) because Google re-shoots the
satellite tile under saved pins — a stale mark bails out with `marks_stale`.

### Rail C — Visit recap MP4 (Remotion)

`recap-pipeline.js` → `video/VisitRecap.jsx`. A 28-second composition rendered in an isolated
child process, queued and stored like the PDF. Pest service line only.

---

## 2. Where the three asks stand

Two behaviors matter per lane: what renders **today** (gate off — the legacy path suppresses
*only* bed bug and rodent trapping), and what renders **after the flip**.

| Lane | Registry entry today | Renders now (gate off) | After the flip |
|---|---|---|---|
| `flea` | eligible · `outline` · `lawnCoverage` · `requiresExteriorChip` | **spray band** | lawn highlight, with the exterior chip recorded |
| `cockroach` | eligible · `spray` · `requiresExteriorChip` | spray band | spray band, conditional on the exterior chip |
| `palmetto_roach_knockdown` | eligible · `spray` · `requiresExteriorChip` | spray band | same, conditional |
| `german_roach_knockdown` | **ineligible** · `interior_only_lane` | **spray band** — a false exterior claim | suppressed |
| `termite_treatment` | eligible · `spray` · `requiresPerimeterMethod` | spray band | spray only on perimeter methods |
| `termite_spot_treatment` (drill-and-foam) | **ineligible** · `localized_treatment_lane` | **spray band** | suppressed |

Two lanes currently publish a perimeter spray claim the visit did not perform. The gate flip
is the fix.

---

## 3. Flea and cockroach — no new animation

**Owner ruling 2026-08-09: there is no visual for the residential side of flea or cockroach
treatments.** Interior flea work and interior roach work (German knockdown's bait/IGR lane,
harborage, monitors) get no map — nothing outdoors happened, and a footprint wash over a roof
would read as an exterior claim. This settles the "rooms-treated card" question from the
earlier draft: **not building it.**

*Open:* whether that ruling also retires flea's **lawn** highlight on full-yard broadcast
visits, or applies only to the interior portion. See §8 Q1 — it decides whether `flea` stays
`outline` or becomes ineligible outright.

The roach family's exterior/palmetto lanes keep the spray band they already have; the flip
just adds the exterior-chip condition so a pure-interior visit stops publishing a perimeter.

---

## 4. Termite foam — the trigger question is unchanged

**There is no "Foam" value in the termite `treatment_method` select.** Options are Spot
treatment · Liquid perimeter · Trenching · Bait station setup · Cartridge replacement · Wood
treatment · Other. Drill-and-foam records as "Spot treatment." Any foam-keyed render needs a
truthful trigger, and that is a business-logic call: add "Foam" to the method select, key on
the catalog service key, or infer from products applied. **This blocks the §5 build too.**

---

## 5. Recommended build — mark the treated spots on a photo

The tech photographs the area they actually spot-treated, then taps the treated locations on
that photo. The report renders the photo with the same numbered-pin vocabulary customers
already see on the bait station map.

### Why this beats both foam options

- **The photo is the evidence.** A satellite view can only put a dot on the roof above a wall
  void; the cutaway diagram is honest but **identical for every customer** — an explainer, not
  a record of their visit. A marked photo is *their* home, *this* visit.
- **No geometry problem.** No satellite tile, no lat/lng, no alignment, no perimeter-vs-area
  variant to reason about. It works indoors, in a crawlspace, on a soffit, inside a garage.
- **Marks can never go stale.** The station map needs drift resolution and a `marks_stale`
  bail because Google re-shoots the imagery under saved pins. A photo is immutable — that
  entire failure class disappears.
- **It covers far more than foam.** Every lane the registry rules ineligible *for good reason*
  is a lane with no honest visual today, and most of them are localized work a photo shows
  perfectly.

### The lanes it unlocks

The registry's existing `reason` values become a routing table — this is the neat part, since
the classification work is already done:

| Current `reason` | Lanes | Gets |
|---|---|---|
| `localized_treatment_lane` | `termite_spot_treatment` (drill-and-foam, wood treatment), `bee_wasp_removal`, `mud_dauber_removal` | **marked photo** |
| `exclusion_lane` | `rodent_exclusion` — sealed entry points photograph extremely well | **marked photo** |
| `injection_lane` | `palm_injection` | **marked photo** |
| `bait_station_lane` / `trap_lane` | termite + rodent stations, trapping | station map (already shipping) |
| `interior_only_lane` | bed bug, German knockdown | **nothing** — per §3 ruling |
| `inspection_lane` | all inspections | nothing — no treatment happened |

### What already exists to build on

- **`service_photos`** — carries `caption`, `sort_order`, `zone_id`, `finding_id`,
  `gps_lat`/`gps_lng`, `state_badge`, `thumbnail_key`, `qa_status`, AI tags, and pre-completion
  staging against the scheduled visit.
- **`TechServicePhotosModal`** — already uploads with a type and caption.
- **`StationMapCard`** — numbered pins, staggered pop-in, flash ring, legend, summary line,
  program-scoped copy. The pin language to reuse verbatim.

### What's new

1. **Marks storage.** `service_photo_marks`: `{ id, service_photo_id, n, x, y, kind, label }`.
   Coordinates **normalized 0..1** against the stored image, not pixels — phone photos vary by
   device and orientation.

   > **Constraint: never burn marks into the image.** `service_photos` carries a
   > tamper-evident hash chain (`hash_sha256` / `prev_hash_sha256`, validated on the report
   > path). Re-encoding a photo to bake pins in would break that chain. Marks stay metadata and
   > render as an overlay — which also keeps them editable and keeps the original photo intact.

2. **Tech marking UI.** After upload, tap to drop marks. Far simpler than the zone modal — no
   map, no lat/lng, no alignment, no turf detection. Pinch-zoom for precision on small targets.

3. **Report renderer.** A `MarkedPhotoCard` sibling to `StationMapCard`, sharing the pin
   vocabulary: numbered pins, staggered pop-in, legend, and a settled still for PDFs and
   reduced-motion visitors.

4. **Registry routing.** `trace-eligibility.js` gains a third answer — `photo` alongside
   `spray` and `outline` — so one module still decides what a lane may publish. The coverage
   contract test extends to it.

5. **Copy rules.** A mark states where treatment was applied on this visit. Never an absence
   or elimination claim; the same banned-copy rules the station card follows.

### Effort

| Piece | Size |
|---|---|
| Marks table + write route | S |
| Tech marking UI | M |
| Report card + pin animation | M |
| Registry routing + contract test | S |
| Fixtures / goldens + `ui-verify` | M |

Roughly two PRs, behind a dark gate.

---

## 6. Superseded: the two foam-specific options

Both are in the mock linked at the top, and both are **not recommended** now that §5 covers
the same ground better. Kept here so the reasoning isn't relitigated.

- **Option A — drill points on the aerial.** Technically fine; the blooms read convincingly as
  foam. But the points sit on a roofline and ask the customer to take on faith what happened
  inside the wall. Superseded by a photo of the actual drilled area.
- **Option B — block-wall cutaway.** Honest and genuinely explains *why we drilled*, but it's
  a generic illustration — the same picture for every customer. Possible future use as a
  static explainer beside a marked photo; not a record of a visit.

---

## 7. Rules any of this has to respect

- **Every render decision goes through `trace-eligibility.js`.** That module exists because
  eight render sites once each keyed on display-name strings independently. Don't add a ninth.
- **Presentation must match what was captured** — `report-data.js` already forces a lawn-family
  capture to render as `outline` regardless of the winning verdict. Photo marks need the same
  clamp: marks belong to one photo and must never render over a different one.
- **All-or-nothing, like the station pins** — a partial set of marks publishes a count that
  contradicts the record.
- **Legacy rows are suppressed at render, never deleted or relabeled.**
- **Every mode needs a truthful still** for PDFs and reduced-motion viewers.
- **`ui-verify` before review** on anything touching the rendered report.

---

## 8. Open questions

1. **Does the "no visual for residential flea/cockroach" ruling retire flea's lawn highlight
   too**, or apply only to the interior portion? Decides whether `flea` stays `outline` or
   becomes ineligible.
2. **How does a foam visit identify itself?** Add "Foam" to the termite method select, key on
   the catalog line, or read products applied. Blocks the marked-photo build for foam.
3. **Do marks carry a type** (drilled & foamed / wood treated / nest removed / entry sealed)?
   A typed mark gives an honest legend — and drawing the vocabulary from the completion form's
   recorded method values keeps it from drifting from what was actually done. Recommended.
4. **Are marks required or optional** on the lanes that support them?
5. **Flip `GATE_TRACE_ELIGIBILITY` as a package?** It fixes flea's geometry and stops two lanes
   over-claiming, but moves several lanes in one release.

---

## 9. Sequence

1. Answer Q1 and Q2 — both block code.
2. Flip the eligibility gate (no new code; fixes the two over-claiming lanes).
3. Build the marked-photo rail; foam is its first lane, exclusion and nest removal follow.
4. Revisit the cutaway only if a static "why we drill" explainer is wanted later.
