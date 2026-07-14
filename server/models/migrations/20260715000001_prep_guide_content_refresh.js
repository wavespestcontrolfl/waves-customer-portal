'use strict';

/**
 * Prep guide content refresh (owner request 2026-07-14).
 *
 * Sources: 550+ mined Waves call transcripts (top asks: "is it pet/kid
 * friendly + do we have to leave", "do you come inside", "will it actually
 * work"), plus authority research (UF/IFAS, EPA, CDC, Purdue, UC IPM, UKY,
 * NPIC) and forum/SERP question mining. Customers almost never ask about
 * post-treatment cleaning on the phone — they find out after — so every
 * guide now answers it proactively.
 *
 * Every guide gains: a "Pets & kids" section (the single most-asked topic),
 * a "What to expect" section (worse-before-better honesty, don't-clean
 * rules, timelines), and a "Your questions, answered" FAQ block built from
 * real caller questions. Compliance: re-entry copy never says "safe" and
 * never promises fixed minutes — re-entry keys off dryness + technician
 * confirmation; product references say "EPA-registered".
 *
 * Two surfaces:
 *  1. prep.* email templates (email body + the public /prep/:token page):
 *     each gets a NEW active version (prior versions archived, never
 *     edited). prep.wildlife is deliberately untouched (owner content
 *     prohibition on wildlife-trapping content).
 *  2. Automations-tab sequence step-0 bodies (bed_bug / cockroach / flea —
 *     the live booking-triggered guide email): read-modify-write with an
 *     exact-match guard on the current body (verified verbatim against
 *     prod 2026-07-14), fixing the fixed-hour re-entry windows those
 *     bodies carried ("be out 3–4 hours" / "out of the kitchen 2 hours").
 */

const json = (v) => JSON.stringify(v);

const p = (content) => ({ type: 'paragraph', content });
const h = (content) => ({ type: 'heading', content });
const callout = (content) => ({ type: 'callout', content });
const faq = (rows) => ({ type: 'details', rows });

// The standard service-info block every prep guide leads with today.
const SERVICE_DETAILS = {
  type: 'details',
  rows: [
    { label: 'Service', value: '{{project_type}}' },
    { label: 'Service date', value: '{{service_date}}' },
    { label: 'Property', value: '{{property_address}}' },
  ],
};

const CTA = { type: 'cta' };

const PETS_KIDS_HEADING = h('Pets & kids');

