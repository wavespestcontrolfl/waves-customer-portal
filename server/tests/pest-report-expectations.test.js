// Unit tests for the Pest Report V2 "expectations" blocks (owner-approved
// 2026-09-27, GATE_PEST_REPORT_EXPECTATIONS). Pure module, synthetic data only.

const {
  pestReportExpectationsGateOn,
  classifyProductExpectation,
  buildRainExpectation,
  buildSpiderExpectation,
  buildWhatToExpect,
  buildPestExpectations,
  toExpectationProduct,
  formatRainfastMinutes,
} = require('../services/service-report/pest-report-expectations');

// An application recorded outside (explicit perimeter method).
const EXTERIOR_APPLICATION = { name: 'Atticus Talak', method: 'perimeter_spray', methodInferred: false, rainfastMinutes: null };

describe('pestReportExpectationsGateOn', () => {
  const ORIGINAL = process.env.GATE_PEST_REPORT_EXPECTATIONS;
  afterEach(() => { process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL; });

  it('is off unless exactly "true"', () => {
    delete process.env.GATE_PEST_REPORT_EXPECTATIONS;
    expect(pestReportExpectationsGateOn()).toBe(false);
    process.env.GATE_PEST_REPORT_EXPECTATIONS = '1';
    expect(pestReportExpectationsGateOn()).toBe(false);
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'TRUE';
    expect(pestReportExpectationsGateOn()).toBe(false);
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    expect(pestReportExpectationsGateOn()).toBe(true);
  });
});

