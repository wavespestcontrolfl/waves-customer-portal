/**
 * Pest Report V2 — customer-value "expectations" blocks (owner-approved
 * 2026-09-27, dark behind GATE_PEST_REPORT_EXPECTATIONS).
 *
 * Two deterministic, honest, non-guaranteeing blocks built from data the
 * visit already collected: (1) a spider ("#1 callback") acknowledgment
 * triggered ONLY by a recorded completed eave/web/soffit protocol action
 * (owner ruling 2026-09-28: a spider-targeted product alone does NOT
 * establish eaves were treated — see buildSpiderExpectation), and (2) a
 * short "what to expect" list keyed to an EXPLICIT, closed product-name map
 * (owner ruling 2026-09-28: never inferred from active ingredient /
 * moa_group / category — see PRODUCT_EXPECTATION_CLASS). Pure — no I/O, no
 * DB, no fetch — every fact is handed in by the caller (report-data.js /
 * report-copy-context.js / reports-public.js), matching the existing
 * pest-report-v2.js "thin arranger" pattern. Every synthesized line runs
 * through the shared banned-copy guard (validateCustomerCopy) before it can
 * render.
 *
 * The "Rain and your treatment" block was removed for good (owner
 * 2026-10-05); the rain key is no longer emitted.
 */

const { validateCustomerCopy } = require('./premium-experience');

function pestReportExpectationsGateOn() {
  return process.env.GATE_PEST_REPORT_EXPECTATIONS === 'true';
}

// Controlled treatment-area chip vocabulary (shared/treatment-area-scopes.json
// — the SAME source report-data.js's own interior/exterior classification
// reads, `AREA_SCOPE_BY_LABEL`). codex P1 2026-09-29 (pre-push audit round
// 3): an earlier unanchored substring regex here (`entry points?`) matched
// the controlled INTERIOR chip "Interior entry points" — a Demand CS
// application chipped there earned both the exterior barrier sentence and
// the ants "treated band" claim. Area evidence now resolves through this
// EXACT, by-key lookup against the controlled classification instead of any
// substring/regex match, matching the "explicit map, never guessed" posture
// classifyProductExpectation already uses. An unrecognized or free-text area
// never qualifies as exterior — fail closed, same as an unmapped product.
const AREA_SCOPES = require('../../../shared/treatment-area-scopes.json');

function normalizeAreaChipText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const EXTERIOR_AREA_CHIPS = new Set((AREA_SCOPES.exterior || []).map(normalizeAreaChipText));
// The eave/soffit chip(s) BY KEY — there is no "overhang" chip in the
// controlled vocabulary, so nothing else may stand in for it.
const EAVE_AREA_CHIPS = new Set(['Eaves / soffit', 'Eaves / soffits'].map(normalizeAreaChipText));

// application_area may be a comma-joined multi-area list (report-data.js's
// matchZoneIds handles the same shape) — split and normalize each part so a
// legitimate chip is recognized regardless of what else rides alongside it.
function applicationAreaChips(value) {
  return String(value || '')
    .split(',')
    .map((part) => normalizeAreaChipText(part))
    .filter(Boolean);
}

function isExteriorApplicationArea(value) {
  return applicationAreaChips(value).some((chip) => EXTERIOR_AREA_CHIPS.has(chip));
}

