// search_knowledge_base: a product page keeps its label rate exactly as the
// catalog states it for every other reader (an admin workflow such as Agent
// Estimate passes an empty context), but a technician's search (a tech
// context with techId) leaves out one in mL (owner ruling: nothing a tech
// reads is in mL).

let mockKbRows = [];
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/knowledge-bridge', () => ({
  unifiedSearch: jest.fn(async () => ({
    claudeopedia: mockKbRows.map((row) => ({ id: row.id, title: row.title, category: row.category || 'chemicals' })),
    wiki: [],
  })),
}));
jest.mock('../models/db', () => jest.fn((table) => ({
  whereIn: () => ({
    select: () => Promise.resolve(table === 'knowledge_base' ? mockKbRows : []),
  }),
})));

const { executeTechTool } = require('../services/intelligence-bar/tech-tools');

function productPage(rateLine) {
  return [
    '**Sample Kelp**',
    'Active Ingredient: Seaweed extract',
    'Container: 1 gal',
    rateLine,
    'Signal Word: Caution',
  ].join('\n');
}

const TECH = { techId: 'tech-1', techName: null };

async function snippets(context = TECH) {
  const { results } = await executeTechTool('search_knowledge_base', { query: 'kelp' }, context);
  return results.map((r) => r.snippet);
}

describe('search_knowledge_base leaves an mL label rate out of a tech answer', () => {
  test('an mL "Default Rate" line is dropped; the rest of the page stays', async () => {
    mockKbRows = [{ id: 1, title: 'Sample Kelp', content: productPage('Default Rate: 5-10 ml/gal') }];
    const [snippet] = await snippets();
    expect(snippet).not.toMatch(/\bml\b/i);
    expect(snippet).not.toContain('Default Rate');
    expect(snippet).toBe('**Sample Kelp**\nActive Ingredient: Seaweed extract\nContainer: 1 gal\nSignal Word: Caution');
  });

  test('every mL form of the unit is caught', async () => {
    mockKbRows = [
      { id: 1, title: 'A', content: productPage('Default Rate: 1-6 ml/inch dbh') },
      { id: 2, title: 'B', content: productPage('Default Rate: 30 ml') },
      { id: 3, title: 'C', content: productPage('Default Rate: 5 - 10 mL/gal') },
    ];
    for (const snippet of await snippets()) expect(snippet).not.toMatch(/\bml\b/i);
  });

  test('any other label rate, and a container size in mL, read exactly as stored', async () => {
    const content = productPage('Default Rate: 0.2-0.8 fl_oz/gal').replace('Container: 1 gal', 'Container: 250 ml');
    mockKbRows = [{ id: 1, title: 'Sample Kelp', content }];
    const [snippet] = await snippets();
    expect(snippet).toBe(content);
  });

  test('the snippet is still the first 300 characters of the page', async () => {
    const content = `Default Rate: 5-10 ml/gal\n${'🐝 pollinator note. '.repeat(40)}`;
    mockKbRows = [{ id: 1, title: 'Long', content }];
    const [snippet] = await snippets();
    expect(Array.from(snippet)).toHaveLength(300);
    expect(snippet.startsWith('🐝 pollinator note.')).toBe(true);
  });

  test('a page with no content has no snippet', async () => {
    mockKbRows = [{ id: 1, title: 'Empty', content: null }];
    expect(await snippets()).toEqual([null]);
  });

  test('an admin workflow reads the page exactly as stored, mL label rate included', async () => {
    const content = productPage('Default Rate: 5-10 ml/gal');
    mockKbRows = [{ id: 1, title: 'Sample Kelp', content }];
    expect(await snippets({})).toEqual([content]);
  });

  test('a protocol page reads up to 2,500 characters, so its visit steps reach the answer', async () => {
    const steps = Array.from({ length: 40 }, (_, i) => `Visit ${i + 1}: treat the perimeter band.`).join('\n');
    const content = `**Pest Control Protocol**\n${steps}`;
    mockKbRows = [
      { id: 1, title: 'Pest Control Protocol', category: 'protocols', content },
      { id: 2, title: 'Sample Kelp', content: `${'kelp note. '.repeat(60)}` },
    ];
    const [protocol, product] = await snippets();
    expect(content.length).toBeGreaterThan(300);
    expect(content.length).toBeLessThan(2500);
    expect(protocol).toBe(content);
    expect(Array.from(product)).toHaveLength(300);
  });

  test('a protocol page longer than 2,500 characters is cut at 2,500', async () => {
    mockKbRows = [{ id: 1, title: 'Lawn', category: 'protocols', content: 'x'.repeat(4000) }];
    const [snippet] = await snippets();
    expect(snippet).toHaveLength(2500);
  });
});
