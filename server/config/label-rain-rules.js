'use strict';

// Label rain rules for the visit-day spray check (GATE_SPRAY_RAIN_RULES, owner 2026-10-26: plan page
// "Visit-Day Rain Rule", decisions D1 = A and D2 = A). Hand-read on 2026-10-26 from each product's
// EPA label (EPA PPLS) for the products used in the last 12 months; the label file and page ride with
// every rule so a reader can check the words.
//
//   duringRain     the label says "Do not make applications during rain" (or "during times of
//                  precipitation"). Judged on the start hour: a caution above the caution tier
//                  (reschedule-rules.js weather.rain). Never a hold: owner 2026-10-29, the card
//                  warns and the technician checks the site, so the dose always shows.
//   dryBeforeRain  the label ADVISES hours to dry before rain ("Avoid making applications when rainfall
//                  is expected before the product has sufficient time to dry (minimum 4 hours)"). A
//                  caution above 60% and the Warning level above 80%, like every rain rule; never a hold.
//   waterIn        rain or irrigation after the application helps (granules, root-zone products). No
//                  rain check.
//   heat           a label temperature line (owner 2026-10-29, plan page "Spray Weather Warnings",
//                  step 2): a caution when the start hour or the next one reads above `aboveF`,
//                  with the label's words (`text`) and what to do (`action`).
//   wind           a label wind line (owner 2026-10-30, "warn at each label's own number"): a caution
//                  when the start hour or the next one reads above `mph` (`orMore`: at `mph` too), from
//                  the spray-drift section of the use Waves makes of it. `services` limits it to the
//                  services that line is for (Cyper TC's line covers on-grade termite sprays only).
//   heavyRain      Florida's fertilizer line "Do not apply if heavy rain is expected" (owner 2026-10-30):
//                  the forecast gives no rain amount, so heavy rain is the start hour's forecast words
//                  ("heavy rain", "thunderstorms") with its rain chance on the same tiers: a caution
//                  above 60% and the Warning level above 80%.
// A tank spray whose label gives no dry time (not listed, or listed with no dry time) gets the Waves
// rule for its service (reschedule-rules.js serviceSensitivity) as its dry time; none when it is not a
// tank spray. olderLabel: EPA lists only a label filed before the registration moved to its current
// company, so the current wording may differ. `label` is the EPA PPLS file, or the company's current
// label URL (the catalog's label_url) with the date it was read.
//
// Keys are products_catalog.epa_reg_number exactly as stored; NAMED_RULES (below) hold the products
// that carry no EPA number.
const DRY_4H = 'Avoid making applications when rainfall is expected before the product has sufficient time to dry (minimum 4 hours).';