describe('buildRainExpectation', () => {
  it('returns null with no rain data and no rainy-season/threshold signal', () => {
    expect(buildRainExpectation({ weekWeather: null, serviceMonth: 2 })).toBeNull();
  });

  it('a genuinely unknown rainInches (null) is never rendered as 0" (Number(null) === 0 footgun)', () => {
    expect(buildRainExpectation({ weekWeather: { rainInches: null, rainConfidence: null }, serviceMonth: 2 })).toBeNull();
  });

  it('states the weekly rain fact when rainInches is known (normal confidence)', () => {
    const out = buildRainExpectation({ weekWeather: { rainInches: 0.4, rainConfidence: null }, serviceMonth: 2 });
    expect(out.lines[0]).toMatch(/Our rain tracker recorded about 0\.4" of rain at your property over the past 7 days\./);
    expect(out.lines).toHaveLength(1); // Feb, < 1" — no ants-after-rain line
  });

  it('hedges the number on low-confidence (city-collective fallback) rain', () => {
    const out = buildRainExpectation({ weekWeather: { rainInches: 2.1, rainConfidence: 'low' }, serviceMonth: 2 });
    expect(out.lines[0]).toMatch(/Our rain tracker recorded roughly 2\.1" of rain in your area/);
    expect(out.lines[0]).not.toMatch(/gauge/i);
  });

  // Owner ruling 2026-09-28, revised: the rain-fast clause appears ONLY
  // when the catalog has a sourced rainfast_minutes number for an applied
  // product. There is NO generic fallback sentence — "rain-fast once it
  // has dried" was itself an unsupported claim (most labels don't state
  // rain-fastness at all, and some say to avoid rain within a window
  // instead), so with no sourced number the clause is simply absent.
  it('states the rain-fast clause ONLY when a product supplies rainfastMinutes (synthetic — prod catalog is NULL today)', () => {
    const withRainfast = buildRainExpectation({
      weekWeather: { rainInches: 0.5, rainConfidence: null },
      products: [{ rainfastMinutes: 30 }],
      serviceMonth: 2,
    });
    expect(withRainfast.lines[0]).toMatch(/rain-fast about 30 min after it dries, per the label\./);
  });

  it('no rainfast_minutes on any applied product: NO rain-fast wording anywhere (no generic fallback)', () => {
    const withoutRainfast = buildRainExpectation({
      weekWeather: { rainInches: 0.5, rainConfidence: null },
      products: [{ rainfastMinutes: null }],
      serviceMonth: 2,
    });
    expect(withoutRainfast.lines[0]).not.toMatch(/rain-fast/i);
    expect(withoutRainfast.lines[0]).not.toMatch(/dried/i);
  });

  it('adds no rain-fast clause at all when no products were applied', () => {
    const out = buildRainExpectation({
      weekWeather: { rainInches: 0.5, rainConfidence: null },
      products: [],
      serviceMonth: 2,
    });
    expect(out.lines[0]).not.toMatch(/rain-fast/i);
  });

  // codex P2 2026-09-29 (round 2): with several applied products each
  // carrying a positive rainfastMinutes, the clause must state the LONGEST
  // one — array order is incidental, never a safety ranking.
  it('states the LONGER rain-fast interval when two products carry different ones, independent of array order', () => {
    const shortFirst = buildRainExpectation({
      weekWeather: { rainInches: 0.5, rainConfidence: null },
      products: [{ rainfastMinutes: 30 }, { rainfastMinutes: 120 }],
      serviceMonth: 2,
    });
    expect(shortFirst.lines[0]).toMatch(/rain-fast about 2 hr after it dries, per the label\./);

    const longFirst = buildRainExpectation({
      weekWeather: { rainInches: 0.5, rainConfidence: null },
      products: [{ rainfastMinutes: 120 }, { rainfastMinutes: 30 }],
      serviceMonth: 2,
    });
    expect(longFirst.lines[0]).toMatch(/rain-fast about 2 hr after it dries, per the label\./);
  });

  it('formats a >=60min rainfast time in hours', () => {
    expect(formatRainfastMinutes(120)).toBe('2 hr');
    expect(formatRainfastMinutes(90)).toBe('1.5 hr');
    expect(formatRainfastMinutes(30)).toBe('30 min');
    expect(formatRainfastMinutes(null)).toBeNull();
  });

  it('adds the forecast heavy-rain caveat only when forecastHeavyRain is true (caller\'s job to gate LIVE-only)', () => {
    const live = buildRainExpectation({
      weekWeather: { rainInches: 0.2, rainConfidence: null }, products: [EXTERIOR_APPLICATION], serviceMonth: 2, forecastHeavyRain: true,
    });
    expect(live.lines[0]).toMatch(/Heavy rain soon after an exterior application/);

    // The caveat names an exterior application, so an application with no
    // exterior method or area on record gets none.
    const interiorOnly = buildRainExpectation({
      weekWeather: { rainInches: 0.2, rainConfidence: null }, products: [{ rainfastMinutes: null }], serviceMonth: 2, forecastHeavyRain: true,
    });
    expect(interiorOnly.lines.join(' ')).not.toMatch(/Heavy rain soon after an exterior application/);

    // No recorded application (inspection / sweep only): no treatment caveat.
    const untreated = buildRainExpectation({
      weekWeather: { rainInches: 0.2, rainConfidence: null }, serviceMonth: 2, forecastHeavyRain: true,
    });
    expect(untreated.lines.join(' ')).not.toMatch(/Heavy rain soon after an exterior application/);

    const notLive = buildRainExpectation({
      weekWeather: { rainInches: 0.2, rainConfidence: null }, serviceMonth: 2, forecastHeavyRain: false,
    });
    expect(notLive.lines[0]).not.toMatch(/Heavy rain soon after an exterior application/);
  });

  // Owner ruling 2026-09-28: never on the calendar month alone — a rain
  // signal (or the LIVE forecast signal) is required every time.
  it('does NOT add the ants-after-rain line in rainy season with no rain data and no forecast signal', () => {
    const out = buildRainExpectation({ weekWeather: null, serviceMonth: 7 });
    expect(out).toBeNull();
  });

  it('rainy season (Jun–Oct): the ants line needs >= 0.5" — under the bar is silent, at/over fires', () => {
    const under = buildRainExpectation({ weekWeather: { rainInches: 0.4, rainConfidence: null }, serviceMonth: 7 });
    expect(under.lines).toHaveLength(1); // rain line only — no ants line
    expect(under.lines.join(' ')).not.toMatch(/Heavy rain floods ant nests/);

    const over = buildRainExpectation({ weekWeather: { rainInches: 0.5, rainConfidence: null }, serviceMonth: 7 });
    expect(over.lines).toHaveLength(2);
    expect(over.lines[1]).toMatch(/Heavy rain floods ant nests/);
  });

  it('outside rainy season: the ants line needs >= 1" — 0.5" (the rainy-season bar) is not enough', () => {
    const halfInch = buildRainExpectation({ weekWeather: { rainInches: 0.5, rainConfidence: null }, serviceMonth: 2 });
    expect(halfInch.lines).toHaveLength(1);
    expect(halfInch.lines.join(' ')).not.toMatch(/Heavy rain floods ant nests/);

    const under = buildRainExpectation({ weekWeather: { rainInches: 0.9, rainConfidence: null }, serviceMonth: 2 });
    expect(under.lines).toHaveLength(1); // rain line only — no ants line
    const over = buildRainExpectation({ weekWeather: { rainInches: 1, rainConfidence: null }, serviceMonth: 2 });
    expect(over.lines).toHaveLength(2);
    expect(over.lines[1]).toMatch(/Heavy rain floods ant nests/);
  });

  it('low-confidence (city-collective) rain always uses the higher 1" bar, even in rainy season', () => {
    // 0.6" is over the 0.5" rainy-season bar but under the 1" low-confidence bar.
    const hedgedUnder = buildRainExpectation({ weekWeather: { rainInches: 0.6, rainConfidence: 'low' }, serviceMonth: 7 });
    expect(hedgedUnder.lines).toHaveLength(1);
    expect(hedgedUnder.lines.join(' ')).not.toMatch(/Heavy rain floods ant nests/);

    const hedgedOver = buildRainExpectation({ weekWeather: { rainInches: 1, rainConfidence: 'low' }, serviceMonth: 7 });
    expect(hedgedOver.lines).toHaveLength(2);
    expect(hedgedOver.lines[1]).toMatch(/Heavy rain floods ant nests/);
  });

  // codex P2 #5137 deferred finding c: settledWeekWeatherForRender
  // (reports-public.js) drops every open trailing-week window, so a
  // same-day live report always passes weekWeather: null here. The live
  // forecast warning must still reach the customer as its OWN line rather
  // than being silently swallowed by the (unrelated) missing settled total.
  it('the LIVE-only forecast heavy-rain signal alone adds BOTH its own warning line and the ants line, even with no rain data', () => {
    const out = buildRainExpectation({ weekWeather: null, products: [EXTERIOR_APPLICATION], serviceMonth: 2, forecastHeavyRain: true });
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatch(/Heavy rain soon after an exterior application/);
    expect(out.lines[1]).toMatch(/Heavy rain floods ant nests/);
  });

  it('an inspection- or sweep-only visit gets no treatment caveat from the forecast alone — only the neutral ants line', () => {
    const out = buildRainExpectation({ weekWeather: null, products: [], serviceMonth: 2, forecastHeavyRain: true });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).not.toMatch(/treatment/);
    expect(out.lines[0]).toMatch(/Heavy rain floods ant nests and pushes foragers indoors for a few days/);
  });

  it('with no rain data and NO forecast signal, no heavy-rain warning line is invented', () => {
    const out = buildRainExpectation({ weekWeather: null, serviceMonth: 2, forecastHeavyRain: false });
    expect(out).toBeNull();
  });

  it('never claims rain can\'t affect the treatment beyond the label facts', () => {
    const out = buildRainExpectation({
      weekWeather: { rainInches: 3, rainConfidence: null },
      products: [{ rainfastMinutes: 30 }],
      serviceMonth: 8,
      forecastHeavyRain: true,
    });
    const joined = out.lines.join(' ');
    expect(joined).not.toMatch(/guarantee/i);
    expect(joined).not.toMatch(/eliminated\b/i);
  });

  // codex P1 2026-09-29 (pre-push audit round 2): "moving through the
  // treated band" is a TREATMENT claim and must never fire from rain alone.
  // The ants line now requires the SAME confirmed exterior/perimeter
  // application evidence the pyrethroid barrier sentence requires.
  describe('ants-after-rain wording requires confirmed perimeter-treatment evidence', () => {
    const HEAVY_WEEK = { rainInches: 2, rainConfidence: null };

    it('no applications at all (inspection/sweep-only visit): treatment-neutral wording, never "treated band"', () => {
      const out = buildRainExpectation({ weekWeather: HEAVY_WEEK, products: [], serviceMonth: 7 });
      expect(out.lines).toHaveLength(2);
      expect(out.lines[1]).toMatch(/Heavy rain floods ant nests/);
      expect(out.lines[1]).not.toMatch(/6-foot perimeter band/);
      expect(out.lines[1]).toMatch(/text us/i);
    });

    it('an INTERIOR-only application (non_repellent, no exterior evidence): treatment-neutral wording', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Taurus SC', method: 'spot_treatment', methodInferred: false, applicationArea: 'Kitchen' }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).not.toMatch(/6-foot perimeter band/);
    });

    it('a product applied with UNKNOWN method/area (nothing recorded): treatment-neutral wording', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Demand CS' }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).not.toMatch(/6-foot perimeter band/);
    });

    it('an INFERRED method (the pest-line default guess) is treated as unknown, never confirms perimeter evidence', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Taurus SC', method: 'perimeter_spray', methodInferred: true }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).not.toMatch(/6-foot perimeter band/);
    });

    it('an ant bait / roach gel / IGR with confirmed exterior evidence STILL does not earn the band claim (not a perimeter band)', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Advion Ant Bait Gel', method: 'perimeter_spray', methodInferred: false }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).not.toMatch(/6-foot perimeter band/);
    });

    it('an EXPLICIT perimeter spray (non_repellent) TAGGED for ants earns the treated-band wording', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Taurus SC', method: 'perimeter_spray', methodInferred: false, targets: ['Ants'] }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).toMatch(/6-foot perimeter band/);
    });

    it('an applicationArea naming an exterior/perimeter chip (no explicit method), tagged for ants, also earns the 6-foot band wording', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Alpine WSG', applicationArea: 'Foundation perimeter', targets: ['ants', 'spiders'] }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).toMatch(/6-foot perimeter band/);
    });

    it('a repellent barrier sprayed outside for ants never earns the 6-foot band wording (it describes a non-repellent)', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Demand CS', applicationArea: 'Foundation perimeter', targets: ['ants', 'spiders'] }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).not.toMatch(/6-foot perimeter band/);
      expect(out.lines[1]).toMatch(/we'll come back out/);
    });

    // codex P1 2026-09-28 round 4: the colony/trail claim is ANT-specific —
    // a confirmed perimeter band applied for roaches only, or with no targets
    // recorded, gets the pest-neutral wording.
    it('a confirmed perimeter spray tagged ONLY for roaches never earns the treated-band wording', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Taurus SC', method: 'perimeter_spray', methodInferred: false, targets: ['Roaches'] }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).toMatch(/Heavy rain floods ant nests/);
      expect(out.lines[1]).not.toMatch(/6-foot perimeter band/);
    });

    it('a confirmed perimeter spray with NO targets recorded never earns the treated-band wording', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Taurus SC', method: 'perimeter_spray', methodInferred: false }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).not.toMatch(/6-foot perimeter band/);
    });

    it('the ant target match is word-bounded ("Giant water bugs" is not an ant tag)', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Taurus SC', method: 'perimeter_spray', methodInferred: false, targets: ['Giant water bugs', 'pantry pests'] }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).not.toMatch(/6-foot perimeter band/);
    });

    // codex P1 2026-09-29 (pre-push audit round 3): same collision as the
    // pyrethroid barrier sentence — "Interior entry points" is a controlled
    // INTERIOR chip and must never earn the treated-band claim, even though
    // it contains the substring "entry points".
    it('the controlled INTERIOR chip "Interior entry points" never earns the treated-band wording', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Demand CS', method: 'spot_treatment', methodInferred: false, applicationArea: 'Interior entry points' }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).not.toMatch(/6-foot perimeter band/);
    });

    it('an unrecognized / free-text area string never qualifies as exterior (fail closed, no guessing)', () => {
      const out = buildRainExpectation({
        weekWeather: HEAVY_WEEK,
        products: [{ name: 'Demand CS', applicationArea: 'Somewhere out back, per the tech\'s note' }],
        serviceMonth: 7,
      });
      expect(out.lines[1]).not.toMatch(/6-foot perimeter band/);
    });

    it('never guarantees/eliminates in the neutral wording either', () => {
      const out = buildRainExpectation({ weekWeather: HEAVY_WEEK, products: [], serviceMonth: 7 });
      expect(out.lines[1]).not.toMatch(/guarantee|eliminated\b/i);
    });
  });
});

