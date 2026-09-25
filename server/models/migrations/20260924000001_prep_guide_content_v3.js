'use strict';

/**
 * Prep guide content v3 (owner request 2026-09-24).
 *
 * The 2026-07-15 refresh (20260715000001) gave every guide a Pets & kids
 * section, a what-to-expect section, and an FAQ. Owner feedback: the guides
 * still read generic — no named products, no links, no numbers, and none of
 * the "why" that makes a customer actually do the prep. v3 keeps every
 * compliance rule from the refresh and adds substance:
 *
 *  - Named, linked product recommendations (plain manufacturer / retailer
 *    URLs — NO affiliate tags: Amazon Associates forbids Special Links in
 *    email, and docs/affiliate-links-pilot.md keeps affiliate material
 *    web-only).
 *  - Protocol-grounded "what we do on the day" copy taken from
 *    server/config/protocols.json (bait-first German roach work, 10–14 day
 *    follow-ups, trap-first rodent work, inspection-led bed bug work).
 *  - Specific prep checklists as `list` blocks (renderBlocks check rows),
 *    inline markdown links (renderInline), and a "do NOT" section where
 *    customers routinely sabotage the treatment (foggers, throwing out the
 *    mattress, spraying over bait).
 *  - Signature block with the office lines.
 *
 * Compliance carried forward (guarded by the migration test): re-entry copy
 * never says "safe" and never promises a fixed re-entry window — re-entry
 * keys off dryness + technician confirmation; product references say
 * "EPA-registered"; brand is "Waves Pest Control"; no "per visit"; no
 * wildlife content (prep.wildlife untouched — owner prohibition); no
 * fumigation/tenting content; bed bug copy describes chemical/IPM work
 * only (owner 2026-09-24: no heat-treatment component).
 *
 * Mechanics mirror 20260715000001: each template gets a NEW active version
 * (prior archived, never edited), stamped with MIGRATION_MARKER so down()
 * restores exactly the version it displaced. Subjects/preview text are
 * refreshed on the new version. Sequence step-0 bodies (automation_steps)
 * are NOT touched.
 */

const json = (v) => JSON.stringify(v);

const MIGRATION_MARKER = 'migration:20260924000001';

function snapshotSource(version) {
  try {
    const snap = typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
    return snap?.source || null;
  } catch { return null; }
}

const p = (content) => ({ type: 'paragraph', content });
const h = (content) => ({ type: 'heading', content });
const callout = (content) => ({ type: 'callout', content });
const list = (items) => ({ type: 'list', items });
const faq = (rows) => ({ type: 'details', variant: 'faq', rows });

const SERVICE_DETAILS = {
  type: 'details',
  rows: [
    { label: 'Service', value: '{{project_type}}' },
    { label: 'Service date', value: '{{service_date}}' },
    { label: 'Property', value: '{{property_address}}' },
  ],
};

// Same shape as the versions being replaced — renderTemplate only appends
// the default CTA when there is NO cta block, and renderBlocks skips a cta
// without url/url_variable (codex #2741 P2).
const CTA = { type: 'cta', label: 'Open prep guide', url_variable: 'prep_url' };

const PETS_KIDS_HEADING = h('Pets & kids');

const SIGNATURE = {
  type: 'signature',
  content: '— The Waves Pest Control Team\nOffice (941) 318-7612 · Mobile (941) 599-3489 · Toll-free (855) 926-0203\ncontact@wavespestcontrol.com · wavespestcontrol.com',
};

const REPLY_LINE = p('Questions before the visit, or something on this list you cannot get done in time? Reply to this email and it goes straight to our team. We would rather adjust the plan than treat a home that is not ready.');

// Plain product links. Hosts are allowlisted in the migration test.
const L = {
  nexgard: 'https://nexgardforpets.com/',
  simparica: 'https://www.simparicatrio.com/',
  bravecto: 'https://www.bravecto.com/',
  bravectoCats: 'https://www.bravecto.com/cats',
  credelio: 'https://www.credelio.com/',
  revolutionPlus: 'https://www.revolutionplus.com/',
  capstar: 'https://www.amazon.com/s?k=capstar+flea+tablets',
  frontline: 'https://frontline.com/',
  advantage: 'https://yourpetandyou.elanco.com/us/our-products/advantage-ii',
  serestoDog: 'https://www.amazon.com/Seresto-Vet-Recommended-Treatment-Prevention-Collar/dp/B00B8CG602',
  serestoCat: 'https://yourpetandyou.elanco.com/us/our-products/seresto/seresto-cats',
  adamsShampoo: 'https://www.chewy.com/adams-plus-flea-tick-shampoo-precor/dp/102579',
  fleaComb: 'https://www.chewy.com/hartz-groomers-best-flea-comb-dogs/dp/159708',
  encasement: 'https://www.amazon.com/dp/B003GTR8IO',
  interceptors: 'https://www.amazon.com/s?k=climbup+bed+bug+interceptor',
  doorSweep: 'https://www.amazon.com/dp/B07TFW5R2H',
  copperMesh: 'https://www.amazon.com/dp/B004G6YL5E',
  bedBugPage: 'https://www.wavespestcontrol.com/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/',
};

