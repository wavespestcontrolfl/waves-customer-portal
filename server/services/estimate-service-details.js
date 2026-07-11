// ============================================================
// estimate-service-details.js — per-service "full details" guide
//
// One PDF guide per service line on an estimate. Three layers:
//   1. process + inclusions copy (inspection-led protocol walkthrough),
//   2. answers to the questions customers ACTUALLY ask (mined from real
//      SMS threads + call transcripts, 2026-07 — interior vs exterior,
//      pet safety, rain, bait-vs-tent, Bermuda, …),
//   3. the public product registry (name, active ingredient, EPA reg #,
//      re-entry guidance, label/SDS links) filtered to that service line,
// plus the documentation differentiators (service reports, live GPS
// tracking, the Waves app, lawn assessment intelligence) and the product &
// safety standard ("EPA-registered", never "EPA-approved"; no absolute
// safety claims; re-entry is product-specific).
//
// Requested BY the customer from their own estimate page and delivered only
// to the contact info already on the estimate — email (PDF attached) or SMS
// (tokened link to the same PDF). The whole surface is dark behind
// GATE_SERVICE_DETAILS_PDF until the owner approves this copy.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');

// Registry `service_product_usage.service_type` values are human labels
// ("Quarterly Pest Control", "Mosquito Treatment - Essential Barrier") —
// match them to estimate service keys by pattern so new registry rows keep
// flowing in without a code change.
const REGISTRY_PATTERNS = {
  pest_control: /pest control|pest perimeter|ant service/i,
  mosquito: /^mosquito/i,
  termite_bait: /^termite bait/i,
  lawn_care: /^lawn care/i,
  tree_shrub: /tree\s*&\s*shrub/i,
};

// Shared documentation section — the differentiators every guide carries.
// The lawn guide appends its assessment-intelligence line.
const DOCUMENTATION_SECTION = {
  heading: 'Documented every visit — no mystery treatments, no missing paperwork',
  bullets: [
    'Every completed visit produces a digital service report: areas inspected, findings, areas treated, the exact products applied, technician notes, photos when findings warrant them, and the precautions applicable to that visit.',
    'Track your technician’s live location and estimated arrival in the Waves app once they’re en route — no waiting on a four-hour window.',
    'The app also carries your full visit history, upcoming schedule, invoices and autopay, household contacts for shared alerts, and every past report — savable and shareable as a PDF.',
    'Your service report is the property-specific record of what was inspected, found, and performed at YOUR home \u2014 it names the exact products used, not a generic list. Your service agreement controls the plan itself: covered pests, frequency, exclusions, and guarantee terms.',
  ],
};

const LAWN_DOCUMENTATION_EXTRA = 'Lawn visits also feed your lawn-health score and assessment history — treatment decisions are informed by a growing knowledge base built from real Southwest Florida lawn outcomes, not guesswork.';

// Pet/kid safety standard — shared across guides, and deliberately the
// DEEPEST section (owner directive 2026-07-10: safety questions dominate the
// real inbound corpus — win on technical transparency). Wording rules
// (owner-supplied compliance review, FIFRA): "EPA-registered" never
// "EPA-approved"; a pesticide is never called "safe"/"non-toxic"/"harmless";
// no blanket "low toxicity" claims; re-entry is product-specific. The
// strategy is to EXPLAIN the engineering — registration rigor, signal
// words, label rates, exposure control — not to assert a conclusion the
// label doesn't allow.
const SAFETY_SECTION = {
  heading: 'Pets, kids & your family — how safety is engineered into every visit',
  paragraphs: [
    'If you have kids or pets, this is probably your most important question — it is the single most common question we get, so here is the full technical answer instead of a one-liner.',
    'Every pesticide product Waves applies is EPA-registered and used in accordance with its product label. Registration means the EPA evaluated the required scientific data and the proposed label and determined the product can be used without unreasonable adverse effects when the label is followed \u2014 and that label is legally binding: it dictates where the product may go, at what rate, with what precautions, and when people and pets may re-enter. EPA registration does not mean exposure is risk-free; in this industry the label is the law, and our technicians treat it that way.',
  ],
  bullets: [
    'Read the signal word on every product card in this guide. It is the EPA\u2019s at-a-glance acute-hazard communication: DANGER is the most severe category, WARNING is next, and CAUTION is the lowest signal-word category. It reflects the product\u2019s acute hazard labeling \u2014 a useful indicator, though not a complete measure of every risk, which is why the full label governs every application.',
    'Professional products are applied at label-mandated dilution rates measured in fractions of an ounce per gallon \u2014 our primary residual perimeter products go down at finished concentrations well under one-tenth of one percent active ingredient. Concentration alone does not set the precautions, though: the label does, and we follow it in full.',
    'Risk depends on both what a product is and how much of it people actually contact \u2014 so we drive the contact side down. Crack-and-crevice, void, bait, and station placements put product where insects travel and children and pets do not: behind appliances, inside wall voids, along the foundation line \u2014 and always away from toys, food surfaces, and pet dishes.',
    'Where a program uses insect-specific chemistry, we say so \u2014 insect growth regulators (mosquito and flea programs) disrupt molting and reproduction hormone systems that mammals simply do not have.',
    'The "keep off until dry" rule has a mechanism behind it: while a liquid application is wet, it can transfer to skin, paws, and mouths; once dry, the residue stays on the treated surface where insects contact it. For labels that require it, complete drying \u2014 not a generic clock time \u2014 is the controlling condition, and your service report carries the precautions for the products actually used at your visit.',
    'More product is never the answer. Rates come from the label, not from pest pressure or an upsell — correct identification, accurate placement, and label-compliant application are what produce results.',
    'Waves Pest Control, LLC operates under Florida pest-control business license JB351547 and is insured, and every applied product is documented in your service report with its own re-entry guidance \u2014 so you never have to wonder what was used at your home or when the yard is yours again.',
  ],
  closing: 'We will never tell you a pesticide is \u201c100% safe\u201d \u2014 no honest company can, and the EPA does not permit that claim for any product. What we can show you is every choice made to minimize exposure, and the paper trail to verify it \u2014 our technicians treat their own homes with the same products and the same rules.',
};

