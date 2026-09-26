/**
 * Searchable, technician-selected closeout vocabulary for the three routine
 * service families. These entries are candidates only: choosing one is what
 * turns it into a visit fact. Nothing in this module auto-selects findings or
 * completed work.
 *
 * @typedef {"lawn" | "tree_shrub" | "recurring_pest"} ServiceCompletionChoiceFamily
 * @typedef {"observations" | "recommendations" | "completedActions"} ServiceCompletionChoiceCategory
 * @typedef {{ id: string, label: string, keywords: readonly string[], scope?: "interior" | "exterior", treatmentApplied?: boolean }} ServiceCompletionChoice
 */

export const SERVICE_COMPLETION_CHOICE_FAMILIES = Object.freeze([
  "lawn",
  "tree_shrub",
  "recurring_pest",
]);

export const SERVICE_COMPLETION_CHOICE_CATEGORIES = Object.freeze([
  "observations",
  "recommendations",
  "completedActions",
]);

const CATEGORY_ID_PART = {
  observations: "observation",
  recommendations: "recommendation",
  completedActions: "completed-action",
};

const defineChoices = (family, category, rows) => Object.freeze(rows.map(([slug, label, keywords = [], metadata = {}]) => Object.freeze({
  id: `${family}-${CATEGORY_ID_PART[category]}-${slug}`,
  label,
  keywords: Object.freeze(keywords),
  ...metadata,
})));

