// Pest Insider "A tool we'd use": the reviewed tool list, held to the
// vendored affiliate registry (owner 2026-11-19: approved registry products
// only, Amazon only, Amazon's exact sentence) and to the tool copy rule.
const registry = require('../../packages/affiliate-registry');
const { TOOLS, TOOL_URLS, AMAZON_DISCLOSURE, toolById, toolLinkText, validateTools } = require('../services/pest-insider/tools');
const { toolLineProblem } = require('../services/pest-insider/claim-check');

const index = registry.productIndex();
const MESH = 'stuff-it-copper-mesh';
const entry = (over = {}) => ({ product_id: MESH, name: 'Copper mesh', lines: ['Copper mesh fills small gaps.'], services: ['pest'], ...over });
// A registry index with one row changed, for the refusals.
const indexWith = (id, change) => {
  const copy = new Map(index);
  const { row, state } = copy.get(id);
  copy.set(id, { state, ...change({ row: { ...row }, state }) });
  return copy;
};

describe('the reviewed tool list', () => {
  test('every tool is an active, green Amazon product of the registry, linked by its approved URL', () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    for (const tool of TOOLS) {
      const { row, state } = index.get(tool.productId);
      expect(state).toBe('active');
      expect(row).toMatchObject({ risk_class: 'green', merchant: 'amazon' });
      expect(tool.url).toBe(row.approved_affiliate_url);
      expect(tool.url).toMatch(/^https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}\?tag=wavespestcont-20$/);
      expect(toolById(tool.productId)).toBe(tool);
      expect(toolLinkText(tool)).toBe(`${tool.name} on Amazon`);
    }
    expect(TOOL_URLS).toEqual(TOOLS.map((t) => t.url));
    expect(toolById('ks-adjustable-door-sweep')).toBeNull(); // dead listing: not listed
  });

  test('the list and the link allowlist cannot be changed by a caller', () => {
    expect(Object.isFrozen(TOOLS) && TOOLS.every((t) => Object.isFrozen(t) && Object.isFrozen(t.lines))).toBe(true);
    expect(() => TOOL_URLS.push('https://www.amazon.com/dp/B000000000?tag=wavespestcont-20')).toThrow(TypeError);
  });

  test("Amazon's sentence is the exact required wording", () => {
    expect(AMAZON_DISCLOSURE).toBe('As an Amazon Associate I earn from qualifying purchases.');
  });

  test.each([
    ['a product the registry does not have', { product_id: 'no-such-product' }, index, /not in the affiliate registry/],
    ['a paused registry product', {}, indexWith(MESH, () => ({ state: 'inactive' })), /not active/],
    ['a yellow (consumer pesticide) product', {}, indexWith(MESH, ({ row }) => ({ row: { ...row, risk_class: 'yellow' } })), /not green/],
    ['a product sold somewhere else', {}, indexWith(MESH, ({ row }) => ({ row: { ...row, merchant: 'domyown' } })), /not an Amazon product/],
    ['a registry URL with more than our tag', {}, indexWith(MESH, ({ row }) => ({ row: { ...row, approved_affiliate_url: `${row.approved_affiliate_url}&ref=email` } })), /not a tagged Amazon product page/],
    ['a brand in the name', { name: 'Stuff-it mesh' }, index, /name/],
    ['a capitalized brand word in the name', { name: 'Copper stuff' }, indexWith(MESH, ({ row }) => ({ row: { ...row, display_name: 'Copper Stuff mesh roll' } })), /brand word "copper"/],
    ['a name in title case', { name: 'Copper Mesh' }, index, /name must be/],
    ['no lines', { lines: [] }, index, /1 or 2 lines/],
    ['three lines', { lines: ['A.', 'B.', 'C.'] }, index, /1 or 2 lines/],
    ['a line on two lines', { lines: ['It fills gaps.\nIt lasts.'] }, index, /one trimmed line/],
    ['a line with a number', { lines: ['It fills gaps up to 2 inches wide.'] }, index, /number/],
    ['a line with a month', { lines: ['It works best in June.'] }, index, /month or season/],
    ['a line naming Amazon', { lines: ['Amazon sells it in rolls.'] }, index, /brand/],
    ['a line with "safe"', { lines: ['It is safe around pets.'] }, index, /safe/],
    ['a line with a price word', { lines: ['It is a cheap fix.'] }, index, /price word/],
    ['a line that asks the reader to buy', { lines: ['It is worth it to buy through our link and support us.'] }, index, /sales word/],
    ['a line that says a purchase helps us', { lines: ['Every roll helps us keep this email free.'] }, index, /sales word/],
    ['a line with a name', { lines: ['It is the roll Home Depot sells.'] }, index, /name not in the source/],
    ['a service the fact bank does not have', { services: ['pool'] }, index, /services must list/],
  ])('refuses %s', (_label, over, idx, message) => {
    expect(() => validateTools({ tools: [entry(over)] }, idx)).toThrow(message);
  });

  test('refuses a product listed twice, and a file with no tools list', () => {
    expect(() => validateTools({ tools: [entry(), entry()] }, index)).toThrow(/listed twice/);
    expect(() => validateTools({}, index)).toThrow(/no tools list/);
  });
});

describe('toolLineProblem', () => {
  test('a plain line passes; a unit word passes only when the tool name has it', () => {
    expect(toolLineProblem('A soil moisture meter reads the water down at the roots.', { name: 'Soil moisture meter' })).toBeNull();
    expect(toolLineProblem('A rain gauge reads to the nearest meter.', { name: 'Rain gauge' })).toMatch(/unit:meter/);
    expect(toolLineProblem('', { name: 'Rain gauge' })).toBe('empty sentence');
  });
});