// Owner ruling 2026-09-28 (P1 audit, 2 rounds of misclassification from the
// prior heuristic — a category/name-regex classifier would have called an
// Advion ANT Bait Gel a roach product, since it also matched the generic
// "bait" category rule): classification is now an EXPLICIT, CLOSED map
// keyed by the exact catalog product name — active ingredient, moa_group,
// and category are NEVER consulted. A product not in the map gets no class.
describe('classifyProductExpectation — explicit product-name map (no heuristics)', () => {
  const cases = [
    [{ name: 'Taurus SC' }, 'non_repellent'],
    [{ name: 'Alpine WSG' }, 'non_repellent'],
    // Atticus Talak: the CATALOG's canonical spelling (no suffix) and the
    // longer display form some fixtures use both classify (codex P2
    // 2026-09-29 round 2 — see the dedicated describe block below).
    [{ name: 'Atticus Talak' }, 'pyrethroid'],
    [{ name: 'Atticus Talak 7.9 F' }, 'pyrethroid'],
    [{ name: 'Demand CS' }, 'pyrethroid'],
    [{ name: 'Onslaught Fastcap' }, 'pyrethroid'],
    // Delta Dust is its OWN class ('dust'), not 'pyrethroid' (owner ruling
    // 2026-09-28, P1 audit round 2): a dust formulation is never a surface
    // barrier — see the 'dust' class copy in buildWhatToExpect below.
    [{ name: 'Delta Dust' }, 'dust'],
    [{ name: 'Advion Evolution Cockroach Gel Bait' }, 'roach_gel_bait'],
    [{ name: 'Advion Cockroach Gel Bait' }, 'roach_gel_bait'],
    [{ name: 'Advion Ant Bait Gel' }, 'ant_bait'],
    [{ name: 'Advion WDG Granular' }, 'non_repellent'],
    [{ name: 'Gentrol IGR' }, 'igr'],
    [{ name: 'Tekko Pro IGR' }, 'igr'],
    // Surfactant — explicitly mapped to no class, not merely absent.
    [{ name: 'LESCO 90/10 Nonionic Surfactant' }, null],
    // Unmapped product — fail closed, never guess.
    [{ name: 'Some Unlisted Product 2000' }, null],
    [{}, null],
  ];
  it.each(cases)('%j → %s', (product, expected) => {
    expect(classifyProductExpectation(product)).toBe(expected);
  });

  it('is case/whitespace-insensitive on the name (same matching style cleanText() uses elsewhere)', () => {
    expect(classifyProductExpectation({ name: '  taurus sc  ' })).toBe('non_repellent');
    expect(classifyProductExpectation({ name: 'TAURUS SC' })).toBe('non_repellent');
  });

  // The actual bug this replaces: a category/active-ingredient/moa_group
  // heuristic would have classified an Advion Ant Bait Gel as roach gel
  // bait (both are "bait" category with an "Advion" name prefix). The
  // explicit map only ever matches the FULL product name, so this never
  // happens now — and never reintroduces any other combination of
  // active-ingredient/category/moa_group without a matching name either.
  it('active ingredient / category / moa_group ALONE (no matching name) never classify anything', () => {
    expect(classifyProductExpectation({ activeIngredient: 'Fipronil', category: 'insecticide', moaGroup: 'Group 2B' })).toBeNull();
    expect(classifyProductExpectation({ category: 'bait', activeIngredient: 'Indoxacarb' })).toBeNull();
    expect(classifyProductExpectation({ category: 'IGR' })).toBeNull();
  });
});

