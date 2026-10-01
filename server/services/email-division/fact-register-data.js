'use strict';

/**
 * Email division fact register — the DATA.
 *
 * The facts customer-facing email copy is allowed to state, each quoted from
 * a source that was opened and read on the verification date. This file is
 * the register's source of truth; fact-register.js syncs it into the
 * knowledge_base table (category 'facts', source 'email-division-fact-
 * register') so the admin knowledge base shows the same rows the writer is
 * prompted with. Editing a fact is an ordinary reviewable code change here,
 * never a migration: a seed migration freezes the moment it is pushed, and
 * facts get corrected.
 *
 * Born from the September 2026 Pest Insider draft asserting a "second
 * subterranean termite swarm after storms", which no University of Florida
 * source supports. The rule this register enforces: a statement in customer
 * email quotes a primary source (a UF/IFAS publication, a product label, a
 * manufacturer, a county or district notice, CDC), or it is Waves' own
 * measured data, or it is not said.
 *
 * Per fact:
 * - `quote`   — text taken verbatim from the page(s) at `sourceUrls`, in
 *               double quotes; the only thing a writer may restate. Every
 *               number, month and attribution `content` uses appears here.
 * - `content` — the plain-words restatement, and what the source does NOT
 *               state, so a writer cannot fill a gap with a number.
 * - `derived` — true for an entry that states what the sources do not say
 *               (a negative fact), built from quotes above.
 * - `expiresOn` — ISO date after which the fact is retired (a notice with
 *               an end date). Optional.
 *
 * No retailer page is a source: retailer copy carries efficacy timelines the
 * labels do not.
 */

const SOURCE = 'email-division-fact-register';
const VERIFIED_ON = '2026-09-28';

