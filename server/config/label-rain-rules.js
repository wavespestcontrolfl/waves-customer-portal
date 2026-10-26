'use strict';

// Label rain rules for the visit-day spray check (GATE_SPRAY_RAIN_RULES, owner 2026-10-26: plan page
// "Visit-Day Rain Rule", decisions D1 = A and D2 = A). Hand-read on 2026-10-26 from each product's
// EPA label (EPA PPLS) for the products used in the last 12 months; the label file and page ride with
// every rule so a reader can check the words.
//
//   duringRain     the label says "Do not make applications during rain" (or "during times of
//                  precipitation"). Judged on the start hour: a caution, and a hold only at the
//                  reschedule tier (reschedule-rules.js weather.rain).
//   dryBeforeRain  the label ADVISES hours to dry before rain ("Avoid making applications when rainfall
//                  is expected before the product has sufficient time to dry (minimum 4 hours)"). A
//                  caution only, never a hold.
//   waterIn        rain or irrigation after the application helps (granules, root-zone products). No
//                  rain check.
// A product not listed gets the Waves rule for its service (reschedule-rules.js serviceSensitivity),
// or none when it is not a tank spray. olderLabel: EPA lists only a label filed before the
// registration moved to its current company, so the current wording may differ.
//
// Keys are products_catalog.epa_reg_number exactly as stored.
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
  '53883-92': { product: 'Cyper TC', label: '053883-00092-20250915.pdf', duringRain: { page: 5, quote: 'Do not make applications during rain.' }, dryBeforeRain: { hours: 4, page: 5, quote: DRY_4H } },
  '53883-189': { product: 'Bifen XTS', label: '053883-00189-20141022.pdf', duringRain: { page: 3, quote: 'Do not make applications during rain.' } },
  '1021-2574': { product: 'Onslaught Fastcap', label: '001021-02574-20260305.pdf', duringRain: { page: 8, quote: 'Do not make applications during rain.' }, dryBeforeRain: { hours: 4, page: 8, quote: DRY_4H } },
  '53883-335': { product: 'Tekko Pro IGR', label: '053883-00335-20250522.pdf', duringRain: { page: 5, quote: 'Do not make applications during rain.' }, dryBeforeRain: { hours: 4, page: 5, quote: DRY_4H } },
  '53883-90': { product: 'Permethrin SFR', label: '053883-00090-20251212.pdf', duringRain: { page: 7, quote: 'DO NOT make applications during rain.' }, dryBeforeRain: { hours: 4, page: 7, quote: DRY_4H } },
  '101563-363': { product: 'Scion Insecticide', label: '000279-03612-20220915.pdf', olderLabel: true, duringRain: { page: 7, quote: 'Do not make applications during rain.' } },
  '81880-24': { product: 'Sedgehammer Plus', label: '081880-00024-20200828.pdf', dryBeforeRain: { hours: 4, page: 6, quote: 'Avoid applications when rainfall is forecasted to occur within 4 hours.' } },
  '81880-1-10163': { product: 'Sedgehammer 75%', label: '081880-00001-20260901.pdf', dryBeforeRain: { hours: 4, page: 6, quote: 'Avoid applications when rainfall is forecasted to occur within 4 hours.' } },
  '101563-327': { product: 'Blindside Herbicide', label: '000279-03411-20100921.pdf', olderLabel: true, dryBeforeRain: { hours: 24, page: 5, quote: 'Best weed control results will be obtained when no rainfall or irrigation occurs within 24 hours after application.' } },
  '100-1323': { product: 'Heritage G', label: '000100-01323-20251117.pdf', waterIn: { page: 12, quote: 'Irrigate with at least 0.5 inches water within 24 hours after application if rainfall is not expected.' } },
  '100-1216': { product: 'Headway Fungicide', label: '000100-01216-20260403.pdf', waterIn: { page: 17, quote: 'Irrigate with 0.1 to 0.2 inches within 24 hours after application to facilitate movement into the root zone.' } },
  '228-631-10404': { product: 'LESCO T-Storm 2G', label: '000228-00631-20230831.pdf', waterIn: { page: 6, quote: 'For best results, activate the application within 24 hours with irrigation or natural rainfall.' } },
  '10404-114': { product: 'LESCO Stonewall 0.37%', label: '010404-00114-20200501.pdf', waterIn: { page: 3, quote: 'Most effective weed control will be obtained when this product is activated by at least 0.5 inches of rainfall, irrigation, or shallow (1-2 inches) incorporation…' } },
  // Florida's fertilizer statement is on this label too ("Do not apply if heavy rain is expected.",
  // p8); the forecast rows carry no rain amount, so heavy rain is not judged.
  '10404-87': { product: 'LESCO Dimension 0.21% + fertilizer', label: '010404-00087-20250117.pdf', waterIn: { page: 4, quote: 'A best practice for improved weed control is when treated lawn or ornamental turfgrass is watered or receives rainfall within a few days after application of this product.' } },
  // Turf uses water in (p53, p68). The bark-spray rule ("Do not apply to wet bark, during rainfall or if
  // rain is expected within 4 hours", p64) covers tree trunk sprays only, which no job card plans.
  '59639-152': { product: 'Arena 50 WDG', label: '059639-00152-20210723.pdf', waterIn: { page: 68, quote: 'Follow application with sufficient irrigation or rainfall to move the active ingredient through the thatch.' } },
});

function labelRainRuleFor(product) {
  const key = String(product?.epa_reg_number || '').trim();
  return key ? LABEL_RAIN_RULES[key] || null : null;
}

module.exports = { LABEL_RAIN_RULES, labelRainRuleFor };
