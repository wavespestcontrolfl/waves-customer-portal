# Specialty Phase 2 — Owner Spec (Adam, 2026-06-12)

Verbatim owner specification for the Phase 2 typed-completion program. This is
the authoritative content source for the typed forms below — field lists,
option vocabularies, customer-facing templates, and wording rules come from
this document and must not be invented or extended without owner sign-off.

Split: **Phase 2 cutover work** (typed forms already exist) vs **new typed
form work** (build before cutover).

Owner recommendation summary:

- Cut over rodent family + flea now because typed forms already exist.
- Build Tree & Shrub typed checklist before cutover because generic reports
  are too weak for that service.
- Build bee/wasp-specific form eventually, but it is lower priority than
  Tree & Shrub.
- Add cockroach knockdown profiles now because German vs. palmetto/large
  roach service notes are meaningfully different.

## Priority order (owner)

1. **Tree & Shrub typed checklist** — recurring, customer-visible, currently
   generic, legacy hard-block is awkward. Biggest client-experience gap.
2. **German cockroach knockdown profile** — high callback risk, needs
   customer prep language, not safe as generic.
3. **Rodent family cutover** — forms exist, but exclusion/sanitation modules
   must be good enough before flipping all nine keys.
4. **Flea cutover** — form exists, lower complexity, aftercare language
   matters.
5. **Bee/wasp-specific form** — useful; generic one-time form acceptable
   short-term.

Owner's biggest critique: *do not graduate the whole rodent family just
because "a rodent form exists." Rodent trapping, exclusion, sanitation,
inspection, and bait stations are different service stories. They can share
one registry family, but the customer report needs conditional modules so
the output does not flatten everything into "rodent service completed."*

---

## 1. Rodent Exclusion Typed Checklist

Not the same report shape as rodent trapping. Exclusion is a
repair/prevention service: emphasize entry points sealed, materials used,
areas inaccessible, and remaining risks.

**Inspection / work areas:** Roofline; Soffit/fascia; Garage; Exterior
perimeter; AC/utility penetrations; Vents; Doors; Lanai/pool cage;
Crawlspace; Attic access; Other.

**Entry points addressed:** Garage door gaps; AC line penetration;
Plumbing/electrical penetration; Roof return gap; Soffit/fascia gap;
Vent/screen opening; Door sweep gap; Weep hole/open masonry gap; Foundation
gap; Other.

**Work completed:** Sealed entry point; Installed hardware cloth/mesh;
Installed sealant/foam/backer; Repaired screen/vent; Installed door
sweep/seal; Reinforced opening; Temporary seal; Permanent exclusion repair;
Inspection only.

**Materials used:** Hardware cloth; Rodent-proof mesh; Sealant; Foam + mesh
backing; Sheet metal; Door sweep/weatherstrip; Vent cover; Concrete/mortar
patch; Other.

**Remaining concerns:** Activity still present; Trapping still active; Area
inaccessible; Structural repair needed by others; Tree limbs touching roof;
Garage seal replacement needed; Customer declined repair; Moisture/sanitation
concern; No remaining concerns observed.

**Follow-up:** Continue trapping; Monitor for new activity; Return for
additional exclusion; Sanitation recommended; Customer repair needed; No
follow-up needed.

**Customer-facing summary template:**

> Completed rodent exclusion work today around [areas]. Entry points
> addressed included [entry points]. Repairs completed: [work
> completed/materials].
> Remaining concerns: [remaining concerns or none noted].
> Recommendation: [customer action].
> Next step: [continue trapping/monitor/return/sanitation/no further action].

**Strong example:**

> Completed rodent exclusion work around the garage and right-side exterior
> wall. Sealed the AC line penetration and reinforced a gap near the rear
> garage corner using rodent-resistant mesh and sealant. Tree limbs are
> still touching the roofline, which may provide future access and should be
> trimmed back. Recommend continuing trapping/monitoring before final trap
> removal.

**Key wording rule:** Do not say "Home is rodent-proof." Use "Repairs were
completed to reduce rodent access and help prevent re-entry."

## 2. Rodent Sanitation Typed Checklist

A health/safety cleanup report, not a pest-control treatment report. Needs
before/after clarity. Applies to the sanitation tiers (light / standard /
heavy — owner wrote "moderate"; the prod key is `rodent_sanitation_standard`).

**Areas serviced:** Attic; Garage; Closet; Kitchen area; Under sink;
Laundry; Storage area; Crawlspace; Exterior area; Other.

**Contamination level:** Light; Moderate; Heavy; Severe / office review
needed.

