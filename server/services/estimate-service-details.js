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

// Compliance section (owner ask 2026-07-11): the rules every guide operates
// under, stated plainly. Shared base + per-service `complianceExtras`
// (fertilizer ordinances, treatment-notice statute, pollinator label law).
const COMPLIANCE_SECTION = {
  heading: 'Compliance & licensing — the rules we operate under',
  bullets: [
    'Waves Pest Control, LLC operates under Florida pest-control business license JB351547 — a business license issued under Chapter 482, Florida Statutes, the law governing pest control operations in Florida — and is insured.',
    'Every pesticide we apply is EPA-registered and used in accordance with its label. The label is legally enforceable: it dictates the sites, rates, methods, precautions, and re-entry conditions for every application, and using a product inconsistent with its labeling violates federal law.',
    '"EPA-registered" is the accurate term — the EPA does not "approve" or endorse pesticides, and registration does not mean risk-free. You will never hear us describe a pesticide as 100% safe.',
    'Your service report documents the exact products applied at each visit — the standing record you can check all of this against, any time.',
  ],
};

// Customer-facing copy per service. `included` mirrors the estimate card
// inclusions; `process` is the inspection-led protocol walkthrough; `faq`
// answers the questions mined from real SMS threads and call transcripts.
// OWNER REVIEWS ALL OF THIS BEFORE THE GATE FLIPS — anything field reality
// doesn't back gets cut.
const SERVICE_DETAILS_COPY = {
  pest_control: {
    title: 'Pest Protection — Service Details',
    // Stylized in-house renders (gemini-3-pro-image, 2026-07-11 — no
    // manufacturer photography/trade dress). Owner-picked set: the plan's
    // primary solutions + the spray adjuvant.
    productImages: {
      heading: 'A few of the products doing the work',
      images: [
        { file: 'product-taurus-sc.png', product: 'Taurus', caption: 'Taurus SC® — non-repellent insecticide (fipronil)' },
        { file: 'product-talstar-p.png', product: 'Talstar', caption: 'Talstar® P — residual insecticide (bifenthrin)' },
        { file: 'product-surfactant.png', caption: 'Non-ionic surfactant — helps treatments spread & stick' },
      ],
      note: 'Stylized product illustrations — product selection follows the inspection and the label, and your service report names the exact products applied at your home.',
    },
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
    productImages: {
      heading: 'A few of the products doing the work',
      images: [
        { file: 'product-scion.png', product: 'Scion', caption: 'Scion® — residual insecticide' },
        { file: 'product-bifen-it.png', product: 'Bifen', caption: 'Bifen® I/T — bifenthrin insecticide' },
        { file: 'product-tekko-pro.png', product: 'Tekko', caption: 'Tekko® Pro — insect growth regulator' },
      ],
      note: 'Stylized product illustrations — product selection follows the inspection, the season, and the label, and your service report names the exact products applied at your home.',
    },
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
    productImages: {
      heading: 'The system going into the ground',
      images: [
        { file: 'product-trelona-station.png', product: 'Trelona', caption: 'Trelona® ATBS in-ground bait station with bait cartridge' },
      ],
      note: 'Stylized illustration — your installation report maps the actual numbered stations at your home, and each station sits below grade with a locked lid.',
    },
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
  // Lawn guide rebuilt 2026-07-11 per the owner-supplied external lawn
  // review (UF/IFAS- and EPA-grounded): inspection-led protocol, turf-type
  // specificity, cultural-vs-pest honesty, no universal re-entry times, no
  // "residue binds the blade" universal claims, control-not-eliminate
  // language, fertilizer-ordinance compliance, and report/knowledge-base
  // documentation made explicit.
  lawn_care: {
    title: 'Lawn Care — Service Details',
    tagline: 'Your grass type, your property’s conditions, and the actual problem determine the treatment — not a one-size-fits-all route sheet.',
    systemBox: {
      heading: 'Your program at a glance',
      rows: [
        ['Visits', 'Full lawn programs typically run 9–12 visits per year (your estimate states your plan’s count), scheduled around turf growth, seasonal pest pressure, weather, and local fertilizer rules — not a rigid monthly calendar'],
        ['Built for your grass', 'St. Augustine, Bermuda, Zoysia & Bahia run dedicated program tracks — a product or rate that helps one grass can injure another, so the turf is identified before anything is applied'],
        ['Every visit', 'Inspection first — then turf-specific fertilization, weed & sedge management, and insect/disease work as season, conditions, and labels warrant'],
        ['Covered turf insects', 'Chinch bugs, sod webworms, armyworms, white grubs & mole crickets — monitored every visit, treated on evidence. Fire-ant control is included only when your proposal specifically includes it; billbugs and unusual turf pests are inspected and quoted from diagnosis'],
        ['Disease', 'Scouted every visit — a brown patch is a symptom, not a diagnosis. Condition-based fungicide is part of comprehensive lawn plans; fertilization-only and weed-only plans quote it separately'],
        ['Summer fertilizer rules', 'Manatee County, Bradenton & Sarasota County restrict nitrogen/phosphorus fertilizer Jun 1 – Sep 30 — summer visits shift to iron & micronutrients, weed control, and lawn insect control, never skipped'],
        ['Documentation', 'Digital report every visit: findings, photos, exact products, watering & mowing instructions, and your lawn-health trend in the app'],
        ['Re-service', 'No-charge re-services for covered issues while your plan is active — report a concern any time; some treatments need their normal response window (about 7–10 days) before another application'],
        ['Separate services', 'Mowing, edging, irrigation diagnosis/repair, sod installation, flowerbed weed control, tree & shrub care — core aeration and lawn plugging are available as separately quoted services'],
      ],
      note: 'Your estimate and service agreement control the exact scope, covered pests, and guarantee terms. Where a lawn problem needs something a treatment cannot fix — shade, a broken sprinkler head, compacted soil — we say so instead of selling you product.',
    },
    included: [
      'Inspection-led visits with turf-specific fertilization and nutrient applications',
      'Broadleaf, sedge, and grassy-weed management — pre- and post-emergent as conditions and labels allow',
      'Monitoring and evidence-based treatment for chinch bugs, grubs, sod webworms, armyworms, and other covered turf insects',
      'Turf-disease evaluation, with treatment when the evidence supports it',
      'Non-pest condition checks: drought stress, overwatering, sprinkler-pattern clues, mowing injury, shade stress',
      'Photos, findings, exact product records, and notes carried forward visit to visit — plus your lawn-health trend',
    ],
    process: [
      'Every visit starts with your lawn’s history, not a spreader: previous findings, photos, products applied, what improved, and what did not respond as expected. The program gets smarter about your lawn every visit — it never restarts from zero.',
      'We confirm the turf before choosing products. St. Augustine, Bermuda, Zoysia, and Bahia tolerate different herbicides, rates, and mowing heights — a product appropriate for one grass can injure another — so mixed turf, new sod, and unidentified cultivars get flagged before herbicide selection.',
      'Then we inspect: color, density, and recovery; the pattern and location of damage; leaf, root, and thatch condition; visible insects and feeding evidence; weed and sedge identification; disease symptoms; soil moisture and drainage; sprinkler-coverage clues; mowing height and scalping; shade, traffic, and pet areas. A brown area is a symptom, not a diagnosis — insects, disease, drought, overwatering, mower injury, and shade can all look alike.',
      'We separate pest problems from cultural ones. A pesticide can control a covered pest — it cannot create sunlight in deep shade, fix a broken sprinkler head, decompact soil, reverse repeated scalping, replace dead sod, or make the wrong grass thrive in the wrong spot. When the primary cause is cultural or environmental, your report says so plainly, along with what has to change for lasting improvement.',
      'Treatment follows the evidence: product, rate, method, and treated area are chosen from the confirmed (or reasonably supported) target, your grass and its condition, weather and soil moisture, nearby ornamentals and water, previous applications, local fertilizer rules, and the label. More product is never better — using a pesticide inconsistent with its labeling violates federal law.',
      'Visits flex with the season instead of running an identical pass: nutrition leads part of the year, weed management another, insect and disease monitoring another — driven by weather, growth, results, and label restrictions.',
      'And every visit is documented: areas inspected, findings, areas treated, the exact products applied, photos when they add evidence, watering and mowing instructions, product-specific re-entry guidance, and what to reassess next visit.',
    ],
    responsibilities: {
      heading: 'How you can multiply the results',
      bullets: [
        'Mow for the grass you have — UF/IFAS starting points: standard St. Augustine about 3.5–4", dwarf St. Augustine 2–2.5", Bermuda 1–2", Zoysia 1.75–2.5", Bahia 3–4". Never remove more than about a third of the blade in one mowing, and keep blades sharp — repeated scalping produces browning that mimics pest damage.',
        'Water on lawn need, not an unchanged timer: folded blades, a blue-gray cast, and footprints that linger mean it’s time. A typical event is about ½–¾ inch, early morning. Overwatering feeds shallow roots, disease, dollarweed, and sedges — adjust with rainfall and season.',
        'Before applying any store-bought fertilizer, weed-and-feed, or pesticide, send us a photo of the front and back labels first. Overlapping treatments can injure turf, violate label intervals, confuse diagnosis, and undo the plan.',
        'On service day: unlock gates, secure pets, pick up toys and bowls, clear heavy pet waste from treatment areas, and flag new sod, edibles, ponds, beehives, or anything that changed since last visit.',
      ],
    },
    faq: [
      {
        q: 'Will this help my Bermuda grass?',
        a: 'Yes — provided it runs as a Bermuda program, which is exactly what we do. Bermuda is not "St. Augustine with smaller blades": its fertility, mowing, weed-control, and recovery plan are built for Bermuda. What "help" means depends on the cause — thinning from shade has a different fix than armyworms, weeds, nematodes, low mowing, or irrigation stress — so we diagnose first, and your reports track the response visit over visit.',
      },
      {
        q: 'Are my brown spots fungus, insects, or something else?',
        a: 'Nobody can answer that honestly without inspecting the lawn. Brown or yellow areas can be disease, chinch bugs, grubs, webworms, irrigation coverage, drought, overwatering, mower scalping, fertilizer or herbicide injury, pet activity, shade, root decline — or several at once, and turf disease is one of the most commonly misdiagnosed lawn problems. We inspect the pattern, tissue, moisture, roots, and surroundings, then document the finding with photos. When a confident field call is not possible, we say so and tell you what testing or monitoring comes next.',
      },
      {
        q: 'Do you apply fungicide whenever you see a brown patch?',
        a: 'No. A brown patch does not automatically mean fungus, and an unnecessary fungicide will not correct insects, drought, sprinkler gaps, mowing injury, or pet damage — misidentification is a leading reason lawn treatments fail. Every comprehensive visit includes disease scouting; fungicide is applied when disease is present, when conditions create a documented high risk, or when your lawn’s disease history justifies a preventive application. When we do treat, the product is labeled for your turf and that disease, with the watering and mowing instructions that fungicide requires. Fertilization-only and weed-only plans quote fungicide separately.',
      },
      {
        q: 'Do you apply insecticide at every visit automatically?',
        a: 'No — treatments follow evidence, not a route sheet. The technician weighs your grass, pest history, current activity, season, and the label, and when an insecticide is applied, your report identifies the pest or the evidence supporting it. Blanket applications you cannot trace to a reason are exactly what the report exists to prevent.',
      },
      {
        q: 'How fast will my lawn improve?',
        a: 'There is no honest universal timeline. It depends on the cause, how long the damage was present, whether roots and growing points are still alive, the grass and season, mowing and watering, and whether the underlying condition was corrected. A treatment can stop an active pest without instantly replacing dead turf; weeds take time to decline after treatment; areas with dead roots may need renovation rather than patience. Your technician tells you which situation you have and what to watch for by the next visit.',
      },
      {
        q: 'Will every weed disappear?',
        a: 'No lawn company should promise a permanently weed-free yard. Some weeds are best prevented before they emerge, others need post-emergent work, and mature perennials, sedges in chronically wet soil, and grassy weeds growing inside another grass may need repeat treatment or have limited selective options. Sometimes leaving a weed untreated for a visit is the right call — unidentified weed, wrong product for your grass, heat-stressed turf, label temperature limits, or fresh sod. The durable fix is dense, healthy turf; where the lawn stays thin from shade, water, or compaction, weeds keep returning no matter what is sprayed — and your report says so.',
      },
      {
        q: 'Do you treat nutsedge?',
        a: 'Yes, when it is identified and a labeled treatment fits your turf — with an honest caveat: sedges thrive in continuously wet soil and regrow from underground tubers, so herbicide suppresses the visible growth while recurring excess moisture keeps sponsoring new shoots. Expect repeat treatments, and expect us to point at the drainage or irrigation pattern if that is the real sponsor.',
      },
      {
        q: 'When can my dogs and kids use the lawn again?',
        a: 'Follow the product-specific re-entry instructions in your service report — that is the honest answer, and it is different for different products and even different weather. Many liquid applications require keeping people and pets off until the treated area has dried; some granular products instead need watering-in before normal use resumes. There is no single standard time, and we will not print one. Keep everyone clear during the application, bring in toys and water bowls beforehand, and check the report — it states the exact guidance for the products actually used, every visit.',
      },
      {
        q: 'What about rain, watering, and mowing after a visit?',
        a: 'It depends on the product, so your report tells you plainly: water it in, keep it dry for a stated period, resume normal irrigation, or no action needed. Do not automatically run irrigation after service unless the report says to, and do not mow a wet application — some treatments need leaf-contact time before clippings carry them away. We schedule around weather so applications are not wasted, and if a downpour compromises a treatment, contact us.',
      },
      {
        q: 'I just had new sod installed — can you treat it?',
        a: 'New sod gets an establishment plan, not the standard program pass. Tell us the installation date, the grass type if you know it, what the installer applied, your watering schedule, and any sod warranty terms. Some fertilizers and herbicides must be delayed or modified during rooting — treating fresh sod like established turf is how new lawns get hurt.',
      },
      {
        q: 'Do you offer aeration or lawn plugging?',
        a: 'Yes — both, as separately quoted specialty services rather than part of the standard visit rotation. Core aeration relieves soil compaction and opens the root zone; plugging installs live sod plugs at 6-, 12-, or 18-inch spacing to regrow thin or bare areas. We recommend them from what the inspection actually shows — compaction, thatch, bare ground, your grass type — and whether the site can support the recovery.',
      },
      {
        q: 'Can treatments fix thin grass under my trees?',
        a: 'They can address a covered pest or a nutrient issue — they cannot manufacture sunlight. No common Florida lawn grass performs well in dense shade, and tree-root competition and mowing difficulty pile on. In genuinely unsuitable areas, pruning by a qualified professional, a shade-tolerant groundcover, or mulch is more realistic than repeatedly treating grass that cannot win there — and we will tell you that rather than billing you to fight physics.',
      },
      {
        q: 'Does service continue during the summer fertilizer restriction?',
        a: 'Yes. Manatee County, Bradenton, and Sarasota County restrict nitrogen and phosphorus lawn fertilizers from June 1 through September 30, and your property address — not a company calendar — determines which ordinance applies. A restricted period does not mean your lawn is ignored: summer visits still carry the full inspection and pest scouting, covered turf-insect treatment, selective weed control, iron and approved zero-nitrogen/zero-phosphorus micronutrients to hold color lawfully, disease monitoring with condition-based treatment, and the usual checks on drought stress, mowing, and irrigation — and your report documents exactly what was used.',
      },
      {
        q: 'What happens when I request a re-service?',
        a: 'Report a concern any time — there is no waiting period to call, and if damage is actively spreading we inspect promptly. The re-service itself starts with inspection, not an automatic second application: we review the previous report and photos, ask when the concern began, and determine whether it is the same covered condition, a different pest, normal treatment response time (many treatments need about 7–10 days to show their work before re-applying makes sense), or an excluded cause like irrigation or mowing. We re-treat when it is appropriate and label-permitted — and explain the non-treatment correction when that is what the lawn actually needs. "More product" is not a diagnosis.',
      },
      {
        q: 'Do you guarantee a perfect green lawn?',
        a: 'No responsible company can guarantee a flawless lawn regardless of irrigation, mowing, shade, soil, weather, pets, and what gets applied between visits. What we do stand behind: careful inspection, correct covered treatments, label and ordinance compliance, honest documentation, re-service for covered issues under your written program terms — and telling you straight when a condition falls outside what treatment can fix. Your service agreement states the exact guarantee terms.',
      },
      {
        q: 'What if you are not sure what is causing the problem?',
        a: 'We say so. We will not invent a confident-sounding diagnosis to make a visit feel complete. You get what we observed, what has been ruled out, what remains possible, and the next step — monitoring, an irrigation check, a root or thatch exam, an insect or turf sample, or soil testing (recommended or arranged when needed; your proposal states whether sampling and laboratory fees are included), up to UF/IFAS laboratory analysis. An honest "not yet confirmed" beats a guess with a product bill attached.',
      },
    ],
    // Lawn-specific safety copy replaces the shared structural-pest section
    // (crack-and-crevice/station content doesn't describe a lawn visit) —
    // external review: no universal re-entry time, no universal "binds to
    // the blade" claim, signal words qualified.
    safetyOverride: {
      heading: 'Pets, kids & your family — lawn-treatment safety, straight',
      paragraphs: [
        'If you have kids or dogs on this lawn, this is the question that matters most — so here is the real answer instead of a slogan.',
        'Every pesticide product Waves applies is EPA-registered and used in accordance with its label — and that label is legally binding: it dictates where the product may go, at what rate, with what precautions, and when people and pets may re-enter. Registration does not mean risk-free, and no honest company will call any pesticide "completely safe."',
      ],
      bullets: [
        'There is no single re-entry time for every lawn visit, and we will not print one. Many liquid applications require keeping people and pets off until the treated area has dried; some granular products instead need watering-in before normal use resumes; other labels carry different conditions — and weather, humidity, shade, and method all move those windows. Your service report states the exact re-entry guidance for the products actually used, every visit.',
        'During service, keep children and pets inside or clear of the work area, and bring in toys, chew items, food and water bowls, and anything else that could contact treated turf.',
        'Signal words are the EPA’s at-a-glance acute-hazard categories — DANGER most severe, WARNING next, CAUTION the lowest signal-word category. They are useful indicators, not a complete measure of every risk: the full label governs every application.',
        'Tell us about edible gardens, beehives, ponds, chickens, play areas, and sensitive occupants before treatment — placement and product selection are planned around them and the label.',
        'More product is never the answer: rates come from the label, not from how bad the weeds look. Correct identification, correct product, correct placement — that is what produces results.',
        'Waves Pest Control, LLC operates under Florida pest-control business license JB351547 and is insured, and every applied product is documented in your service report with its own re-entry guidance.',
      ],
      closing: 'We will never tell you a lawn treatment is “100% safe” — no honest company can, and the EPA does not permit that claim for any product. What we can show you is the product-by-product paper trail and the label-driven precautions behind every visit — the same rules our technicians follow on their own lawns.',
    },
    // Stylized in-house product renders (client/public/product-images) — the
    // program's flagship products, generated 2026-07-11 (gemini-3-pro-image;
    // no manufacturer photography, no copied trade dress). Products chosen
    // from the lawn protocols: Arena 50 WDG (insecticide rotation), LESCO
    // granular fert + Chelated AM+Micros (summer iron/micros), Celsius WG
    // (primary post-emergent, unified St. Augustine protocol).
    productImages: {
      heading: 'A few of the products doing the work',
      images: [
        { file: 'product-lesco-fertilizer-bag.png', caption: 'LESCO® professional turf fertilizer' },
        { file: 'product-celsius-wg.png', product: 'Celsius', caption: 'Celsius® WG — post-emergent herbicide' },
        { file: 'product-arena-50-wdg.png', product: 'Arena', caption: 'Arena® 50 WDG — turf insecticide' },
        { file: 'product-lesco-am-micros.png', caption: 'LESCO® Chelated AM + Micros — summer iron & micronutrients' },
      ],
      note: 'Stylized product illustrations — product selection follows your turf, the season, and the label, and your service report names the exact products applied at your home.',
    },
    complianceExtras: [
      'Florida law requires a conspicuous treatment notice when pesticides are applied to lawns or exterior foliage — we post it at every qualifying visit, and your digital report carries the full details behind the sign.',
      'Local fertilizer ordinances are built into the program: Manatee County, the City of Bradenton, and Sarasota County restrict nitrogen and phosphorus lawn and landscape fertilizers from June 1 through September 30. The property address — never a generic company calendar — determines which ordinance applies, and restricted-season visits are adjusted to lawful materials and work.',
    ],
    documentationOverride: {
      heading: 'Documented every visit — your lawn’s case file, not a mystery treatment',
      bullets: [
        'Every completed visit produces a digital lawn service report: areas inspected, conditions and problems observed, areas treated, the exact products applied and why, photos when findings warrant them, watering and mowing instructions when applicable, product-specific re-entry guidance, and what to reassess next visit.',
        'Lawn visits feed your lawn report’s health score and trend — findings and treatment notes carry forward, so future decisions are based on your lawn’s actual history and response, not a generic checklist.',
        'Behind the program is our agronomic knowledge base: Southwest Florida turf protocols, product data, and documented outcomes from real local lawns. That knowledge base — not guesswork — is what treatment decisions draw on.',
        'Track your technician’s live location and estimated arrival in the Waves app once they’re en route, and keep every past report, invoice, and visit in one place — savable and shareable as a PDF.',
        'Your service report is the property-specific record of what was inspected, found, and performed at YOUR home. Your service agreement controls the plan itself: covered pests, frequency, exclusions, and guarantee terms.',
      ],
    },
    ctaMicro: 'Turf-specific program · Re-service for covered issues per your program terms · Every visit documented',
  },
  // Tree & Shrub guide rebuilt 2026-07-11 per the owner-supplied external
  // T&S review: plant-ID-first protocol, treat-only-when-warranted honesty,
  // sooty-mold/honeydew education, palm-specific care, arborist referral
  // boundary, pollinator/edible protection, ornamental-specific safety
  // (replaces the structural-pest shared section), no "deep-root
  // fertilization"/"season-long protection" claims.
  tree_shrub: {
    title: 'Tree & Shrub Care — Service Details',
    // Products from the T&S protocols: Dominion 2L is the primary systemic
    // (is_primary in the protocol usage seed); SuffOil-X is the
    // horticultural spray oil in the T&S catalog.
    productImages: {
      heading: 'A few of the products doing the work',
      images: [
        { file: 'product-dominion-2l.png', product: 'Dominion', caption: 'Dominion® 2L — systemic insecticide (imidacloprid)' },
        { file: 'product-suffoil-x.png', product: 'SuffOil', caption: 'SuffOil-X® — horticultural spray oil' },
      ],
      note: 'Stylized product illustrations — product selection follows the plant, the diagnosis, and the label, and your service report names the exact products applied at your home.',
    },
    tagline: 'Your ornamentals are not lawn grass — plant-specific inspection, treatment, and honest diagnosis, documented every visit.',
    systemBox: {
      heading: 'Your program at a glance',
      rows: [
        ['Covered plants', 'The ornamental trees, palms, shrubs, hedges, and plant beds identified on your estimate'],
        ['Watch list', 'Scale, whiteflies, aphids, mealybugs, mites, lace bugs, caterpillars, thrips & other covered ornamental pests'],
        ['Every visit', 'Plant-by-plant inspection first — treatment only where the evidence and the label support it'],
        ['Disease', 'Symptoms evaluated before fungicide — some problems need a sample or lab work, and some are cultural, not chemical'],
        ['Plant nutrition', 'A combination of foliar feeding and root-zone feeding (soil drenches / deep-root applications), selected per plant species, soil, and diagnosis — palms get palm-specific care, never lawn fertilizer pointed at a palm'],
        ['Pollinators & edibles', 'Blooms, foraging bees, and food plants are checked before treatment — tell us about hives, butterfly gardens, and edibles'],
        ['Documentation', 'Digital report every visit: plants inspected, findings, exact products, photos, watering & re-entry instructions'],
        ['Separate services', 'Pruning, hedge shaping, tree removal, structural tree-risk assessment, irrigation repair, bed weed control, palm trunk injections (own program), plant replacement'],
      ],
      note: 'Your estimate and service agreement control the exact plants and scope. Pesticide service is not an arborist’s structural inspection — leaning trunks, cavities, and storm damage get documented and referred, not sprayed.',
    },
    included: [
      'Inspection of the covered ornamental trees, palms, shrubs, hedges, and beds',
      'Monitoring for covered insects, mites, and visible disease symptoms',
      'Targeted, label-directed treatment when the evidence supports it',
      'Evaluation of yellowing, leaf drop, spotting, dieback, and vigor loss — including the non-pest causes',
      'Plant-specific nutritional support when included in your program',
      'Photos, exact product records, and plant-by-plant notes carried forward',
    ],
    process: [
      'Plant identification comes first. Palms, hedges, flowering shrubs, and ornamental trees tolerate different products — even closely related plants can differ — so the plant is identified before anything is selected, and uncertainty gets documented rather than guessed through.',
      'We review your landscape’s history before treating: previously affected plants, products used, photos, what improved, and what did not respond. The program compounds knowledge visit over visit instead of restarting from zero.',
      'Then the inspection: new growth and mature foliage, both leaf surfaces, stems and trunks, visible insects, wax, webbing, honeydew and sooty mold, spots and dieback, soil moisture and irrigation coverage, planting depth and mulch placement, sun and salt exposure, and mechanical damage from trimmers or construction. A symptom is not a diagnosis — yellow leaves alone have a dozen possible causes.',
      'We separate pests from cultural problems. An insecticide will not fix chronic overwatering, a buried root flare, mulch piled against a trunk, compacted soil, or a plant in the wrong spot — and fertilizer will not cure every yellow plant. When the cause is cultural or environmental, the report says so plainly.',
      'Then we decide whether treatment is necessary at all. Finding an insect does not automatically mean spraying: beneficial insects may already be suppressing it, low numbers may not be damaging the plant, and monitoring or a cultural correction is sometimes the better call. A visit is still valuable when the correct decision is not to spray.',
      'When treatment is warranted, the product, rate, timing, and method are chosen for the plant, the pest and its life stage, plant condition, weather, nearby water and edible plants, bloom and pollinator activity, and the label. Using a pesticide inconsistent with its labeling violates federal law.',
      'Non-target protection is planned before application: open blooms, actively foraging bees, butterfly host plants, ponds and fountains, pet areas, play areas, and drift. When the label or conditions make treatment inappropriate, we delay it, modify the method, or treat only selected plants — and document why.',
      'Every visit is documented: plants inspected, what was found (or explicitly not found), what was treated and why, the exact products applied, photos, watering instructions, re-entry precautions, and what to reassess next time.',
    ],
    responsibilities: {
      heading: 'How you can multiply the results',
      bullets: [
        'Water the root zone, not the lawn schedule — established shrubs and turf rarely need the same frequency. Chronic overspray keeps foliage wet and invites disease, while a dry original root ball can kill a new plant even when the surrounding soil looks moist.',
        'Keep mulch off trunks and root flares — place it around, never over, the root ball. Buried flares and mulch volcanoes are slow-motion plant killers that no treatment corrects.',
        'Send us front-and-back label photos before applying any store-bought product to covered plants — overlapping treatments can burn foliage, harm beneficial insects, violate label intervals, and make it look like the professional treatment failed.',
        'Tell us when hedge trimming or landscaping work is scheduled — heavy pruning right before or after a treatment can remove treated foliage and the very evidence we need for diagnosis.',
      ],
    },
    faq: [
      {
        q: 'Is this the same as lawn care?',
        a: 'No — turf and ornamentals need different products, rates, methods, and timing. The lawn program covers the grass; this program covers the plants named on your estimate. They pair well and can ride the same visit schedule, but the technician inspects and documents them separately.',
      },
      {
        q: 'Which plants are included?',
        a: 'The plants and areas covered by your written estimate — that is the honest boundary. Ask us specifically about palms, mature canopy trees, newly installed plants, container plants, and anything edible: each has its own coverage answer. On tree size: there is no fixed height limit for root-zone and systemic treatment — a mature oak can be treated through its root system — but foliar and contact applications are limited to canopy we can reach safely and effectively from the ground. We do not climb, spray from bucket trucks, prune, or remove trees; large trees are inspected before treatment is accepted, and anything beyond the program gets documented and referred rather than half-treated.',
      },
      {
        q: 'How do you feed plants — through the leaves or the roots?',
        a: 'Both, chosen per plant. Foliar feeding delivers targeted nutrients directly through the leaves; soil drenches and deep-root applications deliver nutrients and systemic protection through the root system. The method follows the plant species, soil conditions, pest pressure, and the diagnosed deficiency — not a one-method routine. And feeding follows diagnosis: we do not fertilize a yellow plant until we know why it is yellow.',
      },
      {
        q: 'Do you spray every plant at every visit?',
        a: 'No — and you should be suspicious of any company that does. Each visit starts with inspection; some plants need treatment, others need monitoring, and some are in bloom, hosting beneficial insects, or stressed in ways that make spraying the wrong move. When we leave a plant untreated, the report states the reason — no damaging pest found, unconfirmed identification, label restriction, bloom, weather, or a cultural cause a product cannot fix — so you never have to wonder whether it was overlooked.',
      },
      {
        q: 'What is the black coating on my leaves?',
        a: 'Very likely sooty mold — and it is a clue, not the disease itself. Sooty mold grows on the sugary honeydew produced by sap-feeding insects (whiteflies, aphids, mealybugs, soft scales), often feeding higher in the canopy than the coating. Sticky leaves, cars, or walkways point the same direction. The fix is finding and managing the insect producing the honeydew; treating the black film directly solves nothing, and the existing coating weathers off gradually after the source is controlled.',
      },
      {
        q: 'Are yellow leaves a fertilizer problem?',
        a: 'Not automatically. Yellowing can be normal leaf aging, a nutrient issue, soil pH, overwatering, drought, poor drainage, root damage, salt, herbicide drift, sap-feeding pests, disease, or a plant planted too deep. Fertilizing without identifying the cause wastes product and can stress damaged roots further — so we diagnose before recommending nutrition.',
      },
      {
        q: 'What about my palms specifically?',
        a: 'Palms get palm care, not shrub care. Their most common problems in our area are nutritional — potassium, magnesium, manganese, boron — and those deficiencies can mimic disease, which is why palm discoloration should never automatically trigger fungicide. When supplemental nutrition is warranted, we use palm-specific controlled-release analyses in line with UF/IFAS guidance, not lawn fertilizer. Palms are inspected and coordinated with this program, but trunk injections are their own program: diagnosed first, then quoted by palm species, condition, the treatment needed, and the number of palms — never automatically included. And we are straight about the hard cases: some palm diseases, like Ganoderma butt rot, have no effective treatment — a suspected lethal disease or trunk decay gets documented and referred promptly instead of being dressed up as a treatable condition.',
      },
      {
        q: 'Can you save a dying plant?',
        a: 'Sometimes — and no honest company promises it before inspecting. It depends on the cause, how long it has been acting, whether the roots and growing points are alive, whether the site problem can be corrected, and whether the pest or disease is treatable at all. We tell you which goal is realistic: recovery, stabilization, protecting the unaffected growth, or the honest call that replacement beats another treatment invoice.',
      },
      {
        q: 'The plant still looks damaged after treatment — did it fail?',
        a: 'Old injury does not reverse. Chewed, scarred, or dead leaves stay that way — improvement shows up as reduced pest activity, no new feeding damage, cleaner new growth, less honeydew and fresh sooty mold, and better canopy density over time. Your report tells you what to watch and when we will reassess, instead of promising instant cosmetic restoration no treatment can deliver.',
      },
      {
        q: 'Is it safe for pollinators, pets, kids — and my vegetable garden?',
        a: 'We will not call any pesticide risk-free, for pollinators or anyone else — what we do is engineer exposure down, and the full section below covers it. Blooms and actively foraging bees are checked before treatment and label restrictions are followed, including delaying or modifying treatment. Edible plants are the strictest boundary: the standard program covers ornamentals only, and herbs, vegetables, and plants grown for the table are excluded — tell us about citrus, mango, avocado, herbs, and vegetable beds before service so they are marked no-treatment areas. Fruit trees can be evaluated separately, and are treated only when we have a product labeled for that exact crop and can give you the required re-entry and harvest instructions. Keep kids and pets clear during service and follow the report’s product-specific re-entry instructions after.',
      },
      {
        q: 'Can you tell me if my big tree is safe?',
        a: 'We can document visible symptoms and damage — but ornamental pest service is not a structural tree-risk assessment, and we will not pretend otherwise. A significant lean, root-plate movement, split trunk, large cavity, major deadwood, or storm damage near a house, pool cage, or driveway needs a qualified arborist. We flag those conditions in your report and point you to the right professional; fertilizer and pesticide are not substitutes for a structural evaluation.',
      },
      {
        q: 'What about rain and watering after a visit?',
        a: 'It depends on the application: some foliar products need a rain-free period and time on the leaf, some root-zone and granular products need watering-in, and the answer can be opposite from one product to the next. Your report tells you plainly — water it in, keep foliage dry for a stated period, resume normal irrigation, or no action needed. Do not automatically run irrigation after treatment, and if unexpected heavy rain follows a visit, contact us and we will assess whether anything needs to be redone.',
      },
      {
        q: 'What happens when I request a callback?',
        a: 'It starts with inspection, not an automatic re-spray. We review the previous report and photos, confirm when the concern began, and determine whether the original target is still active, whether a different pest or environmental problem moved in, and whether the first treatment simply needs its response time. We re-treat when appropriate and label-permitted — and when the real fix is irrigation, pruning, drainage, or replacement, we say that instead. More product is not automatically the answer.',
      },
      {
        q: 'Do you guarantee every plant stays green and healthy?',
        a: 'No responsible company can guarantee plant health regardless of weather, irrigation, soil, salt, pruning, construction, and pre-existing disease. What we stand behind: careful inspection, correct plant- and pest-specific product selection, label-compliant application, honest documentation, covered callbacks under your written terms — and the straight answer when treatment is not the right tool. Your service agreement states the exact terms.',
      },
      {
        q: 'What if you are not sure what is wrong?',
        a: 'We say so — "we found symptoms, but the cause cannot be confirmed confidently in the field" is a professional answer, and it beats a confident-sounding guess with a product bill attached. The next step may be monitoring, a closer look at a different pest life stage, an insect or tissue sample, soil analysis, UF/IFAS Extension or a plant-disease laboratory, an irrigation specialist, or an ISA Certified Arborist — and your report records exactly where things stand.',
      },
    ],
    // Ornamental-specific safety copy replaces the shared structural-pest
    // section (external review: crack-and-crevice / station / IGR-mosquito
    // content distracts from ornamental care).
    safetyOverride: {
      heading: 'Pets, kids, pollinators & your garden — ornamental-treatment safety, straight',
      paragraphs: [
        'Ornamental treatments live in the middle of your yard — around play areas, pets, pollinators, and sometimes food plants — so here is the full answer, not a slogan.',
        'Every pesticide product Waves applies is EPA-registered and used in accordance with its label — and that label is legally binding: it dictates the plants and sites it may be applied to, the rate, the required precautions, and when people and pets may re-enter. Registration does not mean risk-free, and no honest company will call any pesticide "completely safe."',
      ],
      bullets: [
        'Foliar sprays and root-zone applications carry different precautions — a leaf spray may need drying time on the foliage, while a soil or granular application may need watering-in. There is no single re-entry time for every visit: your service report states the exact guidance for the products actually used.',
        'Blooms and pollinators are checked before every application. Depending on the label, that can mean not treating open blooms, not treating while bees are foraging, adjusting timing or method, reducing drift, or leaving flowering plants untreated — and telling you why in the report.',
        'Edible plants are the strictest line we hold: products labeled only for ornamentals are never applied to food plants. Flag every edible — citrus, herbs, vegetables, fruit trees — before service, and they are treated only when the label and your plan expressly allow it.',
        'During service, keep children and pets away from the technician and the plants being treated, and bring in toys, bowls, and chews from treatment areas. Tell us about beehives, butterfly gardens, ponds, chickens, and tortoise or pet enclosures before we start.',
        'Signal words are the EPA’s at-a-glance acute-hazard categories — DANGER most severe, WARNING next, CAUTION the lowest signal-word category. Useful indicators, not a complete measure of every risk: the full label governs every application.',
        'Waves Pest Control, LLC operates under Florida pest-control business license JB351547 and is insured, and every applied product is documented in your service report with its own precautions and re-entry guidance.',
      ],
      closing: 'We will never tell you an ornamental treatment is “100% safe” — for your family or for pollinators — because no honest company can, and the EPA does not permit the claim. What we can show you is every choice made to keep exposure down, documented plant by plant.',
    },
    complianceExtras: [
      'Florida law requires a conspicuous treatment notice when pesticides are applied to lawns or exterior foliage — we post it at every qualifying visit.',
      'Local fertilizer ordinances cover landscape plants, not just turf: Manatee County, Bradenton, and Sarasota County restrict nitrogen and phosphorus fertilizers from June 1 through September 30, and the property address determines the rules any nutritional application must follow.',
      'Pesticide labels can carry pollinator-protection requirements — bloom restrictions, foraging restrictions, timing limits, and drift-reduction measures. Those are label law, and treatment timing and method are planned around them.',
    ],
    documentationOverride: {
      heading: 'Documented every visit — a plant-specific paper trail',
      bullets: [
        'Every completed visit produces a digital service report: plants and areas inspected, problems observed (or explicitly none), what was treated and why, the exact products applied, photos when they add evidence, and the watering and re-entry instructions for that visit.',
        'Your tree & shrub reports keep a plant-by-plant history — how each plant responded is on record, so future decisions build on your landscape’s actual behavior, not a one-size-fits-all route sheet.',
        'Track your technician’s live location and estimated arrival in the Waves app once they’re en route, and keep every past report, invoice, and visit in one place — savable and shareable as a PDF.',
        'Your service report is the record of each visit; your service agreement controls the plan itself — covered plants, scope, exclusions, and guarantee terms.',
      ],
    },
    ctaMicro: 'Plant-specific program · Covered callbacks per your program terms · Every visit documented',
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
    compliance: copy.complianceOverride || {
      heading: COMPLIANCE_SECTION.heading,
      bullets: [...COMPLIANCE_SECTION.bullets, ...(copy.complianceExtras || [])],
    },
    // Product-image callouts obey the SAME public-registry chokepoint as the
    // product list below them: an image that names a specific pesticide
    // product (its `product` key) renders only when that product is present
    // in the fetched public-approved registry rows — so a name the owner
    // hasn't approved for the public registry can't leak through a caption.
    // Generic imagery (no `product` key: the surfactant, fertilizer bags)
    // always renders.
    productImages: (() => {
      if (!copy.productImages) return null;
      const registryNames = products
        .map((p) => `${p.name || ''} ${p.common_name || ''}`.toLowerCase());
      const images = (copy.productImages.images || []).filter((img) => !img.product
        || registryNames.some((n) => n.includes(String(img.product).toLowerCase())));
      return images.length ? { ...copy.productImages, images } : null;
    })(),
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
