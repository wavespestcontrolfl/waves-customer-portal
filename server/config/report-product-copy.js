/**
 * Product wording for the customer service report (owner-approved 2026-09-28,
 * verbatim from the reviewed wording page — GATE_REPORT_PRODUCT_COPY; the
 * "also labeled for" line was replaced with a high-level count + city per
 * owner ruling 2026-09-29 — see below).
 *
 * Three short customer-facing lines per applied product:
 *   howItWorks           — one plain sentence on what the product does.
 *   alsoLabeledForPestCount — the RAW distinct-pest count read off the
 *                    product's current EPA/registrant label (owner ruling
 *                    2026-09-29 counting rules — see the comment beside each
 *                    entry for the source/date). Rendered as
 *                    `Labeled for {N}+ {City} pests` (or `Labeled for {N}+
 *                    pests` with no usable city), where N is this raw count
 *                    FLOORED to a multiple of 25 by `floorToMultipleOf25`
 *                    (buildAlsoLabeledForText) — never a named pest list.
 *                    Omitted entirely for narrow products (gel baits,
 *                    granular bait, IGRs) and the LESCO surfactant — see
 *                    `alsoLabeledForPestCount` absent below.
 *   petsKids       — re-entry / pets-and-kids guidance in plain language.
 *
 * Matched PRIMARILY by EPA registration number (the number printed on the
 * label itself, so it survives any catalog display-name spelling), read off
 * the applied product's own `epa_reg_number` (report-data.js's
 * `attachApprovedReportProductFacts` already resolves this from the catalog
 * join). Products with no EPA registration (the LESCO surfactant is not a
 * pesticide) match by normalized name only. Every entry ALSO carries an
 * explicit name-alias list as a fallback: a hand-entered service_products
 * row with no product_id never joined the catalog, so it carries no
 * `epa_reg_number` at all and must still resolve by name — and the catalog's
 * OWN canonical name can differ from this page's display spelling (e.g. the
 * catalog row is "Atticus Talak", not "Atticus Talak 7.9 F" — both are
 * listed below, same posture pest-report-expectations.js's
 * PRODUCT_EXPECTATION_CLASS takes for the same product).
 *
 * NOT fuzzy: no substring/regex matching, ever (owner ruling 2026-09-28). A
 * product absent from this list gets NO copy at all — fail closed, never
 * guessed. Extend this list only with new owner-verified wording, never
 * inferred or paraphrased.
 *
 * Source: owner-approved wording page (report-product-wording.html,
 * approved as-is 2026-09-28); pest counts re-read directly off each
 * product's current EPA/registrant label 2026-09-29 (owner ruling — replace
 * named pest lists with a high-level count + city).
 */

