'use strict';

/**
 * Email division fact register — the facts customer-facing email copy is
 * allowed to state, each quoted from a source that was opened and read on
 * the verification date.
 *
 * Born from the September 2026 Pest Insider draft asserting a "second
 * subterranean termite swarm after storms", which no University of Florida
 * source supports. The rule this register enforces: a statement in customer
 * email quotes a primary source (a UF/IFAS publication, a product label, a
 * manufacturer, a county or district notice, CDC), or it is Waves' own
 * measured data, or it is not said.
 *
 * Every `quote` below is text taken from the page at `sourceUrl` (first of
 * `sourceUrls`). `content` restates it in plain words and says what the
 * source does NOT state, so a writer cannot fill the gap with a number.
 * No retailer page is a source.
 *
 * category 'facts', source 'email-division-fact-register', status 'active',
 * confidence 'high'. fact-register.js reads these back through the ordinary
 * knowledge_base 'facts' category.
 *
 * Idempotent by slug and insert-only: a slug already present (including one
 * a person has edited) is left untouched. The audit row is written in this
 * migration's own transaction (trx + critical), so a fact never commits
 * without its audit row. down() is a documented no-op for the same reason
 * up() never overwrites: a person may have edited a row since.
 */
const STAMP = '20260928100000_email_division_fact_register';
const SOURCE = 'email-division-fact-register';
const VERIFIED_ON = '2026-09-28';
const ACTION = 'knowledge_base.fact_seeded';

