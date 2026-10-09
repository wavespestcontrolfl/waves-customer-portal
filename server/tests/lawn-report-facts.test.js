// GATE_LAWN_REPORT_FACTS: the lawn report's re-entry condition, spot-product text and finding-to-product
// ties are DECIDED at completion (lawn-report-facts.js) and read from the record. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const facts = require('../services/service-report/lawn-report-facts');

const rule = (mode, extra = {}) => ({ mode, source: 'label', ...extra });
// An approved product's frozen facts: the plain residential label ("until dry") plus its watering rule.
const UNTIL_DRY = 'Keep people and pets off treated areas until dry.';
const approved = (wateringRule, extra = {}) => ({ wateringRule, reentryHours: 0, reentrySummary: UNTIL_DRY, ...extra });
const row = (id, method, product = {}) => ({
  id,
  product_id: product.productId === undefined ? `pid-${id}` : product.productId,
  product_name: product.name || `Product ${id}`,
  product_category: product.category || '',
  application_method: method,
  area_value: product.areaValue ?? null,
  area_unit: product.areaUnit ?? null,
  approved_report_product_facts: product.facts === undefined ? approved(rule('none')) : product.facts,
});

const SPRAY = row('p-spray', 'broadcast_spray', { category: 'herbicide', facts: approved(rule('hold', { hold_hours: 24 })) });
const GRANULE = row('p-granule', 'granular_broadcast', { category: 'fertilizer', facts: approved(rule('water_in', { water_in_inches: 0.25 })) });
const SPOT_HERBICIDE = row('p-spot', 'spot_treatment', { category: 'herbicide', areaValue: 250, areaUnit: 'sqft' });
const FUNGICIDE = row('p-fung', 'spot_treatment', { category: 'fungicide', areaValue: 500, areaUnit: 'sqft' });

describe('one product\'s re-entry rule', () => {
  test('a spray, a spot spray and a bait are dry', () => {
    for (const method of ['broadcast_spray', 'spot_treatment', 'foliar_spray', 'soil_drench', 'bait_placement']) {
      expect(facts.productReentry(row('x', method))).toEqual({ id: 'x', rule: 'dry', source: 'facts' });
    }
  });

  test('a frozen water-in rule is watered_in_and_dry, even on a spray', () => {
    expect(facts.productReentry(GRANULE)).toEqual({ id: 'p-granule', rule: 'watered_in_and_dry', source: 'facts' });
    expect(facts.productReentry(row('y', 'broadcast_spray', { facts: approved(rule('water_in')) })).rule).toBe('watered_in_and_dry');
  });

  test('a granule that is NOT watered in (its rule is hold or none) is dry', () => {
    expect(facts.productReentry(row('g', 'granular_broadcast', { facts: approved(rule('none')) })).rule).toBe('dry');
    expect(facts.productReentry(row('g', 'granular_broadcast', { facts: approved(rule('hold', { hold_hours: 24 })) })).rule).toBe('dry');
  });

  test('no usable fact fails closed to the default and is marked: a granule with no frozen rule, no method, no facts', () => {
    const marked = { rule: null, source: 'default' };
    expect(facts.productReentry(row('a', 'granular_broadcast', { facts: approved(null) }))).toMatchObject(marked);
    expect(facts.productReentry(row('b', 'granular_broadcast', { facts: null }))).toMatchObject(marked);
    expect(facts.productReentry(row('c', '', { facts: approved(rule('none')) }))).toMatchObject(marked);
    expect(facts.productReentry(row('d', null, { facts: null }))).toMatchObject(marked);
  });

  describe('never weaker than the label floor the report shows today (Codex: the method alone is not a fact)', () => {
    const marked = { rule: null, source: 'default' };

    test('a product with NO approved frozen facts is default, whatever its method (spray, spot, bait, granule)', () => {
      for (const method of ['broadcast_spray', 'spot_treatment', 'foliar_spray', 'bait_placement', 'granular_broadcast']) {
        expect(facts.productReentry(row('u', method, { facts: null }))).toMatchObject(marked);
      }
    });

    test('an approved spray with frozen facts is dry; a frozen water-in rule is watered_in_and_dry; a granule with a hold or none rule is dry', () => {
      expect(facts.productReentry(row('s', 'broadcast_spray', { facts: approved(rule('none')) }))).toEqual({ id: 's', rule: 'dry', source: 'facts' });
      expect(facts.productReentry(row('s', 'spot_treatment', { facts: approved(null) }))).toEqual({ id: 's', rule: 'dry', source: 'facts' });
      expect(facts.productReentry(row('w', 'granular_broadcast', { facts: approved(rule('water_in')) })).rule).toBe('watered_in_and_dry');
      expect(facts.productReentry(row('g', 'granular_broadcast', { facts: approved(rule('hold', { hold_hours: 24 })) })).rule).toBe('dry');
    });

    test('a granule with approved facts but NO frozen watering rule is default (we cannot tell whether it is watered in)', () => {
      expect(facts.productReentry(row('g', 'granular_broadcast', { facts: approved(null) }))).toMatchObject(marked);
      expect(facts.productReentry(row('g', 'granular_broadcast', { facts: approved({ mode: 'sideways' }) }))).toMatchObject(marked);
    });

    test('a label that is not plainly "until dry" is default: a stored hours figure, a text that states hours, an unreadable text, no text', () => {
      const withLabel = (reentryHours, reentrySummary) => row('t', 'broadcast_spray', { facts: approved(rule('none'), { reentryHours, reentrySummary }) });
      expect(facts.productReentry(withLabel(12, 'Keep people and pets off treated areas for 12 hours.'))).toMatchObject(marked);
      expect(facts.productReentry(withLabel(12, undefined))).toMatchObject(marked);
      expect(facts.productReentry(withLabel(12, UNTIL_DRY))).toMatchObject(marked);
      expect(facts.productReentry(withLabel(0, 'Keep people and pets off treated areas for 12 hours.'))).toMatchObject(marked);
      expect(facts.productReentry(withLabel(0, 'Wait a day.'))).toMatchObject(marked);
      expect(facts.productReentry(withLabel(0, undefined))).toMatchObject(marked);
      expect(facts.productReentry(withLabel(null, undefined))).toMatchObject(marked);
    });

    test('a plain until-dry label (0 or null figure) is usable', () => {
      expect(facts.productReentry(row('t', 'broadcast_spray', { facts: approved(rule('none'), { reentryHours: 0 }) })).rule).toBe('dry');
      expect(facts.productReentry(row('t', 'broadcast_spray', { facts: approved(rule('none'), { reentryHours: null }) })).rule).toBe('dry');
    });

    test('there is no timed rule: a product that carries label hours defaults and writes no hours', () => {
      const out = facts.productReentry(row('t', 'broadcast_spray', { facts: approved(rule('none'), { reentryHours: 12, reentrySummary: 'Keep people and pets off treated areas for 12 hours.' }) }));
      expect(out).toEqual({ id: 't', rule: null, source: 'default' });
      expect(facts._test.labelIsPlainUntilDry({ reentryHours: 12, reentrySummary: UNTIL_DRY })).toBe(false);
    });
  });
});

