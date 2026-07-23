// Species-specific completion-target prefill (owner request 2026-07-23).
//
// The 20260711500000 backfill gave pest-treatment products broad category
// lists ("ants", "roaches", "spiders"), so the completion card prefilled
// chips the tech deletes and retypes as the actual SWFL species being
// worked (e.g. Taurus SC on a residential general-pest visit targets ghost
// / big-headed / crazy / fire ants — not "ants"). This migration upgrades
// those lists to the specific SWFL targets, and extends prefill to the
// products the earlier backfill intentionally skipped now that the
// completion card surfaces targets for them too:
// - lawn herbicides → the weeds they control
// - lawn fungicides → the turf diseases they suppress
// - fertilizers → the nutrition goal of the application (green-up, iron
//   chlorosis, potassium deficiency), which the picker now collects
//
// Data rules (admin-edit-preserving, same contract as 20260711500000):
// - A row is written only when its current target_pests is NULL, [], or
//   EXACTLY one of the known machine-written legacy lists in `prevLists`
//   below. Three migrations have machine-written target_pests before this
//   one — the 20260528000002 batch-1 completion (unconditional overwrite),
//   the 20260711500000 prefill (filled NULL/[] only), and the
//   20260717000010 public-page enrich (COALESCE — filled NULL only) — so a
//   row's current value depends on which of those matched its name; every
//   candidate is listed verbatim. Anything else is an admin edit and is
//   never overwritten.
// - down() reverts a row only when its value is exactly what this
//   migration wrote: back to prevLists[0] (the value the row most likely
//   held, given the migration order above) where one exists, else NULL.