function normalizeEpaReg(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeProductName(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// N = the label's raw pest count rounded DOWN to a multiple of 25 (owner
// ruling 2026-09-29). A non-finite/non-positive input yields 0 (treated as
// "no line" by buildAlsoLabeledForText) rather than a negative/NaN result.
function floorToMultipleOf25(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 25) * 25;
}

// Normalizes a city for display: trim, collapse internal whitespace, and
// title-case a value that is ENTIRELY upper- or lower-case (owner ruling
// 2026-09-29) — a mixed-case value is trusted as already correctly cased and
// passed through unchanged (never invented, never re-cased). Returns null
// for blank/unusable input (nothing left after trimming, or no letters at
// all — e.g. stray punctuation/digits).
function normalizeReportCity(rawCity) {
  const collapsed = String(rawCity == null ? '' : rawCity).trim().replace(/\s+/g, ' ');
  if (!collapsed || !/[a-zA-Z]/.test(collapsed)) return null;
  const isAllCaps = collapsed === collapsed.toUpperCase() && collapsed !== collapsed.toLowerCase();
  const isAllLower = collapsed === collapsed.toLowerCase() && collapsed !== collapsed.toUpperCase();
  if (!isAllCaps && !isAllLower) return collapsed;
  return collapsed
    .toLowerCase()
    .split(' ')
    .map((word) => word.replace(/^[a-z]/, (ch) => ch.toUpperCase()))
    .join(' ');
}

// The one place the customer-facing sentence is composed (owner ruling
// 2026-09-29): `Labeled for {N}+ {City} pests`, falling back to `Labeled for
// {N}+ pests` when no usable city is available. Returns null (never render a
// line) when the product carries no pest count at all.
function buildAlsoLabeledForText(pestCount, city) {
  const floored = floorToMultipleOf25(pestCount);
  if (!floored) return null;
  const normalizedCity = normalizeReportCity(city);
  return normalizedCity
    ? `Labeled for ${floored}+ ${normalizedCity} pests`
    : `Labeled for ${floored}+ pests`;
}

const REPORT_PRODUCT_COPY = [
  {
    epaReg: '53883-279',
    names: ['taurus sc'],
    howItWorks: 'Pests can’t detect it, so they walk right through the treated band along your foundation and carry it back to the nest — reaching ants you never see.',
    // 35 distinct pests — Control Solutions Inc. current specimen label,
    // cross-checked against the EPA PPLS supplemental label accepted
    // 11/04/2015 (EPA Reg. No. 53883-279). -> floors to 25+.
    alsoLabeledForPestCount: 35,
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '91234-145',
    // The catalog's canonical products_catalog.name is "Atticus Talak"
    // (migration 20260712100000_catalog_label_rate_backfill.js); this
    // wording page's longer "Atticus Talak 7.9 F" display spelling is kept
    // as a second alias for any hand-entered row using it.
    names: ['atticus talak', 'atticus talak 7.9 f'],
    howItWorks: 'A long-lasting barrier on soil, walls and eaves. Insects that crawl across or rest on treated surfaces pick up a dose — our main barrier against spiders and crawling invaders.',
    // 88 distinct pests — Atticus, LLC current specimen label (Talak 7.9 F,
    // EPA Reg. No. 91234-145), read in full 2026-09-29. -> floors to 75+.
    alsoLabeledForPestCount: 88,
    petsKids: 'Stay off treated areas until the application has dried.',
  },
  {
    epaReg: '499-561',
    names: ['alpine wsg'],
    howItWorks: 'A fast-acting non-repellent. Pests don’t avoid it, so we use it on ant trails, entry points and the cracks where roaches hide.',
    // 30 distinct pests — EPA PPLS, accepted 05/01/2019 (BASF Alpine WSG,
    // EPA Reg. No. 499-561; no later PPLS version found). -> floors to 25+.
    alsoLabeledForPestCount: 30,
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '100-1066',
    names: ['demand cs'],
    howItWorks: 'Microscopic capsules that stay on surfaces for weeks; insects pick them up as they walk across. It holds up well on stucco and wood.',
    // 90 distinct pests — EPA PPLS, accepted 01/23/2024 (Syngenta Demand CS
    // Master Label, EPA Reg. No. 100-1066), structural + ornamental + turf
    // tables reconciled. -> floors to 75+.
    alsoLabeledForPestCount: 90,
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '1021-2574',
    names: ['onslaught fastcap'],
    howItWorks: 'Made for spiders and scorpions: one ingredient flushes them out and knocks them down fast, and microcapsules keep working on eaves, soffits and ledges.',
    // 169 distinct pests — MGK current specimen label (Onslaught FastCap
    // Spider & Scorpion Insecticide, EPA Reg. No. 1021-2574), printed
    // 7/28/2020. -> floors to 150+.
    alsoLabeledForPestCount: 169,
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '100-1484',
    names: ['advion evolution cockroach gel bait'],
    howItWorks: 'Roaches eat the gel and share it back where they hide, so it reaches roaches we never see. The placements stay attractive for weeks.',
    // Narrow bait product (owner ruling 2026-09-29): no "also labeled for"
    // line at all — alsoLabeledForPestCount intentionally absent.
    petsKids: 'Please leave the small bait placements alone.',
  },
  {
    epaReg: '100-1498',
    names: ['advion ant bait gel'],
    howItWorks: 'Worker ants carry the gel home and feed it to the queen and young — that’s how whole colonies go down, not just the ants you see.',
    // Narrow bait product (owner ruling 2026-09-29): no line.
    petsKids: 'Leave the placements undisturbed.',
  },
  {
    epaReg: '100-1483',
    names: ['advion wdg granular'],
    howItWorks: 'A granular bait scattered in beds and along the foundation. Ants and crickets eat it and carry it back to where they live.',
    // Narrow granular bait product (owner ruling 2026-09-29): no line.
    petsKids: 'Leave the granules undisturbed.',
  },
  {
    epaReg: '2724-351',
    names: ['gentrol igr'],
    howItWorks: 'An insect growth regulator: young roaches can’t mature or reproduce, so it breaks the breeding cycle. Results build over the following weeks.',
    // Narrow IGR product (owner ruling 2026-09-29): no line.
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '53883-335',
    names: ['tekko pro igr'],
    howItWorks: 'Two growth regulators in one: eggs don’t hatch and young insects can’t grow into breeding adults.',
    // Narrow IGR product (owner ruling 2026-09-29): no line.
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '432-772',
    names: ['delta dust'],
    howItWorks: 'A waterproof dust puffed into wall voids, weep holes and outlets, where pests travel and hide. It keeps working there for months.',
    // 66 distinct pests — registrant specimen label (AgrEvo -> Bayer ->
    // Envu lineage, unchanged 0.05% deltamethrin dust formulation), 1999
    // print, read in full. VERIFIED 2026-09-29 against Envu's current live
    // specimen-label download (bynder.envu.com, undated on this copy,
    // fetched directly from envu.com's own DeltaDust product page) — that
    // current label independently lists at least 50 distinct pests (a
    // fresh count applying the same rules found ~74, driven mainly by an
    // expanded ornamental-pest table and stored-product list not present on
    // the 1999 copy), so the 66-count/50+ claim below ships. If a future
    // edit needs the exact current-label count re-verified, re-fetch from
    // envu.com's DeltaDust product page rather than the 1999 copy. -> floors
    // to 50+.
    alsoLabeledForPestCount: 66,
    petsKids: 'The treated voids stay undisturbed.',
  },
  {
    // Spray adjuvant, not a pesticide — no EPA registration to match on, so
    // this entry resolves by name only.
    epaReg: null,
    names: ['lesco 90/10 nonionic surfactant'],
    howItWorks: 'A spreader added to the spray so it covers evenly and sticks to surfaces. It isn’t a pesticide and doesn’t target pests on its own.',
    // No "also labeled for" line at all for the surfactant (owner ruling
    // 2026-09-28) — never render an empty/placeholder line for it.
    petsKids: 'Follows the spray it’s mixed into.',
  },
];

const BY_EPA_REG = new Map();
const BY_NAME = new Map();
for (const entry of REPORT_PRODUCT_COPY) {
  const reg = normalizeEpaReg(entry.epaReg);
  if (reg && !BY_EPA_REG.has(reg)) BY_EPA_REG.set(reg, entry);
  for (const name of entry.names) {
    const key = normalizeProductName(name);
    if (key && !BY_NAME.has(key)) BY_NAME.set(key, entry);
  }
}

// EPA registration number is AUTHORITATIVE when present (it is on the
// label, so it survives any catalog display-name spelling): a non-empty
// `epaReg` either matches the config or the product gets no copy at all —
// it never falls through to a name alias, which could belong to a
// different, unrelated product sharing that display name (codex P1
// 2026-09-28: an unrecognized EPA reg alongside a name that happens to
// alias an approved product must never borrow that product's copy). The
// normalized name list is the fallback ONLY for rows with no `epa_reg_number`
// recorded at all (the LESCO surfactant; a hand-entered row with no catalog
// join). Exact lookups only — never a substring/regex match.
function findReportProductCopyEntry({ epaReg, name } = {}) {
  const reg = normalizeEpaReg(epaReg);
  if (reg) return BY_EPA_REG.get(reg) || null;
  const key = normalizeProductName(name);
  if (key && BY_NAME.has(key)) return BY_NAME.get(key);
  return null;
}

// Public shape for the report payload — snake_case to match the surrounding
// `applications[].product` fields (service_report_summary, precaution_summary,
// epa_reg, ...). `also_labeled_for` is OMITTED (never a null/empty string)
// when the matched entry carries no pest count (narrow products, LESCO), per
// the owner rulings above. `city` is the visit's own city (see the caller in
// report-product-copy.js/report-data.js for precedence) — passed straight
// through to buildAlsoLabeledForText, which normalizes/falls back on it.
function reportProductCopyFor({ epaReg, name, city } = {}) {
  const entry = findReportProductCopyEntry({ epaReg, name });
  if (!entry) return null;
  const alsoLabeledFor = entry.alsoLabeledForPestCount
    ? buildAlsoLabeledForText(entry.alsoLabeledForPestCount, city)
    : null;
  return {
    how_it_works: entry.howItWorks,
    ...(alsoLabeledFor ? { also_labeled_for: alsoLabeledFor } : {}),
    pets_kids: entry.petsKids,
  };
}

module.exports = {
  REPORT_PRODUCT_COPY,
  findReportProductCopyEntry,
  reportProductCopyFor,
  floorToMultipleOf25,
  normalizeReportCity,
  buildAlsoLabeledForText,
};