// codex P2 2026-09-29 (round 2): the closed map is only useful if its keys
// match the CATALOG's actual canonical name — a spelling mismatch silently
// drops a product's classification with no error, since an unmapped
// product just gets no line. Every name below is spelled EXACTLY as
// server/models/migrations/20260712100000_catalog_label_rate_backfill.js
// (and every other seed/backfill migration touching these rows) seeds
// products_catalog.name — the same spelling client/src/lib/pest-default-mix.js's
// house-mix matcher resolves against for the standard recurring-pest tank
// mix (Taurus SC + Atticus Talak + LESCO 90/10 Nonionic Surfactant).
describe('every catalog product name this map claims to know classifies (codex P2 2026-09-29 round 2)', () => {
  const CATALOG_NAMES = [
    ['Taurus SC', 'non_repellent'],
    ['Alpine WSG', 'non_repellent'],
    ['Atticus Talak', 'pyrethroid'],
    ['Demand CS', 'pyrethroid'],
    ['Onslaught Fastcap', 'pyrethroid'],
    ['Delta Dust', 'dust'],
    ['Advion Evolution Cockroach Gel Bait', 'roach_gel_bait'],
    ['Advion Cockroach Gel Bait', 'roach_gel_bait'],
    ['Advion Ant Bait Gel', 'ant_bait'],
    ['Advion WDG Granular', 'non_repellent'],
    ['Gentrol IGR', 'igr'],
    ['Tekko Pro IGR', 'igr'],
    // Deliberately mapped to no class (documented decision, not a gap) —
    // this is the ONE catalog name in the map that is EXPECTED to be null.
    ['LESCO 90/10 Nonionic Surfactant', null],
  ];
  it.each(CATALOG_NAMES)('catalog name %j → %s', (name, expected) => {
    expect(classifyProductExpectation({ name })).toBe(expected);
  });

  it('the recurring-pest house-mix trio (client/src/lib/pest-default-mix.js) all classify to a non-null class', () => {
    // LESCO is the mix's own third product but is deliberately no-class —
    // asserted separately above, not part of this "must have a class" check.
    expect(classifyProductExpectation({ name: 'Taurus SC' })).not.toBeNull();
    expect(classifyProductExpectation({ name: 'Atticus Talak' })).not.toBeNull();
  });
});

// Owner-flagged P1 (2026-09-28): the AI-grounding path (report-copy-context.js)
// used to build its own product list WITHOUT `name`, so a name-dependent
// classification (e.g. roach gel bait vs. ant bait — both "Advion ... Bait"
// products) could come out different for the grounded AI copy than for the
// customer-facing render block. toExpectationProduct is the ONE shared
// normalizer both paths now funnel through.
describe('toExpectationProduct — shared normalizer (grounding/render can\'t drift)', () => {
  const GEL_BAIT = { name: 'Advion Cockroach Gel Bait', activeIngredient: 'Indoxacarb', category: 'bait' };

  it('reads the same fields from the render (applications) shape and the grounding (productSafety) shape', () => {
    const renderShape = { product: { name: GEL_BAIT.name, active_ingredient: GEL_BAIT.activeIngredient, category: GEL_BAIT.category, moa_group: null, rainfast_minutes: null } };
    const groundingShape = { ...GEL_BAIT, moaGroup: null, rainfastMinutes: null };
    expect(toExpectationProduct(renderShape)).toEqual(toExpectationProduct(groundingShape));
  });

  it('classification of a gel-bait product (name-dependent) is IDENTICAL whichever shape it came from', () => {
    const fromRender = toExpectationProduct({ product: { name: GEL_BAIT.name, active_ingredient: GEL_BAIT.activeIngredient, category: GEL_BAIT.category } });
    const fromGrounding = toExpectationProduct(GEL_BAIT);
    expect(classifyProductExpectation(fromRender)).toBe('roach_gel_bait');
    expect(classifyProductExpectation(fromGrounding)).toBe('roach_gel_bait');
    expect(classifyProductExpectation(fromRender)).toBe(classifyProductExpectation(fromGrounding));
  });

  it('regression: WITHOUT the shared normalizer preserving name, the product would fail to classify at all', () => {
    // Simulates the pre-fix bug directly: a product object missing `name`.
    const missingName = classifyProductExpectation({ category: 'bait' });
    expect(missingName).not.toBe('roach_gel_bait');
    expect(missingName).toBeNull();
  });

  it('end-to-end: buildPestExpectations (render path, applications shape) and buildWhatToExpect fed via the grounding path (productSafety shape) produce IDENTICAL what-to-expect lines for the same visit', () => {
    const renderExpectations = buildPestExpectations({
      applications: [{ product: { name: GEL_BAIT.name, active_ingredient: GEL_BAIT.activeIngredient, category: GEL_BAIT.category }, targets: [] }],
    });
    // Mirrors exactly what report-copy-context.js does: productSafety
    // entries (camelCase, name included) mapped through the same normalizer.
    const groundingProducts = [GEL_BAIT].map(toExpectationProduct);
    const groundingWhatToExpect = buildWhatToExpect({ products: groundingProducts });
    expect(renderExpectations.whatToExpect).toEqual(groundingWhatToExpect);
    expect(renderExpectations.whatToExpect.lines[0]).toMatch(/gel bait/);
  });
});