// Pinned against the production catalog (read-only, 2026-10-08): the 21 products the live v13 program uses, by
// coalesce(reentry_summary, reentry_text) and rei_hours. The rule is NOT loosened to make more rows qualify:
// missing or unreadable text is a catalog data gap the owner fills separately.
describe('the label floor on the real catalog strings', () => {
  const { parseReentryText } = require('../services/sms-label-facts');
  const STAY_OFF = 'Stay off treated areas until the application has dried.';
  const WATER_IN = 'Water in per the visit notes; no re-entry wait once dry.';
  const FOLLOW_LABEL = 'Follow the product label and technician service report before re-entering treated areas.';
  const FOLLOW_REPORT = 'Follow the technician service report for any product-specific instructions.';

  // [products, text, rei_hours values seen, qualifies as a plain until-dry label, parser's reading]
  const STRINGS = [
    ['Acelepryn, Artavia, Talak, Blindside, Celsius, Certainty, Dimension 2EW, Headway, Stonewall 4FL, Tetrino, Velista', STAY_OFF, [null, 0], true, 'until_dry'],
    ['LESCO 24-0-11 with PolyPlus OPTI', WATER_IN, [null], false, 'unreadable (null)'],
    ['Arena 50 WDG', FOLLOW_LABEL, [null], false, 'none'],
    ['Dispatch Sprayable', FOLLOW_REPORT, [null], false, 'unreadable (null)'],
    ['Advion Fire Ant Bait, Dylox 6.2 G, Gravex 20 EW, LESCO 10-0-22, LESCO 90/10 Nonionic Surfactant, LESCO Dimension 0.21% 18-0-10, LESCO Nutra-TECH', undefined, [null, 0], false, 'no text'],
  ];

  test.each(STRINGS)('%s -> label plain until-dry: %s', (_products, text, reiValues, qualifies, reading) => {
    const read = text ? parseReentryText(text) : null;
    expect(read ? read.kind : (reading === 'no text' ? 'no text' : 'unreadable (null)')).toBe(reading);
    for (const reentryHours of reiValues) {
      expect(facts._test.labelIsPlainUntilDry({ reentryHours, reentrySummary: text })).toBe(qualifies);
    }
  });

  describe('the full per-product rule (approved facts, so only the label decides)', () => {
    const ruleOf = (text, method, wateringRule, reentryHours = null) => facts.productReentry(row('p', method, {
      facts: { wateringRule, reentryHours, reentrySummary: text },
    }));

    test('the "Stay off ... until the application has dried" group: a spray or spot spray is dry; with a frozen water-in rule it is watered_in_and_dry', () => {
      for (const reentryHours of [null, 0]) {
        expect(ruleOf(STAY_OFF, 'broadcast_spray', rule('none'), reentryHours)).toEqual({ id: 'p', rule: 'dry', source: 'facts' });
        expect(ruleOf(STAY_OFF, 'spot_treatment', null, reentryHours).rule).toBe('dry');
        expect(ruleOf(STAY_OFF, 'broadcast_spray', rule('water_in'), reentryHours).rule).toBe('watered_in_and_dry');
      }
    });

    test('LESCO 24-0-11: the parser does NOT read "no re-entry wait once dry" as until-dry, so even with a frozen water-in rule the product defaults', () => {
      expect(parseReentryText(WATER_IN)).toBeNull();
      expect(ruleOf(WATER_IN, 'granular_broadcast', rule('water_in'))).toEqual({ id: 'p', rule: null, source: 'default' });
    });

    test('the two "Follow the ..." sentences default, for every method and rule', () => {
      for (const text of [FOLLOW_LABEL, FOLLOW_REPORT]) {
        for (const [method, wateringRule] of [['broadcast_spray', rule('none')], ['spot_treatment', null], ['granular_broadcast', rule('water_in')]]) {
          expect(ruleOf(text, method, wateringRule)).toEqual({ id: 'p', rule: null, source: 'default' });
        }
      }
    });

    test('rows with no text at all default, whatever the figure (null or the 0 sentinel), method or rule', () => {
      for (const reentryHours of [null, 0]) {
        for (const [method, wateringRule] of [['broadcast_spray', rule('none')], ['granular_broadcast', rule('water_in')], ['bait_placement', null]]) {
          expect(ruleOf(undefined, method, wateringRule, reentryHours)).toEqual({ id: 'p', rule: null, source: 'default' });
        }
      }
    });

    test('a visit mixing the until-dry group with one unreadable row defaults as a whole', () => {
      const ok = row('ok', 'broadcast_spray', { facts: { wateringRule: rule('none'), reentryHours: null, reentrySummary: STAY_OFF } });
      const gap = row('gap', 'granular_broadcast', { facts: { wateringRule: rule('water_in'), reentryHours: null, reentrySummary: undefined } });
      expect(facts.visitReentry([ok])).toMatchObject({ rule: 'dry', source: 'facts' });
      expect(facts.visitReentry([ok, gap])).toMatchObject({ rule: 'default', source: 'default' });
    });
  });
});

