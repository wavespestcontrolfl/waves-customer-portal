# Treatment Animation Scope — Termite Foam, Flea, Cockroach

**Date:** 2026-08-08 · **Status:** scope for owner sign-off. No code changes in this doc.

**Visual mock:** https://claude.ai/code/artifact/f8082d1d-2044-4c32-94cd-20a10cabddc6 — live
animations for both foam options beside the two that already ship, rendered with the real
engine algorithms over a synthetic aerial.

The ask: what do we do today with the traced spray and the lawn on service reports,
and what would an animation look like for termite foam, flea, and cockroach.

Short version: **two of the three are already built and sitting behind a dark gate.**
Flea's geometry is already corrected to the lawn treatment, and the roach family is
already split exterior-vs-interior. **Termite foam is the only genuinely new
animation**, and it needs a geometry we have never built: points, not a path.

---

## 1. What exists today — three animation rails

### Rail A — Traced Treatment Zone (path geometry)

The one the owner means by "the tray spray and the lawn."

**Capture** — `client/src/components/tech/TechTreatmentZoneModal.jsx` driving
`client/src/components/tech/treatmentZoneSpray.js` (deliberately React-free canvas +
`requestAnimationFrame`, so the same engine could back a server-side renderer later).
The tech traces on a Google Static Maps satellite tile (zoom 21→19, 1280×960 physical
px, optional rotate-to-square-the-home alignment).

Four persisted capture modes:

| `capture_mode` | Geometry | Animation |
|---|---|---|
| `perimeter` | open or closed path | spray-mist band stamped along the line, drifting puffs, Waves mascot riding the head as the emitter, then the whole band breathes |
| `interior` | closed footprint (tech ticks "Interior spray too") | perimeter band **plus** the footprint flooded with a soft brand-blue wash |
| `lawn_highlight` | closed loop | per-pixel turf detection inside the loop (region-grown from confidently-green seeds), luminous blue highlight, sweep-reveal with a shimmer on the front edge, then breathes |
| `lawn` | closed loop | fallback when the imagery isn't pixel-readable: clean 3-stroke outline draws itself in, then pulses |

**Persistence** — `treatment_zone_maps`: `snapshot_s3_key` (satellite + settled
animation baked in), `mask_s3_key` (the transparent highlight layer, lawn only),
`path_points` (px **and** lat/lng), `closed_loop`, `linear_ft`, `capture_mode`.

**Report replay** — `client/src/components/report/TracedTreatmentZoneMap.jsx`. Note
this is a **separate SVG/CSS reimplementation** of the same story, not the canvas
engine. It mounts only after IntersectionObserver fires on a motion-tolerant screen,
so PDFs and reduced-motion visitors keep the baked still. Rendered from
`ReportViewPage`, `PestReportV2`, and `PestReportV2Section`.

**The registry** — `server/services/service-report/trace-eligibility.js`. One module
decides `{ eligible, variant, captionKey, reason }` for every lane, keyed on typed
`findingsType` first and catalog `serviceKey` second. Today it knows exactly **two
variants**: `spray` and `outline`; two captions: `sprayPerimeter` and `lawnCoverage`.
Unrecognized services are ineligible by design. It is behind
**`GATE_TRACE_ELIGIBILITY`, currently dark.**

### Rail B — Station / trap map (point geometry)

`client/src/components/StationMapCard.jsx`. Numbered pins over the live satellite
image with staggered pop-in, a snap flash ring, and a rat scurry on captures. Termite
bait, rodent bait, and trapping programs. No tech tracing — pins come from the station
registry. **This is our only existing precedent for animating points rather than a
path**, and it's the closest template for foam.

### Rail C — Visit recap MP4 (Remotion)

`recap-pipeline.js` → `video/VisitRecap.jsx`. A 28-second composition rendered in an
isolated child process and queued/stored like the PDF. Driven off the same
`buildPestReportV2` payload as the report. Phase 1 is **pest service line only**.

