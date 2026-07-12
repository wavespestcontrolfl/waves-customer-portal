// Completion-screen target prefill coverage: the products-applied card
// prefills its Targets chips from products_catalog.target_pests, but most
// pest-treatment rows never got a list (only a handful were covered by the
// 20260528 inventory data-completion batches), so the tech types targets
// from scratch on nearly every pest visit. Backfills label-derived target
// lists for the pest/termite/rodent/mosquito treatment products that are
// missing one.
//
// Data rules:
// - Only rows whose target_pests is NULL or [] are touched — an
//   admin-edited list is never overwritten.
// - Adjuvants/surfactants, fertilizers, and lawn herbicide/fungicide rows
//   are intentionally absent: they either have nothing to "target" or take
//   weed/disease targets that the lawn flow handles separately.
// - down() reverts a row only when its current value is exactly what this
//   migration wrote, so later admin edits survive a rollback.

const TARGET_PREFILL = [
  // General-pest liquids / dusts
  ['Bifen I/T', ['ants', 'spiders', 'roaches', 'wasps', 'centipedes', 'mosquitoes']],
  ['Bifen XTS', ['ants', 'spiders', 'roaches', 'mosquitoes', 'fleas', 'ticks']],
  ['Taurus SC', ['termites', 'ants', 'spiders', 'roaches', 'centipedes']],
  ['Termidor SC', ['termites', 'ants']],
  ['Bora-Care', ['termites', 'carpenter ants', 'wood-boring beetles']],
  ['Suspend SC', ['ants', 'spiders', 'roaches', 'fleas', 'wasps']],
  ['Suspend Polyzone', ['ants', 'spiders', 'roaches', 'flies', 'mosquitoes']],
  ['Demand CS Insecticide', ['ants', 'roaches', 'spiders', 'silverfish', 'centipedes']],
  ['Onslaught Fastcap', ['spiders', 'scorpions', 'ants', 'roaches']],
  ['Permethrin SFR', ['ants', 'roaches', 'spiders', 'fleas', 'ticks', 'termites']],
  ['Temprid FX', ['ants', 'spiders', 'roaches', 'wasps', 'bed bugs']],
  ['Alpine WSG', ['ants', 'roaches', 'flies', 'bed bugs']],
  ['Delta Dust', ['ants', 'roaches', 'wasps', 'silverfish', 'bed bugs']],
  ['Elector PSP', ['flies', 'beetles']],
  ['Gentrol IGR', ['roaches', 'drain flies', 'pantry pests']],
  ['Tekko Pro IGR', ['roaches', 'fleas', 'flies', 'mosquitoes']],
  ['LESCO Crosscheck Plus', ['ants', 'chinch bugs', 'spiders', 'fleas', 'ticks']],
  ['Talstar P', ['ants', 'spiders', 'roaches', 'fleas', 'ticks', 'chinch bugs']],
  ['Aprehend', ['bed bugs']],

  // Turf insect control
  ['Topchoice Granular Insecticide', ['fire ants', 'fleas', 'ticks', 'mole crickets']],
  ['Acelepryn Insecticide', ['grubs', 'caterpillars', 'billbugs']],
  ['Acelepryn Xtra', ['grubs', 'caterpillars', 'chinch bugs']],
  ['Dylox 420 SL T&O Insecticide', ['grubs', 'mole crickets', 'sod webworms']],
  ['Arena 50 WDG', ['grubs', 'chinch bugs']],
  [
    'Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide',
    ['grubs', 'chinch bugs'],
  ],
  ['Tetrino Insecticide', ['grubs', 'sod webworms', 'armyworms']],
  ['Merit 2F', ['grubs', 'aphids', 'whiteflies', 'scale']],

  // Ornamental / tree & shrub
  ['Safari 20 SG', ['whiteflies', 'scale', 'mealybugs', 'aphids']],
  ['Zylam Insecticide', ['whiteflies', 'scale', 'aphids', 'leafminers']],
  ['Mainspring GNL Insecticide', ['thrips', 'whiteflies', 'caterpillars', 'aphids']],
  ['Avid Insecticide', ['mites', 'leafminers']],
  ['Floramite Miticide 1 qt', ['spider mites']],
  ['Floramite SC/LS 8 oz', ['spider mites']],
  ['Forbid 4F', ['mites', 'whiteflies']],
  ['Hexygon IQ Miticide', ['spider mites']],
  ['Kontos Insecticide/Miticide', ['aphids', 'whiteflies', 'mites', 'scale', 'mealybugs']],
  ['Conserve SC', ['caterpillars', 'thrips', 'sod webworms']],
  ['SuffOil-X Spray Oil Emulsion', ['scale', 'mites', 'aphids', 'whiteflies']],
  ['Distance IGR', ['whiteflies', 'scale']],
  ['Talus 70 DF IGR', ['whiteflies', 'scale', 'mealybugs']],
  ['Dominion 2L 1 gal', ['termites', 'ants', 'aphids', 'whiteflies', 'scale']],
  ['Dominion 2L 27.5 oz', ['termites', 'ants', 'aphids', 'whiteflies', 'scale']],
  ['Arborjet Ima-Jet 10', ['borers', 'aphids', 'scale', 'whiteflies']],
  ['Arborjet Ima-Jet Systemic Insecticide', ['borers', 'aphids', 'scale', 'whiteflies']],
  ['Arborjet Tree-Age G-4 Injectable Insecticide', ['borers', 'caterpillars', 'mites']],
  ['ArborJet Tree-Age R10 Insecticide', ['borers', 'caterpillars', 'mites']],

  // Baits
  ['Advion Ant Bait Gel', ['ants']],
  ['Advion Evolution Cockroach Gel Bait', ['roaches']],
  ['Advion Cockroach Gel Bait', ['roaches']],

  // Mosquito
  ['Altosid 30 Day Briquets', ['mosquitoes']],
  ['In2Care Mosquito Station', ['mosquitoes']],

  // Rodent
  ['Contrac Blox', ['rats', 'mice']],
  ['Victor Expanded Trigger Rat Snap Trap', ['rats']],
  ['Trapper T-Rex Rat Snap Trap', ['rats']],

  // Termite stations / monitoring
  ['Trelona ATBS Annual Bait Station', ['termites']],
  ['Trelona Compressed Termite Bait Cartridges', ['termites']],
  ['HexPro Termite Monitoring Baiting System', ['termites']],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [name, targets] of TARGET_PREFILL) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereRaw("(target_pests IS NULL OR target_pests = '[]'::jsonb)")
      .update({
        target_pests: JSON.stringify(targets),
        updated_at: new Date(),
      });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [name, targets] of TARGET_PREFILL) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereRaw('target_pests = ?::jsonb', [JSON.stringify(targets)])
      .update({
        target_pests: null,
        updated_at: new Date(),
      });
  }
};