// The same catalog AFTER the owner fills the missing re-entry text from the labels (2026-10-08): sentence A for
// sprays, sentence B for the granules the program waters in. Pinned so the behavior on the future data is visible.
describe('the label floor on the catalog strings as they will read after the owner\'s fill', () => {
  const A = 'Stay off treated areas until the application has dried.';
  const B = 'Stay off treated areas until the product has been watered in and the turf is dry.';
  const shape = (text, reentryHours = null) => ({
    untilDry: facts._test.labelIsPlainUntilDry({ reentryHours, reentrySummary: text }),
    wateredIn: facts._test.labelIsPlainUntilWateredInAndDry({ reentryHours, reentrySummary: text }),
  });
  const ruleOf = (text, method, wateringRule, reentryHours = null) => facts.productReentry(row('p', method, {
    facts: { wateringRule, reentryHours, reentrySummary: text },
  }));
  const DEFAULT = { id: 'p', rule: null, source: 'default' };

  // [products, text, method, shape A?, shape B?]
  test.each([
    ['Arena 50 WDG', A, 'spot_treatment'],
    ['Gravex 20 EW', A, 'broadcast_spray'],
    ['Dispatch Sprayable', A, 'broadcast_spray'],
    ['LESCO 90/10 Nonionic Surfactant', A, 'broadcast_spray'],
    ['LESCO Nutra-TECH', A, 'broadcast_spray'],
  ])('sentence A on %s: until-dry, not watered-in; a spray is dry (water-in rule: watered_in_and_dry)', (_name, text, method) => {
    expect(shape(text)).toEqual({ untilDry: true, wateredIn: false });
    expect(ruleOf(text, method, rule('none'))).toEqual({ id: 'p', rule: 'dry', source: 'facts' });
    expect(ruleOf(text, method, rule('water_in')).rule).toBe('watered_in_and_dry');
  });

  test.each([
    ['LESCO Dimension 0.21% 18-0-10'],
    ['Dylox 6.2 G'],
    ['LESCO 10-0-22'],
    ['LESCO 24-0-11'],
  ])('sentence B on %s: watered_in_and_dry only with a frozen water-in rule; hold, none or missing default', (_name) => {
    expect(shape(B)).toEqual({ untilDry: false, wateredIn: true });
    expect(ruleOf(B, 'granular_broadcast', rule('water_in'))).toEqual({ id: 'p', rule: 'watered_in_and_dry', source: 'facts' });
    for (const wateringRule of [rule('hold', { hold_hours: 24 }), rule('none'), null, { mode: 'sideways' }]) {
      expect(ruleOf(B, 'granular_broadcast', wateringRule)).toEqual(DEFAULT);
    }
  });

  test('a spray whose text is the watered-in shape is watered_in_and_dry only with a frozen water-in rule, else default', () => {
    expect(ruleOf(B, 'broadcast_spray', rule('water_in')).rule).toBe('watered_in_and_dry');
    expect(ruleOf(B, 'broadcast_spray', rule('none'))).toEqual(DEFAULT);
    expect(ruleOf(B, 'spot_treatment', null)).toEqual(DEFAULT);
  });

  test('sentence B variants the shape accepts: the product / application / treatment / granules, turf / grass / lawn / surface, "is dry" or "has dried", the keep-off lead, a missing full stop', () => {
    for (const text of [
      'Stay off treated areas until the granules have been watered in and the grass has dried.',
      'Stay off treated areas until the application has been watered in and the lawn is dry.',
      'Keep people and pets off treated areas until the product has been watered in and the surface is dry.',
      'stay off treated areas until the treatment has been watered in and the turf is dry',
    ]) {
      expect(shape(text).wateredIn).toBe(true);
    }
  });

  test.each([
    ['dust', 'Keep people and pets off treated areas until dust has settled.'],
    ['the 24-0-11 text today', 'Water in per the visit notes; no re-entry wait once dry.'],
    ['a watered-in sentence that states hours', 'Stay off treated areas until the product has been watered in and the turf is dry for 24 hours.'],
    ['a watered-in sentence with a digit', 'Stay off treated areas until the product has been watered in and the turf is dry, about 2 h.'],
    ['a watered-in sentence with a time word', 'Stay off treated areas until the product has been watered in and the turf is dry, usually overnight.'],
    ['a watered-in sentence with no dryness', 'Stay off treated areas until the product has been watered in.'],
    ['another subject', 'Stay off treated areas until the dog has been watered in and the turf is dry.'],
    ['an extra clause after it', 'Stay off treated areas until the product has been watered in and the turf is dry. Call us with questions.'],
    ['a different lead', 'Follow the product label until the product has been watered in and the turf is dry.'],
    ['the follow-the-label sentence', 'Follow the product label and technician service report before re-entering treated areas.'],
  ])('near miss (%s) never qualifies as watered-in', (_label, text) => {
    expect(shape(text).wateredIn).toBe(false);
    expect(ruleOf(text, 'granular_broadcast', rule('water_in'))).toEqual(DEFAULT);
  });

  test('"until the turf is dry" is not the watered-in shape (the shared parser reads it as plain until-dry, so the A rules apply)', () => {
    const text = 'Stay off treated areas until the turf is dry.';
    expect(shape(text).wateredIn).toBe(false);
    expect(ruleOf(text, 'granular_broadcast', rule('none')).rule).toBe(shape(text).untilDry ? 'dry' : null);
  });

  test('a stored positive rei_hours disqualifies both shapes, even beside the right sentence', () => {
    expect(shape(B, 12)).toEqual({ untilDry: false, wateredIn: false });
    expect(shape(A, 12)).toEqual({ untilDry: false, wateredIn: false });
    expect(ruleOf(B, 'granular_broadcast', rule('water_in'), 12)).toEqual(DEFAULT);
  });

  test('a stored 0 figure is fine for both shapes', () => {
    expect(shape(B, 0).wateredIn).toBe(true);
    expect(ruleOf(B, 'granular_broadcast', rule('water_in'), 0).rule).toBe('watered_in_and_dry');
  });

  test('a visit of the four granules (sentence B, water-in rules) beside sprays (sentence A) is watered_in_and_dry; one granule missing its water-in rule defaults the visit', () => {
    const granule = (id, wateringRule) => row(id, 'granular_broadcast', { facts: { wateringRule, reentryHours: null, reentrySummary: B } });
    const spray = row('sp', 'broadcast_spray', { facts: { wateringRule: rule('none'), reentryHours: null, reentrySummary: A } });
    const granules = ['g1', 'g2', 'g3', 'g4'].map((id) => granule(id, rule('water_in')));
    expect(facts.visitReentry([...granules, spray])).toMatchObject({ rule: 'watered_in_and_dry', source: 'facts' });
    expect(facts.visitReentry([...granules.slice(0, 3), granule('g4', rule('none')), spray])).toMatchObject({ rule: 'default' });
  });
});

describe('the visit\'s rule is the strictest of its products', () => {
  test('spray only -> dry', () => {
    expect(facts.visitReentry([SPRAY, SPOT_HERBICIDE])).toMatchObject({ rule: 'dry', source: 'facts' });
  });

  test('granular only -> watered_in_and_dry', () => {
    expect(facts.visitReentry([GRANULE])).toMatchObject({ rule: 'watered_in_and_dry', source: 'facts' });
  });

  test('mixed spray and granule -> watered_in_and_dry', () => {
    expect(facts.visitReentry([SPRAY, GRANULE])).toMatchObject({ rule: 'watered_in_and_dry' });
  });

  test('a granular bait or a granule that is not watered in beside a spray stays dry', () => {
    const bait = row('bait', 'bait_placement');
    expect(facts.visitReentry([SPRAY, bait])).toMatchObject({ rule: 'dry' });
  });

  test('label hours default the whole visit: 4 h + 12 h products, alone or beside a spray or granule', () => {
    const hours = (id, h) => row(id, 'broadcast_spray', { facts: approved(rule('none'), { reentryHours: h, reentrySummary: `Keep people and pets off treated areas for ${h} hours.` }) });
    for (const rows of [[hours('t1', 4), hours('t2', 12), GRANULE], [hours('t1', 4), SPRAY], [hours('t2', 12)]]) {
      const visit = facts.visitReentry(rows);
      expect(visit).toMatchObject({ rule: 'default', source: 'default' });
      expect(visit).not.toHaveProperty('hours');
      expect(visit).not.toHaveProperty('base');
    }
  });

  test('an unapproved product beside an approved spray defaults the visit', () => {
    expect(facts.visitReentry([SPRAY, row('u', 'broadcast_spray', { facts: null })])).toMatchObject({ rule: 'default' });
  });

  test('one product with no usable fact marks the whole visit default (today\'s clock), and the record names it', () => {
    const unknown = row('u', 'granular_broadcast', { facts: null });
    const visit = facts.visitReentry([SPRAY, unknown]);
    expect(visit).toMatchObject({ rule: 'default', source: 'default' });
    expect(visit.products.find((p) => p.id === 'u')).toEqual({ id: 'u', rule: null, source: 'default' });
    expect(visit.products.find((p) => p.id === 'p-spray')).toMatchObject({ rule: 'dry', source: 'facts' });
  });

  test('no product rows -> nothing to decide', () => {
    expect(facts.visitReentry([])).toBeNull();
    expect(facts.visitReentry(undefined)).toBeNull();
  });
});

