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
 *   mainPests      — what we mainly use the product for (owner 2026-10-12:
 *                    "if we use Taurus it should know it is focused on
 *                    ants; Alpine and Gentrol, roaches"). Read only by the
 *                    AI report writer's PRODUCT FACTS block
 *                    (report-writer-records.js); never printed as a list.
 *                    Absent = the writer gets no main-pest fact.
 *   labelPests     — the pests the product's current EPA label names, as the
 *                    fixed terms in label-pest-facts.js (owner 2026-10-24,
 *                    "labels go"). Read only by the AI report writer's
 *                    PRODUCT FACTS, and only for a pest the technician named
 *                    today (GATE_PEST_LABEL_FACTS); never printed as a list.
 *   labelPestsExcept — species the label leaves out by name; they never fall
 *                    back to their group.
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
    mainPests: ['ants'],
    howItWorks: 'Pests can’t detect it, so they walk right through the treated band along your foundation and carry it back to the nest — reaching ants you never see.',
    // 35 distinct pests — Control Solutions Inc. current specimen label,
    // cross-checked against the EPA PPLS supplemental label accepted
    // 11/04/2015 (EPA Reg. No. 53883-279). -> floors to 25+.
    alsoLabeledForPestCount: 35,
    // Pests its current EPA label names, for the writer's "its label lists" fact
    // (GATE_PEST_LABEL_FACTS; label-pest-facts.js). EPA PPLS 053883-00279-20200617 (2020-06-17).
    // Ants, cockroaches and spiders appear only as closed lists of species, so no group term.
    labelPests: ['Big-headed ants', 'Crazy ants', 'Carpenter ants', 'Argentine ants', 'Pharaoh ants', 'Smokybrown cockroaches', 'Australian cockroaches', 'silverfish', 'millipedes', 'centipedes', 'Paper wasps', 'Yellowjackets'],
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '91234-145',
    // The catalog's canonical products_catalog.name is "Atticus Talak"
    // (migration 20260712100000_catalog_label_rate_backfill.js); this
    // wording page's longer "Atticus Talak 7.9 F" display spelling is kept
    // as a second alias for any hand-entered row using it.
    names: ['atticus talak', 'atticus talak 7.9 f'],
    mainPests: ['spiders', 'crawling insects'],
    howItWorks: 'A long-lasting barrier on soil, walls and eaves. Insects that crawl across or rest on treated surfaces pick up a dose — our main barrier against spiders and crawling invaders.',
    // 88 distinct pests — Atticus, LLC current specimen label (Talak 7.9 F,
    // EPA Reg. No. 91234-145), read in full 2026-09-29. -> floors to 75+.
    alsoLabeledForPestCount: 88,
    // Pests its current EPA label names, for the writer's "its label lists" fact
    // (GATE_PEST_LABEL_FACTS; label-pest-facts.js). EPA PPLS 083520-00003-20130613 (2013-06-13).
    // Filed as Bifen 7.9 SC (83520-3), the same registration before it moved to Atticus on 2019-04-10; the Atticus
    // specimen label F20130613a matches.
    labelPests: ['ants', 'cockroaches', 'spiders', 'wasps', 'flies', 'Carpenter ants', 'Fire ants', 'Widow spiders', 'silverfish', 'earwigs', 'millipedes', 'centipedes', 'springtails', 'crickets', 'Yellowjackets', 'scorpions'],
    petsKids: 'Stay off treated areas until the application has dried.',
  },
  {
    epaReg: '499-561',
    names: ['alpine wsg'],
    mainPests: ['ants', 'roaches'],
    howItWorks: 'A non-repellent. Pests don’t avoid it, so we use it on ant trails, entry points and the cracks where roaches hide.',
    // 30 distinct pests — EPA PPLS, accepted 05/01/2019 (BASF Alpine WSG,
    // EPA Reg. No. 499-561; no later PPLS version found). -> floors to 25+.
    alsoLabeledForPestCount: 30,
    // Pests its current EPA label names, for the writer's "its label lists" fact
    // (GATE_PEST_LABEL_FACTS; label-pest-facts.js). EPA PPLS 000499-00561-20190501 (2019-05-01).
    // Wasps and flies appear only as listed species; "Ants (excluding Pharaoh)".
    labelPests: ['ants', 'cockroaches', 'spiders', 'Carpenter ants', 'Fire ants', 'Argentine ants', 'German cockroaches', 'American cockroaches', 'earwigs', 'millipedes', 'centipedes', 'springtails', 'crickets', 'Paper wasps', 'Yellowjackets', 'House flies'],
    labelPestsExcept: ['Pharaoh ants'],
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
    // Pests its current EPA label names, for the writer's "its label lists" fact
    // (GATE_PEST_LABEL_FACTS; label-pest-facts.js). EPA PPLS 000100-01066-20260128 (2026-01-28).
    // Bed bugs, pantry pests and termites are narrower on the label (adults, beetles, above ground only), so none
    // is listed.
    labelPests: ['ants', 'cockroaches', 'spiders', 'wasps', 'flies', 'Fire ants', 'silverfish', 'earwigs', 'millipedes', 'centipedes', 'crickets', 'scorpions'],
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
    // Pests its current EPA label names, for the writer's "its label lists" fact
    // (GATE_PEST_LABEL_FACTS; label-pest-facts.js). EPA PPLS 001021-02574-20260305 (2026-03-05).
    // Flies appear only as house flies; "Ants (excluding fire ants)".
    labelPests: ['ants', 'cockroaches', 'spiders', 'wasps', 'Carpenter ants', 'German cockroaches', 'silverfish', 'earwigs', 'millipedes', 'springtails', 'booklice', 'crickets', 'Yellowjackets', 'House flies', 'scorpions'],
    labelPestsExcept: ['Fire ants'],
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '100-1484',
    names: ['advion evolution cockroach gel bait'],
    mainPests: ['roaches'],
    howItWorks: 'Roaches eat the gel and share it back where they hide, so it reaches roaches we never see. The placements stay attractive for weeks.',
    // Narrow bait product (owner ruling 2026-09-29): no "also labeled for"
    // line at all — alsoLabeledForPestCount intentionally absent.
    // Pests its current EPA label names, for the writer's "its label lists" fact
    // (GATE_PEST_LABEL_FACTS; label-pest-facts.js). EPA PPLS 000100-01484-20240725 (2024-07-25).
    // The July 2024 label names German and American cockroaches; other cockroaches only as "cockroaches".
    labelPests: ['cockroaches', 'German cockroaches', 'American cockroaches'],
    petsKids: 'Please leave the small bait placements alone.',
  },
  {
    epaReg: '100-1498',
    names: ['advion ant bait gel'],
    howItWorks: 'Worker ants carry the gel home and feed it to the queen and young — that’s how whole colonies go down, not just the ants you see.',
    // Narrow bait product (owner ruling 2026-09-29): no line.
    // Pests its current EPA label names, for the writer's "its label lists" fact
    // (GATE_PEST_LABEL_FACTS; label-pest-facts.js). EPA PPLS 000100-01498-20200417 (2020-04-17).
    // Fire ants are limited to foraging red imported fire ants, so not listed.
    labelPests: ['ants', 'Ghost ants', 'Big-headed ants', 'Crazy ants', 'White-footed ants', 'Carpenter ants', 'Argentine ants', 'Pharaoh ants', 'Rover ants'],
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
    mainPests: ['roaches'],
    howItWorks: 'An insect growth regulator: young roaches can’t mature or reproduce, so it breaks the breeding cycle. Results build over the following weeks.',
    // Narrow IGR product (owner ruling 2026-09-29): no line.
    // Pests its current EPA label names, for the writer's "its label lists" fact
    // (GATE_PEST_LABEL_FACTS; label-pest-facts.js). EPA PPLS 002724-00351-20091201 (2009-12-01).
    // A growth regulator: the label says exposed cockroaches "become adults incapable of reproducing". Fleas, bed
    // bugs and pantry pests are never facts here.
    labelPests: ['cockroaches', 'Drain flies'],
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '53883-335',
    names: ['tekko pro igr'],
    howItWorks: 'Two growth regulators in one: eggs don’t hatch and young insects can’t grow into breeding adults.',
    // Narrow IGR product (owner ruling 2026-09-29): no line.
    // Pests its current EPA label names, for the writer's "its label lists" fact
    // (GATE_PEST_LABEL_FACTS; label-pest-facts.js). EPA PPLS 053883-00335-20250522 (2025-05-22).
    // A growth regulator: the label says it "prevents the adult pest from developing".
    labelPests: ['ants', 'cockroaches', 'flies', 'crickets', 'House flies'],
    petsKids: 'Keep people and pets off treated areas until the spray has dried.',
  },
  {
    epaReg: '432-772',
    names: ['delta dust'],
    howItWorks: 'A dust that does not clump or absorb moisture, puffed into wall voids, weep holes and outlets, where pests travel and hide. It keeps working there for months.',
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
    // Pests its current EPA label names, for the writer's "its label lists" fact
    // (GATE_PEST_LABEL_FACTS; label-pest-facts.js). EPA PPLS 000432-00772-20160805 (2016-08-05).
    // Now Envu 101563-6; PPLS has no newer stamped label, and the current Envu specimen label matches. Flies and
    // termites are narrower on the label.
    labelPests: ['ants', 'cockroaches', 'spiders', 'wasps', 'Carpenter ants', 'Fire ants', 'silverfish', 'millipedes', 'centipedes', 'crickets', 'scorpions'],
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
