/**
 * Email division fact register — UF/IFAS (and other authoritative) facts
 * used in customer-facing newsletter copy, each with its own source URL.
 *
 * Born from the September Pest Insider draft asserting a "second
 * subterranean termite swarm after storms" — a claim no UF/IFAS source
 * supports. Every UF fact the newsletter pipeline is allowed to state now
 * lives here first, so the claim validator (newsletter-validator.js /
 * fact-register.js) can check generated copy against it and so a human can
 * click through to the primary source before approving a proof.
 *
 * category 'facts', source 'email-division-fact-register', status
 * 'active', confidence 'high'. metadata.source_url / .quote / .verified_on
 * carry the citation; fact-register.js reads these back through the
 * ordinary knowledge_base 'facts' category, not a bespoke table.
 *
 * Idempotent by slug: an entry already present (including one an admin has
 * since edited) is left untouched — this migration only inserts, it never
 * overwrites. down() is a documented no-op for the same reason (waves-db
 * skill: a seed migration whose up() preserves admin edits must not ship a
 * destructive down()).
 */

const MIGRATION_TAG = '20260928050000_email_division_fact_register';
const SOURCE = 'email-division-fact-register';
const VERIFIED_ON = '2026-09-27';

const FACTS = [
  {
    slug: 'fact-native-subterranean-termite-swarm-season',
    title: 'Native subterranean termite swarm season (Florida)',
    tags: ['termites', 'subterranean-termites', 'swarm-season'],
    sourceUrl: 'https://edis.ifas.ufl.edu/ig097',
    quote: 'Native subterranean termite swarms occur January through May, on warm days after rain.',
    content: 'Native (eastern) subterranean termites in Florida swarm January through May, typically on warm days following rain. This is the ONLY swarm window UF/IFAS documents for this species — see the negative fact on storm-triggered "second swarms" in this same register.',
  },
  {
    slug: 'fact-asian-formosan-termite-swarm-season',
    title: 'Asian and Formosan subterranean termite swarm season (Florida)',
    tags: ['termites', 'subterranean-termites', 'swarm-season', 'invasive-species'],
    sourceUrl: 'https://blogs.ifas.ufl.edu/news/2022/03/30/termite-season-uf-ifas-scientist-answers-common-questions-corrects-misconceptions/',
    quote: 'Asian subterranean termites swarm February through April around sunset; Formosan subterranean termites swarm late April through June after sunset.',
    content: 'Asian subterranean termites swarm February through April, around sunset. Formosan subterranean termites swarm later in the year, late April through June, after sunset. Both are distinct from the native subterranean termite\'s January–May daytime-after-rain window.',
  },
  {
    slug: 'fact-west-indian-drywood-termite-dispersal',
    title: 'West Indian drywood termite dispersal flights (Florida)',
    tags: ['termites', 'drywood-termites', 'swarm-season'],
    sourceUrl: 'https://ask.ifas.ufl.edu/publication/IN236',
    quote: 'West Indian drywood termite dispersal flights occur April through June, though a flight is possible in almost any month; their fecal pellets are hexagonal in cross-section.',
    content: 'The West Indian drywood termite\'s dispersal (swarming) flights mainly occur April through June in Florida, though a flight is possible in almost any month. A distinguishing field sign: this species\' fecal pellets are hexagonal in cross-section (visible with a hand lens), unlike the pellets of other drywood termite species.',
  },
  {
    slug: 'fact-western-drywood-termite-flight-season',
    title: 'Western drywood termite flight season (Florida)',
    tags: ['termites', 'drywood-termites', 'swarm-season', 'invasive-species'],
    sourceUrl: 'https://ask.ifas.ufl.edu/publication/IN526',
    quote: 'Western drywood termite flights in Florida occur in all months except December, with about half occurring September through November, typically during the day and often indoors.',
    content: 'The western drywood termite (an introduced pest in Florida) has been recorded flying in every month except December, with roughly half of flights occurring September through November. Flights typically happen during the day, and — unlike many termite swarms — are often noticed indoors rather than outdoors.',
  },
  {
    slug: 'fact-no-storm-triggered-second-termite-swarm',
    title: 'No UF source supports a storm-triggered "second swarm" of native subterranean termites',
    tags: ['termites', 'subterranean-termites', 'swarm-season', 'claim-correction'],
    sourceUrl: 'https://edis.ifas.ufl.edu/ig097',
    quote: 'UF/IFAS documents one native subterranean termite swarm window (January–May, warm days after rain) — no UF source describes a second, storm-triggered swarm later in the year.',
    content: 'This is a negative/correction fact: no University of Florida (UF/IFAS) source documents a second subterranean termite swarm triggered by storms, late-summer rain, or any other late-season event. The only native subterranean termite swarm window UF/IFAS publishes is January through May on warm days after rain (see the companion fact in this register). A newsletter or other customer email claiming a late-summer/storm-triggered "second swarm" of native subterranean termites is unsupported and must not be sent — this is the exact claim the September 2026 Pest Insider draft made in error.',
  },
  {
    slug: 'fact-southern-chinch-bug',
    title: 'Southern chinch bug: season, injury pattern, and the flotation test',
    tags: ['chinch-bugs', 'lawn', 'st-augustinegrass', 'diagnosis'],
    sourceUrl: 'https://ask.ifas.ufl.edu/publication/IN383',
    quote: 'Southern chinch bugs thrive in warm, dry-to-damp summer weather with populations peaking in early July; injury shows first in water-stressed, full-sun turf along lawn edges (driveways, sidewalks); a coffee can with both ends cut, pushed 3 inches into the soil and kept full of water for 5 minutes floats the bugs to the surface; yellow or brown lawn spots alone are not proof of chinch bug damage.',
    content: 'The southern chinch bug thrives in warm summer weather, with populations typically peaking in early July. Injury shows up first in water-stressed turf in full sun, often along lawn edges such as driveways and sidewalks. The standard diagnostic is the coffee-can flotation test: cut both ends off a can, push it about 3 inches into the soil in a suspect area, keep it filled with water for about 5 minutes, and chinch bugs will float to the surface. Yellow or brown patches in the lawn are NOT by themselves proof of chinch bug damage — other causes (drought stress, disease, fertilizer burn) look similar, and the flotation test (or another positive ID) is required before treating for chinch bugs.',
  },
  {
    slug: 'fact-st-augustinegrass-care',
    title: 'St. Augustinegrass mowing, irrigation, and common summer/fall diseases',
    tags: ['lawn', 'st-augustinegrass', 'turf-care', 'diagnosis'],
    sourceUrl: 'https://ask.ifas.ufl.edu/publication/LH010',
    quote: 'Standard St. Augustinegrass cultivars mow at 3.5–4 inches (dwarf cultivars 2–2.5 inches); irrigate 1/2 to 3/4 inch per application when the grass shows folded/wilted blades, a blue-gray cast, or footprints that stay; large patch appears in spring and fall in cool, wet weather and is worsened by excess nitrogen; gray leaf spot is a summer rainy-season disease of new growth; chinch bug injury shows first along sidewalks and driveways in full sun.',
    content: 'Standard St. Augustinegrass cultivars should be mowed at 3.5–4 inches, dwarf cultivars at 2–2.5 inches. Irrigate about 1/2 to 3/4 inch per application, only when the lawn shows signs of drought stress: folded or wilted blades, a blue-gray cast, or footprints that remain visible. Large patch disease appears in spring and fall during cool, humid weather and is worsened by excess nitrogen fertilization — it is NOT a summer disease. Gray leaf spot, by contrast, is a summer rainy-season disease that attacks new growth (including recently fertilized or newly sodded areas). Chinch bug injury on St. Augustinegrass shows up first along sidewalks and driveways in full sun, matching the southern chinch bug fact in this register.',
  },
  {
    slug: 'fact-fire-ant-mating-flights',
    title: 'Fire ant mating flight conditions',
    tags: ['fire-ants', 'swarm-season'],
    sourceUrl: 'https://edis.ifas.ufl.edu/lh059',
    quote: 'Fire ant mating flights occur in spring and fall when soil temperature is about 70–75°F, typically about 24 hours after a heavy rain, from late morning into the afternoon.',
    content: 'Fire ant mating (nuptial) flights occur in spring and fall, when soil temperature is roughly 70–75°F, and are typically triggered about 24 hours after a heavy rain. Flights happen from late morning into the afternoon.',
  },
  {
    slug: 'fact-american-cockroach-palmetto-bug',
    title: 'American cockroach ("palmetto bug") is an outdoor species that wanders in',
    tags: ['cockroaches', 'american-cockroach'],
    sourceUrl: 'https://ask.ifas.ufl.edu/publication/IN298',
    quote: 'The American cockroach ("palmetto bug") normally lives outdoors and wanders indoors searching for food and water, or to escape extreme weather.',
    content: 'The American cockroach, commonly called the "palmetto bug" in Florida, is fundamentally an outdoor species — it lives in moist outdoor habitats such as mulch, tree holes, and sewers. It wanders indoors mainly to search for food and water, or to escape extreme heat, cold, or flooding, rather than establishing large indoor infestations the way the German cockroach does.',
  },
  {
    slug: 'fact-ghost-ants-florida',
    title: 'Ghost ants: prevalence and indoor nesting behavior',
    tags: ['ants', 'ghost-ants'],
    sourceUrl: 'https://edis.ifas.ufl.edu/in532',
    quote: 'Ghost ants make up about 14% of Florida pest-ant samples and are notable for nesting indoors, driven by moisture.',
    content: 'Ghost ants account for roughly 14% of pest ant samples submitted in Florida. Unlike many pest ants, ghost ants readily nest indoors, and their indoor presence is strongly moisture-driven — they favor damp areas such as potted plants, wall voids near plumbing, and bathrooms.',
  },
  {
    slug: 'fact-roof-rats-florida',
    title: 'Roof rat seasonal peak and palm nesting',
    tags: ['rodents', 'roof-rats'],
    sourceUrl: 'https://edis.ifas.ufl.edu/publication/UW120',
    quote: 'Roof rat activity in Florida homes peaks September through March, coinciding with ripening citrus; roof rats commonly nest in palms.',
    content: 'Roof rat activity in and around Florida homes peaks September through March, a window that coincides with ripening citrus (a major food source). Roof rats are strong climbers and commonly nest in palms, in addition to attics and dense vegetation.',
  },
  {
    slug: 'fact-container-mosquitoes',
    title: 'Container mosquitoes (Aedes aegypti, Aedes albopictus): year-round breeding, egg-to-adult time',
    tags: ['mosquitoes', 'container-mosquitoes', 'waveguard'],
    sourceUrl: ['https://edis.ifas.ufl.edu/in792', 'https://www.scgov.net/government/health-and-human-services/mosquito-management-services'],
    quote: 'Aedes aegypti and Aedes albopictus breed year-round in standing water in Florida, and can go from egg to adult in as little as 5–10 days.',
    content: 'Aedes aegypti (yellow fever mosquito) and Aedes albopictus (Asian tiger mosquito) — Florida\'s two primary container-breeding mosquitoes — breed year-round wherever standing water collects (plant saucers, tarps, gutters, discarded containers), not on a seasonal cycle the way floodwater mosquitoes do. They can complete their life cycle from egg to adult in as little as 5 to 10 days, which is why standing water should never be allowed to sit for more than about a week.',
  },
  {
    slug: 'fact-fertilizer-ordinance-sarasota-manatee',
    title: 'Sarasota/Manatee fertilizer ordinance: summer blackout, waterway setback, slow-release requirement',
    tags: ['fertilizer', 'lawn', 'compliance', 'sarasota-county', 'manatee-county'],
    sourceUrl: ['https://www.mymanatee.org/connect/news-and-information/news-and-information/article-detail/environmental-protection-division-posts/2025/01/02/fertilizer-ordinance', 'https://sfyl.ifas.ufl.edu/media/sfylifasufledu/sarasota/documents/pdf/hortres/keydocs/2025_HortRes_brochureSacoFertilizerCodes_FINAL_ADA.pdf'],
    quote: 'Sarasota and Manatee County fertilizer ordinances prohibit nitrogen or phosphorus fertilizer application June 1 through September 30, require at least a 10-foot setback from any water body, and require fertilizer applied outside the blackout window to be at least 50% slow-release nitrogen.',
    content: 'Sarasota and Manatee County fertilizer ordinances prohibit applying fertilizer containing nitrogen or phosphorus from June 1 through September 30 (the summer blackout, timed to the rainy season when runoff risk is highest). Year-round, fertilizer application requires at least a 10-foot setback from any water body (pond, canal, lake, etc.). Outside the June–September blackout window, at least 50% of the nitrogen in any fertilizer applied must be slow-release.',
  },
  {
    slug: 'fact-swfwmd-modified-phase-iii-water-shortage',
    title: 'SWFWMD Modified Phase III water shortage: one watering day per week through Oct 1, 2026',
    tags: ['irrigation', 'lawn', 'compliance', 'swfwmd', 'water-restrictions'],
    sourceUrl: 'https://www.swfwmd.state.fl.us/the-newsroom/2026/district-extends-modified-phase-iii-water-shortage',
    quote: 'Under the SWFWMD Modified Phase III water shortage order, properties are limited to one lawn/landscape watering day per week through October 1, 2026, assigned by the last digit of the street address.',
    content: 'Under the Southwest Florida Water Management District (SWFWMD) Modified Phase III water shortage order, properties are restricted to one lawn/landscape irrigation day per week through October 1, 2026. The assigned watering day is determined by the last digit of the property\'s street address, per the district\'s published schedule.',
  },
  {
    slug: 'fact-taurus-sc-non-repellent',
    title: 'Taurus SC (fipronil 9.1%): non-repellent transfer effect and colony timeline',
    tags: ['products', 'taurus-sc', 'fipronil', 'ants', 'cockroaches', 'termiticide'],
    sourceUrl: 'https://www.domyown.com/taurus-sc-termiticide-p-1816.html',
    quote: 'Taurus SC (fipronil 9.1%) is non-repellent, so ants and roaches carry it back to the colony; visible pest activity can continue for 1–2 weeks after treatment, and control of large colonies can take up to 90 days.',
    content: 'Taurus SC (9.1% fipronil) is a non-repellent termiticide/insecticide — treated ants and roaches cannot detect and avoid it, so they carry it back to the nest and transfer it to nestmates (the "domino effect"). Because of this transfer mechanism, visible activity can continue for 1 to 2 weeks after treatment, and full control of large or well-established colonies can take up to 90 days. This should always be set against expectations for immediate knockdown, which non-repellents are not designed to provide.',
  },
  {
    slug: 'fact-bifenthrin-talstar-p-residual',
    title: 'Bifenthrin (Talstar P) residual length and rain/irrigation interval',
    tags: ['products', 'bifenthrin', 'talstar-p', 'residual'],
    sourceUrl: 'https://www.domyown.com/talstar-professional-insecticide-p-97.html',
    quote: 'Bifenthrin (Talstar P) residual control lasts about 30 days outdoors, up to 90 days in mild/dry conditions; allow 24 hours before rain or irrigation after application.',
    content: 'Bifenthrin (as in Talstar P) provides residual outdoor control for about 30 days under typical conditions, extending up to about 90 days in mild, dry conditions with less UV and rainfall breakdown. Label guidance calls for at least 24 hours between application and rain or irrigation so the residual can bind to the treated surface.',
  },
  {
    slug: 'fact-gentrol-igr-hydroprene',
    title: 'Gentrol IGR (hydroprene): sterilization mechanism and timeline',
    tags: ['products', 'gentrol', 'igr', 'cockroaches'],
    sourceUrl: 'https://www.zoecon.com/all-products/gentrol/gentrol-igr-concentrate',
    quote: 'Gentrol IGR (hydroprene) sterilizes adult roaches and prevents nymphs from maturing to reproductive adults; fewer newly-produced roaches appear within 7–14 days, with full population control typically achieved over 30–90 days.',
    content: 'Gentrol IGR\'s active ingredient, hydroprene, is an insect growth regulator: it sterilizes adult cockroaches and prevents nymphs from developing into reproductive adults, rather than killing on contact. Because it works on reproduction rather than direct kill, a visible drop in newly-produced roaches typically appears within 7 to 14 days, with full population control usually achieved over a longer 30- to 90-day window as the existing population ages out without being replaced.',
  },
  {
    slug: 'fact-flea-vacuuming-14-days',
    title: 'Daily vacuuming for 14 days post-treatment is flea-specific — not ant/roach guidance',
    tags: ['fleas', 'products', 'claim-correction'],
    sourceUrl: 'https://edis.ifas.ufl.edu/ig087',
    quote: 'Vacuuming daily for about 14 days after flea treatment helps hatch flea pupae into the treated residual; this guidance is specific to fleas and does not apply to ant or roach treatments.',
    content: 'The advice to vacuum daily for about 14 days after treatment is flea-specific: flea pupae are protected in a cocoon that is resistant to insecticide, and the vibration/warmth from vacuuming helps stimulate them to hatch into the treated residual where they are then controlled. This guidance does not carry over to ant or roach treatments, which have no equivalent pupal-cocoon stage sheltered from the treatment — customer copy should never generalize "vacuum daily for two weeks" beyond a flea job.',
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const hasAuditLog = await knex.schema.hasTable('audit_log');

  for (const fact of FACTS) {
    const existing = await knex('knowledge_base').where({ slug: fact.slug }).first('id');
    // Idempotent by slug: never overwrite (an admin may have since edited
    // this entry) — insert only when the slug is not yet present.
    if (existing) continue;

    const metadata = {
      source_url: fact.sourceUrl,
      quote: fact.quote,
      verified_on: VERIFIED_ON,
    };

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
      metadata: JSON.stringify(metadata),
      last_verified_at: new Date(`${VERIFIED_ON}T00:00:00Z`),
      verified_by: SOURCE,
    }).returning(['id']);

    if (hasAuditLog && inserted?.id) {
      await require('../../services/audit-log').recordAuditEvent({
        actor_type: 'migration',
        actor_id: null,
        action: 'knowledge_base.fact_seeded',
        resource_type: 'knowledge_base',
        resource_id: inserted.id,
        metadata: { slug: fact.slug, migration: MIGRATION_TAG, source: SOURCE },
      });
    }
  }
};

// Documented no-op: up() only ever inserts a row that was missing, and
// never overwrites one an admin may have since edited — a blanket revert
// would delete facts that could by then carry admin corrections. Removing
// a specific bad fact is a deliberate follow-up migration, not this down().
exports.down = async function down() {};