**Evidence cleaned:** Droppings; Urine staining; Nesting material; Dead
rodent/remains; Odor source; Contaminated insulation; Food debris; Other.

**Work completed:** Removed droppings; Removed nesting material; Removed
dead rodent; HEPA vacuum / controlled cleanup; Disinfected/sanitized
affected areas; Deodorized affected areas; Bagged/disposed contaminated
debris; Insulation removal recommended; Limited cleanup due to access.

**Limitations:** Area not fully accessible; Heavy storage limited cleaning;
Insulation contamination remains; Electrical/HVAC obstruction; Customer
items could not be moved; PPE/safety limitation; No limitations.

**Recommendation:** Continue trapping; Complete exclusion; Replace
contaminated insulation; Reduce clutter; Store food/pet food sealed;
Monitor odor; Additional sanitation recommended.

**Customer-facing summary template:**

> Completed rodent sanitation service in [areas]. Contamination level was
> [level]. We removed/treated [evidence cleaned] and completed [work
> completed].
> Limitations: [limitations or none].
> Recommendation: [customer action].
> Next step: [continue trapping/exclusion/monitor/additional sanitation].

**Strong example:**

> Completed moderate rodent sanitation in the accessible attic area above
> the garage. Removed droppings and nesting material, cleaned affected
> surfaces, and deodorized the service area. Some insulation staining
> remains in areas that were not safely accessible around HVAC lines.
> Recommend completing exclusion repairs and continuing monitoring before
> considering trap removal.

## 3. Rodent Trapping Combo Keys

Use the existing rodent_trapping form with conditional add-on sections
depending on the combo. Avoid totally separate forms: **base rodent
trapping checklist + optional exclusion/sanitation modules**.

Base trapping required fields: Traps checked; Captures; Activity level;
Evidence found; Active locations; Traps reset/relocated; Entry points
observed; Customer recommendations; Follow-up window.

Add if combo includes exclusion: Entry points sealed; Materials used;
Remaining access concerns; Exclusion follow-up needed.

Add if combo includes sanitation: Areas cleaned; Contamination level;
Evidence removed; Sanitation limitations; Additional cleanup needed.

**Customer-facing combo example:**

> Checked and reset 6 rodent traps today. One capture was removed from the
> attic near the garage wall. Fresh droppings were still present near the
> same area, so trapping should continue. Also completed exclusion work at
> the right-side AC line penetration using rodent-resistant mesh and
> sealant. Recommend trimming vegetation away from the roofline and
> rechecking traps in 5–7 days.

## 4. Rodent Inspection / General One-Time

Should not auto-create a heavy project feel unless findings justify it.
Diagnostic and sales-supportive.

Required fields: Areas inspected; Activity found (Yes/No); Evidence type;
Suspected rodent type (Rat/Mouse/Unknown); Entry points found; Conducive
conditions; Interior concern (Yes/No); Exterior pressure (Yes/No); Photos
taken; Recommended service; Urgency (Routine/Soon/High).

**Customer-facing example:**

> Completed rodent inspection of the exterior perimeter, garage, attic
> access area, and accessible interior areas. Rodent droppings were observed
> in the garage near stored items, and a possible entry gap was noted near
> the right-side AC line. Recommend starting a rodent trapping program with
> exclusion repairs after activity is reduced.

## 5. Flea Typed Checklist

Cut over with rodent Phase 2. Flea reports must make customer cooperation
very clear — treatment alone underperforms if vacuuming, pets, and yard
conditions are ignored.

**Evidence/activity level:** None observed; Suspected; Light; Moderate;
Heavy.

**Activity areas:** Interior; Exterior lawn; Pet resting area; Shaded yard;
Lanai; Around bedding; Carpet/rugs; Furniture; Garage; Other.

**Treatment completed:** Exterior flea treatment; Interior flea treatment;
Growth regulator; Crack/crevice treatment; Lawn treatment; Pet resting area
treatment; Inspection only; Limited treatment.

**Contributing conditions:** Pets present; Wildlife activity; Shaded/moist
yard; Tall grass; Pet bedding; Rugs/carpet; Vacuuming needed; Untreated
pets; Access limitation.

**Customer prep / aftercare:** Vacuum daily for 2 weeks; Wash pet bedding;
Treat pets through veterinarian; Keep grass mowed; Avoid washing treated
areas immediately; Keep people/pets off until dry; Follow-up recommended.

**Customer-facing example:**

> Completed flea treatment in the exterior lawn and pet resting areas. Flea
> activity level was moderate, with activity noted in shaded areas near the
> rear patio. Treatment included targeted exterior application and growth
> regulator support. Recommend vacuuming daily for 2 weeks, washing pet
> bedding, and keeping pets on a veterinarian-approved flea prevention plan.
> Follow-up may be needed depending on activity.