const FACTS = [
  {
    slug: 'fact-native-subterranean-termite-flight-season',
    title: 'Native subterranean termites: flight season by species (Florida)',
    tags: ['termites', 'subterranean-termites', 'swarm-season'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN369'],
    quote: 'Reticulitermes flavipes: "flights start in early January and end in April"; Reticulitermes virginicus flights "occur between early February and late May"; both disperse "during warm, sunny, and windless early afternoons usually after rain". Reticulitermes hageni: "alate flights begin in early December and last until early February", "in the evening".',
    content: 'UF/IFAS gives one flight season for each native subterranean termite. Reticulitermes flavipes flies from early January to April and Reticulitermes virginicus from early February to late May, both on warm, sunny, windless early afternoons, usually after rain. Reticulitermes hageni flies in the evening from early December to early February. UF notes that populations in southern Florida may fly earlier in the season than those in northern Florida.',
  },
  {
    slug: 'fact-asian-formosan-termite-swarm-season',
    title: 'Asian and Formosan subterranean termites: when swarming starts (Florida)',
    tags: ['termites', 'subterranean-termites', 'swarm-season', 'invasive-species'],
    sourceUrls: ['https://blogs.ifas.ufl.edu/news/2022/03/30/termite-season-uf-ifas-scientist-answers-common-questions-corrects-misconceptions/'],
    quote: '"In March, the Asian subterranean termites produce their winged form and initiate their large swarming events, which can be visible during sunset on warm days. In late April, the Formosan subterranean termite initiates their swarming events." "From March to June, termite activity is the most visible."',
    content: 'Per UF/IFAS urban entomologist Thomas Chouvenc, Asian subterranean termites begin their large swarms in March, visible around sunset on warm days, and Formosan subterranean termites begin in late April. Termite activity is most visible from March to June. The article does not state an end month for either species.',
  },
  {
    slug: 'fact-west-indian-drywood-termite-dispersal',
    title: 'West Indian drywood termite: dispersal flights and pellets',
    tags: ['termites', 'drywood-termites', 'swarm-season'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN236'],
    quote: '"These alates leave the colony on multiple mating flights from April to June, though flights are possible any time of the year." "Drywood termite pellets are hexagonal in cross section".',
    content: 'West Indian drywood termites (Cryptotermes brevis) make multiple mating flights from April to June, and a flight is possible at any time of year. Their fecal pellets are hexagonal in cross section and can be cream, red or black. The colony lives entirely within wood.',
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
    title: 'No UF source describes a second, storm-triggered subterranean termite swarm',
    tags: ['termites', 'subterranean-termites', 'swarm-season', 'negative-fact'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN369'],
    quote: 'Reticulitermes flavipes: "flights start in early January and end in April". Reticulitermes virginicus flights "occur between early February and late May".',
    content: 'UF/IFAS gives each native subterranean termite a single flight season that ends by late May. It describes no second swarm later in the year and none triggered by summer storms or hurricanes. Copy must not describe a repeat flight, or one set off by summer storms, for these species. Termites seen flying in late summer or fall in Florida are more likely drywood termites, whose flights UF records in those months.',
    derived: true,
  },
  {
    slug: 'fact-southern-chinch-bug',
    title: 'Southern chinch bug: season, where injury starts, the flotation test',
    tags: ['lawn', 'chinch-bugs', 'st-augustinegrass'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN383'],
    quote: '"The southern chinch bug thrives during the warm, damp summer months, and infestations peak in early July." "Injury typically occurs first in water-stressed areas along the edges of the lawn or where the grass is growing in full sunlight." "Yellow or brownish spots of St. Augustinegrass do not necessarily denote a chinch bug infestation."',
    content: 'Southern chinch bugs thrive in the warm, damp summer months and infestations peak in early July. Injury shows first in water-stressed areas along lawn edges or in full sun. The flotation test: remove the bottom of a metal coffee can, push the can 3 inches into the soil at the edge of the discolored grass, keep it filled with water for five minutes, and chinch bugs float to the top. Yellow or brown spots alone do not prove chinch bugs: dehydration, root rot and other diseases, nematodes and other insects can look the same.',
  },
  {
    slug: 'fact-st-augustinegrass-care',
    title: 'St. Augustinegrass: mowing height, irrigation amount, gray leaf spot',
    tags: ['lawn', 'st-augustinegrass', 'mowing', 'irrigation', 'gray-leaf-spot'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/LH010'],
    quote: '"Standard St. Augustinegrass cultivars...should be maintained at a height of 3.5–4 inches." Dwarf varieties "should be mowed at 2–2.5 inches for optimum health." "Apply ½–¾ inch of water per application." "Gray leaf spot occurs during the summer rainy season and is primarily a problem on new growth."',
    content: 'Mow standard St. Augustinegrass cultivars at 3.5 to 4 inches and dwarf cultivars at 2 to 2.5 inches. Apply one half to three quarters of an inch of water per application, and water when leaf blades begin to fold up, wilt, or turn a blue-gray color, or when footprints remain visible after walking. Gray leaf spot occurs during the summer rainy season and is mainly a problem on new growth. Chinch bug injury is usually first noticed along sidewalks, next to buildings and in other water-stressed areas in full sun.',
  },
  {
    slug: 'fact-large-patch',
    title: 'Large patch: November through May, below 80°F, not a summer disease',
    tags: ['lawn', 'large-patch', 'brown-patch', 'fungus'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/LH044', 'https://ask.ifas.ufl.edu/publication/LH010'],
    quote: '"This disease is most likely to be observed from November through May when temperatures are below 80°F. It is normally not observed in the summer months." "Infection is triggered by rainfall, excessive irrigation, or extended periods of high humidity resulting in the leaves being continuously wet for 48 hours or more."',
    content: 'Large patch (Rhizoctonia solani) is most likely from November through May when temperatures are below 80°F, and is normally not observed in summer. Infection is triggered by rainfall, excessive irrigation or long periods of high humidity that keep leaves wet for 48 hours or more. UF advises avoiding excessive nitrogen during periods when the disease can develop. It usually begins as patches about 1 foot across that turn yellow, then reddish brown, brown or straw colored, and can expand to several feet; rings of yellow or brown turf with healthy turf in the center are common.',
  },
  {
    slug: 'fact-fire-ant-mating-flights',
    title: 'Red imported fire ant: mating flights',
    tags: ['ants', 'fire-ants', 'mating-flights'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN352'],
    quote: '"Six to eight mating flights consisting of up to 4,500 alates each" occur "between the spring and fall", "on a warm (>74°F/24°C), sunny day" "following rain", and "usually occur midday".',
    content: 'Red imported fire ant colonies make six to eight mating flights of up to 4,500 winged ants each between spring and fall, usually at midday on a warm (above 74°F), sunny day following rain. Newly mated queens land under rocks or leaves or in a small crack or crevice, such as the edge of a sidewalk, driveway or street. New mounds after a storm are new colonies starting, not a treatment failing.',
  },
  {
    slug: 'fact-american-cockroach-indoors',
    title: 'American cockroach: why it comes indoors',
    tags: ['cockroaches', 'american-cockroach'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN298'],
    quote: 'American cockroaches "wander indoors to search for food and water or to avoid extreme weather conditions."',
    content: 'American cockroaches live mainly outdoors and wander indoors to search for food and water or to avoid extreme weather. The UF publication does not use the nickname "palmetto bug"; copy may use that word as the local name but must not attribute it to the source.',
  },
  {
    slug: 'fact-ghost-ants-florida',
    title: 'Ghost ants: how common, where they nest, how colonies spread',
    tags: ['ants', 'ghost-ants'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN532'],
    quote: '"Indoors, the ant colonizes wall void or spaces between cabinetry and baseboards. It will also nest in potted plants." "New colonies are probably formed by budding." "Reduce moisture sources, including condensation and leaks."',
    content: 'Ghost ants were among the key pest ants in a Florida survey, each of those species making up 14% of the samples submitted. Indoors they colonize wall voids and the spaces between cabinetry and baseboards, and nest in potted plants. New colonies are probably formed by budding, when one or more reproductive females leave with workers for a new nesting site. UF recommends reducing moisture sources, including condensation and leaks.',
  },
  {
    slug: 'fact-roof-rats-access',
    title: 'Roof rats: how they reach a house and what to prune',
    tags: ['rodents', 'roof-rats', 'exclusion'],
    sourceUrls: ['https://ask.ifas.ufl.edu/publication/IN1397'],
    quote: '"Rats, such as the roof rat (Rattus rattus) can jump three feet in the air vertically and more than four feet horizontally." "Prune any overhanging or touching limbs away from your house" and "Prune dead leaves from palm trees that are close to buildings."',
    content: 'Roof rats can jump three feet vertically and more than four feet horizontally, and tree limbs serve as routes onto a house. UF advises pruning overhanging or touching limbs away from the house and pruning dead leaves from palms close to buildings, since palms with many dead leaves make good rodent habitat. Plants that will sit less than two feet from the house at maturity are too close. This source states no season or months of peak activity, so copy must not state one.',
  },
  {
    slug: 'fact-container-mosquitoes',
    title: 'Aedes mosquitoes: containers and the 7–10 day life cycle',
    tags: ['mosquitoes', 'aedes'],
    sourceUrls: ['https://www.cdc.gov/mosquitoes/about/life-cycle-of-aedes-mosquitoes.html', 'https://ask.ifas.ufl.edu/publication/IN792'],
    quote: '"A mosquito egg takes 7–10 days to develop into an adult mosquito." "Adult female mosquitoes lay eggs on the inner walls of containers with water, above the waterline." "Eggs can survive drying out for up to 8 months." "Mosquitoes only need a small amount of water to lay eggs."',
    content: 'Per CDC, an Aedes mosquito egg takes 7 to 10 days to develop into an adult, females lay eggs on the inner walls of containers with water above the waterline, eggs can survive drying out for up to 8 months, and only a small amount of water is needed. UF/IFAS describes the yellow fever mosquito as container-inhabiting, often breeding in unused flowerpots, spare tires, untreated swimming pools and drainage ditches. Mosquitoes from a rain event therefore become biting adults about 7 to 10 days later.',
  },
  {
    slug: 'fact-fertilizer-ordinance-sarasota-county',
    title: 'Fertilizer codes in Sarasota County, by jurisdiction',
    tags: ['lawn', 'fertilizer', 'ordinance', 'sarasota'],
    sourceUrls: ['https://sfyl.ifas.ufl.edu/media/sfylifasufledu/sarasota/documents/pdf/hortres/keydocs/2025_HortRes_brochureSacoFertilizerCodes_FINAL_ADA.pdf'],
    quote: 'Sarasota County (unincorporated), City of Sarasota, City of Venice: "From June 1 through Sept. 30, no fertilizer containing nitrogen or phosphorus shall be applied to turf or landscape plants in residential areas." "Nitrogen fertilizer must contain at least 50 percent slowly available or slow-release nitrogen". "Fertilizer may not be applied within 10 feet of any water body or wetland." City of North Port: "From April 1 through Sept. 30".',
    content: 'In unincorporated Sarasota County, the City of Sarasota and the City of Venice, no fertilizer containing nitrogen or phosphorus may be applied to turf or landscape plants in residential areas from June 1 through September 30. The City of North Port restricted season is longer: April 1 through September 30. In all of them nitrogen fertilizer must be at least 50 percent slow-release, no more than 1 pound of nitrogen per 1,000 square feet per application and 4 pounds per year. Sarasota County, Sarasota and Venice allow no fertilizer within 10 feet of any water body or wetland. The Town of Longboat Key uses June 1 through September 30 with a 3-foot zone, or 10 feet for a broadcast spreader without deflector shields.',
  },
  {
    slug: 'fact-fertilizer-ban-manatee-county',
    title: 'Manatee County seasonal fertilizer ban',
    tags: ['lawn', 'fertilizer', 'ordinance', 'manatee'],
    sourceUrls: ['https://wusf.org/text/environment/2026-06-03/most-of-the-tampa-bay-region-is-under-a-seasonal-fertilizer-ban-heres-what-you-need-to-know'],
    quote: 'The seasonal ban runs "June 1 until Sept. 30" and applies to "fertilizers containing nitrogen and phosphorus". "Fertilizers with micronutrients like iron can help your lawn".',
    content: 'Manatee County is under the seasonal fertilizer ban from June 1 until September 30, covering fertilizers that contain nitrogen and phosphorus; the ban has been in place for over a decade. Fertilizers with micronutrients such as iron remain an option. This source does not state a setback distance from water or a slow-release percentage for Manatee County, so copy must not state either for Manatee.',
  },
  {
    slug: 'fact-swfwmd-modified-phase-iii-water-shortage',
    title: 'SWFWMD Modified Phase III "Extreme" Water Shortage: one watering day a week through Oct. 1, 2026',
    tags: ['lawn', 'irrigation', 'water-restrictions', 'swfwmd'],
    sourceUrls: ['https://www.swfwmd.state.fl.us/the-newsroom/2026/district-extends-modified-phase-iii-water-shortage'],
    quote: '"one-day-per-week watering restrictions"; "If your address (house number) ends in...0 or 1, water only on Monday" through "8 or 9, water only on Friday"; hours "12:01 a.m. to 4 a.m. or 8 p.m. to 11:59 p.m."; through "Oct. 1, 2026".',
    content: 'The Southwest Florida Water Management District Modified Phase III "Extreme" Water Shortage covers all of Manatee and Sarasota counties among others and runs through October 1, 2026. Lawn watering is limited to one day per week by the last digit of the house number: 0 or 1 Monday, 2 or 3 Tuesday, 4 or 5 Wednesday, 6 or 7 Thursday, 8 or 9 Friday. Allowed hours are 12:01 a.m. to 4 a.m. or 8 p.m. to 11:59 p.m.; properties of one acre or more may water before 4 a.m. and after 8 p.m.',
  },
  {
    slug: 'fact-taurus-sc-non-repellent',
    title: 'Taurus SC (fipronil 9.1%): non-repellent, spread through the colony',
    tags: ['products', 'taurus-sc', 'fipronil', 'ants', 'cockroaches'],
    sourceUrls: ['https://www.controlsolutionsinc.com/csi-pest/products/taurus-sc'],
    quote: '"Taurus SC is a non-repellent insecticide that is undetectable to target pests, allowing them to touch, ingest and spread the insecticide throughout the entire colony".',
    content: 'Taurus SC (9.1% fipronil) is a non-repellent: target pests cannot detect it, so they touch it, ingest it and spread it through the colony. It works through the colony rather than killing on contact, so ants may remain visible after a treatment. The manufacturer states no time to control and no length of visible activity, so copy must not state a number of days or weeks for either.',
  },
  {
    slug: 'fact-bifenthrin-talstar-p-label',
    title: 'Bifenthrin (Talstar P) label: rain, re-entry and stated residual',
    tags: ['products', 'bifenthrin', 'talstar-p', 'label'],
    sourceUrls: ['https://mda.maryland.gov/plants-pests/Documents/Talstar%20P%20Professional%2004-17-13R%20Label.pdf'],
    quote: '"Applying this product in calm weather when rain is not predicted for the next 24 hours will help to ensure that wind or rain does not blow or wash pesticide off the treatment area." "Do not make applications during rain." "Do not allow people or pets on treated surfaces until the spray has dried."',
    content: 'The Talstar P Professional label (bifenthrin 7.9%) asks for application in calm weather when rain is not predicted for the next 24 hours, prohibits application during rain, and says people and pets must stay off treated surfaces until the spray has dried. The only residual durations the label states are up to 1 month of residual control of house flies and up to 3 months for fleas. It gives no general outdoor perimeter residual, so copy must not state a number of days of residual for ants, spiders or other pests.',
  },
  {
    slug: 'fact-gentrol-igr-hydroprene',
    title: 'Gentrol IGR (hydroprene): exposed roaches become adults that cannot reproduce',
    tags: ['products', 'gentrol', 'igr', 'cockroaches'],
    sourceUrls: [
      'https://www.zoecon.com/-/media/project/oneweb/zoecon/files/product-labels/specimen/gentrol-igr-concentrate-specimen-label.pdf',
      'https://www.zoecon.com/all-products/gentrol/gentrol-igr-concentrate',
    ],
    quote: '"Cockroaches and bedbugs exposed to the GENTROL IGR will become adults incapable of reproducing." Manufacturer page: "120 days of control".',
    content: 'Gentrol IGR Concentrate (hydroprene) is an insect growth regulator, a synthetic juvenile hormone look-alike that disrupts normal growth and development. Per the label, cockroaches exposed to it become adults incapable of reproducing, and the cycle of the infestation ends. The manufacturer states 120 days of control. Neither source states how long until results are visible, and neither says it makes already-mature adults sterile, so copy must not state a number of days to results or claim it sterilises adults.',
  },
  {
    slug: 'fact-flea-vacuuming-after-treatment',
    title: 'Fleas: why vacuuming continues after treatment',
    tags: ['fleas', 'vacuuming', 'prep'],
    sourceUrls: ['https://entomology.mgcafe.uky.edu/ef602'],
    quote: '"Even after treatment, expect to see some fleas for a few weeks or longer." "Instead of retreating immediately, continue to vacuum. As mentioned earlier, vacuuming stimulates insecticide-resistant flea pupae/cocoons to hatch, bringing emerging adults into contact with the treatment sooner." "If adult fleas continue to be seen beyond 4 weeks, retreatment of the premises and/or pets may be necessary."',
    content: 'Per University of Kentucky Extension entomologist Michael F. Potter (ENTFACT-602), the flea cocoon is impervious to insecticides, so some fleas are still seen for a few weeks or longer after treatment. Continuing to vacuum stimulates pupae to hatch and brings the emerging adults into contact with the treatment sooner. If adult fleas are still seen beyond 4 weeks, retreatment may be necessary. This guidance is specific to fleas; it does not apply to ant or cockroach treatments. The source gives no fixed number of days of vacuuming.',
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const hasAuditLog = await knex.schema.hasTable('audit_log');

  for (const fact of FACTS) {
    const existing = await knex('knowledge_base').where({ slug: fact.slug }).first('id');
    if (existing) continue; // insert-only: never overwrite a row that is already there

    const [inserted] = await knex('knowledge_base').insert({
      path: `kb/facts/${fact.slug}.md`,
      slug: fact.slug,
      title: fact.title,
      category: 'facts',
      content: fact.content,
      summary: fact.quote,
      tags: JSON.stringify(fact.tags),
      source: SOURCE,
      confidence: 'high',
      status: 'active',
      active: true,
      version: 1,
      metadata: JSON.stringify({
        source_url: fact.sourceUrls[0],
        source_urls: fact.sourceUrls,
        quote: fact.quote,
        verified_on: VERIFIED_ON,
        derived: fact.derived === true,
      }),
      last_verified_at: new Date(`${VERIFIED_ON}T00:00:00Z`),
      verified_by: SOURCE,
    }).returning(['id']);

    if (hasAuditLog && inserted?.id) {
      await require('../../services/audit-log').recordAuditEvent({
        actor_type: 'migration',
        actor_id: null,
        action: ACTION,
        resource_type: 'knowledge_base',
        resource_id: inserted.id,
        metadata: { slug: fact.slug, migration: STAMP, source: SOURCE },
        trx: knex,
        critical: true,
      });
    }
  }
};

// Documented no-op: up() only inserts a row that was missing and never
// overwrites one a person may have edited, so a blanket revert would delete
// rows that could by then carry a person's corrections.
exports.down = async function down() {};

module.exports._internals = { FACTS, SOURCE, VERIFIED_ON };
