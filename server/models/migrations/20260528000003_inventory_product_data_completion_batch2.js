const VERIFIED_AT = new Date('2026-05-28T00:00:00.000Z');
const VERIFIED_BY = 'inventory-data-completion-batch-2';

const JSON_FIELDS = ['target_pests', 'application_zones'];

const PRODUCT_UPDATES = [
  {
    name: 'Bora-Care',
    fields: {
      active_ingredient: 'Disodium octaborate tetrahydrate 40.0%',
      epa_reg_number: '64405-1',
      formulation: 'liquid',
      label_verified_at: VERIFIED_AT,
      label_verified_by: VERIFIED_BY,
      label_source_note: 'EPA PPLS registration 64405-1 lists Bora-Care with boron sodium oxide/disodium octaborate tetrahydrate 40%.',
    },
  },
  {
    name: 'Contrac Blox',
    fields: {
      active_ingredient: 'Bromadiolone 0.005%',
      epa_reg_number: '12455-79',
      formulation: 'bait block',
      label_verified_at: VERIFIED_AT,
      label_verified_by: VERIFIED_BY,
      label_source_note: 'EPA label registration 12455-79 lists Contrac All-Weather Blox with bromadiolone 0.005%.',
    },
  },
  {
    name: 'Cyzmic CS',
    fields: {
      active_ingredient: 'Lambda-cyhalothrin 9.7%',
      epa_reg_number: '53883-389',
      formulation: 'CS',
      label_verified_at: VERIFIED_AT,
      label_verified_by: VERIFIED_BY,
      label_source_note: 'Current manufacturer product page lists Cyzmic CS with EPA Reg. 53883-389 and lambda-cyhalothrin 9.7%.',
    },
  },
  {
    name: 'Prodiamine 65 WDG',
    fields: {
      active_ingredient: 'Prodiamine 65.0%',
      epa_reg_number: '66222-89',
      formulation: 'WDG',
      label_verified_at: VERIFIED_AT,
      label_verified_by: VERIFIED_BY,
      label_source_note: 'EPA label registration 66222-89 lists Prodiamine 65 WDG with prodiamine 65.0%.',
    },
  },
  {
    name: 'Advance Termite Bait Station',
    fields: {
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Termite bait station',
      portal_summary: 'Installed or serviced as an in-ground termite monitoring and bait station around the structure perimeter.',
      customer_safety_summary: 'Bait is contained inside a station and serviced by trained technicians.',
      pet_kid_guidance_text: 'Do not open, move, or disturb termite bait stations.',
      target_pests: ['subterranean termites'],
      application_zones: ['exterior perimeter', 'in-ground station'],
    },
  },
  {
    name: 'LESCO 12-0-0 Chelated Iron Plus',
    fields: {
      epa_reg_number: 'Not EPA-registered fertilizer',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Chelated iron and nitrogen turf supplement',
      portal_summary: 'Applied as a foliar turf supplement to support color response where iron and nitrogen are appropriate.',
      customer_safety_summary: 'Turf supplement applied according to label directions and site conditions.',
      pet_kid_guidance_text: 'Keep people and pets off treated lawn until spray has dried.',
      target_pests: [],
      application_zones: ['lawn', 'turf'],
    },
  },
  {
    name: 'Summit Mosquito Dunk Tablets',
    fields: {
      formulation: 'tablet',
      customer_visibility: 'portal_only',
      content_status: 'approved_for_portal',
      common_name: 'Mosquito larvicide tablet',
      portal_summary: 'Placed in appropriate standing-water sites to target mosquito larvae before they become biting adults.',
      customer_safety_summary: 'Used only in suitable water-holding areas according to label directions.',
      pet_kid_guidance_text: 'Do not disturb treated water sites or tablets.',
      target_pests: ['mosquito larvae'],
      application_zones: ['standing water', 'drainage areas', 'water-holding containers'],
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