describe('buildWhatToExpect', () => {
  it('returns null with no classifiable products', () => {
    expect(buildWhatToExpect({ products: [{ name: 'Some Unlisted Product' }] })).toBeNull();
    expect(buildWhatToExpect({ products: [] })).toBeNull();
  });

  it('an unmapped product gets NO line (fail closed)', () => {
    expect(buildWhatToExpect({ products: [{ name: 'Not In The Map' }] })).toBeNull();
  });

  // The exact P1 scenario this round fixes: an Advion Ant Bait Gel must
  // NEVER print the roach-gel "dead roaches" line.
  it('Advion Ant Bait Gel gets the ant_bait line, never the roach gel bait line', () => {
    const out = buildWhatToExpect({ products: [{ name: 'Advion Ant Bait Gel' }] });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/share it through the colony/);
    expect(out.lines[0]).not.toMatch(/Roaches/);
  });

  // codex P1 2026-09-28 round 4: the ant line is ant-specific copy — it
  // needs a non-repellent application the tech TAGGED for ants. Owner
  // 2026-10-01: it also names the 6-foot perimeter band, so the same
  // application must be recorded outside.
  describe('non-repellent ant wording requires an ant-tagged application recorded outside', () => {
    it('tagged for ants and sprayed on the perimeter → the 6-foot band line, active ingredient, no brand', () => {
      const out = buildWhatToExpect({ products: [{ name: 'Taurus SC', targets: ['Ants'], method: 'perimeter_spray', methodInferred: false }] });
      expect(out.lines[0]).toMatch(/^We applied a fipronil-based non-repellent as a 6-foot perimeter band around your foundation\./);
      expect(out.lines[0]).toMatch(/spike in ant activity/);
      expect(out.lines[0]).not.toMatch(/Taurus/);
    });

    it('tagged for ants but nowhere recorded outside → the general wording, no band', () => {
      const out = buildWhatToExpect({ products: [{ name: 'Taurus SC', targets: ['Ants'] }] });
      expect(out.lines[0]).toMatch(/Insects can't detect the treated zone/);
      expect(out.lines[0]).not.toMatch(/6-foot|ants/i);
    });

    it('the ant tag and the exterior record must be on the SAME application', () => {
      const out = buildWhatToExpect({ products: [
        { name: 'Taurus SC', targets: ['Ants'] },
        { name: 'Alpine WSG', targets: ['Roaches'], method: 'perimeter_spray', methodInferred: false },
      ] });
      expect(out.lines[0]).not.toMatch(/6-foot/);
    });

    it('tagged for roaches only → pest-neutral transfer wording, no ants', () => {
      const out = buildWhatToExpect({ products: [{ name: 'Alpine WSG', targets: ['Roaches'] }] });
      expect(out.lines[0]).toMatch(/^We applied a dinotefuran-based non-repellent\. Insects can't detect the treated zone/);
      expect(out.lines[0]).not.toMatch(/ants/i);
      expect(out.lines[0]).not.toMatch(/colony/i);
    });

    it('no targets recorded (e.g. the grounding path) → pest-neutral transfer wording', () => {
      const out = buildWhatToExpect({ products: [{ name: 'Taurus SC' }] });
      expect(out.lines[0]).toMatch(/Insects can't detect the treated zone/);
      expect(out.lines[0]).not.toMatch(/ants/i);
    });

    it('one ant-tagged non-repellent among several applications is enough', () => {
      const out = buildWhatToExpect({ products: [
        { name: 'Alpine WSG', targets: ['Roaches'] },
        { name: 'Taurus SC', targets: ['ants'], method: 'perimeter_spray', methodInferred: false },
      ] });
      expect(out.lines[0]).toMatch(/spike in ant activity/);
      // Two non-repellents: both active ingredients are named.
      expect(out.lines[0]).toMatch(/dinotefuran and fipronil-based/);
    });

    it('toExpectationProduct carries the application targets (trimmed), null when absent', () => {
      expect(toExpectationProduct({ product: { name: 'Taurus SC' }, targets: [' Ants ', '', 'Spiders'] }).targets).toEqual(['Ants', 'Spiders']);
      expect(toExpectationProduct({ product: { name: 'Taurus SC' } }).targets).toBeNull();
    });
  });

  // A sprayed granule, not a bait: its label calls indoxacarb non-repellent.
  it('Advion WDG Granular takes the non-repellent line, never the gel bait line', () => {
    const out = buildWhatToExpect({ products: [{ name: 'Advion WDG Granular' }] });
    expect(out.lines[0]).toMatch(/^We applied a indoxacarb-based non-repellent|^We applied an indoxacarb-based non-repellent/);
    expect(out.lines[0]).not.toMatch(/gel bait/);
  });

  it('LESCO 90/10 Nonionic Surfactant gets no line (explicitly mapped to no class)', () => {
    expect(buildWhatToExpect({ products: [{ name: 'LESCO 90/10 Nonionic Surfactant' }] })).toBeNull();
  });

  // P1-D fix (owner ruling 2026-09-28, P1 audit round 2): Delta Dust is a
  // DUST formulation (cracks/voids), never a surface barrier — it must
  // never share the pyrethroid barrier copy or mention doors/windows.
  describe('Delta Dust — dedicated dust class, never a barrier claim', () => {
    it('gets its own dust-class line, not the pyrethroid barrier line', () => {
      const out = buildWhatToExpect({ products: [{ name: 'Delta Dust' }] });
      expect(out.lines).toHaveLength(1);
      expect(out.lines[0]).toMatch(/cracks, crevices and voids/);
      expect(out.lines[0]).not.toMatch(/barrier|doors and windows/i);
    });

    it('still gets the dust line even applied via an exterior/perimeter method (the class, not the method, decides)', () => {
      const out = buildWhatToExpect({
        products: [{ name: 'Delta Dust', method: 'perimeter_spray', methodInferred: false }],
      });
      expect(out.lines[0]).not.toMatch(/barrier|doors and windows/i);
    });
  });

  // P1-D fix, second half: even an actual pyrethroid SPRAY product (Demand
  // CS / Onslaught Fastcap / Atticus Talak 7.9 F) only earns the barrier
  // claim with CONFIRMED exterior/perimeter application evidence — method
  // and area were previously discarded before classification.
  describe('pyrethroid barrier claim requires confirmed exterior/perimeter application evidence', () => {
    it('EXPLICIT exterior method (methodInferred: false) earns the barrier line', () => {
      const out = buildWhatToExpect({
        products: [{ name: 'Demand CS', method: 'perimeter_spray', methodInferred: false }],
      });
      expect(out.lines[0]).toMatch(/barrier around the outside/);
      expect(out.lines[0]).toMatch(/near doors and windows/);
    });

    it('an applicationArea naming an exterior/perimeter chip earns the barrier line even with no explicit method', () => {
      const out = buildWhatToExpect({
        products: [{ name: 'Demand CS', applicationArea: 'Foundation perimeter' }],
      });
      expect(out.lines[0]).toMatch(/barrier around the outside/);
    });

    it('UNKNOWN method/area (nothing recorded) falls back to non-barrier wording for the SAME product class', () => {
      const out = buildWhatToExpect({ products: [{ name: 'Demand CS' }] });
      expect(out.lines[0]).not.toMatch(/barrier|doors and windows/i);
      expect(out.lines[0]).toMatch(/a residual insecticide that binds to treated surfaces/);
    });

    it('an INFERRED method (methodInferred: true) is treated as UNKNOWN, never assumed exterior — even though the pest-line default guess IS perimeter_spray', () => {
      const out = buildWhatToExpect({
        products: [{ name: 'Onslaught Fastcap', method: 'perimeter_spray', methodInferred: true }],
      });
      expect(out.lines[0]).not.toMatch(/barrier|doors and windows/i);
    });

    it('an EXPLICIT interior/non-perimeter method never earns the barrier line', () => {
      const out = buildWhatToExpect({
        products: [{ name: 'Atticus Talak 7.9 F', method: 'spot_treatment', methodInferred: false, applicationArea: 'Kitchen' }],
      });
      expect(out.lines[0]).not.toMatch(/barrier|doors and windows/i);
    });

    // codex P1 2026-09-29 (pre-push audit round 3): the PRIOR unanchored
    // "entry points?" regex alternative matched the controlled INTERIOR chip
    // "Interior entry points" too, since it never anchored on the "Interior"
    // prefix. A Demand CS application chipped there — with an explicit
    // interior method (spot_treatment) — must never earn the barrier line.
    // Area evidence now resolves through an EXACT lookup against the
    // controlled interior/exterior classification (shared/treatment-area-scopes.json),
    // never a substring match.
    it('the controlled INTERIOR chip "Interior entry points" never earns the barrier line, even with the collision-prone substring "entry points"', () => {
      const out = buildWhatToExpect({
        products: [{ name: 'Demand CS', method: 'spot_treatment', methodInferred: false, applicationArea: 'Interior entry points' }],
      });
      expect(out.lines[0]).not.toMatch(/barrier|doors and windows/i);
    });

    // The genuine controlled EXTERIOR chips this predicate exists to
    // recognize — straight from shared/treatment-area-scopes.json.
    it.each([
      'Perimeter',
      'Foundation',
      'Foundation perimeter',
      'Eaves / soffit',
      'Eaves / soffits',
      'Exterior perimeter',
    ])('the real controlled exterior chip %j still earns the barrier line', (applicationArea) => {
      const out = buildWhatToExpect({ products: [{ name: 'Demand CS', applicationArea }] });
      expect(out.lines[0]).toMatch(/barrier around the outside/);
    });

    it('an unrecognized / free-text area string never qualifies as exterior (fail closed, no guessing)', () => {
      const out = buildWhatToExpect({
        products: [{ name: 'Demand CS', applicationArea: 'Somewhere out back, per the tech\'s note' }],
      });
      expect(out.lines[0]).not.toMatch(/barrier|doors and windows/i);
    });

    it('never guarantees/eliminates in either pyrethroid wording', () => {
      const confirmed = buildWhatToExpect({ products: [{ name: 'Demand CS', method: 'perimeter_spray', methodInferred: false }] });
      const unconfirmed = buildWhatToExpect({ products: [{ name: 'Demand CS' }] });
      expect(confirmed.lines[0]).not.toMatch(/guarantee|eliminated\b/i);
      expect(unconfirmed.lines[0]).not.toMatch(/guarantee|eliminated\b/i);
    });
  });

  it('one line per class, de-duplicated across products of the same class (two roach-gel product names)', () => {
    const out = buildWhatToExpect({
      products: [
        { name: 'Advion Evolution Cockroach Gel Bait' },
        { name: 'Advion Cockroach Gel Bait' }, // same class — must not double the line
      ],
    });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/gel bait/);
  });

  it('caps to 3 lines in fixed priority order when 5 classes are present', () => {
    const out = buildWhatToExpect({
      products: [
        { name: 'Gentrol IGR' },
        { name: 'Demand CS' }, // pyrethroid
        { name: 'Advion Cockroach Gel Bait' },
        { name: 'Advion Ant Bait Gel' },
        { name: 'Taurus SC' }, // non_repellent
      ],
    });
    expect(out.lines).toHaveLength(3);
    // priority order: non_repellent, ant_bait, roach_gel_bait, pyrethroid, igr
    // — pyrethroid and igr dropped.
    expect(out.lines[0]).toMatch(/non-repellent/);
    expect(out.lines[1]).toMatch(/share it through the colony/);
    expect(out.lines[2]).toMatch(/crack-and-crevice placements/);
    expect(out.lines.join(' ')).not.toMatch(/barrier around the outside|breeding cycle/);
  });

  it('never uses guarantee/eliminate language', () => {
    const out = buildWhatToExpect({
      products: [
        { name: 'Taurus SC' }, { name: 'Demand CS' },
        { name: 'Advion Cockroach Gel Bait' }, { name: 'Gentrol IGR' }, { name: 'Advion Ant Bait Gel' },
      ],
    });
    const joined = out.lines.join(' ');
    expect(joined).not.toMatch(/guarantee/i);
    expect(joined).not.toMatch(/eliminated\b/i);
  });
});

// Owner 2026-10-01 (review page v7): the active ingredient, never a brand;
// "eliminates", never "die"/"kill"; every class keeps a line through the
// customer-copy guard.
describe('buildWhatToExpect — owner wording rules 2026-10-01', () => {
  const ALL = [
    { name: 'Taurus SC', targets: ['Ants'], method: 'perimeter_spray', methodInferred: false },
    { name: 'Alpine WSG' },
    { name: 'Advion WDG Granular' },
    { name: 'Atticus Talak', method: 'perimeter_spray', methodInferred: false },
    { name: 'Demand CS' },
    { name: 'Onslaught Fastcap' },
    { name: 'Delta Dust' },
    { name: 'Advion Evolution Cockroach Gel Bait' },
    { name: 'Advion Ant Bait Gel' },
    { name: 'Gentrol IGR' },
    { name: 'Tekko Pro IGR' },
  ];

  it.each(ALL.map((p) => [p.name, p]))('%s gets a line with no brand name and no die/kill wording', (_name, product) => {
    const out = buildWhatToExpect({ products: [product] });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).not.toMatch(/Taurus|Alpine|Advion|Talak|Demand|Onslaught|Delta Dust|Gentrol|Tekko/);
    expect(out.lines[0]).not.toMatch(/\b(die|dies|dying|dead|kill\w*)\b/i);
  });

  it('the barrier sentence names only the products recorded outside', () => {
    const out = buildWhatToExpect({ products: [
      { name: 'Atticus Talak', method: 'perimeter_spray', methodInferred: false },
      { name: 'Demand CS' },
    ] });
    expect(out.lines[0]).toMatch(/^We applied a residual bifenthrin barrier around the outside of your home\. Bifenthrin binds/);
    expect(out.lines[0]).not.toMatch(/lambda-cyhalothrin/);
  });

  it('only a Tekko Pro visit states the label\'s 6-month duration', () => {
    const gentrol = buildWhatToExpect({ products: [{ name: 'Gentrol IGR' }] });
    expect(gentrol.lines[0]).toMatch(/with \(S\)-hydroprene/);
    expect(gentrol.lines[0]).not.toMatch(/6 months/);
    const tekko = buildWhatToExpect({ products: [{ name: 'Tekko Pro IGR' }] });
    expect(tekko.lines[0]).toMatch(/with pyriproxyfen and novaluron.*up to 6 months of activity on cockroach nymphs\.$/);
  });

  it('the roach gel line keeps the over-the-counter spray warning from the label', () => {
    const out = buildWhatToExpect({ products: [{ name: 'Advion Evolution Cockroach Gel Bait' }] });
    expect(out.lines[0]).toMatch(/^We placed an indoxacarb gel bait as crack-and-crevice placements/);
    expect(out.lines[0]).toMatch(/a residual spray contaminates the bait/);
  });
});

