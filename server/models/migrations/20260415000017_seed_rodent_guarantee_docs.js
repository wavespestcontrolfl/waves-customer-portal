/**
 * Seed the canonical Rodent Guarantee SOP and Rodent Service Phases docs
 * into Claudeopedia. Replaces the earlier condensed SOP entry.
 *
 * Idempotent: re-running updates existing rows, bumps version.
 */

const fs = require('fs');
const path = require('path');

const DOCS = [
  {
    path: 'protocols/rodent-guarantee-sop.md',
    title: 'Rodent Guarantee Callback SOP',
    summary: 'Complete standard operating procedure for rodent guarantee callbacks — what triggers a visit, the on-site diagnostic and repair workflow, how to distinguish original exclusion failure from new entry points, coverage vs. exclusion rules, escalation triggers, lapse/reinstatement policy, and customer communication scripts. Guarantee covers up to 4 callbacks with re-sealing within 12 months at $199/year.',
    category: 'protocols',
    tags: ['rodent','guarantee','callback','exclusion','re-entry','trapping','roof_rat','norway_rat','mouse','bait_station','copper_mesh','SWFL'],
    backlinks: ['protocols/rodent-service-phases','operations/per-visit-quality-scoring'],
    file: 'rodent-guarantee-sop.md',
  },
  {
    path: 'protocols/rodent-service-phases.md',
    title: 'Rodent Service Phases: Inspection → Trapping → Exclusion → Monitoring',
    summary: 'Three-phase rodent service protocol for SWFL residential properties: Phase 1 (inspection + trapping, Visit 1), Phase 2 (follow-up + exclusion, Visits 2-3), Phase 3 (ongoing monitoring, monthly/quarterly). Covers species identification, trap placement, SWFL-specific entry points, exclusion materials, and transition to recurring monitoring revenue.',
    category: 'protocols',
    tags: ['rodent','trapping','exclusion','monitoring','inspection','roof_rat','norway_rat','snap_trap','bait_station','copper_mesh','hardware_cloth'],
    backlinks: ['protocols/rodent-guarantee-sop'],
    file: 'rodent-service-phases.md',
  },
];

