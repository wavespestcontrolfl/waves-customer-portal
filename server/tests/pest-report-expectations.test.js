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
    expect(out.lines[0]).toMatch(/rained about 0\.4" at your property/);
    expect(out.lines).toHaveLength(1); // Feb, < 1" — no ants-after-rain line
  });

  it('hedges the number on low-confidence (city-collective fallback) rain', () => {
    const out = buildRainExpectation({ weekWeather: { rainInches: 2.1, rainConfidence: 'low' }, serviceMonth: 2 });
    expect(out.lines[0]).toMatch(/Rain gauges for your area suggest roughly 2\.1"/);
    expect(out.lines[0]).toMatch(/can vary/);
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

  it('formats a >=60min rainfast time in hours', () => {
    expect(formatRainfastMinutes(120)).toBe('2 hr');
    expect(formatRainfastMinutes(90)).toBe('1.5 hr');
    expect(formatRainfastMinutes(30)).toBe('30 min');
    expect(formatRainfastMinutes(null)).toBeNull();
  });

  it('adds the forecast heavy-rain caveat only when forecastHeavyRain is true (caller\'s job to gate LIVE-only)', () => {
    const live = buildRainExpectation({
      weekWeather: { rainInches: 0.2, rainConfidence: null }, serviceMonth: 2, forecastHeavyRain: true,
    });
    expect(live.lines[0]).toMatch(/Heavy rain right after a treatment/);

    const notLive = buildRainExpectation({
      weekWeather: { rainInches: 0.2, rainConfidence: null }, serviceMonth: 2, forecastHeavyRain: false,
    });
    expect(notLive.lines[0]).not.toMatch(/Heavy rain right after a treatment/);
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
    expect(under.lines.join(' ')).not.toMatch(/Heavy rain pushes ants indoors/);

    const over = buildRainExpectation({ weekWeather: { rainInches: 0.5, rainConfidence: null }, serviceMonth: 7 });
    expect(over.lines).toHaveLength(2);
    expect(over.lines[1]).toMatch(/Heavy rain pushes ants indoors/);
  });

  it('outside rainy season: the ants line needs >= 1" — 0.5" (the rainy-season bar) is not enough', () => {
    const halfInch = buildRainExpectation({ weekWeather: { rainInches: 0.5, rainConfidence: null }, serviceMonth: 2 });
    expect(halfInch.lines).toHaveLength(1);
    expect(halfInch.lines.join(' ')).not.toMatch(/Heavy rain pushes ants indoors/);

    const under = buildRainExpectation({ weekWeather: { rainInches: 0.9, rainConfidence: null }, serviceMonth: 2 });
    expect(under.lines).toHaveLength(1); // rain line only — no ants line
    const over = buildRainExpectation({ weekWeather: { rainInches: 1, rainConfidence: null }, serviceMonth: 2 });
    expect(over.lines).toHaveLength(2);
    expect(over.lines[1]).toMatch(/Heavy rain pushes ants indoors/);
  });

  it('low-confidence (city-collective) rain always uses the higher 1" bar, even in rainy season', () => {
    // 0.6" is over the 0.5" rainy-season bar but under the 1" low-confidence bar.
    const hedgedUnder = buildRainExpectation({ weekWeather: { rainInches: 0.6, rainConfidence: 'low' }, serviceMonth: 7 });
    expect(hedgedUnder.lines).toHaveLength(1);
    expect(hedgedUnder.lines.join(' ')).not.toMatch(/Heavy rain pushes ants indoors/);

    const hedgedOver = buildRainExpectation({ weekWeather: { rainInches: 1, rainConfidence: 'low' }, serviceMonth: 7 });
    expect(hedgedOver.lines).toHaveLength(2);
    expect(hedgedOver.lines[1]).toMatch(/Heavy rain pushes ants indoors/);
  });

  it('the LIVE-only forecast heavy-rain signal alone adds the ants line, even with no rain data', () => {
    const out = buildRainExpectation({ weekWeather: null, serviceMonth: 2, forecastHeavyRain: true });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/Heavy rain pushes ants indoors/);
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
    expect(joined).not.toMatch(/eliminat/i);
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
    [{ name: 'Advion WDG Granular' }, 'ant_bait'],
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
    expect(out.lines[0]).toMatch(/carry it back to the colony/);
    expect(out.lines[0]).not.toMatch(/dead roaches/);
  });

  it('Advion WDG Granular also classifies ant_bait', () => {
    const out = buildWhatToExpect({ products: [{ name: 'Advion WDG Granular' }] });
    expect(out.lines[0]).toMatch(/carry it back to the colony/);
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
      expect(out.lines[0]).toMatch(/cracks, voids/);
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
      expect(out.lines[0]).toMatch(/barrier treatment/);
      expect(out.lines[0]).toMatch(/near doors and windows/);
    });

    it('an applicationArea naming an exterior/perimeter chip earns the barrier line even with no explicit method', () => {
      const out = buildWhatToExpect({
        products: [{ name: 'Demand CS', applicationArea: 'Foundation perimeter' }],
      });
      expect(out.lines[0]).toMatch(/barrier treatment/);
    });

    it('UNKNOWN method/area (nothing recorded) falls back to non-barrier wording for the SAME product class', () => {
      const out = buildWhatToExpect({ products: [{ name: 'Demand CS' }] });
      expect(out.lines[0]).not.toMatch(/barrier|doors and windows/i);
      expect(out.lines[0]).toMatch(/keeps working after it's applied/);
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

    it('never guarantees/eliminates in either pyrethroid wording', () => {
      const confirmed = buildWhatToExpect({ products: [{ name: 'Demand CS', method: 'perimeter_spray', methodInferred: false }] });
      const unconfirmed = buildWhatToExpect({ products: [{ name: 'Demand CS' }] });
      expect(confirmed.lines[0]).not.toMatch(/guarantee|eliminat/i);
      expect(unconfirmed.lines[0]).not.toMatch(/guarantee|eliminat/i);
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
    expect(out.lines[0]).toMatch(/Non-repellent/);
    expect(out.lines[1]).toMatch(/carry it back to the colony/);
    expect(out.lines[2]).toMatch(/gel bait/);
    expect(out.lines.join(' ')).not.toMatch(/barrier treatment|next generation/);
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
    expect(joined).not.toMatch(/eliminat/i);
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
    expect(out.whatWeDid).toBe('We knocked down webs around the eaves and entry points.');
    // No treatment/residual claim anywhere in the card.
    expect(out.whatWeDid).not.toMatch(/treated|residual/i);
    expect(out.expectation).not.toMatch(/residual we applied/i);
    expect(out.expectation).toMatch(/New webs can appear within days/);
    expect(out.nextStep).toMatch(/keeps coming back/);
    // The raw protocol-action label text never leaks into the customer copy.
    expect(out.whatWeDid).not.toMatch(/Swept eaves, window frames, door frames, and lanai/);
  });

  it('a differently-worded eave/web action still renders the SAME fixed de-web sentence, not its own text', () => {
    const out = buildSpiderExpectation({
      actionLabels: ['Internal SKU-4471 cobweb removal — do not quote to customer'],
      applications: [],
    });
    expect(out.whatWeDid).toBe('We knocked down webs around the eaves and entry points.');
    expect(out.whatWeDid).not.toMatch(/SKU-4471/);
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
    expect(out.whatWeDid).toBe('We knocked down webs around the eaves and entry points.');
    expect(out.expectation).not.toMatch(/residual we applied/i);
  });

  it('action recorded AND a spider-labeled pyrethroid residual applied WITH its own application area naming eaves/soffit: combined wording', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'], applicationArea: 'Eaves / soffit' }],
    });
    expect(out.whatWeDid).toBe('We knocked down webs and treated the eaves and entry points where spiders build.');
    expect(out.expectation).toMatch(/residual we applied/i);
    expect(out.expectation).toMatch(/thin out over about two weeks/);
    expect(out.nextStep).toMatch(/come take another look/);
  });

  it('action recorded AND a spider-labeled pyrethroid residual applied, AND the visit separately recorded a genuine (treatmentApplied: true) eave action: combined wording', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      actionEntries: [{ label: 'Treated eaves and soffit with residual', treatmentApplied: true }],
      applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'] }], // no area of its own
    });
    expect(out.whatWeDid).toBe('We knocked down webs and treated the eaves and entry points where spiders build.');
    expect(out.expectation).toMatch(/residual we applied/i);
  });

  it('a SWEEP-only actionEntries (treatmentApplied: false) does NOT count as eave-treatment evidence', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      actionEntries: [{ label: EAVE_ACTION[0], treatmentApplied: false }],
      applications: [{ product: { name: 'Onslaught Fastcap' }, targets: ['spiders'] }],
    });
    expect(out.whatWeDid).toBe('We knocked down webs around the eaves and entry points.');
  });

  it('action recorded, a spider-targeted product applied but it is NOT pyrethroid-classified: still de-web only (no false residual credit)', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      applications: [{ product: { name: 'Taurus SC' }, targets: ['spiders'], applicationArea: 'Eaves / soffit' }], // non_repellent, not pyrethroid
    });
    expect(out.whatWeDid).toBe('We knocked down webs around the eaves and entry points.');
  });

  it('action recorded, a pyrethroid product applied but NOT targeted for spiders: still de-web only', () => {
    const out = buildSpiderExpectation({
      actionLabels: EAVE_ACTION,
      applications: [{ product: { name: 'Demand CS' }, targets: ['ants'], applicationArea: 'Eaves / soffit' }],
    });
    expect(out.whatWeDid).toBe('We knocked down webs around the eaves and entry points.');
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
      expect(out.expectation + out.nextStep).not.toMatch(/guarantee/i);
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
    expect(out.spiders.whatWeDid).toBe('We knocked down webs around the eaves and entry points.');
    expect(out.whatToExpect.lines[0]).toMatch(/Non-repellent/);
  });
});