describe('buildSpiderExpectation', () => {
  const EAVE_ACTION = ['Swept eaves, window frames, door frames, and lanai'];

  it('returns null with no eave/web/soffit action at all', () => {
    expect(buildSpiderExpectation({ actionLabels: ['Treated exterior perimeter band'], applications: [] })).toBeNull();
  });

  // Owner ruling 2026-09-28 (P1 audit): a spider-targeted product does NOT
  // establish that eaves were treated — the tech may have tagged it while
  // applying it somewhere else entirely. This is the exact required
  // regression test: no recorded action => no spider section, REGARDLESS
  // of any spider-targeted (even pyrethroid-classified) product.
  it('a spider-targeted product WITHOUT a recorded eave/web/soffit action => NO spider section', () => {
    const out = buildSpiderExpectation({
      actionLabels: ['Treated exterior perimeter band'],
      applications: [{ product: { name: 'Demand CS' }, targets: ['spiders'] }],
    });
    expect(out).toBeNull();
  });

  it('action recorded, no spider-labeled pyrethroid residual applied: de-web wording only, no treatment claim', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      applications: [],
    });
    expect(out.headline).toBe('Spiders');
    expect(out.whatWeDid).toBe('We swept webs and egg sacs from your eaves and entry points.');
    // No treatment/residual claim anywhere in the card.
    expect(out.whatWeDid).not.toMatch(/treated|residual/i);
    expect(out.expectation).not.toMatch(/The residual binds/);
    expect(out.expectation).toMatch(/takes out established harborage/);
    expect(out.nextStep).toBeUndefined();
    // The raw protocol-action label text never leaks into the customer copy.
    expect(out.whatWeDid).not.toMatch(/Swept eaves, window frames, door frames, and lanai/);
  });

  it('a differently-worded web action (no eave named) renders the fixed LOCATION-NEUTRAL de-web sentence, never its own text', () => {
    const out = buildSpiderExpectation({
      actionLabels: ['Internal SKU-4471 cobweb removal — do not quote to customer'],
      applications: [],
    });
    expect(out.whatWeDid).toBe('We swept webs and egg sacs from the exterior of your home.');
    expect(out.whatWeDid).not.toMatch(/SKU-4471/);
    expect(out.whatWeDid).not.toMatch(/eaves/);
  });

  // codex P2 2026-09-28 round 5: the canonical exterior action opens the
  // section (it is a web action) but places the work nowhere in particular,
  // so the eaves are never named.
  it('the canonical "Removed accessible webs from the recorded exterior areas." action: section renders, wording is location-neutral', () => {
    const out = buildSpiderExpectation({
      actionLabels: ['Removed accessible webs from the recorded exterior areas.'],
      actionEntries: [{ label: 'Removed accessible webs from the recorded exterior areas.', treatmentApplied: false }],
      applications: [],
    });
    expect(out).not.toBeNull();
    expect(out.whatWeDid).toBe('We swept webs and egg sacs from the exterior of your home.');
    expect(out.whatWeDid).not.toMatch(/eaves|entry points/);
    expect(out.expectation).toMatch(/takes out established harborage/);
  });

  it('a generic web action plus a TREATED generic web entry (no eave named anywhere) never earns the eave residual wording', () => {
    const out = buildSpiderExpectation({
      actionLabels: ['Removed accessible webs from the recorded exterior areas.'],
      actionEntries: [{ label: 'Treated webs on exterior surfaces', treatmentApplied: true }],
      applications: [{ product: { name: 'Demand CS' }, targets: ['spiders'] }],
    });
    expect(out.whatWeDid).toBe('We swept webs and egg sacs from the exterior of your home.');
    expect(out.expectation).not.toMatch(/The residual binds/);
  });

  // P1-C fix (owner ruling 2026-09-28, P1 audit round 2): a spider-targeted
  // pyrethroid applied ANYWHERE is not evidence the EAVES were treated —
  // the sweep-only eave action alone (treatmentApplied: false) must not be
  // combined with an unrelated product's spider tag to claim a residual is
  // present. This is the exact false-positive the fix closes: NO area
  // evidence tying the product to the eaves, and NO separately-recorded
  // eave TREATMENT (only the sweep) => de-web wording, never combined.
  it('spider-targeted pyrethroid applied with NO location evidence tying it to the eaves: de-web wording only (no false residual credit)', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'] }],
    });
    expect(out.whatWeDid).toBe('We swept webs and egg sacs from your eaves and entry points.');
    expect(out.expectation).not.toMatch(/The residual binds/);
  });

  it('action recorded AND a spider-labeled pyrethroid residual applied WITH its own application area naming eaves/soffit: combined wording', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'], applicationArea: 'Eaves / soffit' }],
    });
    expect(out.whatWeDid).toBe('We swept webs and egg sacs, then applied a residual insecticide to the eaves and entry points where spiders build.');
    expect(out.expectation).toMatch(/The residual binds/);
    expect(out.expectation).toMatch(/thins out over the next few weeks/);
    expect(out.nextStep).toBeUndefined();
  });

  it('the OTHER real controlled eave chip, "Eaves / soffits" (plural), also earns the combined wording', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'], applicationArea: 'Eaves / soffits' }],
    });
    expect(out.whatWeDid).toBe('We swept webs and egg sacs, then applied a residual insecticide to the eaves and entry points where spiders build.');
  });

  // codex P1 2026-09-29 (pre-push audit round 3): eave/soffit area evidence
  // resolves by EXACT controlled-chip key, never a substring match. Neither
  // the controlled INTERIOR chip "Interior entry points" nor an
  // eave-sounding but uncontrolled free-text string may stand in for the
  // real "Eaves / soffit(s)" chip(s).
  it('the controlled INTERIOR chip "Interior entry points" is not eave/soffit evidence (no false residual credit)', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'], applicationArea: 'Interior entry points' }],
    });
    expect(out.whatWeDid).toBe('We swept webs and egg sacs from your eaves and entry points.');
  });

  it('an eave-sounding but uncontrolled free-text area does not qualify as eave/soffit evidence', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'], applicationArea: 'Cleaned out the eaves and gutters' }],
    });
    expect(out.whatWeDid).toBe('We swept webs and egg sacs from your eaves and entry points.');
  });

  it('action recorded AND a spider-labeled pyrethroid residual applied, AND the visit separately recorded a genuine (treatmentApplied: true) eave action: combined wording', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      actionEntries: [{ label: 'Treated eaves and soffit with residual', treatmentApplied: true }],
      applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'] }], // no area of its own
    });
    expect(out.whatWeDid).toBe('We swept webs and egg sacs, then applied a residual insecticide to the eaves and entry points where spiders build.');
    expect(out.expectation).toMatch(/The residual binds/);
  });

  it('a SWEEP-only actionEntries (treatmentApplied: false) does NOT count as eave-treatment evidence', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      actionEntries: [{ label: EAVE_ACTION[0], treatmentApplied: false }],
      applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'] }],
    });
    expect(out.whatWeDid).toBe('We swept webs and egg sacs from your eaves and entry points.');
  });

  it('action recorded, a spider-targeted product applied but it is NOT pyrethroid-classified: still de-web only (no false residual credit)', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      applications: [{ product: { name: 'Taurus SC' }, targets: ['spiders'], applicationArea: 'Eaves / soffit' }], // non_repellent, not pyrethroid
    });
    expect(out.whatWeDid).toBe('We swept webs and egg sacs from your eaves and entry points.');
  });

  it('action recorded, a pyrethroid product applied but NOT targeted for spiders: still de-web only', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      applications: [{ product: { name: 'Demand CS' }, targets: ['ants'], applicationArea: 'Eaves / soffit' }],
    });
    expect(out.whatWeDid).toBe('We swept webs and egg sacs from your eaves and entry points.');
  });

  // codex P2 #5137 deferred finding b: "Completed the recorded eave and
  // soffit service." (client/src/lib/service-completion-choices.js's
  // "serviced-eaves" choice) names the eaves but records no web-removal
  // work at all — it matched SPIDER_ACTION_RE (and so opened the section)
  // purely because it contains "eave"/"soffit". Selecting it alone must no
  // longer produce "We knocked down webs around the eaves and entry
  // points." with nothing to back up that webs were ever touched.
  describe('a location-only eave-service action records no web removal (codex P2 deferred finding b, #5137)', () => {
    const EAVE_SERVICE_ONLY = ['Completed the recorded eave and soffit service.'];

    it('no card at all — no residual, no web-removal wording of any kind', () => {
      const out = buildSpiderExpectation({ actionLabels: EAVE_SERVICE_ONLY, applications: [] });
      expect(out).toBeNull();
    });

    it('still no card even with a spider-labeled pyrethroid residual applied at the eaves — the "knocked down webs" claim needs web-removal evidence, not just a treatment', () => {
      const out = buildSpiderExpectation({
        actionLabels: EAVE_SERVICE_ONLY,
        applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'], applicationArea: 'Eaves / soffit' }],
      });
      expect(out).toBeNull();
    });

    it('paired with an actual web-removal action ("removed-webs"), the section renders with the eave-named wording as before', () => {
      const out = buildSpiderExpectation({
        actionLabels: [...EAVE_SERVICE_ONLY, 'Removed accessible webs from the recorded exterior areas.'],
        applications: [],
      });
      expect(out).not.toBeNull();
      expect(out.whatWeDid).toBe('We swept webs and egg sacs from your eaves and entry points.');
    });

    it('the protocol library\'s "Swept eaves, window frames, door frames, and lanai" action still counts as web-removal evidence (sweeping IS the act)', () => {
      const out = buildSpiderExpectation({
        actionLabels: ['Swept eaves, window frames, door frames, and lanai'],
        applications: [],
      });
      expect(out).not.toBeNull();
      expect(out.whatWeDid).toBe('We swept webs and egg sacs from your eaves and entry points.');
    });
  });

  it('never guarantees a result, in either combo', () => {
    const combos = [
      buildSpiderExpectation({ actionLabels: EAVE_ACTION, applications: [] }),
      buildSpiderExpectation({
        actionLabels: EAVE_ACTION,
        applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'], applicationArea: 'Eaves / soffit' }],
      }),
    ];
    for (const out of combos) {
      expect(out.expectation).not.toMatch(/guarantee/i);
    }
  });
});

