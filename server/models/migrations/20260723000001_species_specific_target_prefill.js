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
// Data rules (same admin-edit-preserving contract as 20260711500000):
// - A row is written only when its current target_pests is NULL, [], or
//   EXACTLY the list the 20260711500000 migration wrote (`prev` below) —
//   an admin-edited list is never overwritten.
// - down() reverts a row only when its value is exactly what this
//   migration wrote: back to `prev` where one existed, else NULL.

// [name, nextTargets, prevTargets|null]. `prev` entries are verbatim copies
// of the 20260711500000 lists (jsonb equality is order-sensitive).
const TARGET_UPGRADES = [
  // General-pest liquids / dusts
  ['Bifen I/T', ['Ghost ants', 'Big-headed ants', 'Fire ants', 'American cockroaches', 'Wolf spiders', 'Mosquitoes'], ['ants', 'spiders', 'roaches', 'wasps', 'centipedes', 'mosquitoes']],
  ['Bifen XTS', ['Ghost ants', 'Big-headed ants', 'Fire ants', 'Mosquitoes', 'Fleas', 'Ticks'], ['ants', 'spiders', 'roaches', 'mosquitoes', 'fleas', 'ticks']],
  // Owner-directed: Taurus SC is the residential general-pest ant product —
  // prefill the SWFL ant species, not the whole fipronil label.
  ['Taurus SC', ['Ghost ants', 'Big-headed ants', 'Crazy ants', 'White-footed ants', 'Fire ants', 'Carpenter ants'], ['termites', 'ants', 'spiders', 'roaches', 'centipedes']],
  ['Termidor SC', ['Subterranean termites', 'Formosan termites', 'Carpenter ants'], ['termites', 'ants']],
  ['Bora-Care', ['Drywood termites', 'Subterranean termites', 'Carpenter ants', 'Wood-boring beetles'], ['termites', 'carpenter ants', 'wood-boring beetles']],
  ['Suspend SC', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Wolf spiders', 'Paper wasps'], ['ants', 'spiders', 'roaches', 'fleas', 'wasps']],
  ['Suspend Polyzone', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Wolf spiders', 'Mosquitoes'], ['ants', 'spiders', 'roaches', 'flies', 'mosquitoes']],
  ['Demand CS Insecticide', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Silverfish', 'Wolf spiders'], ['ants', 'roaches', 'spiders', 'silverfish', 'centipedes']],
  ['Demand CS', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Silverfish', 'Wolf spiders'], null],
  ['Cyzmic CS', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Wolf spiders'], null],
  ['Atticus Talak', ['Ghost ants', 'Big-headed ants', 'Fire ants', 'Smokybrown cockroaches', 'Southern chinch bugs'], null],
  ['Scion Insecticide', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Mosquitoes'], null],
  ['Onslaught Fastcap', ['Wolf spiders', 'Widow spiders', 'Scorpions', 'Ghost ants'], ['spiders', 'scorpions', 'ants', 'roaches']],
  ['Permethrin SFR', ['Ghost ants', 'American cockroaches', 'Wolf spiders', 'Fleas', 'Ticks', 'Subterranean termites'], ['ants', 'roaches', 'spiders', 'fleas', 'ticks', 'termites']],
  ['Temprid FX', ['Ghost ants', 'Big-headed ants', 'American cockroaches', 'Paper wasps', 'Bed bugs'], ['ants', 'spiders', 'roaches', 'wasps', 'bed bugs']],
  ['Alpine WSG', ['German cockroaches', 'American cockroaches', 'Ghost ants', 'White-footed ants'], ['ants', 'roaches', 'flies', 'bed bugs']],
  ['Delta Dust', ['Ghost ants', 'German cockroaches', 'Paper wasps', 'Silverfish'], ['ants', 'roaches', 'wasps', 'silverfish', 'bed bugs']],
  ['Elector PSP', ['House flies', 'Darkling beetles'], ['flies', 'beetles']],
  ['Gentrol IGR', ['German cockroaches', 'Drain flies', 'Pantry moths & beetles'], ['roaches', 'drain flies', 'pantry pests']],
  ['Tekko Pro IGR', ['German cockroaches', 'Fleas', 'Mosquitoes'], ['roaches', 'fleas', 'flies', 'mosquitoes']],
  ['LESCO Crosscheck Plus', ['Fire ants', 'Big-headed ants', 'Southern chinch bugs', 'Fleas', 'Ticks'], ['ants', 'chinch bugs', 'spiders', 'fleas', 'ticks']],
  ['Talstar P', ['Ghost ants', 'Big-headed ants', 'Fire ants', 'Smokybrown cockroaches', 'Southern chinch bugs'], ['ants', 'spiders', 'roaches', 'fleas', 'ticks', 'chinch bugs']],
  ['Aprehend', ['Bed bugs'], ['bed bugs']],

  // Turf insect control
  ['Topchoice Granular Insecticide', ['Fire ants', 'Tawny mole crickets', 'Fleas', 'Ticks'], ['fire ants', 'fleas', 'ticks', 'mole crickets']],
  ['Acelepryn Insecticide', ['White grubs', 'Tropical sod webworms', 'Fall armyworms', 'Billbugs'], ['grubs', 'caterpillars', 'billbugs']],
  ['Acelepryn Xtra', ['White grubs', 'Tropical sod webworms', 'Fall armyworms', 'Southern chinch bugs'], ['grubs', 'caterpillars', 'chinch bugs']],
  ['Dylox 420 SL T&O Insecticide', ['White grubs', 'Tawny mole crickets', 'Tropical sod webworms'], ['grubs', 'mole crickets', 'sod webworms']],
  ['Arena 50 WDG', ['White grubs', 'Southern chinch bugs'], ['grubs', 'chinch bugs']],
  [
    'Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide',
    ['White grubs', 'Southern chinch bugs'],
    ['grubs', 'chinch bugs'],
  ],
  ['Tetrino Insecticide', ['White grubs', 'Tropical sod webworms', 'Fall armyworms'], ['grubs', 'sod webworms', 'armyworms']],
  ['Merit 2F', ['White grubs', 'Aphids', 'Whiteflies', 'Soft scale insects'], ['grubs', 'aphids', 'whiteflies', 'scale']],

  // Ornamental / tree & shrub
  ['Safari 20 SG', ['Ficus whitefly', 'Rugose spiraling whitefly', 'Scale insects', 'Mealybugs', 'Aphids'], ['whiteflies', 'scale', 'mealybugs', 'aphids']],
  ['Zylam Insecticide', ['Ficus whitefly', 'Rugose spiraling whitefly', 'Scale insects', 'Aphids', 'Leafminers'], ['whiteflies', 'scale', 'aphids', 'leafminers']],
  ['Mainspring GNL Insecticide', ['Chilli thrips', 'Whiteflies', 'Caterpillars', 'Aphids'], ['thrips', 'whiteflies', 'caterpillars', 'aphids']],
  ['Avid Insecticide', ['Spider mites', 'Leafminers'], ['mites', 'leafminers']],
  ['Floramite Miticide 1 qt', ['Twospotted spider mites'], ['spider mites']],
  ['Floramite SC/LS 8 oz', ['Twospotted spider mites'], ['spider mites']],
  ['Forbid 4F', ['Spider mites', 'Broad mites', 'Whiteflies'], ['mites', 'whiteflies']],
  ['Hexygon IQ Miticide', ['Twospotted spider mites'], ['spider mites']],
  ['Kontos Insecticide/Miticide', ['Aphids', 'Ficus whitefly', 'Spider mites', 'Scale insects', 'Mealybugs'], ['aphids', 'whiteflies', 'mites', 'scale', 'mealybugs']],
  ['Conserve SC', ['Caterpillars', 'Chilli thrips', 'Tropical sod webworms'], ['caterpillars', 'thrips', 'sod webworms']],
  ['SuffOil-X Spray Oil Emulsion', ['Scale insects', 'Spider mites', 'Aphids', 'Whiteflies'], ['scale', 'mites', 'aphids', 'whiteflies']],
  ['Distance IGR', ['Ficus whitefly', 'Rugose spiraling whitefly', 'Scale insects'], ['whiteflies', 'scale']],
  ['Talus 70 DF IGR', ['Ficus whitefly', 'Scale insects', 'Mealybugs'], ['whiteflies', 'scale', 'mealybugs']],
  ['Dominion 2L 1 gal', ['Subterranean termites', 'Ghost ants', 'Aphids', 'Whiteflies', 'Scale insects'], ['termites', 'ants', 'aphids', 'whiteflies', 'scale']],
  ['Dominion 2L 27.5 oz', ['Subterranean termites', 'Ghost ants', 'Aphids', 'Whiteflies', 'Scale insects'], ['termites', 'ants', 'aphids', 'whiteflies', 'scale']],
  ['Arborjet Ima-Jet 10', ['Wood borers', 'Aphids', 'Scale insects', 'Whiteflies'], ['borers', 'aphids', 'scale', 'whiteflies']],
  ['Arborjet Ima-Jet Systemic Insecticide', ['Wood borers', 'Aphids', 'Scale insects', 'Whiteflies'], ['borers', 'aphids', 'scale', 'whiteflies']],
  ['Arborjet Tree-Age G-4 Injectable Insecticide', ['Wood borers', 'Caterpillars', 'Spider mites'], ['borers', 'caterpillars', 'mites']],
  ['ArborJet Tree-Age R10 Insecticide', ['Wood borers', 'Caterpillars', 'Spider mites'], ['borers', 'caterpillars', 'mites']],

  // Baits
  ['Advion Ant Bait Gel', ['Ghost ants', 'Big-headed ants', 'Crazy ants', 'Pharaoh ants'], ['ants']],
  ['Advion Evolution Cockroach Gel Bait', ['German cockroaches', 'American cockroaches'], ['roaches']],
  ['Advion Cockroach Gel Bait', ['German cockroaches', 'American cockroaches'], ['roaches']],
  ['Advion Cockroach Gel', ['German cockroaches', 'American cockroaches'], null],
  ['Advion WDG Granular', ['Ghost ants', 'Big-headed ants', 'Crickets', 'Silverfish'], null],
  ['Vendetta Plus', ['German cockroaches'], null],

  // Mosquito
  ['Altosid 30 Day Briquets', ['Mosquito larvae (standing water)'], ['mosquitoes']],
  ['In2Care Mosquito Station', ['Aedes mosquitoes (container breeders)'], ['mosquitoes']],

  // Rodent / mole
  ['Contrac Blox', ['Roof rats', 'Norway rats', 'House mice'], ['rats', 'mice']],
  ['Victor Expanded Trigger Rat Snap Trap', ['Roof rats', 'Norway rats'], ['rats']],
  ['Trapper T-Rex Rat Snap Trap', ['Roof rats', 'Norway rats'], ['rats']],
  ['Talpirid', ['Moles'], null],

  // Termite stations / foam
  ['Trelona ATBS Annual Bait Station', ['Subterranean termites', 'Formosan termites'], ['termites']],
  ['Trelona ATBS Bait Station', ['Subterranean termites', 'Formosan termites'], null],
  ['Trelona Compressed Termite Bait Cartridges', ['Subterranean termites', 'Formosan termites'], ['termites']],
  ['HexPro Termite Monitoring Baiting System', ['Subterranean termites'], ['termites']],
  ['Termidor Foam', ['Subterranean termites', 'Drywood termites', 'Carpenter ants'], null],

  // Lawn herbicides → the weeds they control
  ['Celsius WG', ['Dollarweed', 'Doveweed', 'Chamberbitter', 'Spurge', 'Clover'], null],
  ['Dismiss NXT', ['Yellow nutsedge', 'Purple nutsedge', 'Green kyllinga'], null],
  ['Prodiamine 65 WDG', ['Crabgrass (pre-emergent)', 'Goosegrass (pre-emergent)', 'Annual bluegrass (Poa annua)'], null],
  ['SpeedZone Southern', ['Dollarweed', 'Clover', 'Spurge', 'Chickweed'], null],
  ['LESCO Stonewall 0-0-7', ['Crabgrass (pre-emergent)', 'Goosegrass (pre-emergent)', 'Annual bluegrass (Poa annua)'], null],

  // Lawn fungicides → the turf diseases they suppress
  ['Heritage G', ['Brown patch / large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring'], null],
  ['Pillar G Intrinsic', ['Brown patch / large patch', 'Dollar spot', 'Gray leaf spot'], null],

  // Fertilizers → the nutrition goal of the application
  ['LESCO K-Flow 0-0-25', ['Potassium deficiency', 'Root strength & stress tolerance'], null],
  ['LESCO 24-0-11', ['Nitrogen green-up', 'Color & density', 'Potassium root support'], null],
  ['24-0-11 50% MESA', ['Nitrogen green-up', 'Slow-release feeding', 'Color & density'], null],
  ['LESCO 12-0-0 Chelated Iron Plus', ['Iron chlorosis (yellowing turf)', 'Deep green color'], null],
  ['LESCO Green Flo 6-0-0 10% Ca', ['Nitrogen green-up', 'Calcium deficiency', 'Color & density'], null],
  ['0-0-16 Winterizer', ['Potassium deficiency', 'Root strength & winter hardiness'], null],
  ['16-4-8 + Micros', ['Balanced feeding', 'Nitrogen green-up', 'Micronutrient deficiency'], null],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [name, next, prev] of TARGET_UPGRADES) {
    const query = knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name]);
    if (prev) {
      query.whereRaw(
        "(target_pests IS NULL OR target_pests = '[]'::jsonb OR target_pests = ?::jsonb)",
        [JSON.stringify(prev)],
      );
    } else {
      query.whereRaw("(target_pests IS NULL OR target_pests = '[]'::jsonb)");
    }
    await query.update({
      target_pests: JSON.stringify(next),
      updated_at: new Date(),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [name, next, prev] of TARGET_UPGRADES) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereRaw('target_pests = ?::jsonb', [JSON.stringify(next)])
      .update({
        target_pests: prev ? JSON.stringify(prev) : null,
        updated_at: new Date(),
      });
  }
};
