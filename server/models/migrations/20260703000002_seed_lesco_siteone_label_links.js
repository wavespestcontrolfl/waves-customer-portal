// Seed owner-provided label/SDS links (2026-07-03) for the LESCO fertilizer
// and support-product rows, plus the owner-provided EPA registration number
// for Atrazine 4L.
//
// The owner's direction: LESCO fertilizer labels are found on SiteOne. Where
// a direct label PDF was provided it is used; otherwise the SiteOne product
// page (which hosts the label/SDS under Resources) is the label link.
//
// The catalog carries duplicate name-variants for several of these products
// (e.g. five "Chelated Iron Plus" rows), so each entry matches by a tight
// name pattern and updates every active variant — whichever variant the plan
// engine resolves gets the link. Guarded to fill only empty fields so rows
// that already carry a real label document (High Manganese Combo AM,
// CarbonPro-L w/ MobilE) are never clobbered.

const SITEONE_LINKS = [
  {
    pattern: '%24-0-11%',
    vendorUrl: 'https://www.siteone.com/en/098631-lesco-24-0-11-50-polyplus-opti-2fe-1mn-mop-turfgrass-granular-fertilizer-50-lb-bag/p/336709',
    labelUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/rb-ue-labels-15995_336709_label_098631-opti-label-643166/rb-ue-labels-15995-336709-label-098631-opti-label-643166.pdf',
    sdsUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/safetyDataSheet/rb-ue-msds-2209_336709_msds_1015sds-269052/rb-ue-msds-2209-336709-msds-1015sds-269052.pdf',
  },
  {
    pattern: '%15-0-15%',
    vendorUrl: 'https://www.siteone.com/en/098586wb-lesco-15-0-15-30-polyplus-opti45-as-1-fe-04-mn-245s-mop-turfgrass-granular-fertilizer/p/1061038',
  },
  {
    pattern: '%7-1-7%',
    vendorUrl: 'https://www.siteone.com/en/098646-lesco-7-1-7-40-polyplus-1-fe-1-mg-1-mn-217-s-pc-urea-dap-mop-is-ms-k-mag-turfgrass-granular-fertilizer-50-lb-bag/p/336923',
  },
  {
    pattern: '%K-Flow 0-0-25%',
    vendorUrl: 'https://www.siteone.com/en/098504b-lesco-florida-friendly-k-flow-0-0-25-potassium-thiosulfate-17-s-turfgrass-ornamental-liquid-fertilizer/p/571580',
    labelUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/rb-ue-labels-15325_332557_label_98504-120681/rb-ue-labels-15325-332557-label-98504-120681.pdf',
    sdsUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/safetyDataSheet/rb-ue-msds-22393_332557_msds_1016-1sds-315287/rb-ue-msds-22393-332557-msds-1016-1sds-315287.pdf',
  },
  {
    pattern: '%Green Flo Phyte Plus%',
    vendorUrl: 'https://www.siteone.com/en/9999903961-nla-lesco-green-flo-phyte-plus-liquid-fertilizer-0-0-26/p/571631',
    labelUrl: 'https://www.siteone.com/pdf/sdsPDF?resourceId=24797',
    sdsUrl: 'https://www.siteone.com/pdf/sdsPDF?resourceId=21051&skuId=368293',
  },
  {
    pattern: '%0-0-18 Bio KMAG%',
    vendorUrl: 'https://www.siteone.com/en/510333-lesco-0-0-18-bio-kmag-1-fe-1-mg-1-mn-217-s-organic-turf-granular-fertilizer-40-lb-bag/p/396974',
  },
  {
    pattern: '%Elite 0-0-28%',
    vendorUrl: 'https://www.siteone.com/en/015171-lesco-elite-0-0-28-am-75-fe-65-mn-9-s-turfgrass-granular-fertilizer-50-lb-bag/p/4465',
  },
  {
    pattern: '%Chelated Iron Plus%',
    vendorUrl: 'https://www.siteone.com/en/9999903964-lesco-chelated-iron-plus-12-0-0-6fe-2mn-all-purpose-liquid-fertilizer/p/571634',
    labelUrl: 'https://www.siteone.com/pdf/sdsPDF?resourceId=27983',
    sdsUrl: 'https://spsonline.com/wp-content/uploads/2024/10/Lesco-Iron-plus-chelated-fertilizer-SDS.pdf',
  },
  {
    pattern: '%Green Flo 6-0-0%',
    vendorUrl: 'https://www.siteone.com/en/511125-nla-lesco-green-flo-6-0-0-10-ca-turfgrass-liquid-fertilizer-25-gal-jug/p/668926',
  },
  {
    pattern: '%High Manganese Combo%',
    vendorUrl: 'https://www.siteone.com/en/agronomic-maintenance-fertility-nutrition/c/sh1315110103',
  },
  {
    pattern: '%Chelated AM + Micros%',
    vendorUrl: 'https://www.siteone.com/en/098186b-lesco-florida-friendly-am-turfgrass-ornamental-chleated-liquid-micronutrient/p/574274',
  },
  {
    pattern: '%Moisture Manager%',
    vendorUrl: 'https://www.siteone.com/en/080-8035-lesco-moisture-manager-25-gal-jug/p/166325',
  },
  {
    pattern: '%CarbonPro-L%',
    vendorUrl: 'https://www.siteone.com/en/articles/turf-care/lesco-three-steps',
  },
];

