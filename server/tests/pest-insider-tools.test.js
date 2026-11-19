// Pest Insider "A tool we'd use": the reviewed tool list, held to the
// vendored affiliate registry (owner 2026-11-19: approved registry products
// only, Amazon only, Amazon's exact sentence) and to the tool copy rule.
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const registry = require('../../packages/affiliate-registry');
const data = require('../data/pest-insider-tools-v1.json');
const { TOOLS, TOOL_PROBLEMS, AMAZON_DISCLOSURE, toolById, toolLinkText, checkTools } = require('../services/pest-insider/tools');
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
    expect(toolById('ks-adjustable-door-sweep')).toBeNull(); // dead listing: not listed
  });

  test('CI holds the shipped list strict: every listed item loads, with no problem', () => {
    expect(TOOL_PROBLEMS).toEqual([]);
    expect(TOOLS.map((t) => t.productId)).toEqual(data.tools.map((t) => t.product_id));
  });

  test('the list cannot be changed by a caller', () => {
    expect(Object.isFrozen(TOOLS) && TOOLS.every((t) => Object.isFrozen(t) && Object.isFrozen(t.lines))).toBe(true);
    expect(() => TOOLS.push({ productId: 'x', url: 'https://www.amazon.com/dp/B000000000?tag=wavespestcont-20' })).toThrow(TypeError);
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
  ])('leaves out %s', (_label, over, idx, message) => {
    const { tools, problems } = checkTools({ tools: [entry(over)] }, idx);
    expect(tools).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(message);
  });

  test('a bad item drops only itself; a product listed twice drops both copies', () => {
    const gauge = data.tools.find((t) => t.product_id === 'acurite-glass-rain-gauge');
    const mixed = checkTools({ tools: [entry({ lines: ['It is safe around pets.'] }), gauge] }, index);
    expect(mixed.tools.map((t) => t.productId)).toEqual(['acurite-glass-rain-gauge']);
    expect(mixed.problems).toEqual([expect.stringMatching(/^stuff-it-copper-mesh: line .*safe/)]);
    expect(checkTools({ tools: [entry(), entry()] }, index)).toEqual({ tools: [], problems: [`${MESH}: is listed twice`, `${MESH}: is listed twice`] });
    expect(checkTools({}, index)).toEqual({ tools: [], problems: ['the file has no tools list'] });
  });

  test('a registry file that cannot be read drops every tool, and an issue still builds (pre-push PR 3 r2)', () => {
    // The registry loads an unreadable file as empty (its dark posture). A
    // fresh process, so the module-load path is the one under test.
    const probe = [
      "const { buildIssue } = require('./services/pest-insider');",
      "const { POSTS } = require('./services/pest-insider/posts');",
      "const { TOOLS, TOOL_PROBLEMS } = require('./services/pest-insider/tools');",
      "const r = buildIssue({ sendDate: '2026-12-03', livePostFactIds: Object.keys(POSTS), liveToolIds: ['acurite-glass-rain-gauge', 'stuff-it-copper-mesh'] });",
      "process.stdout.write('\\nRESULT ' + JSON.stringify({ ok: r.ok, toolId: r.toolId, tools: TOOLS.length, problems: TOOL_PROBLEMS }) + '\\n');",
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'offline-sample', AFFILIATE_REGISTRY_PATH: path.join(os.tmpdir(), `no-such-registry-${process.pid}.json`) },
      encoding: 'utf8',
      timeout: 60000,
    });
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    expect(JSON.parse(line.slice('RESULT '.length))).toEqual({
      ok: true, toolId: null, tools: 0, problems: data.tools.map((t) => `${t.product_id}: is not in the affiliate registry`),
    });
  }, 60000);
});

describe('toolLineProblem', () => {
  test('a plain line passes; a unit word passes only when the tool name has it', () => {
    expect(toolLineProblem('A soil moisture meter reads the water down at the roots.', { name: 'Soil moisture meter' })).toBeNull();
    expect(toolLineProblem('A rain gauge reads to the nearest meter.', { name: 'Rain gauge' })).toMatch(/unit:meter/);
    expect(toolLineProblem('', { name: 'Rain gauge' })).toBe('empty sentence');
  });
});
