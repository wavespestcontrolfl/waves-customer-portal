/**
 * Product wording for the customer service report (owner-approved 2026-09-28,
 * verbatim from the reviewed wording page — GATE_REPORT_PRODUCT_COPY).
 *
 * Three short customer-facing lines per applied product:
 *   howItWorks     — one plain sentence on what the product does.
 *   alsoLabeledFor — other pests the LABEL covers, worded as what the
 *                    product is labeled for, never as something treated on
 *                    THIS visit. Omitted entirely for the LESCO surfactant
 *                    (it is not a pesticide) — see `alsoLabeledFor: null`.
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
 * approved as-is 2026-09-28).
 */

function normalizeEpaReg(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeProductName(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

const REPORT_PRODUCT_COPY = [
  {
    epaReg: '53883-279',
    names: ['taurus sc'],
    howItWorks: 'Pests can’t detect it, so they walk right through the treated band along your foundation and carry it back to the nest — reaching ants you never see.',
    alsoLabeledFor: 'Big-headed, crazy, carpenter and pharaoh ants; smoky brown and Australian cockroaches; black widow and brown recluse spiders; centipedes, millipedes, earwigs, crickets, silverfish, pill bugs, ticks, paper wasps and yellow jackets.',
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
    alsoLabeledFor: 'Ants including fire ants, spiders including black widows, cockroaches, scorpions, centipedes, millipedes, earwigs, crickets, silverfish, pill bugs, fleas, ticks, mosquitoes and wasps.',
    petsKids: 'Stay off treated areas until the application has dried.',
  },
  {
    epaReg: '499-561',
    names: ['alpine wsg'],
    howItWorks: 'A fast-acting non-repellent. Pests don’t avoid it, so we use it on ant trails, entry points and the cracks where roaches hide.',
    alsoLabeledFor: 'Ants (except pharaoh ants), cockroaches, crickets, earwigs, millipedes, pill bugs, spiders (except brown recluse), paper wasps, yellow jackets, flies and bed bugs.',
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '100-1066',
    names: ['demand cs'],
    howItWorks: 'Microscopic capsules that stay on surfaces for weeks; insects pick them up as they walk across. It holds up well on stucco and wood.',
    alsoLabeledFor: 'Ants, cockroaches, spiders, scorpions, centipedes, millipedes, earwigs, crickets, silverfish, pill bugs, fleas, ticks, mosquitoes and wasps.',
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '1021-2574',
    names: ['onslaught fastcap'],
    howItWorks: 'Made for spiders and scorpions: one ingredient flushes them out and knocks them down fast, and microcapsules keep working on eaves, soffits and ledges.',
    alsoLabeledFor: 'Widow and wolf spiders, scorpions and ghost ants.',
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '100-1484',
    names: ['advion evolution cockroach gel bait'],
    howItWorks: 'Roaches eat the gel and share it back where they hide, so it reaches roaches we never see. The placements stay attractive for weeks.',
    alsoLabeledFor: 'German, American and smoky brown cockroaches.',
    petsKids: 'No wait to go back in. Please leave the small bait placements alone.',
  },
  {
    epaReg: '100-1498',
    names: ['advion ant bait gel'],
    howItWorks: 'Worker ants carry the gel home and feed it to the queen and young — that’s how whole colonies go down, not just the ants you see.',
    alsoLabeledFor: 'Ghost ants, big-headed ants, crazy ants and pharaoh ants.',
    petsKids: 'No re-entry wait for living spaces; leave the placements undisturbed.',
  },
  {
    epaReg: '100-1483',
    names: ['advion wdg granular'],
    howItWorks: 'A granular bait scattered in beds and along the foundation. Ants and crickets eat it and carry it back to where they live.',
    alsoLabeledFor: 'Ghost ants, big-headed ants, crickets including mole crickets, and silverfish.',
    petsKids: 'No re-entry wait for living spaces; leave the granules undisturbed.',
  },
  {
    epaReg: '2724-351',
    names: ['gentrol igr'],
    howItWorks: 'An insect growth regulator: young roaches can’t mature or reproduce, so it breaks the breeding cycle. Results build over the following weeks.',
    alsoLabeledFor: 'German and American cockroaches.',
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '53883-335',
    names: ['tekko pro igr'],
    howItWorks: 'Two growth regulators in one: eggs don’t hatch and young insects can’t grow into breeding adults.',
    alsoLabeledFor: 'German cockroaches, fleas and mosquitoes.',
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '432-772',
    names: ['delta dust'],
    howItWorks: 'A waterproof dust puffed into wall voids, weep holes and outlets, where pests travel and hide. It keeps working there for months.',
    alsoLabeledFor: 'Ghost ants, German cockroaches, paper wasps and silverfish.',
    petsKids: 'No re-entry wait for living spaces; the treated voids stay undisturbed.',
  },
  {
    // Spray adjuvant, not a pesticide — no EPA registration to match on, so
    // this entry resolves by name only.
    epaReg: null,
    names: ['lesco 90/10 nonionic surfactant'],
    howItWorks: 'A spreader added to the spray so it covers evenly and sticks to surfaces. It isn’t a pesticide and doesn’t target pests on its own.',
    // No "also labeled for" line at all for the surfactant (owner ruling
    // 2026-09-28) — never render an empty/placeholder line for it.
    alsoLabeledFor: null,
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

// EPA registration number FIRST (it is on the label, so it survives any
// catalog display-name spelling); the normalized name list is the fallback
// for rows with no `epa_reg_number` at all. Exact lookups only — never a
// substring/regex match.
function findReportProductCopyEntry({ epaReg, name } = {}) {
  const reg = normalizeEpaReg(epaReg);
  if (reg && BY_EPA_REG.has(reg)) return BY_EPA_REG.get(reg);
  const key = normalizeProductName(name);
  if (key && BY_NAME.has(key)) return BY_NAME.get(key);
  return null;
}

// Public shape for the report payload — snake_case to match the surrounding
// `applications[].product` fields (service_report_summary, precaution_summary,
// epa_reg, ...). `also_labeled_for` is OMITTED (never a null/empty string)
// when the matched entry has none, per the LESCO ruling above.
function reportProductCopyFor({ epaReg, name } = {}) {
  const entry = findReportProductCopyEntry({ epaReg, name });
  if (!entry) return null;
  return {
    how_it_works: entry.howItWorks,
    ...(entry.alsoLabeledFor ? { also_labeled_for: entry.alsoLabeledFor } : {}),
    pets_kids: entry.petsKids,
  };
}

module.exports = {
  REPORT_PRODUCT_COPY,
  findReportProductCopyEntry,
  reportProductCopyFor,
};