// Customer-facing copy per service. `included` mirrors the estimate card
// inclusions; `process` is the inspection-led protocol walkthrough; `faq`
// answers the questions mined from real SMS threads and call transcripts.
// OWNER REVIEWS ALL OF THIS BEFORE THE GATE FLIPS — anything field reality
// doesn't back gets cut.
const SERVICE_DETAILS_COPY = {
  pest_control: {
    title: 'Pest Protection — Service Details',
    systemBox: {
      heading: 'Your plan at a glance',
      rows: [
        ['Service cadence', 'Quarterly, bi-monthly, or monthly \u2014 you pick on your estimate'],
        ['Primary solutions', 'Taurus SC\u00ae (fipronil) & Talstar\u00ae P (bifenthrin) \u2014 selected per inspection & label'],
        ['Covered pests', 'Ants (incl. ghost, big-headed, carpenter & fire-ant mounds near the structure), large roaches (American, Australian, smokybrown \u2014 \u201cpalmetto bugs\u201d), spiders (incl. widow & recluse), crickets, earwigs, silverfish, millipedes, centipedes, pillbugs, scorpions, wasps, stink & boxelder bugs'],
        ['Interior service', 'Included for covered pests whenever you report activity'],
        ['Re-service', 'Unlimited, no charge, for covered pests between visits'],
        ['Guarantee', '90-day money-back on recurring plans'],
        ['Separate services', 'German-roach cleanouts, fleas, bed bugs, rodents, wildlife, turf insect programs'],
      ],
      note: 'Product selection follows the inspection and the label \u2014 not every product is used at every home or every visit. Your estimate and service agreement control the plan.',
    },
    tagline: 'Inspection-led service for covered household pests \u2014 documented visits, no-charge re-service between appointments.',
    included: [
      'Exterior perimeter protection around entry-prone areas',
      'Interior service support when activity is reported',
      'Web, nest, and egg-sac removal from accessible exterior areas',
      'Free re-service between recurring visits',
    ],
    process: [
      'Every visit starts with inspection, not application: the foundation and lower walls, door and garage thresholds, window frames and sills, utility penetrations, cracks and crevices, eaves and soffits, lanai and entry areas, and the landscape zones touching the structure.',
      'Product selection follows the inspection, not a script. Depending on the findings, the technician may place non-repellent products where pests actively enter, travel, and harbor, and residual contact or repellent treatments in appropriate labeled exterior zones \u2014 when both are used, placement is planned around the labels and the target pest.',
      'Some non-repellent products can extend control beyond the first insect that contacts or consumes them: for certain ants and cockroaches, exposed insects can pass the effect through contact, feeding, and grooming. That transfer is product- and pest-specific \u2014 we use it where it genuinely applies and never present it as a universal effect or a colony-elimination guarantee.',
      'Where the pest, site, and label support it, the technician establishes a residual exterior treatment zone at selected foundation, threshold, landscape-edge, and eave areas identified during inspection \u2014 targeted placement, never an automatic pass over every wall, plant, and surface.',
      'Targeted interior service is included for pests covered by your recurring plan: baits, gels, monitors, crack-and-crevice, and void placements at travel and harborage areas \u2014 plumbing penetrations, under sinks, behind appliances \u2014 rather than routine baseboard spraying. Specialty infestations (German-cockroach cleanouts, fleas, bed bugs, rodents) are separate services unless your estimate expressly includes them.',
      'Routine exterior visits include removal of accessible spider webs, egg sacs, and inactive nest material from designated service areas \u2014 wherever they can be safely reached from the ground with standard service equipment. Active stinging-insect nests and work needing specialized access are handled under the applicable service terms.',
    ],
    faq: [
      {
        q: 'Which pests are actually covered?',
        a: 'The plan is built around two professional mainstays \u2014 Taurus SC\u00ae (fipronil, non-repellent) and Talstar\u00ae P (bifenthrin, residual) \u2014 and covers the household pests on their labels: ants including ghost, big-headed, carpenter, and fire-ant mounds near the structure; the big Florida roaches (American, Australian, smokybrown \u2014 the \u201cpalmetto bugs\u201d); spiders including widow and recluse; crickets, earwigs, silverfish, millipedes, centipedes, pillbugs, scorpions, wasps, and stink and boxelder bugs. German-cockroach cleanouts, fleas, bed bugs, rodents, and turf insect programs are separate services with their own treatment plans.',
      },
      {
        q: 'Does pest control spray around the house base or just the grass?',
        a: 'The structure and the pest zones immediately around it: foundation band, entry points, thresholds, eaves, and the landscape edges touching the home. It is a structural application, not a turf application — full-lawn insect programs (chinch bugs, grubs, webworms) belong to the lawn program, and mosquitoes to the mosquito program. We will spot-treat a grassy area when activity there threatens the structure and the label allows it.',
      },
      {
        q: 'Is the interior included, or is that extra?',
        a: 'Included for the pests your recurring plan covers \u2014 whenever you see covered activity inside, targeted interior treatment is part of the plan at no extra charge. Specialty infestations (German-cockroach cleanouts, fleas, bed bugs, rodents) are their own services and are included only when your estimate says so.',
      },
      {
        q: 'Is it safe for my kids and pets?',
        a: 'This deserves more than a one-liner \u2014 see the full \u201cPets, kids & your family\u201d section below. The short version: every pesticide is EPA-registered and applied at label-mandated dilutions, placed where insects travel and kids and pets do not, and your service report carries the precautions for the products actually used. The practical rule: keep people and pets off treated areas until completely dry when the label requires it.',
      },
      {
        q: 'What if it rains after my treatment?',
        a: 'Before treating, the technician weighs current and forecast weather, wind, surface moisture, and the product label \u2014 we do not apply when conditions would violate the label or waste the treatment. Select microencapsulated formulations add controlled release and residual staying power, but no application is weatherproof: if heavy rain hits before a treatment dries or you think an application was compromised, contact us and we will re-service at no charge when your plan warrants it.',
      },
      {
        q: 'I still see ants a few days after treatment — is it working?',
        a: 'Often, yes \u2014 non-repellent and bait treatments are intentionally slower than contact-kill sprays because foragers have to contact or consume them, so continued activity for several days is normal. An apparent increase does not by itself prove the treatment is working, though \u2014 give it 7\u201310 days, and if activity is not clearly declining by then, request your no-charge re-service. That is exactly what it exists for.',
      },
      {
        q: 'Do I need to be home?',
        a: 'For the initial visit, we ask that an adult be available when it includes a walkthrough or interior service. Routine exterior visits generally do not need anyone home as long as we have safe access to gates and covered areas \u2014 and you can watch the technician\u2019s arrival live in the app either way.',
      },
    ],
  },
  mosquito: {
    title: 'Mosquito Defense — Service Details',
    tagline: 'Targeted adult-mosquito treatment, breeding-source inspection, and documented recurring visits — a population-reduction program, honestly framed.',
    systemBox: {
      heading: 'Your plan at a glance',
      rows: [
        ['Program', 'Monthly (12 visits/yr) or Seasonal (9 visits) — you pick on your estimate'],
        ['Covered pest', 'Mosquitoes'],
        ['Other biting insects', 'No-see-ums, biting midges, gnats, fleas & ticks only when named in your estimate'],
        ['Every visit', 'Adult-mosquito treatment in resting zones + inspection of accessible on-property water sources'],
        ['Larval control', 'EPA-registered larvicide or growth regulator applied only to eligible, label-approved sites within your covered area'],
        ['Re-service', 'No-charge re-service for qualifying mosquito activity between visits'],
        ['Guarantee', '90-day money-back on recurring plans'],
      ],
      note: 'This is a population-reduction program — not a promise of zero mosquitoes, zero bites, or disease prevention. Your estimate and service agreement control the plan.',
    },
    included: [
      'Targeted adult-mosquito treatment in identified resting zones',
      'Inspection of accessible on-property water-holding sources, documented each visit',
      'Label-directed larval treatment of eligible water sources within the covered area',
      'Weather-aware treatment timing',
    ],
    process: [
      'Many adult mosquitoes rest through the heat of the day in shaded, humid, protected places — dense vegetation, fence lines, lanai framing, under decks and outdoor structures. We direct treatment there with gas-powered backpack misting equipment that places fine, labeled spray droplets into and beneath the foliage — controlled placement where mosquitoes actually rest, not a blanket pass over the lawn.',
      'The treatment reduces adult mosquitoes that contact treated surfaces and pressure from mosquitoes entering the yard. It is not a physical barrier — no honest company will tell you nothing can fly in from next door.',
      'Every visit includes a visual inspection of accessible, on-property water-holding sources — planters, toys, tarps, birdbaths, bromeliads, visible drainage, accessible gutters — with each finding documented: emptied, treated, inaccessible, off-property, or flagged for you to correct.',
      'Where the label, site, and your plan allow, standing water that cannot be emptied is treated with an EPA-registered larvicide or insect growth regulator — applied only through label-approved methods to eligible locations. Adult sprays, by contrast, are kept out of water and away from drift into aquatic areas per label; the two applications are separate tools with separate rules.',
      'We do not treat what is not ours to treat: neighboring property, HOA ponds, public storm drains, canals, and wetlands are outside a residential program\u2019s authority — we document off-property pressure so you know where it is coming from.',
    ],
    responsibilities: {
      heading: 'How you can multiply the results',
      bullets: [
        'Empty, scrub, cover, or toss water-holding containers weekly — some mosquito eggs glue to container walls and survive drying, which is why scrubbing matters, not just dumping.',
        'Unlock gates on service day, keep people and pets clear during application, and tell us about beehives, butterfly gardens, edible plants, koi ponds, or anywhere you do not want treated.',
        'Fix leaking irrigation, clogged gutters, and drainage low spots when practical — one neglected source can outbreed a treated yard.',
      ],
    },
    faq: [
      {
        q: 'Isn\u2019t my quarterly pest control enough for mosquitoes?',
        a: 'No — and that is by design, not upselling. Pest control treats the structure; mosquitoes rest in foliage and breed in water, which structural treatment does not reach. The mosquito program exists because the two problems live in different places.',
      },
      {
        q: 'Does this cover no-see-ums and biting midges?',
        a: 'The program covers mosquitoes. No-see-ums, biting midges, gnats, fleas, and ticks are different insects with different habits and label requirements — they are included only when specifically named in your estimate. If bites near the water are your real problem, tell us and we will scope the right treatment instead of letting a mosquito plan disappoint you.',
      },
      {
        q: 'Will this eliminate every mosquito?',
        a: 'No honest company promises that. Pressure can rebuild from rainfall, standing water, and neighboring properties. What the program delivers is a meaningful reduction in biting pressure — backed by recurring treatment, documented source inspections, and no-charge re-service for qualifying activity between visits. Most customers buy it because the patio, pool, and lanai become usable again; we back that goal with work, not a zero-mosquito promise.',
      },
      {
        q: 'Monthly or seasonal — which should I pick?',
        a: 'Monthly (12 visits) holds pressure down year-round and suits properties near water or heavy vegetation. Seasonal (9 visits) concentrates on the high-pressure months at a lower annual cost. Your estimate recommends one based on your property; you can switch on the estimate page.',
      },
      {
        q: 'How do you handle kids, pets, gardens, pollinators, and water?',
        a: 'Before treating, the technician accounts for play areas, pets, open blooms and active pollinators, edible plants, ponds, pools, aquarium airways, wind, and neighboring property — placement and product selection follow the complete label. Adult sprays are kept off edible plants unless the specific label permits it, and away from blooms and aquatic features where the label requires. Larvicides are the one deliberate water application, used only on eligible sites. Tell us about hives, butterfly gardens, or koi ponds before service, and keep people and pets clear until the report\u2019s re-entry condition is met.',
      },
      {
        q: 'What if it rains right after treatment?',
        a: 'We evaluate current and forecast weather, wind, and wet foliage against the product label before treating — and we do not apply when the label says no. No exterior treatment is weatherproof: if heavy rain hits before an application dries or you believe a visit was compromised, contact us and we will re-service at no charge when your plan warrants it.',
      },
      {
        q: 'Why is there a sign in my yard after service?',
        a: 'Florida law requires a conspicuous treatment notice whenever pesticide is applied to lawn or exterior foliage. We post it at every qualifying visit — and pair it with something better than a sign: a digital report naming the exact products, treatment areas, and precautions for your property.',
      },
    ],
    ctaMicro: 'Month-to-month plan \u00b7 No-charge re-service for qualifying mosquito activity \u00b7 90-day money-back guarantee',
    illustrations: ['treatment_notice'],
  },
  termite_bait: {
    title: 'Termite Defense — Service Details',
    // Review-corrected (2026-07-10, label-sourced): no "works while nobody is
    // watching" vs "only while someone is watching" contradiction.
    tagline: 'Always working between visits — professionally verified on schedule.',
    // Page-1 system box (external review §1): name the actual system. Facts
    // from the Trelona ATBS Annual label, EPA Reg. No. 499-557.
    systemBox: {
      heading: 'Your system at a glance',
      rows: [
        ['System', 'Trelona\u00ae ATBS Annual Bait Stations (BASF)'],
        ['Stations target', 'Subterranean termites (incl. Formosan)'],
        ['Guarantee covers', 'Subterranean & Formosan, drywood, powderpost beetles, old house borers'],
        ['Active ingredient', 'Novaluron 0.5%'],
        ['EPA Registration No.', '499-557'],
        ['Signal word', 'CAUTION'],
        ['Standard station checks', '4 per year (quarterly)'],
        ['Required for guarantee', 'Annual inspection + current payments'],
        ['Warranty type', 'Retreatment AND repair (per written agreement)'],
        ['Repair coverage', 'Up to $1,000,000 for new covered WDO damage'],
        ['Transferable', 'Yes \u2014 to a new homeowner ($250 + transfer inspection)'],
        ['Station ownership', 'Yours \u2014 purchased once with installation'],
      ],
      note: 'Your signed termite agreement controls the covered structures, covered organisms, warranty type, renewal, limitations, and exclusions — this guide explains how the program works.',
    },
    included: [
      'Trelona\u00ae ATBS bait stations installed in accessible soil around the covered structure',
      'An installation report with the actual station count and locations',
      'Quarterly inspection of every accessible station, documented every time',
      'Bait replacement when consumption or condition meets the manufacturer\u2019s criteria',
    ],
    process: [
      'We install Trelona\u00ae ATBS Annual Bait Stations in accessible soil around the perimeter of the covered structure. Placement follows the product label and your property\u2019s realities — construction features, utilities, hardscape, moisture, and safe access — and your installation report shows the actual number and location of every station, including any perimeter sections that could not be accessed.',
      'The stations are YOURS. You buy them once and they stay your property — unlike leased bait systems, nobody digs them up if you ever stop service.',
      'How the bait works: foraging termites discover and feed on the novaluron bait, which interferes with the termite molting process; effects spread through the colony via continued feeding and normal colony behavior. Bait control is intentionally not instantaneous — discovery and colony impact vary with colony location, competing food, soil moisture, season, and other site conditions. No honest bait program promises a colony-elimination date.',
      'We check every accessible station quarterly and document each check in your service report: station condition, any activity found, and bait consumption. Cartridges are replaced when consumption or condition meets the manufacturer\u2019s replacement criteria — such as more than a third of the bait consumed or excessive decay — not simply because a calendar date passed. Intact cartridges stay effective for years.',
      'If activity is found, we document it with photos, evaluate consumption, inspect accessible areas of the covered structure, replace bait per the label criteria, and determine whether additional stations, an earlier follow-up visit, or a localized supplemental treatment is the right call.',
    ],
    faq: [
      {
        q: 'Bait stations or tenting — which do I need?',
        a: 'They solve different termites. Bait stations target SUBTERRANEAN termites — the soil-dwelling colonies that attack from under and around your home. DRYWOOD termites live inside the wood itself and need a different strategy: depending on the location and extent of activity, that can mean whole-structure fumigation (tenting) or an appropriate localized treatment. Waves does not perform structural fumigation — if we find evidence consistent with drywood termites, we document it and point you to the right treatment instead of selling you the wrong one.',
      },
      {
        q: 'How long does installation take, and is it disruptive?',
        a: 'Standard exterior installation is typically completed in a single visit, normally entirely outside — no need to leave the home. Certain construction types, crawlspaces, or hardscape conditions can require additional access or separately authorized work; anything like that gets explained before work begins.',
      },
      {
        q: 'What are the term options, and what happens if I sell the house?',
        a: 'You choose a 1-, 5-, or 10-year term, billed monthly or annually in advance — longer terms lock lower monthly rates, fixed for the term you pick. The guarantee is transferable to a new homeowner with a transfer inspection and a $250 transfer fee, which is a genuine selling point when you list the house: the buyer inherits active termite protection with its history documented in the app.',
      },
      {
        q: 'Do I own the bait stations, or am I renting them?',
        a: 'You own them. The Trelona\u00ae stations we install are bought once with your installation and stay your property permanently. Some competing systems are leased — stop paying and the stations come out of your yard, taking the protection history with them. Yours stay in the ground, and your monitoring records stay in your app.',
      },
      {
        q: 'Are the stations safe around kids and pets?',
        a: 'The stations are engineered for exactly that worry: the bait sits below grade inside a secured, tamper-resistant housing — a curious kid or dog meets a plastic device, not the active material. The bait chemistry (novaluron) inhibits chitin synthesis, the insect exoskeleton-building process; mammals do not synthesize chitin. There is no spray and no drying period with a station-only installation. Just never open, move, bury, or cover a station — and call us if one is ever exposed or damaged.',
      },
      {
        q: 'Does the bait get old? What keeps the system honest?',
        a: 'Replacement is condition-based, not calendar-based. At each quarterly check we evaluate activity, consumption, moisture, decay, and station condition, and we replace cartridges when the manufacturer\u2019s criteria are met. Every check lands in your service report — including when we found NO activity — so you can see the system being maintained rather than taking it on faith.',
      },
      {
        q: 'What does finding termites in a station actually mean?',
        a: 'It means foraging termites discovered and are feeding on the bait — which is the system doing its job, not failing. It does not by itself prove termites are absent from the structure or that feeding elsewhere has stopped, so we also inspect accessible areas of the covered structure, document station and structural findings separately, and decide whether additional stations, an earlier follow-up, or a localized supplemental treatment is appropriate. What\u2019s included versus separately quoted is spelled out in your written agreement.',
      },
      {
        q: 'What exactly does the WaveGuard guarantee cover?',
        a: 'More than the stations alone. The WaveGuard Termite & WDO Guarantee covers infestations by subterranean and Formosan termites, drywood termites, powderpost beetles, and old house borers — with corrective retreatment of covered pests at no additional cost and repair coverage up to $1,000,000 for NEW covered damage during an active term, per your written agreement.',
      },
      {
        q: 'How can it cover drywood termites and beetles if bait stations only work on subterranean?',
        a: 'Because the program is layered, with each tool aimed where its organism actually lives. Bait stations — and liquid trenching where used — intercept SUBTERRANEAN colonies in the soil. Bora-Care\u00ae borate treatment protects the wood itself: applied to exposed and accessible wood areas (attics, crawl spaces), it defends against ALL the covered wood-destroying organisms — drywood termites, powderpost beetles, and old house borers included. Soil layer plus wood layer is what lets one guarantee cover the full list.',
      },
      {
        q: 'What does the guarantee NOT cover?',
        a: 'Pre-existing damage, detached structures (sheds, fences, decks) unless explicitly added in writing, cosmetic-only damage (paint, trim, finishes not needed for structural repair), and whole-structure fumigation unless separately contracted. Keeping the guarantee valid requires the annual inspection, current payments, and reasonable property conditions — no wood-to-soil contact, moisture problems addressed, and access for inspections. Your written agreement is the authority; read it and ask us anything unclear.',
      },
    ],
    // Termite-specific customer responsibilities (external review): the
    // system only works if the stations stay accessible and undisturbed.
    responsibilities: {
      heading: 'Helping the system stay effective',
      bullets: [
        'Please don\u2019t open, move, remove, bury, pave over, or damage bait stations — and tell us before installing pavers, additions, pools, patios, fences, major landscaping, new irrigation, or grading near the covered structure.',
        'Provide access for the scheduled checks, and call us promptly if you see swarmers, discarded wings, mud tubes, damaged wood, or an exposed or damaged station.',
        'Conditions like persistent moisture, plumbing leaks, wood-to-soil contact, or drainage problems can affect inspection and control — we document significant ones in your report along with the recommended correction.',
      ],
    },
    // Termite-specific safety copy replaces the shared spray-oriented
    // section (external review §9): a station-only service has no spray, no
    // drying period, and its own environmental precautions.
    safetyOverride: {
      heading: 'Pets, kids & your family — station-only safety, straight',
      paragraphs: [
        'Termite bait stations are one of the lowest-exposure treatment formats in professional pest control — and here is exactly why, in technical terms rather than adjectives.',
        'The bait is installed below grade inside a secured professional station. A standard station-only installation involves no spray, no interior application, and no drying period — there is ordinarily nothing to wait out and no need to leave your home.',
      ],
      bullets: [
        'The bait is Trelona\u00ae, containing novaluron at 0.5% — EPA-registered under No. 499-557 with the signal word CAUTION. The signal word reflects the product\u2019s acute hazard labeling category; it is a useful at-a-glance indicator, not a complete measure of every risk, which is why placement and handling follow the full label.',
        'Novaluron is a chitin-synthesis inhibitor: it disrupts the process insects use to build their exoskeletons. Mammals do not synthesize chitin.',
        'Stations are locked and tamper-resistant — a curious kid or dog encounters a plastic housing, not the bait. Never open, move, bury, or cover a station; contact Waves if one becomes exposed, displaced, or damaged.',
        'The active ingredient is highly toxic to aquatic invertebrates, so stations are never positioned where moving water could carry bait into ponds, streams, or other water containing aquatic life — an explicit label requirement we plan placements around.',
        'Waves Pest Control, LLC operates under Florida pest-control business license JB351547, and every check is documented in your service report — the record of what was inspected, found, and done at your home.',
      ],
      closing: 'No pesticide should ever be described as risk-free or \u201c100% safe\u201d — no honest company will tell you that, and the EPA does not permit the claim. What we can show you is a below-grade, contained, condition-monitored system with a full paper trail — the same system our technicians choose for their own homes.',
    },
    // Termite-specific documentation bullets (external review): the report
    // records presence OR absence, station-level detail, and the agreement
    // stays the authority on coverage.
    documentationOverride: {
      heading: 'Documented every check — including the visits where we find nothing',
      bullets: [
        'Every station check lands in your service report: stations inspected, station condition, activity found (or explicitly none), bait consumption, and any cartridges replaced — with photos when evidence is visible and safely accessible.',
        'Whether a visit was inspection-only or included treatment is stated on the report, along with your next scheduled check.',
        'Track your technician\u2019s live location and estimated arrival in the Waves app once they\u2019re en route, and keep every past report, invoice, and visit in one place — savable and shareable as a PDF.',
        'Your service report is the record of each visit; your signed termite agreement controls coverage, warranty, renewal, and exclusions. And a recurring service report is not a real-estate WDO inspection report — that is a separate, state-prescribed inspection you can order when you need one.',
      ],
    },
    // Termite CTA: single closing band with agreement-accurate microcopy
    // (the generic "no long-term contract / 90-day" line doesn't fit a
    // written termite agreement).
    ctaPlacement: 'closing_only',
    ctaMicro: 'A written termite agreement covers every installation \u2014 it states your coverage, warranty type, renewal, and exclusions in plain terms.',
    illustrations: ['station_map'],
  },
  lawn_care: {
    title: 'Lawn Care — Service Details',
    tagline: 'Turf-specific treatment programs for Florida grasses — built on documented outcomes, not guesswork.',
    included: [
      'Seasonal turf treatments matched to the lawn program',
      'Weed, fungus, chinch, and turf-stress observations',
      'Treatment notes carried forward for future visits',
    ],
    process: [
      'Programs are built for your grass type — St. Augustine, Bermuda, Zoysia, and Bahia cannot always be treated with the same products, so the program tracks your turf specifically.',
      'Depending on your program and season, visits cover fertilization, weed and sedge control, and monitoring/treatment for turf-damaging insects: chinch bugs, grubs, sod webworms, and armyworms.',
      'Every visit includes an inspection for weeds, fungus, insect pressure, and turf stress — findings, photos, and your lawn-health trend land in your service report, and treatment notes carry forward so the program adapts to what your lawn actually does.',
      'Treatments flex with the season, weather, irrigation, and label requirements rather than running an identical pass every visit.',
    ],
    faq: [
      {
        q: 'Will the lawn service help my Bermuda grass?',
        a: 'Yes — Bermuda is one of the four turf types we run a dedicated program track for, with products and timing matched to it. Tell us what you are seeing (thinning, weeds, insect damage) and the program targets it; your reports then track the recovery visit over visit.',
      },
      {
        q: 'Are the brown spots fungus, bugs, or something else?',
        a: 'That is the first thing a visit answers. Brown patches can be fungus, chinch bugs, grubs, irrigation coverage, or pet damage — and each has a different fix. We diagnose before treating and document the finding with photos in your report.',
      },
      {
        q: 'Does lawn care include mowing or irrigation work?',
        a: 'No. The program covers treatment of the turf: fertilization, weed control, insect and disease management. Mowing, edging, irrigation diagnosis or repair, and sod installation are not included — though your reports will flag irrigation-pattern problems when we see them.',
      },
      {
        q: 'Is the lawn safe for my dogs after treatment?',
        a: 'The most common question we get, so here is the mechanism, not just the rule: while an application is wet it can transfer to paws and mouths; once dry, the residue is bound to the grass blade where insects contact it. Keep pets off the treated lawn until it is dry — in Florida sun that is typically fast — and some granular products instead need watering-in first, which your technician flags on the visit. Your service report states the exact per-product re-entry guidance every time. The full technical picture is in the "Pets, kids & your family" section below.',
      },
      {
        q: 'Do you treat flowerbeds and shrubs too?',
        a: 'Ornamentals are their own program — Tree & Shrub Care — with products matched to plants rather than turf. Ask us to add it and both ride the same visit cadence where possible.',
      },
      {
        q: 'What about rain and irrigation after a treatment?',
        a: 'Some applications need watering-in and some need dry time — it depends on the product. Your technician leaves the exact guidance after each visit, and we schedule around weather so applications are not wasted.',
      },
    ],
  },
  tree_shrub: {
    title: 'Tree & Shrub Care — Service Details',
    tagline: 'Ornamental protection through the seasons — plant-specific, not lawn products pointed at bushes.',
    included: [
      'Ornamental inspection during service visits',
      'Targeted insect, mite, and disease observations',
      'Seasonal plant-health treatment support',
    ],
    process: [
      'We inspect and treat your ornamentals — trees, shrubs, and plant beds — for insect, mite, and disease pressure with products labeled for plant health, not turf products repurposed.',
      'Treatments are seasonal and targeted to what the plants actually need; findings and photos land in your service report with notes carried forward.',
    ],
    faq: [
      {
        q: 'Is this the same as lawn care?',
        a: 'No — turf and ornamentals need different products, rates, and timing. This program covers the plants; the lawn program covers the grass. They pair well and can ride the same visit schedule.',
      },
      {
        q: 'Is it safe for pollinators and my garden?',
        a: 'Applications follow label pollinator precautions — including avoiding treatment of open blooms where the label directs — and your report documents exactly what was applied and where.',
      },
    ],
  },
};