const lawn = Object.freeze({
  observations: defineChoices("lawn", "observations", [
    ["even-coverage", "Turf coverage appeared even in the inspected areas.", ["uniform", "density"]],
    ["thin-turf", "Thin turf was visible in the inspected area.", ["sparse", "density"]],
    ["bare-damaged-area", "A bare or damaged turf area was visible.", ["dead", "open soil"]],
    ["yellowing-unknown", "Yellowing was visible; the cause was not confirmed.", ["chlorosis", "discoloration"]],
    ["uneven-color", "Uneven turf color was visible across the inspected area.", ["discoloration", "patchy"]],
    ["leaf-spots-unconfirmed", "Leaf spotting was visible; the cause was not confirmed.", ["lesions", "disease"]],
    ["circular-discoloration", "Circular turf discoloration was visible; the cause was not confirmed.", ["ring", "patch"]],
    ["mushrooms-visible", "Mushrooms were visible; their presence alone did not confirm turf disease.", ["fungus", "toadstools"]],
    ["live-pests", "Live lawn pests were visible in the inspected area.", ["insects", "bugs"]],
    ["feeding-damage-unconfirmed", "Turf feeding damage was visible; the cause was not confirmed.", ["insect damage", "chewing"]],
    ["isolated-weeds", "Isolated weeds were visible in the lawn.", ["spot weeds", "weed pressure"]],
    ["scattered-weeds", "Scattered weed growth was visible in the lawn.", ["weed pressure", "breakthrough"]],
    ["sedge-growth", "Sedge growth was visible in the lawn.", ["nutsedge", "kyllinga"]],
    ["grassy-weeds", "Grassy weed growth was visible in the lawn.", ["crabgrass", "goosegrass"]],
    ["broadleaf-weeds", "Broadleaf weed growth was visible in the lawn.", ["dollarweed", "buttonweed"]],
    ["dry-root-zone", "The inspected root zone was dry at the time of service.", ["moisture stress", "dry soil"]],
    ["saturated-soil", "The inspected soil was saturated at the time of service.", ["wet", "overwatering"]],
    ["standing-water", "Standing water was visible in the lawn.", ["drainage", "ponding"]],
    ["uneven-irrigation", "Irrigation testing showed uneven coverage.", ["sprinkler", "dry spots"]],
    ["damaged-sprinkler", "A damaged sprinkler head was visible.", ["irrigation", "broken head"]],
    ["blocked-sprinkler", "Landscape growth was blocking a sprinkler pattern.", ["irrigation", "obstruction"]],
    ["mowing-low", "The lawn appeared to have been mowed low.", ["cut height", "short"]],
    ["scalping", "Turf scalping was visible.", ["mowing damage", "cut low"]],
    ["frayed-blades", "Frayed grass-blade tips were visible.", ["dull mower blade", "shredded"]],
    ["clipping-buildup", "Heavy grass-clipping buildup was visible.", ["clumps", "mowing"]],
    ["excess-thatch", "Inspection found a heavy thatch layer.", ["thatch buildup", "spongy"]],
    ["traffic-wear", "Turf wear was visible along a frequently traveled area.", ["foot traffic", "path"]],
    ["improved-condition", "The inspected area improved from the previous documented visit.", ["progress", "recovery"]],
  ]),
  recommendations: defineChoices("lawn", "recommendations", [
    ["review-irrigation", "Homeowner: review the irrigation schedule if the soil remains too wet or too dry.", ["watering", "controller"]],
    ["check-coverage", "Homeowner: check irrigation coverage where the lawn shows uneven moisture.", ["sprinklers", "dry spots"]],
    ["repair-sprinkler", "Homeowner: arrange repair of the damaged sprinkler head.", ["irrigation", "broken"]],
    ["clear-sprinkler", "Homeowner: trim or move growth that blocks the sprinkler pattern.", ["irrigation obstruction", "coverage"]],
    ["address-leak", "Homeowner: arrange repair if an irrigation leak continues.", ["sprinkler", "water loss"]],
    ["review-drainage", "Homeowner: have persistent standing water or drainage problems evaluated.", ["ponding", "saturated"]],
    ["avoid-evening-water", "Homeowner: avoid irrigation timing that leaves grass wet for long periods overnight.", ["watering time", "leaf wetness"]],
    ["mow-higher", "Homeowner: raise mowing height if the lawn continues to be cut too low.", ["scalping", "cut height"]],
    ["sharpen-blades", "Homeowner: sharpen or replace mower blades if grass tips remain frayed.", ["mowing", "dull blade"]],
    ["adjust-mowing-frequency", "Homeowner: adjust mowing frequency so no heavy clipping layer is left behind.", ["clumps", "overgrown"]],
    ["vary-mowing-path", "Homeowner: vary the mowing path if ruts or repeated traffic wear continue.", ["compaction", "tire tracks"]],
    ["limit-traffic", "Homeowner: limit traffic over stressed turf while it is recovering.", ["foot traffic", "wear"]],
    ["remove-clipping-clumps", "Homeowner: remove heavy clipping clumps that cover living turf.", ["mowing debris", "clippings"]],
    ["monitor-yellowing", "Homeowner: monitor the yellow area and note whether it expands or changes.", ["discoloration", "photos"]],
    ["monitor-leaf-spots", "Homeowner: monitor visible leaf spotting and report meaningful changes.", ["lesions", "disease symptoms"]],
    ["photograph-change", "Homeowner: take a clear photo if the affected area changes before the next visit.", ["document", "progress"]],
    ["avoid-unrecorded-products", "Homeowner: avoid adding unrecorded lawn products while the cause of damage is uncertain.", ["fertilizer", "herbicide"]],
    ["share-product-history", "Homeowner: share any recent lawn-product applications if unusual damage continues.", ["fertilizer history", "herbicide history"]],
    ["identify-pest-sample", "Homeowner: save a clear photo or sample if live lawn pests reappear.", ["insect", "identification"]],
    ["mark-recurring-weeds", "Homeowner: note where recurring weeds are most concentrated.", ["weed map", "breakthrough"]],
    ["keep-pets-off-sample", "Homeowner: keep people and pets from disturbing a marked sample area.", ["diagnosis", "testing"]],
    ["soil-test", "Homeowner: consider soil testing if color or rooting problems persist.", ["ph", "nutrients"]],
    ["professional-drainage", "Homeowner: consult a drainage professional if low areas remain saturated.", ["standing water", "grading"]],
    ["tree-shade-review", "Homeowner: consider a qualified tree-care review where dense shade limits turf growth.", ["canopy", "low light"]],
    ["protect-new-sod", "Homeowner: limit traffic on newly installed sod until it is established.", ["new turf", "rooting"]],
    ["check-pet-pattern", "Homeowner: watch for repeated pet activity where isolated spots recur.", ["urine", "localized damage"]],
    ["report-fast-change", "Homeowner: contact the office if the affected area expands quickly.", ["worsening", "decline"]],
    ["continue-current-care", "Homeowner: continue the current care routine while the documented improvement holds.", ["progress", "stable"]],
  ]),
  completedActions: defineChoices("lawn", "completedActions", [
    ["inspected-turf", "Inspected the serviced turf areas.", ["assessment", "walkthrough"], { scope: "exterior", treatmentApplied: false }],
    ["inspected-roots", "Inspected affected turf and roots.", ["root zone", "diagnosis"], { scope: "exterior", treatmentApplied: false }],
    ["photographed-area", "Recorded close-up photographs of the affected area.", ["photos", "documented"], { scope: "exterior", treatmentApplied: false }],
    ["checked-live-pests", "Checked the lawn for live pest activity.", ["insects", "inspection"], { scope: "exterior", treatmentApplied: false }],
    ["documented-weeds", "Documented visible weed pressure and locations.", ["weed map", "findings"], { scope: "exterior", treatmentApplied: false }],
    ["tested-irrigation", "Tested irrigation coverage in the affected area.", ["sprinklers", "watering"], { scope: "exterior", treatmentApplied: false }],
    ["inspected-sprinklers", "Inspected accessible sprinkler heads and operating zones.", ["irrigation", "coverage"], { scope: "exterior", treatmentApplied: false }],
    ["checked-moisture", "Checked soil moisture in the affected area.", ["root zone", "wet dry"], { scope: "exterior", treatmentApplied: false }],
    ["checked-mowing", "Documented mowing height and visible mowing damage.", ["scalping", "blade tips"], { scope: "exterior", treatmentApplied: false }],
    ["checked-thatch", "Inspected the lawn for thatch buildup.", ["thatch layer", "assessment"], { scope: "exterior", treatmentApplied: false }],
    ["collected-soil-sample", "Collected a soil sample for analysis.", ["testing", "ph"], { scope: "exterior", treatmentApplied: false }],
    ["collected-turf-sample", "Collected a turf sample for further evaluation.", ["diagnosis", "lab"], { scope: "exterior", treatmentApplied: false }],
    ["compared-prior-visit", "Compared the area with the previous documented visit.", ["progress", "history"], { scope: "exterior", treatmentApplied: false }],
    ["marked-monitoring-area", "Marked the affected area for future comparison.", ["monitor", "location"], { scope: "exterior", treatmentApplied: false }],
    ["cleared-accessible-debris", "Cleared accessible debris that was covering turf.", ["clippings", "leaves"], { scope: "exterior", treatmentApplied: false }],
    ["applied-recorded-protocol", "Applied the documented lawn protocol to the recorded service area.", ["treatment", "application"], { scope: "exterior", treatmentApplied: true }],
    ["completed-broadcast", "Completed the documented broadcast application.", ["treatment", "entire lawn"], { scope: "exterior", treatmentApplied: true }],
    ["completed-targeted", "Completed a targeted application in the recorded area.", ["spot treatment", "localized"], { scope: "exterior", treatmentApplied: true }],
    ["treated-visible-weeds", "Spot-treated visible weeds in the recorded area.", ["weed control", "targeted"], { scope: "exterior", treatmentApplied: true }],
    ["completed-nutrient", "Completed the documented lawn nutrient application.", ["fertilizer", "nutrition"], { scope: "exterior", treatmentApplied: true }],
    ["completed-insect-control", "Completed the documented lawn insect-control application.", ["pests", "insects"], { scope: "exterior", treatmentApplied: true }],
    ["completed-disease-control", "Completed the documented lawn disease-control application.", ["fungus", "turf disease"], { scope: "exterior", treatmentApplied: true }],
    ["serviced-front-yard", "Completed lawn service in the front yard.", ["area", "zone"]],
    ["serviced-back-yard", "Completed lawn service in the back yard.", ["area", "zone"]],
    ["serviced-side-yards", "Completed lawn service in the side yards.", ["area", "zone"]],
    ["serviced-landscape-edges", "Completed the recorded work along lawn and landscape edges.", ["perimeter", "borders"]],
    ["recorded-products", "Recorded the products and actual amounts used during service.", ["application record", "materials"]],
    ["reviewed-work", "Reviewed the completed lawn work and recorded service areas.", ["closeout", "verification"]],
  ]),
});

