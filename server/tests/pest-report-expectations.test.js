// Unit tests for the Pest Report V2 "expectations" blocks (owner-approved
// 2026-09-27, GATE_PEST_REPORT_EXPECTATIONS). Pure module, synthetic data only.

const {
  pestReportExpectationsGateOn,
  classifyProductExpectation,
  buildRainExpectation,
  buildSpiderExpectation,
  buildWhatToExpect,
  buildPestExpectations,
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

  it('adds the rain-fast clause ONLY when a product supplies rainfastMinutes (synthetic — prod catalog is NULL today)', () => {
    const withRainfast = buildRainExpectation({
      weekWeather: { rainInches: 0.5, rainConfidence: null },
      products: [{ rainfastMinutes: 30 }],
      serviceMonth: 2,
    });
    expect(withRainfast.lines[0]).toMatch(/rain-fast once dry \(about 30 min, per the label\)/);

    const withoutRainfast = buildRainExpectation({
      weekWeather: { rainInches: 0.5, rainConfidence: null },
      products: [{ rainfastMinutes: null }],
      serviceMonth: 2,
    });
    expect(withoutRainfast.lines[0]).not.toMatch(/rain-fast/);
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

describe('classifyProductExpectation', () => {
  const cases = [
    [{ activeIngredient: 'Fipronil' }, 'non_repellent'],
    [{ activeIngredient: 'Dinotefuran' }, 'non_repellent'],
    [{ activeIngredient: 'Imidacloprid' }, 'non_repellent'],
    [{ activeIngredient: 'Indoxacarb' }, 'non_repellent'],
    [{ moaGroup: 'Group 2B' }, 'non_repellent'],
    [{ activeIngredient: 'Bifenthrin' }, 'pyrethroid'],
    [{ activeIngredient: 'Lambda-Cyhalothrin' }, 'pyrethroid'],
    [{ moaGroup: 'Group 3A' }, 'pyrethroid'],
    [{ category: 'IGR', activeIngredient: 'Hydroprene' }, 'igr'],
    [{ category: 'IGR', name: 'Tekko Pro IGR' }, 'igr'],
    [{ category: 'bait', name: 'Advion Cockroach Gel' }, 'roach_gel_bait'],
    [{ category: 'gel', name: 'Vendetta Plus gel' }, 'roach_gel_bait'],
    [{ activeIngredient: 'Water' }, null],
    [{}, null],
  ];
  it.each(cases)('%j → %s', (product, expected) => {
    expect(classifyProductExpectation(product)).toBe(expected);
  });
});

describe('buildWhatToExpect', () => {
  it('returns null with no classifiable products', () => {
    expect(buildWhatToExpect({ products: [{ activeIngredient: 'Water' }] })).toBeNull();
    expect(buildWhatToExpect({ products: [] })).toBeNull();
  });

  it('one line per class, de-duplicated across products of the same class', () => {
    const out = buildWhatToExpect({
      products: [
        { activeIngredient: 'Fipronil' },
        { activeIngredient: 'Dinotefuran' }, // same class — must not double the line
      ],
    });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/Non-repellent/);
  });

  it('caps to 3 lines in fixed priority order when 4 classes are present', () => {
    const out = buildWhatToExpect({
      products: [
        { category: 'IGR', activeIngredient: 'Hydroprene' },
        { activeIngredient: 'Bifenthrin' },
        { category: 'bait', name: 'Advion Cockroach Gel' },
        { activeIngredient: 'Fipronil' },
      ],
    });
    expect(out.lines).toHaveLength(3);
    // priority: non_repellent, roach_gel_bait, pyrethroid, igr — igr dropped.
    expect(out.lines.join(' ')).not.toMatch(/next generation/);
  });

  it('never uses guarantee/eliminate language', () => {
    const out = buildWhatToExpect({
      products: [
        { activeIngredient: 'Fipronil' }, { activeIngredient: 'Bifenthrin' },
        { category: 'gel', name: 'roach gel' }, { category: 'IGR' },
      ],
    });
    const joined = out.lines.join(' ');
    expect(joined).not.toMatch(/guarantee/i);
    expect(joined).not.toMatch(/eliminat/i);
  });
});

describe('buildSpiderExpectation', () => {
  it('returns null with no eave/web action and no spider-targeted product', () => {
    expect(buildSpiderExpectation({ actionLabels: ['Treated exterior perimeter band'], applications: [{ targets: ['ants'] }] })).toBeNull();
  });

  it('triggers on a completed eave/web action label — renders FIXED wording, never the raw label', () => {
    const out = buildSpiderExpectation({
      actionLabels: ['Swept eaves, window frames, door frames, and lanai'],
      applications: [],
    });
    expect(out.headline).toBe('Spiders');
    expect(out.whatWeDid).toBe('We knocked down webs and treated the eaves and entry points where spiders build.');
    // The raw protocol-action label text never leaks into the customer copy
    // (owner ruling 2026-09-28 — it can carry internal wording/product hints).
    expect(out.whatWeDid).not.toMatch(/Swept eaves, window frames, door frames, and lanai/);
    expect(out.expectation).toMatch(/thin out over about two weeks/);
    expect(out.nextStep).toBeTruthy();
  });

  it('a differently-worded eave/web action label still renders the SAME fixed sentence, not its own text', () => {
    const out = buildSpiderExpectation({
      actionLabels: ['Internal SKU-4471 cobweb removal — do not quote to customer'],
      applications: [],
    });
    expect(out.whatWeDid).toBe('We knocked down webs and treated the eaves and entry points where spiders build.');
    expect(out.whatWeDid).not.toMatch(/SKU-4471/);
  });

  it('triggers on a spider-targeted product with no matching action label', () => {
    const out = buildSpiderExpectation({
      actionLabels: ['Treated exterior perimeter band'],
      applications: [{ targets: ['spiders'] }],
    });
    expect(out.whatWeDid).toBe('We applied a residual treatment labeled for spiders during this visit.');
  });

  it('never guarantees a result', () => {
    const out = buildSpiderExpectation({ actionLabels: ['Swept eaves, window frames, door frames, and lanai'], applications: [] });
    expect(out.expectation + out.nextStep).not.toMatch(/guarantee/i);
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
        { product: { active_ingredient: 'Fipronil', category: 'insecticide', moa_group: null, rainfast_minutes: null }, targets: ['ants'] },
      ],
      actionLabels: ['Swept eaves, window frames, door frames, and lanai'],
      serviceMonth: 7,
    });
    expect(out.rain.lines.length).toBeGreaterThan(0);
    expect(out.spiders.headline).toBe('Spiders');
    expect(out.whatToExpect.lines[0]).toMatch(/Non-repellent/);
  });
});