// (941) 297-5749-style display for the guide meta block; passes through
// anything that isn't a plain US number.
function formatGuidePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw ? String(raw) : null;
}

function serviceDetailsAvailable(serviceKey) {
  return Object.prototype.hasOwnProperty.call(SERVICE_DETAILS_COPY, serviceKey);
}

async function fetchRegistryProducts(serviceKey) {
  const pattern = REGISTRY_PATTERNS[serviceKey];
  if (!pattern) return [];
  try {
    const products = await db('products_catalog')
      .where({
        active: true,
        customer_visibility: 'public',
        content_status: 'approved_for_public',
      })
      .select(
        'id', 'name', 'common_name', 'active_ingredient', 'formulation',
        'epa_reg_number', 'signal_word', 'public_summary',
        'customer_safety_summary', 'pet_kid_guidance_text', 'reentry_text',
        'label_url', 'sds_url',
      )
      .orderBy('name');
    if (!products.length) return [];
    const usage = await db('service_product_usage')
      .whereIn('product_id', products.map((p) => p.id))
      .select('product_id', 'service_type');
    const matching = new Set(
      usage.filter((u) => pattern.test(String(u.service_type || ''))).map((u) => u.product_id),
    );
    return products.filter((p) => matching.has(p.id));
  } catch (err) {
    // The packet must never 500 a customer request over a registry hiccup —
    // it renders with the "current product list on request" note instead.
    logger.error(`[service-details] registry lookup failed for ${serviceKey}: ${err.message}`);
    return [];
  }
}

