const { randomUUID } = require('crypto');

const VERIFIED_AT = '2026-05-30';

const CUSTOMER_PRECAUTION_PESTICIDE = 'When this pesticide product is used, the technician follows the product label and service report instructions. People and pets should remain off treated areas until the application has dried, unless the label or technician instructions require a longer interval.';
const REENTRY_PESTICIDE = 'Follow the product label and technician service report before re-entering treated areas.';
const CUSTOMER_PRECAUTION_SUPPORT = 'When this support product is used, follow the technician service report for watering, access, or other customer action items.';
const REENTRY_SUPPORT = 'Follow the technician service report for any product-specific instructions.';
const NON_PESTICIDE_EPA_PLACEHOLDER = 'N/A';

const FACTS = [
  {
    aliases: ['Sedgehammer Plus', 'SedgeHammer Plus', 'Sedgehammer'],
    name: 'Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide',
    category: 'herbicide',
    product_type: 'pesticide',
    manufacturer: 'Gowan',
    active_ingredient: 'Halosulfuron-methyl 5%',
    epa_reg_number: '81880-24',
    label_source_url: 'https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102::::::P102_REG_NUM:81880-24',
    label_version: 'EPA PPLS SEDGEHAMMER+ accepted label record',
    public_summary: 'SedgeHammer Plus may be used for sedge pressure when turf type, season, site conditions, label directions, and local rules allow.',
    service_report_summary: 'SedgeHammer Plus was used for targeted sedge control according to label directions and the technician service notes.',
    use_conditions: 'Sedge control only when technician assessment, turf compatibility, weather, label directions, and local rules support treatment.',
    approve: true,
  },
  {
    aliases: ['Medallion SC', 'Medallion'],
    name: 'Medallion SC',
    category: 'fungicide',
    product_type: 'pesticide',
    manufacturer: 'Syngenta',
    active_ingredient: 'Fludioxonil',
    epa_reg_number: '100-1448',
    label_source_url: 'https://www.greencastonline.com/labels/medallion-sc',
    label_version: 'Syngenta Greencast current EPA-approved label page',
    public_summary: 'Medallion SC may be used as a fungicide rotation option when turf disease activity or history supports treatment and label directions allow.',
    service_report_summary: 'Medallion SC was used as a fungicide application according to label directions and the technician service notes.',
    use_conditions: 'Disease treatment or prevention only when turf type, disease pressure, rotation plan, label directions, and local rules support treatment.',
    approve: true,
  },
  {
    aliases: ['Armada 50 WDG', 'Armada'],
    name: 'Armada 50 WDG',
    category: 'fungicide',
    product_type: 'pesticide',
    manufacturer: 'Envu',
    active_ingredient: 'Triadimefon + Trifloxystrobin',
    epa_reg_number: '101563-142',
    label_source_url: 'https://www3.epa.gov/pesticides/chem_search/ppls/101563-00142-20250724.pdf',
    label_version: 'EPA accepted label amendment record',
    public_summary: 'Armada 50 WDG may be used as part of a fungicide rotation where disease risk, turf type, label directions, and local rules support treatment.',
    service_report_summary: 'Armada 50 WDG was used as a fungicide application according to label directions and the technician service notes.',
    use_conditions: 'Fungicide rotation only when technician assessment, disease history, turf compatibility, label directions, and local rules support treatment.',
    approve: true,
  },
  {
    aliases: ['Torque SC', 'Torque'],
    name: 'Torque SC',
    category: 'fungicide',
    product_type: 'pesticide',
    manufacturer: 'Nufarm',
    active_ingredient: 'Tebuconazole 38.7%',
    epa_reg_number: '1001-87',
    label_source_url: 'https://nufarm.com/usst/product/torque/torque-2/',
    label_version: 'Nufarm Torque product label page',
    public_summary: 'Torque SC may be used as a fungicide rotation option where disease risk, turf type, label directions, and local rules support treatment.',
    service_report_summary: 'Torque SC was used as a fungicide application according to label directions and the technician service notes.',
    use_conditions: 'Disease treatment or prevention only when technician assessment, rotation plan, label directions, and local rules support treatment.',
    approve: true,
  },
  {
    aliases: ['Drive XLR8'],
    name: 'Drive XLR8 Herbicide Crabgrass Killer',
    category: 'herbicide',
    product_type: 'pesticide',
    manufacturer: 'BASF',
    active_ingredient: 'Quinclorac',
    epa_reg_number: '7969-272',
    label_source_url: 'https://www3.epa.gov/pesticides/chem_search/ppls/007969-00272-20191101.pdf',
    label_version: 'EPA accepted label mitigation record',
    public_summary: 'Drive XLR8 may be used for crabgrass breakthrough where the turf type, weed stage, weather, label directions, and local rules support treatment.',
    service_report_summary: 'Drive XLR8 was used for targeted crabgrass control according to label directions and the technician service notes.',
    use_conditions: 'Crabgrass control only when turf compatibility, weed pressure, weather, label directions, and local rules support treatment.',
    approve: true,
  },
  {
    aliases: ['Arena 50 WDG', 'Arena'],
    name: 'Arena 50 WDG',
    category: 'insecticide',
    product_type: 'pesticide',
    manufacturer: 'Valent',
    active_ingredient: 'Clothianidin 50%',
    epa_reg_number: '59639-152',
    label_source_url: 'https://labelsds.com/view-product?company_uuid=440fc9fc-b9b0-4cbf-b237-84b6ad4d8bf7&product=58',
    label_version: 'LabelSDS product label record',
    public_summary: 'Arena 50 WDG may be used as an insecticide rotation option when pest pressure, prior treatment response, label directions, and local rules support treatment.',
    service_report_summary: 'Arena 50 WDG was used as an insecticide application according to label directions and the technician service notes.',
    use_conditions: 'Insect treatment only when pest pressure, mode-of-action rotation, label directions, and local rules support treatment.',
    approve: false,
  },
  {
    aliases: ['Topchoice Granular Insecticide', 'Topchoice'],
    name: 'Topchoice Granular Insecticide',
    category: 'insecticide',
    product_type: 'pesticide',
    manufacturer: 'Bayer / Envu',
    active_ingredient: 'Fipronil 0.0143%',
    epa_reg_number: '432-1217',
    label_source_url: 'https://www.epa.gov/sites/default/files/2017-10/documents/rup-report-oct2017.pdf',
    label_version: 'EPA restricted-use product summary report',
    public_summary: 'Topchoice may be used for documented fire ant history where restricted-use requirements, label directions, site conditions, and local rules allow.',
    service_report_summary: 'Topchoice was used for fire ant management according to label directions, restricted-use requirements, and technician service notes.',
    use_conditions: 'Restricted-use fire ant product. Use only when licensing, site history, label directions, and local rules support treatment.',
    approve: true,
  },
  {
    aliases: ['LESCO CarbonPro-L', 'CarbonPro-L', 'CarbonPro'],
    name: 'LESCO CarbonPro-L w/ MobilEX Biostimulant Liquid Soil Amendment',
    category: 'soil_amendment',
    product_type: 'biostimulant',
    manufacturer: 'LESCO / SiteOne',
    active_ingredient: 'Humic substances, kelp extract, chelated iron',
    epa_reg_number: null,
    label_source_url: 'https://www.siteone.com/en/510894-lesco-carbonpro-l-w-mobilex-biostimulant-liquid-soil-amendment-1-gal-jug-qgcy/p/626427',
    label_version: 'SiteOne product information and label page',
    public_summary: 'CarbonPro-L may be used as soil and root support where the lawn would benefit from biostimulant support, nutrient-use support, or stress recovery support.',
    service_report_summary: 'CarbonPro-L was used as a soil-support or biostimulant application according to the technician service notes.',
    customer_precaution_summary: CUSTOMER_PRECAUTION_SUPPORT,
    reentry_summary: REENTRY_SUPPORT,
    use_conditions: 'Soil-support use only when turf condition, season, product directions, and local rules support treatment.',
    approve: true,
  },
  {
    aliases: ['Hydretain Liquid', 'Hydretain'],
    name: 'Hydretain Liquid',
    category: 'adjuvant',
    product_type: 'wetting_agent',
    manufacturer: 'Hydretain',
    active_ingredient: 'Hygroscopic and humectant blend',
    epa_reg_number: null,
    label_source_url: 'https://www.hydretain.com/',
    label_version: 'Hydretain product information page',
    public_summary: 'Hydretain may be used as moisture-management support where drought stress, dry areas, or seasonal heat pressure make water efficiency important.',
    service_report_summary: 'Hydretain was used as moisture-management support according to the technician service notes.',
    customer_precaution_summary: CUSTOMER_PRECAUTION_SUPPORT,
    reentry_summary: REENTRY_SUPPORT,
    irrigation_notes: 'Watering or rainfall may be needed after application when directed by the service report.',
    use_conditions: 'Moisture-management support only when site condition, irrigation status, season, and product directions support treatment.',
    approve: true,
  },
  {
    aliases: ['Dispatch Sprayable Wetting Agent', 'Dispatch'],
    name: 'Dispatch Sprayable Wetting Agent',
    category: 'soil_surfactant',
    product_type: 'wetting_agent',
    manufacturer: 'Aquatrols',
    active_ingredient: 'Alkoxylated polyols + glucoethers',
    epa_reg_number: null,
    label_source_url: 'https://aquatrolscompany.com/products/dispatch-sprayable/',
    label_version: 'Aquatrols product information page',
    public_summary: 'Dispatch may be used as wetting-agent support where water movement, dry spots, or soil water repellency are part of the turf stress picture.',
    service_report_summary: 'Dispatch was used as wetting-agent support according to the technician service notes.',
    customer_precaution_summary: CUSTOMER_PRECAUTION_SUPPORT,
    reentry_summary: REENTRY_SUPPORT,
    irrigation_notes: 'Follow the service report for any watering instructions after application.',
    use_conditions: 'Wetting-agent support only when site condition, moisture observations, product directions, and local rules support treatment.',
    approve: true,
  },
  {
    aliases: ['High Mn Combo', 'High Manganese Combo'],
    name: 'High Manganese Combo',
    category: 'fertilizer',
    product_type: 'fertilizer',
    manufacturer: 'LESCO / SiteOne',
    active_ingredient: 'Manganese and micronutrients',
    epa_reg_number: null,
    label_source_url: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/rb-ue-labels-10646_12913_label_84037-218428/rb-ue-labels-10646-12913-label-84037-218428.pdf',
    label_version: 'LESCO High Manganese Combo label',
    public_summary: 'High Manganese Combo may be used for micronutrient support where turf color, stress indicators, soil conditions, season, and local rules support treatment.',
    service_report_summary: 'High Manganese Combo was used for micronutrient support according to the technician service notes.',
    customer_precaution_summary: CUSTOMER_PRECAUTION_SUPPORT,
    reentry_summary: REENTRY_SUPPORT,
    use_conditions: 'Micronutrient support only when turf observations, product directions, and local fertilizer rules support treatment.',
    approve: true,
  },
];

