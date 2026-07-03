// Batch-2/3 of the owner-provided label/SDS documents (2026-07-03).
//
// WHY A NEW MIGRATION: PR #2306 was merged and 20260703000002 ran on prod at
// 17:58Z in its merged form (SiteOne product pages as label links for most
// LESCO rows). Knex tracks migrations by filename, so the later batch-2
// additions to that file never executed anywhere — they are re-issued here,
// together with the owner's corrected rows (US Medallion SC docs, liquid
// Moisture Manager docs, Hydretain ES Plus).
//
// Semantics:
// - labelUrl with replaceLabelUrls upgrades a previously-seeded product-page
//   label link to the direct document; fill-only-empty otherwise, so any
//   admin-set value that isn't the listed old URL is never clobbered.
// - Owner-flagged VERIFY documents were checked against the fetched PDFs;
//   rejected finds from the first pass are corrected here per the owner's
//   follow-up (Medallion US EPA 100-1448 docs, not the Syngenta Canada PMRA
//   sheet; liquid Moisture Manager SDS for SiteOne item 080-8035 — its SDS
//   identifies product code HYD77-MM, synonym Hydretain ES Plus — not
//   Granular QD).
// - Both Hydretain catalog rows carry the professional profile (2.5 gal
//   container, $184.81, 9 fl oz/1K), so per the owner's decision rule they
//   get the Hydretain ES Plus 2.5-gal label/SDS, not the retail documents.