const LABEL_RAIN_RULES = Object.freeze({
  '53883-279': { product: 'Taurus SC', label: '053883-00279-20200617.pdf', duringRain: { page: 16, quote: 'Do not make treatments during times of precipitation.' } },
  '91234-145': { product: 'Atticus Talak 7.9 F', label: '083520-00003-20130321.pdf', olderLabel: true, duringRain: { page: 3, quote: 'Do not make applications during rain.' } },
  '101563-6': { product: 'Delta Dust', label: '000432-00772-20141014.pdf', olderLabel: true, duringRain: { page: 5, quote: 'Do not make applications during rain.' } },
  '100-1066': {
    product: 'Demand CS',
    label: '000100-01066-20260128.pdf',
    duringRain: { page: 8, quote: 'DO NOT make applications during rain.' },
    dryBeforeRain: { hours: 4, page: 8, quote: 'Avoid making applications when rainfall is expected before the product has sufficient time to dry (minimum of 4 hours).' },
  },
  '53883-92': {
    product: 'Cyper TC',
    label: '053883-00092-20250915.pdf',
    duringRain: { page: 5, quote: 'Do not make applications during rain.' },
    dryBeforeRain: { hours: 4, page: 5, quote: DRY_4H },
    wind: { mph: 10, services: /\btermite\b/i, page: 10, quote: 'Do not make on-grade applications when sustained wind speeds are above 10 mph (at application site) at nozzle end height.', text: 'no on-grade spraying above 10 mph' },
  },
  '53883-189': {
    product: 'Bifen XTS',
    label: '053883-00189-20141022.pdf',
    duringRain: { page: 3, quote: 'Do not make applications during rain.' },
    wind: { mph: 10, page: 12, quote: 'Do not apply when wind velocity exceeds 10 miles per hour.' },
  },
  '1021-2574': {
    product: 'Onslaught Fastcap',
    label: '001021-02574-20260305.pdf',
    duringRain: { page: 8, quote: 'Do not make applications during rain.' },
    dryBeforeRain: { hours: 4, page: 8, quote: DRY_4H },
    wind: { mph: 15, page: 8, quote: 'Do not apply when the wind speed is greater than 15 mph.' },
  },
  '53883-335': {
    product: 'Tekko Pro IGR',
    label: '053883-00335-20250522.pdf',
    duringRain: { page: 5, quote: 'Do not make applications during rain.' },
    dryBeforeRain: { hours: 4, page: 5, quote: DRY_4H },
    // Boom-less ground applications; handheld sprays are told to take precautions, with no number.
    wind: { mph: 15, page: 6, quote: 'Do not apply when wind speeds exceed 15 miles per hour at the application site.' },
  },
  '53883-90': {
    product: 'Permethrin SFR',
    label: '053883-00090-20251212.pdf',
    duringRain: { page: 7, quote: 'DO NOT make applications during rain.' },
    dryBeforeRain: { hours: 4, page: 7, quote: DRY_4H },
    wind: { mph: 15, page: 20, quote: 'Do not apply when the wind speed is greater than 15 mph.' },
  },
  // Read from the current Envu label (the catalog's label_url) on 2026-10-30; the PPLS copy is a 2022 Bayer label
  // with no wind line.
  '101563-363': {
    product: 'Scion Insecticide',
    label: 'https://bynder.envu.com/asset/26d0a78e-4acd-469c-a189-cc799ef09929/Digital_PPM_Scion_UVX_Technology_Label_NA_US_EN.pdf',
    read: '2026-10-30',
    duringRain: { page: 3, quote: 'Do not make applications during rain.' },
    wind: { mph: 15, orMore: true, page: 15, quote: 'DO NOT make outdoor broadcast applications to turf and ornamentals when wind speed is 15 mph or greater.', text: 'no broadcast spraying at 15 mph or more' },
  },
  // Read from the current Envu label (the catalog's label_url) on 2026-10-29; the PPLS copy is a 2019 Bayer label.
  '101563-141': {
    product: 'Celsius WG',
    label: 'https://bynder.envu.com/m/65d25e1e68990f59/original/Digital_TO_Celsius-WG_label_NA_US_EN.pdf',
    read: '2026-10-29',
    heat: {
      aboveF: 90,
      page: 5,
      quote: 'DO NOT use a spray adjuvant at temperatures above 90 degrees.',
      text: 'no surfactant above 90°F',
      action: 'Leave the NIS out of the tank. Spot sprays on St. Augustine may slow its growth for a while (label).',
      also: { page: 4, quote: 'Spot treatments to St. Augustinegrass turf at temperatures above 90 degrees may cause temporary growth regulation.' },
    },
  },
  '81880-24': { product: 'Sedgehammer Plus', label: '081880-00024-20200828.pdf', dryBeforeRain: { hours: 4, page: 6, quote: 'Avoid applications when rainfall is forecasted to occur within 4 hours.' } },
  '81880-1-10163': {
    product: 'Sedgehammer 75%',
    label: '081880-00001-20260901.pdf',
    dryBeforeRain: { hours: 4, page: 6, quote: 'Avoid applications when rainfall is forecasted to occur within 4 hours.' },
    wind: { mph: 10, page: 5, quote: 'DO NOT apply when wind speeds exceed 10 miles per hour at the application site.' },
  },
  // Read from the current Envu label (the catalog's label_url) on 2026-10-30; the PPLS copy is a 2010 FMC label
  // with no wind line.
  '101563-327': {
    product: 'Blindside Herbicide',
    label: 'https://bynder.envu.com/m/41196881a96d8876/original/Digital_FMC_Golf_Blindside_Label_NA_US_EN.pdf',
    read: '2026-10-30',
    dryBeforeRain: { hours: 24, page: 13, quote: 'Best weed control results will be obtained when no rainfall or irrigation occurs within 24 hours after application.' },
    wind: { mph: 10, page: 10, quote: 'Do not apply when wind speeds exceed 10 miles per hour at the application site.' },
  },
  // Read from the current Envu label (the catalog's label_url) on 2026-10-30; the PPLS copy is a 1998 scan.
  '101563-60': {
    product: 'Merit 2F',
    label: 'https://bynder.envu.com/m/24cd8422578a7725/original/Digital_TO_Merit-2F_label_NA_US_EN.pdf',
    read: '2026-10-30',
    waterIn: { page: 8, quote: 'For optimum control, if rainfall does not occur within 24 hours after application, irrigate to move the active ingredient through the thatch.' },
  },
  '100-1323': { product: 'Heritage G', label: '000100-01323-20251117.pdf', waterIn: { page: 12, quote: 'Irrigate with at least 0.5 inches water within 24 hours after application if rainfall is not expected.' } },
  '100-1216': {
    product: 'Headway Fungicide',
    label: '000100-01216-20260403.pdf',
    waterIn: { page: 17, quote: 'Irrigate with 0.1 to 0.2 inches within 24 hours after application to facilitate movement into the root zone.' },
    wind: { mph: 15, page: 10, quote: 'Do not apply when wind speeds exceed 15 mph at the application site.' },
  },
  // Turf sub-label (label pages 57 to 79); the crop sub-label's ground-boom line says 10 mph.
  '91234-74': { product: 'Artavia 2 SC', label: '091234-00074-20260701.pdf', wind: { mph: 15, page: 62, quote: 'Do not apply when wind speeds exceed 15 miles per hour at the application site.' } },
  '100-1093': { product: 'Heritage WDG', label: '000100-01093-20250728.pdf', wind: { mph: 15, page: 11, quote: 'Do not apply when wind speeds exceed 15 mph at the application site.' } },
  '228-631-10404': { product: 'LESCO T-Storm 2G', label: '000228-00631-20230831.pdf', waterIn: { page: 6, quote: 'For best results, activate the application within 24 hours with irrigation or natural rainfall.' } },
  '10404-114': { product: 'LESCO Stonewall 0.37%', label: '010404-00114-20200501.pdf', waterIn: { page: 3, quote: 'Most effective weed control will be obtained when this product is activated by at least 0.5 inches of rainfall, irrigation, or shallow (1-2 inches) incorporation…' } },
  '10404-87': {
    product: 'LESCO Dimension 0.21% + fertilizer',
    label: '010404-00087-20250117.pdf',
    waterIn: { page: 4, quote: 'A best practice for improved weed control is when treated lawn or ornamental turfgrass is watered or receives rainfall within a few days after application of this product.' },
    heavyRain: { page: 8, quote: 'Do not apply if heavy rain is expected.' },
  },
  // Turf uses water in (p53, p68). The bark-spray rule ("Do not apply to wet bark, during rainfall or if
  // rain is expected within 4 hours", p64) covers tree trunk sprays only, which no job card plans.
  '59639-152': { product: 'Arena 50 WDG', label: '059639-00152-20210723.pdf', waterIn: { page: 68, quote: 'Follow application with sufficient irrigation or rainfall to move the active ingredient through the thatch.' } },
});

