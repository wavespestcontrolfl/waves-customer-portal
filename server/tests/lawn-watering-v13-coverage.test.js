// Every product mix the v13 lawn program can put on one visit gets a watering text (owner 2026-10-22: "for all
// combinations, a text goes out, but the text is accurate") once GATE_LAWN_WATERING_EVERY_VISIT resolves targets and
// applies rule E. A mix = every primary product of a month (or of its cadence variant) plus any subset of that
// month's secondaries and add-ons, with or without the liquid K-Flow + Chelated AM pair. The rules are the catalog's
// after migrations 20261022120000 and 20261022150000 (fixture); a product the program names that the fixture lacks
// fails here, so a new protocol product needs a watering rule first.
const v13 = require('../config/lawn-protocol-v13.json');
const RULES = require('./fixtures/lawn-watering-rules-v13-2026-10-22.json');
const { validateRule, rulesForTargets } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');

const LIQUIDS = ['LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer', 'LESCO Chelated AM + Micros Turf & Ornamental Liquid Micronutrient'];
// Lawn visits end between 9 AM and 6 PM ET (2026-05 to 2026-10): 10 AM and 4 PM, EDT.
const TIMES = ['2026-10-21T14:00:00Z', '2026-10-21T20:00:00Z'];
const BANNED = /(keep[^.]{0,20}off|stay off|\bwait\b|\bdry\b)[^.]{0,30}\b\d+\s*(h|hour|min)/i;
const namesOf = (text) => String(text || '').split('\n').map((line) => line.split(' — ')[0].trim())
  .filter((name) => name && !name.startsWith('Scout visit'));

function visitMixes() {
  const mixes = [];
  for (const [turf, program] of Object.entries(v13)) {
    for (const visit of program.visits) {
      const addOns = Object.values(visit.addOns || {}).flatMap((addOn) => namesOf(addOn.secondary));
      for (const variant of [visit, ...Object.values(visit.cadenceVariants || {})]) {
        const optional = [...new Set([...namesOf(variant.secondary), ...addOns])];
        for (let mask = 0; mask < (1 << optional.length); mask += 1) {
          const chosen = optional.filter((_, i) => mask & (1 << i));
          for (const liquids of [[], LIQUIDS]) {
            const names = [...new Set([...namesOf(variant.primary), ...chosen, ...liquids])];
            if (names.length) mixes.push({ label: `${turf} ${visit.month}`, names });
          }
        }
      }
    }
  }
  return mixes;
}

test('every product the program names has a valid watering rule', () => {
  const named = new Set(visitMixes().flatMap((mix) => mix.names));
  for (const name of named) {
    expect({ name, valid: validateRule(RULES[name]).valid }).toEqual({ name, valid: true });
  }
});

test('every program mix gets an accurate-shaped watering text at a daytime completion', () => {
  const failures = [];
  for (const mix of visitMixes()) {
    // No target logged: each target-split product reads its main use (the protocol's).
    const rules = mix.names.flatMap((name) => rulesForTargets(validateRule(RULES[name]).rule, []).map((rule) => ({ name, rule })));
    for (const completedAt of TIMES) {
      const ins = buildWateringInstruction({ rules, completedAt, plainWhenNoSetup: true, labelFirst: true });
      const bad = !ins.state || !ins.lines.length || ins.lines.some((line) => BANNED.test(line))
        || (ins.holdUntil && ins.waterInBy && Date.parse(ins.waterInBy) <= Date.parse(ins.holdUntil));
      if (bad) failures.push(`${mix.label} @ ${completedAt}: ${mix.names.join(' + ')} -> ${ins.state} ${ins.noClaim ? ins.noClaim.reason : ''}`);
    }
  }
  expect(failures.slice(0, 5)).toEqual([]);
});