const treeShrub = Object.freeze({
  observations: defineChoices("tree-shrub", "observations", [
    ["no-visible-stress", "No visible plant stress was noted in the inspected areas.", ["healthy", "stable"]],
    ["yellow-foliage", "Yellow foliage was visible; the cause was not confirmed.", ["chlorosis", "discoloration"]],
    ["discolored-foliage", "Discolored foliage was visible on inspected plants.", ["color", "leaves"]],
    ["leaf-spots", "Leaf spotting was visible; the cause was not confirmed.", ["lesions", "disease"]],
    ["leaf-chewing", "Leaf-chewing damage was visible; the cause was not confirmed.", ["feeding", "notches"]],
    ["distorted-growth", "Distorted new growth was visible; the cause was not confirmed.", ["curling", "deformed"]],
    ["premature-leaf-drop", "Premature leaf drop was visible beneath inspected plants.", ["defoliation", "fallen leaves"]],
    ["sparse-canopy", "Sparse foliage was visible in part of the canopy.", ["thin canopy", "density"]],
    ["branch-dieback", "Branch-tip dieback was visible.", ["decline", "dead tips"]],
    ["deadwood", "Dead or damaged branches were visible.", ["limbs", "pruning"]],
    ["wilted-foliage", "Wilted foliage was visible at the time of service.", ["drooping", "moisture stress"]],
    ["scale-like-insects", "Scale-like insects were visible; identification was not confirmed.", ["scale", "insects"]],
    ["cottony-material", "White cottony material was visible on plant tissue; the cause was not confirmed.", ["mealybug", "woolly"]],
    ["webbing", "Fine webbing was visible on inspected foliage.", ["mites", "silk"]],
    ["live-insects", "Live insects were visible on inspected plants.", ["pests", "bugs"]],
    ["sticky-sooty-coating", "A sticky or dark coating was visible on foliage.", ["honeydew", "sooty mold"]],
    ["fungal-like-growth", "Fungal-like growth was visible; the cause was not confirmed.", ["mushroom", "fruiting body"]],
    ["trunk-damage", "Visible damage was present on a trunk or main stem.", ["wound", "mechanical damage"]],
    ["bark-cracking", "Cracking or loose bark was visible.", ["trunk", "stem"]],
    ["root-exposure", "Surface roots or root-zone disturbance were visible.", ["exposed roots", "soil"]],
    ["dry-soil", "The inspected root-zone soil was dry.", ["moisture", "watering"]],
    ["saturated-soil", "The inspected root-zone soil was saturated.", ["wet", "overwatering"]],
    ["standing-water", "Standing water was visible near a plant root zone.", ["drainage", "ponding"]],
    ["uneven-irrigation", "Irrigation did not appear to reach all inspected plants evenly.", ["coverage", "sprinkler"]],
    ["frond-discoloration", "Palm frond discoloration was visible; the cause was not confirmed.", ["palms", "yellowing"]],
    ["dead-fronds", "Dead or damaged palm fronds were visible.", ["palms", "canopy"]],
    ["abnormal-new-growth", "Abnormal new plant growth was visible; the cause was not confirmed.", ["bud", "flush"]],
    ["structure-contact", "Plant growth was touching the structure.", ["branches", "roof wall"]],
  ]),
  recommendations: defineChoices("tree-shrub", "recommendations", [
    ["review-irrigation", "Homeowner: review irrigation if root-zone soil remains too wet or too dry.", ["watering", "moisture"]],
    ["check-coverage", "Homeowner: check that irrigation reaches the affected plants evenly.", ["sprinklers", "dry plants"]],
    ["repair-leak", "Homeowner: arrange repair if an irrigation leak continues near the root zone.", ["water", "sprinkler"]],
    ["address-drainage", "Homeowner: have persistent standing water near plant roots evaluated.", ["ponding", "saturated"]],
    ["avoid-trunk-watering", "Homeowner: adjust irrigation if water repeatedly strikes trunks or main stems.", ["sprinkler", "bark"]],
    ["keep-mulch-off-trunk", "Homeowner: keep mulch and soil from piling against trunks and main stems.", ["root flare", "mulch volcano"]],
    ["protect-roots", "Homeowner: avoid digging or compacting soil over visible root zones.", ["surface roots", "traffic"]],
    ["limit-mechanical-damage", "Homeowner: keep mowers and string trimmers away from trunks and stems.", ["equipment", "wounds"]],
    ["qualified-deadwood-review", "Homeowner: have hazardous or elevated dead branches assessed by a qualified tree professional.", ["arborist", "deadwood"]],
    ["remove-small-dead-material", "Homeowner: remove reachable dead plant material when it can be done without damaging live growth.", ["sanitation", "pruning"]],
    ["disinfect-pruning-tools", "Homeowner: clean pruning tools before moving between affected plants.", ["sanitation", "shears"]],
    ["avoid-unrecorded-products", "Homeowner: avoid adding unrecorded plant products while the cause of damage is uncertain.", ["fertilizer", "spray"]],
    ["share-product-history", "Homeowner: share recent plant-product applications if unusual damage continues.", ["fertilizer history", "treatment history"]],
    ["monitor-leaf-spots", "Homeowner: monitor leaf spotting and report meaningful spread or change.", ["lesions", "disease"]],
    ["monitor-new-growth", "Homeowner: monitor the next flush of growth for the same symptoms.", ["buds", "leaves"]],
    ["photograph-change", "Homeowner: take a clear photo if the affected plant changes before the next visit.", ["document", "progress"]],
    ["save-insect-sample", "Homeowner: save a clear photo or sample if live insects reappear.", ["identification", "pest"]],
    ["rinse-sooty-residue", "Homeowner: wait for pest activity to subside before gently cleaning accessible residue from foliage.", ["sooty coating", "honeydew"]],
    ["reduce-plant-contact", "Homeowner: trim plant growth away from walls and roofs and screens where practical.", ["structure contact", "branches"]],
    ["improve-airflow", "Homeowner: consider selective pruning by a qualified provider where crowding severely limits airflow.", ["dense canopy", "humidity"]],
    ["remove-fallen-debris", "Homeowner: remove heavy fallen-leaf and fruit buildup around affected plants.", ["sanitation", "debris"]],
    ["watch-palm-growth", "Homeowner: monitor the newest palm growth and report rapid decline.", ["bud", "spear leaf"]],
    ["professional-palm-review", "Homeowner: seek a qualified palm or tree assessment if canopy decline advances quickly.", ["arborist", "palms"]],
    ["confirm-plant-id", "Homeowner: confirm the plant variety if care requirements are uncertain.", ["species", "identification"]],
    ["avoid-root-zone-storage", "Homeowner: avoid storing heavy items over the affected root zone.", ["compaction", "traffic"]],
    ["keep-pets-away-sample", "Homeowner: keep people and pets from disturbing a marked sample area.", ["testing", "diagnosis"]],
    ["report-fast-change", "Homeowner: contact the office if visible decline spreads quickly.", ["worsening", "urgent"]],
    ["continue-current-care", "Homeowner: continue the current care routine while the documented improvement holds.", ["stable", "progress"]],
  ]),
  completedActions: defineChoices("tree-shrub", "completedActions", [
    ["inspected-plants", "Inspected the serviced trees and shrubs and ornamentals.", ["plant health", "assessment"], { scope: "exterior", treatmentApplied: false }],
    ["tagged-plants", "Identified and recorded the affected plants.", ["tag", "location"]],
    ["photographed-plants", "Recorded close-up photographs of the affected plants.", ["photos", "documented"]],
    ["compared-prior-visit", "Compared plant condition with the previous documented visit.", ["progress", "history"]],
    ["checked-leaf-undersides", "Inspected leaf surfaces and undersides for visible activity.", ["insects", "eggs"]],
    ["checked-branches", "Inspected accessible branches and new growth.", ["canopy", "buds"]],
    ["checked-trunks", "Inspected accessible trunks and main stems.", ["bark", "wounds"]],
    ["checked-root-zones", "Inspected accessible root zones and surface roots.", ["soil", "root flare"]],
    ["checked-moisture", "Checked soil moisture around affected plants.", ["wet dry", "root zone"]],
    ["checked-irrigation", "Checked irrigation coverage around affected plants.", ["sprinklers", "watering"]],
    ["documented-insects", "Documented visible plant-pest activity and locations.", ["bugs", "findings"]],
    ["documented-damage", "Documented visible foliage and branch or trunk damage.", ["findings", "condition"], { scope: "exterior", treatmentApplied: false }],
    ["collected-sample", "Collected a plant sample for further evaluation.", ["leaf", "diagnosis"]],
    ["marked-monitoring-plant", "Marked the affected plant for future comparison.", ["tagged", "monitor"]],
    ["removed-accessible-debris", "Removed accessible dead plant debris from the serviced area.", ["sanitation", "fallen leaves"], { scope: "exterior", treatmentApplied: false }],
    ["removed-accessible-webbing", "Removed accessible webbing from inspected foliage.", ["mechanical", "cleanup"], { scope: "exterior", treatmentApplied: false }],
    ["applied-recorded-protocol", "Applied the documented tree and shrub protocol to the recorded plants.", ["treatment", "application"], { scope: "exterior", treatmentApplied: true }],
    ["completed-foliar", "Completed the documented foliar application.", ["leaf spray", "treatment"], { scope: "exterior", treatmentApplied: true }],
    ["completed-root-zone", "Completed the documented root-zone application.", ["soil treatment", "drench"], { scope: "exterior", treatmentApplied: true }],
    ["completed-granular", "Completed the documented granular application.", ["soil", "broadcast"], { scope: "exterior", treatmentApplied: true }],
    ["completed-targeted", "Completed a targeted application on the recorded plants.", ["spot treatment", "localized"], { scope: "exterior", treatmentApplied: true }],
    ["completed-trunk", "Completed the documented trunk application.", ["injection", "stem"], { scope: "exterior", treatmentApplied: true }],
    ["treated-visible-activity", "Treated the recorded area of visible plant-pest activity.", ["insects", "localized"], { scope: "exterior", treatmentApplied: true }],
    ["serviced-palms", "Completed the recorded palm-care work.", ["palms", "fronds"]],
    ["serviced-foundation-beds", "Completed tree and shrub service in the foundation beds.", ["landscape", "zone"]],
    ["serviced-pool-landscape", "Completed tree and shrub service in the pool or lanai landscape.", ["landscape", "zone"]],
    ["recorded-products", "Recorded the products and actual amounts used during service.", ["application record", "materials"]],
    ["reviewed-work", "Reviewed the completed plant-health work and recorded service areas.", ["closeout", "verification"]],
  ]),
});

