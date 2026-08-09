# Termite Foam — Marked-Photo Treatment Visual

**Date:** 2026-08-08, revised 2026-08-09 · **Status:** scope for owner sign-off. No code changes in this doc.

**Visual mock:** https://claude.ai/code/artifact/f8082d1d-2044-4c32-94cd-20a10cabddc6 — the two
satellite-based options, superseded but kept for reference (§6).

**Direction (owner, 2026-08-09):** photograph the area actually spot-treated and mark the
treated locations on that photo, the way bait station pins are marked today. Scope is
**termite foam only** — flea and cockroach are settled in §3 and out of scope.

---

## 1. The foam identity question is already answered

The earlier draft asked how a foam visit identifies itself and called it a blocker. **It
shipped the same day** — PR #3306, "Termite foam: full service identity," merged 2026-08-08.

- **Catalog rows** `foam_drill` (one-time) and `foam_recurring` (recurring, standalone) under
  `category: termite`, inserted by migration `20260808070000_foam_termite_catalog_rows.js`.
- **Classifier** routes the drill-and-foam forms to **termite** across all four detector
  mirrors — deliberately *not* on a bare `foam` substring, since "Rodent Exclusion – Foam
  Sealing" is rodent-exclusion material and stays rodent.
- **Completion profile** for both keys: `service_report / termite_treatment / auto_send`.
- `booking_enabled: false` on both — foam is priced by **drill-point count**, assessment-first,
  and only enters the schedule when an estimate carrying a foam line is accepted.

**So the trigger is the catalog service key, not a method-select value.** No change to the
termite `treatment_method` options is needed, and none should be made — the options list stays
`Spot treatment · Liquid perimeter · Trenching · Bait station setup · Cartridge replacement ·
Wood treatment · Other`, with `percent_solution` required for the liquid-dilution ones.

Two facts from that PR shape everything below:

1. **Zero foam visits all-time** as of 2026-08-08 (verified against prod). There is no legacy
   foam data to suppress or migrate — a genuinely clean slate.
2. **Foam is priced by drill-point count.** The marks on the photo are the same unit as the
   price. That's a strong argument for marking being the natural record of the job — though the
   marks should stay a *visual record*, not a billing input.

---

## 2. How a foam visit resolves in the eligibility registry today

`trace-eligibility.js` decides `{ eligible, variant, captionKey, reason }` per lane, typed
`findingsType` first and catalog `serviceKey` second, behind **`GATE_TRACE_ELIGIBILITY`
(currently dark)**.

Foam completes as the typed `termite_treatment` findings type — the **same typed pointer as
liquid perimeter and trenching**. That rule is:

```
termite_treatment: { eligible: true, variant: 'spray',
                     captionKey: 'sprayPerimeter', requiresPerimeterMethod: true }
```

| | Behavior |
|---|---|
| **Gate ON** | Foam records a non-perimeter method, so `requiresPerimeterMethod` suppresses the map. Correct — no false perimeter claim. |
| **Gate OFF (today)** | The legacy path suppresses only bed bug and rodent trapping, so a foam visit **can still publish a perimeter spray band** if a tech traces one. Same defect class as `german_roach_knockdown` and `termite_spot_treatment`. |

`foam_drill` and `foam_recurring` are **not** in `SERVICE_KEY_RULES`. That's safe today — the
registry's default is ineligible — and it does **not** break the coverage contract test, which
enumerates only the generic lanes the completion-lane registry names, and foam is typed rather
than generic. But it does mean foam has no positive classification of its own yet.

### The routing this needs

Typed lanes are evaluated first, and the module is explicit that *a typed lane's verdict must
not depend on which catalog key routed to it*. Since foam shares `termite_treatment` with the
perimeter methods, routing foam to a photo variant needs the catalog key to win:

```
foam_drill:     { eligible: true, variant: 'photo', captionKey: 'foamPoints',
                  overridesSnapshot: true }
foam_recurring: { eligible: true, variant: 'photo', captionKey: 'foamPoints',
                  overridesSnapshot: true }
```

`overridesSnapshot` is the mechanism `fire_ant`, `tick_control`, and `pest_re_service` already
use for exactly this — the catalog key's geometry is more specific than a shared typed pointer.
So this fits an established pattern rather than inventing one.

---

## 3. Flea and cockroach — settled, out of scope

**Owner ruling 2026-08-09: there is no visual for the residential side of flea or cockroach
treatments.** No rooms-treated card, no interior footprint wash. Nothing outdoors happened on
those visits, and a wash over a roof would read as an exterior claim.

The registry entries for `flea`, `cockroach`, `palmetto_roach_knockdown`, and
`german_roach_knockdown` are unchanged by this scope. Whether flea's full-yard lawn highlight
also retires is a separate decision, not needed for the foam build.

---

## 4. What exists to build on

**Station pins (the vocabulary to reuse).** `StationMapCard.jsx` renders numbered pins with
staggered pop-in, a flash ring, a legend, and a summary line; the server contract is
`termite-stations.js → buildStationMapReportContext`, returning `{ available, reason }` and pins
shaped `{ id, number, label, cx, cy, status }` in **image space**.

