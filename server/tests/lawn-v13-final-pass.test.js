// Lawn protocol v13, final advisor pass (owner 2026-10-09; migration 20261009150000, config/lawn-v13-count-caps.js, the recipe file).
// The recipe text and the limit entries, no database: the staged rows and the limit maths run in lawn-v13-final-pass.db.test.js and
// lawn-v13-final-pass-limits.db.test.js. Synthetic data only.
const fs = require('fs');
const path = require('path');
const v13 = require('../config/lawn-protocol-v13.json');
const caps = require('../config/lawn-v13-count-caps');
const migration = require('../models/migrations/20261009150000_lawn_v13_final_pass');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TRACKS = Object.keys(v13);
const visit = (month, track = 'st_augustine') => v13[track].visits.find((v) => v.month === MONTH_ABBR[month - 1]);
const lines = (text) => String(text || '').split('\n').filter(Boolean);
const lineFor = (month, name, track) => lines(visit(month, track).secondary).filter((l) => l.startsWith(`${name} — `));
const N = staged.NAMES;

describe('the recipe file', () => {
  test('the three tracks stay identical except for the name', () => {
    expect(TRACKS).toEqual(['st_augustine', 'bermuda', 'zoysia']);
    for (const track of TRACKS) {
      const { name, ...rest } = v13[track];
      expect(rest).toEqual((({ name: _name, ...others }) => others)(v13.st_augustine));
      expect(name).toMatch(/^Waves Lawn Program v13 \(/);
    }
  });

  test('the file keeps its two-space JSON form (one write path, no reformatting)', () => {
    const raw = fs.readFileSync(path.join(__dirname, '../config/lawn-protocol-v13.json'), 'utf8');
    expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
  });

  test.each(TRACKS)('%s: Topchoice carries the 500 ft scrub-jay setback beside the water setbacks in April and October, and the safety rules say who checks the map', (track) => {
    for (const month of [4, 10]) {
      const [line] = lineFor(month, 'Topchoice Granular Insecticide', track);
      expect(line).toContain('not within 15 ft of fresh water or 60 ft of tidal water; not within 500 ft of areas occupied by the threatened Florida scrub jay, bluetail mole skink or sand skink');
      expect(line).toContain('the office checks the county scrub-jay habitat map before it prices the add-on');
    }
    const rule = v13[track].safety_rules.find((r) => r.startsWith('Topchoice Granular Insecticide: not within 500 ft'));
    expect(rule).toMatch(/Florida scrub jay, bluetail mole skink or sand skink/);
    expect(rule).toMatch(/The office checks the county scrub-jay habitat map before it prices the add-on/);
  });

  test.each(TRACKS)('%s: the Pythium pair stays Artavia twice, as a named exception to the group rule (no Headway: it repeats group 11)', (track) => {
    for (const month of [6, 7, 8]) {
      expect(lineFor(month, N.ART, track).join('\n')).toContain('Pythium root rot on saturated areas, 0.77 fl oz per 1,000 sq ft every 10 to 14 days, two applications in a row at most. This pair is a named exception to the group rule (no other Pythium product is in the kit; the Artavia label allows sequential applications). Fix the watering first.');
      expect(lineFor(month, 'Headway Fungicide', track)).toEqual([]);
    }
    const notes = v13[track].notes.join('\n');
    expect(notes).toMatch(/Three exceptions: Group 3 pre-emergents .*, the take-all pair \(Artavia, then Headway 30 days later, or Artavia twice; both recorded for take-all\) and the Pythium pair \(Artavia twice, 10 to 14 days apart; no other Pythium product is in the kit/);
    expect(notes).toContain('Pythium root rot with Artavia in June, July and August');
    expect(v13[track].safety_rules.find((r) => /chemical group/.test(r))).toMatch(/and the Pythium pair \(Artavia twice, 10 to 14 days apart, recorded for Pythium\)\.$/);
  });

  test.each(TRACKS)('%s: Acelepryn prints the label\'s caterpillar range', (track) => {
    for (const month of [7, 8, 9]) expect(lineFor(month, 'Acelepryn Insecticide', track)[0]).toContain('caterpillars, 0.05 to 0.09 fl oz per 1,000 sq ft, recheck in 7 days');
    expect(JSON.stringify(v13[track])).not.toMatch(/0\.046|0\.092/);
  });

  test.each(TRACKS)('%s: Arena is the Florida 2(ee) rate, below the label range of 9.6 to 12.8 oz per acre, with the numbers unchanged', (track) => {
    const note = v13[track].notes.find((n) => n.startsWith('Chinch bugs'));
    expect(note).toContain('Arena: 0.147 oz per 1,000 sq ft (6.4 oz per acre, the Florida 2(ee) recommendation rate, below the label\'s chinch range of 9.6 to 12.8 oz per acre; about 1.4 level teaspoons), up to 2 applications per lawn per year at least 8 weeks (56 days) apart');
    expect(note).toContain('Two applications reach the label\'s yearly limit of 12.8 oz per acre (0.4 lb clothianidin per acre)');
    expect(JSON.stringify(v13[track])).not.toContain('low end of the label');
  });

  test.each(TRACKS)('%s: November and December say what to do on an active large patch; N rates are unchanged', (track) => {
    expect(visit(11, track).notes).toContain('Active large patch mapped this month: use the 0.5 lb N setting (2.1 lb of the 24-0-11 per 1,000 sq ft) and keep fertilizer off the patch.');
    expect(visit(12, track).notes).toContain('Active large patch mapped this month: keep fertilizer off the patch.');
    expect(visit(12, track).notes).not.toMatch(/0\.5 lb N setting/);
    expect(visit(11, track).notes).toMatch(/^N rate: 0\.75 lb N\./);
    expect(visit(12, track).notes).toMatch(/^N rate: 0\.45 lb N\. K rate: 0\.99 lb K\./);
    // 2.1 lb of 24-0-11 is the 0.5 lb N the April visit already uses.
    expect(Math.round(2.1 * 0.24 * 1000) / 1000).toBe(0.504);
    expect(visit(4, track).primary).toContain('2.1 lb per 1,000 sq ft (0.5 lb N)');
  });

  test.each(TRACKS)('%s: the large patch and take-all lines state the catalog rates', (track) => {
    expect(lineFor(1, N.ART, track)[0]).toContain('active large patch, mapped areas, 0.38 to 0.77 fl oz per 1,000 sq ft');
    expect(lineFor(12, N.ART, track)[0]).toContain('active large patch, mapped areas, 0.38 to 0.77 fl oz per 1,000 sq ft');
    expect(lineFor(10, N.ART, track)[0]).toContain('mapped large patch with Velista, 0.38 to 0.77 fl oz per 1,000 sq ft at 2 gal per 1,000 sq ft');
    expect(lineFor(3, N.ART, track)[0]).toContain('mapped take-all areas, first spring application, 0.77 fl oz per 1,000 sq ft');
    expect(lineFor(9, N.ART, track)[0]).toContain('mapped take-all areas, first fall application, 0.77 fl oz per 1,000 sq ft');
    expect(lineFor(1, N.VEL, track)[0]).toContain('large patch, the next application after Artavia, 0.5 oz per 1,000 sq ft');
    expect(lineFor(10, N.VEL, track)[0]).toContain('mapped large patch with Artavia, 0.5 oz per 1,000 sq ft at 2 gal per 1,000 sq ft;');
    expect(lineFor(11, N.VEL, track)[0]).toContain('mapped large patch, 0.5 oz per 1,000 sq ft at 2 gal per 1,000 sq ft;');
  });

  test('no Nutra-TECH rate, North Port wording or N rate moved (spot checks against the pre-change text)', () => {
    const track = v13.st_augustine;
    expect(visit(6).primary).toContain('12 fl oz per 1,000 sq ft (16 fl oz on pale turf)');
    expect(track.notes.join('\n')).toContain('North Port: no Nutra-TECH on the June, August and September visits until the city confirms. The April Nutra-TECH pass stays.');
    expect(visit(2).primary).toContain('3.1 lb per 1,000 sq ft (0.75 lb N)');
    expect(visit(10).primary).toContain('4.04 lb per 1,000 sq ft (0.73 lb N, 0.4 lb K2O)');
  });
});

describe('the limit entries (config/lawn-v13-count-caps.js)', () => {
  const entry = (name) => caps.V13_LIMITS.find((e) => e.name === name);

  test('V13_COUNT_CAPS keeps exactly the four names that pushed migrations 20261007175000 and 20261007177000 read when they run', () => {
    expect(caps.V13_COUNT_CAPS.map((e) => e.name)).toEqual(['Celsius WG', 'Arena 50 WDG', 'Certainty Turf Herbicide', 'Blindside Herbicide']);
    expect(caps.V13_COUNT_CAPS.every((e) => e.cap === 2)).toBe(true);
    expect(caps.V13_LIMITS.map((e) => e.name)).toEqual([...caps.V13_COUNT_CAPS.map((e) => e.name), 'Dylox 6.2 G Granular Insecticide', 'Velista', 'Artavia 2 SC (Azoxy)']);
    expect(Object.isFrozen(caps.V13_COUNT_CAPS) && Object.isFrozen(caps.V13_MORE_LIMITS) && Object.isFrozen(caps.V13_LIMITS)).toBe(true);
  });

  test('Blindside: program rate 0.149 oz (label warm-season rate), count 2 kept for frozen migrations, yearly amount 0.23 oz holds it to one pass', () => {
    const blindside = entry('Blindside Herbicide');
    expect(blindside.cap).toBe(2);
    expect(blindside.annualAmount).toMatchObject({ cap: 0.23, unit: 'oz/1000sf/year', fallbackRate: 0.23 });
    expect(blindside.annualAmount.description).toContain('EPA 279-3411');
    // One pass at the v13 rate fits the yearly amount; two (0.298 oz) do not; one at the label maximum fills it.
    expect(migration.BLINDSIDE_RATE).toBe(0.149);
    expect(migration.BLINDSIDE_RATE).toBeLessThanOrEqual(blindside.annualAmount.cap);
    expect(migration.BLINDSIDE_RATE * 2).toBeGreaterThan(blindside.annualAmount.cap);
    expect(blindside.description).toContain('0.149 oz');
    for (const track of Object.values(v13)) {
      const text = JSON.stringify(track);
      expect(text).not.toContain('0.115');
      expect(track.safety_rules[0]).toContain('Blindside: 1 application per lawn per year');
      expect(track.safety_rules[0]).toContain('at 0.149 oz per 1,000 sq ft, one application per lawn per year (label: warm-season rate 0.149 to 0.23 oz a pass, no more than 0.23 oz per 1,000 sq ft a year)');
      expect(track.notes.join('\n')).toContain('Blindside goes on at 0.149 oz per 1,000 sq ft, one application per lawn per year (label: the warm-season rate is 0.149 to 0.23 oz a pass, and no more than 0.23 oz per 1,000 sq ft (10 oz per acre) a year).');
    }
    expect(migration.BLINDSIDE_UNIT).toBe('oz');
  });

  test('Certainty keeps its count of 2 and gains a 28 day interval; Dylox is a count of 3; Velista and Artavia carry only a yearly amount', () => {
    expect(entry('Certainty Turf Herbicide')).toMatchObject({ cap: 2, minIntervalDays: 28 });
    expect(entry('Certainty Turf Herbicide').intervalDescription).toContain('4 or more weeks');
    expect(entry('Dylox 6.2 G Granular Insecticide')).toMatchObject({ cap: 3 });
    expect(entry('Dylox 6.2 G Granular Insecticide').description).toContain('limit applications to 3 per calendar year');
    expect(entry('Velista')).toMatchObject({ annualAmount: { cap: 2.2, unit: 'oz/1000sf/year', fallbackRate: 0.7 } });
    expect(entry('Velista').cap).toBeUndefined();
    expect(entry('Artavia 2 SC (Azoxy)')).toMatchObject({ annualAmount: { cap: 7.1, unit: 'fl oz/1000sf/year', fallbackRate: 0.77 } });
    expect(entry('Artavia 2 SC (Azoxy)').cap).toBeUndefined();
  });

  test('the Arena entry: numbers unchanged, wording corrected in the header and the description', () => {
    const arena = entry('Arena 50 WDG');
    expect(arena).toMatchObject({ cap: 2, minIntervalDays: 56, annualAmount: { cap: 0.294, unit: 'oz/1000sf/year', fallbackRate: 0.29 } });
    expect(arena.description).toContain('the Florida 2(ee) recommendation rate, below the label\'s chinch range of 9.6 to 12.8 oz per acre');
    const source = fs.readFileSync(path.join(__dirname, '../config/lawn-v13-count-caps.js'), 'utf8');
    expect(source).not.toMatch(/low end of the label/);
    expect(source).toMatch(/Florida 2\(ee\)[\s*]+recommendation rate and below the label's chinch range/);
  });

  test.each([
    ['Celsius WG', ['annual_max_apps']],
    ['Arena 50 WDG', ['annual_max_apps', 'min_interval_days', 'annual_max_rate']],
    ['Certainty Turf Herbicide', ['annual_max_apps', 'min_interval_days']],
    ['Blindside Herbicide', ['annual_max_apps', 'annual_max_rate']],
    ['Dylox 6.2 G Granular Insecticide', ['annual_max_apps']],
    ['Velista', ['annual_max_rate']],
    ['Artavia 2 SC (Azoxy)', ['annual_max_rate']],
  ])('%s: the synthetic rows an empty product gets are exactly %j, all hard blocks', (name, types) => {
    const rows = caps.withEntryCaps(entry(name), [], 'p1');
    expect(rows.map((r) => r.limit_type)).toEqual(types);
    expect(rows.every((r) => r.severity === 'hard_block' && r.synthetic === true && r.product_id === 'p1')).toBe(true);
    expect(rows.filter((r) => r.match_type === caps.V13_AMOUNT).map((r) => [r.limit_value, r.limit_unit, r.fallback_rate])).toEqual(
      entry(name).annualAmount ? [[entry(name).annualAmount.cap, entry(name).annualAmount.unit, entry(name).annualAmount.fallbackRate]] : [],
    );
  });

  test('an entry with no count adds no count row and leaves a stored one as it is; with a stored row the amount and interval rows still come', () => {
    const stored = { id: 7, product_id: 'p1', match_type: 'product', limit_type: 'annual_max_apps', limit_value: 9, limit_unit: 'applications', severity: 'warning' };
    expect(caps.withEntryCaps(entry('Velista'), [stored], 'p1').map((r) => [r.id, r.limit_type, Number(r.limit_value), r.severity])).toEqual([
      [7, 'annual_max_apps', 9, 'warning'], [null, 'annual_max_rate', 2.2, 'hard_block'],
    ]);
    // A counted entry still lowers a stored row and makes it hard.
    expect(caps.withEntryCaps(entry('Dylox 6.2 G Granular Insecticide'), [stored], 'p1')).toEqual([{ ...stored, limit_value: 3, severity: 'hard_block' }]);
    expect(caps.withEntryCaps(entry('Certainty Turf Herbicide'), [{ ...stored, limit_value: 3 }], 'p1').map((r) => [r.limit_type, Number(r.limit_value)])).toEqual([['annual_max_apps', 2], ['min_interval_days', 28]]);
    expect(caps.withEntryCaps(null, [stored])).toEqual([stored]);
  });

  test('withEntryCapMetadata: an entry with no count clamps nothing and never throws; a stale Certainty interval is raised; the Celsius and Arena clamps are as before', () => {
    const product = { gates: { annualMaxApps: 5 }, annual_counter: { maxApplications: 9 } };
    expect(caps.withEntryCapMetadata(entry('Velista'), product)).toBe(product);
    expect(caps.withEntryCapMetadata(entry('Artavia 2 SC (Azoxy)'), product)).toBe(product);
    expect(caps.withEntryCapMetadata(null, product)).toBe(product);
    const clamped = caps.withEntryCapMetadata(entry('Celsius WG'), product);
    expect([clamped.gates.annualMaxApps, clamped.annual_counter.maxApplications]).toEqual([2, 2]);
    expect(caps.withEntryCapMetadata(entry('Dylox 6.2 G Granular Insecticide'), product).gates.annualMaxApps).toBe(3);
    const stale = caps.withEntryCapMetadata(entry('Certainty Turf Herbicide'), { gates: { minIntervalDays: 14, annualMaxApps: 2 }, annual_counter: { maxApplications: 2 } });
    expect(stale.gates).toEqual({ minIntervalDays: 28, annualMaxApps: 2 });
    expect(caps.withEntryCapMetadata(entry('Arena 50 WDG'), { gates: { minIntervalDays: 56, annualMaxApps: 2 } }).gates).toEqual({ minIntervalDays: 56, annualMaxApps: 2 });
  });

  test('the Celsius yearly figure the report copy reads is still 2 under v13 and 3 before it', () => {
    expect([caps.CELSIUS_YTD_CAP, caps.CELSIUS_YTD_CAP_LEGACY]).toEqual([2, 3]);
  });

  test('every name resolves by the exact catalog name the staged migration uses (the cap entries are keyed by what the recipe and catalog call them)', () => {
    expect(entry('Velista').name).toBe(N.VEL);
    expect(entry('Artavia 2 SC (Azoxy)').name).toBe(N.ART);
    expect(entry('Dylox 6.2 G Granular Insecticide').name).toBe(N.DYL);
    expect(entry('Certainty Turf Herbicide').name).toBe(N.CER);
    for (const name of caps.V13_LIMITS.map((e) => e.name)) expect(caps.v13CountCapFor(name)).toBe(entry(name));
  });
});

describe('the migration', () => {
  test('its audit action fits the column (40 characters) and its names are the catalog\'s', () => {
    expect(migration.ACTION.length).toBeLessThanOrEqual(40);
    expect(migration.WEED_NAMES).toEqual([N.CEL, N.CER, N.NIS, 'Blindside Herbicide']);
    expect(migration.WINDOWS.NOV).toBe(staged.WINDOWS.find((w) => w[0] === 11)[1]);
    expect(migration.WINDOWS.DEC).toBe(staged.WINDOWS.find((w) => w[0] === 12)[1]);
  });
});
