// Lawn protocol v13: the optional fire ant add-on is Topchoice Granular Insecticide (migration 20261009100000, owner
// 2026-10-09), replacing Advion Fire Ant Bait. Topchoice is the catalog row that already exists. No database: the recipe
// text, what the migration writes to the row, the watering rule, and the files that name the product.
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const v13 = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261009100000_lawn_v13_fire_ant_granule');
const matrix = require('../models/migrations/20261007180000_lawn_v13_matrix_adds');
const { validateRule, resolveWateringRule } = require('../services/service-report/lawn-watering-rule');
const { approvedReportProductFacts } = require('../services/service-report/report-data');
const { PRODUCT_CLASS, normalizeProductName } = require('../config/lawn-expectations');

const { GRANULE } = migration;
const TRACKS = Object.keys(v13);
const lines = (text) => String(text || '').split('\n').filter(Boolean);
const addOnLines = (track, month) => lines(v13[track].visits.find((v) => v.month === month).secondary).filter((l) => l.startsWith(GRANULE));

// The catalog row as the seeds leave it (20260530000022 and the WaveGuard alias seeds), the fields this change reads.
const TOPCHOICE_ROW = {
  name: GRANULE, category: 'insecticide', product_type: 'pesticide', formulation: 'granular', active_ingredient: 'Fipronil 0.0143%', epa_reg_number: '432-1217',
  restricted_use: false, default_rate_per_1000: 2, rate_unit: 'lb', irrigation_required: true, post_application_watering: null, approved_for_service_report: true,
  reentry_summary: 'Follow the product label and technician service report before re-entering treated areas.',
  customer_precaution_summary: 'When this pesticide product is used, the technician follows the product label and service report instructions. People and pets should remain off treated areas until the application has dried, unless the label or technician instructions require a longer interval.',
  service_report_summary: 'Topchoice was used for fire ant management according to label directions, restricted-use requirements, and technician service notes.',
};

describe('the recipe: the fire ant granule in April and October of every track', () => {
  test('the old Advion text is gone from the recipe, and nothing else is named in its place', () => {
    expect(JSON.stringify(v13)).not.toMatch(/Advion|fire ant bait|Maxforce/i);
  });

  test.each(TRACKS)('%s: one secondary line in April and in October, none in any other month, never in a primary line', (track) => {
    for (const visit of v13[track].visits) {
      const found = addOnLines(track, visit.month);
      expect({ month: visit.month, count: found.length }).toEqual({ month: visit.month, count: ['Apr', 'Oct'].includes(visit.month) ? 1 : 0 });
      expect(lines(visit.primary).some((l) => l.startsWith(GRANULE))).toBe(false);
    }
  });

  test('the line carries every label and program fact the owner asked for, and nothing else', () => {
    const [line] = addOnLines('st_augustine', 'Apr');
    expect(line).toBe(addOnLines('st_augustine', 'Oct')[0]);
    for (const part of [
      'optional add-on, office prices it',
      '2 lb per 1,000 sq ft (87 lb per acre)',
      'with a spreader, as its own pass',
      "never blended with the month's granular",
      'the label says not to apply it in combination with other materials',
      'one application per lawn per year, so April or October, not both',
      'water in after application, within 24 hours',
      'not when rain is predicted in the next 24 hours',
      'not within 15 ft of fresh water or 60 ft of tidal water',
      'restricted use product, a certified applicator applies or supervises',
    ]) expect(line).toContain(part);
    expect(line.endsWith('on request only')).toBe(true);
    // No claim beyond fire ants (the label's one-year length of control is not a program claim).
    expect(line).not.toMatch(/flea|tick|nuisance|mole cricket|guarantee|control|year of/i);
  });

  test('the notes line names Topchoice, April or October, once a year, office priced, outside the base visit', () => {
    for (const track of TRACKS) {
      const notes = v13[track].notes.filter((n) => /Fire ant/.test(n));
      expect(notes).toEqual(['Fire ant granule (Topchoice Granular Insecticide) is an optional add-on in April or October, both spreader visits, one application per lawn per year. The office prices it. It is not part of the base visit.']);
    }
  });

  test('the 2 lb per 1,000 sq ft rate is the label\'s 87 lb per acre (87 / 43.56 = 1.997), one application is 2 lb a year', () => {
    expect(Math.round((87 / 43.56) * 100) / 100).toBe(2);
    expect(migration.ROW.rate).toBe(2);
    const write = (column) => migration.WRITES.find((w) => w.column === column);
    expect(write('max_label_rate_per_1000').after).toBe(2);
    expect(write('max_annual_per_1000').after).toBe(2);
    expect(migration.LIMIT).toMatchObject({ limit_type: 'annual_max_apps', limit_value: 1, severity: 'hard_block', match_type: 'product' });
  });
});