## 6. Tree & Shrub Typed Checklist

The biggest gap. Generic reports are not good enough — the customer needs
plant-health storytelling: what plants look like, what was applied, what
pests/disease/deficiencies were seen, and what should improve over time.

One typed form with modules: **Tree/Shrub Base + Palm Module + Bed/Weed
Module + Injection Module**.

**Plant groups serviced:** Palms; Shrubs; Ornamentals; Hedges; Small trees;
Flowering plants; Groundcover beds; Other.

**Overall landscape condition:** Excellent; Good; Fair; Poor; Declining;
Recovering.

**Observed plant conditions:** Healthy/new growth; Yellowing/chlorosis;
Leaf spot; Scale; Mealybug; Aphids; Whitefly; Mites; Caterpillar damage;
Sooty mold; Fungal pressure; Nutrient deficiency; Drought stress;
Overwatering stress; Pruning stress; Freeze/cold damage; Salt/wind stress;
No major issues observed.

**Treatment completed:** Fertilizer; Palm fertilizer; Micronutrients;
Insect treatment; Disease/fungicide treatment; Horticultural oil; Soil
drench; Foliar treatment; Pre-emergent bed treatment; Weed spot treatment;
Soil amendment/acidifier; Inspection only.

**Palm-specific module** (use when palms are present): Number of palms
serviced; Palm condition (Good/Fair/Poor/Declining); Nutrient stress
(Yes/No); Spear leaf condition (Firm/Soft/Pulling/Not checked); Canopy
density (Full/Moderate/Thin/Declining); Trunk concern (Yes/No); Visible
Ganoderma conk (Yes/No); Injection recommended (Yes/No).

**Shrub/ornamental module:** Pest pressure (None/Light/Moderate/Heavy);
Disease pressure (None/Light/Moderate/Heavy); Deficiency symptoms
(None/Light/Moderate/Heavy); New growth present (Yes/No); Pruning issue
observed (Yes/No); Irrigation issue observed (Yes/No).

**Bed/pre-emergent module:** Bed weeds present (None/Light/Moderate/Heavy);
Pre-emergent applied (Yes/No); Mulch depth concern (Yes/No); Weed
breakthrough areas; Customer action needed.

**Customer recommendations:** Adjust irrigation; Avoid over-pruning; Remove
dead plant material; Trim away from structure; Keep mulch off trunks/stems;
Monitor decline; Replace severely declining plant; Approve injection;
Improve drainage; Continue program.

**Customer-facing summary template:**

> Completed Tree & Shrub service for [plant groups]. Overall landscape
> condition is [condition]. Observed conditions included [observed
> conditions].
> Treatment completed: [treatments].
> Palm notes: [if applicable].
> Recommendation: [customer action].
> Next step: [continue program/monitor/injection recommended/follow-up
> needed].

**Strong example:**

> Completed Tree & Shrub service for palms, shrubs, and ornamental beds.
> Overall landscape condition is fair and improving. Light scale activity
> was observed on several shrubs, and mild yellowing was noted on two palms.
> Applied ornamental fertilizer, palm fertilizer, and targeted insect
> treatment to affected plant material. No visible Ganoderma conks or trunk
> decay were observed on palms today. Recommend avoiding over-pruning,
> keeping mulch pulled back from trunks, and monitoring palm canopy response
> over the next few visits.

**Critical recommendation:** Tree & Shrub should not be blocked by the old
Tree/Shrub closeout forever. Replace the legacy hard-block with typed
required fields: Plant groups serviced; Condition; Observed issues;
Treatment completed; Recommendation; Next step. Same enforcement, inside
the new checklist model.

## 7. Bee/Wasp-Specific Typed Checklist

Generic one-time pest form acceptable short-term; a bee/wasp-specific
report is better — customers care about nest location, removal vs.
treatment, activity risk, and follow-up expectations.

**Pest type:** Paper wasp; Yellow jacket; Hornet; Mud dauber; Carpenter
bee; Honey bee; Unknown stinging insect.

**Nest/activity location:** Eave; Soffit; Fascia; Tree/shrub; Ground nest;
Wall void; Pool cage; Lanai; Fence; Playset; Shed; Attic/vent; Other.

**Activity level:** None observed; Light; Moderate; Heavy; Aggressive/high
risk.

**Work completed:** Nest removed; Nest treated; Entry point treated;
Residual treatment; Dust application; Knockdown treatment; Inspection only;
Unable to access nest; Customer advised beekeeper needed.