const recurringPest = Object.freeze({
  observations: defineChoices("recurring-pest", "observations", [
    ["no-live-interior", "No live pest activity was visible in the inspected interior areas.", ["clear", "inside"]],
    ["no-live-exterior", "No live pest activity was visible in the inspected exterior areas.", ["clear", "outside"]],
    ["live-interior", "Live pest activity was visible in an inspected interior area.", ["insects", "inside"]],
    ["live-exterior", "Live pest activity was visible in an inspected exterior area.", ["insects", "outside"]],
    ["dead-insects", "Dead insects were visible in the inspected area.", ["pest evidence", "bodies"]],
    ["webbing", "Pest webbing was visible in the inspected area.", ["spider webs", "cobwebs"]],
    ["droppings", "Pest droppings were visible; the source was not confirmed.", ["feces", "evidence"]],
    ["shed-skins", "Shed insect skins were visible.", ["cast skins", "evidence"]],
    ["egg-cases", "Possible insect egg cases were visible; identification was not confirmed.", ["ootheca", "eggs"]],
    ["trails", "Visible pest trails or travel paths were present.", ["ants", "movement"]],
    ["harborage", "A potential pest harborage area was visible.", ["hiding place", "nesting"]],
    ["entry-gaps", "Accessible gaps or openings were visible near a likely entry path.", ["cracks", "penetrations"]],
    ["moisture", "Moisture was visible near the reported activity area.", ["damp", "leak"]],
    ["food-residue", "Accessible food residue was visible near the reported activity area.", ["crumbs", "grease"]],
    ["trash-access", "Trash or recycling material was accessible to pests.", ["garbage", "containers"]],
    ["pet-food-access", "Pet food or water was accessible in the activity area.", ["bowls", "feeding"]],
    ["vegetation-contact", "Vegetation was touching the structure.", ["branches", "shrubs"]],
    ["leaf-litter", "Heavy leaf litter or mulch buildup was visible near the structure.", ["debris", "harborage"]],
    ["standing-water", "Standing water was visible on the inspected exterior.", ["moisture", "drainage"]],
    ["station-disturbed", "A monitored pest station appeared disturbed or moved.", ["bait station", "device"]],
    ["bait-consumption", "Bait consumption was visible in a monitored station.", ["feeding", "station"]],
    ["station-damaged", "A monitored pest station was damaged or inaccessible.", ["device", "bait"]],
    ["area-inaccessible", "Part of the reported activity area was inaccessible during inspection.", ["blocked", "unable to inspect"]],
    ["reported-not-observed", "Customer-reported activity was not visible during today’s inspection.", ["no evidence", "complaint"]],
    ["activity-reduced", "Visible activity was reduced from the previous documented visit.", ["improved", "progress"]],
    ["activity-increased", "Visible activity increased from the previous documented visit.", ["worsening", "trend"]],
    ["door-window-activity", "Pest activity was visible near a door or window.", ["entry point", "threshold"]],
    ["utility-entry-activity", "Pest activity was visible near a utility or plumbing entry.", ["penetration", "pipes"]],
  ]),
  recommendations: defineChoices("recurring-pest", "recommendations", [
    ["seal-gaps", "Homeowner: seal accessible gaps after confirming they are not needed for ventilation or drainage.", ["entry points", "cracks"]],
    ["repair-screen", "Homeowner: repair damaged door or window or enclosure screens.", ["entry", "mesh"]],
    ["door-sweep", "Homeowner: repair or replace a door sweep that leaves a visible gap.", ["threshold", "entry"]],
    ["utility-gaps", "Homeowner: seal suitable gaps around utility and plumbing entries.", ["pipes", "penetrations"]],
    ["address-leak", "Homeowner: arrange repair of leaks or recurring moisture near the activity area.", ["water", "damp"]],
    ["dry-standing-water", "Homeowner: remove avoidable standing water from containers and low spots.", ["moisture", "drainage"]],
    ["store-food", "Homeowner: keep open food in sealed containers.", ["pantry", "kitchen"]],
    ["clean-residue", "Homeowner: clean food residue and grease and spills near the activity area.", ["sanitation", "crumbs"]],
    ["pet-food", "Homeowner: store pet food securely and remove leftover food after feeding.", ["bowls", "kibble"]],
    ["secure-trash", "Homeowner: keep trash and recycling containers closed and clean.", ["garbage", "bins"]],
    ["reduce-cardboard", "Homeowner: reduce stored cardboard and paper clutter near the activity area.", ["boxes", "harborage"]],
    ["declutter", "Homeowner: reduce clutter that limits inspection or creates hiding areas.", ["storage", "harborage"]],
    ["move-storage-off-wall", "Homeowner: move stored items away from walls where practical so edges remain inspectable.", ["garage", "access"]],
    ["trim-vegetation", "Homeowner: trim vegetation away from walls and roofs and screens where practical.", ["branches", "structure contact"]],
    ["reduce-leaf-litter", "Homeowner: remove heavy leaf litter and plant debris next to the structure.", ["mulch", "harborage"]],
    ["move-firewood", "Homeowner: store firewood and similar materials away from the structure where practical.", ["wood pile", "harborage"]],
    ["clean-drains", "Homeowner: clean accessible drains if organic buildup or small-fly activity continues.", ["flies", "moisture"]],
    ["repair-vent", "Homeowner: repair damaged vent covers while preserving required airflow.", ["screen", "attic crawlspace"]],
    ["avoid-moving-devices", "Homeowner: leave monitoring devices and bait stations in their recorded locations.", ["traps", "stations"]],
    ["keep-area-accessible", "Homeowner: keep the reported area accessible for future inspection.", ["clear access", "storage"]],
    ["save-sample", "Homeowner: save a clear photo or sample if the pest reappears.", ["identification", "bug"]],
    ["note-time-location", "Homeowner: note the time and exact location if activity returns.", ["monitor", "pattern"]],
    ["monitor-entry", "Homeowner: monitor the documented door or window or utility entry for renewed activity.", ["entry point", "watch"]],
    ["report-indoor-activity", "Homeowner: contact the office if live interior activity continues.", ["callback", "persistent"]],
    ["report-increase", "Homeowner: contact the office if visible activity increases substantially.", ["worsening", "follow up"]],
    ["check-deliveries", "Homeowner: inspect incoming boxes or stored goods if activity is concentrated nearby.", ["cardboard", "pantry pest"]],
    ["launder-pet-bedding", "Homeowner: clean pet bedding if pest evidence is concentrated in the pet-resting area.", ["fleas", "pet area"]],
    ["continue-sanitation", "Homeowner: continue the current sanitation and exclusion steps while activity remains reduced.", ["progress", "prevention"]],
  ]),
  completedActions: defineChoices("recurring-pest", "completedActions", [
    ["inspected-interior", "Inspected the recorded interior service areas.", ["inside", "assessment"], { scope: "interior", treatmentApplied: false }],
    ["inspected-exterior", "Inspected the recorded exterior service areas.", ["outside", "assessment"], { scope: "exterior", treatmentApplied: false }],
    ["inspected-entry-points", "Inspected accessible doors and windows and utility entry points.", ["gaps", "penetrations"], { treatmentApplied: false }],
    ["documented-activity", "Documented visible pest activity and locations.", ["findings", "map"]],
    ["photographed-evidence", "Recorded photographs of visible pest evidence.", ["photos", "documented"]],
    ["identified-harborage", "Documented accessible pest harborage areas.", ["hiding", "nesting"]],
    ["checked-moisture", "Checked accessible moisture sources near the activity area.", ["leak", "damp"]],
    ["checked-stations", "Checked the recorded monitoring or bait stations.", ["devices", "traps"]],
    ["replaced-station", "Replaced a damaged or missing monitored station.", ["bait station", "device"]],
    ["reset-monitor", "Reset or repositioned a monitored pest device.", ["trap", "station"]],
    ["removed-webs", "Removed accessible webs from the recorded exterior areas.", ["de-webbed", "cobweb sweep"], { scope: "exterior", treatmentApplied: false }],
    ["removed-evidence", "Removed accessible pest evidence from the inspected area.", ["cleanup", "droppings"], { treatmentApplied: false }],
    ["applied-perimeter-band", "Applied the documented exterior perimeter band.", ["barrier", "foundation"], { scope: "exterior", treatmentApplied: true }],
    ["treated-entry-points", "Treated the recorded exterior entry points.", ["doors", "windows", "pipes"], { scope: "exterior", treatmentApplied: true }],
    ["applied-exterior-nonrepellent", "Applied the documented non-repellent treatment to recorded exterior areas.", ["outside", "application"], { scope: "exterior", treatmentApplied: true }],
    ["applied-interior-nonrepellent", "Applied the documented non-repellent treatment to recorded interior areas.", ["inside", "application"], { scope: "interior", treatmentApplied: true }],
    ["applied-exterior-repellent", "Applied the documented repellent treatment to recorded exterior areas.", ["outside", "application"], { scope: "exterior", treatmentApplied: true }],
    ["applied-interior-repellent", "Applied the documented repellent treatment to recorded interior areas.", ["inside", "application"], { scope: "interior", treatmentApplied: true }],
    ["completed-baseboard-treatment", "Completed the documented interior edge and baseboard treatment.", ["kitchen", "bath", "inside"], { scope: "interior", treatmentApplied: true }],
    ["completed-crack-crevice", "Completed the documented crack-and-crevice treatment.", ["gaps", "targeted"], { scope: "interior", treatmentApplied: true }],
    ["applied-gel-bait", "Applied gel bait in the recorded locations.", ["bait", "interior"], { scope: "interior", treatmentApplied: true }],
    ["dusted-voids", "Applied dust to the recorded accessible voids.", ["wall void", "application"], { scope: "interior", treatmentApplied: true }],
    ["serviced-eaves", "Completed the recorded eave and soffit service.", ["roofline", "exterior"]],
    ["serviced-garage", "Completed the recorded garage service.", ["interior", "area"]],
    ["serviced-kitchen-baths", "Completed the recorded kitchen and bathroom service.", ["interior", "area"]],
    ["serviced-lanai", "Completed the recorded lanai or pool-cage service.", ["screened enclosure", "area"]],
    ["recorded-products", "Recorded the products and actual amounts used during service.", ["application record", "materials"]],
    ["reviewed-work", "Reviewed the completed pest-control work and recorded service areas.", ["closeout", "verification"]],
  ]),
});

