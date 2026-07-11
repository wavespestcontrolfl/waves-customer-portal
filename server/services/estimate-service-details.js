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
    'Every completed visit produces a digital service report: areas inspected, findings, areas treated, the exact products applied, photos, technician notes, and product-specific re-entry guidance.',
    'Track your technician’s live location and estimated arrival in the Waves app once they’re en route — no waiting on a four-hour window.',
    'The app also carries your full visit history, upcoming schedule, invoices and autopay, household contacts for shared alerts, and every past report — savable and shareable as a PDF.',
    'Your service report is the source of truth for your property: it names the exact products used at YOUR home, not a generic list.',
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
    'Every pesticide product Waves applies is EPA-registered and used in accordance with its product label. Registration is not a rubber stamp: before a product can be sold, the EPA requires the manufacturer to submit extensive scientific data — often more than 100 separate health and environmental studies — covering toxicity, exposure, residues, and environmental fate. The label that comes out of that process is legally binding: it dictates where the product may go, at what rate, with what precautions, and when people and pets may re-enter. In this industry the label is the law, and our technicians treat it that way.',
  ],
  bullets: [
    'Read the signal word on every product card in this guide. It is the EPA\u2019s at-a-glance acute-hazard communication: DANGER is the most severe category, WARNING is next, and CAUTION is the lowest signal-word category. It reflects the product\u2019s acute hazard labeling \u2014 a useful indicator, though not a complete measure of every risk, which is why the full label governs every application.',
    'Professional products are applied at label-mandated dilution rates measured in fractions of an ounce per gallon \u2014 our primary residual perimeter products go down at finished concentrations well under one-tenth of one percent active ingredient.',
    'Risk is toxicity multiplied by exposure — so we engineer the exposure side down. Crack-and-crevice, void, bait, and station placements put product where insects travel and children and pets do not: behind appliances, inside wall voids, in locked stations, along the foundation line — and always away from toys, food surfaces, and pet dishes.',
    'Where the target pest allows it, we choose insect-specific chemistry. Insect growth regulators (used in mosquito and flea programs) disrupt molting and reproduction hormone systems that mammals simply do not have, and termite bait actives inhibit chitin synthesis — chitin is the insect exoskeleton material; your dog does not make any.',
    'The "keep off until dry" rule has a mechanism behind it: while an application is wet, it can transfer to skin, paws, and mouths; once dry, the residue is bound to the treated surface where insects contact it. In Florida conditions exterior applications typically dry fast — and your service report states the exact product-specific re-entry window for your visit, per label, not a guess.',
    'Termite and rodent stations are locked and tamper-resistant, with the active material contained inside the device — engineered specifically so curious kids and pets meet a plastic housing, not a bait.',
    'More product is never the answer. Rates come from the label, not from pest pressure or an upsell — correct identification, accurate placement, and label-compliant application are what produce results.',
    'Waves Pest Control, LLC operates under Florida pest-control business license JB351547 and is insured, and every applied product is documented in your service report with its own re-entry guidance \u2014 so you never have to wonder what was used at your home or when the yard is yours again.',
  ],
  closing: 'We will never tell you a pesticide is "100% safe" — no honest company can, and the EPA does not permit that claim for any product. What we can show you is every choice made to keep exposure as close to zero as the job allows, and the paper trail to verify it. That is the standard we would want for our own kids and dogs — because our technicians treat their own homes with the same products and the same rules.',
};

