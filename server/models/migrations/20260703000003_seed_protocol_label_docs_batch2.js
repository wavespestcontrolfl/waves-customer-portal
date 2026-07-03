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
    // Owner's strongest match: the LabelSDS Pro Plus T&O Micro label shows
    // item #098186 (Florida Friendly / T&O Chelated Micro-Nutrient Package,
    // 2 x 2.5 gal case) and the SDS is the matching ProPlus T&O Micro
    // Nutrient sheet.
    pattern: '%Chelated AM + Micros%',
    labelUrl: 'https://labelsds.com/document.php?file=Pro+Plus+TO+Micro+Label.pdf&product=4254',
    sdsUrl: 'https://labelsds.com/document.php?file=ProPlus+Micro+SDS+11-20-14.pdf&product=4254',
    replaceLabelUrls: ['https://www.siteone.com/en/098186b-lesco-florida-friendly-am-turfgrass-ornamental-chleated-liquid-micronutrient/p/574274'],
    note: 'Pro Plus T&O Micro label (item #098186, Florida Friendly package) + ProPlus T&O Micro Nutrient SDS owner-provided 2026-07-03.',
  },
  // The four dry granular rows use the generic "LESCO Granular Fertilizer –
  // All Analyses" SDS per the owner's direction: SiteOne exposes that exact
  // SDS under the 15-0-15 row and the sheet states it covers granular
  // fertilizers with and without micronutrients. Swap to product-specific
  // SDS documents if they surface later.
  {
    pattern: '%15-0-15%',
    labelUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/rb-ue-labels-27652_336165_label_098586-label-732419/rb-ue-labels-27652-336165-label-098586-label-732419.pdf',
    sdsUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/safetyDataSheet/rb-ue-msds-2209_336165_msds_1015sds-308654/rb-ue-msds-2209-336165-msds-1015sds-308654.pdf',
    replaceLabelUrls: ['https://www.siteone.com/en/098586wb-lesco-15-0-15-30-polyplus-opti45-as-1-fe-04-mn-245s-mop-turfgrass-granular-fertilizer/p/1061038'],
    note: 'Direct SiteOne label (098586) + LESCO Granular All-Analyses SDS owner-provided 2026-07-03.',
  },
  {
    // No direct label PDF found — the label link stays the SiteOne product
    // page seeded by 20260703000002; only the SDS fills here.
    pattern: '%7-1-7%',
    sdsUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/safetyDataSheet/rb-ue-msds-2209_336165_msds_1015sds-308654/rb-ue-msds-2209-336165-msds-1015sds-308654.pdf',
    note: 'LESCO Granular All-Analyses SDS owner-provided 2026-07-03 (no product-specific label PDF found; label stays the SiteOne product page).',
  },
  {
    pattern: '%0-0-18 Bio KMAG%',
    labelUrl: 'https://www.siteone.com/pdf/sdsPDF?resourceId=21211&skuId=396974',
    sdsUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/safetyDataSheet/rb-ue-msds-2209_336165_msds_1015sds-308654/rb-ue-msds-2209-336165-msds-1015sds-308654.pdf',
    replaceLabelUrls: ['https://www.siteone.com/en/510333-lesco-0-0-18-bio-kmag-1-fe-1-mg-1-mn-217-s-organic-turf-granular-fertilizer-40-lb-bag/p/396974'],
    note: 'Product information/label PDF (510333) + LESCO Granular All-Analyses SDS owner-provided 2026-07-03.',
  },
  {
    pattern: '%Elite 0-0-28%',
    labelUrl: 'https://www.siteone.com/pdf/sdsPDF?resourceId=126596&skuId=334404',
    sdsUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/safetyDataSheet/rb-ue-msds-2209_336165_msds_1015sds-308654/rb-ue-msds-2209-336165-msds-1015sds-308654.pdf',
    replaceLabelUrls: ['https://www.siteone.com/en/015171-lesco-elite-0-0-28-am-75-fe-65-mn-9-s-turfgrass-granular-fertilizer-50-lb-bag/p/4465'],
    note: 'Elite family spec/catalog PDF (incl. 015171 0-0-28) + LESCO Granular All-Analyses SDS owner-provided 2026-07-03.',
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
    // On prod this row's label_url is empty; databases seeded by
    // 20260530000022 carry the generic hydretain.com homepage here, so it is
    // listed as replaceable too (down() restores the homepage, which matches
    // the fresh-DB prior state; prod's prior state was empty).
    pattern: 'Hydretain Liquid',
    labelUrl: 'https://www.hydretain.com/wp-content/uploads/2018/10/HydESP_2.5GalLab_US_C_LRWEB_R20171129.pdf',
    sdsUrl: 'https://www.hydretain.com/wp-content/uploads/2018/10/HydESP_SDS_R20160226.pdf',
    replaceLabelUrls: ['https://www.hydretain.com/'],
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
    labelUrl: 'https://www3.epa.gov/pesticides/chem_search/ppls/000100-01680-20230626.pdf',
    sdsUrl: 'https://www.domyown.com/msds/Acelepryn_Xtra_SDS_2023.pdf',
    note: 'EPA-hosted label + official Syngenta SDS (via mirror) owner-provided 2026-07-03; EPA reg corrected to 100-1680 per owner ruling.',
  },
  {
    pattern: 'Headway G',
    labelUrl: 'https://www3.epa.gov/pesticides/chem_search/ppls/000100-01378-20190816.pdf',
    sdsUrl: 'https://assets.syngenta-us.com/pdf/msds/hEADWAY%20g.pdf',
    note: 'EPA-hosted label + official Syngenta SDS owner-provided 2026-07-03 (GreenCast confirms EPA 100-1378).',
  },
  {
    // Inventory is the current EW formulation — the vendor_pricing row's SKU
    // is SPEEDZONE-SOUTHERN-EW — so per the owner's ruling this row gets the
    // SpeedZone Southern EW documents (EPA 2217-1031), not the old non-EW
    // 2217-835 records.
    pattern: '%SpeedZone Southern%',
    labelUrl: 'https://www3.epa.gov/pesticides/chem_search/ppls/002217-01031-20190730.pdf',
    sdsUrl: 'https://savannahga.gov/DocumentCenter/View/34436/SDS',
    note: 'SpeedZone Southern EW label (EPA 2217-1031) + SDS owner-provided 2026-07-03; inventory SKU SPEEDZONE-SOUTHERN-EW confirms the EW formulation.',
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

// Owner rulings 2026-07-03: two catalog EPA registration numbers are wrong.
// - Acelepryn Xtra is EPA 100-1680 (Syngenta/GreenCast, Greenbook, and the
//   EPA-hosted A15452 label all agree); the seeded 432-1652 is not this
//   product.
// - SpeedZone Southern: no support exists for the seeded 2217-987. Inventory
//   is the current EW formulation (vendor SKU SPEEDZONE-SOUTHERN-EW), which
//   is EPA 2217-1031 per its EPA-hosted label; the old non-EW product was
//   2217-835 and is not what we stock.
// Guarded to the exact wrong value so an admin correction is never clobbered.
const EPA_CORRECTIONS = [
  {
    // The 100-1680 product is chlorantraniliprole + THIAMETHOXAM (IRAC
    // 28 + 4A per the verified Syngenta SDS) — the seeded 432-1652
    // classification carried bifenthrin / 28+3A, which would keep the
    // WaveGuard MOA-rotation and reporting logic treating this as a
    // pyrethroid product. Classification fixes are guarded to the exact
    // stale values (prod already carries the corrected active_ingredient;
    // fresh DBs still carry the seed's bifenthrin text).
    pattern: 'Acelepryn Xtra',
    from: '432-1652',
    to: '100-1680',
    fieldFixes: [
      { column: 'irac_group', from: ['28+3A'], to: '28+4A' },
      { column: 'active_ingredient', from: ['Chlorantraniliprole + Bifenthrin'], to: 'Chlorantraniliprole & Thiamethoxam' },
    ],
    note: 'EPA Reg. No. corrected 432-1652 → 100-1680 per owner ruling 2026-07-03 (GreenCast/Greenbook/EPA label agree); IRAC corrected 28+3A → 28+4A (thiamethoxam, not bifenthrin, per the verified Syngenta SDS).',
  },
  // Exact-name patterns so each SpeedZone row keeps its own up()/down()
  // pairing — a shared pattern would let the first down() pass rewrite
  // both rows before the second pass runs.
  {
    pattern: 'SpeedZone Southern',
    from: '2217-987',
    to: '2217-1031',
    note: 'EPA Reg. No. corrected 2217-987 (unsupported) → 2217-1031 (SpeedZone Southern EW) per owner ruling 2026-07-03; inventory SKU SPEEDZONE-SOUTHERN-EW confirms EW.',
  },
  {
    // The EW-named duplicate row carries no reg at all.
    pattern: 'SpeedZone Southern EW',
    from: 'N/A',
    to: '2217-1031',
    note: 'EPA Reg. No. set to 2217-1031 (SpeedZone Southern EW) per owner ruling 2026-07-03.',
  },
];

function appendNote(existing, note) {
  if (!note) return existing || null;
  if (existing && existing.includes(note)) return existing;
  return existing ? `${existing} ${note}` : note;
}

// Exposed for tests / read-only preview tooling.
exports._data = { DOC_LINKS, THREE_WAY, EPA_CORRECTIONS };

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

  for (const fix of EPA_CORRECTIONS) {
    const columns = ['id', 'label_source_note', ...(fix.fieldFixes || []).map((f) => f.column)];
    const rows = await knex('products_catalog')
      .where('name', 'ilike', fix.pattern)
      .where({ epa_reg_number: fix.from })
      .select(columns);
    for (const row of rows) {
      const update = {
        epa_reg_number: fix.to,
        label_source_note: appendNote(row.label_source_note, fix.note),
        updated_at: knex.fn.now(),
      };
      for (const field of fix.fieldFixes || []) {
        if (field.from.includes(row[field.column])) update[field.column] = field.to;
      }
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

  // Exact-name patterns keep each row paired with its own original value.
  // The IRAC fix reverts alongside the reg (guarded to the corrected value);
  // active_ingredient is left at the corrected value on purpose — prod
  // carried the corrected text before this migration, so reverting it would
  // reintroduce the bifenthrin error there.
  for (const fix of EPA_CORRECTIONS) {
    for (const field of fix.fieldFixes || []) {
      if (field.column !== 'irac_group') continue;
      await knex('products_catalog')
        .where('name', 'ilike', fix.pattern)
        .where({ epa_reg_number: fix.to, [field.column]: field.to })
        .update({ [field.column]: field.from[0], updated_at: knex.fn.now() });
    }
    await knex('products_catalog')
      .where('name', 'ilike', fix.pattern)
      .where({ epa_reg_number: fix.to })
      .update({ epa_reg_number: fix.from, updated_at: knex.fn.now() });
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