export const SERVICE_COMPLETION_CHOICES = Object.freeze({
  lawn,
  tree_shrub: treeShrub,
  recurring_pest: recurringPest,
});

export const SERVICE_COMPLETION_CHOICE_COUNTS = Object.freeze(Object.fromEntries(
  SERVICE_COMPLETION_CHOICE_FAMILIES.map((family) => [family, Object.freeze(Object.fromEntries(
    SERVICE_COMPLETION_CHOICE_CATEGORIES.map((category) => [category, SERVICE_COMPLETION_CHOICES[family][category].length]),
  ))]),
));

const FAMILY_ALIASES = Object.freeze({
  lawn: "lawn",
  lawn_care: "lawn",
  tree_shrub: "tree_shrub",
  tree_and_shrub: "tree_shrub",
  trees_shrubs: "tree_shrub",
  ornamental: "tree_shrub",
  palm: "tree_shrub",
  recurring_pest: "recurring_pest",
  pest: "recurring_pest",
  pest_control: "recurring_pest",
  general_pest: "recurring_pest",
});

const CATEGORY_ALIASES = Object.freeze({
  observation: "observations",
  observations: "observations",
  recommendation: "recommendations",
  recommendations: "recommendations",
  action: "completedActions",
  actions: "completedActions",
  completed_action: "completedActions",
  completed_actions: "completedActions",
  completedactions: "completedActions",
  actionscompleted: "completedActions",
  protocolactionscompleted: "completedActions",
  protocol_action: "completedActions",
  protocol_actions: "completedActions",
});

function normalizedKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeServiceCompletionChoiceFamily(value) {
  const key = normalizedKey(value);
  return Object.hasOwn(FAMILY_ALIASES, key) ? FAMILY_ALIASES[key] : null;
}

export function normalizeServiceCompletionChoiceCategory(value) {
  const key = normalizedKey(value);
  return Object.hasOwn(CATEGORY_ALIASES, key) ? CATEGORY_ALIASES[key] : null;
}

export function serviceCompletionChoicesFor(family, category) {
  const familyKey = normalizeServiceCompletionChoiceFamily(family);
  const categoryKey = normalizeServiceCompletionChoiceCategory(category);
  if (!familyKey || !categoryKey) return [];
  return SERVICE_COMPLETION_CHOICES[familyKey][categoryKey];
}

export function searchServiceCompletionChoices(family, category, query = "") {
  const choices = serviceCompletionChoicesFor(family, category);
  const terms = normalizedKey(query).split("_").filter(Boolean);
  if (!terms.length) return choices;
  return choices.filter((choice) => {
    const haystack = normalizedKey([choice.label, ...choice.keywords].join(" "));
    return terms.every((term) => haystack.includes(term));
  });
}
