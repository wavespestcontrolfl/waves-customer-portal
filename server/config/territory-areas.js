/**
 * Territory areas (owner 2026-10-30: "each tech will have a territory", drawn by ZIP;
 * scope page "Waves Territory Map", question 4 "go"). An area is a group of whole
 * ZIPs between hard edges (the Manatee River, I-75, University Parkway, the county
 * line). A territory is a set of areas plus swing ZIPs at the seams; which
 * technician owns a ZIP lives in territory_zips.technician_id, not here.
 *
 * This list is labels and order only. ZIP membership is the territory_zips table,
 * seeded by migration 20261031000000_territory_zips.js (one ZIP, one area).
 *
 * Deliberately separate from the other geo lists (config/county-zips.js is the
 * tax/compliance county map, utils/zip-to-city.js is ZIP -> USPS city): an area
 * is a routing unit, not a county or a city.
 */
const TERRITORY_AREAS = Object.freeze([
  Object.freeze({ slug: 'north_river', label: 'North of the river' }),
  Object.freeze({ slug: 'ranch', label: 'Ranch' }),
  Object.freeze({ slug: 'bradenton_west', label: 'Bradenton West' }),
  Object.freeze({ slug: 'university', label: 'University' }),
  Object.freeze({ slug: 'sarasota', label: 'Sarasota' }),
  Object.freeze({ slug: 'venice', label: 'Venice' }),
  Object.freeze({ slug: 'charlotte', label: 'Charlotte' }),
]);

const AREA_SLUGS = Object.freeze(TERRITORY_AREAS.map((area) => area.slug));

/** The label for an area slug, or null for an unknown slug. */
function areaLabel(slug) {
  const area = TERRITORY_AREAS.find((row) => row.slug === slug);
  return area ? area.label : null;
}

module.exports = { TERRITORY_AREAS, AREA_SLUGS, areaLabel };