// Customer-facing copy per service. `included` mirrors the estimate card
// inclusions; `process` is the inspection-led protocol walkthrough; `faq`
// answers the questions mined from real SMS threads and call transcripts.
// OWNER REVIEWS ALL OF THIS BEFORE THE GATE FLIPS — anything field reality
// doesn't back gets cut.
const SERVICE_DETAILS_COPY = {
  pest_control: {
    title: 'Pest Protection — Service Details',
    tagline: 'Inspection-led, property-specific structural protection — not a one-product pass around the house.',
    included: [
      'Exterior perimeter protection around entry-prone areas',
      'Interior service support when activity is reported',
      'Web, nest, and egg-sac removal from accessible exterior areas',
      'Free re-service between recurring visits',
    ],
    process: [
      'Every visit starts with inspection, not application: the foundation and lower walls, door and garage thresholds, window frames and sills, utility penetrations, cracks and crevices, eaves and soffits, lanai and entry areas, and the landscape zones touching the structure.',
      'We use both non-repellent and repellent solutions strategically. Non-repellents go precisely where pests enter, travel, and harbor — pests can cross or feed on them without avoiding them, and with some products and social insects (ants, roaches, termites) the active ingredient transfers deeper into the population.',
      'Repellent residual barriers go where we need a defended exterior zone — foundation band, adjacent beds and mulch lines, eaves, and other resting areas identified during inspection. Targeted, never an automatic blanket pass over every surface.',
      'Interior treatment concentrates on travel and harborage areas — plumbing penetrations, under sinks, behind appliances, cabinet voids — rather than indiscriminate baseboard spraying, and is included whenever you report activity.',
      'Accessible spider webs, egg sacs, and nest material are removed from exterior service areas every visit — mechanical work that disrupts resting and reproduction sites before they rebuild.',
    ],
    faq: [
      {
        q: 'Does pest control spray around the house base or just the grass?',
        a: 'The structure and the pest zones immediately around it: foundation band, entry points, thresholds, eaves, and the landscape edges touching the home. It is a structural application, not a turf application — full-lawn insect programs (chinch bugs, grubs, webworms) belong to the lawn program, and mosquitoes to the mosquito program. We will spot-treat a grassy area when activity there threatens the structure and the label allows it.',
      },
      {
        q: 'Is the interior included, or is that extra?',
        a: 'Included. Exterior protection does the standing work; whenever you see activity inside, interior treatment is part of your plan — no extra charge, no upsell.',
      },
      {
        q: 'Is it safe for my kids and pets?',
        a: 'This deserves more than a one-liner — see the full "Pets, kids & your family" section below. The short version: every pesticide is EPA-registered, applied at label-mandated dilutions (our primary perimeter products go down at well under one-tenth of one percent active ingredient), placed where insects travel and kids and pets do not, and your report states the exact re-entry window. The practical rule: keep people and pets off treated areas until dry.',
      },
      {
        q: 'What if it rains after my treatment?',
        a: 'We schedule around weather, and the exterior formulations we choose are designed for Florida conditions per their labels. If a downpour compromises an application, tell us — re-service between visits is free on your recurring plan.',
      },
      {
        q: 'I still see ants a few days after treatment — is it working?',
        a: 'Usually yes. Non-repellent treatments work through contact and transfer, which takes days rather than minutes, and activity can briefly rise as colonies contact the treatment. If activity has not clearly dropped within about a week, use your free re-service — that is what it is for.',
      },
      {
        q: 'Do I need to be home?',
        a: 'Not for exterior service. If interior work or gated access is needed, we coordinate through the app or a text — and you can watch the technician’s arrival live in the app either way.',
      },
    ],
  },
  mosquito: {
    title: 'Mosquito Defense — Service Details',
    tagline: 'A population-reduction program that targets where mosquitoes rest and breed — not just the ones flying by.',
    included: [
      'Targeted barrier application in mosquito resting zones',
      'Standing-water and breeding-pressure observations',
      'Weather-aware treatment timing',
    ],
    process: [
      'Adult mosquitoes rest in shaded, humid, protected foliage — so we treat dense shrubs, ornamental undersides, shaded beds, fence lines, and areas around outdoor structures using backpack misting equipment that places fine droplets inside the vegetation, not just on its surface.',
      'Where labeled and appropriate, the program combines an adult treatment, residual protection in resting vegetation, and an insect growth regulator (IGR) that interrupts immature mosquito development so larvae do not become biting adults.',
      'Every visit includes a walk for standing water and breeding pressure — gutters, planters, drains, toys, tarps — with findings documented in your report and correction recommendations when we spot a source.',
      'Applications are adjusted for wind, weather, flowering plants, people, pets, water features, and neighboring property — always label-directed.',
    ],
    faq: [
      {
        q: 'Isn’t my quarterly pest control enough for mosquitoes?',
        a: 'No — and that is by design, not upselling. Pest control treats the structure; mosquitoes rest in foliage and breed in water, which structural treatment does not reach. The mosquito program exists because the two problems live in different places.',
      },
      {
        q: 'Will this eliminate every mosquito?',
        a: 'No honest company promises that. This is a population-reduction program: pressure can rebuild from rainfall, standing water, and neighboring properties. What you should expect is a backyard that is comfortable to use again — and a technician watching for the breeding sources on your property every visit.',
      },
      {
        q: 'Monthly or seasonal — which should I pick?',
        a: 'Monthly (12 visits) holds pressure down year-round and suits properties near water or heavy vegetation. Seasonal (9 visits) concentrates on the high-pressure months at a lower annual cost. Your estimate recommends one based on your property; you can switch on the estimate page.',
      },
      {
        q: 'Is it safe for pets, kids, and my garden?',
        a: 'The program is engineered around exposure control — see the full "Pets, kids & your family" section below. Treatment goes INTO resting foliage, not across your yard or play areas, and stays away from flowering plants and water features per label. Where the program uses an insect growth regulator, it targets molting hormone systems that mammals do not have. Standard guidance: stay clear of treated foliage until dry; your report states the exact re-entry directions.',
      },
      {
        q: 'What if it rains right after treatment?',
        a: 'We time applications around weather so they are not wasted on a washout, and treatment placed inside dense foliage is more protected than a surface pass. If a storm undercuts a fresh treatment, contact us and we will make it right.',
      },
    ],
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
    safety: copy.safetyOverride || SAFETY_SECTION,
    systemBox: copy.systemBox || null,
    responsibilities: copy.responsibilities || null,
    ctaPlacement: copy.ctaPlacement || 'both',
    ctaMicro: copy.ctaMicro || null,
    products,
  };
}

module.exports = {
  SERVICE_DETAILS_COPY,
  serviceDetailsAvailable,
  buildServiceDetailsContent,
};