// Fertilizers carry no EPA registration (the catalog stores 'N/A'), so these rules match the catalog name. Read from
// the company label (the catalog's label_url) on 2026-10-30.
const NAMED_RULES = Object.freeze([
  {
    name: /\bgreen flo phyte plus\b/i,
    rule: {
      product: 'LESCO Green Flo Phyte Plus',
      label: 'https://www.siteone.com/pdf/sdsPDF?resourceId=24797',
      read: '2026-10-30',
      heavyRain: { page: 1, quote: 'DO NOT APPLY IF HEAVY RAIN IS EXPECTED.' },
      heat: {
        aboveF: 90,
        page: 2,
        quote: 'Do not apply LESCO Green Flo Phyte Plus to foliage of any plant when temperatures are above 90˚ F.',
        text: 'no spraying on leaves above 90°F',
        action: 'Spray it in a cooler hour, or on another day.',
      },
    },
  },
  {
    name: /\bhigh manganese combo\b/i,
    rule: {
      product: 'LESCO High Manganese Combo',
      label: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/rb-ue-labels-24471_486352_label_084053ca-label-246405/rb-ue-labels-24471-486352-label-084053ca-label-246405.pdf',
      read: '2026-10-30',
      heavyRain: { page: 1, quote: 'DO NOT APPLY IF HEAVY RAIN IS EXPECTED.' },
    },
  },
]);

// A registered product by its EPA number only; a name match is for a product with no registration.
function labelRainRuleFor(product) {
  const key = String(product?.epa_reg_number || '').trim();
  if (/^\d/.test(key)) return LABEL_RAIN_RULES[key] || null;
  const name = String(product?.name || '');
  return NAMED_RULES.find((entry) => entry.name.test(name))?.rule || null;
}

module.exports = { LABEL_RAIN_RULES, NAMED_RULES, labelRainRuleFor };
