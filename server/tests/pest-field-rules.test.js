// Pest field rules (owner walkthrough 2026-10-03): one fact per rule, each
// synced as its own knowledge entry so the tech bar quotes the rule itself.
jest.mock('../models/db', () => jest.fn());

const protocols = require('../config/protocols.json');
const { _internals } = require('../services/knowledge-base');

const { fieldRuleEntries } = _internals;
const rules = protocols.pest.field_rules;
const ruleById = Object.fromEntries(rules.map((r) => [r.id, r.rule]));

describe('pest field rules', () => {
  test('every rule has an id, a question, a rule and a source', () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      for (const key of ['ask', 'rule', 'source']) expect(typeof r[key] === 'string' && r[key].trim().length > 0).toBe(true);
    }
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
  });

  test('sentences stay short: 20 words or fewer', () => {
    const long = [];
    for (const r of rules) {
      // Split on a period that ends a sentence, not one inside a number.
      for (const sentence of r.rule.split(/(?<!\d)\.\s+|\.\s+(?=[A-Z])/)) {
        if (sentence.trim().split(/\s+/).length > 20) long.push(`${r.id}: ${sentence}`);
      }
    }
    expect(long).toEqual([]);
  });

  test('rules follow the owner walkthrough', () => {
    expect(ruleById['taurus-band']).toContain('1 ft up the wall and 1 ft out');
    expect(ruleById['talak-band']).toContain('6 ft wide');
    expect(ruleById['talak-rate']).toContain('Do not add LESCO 90/10');
    expect(ruleById['alpine-outside']).toContain('Do not use Alpine WSG outside');
    expect(ruleById['outside-sprayer']).toContain('FlowZone');
    expect(ruleById.granules).toContain('Do not apply granules');
    // Dropped by the walkthrough: no Demand CS step, no rainy-season swap.
    expect(rules.some((r) => /Demand CS/.test(r.rule))).toBe(false);
    expect(rules.some((r) => /main tank/i.test(r.rule))).toBe(false);
  });

  test('each rule becomes its own protocols entry', () => {
    const entries = fieldRuleEntries(protocols);
    expect(entries).toHaveLength(rules.length);
    const taurus = entries.find((e) => e.slug === 'field-rule-pest-taurus-rate');
    expect(taurus.title).toBe('Pest Control Protocol: How much Taurus per gallon?');
    expect(taurus.content.split('\n')[0]).toBe('How much Taurus per gallon?');
    expect(taurus.content).toContain('Mix 0.8 fl oz Taurus SC in 1 gallon of water.');
    expect(taurus.tags).toEqual(['pest', 'field-rule']);
    expect(new Set(entries.map((e) => e.slug)).size).toBe(entries.length);
  });

  test('a rule missing its text is skipped, not synced blank', () => {
    const entries = fieldRuleEntries({ demo: { name: 'Demo', field_rules: [{ id: 'a', ask: 'Q?', rule: '' }, { id: 'b', ask: 'Q?', rule: 'Do it.' }] } });
    expect(entries.map((e) => e.slug)).toEqual(['field-rule-demo-b']);
    expect(entries[0].content).toBe('Q?\nDo it.');
  });
});