Two rules worth carrying over verbatim:

- **All-or-nothing.** A single dropped pin suppresses the whole map rather than publishing a
  summary that contradicts the findings.
- **Image drift is a real failure mode.** `resolveZoneRowsImageDrift` exists because Google
  re-shoots the satellite tile under saved pins, and a stale mark bails out with `marks_stale`.
  **A photo is immutable, so marking a photo deletes this entire failure class.**

**Photos.** `service_photos` already carries `caption`, `sort_order`, `zone_id`, `finding_id`,
`gps_lat`/`gps_lng`, `state_badge`, `thumbnail_key`, `qa_status`, AI tags, and pre-completion
staging against the scheduled visit. `TechServicePhotosModal` already uploads with a type and
caption.

---

## 5. The build

### 5.1 Marks storage

New `service_photo_marks`: `{ id, service_photo_id, n, x, y, kind, label }`.

Coordinates **normalized 0..1** against the stored image, never pixels — phone photos vary by
device and orientation.

> **Constraint: never burn marks into the image.** `service_photos` carries a tamper-evident
> hash chain (`hash_sha256` / `prev_hash_sha256`, validated on the report path). Re-encoding a
> photo to bake pins in would break that chain. Marks stay metadata and render as an overlay —
> which also keeps them editable and the original photo intact.

### 5.2 Tech marking UI

After upload, tap to drop marks. Far simpler than the zone modal — no map, no lat/lng, no
alignment, no turf detection. Pinch-zoom for precision on small targets like a drill hole in a
mortar joint.

### 5.3 Report renderer

A `MarkedPhotoCard` sibling to `StationMapCard`, sharing the pin vocabulary: numbered pins,
staggered pop-in, legend, and a settled still for PDFs and reduced-motion visitors.

### 5.4 Registry routing

`trace-eligibility.js` gains a third variant, `photo`, alongside `spray` and `outline`, plus the
two foam keys from §2. One module still decides what each lane may publish. The coverage
contract test extends to the new variant.

### 5.5 Copy

A mark states where treatment was applied on this visit — never an absence or elimination claim,
same banned-copy rules the station card follows. Proposed caption:

> Foam was injected at the marked points during today's visit.

### Effort

| Piece | Size |
|---|---|
| Marks table + write route | S |
| Tech marking UI | M |
| Report card + pin animation | M |
| Registry routing (`photo` variant + two foam keys) + contract test | S |
| Fixtures / goldens + `ui-verify` | M |

Roughly two PRs, behind a dark gate.

### Where it goes next

Once the rail exists, it's the honest visual for every lane the registry rules ineligible *for
good reason*: `localized_treatment_lane` (wood treatment, `bee_wasp_removal`,
`mud_dauber_removal`), `exclusion_lane` (`rodent_exclusion` — sealed entry points photograph
extremely well), and `injection_lane` (`palm_injection`). Foam is the first lane, not the only
one. Interior lanes stay excluded per §3.

---

## 6. Superseded: the two satellite-based foam options

Both are in the mock; neither is recommended.

- **Option A — drill points on the aerial.** The blooms read convincingly as foam, but the
  points sit on a roofline and ask the customer to take on faith what happened inside the wall.
- **Option B — block-wall cutaway.** Honest, and it genuinely explains *why we drilled* — but
  it's the same illustration for every customer. An explainer, not a record of a visit. Possible
  future use as a static diagram beside a marked photo.

---

## 7. Rules any of this has to respect

- **Every render decision goes through `trace-eligibility.js`** — that module exists because
  eight render sites once each keyed on display-name strings independently.
- **Presentation must match what was captured.** `report-data.js` already forces a lawn-family
  capture to render as `outline` regardless of the winning verdict; marks need the same clamp so
  they can never render over a different photo than the one they were placed on.
- **All-or-nothing marks**, like the station pins.
- **Legacy rows are suppressed at render, never deleted or relabeled.** (Moot for foam — zero
  visits all-time.)
- **Every mode needs a truthful still** for PDFs and reduced-motion viewers.
- **`ui-verify` before review** on anything touching the rendered report.

---

## 8. Open questions

1. **Do marks carry a type** (drilled & foamed / wood treated / nest removed / entry sealed)? A
   typed mark gives an honest legend, and drawing the vocabulary from the completion form's
   recorded values keeps it from drifting from what was done. **Recommended.**
2. **Are marks required or optional** on a foam visit?
3. **Flip `GATE_TRACE_ELIGIBILITY` as a package?** Independent of this build, but it's what
   stops foam and the two other lanes from publishing a perimeter band they didn't perform.

---

## 9. Sequence

1. Answer Q1 and Q2 — both are small and both shape the schema.
2. Flip the eligibility gate (no new code; stops the over-claiming lanes).
3. Build the marked-photo rail with foam as its first lane.
4. Extend to exclusion, nest removal, and palm injection.