const TEMPLATES = [
  // ───────────────────────────── FLEA ─────────────────────────────
  {
    key: 'prep.flea',
    subject: 'Your flea treatment is booked — here is how to make it stick',
    preview: 'Pets first, floors second, then let us handle the rest. A five-minute read that saves a second visit.',
    blocks: [
      p('Hi {{first_name}}, your Waves flea treatment is on the calendar. Fleas are the one pest where what you do in the 48 hours before we arrive matters as much as what we apply. This guide is longer than our usual prep email on purpose: follow it and one treatment usually does the job. Skip it and the fleas come back in three weeks no matter who treats the house.'),
      SERVICE_DETAILS,
      h('Why fleas are different in Florida'),
      p('Almost every flea we find in Sarasota and Manatee homes is the cat flea, and it lives just as happily on dogs, raccoons, opossums and feral cats. Our humidity keeps eggs and larvae alive year-round, so there is no real off-season, just busier months from spring through fall.'),
      list([
        'One adult female lays 40 to 50 eggs a day. Eggs roll off the pet and land wherever the pet rests: bedding, couch cushions, carpet, the rug by the door.',
        'Only about 5% of the fleas in an infested home are adults. The other 95% are eggs, larvae and pupae hiding in fabric and floor cracks, which is why you keep seeing "new" fleas after killing the ones you can find.',
        'Pupae sit inside a sticky cocoon that no treatment reaches. They hatch when they feel vibration, warmth and breath, meaning a person or pet walking by. Vacuuming triggers that hatch on purpose so the treatment can reach them.',
        'Indoor-only pets still get fleas. Adults ride in on pant legs and shoes, and wildlife bedding under a lanai, deck or shed keeps a supply going outside.',
      ]),
      h('Step 1: Treat every pet, the same day as service'),
      p('Your pet is the flea\'s food source. If the pet is not treated, the house re-seeds itself within days. Do this for every dog and cat in the home, not just the one that is scratching.'),
      list([
        `Start a vet-recommended flea preventative before or on the day of service. Oral monthly products are our strongest recommendation because they cannot wash off and they kill fleas fast enough to stop egg laying: [NexGard](${L.nexgard}), [Simparica Trio](${L.simparica}), [Bravecto](${L.bravecto}) (12 weeks per dose) or [Credelio](${L.credelio}). For cats, ask your vet about [Revolution Plus](${L.revolutionPlus}) or [Bravecto for Cats](${L.bravectoCats}).`,
        `Need something today? [Capstar](${L.capstar}) kills adult fleas within 30 minutes and can be given alongside a monthly product. It only lasts 24 hours, so it is a bridge, not a plan.`,
        `Topical (spot-on) options if your vet prefers them: [Frontline Plus](${L.frontline}) (dog and cat versions) or [Advantage II](${L.advantage}). Apply 48 hours away from any bath.`,
        `Collar option: [Seresto for dogs](${L.serestoDog}) or [Seresto for cats](${L.serestoCat}) gives up to 8 months of protection. Buy from a vet or Chewy; counterfeit Seresto collars are common on marketplace sites.`,
        `Flea bath and comb the day before service: [Adams Plus Flea & Tick Shampoo with Precor](${L.adamsShampoo}) kills adults and includes an egg-stopping growth regulator. Follow with a [fine-toothed flea comb](${L.fleaComb}) at the neck, belly, tail base and behind the legs. Drop what you comb off into soapy water.`,
        'Wash or replace pet bedding. Anything you cannot hot-wash is better thrown out than kept.',
      ]),
      callout('Check with your veterinarian before combining products, and never use a dog flea product on a cat. Permethrin-based dog spot-ons are toxic to cats.'),
      h('Step 2: Vacuum like you mean it (the most important step)'),
      p('Vacuuming does three things at once: it removes eggs and larvae, it vibrates pupae into hatching so our residual can reach them, and it lifts carpet fibers so the product gets down to the base where larvae live. Do this within 24 hours before we arrive.'),
      list([
        'Vacuum every carpet, rug and hard floor, slowly, including under beds, under couch cushions, behind and under furniture, along every baseboard, and inside closets.',
        'Use the crevice tool along baseboards and in the seams of upholstered furniture. Fleas develop in cracks, not out in the open.',
        'Vacuum pet resting spots twice: the dog\'s favorite corner, the cat\'s windowsill perch, the rug by the back door.',
        'Empty the canister or bag into a sealed trash bag and take it outside to the bin right away. Otherwise the vacuum becomes a flea nursery.',
        'Wash all bedding, throw blankets, pet blankets, slipcovers and small rugs on the hottest cycle the fabric allows, then dry on high heat for at least 20 minutes. Heat kills all four life stages.',
        'Steam-cleaning carpets is a plus if you can rent a machine, but do it at least a day before service so carpets are dry when we treat.',
      ]),
      h('Step 3: Clear the floors and get the home ready'),
      list([
        'Pick up toys, pet toys, shoes, laundry, pet food and water bowls, and anything else off the floor so we can treat wall to wall. Pet toys and bowls go in a sealed bag or the dishwasher, not back on the floor until it is dry.',
        'Pull furniture 12 to 18 inches from the walls where possible. Fleas concentrate along edges.',
        'Cover or remove fish tanks: turn off the air pump and lay a towel over the tank. Bird cages go outside or into an untreated room with the door closed.',
        'Strip beds and pet beds so we can treat mattress edges and bed frames if needed.',
        'Plan for everyone, including pets, to be out of the home during the interior treatment and until floors are fully dry and your technician confirms the rooms are ready. Take the pets with you and get their vet treatment, bath or Capstar done during that window.',
        'Unlock gates and clear the lanai, patio and under-deck areas. If we are treating the yard, we focus on shaded, moist spots where pets rest and where wildlife bed down: under shrubs, along the foundation, under decks and sheds, and the pet\'s favorite dig spots.',
        'Used a fogger or store spray already? Tell your technician what and where. Foggers do not reach fleas under furniture, and it changes how we treat.',
      ]),
      PETS_KIDS_HEADING,
      p('We use EPA-registered products applied to the areas fleas actually live: floors, carpet, under furniture, baseboards and pet resting spots, never countertops, bedding surfaces or food areas. Keep people and pets off treated areas until they are fully dry and your technician confirms things are ready. If anyone in the home is pregnant or chemically sensitive, or you have fish, birds or reptiles, tell us so your technician can plan around them.'),
      h('What we do on the day'),
      p('Your technician applies a residual adulticide combined with an insect growth regulator (IGR) to floors, carpets, under furniture, baseboards and pet resting areas, then treats exterior harborage. The adulticide catches fleas that emerge over the next several weeks. The IGR sterilizes eggs and larvae so new fleas cannot mature, which is what breaks the cycle for good.'),
      h('What to expect after'),
      callout('Seeing fleas for 2 to 3 weeks after treatment is normal and does not mean it failed. Pupae keep hatching, land on the treated floor, and die within hours. The number you see should drop sharply after the first week.'),
      list([
        'Vacuum daily for the next 14 days, then every other day through week four. Every pass triggers more pupae to hatch onto the treated surface. Empty the canister outside each time.',
        'Do not mop, shampoo or steam-clean treated carpets and floors for at least 2 weeks. That strips the EPA-registered residual before it finishes the job. Spot-clean spills only.',
        'Keep pets on their preventative on schedule. A missed monthly dose is the number one reason fleas return.',
        'The white sock test: walk the carpet in white socks for a few minutes. Fleas jump toward movement and show up clearly against white. Do it weekly for a month; it tells you exactly which room still has activity.',
        'Still seeing more than a handful of fleas at day 21? Reply to this email or text us with the room, and we will schedule a follow-up look.',
      ]),
      h('Keeping them out for good'),
      list([
        'Year-round preventative on every pet. In Florida there is no off-season.',
        'Weekly vacuuming of pet areas, and wash pet bedding every two weeks on hot.',
        'Trim shrubs and ground cover along the foundation, keep the lawn mowed, and remove leaf and mulch buildup where pets rest. Fleas need shade and moisture to develop outdoors.',
        'Discourage wildlife: secure trash, do not leave pet food outside, and tell us about raccoons, opossums or stray cats sheltering under the lanai, deck or shed. That is the outdoor flea factory.',
        'Bathe your dog after the dog park or beach, and check with a flea comb when you get home.',
      ]),
      faq([
        { label: 'Do you treat the yard too?', value: 'When fleas are coming from outside, yes. Exterior work targets shaded, moist harborage along the foundation, under decks and shrubs, and where pets rest, not the open lawn. Reply if you are seeing fleas on the lanai or in the garage.' },
        { label: 'My pets are indoor-only. How did we get fleas?', value: 'Adult fleas ride in on shoes and pant legs, and a single female starts a colony. Wildlife sheltering under a lanai or deck is the most common outdoor source in this area.' },
        { label: 'Will one treatment do it?', value: 'Usually, when the pets are treated the same day and the vacuuming schedule is followed. Pupae that were already in the carpet keep hatching for a few weeks and die on the treated floor. If activity is not clearly dropping by week three, tell us and we will come back out.' },
      ]),
      REPLY_LINE,
      CTA,
      SIGNATURE,
    ],
  },

  // ─────────────────────────── COCKROACH ──────────────────────────
  {
    key: 'prep.cockroach',
    subject: 'Before your cockroach treatment: the prep that makes bait work',
    preview: 'Please do not spray anything before we come. Here is why, and what to do instead.',
    blocks: [
      p('Hi {{first_name}}, your cockroach treatment is booked. Roach work in Florida comes in two very different flavors, and the prep is different for each, so this guide covers both. The single most important line in it: please do not spray anything before or between our visits. Store sprays repel roaches away from the bait that actually kills the colony, and one can of spray can undo a treatment.'),
      SERVICE_DETAILS,
      h('Which roach do you have?'),
      list([
        'Small (about half an inch), tan with two dark stripes behind the head, seen in the kitchen or bathroom, often several at once, sometimes tiny babies: German cockroach. This is an indoor breeding infestation. Bait, growth regulator, sanitation and a follow-up visit are the cure.',
        'Big (1.5 to 2 inches), reddish brown, shows up one at a time near doors, the garage, lanai, drains or the pool bath, sometimes flies: American or smokybrown cockroach, the "palmetto bug." These live outside in mulch, palms and drains and wander in. The cure is exterior treatment plus sealing how they get in.',
        'Not sure? Reply with a photo and we will tell you before the visit.',
      ]),
      h('Prep for a German roach cleanout (kitchen and bath)'),
      p('Bait only works if roaches eat it, and they only eat it when it is the best food in the room. So prep is mostly about taking away their other options and giving us access to where they live: the warm, dark, damp spots around appliances and plumbing.'),
      list([
        'Do not spray, bomb or fog. Do not wipe cabinets down with bleach or strong cleaners the day of service. Both leave repellent residue that keeps roaches off the bait placements.',
        'Empty the cabinets under the kitchen sink and under bathroom sinks. If activity is heavy, also empty the lower cabinets and drawers nearest the stove and dishwasher. Put contents in bins or on the dining table.',
        'Clear the counters. Unplug small appliances (toaster, coffee maker, microwave) and pull them forward so we can treat behind and under them. Roaches nest inside toaster and microwave housings and in the motor area of the fridge.',
        'Wash all dishes and run the dishwasher the night before. No dirty dishes in the sink, none soaking in water. Wipe the stovetop and clean grease from around the burners and under the hood.',
        'Take the trash out and use a can with a lid. Pull the fridge forward if you can do so without hurting yourself or the floor; if not, we will.',
        'Pet food and water bowls up off the floor overnight, pet food stored in a sealed container, and pet toys and chew items picked up and put away. Bird seed and dog food bags are roach buffets, and a rawhide under the couch is a roach meal.',
        'Fix or report leaks: a dripping trap under the sink, a sweating pipe, a wet dishwasher kick plate. Roaches need water more than food. Dry the sink and tub before bed.',
        'Store open food (cereal, flour, sugar, chips, pet treats) in sealed containers or the fridge.',
        'Tell us where you see them most. Reply with the cabinet, appliance or room. We place bait where the roaches are, and your sightings save inspection time.',
      ]),
      h('Prep for palmetto bugs (exterior and occasional indoor)'),
      list([
        'Unlock gates and clear the lanai, garage entry and the strip along the house foundation so we can treat the perimeter, cracks and harborage zones.',
        'Pull mulch, leaf litter and stored items 12 inches back from the foundation where you can. Mulch against the slab is the number one palmetto bug harborage in this area.',
        'Note where they come in. Garage door corners, the gap under an exterior door, the pool bath, the laundry drain and the dishwasher air gap are the usual suspects. Tell us which.',
        'Run water down rarely used drains (guest bath, laundry, floor drains) once a week. A dry trap is an open door from the sewer.',
        `Check door sweeps. If you can see daylight under an exterior door, a roach fits. An [adjustable exterior door sweep](${L.doorSweep}) is a 20-minute fix, and we will point out which doors need one.`,
        'Bring pet bowls, pet toys and water dishes in off the lanai and patio before we treat.',
      ]),
      PETS_KIDS_HEADING,
      p('We use EPA-registered products, and German roach bait placements go inside cracks, hinges and voids as small gel dots, out of reach of curious hands and paws. Exterior treatment is a perimeter application, not a broadcast over the yard. Keep pets and kids out of treated rooms and off the treated perimeter until surfaces are dry and your technician confirms things are ready. Tell us about dogs that chew, crawling babies, or anyone chemically sensitive, and about fish tanks (cover and switch off the pump during interior work).'),
      h('What we do on the day'),
      p('For German roaches, we inspect the kitchen, bathrooms, cabinet hinges, appliance motors and plumbing voids, vacuum visible clusters, then place gel bait in dozens of small dots exactly where roaches travel, apply a non-repellent crack-and-crevice treatment, and add an insect growth regulator that stops nymphs from maturing and breeding. We leave sticky monitors to measure progress. For palmetto bugs, we treat the exterior perimeter, cracks, crevices and harborage zones, place granular bait in landscape and utility areas, and treat inside only where activity is present.'),
      h('What to expect after'),
      callout('For German roaches, expect to see MORE roaches for the first 3 to 7 days, often out in the open and moving slowly during the day. That is the bait working: poisoned roaches leave harborage, and others eat them and die too. Activity should fall off hard by day 10 to 14, when your follow-up visit is due.'),
      list([
        'Do not wipe, scrub or spray around the bait dots. They look like small brown gel spots in hinges, corners and under appliances. Leave them alone for a month.',
        'Do not use any store spray, fogger or bomb between visits. If you must kill one, step on it or use soapy water.',
        'Keep the kitchen dry and dish-free overnight for at least 30 days. This is the part of the treatment only you can do.',
        'Leave the sticky monitors in place. Your technician reads them at the follow-up.',
        'Vacuum dead roaches and droppings after a week; do not wet-mop cabinet interiors for 2 weeks. Normal counter and dish cleanup is fine once everything is dry.',
        'Still seeing live German roaches at day 14? That is exactly what the follow-up is for. Tell your technician what you have seen and where.',
      ]),
      h('Keeping them out'),
      list([
        'Sealed food, dry sink, lidded trash, pet food and pet toys up at night. Boring, and it is 80% of German roach prevention.',
        'Inspect grocery bags, cardboard boxes and secondhand appliances before they come inside. German roaches almost always arrive in something you carried in.',
        'Mulch and plantings 12 inches off the foundation, drains flushed weekly, door sweeps tight, and fix exterior moisture: dripping spigots, AC condensate lines, irrigation hitting the house.',
        'On a pest plan, your regular exterior service keeps palmetto bug pressure down year-round. Interior German roach activity is a separate, follow-up-driven treatment, and catching it early keeps it a one-visit job.',
      ]),
      faq([
        { label: 'Do I need to empty every cabinet?', value: 'No. Under-sink cabinets always, and the lower cabinets nearest the stove and dishwasher if activity is heavy. Bait-based treatment does not need the whole kitchen boxed up. Your technician will tell you if a heavier infestation needs more.' },
        { label: 'Do you treat the lanai?', value: 'Yes. Lanais, pool cages and the exterior perimeter are part of roach defense in Florida. Reply if the lanai is a hot spot.' },
        { label: 'Is the follow-up visit really necessary?', value: 'For German roaches, yes. Egg cases laid before the visit hatch over the following two weeks, and the follow-up catches that generation before it breeds. Skipping it is the most common reason a German roach job comes back.' },
      ]),
      REPLY_LINE,
      CTA,
      SIGNATURE,
    ],
  },

  // ─────────────────────────── BED BUG ────────────────────────────
  {
    key: 'prep.bed_bug',
    subject: 'Your bed bug treatment itinerary: before, during and after',
    preview: 'Prep is half the treatment. Here is exactly what to do, in order.',
    blocks: [
      p('Hi {{first_name}}, we know a bed bug problem is stressful, and we know most of the advice online is either wrong or sells you a fogger. This itinerary is the full plan: what to do before we arrive, what we do while we are there, and what to expect for the month after. Bed bug work is inspection-led and prep-dependent. The homes where one treatment plan finishes the job are the homes where this list got done. And one thing first: bed bugs are hitchhikers, not a housekeeping verdict. They ride in on luggage, furniture and travel. It happens to spotless homes.'),
      SERVICE_DETAILS,
      h('First, three things NOT to do'),
      list([
        'Do not use bug bombs or foggers. They do not reach bed bugs inside seams and wall voids, and they scatter them into other rooms, turning one bedroom problem into a whole-house one.',
        'Do not throw out your mattress or furniture. Treated correctly it is fine, and hauling an infested mattress through the house spreads bugs along the way. A new mattress in an untreated room gets infested within a week.',
        'Do not move to another bedroom or the couch. Bed bugs follow the breath of a sleeping person. Sleeping elsewhere just recruits that room. Keep sleeping in the treated bed so the bugs come to the treated zone.',
      ]),
      h('Before treatment: the prep checklist'),
      p('Bed bugs die in a hot dryer. They survive everything else you can buy at a store. So the prep is about laundry heat, access and containment, not spraying.'),
      list([
        'Wash all bedding, curtains, clothing, stuffed animals and fabric from affected rooms on hot, then dry on HIGH for at least 30 minutes. Dryer heat is what kills eggs; the wash alone does not.',
        'Bag clean items in new sealed plastic bags or bins as they come out of the dryer, and keep them sealed until after the follow-up visit. Label the bags "clean."',
        'Items that cannot be washed (shoes, books, electronics, delicate fabric): bag them, and either run them through the dryer on high for 30 minutes if the item can take it, or seal them for 3 days in a freezer at 0°F. Dry cleaning also works; tell the cleaner they came from a bed bug room.',
        'Do NOT carry loose items from the infested room into other rooms. Bag first, then move. This is the number one way infestations spread during prep.',
        'Declutter the floor and under the bed completely. Anything left on the floor is a hiding place we cannot treat, and clutter is the most common reason a treatment fails. Swap cardboard boxes for sealed plastic bins.',
        'Empty nightstands and dresser drawers into sealed bags. Leave the drawers open and pulled out.',
        'Pull the bed and all furniture 18 inches from the walls. Take pictures, clocks, mirrors and wall decor off the bedroom walls and set them on the bed, face down.',
        'Vacuum mattress seams, the box spring, bed frame joints, headboard, baseboards, carpet edges and upholstered furniture seams. Empty the vacuum into a sealed bag outside immediately. A vacuum with bed bugs in it is a mobile infestation.',
        'Strip the bed completely: mattress and box spring bare, no sheets, no encasement yet. We need to see and treat the seams.',
        'Unplug lamps, chargers and small electronics in the room and leave them on the bed so we can inspect them.',
        'Remove pets from the home, along with pet beds, food bowls and pet toys from the treated rooms. Cover fish tanks and turn off the air pump. Bird cages out.',
        'Leave the air conditioning on and set normally. There is no need to turn off the AC or fans.',
      ]),
      callout('Cannot get all of this done before the visit? Reply and tell us what is not finished. We would rather reschedule than treat a room that is not ready, because an incomplete prep usually means a second full treatment.'),
      h('Strongly recommended: buy these two things now'),
      list([
        `Mattress and box spring encasements: zippered, bed bug rated (the tag will say "bite proof" and "escape proof"). Install them AFTER we treat, not before, and leave them on for at least 12 months. Anything trapped inside dies; anything new cannot get into the seams. Example: [SafeRest zippered encasement](${L.encasement}).`,
        `Interceptor cups under all four bed legs, such as [ClimbUp interceptors](${L.interceptors}). They catch bugs traveling to and from the bed and tell you, and us, whether anything is still alive at the follow-up. Move the bed so nothing but the legs touches the floor, and keep sheets and blankets off the floor.`,
      ]),
      PETS_KIDS_HEADING,
      p('We use EPA-registered products applied to the cracks, seams, frames and voids where bed bugs hide, never to the mattress top, bedding or your belongings unless a product label specifically allows that use. Plan for everyone, people and pets, to be out of the home during the treatment and until your technician confirms treated areas are dry and ready. Fish tank: pump off and top covered. Birds and reptiles are especially sensitive, so they leave the home for the visit. Tell us about anyone pregnant or chemically sensitive so your technician can plan around them.'),
      h('During treatment: what your technician does'),
      list([
        'Inspects sleeping and resting areas first: mattress seams, box spring, bed frame, headboard, baseboards, outlets, furniture seams, luggage areas and adjacent rooms. We photograph evidence so the follow-up has a baseline.',
        'Treats cracks, crevices, bed frame, baseboards and furniture voids with a combination of a contact product for bugs present now and a residual for the ones that hatch later. Where the label and site allow, we add dust in voids and outlets and vacuum visible clusters.',
        'Bags or isolates items according to this guide, so we can treat around your belongings rather than on them.',
        'Documents rooms treated, method, and anything we could not reach, then sets the follow-up window.',
      ]),
      h('What to expect after: the four weeks that finish the job'),
      callout('Seeing a few bed bugs in the first week or two after treatment is expected. Eggs are not killed by most products; they hatch over 7 to 10 days onto treated surfaces and die. A second treatment 10 to 14 days later catches that hatch, which is why the follow-up is part of the plan and not a sign of failure.'),
      list([
        'Re-enter once your technician confirms the rooms are ready, then open windows or run fans for an hour.',
        'Install the mattress and box spring encasements now, on the bare treated mattress. Zip fully and tape over the zipper end. Leave on for 12 months minimum.',
        'Put the interceptor cups under the bed legs. Check them every few days and photograph anything you find. Your technician will ask at the follow-up.',
        'Keep sleeping in the treated bed. Do not relocate.',
        'Keep bagged items sealed until the follow-up visit clears the room. Then unbag a little at a time.',
        'Do not vacuum or wet-clean baseboards and treated cracks for 2 weeks. Vacuuming the open floor is fine and helpful.',
        'Repeat the laundry prep before the follow-up visit: bedding hot-washed and dried on high, floor clear, bed pulled from the wall.',
        'If you are seeing more bugs after week two rather than fewer, reply with a photo and the room. That changes the plan and we want to know early.',
      ]),
      h('Keeping them out after we are done'),
      list([
        'Travel is the main way they come back. Keep luggage on the rack, never on the bed or floor. When you get home, unpack straight into the washer and run the empty suitcase in a hot dryer or leave it in a hot garage or car for a day.',
        'Never bring in curbside or thrift furniture, especially upholstered pieces and mattresses, without inspecting the seams and legs with a flashlight.',
        'Check the interceptors monthly for the first year. An empty cup is real evidence you are clear.',
        'If you live in a condo or attached unit, tell your association or neighbor in writing and keep your treatment records. Shared walls mean shared bugs, and a treated unit next to an untreated one gets reinfested.',
      ]),
      faq([
        { label: 'How did I get bed bugs?', value: 'Travel, guests, used furniture, shared walls. Anywhere people and their belongings move. It has nothing to do with how clean your home is.' },
        { label: 'Will one treatment fix it?', value: 'Bed bugs are the toughest household pest, and eggs survive the first visit. The follow-up 10 to 14 days later is what breaks the cycle. Be wary of anyone who promises every last egg gone in one shot.' },
        { label: 'I rent. What should I know?', value: 'Bed bugs travel between units through shared walls. Tell your landlord in writing, and keep your inspection and treatment records. They document that you addressed it properly.' },
      ]),
      p(`Full expanded checklist and photos of what to look for: [our bed bug guide on wavespestcontrol.com](${L.bedBugPage}).`),
      REPLY_LINE,
      CTA,
      SIGNATURE,
    ],
  },

  // ──────────────────────────── RODENT ────────────────────────────
  {
    key: 'prep.rodent',
    subject: 'Your rodent service: how it works, and how to get the home ready',
    preview: 'Trap-first, then seal. Here is what to do before we arrive and what the next few weeks look like.',
    blocks: [
      p('Hi {{first_name}}, your Waves rodent service is coming up. Here is how to get the home ready, and an honest picture of how rodent work goes: it is a process with a trapping phase, a sealing phase and a verification phase, not a one-visit fix. Most of what we handle in this area is roof rats, which live in attics, palms and soffits, and occasionally house mice in garages.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      list([
        'Clear a path to the attic hatch, garage corners, utility closets, the water heater closet and anywhere you have heard or seen activity. Attic access is the big one: move the boxes out from under the hatch and make sure a ladder can stand there.',
        'Store loose food, pet food and bird seed in sealed hard containers (rats chew through bags), keep trash lidded, and pick up fallen fruit in the yard. Citrus, mango and palm fruit are roof rat magnets in Florida.',
        'Pet food and water bowls come up off the floor and lanai overnight. Pet toys and chew items get put away too; a rawhide left out is a food source.',
        'Leave droppings where they are. Your technician reads them like a map: location, size and freshness tell us species and traffic routes. Never sweep or vacuum droppings dry; stirring that dust is a health risk. If you must clean a spot, soak it first with a disinfectant or a bleach solution (1 part bleach to 10 parts water), wait five minutes, and wipe with gloves on.',
        'If you have already put down consumer bait or traps, tell your technician exactly what and where. Leftover bait changes trap strategy, and we would rather know than find it.',
        'Note the sounds: scratching at dusk in the ceiling is classic roof rat; daytime noise in a wall near the kitchen leans mouse. Tell us the time of day and the room.',
        'Unlock gates and side yards. Exterior inspection covers the roofline, soffit vents, AC line penetrations, the garage door seal and where palm fronds or tree limbs touch the roof.',
      ]),
      PETS_KIDS_HEADING,
      p('Trapping comes first at Waves: traps inside the structure, not loose poison, so there is nothing for pets or kids to get into indoors. Any exterior bait stations are EPA-registered, tamper-resistant, locked and anchored, designed so dogs and children cannot reach the contents. Keep pets away from placement areas, and never move a trap or station yourself. If a dog or cat does get into anything, call us and your vet right away with the product name from the station label.'),
      h('What we do on the day'),
      p('Inspection first: attic, garage, exterior roofline and entry points, with photos of droppings, rub marks, gnawing and nesting. Then trap placement along the routes the evidence shows, usually in the attic and garage, with bait chosen for the species. Exterior bait stations go along the foundation and near fruit trees only where the evidence supports them. Exclusion, meaning sealing the entry points with steel wool, hardware cloth, copper mesh or sheet metal, comes after the trapping phase has knocked the population down, because sealing too early traps animals inside the structure.'),
      h('What to expect after'),
      callout('The first few days can get NOISIER. Traps snapping and rodents reacting to a changed environment means the plan is working. You will know it is ending when the noises stop, traps come back empty and no new droppings appear. Your technician tracks all three.'),
      list([
        'Follow-up visits to check, reset and reposition traps are part of the service. Rodents are wary of new objects, so placement often gets adjusted on the second visit.',
        'Do not move, bait or check traps yourself, and keep kids and pets out of the attic and garage placement zones.',
        'Straight answer to a common worry: if a rodent dies somewhere unreachable, there can be an odor for a week or two. It is rare with trap-first work, which is exactly why we lead with traps, and we will help locate and remove it if it happens.',
        'Once trapping is quiet, exclusion seals the entry points and a verification visit confirms nothing is getting back in.',
        `Homeowner fixes that help: trim palms and tree limbs 4 feet off the roof, replace a worn garage door bottom seal, and stuff gaps around pipes with [copper mesh](${L.copperMesh}) or steel wool before caulking. Your technician will point out which gaps matter.`,
      ]),
      faq([
        { label: 'Do rodents just leave on their own?', value: 'Not in Florida. An attic offers shelter and nesting, and roof rats breed year-round. Trapping plus sealing the entry points is what ends it.' },
        { label: 'Will they get smart and avoid the traps?', value: 'Rodents are cautious about new objects, which is why placement, bait choice and follow-up adjustments matter. That is the technician\'s craft, and why we return to reposition rather than set and forget.' },
        { label: 'What does exclusion actually cover?', value: 'Sealing the gaps rodents use to get in: rooflines, soffits, vent screens, pipe penetrations, the garage door seal. Your technician documents each sealed point, and a follow-up visit verifies nothing is getting back in.' },
        { label: 'Should I clean the attic insulation?', value: 'Wait until trapping is done and the entry points are sealed. Cleaning first just gets re-soiled. Heavily contaminated insulation can be removed and replaced afterward; your technician will tell you if it is bad enough to warrant that.' },
      ]),
      callout('If you hear active movement in a wall or ceiling before we arrive, reply with the location and the time of day. It helps your technician set the first traps where the traffic is.'),
      REPLY_LINE,
      CTA,
      SIGNATURE,
    ],
  },

  // ─────────────────────────── TERMITE ────────────────────────────
  {
    key: 'prep.termite',
    subject: 'Your termite treatment: what to expect and how to prepare',
    preview: 'Good news first: for most termite treatments you do not need to leave home. Prep is mostly about access.',
    blocks: [
      p('Hi {{first_name}}, your Waves termite treatment is coming up. Good news first: for most termite treatments you do not need to leave home, and prep is mostly about access. This guide explains what we do, what the day sounds like, and what the years after look like, because a termite treatment is a long-term protection plan, not a one-time spray.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      list([
        'Move stored items 2 to 3 feet away from the walls in the garage and any interior treatment areas the technician has flagged, so the slab-to-wall line is reachable. The garage perimeter is almost always part of it.',
        'Clear access to the attic hatch and any crawlspace openings, and unlock gates, garages, utility rooms and pool equipment areas.',
        'Outside, pull mulch, firewood, potted plants and stored lumber back from the foundation where you can. Soil treatment happens right along that line, and firewood stacked against the house is a termite bridge.',
        'Mark or tell us about anything buried along the foundation: irrigation lines, low-voltage lighting wire, invisible fence wire, French drains, septic lines. Trenching and rod injection go along the slab edge, and we want to miss those.',
        'If you have a well or an edible garden within a few feet of the foundation, tell us before the visit. It changes placement and product choice.',
        'Pets and kids inside during the exterior work, and out of the garage and any interior drilling zones.',
      ]),
      PETS_KIDS_HEADING,
      p('Termite products are EPA-registered and targeted at the soil and structure, not living spaces. Keep people and pets away from open trenches, drill areas and treated soil until the work is finished and your technician confirms areas are ready. Bait stations sit flush with the ground, locked and tamper-resistant. Nothing is broadcast across the lawn, and treated soil is backfilled before we leave.'),
      h('What to expect during and after'),
      list([
        'Liquid soil treatments involve trenching along the foundation and, where a slab, patio, driveway or garage floor meets the structure, drilling small holes every 12 to 18 inches to inject product under the slab. Expect drill noise for a stretch. Every hole gets plugged and patched before we leave.',
        'Bait systems involve stations set in the soil every 10 to 20 feet around the structure. Termites find them while foraging and carry the bait back to the colony. This is slower on purpose; the colony has to keep feeding for the bait to reach the queen.',
        'Seeing termites for a few weeks after treatment is normal and does not mean it failed. With bait especially, the colony keeps working while the bait does its job. Swarmers or new mud tubes more than a month out are worth a call, and we will inspect.',
        'Your technician will explain which system your home is getting and why. A liquid barrier protects the structure at the soil line; bait works on the colony itself. Some homes get both.',
        'If the inspection turns up drywood termites, a different Florida termite that lives inside the wood rather than the soil, treatment options differ and we will walk you through them before doing anything.',
      ]),
      h('Protecting the treatment for the long haul'),
      list([
        'Keep the treated strip along the foundation undisturbed. Do not add new planting beds, regrade, or pile mulch against the slab; that breaks the barrier and hides mud tubes.',
        'Keep mulch and soil at least 6 inches below the top of the slab and off stucco. Stucco that runs into the ground is the most common termite entry we see in Lakewood Ranch and Bradenton construction.',
        'Fix moisture: leaking spigots, AC condensate dripping at the foundation, irrigation heads spraying the house, gutters dumping at the slab. Subterranean termites follow moisture.',
        'Store firewood and lumber off the ground and away from the house. Remove dead stumps and roots near the foundation.',
        'Keep your annual inspection. Renewals and station checks are what keep the protection valid year after year.',
      ]),
      faq([
        { label: 'Do I have to leave the house?', value: 'No. Soil and bait treatments do not require vacating. Just steer clear of the active work areas until your technician gives the all-clear.' },
        { label: 'Will this poison my yard or garden?', value: 'The product is placed in the soil directly against the foundation and binds there; it is not broadcast across the yard. Keep edible plantings out of the treated strip along the foundation, and tell your technician about any vegetable beds near the house.' },
        { label: 'Do bait stations attract termites to my property?', value: 'No. Termites forage blindly through soil and find stations that sit in their path. The stations intercept what is already there; they do not draw new colonies in.' },
        { label: 'Do I need to be home for station checks?', value: 'No. Monitoring visits are exterior-only. We will let you know what we find.' },
        { label: 'Will the drill holes show?', value: 'Each hole is about the width of a pencil and gets plugged and patched with a color-matched or concrete patch. In a garage or on a patio they are visible up close if you look for them, and they fade with time.' },
      ]),
      callout('For construction or pre-treatment work, please make sure the site is accessible and ready for the treatment stage scheduled.'),
      REPLY_LINE,
      CTA,
      SIGNATURE,
    ],
  },

  // ─────────────────────────── MOSQUITO ───────────────────────────
  {
    key: 'prep.mosquito',
    subject: 'Before your mosquito service: the prep that doubles the results',
    preview: 'Tip out standing water, flush the bromeliads, unlock the gate. The rest is ours.',
    blocks: [
      p('Hi {{first_name}}, your Waves mosquito service is coming up. The treatment targets where mosquitoes rest during the day, the undersides of leaves in shaded, humid spots, and where they breed, which is any standing water older than about five days. Your prep doubles how well it works, because we cannot treat water we cannot find and mosquitoes keep hatching from it.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      list([
        'Unlock gates so the technician can reach the yard, lanai, shrubs, shaded areas and water-prone spots. If mowing is due, mow the day before. Treatment bonds better to trimmed growth, and cutting flowering weeds first protects bees.',
        'Tip out standing water: buckets, kids\' toys, plant saucers, tarps, boat and grill covers, wheelbarrows, clogged gutter corners, the tray under the AC. A bottle cap of water can breed mosquitoes.',
        'Bromeliads are the signature Florida breeding spot. Flush every bromeliad cup with the hose weekly, or reply if you want us to treat them with a larvicide granule.',
        'Refresh birdbaths and outdoor pet water every few days, and bring pet bowls, pet toys, kids\' toys and patio cushions inside or away from treatment areas before we arrive.',
        'Check the rain barrel, the pool cover and the pond: screen the barrel inlet, drain the cover, and tell us about the pond so we buffer it and avoid open water.',
        'Walk the yard for the hidden ones: a forgotten cooler, a tire, a low spot that stays wet, the bottom of a dead palm frond pile. Those are the sources we most often find on a first visit.',
      ]),
      PETS_KIDS_HEADING,
      p('Keep everyone, kids and pets, inside during the application and off treated vegetation until it is dry. Your technician will confirm when the yard is ready. We use EPA-registered products and deliberately skip play equipment, edible gardens, blooming plants and open water. Tell us about fish ponds (we make sure they are covered and buffered), beehives nearby, and anyone with chemical sensitivities.'),
      h('What we do on the day'),
      p('A barrier application to the foliage undersides, shaded shrubs, under the lanai cage edge, under decks and along fence lines where adult mosquitoes rest, plus a larvicide in standing water we cannot drain, such as drains, bromeliad cups and ornamental water features where labeled. The product bonds to the leaf surface as it dries and keeps working for weeks.'),
      h('What to expect after'),
      list([
        'Expect a strong knockdown, not a force field. Barrier treatments dramatically reduce mosquitoes for several weeks, but new ones fly in from beyond your property and new hatches follow every rain. An occasional mosquito is normal; a steady comeback before your next application is not, so tell us if that happens.',
        'Once the product is dry it is bonded to the foliage and rain-tolerant. If a heavy storm hits during or right after your application, let us know and we will make it right.',
        'Keep tipping out water between visits. Treatment handles the adults; you handle the nursery.',
        'Wait until foliage is dry before letting kids and pets back on the treated shrubs, and hold off on hosing down treated plants for a day.',
      ]),
      faq([
        { label: 'Will this handle no-see-ums too?', value: 'Honestly: no-see-ums (biting midges) are a different insect and much harder to control. No yard treatment eliminates them. Our service reduces them somewhat, but anyone promising no-see-um elimination is overselling.' },
        { label: 'How long do we stay out of the yard?', value: 'Stay off treated areas until they are dry. Your technician will tell you when the yard is ready before leaving.' },
        { label: 'Is it going to hurt the lizards, frogs and butterflies?', value: 'The treatment targets mosquito resting areas at label rates, skips blooming plants and avoids open water where amphibians live. Tell your technician about ponds, rain gardens or a butterfly garden so they buffer those zones.' },
        { label: 'How often do I need this?', value: 'In season, every 3 to 4 weeks keeps the barrier continuous. Waves also offers a misting system for lanais and pool decks if you want set-and-forget coverage; ask your technician.' },
      ]),
      callout('If you have a pond, fountain, beehive nearby, pool concern or drainage problem, reply with details before the visit.'),
      REPLY_LINE,
      CTA,
      SIGNATURE,
    ],
  },

  // ───────────────────────────── LAWN ─────────────────────────────
  {
    key: 'prep.lawn',
    subject: 'Before your lawn treatment: mowing, watering and what happens next',
    preview: 'Mow the day before, irrigation off the night before, and the after-care answers most people wish they had in writing.',
    blocks: [
      p('Hi {{first_name}}, your Waves lawn treatment is coming up. Quick prep below, plus the after-care answers most people wish they had in writing. Florida turf, mostly St. Augustine and some zoysia and bahia around here, responds to a treatment on its own schedule, and knowing that schedule is most of the battle.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      list([
        'If mowing is due, mow at least 24 hours before service. Skip mowing right after treatment; give it a day or two (your technician will say if this application needs longer) so the product is not stripped off the grass blades.',
        'Mow height matters more than most people think. St. Augustine wants 3.5 to 4 inches. Cutting it short in our heat stresses the turf, invites weeds and undoes fertilization. Sharpen the blade twice a season.',
        'Unlock gates and clear the lawn: toys, hoses, furniture, pet bowls, pet toys and pet waste. If you have shallow irrigation lines, an invisible-fence wire or landscape lighting wire, flag them or mention them.',
        'Keep irrigation OFF the night before so the grass is dry when we arrive, and hold watering after treatment until your technician\'s instructions say otherwise. Some applications need watering in; others need to stay dry. The service report spells out which.',
        'Bring pets inside for the visit and keep them off the lawn until it is dry.',
      ]),
      PETS_KIDS_HEADING,
      p('Keep kids and pets off the lawn until it is dry. That is the rule of thumb for every application, and your technician will note anything different on the service report. Dogs that graze on grass or lick paws are the main exposure route, so if you have a grazer, tell us and we will advise for that specific treatment. Products are EPA-registered and applied at label rates to the turf, not to beds, edible plantings or the lanai.'),
      h('What to expect after'),
      list([
        'Weeds do not die overnight. Expect yellowing and wilting over 1 to 2 weeks, and stubborn perennials like dollarweed and sedge sometimes need a second pass. That timeline is the product working, not a miss.',
        'Honest lawn talk: grass that chinch bugs or fungus already killed will not green back up. Treatment stops the spread, and dead patches recover by regrowth, plugs or sod. Your technician will tell you which you are looking at.',
        'If your lawn yellows in streaks within days of a visit, call us. That is worth an immediate look.',
        'After a fertilizer application, expect greening in 7 to 14 days. After an insecticide application for chinch bugs, expect the spread to stop within a week; the damaged area fills in over the following month with proper watering.',
        'Fungus in summer (brown patch, gray leaf spot) is usually a watering problem first. Water early morning, 2 to 3 times a week deeply, never in the evening. Nightly light watering is the single most common thing we see killing Lakewood Ranch lawns.',
      ]),
      faq([
        { label: 'Is this the same as mowing service?', value: 'No. We handle the health side: fertilization, weed control and lawn insects. Your mower (or you) handles the cut. The two work best on a coordinated schedule.' },
        { label: 'Why no fertilizer on this visit?', value: `Sarasota and Manatee counties ban nitrogen and phosphorus fertilizer June 1 through September 30 to protect the bays. Summer visits focus on insects, weeds, iron and soil health instead. Your lawn still gets fed, just within the rules.` },
        { label: 'What about watering restrictions?', value: `District watering rules limit sprinkler days, and they change with drought conditions. Your technician's watering instructions always work within your allowed schedule. Hand-watering rules are looser than sprinkler rules if something needs a drink sooner.` },
        { label: 'Can I overseed or lay sod right after?', value: 'Not right after a weed treatment. Pre-emergent and some post-emergent products stop new grass too. Ask your technician for the window; it is usually several weeks.' },
      ]),
      callout('After service, follow the watering and dry-time instructions on your service report for that specific treatment. They change by application.'),
      REPLY_LINE,
      CTA,
      SIGNATURE,
    ],
  },

  // ─────────────────────── INTERIOR PEST ──────────────────────────
  {
    key: 'prep.interior_pest',
    subject: 'Before your interior pest treatment: a few minutes of prep',
    preview: 'Clear the access points, put the food away, skip the store sprays. Here is the full list.',
    blocks: [
      p('Hi {{first_name}}, your Waves interior pest treatment is scheduled. A few minutes of prep gives your technician clean access to the places pests actually live: the edges, cracks and entry points, not the middle of the room. Interior work is targeted placement, so the more of those spots we can reach, the longer the result lasts.'),
      SERVICE_DETAILS,
      h('Before we arrive'),
      list([
        'Clear access to baseboards, under sinks, cabinet edges, pantry corners, bathrooms, the laundry room, the garage, and any rooms where you have seen activity. Heavy furniture can stay; just open a path along the walls.',
        'Store food, dishes, utensils, toothbrushes and pet bowls away from treatment areas, and put away kids\' toys, pet toys and blankets from rooms being treated.',
        'Hold off on store-bought sprays before the visit. They scatter pests and work against the products your technician places.',
        'Wipe up crumbs and grease and take out the trash the morning of the visit so pests take the bait placements instead.',
        'Write down what you have seen and where: the pest, the room, the time of day. Ants at the kitchen sink at night and ants on the lanai at noon are often two different species with two different fixes.',
        'Pets in a closed room or out with you during interior work; fish tank covered with the pump off.',
      ]),
      PETS_KIDS_HEADING,
      p('We use EPA-registered products with targeted placements: cracks, crevices, hinges, voids and entry points, not broadcast spraying over your living space. Keep pets and kids out of treated rooms until surfaces are dry and your technician confirms they are ready. Have a fish tank? Cover it and switch off the pump during interior work. Tell us about crawling babies, dogs that chew, and anyone pregnant or chemically sensitive so your technician can plan placements around them.'),
      h('What we do on the day'),
      p('Inspection of the areas you flagged plus the usual suspects (under sinks, behind appliances, door thresholds, window tracks, the garage door seal), then targeted placements: gel or granular baits for ants and roaches where they travel, crack-and-crevice treatment along baseboards and cabinet seams, dust in wall voids where labeled, and an exterior check of how the pests are getting in. Most interior problems have an exterior source, and your technician will point it out.'),
      h('What to expect after'),
      list([
        'A brief uptick in sightings right after treatment is common. Pests get flushed out of hiding as the product reaches them. Activity should fall off over the following days to a couple of weeks depending on the pest.',
        'Ants specifically: with bait, you may see MORE ants for a few days as they feed on it and carry it to the colony. Do not spray them. That is the bait doing its job.',
        'Light cleaning is fine once surfaces are dry, but skip wiping baseboards, hinges and the treated cracks and corners for a couple of weeks. The residual keeps working there long after the visit.',
        `Homeowner fixes that make interior treatment last: a tight [door sweep](${L.doorSweep}) on exterior doors, caulk around pipe penetrations under sinks, screens repaired, and mulch pulled back from the slab.`,
      ]),
      faq([
        { label: 'Do I need to leave the house?', value: 'Usually just the rooms being treated, until surfaces are dry and your technician confirms they are ready. Your technician will tell you if this particular service needs more than that.' },
        { label: 'Do you need to come inside, or is outside enough?', value: 'It depends on the pest. Exterior defense stops most invaders, but pests living indoors (like German roaches or pharaoh ants) need interior treatment. Your technician treats where the problem actually is.' },
        { label: 'Do I need to be home?', value: 'For interior work, yes. Someone needs to let us in. Exterior-only visits do not need you home as long as gates are open and pets are in.' },
        { label: 'What if it is ghost ants or sugar ants?', value: 'Tiny pale ants trailing to the sink or a sweet spill are ghost ants, the most common indoor ant in this area. They respond to gel bait, and spraying them splits the colony into several. Leave them alone until we arrive and show your technician the trail.' },
      ]),
      callout('If activity is concentrated in a specific room, reply with that location so we can prioritize it during the visit.'),
      REPLY_LINE,
      CTA,
      SIGNATURE,
    ],
  },
];

async function publishVersion(knex, t) {
  const template = await knex('email_templates').where({ template_key: t.key }).first();
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
    subject: t.subject || prior?.subject || null,
    preview_text: t.preview || prior?.preview_text || null,
    blocks: json(t.blocks),
    text_body: null,
    validation_snapshot: json({
      ok: true,
      source: MIGRATION_MARKER,
      referenced_variables: [],
      disallowed_variables: [],
      missing_required_in_template: [],
    }),
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

exports.TEMPLATES = TEMPLATES;
exports.MIGRATION_MARKER = MIGRATION_MARKER;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const t of TEMPLATES) {
    await publishVersion(knex, t);
  }
};

exports.down = async function down(knex) {
  // Re-activate each template's prior version; the v3 version is archived
  // (versions are retained, never deleted). Only a version THIS migration
  // created (snapshot marker) is rolled back — an admin publication after
  // the migration is left alone.
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const t of TEMPLATES) {
    const template = await knex('email_templates').where({ template_key: t.key }).first();
    if (!template?.active_version_id) continue;
    const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
    if (!current || snapshotSource(current) !== MIGRATION_MARKER) continue;
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
};
