// Pest Insider fact bank + identifier species: the data every issue is written from.
const fs = require('fs');
const path = require('path');
const bank = require('../data/pest-insider-facts-v1.json');
const { FACTS, factsForSend, validateBank, sendDateET, LEAD_MIN, LEAD_MAX } = require('../services/pest-insider/facts');
const { bannedReason } = require('../services/pest-insider/claim-check');
const { SPECIES, identifierSpecies } = require('../services/pest-insider/plan');
const { getEntry, listEntries } = require('../services/species-catalog');

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
    expect(() => validateBank({ facts: [{ ...good, quote_sources: [] }] })).toThrow(/quote_sources/);
    expect(() => validateBank({ facts: [{ ...good, quote_sources: good.quotes.map(() => good.sources.length) }] })).toThrow(/quote_sources/);
  });

  test('a main fact carries 2 to 4 reviewed lead sentences; a reserve fact needs none', () => {
    const good = main[0];
    const { lead, ...noLead } = good;
    expect([LEAD_MIN, LEAD_MAX]).toEqual([2, 4]);
    expect(lead.length).toBeGreaterThanOrEqual(LEAD_MIN);
    expect(() => validateBank({ facts: [noLead] })).toThrow(/lead must be 2 to 4 sentences/);
    expect(() => validateBank({ facts: [{ ...good, lead: [lead[0]] }] })).toThrow(/lead must be/);
    expect(() => validateBank({ facts: [{ ...good, lead: [...lead, ...lead] }] })).toThrow(/lead must be/);
    expect(() => validateBank({ facts: [{ ...good, lead: [lead[0], ' '] }] })).toThrow(/lead must be/);
    expect(() => validateBank({ facts: [reserve[0]] })).not.toThrow();
    expect(() => validateBank({ facts: [{ ...reserve[0], lead: ['One line.'] }] })).toThrow(/lead must be/);
  });

  test('every quote names the source it came from; two-publisher facts are split correctly', () => {
    const { attributedQuotes, factById } = require('../services/pest-insider/facts');
    for (const f of bank.facts) expect(f.quote_sources).toHaveLength(f.quotes.length);
    expect(attributedQuotes(factById('M02')).map((q) => q.label)).toEqual(['CDC', 'CDC', 'UF/IFAS', 'UF/IFAS']);
    expect(attributedQuotes(factById('O03')).map((q) => q.label)).toEqual(['Florida law', 'UF/IFAS']);
    expect(attributedQuotes(factById('O02')).map((q) => q.label)).toEqual(['UF/IFAS', 'UF/IFAS', 'WUSF', 'WUSF']);
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

  test('a fact marked for a send-time recheck leads only when the caller names it as rechecked', () => {
    const flagged = bank.facts.filter((f) => f.recheck_before_send).map((f) => f.id);
    expect(flagged).toContain('M01');
    const june = factsForSend('2027-06-03').map((f) => f.id);
    expect(june.filter((id) => flagged.includes(id))).toEqual([]);
    expect(factsForSend('2027-06-03', { recheckedIds: ['M01'] }).map((f) => f.id)).toContain('M01');
  });

  test('a fact past expires_on is dropped, and still valid on the day itself', () => {
    const rechecked = { recheckedIds: ['O04'] }; // O04 is also marked for a send-time recheck
    expect(factsForSend('2027-03-31', rechecked).map((f) => f.id)).toContain('O04');
    expect(factsForSend('2027-04-01', rechecked).map((f) => f.id)).not.toContain('O04');
    expect(FACTS.find((f) => f.id === 'O04').months).not.toContain(4);
  });

  test('refuses a calendar day that does not exist, as a date or a timestamp', () => {
    expect(() => factsForSend('2027-02-30')).toThrow(/not a real calendar date/);
    expect(() => factsForSend('2027-02-30T12:00:00-05:00')).toThrow(/not a real calendar date/);
    expect(() => factsForSend('2026-13-01')).toThrow(/not a real calendar date/);
    expect(factsForSend('2028-02-29').length).toBeGreaterThan(0);
  });

  test('a timestamp with no offset is Eastern wall-clock time; Z or an offset is an instant', () => {
    expect(sendDateET('2026-12-01T01:00:00')).toBe('2026-12-01');
    expect(sendDateET('2026-12-01 23:30')).toBe('2026-12-01');
    expect(sendDateET('2026-12-01T01:00:00Z')).toBe('2026-11-30');
    expect(sendDateET('2026-12-01T01:00:00-05:00')).toBe('2026-12-01');
    expect(sendDateET(' 2026-12-03 ')).toBe('2026-12-03');
    for (const bad of ['December 3, 2026', '12/03/2026', '2026-12-03T25', '2026-12-03T25:99', '2026-12-03T24:00', '2026-12-03T12:60', '2026-12-03T12:00+25:00', '', null, 20261203]) {
      expect(() => sendDateET(bad)).toThrow(/sendDate must be/);
    }
    expect(() => sendDateET(new Date('nope'))).toThrow(/not a valid date/);
  });

  test('uses the ET calendar date of a Date, not UTC', () => {
    // 2026-12-01 02:00 UTC is still November 30 in Eastern time.
    const ids = factsForSend(new Date('2026-12-01T02:00:00Z')).map((f) => f.id);
    expect(ids).toEqual(factsForSend('2026-11-30').map((f) => f.id));
  });
});

describe('identifier species (the portal species catalog)', () => {
  test("every species is an approved catalog entry with a pest identifier page, printed in the catalog's reviewed words", () => {
    expect(SPECIES.length).toBeGreaterThanOrEqual(60);
    for (const s of SPECIES) {
      const entry = getEntry(s.slug);
      expect(entry.links.site_page).toBe(`/pest-identifier/${s.slug}/`);
      expect(s).toEqual({ slug: entry.slug, name: entry.common_name, category: entry.site_category, fact: entry.copy.fact, note: entry.copy.blurb });
    }
  });

  test('an entry whose reviewed copy changed after approval, or with no identifier page, is left out', () => {
    const entry = getEntry('wolf-spider');
    const edited = { ...entry, copy: { ...entry.copy, fact: "It's the only spider that does this." } };
    const noPage = { ...getEntry('ghost-ant'), links: { ...getEntry('ghost-ant').links, site_page: null } };
    expect(identifierSpecies([entry, edited, noPage]).map((s) => s.fact)).toEqual([entry.copy.fact]);
    expect(() => identifierSpecies(listEntries().filter((e) => !e.links.site_page))).toThrow(/no approved identifier species/);
  });

  test('the species facts pass the banned-word check (notes carry advice and are not restated)', () => {
    for (const s of SPECIES) expect({ slug: s.slug, hit: bannedReason(s.fact) }).toEqual({ slug: s.slug, hit: null });
  });
});