const TEMPLATES = [
  {
    key: 'prep.flea',
    blocks: [
      p('Hi {{first_name}}, your Waves flea treatment is scheduled. Homes, pets, and habits beat fleas together — a little prep before we arrive makes the difference between one treatment and a repeat visit.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      p('Vacuum everywhere fleas hide: carpets, rugs, under furniture and cushions, pet resting spots, and along baseboards. The vibration also wakes dormant fleas so the treatment reaches them. Seal the vacuum bag or canister contents in a plastic bag and take it to an outside bin right away.'),
      p('Pick up clothes, shoes, toys, and anything else on the floor so the full carpet area can be treated.'),
      p('Wash pet bedding, blankets, and washable throws on a hot cycle and dry on high heat.'),
      p('Treat every pet the same day with a vet-recommended flea product. This is the step that makes or breaks flea control — an untreated pet re-seeds the home. Dog and cat products are not interchangeable, so follow your veterinarian’s guidance for each animal.'),
      PETS_KIDS_HEADING,
      p('We use EPA-registered products applied to the areas fleas actually live. Keep people and pets off treated areas until they are fully dry — your technician will tell you when things are ready before leaving. If anyone in the home is pregnant, chemically sensitive, or you have fish, birds, or reptiles, let us know so your technician can plan around them.'),
      h('What to expect after'),
      p('You may keep seeing some fleas for up to a few weeks — that is expected, not a failed treatment. Flea pupae are protected in their cocoons until they hatch, and the treatment gets them as they emerge. Vacuum every day or two during this stretch; it speeds the process up.'),
      p('Hold off on mopping, carpet shampooing, or steam cleaning treated floors and baseboards while the treatment does its work — wet cleaning strips the product that is still catching newly hatched fleas. Regular dry vacuuming is exactly right.'),
      faq([
        { label: 'I already used a fogger — does that help?', value: 'Store-bought foggers rarely reach fleas under furniture or in cocoons. Tell your technician what you’ve already applied and where, so they can plan the treatment around it.' },
        { label: 'I don’t even have pets — how do I have fleas?', value: 'Wildlife, a previous resident’s pets, or a visit from one flea-carrying animal is all it takes. The treatment works the same either way.' },
        { label: 'My pet is on flea medication — isn’t that enough?', value: 'Pet products protect the pet; they don’t clear the eggs and pupae already in your carpet. The home treatment and the pet treatment work as a pair.' },
      ]),
      callout('Fleas in the garage, lanai, or yard too? Reply and tell us where you’re seeing activity so your technician can cover those areas.'),
      CTA,
    ],
  },
  {
    key: 'prep.cockroach',
    blocks: [
      p('Hi {{first_name}}, please review these prep steps before your cockroach treatment. Twenty minutes of prep lets your technician spend their time treating instead of moving things.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      p('Clear access to the spots roaches love: under sinks, around and behind appliances, pantry edges, and bathroom cabinets. If you can, pull the fridge forward a bit — the warm motor area is prime real estate.'),
      p('Wipe up grease and crumbs and take out the trash the morning of the visit. Greasy surfaces reduce how well the treatment sticks, and less food around means roaches take the bait faster.'),
      p('Store food, dishes, utensils, toothbrushes, and pet bowls away from treatment areas. Toss any food that was sitting out uncovered.'),
      p('Skip the store-bought sprays before and between visits. Most of them repel roaches — they scatter the colony deeper into walls and can keep roaches away from our bait, which works the opposite way: they walk through it, carry it home, and share it.'),
      PETS_KIDS_HEADING,
      p('We use EPA-registered products, and bait placements go inside cracks, hinges, and voids — out of reach of curious hands and paws. Keep pets and kids out of treated rooms until surfaces are dry and your technician confirms things are ready. Tell us about dogs that chew, crawling babies, or anyone chemically sensitive and we’ll place accordingly.'),
      h('What to expect after'),
      p('Seeing MORE roaches in the first days is normal — treatment flushes them out of hiding, and that traffic is what spreads the bait. Activity usually tapers over the following weeks, and eggs that were already laid can hatch before the bait catches up with them, so a follow-up visit 10–14 days later is part of the plan, not a bad sign.'),
      p('Don’t deep-clean the treated zones: no wiping down baseboards, cabinet hinges, or the spots where bait was placed. Cleaning products push roaches away from the bait. Normal kitchen cleanup on counters and dishes is fine once everything is dry.'),
      faq([
        { label: 'Is this a German roach or a palmetto bug?', value: 'Big reddish roaches that wander in from outside are palmetto bugs — exterior treatment handles them. Small light-brown roaches with two dark stripes that live in your kitchen are German roaches — they need interior bait. Your technician will confirm which you have; feel free to text us a photo beforehand.' },
        { label: 'Do I need to empty every cabinet?', value: 'Usually no — bait-based treatment doesn’t require emptied cabinets. Clear access to the areas where you’ve seen activity, and your technician will tell you if a heavier infestation needs more.' },
        { label: 'Do you treat the lanai?', value: 'Yes — lanais, pool cages, and the exterior perimeter are part of roach defense in Florida. Reply if the lanai is a hot spot.' },
      ]),
      callout('Reply with the rooms or cabinets where activity is worst so your technician can prioritize those areas.'),
      CTA,
    ],
  },
  {
    key: 'prep.bed_bug',
    blocks: [
      p('Hi {{first_name}}, please review these prep steps before your bed bug treatment. Thorough preparation is one of the most important factors in getting rid of bed bugs — and one thing first: bed bugs are hitchhikers, not a housekeeping verdict. They ride in on luggage, furniture, and travel. It happens to spotless homes.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      p('Launder ALL bedding, linens, pillowcases, and clothing from affected rooms in hot water, then dry on the highest heat setting for at least 30 minutes — the high-heat dry is the step that kills every stage. Items that can’t be washed can go straight into a hot dryer for 30 minutes.'),
      p('Seal the cleaned items in NEW plastic bags and keep them sealed until your treatment plan — including the follow-up visit — is complete.'),
      p('Declutter around beds, nightstands, dressers, and closets, and swap cardboard boxes for sealed plastic bins where you can. Do NOT move items to other rooms — that’s how bed bugs spread through a house.'),
      p('Vacuum mattresses, box springs, bed frames, headboards, baseboards, furniture seams, and carpet edges. Seal the vacuum bag or contents in plastic and take it to an outside bin immediately.'),
      p('Pull beds and furniture 12–18 inches away from walls and remove wall hangings near beds. Keep bedding from touching the floor.'),
      p('Do NOT throw out your mattress or furniture. Discarding spreads bed bugs through the home on the way out, and a new mattress gets re-infested by the bugs that stayed behind. Ask your technician about mattress encasements — they lock any survivors in and protect the new start.'),
      PETS_KIDS_HEADING,
      p('We use EPA-registered products applied to the cracks, seams, and frames where bed bugs hide. Plan for everyone — people and pets — to be out of the home during the treatment and until your technician confirms treated areas are ready. If you have a fish tank, turn off the pump and cover the top; birds and reptiles are extra sensitive and should stay elsewhere during treatment. Tell us in advance about pregnancies, medical conditions, or anyone who needs help with the prep — we can work with you on it.'),
      h('What to expect after'),
      p('Seeing a few bed bugs in the first days after a treatment is normal — they’re being flushed across treated surfaces, which is the treatment working. Eggs laid before the visit can hatch afterward, which is exactly why the follow-up visit (typically about 14 days later) is critical. Repeat the same prep before that visit, and keep sleeping in the treated bed — moving to the couch just teaches the survivors to follow you.'),
      p('Leave the treated zones alone: don’t wipe down baseboards, bed frames, or outlet areas where product was applied. It keeps working for weeks if it stays put.'),
      faq([
        { label: 'How did I get bed bugs?', value: 'Travel, guests, used furniture, shared walls — anywhere people and their belongings move. It has nothing to do with how clean your home is.' },
        { label: 'Will one treatment fix it?', value: 'Bed bugs are the toughest household pest, and eggs survive the first visit. The follow-up is what breaks the cycle — be wary of anyone who promises every last egg gone in one shot.' },
        { label: 'I rent — what should I know?', value: 'Bed bugs travel between units through shared walls. Tell your landlord in writing, and keep your inspection and treatment records — they document that you addressed it properly.' },
      ]),
      callout('Your follow-up treatment is the critical step for breaking the egg cycle. Repeat all of these prep steps before that visit.'),
      CTA,
    ],
  },
  {
    key: 'prep.rodent',
    blocks: [
      p('Hi {{first_name}}, your Waves rodent service is coming up. Here’s how to get the home ready — and an honest picture of how rodent work goes, because it’s a process, not a one-visit fix.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      p('Clear a path to the attic hatch, garage corners, utility closets, and anywhere you’ve heard or seen activity. Attic access is the big one — move the boxes out from under the hatch.'),
      p('Store loose food, pet food, and bird seed in sealed containers, keep trash lidded, and pick up fallen fruit in the yard — fruit trees are a roof rat magnet in Florida.'),
      p('Leave droppings where they are — your technician reads them like a map (location, size, and freshness tell us species and traffic routes). And never sweep or vacuum droppings dry: stirring the dust is a health risk. If you must clean a spot, wet it thoroughly with a bleach solution first and use gloves — or leave it for us.'),
      p('If you’ve already put down consumer bait or traps, tell your technician exactly what and where. Leftover bait changes trap strategy, and we’d rather know than find it.'),
      PETS_KIDS_HEADING,
      p('Trapping comes first at Waves — traps inside the structure, not loose poison, so there’s nothing for pets or kids to get into indoors. Any exterior bait stations are tamper-resistant, locked, and anchored, designed so dogs and children can’t reach the contents. Keep pets away from placement areas, and never move a trap or station yourself — tell us and we’ll adjust it.'),
      h('What to expect after'),
      p('The first days can actually get NOISIER — traps snapping and rodents reacting to a changed environment means the plan is working. Follow-up visits to check and reset traps are part of the service; entry-point sealing (exclusion) comes after trapping has knocked the population down, because sealing too early traps animals inside.'),
      p('You’ll know it’s ending when the noises stop, traps come back empty, and no new droppings appear — your technician tracks all three. And a straight answer to a common worry: if a rodent dies somewhere unreachable, there can be an odor for a couple of weeks. It’s rare with trap-first work — this is exactly why we lead with traps instead of poison — but if it happens, call us and we’ll find it.'),
      faq([
        { label: 'Do rodents just leave on their own?', value: 'Not in Florida — an attic offers shelter and nesting, and roof rats breed year-round. Trapping plus sealing the entry points is what ends it.' },
        { label: 'Won’t they get smart and avoid the traps?', value: 'Rodents are cautious about new objects, which is why placement, bait choice, and follow-up adjustments matter — that’s the technician’s craft, and why we return to reposition rather than set-and-forget.' },
        { label: 'What does exclusion actually cover?', value: 'Sealing the gaps rodents use to get in — rooflines, soffits, vent screens, pipe penetrations. Your technician documents each sealed point, and a follow-up visit verifies nothing is getting back in.' },
      ]),
      callout('If you hear active movement in a wall or ceiling before we arrive, reply with the location — it helps your technician set the first traps where the traffic is.'),
      CTA,
    ],
  },
  {
    key: 'prep.termite',
    blocks: [
      p('Hi {{first_name}}, your Waves termite treatment is coming up. Good news first: for most termite treatments you don’t need to leave home, and prep is mostly about access.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      p('Move stored items 2–3 feet away from the walls in the garage and any interior treatment areas the technician has flagged, so the slab-wall line is reachable.'),
      p('Clear access to the attic hatch and any crawlspace openings, and unlock gates, garages, and utility rooms.'),
      p('Outside, pull mulch, firewood, and stored lumber back from the foundation where you can — soil treatment happens right along that line.'),
      PETS_KIDS_HEADING,
      p('Termite products are EPA-registered and targeted at the soil and structure, not living spaces. Keep people and pets away from open trenches, drill areas, and treated soil until the work is finished and your technician confirms areas are ready. Bait stations sit flush with the ground, locked and tamper-resistant — nothing exposed for dogs or kids to reach.'),
      h('What to expect during and after'),
      p('Liquid soil treatments involve trenching along the foundation and sometimes drilling small holes through slabs, patios, or garage floors where they meet the structure — expect some drill noise for a stretch. Every drilled hole gets patched before we leave.'),
      p('Seeing termites for a few weeks after treatment is normal and doesn’t mean it failed — with bait systems especially, the colony keeps feeding while the bait does its slow work; that’s by design. If you see swarmers or new mud tubes more than a month out, call us and we’ll inspect.'),
      p('Straight expectations: a liquid barrier protects the structure, and bait systems work on the colony itself — your technician will explain which your home is getting and why. If your inspection turns up drywood termites (a different Florida termite that lives in the wood, not the soil), treatment options differ and we’ll walk you through them separately.'),
      faq([
        { label: 'Do I have to leave the house?', value: 'No — soil and bait treatments don’t require vacating. Just steer clear of the active work areas until your technician gives the all-clear.' },
        { label: 'Will this poison my yard or garden?', value: 'The product is placed in the soil directly against the foundation and binds there — it isn’t broadcast across the yard. Keep edible plantings out of the treated strip along the foundation, and tell your technician about any vegetable beds near the house.' },
        { label: 'Do bait stations attract termites to my property?', value: 'No — termites forage blindly through soil and find stations that sit in their path. The stations intercept what’s already there; they don’t draw new colonies in.' },
        { label: 'Do I need to be home for station checks?', value: 'No — monitoring visits are exterior-only. We’ll let you know what we find.' },
      ]),
      callout('For construction or pre-treatment work, please make sure the site is accessible and ready for the treatment stage scheduled.'),
      CTA,
    ],
  },
  {
    key: 'prep.mosquito',
    blocks: [
      p('Hi {{first_name}}, your Waves mosquito service is coming up. The treatment targets where mosquitoes rest and breed — your prep doubles how well it works.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      p('Unlock gates so the technician can reach the yard, lanai, shrubs, shaded areas, and water-prone spots. If mowing is due, mow the day before — treatment bonds better to trimmed growth, and cutting flowering weeds first protects bees.'),
      p('Tip out standing water: buckets, toys, plant saucers, tarps, boat covers, and clogged gutter corners. Refresh birdbaths and pet bowls. In Florida, bromeliads are a signature breeding spot — flush them with the hose weekly.'),
      p('Bring pet bowls, kids’ toys, and patio cushions inside or away from treatment areas.'),
      PETS_KIDS_HEADING,
      p('Keep everyone — kids and pets — inside during the application and off treated vegetation until it’s dry; your technician will confirm when the yard is ready. We use EPA-registered products and deliberately skip play equipment, edible gardens, and open water. Tell us about fish ponds (we’ll make sure they’re covered and buffered), backyard beehives, or butterfly gardens — we treat around them, not over them.'),
      h('What to expect after'),
      p('Expect a strong knockdown, not a force field: barrier treatments dramatically reduce mosquitoes for several weeks, but new ones fly in from beyond your property and new hatches follow every rain. Seeing an occasional mosquito is normal — a steady comeback before your next application isn’t, so tell us if that happens.'),
      p('Once the product is dry it’s bonded to the foliage and rain-tolerant. If a heavy storm hits during or right after your application, let us know — we’ll make it right.'),
      faq([
        { label: 'Will this handle no-see-ums too?', value: 'Honestly: no-see-ums (biting midges) are a different insect and much harder to control — no yard treatment eliminates them. Our service reduces them somewhat, but anyone promising no-see-um elimination is overselling.' },
        { label: 'How long do we stay out of the yard?', value: 'Stay off treated areas until they’re dry. Your technician will tell you when the yard is ready before leaving.' },
        { label: 'Is it going to hurt the lizards and frogs?', value: 'The treatment targets mosquito resting areas at label rates and avoids open water where amphibians live. Tell your technician about ponds or rain gardens so they buffer those zones.' },
      ]),
      callout('If you have a pond, fountain, beehive nearby, pool concern, or drainage problem, reply with details before the visit.'),
      CTA,
    ],
  },
  {
    key: 'prep.lawn',
    blocks: [
      p('Hi {{first_name}}, your Waves lawn treatment is coming up. Quick prep below — plus the after-care answers most people wish they’d had in writing.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      p('If mowing is due, mow at least 24 hours before service. Skip mowing right after treatment — give it a day or two (your technician will say if this application needs longer) so the product isn’t stripped off the grass blades.'),
      p('Unlock gates and clear the lawn: toys, hoses, furniture, pet bowls, and pet waste. If you have shallow irrigation lines or an invisible-fence wire, flag or mention them.'),
      p('Keep irrigation OFF the night before so the grass is dry when we arrive, and hold watering after treatment until your technician’s instructions say otherwise — some applications need watering in, others need to stay dry. The service report spells out which.'),
      PETS_KIDS_HEADING,
      p('Keep kids and pets off the lawn until it’s dry — that’s the rule of thumb for every application, and your technician will note anything different on the service report. Dogs that graze on grass or lick paws are the main exposure route, so if you have a grazer, tell us and we’ll advise for that specific treatment. Products are EPA-registered and applied at label rates.'),
      h('What to expect after'),
      p('Weeds don’t die overnight: expect yellowing and wilting over 1–2 weeks, and stubborn perennials sometimes need a second pass. That timeline is the product working, not a miss.'),
      p('Honest lawn talk: grass that chinch bugs or fungus already killed won’t green back up — treatment stops the spread, and dead patches recover by regrowth, plugs, or sod. Your technician will tell you which you’re looking at. And if your lawn yellows in streaks within days of a visit, call us — that’s worth an immediate look, not a wait-and-see.'),
      faq([
        { label: 'Is this the same as mowing service?', value: 'No — we handle the health side: fertilization, weed control, and lawn insects. Your mower (or you) handles the cut. The two work best on a coordinated schedule.' },
        { label: 'Why no fertilizer on this visit?', value: 'Sarasota and Manatee counties ban nitrogen and phosphorus fertilizer June 1 – September 30 to protect the bays. Summer visits focus on insects, weeds, and iron instead — your lawn still gets fed, just within the rules.' },
        { label: 'What about watering restrictions?', value: 'District watering rules limit sprinkler days, and they change — your technician’s watering instructions always work within your allowed schedule. Hand-watering rules are looser than sprinkler rules if something needs a drink sooner.' },
      ]),
      callout('After service, follow the watering and dry-time instructions on your service report for that specific treatment — they change by application.'),
      CTA,
    ],
  },
  {
    key: 'prep.interior_pest',
    blocks: [
      p('Hi {{first_name}}, your Waves interior pest treatment is scheduled. A few minutes of prep gives your technician clean access to the places pests actually live.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      p('Clear access to baseboards, under sinks, cabinet edges, pantry corners, bathrooms, the garage, and any rooms where you’ve seen activity. Heavy furniture can stay — just open a path.'),
      p('Store food, dishes, utensils, toothbrushes, and pet bowls away from treatment areas, and put away kids’ toys and blankets from rooms being treated.'),
      p('Hold off on store-bought sprays before the visit — they scatter pests and work against the products your technician places.'),
      PETS_KIDS_HEADING,
      p('We use EPA-registered products with targeted placements — cracks, crevices, and entry points, not broadcast spraying over your living space. Keep pets and kids out of treated rooms until surfaces are dry and your technician confirms they’re ready. Have a fish tank? Cover it and switch off the pump during interior work. Pregnant, chemically sensitive, or have a crawling baby? Reply and tell us — your technician will adjust placements and walk you through the plan.'),
      h('What to expect after'),
      p('A brief uptick in sightings right after treatment is common — pests get flushed out of hiding as the product reaches them. Activity should fall off over the following days to a couple of weeks depending on the pest.'),
      p('Light cleaning is fine once surfaces are dry, but skip wiping baseboards and the treated cracks and corners for a while — the residual product keeps working there long after the visit.'),
      faq([
        { label: 'Do I need to leave the house?', value: 'Usually just the rooms being treated — until surfaces are dry and your technician confirms they’re ready. Your technician will tell you if this particular service needs more than that.' },
        { label: 'Do you need to come inside, or is outside enough?', value: 'It depends on the pest — exterior defense stops most invaders, but pests living indoors (like German roaches) need interior treatment. Your technician treats where the problem actually is.' },
        { label: 'Do I need to be home?', value: 'For interior work, yes — someone needs to let us in. Exterior-only visits don’t need you home as long as gates are open and pets are in.' },
      ]),
      callout('If activity is concentrated in a specific room, reply with that location so we can prioritize it during the visit.'),
      CTA,
    ],
  },
];

// ── Sequence step-0 bodies (the live booking-triggered guide email) ──────
// Exact-match, admin-edit-preserving swaps. "from" bodies verified verbatim
// against prod 2026-07-14. Fixes the fixed-hour re-entry windows and folds
// in the top proactive answers (don't-clean rules, worse-before-better,
// same-day pet treatment, don't-discard-the-mattress).

const STEP_SWAPS = [
  {
    templateKey: 'bed_bug',
    fromHtml: '<h2>Hi {{first_name}} — let\'s get your home bed bug-free</h2>\n<p>Bed bug treatments work best when the home is prepped properly. This list isn\'t optional — skipping steps is the #1 reason a treatment needs a follow-up.</p>\n\n<h2>Before we arrive</h2>\n<ul>\n  <li>Strip all bedding — sheets, pillowcases, comforters. Wash hot, dry hot for 30+ minutes.</li>\n  <li>Vacuum mattresses, box springs, and the floor along baseboards. Empty the vacuum outside.</li>\n  <li>Clear the floor of clutter (clothes, shoes, toys) in the affected rooms</li>\n  <li>Pull furniture 12–18 inches from the walls</li>\n  <li>Bag clean laundry in sealed plastic bags until the treatment is complete</li>\n</ul>\n\n<h2>Day of treatment</h2>\n<p>Plan to be out of the home for 3–4 hours. Pets too — including fish tanks covered and pumps off for the duration.</p>\n\n<h2>After</h2>\n<p>We\'ll schedule a follow-up visit at 14 days to catch any eggs that hatched post-treatment. Don\'t re-wash bedding until after that second visit.</p>\n\n<p>Reply to this email if anything on the list is unclear — we\'d rather answer now than re-treat later.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style="color:#71717A;font-size:12px;margin-top:16px;">Reply to this email anytime — it goes straight to our team.</p>',
    toHtml: '<h2>Hi {{first_name}} — let\'s get your home bed bug-free</h2>\n<p>Bed bug treatments work best when the home is prepped properly. This list isn\'t optional — skipping steps is the #1 reason a treatment needs a follow-up. And for the record: bed bugs hitchhike in on luggage and furniture. They are not a housekeeping verdict.</p>\n\n<h2>Before we arrive</h2>\n<ul>\n  <li>Strip all bedding — sheets, pillowcases, comforters. Wash hot, then dry on high heat 30+ minutes (the hot dryer is the step that kills every stage).</li>\n  <li>Vacuum mattresses, box springs, and the floor along baseboards. Seal the vacuum contents in plastic and take them to an outside bin.</li>\n  <li>Clear the floor of clutter (clothes, shoes, toys) in the affected rooms — but do NOT move items to other rooms; that spreads bed bugs through the house.</li>\n  <li>Pull furniture 12–18 inches from the walls</li>\n  <li>Bag clean laundry in NEW sealed plastic bags until the treatment plan is complete</li>\n  <li>Do NOT throw out your mattress or furniture — discarding spreads bugs on the way out, and encasements protect what you have. Ask your technician.</li>\n</ul>\n\n<h2>Day of treatment</h2>\n<p>Plan for everyone — people and pets — to be out of the home during treatment and until your technician confirms treated areas are ready. Fish tanks: pump off, top covered. Birds and reptiles are extra sensitive — arrange for them to stay elsewhere. If anyone is pregnant or chemically sensitive, reply and tell us before the visit.</p>\n\n<h2>After</h2>\n<p>Seeing a few bed bugs in the first days is normal — they\'re crossing treated surfaces, which is the treatment working. Your follow-up visit at about 14 days catches the eggs that hatch after the first pass — repeat this same prep before it, don\'t re-wash bedding until after that second visit, and keep sleeping in the treated bed (moving to the couch just teaches survivors to follow you). Don\'t wipe down baseboards or bed frames where product was applied — it keeps working for weeks.</p>\n\n<p>Reply to this email if anything on the list is unclear — we\'d rather answer now than re-treat later.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style="color:#71717A;font-size:12px;margin-top:16px;">Reply to this email anytime — it goes straight to our team.</p>',
  },
  {
    templateKey: 'cockroach',
    fromHtml: '<h2>Hi {{first_name}} — let\'s clear out the roaches</h2>\n<p>German cockroach treatments are more effective when their hiding spots are accessible. Spend 20 minutes on this and we\'ll spend 20 minutes less chasing them.</p>\n\n<h2>Before we arrive</h2>\n<ul>\n  <li>Empty kitchen cabinets and drawers — especially under the sink</li>\n  <li>Pull the fridge forward a foot if you can (they hide behind the motor)</li>\n  <li>Clear countertops and wipe up grease + crumbs</li>\n  <li>Remove pet food bowls and bag dry pet food in sealed containers</li>\n  <li>Take trash out the morning of the visit</li>\n</ul>\n\n<h2>Day of</h2>\n<p>Plan to be out of the kitchen for 2 hours after we apply the bait and gel. Pets out too. The product is non-repellent — roaches walk through it, go back to the nest, and spread it — so don\'t spray over-the-counter products between our visits or you\'ll scatter them without killing them.</p>\n\n<h2>Follow-up</h2>\n<p>We come back in 10–14 days to hit the second generation that hatches from existing eggs. Expect to still see a few roaches for the first 2–3 weeks — that\'s the bait working.</p>\n\n<p>Questions? Reply here.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style="color:#71717A;font-size:12px;margin-top:16px;">Reply to this email anytime — it goes straight to our team.</p>',
    toHtml: '<h2>Hi {{first_name}} — let\'s clear out the roaches</h2>\n<p>German cockroach treatments are more effective when their hiding spots are accessible. Spend 20 minutes on this and we\'ll spend 20 minutes less chasing them.</p>\n\n<h2>Before we arrive</h2>\n<ul>\n  <li>Clear access under the sink and to cabinets where you\'ve seen activity (with bait treatment you usually don\'t need to empty everything — your technician will say if a heavy infestation needs more)</li>\n  <li>Pull the fridge forward a foot if you can (they hide behind the motor)</li>\n  <li>Clear countertops and wipe up grease + crumbs — grease keeps the treatment from sticking</li>\n  <li>Remove pet food bowls and bag dry pet food in sealed containers; toss food that was sitting out uncovered</li>\n  <li>Take trash out the morning of the visit</li>\n</ul>\n\n<h2>Day of</h2>\n<p>Keep people and pets out of the kitchen until surfaces are dry and your technician confirms it\'s ready — bait goes into cracks, hinges, and voids, out of reach of kids and pets. The product is non-repellent — roaches walk through it, go back to the nest, and spread it — so don\'t spray over-the-counter products between our visits or you\'ll scatter them without killing them.</p>\n\n<h2>Follow-up</h2>\n<p>We come back in 10–14 days to hit the second generation that hatches from existing eggs. Expect to still see a few roaches for the first 2–3 weeks — seeing MORE at first is normal too; treatment flushes them out, and that traffic spreads the bait. One rule while it works: don\'t deep-clean the baited zones (baseboards, hinges, cabinet corners) — cleaning products push roaches away from the bait. Normal counter-and-dish cleanup is fine once dry.</p>\n\n<p>Questions? Reply here.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style="color:#71717A;font-size:12px;margin-top:16px;">Reply to this email anytime — it goes straight to our team.</p>',
  },
  {
    templateKey: 'flea',
    fromHtml: '<h2>Hi {{first_name}} — let\'s get your home flea-free</h2>\n<p>Flea treatments work best when the home, the pets, and the activity areas get handled together. Twenty minutes of prep before we arrive makes the difference between one treatment and a repeat visit.</p>\n\n<h2>Before we arrive</h2>\n<ul>\n  <li>Vacuum carpets, rugs, furniture edges, pet resting areas, and along baseboards — then empty the vacuum outside.</li>\n  <li>Wash pet bedding, blankets, and washable throws on a hot cycle.</li>\n  <li>Coordinate pet flea control with your veterinarian — treating the home without treating the pets is how fleas come back.</li>\n  <li>Pick up toys, clothes, and clutter from the floor so we can treat the full carpet area.</li>\n</ul>\n\n<h2>After the treatment</h2>\n<p>Keep people and pets off treated areas until they\'re dry. You may still see some flea activity for a short while as immature fleas emerge — that\'s expected, and continued vacuuming helps break the cycle.</p>\n\n<p>Reply to this email if anything on the list is unclear — we\'d rather answer now than re-treat later.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style="color:#71717A;font-size:12px;margin-top:16px;">Reply to this email anytime — it goes straight to our team.</p>',
    toHtml: '<h2>Hi {{first_name}} — let\'s get your home flea-free</h2>\n<p>Flea treatments work best when the home, the pets, and the activity areas get handled together. Twenty minutes of prep before we arrive makes the difference between one treatment and a repeat visit.</p>\n\n<h2>Before we arrive</h2>\n<ul>\n  <li>Vacuum carpets, rugs, under furniture and cushions, pet resting areas, and along baseboards — the vibration also wakes dormant fleas so the treatment reaches them. Seal the vacuum contents in plastic and take them to an outside bin.</li>\n  <li>Wash pet bedding, blankets, and washable throws on a hot cycle and dry on high heat.</li>\n  <li>Treat every pet the same day with a vet-recommended product — treating the home without treating the pets is how fleas come back. Dog and cat products are not interchangeable.</li>\n  <li>Pick up toys, clothes, and clutter from the floor so we can treat the full carpet area.</li>\n  <li>Used a fogger or spray already? Tell your technician what and where — foggers don\'t reach fleas under furniture, and it changes how we treat.</li>\n</ul>\n\n<h2>After the treatment</h2>\n<p>Keep people and pets off treated areas until they\'re dry — your technician will confirm when things are ready. You may still see fleas for up to a few weeks as protected pupae hatch — that\'s expected, not a failed treatment. Vacuum every day or two (it speeds things up), but hold off on mopping, shampooing, or steam-cleaning treated floors — wet cleaning strips the product that\'s still catching new hatchers.</p>\n\n<p>Reply to this email if anything on the list is unclear — we\'d rather answer now than re-treat later.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style="color:#71717A;font-size:12px;margin-top:16px;">Reply to this email anytime — it goes straight to our team.</p>',
  },
];

function textFromHtml(html) {
  return String(html || '')
    .replace(/<li>/g, '• ')
    .replace(/<\/(h2|p|li|ul)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function publishVersion(knex, key, blocks) {
  const template = await knex('email_templates').where({ template_key: key }).first();
  if (!template) return;
  const prior = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const now = new Date();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: prior?.subject || null,
    preview_text: prior?.preview_text || null,
    blocks: json(blocks),
    text_body: null,
    published_at: now,
  }).returning('*');
  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: now });
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: now,
    updated_at: now,
  });
}

async function swapStepBody(knex, { templateKey, fromHtml, toHtml }, direction) {
  const from = direction === 'up' ? fromHtml : toHtml;
  const to = direction === 'up' ? toHtml : fromHtml;
  const step = await knex('automation_steps')
    .where({ template_key: templateKey })
    .orderBy('step_order', 'asc')
    .first();
  if (!step || String(step.html_body || '') !== from) return; // admin-edited: leave alone
  await knex('automation_steps').where({ id: step.id }).update({
    html_body: to,
    text_body: textFromHtml(to),
    updated_at: new Date(),
  });
}

exports.TEMPLATES = TEMPLATES;
exports.STEP_SWAPS = STEP_SWAPS;

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_templates') && await knex.schema.hasTable('email_template_versions')) {
    for (const t of TEMPLATES) {
      await publishVersion(knex, t.key, t.blocks);
    }
  }
  if (await knex.schema.hasTable('automation_steps')) {
    for (const swap of STEP_SWAPS) {
      await swapStepBody(knex, swap, 'up');
    }
  }
};

exports.down = async function down(knex) {
  // Re-activate each template's prior version; the refresh version is
  // archived (versions are retained, never deleted).
  if (await knex.schema.hasTable('email_templates') && await knex.schema.hasTable('email_template_versions')) {
    for (const t of TEMPLATES) {
      const template = await knex('email_templates').where({ template_key: t.key }).first();
      if (!template?.active_version_id) continue;
      const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
      if (!current || JSON.stringify(JSON.parse(JSON.stringify(t.blocks))) !== JSON.stringify(
        typeof current.blocks === 'string' ? JSON.parse(current.blocks) : current.blocks,
      )) continue; // admin republished since: leave alone
      const prior = await knex('email_template_versions')
        .where({ template_id: template.id, status: 'archived' })
        .where('version_number', '<', current.version_number)
        .orderBy('version_number', 'desc')
        .first();
      if (!prior) continue;
      const now = new Date();
      await knex('email_template_versions').where({ id: prior.id }).update({ status: 'active', updated_at: now });
      await knex('email_template_versions').where({ id: current.id }).update({ status: 'archived', updated_at: now });
      await knex('email_templates').where({ id: template.id }).update({ active_version_id: prior.id, updated_at: now });
    }
  }
  if (await knex.schema.hasTable('automation_steps')) {
    for (const swap of STEP_SWAPS) {
      await swapStepBody(knex, swap, 'down');
    }
  }
};
