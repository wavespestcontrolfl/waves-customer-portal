/**
 * Technician visibility audit B3 (owner ruling 2026-11-04): the daily KB sync
 * writes no "Best Price: $X (<vendor>)" line into a product article. A row the
 * old sync wrote is rewritten (its content changed) on the next run.
 */
const mockInserts = [];
const mockUpdates = [];
let mockExistingProductRow = null;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/pricing-engine', () => ({ syncConstantsFromDB: jest.fn(async () => false), constants: {} }));
jest.mock('../models/db', () => jest.fn((table) => {
  const qb = {
    where() { return qb; },
    orWhere() { return qb; },
    orderBy() { return table === 'products_catalog' ? Promise.resolve([{
      name: 'Sample Herbicide', active: true, active_ingredient: 'Sampleazole', default_rate: '2', default_unit: 'oz',
      best_price: '139.50', best_vendor: 'Test Vendor', signal_word: 'Caution', category: 'herbicide',
    }]) : Promise.reject(new Error('not in this test')); },
    first() { return Promise.resolve(table === 'knowledge_base' ? mockExistingProductRow : undefined); },
    insert(row) { mockInserts.push({ table, row }); return Promise.resolve(); },
    update(row) { mockUpdates.push({ table, row }); return Promise.resolve(1); },
  };
  return qb;
}));

const KBService = require('../services/knowledge-base');

beforeEach(() => { mockInserts.length = 0; mockUpdates.length = 0; mockExistingProductRow = null; });

test('a new product article carries the label facts and no vendor price line', async () => {
  await KBService.autoSync();
  const product = mockInserts.find((i) => i.row.slug === 'product-sample-herbicide');
  expect(product.row.category).toBe('chemicals');
  expect(product.row.content).toContain('Default Rate: 2 oz');
  expect(product.row.content).toContain('Signal Word: Caution');
  expect(product.row.content).not.toMatch(/Best Price|Test Vendor|139\.50/);
});

test('an article the old sync wrote with a Best Price line is rewritten without it', async () => {
  mockExistingProductRow = {
    id: 7, slug: 'product-sample-herbicide', path: 'kb/chemicals/product-sample-herbicide.md', title: 'Sample Herbicide',
    category: 'chemicals', tags: '[]',
    content: '**Sample Herbicide**\nBest Price: $139.50 (Test Vendor)\nSignal Word: Caution',
  };
  await KBService.autoSync();
  const update = mockUpdates.find((u) => u.table === 'knowledge_base');
  expect(update.row.content).not.toMatch(/Best Price|Test Vendor/);
});