describe('what the migration writes to the existing Topchoice row', () => {
  test('only label facts: restricted use, the 2 lb maximum, a label note, a watering rule where none is stored', () => {
    expect(migration.WRITES.map((w) => [w.column, w.mode])).toEqual([
      ['restricted_use', 'set'], ['max_label_rate_per_1000', 'fill'], ['max_annual_per_1000', 'fill'], ['label_source_note', 'append'], ['post_application_watering', 'fill'],
    ]);
    // Never the approval, the copy, the price or the re-entry text.
    const written = migration.WRITES.map((w) => w.column);
    for (const column of ['approved_for_service_report', 'approved_for_public_page', 'approved_for_estimate_packet', 'public_summary', 'service_report_summary',
      'customer_precaution_summary', 'customer_safety_summary', 'reentry_summary', 'reentry_text', 'rei_hours', 'best_price', 'cost_per_unit', 'needs_pricing',
      'default_rate_per_1000', 'epa_reg_number', 'name']) expect(written).not.toContain(column);
  });

  test('the label note names the label, its acceptance date and the sod-farm-only 24 hours, and the sentence is appended', () => {
    expect(migration.LABEL).toBe('Topchoice label, EPA Reg. No. 432-1217, accepted 2018-03-20');
    expect(migration.EPA).toBe('432-1217');
    expect(migration.LABEL_NOTE.startsWith(migration.LABEL)).toBe(true);
    expect(migration.LABEL_NOTE).toMatch(/restricted-entry interval is in the sod farm \(WPS\) box only; the lawn directions state none\.$/);
    expect(migration.LABEL_NOTE).not.toMatch(/Maxforce/);
  });

  test('the staged row is the shape the Advion row had: optional, never in the plan by default, office priced', () => {
    expect(migration.ROW).toEqual({
      role: 'insecticide_optional_addon', mode: 'broadcast', rate: 2, unit: 'lb', carrier: null, defaultInPlan: false,
      gates: { trigger: 'fire_ants_optional_add_on', optionalAddOn: true, officePrices: true },
    });
    const advion = matrix.INSERTS.find((spec) => spec.name === matrix.ADVION);
    expect({ role: advion.role, mode: advion.mode, carrier: advion.carrier, defaultInPlan: advion.defaultInPlan, gates: advion.gates })
      .toEqual({ role: migration.ROW.role, mode: migration.ROW.mode, carrier: migration.ROW.carrier, defaultInPlan: migration.ROW.defaultInPlan, gates: migration.ROW.gates });
    expect(migration.WINDOW_KEYS).toEqual([matrix.WINDOWS.APR, matrix.WINDOWS.OCT]);
  });
});

describe('watering and the customer report', () => {
  test('the rule written where none is stored is a valid water-in at the default the row already derived, sourced to the label sentence', () => {
    const checked = validateRule(migration.WATERING_RULE);
    expect(checked.errors).toEqual([]);
    expect(checked.rule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' });
    expect(checked.rule.water_in_same_day).toBeUndefined();
    expect(checked.rule.label_note).toMatch(/"For best results, water or irrigate treated turf after application"/);
    expect(checked.rule.label_note).toMatch(/program default, not label text/);
    // Same instruction as today: with no stored rule the row's irrigation_required flag derives the same water-in.
    const derived = resolveWateringRule(TOPCHOICE_ROW);
    expect({ mode: derived.mode, inches: derived.water_in_inches, by: derived.water_in_by_hours }).toEqual({ mode: 'water_in', inches: 0.25, by: 24 });
    expect(resolveWateringRule({ ...TOPCHOICE_ROW, post_application_watering: migration.WATERING_RULE })).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24 });
  });

  test('the row stays approved for the report with its own copy; the freeze carries the precaution and re-entry text it has today', () => {
    const facts = approvedReportProductFacts({ ...TOPCHOICE_ROW, restricted_use: true, post_application_watering: migration.WATERING_RULE });
    expect(facts).toMatchObject({
      productType: 'pesticide', epaRegNumber: '432-1217', reentrySummary: TOPCHOICE_ROW.reentry_summary, precautionSummary: TOPCHOICE_ROW.customer_precaution_summary,
      reentryHours: null,
    });
    expect(facts.wateringRule).toMatchObject({ mode: 'water_in', source: 'label' });
  });
});