const ATRAZINE_EPA_REG = '19713-11';

function noteFor(entry, usedVendorPageAsLabel) {
  const base = usedVendorPageAsLabel
    ? 'Label link is the owner-preferred SiteOne product page (label/SDS under Resources), owner-provided 2026-07-03.'
    : 'Label/SDS links owner-provided from SiteOne, 2026-07-03.';
  return base;
}

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('products_catalog');
  if (!hasTable) return;

  for (const entry of SITEONE_LINKS) {
    const rows = await knex('products_catalog')
      .where('name', 'ilike', entry.pattern)
      .where(function () {
        this.where({ active: true }).orWhereNull('active');
      })
      .select('id', 'label_url', 'sds_url', 'label_source_note');

    for (const row of rows) {
      const update = {};
      const usedVendorPageAsLabel = !entry.labelUrl;
      if (!row.label_url) update.label_url = entry.labelUrl || entry.vendorUrl;
      if (!row.sds_url && entry.sdsUrl) update.sds_url = entry.sdsUrl;
      if (!Object.keys(update).length) continue;

      const note = noteFor(entry, usedVendorPageAsLabel);
      update.label_source_note = row.label_source_note
        ? `${row.label_source_note} ${note}`
        : note;
      update.updated_at = knex.fn.now();
      await knex('products_catalog').where({ id: row.id }).update(update);
    }
  }

  // Owner-provided EPA registration number for Atrazine 4L (2026-07-03).
  // The protocol-reference UI derives the EPA PPLS label link from this.
  await knex('products_catalog')
    .where({ name: 'Atrazine 4L' })
    .where(function () {
      this.whereNull('epa_reg_number').orWhere('epa_reg_number', 'N/A');
    })
    .update({
      epa_reg_number: ATRAZINE_EPA_REG,
      label_source_note: knex.raw(
        "trim(coalesce(label_source_note, '') || ' EPA Reg. No. 19713-11 owner-provided 2026-07-03.')",
      ),
      updated_at: knex.fn.now(),
    });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('products_catalog');
  if (!hasTable) return;

  // Only revert values this migration set.
  for (const entry of SITEONE_LINKS) {
    const setLabel = entry.labelUrl || entry.vendorUrl;
    await knex('products_catalog')
      .where('name', 'ilike', entry.pattern)
      .where({ label_url: setLabel })
      .update({ label_url: null, updated_at: knex.fn.now() });
    if (entry.sdsUrl) {
      await knex('products_catalog')
        .where('name', 'ilike', entry.pattern)
        .where({ sds_url: entry.sdsUrl })
        .update({ sds_url: null, updated_at: knex.fn.now() });
    }
  }

  await knex('products_catalog')
    .where({ name: 'Atrazine 4L', epa_reg_number: ATRAZINE_EPA_REG })
    .update({ epa_reg_number: 'N/A', updated_at: knex.fn.now() });
};