const FACTS = [
  {
    slug: 'fact-native-subterranean-termite-flight-season',
    title: 'Native subterranean termites: flight season by species (Florida)',
    tags: ['termites', 'subterranean-termites', 'swarm-season'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN369'],
    quote: 'Reticulitermes flavipes: "flights start in early January and end in April". Reticulitermes virginicus: flights "occur between early February and late May". "Dispersal by Reticulitermes flavipes and Reticulitermes virginicus occurs during warm, sunny, and windless early afternoons usually after rain, while Reticulitermes hageni alates disperse in the evening." Reticulitermes hageni: "alate flights begin in early December and last until early February". "For a given species, populations located in southern Florida may fly earlier within the season than populations located in Northern Florida."',
    content: 'UF/IFAS gives one flight season for each native subterranean termite. Reticulitermes flavipes flies from early January to April and Reticulitermes virginicus from early February to late May, both on warm, sunny, windless early afternoons, usually after rain. Reticulitermes hageni flies in the evening from early December to early February. For a given species, populations in southern Florida may fly earlier within the season than those in northern Florida.',
  },
  {
    slug: 'fact-asian-formosan-termite-swarm-season',
    title: 'Asian and Formosan subterranean termites: when swarming starts (Florida)',
    tags: ['termites', 'subterranean-termites', 'swarm-season', 'invasive-species'],
    sourceUrls: ['https://blogs.ifas.ufl.edu/news/2022/03/30/termite-season-uf-ifas-scientist-answers-common-questions-corrects-misconceptions/'],
    quote: '"In March, the Asian subterranean termites produce their winged form and initiate their large swarming events, which can be visible during sunset on warm days. In late April, the Formosan subterranean termite initiates their swarming events." "“From March to June, termite activity is the most visible, which means it is a good time to pay attention and have a termite checkup,” said Thomas Chouvenc, an assistant professor of urban entomology at the UF/IFAS Fort Lauderdale Research and Education Center."',
    content: 'Per Thomas Chouvenc, assistant professor of urban entomology at the UF/IFAS Fort Lauderdale Research and Education Center, Asian subterranean termites begin their large swarms in March, visible around sunset on warm days, and Formosan subterranean termites begin in late April. Termite activity is most visible from March to June. The article does not state an end month for either species.',
  },
  {
    slug: 'fact-west-indian-drywood-termite-dispersal',
    title: 'West Indian drywood termite: dispersal flights and pellets',
    tags: ['termites', 'drywood-termites', 'swarm-season'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN236'],
    quote: '"These alates leave the colony on multiple mating flights from April to June, though flights are possible any time of the year." "Drywood termite pellets are hexagonal in cross section (Figure 14) and can be a variety of colors, including cream, red, or black". "Drywood termites differ from subterranean termites in that the colony lives entirely within wood."',
    content: 'West Indian drywood termites (Cryptotermes brevis) make multiple mating flights from April to June, and a flight is possible at any time of year. Their fecal pellets are hexagonal in cross section and can be cream, red or black. Unlike subterranean termites, the colony lives entirely within wood.',
  },
  {
    slug: 'fact-western-drywood-termite-flight-season',
    title: 'Western drywood termite: recorded flights in Florida',
    tags: ['termites', 'drywood-termites', 'swarm-season'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN526'],
    quote: '"In Florida, dispersal flights (all recorded indoors and during daytime) have occurred in all months of the year except December with 50% of the flights occurring in September, October, or November."',
    content: 'Recorded Florida flights of the western drywood termite (Incisitermes minor) were all indoors and in daytime, in every month except December, with half of them in September, October or November.',
  },
  {
    slug: 'fact-no-storm-triggered-second-termite-swarm',
    title: 'UF describes no second or storm-triggered swarm for native subterranean termites',
    tags: ['termites', 'subterranean-termites', 'swarm-season', 'negative-fact'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN369', 'https://ask.ifas.ufl.edu/publication/IN526'],
    quote: 'IN369 — Reticulitermes flavipes: "flights start in early January and end in April". Reticulitermes virginicus: flights "occur between early February and late May". Reticulitermes hageni: "alate flights begin in early December and last until early February". IN526 — western drywood termite: "In Florida, dispersal flights (all recorded indoors and during daytime) have occurred in all months of the year except December with 50% of the flights occurring in September, October, or November."',
    content: 'UF/IFAS gives each native subterranean termite one flight season: early December to early February for Reticulitermes hageni, early January to April for Reticulitermes flavipes, early February to late May for Reticulitermes virginicus. It describes no second flight later in the year for any of them and none set off by summer storms or hurricanes, so copy must not describe a repeat swarm, or a storm-triggered one, for these species. UF separately records western drywood termite flights in every month but December, half of them in September, October or November; this entry makes no claim about which termite a reader has seen.',
    derived: true,
  },
  {
    slug: 'fact-southern-chinch-bug',
    title: 'Southern chinch bug: season, where injury starts, the flotation test',
    tags: ['lawn', 'chinch-bugs', 'st-augustinegrass'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN383'],
    quote: '"The southern chinch bug thrives during the warm, damp summer months, and infestations peak in early July." "Injury typically occurs first in water-stressed areas along the edges of the lawn or where the grass is growing in full sunlight." "To test for chinch bug presence, use the flotation method: remove the bottom of a metal coffee can and insert the can into the soil surrounding the discolored grass. Use a knife or shovel to dig the edges of the can down 3 inches into the soil. Fill the can with water continuously for five minutes. The chinch bugs trapped in the can will float to the top of the water." "Yellow or brownish spots of St. Augustinegrass do not necessarily denote a chinch bug infestation." "Dehydration, root rot and other diseases, nematodes and various insect infestations may have similar symptoms."',
    content: 'Southern chinch bugs thrive in the warm, damp summer months and infestations peak in early July. Injury typically shows first in water-stressed areas along lawn edges or in full sun. The flotation test: remove the bottom of a metal coffee can, insert it into the soil around the discolored grass, dig its edges 3 inches down, keep it filled with water for five minutes, and any chinch bugs float to the top. Yellow or brown spots alone do not prove chinch bugs: dehydration, root rot and other diseases, nematodes and other insects can look the same.',
  },
  {
    slug: 'fact-st-augustinegrass-care',
    title: 'St. Augustinegrass: mowing height, irrigation amount, gray leaf spot, chinch bug injury',
    tags: ['lawn', 'st-augustinegrass', 'mowing', 'irrigation', 'gray-leaf-spot', 'chinch-bugs'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/LH010'],
    quote: '"Standard cultivars should be mowed at 3.5–4 inches and dwarf cultivars should be mowed at 2.5 inches." "Dwarf varieties have a lower growth habit and should be mowed at 2–2.5 inches for optimum health." "Irrigation is needed when leaf blades begin to fold up, wilt, or turn a blue-gray color, or when footprints remain visible after walking on the grass". "Apply ½–¾ inch of water per application. This applies water to roughly the top 8 inches of soil where the majority of the roots are." "Gray leaf spot occurs during the summer rainy season and is primarily a problem on new growth." Chinch bugs: "Injured areas are usually first noticed as the weather begins to warm in areas along sidewalks, adjacent to buildings, and in other water-stressed areas where the grass is in full sun." "Chinch bugs will float to the water surface within 5 minutes."',
    content: 'Mow standard St. Augustinegrass cultivars at 3.5 to 4 inches; UF gives dwarf cultivars 2 to 2.5 inches (one passage says 2.5). Water when leaf blades begin to fold up, wilt or turn blue-gray, or when footprints stay visible after walking on the grass, and apply one half to three quarters of an inch per application, which wets roughly the top 8 inches of soil. Gray leaf spot occurs during the summer rainy season and is mainly a problem on new growth. Chinch bug injury is usually first noticed as the weather warms, along sidewalks, next to buildings and in other water-stressed areas in full sun; in a coffee-can flotation test the bugs float to the surface within 5 minutes.',
  },
  {
    slug: 'fact-large-patch',
    title: 'Large patch: November through May, below 80°F; normally not observed in summer',
    tags: ['lawn', 'large-patch', 'brown-patch', 'fungus'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/LH044', 'https://ask.ifas.ufl.edu/publication/LH010'],
    quote: 'LH044 — "This disease is most likely to be observed from November through May when temperatures are below 80°F. It is normally not observed in the summer months." "Infection is triggered by rainfall, excessive irrigation, or extended periods of high humidity resulting in the leaves being continuously wet for 48 hours or more." "This disease usually begins as small patches (about 1 ft in diameter) that turn yellow and then reddish brown, brown, or straw colored as the leaves start to die." "It is not uncommon to see rings of yellow or brown turf with apparently healthy turf in the center." "Excessive nitrogen application during potential disease development periods should be avoided." On a different disease: "R. zeae and R. oryzae cause the disease Rhizoctonia leaf and sheath spot. This disease occurs during the summer when the temperatures are above 80°F." "This disease must be confirmed by a plant disease clinic prior to any control efforts as the controls are very different from large patch." LH010 — "Large patch occurs in warm, humid weather and is encouraged by excessive nitrogen. It is generally most noticeable during the spring and fall months."',
    content: 'Large patch (Rhizoctonia solani) is most likely from November through May when temperatures are below 80°F, is normally not observed in summer, and is generally most noticeable in spring and fall. Infection is triggered by rainfall, excessive irrigation or long periods of high humidity that keep leaves wet for 48 hours or more; UF advises avoiding excessive nitrogen during periods when the disease can develop. It usually begins as small patches about 1 foot across that turn yellow, then reddish brown, brown or straw colored; rings of yellow or brown turf with apparently healthy turf in the center are not uncommon. A patch that appears in summer above 80°F may be Rhizoctonia leaf and sheath spot, which UF says is different from large patch and must be confirmed by a plant disease clinic because the controls differ. Copy must not attach the name "large patch" to a warm-season patch.',
  },
  {
    slug: 'fact-fire-ant-mating-flights',
    title: 'Red imported fire ant: mating flights',
    tags: ['ants', 'fire-ants', 'mating-flights'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN352'],
    quote: '"Six to eight mating flights consisting of up to 4,500 alates each occur between the spring and fall". "Mating flights usually occur midday on a warm (>74°F/24°C), sunny day following rain". After mating the queen lands: "Often this spot is under rocks, leaves or in a small crack or crevice, such as at the edge of a sidewalk, driveway, or street."',
    content: 'Red imported fire ant colonies make six to eight mating flights of up to 4,500 winged ants each between spring and fall, usually at midday on a warm (above 74°F), sunny day following rain. After mating, the queen often lands under rocks or leaves, or in a small crack or crevice such as the edge of a sidewalk, driveway or street. The source says nothing about treatments, so copy must not tie new mounds to whether a treatment worked.',
  },
  {
    slug: 'fact-lovebug-flights',
    title: 'Lovebugs: two four-week flights a year (April–May, August–September); windshields and paint',
    tags: ['lovebugs', 'engagement', 'seasonal'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN204'],
    quote: '"Each of the two Plecia nearctica generations in Florida lasts about four weeks in April–May and August–September." "In addition to the two large emergences, this species has been collected in Florida every month of the year except November". "in south Florida most of the adults seem to appear in April during the first yearly flight." "The adult flies are a nuisance to motorists because the flies are attracted to highways and spatter on the hood and windshield of vehicles." "They can also reduce visibility and etch automobile paint as the body fluids are slightly acidic." "If the egg mass and body parts are allowed to remain on the vehicle for several days, bacterial action increases the acidity and etches the paint." "The larvae develop under and feed on dead, partially decayed plant material, particularly in moist to damp areas".',
    content: 'Lovebugs (Plecia nearctica) have two flights a year in Florida, each lasting about four weeks: April–May and August–September; in south Florida most adults of the first flight appear in April, and the species has been collected in every month except November. Adults are a nuisance to drivers because they are attracted to highways and spatter on hoods and windshields; their body fluids are slightly acidic and can etch paint, more so when left on the vehicle for several days. Larvae feed on dead, partially decayed plant material in moist to damp areas. UF describes no treatment or control for lovebugs, so copy must not offer or imply one.',
  },
  {
    slug: 'fact-american-cockroach-indoors',
    title: 'American cockroach: why it comes indoors',
    tags: ['cockroaches', 'american-cockroach'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN298'],
    quote: 'American cockroaches "wander indoors to search for food and water or to avoid extreme weather conditions."',
    content: 'UF says American cockroaches wander indoors to search for food and water or to avoid extreme weather conditions. The UF publication does not use the nickname "palmetto bug"; copy may use that word as the local name but must not attribute it to the source.',
  },
  {
    slug: 'fact-ghost-ants-florida',
    title: 'Ghost ants: how common, where they nest, how colonies spread',
    tags: ['ants', 'ghost-ants'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN532'],
    quote: '"eight species of ants were identified as key pests in Florida. Of these, the most common were the red imported fire ant, Solenopsis invicta Buren, the ghost ant, Tapinoma melanocephalum, (Fabricius); and the crazy ant, Paratrechina longicornis (Latreille). Each species comprising 14% of the samples submitted". "Indoors, the ant colonizes wall void or spaces between cabinetry and baseboards. It will also nest in potted plants." "New colonies are probably formed by budding. This occurs when one or more reproductive females, accompanied by several workers and possibly some brood (larvae and pupae) leave an established colony for a new nesting site." "Reduce moisture sources, including condensation and leaks."',
    content: 'In the Florida survey UF cites, the ghost ant was one of the three most common of eight key pest ant species, each of the three making up 14% of the samples submitted. Indoors they colonize wall voids and the spaces between cabinetry and baseboards, and nest in potted plants. New colonies are probably formed by budding, when one or more reproductive females leave with workers, and possibly brood, for a new nesting site. UF recommends reducing moisture sources, including condensation and leaks.',
  },
  {
    slug: 'fact-roof-rats-access',
    title: 'Roof rats: how they reach a house and what to prune',
    tags: ['rodents', 'roof-rats', 'exclusion'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN1397'],
    quote: '"Rats, such as the roof rat (Rattus rattus) can jump three feet in the air vertically and more than four feet horizontally." "Prune any overhanging or touching limbs away from your house." "Prune dead leaves from palm trees that are close to buildings." Palms with many dead leaves "naturally develop a “skirt” of hanging leaves. This creates an excellent habitat for rodents". "Plants installed less than two feet from your house at maturity are too close and provide harborage for nuisance wildlife."',
    content: 'UF says roof rats can jump three feet in the air vertically and more than four feet horizontally. UF advises pruning overhanging or touching limbs away from the house and pruning dead leaves from palms close to buildings, since a skirt of hanging dead palm leaves is excellent rodent habitat. Plants that will sit less than two feet from the house at maturity are too close. This source states no season or months of peak activity, so copy must not state one.',
  },
  {
    slug: 'fact-container-mosquitoes',
    title: 'Aedes mosquitoes: containers and egg-to-adult time',
    tags: ['mosquitoes', 'aedes'],
    sourceUrls: ['https://www.cdc.gov/mosquitoes/about/life-cycle-of-aedes-mosquitoes.html', 'https://ask.ifas.ufl.edu/publication/IN792'],
    quote: 'CDC — "A mosquito egg takes 7–10 days to develop into an adult mosquito." "Adult female mosquitoes lay eggs on the inner walls of containers with water, above the waterline." "Eggs can survive drying out for up to 8 months." "Mosquitoes only need a small amount of water to lay eggs." UF/IFAS IN792 — "Yellow fever mosquitoes are container-inhabiting mosquitoes; often breeding in unused flowerpots, spare tires, untreated swimming pools, and drainage ditches."',
    content: 'Per CDC, an Aedes mosquito egg takes 7 to 10 days to develop into an adult, females lay eggs on the inner walls of containers with water above the waterline, eggs can survive drying out for up to 8 months, and only a small amount of water is needed. UF/IFAS describes the yellow fever mosquito as container-inhabiting, often breeding in unused flowerpots, spare tires, untreated swimming pools and drainage ditches.',
  },
  {
    slug: 'fact-fertilizer-ordinance-sarasota-county',
    title: 'Fertilizer codes in Sarasota County, by jurisdiction',
    tags: ['lawn', 'fertilizer', 'ordinance', 'sarasota'],
    sourceUrls: ['https://sfyl.ifas.ufl.edu/media/sfylifasufledu/sarasota/documents/pdf/hortres/keydocs/2025_HortRes_brochureSacoFertilizerCodes_FINAL_ADA.pdf'],
    quote: 'Sarasota County (unincorporated), City of Sarasota, City of Venice: "From June 1 through Sept. 30, no fertilizer containing nitrogen or phosphorus shall be applied to turf or landscape plants in residential areas." City of North Port: "From April 1 through Sept. 30". Town of Longboat Key: "From June 1 through Sept. 30". The brochure\'s table repeats the same nitrogen rule in the column of every jurisdiction: nitrogen fertilizer must contain "at least 50 percent slowly available or slow-release nitrogen (SRN)" and "Shall not exceed 1 pound per 1,000 square feet at each application to turf or landscape plants, nor exceed 4 pounds" per year. Sarasota County, Sarasota, Venice: "Fertilizer may not be applied within 10 feet of any water body or wetland." Longboat Key: "Fertilizer shall not be applied within 3 feet — or within 10 feet if applied by a broadcast spreader without deflector shields — of any pond, stormwater drain, ditch, conveyance".',
    content: 'In unincorporated Sarasota County, the City of Sarasota and the City of Venice, no fertilizer containing nitrogen or phosphorus may be applied to turf or landscape plants in residential areas from June 1 through September 30; the Town of Longboat Key uses the same dates, and the City of North Port a longer season, April 1 through September 30. Every one of these jurisdictions requires nitrogen fertilizer to be at least 50 percent slow-release, with no more than 1 pound of nitrogen per 1,000 square feet per application and 4 pounds per year. Sarasota County, Sarasota and Venice allow no fertilizer within 10 feet of any water body or wetland; Longboat Key keeps a 3-foot zone from ponds, stormwater drains, ditches and conveyances, or 10 feet for a broadcast spreader without deflector shields. The brochure states no setback for North Port, so copy must not state one.',
  },
  {
    slug: 'fact-fertilizer-ban-manatee-county',
    title: 'Manatee County fertilizer ordinance: June 1 through September 30, slow-release nitrogen, phosphorus only on a soil test',
    tags: ['lawn', 'fertilizer', 'ordinance', 'manatee'],
    sourceUrls: ['https://www.mymanatee.org/services-and-amenities/service-listing/service-details/find-information-for-landscape-maintenance-professionals'],
    quote: '"The Manatee County Fertilizer Ordinance restricts the use of the following products on residential urban landscapes: Granular fertilizer products with less than 50% slow-release nitrogen. Nitrogen or phosphorus containing products between June 1 and September 30. Phosphorus applications without a soil test indicating a phosphorous deficiency." "As of June 1, 2012 all commercial and institutional (e.g. school, government employees) fertilizer applicators must be individually certified to apply fertilizers in Manatee County."',
    content: 'Manatee County\'s fertilizer ordinance restricts, on residential urban landscapes, granular fertilizer with less than 50% slow-release nitrogen, any nitrogen- or phosphorus-containing product between June 1 and September 30, and phosphorus unless a soil test shows a deficiency. Since June 1, 2012 every commercial and institutional fertilizer applicator in the county must be individually certified. The county page states no setback distance from water and no pounds-per-1,000-square-feet limit, so copy must not state either for Manatee County.',
  },
  {
    slug: 'fact-swfwmd-modified-phase-iii-water-shortage',
    title: 'SWFWMD Modified Phase III "Extreme" Water Shortage: one watering day a week through Oct. 1, 2026',
    tags: ['lawn', 'irrigation', 'water-restrictions', 'swfwmd'],
    sourceUrls: ['https://www.swfwmd.state.fl.us/the-newsroom/2026/district-extends-modified-phase-iii-water-shortage'],
    quote: 'News release, June 23, 2026: "All residents remain under one-day-per-week watering restrictions with strict watering hours through Oct. 1, 2026". "The restrictions apply to all of Citrus, DeSoto, Hardee, Hernando, Hillsborough, Manatee, Pasco, Pinellas, Polk, Sarasota and Sumter counties". "If your address (house number) ends in... 0 or 1, water only on Monday ...2 or 3, water only on Tuesday ...4 or 5, water only on Wednesday ...6 or 7, water only on Thursday ...8 or 9, water only on Friday". "Unless your city or county already has stricter hours in effect, watering hours remain reduced to 12:01 a.m. to 4 a.m. or 8 p.m. to 11:59 p.m. Properties less than one acre in size may only use one of these windows." "properties one acre or larger may only water before 4 a.m. and after 8 p.m." "Low-volume watering of plants and shrubs (micro-irrigation, soaker hoses, hand watering) is allowed any day but is limited to before 8 a.m. or after 6 p.m."',
    content: 'The Southwest Florida Water Management District Modified Phase III "Extreme" Water Shortage covers all of Manatee and Sarasota counties among others and runs through October 1, 2026. Lawn watering is limited to one day per week by the last digit of the house number: 0 or 1 Monday, 2 or 3 Tuesday, 4 or 5 Wednesday, 6 or 7 Thursday, 8 or 9 Friday. Hours are 12:01 a.m. to 4 a.m. or 8 p.m. to 11:59 p.m.; properties under one acre may use only one of the two windows, and properties of one acre or more may water before 4 a.m. and after 8 p.m. Low-volume watering of plants and shrubs (micro-irrigation, soaker hoses, hand watering) is allowed any day before 8 a.m. or after 6 p.m. Cities and counties may have stricter hours.',
    expiresOn: '2026-10-02',
  },
  {
    slug: 'fact-taurus-sc-non-repellent',
    title: 'Taurus SC (fipronil 9.1%): non-repellent, spread through the colony',
    tags: ['products', 'taurus-sc', 'fipronil', 'ants', 'cockroaches'],
    sourceUrls: ['https://www.controlsolutionsinc.com/csi-pest/products/taurus-sc'],
    quote: '"9.1% Fipronil". "Taurus SC is a non-repellent insecticide that is undetectable to target pests, allowing them to touch, ingest and spread the insecticide throughout the entire colony".',
    content: 'Per the manufacturer, Taurus SC (9.1% fipronil) is a non-repellent insecticide that target pests cannot detect, which lets them touch it, ingest it and spread it throughout the colony. The manufacturer states no time to control, no speed of action and no length of visible activity, so copy must not state a number of days or weeks for any of them, and must not attribute to the manufacturer any statement about how long pests stay visible.',
  },
  {
    slug: 'fact-bifenthrin-talak-label',
    title: 'Bifenthrin (Talak 7.9% F) label: rain, re-entry, watering, bees — and no stated residual',
    tags: ['products', 'bifenthrin', 'talak', 'label'],
    sourceUrls: ['https://atticusllc.com/wp-content/uploads/2020/08/Talak-7.9-F-Specimen.pdf'],
    quote: '"Bifenthrin* ... 7.9%"; "EPA Reg. No.: 91234-145". "Applying this product in calm weather when rain is not predicted for the next 24 hours will help to ensure that wind or rain does not blow or wash pesticide off the treatment area." "Do not make applications during rain." "Do not permit humans or pets to contact treated surfaces until the spray has dried." Lawns: "For best results, postpone watering (irrigation) or mowing for 24 hours after application." "This product is highly toxic to bees exposed to direct treatment or residues on blooming crops or weeds."',
    content: 'Talak 7.9% F (bifenthrin 7.9%, EPA Reg. No. 91234-145) is the bifenthrin Waves applies. Its label asks for application in calm weather when rain is not predicted for the next 24 hours, prohibits application during rain, says humans and pets must not contact treated surfaces until the spray has dried, and for lawns says to postpone watering or mowing for 24 hours after application. It says the product is highly toxic to bees exposed to direct treatment or to residues on blooming crops or weeds, so copy must never make a bee-safety claim for it. The label states no residual duration for any pest, so copy must not state a number of days, weeks or months of residual control.',
  },
  {
    slug: 'fact-gentrol-igr-hydroprene',
    title: 'Gentrol IGR (hydroprene): exposed roaches become adults that cannot reproduce',
    tags: ['products', 'gentrol', 'igr', 'cockroaches'],
    sourceUrls: [
      'https://www.zoecon.com/-/media/project/oneweb/zoecon/files/product-labels/specimen/gentrol-igr-concentrate-specimen-label.pdf',
      'https://www.zoecon.com/all-products/gentrol/gentrol-igr-concentrate',
    ],
    quote: 'Label — "GENTROL®, an Insect Growth Regulator (IGR), is a synthetic, juvenile hormone “look-alike” which disrupts the normal growth development of cockroaches, drain flies, fruit flies, bedbugs, and stored product pests". "Cockroaches and bedbugs exposed to the GENTROL® IGR will become adults incapable of reproducing." Front panel: "CONTINUOUS PROTECTION FOR 4 MONTHS". Manufacturer page — hydroprene "effectively breaks the insects’ life cycles and offers 120 days of control".',
    content: 'Gentrol IGR Concentrate (hydroprene) is an insect growth regulator: per the label, a synthetic juvenile hormone look-alike that disrupts the normal growth and development of cockroaches, drain flies, fruit flies, bedbugs and stored product pests, and cockroaches and bedbugs exposed to it become adults incapable of reproducing. The label states continuous protection for 4 months and the manufacturer page states 120 days of control. Neither source states how long until results are visible, and neither says it makes already-mature adults sterile, so copy must not state a number of days to results or claim it sterilises adults.',
  },
  {
    slug: 'fact-flea-vacuuming-after-treatment',
    title: 'Fleas: why vacuuming continues after treatment',
    tags: ['fleas', 'vacuuming', 'prep'],
    sourceUrls: ['https://entomology.mgcafe.uky.edu/ef602'],
    quote: 'ENTFACT-602, "By Michael F. Potter, Extension Entomologist University of Kentucky College of Agriculture": "Pupae remain inside the cocoon for 1 to 4 weeks." "The cocoon is also impervious to insecticides—another reason some fleas may persist for an extended period, even after the pet and home are treated." "Even after treatment, expect to see some fleas for a few weeks or longer." "Instead of retreating immediately, continue to vacuum. As mentioned earlier, vacuuming stimulates insecticide-resistant flea pupae/cocoons to hatch, bringing emerging adults into contact with the treatment sooner." "If adult fleas continue to be seen beyond 4 weeks, retreatment of the premises and/or pets may be necessary."',
    content: 'Per University of Kentucky Extension entomologist Michael F. Potter (ENTFACT-602), pupae stay in the cocoon for 1 to 4 weeks and the cocoon is impervious to insecticides, so some fleas are still seen for a few weeks or longer after treatment. Continuing to vacuum stimulates pupae to hatch and brings the emerging adults into contact with the treatment sooner. If adult fleas are still seen beyond 4 weeks, retreatment may be necessary. This guidance is specific to fleas; it does not apply to ant or cockroach treatments. The source gives no fixed number of days of vacuuming.',
  },
];

module.exports = { FACTS, SOURCE, VERIFIED_ON };
