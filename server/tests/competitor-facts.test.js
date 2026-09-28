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

  test('legal-suffix normalization strips ONLY true legal-entity suffixes, never a descriptive word (#5146 r9)', () => {
    // Direction 1: a true legal suffix still resolves to the curated record.
    for (const [name, id] of [
      ['Orkin, LLC', 'orkin'],
      ['Massey Services, Inc.', 'massey-services'],
      ['Massey Services Incorporated', 'massey-services'],
      ['HomeTeam Pest Defense, Inc.', 'hometeam-pest-defense'],
      ['Turner Pest Control Corp', 'turner-pest'],
      ['Turner Pest Control Corporation', 'turner-pest'],
      ['Turner Pest Control Co', 'turner-pest'],
      ['Turner Pest Control Company', 'turner-pest'],
      ['Turner Pest Control Ltd', 'turner-pest'],
      ['Turner Pest Control LP', 'turner-pest'],
      ['Turner Pest Control LLP', 'turner-pest'],
      ['Turner Pest Control PLLC', 'turner-pest'],
      // Dotted forms normalize to one-letter words and must rejoin.
      ['Orkin, L.L.C.', 'orkin'],
      ['Turner Pest Control, P.L.L.C.', 'turner-pest'],
      ['Turner Pest Control L.P.', 'turner-pest'],
      ['Massey Services Co. L.L.C.', 'massey-services'],
    ]) {
      expect(cf.findCompetitor(name)?.id).toBe(id);
    }
    // A one-letter run that spells no legal suffix is left alone.
    expect(cf.findCompetitor('Orkin S.W.F.L.')).toBeNull();
    // Direction 2: a descriptive word must NOT be stripped — an unrelated
    // off-list company sharing an approved short prefix reads as unknown,
    // never as the approved record ("Turner Services LLC" is not Turner
    // Pest Control; "HomeTeam Services LLC" is not HomeTeam Pest Defense).
    for (const name of [
      'Turner Services LLC', 'Turner Services', 'Turner Global', 'Turner Group',
      'Turner Holdings', 'Turner Holdings LLC', 'The Turner Company',
      'HomeTeam Services LLC', 'HomeTeam Services', 'HomeTeam Group',
    ]) {
      expect(cf.findCompetitor(name)).toBeNull();
      expect(cf.isKnownCompetitor(name)).toBe(false);
    }
  });

  test('a real legal-name variant needing a descriptive word is a curated alias, not suffix-stripped (#5146 r9)', () => {
    expect(cf.findCompetitor('Terminix Global Holdings')?.id).toBe('terminix');
    expect(cf.isOwnerApprovedForAutopublish('Terminix Global Holdings')).toBe(true);
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

  test('owner autopublish list: the eight approved companies under every approved spelling, nobody else (rulings 2026-09-27 D2 + 2026-09-28, Aptive + Truly Nolen added 2026-09-28)', () => {
    for (const name of ['Orkin', 'Terminix', 'HomeTeam', 'HomeTeam Pest Defense', 'TAEXX', 'Turner', 'Turner Pest Control', 'Massey', 'Massey Services', 'TruGreen', 'Aptive', 'Aptive Environmental', 'Aptive Pest Control', 'goaptive', 'Truly Nolen']) {
      expect(cf.isOwnerApprovedForAutopublish(name)).toBe(true);
    }
    for (const name of ['Keller\'s Pest Control', 'Hughes Exterminators', 'Hulett', 'Hawx']) {
      expect(cf.isOwnerApprovedForAutopublish(name)).toBe(false);
    }
    expect(cf.findBusinessMentions('HomeTeam installs TAEXX tubes.').map((m) => m.name)).toEqual(['HomeTeam Pest Defense']);
    // Lowercase "hometeam" / "home team" / "turner" stay ordinary prose.
    expect(cf.findBusinessMentions('Cheer for the home team; hometeam spirit; a pancake turner.')).toEqual([]);
    expect(cf.findBusinessMentions('Turner runs its plan under TurnerGuard.').map((m) => m.name)).toEqual(['Turner Pest Control']);
  });

  test('Aptive has a curated record sourced from its own site (aptivepestcontrol.com — aptive.com is an unrelated company)', () => {
    const rec = cf.findCompetitor('Aptive');
    expect(rec).toMatchObject({ id: 'aptive', name: 'Aptive Environmental', hosts: ['aptivepestcontrol.com', 'goaptive.com'] });
    expect(rec.hosts).not.toContain('aptive.com');
    for (const a of Object.values(rec.attributes)) {
      expect(a.source).toMatch(/^https:\/\/aptivepestcontrol\.com\//);
      expect(a.asOf).toBe('2026-09-28');
    }
  });
});
