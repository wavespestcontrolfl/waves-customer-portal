// Owner rule (2026-09-27): "nothing should be put into ml" — technicians have
// no way to measure milliliters. Protocol amounts are measuring-spoon
// teaspoons, ounce-cup fluid ounces, gallons, or dry weights.
const protocols = require('../config/protocols.json');

const ML_AMOUNT = /\d\s*(?:ml|milliliters?|millilitres?|cc)\b/i;

function collectStrings(node, path, out) {
  if (typeof node === 'string') {
    out.push([path, node]);
  } else if (Array.isArray(node)) {
    node.forEach((item, i) => collectStrings(item, `${path}[${i}]`, out));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) collectStrings(value, path ? `${path}.${key}` : key, out);
  }
  return out;
}

describe('protocols.json amounts', () => {
  test('no protocol states an amount in milliliters', () => {
    const offenders = collectStrings(protocols, '', [])
      .filter(([, text]) => ML_AMOUNT.test(text))
      .map(([path, text]) => `${path}: ${text}`);
    expect(offenders).toEqual([]);
  });

  test('the pattern catches the forms a writer would use', () => {
    for (const text of ['Mainspring 1.2 ml per gal', '5mL per backpack', '20 milliliters', '3 cc in the tank']) {
      expect(ML_AMOUNT.test(text)).toBe(true);
    }
    for (const text of ['1¾ tsp per FlowZone', '4 fl oz per 100 gal', 'Hand spreader', 'Mainspring GNL']) {
      expect(ML_AMOUNT.test(text)).toBe(false);
    }
  });
});