const CONTENT = {
  'rodent-guarantee-sop.md': `# Rodent Guarantee Callback SOP

## Guarantee Overview

The Rodent Guarantee is a $199/year renewal available to customers who completed the full rodent package (trapping + exclusion). It activates upon exclusion completion and covers callbacks for rodent re-entry at original exclusion points.

### What's Covered

- Up to 4 callback visits within the 12-month guarantee period
- Full inspection at each callback visit
- Re-trapping if new activity is confirmed (snap traps in tamper-resistant stations)
- Re-sealing of ORIGINAL exclusion points that have failed or been compromised by normal wear
- Materials included for re-seal work (copper mesh, expanding foam, caulk, minor hardware cloth patches)

### What's NOT Covered

- New entry points NOT part of the original exclusion scope (quoted separately)
- Damage from hurricanes, tropical storms, or structural settling
- Entry points created by other contractors, homeowner renovations, or structural modifications
- Properties that declined recommended vegetation management at the time of exclusion (tree limbs within 3 ft of structure, overgrown landscaping against foundation)
- New tree limb contact that developed after the original service
- Attic insulation remediation or drywall repair
- Interior damage caused by rodents (chewed wiring, contaminated insulation, staining)

### Enrollment & Renewal Rules

- Must be purchased within 30 days of exclusion completion
- Renews annually on the exclusion completion anniversary date
- Non-refundable once activated
- If the guarantee lapses (not renewed), reinstatement requires a full re-inspection at standard inspection rates before re-enrolling
- Guarantee does NOT auto-renew — customer must actively opt in at renewal. Renewal reminder goes out at 30 days, 14 days, and 3 days before expiration.

## When a Customer Reports Activity

### Step 1 — Intake Triage (Virginia / CSR)

When a guarantee customer calls or texts reporting rodent activity, gather:

1. **What are they hearing/seeing?** Scratching in walls/attic, droppings, chew marks, visual sighting, pet behavior changes. Get specifics: time of day (nocturnal = likely rats, daytime = possibly squirrel or bird), location in home, frequency.
2. **When did it start?** Sudden onset vs. gradual. Sudden onset after a storm = likely storm damage (may not be covered). Gradual = possible exclusion failure or new entry.
3. **Has anything changed on the property?** Roof work, A/C replacement, new landscaping, tree trimming (or lack of), construction nearby. Any "yes" here is a flag for non-covered new entry.
4. **Guarantee status check.** Verify in the CRM: Is the guarantee active? How many callbacks have been used? When does it expire?

**If guarantee is active and callbacks remain:** Schedule the callback within 48 hours. Rodent complaints are time-sensitive — activity gets worse, not better, with delay. Route to the tech who did the original exclusion if possible (they know the property).

**If guarantee has lapsed:** Inform the customer that re-enrollment requires a re-inspection. Quote the re-inspection fee. Do not dispatch a free callback on a lapsed guarantee.

**If 4 callbacks have been exhausted:** See Escalation Protocol below.

### Step 2 — Pre-Visit Preparation (Tech)

Before heading to the callback, the tech should:

1. **Pull the original exclusion report** from the CRM. Review: what entry points were sealed, what materials were used, what was the original species (roof rat, Norway rat, mice), where were traps placed, what was the original activity pattern.
2. **Check callback history** on this property. Is this callback #1 or callback #3? Repeat callbacks on the same property signal either incomplete original exclusion, a persistent conducive condition, or a new entry point.
3. **Load the truck** with: snap traps (T-Rex preferred), copper mesh, pest-block expanding foam, caulk/sealant, hardware cloth + screws, flashlight/headlamp, inspection mirror, dust mask, camera.

## On-Site Callback Protocol

### Step 3 — Full Property Re-Inspection (30–45 minutes)

Do NOT assume the entry point is the same as the original. Treat every callback as a fresh diagnostic.

**Attic Inspection:**
- Access the attic. Look for fresh droppings (dark, moist = recent; gray, dry, crumbly = old), new rub marks (greasy brown streaks along rafters/joists), gnaw marks on wiring or wood, disturbed insulation, nesting material.
- Check all original exclusion points from the attic side. Are seals intact? Has foam been chewed through? Has copper mesh been displaced?
- Look for NEW penetrations not in the original scope — A/C line additions, plumbing changes, ridge vent gaps.

**Exterior Perimeter Inspection:**
Walk the full exterior checking the common SWFL entry points:

- **A/C line penetrations** — the #1 re-entry point in SWFL. Foam around line sets degrades in UV and moisture. Check every line set penetration on the structure.
- **Plumbing roof vents** — pipe boots crack in Florida sun. Check for gaps around every roof vent pipe.
- **Soffit gaps** — especially at roof-wall junctions where the soffit meets the fascia. Roof rats in SWFL exploit these gaps more than any other entry point.
- **Garage door corners** — rubber weather seal deteriorates. Rats can compress through a gap the size of a quarter.
- **Dryer vents** — check that the vent cover is intact and the damper closes.
- **Gable vents** — verify screening is intact. Hardware cloth should be secured with screws, not just friction-fit.
- **Fascia/soffit transitions at gable ends** — common gap point on SWFL construction, especially stucco homes where the stucco terminates at the roofline.
- **Roof-to-roof transitions** — on multi-level homes, the junction where a lower roof meets an upper wall is a common gap.

**Vegetation Check:**
- Is any tree canopy, palm frond, or vegetation within 3 ft of the structure? Roof rats use branches as highways to the roofline.
- Has vegetation grown INTO contact since the original exclusion? If so, this may be a non-covered condition (customer was advised to maintain clearance).
- Document with photos. If vegetation contact is the likely entry vector, note it clearly — this is a coverage conversation.

**Interior Evidence:**
- Check areas customer reported activity. Look for fresh droppings, rub marks, gnaw marks.
- If droppings are present, assess species: roof rat droppings are ~½ inch, spindle-shaped; Norway rat droppings are ~¾ inch, blunt-ended; mouse droppings are ~¼ inch, pointed. Species identification matters for determining entry vector (roof rats come from above, Norway rats from ground level).

### Step 4 — Diagnosis: Original Failure vs. New Entry

This is the critical determination that dictates coverage.

**COVERED — Original Exclusion Failure:**
- A sealed entry point has degraded, been chewed through, or failed due to normal material wear
- The same entry point identified in the original scope is the source of re-entry
- No property modifications or new conducive conditions contributed to the failure

**Examples of covered failures:**
- Expanding foam chewed through at an A/C penetration that was sealed during the original exclusion
- Copper mesh displaced from a soffit gap that was part of the original scope
- Weather seal on a garage door corner that was replaced during exclusion has degraded

**NOT COVERED — New Entry Point:**
- An entry point that was NOT identified or sealed in the original exclusion scope
- An entry point created by post-service construction, renovation, or contractor work
- An entry point enabled by vegetation growth that the customer was advised to manage
- Storm damage to roofing, soffits, or screening

**Examples of non-covered situations:**
- Customer had roof work done and the roofer left a gap at a soffit junction
- A live oak branch has grown to touch the roofline since the original service (customer was warned to trim)
- Hurricane damage displaced a gable vent screen
- Rats entering through a new A/C line installed after the original exclusion

### Step 5 — Action Based on Diagnosis

**If COVERED (original failure):**
1. Re-seal the failed entry point. Use copper mesh + pest-block foam as the standard repair. For larger failures, hardware cloth secured with screws.
2. Place snap traps (T-Rex in tamper-resistant stations) at confirmed activity points. Typical placement: 4–8 traps depending on activity level.
3. Document: photos of the failed seal, the repair performed, trap placements, and any additional observations.
4. Schedule a follow-up check in 5–7 days to retrieve traps and verify the seal is holding.
5. Log the callback in the CRM — date, diagnosis, action taken, callback count (1/4, 2/4, etc.).

**If NOT COVERED (new entry):**
1. Explain to the customer clearly and without defensiveness what you found. Show them the photos. "The original exclusion points are holding — this activity is coming from [new entry point], which wasn't part of the original scope because [reason]."
2. Provide a quote for the additional exclusion work on the spot if possible. This is not a sales pitch — it's solving their problem. Most customers appreciate the honesty and will authorize the work.
3. Still place traps to address the immediate activity as a goodwill gesture (traps are low cost). Do NOT re-seal the new entry point for free — that sets a precedent that erodes the guarantee's value.
4. Document everything. Photos of the new entry point, explanation of why it's outside scope, quote provided. This protects you if the customer disputes coverage.

**If UNCLEAR:**
When in doubt — when the entry point could be argued either way — err on the side of the customer and cover the repair. The material cost of copper mesh and foam is $10–25. The cost of a bad review or a lost customer is far higher. Log it as covered but note the ambiguity in the CRM for future reference.

## Escalation Protocol: 4 Callbacks Exhausted

If a customer has used all 4 guarantee callbacks within the 12-month period, this is a signal that something systemic is wrong. Do NOT simply tell the customer "your callbacks are used up."

### Required Actions:

1. **Manager review.** Pull the full callback history. What was found each time? Same entry point or different? Same species? Were repairs holding between visits?

2. **Root cause analysis.** The three most common root causes for repeat callbacks in SWFL:
   - **Incomplete original exclusion.** The initial scope missed an entry point — possibly one that was inaccessible at the time (under insulation, behind fascia) or that wasn't active during the initial inspection but became active later.
   - **Persistent conducive conditions.** Customer has fruit trees dropping fruit, pet food outside, a neighbor feeding wildlife, or vegetation in constant roof contact. The property is generating ongoing rodent pressure that exceeds what exclusion alone can manage.
   - **Construction quality.** Older SWFL homes (pre-2000) with barrel tile roofs, deteriorating stucco, or original soffit material have so many micro-gaps that a standard exclusion scope may be insufficient. These properties may need a more comprehensive (and more expensive) exclusion approach.

3. **Re-scope and re-quote.** Schedule a full re-inspection (this one is complimentary given the situation — don't charge the re-inspection fee for an exhausted guarantee, that feels punitive). Present the customer with options:
   - Expanded exclusion scope addressing newly identified entry points — quoted at standard exclusion rates
   - Ongoing monitoring service (monthly bait station program) as a supplement to exclusion for high-pressure properties
   - Vegetation management recommendations (in writing, with photos of specific contact points)

4. **CRM Flag.** Tag this property as "High Rodent Pressure" for future reference. If the customer renews the guarantee after re-scope, adjust internal expectations — this property may use all 4 callbacks again.

## Follow-Up Visit Protocol (5–7 Days After Callback)

Every callback that includes trap placement requires a follow-up:

1. Check and retrieve all traps. Count catches. Document species and locations.
2. Re-inspect the repaired exclusion point. Is the seal holding? Any new chew marks or displacement?
3. If traps caught 0 rodents and the seal is holding — the callback was successful. Communicate this to the customer.
4. If traps caught rodents and/or the seal shows new activity — a second callback may be needed. This counts toward the 4-callback limit.
5. Remove all traps. Do not leave traps indefinitely — dead rodents in traps that aren't checked create odor and fly issues.

## Customer Communication Scripts

### Scheduling the Callback (Virginia/CSR)
"I've got your guarantee on file and you're covered. I'm scheduling a tech visit within the next [24/48] hours. They'll do a full re-inspection of the property — attic, exterior, all the original exclusion points — and get traps set if there's confirmed activity. We'll call you when we're on our way."

### On-Site: Covered Repair (Tech)
"I found the issue — [specific entry point] from the original exclusion has [degraded/been compromised]. I've re-sealed it with [material] and placed [X] traps in the areas where I'm seeing fresh activity. I'll come back in about a week to check the traps and make sure the repair is holding. You're covered on this one."

### On-Site: Non-Covered New Entry (Tech)
"Good news is all the original exclusion points are holding solid. The activity you're hearing is coming from [new entry point] — this one wasn't part of the original work because [it didn't exist / wasn't accessible / was created by X]. I can seal this up for you today — it would be [quote]. In the meantime, I've placed traps to start catching what's active right now."

### 4 Callbacks Exhausted (Manager)
"I've reviewed your full service history and I want to be upfront with you — having 4 callbacks in [X months] tells me there's something more going on that a standard exclusion scope isn't fully addressing. I'd like to come out personally, do a comprehensive re-inspection at no charge, and put together a plan that actually solves this for good. That might mean expanding the exclusion scope to cover areas we couldn't get to originally, or adding monthly monitoring to manage the pressure on your property. Either way, I want to make sure we fix this right."

## Species Reference (SWFL)

### Roof Rat (Rattus rattus) — DOMINANT in SWFL residential
- Entry vector: ABOVE — roofline, soffits, gable vents, tree-to-roof transit
- Droppings: ~½ inch, spindle-shaped with pointed ends
- Behavior: Nocturnal, excellent climber, prefers attics and upper structure
- Key indicator: Scratching/running sounds in attic/ceiling, especially at night

### Norway Rat (Rattus norvegicus)
- Entry vector: GROUND LEVEL — foundation gaps, garage doors, ground-floor penetrations
- Droppings: ~¾ inch, blunt/capsule-shaped
- Behavior: Nocturnal, burrower, prefers ground level and lower structure
- Key indicator: Burrows along foundation, gnaw marks at ground level

### House Mouse (Mus musculus)
- Entry vector: ANY level — can fit through a gap the size of a dime
- Droppings: ~¼ inch, pointed ends, scattered widely
- Behavior: Nocturnal but more bold than rats, nests in wall voids and clutter
- Key indicator: Droppings in cabinets/drawers, gnaw marks on food packaging

## Common SWFL Entry Points Reference

These are the highest-priority inspection points for every callback, listed in approximate order of frequency for SWFL residential properties:

1. **A/C line penetrations** — foam sealant degrades in UV/moisture; #1 re-entry point
2. **Soffit gaps at roof-wall junctions** — especially on hip roof corners
3. **Plumbing roof vent pipe boots** — rubber cracks in Florida sun
4. **Garage door corner seals** — weather stripping deteriorates
5. **Gable vent screening** — original builder screening is often insufficient gauge
6. **Fascia/soffit transitions at gable ends** — gap where stucco terminates at roofline
7. **Dryer vent covers** — damper failure or screen missing
8. **Roof-to-roof transitions** — lower roof meeting upper wall on multi-level homes
9. **Barrel tile gaps** — older SWFL homes with barrel tile have gaps between tiles and underlayment
10. **Pool equipment penetrations** — plumbing and electrical lines entering the structure from pool pad
`,
  'rodent-service-phases.md': `# Rodent Service Phases

SWFL primary targets: roof rats (Rattus rattus — dominant in residential), Norway rats (Rattus norvegicus), and house mice (Mus musculus). Roof rats are the #1 species in most SWFL residential settings due to the prevalence of mature tree canopy, barrel tile roofs, and soffit construction gaps.

## Phase 1 — Inspection + Trapping (Visit 1)

**Duration:** 1–1.5 hours on-site

### Full Property Inspection

Inspect every access point systematically. Document all findings with photos.

**Attic:**
- Access the attic (headlamp, dust mask required). Look for droppings, rub marks (greasy brown streaks), gnaw marks, disturbed insulation, nesting material.
- Identify species from droppings: roof rat (~½ inch, spindle/pointed), Norway rat (~¾ inch, blunt), mouse (~¼ inch, pointed).
- Assess insulation damage — note for customer as potential remediation upsell but do NOT include in exclusion scope.

**Exterior Perimeter:**
Walk the full exterior. Check all penetrations, transitions, and gaps. SWFL-specific priority list:
1. A/C line penetrations (every line set)
2. Soffit gaps — especially at roof-wall junctions and hip roof corners
3. Plumbing roof vent pipe boots
4. Garage door corner weather seals
5. Gable vents (check screen gauge and attachment)
6. Fascia/soffit transitions at gable ends
7. Dryer vent covers and dampers
8. Roof-to-roof transitions on multi-level homes
9. Barrel tile gaps on older homes
10. Pool equipment penetrations

**Vegetation Assessment:**
- Document any tree canopy, palm fronds, or landscaping within 3 ft of the structure
- Fruit trees on the property (citrus, mango, avocado attract rodents)
- Ground-level harborage: debris piles, woodpiles, dense ground cover against foundation

**Interior (if customer reports interior activity):**
- Check reported areas for droppings, gnaw marks, rub marks
- Inspect under kitchen/bathroom sinks, behind appliances, inside garage cabinets
- Look for food storage issues — open containers, pet food left out

### Trap Placement

- **Product:** T-Rex rat snap traps (preferred) or Victor M9 Professional snap traps in tamper-resistant Protecta LP stations for outdoor placement.
- **Placement:** At confirmed activity points — along rub mark paths, near droppings concentrations, at identified entry points.
- **Quantity:** Typical residential: 6–12 traps depending on activity level and property size.
- **Bait:** Peanut butter or Provoke professional rodent attractant.
- **Florida law:** Outdoor snap traps MUST be in tamper-resistant stations where children, pets, or non-target animals may be present.
- **Attic traps:** Can be placed without stations (no access by children/pets) but secure to a surface so a caught rodent doesn't drag the trap into an inaccessible void.

### Visit 1 Deliverable to Customer

Walk the customer through findings. Show photos of entry points on your phone. Explain the three-phase plan:
1. Traps are set to catch what's currently active
2. Next visit in 5–7 days to check traps and begin sealing entry points
3. After exclusion is complete, transition to monitoring

Provide the vegetation management recommendation in writing if applicable — this creates the documentation needed for guarantee coverage decisions later.

## Phase 2 — Follow-Up + Exclusion (Visits 2–3, Weekly)

**Duration:** 1–2 hours per visit depending on exclusion scope

### Visit 2 (5–7 Days After Visit 1)

**Trap Check:**
- Check every trap. Count catches, document species and location.
- Re-set or reposition traps that haven't caught. Traps with no activity after 7 days may be in the wrong location — move them.
- Remove any traps with catches, replace with fresh traps in the same location.

**Begin Exclusion Work:**
Seal identified entry points using appropriate materials:

| Entry Point | Primary Material | Method |
|-------------|-----------------|--------|
| Gaps <½ inch | Copper mesh (Stuf-Fit) + pest-block expanding foam | Stuff copper mesh into gap first, then seal over with foam. Foam alone is NOT sufficient — rodents chew through foam. |
| Gaps ½–2 inches | Copper mesh + expanding foam + exterior caulk finish | Copper mesh for structure, foam for fill, caulk for weather seal and aesthetics |
| Gaps >2 inches | ¼-inch galvanized hardware cloth | Secure with screws and washers. Covers gable vents, soffit gaps, crawlspace openings |
| A/C line penetrations | Copper mesh + pest-block foam | Pack tightly around line sets. This is the most common failure point — be thorough |
| Garage door corners | Replace weather seal strip + copper mesh at frame gaps | New weather seal + seal the frame gap behind it |
| Pipe boot cracks | Roofing sealant or pipe boot replacement | If the rubber boot is cracked, sealant is temporary — recommend replacement |
| Barrel tile gaps | Copper mesh or stainless steel wool stuffed into tile gaps at eave line | Labor-intensive on older homes but critical for roof rat entry |

**Material Notes:**
- **Copper mesh** is the gold standard for exclusion fill — rodents cannot chew through it, it doesn't rust, and it holds shape.
- **Expanding foam** alone is NOT a seal. Rodents chew through foam in hours. Always back foam with copper mesh or hardware cloth.
- **Pest-block foam** contains a bittering agent that discourages chewing. Use this instead of standard expanding foam.
- **Stainless steel wool** is an acceptable alternative to copper mesh but rusts faster in SWFL humidity.

### Visit 3 (5–7 Days After Visit 2)

**Trap Check:**
- Final trap check. If catches have stopped and no fresh droppings/activity, the trapping phase is complete.
- If activity continues, extend trapping for another week. Re-assess entry points — is something being missed?

**Complete Exclusion:**
- Finish any remaining exclusion points from the scope.
- Perform a final walk of all sealed points. Photograph every repair for the CRM record.
- Verify vegetation clearance recommendations were communicated.

**Transition Conversation:**
This is where you present the ongoing monitoring option and the guarantee:

1. "The trapping and exclusion work is complete. Your property is sealed against rodent entry at [X] points."
2. "I recommend monthly monitoring — we check the exterior stations, verify the exclusion is holding, and catch any new activity early before it becomes a problem. That's $45/month."
3. "You also have the option to add our annual guarantee for $199. That covers up to 4 callback visits with re-sealing if rodents get back in through any of the points we sealed."

## Phase 3 — Ongoing Monitoring (Monthly or Quarterly)

**Duration:** 20–30 minutes per visit

This is the recurring revenue phase. Monitoring can be monthly ($45/month) or bundled into a WaveGuard membership.

### Monthly Monitoring Visit Checklist

1. **Inspect exterior bait/monitoring stations.** Check for activity (consumed bait, droppings in station, rub marks). Replenish bait as needed.
2. **Check exclusion integrity.** Walk the sealed points and verify seals are intact. Photograph any degradation.
3. **Perimeter scan.** Look for new entry indicators — fresh rub marks, gnaw marks, droppings along the foundation or roofline.
4. **Vegetation check.** Has anything grown into contact with the structure since last visit?
5. **Document and report.** Log visit in CRM with station activity readings and exclusion condition. Push visit summary to customer.

### Bait Station Protocols

- **Product:** Contrac Blox (bromadiolone, second-generation anticoagulant) in tamper-resistant Protecta LP stations.
- **IMPORTANT:** Contrac Blox is a Restricted Use Pesticide (RUP). Certified applicator only. Florida requires tamper-resistant, anchored stations for all exterior rodenticide placements.
- **Secondary poisoning risk:** Inform customers with outdoor cats or raptors on the property. Consider using snap traps in monitoring stations instead of bait on properties with known non-target wildlife.
- **Station placement:** At activity zones, along known transit routes (fence lines, foundation edges, near A/C units), and at previously sealed entry points.

### When Monitoring Detects New Activity

If a monitoring visit finds evidence of new rodent activity (consumed bait, fresh droppings, new gnaw marks):

1. Assess whether the activity is exterior-only (rodents visiting stations but not entering the structure) or interior re-entry.
2. If exterior only — normal. Replenish bait, continue monitoring. SWFL has persistent rodent pressure from surrounding habitat. Exterior station activity does not necessarily indicate an exclusion failure.
3. If evidence of interior re-entry — this triggers the guarantee callback protocol if the customer has an active guarantee. See [Rodent Guarantee Callback SOP](protocols/rodent-guarantee-sop). If no guarantee, quote a callback visit at standard rates.
`,
};

async function upsert(knex, doc) {
  const content = CONTENT[doc.file];
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const existing = await knex('knowledge_base').where('path', doc.path).first();
  if (existing) {
    await knex('knowledge_base').where('id', existing.id).update({
      title: doc.title,
      category: doc.category,
      summary: doc.summary,
      content,
      tags: JSON.stringify(doc.tags),
      backlinks: JSON.stringify(doc.backlinks),
      word_count: wordCount,
      last_compiled: new Date(),
      version: (existing.version || 1) + 1,
      active: true,
      updated_at: new Date(),
    });
  } else {
    await knex('knowledge_base').insert({
      path: doc.path,
      title: doc.title,
      category: doc.category,
      summary: doc.summary,
      content,
      tags: JSON.stringify(doc.tags),
      backlinks: JSON.stringify(doc.backlinks),
      source_documents: JSON.stringify(['founder-docs:2026-04-15']),
      word_count: wordCount,
      last_compiled: new Date(),
      version: 1,
      active: true,
    });
  }
}

exports.up = async function (knex) {
  for (const doc of DOCS) await upsert(knex, doc);
};

exports.down = async function (knex) {
  for (const doc of DOCS) {
    await knex('knowledge_base').where('path', doc.path).del();
  }
};