describe('the other files that name the product', () => {
  test('lawn-expectations: no owner-approved result timing for Topchoice; the Advion entry stays for the catalog row', () => {
    for (const name of [GRANULE, matrix.ADVION]) {
      expect(PRODUCT_CLASS.has(normalizeProductName(name))).toBe(true);
      expect(PRODUCT_CLASS.get(normalizeProductName(name))).toBeNull();
    }
    const source = fs.readFileSync(path.join(__dirname, '../config/lawn-expectations.js'), 'utf8');
    expect(source).toContain("['Topchoice Granular Insecticide', null]");
    expect(source).toContain("['Advion Fire Ant Bait', null]");
  });

  test('pricing.csv: the Advion line is gone and Topchoice keeps its one existing line (no second line)', () => {
    const rows = parse(fs.readFileSync(path.join(__dirname, '../data/pricing.csv'), 'utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true });
    expect(rows.filter((row) => /Advion Fire Ant/.test(row.Product))).toEqual([]);
    const hits = rows.filter((row) => row.Product === GRANULE);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ Vendor: 'SiteOne', Size: '50 lb', Category: 'Insecticide', 'Category Section': 'Lawn Care' });
  });

  test('the inventory readiness list for the v13 recipe names Topchoice, not Advion', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-inventory.js'), 'utf8');
    expect(source).toContain("['v13_fire_ant_granule', 'Topchoice Granular Insecticide', 'pesticide', 'insecticide granule']");
    expect(source).not.toContain('v13_advion_fire_ant');
  });
});

describe('the gate-off recipe (protocols.json) carries the same Topchoice label rules', () => {
  const legacy = require('../config/protocols.json');
  const lawnTexts = () => {
    const found = [];
    const walk = (value, where) => {
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${where}[${index}]`));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => walk(item, `${where}/${key}`));
      else if (typeof value === 'string' && /Topchoice/.test(value)) found.push({ where, text: value });
    };
    walk(legacy.lawn, 'lawn');
    return found;
  };

  test('every Topchoice line of the legacy program (the bahia note, April and October secondary and notes) states the label rules', () => {
    const texts = lawnTexts();
    expect(texts.map((entry) => entry.where)).toEqual([
      'lawn/bahia/notes[8]', 'lawn/bahia/visits[3]/secondary', 'lawn/bahia/visits[3]/notes', 'lawn/bahia/visits[9]/secondary', 'lawn/bahia/visits[9]/notes',
    ]);
    for (const { where, text } of texts) {
      for (const part of [
        'its own pass, not blended with the visit\'s other products (the label says not to apply it in combination with other materials)',
        'one application per lawn per year',
        'water in after application, within 24 hours',
        'not within 15 ft of fresh water or 60 ft of tidal water',
        'restricted use product, a certified applicator applies or supervises',
      ]) expect({ where, has: text.includes(part) }).toEqual({ where, has: true });
    }
  });

  test('no efficacy claim beyond the label: "prevents callbacks" and "12-month control" are gone; the one-year figure is the label\'s', () => {
    const joined = lawnTexts().map((entry) => entry.text).join('\n');
    expect(joined).not.toMatch(/prevents callb|12-month|provides/i);
    expect(joined).toContain('The label lists about 1 year of fire ant control');
    // No rate is introduced: the legacy lines stated none.
    expect(joined).not.toMatch(/\d\s*lb per/);
  });

  test('the v13 recipe, the legacy recipe and the migration agree on the watering window and the buffers', () => {
    for (const text of [...lawnTexts().map((entry) => entry.text), addOnLines('st_augustine', 'Apr')[0]]) {
      expect(text).toMatch(/water in after application, within 24 hours/);
      expect(text).toMatch(/not within 15 ft of fresh water or 60 ft of tidal water/);
    }
  });
});