async function findProduct(knex, aliases) {
  for (const alias of aliases) {
    const product = await knex('products_catalog')
      .whereRaw('lower(name) like ?', [`%${alias.toLowerCase()}%`])
      .first();
    if (product) return product;
  }
  return null;
}

async function upsertFact(knex, fact) {
  const existing = await findProduct(knex, fact.aliases);
  const pesticide = fact.product_type === 'pesticide';
  const epaRegNumber = fact.epa_reg_number
    || existing?.epa_reg_number
    || NON_PESTICIDE_EPA_PLACEHOLDER;
  const update = {
    name: existing?.name || fact.name,
    category: existing?.category || fact.category,
    product_type: fact.product_type,
    manufacturer: fact.manufacturer,
    active_ingredient: fact.active_ingredient,
    epa_reg_number: epaRegNumber,
    customer_visibility: fact.approve ? 'portal_only' : 'internal_only',
    content_status: fact.approve ? 'approved_for_portal' : 'draft',
    public_summary: fact.public_summary,
    portal_summary: fact.public_summary,
    service_report_summary: fact.service_report_summary,
    customer_safety_summary: fact.customer_precaution_summary || (pesticide ? CUSTOMER_PRECAUTION_PESTICIDE : CUSTOMER_PRECAUTION_SUPPORT),
    customer_precaution_summary: fact.customer_precaution_summary || (pesticide ? CUSTOMER_PRECAUTION_PESTICIDE : CUSTOMER_PRECAUTION_SUPPORT),
    pet_kid_guidance_text: pesticide ? REENTRY_PESTICIDE : REENTRY_SUPPORT,
    reentry_text: fact.reentry_summary || (pesticide ? REENTRY_PESTICIDE : REENTRY_SUPPORT),
    reentry_summary: fact.reentry_summary || (pesticide ? REENTRY_PESTICIDE : REENTRY_SUPPORT),
    label_url: fact.label_source_url,
    label_source_url: fact.label_source_url,
    label_verified_at: VERIFIED_AT,
    label_version: fact.label_version,
    label_source_note: 'Seeded for lawn outline estimate packets from verified product/label source.',
    use_conditions: fact.use_conditions ? JSON.stringify({ publicSummary: fact.use_conditions }) : null,
    irrigation_notes: fact.irrigation_notes || null,
    local_rule_sensitivity: /fertilizer|micronutrient|soil|biostimulant|wetting/i.test(`${fact.category} ${fact.product_type}`),
    approved_for_public_page: fact.approve,
    approved_for_estimate_packet: fact.approve,
    approved_for_service_report: fact.approve,
    approved_at: fact.approve ? knex.fn.now() : null,
    review_due_at: '2027-05-30',
    updated_at: knex.fn.now(),
  };
  if (existing) {
    await knex('products_catalog').where({ id: existing.id }).update(update);
    return;
  }
  await knex('products_catalog').insert({
    id: randomUUID(),
    ...update,
    active: true,
    needs_pricing: true,
    created_at: knex.fn.now(),
  });
}

exports.up = async function up(knex) {
  for (const fact of FACTS) {
    await upsertFact(knex, fact);
  }
};

exports.down = async function down(knex) {
  for (const fact of FACTS) {
    const existing = await findProduct(knex, fact.aliases);
    if (!existing) continue;
    await knex('products_catalog')
      .where({ id: existing.id })
      .update({
        approved_for_public_page: false,
        approved_for_estimate_packet: false,
        approved_for_service_report: false,
        approved_at: null,
        customer_visibility: 'internal_only',
        content_status: 'draft',
        updated_at: knex.fn.now(),
      });
  }
};