const DOC_LINKS = [
  {
    pattern: '%Green Flo 6-0-0%',
    labelUrl: 'https://www.siteone.com/pdf/sdsPDF?resourceId=23286',
    sdsUrl: 'https://www.siteone.com/pdf/sdsPDF?resourceId=22394',
    replaceLabelUrls: ['https://www.siteone.com/en/511125-nla-lesco-green-flo-6-0-0-10-ca-turfgrass-liquid-fertilizer-25-gal-jug/p/668926'],
    note: 'Direct label/SDS documents owner-provided from SiteOne 2026-07-03 (upgrade from product-page link).',
  },
  {
    pattern: '%High Manganese Combo%',
    labelUrl: 'https://www.siteone.com/pdf/sdsPDF?resourceId=24744',
    sdsUrl: 'https://www.siteone.com/pdf/sdsPDF?resourceId=2224&skuId=12927',
    replaceLabelUrls: ['https://www.siteone.com/en/agronomic-maintenance-fertility-nutrition/c/sh1315110103'],
    note: 'Direct label/SDS documents owner-provided from SiteOne 2026-07-03.',
  },
  {
    pattern: '%Chelated AM + Micros%',
    labelUrl: 'https://www.siteone.com/pdf/sdsPDF?resourceId=8928',
    replaceLabelUrls: ['https://www.siteone.com/en/098186b-lesco-florida-friendly-am-turfgrass-ornamental-chleated-liquid-micronutrient/p/574274'],
    note: 'T&O Chelated Micronutrient Package label/spec doc owner-provided from SiteOne 2026-07-03.',
  },
  {
    pattern: '%Moisture Manager%',
    labelUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/rb-ue-labels-6786_166325_label_89075-651846/rb-ue-labels-6786-166325-label-89075-651846.pdf',
    sdsUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/safetyDataSheet/rb-ue-msds-2584_166325_msds_5053sds-123109/rb-ue-msds-2584-166325-msds-5053sds-123109.pdf',
    replaceLabelUrls: ['https://www.siteone.com/en/080-8035-lesco-moisture-manager-25-gal-jug/p/166325'],
    note: 'Liquid Moisture Manager label/SDS (SiteOne item 080-8035, 2.5 gal; SDS product code HYD77-MM, synonym Hydretain ES Plus) owner-provided 2026-07-03 — NOT the Granular QD sheet.',
  },
  {
    // Owner: the real product page is a good replacement for the previously
    // seeded "three steps" article link.
    pattern: '%CarbonPro-L%',
    labelUrl: 'https://www.siteone.com/en/510894b-lesco-carbonpro-l-w-mobilex-biostimulant-liquid-soil-amendment/p/1061272',
    sdsUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/safetyDataSheet/510894b-sds/510894b-sds.pdf',
    replaceLabelUrls: ['https://www.siteone.com/en/articles/turf-care/lesco-three-steps'],
    note: 'SiteOne product page (label under Resources) + SDS owner-provided 2026-07-03.',
  },
  {
    pattern: '%Dispatch Sprayable%',
    labelUrl: 'https://labelsds.com/document.php?file=Dispatch+Sprayable+Label+4-8-19.pdf&product=2939',
    sdsUrl: 'https://aquatrolscompany.com/wp-content/uploads/2025/03/Dispatch-Sprayable-US-SDS.pdf',
    replaceLabelUrls: ['https://aquatrolscompany.com/products/dispatch-sprayable/'],
    note: 'Label (LabelSDS mirror) and Aquatrols SDS owner-provided 2026-07-03.',
  },
  {
    pattern: 'Medallion SC',
    labelUrl: 'https://www3.epa.gov/pesticides/chem_search/ppls/000100-01448-20220202.pdf',
    sdsUrl: 'https://assets.syngenta-us.com/pdf/msds/MEDALLION%20SC%20A17856B%2002172015.pdf',
    replaceLabelUrls: ['https://www.greencastonline.com/labels/medallion-sc'],
    note: 'US Medallion SC EPA-hosted label + Syngenta US SDS owner-provided 2026-07-03 (GreenCast confirms EPA 100-1448); replaces the GreenCast page link.',
  },
  // Both Hydretain rows carry the professional 2.5-gal profile (2.5 gal
  // container, $184.81, 9 fl oz/1K) — ES Plus documents per the owner's
  // decision rule, not retail Hydretain Liquid. Two exact-name entries so
  // down() restores each row to its own prior state.
  {
    pattern: 'Hydretain Liquid',
    labelUrl: 'https://www.hydretain.com/wp-content/uploads/2018/10/HydESP_2.5GalLab_US_C_LRWEB_R20171129.pdf',
    sdsUrl: 'https://www.hydretain.com/wp-content/uploads/2018/10/HydESP_SDS_R20160226.pdf',
    note: 'Hydretain ES Plus 2.5-gal label/SDS (Ecologel) owner-provided 2026-07-03 — row matches the professional product (2.5 gal, 9 fl oz/1K).',
  },
  {
    pattern: 'Hydretain Liquid Humectant',
    labelUrl: 'https://www.hydretain.com/wp-content/uploads/2018/10/HydESP_2.5GalLab_US_C_LRWEB_R20171129.pdf',
    sdsUrl: 'https://www.hydretain.com/wp-content/uploads/2018/10/HydESP_SDS_R20160226.pdf',
    replaceLabelUrls: ['https://www.hydretain.com/'],
    note: 'Hydretain ES Plus 2.5-gal label/SDS (Ecologel) owner-provided 2026-07-03 — row matches the professional product (2.5 gal, 9 fl oz/1K).',
  },
  // Protocol pesticides: SDS documents only — labels already resolve via
  // label_url or the EPA PPLS record. VERIFY-flagged documents were checked
  // against the fetched PDFs before inclusion. SpeedZone Southern and
  // Headway G remain absent (no reliable SDS found yet).
  {
    pattern: 'Celsius WG',
    sdsUrl: 'https://bynder.envu.com/m/3237e534a3bade42/original/Digital_TO_Celsius-WG_SDS_NA_US_EN.pdf',
    note: 'SDS owner-provided 2026-07-03.',
  },
  {
    pattern: 'Prodiamine 65 WDG',
    sdsUrl: 'https://s3-us-west-1.amazonaws.com/agrian-cg-fs1-production/pdfs/PRODIAMINE_65WDG_MSDS.pdf',
    note: 'Quali-Pro Prodiamine 65 WDG SDS; verified 2026-07-03 — lists EPA Reg. Nos. 53883-429, 66222-89 (this row: 66222-89).',
  },
  {
    pattern: 'Dismiss NXT',
    sdsUrl: 'https://bynder.envu.com/m/e27f9ba5b973533/original/Digital_FMC_Golf_Dismiss-NXT_SDS_NA_US_EN.pdf',
    note: 'SDS owner-provided 2026-07-03.',
  },
  {
    pattern: '%Sedgehammer Plus%',
    sdsUrl: 'https://www.gowanco.com/sites/default/files/gowanco_com/_attachments/product/resource/sds/sd349_-_sedgehammerr_turf_herbicide_us.pdf',
    note: 'Gowan SDS; verified 2026-07-03 — shows EPA Reg. No. 81880-24-10163, a distributor sub-registration of this row’s 81880-24.',
  },
  {
    pattern: 'Atrazine 4L',
    sdsUrl: 'https://carovail.com/wp-content/uploads/2019/01/Atrazine-4L-Drexel-1.pdf',
    note: 'Drexel Atrazine 4L SDS (mirror), matches EPA Reg. No. 19713-11.',
  },
  {
    pattern: 'Talstar P',
    sdsUrl: 'https://www.rosepestcontrol.com/wp-content/uploads/2022/02/Talstar-P-Professional-SDS.pdf',
    note: 'Mirror SDS owner-provided 2026-07-03.',
  },
  {
    pattern: 'Acelepryn Xtra',
    sdsUrl: 'https://www.domyown.com/msds/Acelepryn_Xtra_SDS_2023.pdf',
    note: 'Official Syngenta SDS via mirror; verified 2026-07-03. NOTE: the SDS states product registration 100-1680 (Syngenta) while this row carries 432-1652 — owner to reconcile the EPA reg number.',
  },
  {
    pattern: 'Arena 50 WDG',
    sdsUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/Nufarm/safetyDataSheet/rb-ue-msds-8817_711405_msds_2774-0sds-976698/rb-ue-msds-8817-711405-msds-2774-0sds-976698.pdf',
    note: 'SDS owner-provided 2026-07-03 (SiteOne/Nufarm).',
  },
  {
    pattern: 'Torque SC',
    sdsUrl: 'https://www.agrian.com/pdfs/Torque_Fungicide_MSDS.pdf',
    note: 'Mirror SDS owner-provided 2026-07-03.',
  },
  {
    pattern: 'Primo Maxx',
    sdsUrl: 'https://assets.syngenta-us.com/pdf/msds/Primo%20Maxx.pdf',
    note: 'SDS owner-provided 2026-07-03.',
  },
];