**The architectural fact that governs everything below:** Rail A understands paths.
Rail B understands points. Nothing we have understands rooms or wall voids.

---

## 2. Where the three asks actually stand

Two behaviors matter per lane: what renders **today** (gate off — the legacy path
suppresses *only* bed bug and rodent trapping), and what renders **after the flip**.

| Lane | Registry entry today | Renders now (gate off) | After the flip |
|---|---|---|---|
| `flea` | eligible · `outline` · `lawnCoverage` · `requiresExteriorChip` | **spray band** — the legacy client fallback is `serviceLine === 'lawn' ? outline : spray` | lawn highlight / outline, and only with the exterior chip recorded |
| `cockroach` | eligible · `spray` · `requiresExteriorChip` | spray band | spray band, conditional on the recorded exterior chip |
| `palmetto_roach_knockdown` | eligible · `spray` · `requiresExteriorChip` | spray band | same, conditional |
| `german_roach_knockdown` | **ineligible** · `interior_only_lane` | **spray band** — a false exterior claim on an interior bait/IGR visit | suppressed |
| `termite_treatment` | eligible · `spray` · `requiresPerimeterMethod` | spray band | spray only when the method is Liquid perimeter or Trenching |
| `termite_spot_treatment` (the drill-and-foam catalog line) | **ineligible** · `localized_treatment_lane` | **spray band** | suppressed |

Read the bold cells together: the gate flip is not just a feature toggle. It is
currently the fix for two lanes that publish a perimeter spray claim the visit did
not perform.

---

## 3. Flea — no new animation needed

The registry already rules flea as `outline` / `lawnCoverage`, on the reasoning that
the live `flea_tick` service is a full-yard broadcast with interior as the add-on, and
the form records "Lawn treatment." The treated area is the yard, not the building line.

**So flea's animation is the lawn highlight we already ship.** It arrives with the
gate flip, not with new code.