// [name, nextTargets, prevLists]. `prevLists` entries are verbatim copies
// from the migrations named above (jsonb equality is order- and
// case-sensitive).
const TARGET_UPGRADES = [
  // General-pest liquids / dusts
  ['Bifen I/T', ['Ghost ants', 'Big-headed ants', 'Fire ants', 'American cockroaches', 'Wolf spiders', 'Mosquitoes'], [
    ['ants', 'spiders', 'roaches', 'wasps', 'centipedes', 'mosquitoes'],
    ['Ants', 'Spiders', 'Mosquitoes', 'Fleas', 'Ticks', 'Scorpions'],
  ]],
  ['Bifen XTS', ['Ghost ants', 'Big-headed ants', 'Fire ants', 'Mosquitoes', 'Fleas', 'Ticks'], [
    ['ants', 'spiders', 'roaches', 'mosquitoes', 'fleas', 'ticks'],
  ]],
  // Owner-directed: Taurus SC is the residential general-pest ant product —
  // prefill the SWFL ant species, not the whole fipronil label.
  ['Taurus SC', ['Ghost ants', 'Big-headed ants', 'Crazy ants', 'White-footed ants', 'Fire ants', 'Carpenter ants'], [
    ['termites', 'ants', 'spiders', 'roaches', 'centipedes'],
  ]],
  ['Termidor SC', ['Subterranean termites', 'Formosan termites', 'Carpenter ants'], [
    ['termites', 'ants'],
    ['Subterranean termites', 'Carpenter ants', 'Ants'],
  ]],
  ['Bora-Care', ['Drywood termites', 'Subterranean termites', 'Carpenter ants', 'Wood-boring beetles'], [
    ['termites', 'carpenter ants', 'wood-boring beetles'],
    ['Subterranean termites', 'Drywood termites', 'Carpenter ants', 'Wood-destroying beetles', 'Wood decay fungi'],
  ]],
  ['Suspend SC', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Wolf spiders', 'Paper wasps'], [
    ['ants', 'spiders', 'roaches', 'fleas', 'wasps'],
  ]],
  ['Suspend Polyzone', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Wolf spiders', 'Mosquitoes'], [
    ['ants', 'spiders', 'roaches', 'flies', 'mosquitoes'],
  ]],
  ['Demand CS Insecticide', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Silverfish', 'Wolf spiders'], [
    ['ants', 'roaches', 'spiders', 'silverfish', 'centipedes'],
  ]],
  ['Demand CS', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Silverfish', 'Wolf spiders'], [
    ['ants', 'roaches', 'spiders', 'silverfish', 'centipedes'],
    ['Ants', 'Cockroaches', 'Spiders', 'Fleas', 'Ticks', 'Wasps', 'Scorpions'],
  ]],
  ['Cyzmic CS', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Wolf spiders'], [
    ['ants', 'roaches', 'spiders', 'mosquitoes'],
    ['Ants', 'Cockroaches', 'Spiders', 'Fleas', 'Ticks', 'Scorpions'],
  ]],
  ['Atticus Talak', ['Ghost ants', 'Big-headed ants', 'Fire ants', 'Smokybrown cockroaches', 'Southern chinch bugs'], [
    ['ants', 'roaches', 'spiders', 'fleas', 'ticks'],
    ['Ants', 'Spiders', 'Mosquitoes', 'Fleas', 'Ticks', 'Scorpions'],
  ]],
  ['Scion Insecticide', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Mosquitoes'], [
    ['ants', 'roaches', 'spiders', 'mosquitoes'],
    ['Mosquitoes', 'Ants', 'Spiders', 'Fleas', 'Ticks', 'Scorpions'],
  ]],
  ['Onslaught Fastcap', ['Wolf spiders', 'Widow spiders', 'Scorpions', 'Ghost ants'], [
    ['spiders', 'scorpions', 'ants', 'roaches'],
  ]],
  ['Permethrin SFR', ['Ghost ants', 'American cockroaches', 'Wolf spiders', 'Fleas', 'Ticks', 'Subterranean termites'], [
    ['ants', 'roaches', 'spiders', 'fleas', 'ticks', 'termites'],
  ]],
  ['Temprid FX', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Paper wasps', 'Bed bugs'], [
    ['ants', 'spiders', 'roaches', 'wasps', 'bed bugs'],
  ]],
  ['Alpine WSG', ['German cockroaches', 'American cockroaches', 'Ghost ants', 'White-footed ants'], [
    ['ants', 'roaches', 'flies', 'bed bugs'],
    ['Ants', 'Cockroaches', 'Fleas', 'Crickets', 'Silverfish', 'Wasps'],
  ]],
  ['Delta Dust', ['Ghost ants', 'German cockroaches', 'Paper wasps', 'Silverfish'], [
    ['ants', 'roaches', 'wasps', 'silverfish', 'bed bugs'],
  ]],
  ['Elector PSP', ['House flies', 'Darkling beetles'], [
    ['flies', 'beetles'],
  ]],
  ['Gentrol IGR', ['German cockroaches', 'Drain flies', 'Pantry moths & beetles'], [
    ['roaches', 'drain flies', 'pantry pests'],
  ]],
  ['Tekko Pro IGR', ['German cockroaches', 'Fleas', 'Mosquitoes'], [
    ['roaches', 'fleas', 'flies', 'mosquitoes'],
    ['Fleas', 'Ticks', 'Mosquito larvae', 'Cockroaches', 'Flies'],
  ]],
  ['LESCO Crosscheck Plus', ['Fire ants', 'Big-headed ants', 'Southern chinch bugs', 'Fleas', 'Ticks'], [
    ['ants', 'chinch bugs', 'spiders', 'fleas', 'ticks'],
  ]],
  ['Talstar P', ['Ghost ants', 'Big-headed ants', 'Fire ants', 'Smokybrown cockroaches', 'Southern chinch bugs'], [
    ['ants', 'spiders', 'roaches', 'fleas', 'ticks', 'chinch bugs'],
  ]],
  ['Aprehend', ['Bed bugs'], [
    ['bed bugs'],
  ]],

  // Turf insect control
  ['Topchoice Granular Insecticide', ['Fire ants', 'Tawny mole crickets', 'Fleas', 'Ticks'], [
    ['fire ants', 'fleas', 'ticks', 'mole crickets'],
    ['Fire ants', 'Mole crickets', 'Nuisance ants', 'Fleas', 'Ticks'],
  ]],
  ['Acelepryn Insecticide', ['White grubs', 'Tropical sod webworms', 'Fall armyworms', 'Billbugs'], [
    ['grubs', 'caterpillars', 'billbugs'],
  ]],
  ['Acelepryn Xtra', ['White grubs', 'Tropical sod webworms', 'Fall armyworms', 'Southern chinch bugs'], [
    ['grubs', 'caterpillars', 'chinch bugs'],
    ['White grubs', 'Chinch bugs', 'Armyworms', 'Sod webworms', 'Fire ants', 'Billbugs'],
  ]],
  ['Dylox 420 SL T&O Insecticide', ['White grubs', 'Tawny mole crickets', 'Tropical sod webworms'], [
    ['grubs', 'mole crickets', 'sod webworms'],
  ]],
  ['Arena 50 WDG', ['White grubs', 'Southern chinch bugs'], [
    ['grubs', 'chinch bugs'],
  ]],
  [
    'Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide',
    ['White grubs', 'Southern chinch bugs'],
    [
      ['grubs', 'chinch bugs'],
    ],
  ],
  ['Tetrino Insecticide', ['White grubs', 'Tropical sod webworms', 'Fall armyworms'], [
    ['grubs', 'sod webworms', 'armyworms'],
  ]],
  ['Merit 2F', ['White grubs', 'Aphids', 'Whiteflies', 'Soft scale insects'], [
    ['grubs', 'aphids', 'whiteflies', 'scale'],
  ]],

  // Ornamental / tree & shrub
  ['Safari 20 SG', ['Ficus whitefly', 'Rugose spiraling whitefly', 'Scale insects', 'Mealybugs', 'Aphids'], [
    ['whiteflies', 'scale', 'mealybugs', 'aphids'],
  ]],
  ['Zylam Insecticide', ['Ficus whitefly', 'Rugose spiraling whitefly', 'Scale insects', 'Aphids', 'Leafminers'], [
    ['whiteflies', 'scale', 'aphids', 'leafminers'],
  ]],
  ['Mainspring GNL Insecticide', ['Chilli thrips', 'Whiteflies', 'Caterpillars', 'Aphids'], [
    ['thrips', 'whiteflies', 'caterpillars', 'aphids'],
  ]],
  ['Avid Insecticide', ['Spider mites', 'Leafminers'], [
    ['mites', 'leafminers'],
  ]],
  ['Floramite Miticide 1 qt', ['Twospotted spider mites'], [
    ['spider mites'],
  ]],
  ['Floramite SC/LS 8 oz', ['Twospotted spider mites'], [
    ['spider mites'],
  ]],
  ['Forbid 4F', ['Spider mites', 'Broad mites', 'Whiteflies'], [
    ['mites', 'whiteflies'],
  ]],
  ['Hexygon IQ Miticide', ['Twospotted spider mites'], [
    ['spider mites'],
  ]],
  ['Kontos Insecticide/Miticide', ['Aphids', 'Ficus whitefly', 'Spider mites', 'Scale insects', 'Mealybugs'], [
    ['aphids', 'whiteflies', 'mites', 'scale', 'mealybugs'],
  ]],
  ['Conserve SC', ['Caterpillars', 'Chilli thrips', 'Tropical sod webworms'], [
    ['caterpillars', 'thrips', 'sod webworms'],
  ]],
  ['SuffOil-X Spray Oil Emulsion', ['Scale insects', 'Spider mites', 'Aphids', 'Whiteflies'], [
    ['scale', 'mites', 'aphids', 'whiteflies'],
  ]],
  ['Distance IGR', ['Ficus whitefly', 'Rugose spiraling whitefly', 'Scale insects'], [
    ['whiteflies', 'scale'],
  ]],
  ['Talus 70 DF IGR', ['Ficus whitefly', 'Scale insects', 'Mealybugs'], [
    ['whiteflies', 'scale', 'mealybugs'],
  ]],
  ['Dominion 2L 1 gal', ['Subterranean termites', 'Ghost ants', 'Aphids', 'Whiteflies', 'Scale insects'], [
    ['termites', 'ants', 'aphids', 'whiteflies', 'scale'],
  ]],
  ['Dominion 2L 27.5 oz', ['Subterranean termites', 'Ghost ants', 'Aphids', 'Whiteflies', 'Scale insects'], [
    ['termites', 'ants', 'aphids', 'whiteflies', 'scale'],
  ]],
  ['Arborjet Ima-Jet 10', ['Wood borers', 'Aphids', 'Scale insects', 'Whiteflies'], [
    ['borers', 'aphids', 'scale', 'whiteflies'],
  ]],
  ['Arborjet Ima-Jet Systemic Insecticide', ['Wood borers', 'Aphids', 'Scale insects', 'Whiteflies'], [
    ['borers', 'aphids', 'scale', 'whiteflies'],
  ]],
  ['Arborjet Tree-Age G-4 Injectable Insecticide', ['Wood borers', 'Caterpillars', 'Spider mites'], [
    ['borers', 'caterpillars', 'mites'],
  ]],
  ['ArborJet Tree-Age R10 Insecticide', ['Wood borers', 'Caterpillars', 'Spider mites'], [
    ['borers', 'caterpillars', 'mites'],
  ]],

  // Baits
  ['Advion Ant Bait Gel', ['Ghost ants', 'Big-headed ants', 'Crazy ants', 'Pharaoh ants'], [
    ['ants'],
  ]],
  ['Advion Evolution Cockroach Gel Bait', ['German cockroaches', 'American cockroaches'], [
    ['roaches'],
  ]],
  ['Advion Cockroach Gel Bait', ['German cockroaches', 'American cockroaches'], [
    ['roaches'],
    ['German cockroach', 'American cockroach', 'Brown-banded cockroach', 'Oriental cockroach'],
  ]],
  ['Advion Cockroach Gel', ['German cockroaches', 'American cockroaches'], [
    ['cockroaches'],
  ]],
  ['Advion WDG Granular', ['Ghost ants', 'Big-headed ants', 'Crickets', 'Silverfish'], [
    ['ants', 'roaches'],
    ['Ants', 'Mole crickets', 'Crickets', 'Cockroaches', 'Earwigs', 'Silverfish'],
  ]],
  ['Vendetta Plus', ['German cockroaches'], [
    ['cockroaches'],
    ['German cockroach'],
  ]],

  // Mosquito
  ['Altosid 30 Day Briquets', ['Mosquito larvae (standing water)'], [
    ['mosquitoes'],
  ]],
  ['In2Care Mosquito Station', ['Aedes mosquitoes (container breeders)'], [
    ['mosquitoes'],
    ['Aedes mosquitoes', 'Culex mosquitoes'],
  ]],

  // Rodent / mole
  ['Contrac Blox', ['Roof rats', 'Norway rats', 'House mice'], [
    ['rats', 'mice'],
    ['Norway rats', 'Roof rats', 'House mice'],
  ]],
  ['Victor Expanded Trigger Rat Snap Trap', ['Roof rats', 'Norway rats'], [
    ['rats'],
  ]],
  ['Trapper T-Rex Rat Snap Trap', ['Roof rats', 'Norway rats'], [
    ['rats'],
    ['Norway rats', 'Roof rats'],
  ]],
  ['Talpirid', ['Moles'], [
    ['moles'],
  ]],

  // Termite stations / foam
  ['Trelona ATBS Annual Bait Station', ['Subterranean termites', 'Formosan termites'], [
    ['termites'],
  ]],
  ['Trelona ATBS Bait Station', ['Subterranean termites', 'Formosan termites'], [
    ['subterranean termites'],
    ['Subterranean termites'],
  ]],
  ['Trelona Compressed Termite Bait Cartridges', ['Subterranean termites', 'Formosan termites'], [
    ['termites'],
  ]],
  ['HexPro Termite Monitoring Baiting System', ['Subterranean termites'], [
    ['termites'],
    ['Subterranean termites'],
  ]],
  ['Termidor Foam', ['Subterranean termites', 'Drywood termites', 'Carpenter ants'], [
    ['subterranean termites', 'drywood termites'],
    ['Subterranean termites', 'Drywood termites', 'Carpenter ants'],
  ]],

  // Lawn herbicides → the weeds they control
  ['Celsius WG', ['Dollarweed', 'Doveweed', 'Chamberbitter', 'Spurge', 'Clover'], [
    ['Doveweed', 'Dollarweed', 'Florida pusley', 'Virginia buttonweed', 'Chamberbitter', 'Clover'],
  ]],
  ['Dismiss NXT', ['Yellow nutsedge', 'Purple nutsedge', 'Green kyllinga'], []],
  ['Prodiamine 65 WDG', ['Crabgrass (pre-emergent)', 'Goosegrass (pre-emergent)', 'Annual bluegrass (Poa annua)'], []],
  ['SpeedZone Southern', ['Dollarweed', 'Clover', 'Spurge', 'Chickweed'], []],
  ['LESCO Stonewall 0-0-7', ['Crabgrass (pre-emergent)', 'Goosegrass (pre-emergent)', 'Annual bluegrass (Poa annua)'], [
    ['annual grassy weeds', 'broadleaf weeds'],
    ['Crabgrass (pre-emergent)', 'Poa annua', 'Goosegrass', 'Chickweed', 'Florida pusley'],
  ]],

  // Lawn fungicides → the turf diseases they suppress
  ['Heritage G', ['Brown patch / large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring'], [
    ['turf disease'],
    ['Brown patch', 'Large patch', 'Gray leaf spot', 'Anthracnose', 'Pythium blight', 'Fairy ring'],
  ]],
  ['Pillar G Intrinsic', ['Brown patch / large patch', 'Dollar spot', 'Gray leaf spot'], [
    ['turf disease'],
    ['Brown patch', 'Large patch', 'Dollar spot', 'Gray leaf spot', 'Anthracnose', 'Fairy ring'],
  ]],

  // Fertilizers → the nutrition goal of the application
  ['LESCO K-Flow 0-0-25', ['Potassium deficiency', 'Root strength & stress tolerance'], []],
  ['LESCO 24-0-11', ['Nitrogen green-up', 'Color & density', 'Potassium root support'], []],
  ['24-0-11 50% MESA', ['Nitrogen green-up', 'Slow-release feeding', 'Color & density'], []],
  ['LESCO 12-0-0 Chelated Iron Plus', ['Iron chlorosis (yellowing turf)', 'Deep green color'], []],
  ['LESCO Green Flo 6-0-0 10% Ca', ['Nitrogen green-up', 'Calcium deficiency', 'Color & density'], []],
  ['0-0-16 Winterizer', ['Potassium deficiency', 'Root strength & winter hardiness'], []],
  ['16-4-8 + Micros', ['Balanced feeding', 'Nitrogen green-up', 'Micronutrient deficiency'], []],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [name, next, prevLists] of TARGET_UPGRADES) {
    const conditions = ["target_pests IS NULL", "target_pests = '[]'::jsonb"];
    const bindings = [];
    for (const prev of prevLists) {
      conditions.push('target_pests = ?::jsonb');
      bindings.push(JSON.stringify(prev));
    }
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereRaw(`(${conditions.join(' OR ')})`, bindings)
      .update({
        target_pests: JSON.stringify(next),
        updated_at: new Date(),
      });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [name, next, prevLists] of TARGET_UPGRADES) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereRaw('target_pests = ?::jsonb', [JSON.stringify(next)])
      .update({
        target_pests: prevLists.length ? JSON.stringify(prevLists[0]) : null,
        updated_at: new Date(),
      });
  }
};
