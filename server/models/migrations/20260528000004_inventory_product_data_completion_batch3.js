const VERIFIED_AT = new Date('2026-05-28T00:00:00.000Z');
const VERIFIED_BY = 'inventory-data-completion-batch-3';

const PRODUCT_UPDATES = [
  {
    name: 'Advance Termite Bait Station',
    fields: {
      active_ingredient: 'Diflubenzuron 0.25%',
      epa_reg_number: '499-488',
      formulation: 'termite bait station',
      label_source_note: 'EPA/label references for Advance termite bait station list diflubenzuron 0.25% under EPA Reg. 499-488.',
    },
  },
  {
    name: 'Advion Cockroach Gel',
    fields: {
      active_ingredient: 'Indoxacarb 0.6%',
      epa_reg_number: '100-1484',
      formulation: 'gel bait',
      label_source_note: 'EPA/label references for Advion Cockroach Gel Bait list indoxacarb 0.6% under EPA Reg. 100-1484.',
    },
  },
  {
    name: 'Advion Cockroach Gel Bait',
    fields: {
      active_ingredient: 'Indoxacarb 0.6%',
      epa_reg_number: '100-1484',
      formulation: 'gel bait',
      label_source_note: 'EPA/label references for Advion Cockroach Gel Bait list indoxacarb 0.6% under EPA Reg. 100-1484.',
    },
  },
  {
    name: 'Advion WDG Granular',
    fields: {
      active_ingredient: 'Indoxacarb 0.22%',
      epa_reg_number: '100-1483',
      formulation: 'granular bait',
      label_source_note: 'EPA/label references for Advion Insect Granule list indoxacarb 0.22% under EPA Reg. 100-1483.',
    },
  },
  {
    name: 'Atticus Talak',
    fields: {
      active_ingredient: 'Bifenthrin 7.9%',
      epa_reg_number: '91234-145',
      formulation: 'SC',
      label_source_note: 'Manufacturer label references for Talak 7.9 F list bifenthrin 7.9% under EPA Reg. 91234-145.',
    },
  },
  {
    name: 'Headway G',
    fields: {
      active_ingredient: 'Azoxystrobin 0.31% + Propiconazole 0.75%',
      epa_reg_number: '100-1378',
      formulation: 'granular',
      label_source_note: 'EPA/label references for Headway G list azoxystrobin 0.31% and propiconazole 0.75% under EPA Reg. 100-1378.',
    },
  },
  {
    name: 'Heritage G',
    fields: {
      active_ingredient: 'Azoxystrobin 0.31%',
      epa_reg_number: '100-1093',
      formulation: 'granular',
      label_source_note: 'EPA/label references for Heritage G list azoxystrobin 0.31% under EPA Reg. 100-1093.',
    },
  },
  {
    name: 'In2Care Mosquito Station',
    fields: {
      active_ingredient: 'Beauveria bassiana spores + Pyriproxyfen',
      epa_reg_number: '91720-1',
      formulation: 'station refill',
      label_source_note: 'EPA/label references for In2Care Mosquito Station list Beauveria bassiana spores and pyriproxyfen under EPA Reg. 91720-1.',
    },
  },
  {
    name: 'LESCO 24-0-11',
    fields: {
      active_ingredient: 'Nitrogen and potash fertilizer',
      epa_reg_number: 'Not EPA-registered fertilizer',
      formulation: 'granular',
      label_source_note: 'Fertilizer product; EPA registration is not expected for the fertilizer row.',
    },
  },
  {
    name: 'LESCO Stonewall 0-0-7',
    fields: {
      active_ingredient: 'Prodiamine 0.43%',
      epa_reg_number: '10404-117',
      formulation: 'granular',
      label_source_note: 'LESCO Stonewall 0-0-7 label references list prodiamine 0.43% under EPA Reg. 10404-117.',
    },
  },
  {
    name: 'Pillar G Intrinsic',
    fields: {
      active_ingredient: 'Pyraclostrobin 0.38% + Triticonazole 0.43%',
      epa_reg_number: '7969-295',
      formulation: 'granular',
      label_source_note: 'EPA/label references for Pillar G Intrinsic list pyraclostrobin 0.38% and triticonazole 0.43% under EPA Reg. 7969-295.',
    },
  },
  {
    name: 'Scion Insecticide',
    fields: {
      active_ingredient: 'Gamma-cyhalothrin 5.9%',
      epa_reg_number: '279-3624',
      formulation: 'CS',
      label_source_note: 'EPA/label references for Scion Insecticide with UVX Technology list gamma-cyhalothrin 5.9% under EPA Reg. 279-3624.',
    },
  },
  {
    name: 'Summit Mosquito Dunk Tablets',
    fields: {
      active_ingredient: 'Bacillus thuringiensis subsp. israelensis solids',
      epa_reg_number: '6218-47',
      formulation: 'tablet',
      label_source_note: 'EPA/label references for Summit Mosquito Dunks list Bti solids under EPA Reg. 6218-47.',
    },
  },
  {
    name: 'Talpirid',
    fields: {
      active_ingredient: 'Bromethalin 0.025%',
      epa_reg_number: '12455-101',
      formulation: 'worm bait',
      label_source_note: 'EPA/label references for Talpirid Mole Bait list bromethalin 0.025% under EPA Reg. 12455-101.',
    },
  },
  {
    name: 'Tekko Pro IGR',
    fields: {
      active_ingredient: 'Pyriproxyfen 1.3% + Novaluron 1.3%',
      epa_reg_number: '53883-335',
      formulation: 'emulsifiable concentrate',
      label_source_note: 'EPA/label references for Tekko Pro list pyriproxyfen 1.3% and novaluron 1.3% under EPA Reg. 53883-335.',
    },
  },
  {
    name: 'Termidor Foam',
    fields: {
      active_ingredient: 'Fipronil 0.005%',
      epa_reg_number: '499-563',
      formulation: 'foam',
      label_source_note: 'EPA/label references for Termidor Foam list fipronil 0.005% under EPA Reg. 499-563.',
    },
  },
  {
    name: 'Trelona ATBS',
    fields: {
      active_ingredient: 'Novaluron 0.5%',
      epa_reg_number: '499-557',
      formulation: 'termite bait',
      label_source_note: 'EPA/label references for Trelona ATBS Annual Bait Stations list novaluron 0.5% under EPA Reg. 499-557.',
    },
  },
  {
    name: 'Trelona ATBS Bait Station',
    fields: {
      active_ingredient: 'Novaluron 0.5%',
      epa_reg_number: '499-557',
      formulation: 'termite bait station',
      label_source_note: 'EPA/label references for Trelona ATBS Annual Bait Stations list novaluron 0.5% under EPA Reg. 499-557.',
    },
  },
  {
    name: 'Vendetta Plus',
    fields: {
      active_ingredient: 'Abamectin 0.05% + Pyriproxyfen 0.5%',
      epa_reg_number: '1021-1828',
      formulation: 'gel bait',
      label_source_note: 'EPA/label references for Vendetta Plus list abamectin 0.05% and pyriproxyfen 0.5% under EPA Reg. 1021-1828.',
    },
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const product of PRODUCT_UPDATES) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [product.name])
      .update({
        ...product.fields,
        label_verified_at: VERIFIED_AT,
        label_verified_by: VERIFIED_BY,
        updated_at: new Date(),
      });
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