// LESCO Three-Way: owner-provided EPA registration (verified against the
// EPA-hosted label PDF), label, and SDS (2026-07-03). SiteOne product page:
// https://www.siteone.com/en/10446b-lesco-three-way-selective-post-emergent-liquid-herbicide/p/964147
const THREE_WAY = {
  name: 'LESCO Three-Way Selective Herbicide',
  epaRegNumber: '10404-43',
  labelUrl: 'https://www3.epa.gov/pesticides/chem_search/ppls/010404-00043-20211102.pdf',
  sdsUrl: 'https://assets.greenbook.net/M6921.pdf',
};

function appendNote(existing, note) {
  if (!note) return existing || null;
  if (existing && existing.includes(note)) return existing;
  return existing ? `${existing} ${note}` : note;
}

// Exposed for tests / read-only preview tooling.
exports._data = { DOC_LINKS, THREE_WAY };

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('products_catalog');
  if (!hasTable) return;

  for (const entry of DOC_LINKS) {
    const rows = await knex('products_catalog')
      .where('name', 'ilike', entry.pattern)
      .where(function () {
        this.where({ active: true }).orWhereNull('active');
      })
      .select('id', 'label_url', 'sds_url', 'label_source_note');

    for (const row of rows) {
      const update = {};
      const replaceable = (entry.replaceLabelUrls || []).includes(row.label_url);
      if (entry.labelUrl && (!row.label_url || replaceable)) update.label_url = entry.labelUrl;
      if (entry.sdsUrl && !row.sds_url) update.sds_url = entry.sdsUrl;
      if (!Object.keys(update).length) continue;

      update.label_source_note = appendNote(row.label_source_note, entry.note);
      update.updated_at = knex.fn.now();
      await knex('products_catalog').where({ id: row.id }).update(update);
    }
  }

  const threeWay = await knex('products_catalog')
    .where({ name: THREE_WAY.name })
    .first('id', 'label_url', 'sds_url', 'epa_reg_number', 'label_source_note');
  if (threeWay) {
    const update = {};
    if (!threeWay.epa_reg_number || threeWay.epa_reg_number === 'N/A') {
      update.epa_reg_number = THREE_WAY.epaRegNumber;
    }
    if (!threeWay.label_url) update.label_url = THREE_WAY.labelUrl;
    if (!threeWay.sds_url) update.sds_url = THREE_WAY.sdsUrl;
    if (Object.keys(update).length) {
      update.label_source_note = appendNote(
        threeWay.label_source_note,
        'EPA Reg. No. 10404-43, EPA-hosted label, and Greenbook SDS owner-provided 2026-07-03.',
      );
      update.updated_at = knex.fn.now();
      await knex('products_catalog').where({ id: threeWay.id }).update(update);
    }
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('products_catalog');
  if (!hasTable) return;

  // Only revert values this migration set; restore replaced label links.
  for (const entry of DOC_LINKS) {
    if (entry.labelUrl) {
      await knex('products_catalog')
        .where('name', 'ilike', entry.pattern)
        .where({ label_url: entry.labelUrl })
        .update({ label_url: null, updated_at: knex.fn.now() });
      for (const oldUrl of entry.replaceLabelUrls || []) {
        await knex('products_catalog')
          .where('name', 'ilike', entry.pattern)
          .whereNull('label_url')
          .update({ label_url: oldUrl, updated_at: knex.fn.now() });
      }
    }
    if (entry.sdsUrl) {
      await knex('products_catalog')
        .where('name', 'ilike', entry.pattern)
        .where({ sds_url: entry.sdsUrl })
        .update({ sds_url: null, updated_at: knex.fn.now() });
    }
  }

  await knex('products_catalog')
    .where({ name: THREE_WAY.name, epa_reg_number: THREE_WAY.epaRegNumber })
    .update({ epa_reg_number: 'N/A', updated_at: knex.fn.now() });
  await knex('products_catalog')
    .where({ name: THREE_WAY.name, label_url: THREE_WAY.labelUrl })
    .update({ label_url: null, updated_at: knex.fn.now() });
  await knex('products_catalog')
    .where({ name: THREE_WAY.name, sds_url: THREE_WAY.sdsUrl })
    .update({ sds_url: null, updated_at: knex.fn.now() });
};