describe('the customer wording is fixed and chosen by code', () => {
  const dry = { rule: 'dry', source: 'facts', products: [{ id: 'a', rule: 'dry', source: 'facts' }] };
  const wet = { rule: 'watered_in_and_dry', source: 'facts', products: [{ id: 'a', rule: 'watered_in_and_dry', source: 'facts' }] };

  test('spray only', () => {
    expect(facts.reentryCondition(dry)).toEqual({
      rule: 'dry',
      text: 'Ready to walk on once the application has dried — your technician confirms timing.',
      pets: 'Keep people and pets off the lawn until then.',
      statusLabel: 'Once dry',
    });
  });

  test('granular or mixed', () => {
    expect(facts.reentryCondition(wet)).toEqual({
      rule: 'watered_in_and_dry',
      text: 'Ready to walk on once today’s treatment has dried and, after you water it in, the grass is dry again — your technician confirms timing.',
      pets: 'Keep people and pets off the lawn until then.',
      statusLabel: 'After watering in',
    });
  });

  test('both rules carry the approved technician-confirmation clause, once, word for word (AGENTS.md re-entry idiom), and no "safe"', () => {
    const { REENTRY_SAFE_COPY } = require('../services/social-media');
    // The reused clause is the tail of the approved idiom the printed record already uses.
    expect(REENTRY_SAFE_COPY).toBe('Ready once dry — your technician confirms timing.');
    for (const r of [dry, wet]) {
      const c = facts.reentryCondition(r);
      expect(c.text.endsWith(' — your technician confirms timing.')).toBe(true);
      expect(c.text.split('your technician confirms timing')).toHaveLength(2);
      expect(`${c.text} ${c.pets}`).not.toMatch(/\bsafe/i);
    }
  });

  test('the sentences pass the customer-copy screen and the printed-record timing strip unchanged', () => {
    const { stripFixedReentryTiming, REENTRY_SAFE_COPY } = require('../services/social-media');
    const { customerCopyViolations } = require('../services/service-report/technician-report-copy');
    for (const r of [dry, wet]) {
      const c = facts.reentryCondition(r);
      for (const line of [c.text, c.pets]) {
        expect(customerCopyViolations(line)).toEqual([]);
        expect(stripFixedReentryTiming(line, REENTRY_SAFE_COPY).text).toBe(line);
      }
    }
  });

  test('no clock time and no countdown in a condition', () => {
    for (const r of [dry, wet]) {
      const c = facts.reentryCondition(r);
      expect(`${c.text} ${c.pets}`).not.toMatch(/\d|\bmin(ute)?s?\b|\bsec(ond)?s?\b|\bPM\b|\bAM\b/);
    }
  });

  test('the marked default, and an unknown rule, have no condition', () => {
    expect(facts.reentryCondition({ rule: 'default', source: 'default', products: [] })).toBeNull();
    expect(facts.reentryCondition({ rule: 'mystery' })).toBeNull();
    expect(facts.reentryCondition({ rule: 'timed', hours: 12, base: 'dry' })).toBeNull();
    expect(facts.reentryCondition(null)).toBeNull();
  });
});

