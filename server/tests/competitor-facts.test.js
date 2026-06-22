const cf = require('../services/content/competitor-facts');

describe('competitor-facts', () => {
  test('allowlisted names + aliases resolve to a record', () => {
    expect(cf.isKnownCompetitor('Orkin')).toBe(true);
    expect(cf.isKnownCompetitor('orkin pest control')).toBe(true);
    expect(cf.isKnownCompetitor('Massey')).toBe(true); // alias of Massey Services
    expect(cf.findCompetitor('Truly Nolen')?.id).toBe('truly-nolen');
  });

  test('owner-supplied local/FL competitors are allowlisted with reach + recurring', () => {
    for (const [name, id] of [
      ['Prodigy Pest Solutions', 'prodigy-pest'],
      ["Keller's Pest Control", 'kellers-pest'],
      ['All U Need Pest Control', 'all-u-need-pest'],
      ['Arrow Environmental', 'arrow-environmental'],
      ['Farrow Pest Services', 'farrow-pest'],
      ['Rodent Solutions Inc', 'rodent-solutions'],
      ['Turner Pest Control', 'turner-pest'],
      ['Good News Pest Solutions', 'good-news-pest'],
      ['HomeTeam Pest Defense', 'hometeam-pest-defense'],
      ['EcoShield Pest Solutions', 'ecoshield-pest'],
      ['Greenhouse Termite & Pest Control', 'greenhouse-pest'],
      ['Hughes Exterminators', 'hughes-exterminators'],
    ]) {
      const rec = cf.findCompetitor(name);
      expect(rec?.id).toBe(id);
      expect(cf.attributeValues(name).length).toBeGreaterThanOrEqual(2); // reach + recurring
    }
    // alias resolution
    expect(cf.findCompetitor('prodigy pest')?.id).toBe('prodigy-pest');
    expect(cf.findCompetitor('hometeam pest')?.id).toBe('hometeam-pest-defense');
  });

  test('bare generic single-word aliases do NOT false-match; smart-quote spellings DO', () => {
    // generic words are not competitor mentions
    expect(cf.findBusinessMentions("you don't have to be a prodigy to spot ants").some((m) => /Prodigy/.test(m.name))).toBe(false);
    expect(cf.findBusinessMentions('the Hughes family called today').some((m) => /Hughes/.test(m.name))).toBe(false);
    // but the actual business name still matches
    expect(cf.findBusinessMentions('we use Prodigy Pest for the office').some((m) => m.inAllowlist && /Prodigy/.test(m.name))).toBe(true);
    // curly-quote stylized spelling matches the allowlisted entry
    expect(cf.findBusinessMentions('compared with All “U” Need Pest Control').some((m) => m.inAllowlist && /All U Need/.test(m.name))).toBe(true);
  });

  test('case-sensitive aliasesCS: capitalized "Rodent Solutions" is a competitor; lower-case generic copy is not', () => {
    // The brand is built from otherwise-generic words, so it is detected only
    // when capitalized. Normalized lookups stay case-insensitive...
    expect(cf.findCompetitor('Rodent Solutions')?.id).toBe('rodent-solutions');
    expect(cf.isKnownCompetitor('Rodent Solutions')).toBe(true);
    // ...but free-text detection requires the capitalized brand form.
    expect(cf.findBusinessMentions('We compared with Rodent Solutions in Venice.')
      .some((m) => m.inAllowlist && m.name === 'Rodent Solutions Inc')).toBe(true);
    expect(cf.findBusinessMentions('compare rodent solutions before choosing a plan.')).toHaveLength(0);
  });

  test('a non-allowlisted business is not known', () => {
    expect(cf.isKnownCompetitor('Hulett')).toBe(false); // detectable signal, not allowlisted
    expect(cf.isKnownCompetitor('Some Random LLC')).toBe(false);
    expect(cf.findCompetitor('Hulett')).toBeNull();
  });

  test('findBusinessMentions flags allowlist vs unlisted businesses', () => {
    const text = 'We compared Orkin and Hulett for SWFL homes.';
    const mentions = cf.findBusinessMentions(text);
    const orkin = mentions.find((m) => m.name === 'Orkin');
    const hulett = mentions.find((m) => m.name === 'Hulett');
    expect(orkin?.inAllowlist).toBe(true);
    expect(hulett?.inAllowlist).toBe(false);
  });

  test('a longer business name shadows the shorter name it contains', () => {
    const mentions = cf.findBusinessMentions('Massey Services treats lawns.');
    // "Massey Services" matched as one business, not also bare "Massey".
    expect(mentions).toHaveLength(1);
    expect(mentions[0].name).toBe('Massey Services');
    expect(mentions[0].inAllowlist).toBe(true);
  });

  test('does not flag our own brand or generic category labels', () => {
    expect(cf.findBusinessMentions('Waves Pest Control vs a national chain or DIY')).toHaveLength(0);
    expect(cf.findBusinessMentions('Local SWFL company vs National chain')).toHaveLength(0);
  });

  test('listForPrompt returns name + attributes with source + as_of', () => {
    const list = cf.listForPrompt();
    expect(list.length).toBeGreaterThan(0);
    const orkin = list.find((c) => c.name === 'Orkin');
    expect(orkin.attributes.reach.value).toMatch(/National/);
    expect(orkin.attributes.reach.source).toMatch(/orkin\.com/);
    expect(orkin.attributes.reach.as_of).toBeTruthy();
  });
});
