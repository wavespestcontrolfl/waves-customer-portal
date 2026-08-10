# Termite Foam — Marked-Photo Treatment Visual

**Date:** 2026-08-08, revised 2026-08-09 · **Status:** scope for owner sign-off. No code changes in this doc.

**Visual mock — the build:** https://claude.ai/code/artifact/042796a8-3fdd-43e4-8ae6-ab65e467c0d3
— the marked-photo card as the customer sees it, the count rule shown side by side, the
no-marks state, and the tech marking screen.

**Visual mock — superseded:** https://claude.ai/code/artifact/f8082d1d-2044-4c32-94cd-20a10cabddc6
— the two satellite-based options, kept for reference (§6).

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

`kind` is **not null** — every mark is typed (owner ruling 2026-08-09, §5.2).

> **Constraint: never burn marks into the image.** `service_photos` carries a tamper-evident
> hash chain (`hash_sha256` / `prev_hash_sha256`, validated on the report path). Re-encoding a
> photo to bake pins in would break that chain. Marks stay metadata and render as an overlay —
> which also keeps them editable and the original photo intact.

### 5.2 Marks are typed (owner ruling)

Every mark carries a `kind` from a **closed, per-lane vocabulary**, validated server-side
against the visit's lane so a rodent-exclusion kind can never appear on a termite report. The
vocabulary is **derived from the completion form's own recorded values**, not invented for the
map — that's what keeps the legend from drifting away from what was actually recorded.

For the foam lane (`foam_drill` / `foam_recurring`, typed `termite_treatment`):

| `kind` | Legend label | Derived from |
|---|---|---|
| `foam_injection` | Drilled & foamed | the catalog key — this is the job |
| `spot_treatment` | Spot treated | `treatment_method: 'Spot treatment'` |
| `wood_treatment` | Wood treated | `treatment_method: 'Wood treatment'` |

`foam_injection` is the default on a foam visit. The other two exist because the shared termite
form legitimately records them on the same stop.

When the rail extends to other lanes (§ "Where it goes next"), each gets its own list drawn the
same way — `rodent_exclusion` from its `Sealed entry point` / `Installed hardware cloth / mesh`
/ `Installed sealant / foam / backer` values, and so on. **One rule: a kind must correspond to a
value the completion form can actually record.** No kind exists that the tech has no way to
have recorded.

### 5.3 Marks are optional — and that changes the copy

Marks are **not required** (owner ruling 2026-08-09). A foam visit with no marks is a normal,
complete visit.

- **No marks → no card.** The photo stays an ordinary gallery photo, exactly as today. No empty
  state, no "marks missing" affordance, nothing in the report that implies something is absent.
- **Marks are a highlight, never an inventory.**

> **The count rule.** This is where optional marks and drill-point pricing collide: foam is
> **priced by drill-point count**, so if the card ever states or implies a total, a customer can
> count 4 marks against a job billed for 12 points and reasonably conclude they were overbilled.
> Since marks are optional and need not be exhaustive, **the marked-photo card must never state
> a count or a total** — no "8 points treated," no "4 of 4."
>
> This is a deliberate divergence from the station card we're borrowing the pin vocabulary from.
> `StationMapCard` *does* state counts ("8 of 8 stations inspected") because stations are an
> exhaustive registry with a row per station. Marks are not a registry. Same pins, different
> claim — and the caption has to carry that difference.

**All-or-nothing still applies, for a narrower reason.** Not "every foam visit must have marks,"
but: if any stored mark on a photo fails to resolve, suppress the whole card rather than render
a subset. A partial render would silently understate what the tech recorded, and the tech's
record and the customer's view would disagree.

### 5.4 Tech marking UI

After upload, tap to drop marks. Far simpler than the zone modal — no map, no lat/lng, no
alignment, no turf detection. Pinch-zoom for precision on small targets like a drill hole in a
mortar joint.

### 5.5 Report renderer

A `MarkedPhotoCard` sibling to `StationMapCard`, sharing the pin vocabulary: numbered pins,
staggered pop-in, legend, and a settled still for PDFs and reduced-motion visitors.

### 5.6 Registry routing

`trace-eligibility.js` gains a third variant, `photo`, alongside `spray` and `outline`, plus the
two foam keys from §2. One module still decides what each lane may publish. The coverage
contract test extends to the new variant.

### 5.7 Copy

A mark states where treatment was applied on this visit — never an absence or elimination claim,
same banned-copy rules the station card follows, and never a count (§5.3).

Proposed caption, revised for the count rule:

> Foam was injected at the points your technician marked on this visit.

The earlier draft said *"at the marked points,"* which reads as a definite, complete set. With
optional marks and drill-point pricing, "the points your technician marked" is the honest
phrasing — it attributes the marks to the tech's record without asserting they are all of them.

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

## 7a. Known limitation — foam must be a LINKED visit

Foam resolves to the photo lane by its **catalog service key** (`foam_drill` /
`foam_recurring`). The registry's display-name fallback deliberately does **not**
recognise foam names: unknown names resolve to `unclassified_service`, which is the
module's fail-closed bias ("no claim until classified"), and adding a name regex would
widen eligibility on editable text.

Consequence: a foam visit with **no `service_id` link** gets no marked-photo card. It
is also ineligible for a satellite trace, so it cannot make a false claim — the failure
is a missing card, not a wrong one, which is the right direction.

Not reachable today: `booking_enabled: false` on both foam keys, the estimate converter
resolves `foam_recurring` through `remainingUnitCatalogKey` so accepted estimates
schedule *with* `service_id`, and there are zero foam visits all-time. Worth knowing if
a foam visit is ever hand-created on the schedule without linking the catalog row.

---

## 8. Decisions on record

| | Ruling | Date |
|---|---|---|
| Approach | Mark treated spots on a photo of the area, reusing the bait-station pin vocabulary | 2026-08-09 |
| Foam trigger | Catalog service key (`foam_drill` / `foam_recurring`) — shipped in #3306, no method-select change | 2026-08-08 |
| Marks typed | **Yes** — closed per-lane vocabulary drawn from the completion form's recorded values (§5.2) | 2026-08-09 |
| Marks required | **No** — optional; no marks means no card, and the card never states a count (§5.3) | 2026-08-09 |
| Flea / cockroach | No visual for the residential side; out of scope | 2026-08-09 |

**Still open:** whether to flip `GATE_TRACE_ELIGIBILITY` as a package. Independent of this
build, but it's what stops foam and two other lanes from publishing a perimeter band they didn't
perform.

---

## 9. Sequence

1. Build the marked-photo rail with foam as its first lane — nothing blocking.
2. Flip the eligibility gate (no new code; stops the over-claiming lanes). Can land before,
   after, or alongside.
3. Extend to exclusion, nest removal, and palm injection.