describe('a spot product says where it was used', () => {
  const RECORDED = new Set(['pid-p-spot', 'pid-p-fung']);

  test('only spot rows are described; whole-lawn rows are not; an area is stated only for a row the technician recorded one for', () => {
    expect(facts.productUseEntries([SPRAY, GRANULE, SPOT_HERBICIDE, FUNGICIDE], RECORDED)).toEqual({
      'p-spot': { sqft: 250 },
      'p-fung': { sqft: 500 },
    });
  });

  test('a spot row sized by a typed amount (its areaValue is the planned / whole-lawn fallback) is NOT stated as an area', () => {
    const fallback = row('p-typed', 'spot_treatment', { category: 'herbicide', areaValue: 5000, areaUnit: 'sqft' });
    expect(facts.productUseEntries([fallback], RECORDED)).toEqual({ 'p-typed': { sqft: null } });
    expect(facts.productUseEntries([fallback])).toEqual({ 'p-typed': { sqft: null } });
    expect(facts.productUseText(facts.productUseEntries([fallback], RECORDED)['p-typed'])).toBe('Spot treatment');
    // Recorded for one row only: the other spot row stays plain.
    expect(facts.productUseEntries([SPOT_HERBICIDE, fallback], new Set(['pid-p-spot']))).toEqual({ 'p-spot': { sqft: 250 }, 'p-typed': { sqft: null } });
  });

  describe('spotAreaFreeze: the completion record of which rows had a recorded spot area', () => {
    const U1 = '00000000-0000-4000-8000-0000000000a1';
    afterEach(() => { delete process.env.GATE_LAWN_REPORT_FACTS; });

    test('gate off: nothing is written (the record is exactly what it was)', () => {
      expect(facts.spotAreaFreeze({ spotAreas: { v: 1, productIds: [U1] } })).toEqual({});
    });

    test('gate on: version 1, uuids only, lower-cased, each once, bounded', () => {
      process.env.GATE_LAWN_REPORT_FACTS = 'true';
      expect(facts.spotAreaFreeze({ spotAreas: { v: 1, productIds: [U1.toUpperCase(), U1, 'nope', 7] } })).toEqual({ lawnSpotAreaRecorded: { v: 1, productIds: [U1] } });
      const many = Array.from({ length: 80 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      expect(facts.spotAreaFreeze({ spotAreas: { v: 1, productIds: many } }).lawnSpotAreaRecorded.productIds).toHaveLength(50);
    });

    test('gate on: no block, a wrong version or a malformed block write nothing', () => {
      process.env.GATE_LAWN_REPORT_FACTS = 'true';
      for (const bad of [undefined, null, { visitType: 'recurring' }, { spotAreas: { v: 2, productIds: [U1] } }, { spotAreas: [U1] }, { spotAreas: { v: 1, productIds: 'x' } }]) {
        expect(facts.spotAreaFreeze(bad)).toEqual({});
      }
    });
  });

  test('a recorded area reads "about N sq ft", a spot with no area reads "Spot treatment"', () => {
    expect(facts.productUseText({ sqft: 250 })).toBe('Spot treatment, about 250 sq ft');
    expect(facts.productUseText({ sqft: 500 })).toBe('Spot treatment, about 500 sq ft');
    expect(facts.productUseText({ sqft: null })).toBe('Spot treatment');
  });

  test('a spot row without a usable area is recorded without one (zero, negative, other unit, text)', () => {
    const entries = facts.productUseEntries([
      row('z', 'spot_treatment', { areaValue: 0, areaUnit: 'sqft' }),
      row('n', 'spot_treatment', { areaValue: -5, areaUnit: 'sqft' }),
      row('l', 'spot_treatment', { areaValue: 40, areaUnit: 'linear_ft' }),
      row('t', 'spot_treatment', { areaValue: 'abc', areaUnit: 'sqft' }),
    ]);
    expect(Object.values(entries)).toEqual([{ sqft: null }, { sqft: null }, { sqft: null }, { sqft: null }]);
  });

  test('the number is rounded sensibly: 5s under 100, 10s under 1,000, 50s above, thousands separated', () => {
    expect(facts._test.roundedSqft(37)).toBe(35);
    expect(facts._test.roundedSqft(2)).toBe(5);
    expect(facts._test.roundedSqft(237)).toBe(240);
    expect(facts._test.roundedSqft(1234)).toBe(1250);
    expect(facts.productUseText({ sqft: 1234 })).toBe('Spot treatment, about 1,250 sq ft');
  });

  test('a stored entry is shape-checked at read time', () => {
    const notes = { lawnReportFacts: { v: 1, productUse: { good: { sqft: 250 }, bad: 'x', worse: { sqft: -3 } } } };
    expect(facts.frozenProductUseTexts(notes)).toEqual({ good: 'Spot treatment, about 250 sq ft', worse: 'Spot treatment' });
  });
});

describe('ties: a finding and what was applied', () => {
  const ASSESSMENT = { id: 'as-1', customer_id: 'c-1', confirmed_by_tech: true };
  const run = (...findings) => ({
    assessment_id: 'as-1', customer_id: 'c-1', reviewed_at: '2026-10-08T15:00:00Z',
    reviewed_findings: findings.map((f, i) => ({ finding_id: `f${i}`, keep: true, confidence: 'high', severity: 'moderate', can_determine: true, ...f })),
  });
  const ties = (findings, rows, techFindings = []) => facts.buildTies({ rows, run: run(...findings), assessment: ASSESSMENT, techFindings });
  const FUNG_ANY = row('fg', 'broadcast_spray', { category: 'fungicide' });
  const INSECT_SPOT = row('is', 'spot_treatment', { category: 'insecticide' });
  const INSECT_BROADCAST = row('ib', 'broadcast_spray', { category: 'insecticide' });
  const WETTING = row('wa', 'broadcast_spray', { name: 'Dispatch Sprayable Wetting Agent', category: 'wetting agent' });

  test.each([
    ['gray leaf spot', 'fungus', 'fungicide', FUNG_ANY],
    ['large patch (fungal) activity', 'fungus', 'fungicide', FUNGICIDE],
    ['dollar spot', 'fungus', 'fungicide', FUNGICIDE],
    ['fungal activity', 'fungus', 'fungicide', FUNGICIDE],
    ['weed pressure', 'weeds', 'herbicide', SPOT_HERBICIDE],
    ['chinch bug activity', 'insects', 'insecticide', INSECT_SPOT],
    ['caterpillar activity', 'insects', 'insecticide', INSECT_SPOT],
    ['grub activity', 'insects', 'insecticide', INSECT_SPOT],
    ['drought stress', 'drought', 'wetting_agent', WETTING],
  ])('%s <-> its product: %s / %s', (label, kind, product, productRow) => {
    expect(ties([{ label }], [productRow])).toEqual([{ source: 'photo', kind, label, sure: true, product }]);
  });

  test('a finding with NO matching product is a finding with product null (never a treatment)', () => {
    expect(ties([{ label: 'gray leaf spot' }], [SPRAY])).toEqual([{ source: 'photo', kind: 'fungus', label: 'gray leaf spot', sure: true, product: null }]);
    expect(ties([{ label: 'chinch bug activity' }], [INSECT_BROADCAST])[0].product).toBeNull();
    expect(ties([{ label: 'weed pressure' }], [row('h', 'broadcast_spray', { category: 'herbicide' })])[0].product).toBeNull();
  });

  test('a weed or insect finding is answered by a SPOT row only; a fungicide by any row', () => {
    expect(ties([{ label: 'weed pressure' }], [SPOT_HERBICIDE])[0].product).toBe('herbicide');
    expect(ties([{ label: 'chinch bug activity' }], [INSECT_SPOT])[0].product).toBe('insecticide');
    expect(ties([{ label: 'gray leaf spot' }], [FUNG_ANY])[0].product).toBe('fungicide');
  });

  test('a product with no matching finding makes no tie', () => {
    expect(ties([], [FUNGICIDE, SPOT_HERBICIDE])).toEqual([]);
    expect(ties([{ label: 'thinning turf' }, { label: 'color stress' }], [FUNGICIDE])).toEqual([]);
  });

  test('confidence: a moderate-or-better, determinable read is sure; low, unknown or undeterminable is hedged', () => {
    expect(ties([{ label: 'weed pressure', confidence: 'moderate' }], [SPOT_HERBICIDE])[0].sure).toBe(true);
    expect(ties([{ label: 'weed pressure', confidence: 'low' }], [SPOT_HERBICIDE])[0].sure).toBe(false);
    expect(ties([{ label: 'weed pressure', confidence: 'unknown' }], [SPOT_HERBICIDE])[0].sure).toBe(false);
    expect(ties([{ label: 'weed pressure', can_determine: false }], [SPOT_HERBICIDE])[0].sure).toBe(false);
  });

  test('two reads of one kind: the more severe names it, the less confident hedges it', () => {
    const out = ties([
      { label: 'gray leaf spot', severity: 'mild', confidence: 'low' },
      { label: 'dollar spot', severity: 'severe', confidence: 'high' },
    ], [FUNGICIDE]);
    expect(out).toEqual([{ source: 'photo', kind: 'fungus', label: 'dollar spot', sure: false, product: 'fungicide' }]);
  });

  test('a rejected finding, an unreviewed run, another assessment and an unconfirmed assessment make no tie', () => {
    expect(ties([{ label: 'gray leaf spot', keep: false }], [FUNGICIDE])).toEqual([]);
    expect(facts.buildTies({ rows: [FUNGICIDE], run: { ...run({ label: 'gray leaf spot' }), reviewed_at: null }, assessment: ASSESSMENT })).toEqual([]);
    expect(facts.buildTies({ rows: [FUNGICIDE], run: { ...run({ label: 'gray leaf spot' }), assessment_id: 'other' }, assessment: ASSESSMENT })).toEqual([]);
    expect(facts.buildTies({ rows: [FUNGICIDE], run: run({ label: 'gray leaf spot' }), assessment: { ...ASSESSMENT, confirmed_by_tech: false } })).toEqual([]);
    expect(facts.buildTies({ rows: [FUNGICIDE], run: null, assessment: null })).toEqual([]);
  });

  test('a label that is not on the customer allowlist, or has no kind, makes no tie', () => {
    expect(ties([{ label: 'something the model made up' }, { label: 'overwatering signal' }, { label: 'thinning turf' }], [FUNGICIDE, SPOT_HERBICIDE])).toEqual([]);
  });

  describe('the technician\'s tap is a finding', () => {
    test.each([
      ['chinch', 'insecticide', INSECT_SPOT],
      ['caterpillars', 'insecticide', INSECT_BROADCAST],
      ['fungus', 'fungicide', FUNG_ANY],
    ])('%s with its product on the visit', (kind, product, productRow) => {
      expect(ties([], [productRow], [{ kind }])).toEqual([{ source: 'technician', kind, product }]);
    });

    test('a tap with no product of its kind on the visit makes no tie (a treatment we did not record is never claimed)', () => {
      expect(ties([], [SPRAY], [{ kind: 'chinch' }, { kind: 'fungus' }])).toEqual([]);
    });

    test('an unknown tap kind is ignored', () => {
      expect(ties([], [INSECT_SPOT], [{ kind: 'weeds' }, { kind: 'mystery' }])).toEqual([]);
    });

    test('the technician\'s word replaces the photo tie of the same kind', () => {
      const out = ties([{ label: 'chinch bug activity' }, { label: 'gray leaf spot' }], [INSECT_SPOT, FUNG_ANY], [{ kind: 'chinch' }]);
      expect(out).toEqual([
        { source: 'technician', kind: 'chinch', product: 'insecticide' },
        { source: 'photo', kind: 'fungus', label: 'gray leaf spot', sure: true, product: 'fungicide' },
      ]);
    });
  });

  test('ties are bounded', () => {
    const many = ties(
      [{ label: 'gray leaf spot' }, { label: 'weed pressure' }, { label: 'chinch bug activity' }, { label: 'drought stress' }],
      [FUNG_ANY, SPOT_HERBICIDE, INSECT_SPOT, WETTING],
      [{ kind: 'fungus' }, { kind: 'chinch' }, { kind: 'caterpillars' }],
    );
    expect(many.length).toBeLessThanOrEqual(4);
  });
});

describe('a preventive-locked product never counts as treating a finding (the tie and "What to expect" read one classification)', () => {
  const ASSESSMENT = { id: 'as-1', customer_id: 'c-1', confirmed_by_tech: true };
  const run = (label) => ({ assessment_id: 'as-1', customer_id: 'c-1', reviewed_at: '2026-10-08T15:00:00Z', reviewed_findings: [{ finding_id: 'f', keep: true, label, confidence: 'high', severity: 'moderate', can_determine: true }] });
  const ACELEPRYN = row('ac1', 'spot_treatment', { name: 'Acelepryn Xtra', category: 'insecticide' });
  const ACELEPRYN_PLAIN = row('ac2', 'spot_treatment', { name: 'Acelepryn Insecticide', category: 'insecticide' });
  const ARENA = row('ar', 'spot_treatment', { name: 'Arena 50 WDG', category: 'insecticide' });

  test('Acelepryn is no product kind at all', () => {
    expect(facts._test.rowProductKind(ACELEPRYN)).toBeNull();
    expect(facts._test.rowProductKind(ACELEPRYN_PLAIN)).toBeNull();
    expect(facts._test.rowProductKind(ARENA)).toBe('insecticide');
    expect(facts._test.rowProductKind(row('x', 'spot_treatment', { name: 'Anything', category: 'insecticide', facts: { ...approved(rule('none')), name: 'Acelepryn Xtra' } }))).toBeNull();
  });

  test('an insect photo finding beside only Acelepryn is unanswered (product null), and no family becomes curative', () => {
    for (const rows of [[ACELEPRYN], [ACELEPRYN_PLAIN]]) {
      const out = facts.buildTies({ rows, run: run('chinch bug activity'), assessment: ASSESSMENT });
      expect(out).toEqual([{ source: 'photo', kind: 'insects', label: 'chinch bug activity', sure: true, product: null }]);
    }
  });

  test('the technician\'s chinch or caterpillar tap with only Acelepryn makes no tie', () => {
    expect(facts.buildTies({ rows: [ACELEPRYN], run: null, assessment: null, techFindings: [{ kind: 'chinch' }, { kind: 'caterpillars' }] })).toEqual([]);
  });

  test('another insecticide on the same visit still answers the finding', () => {
    const out = facts.buildTies({ rows: [ACELEPRYN, ARENA], run: run('chinch bug activity'), assessment: ASSESSMENT, techFindings: [] });
    expect(out[0].product).toBe('insecticide');
  });

  test('the expectation engine keeps Acelepryn preventive for any tie: the tie and the line cannot disagree', () => {
    const { buildLawnExpectations } = require('../services/service-report/lawn-expectations');
    const lines = (tied) => buildLawnExpectations({ applications: [{ name: 'Acelepryn Xtra' }], tiedFamilies: tied }).lines;
    expect(lines(['insecticide'])).toEqual(lines([]));
  });
});

describe('verifiedTechFindings: the echo is checked before a find can reach the customer', () => {
  const P_FUNG = '00000000-0000-4000-8000-000000000031';
  const P_ARENA = '00000000-0000-4000-8000-000000000032';
  const P_CATERPILLAR = '00000000-0000-4000-8000-000000000033';
  const P_OTHER_INSECT = '00000000-0000-4000-8000-000000000034';
  const P_ABSENT = '00000000-0000-4000-8000-000000000035';
  const rowFor = (id, name, category, method = 'spot_treatment') => ({ ...row(`sp-${name}`, method, { name, category }), product_id: id });
  const ROWS = [
    rowFor(P_FUNG, 'Torque SC', 'fungicide'),
    rowFor(P_ARENA, 'Arena 50 WDG', 'insecticide'),
    rowFor(P_CATERPILLAR, 'Caterpillar Insecticide', 'insecticide'),
    rowFor(P_OTHER_INSECT, 'Other Insecticide', 'insecticide'),
  ];
  const STAGED = [
    { product_id: P_FUNG, role: 'fungicide_spot', gates: { trigger: 'mapped_large_patch' } },
    { product_id: P_ARENA, role: 'insecticide_spot', gates: { trigger: 'chinch_20_to_25_per_sqft' } },
    { product_id: P_CATERPILLAR, role: 'insecticide_spot', gates: JSON.stringify({ trigger: 'caterpillars' }) },
  ];
  const stagedKnex = (rows = STAGED, { fail = false } = {}) => () => {
    const q = {};
    q.whereRaw = () => q;
    q.whereIn = (_k, ids) => { q.ids = ids; return q; };
    q.select = () => (fail ? Promise.reject(new Error('down')) : Promise.resolve(rows.filter((r) => q.ids.includes(r.product_id))));
    return q;
  };
  const CONFIRMED = { id: 'as-1', customer_id: 'c-1', confirmed_by_tech: true };
  const runWith = (severities) => ({ assessment_id: 'as-1', customer_id: 'c-1', severities: JSON.stringify(severities) });
  const FUNGUS_RUN = runWith({ fungal_activity: { level: 'moderate' } });
  const INSECT_RUN = runWith({ insect_damage: { level: 'severe' } });
  const verify = (taps, { assessment = CONFIRMED, run = null, knex = stagedKnex() } = {}) => facts._test.verifiedTechFindings({ taps, rows: ROWS, assessment, run, knex });

  test('the standing chinch tap: offered every month, so it needs no finding, only a chinch rung that was applied', async () => {
    expect(await verify([{ kind: 'chinch', productIds: [P_ARENA] }], { assessment: null })).toEqual([{ kind: 'chinch' }]);
  });

  test('a fungus card needs a fungus finding on the confirmed assessment AND its own staged fungicide, applied', async () => {
    expect(await verify([{ kind: 'fungus', productIds: [P_FUNG] }], { run: FUNGUS_RUN })).toEqual([{ kind: 'fungus' }]);
    expect(await verify([{ kind: 'fungus', productIds: [P_FUNG] }], { run: runWith({ fungal_activity: { level: 'none' } }) })).toEqual([]);
    expect(await verify([{ kind: 'fungus', productIds: [P_FUNG] }], { run: null })).toEqual([]);
    expect(await verify([{ kind: 'fungus', productIds: [P_FUNG] }], { assessment: null, run: FUNGUS_RUN })).toEqual([]);
    expect(await verify([{ kind: 'fungus', productIds: [P_FUNG] }], { assessment: { ...CONFIRMED, confirmed_by_tech: false }, run: FUNGUS_RUN })).toEqual([]);
  });

  test('a caterpillar card needs moderate or worse insect damage and the caterpillar row (a trigger stored as JSON text reads too)', async () => {
    expect(await verify([{ kind: 'caterpillars', productIds: [P_CATERPILLAR] }], { run: INSECT_RUN })).toEqual([{ kind: 'caterpillars' }]);
    expect(await verify([{ kind: 'caterpillars', productIds: [P_CATERPILLAR] }], { run: runWith({ insect_damage: { level: 'minor' } }) })).toEqual([]);
  });

  test('a modified echo is refused: a product not applied, an applied product the program does not stage for the card, the wrong kind, no ids', async () => {
    expect(await verify([{ kind: 'chinch', productIds: [P_ABSENT] }])).toEqual([]);
    expect(await verify([{ kind: 'chinch', productIds: [P_OTHER_INSECT] }])).toEqual([]);
    expect(await verify([{ kind: 'chinch', productIds: [P_FUNG] }])).toEqual([]);
    expect(await verify([{ kind: 'fungus', productIds: [P_ARENA] }], { run: FUNGUS_RUN })).toEqual([]);
    expect(await verify([{ kind: 'chinch', productIds: [] }])).toEqual([]);
    expect(await verify([{ kind: 'chinch', productIds: ['not-a-uuid'] }])).toEqual([]);
    expect(await verify([{ kind: 'chinch', productIds: [P_ARENA, P_ABSENT] }])).toEqual([]);
    expect(await verify([{ kind: 'weeds', productIds: [P_ARENA] }])).toEqual([]);
  });

  test('a failed program READ is not an answer: it throws, so the freeze records a failed attempt instead of leaving the find out', async () => {
    await expect(verify([{ kind: 'chinch', productIds: [P_ARENA] }], { knex: stagedKnex(STAGED, { fail: true }) })).rejects.toThrow('down');
    // A definite "no" never reads the program at all, so it cannot fail.
    expect(await verify([{ kind: 'chinch', productIds: [] }], { knex: stagedKnex(STAGED, { fail: true }) })).toEqual([]);
    expect(await verify(undefined)).toEqual([]);
  });

  test('a verified find becomes a customer tie; an unverified one never does', async () => {
    const good = await verify([{ kind: 'chinch', productIds: [P_ARENA] }]);
    expect(facts.buildTies({ rows: ROWS, run: null, assessment: null, techFindings: good })).toEqual([{ source: 'technician', kind: 'chinch', product: 'insecticide' }]);
    const bad = await verify([{ kind: 'chinch', productIds: [P_OTHER_INSECT] }]);
    expect(facts.buildTies({ rows: ROWS, run: null, assessment: null, techFindings: bad })).toEqual([]);
  });
});

describe('the frozen block is read strictly, and only from the record', () => {
  const block = (extra = {}) => ({
    v: 1,
    reentry: { rule: 'dry', source: 'facts', products: [{ id: 'a', rule: 'dry', source: 'facts' }] },
    productUse: { 'p-spot': { sqft: 250 } },
    ties: { assessmentId: '77', items: [{ source: 'photo', kind: 'fungus', label: 'gray leaf spot', sure: true, product: 'fungicide' }] },
    ...extra,
  });
  const notes = (b) => JSON.stringify({ lawnReportFacts: b });

  test('absent or unknown version: nothing', () => {
    expect(facts.readFrozenReportFacts('{}')).toBeNull();
    expect(facts.readFrozenReportFacts(null)).toBeNull();
    expect(facts.readFrozenReportFacts(notes({ ...block(), v: 2 }))).toBeNull();
    expect(facts.frozenReentryRule('{}')).toBeNull();
    expect(facts.frozenReportFactsStamp('{}')).toBe('');
    expect(facts.frozenTies('{}', '77')).toEqual([]);
    expect(facts.frozenTiedFamilies('{}', '77')).toEqual([]);
  });

  test('a real rule is read; the marked default is not a decision', () => {
    expect(facts.frozenReentryRule(notes(block()))).toMatchObject({ rule: 'dry' });
    const dflt = block({ reentry: { rule: 'default', source: 'default', products: [{ id: 'a', rule: null, source: 'default' }] } });
    expect(facts.frozenReentryRule(notes(dflt))).toBeNull();
    expect(facts.readFrozenReportFacts(notes(dflt)).reentry.rule).toBe('default');
  });

  test('malformed rules are no rule', () => {
    for (const bad of [
      { rule: 'dry', source: 'facts', products: [] },
      { rule: 'whenever', source: 'facts', products: [{ id: 'a', rule: 'dry', source: 'facts' }] },
      { rule: 'dry', source: 'guess', products: [{ id: 'a', rule: 'dry', source: 'facts' }] },
      { rule: 'timed', source: 'label', hours: 12, base: 'dry', products: [{ id: 'a', rule: 'dry', source: 'facts' }] },
      { rule: 'dry', source: 'label', products: [{ id: 'a', rule: 'dry', source: 'facts' }] },
      'dry',
    ]) {
      expect(facts.frozenReentryRule(notes(block({ reentry: bad })))).toBeNull();
    }
  });

  test('ties are read for their own assessment only, and a hand-edited tie is dropped', () => {
    expect(facts.frozenTies(notes(block()), '77')).toHaveLength(1);
    expect(facts.frozenTies(notes(block()), 77)).toHaveLength(1);
    expect(facts.frozenTies(notes(block()), '78')).toEqual([]);
    const edited = block({
      ties: {
        assessmentId: '77',
        items: [
          { source: 'photo', kind: 'fungus', label: 'weed pressure', sure: true, product: 'fungicide' },
          { source: 'photo', kind: 'fungus', label: 'gray leaf spot', sure: true, product: 'herbicide' },
          { source: 'technician', kind: 'chinch', product: 'fungicide' },
          { source: 'oracle', kind: 'fungus' },
        ],
      },
    });
    expect(facts.frozenTies(notes(edited), '77')).toEqual([]);
  });

  test('tied families: a fungicide or insecticide that treated a finding makes its family curative', () => {
    const b = block({ ties: { assessmentId: '77', items: [
      { source: 'photo', kind: 'fungus', label: 'gray leaf spot', sure: true, product: 'fungicide' },
      { source: 'photo', kind: 'weeds', label: 'weed pressure', sure: true, product: 'herbicide' },
      { source: 'technician', kind: 'chinch', product: 'insecticide' },
      { source: 'photo', kind: 'insects', label: 'chinch bug activity', sure: true, product: null },
    ] } });
    expect(facts.frozenTiedFamilies(notes(b), '77').sort()).toEqual(['fungicide', 'insecticide']);
    expect(facts.frozenTiedFamilies(notes(block({ ties: { assessmentId: '77', items: [] } })), '77')).toEqual([]);
  });

  test('tied families are those of the render\'s own assessment: another assessment (after a retake), or none, gives none', () => {
    const b = block({ ties: { assessmentId: '77', items: [{ source: 'photo', kind: 'fungus', label: 'gray leaf spot', sure: true, product: 'fungicide' }] } });
    expect(facts.frozenTiedFamilies(notes(b), '77')).toEqual(['fungicide']);
    expect(facts.frozenTiedFamilies(notes(b), 77)).toEqual(['fungicide']);
    expect(facts.frozenTiedFamilies(notes(b), '78')).toEqual([]);
    expect(facts.frozenTiedFamilies(notes(b), null)).toEqual([]);
    expect(facts.frozenTiedFamilies(notes(b))).toEqual([]);
  });

  test('an ADMIN correction of the re-entry minutes (structured_notes.reentryAdjusted) keeps the clock; a technician stepper never overrides the condition', () => {
    const record = { structured_notes: notes(block()) };
    expect(facts.frozenReentryForRecord(record)).toMatchObject({ rule: 'dry' });
    const admin = JSON.stringify({ ...JSON.parse(notes(block())), reentryAdjusted: true, reentryRev: 1 });
    expect(facts.frozenReentryForRecord({ structured_notes: admin })).toBeNull();
    // The technician's stepper at completion marks only advisory.reentry_adjusted: the condition wins.
    expect(facts.frozenReentryForRecord({ ...record, advisory: { reentry_adjusted: { exterior: true, interior: false } } })).toMatchObject({ rule: 'dry' });
    expect(facts.frozenReentryForRecord({ ...record, advisory: JSON.stringify({ reentry_adjusted: true }) })).toMatchObject({ rule: 'dry' });
  });

  describe('the PDF key follows the frozen decision and never a gate', () => {
    const stampOf = (b) => facts.frozenReportFactsStamp(notes(b));

    afterEach(() => { delete process.env.GATE_LAWN_REPORT_FACTS; });

    test('present with a decision, absent without one, and the same with the gate on or off', () => {
      const off = stampOf(block());
      expect(off).toMatch(/^:rf=[0-9a-f]{8}$/);
      process.env.GATE_LAWN_REPORT_FACTS = 'true';
      expect(stampOf(block())).toBe(off);
      expect(facts.frozenReportFactsStamp('{}')).toBe('');
      delete process.env.GATE_LAWN_REPORT_FACTS;
      expect(facts.frozenReportFactsStamp('{}')).toBe('');
    });

    test('a block that holds no decision (default rule, no spot rows, no ties) keeps the old key', () => {
      const none = block({
        reentry: { rule: 'default', source: 'default', products: [{ id: 'a', rule: null, source: 'default' }] },
        productUse: {},
        ties: { assessmentId: '77', items: [] },
      });
      expect(stampOf(none)).toBe('');
    });

    test('it changes with each frozen decision', () => {
      const base = stampOf(block());
      const wet = block({ reentry: { rule: 'watered_in_and_dry', source: 'facts', products: [{ id: 'a', rule: 'watered_in_and_dry', source: 'facts' }] } });
      expect(stampOf(wet)).not.toBe(base);
      expect(stampOf(block({ productUse: { 'p-spot': { sqft: 300 } } }))).not.toBe(base);
      expect(stampOf(block({ ties: { assessmentId: '77', items: [] } }))).not.toBe(base);
    });
  });
});

describe('the freeze is first writer wins and never throws', () => {
  function fakeKnex({ existing = null, fail = false } = {}) {
    const state = { notes: existing ? { lawnReportFacts: existing } : {}, guards: [] };
    const knex = () => {
      const q = {};
      q.where = () => q;
      q.whereRaw = (sql) => { state.guards.push(sql); return q; };
      q.first = async () => ({ structured_notes: JSON.stringify(state.notes) });
      q.update = async ({ structured_notes: raw }) => {
        if (fail) throw new Error('write failed');
        if (state.notes.lawnReportFacts) return 0;
        Object.assign(state.notes, JSON.parse(raw.bindings[0]));
        return 1;
      };
      return q;
    };
    knex.raw = (sql, bindings) => ({ sql, bindings });
    return { knex, state };
  }

  test('writes once, with the key\'s absence in the predicate; a second writer adopts the first', async () => {
    const { knex, state } = fakeKnex();
    const first = { v: 1, marker: 'first' };
    expect(await facts.freezeReportFacts({ knex, serviceRecordId: 's1', facts: first })).toBe(first);
    expect(state.guards[0]).toContain("'lawnReportFacts'");
    expect(state.guards[0]).toContain('IS NULL');
    const second = await facts.freezeReportFacts({ knex, serviceRecordId: 's1', facts: { v: 1, marker: 'second' } });
    expect(second).toEqual({ v: 1, marker: 'first' });
  });

  test('a failed write returns null', async () => {
    const { knex } = fakeKnex({ fail: true });
    expect(await facts.freezeReportFacts({ knex, serviceRecordId: 's1', facts: { v: 1 } })).toBeNull();
  });

  test('buildReportFacts assembles the three facts from one visit', () => {
    const block = facts.buildReportFacts({
      rows: [SPRAY, SPOT_HERBICIDE],
      run: null,
      assessment: { id: 'as-1' },
      techFindings: [],
      recordedSpotAreas: new Set(['pid-p-spot']),
      now: new Date('2026-10-08T20:00:00Z'),
    });
    expect(block).toMatchObject({
      v: 1,
      frozenAt: '2026-10-08T20:00:00.000Z',
      reentry: { rule: 'dry', source: 'facts' },
      productUse: { 'p-spot': { sqft: 250 } },
      ties: { assessmentId: 'as-1', items: [] },
    });
  });
});
