const VERIFIED_AT = new Date('2026-05-28T00:00:00.000Z');
const VERIFIED_BY = 'inventory-data-completion-batch-1';

const JSON_FIELDS = ['target_pests', 'application_zones'];

const PRODUCT_UPDATES = [
  {
    name: 'Demand CS',
    fields: {
      active_ingredient: 'Lambda-cyhalothrin 9.7%',
      epa_reg_number: '100-1066',
      formulation: 'CS',
      common_name: 'Encapsulated perimeter insecticide',
      portal_summary: 'Applied to exterior perimeter areas and entry points for residual control of crawling insects between regular service visits.',
      public_summary: 'A microencapsulated lambda-cyhalothrin perimeter product used by licensed applicators for residual exterior pest control.',
      customer_safety_summary: 'EPA-registered product applied according to label directions. Treated surfaces should be allowed to dry before normal contact.',
      pet_kid_guidance_text: 'Keep people and pets away from treated surfaces until dry.',
      target_pests: ['ants', 'roaches', 'spiders', 'silverfish', 'centipedes'],
      application_zones: ['exterior perimeter', 'eaves', 'door frames', 'window frames', 'garage threshold'],
      customer_visibility: 'public',
      content_status: 'approved_for_public',
      label_verified_at: VERIFIED_AT,
      label_verified_by: VERIFIED_BY,
      label_source_note: 'EPA PPLS registration 100-1066 lists Demand CS with lambda-cyhalothrin 9.7%.',
    },
  },
  {
    name: 'Alpine WSG',
    fields: {
      active_ingredient: 'Dinotefuran 40.0%',
      epa_reg_number: '499-561',
      formulation: 'WSG',
      label_verified_at: VERIFIED_AT,
      label_verified_by: VERIFIED_BY,
      label_source_note: 'EPA label registration 499-561 lists Alpine WSG with dinotefuran 40.0%.',
    },
  },
  {
    name: 'Bifen I/T',
    fields: {
      active_ingredient: 'Bifenthrin 7.9%',
      epa_reg_number: '53883-118',
      formulation: 'liquid concentrate',
      label_verified_at: VERIFIED_AT,
      label_verified_by: VERIFIED_BY,
      label_source_note: 'EPA label registration 53883-118 lists Bifen I/T as bifenthrin 7.9%.',
    },
  },
  {
    name: 'Suspend Polyzone',
    fields: {
      active_ingredient: 'Deltamethrin 4.75%',
      epa_reg_number: '432-1514',
      formulation: 'SC',
      label_verified_at: VERIFIED_AT,
      label_verified_by: VERIFIED_BY,
      label_source_note: 'EPA PPLS registration 432-1514 lists Suspend PolyZone with deltamethrin 4.75%.',
    },
  },
  {
    name: 'Gentrol IGR',
    fields: {
      active_ingredient: '(S)-Hydroprene 9.0%',
      epa_reg_number: '2724-351',
      formulation: 'concentrate',
      label_verified_at: VERIFIED_AT,
      label_verified_by: VERIFIED_BY,
      label_source_note: 'Manufacturer label page lists Gentrol IGR Concentrate as EPA Reg. 2724-351 with 9% (S)-hydroprene.',
    },
  },
  {
    name: 'Termidor SC',
    fields: {
      active_ingredient: 'Fipronil 9.1%',
      epa_reg_number: '7969-210',
      formulation: 'SC',
      label_verified_at: VERIFIED_AT,
      label_verified_by: VERIFIED_BY,
      label_source_note: 'EPA label registration 7969-210 lists Termidor SC with fipronil 9.1%.',
    },
  },
  {
    name: 'Celsius WG',
    fields: {
      formulation: 'WG',
    },
  },
  {
    name: 'Dismiss NXT',
    fields: {
      formulation: 'SC',
    },
  },
  {
    name: 'Prodiamine 65 WDG',
    fields: {
      formulation: 'WDG',
    },
  },
  {
    name: 'Cyzmic CS',
    fields: {
      formulation: 'CS',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Encapsulated residual insecticide',
      portal_summary: 'Applied to targeted exterior pest-pressure areas where a long-lasting residual product is appropriate.',
      customer_safety_summary: 'Applied by licensed technicians according to label directions. Treated areas should dry before normal use.',
      pet_kid_guidance_text: 'Keep people and pets away from treated surfaces until dry.',
      target_pests: ['ants', 'roaches', 'spiders', 'mosquitoes'],
      application_zones: ['exterior perimeter', 'foliage edge', 'entry points'],
    },
  },
  {
    name: 'Advion WDG Granular',
    fields: {
      formulation: 'granular bait',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Professional granular insect bait',
      portal_summary: 'Applied in targeted exterior areas where insect foraging activity supports bait placement.',
      customer_safety_summary: 'Used in controlled placements by licensed technicians according to product label directions.',
      pet_kid_guidance_text: 'Avoid disturbing treated bait placement areas.',
      target_pests: ['ants', 'roaches'],
      application_zones: ['exterior cracks', 'landscape edges', 'foraging paths'],
    },
  },
  {
    name: 'Atticus Talak',
    fields: {
      category: 'insecticide',
      formulation: 'liquid concentrate',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Bifenthrin perimeter insecticide',
      portal_summary: 'Applied to exterior perimeter and lawn-adjacent pest-pressure areas for broad-spectrum residual control.',
      customer_safety_summary: 'Applied according to label directions by licensed technicians. Allow treated areas to dry before normal contact.',
      pet_kid_guidance_text: 'Keep people and pets off treated areas until dry.',
      target_pests: ['ants', 'roaches', 'spiders', 'fleas', 'ticks'],
      application_zones: ['exterior perimeter', 'foundation', 'lawn edge'],
    },
  },
  {
    name: 'Scion Insecticide',
    fields: {
      category: 'insecticide',
      formulation: 'CS',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Professional residual insecticide',
      portal_summary: 'Applied to targeted exterior pest-pressure zones for residual control where a professional encapsulated product is appropriate.',
      customer_safety_summary: 'Applied by licensed technicians according to label directions. Allow treated areas to dry before normal contact.',
      pet_kid_guidance_text: 'Keep people and pets away from treated surfaces until dry.',
      target_pests: ['ants', 'roaches', 'spiders', 'mosquitoes'],
      application_zones: ['exterior perimeter', 'entry points', 'harborage areas'],
    },
  },
  {
    name: 'Advion Cockroach Gel',
    fields: {
      formulation: 'gel',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Professional roach gel bait',
      portal_summary: 'Placed in small targeted spots near cockroach harborage and foraging routes.',
      customer_safety_summary: 'Used in precise placements rather than broadcast over open surfaces.',
      pet_kid_guidance_text: 'Placements are made in cracks, crevices, and inaccessible areas. Do not disturb bait placements.',
      target_pests: ['cockroaches'],
      application_zones: ['cracks and crevices', 'behind appliances', 'utility areas'],
    },
  },
  {
    name: 'Heritage G',
    fields: {
      formulation: 'granular',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Granular turf fungicide',
      portal_summary: 'Applied to turf when disease pressure or seasonal conditions call for fungus protection.',
      customer_safety_summary: 'Applied by licensed technicians according to label directions and turf conditions.',
      pet_kid_guidance_text: 'Keep people and pets off treated lawn until product has settled or been watered in as directed.',
      target_pests: ['turf disease'],
      application_zones: ['lawn', 'turf'],
    },
  },
  {
    name: 'Pillar G Intrinsic',
    fields: {
      formulation: 'granular',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Granular turf fungicide',
      portal_summary: 'Applied to turf for disease-pressure management and plant-health support when conditions warrant.',
      customer_safety_summary: 'Applied by licensed technicians according to label directions and turf conditions.',
      pet_kid_guidance_text: 'Keep people and pets off treated lawn until product has settled or been watered in as directed.',
      target_pests: ['turf disease'],
      application_zones: ['lawn', 'turf'],
    },
  },
  {
    name: 'LESCO Stonewall 0-0-7',
    fields: {
      formulation: 'granular',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Granular pre-emergent with potash',
      portal_summary: 'Applied to turf as part of pre-emergent weed prevention and seasonal potassium support.',
      customer_safety_summary: 'Applied by licensed technicians according to label directions and turf needs.',
      pet_kid_guidance_text: 'Keep people and pets off treated lawn until product has settled or been watered in as directed.',
      target_pests: ['annual grassy weeds', 'broadleaf weeds'],
      application_zones: ['lawn', 'turf'],
    },
  },
  {
    name: 'Talpirid',
    fields: {
      formulation: 'bait',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Mole bait',
      portal_summary: 'Placed in active mole tunnels where technician inspection confirms suitable bait placement.',
      customer_safety_summary: 'Used only in targeted subsurface placements according to label directions.',
      pet_kid_guidance_text: 'Do not disturb marked or recently treated mole tunnel areas.',
      target_pests: ['moles'],
      application_zones: ['active mole tunnels', 'lawn'],
    },
  },
  {
    name: 'Vendetta Plus',
    fields: {
      formulation: 'gel',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Roach gel bait with IGR',
      portal_summary: 'Placed in targeted cracks, crevices, and harborage areas for cockroach control.',
      customer_safety_summary: 'Used in small controlled placements rather than broadcast over open surfaces.',
      pet_kid_guidance_text: 'Do not disturb bait placements. Placements are made in areas selected to reduce access.',
      target_pests: ['cockroaches'],
      application_zones: ['cracks and crevices', 'behind appliances', 'utility areas'],
    },
  },
  {
    name: 'Termidor Foam',
    fields: {
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Termite foam treatment',
      portal_summary: 'Applied into targeted voids or termite galleries where foam placement helps reach concealed activity.',
      customer_safety_summary: 'Applied by licensed technicians into targeted treatment areas according to label directions.',
      pet_kid_guidance_text: 'Avoid treated drill sites or access points until the technician confirms the area is complete and dry.',
      target_pests: ['subterranean termites', 'drywood termites'],
      application_zones: ['wall voids', 'termite galleries', 'targeted drill points'],
    },
  },
  {
    name: 'Trelona ATBS Bait Station',
    fields: {
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Termite bait station',
      portal_summary: 'Installed or serviced as an in-ground termite bait station around the structure perimeter.',
      customer_safety_summary: 'Bait is contained inside a station and serviced by trained technicians.',
      pet_kid_guidance_text: 'Do not open, move, or disturb termite bait stations.',
      target_pests: ['subterranean termites'],
      application_zones: ['exterior perimeter', 'in-ground station'],
    },
  },
  {
    name: '0-0-16 Winterizer',
    fields: {
      active_ingredient: 'Potash fertilizer',
      epa_reg_number: 'Not EPA-registered fertilizer',
      formulation: 'granular',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Potassium winterizer fertilizer',
      portal_summary: 'Applied to support turf stress tolerance and potassium needs during seasonal transitions.',
      customer_safety_summary: 'Fertilizer product applied according to local turf conditions and label directions.',
      pet_kid_guidance_text: 'Keep people and pets off treated lawn until product has settled or been watered in as directed.',
      target_pests: [],
      application_zones: ['lawn', 'turf'],
    },
  },
  {
    name: '16-4-8 + Micros',
    fields: {
      active_ingredient: 'Nitrogen, phosphate, potash, and micronutrients',
      epa_reg_number: 'Not EPA-registered fertilizer',
      formulation: 'granular',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Balanced turf fertilizer with micronutrients',
      portal_summary: 'Applied to support turf color, density, and nutrient balance during the growing season.',
      customer_safety_summary: 'Fertilizer product applied according to turf needs and local conditions.',
      pet_kid_guidance_text: 'Keep people and pets off treated lawn until product has settled or been watered in as directed.',
      target_pests: [],
      application_zones: ['lawn', 'turf'],
    },
  },
  {
    name: '24-0-11 50% MESA',
    fields: {
      active_ingredient: 'Nitrogen and potash fertilizer',
      epa_reg_number: 'Not EPA-registered fertilizer',
      formulation: 'granular',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Slow-release turf fertilizer',
      portal_summary: 'Applied to support steady turf color and density with controlled nitrogen release.',
      customer_safety_summary: 'Fertilizer product applied according to turf needs and local conditions.',
      pet_kid_guidance_text: 'Keep people and pets off treated lawn until product has settled or been watered in as directed.',
      target_pests: [],
      application_zones: ['lawn', 'turf'],
    },
  },
  {
    name: 'Chelated Iron 6%',
    fields: {
      active_ingredient: 'Chelated iron',
      epa_reg_number: 'Not EPA-registered fertilizer',
      formulation: 'liquid',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Chelated iron turf supplement',
      portal_summary: 'Applied to support turf color where iron response is appropriate.',
      customer_safety_summary: 'Turf supplement applied according to label directions and site conditions.',
      pet_kid_guidance_text: 'Keep people and pets off treated lawn until spray has dried.',
      target_pests: [],
      application_zones: ['lawn', 'turf'],
    },
  },
  {
    name: 'FeSO4 Foliar',
    fields: {
      epa_reg_number: 'Not EPA-registered fertilizer',
      formulation: 'liquid',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Foliar iron supplement',
      portal_summary: 'Applied as a foliar iron treatment to support turf color response.',
      customer_safety_summary: 'Turf supplement applied according to label directions and site conditions.',
      pet_kid_guidance_text: 'Keep people and pets off treated lawn until spray has dried.',
      target_pests: [],
      application_zones: ['lawn', 'turf'],
    },
  },
  {
    name: 'Non-ionic Surfactant',
    fields: {
      active_ingredient: 'Non-ionic surfactant blend',
      epa_reg_number: 'Adjuvant - no EPA reg',
      formulation: 'liquid',
      customer_visibility: 'internal_only',
      content_status: 'approved_for_portal',
      common_name: 'Spray adjuvant',
      portal_summary: 'Used as a spray adjuvant when the product label calls for improved coverage or leaf-surface contact.',
      customer_safety_summary: 'Used only as directed with compatible labeled products.',
      pet_kid_guidance_text: 'Follow the same re-entry guidance as the accompanying treatment product.',
      target_pests: [],
      application_zones: ['tank mix'],
    },
  },
  {
    name: 'Trapper T-Rex Rat Snap Trap',
    fields: {
      active_ingredient: 'Mechanical snap trap',
      epa_reg_number: 'Device - no EPA pesticide registration',
      formulation: 'trap',
    },
  },
  {
    name: 'Race Prod',
    fields: {
      active: false,
      category: 'test',
      active_ingredient: 'Test product',
      epa_reg_number: 'N/A',
      formulation: 'test',
      customer_visibility: 'internal_only',
      content_status: 'retired',
    },
  },
];

async function updateProduct(knex, name, fields) {
  const updates = { ...fields, updated_at: new Date() };
  for (const field of JSON_FIELDS) {
    if (updates[field] !== undefined) updates[field] = JSON.stringify(updates[field]);
  }
  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [name])
    .update(updates);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const product of PRODUCT_UPDATES) {
    await updateProduct(knex, product.name, product.fields);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  await knex('products_catalog')
    .where({ label_verified_by: VERIFIED_BY })
    .update({
      label_verified_at: null,
      label_verified_by: null,
      label_source_note: null,
      updated_at: new Date(),
    });
};