- **New animation work: none.**
- **Work required:** verification. Confirm the exterior chip the condition keys on
  matches the flea schema; confirm the tech-side capture button copy ("Outline the
  treated lawn") reads right on a flea job; run the `ui-verify` pass on a real
  rendered flea report.

**Owner question:** an interior-only flea visit (pet areas, no yard work) currently
gets **no map at all** rather than an interior render. Confirm that's what you want.

---

## 4. Cockroach — the exterior is done; the interior is the open question

Exterior and palmetto roach already animate as the spray band; the flip only adds the
honesty condition so a pure-interior bait visit stops publishing a perimeter.

German knockdown is deliberately ineligible — it's an interior bait/IGR program
(rooms, harborage, prep) with no exterior work in its treatment choices at all. If we
want *something* animated there, satellite is the wrong canvas: there is nothing
outdoors to show.

Three options, in order of what I'd recommend:

1. **Nothing (recommended for now).** The lane's story is rooms, monitors, and the
   10–14 day follow-up — none of it spatial from above.
2. **Rooms-treated motion card.** No geometry, no imagery, no capture UI. The lane
   already collects `rooms_treated`, `primary_harborage`, and `monitors_placed`; a
   small animated card can tell that story truthfully. New component, but nothing
   touches the map stack.
3. **Reuse the `interior` capture mode** — let German knockdown capture a
   footprint-only trace and render just the wash. Cheapest in code (the mode already
   exists and bakes) but weakest and riskiest: a blue wash over a roof is close to the
   same false-exterior reading the lane was made ineligible for.

Either way this is its own scope, not a rider on foam.

---

## 5. Termite foam — the real new build

**What foam physically is:** drill points into wall voids, block cells, or the slab,
with foam expanding to fill the void. The geometry is **points with depth** — not a
line, not an area. That is exactly why the registry files it as
`localized_treatment_lane`.

### Blocker to settle first

**There is no "Foam" value in the termite `treatment_method` select.** The options are
Spot treatment · Liquid perimeter · Trenching · Bait station setup · Cartridge
replacement · Wood treatment · Other. Drill-and-foam completions currently record as
"Spot treatment." Any foam-keyed render needs a truthful trigger, and picking one is a
business-logic call, not mine to guess (rule 3). Options: add "Foam" to the method
select, key on the catalog service key, or infer from products applied.

### Proposal — Rail A′: treatment points

- **Capture:** a new `points` mode in `TechTreatmentZoneModal` where the tech *taps*
  drill locations instead of tracing. Reuses the map load, zoom, alignment, and
  px→lat/lng math verbatim. Reuses the `path_points` column as-is (points already
  store both px and lat/lng); `closed_loop = false`, `linear_ft = null`.
- **Engine:** a new bloom mode in `treatmentZoneSpray.js`. Per point, a bright core
  expanding into a soft irregular blob that **settles and holds** — foam expands into
  a void, it doesn't drift like mist. Staggered by index the way the station pins
  already stagger. Must bake a settled frame into the snapshot for PDFs.
- **Report:** a new `points` variant + `foamPoints` caption key in the registry, and a
  render branch in `TracedTreatmentZoneMap` — SVG circles with a scale/opacity
  keyframe and per-index `animation-delay`, the same pattern `StationMapCard` uses.
- **Registry:** `termite_spot_treatment` becomes eligible with `variant: 'points'`,
  conditional on whatever we settle as the foam trigger. `termite_treatment` keeps
  `requiresPerimeterMethod` for its spray variant and gains a foam condition for the
  points variant.

### The risk worth naming before we build

A satellite photo cannot show a wall void. The points will sit on a roof or wall line
seen from above, and the caption has to carry the honesty — "foam was injected at the
marked points," never "treated area." **Worth building a static mock and looking at it
before committing to the capture UI.** It's also fair to ask whether a photo of the
actual drill points tells the story better than a map does.

### Rough effort

| Piece | Size |
|---|---|
| Foam trigger field + registry condition | S |
| `points` capture mode in the modal | M |
| Engine bloom mode + baked settled frame | M |
| Report SVG branch + caption | S |
| Registry rules + coverage contract test | S |
| Fixtures / goldens + `ui-verify` pass | M |

Roughly two PRs, both behind the same dark gate.

---

## 6. Rules any of this has to respect

- **Every render decision goes through `trace-eligibility.js`.** That module exists
  precisely because eight render sites once each keyed on display-name strings
  independently. Do not add a ninth switch.
- **Presentation must match the captured bitmap.** `report-data.js` already forces a
  lawn-family capture to render as `outline` even when the winning verdict came from a
  spray add-on line — the saved bitmap cannot honestly wear the other animation's
  copy. A `points` capture needs the same clamp.
- **Legacy rows are suppressed at render, never deleted or relabeled.**
- **Every new mode needs a baked settled frame** — PDFs and reduced-motion visitors
  must get a truthful still, not a blank or an arbitrary animation frame.
- **Banned customer copy applies to every new caption** — observation-scoped wording,
  no absence or elimination claims.
- **`ui-verify` before review** on anything that touches the rendered report.

---

## 7. Recommended sequence

1. **Flip `GATE_TRACE_ELIGIBILITY`.** Delivers flea's correct lawn geometry, adds the
   exterior condition to the roach family, and stops two lanes from publishing spray
   claims they can't support. No new code — but it changes several lanes at once, so
   it's a package decision.
2. **Settle the foam trigger** and look at a static mock of the points render.
3. **Build Rail A′** if the mock reads right.
4. **Interior roach story** separately, if at all.

---

## 8. Open questions for the owner

1. **Foam trigger** — add "Foam" to the termite method select, key on the catalog
   service key, or infer from products?
2. **Does a drill-point map earn its place** on a customer report, or is a photo of
   the drill points the better artifact?
3. **Interior roach (German knockdown)** — build the rooms card, or leave it alone?
4. **Flea interior-only visits** — no map at all is the current behavior. Confirm.
5. **Is the gate flip ready to ship as a package**, given it changes flea, the roach
   family, termite methods, and several other lanes in one move?