function isEaveApplicationArea(value) {
  return applicationAreaChips(value).some((chip) => EAVE_AREA_CHIPS.has(chip));
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// ── Spiders (#1 callback) ────────────────────────────────────────────────
// Owner ruling 2026-09-28 (P1 audit): a spider-TARGETED product does NOT
// establish that eaves were treated — the tech may have tagged a product
// for spiders while applying it somewhere else entirely (interior crack &
// crevice, a different zone). The ONLY evidence the eaves/webs were worked
// is a recorded completed eave/web/soffit protocol action (protocols.json —
// e.g. "Swept eaves, window frames, door frames, and lanai"), so that is
// now the SOLE entry point for this whole section. No action recorded =>
// no spider section, full stop — never inferred from a product target
// alone. actionLabels: raw completed-action label strings for the visit
// (server-internal only — see report-data.js's completedProtocolActionLabels;
// never rendered verbatim, only matched) — used ONLY for the section gate
// above. actionEntries: the same completed actions WITH treatmentApplied
// preserved (report-data.js's completedProtocolActionEntries,
// { label, treatmentApplied }[], server-internal only) — used for the
// residual-evidence check below, where a sweep (treatmentApplied: false)
// must not count as a treatment. applications: the same array pest-report-v2
// builds ({ product: {...}, targets: [...], applicationArea, ... }).
const SPIDER_ACTION_RE = /\b(eave|eaves|web|webs|webbing|soffit|cobweb)\b/i;
// The LOCATION claim ("around the eaves and entry points") needs an action
// that actually names the eaves/soffit — codex P2 2026-09-28 round 5: the
// canonical exterior action "Removed accessible webs from the recorded
// exterior areas." is a web action (opens the section) but says nothing
// about where, so it gets location-neutral wording.
const EAVE_ACTION_RE = /\b(eave|eaves|soffit|soffits)\b/i;
// Actual evidence webs were REMOVED, as opposed to merely an eave/soffit
// LOCATION being named (codex P2 deferred finding b, #5137): the
// completedActions "serviced-eaves" choice ("Completed the recorded eave and
// soffit service.", client/src/lib/service-completion-choices.js) matches
// SPIDER_ACTION_RE purely because it names the eaves — it records no web
// work of any kind and could just as easily be a residual application or an
// inspection. Every wording this module can produce opens with "We knocked
// down webs...", so that claim needs an action that actually says so: either
// it names web(s)/webbing/a cobweb directly (the completedActions
// "removed-webs" choice), or it explicitly SWEPT (protocols.json's "Swept
// eaves, window frames, door frames, and lanai" — sweeping IS the
// web-removal act). A location-only eave action with none of that wording
// gets no card at all rather than an invented "we knocked down webs" claim.
const WEB_REMOVAL_ACTION_RE = /\b(webs?|webbing|cobweb|swept|sweep(?:ing)?)\b/i;
const SPIDER_TARGET_RE = /spider/i;
// Ant-specific wording (colony, "ants may show up more", the treated-band
// trail claim) needs an application the tech actually TAGGED for ants —
// codex P1 2026-09-28 round 4: a non-repellent applied for roaches only, or
// the auto-seeded pest mix on a visit with no ant target, must not tell the
// customer to expect ants. Word-bounded so "pants"/"giant" never match.
const ANT_TARGET_RE = /\bants?\b/i;
function hasAntTargetEvidence(product) {
  return Array.isArray(product?.targets) && product.targets.some((t) => ANT_TARGET_RE.test(t));
}
// Structured application-area evidence that the eaves/soffit specifically
// were worked (owner ruling 2026-09-28, P1 audit round 2: a spider-targeted
// pyrethroid applied ANYWHERE previously earned the residual/treated
// wording even when the tech only SWEPT the eaves — treatmentApplied:
// false — while separately spraying somewhere unrelated). isEaveApplicationArea
// (above) matches the controlled application-area chip vocabulary BY KEY —
// "Eaves / soffit(s)" only, never free text like technician notes, and never
// a substring match (codex P1 2026-09-29 round 3: a substring regex here
// would have the same false-positive class the exterior-barrier regex did).

// Fixed customer wording only — a raw completed protocol-action label is
// NEVER rendered here; it is used only to decide the action gate above.
//   1. action recorded, NO spider-labeled pyrethroid residual applied
//      -> de-web only, no treatment claim
//   2. action recorded AND a spider-labeled pyrethroid residual (from the
//      explicit PRODUCT_EXPECTATION_CLASS map) was also applied
//      -> combined wording — the eaves claim still rests on the recorded
//         action, never on the product target alone
// "any egg sacs": the records name webs, never egg sacs, so the copy never
// says egg sacs were there (codex #5523 P2).
const WEB_ONLY_TEXT = 'We swept webs and any egg sacs from your eaves and entry points.';
// Same de-web fact, location-neutral — no recorded action placed the work
// at the eaves (codex P2 round 5).
const WEB_ONLY_GENERIC_TEXT = 'We swept webs and any egg sacs from the exterior of your home.';
const WEB_AND_RESIDUAL_TEXT = 'We swept webs and any egg sacs, then applied a residual insecticide to the eaves and entry points where spiders build.';

// Owner 2026-10-01: webs are not a return-visit item, so the spider card has
// no "text us" next step, and it never tells the customer new webs are coming.
const WEB_ONLY_EXPECTATION = 'Removing webs and any egg sacs takes out established harborage and any eggs with them, so spiders lose their foothold on the structure.';
// Residual-backed expectation (combo 2) — the only case where a residual
// can be credited for thinning webs out over time.
const RESIDUAL_EXPECTATION = 'The residual binds to those surfaces, so it eliminates spiders that return to build there. Webbing thins out over the next few weeks.';

function buildSpiderExpectation({ actionLabels = [], actionEntries = [], applications = [] } = {}) {
  const actionHit = (actionLabels || []).some(
    (label) => SPIDER_ACTION_RE.test(cleanText(label)),
  );
  // No recorded eave/web/soffit action => no section, regardless of any
  // spider-targeted product (see module note above).
  if (!actionHit) return null;

  // Web-removal evidence, specifically — not just an eave/soffit-NAMED
  // action (codex P2 deferred finding b, #5137; see WEB_REMOVAL_ACTION_RE
  // above). Every wording below claims webs were knocked down; a
  // location-only "Completed the recorded eave and soffit service." with no
  // web-removal/sweep evidence anywhere on the visit earns no card, gate on
  // or off, residual or not — an unproven "we knocked down webs" claim is
  // never invented just because a treatment happened to reach the eaves.
  const webRemovalNamed = (actionLabels || []).some((label) => WEB_REMOVAL_ACTION_RE.test(cleanText(label)))
    || (actionEntries || []).some((entry) => WEB_REMOVAL_ACTION_RE.test(cleanText(entry?.label)));
  if (!webRemovalNamed) return null;

  // A genuine eave TREATMENT recorded for the visit — not just a sweep
  // (protocol marks a sweep treatmentApplied: false, and that alone is not
  // application evidence the eaves were treated; see the module note above
  // and the P1-C fix this closes). Visit-wide, not tied to one product.
  const eaveActionTreated = (actionEntries || []).some(
    (entry) => entry?.treatmentApplied === true && EAVE_ACTION_RE.test(cleanText(entry?.label)),
  );
  // Did any recorded action place the work AT the eaves/soffit? Without one
  // the de-web sentence stays location-neutral (codex P2 round 5).
  const eaveNamed = (actionLabels || []).some((label) => EAVE_ACTION_RE.test(cleanText(label)))
    || (actionEntries || []).some((entry) => EAVE_ACTION_RE.test(cleanText(entry?.label)));

  // A spider-labeled residual actually applied: tech-tagged for spiders,
  // classified pyrethroid by the explicit product-name map (never a target
  // tag alone — that was the FIRST P1 this replaced), AND now also tied to
  // the eaves/soffit area (owner ruling 2026-09-28, P1 audit round 2): the
  // application's OWN recorded area names eaves/soffit/overhang, OR the
  // visit separately recorded a genuine (treatmentApplied: true) eave
  // action above. A product applied somewhere else entirely — the eaves
  // only ever SWEPT — no longer earns the residual/treated wording.
  const residualApplied = (applications || []).some((app) => {
    const targeted = Array.isArray(app?.targets) && app.targets.some((t) => SPIDER_TARGET_RE.test(cleanText(t)));
    if (!targeted || classifyProductExpectation(toExpectationProduct(app)) !== 'pyrethroid') return false;
    const areaEvidence = isEaveApplicationArea(app?.applicationArea);
    return areaEvidence || eaveActionTreated;
  });

  const whatWeDid = residualApplied ? WEB_AND_RESIDUAL_TEXT : (eaveNamed ? WEB_ONLY_TEXT : WEB_ONLY_GENERIC_TEXT);
  const expectation = residualApplied ? RESIDUAL_EXPECTATION : WEB_ONLY_EXPECTATION;

  return {
    headline: 'Spiders',
    whatWeDid,
    expectation,
  };
}

// ── What to expect (by treatment) ────────────────────────────────────────
// Owner ruling 2026-09-28 (P1 audit, 2 rounds of misclassification from the
// prior heuristic — a spider-targeted product read as an eave treatment,
// and a category/name-regex classifier would have called an Advion ANT
// Bait Gel a roach product): classification is now an EXPLICIT, CLOSED map
// keyed by the exact catalog product name (normalized: cleanText + lower),
// never inferred from active ingredient, moa_group, or category alone. A
// product NOT in this map gets NO what-to-expect line — fail closed, never
// guess. Extend this map (with an owner-verified product name) rather than
// reintroducing inference.
function normalizeProductName(name) {
  return cleanText(name).toLowerCase();
}

const PRODUCT_EXPECTATION_CLASS = new Map([
  ['taurus sc', 'non_repellent'],
  ['alpine wsg', 'non_repellent'],
  // codex P2 2026-09-29 (round 2): the CATALOG's canonical products_catalog.name
  // is "Atticus Talak" (migration 20260712100000_catalog_label_rate_backfill.js,
  // and every other seed/backfill migration that touches this row) —
  // client/src/lib/pest-default-mix.js's house-mix matcher also resolves
  // against that exact catalog row name. "Atticus Talak 7.9 F" is kept too:
  // several purchase-receipt / Amazon-parser / completion-default-products
  // fixtures use the longer display string, and this map fails closed on
  // ANY spelling it doesn't carry — a name mismatch here silently drops a
  // product's classification with no error, so both spellings stay mapped.
  ['atticus talak', 'pyrethroid'],
  ['atticus talak 7.9 f', 'pyrethroid'],
  ['demand cs', 'pyrethroid'],
  ['onslaught fastcap', 'pyrethroid'],
  // Delta Dust is its own class, NOT 'pyrethroid' (owner ruling 2026-09-28,
  // P1 audit round 2): it is a DUST formulation applied into cracks/voids,
  // never a surface barrier — the old shared mapping told a customer whose
  // dust went into an interior void that "the barrier treatment... near
  // doors and windows" was working. See the 'dust' class copy below.
  ['delta dust', 'dust'],
  ['advion evolution cockroach gel bait', 'roach_gel_bait'],
  ['advion cockroach gel bait', 'roach_gel_bait'],
  ['advion ant bait gel', 'ant_bait'],
  // The catalog row is a granular bait broadcast by the pound (migration
  // 20260712100000, report-product-copy.js), and no approved line describes
  // a granular bait: the ant-bait line says "gel bait" (codex #5523 P1), so
  // it gets no line, the same fail-closed posture as an unmapped product.
  ['advion wdg granular', null],
  ['gentrol igr', 'igr'],
  ['tekko pro igr', 'igr'],
  // Surfactant/adjuvant — deliberately maps to no class (documented here so
  // it reads as a decision, not an omission).
  ['lesco 90/10 nonionic surfactant', null],
].map(([name, cls]) => [normalizeProductName(name), cls]));

function classifyProductExpectation(product = {}) {
  const name = normalizeProductName(product?.name);
  if (!name) return null;
  return PRODUCT_EXPECTATION_CLASS.get(name) ?? null;
}

// The active ingredient each mapped product's EPA label names (labels read
// 2026-10-01). Customer copy names the active ingredient, never the brand
// (owner 2026-10-01), so this map is keyed by the same catalog names as
// PRODUCT_EXPECTATION_CLASS. Onslaught's piperonyl butoxide is a synergist,
// not the insecticide, so only esfenvalerate is named.
const PRODUCT_ACTIVE_INGREDIENT = new Map([
  ['taurus sc', 'fipronil'],
  ['alpine wsg', 'dinotefuran'],
  ['atticus talak', 'bifenthrin'],
  ['atticus talak 7.9 f', 'bifenthrin'],
  ['demand cs', 'lambda-cyhalothrin'],
  ['onslaught fastcap', 'esfenvalerate'],
  ['delta dust', 'deltamethrin'],
  ['advion evolution cockroach gel bait', 'indoxacarb'],
  ['advion cockroach gel bait', 'indoxacarb'],
  ['advion ant bait gel', 'indoxacarb'],
  ['gentrol igr', '(S)-hydroprene'],
  ['tekko pro igr', 'pyriproxyfen and novaluron'],
].map(([name, ai]) => [normalizeProductName(name), ai]));

// Label durations, by product. Tekko Pro's is for cockroach nymphs (up to 6
// months), so it needs a roach-tagged application. Gentrol IGR's label
// (EPA 2724-351) states "CONTINUOUS PROTECTION FOR 4 MONTHS" for every pest
// it lists (owner 2026-10-05: say it on the report).
const IGR_LABEL_DURATION = new Map([
  ['tekko pro igr', { needsRoachTarget: true, sentence: 'It is labeled for up to 6 months of activity on cockroach nymphs.' }],
  ['gentrol igr', { needsRoachTarget: false, sentence: 'Its label gives up to 4 months of continuous protection.' }],
].map(([name, entry]) => [normalizeProductName(name), entry]));

function activeIngredientPhrase(products) {
  const names = [...new Set(products
    .map((product) => PRODUCT_ACTIVE_INGREDIENT.get(normalizeProductName(product?.name)))
    .filter(Boolean))];
  if (!names.length) return null;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Owner-approved 2026-10-01 (review page SBDx87AvuCeuzeYRzqBJjX, v7):
// technical, the active ingredient instead of a brand, "eliminate" never
// "die"/"kill". Each builder takes the visit's active-ingredient phrase
// (null when no mapped product names one) and returns the customer line.
const EXPECTATION_TEXT = {
  // Ant-tagged AND applied outside: the 6-foot perimeter band (owner rule:
  // a non-repellent sprayed outside is a 6-foot band).
  non_repellent: (ai, { footage = true } = {}) => `We applied ${ai ? `a ${ai}-based non-repellent` : 'a non-repellent'} as a ${footage ? '6-foot ' : ''}perimeter band `
    + 'around your foundation. Ants can\'t detect it, so foragers walk through the treated zone, pick up the active '
    + 'ingredient and transfer it to the rest of the colony at the nest. Expect a short spike in ant activity for '
    + 'several days as the colony is exposed, then a steady decline over the next couple of weeks.',
  // Same class without both an ant tag and an exterior record — no band,
  // no ant claim (codex P1 2026-09-28 round 4).
  non_repellent_general: (ai) => `We applied ${ai ? `a ${ai}-based non-repellent` : 'a non-repellent'}. Insects can't `
    + 'detect the treated zone, so they cross it, pick up the active ingredient and carry it back to their '
    + 'harborage. Activity can spike for a few days, then declines over the next couple of weeks.',
  // The closing instruction to the customer is left out of the writer's plain
  // version: the writer's rule 7 bans aftercare instructions (codex #5523 P2).
  // No placement claim: the builders read no application area or method,
  // so the bait and dust lines never say where the product went (codex
  // #5523 r2).
  ant_bait: (ai, { aftercare = true } = {}) => `We placed ${ai ? `an ${ai} gel bait` : 'a gel bait'} for the ants. `
    + 'Foragers feed on it and share it through the colony before it takes effect. You may see more '
    + `ants on the placements for a few days.${aftercare ? ' Leave them alone; they\'re carrying the bait back to the nest.' : ''}`,
  roach_gel_bait: (ai, { aftercare = true } = {}) => `We placed ${ai ? `an ${ai} gel bait` : 'a gel bait'} for the `
    + 'roaches. Roaches feed on it and carry it back into '
    + 'harborage, where the active ingredient eliminates them. Over the next week or two you may see roaches out in '
    + 'daylight, slowed and disoriented, as the active ingredient takes effect.'
    + `${aftercare ? ' Don\'t use over-the-counter sprays near the placements; a residual spray contaminates the bait and keeps roaches off it.' : ''}`,
  // Barrier wording — ONLY when the application evidence confirms an
  // exterior/perimeter method or area (see hasExteriorApplicationEvidence).
  pyrethroid: (ai) => `We applied a residual ${ai ? `${ai} ` : ''}barrier around the outside of your home. `
    + `${ai && !ai.includes(' and ') ? `${ai[0].toUpperCase()}${ai.slice(1)}` : 'The residual'} binds to the treated `
    + 'surfaces and eliminates insects on contact as they cross it. Finding a few affected insects near doors and '
    + 'windows over the next couple of weeks means the barrier is working.',
  // Same product class, but the application's method/area is unknown or not
  // confirmed exterior (owner ruling 2026-09-28, P1 audit round 2): never
  // claim a barrier without evidence it was applied there.
  pyrethroid_unconfirmed: (ai) => `We applied ${ai ? `${ai}, a residual insecticide` : 'a residual insecticide'} that `
    + 'binds to treated surfaces and eliminates insects on contact. Finding a few affected insects over the next '
    + 'couple of weeks means it\'s working.',
  // Never a surface barrier (owner ruling 2026-09-28). Delta Dust label: up
  // to 8 months when left undisturbed. The label duration is left out of the
  // writer's plain version: a residual period is not a follow-up window, and
  // the writer takes EXPECTATIONS timeframes as contact windows (codex #5523
  // r2).
  dust: (ai, { labelDuration = true } = {}) => `We applied ${ai ? `a ${ai} insecticide dust` : 'an insecticide dust'}. `
    + 'Dust holds up in cracks and voids where sprays can\'t reach'
    + `${labelDuration ? ', and it is labeled for up to 8 months of residual control of crawling insects when left undisturbed' : ''}`
    + '. Results build over the next few weeks.',
  igr: (ai, { labelDuration = '' } = {}) => `We added an insect growth regulator (IGR)${ai ? ` with ${ai}` : ''}. `
    + 'It stops immature insects from developing into breeding adults and reduces egg hatch, which breaks the '
    + `breeding cycle.${labelDuration ? ` ${labelDuration}` : ''}`,
};

// Fixed priority when more than 3 classes triggered — cap to ~3 lines.
const EXPECTATION_PRIORITY = ['non_repellent', 'ant_bait', 'roach_gel_bait', 'pyrethroid', 'dust', 'igr'];

// Application evidence that a product was applied via an EXTERIOR/PERIMETER
// method or area — required before the "barrier" wording claims it is
// protecting doors/windows (owner ruling 2026-09-28, P1 audit round 2: the
// prior heuristic gave every pyrethroid-classed product the barrier
// sentence regardless of method or area, which would have told a customer
// an INTERIOR crack-and-crevice pyrethroid application was a barrier
// working near their doors and windows). Structured fields only
// (report-data.js's own method / methodInferred / applicationArea, never
// free text). methodInferred === true means no EXPLICIT method was
// recorded — methodFromProduct's pest-line fallback silently defaults an
// unspecified method to 'perimeter_spray', which is a GUESS, not
// application evidence, so an inferred method is treated the same as
// unknown (fail closed, same "explicit map, never guessed" posture as
// classifyProductExpectation itself). The area side reads
// isExteriorApplicationArea (module top) — the controlled chip
// classification BY KEY, never a substring regex (codex P1 2026-09-29
// round 3: an earlier unanchored "entry points?" alternative matched the
// controlled INTERIOR chip "Interior entry points").
const EXTERIOR_METHODS = new Set(['perimeter_spray', 'broadcast_spray']);

function hasExteriorApplicationEvidence(product = {}) {
  if (product.methodInferred !== true && EXTERIOR_METHODS.has(String(product.method || ''))) return true;
  return isExteriorApplicationArea(product.applicationArea);
}

// The "6-foot perimeter band around your foundation" wording needs the band
// itself on record: an explicit perimeter spray, or a perimeter/foundation
// chip by exact key. Other exterior chips (Lanai, Yard, Eaves / soffit, Bait
// stations) are spot work, never a band (codex #5523 P2).
const PERIMETER_BAND_CHIPS = new Set(['Perimeter', 'Exterior perimeter', 'Property perimeter', 'Foundation', 'Foundation perimeter']
  .map(normalizeAreaChipText));

function hasPerimeterBandEvidence(product = {}) {
  if (product.methodInferred !== true && String(product.method || '') === 'perimeter_spray') return true;
  return applicationAreaChips(product.applicationArea).some((chip) => PERIMETER_BAND_CHIPS.has(chip));
}

// `plain` is the AI report writer's version of the same lines: its owner
// rules never name an active ingredient or a footage figure and never give
// aftercare instructions (report-writer-rules.js rules 5 and 7 and its
// footage screen), so those words are left out and everything else is
// identical.
function buildWhatToExpect({ products = [], plain = false } = {}) {
  const byClass = new Map();
  const ingredients = (list) => (plain ? null : activeIngredientPhrase(list));
  // Confirmed exterior evidence for ANY qualifying pyrethroid application —
  // one confirmed application is enough to earn the barrier line even if
  // another pyrethroid application this visit has unknown method/area.
  let pyrethroidExteriorConfirmed = false;
  // The 6-foot band line needs ONE non-repellent application that is both
  // ant-tagged (codex P1 round 4) and recorded outside; otherwise the
  // general variant.
  let nonRepellentAntBand = false;
  for (const product of products) {
    const cls = classifyProductExpectation(product);
    if (!cls) continue;
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(product);
    if (cls === 'pyrethroid' && hasExteriorApplicationEvidence(product)) {
      pyrethroidExteriorConfirmed = true;
    }
    if (cls === 'non_repellent' && hasAntTargetEvidence(product) && hasPerimeterBandEvidence(product)) {
      nonRepellentAntBand = true;
    }
  }
  if (!byClass.size) return null;
  const lines = EXPECTATION_PRIORITY
    .filter((cls) => byClass.has(cls))
    .slice(0, 3)
    .map((cls) => {
      const classProducts = byClass.get(cls);
      const ai = ingredients(classProducts);
      if (cls === 'pyrethroid' && !pyrethroidExteriorConfirmed) return EXPECTATION_TEXT.pyrethroid_unconfirmed(ai);
      // The barrier sentence places the product outside, so it names only
      // the products recorded there.
      if (cls === 'pyrethroid') {
        return EXPECTATION_TEXT.pyrethroid(ingredients(classProducts.filter(hasExteriorApplicationEvidence)));
      }
      if (cls === 'non_repellent' && !nonRepellentAntBand) return EXPECTATION_TEXT.non_repellent_general(ai);
      // The band sentence places the product outside for ants, so it names
      // only the applications that earned it.
      if (cls === 'non_repellent') {
        return EXPECTATION_TEXT.non_repellent(ingredients(classProducts.filter(
          (p) => hasAntTargetEvidence(p) && hasPerimeterBandEvidence(p),
        )), { footage: !plain });
      }
      if (cls === 'igr') {
        // A label duration never reaches the writer (plain). Tekko Pro's
        // figure needs a roach-tagged application (it also covers fleas,
        // flies and mosquitoes); Gentrol's applies to every listed pest.
        // Two growth regulators on one visit share one line, so no single
        // label's duration can speak for it: state a duration only when one
        // product's applies (Codex P2 #5982).
        const durations = plain ? [] : [...new Set(classProducts
          .map((p) => {
            const entry = IGR_LABEL_DURATION.get(normalizeProductName(p?.name));
            if (!entry) return null;
            if (entry.needsRoachTarget && !(Array.isArray(p?.targets) && p.targets.some((t) => /roach/i.test(t)))) return null;
            return entry.sentence;
          })
          .filter(Boolean))];
        const igrProducts = new Set(classProducts.map((p) => normalizeProductName(p?.name)));
        return EXPECTATION_TEXT.igr(ai, { labelDuration: durations.length === 1 && igrProducts.size === 1 ? durations[0] : '' });
      }
      return EXPECTATION_TEXT[cls](ai, { aftercare: !plain, labelDuration: !plain });
    })
    .filter((line) => validateCustomerCopy(line));
  return lines.length ? { lines } : null;
}

// The classes behind buildWhatToExpect's lines, in the same priority order
// and cap. The report writer (GATE_REPORT_WRITER_RULES) turns the longest
// stated window among them into a reach-out date.
function whatToExpectClasses({ products = [] } = {}) {
  const classes = new Set((products || []).map(classifyProductExpectation).filter(Boolean));
  return EXPECTATION_PRIORITY.filter((cls) => classes.has(cls)).slice(0, 3);
}

// Canonical product shape for expectations classification
// ({ name, activeIngredient, category, moaGroup }) — the
// ONE normalizer SHARED by every caller (owner-flagged P1 2026-09-28: the
// AI-grounding path in report-copy-context.js was building its own product
// list without `name`, so a name-dependent classification — e.g. roach gel
// bait, which needs the name to tell it apart from other bait — could come
// out different for the grounded AI copy than for the customer-facing
// block). Accepts either the pest-report-v2.js applications shape
// (`{ product: { name, active_ingredient, category, moa_group } }`, snake_case DB-ish keys) or an already-flat/camelCase
// object (report-copy-context.js's `productSafety` entries) — reads
// whichever keys are present so both call sites funnel through the exact
// same fields the classifier reads, and can't silently drift apart again.
function isPlainObject(value) {
  return !!value && typeof value === 'object';
}

// camelCase key, else its snake_case twin, else null.
function pickEither(source, camelKey, snakeKey) {
  if (!isPlainObject(source)) return null;
  return source[camelKey] ?? source[snakeKey] ?? null;
}

function toExpectationProduct(raw = {}) {
  const product = isPlainObject(raw?.product) ? raw.product : raw;
  return {
    name: isPlainObject(product) ? (product.name ?? null) : null,
    activeIngredient: pickEither(product, 'activeIngredient', 'active_ingredient'),
    category: isPlainObject(product) ? (product.category ?? null) : null,
    moaGroup: pickEither(product, 'moaGroup', 'moa_group'),
    // APPLICATION-level (not product-level) structured fields — report-data.js
    // carries these as siblings of `product` on each application, so they
    // are read off `raw`, never `product`. Present only when `raw` IS an
    // application (pest-report-v2.js's own caller); absent/null for
    // report-copy-context.js's `productSafety` entries, which are deduped
    // by CATALOG PRODUCT and carry no per-application method/area — that
    // caller's barrier-vs-unconfirmed choice fails closed the same way an
    // explicitly unknown value would (never assumes a barrier without
    // evidence; see hasExteriorApplicationEvidence).
    method: isPlainObject(raw) ? (raw.method ?? null) : null,
    methodInferred: isPlainObject(raw) && typeof raw.methodInferred === 'boolean' ? raw.methodInferred : null,
    applicationArea: pickEither(raw, 'applicationArea', 'application_area'),
    // The tech's structured target tags for THIS application (codex P1
    // round 4) — null when the caller has no per-application data.
    targets: Array.isArray(raw?.targets) ? raw.targets.map((t) => cleanText(t)).filter(Boolean) : null,
  };
}

// ── Compose the blocks ─────────────────────────────────────────────
function buildPestExpectations({
  applications = [],
  actionLabels = [],
  actionEntries = [],
} = {}) {
  const flatProducts = (applications || []).map(toExpectationProduct);
  const spiders = buildSpiderExpectation({ actionLabels, actionEntries, applications });
  const whatToExpect = buildWhatToExpect({ products: flatProducts });
  if (!spiders && !whatToExpect) return null;
  // Each child key is present only when that block has something to say
  // (codex P0 #5137 r6 — the public contract; never a serialized null).
  return {
    ...(spiders ? { spiders } : {}),
    ...(whatToExpect ? { whatToExpect } : {}),
  };
}

module.exports = {
  pestReportExpectationsGateOn,
  classifyProductExpectation,
  buildSpiderExpectation,
  buildWhatToExpect,
  whatToExpectClasses,
  buildPestExpectations,
  toExpectationProduct,
  isExteriorApplicationArea,
};
