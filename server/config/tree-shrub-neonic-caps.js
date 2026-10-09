/**
 * Tree & Shrub neonicotinoid yearly caps (GATE_TS_NEONIC_CAP, owner 2026-10-09).
 *
 * A label limit per ACRE of treated landscape per calendar YEAR, written in each
 * product's own unit. A property's yearly amount is that figure scaled to its
 * ornamental bed area (customer_properties.bed_sqft). Products that share an
 * active ingredient share ONE cap: each application is a share of its own
 * product's yearly amount, and the shares add up to 1.
 *
 * The numbers are label facts; do not change one without the label in hand.
 * `source` names the label each came from. A catalog product of a capped ingredient with no entry
 * here has no strength on file: the sheet holds it (uncapped) and never lets it through unchecked.
 */
const SQFT_PER_ACRE = 43560;

const NEONIC_CAPS = Object.freeze([
  {
    key: 'dinotefuran',
    label: 'Dinotefuran',
    // products_catalog.active_ingredient (or the ledger row's own) starts with this, case-insensitive.
    activeIngredientPrefix: 'dinotefuran',
    products: Object.freeze([
      {
        shortName: 'Zylam',
        namePattern: /^zylam\b/i,
        unit: 'fl_oz',
        // 0.54 lb ai per acre per year = 1.811 fl oz per 1,000 sq ft. Foliar and soil
        // count together (Waves' stricter reading of the label).
        perAcreYear: 78.9,
        // A separate label limit, whatever the amounts: three applications per growing season,
        // sprays and drenches together. Counted per calendar year (no dormant season here).
        maxApplicationsPerYear: 3,
        source: 'Zylam Liquid label (PBI-Gordon, EPA 2217-937): dinotefuran 10%, 0.89 lb ai/gal; 78.9 fl oz per acre per year',
      },
      {
        shortName: 'Safari',
        namePattern: /^safari\b/i,
        unit: 'oz',
        // 2.7 lb product (0.54 lb ai) per acre per year = 43.2 oz weight = 0.992 oz per 1,000 sq ft.
        // Same active ingredient and same ai cap as Zylam.
        perAcreYear: 43.2,
        source: 'Safari 20 SG label (Valent, EPA 86203-11): dinotefuran 20%; 2.7 lb product per acre per year',
      },
    ]),
  },
  {
    key: 'imidacloprid',
    label: 'Imidacloprid',
    activeIngredientPrefix: 'imidacloprid',
    // Trunk injection: dosed per tree by trunk diameter on its own label, never spread over the
    // beds. It is not a share of the bed amount, so the sheet says so and does not hold it. Its
    // rows are left out of the bed ledger for the same reason.
    injectionPatterns: Object.freeze([/^arborjet\s+ima-jet\b/i]),
    products: Object.freeze([
      {
        shortName: 'Merit',
        // The 2F liquid only: Merit 75 WSP or a granule is another strength and unit, so it has no
        // entry and the sheet holds it.
        namePattern: /^merit\s*2\s*f\b/i,
        unit: 'fl_oz',
        // 1.6 pints = 25.6 fl oz of product (0.4 lb ai) per acre per year = 0.588 fl oz per 1,000 sq ft.
        perAcreYear: 25.6,
        source: 'Merit 2F label: imidacloprid 2 lb ai/gal; 1.6 pints (25.6 fl oz) per acre per year',
      },
      {
        shortName: 'Dominion 2L',
        namePattern: /^dominion\s+2l\b/i,
        unit: 'fl_oz',
        // The same strength and the same ornamental limit as Merit 2F.
        perAcreYear: 25.6,
        source: 'Dominion 2L label (Control Solutions, EPA 53883-229): imidacloprid 2 lb ai/gal; outdoor ornamentals 1.6 pints (0.4 lb ai) per acre per year',
      },
    ]),
  },
]);

module.exports = { SQFT_PER_ACRE, NEONIC_CAPS };