async function buildServiceDetailsContent(serviceKey, estimate = {}) {
  const copy = SERVICE_DETAILS_COPY[serviceKey];
  if (!copy) return null;
  const products = await fetchRegistryProducts(serviceKey);
  const documentation = copy.documentationOverride || {
    heading: DOCUMENTATION_SECTION.heading,
    bullets: serviceKey === 'lawn_care'
      ? [...DOCUMENTATION_SECTION.bullets, LAWN_DOCUMENTATION_EXTRA]
      : DOCUMENTATION_SECTION.bullets,
  };
  return {
    serviceKey,
    title: copy.title,
    tagline: copy.tagline || null,
    // CTA target — the guide loops the reader straight back to their
    // estimate's scheduling flow (owner 2026-07-10).
    estimateUrl: estimate.token
      ? `https://portal.wavespestcontrol.com/estimate/${estimate.token}`
      : null,
    customerName: estimate.customer_name || null,
    customerEmail: estimate.customer_email || null,
    customerPhone: formatGuidePhone(estimate.customer_phone),
    address: estimate.address || null,
    estimateSlug: estimate.estimate_slug || null,
    included: copy.included,
    process: copy.process,
    faq: copy.faq || [],
    documentation,
    illustrations: copy.illustrations || [],
    safety: copy.safetyOverride || SAFETY_SECTION,
    systemBox: copy.systemBox || null,
    responsibilities: copy.responsibilities || null,
    // One CTA, after the full picture — every external guide review
    // (termite, pest, mosquito) flagged the mid-document CTA as premature.
    ctaPlacement: copy.ctaPlacement || 'closing_only',
    ctaMicro: copy.ctaMicro || null,
    products,
  };
}

module.exports = {
  SERVICE_DETAILS_COPY,
  serviceDetailsAvailable,
  buildServiceDetailsContent,
};
