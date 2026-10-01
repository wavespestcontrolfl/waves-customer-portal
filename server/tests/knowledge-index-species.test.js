/**
 * Species-catalog corpora in the knowledge index: the customer/staff split,
 * the approval gate, and the catalog-first pin in hybrid search.
 */
jest.mock('../models/db', () => jest.fn());

const catalog = require('../services/species-catalog');
const { isApproved } = require('../services/species-catalog-approval');
const { CONNECTORS, loadCorpus } = require('../services/knowledge-index/connectors');
const { catalogPinKeys, pinFirst } = require('../services/knowledge-index/hybrid-search');

const connector = (source) => CONNECTORS.find((c) => c.source === source);

describe('species connectors', () => {
  let customer;
  let staff;
  beforeAll(async () => {
    customer = await loadCorpus(connector('species'));
    staff = await loadCorpus(connector('species_tech'));
  });

  test('both corpora are registered', () => {
    expect(connector('species')).toBeTruthy();
    expect(connector('species_tech')).toBeTruthy();
  });

  test('only approved entries are indexed', () => {
    const approved = new Set(catalog.listEntries().filter(isApproved).map((e) => e.slug));
    const drafts = catalog.listEntries().filter((e) => !isApproved(e));
    expect(drafts.length).toBeGreaterThan(0); // the gate is exercised
    expect(customer.length).toBe(approved.size);
    for (const doc of [...customer, ...staff]) expect(approved.has(doc.sourceId)).toBe(true);
    for (const draft of drafts) expect(customer.some((d) => d.sourceId === draft.slug)).toBe(false);
  });

  test('customer docs never carry tech notes', () => {
    const withNotes = catalog.listEntries().filter((e) => isApproved(e) && String(e.tech_notes || '').trim().length > 40);
    expect(withNotes.length).toBeGreaterThan(0);
    const bySlug = new Map(customer.map((d) => [d.sourceId, d]));
    for (const e of withNotes) {
      const doc = bySlug.get(e.slug);
      expect(doc.content).not.toContain(e.tech_notes.trim());
      expect(doc.content).not.toMatch(/Tech notes:/);
      expect(doc.metadata.audience).toBe('customer');
    }
  });

  test('staff docs carry the tech notes and citations', () => {
    const doc = staff.find((d) => d.sourceId === 'spiraling-whitefly');
    expect(doc.content).toContain(catalog.getEntry('spiraling-whitefly').tech_notes);
    expect(doc.content).toMatch(/ask\.ifas\.ufl\.edu/);
    expect(doc.metadata.audience).toBe('staff');
  });

  test('customer doc renders the approved copy, season and sources', () => {
    const entry = catalog.getEntry('spiraling-whitefly');
    const doc = customer.find((d) => d.sourceId === 'spiraling-whitefly');
    expect(doc.title).toBe(`${entry.common_name} (${entry.scientific_name})`);
    expect(doc.content).toContain(entry.copy.what_it_means);
    expect(doc.content).toMatch(/Active: year-round; peak May/);
    expect(doc.metadata.sources).toEqual(entry.sources);
  });
});

describe('catalog-first pin', () => {
  test('a query naming one entry pins its docs', () => {
    expect(catalogPinKeys('what do I spray for large patch in October')).toEqual(['species:large-patch', 'species_tech:large-patch']);
  });

  test('a group-level or unknown name pins nothing', () => {
    expect(catalogPinKeys('chinch bugs')).toEqual([]);
    expect(catalogPinKeys('how much product per gallon')).toEqual([]);
  });

  test('pinFirst is stable and leaves unpinned order alone', () => {
    const docs = [{ key: 'kb:a' }, { key: 'species_tech:x' }, { key: 'wiki:b' }, { key: 'species:x' }];
    expect(pinFirst(docs, ['species:x', 'species_tech:x']).map((d) => d.key))
      .toEqual(['species_tech:x', 'species:x', 'kb:a', 'wiki:b']);
    expect(pinFirst(docs, [])).toBe(docs);
  });
});
