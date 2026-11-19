// Pest Insider fact bank + identifier snapshot: the data every issue is written from.
const fs = require('fs');
const path = require('path');
const bank = require('../data/pest-insider-facts-v1.json');
const snapshot = require('../data/pest-identifier-species-v1.json');
const { FACTS, factsForSend, validateBank } = require('../services/pest-insider/facts');
const { bannedReason } = require('../services/pest-insider/claim-check');
const { SPECIES } = require('../services/pest-insider/plan');

const SERVICES = ['pest', 'lawn', 'tree_shrub', 'mosquito', 'termite', 'rodent'];

describe('fact bank', () => {
  const main = bank.facts.filter((f) => !f.reserve);
  const reserve = bank.facts.filter((f) => f.reserve);

  test('holds 40 main facts and 11 reserve facts with unique ids', () => {
    expect(main).toHaveLength(40);
    expect(reserve).toHaveLength(11);
    expect(new Set(bank.facts.map((f) => f.id)).size).toBe(bank.facts.length);
  });

  test.each(bank.facts.map((f) => [f.id, f]))('%s is a complete entry', (_id, f) => {
    expect(f.title.trim()).not.toBe('');
    expect(f.statement.trim()).not.toBe('');
    expect(f.quotes.length).toBeGreaterThan(0);
    f.quotes.forEach((q) => expect(q.trim()).not.toBe(''));
    expect(f.months.length).toBeGreaterThan(0);
    f.months.forEach((m) => expect(Number.isInteger(m) && m >= 1 && m <= 12).toBe(true));
    expect(SERVICES).toContain(f.service);
    expect(['pest', 'plant', 'rule']).toContain(f.kind);
    expect(['high', 'medium']).toContain(f.confidence);
    expect(f.sources.length).toBeGreaterThan(0);
    f.sources.forEach((s) => {
      expect(s.publisher && s.title && s.url && s.date_text).toBeTruthy();
      expect(s.url).toMatch(/^https?:\/\//);
      expect(s).toHaveProperty('pub_id');
    });
  });

  test('no banned word in any statement or title (quotes are source text and may differ)', () => {
    for (const f of bank.facts) {
      expect({ id: f.id, hit: bannedReason(f.statement) }).toEqual({ id: f.id, hit: null });
      expect({ id: f.id, hit: bannedReason(f.title) }).toEqual({ id: f.id, hit: null });
    }
  });

  test('the six send-time rechecks, the O04 expiry and the O02 scope note are set', () => {
    const flagged = bank.facts.filter((f) => f.recheck_before_send).map((f) => f.id).sort();
    expect(flagged).toEqual(['D02', 'D03', 'L04', 'M01', 'M02', 'O04']);
    expect(bank.facts.find((f) => f.id === 'O04').expires_on).toBe('2027-03-31');
    expect(bank.facts.filter((f) => f.expires_on)).toHaveLength(1);
    expect(bank.facts.find((f) => f.id === 'O02').scope_note).toMatch(/Sarasota County/);
  });

  test('every quote is a verbatim line from the source notes when the notes are on this machine', () => {
    const file = path.join(process.env.HOME || '', 'research_notes/TIL facts for Field Notes/facts.md');
    if (!fs.existsSync(file)) return;
    const flat = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ');
    for (const f of bank.facts) for (const q of f.quotes) expect(flat).toContain(q.replace(/\s+/g, ' '));
  });

  test('validateBank throws on a malformed entry', () => {
    const good = bank.facts[0];
    expect(() => validateBank({ facts: [{ ...good, quotes: [] }] })).toThrow(/quotes/);
    expect(() => validateBank({ facts: [{ ...good, months: [13] }] })).toThrow(/months/);
    expect(() => validateBank({ facts: [{ ...good, service: 'ants' }] })).toThrow(/service/);
    expect(() => validateBank({ facts: [good, good] })).toThrow(/duplicate/);
    expect(() => validateBank({ facts: [] })).toThrow(/no facts/);
  });
});

describe('factsForSend', () => {
  test('drops reserve facts, other months and recent ids; orders pest, then high, then id', () => {
    const list = factsForSend('2026-12-03');
    expect(list.length).toBeGreaterThan(5);
    expect(list.every((f) => !f.reserve && f.months.includes(12))).toBe(true);
    const keys = list.map((f) => [f.kind === 'pest' ? 0 : 1, f.confidence === 'high' ? 0 : 1, f.id]);
    expect(keys).toEqual([...keys].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || a[2].localeCompare(b[2])));
    expect(list.map((f) => f.id)).not.toContain('L12'); // January only
    const [first] = list;
    expect(factsForSend('2026-12-03', { excludeIds: [first.id] }).map((f) => f.id)).not.toContain(first.id);
  });

  test('a fact past expires_on is dropped, and still valid on the day itself', () => {
    expect(factsForSend('2027-03-31').map((f) => f.id)).toContain('O04');
    expect(factsForSend('2027-04-01').map((f) => f.id)).not.toContain('O04');
    expect(FACTS.find((f) => f.id === 'O04').months).not.toContain(4);
  });

  test('uses the ET calendar date of a Date, not UTC', () => {
    // 2026-12-01 02:00 UTC is still November 30 in Eastern time.
    const ids = factsForSend(new Date('2026-12-01T02:00:00Z')).map((f) => f.id);
    expect(ids).toEqual(factsForSend('2026-11-30').map((f) => f.id));
  });
});

describe('identifier species snapshot', () => {
  test('names its astro source file and commit', () => {
    expect(snapshot.source_file).toBe('src/data/pestIdentifier.ts');
    expect(snapshot.source_commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test('every entry has the copied fields and a usable slug', () => {
    expect(SPECIES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(SPECIES.map((s) => s.slug)).size).toBe(SPECIES.length);
    for (const s of SPECIES) {
      expect(s.slug).toMatch(/^[a-z0-9-]+$/);
      ['name', 'category', 'fact', 'note'].forEach((k) => expect(s[k].trim()).not.toBe(''));
      expect(['ally', 'harmless', 'watch', 'call']).toContain(s.verdict);
      expect(Array.isArray(s.looks) && Array.isArray(s.where)).toBe(true);
    }
  });

  test('the species facts pass the banned-word check (notes carry advice and are not restated)', () => {
    for (const s of SPECIES) expect({ slug: s.slug, hit: bannedReason(s.fact) }).toEqual({ slug: s.slug, hit: null });
  });
});
