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
const entry = (name) => caps.V13_LIMITS.find((e) => e.name === name);

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

  test.each(TRACKS)('%s: Blindside is 0.149 oz, one application per lawn per year, in the notes, the safety rule and every Blindside visit line', (track) => {
    expect(JSON.stringify(v13[track])).not.toContain('0.115');
    expect(v13[track].safety_rules[0]).toContain('(Celsius and Certainty: up to 2 applications per lawn per year each; Blindside: 1 application per lawn per year)');
    expect(v13[track].safety_rules[0]).toContain('at 0.149 oz per 1,000 sq ft, one application per lawn per year (label: warm-season rate 0.149 to 0.23 oz a pass, no more than 0.23 oz per 1,000 sq ft a year)');
    expect(v13[track].notes.join('\n')).toContain('Blindside goes on at 0.149 oz per 1,000 sq ft, one application per lawn per year (label: the warm-season rate is 0.149 to 0.23 oz a pass, and no more than 0.23 oz per 1,000 sq ft (10 oz per acre) a year).');
  });

  // Recipe wording stays behind the data it needs (AGENTS.md "Lawn protocol data fan-out"): the wording below has no staged or
  // field-exec data yet, so this file keeps the text it had before the final pass. Each later PR that adds the data adds the wording.
  test.each(TRACKS)('%s: wording with no data behind it is not in the recipe (Pythium exception, Topchoice scrub-jay, Acelepryn rounding, large-patch N, fungicide rates)', (track) => {
    const text = JSON.stringify(v13[track]);
    expect(text).not.toMatch(/named exception|Three exceptions|Pythium pair/);
    expect(text).not.toMatch(/scrub[- ]jay|mole skink|sand skink/);
    expect(text).not.toMatch(/0\.05 to 0\.09/);
    expect(text).toContain('0.046 to 0.092 fl oz per 1,000 sq ft');
    expect(visit(11, track).notes).not.toMatch(/large patch mapped this month/);
    expect(visit(12, track).notes).not.toMatch(/large patch mapped this month/);
    expect(lineFor(7, N.ART, track)[0]).toContain('Pythium root rot on saturated areas, 0.77 fl oz per 1,000 sq ft every 10 to 14 days, two applications in a row at most');
    expect(v13[track].notes.join('\n')).toContain('twice in a row. Two exceptions: Group 3 pre-emergents');
    expect(lineFor(1, N.ART, track)[0]).toBe(`${N.ART} — active large patch, mapped areas`);
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

  test('V13_COUNT_CAPS keeps exactly the four names that pushed migrations 20261007175000 and 20261007177000 read when they run', () => {
    expect(caps.V13_COUNT_CAPS.map((e) => e.name)).toEqual(['Celsius WG', 'Arena 50 WDG', 'Certainty Turf Herbicide', 'Blindside Herbicide']);
    expect(caps.V13_COUNT_CAPS.every((e) => e.cap === 2)).toBe(true);
    expect(caps.V13_LIMITS.map((e) => e.name)).toEqual([...caps.V13_COUNT_CAPS.map((e) => e.name), 'Dylox 6.2 G Granular Insecticide', 'Velista', 'Artavia 2 SC (Azoxy)']);
    expect(Object.isFrozen(caps.V13_COUNT_CAPS) && Object.isFrozen(caps.V13_MORE_LIMITS) && Object.isFrozen(caps.V13_LIMITS)).toBe(true);
  });

  test('Blindside: program rate 0.149 oz (label warm-season rate), count 2 kept for frozen migrations, yearly amount 0.23 oz holds it to one pass', () => {
    const blindside = entry('Blindside Herbicide');
    expect(blindside.cap).toBe(2);
    expect(blindside.effectiveCap).toBe(1);
    expect(blindside.description).toContain('max 1 application per lawn per year');
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

  test('only Blindside has an effectiveCap; every runtime reader uses it (capOf), the frozen migrations still read cap 2', () => {
    expect(caps.V13_LIMITS.filter((e) => e.effectiveCap != null).map((e) => [e.name, e.cap, e.effectiveCap])).toEqual([['Blindside Herbicide', 2, 1]]);
    const blind = entry('Blindside Herbicide');
    const [count] = caps.withEntryCaps(blind, [], 'p1');
    expect([count.limit_type, count.limit_value, count.description]).toEqual(['annual_max_apps', 1, blind.description]);
    const stored = { id: 7, product_id: 'p1', match_type: 'product', limit_type: 'annual_max_apps', limit_value: 5, limit_unit: 'applications', severity: 'warning' };
    expect(caps.withEntryCaps(blind, [stored], 'p1')[0]).toMatchObject({ id: 7, limit_value: 1, severity: 'hard_block' });
    expect(caps.withEntryCaps(blind, [{ ...stored, limit_value: 0 }], 'p1')[0].limit_value).toBe(0);
    expect(caps.syntheticCountLimit(blind, 'p1').limit_value).toBe(1);
    // Plan and visit-brief figures: a stale staged row at 2 shows 1; a row at 1 is left alone (the same object).
    const stale = caps.withEntryCapMetadata(blind, { gates: { annualMaxApps: 2 }, annual_counter: { maxApplications: 2 } });
    expect([stale.gates.annualMaxApps, stale.annual_counter.maxApplications]).toEqual([1, 1]);
    const product = { gates: { annualMaxApps: 1 }, annual_counter: { maxApplications: 1 } };
    expect(caps.withEntryCapMetadata(blind, product)).toBe(product);
    for (const name of ['Celsius WG', 'Certainty Turf Herbicide']) {
      const kept = caps.withEntryCapMetadata(entry(name), { gates: { annualMaxApps: 2 }, annual_counter: { maxApplications: 2 } });
      expect([kept.gates.annualMaxApps, kept.annual_counter.maxApplications]).toEqual([2, 2]);
      expect(caps.withEntryCaps(entry(name), [], 'p1')[0].limit_value).toBe(2);
    }
    expect(caps.CELSIUS_YTD_CAP).toBe(2);
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

  test('the Arena entry is as it was (numbers and wording): the source-wording change is not in this PR', () => {
    const arena = entry('Arena 50 WDG');
    expect(arena).toMatchObject({ cap: 2, minIntervalDays: 56, annualAmount: { cap: 0.294, unit: 'oz/1000sf/year', fallbackRate: 0.29 } });
    expect(arena.description).toContain('the low end of the label\'s turf range');
    expect(arena.effectiveCap).toBeUndefined();
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

describe('the migrations', () => {
  const blindsideCatalog = require('../models/migrations/20261009151000_lawn_v13_final_pass_blindside_catalog');
  test('20261009151000: audit actions fit the column, the figures match the recipe and the limit entry', () => {
    expect(blindsideCatalog.ACTION_CATALOG.length).toBeLessThanOrEqual(40);
    expect(blindsideCatalog.ACTION_CAP.length).toBeLessThanOrEqual(40);
    expect([blindsideCatalog.RATE, blindsideCatalog.UNIT, blindsideCatalog.OLD_CAP, blindsideCatalog.NEW_CAP]).toEqual([0.149, 'oz', 2, 1]);
    expect(blindsideCatalog.RATE).toBe(migration.BLINDSIDE_RATE);
    expect(blindsideCatalog.NEW_CAP).toBe(entry('Blindside Herbicide').effectiveCap);
  });

  test('its audit action fits the column (40 characters) and its names are the catalog\'s', () => {
    expect(migration.ACTION.length).toBeLessThanOrEqual(40);
    expect(migration.WEED_NAMES).toEqual([N.CEL, N.CER, N.NIS, 'Blindside Herbicide']);
    expect(migration.WINDOWS.NOV).toBe(staged.WINDOWS.find((w) => w[0] === 11)[1]);
    expect(migration.WINDOWS.DEC).toBe(staged.WINDOWS.find((w) => w[0] === 12)[1]);
  });
});