describe('buildPestExpectations — composition', () => {
  it('returns null when rain, spiders, and what-to-expect are all null (no data)', () => {
    expect(buildPestExpectations({ weekWeather: null, applications: [], actionLabels: [], serviceMonth: 2 })).toBeNull();
  });

  it('composes all three from realistic applications shape', () => {
    const out = buildPestExpectations({
      weekWeather: { rainInches: 1.5, rainConfidence: null },
      applications: [
        { product: { name: 'Taurus SC', active_ingredient: 'Fipronil', category: 'insecticide', moa_group: null, rainfast_minutes: null }, targets: ['ants'] },
      ],
      actionLabels: ['Swept eaves, window frames, door frames, and lanai'],
      serviceMonth: 7,
    });
    expect(out.rain.lines.length).toBeGreaterThan(0);
    // Action recorded, but the only applied product is Taurus SC (targeted
    // for ants, not spiders, and non_repellent-classified anyway) => de-web
    // wording, not the combined/residual wording.
    expect(out.spiders.headline).toBe('Spiders');
    expect(out.spiders.whatWeDid).toBe('We swept webs and egg sacs from your eaves and entry points.');
    expect(out.whatToExpect.lines[0]).toMatch(/non-repellent/);
  });

  // codex P2 #5137 deferred finding c: a same-day live report with an open
  // trailing-week window passes weekWeather: null all the way through
  // buildReportV1Data / reports-public.js's settledWeekWeatherForRender —
  // the composed `rain` key must still surface the live forecast warning.
  it('surfaces the rain key from the live forecast signal alone, with no settled weekly total', () => {
    const out = buildPestExpectations({
      weekWeather: null,
      applications: [{ product: { name: 'Demand CS' }, targets: [], method: 'perimeter_spray', methodInferred: false }],
      actionLabels: [],
      serviceMonth: 2,
      forecastHeavyRain: true,
    });
    expect(out.rain.lines[0]).toMatch(/Heavy rain soon after an exterior application/);
  });
});

describe('buildPestExpectations — child keys present only with content (codex P0 #5137 r6)', () => {
  it('only rain → only the rain key', () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    const out = buildPestExpectations({ weekWeather: { rainInches: 0.1, rainConfidence: null, windowClosed: true }, applications: [], serviceMonth: 3 });
    expect(Object.keys(out)).toEqual(['rain']);
  });

  it('nothing → null, never an object of nulls', () => {
    expect(buildPestExpectations({ weekWeather: null, applications: [], serviceMonth: 3 })).toBeNull();
  });
});
