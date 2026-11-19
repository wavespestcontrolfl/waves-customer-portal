// Pest Insider "A tool we'd use": the reviewed tool list, held to the
// vendored affiliate registry (owner 2026-11-19: approved registry products
// only, Amazon only, Amazon's exact sentence) and to the tool copy rule.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('../../packages/affiliate-registry');
const data = require('../data/pest-insider-tools-v1.json');
const { AMAZON_DISCLOSURE, loadTools, toolById, toolLinkText, checkTools } = require('../services/pest-insider/tools');
const { toolLineProblem } = require('../services/pest-insider/claim-check');
const { planIssue } = require('../services/pest-insider/plan');
const { FACTS } = require('../services/pest-insider/facts');
const { POST_URLS } = require('../services/pest-insider/posts');
const { renderIssue, withToolBlock } = require('../services/pest-insider/render');

const { tools: TOOLS, problems: TOOL_PROBLEMS } = loadTools();

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
      expect(toolById(tool.productId)).toEqual(tool);
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
    ['a line with a link', { lines: ['It shows the reading at https://example.org/tools.'] }, index, /plain sentence/],
    ['a line with a bare web address', { lines: ['See example.org for the rest.'] }, index, /plain sentence/],
    ['a line with markup', { lines: ['It fills <b>small</b> gaps.'] }, index, /plain sentence/],
    ['a line with no period', { lines: ['It fills small gaps'] }, index, /plain sentence/],
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
      "const { tools: TOOLS, problems: TOOL_PROBLEMS } = require('./services/pest-insider/tools').loadTools();",
      `const r = buildIssue({ sendDate: '2026-12-03', livePostFactIds: Object.keys(POSTS), liveToolUrls: ${JSON.stringify(TOOLS.map((t) => t.url))} });`,
      "process.stdout.write('\\nRESULT ' + JSON.stringify({ ok: r.ok, tool: r.tool, tools: TOOLS.length, problems: TOOL_PROBLEMS }) + '\\n');",
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'offline-sample', AFFILIATE_REGISTRY_PATH: path.join(os.tmpdir(), `no-such-registry-${process.pid}.json`) },
      encoding: 'utf8',
      timeout: 60000,
    });
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    expect(JSON.parse(line.slice('RESULT '.length))).toEqual({
      ok: true, tool: null, tools: 0, problems: data.tools.map((t) => `${t.product_id}: is not in the affiliate registry`),
    });
  }, 60000);
});

describe('the registry as it is now (pre-push PR 3 r3)', () => {
  test('a row paused or relinked while the process runs takes effect at the next pick and render; a relinked tool waits for a check of its new link (r4)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pest-insider-registry-'));
    const file = path.join(dir, 'registry.json');
    const base = registry.loadRegistry();
    // The registry reloads its file when the file's time changes.
    const write = (change, when) => {
      fs.writeFileSync(file, JSON.stringify({ ...base, products: base.products.map(change) }));
      fs.utimesSync(file, when, when);
    };
    const NEW_URL = 'https://www.amazon.com/dp/B000000001?tag=wavespestcont-20';
    const FEB = '2027-02-04'; // leads with a pest fact: copper mesh fits it
    const plan = (liveToolUrls) => planIssue({ sendDate: FEB, livePostFactIds: FACTS.map((f) => f.id), liveToolUrls }).tool;
    const mesh = TOOLS.find((t) => t.productId === MESH);
    const gauge = TOOLS.find((t) => t.productId === 'acurite-glass-rain-gauge');
    const shared = renderIssue({
      subject: 's', preview: 'p', lead: { headline: 'h', sentences: [{ text: 'a' }], postUrl: POST_URLS[0] },
      idItem: { text: 'x', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
    });
    const before = process.env.AFFILIATE_REGISTRY_PATH;
    try {
      process.env.AFFILIATE_REGISTRY_PATH = file;
      write((row) => row, new Date('2026-11-01T00:00:00Z'));
      expect(loadTools()).toEqual({ tools: TOOLS, problems: [] });
      expect(plan([mesh.url]).productId).toBe(MESH);
      expect(withToolBlock(shared, gauge).html_body).toContain(`href="${gauge.url}"`);

      write((row) => {
        if (row.product_id === MESH) return { ...row, status: 'paused' };
        if (row.product_id === 'acurite-glass-rain-gauge') return { ...row, approved_affiliate_url: NEW_URL };
        return row;
      }, new Date('2026-11-02T00:00:00Z'));
      expect(loadTools().problems).toEqual([`${MESH}: its registry row is inactive, not active`]);
      expect(toolById(MESH)).toBeNull();
      expect(plan([mesh.url])).toBeNull();
      expect(withToolBlock(shared, mesh)).toBe(shared);
      // relinked: only the old link passed a check, so the tool waits for a check of the new one
      expect(toolById(gauge.productId).url).toBe(NEW_URL);
      expect(plan([gauge.url])).toBeNull();
      expect(withToolBlock(shared, gauge)).toBe(shared);
      expect(plan([NEW_URL]).productId).toBe(gauge.productId);
      expect(withToolBlock(shared, { productId: gauge.productId, url: NEW_URL }).html_body).toContain(`href="${NEW_URL}"`);
    } finally {
      if (before === undefined) delete process.env.AFFILIATE_REGISTRY_PATH;
      else process.env.AFFILIATE_REGISTRY_PATH = before;
      registry._resetCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('toolLineProblem', () => {
  test('a plain line passes; a unit word passes only when the tool name has it', () => {
    expect(toolLineProblem('A soil moisture meter reads the water down at the roots.', { name: 'Soil moisture meter' })).toBeNull();
    expect(toolLineProblem('A rain gauge reads to the nearest meter.', { name: 'Rain gauge' })).toMatch(/unit:meter/);
    expect(toolLineProblem('', { name: 'Rain gauge' })).toBe('empty sentence');
  });
});