**Access/safety limitations:** Nest too high; Inside wall void; Inside
soffit; Heavy activity; Weather limitation; Customer/pets nearby; Ladder
unsafe; Honey bee concern; No limitations.

**Follow-up:** Monitor activity for 24–72 hours; Return if activity
continues; Seal entry after activity stops; Beekeeper recommended;
Carpenter bee repair/paint recommended; No follow-up needed.

**Customer-facing example:**

> Treated active wasp nest activity at the rear soffit near the lanai.
> Moderate wasp activity was observed at the time of service. The visible
> nest area was treated, but activity may continue temporarily as foraging
> wasps return to the treated area. Recommend avoiding the area for the
> rest of the day and monitoring for activity over the next 24–72 hours.

**Honey bee caution:** If honey bees are suspected, the form must support:
"Honey bee activity suspected. Recommend beekeeper/removal specialist
evaluation before chemical treatment when appropriate." That protects the
business from treating bees like generic wasps.

## 8. Cockroach Knockdown Profiles

Two different typed profiles — `pest_initial_palmetto_knockdown` and
`pest_initial_german_knockdown`. They should NOT share the exact same
checklist. German roach work is a multi-visit interior sanitation/bait/IGR
process. Palmetto knockdown is large-roach reduction + exclusion/moisture/
perimeter focus.

### A. Palmetto / Large Roach Knockdown

Required: Roach type (Palmetto/American/Smokybrown/Unknown large roach);
Activity level (Light/Moderate/Heavy); Activity locations; Interior
activity (Yes/No); Exterior harborage (Yes/No); Moisture issue (Yes/No);
Entry points observed (Yes/No); Treatment completed; Customer action;
Follow-up needed.

Treatment options: Interior crack/crevice; Exterior perimeter; Garage
treatment; Attic/void treatment; Drain/moisture area treatment; Bait;
Dust; Glue boards; Exclusion recommendation.

**Customer-facing example:**

> Completed initial large-roach knockdown service. Activity was moderate,
> with roaches reported near the garage and kitchen entry area. Treated
> interior cracks/crevices, garage edges, and exterior perimeter harborage
> areas. Moisture and exterior entry points can contribute to palmetto bug
> activity, so we recommend keeping garage seals tight and reducing
> moisture near entry points. Some activity may be seen temporarily as
> roaches are flushed from hiding areas.

### B. German Roach Knockdown

Required: Activity level (Light/Moderate/Heavy/Severe); Rooms treated;
Primary harborage; Live roaches observed (Yes/No); Droppings/egg cases
observed (Yes/No); Sanitation issue (Yes/No); Moisture/leak issue (Yes/No);
Prep completed (Yes/Partial/No); Treatment completed; Monitors placed
(Yes/No); Follow-up required (Yes/No); Follow-up window (10–14 days
preferred).

Treatment options: Gel bait; IGR; Crack/crevice; Dust; Vacuum/flush;
Monitor/glue boards; Appliance-area treatment; Cabinet hinge treatment;
Plumbing penetration treatment.

**Customer-facing example:**

> Completed initial German cockroach knockdown service in the kitchen and
> adjacent areas. Moderate activity was observed behind the refrigerator,
> under the sink, and inside cabinet hinge areas. Live roaches and droppings
> were present. Applied targeted bait, insect growth regulator, and
> crack-and-crevice treatment to active harborage areas. Customer advised
> not to use over-the-counter sprays, to clean food debris behind
> appliances, and to keep bait placements undisturbed. Follow-up service is
> recommended in 10–14 days.

**Critical warning:** Do not let German roach knockdown auto-send a weak
generic note. It needs mandatory customer cooperation language or callbacks
and unrealistic expectations follow.

---

## Phase 2 migration plan (owner)

**Cut over immediately** (typed forms exist or can use existing forms —
ONLY if the typed form supports the right conditional modules; if not, do
not cut over sanitation/exclusion until the modules are added):
`rodent_exclusion`, `rodent_exclusion_only`, `rodent_sanitation_light`,
`rodent_sanitation_standard`, `rodent_sanitation_heavy`,
`rodent_trapping_*` combo keys, `rodent_inspection`,
`rodent_general_one_time`, `flea_tick`.

**Build new typed forms before cutover:** `tree_shrub_program`,
`tree_shrub_6week` (modules: base, palm, shrub/ornamental,
bed/pre-emergent, optional injection recommendation).

**Keep generic temporarily, improve later:** `bee_wasp_removal` (stays on
`one_time_pest_treatment` for now).

**Add cockroach profiles:** `pest_initial_palmetto_knockdown`,
`pest_initial_german_knockdown` — prod-only knockdown keys; should not keep
producing thin reports.
