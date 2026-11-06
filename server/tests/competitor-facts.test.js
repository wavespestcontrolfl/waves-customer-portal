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

  test('owner autopublish list: the seventeen approved companies under every approved spelling, nobody else (rulings 2026-09-27 D2 + 2026-09-28, Aptive + Truly Nolen added 2026-09-28, All U Need and eight more added 2026-11-05)', () => {
    for (const name of ['Orkin', 'Terminix', 'HomeTeam', 'HomeTeam Pest Defense', 'TAEXX', 'Turner', 'Turner Pest Control', 'Massey', 'Massey Services', 'TruGreen', 'Aptive', 'Aptive Environmental', 'Aptive Pest Control', 'goaptive', 'Truly Nolen',
      'All U Need Pest Control', 'All "U" Need Pest Control', 'All “U” Need Pest Control', 'All U Need Pest', 'All U Need', 'All U Need Pest Control, LLC',
      // Owner 2026-11-05: eight more companies.
      'Prodigy Pest Solutions', 'Prodigy Pest', 'Greenhouse Termite & Pest Control', 'Greenhouse Termite and Pest Control',
      'Good News Pest Solutions', 'Good News Pest', "Keller's Pest Control", 'Kellers Pest Control', "Keller's Pest",
      'Arrow Environmental', 'Arrow Environmental Services', 'Hughes Exterminators', 'Hughes Pest Control',
      'Farrow Pest Services', 'Farrow Pest', 'Farrow Pest Control',
      "Westfall's Lawn and Pest Control", "Westfall's Lawn & Pest Control", "Westfall's Pest Control", 'Westfalls Pest Control',
      'Westfalls Lawn and Pest Control, LLC']) {
      expect(cf.isOwnerApprovedForAutopublish(name)).toBe(true);
    }
    // Curated records that stay off the list (EcoShield, Rodent Solutions) and
    // detection-only brands (Hulett, Hawx) are never approved.
    for (const name of ['EcoShield Pest Solutions', 'EcoShield', 'Rodent Solutions Inc', 'Rodent Solutions', 'Hulett', 'Hawx', 'Westfall', 'Arrow Exterminators']) {
      expect(cf.isOwnerApprovedForAutopublish(name)).toBe(false);
    }
    expect(cf.findBusinessMentions('HomeTeam installs TAEXX tubes.').map((m) => m.name)).toEqual(['HomeTeam Pest Defense']);
    // Lowercase "hometeam" / "home team" / "turner" stay ordinary prose.
    expect(cf.findBusinessMentions('Cheer for the home team; hometeam spirit; a pancake turner.')).toEqual([]);
    expect(cf.findBusinessMentions('Turner runs its plan under TurnerGuard.').map((m) => m.name)).toEqual(['Turner Pest Control']);
    // All U Need (owner 2026-11-05): bare brand is case-sensitive prose only.
    expect(cf.findBusinessMentions('All U Need offers recurring plans.').map((m) => m.name)).toEqual(['All U Need Pest Control']);
    expect(cf.findBusinessMentions('Everything all u need to know about ants.')).toEqual([]);
    expect(cf.OWNER_APPROVED_AUTOPUBLISH_IDS).toHaveLength(17);
    expect(cf.OWNER_APPROVED_AUTOPUBLISH_IDS).toEqual(expect.arrayContaining([
      'all-u-need-pest', 'prodigy-pest', 'greenhouse-pest', 'good-news-pest', 'kellers-pest',
      'arrow-environmental', 'hughes-exterminators', 'farrow-pest', 'westfalls-lawn-pest',
    ]));
    expect(cf.OWNER_APPROVED_AUTOPUBLISH_IDS).not.toContain('ecoshield-pest');
    expect(cf.OWNER_APPROVED_AUTOPUBLISH_IDS).not.toContain('rodent-solutions');
    // Every approved id is a real record (a typo would silently approve nobody).
    for (const id of cf.OWNER_APPROVED_AUTOPUBLISH_IDS) expect(cf.COMPETITORS.some((c) => c.id === id)).toBe(true);
  });

  test("Westfall's Lawn and Pest Control: curated record sourced from its own site, full-name spellings only (owner 2026-11-05)", () => {
    const rec = cf.findCompetitor("Westfall's Lawn and Pest Control");
    expect(rec).toMatchObject({ id: 'westfalls-lawn-pest', name: "Westfall's Lawn and Pest Control" });
    for (const a of Object.values(rec.attributes)) {
      expect(a.source).toMatch(/^https:\/\/www\.westfallspestcontrol\.com\//);
      expect(a.asOf).toBe('2026-11-05');
    }
    for (const text of [
      "Westfall's Lawn and Pest offers monthly plans.",
      "Westfall's Lawn & Pest Control offers monthly plans.",
      "Westfall's Pest Control offers monthly plans.",
      'Westfalls Pest Control offers monthly plans.',
      'Westfall’s Pest Control offers monthly plans.', // curly apostrophe
      'WESTFALL\'S PEST CONTROL offers monthly plans.',
    ]) {
      expect(cf.findBusinessMentions(text)).toEqual([{ name: "Westfall's Lawn and Pest Control", inAllowlist: true }]);
    }
    // A surname, a road, or another business with the same surname is not the company.
    for (const text of [
      'The Westfall family called today about ants.',
      'Turn left on Westfall Road.',
      "Mr. Westfall's yard has chinch bugs.",
      "Westfall's Plumbing fixed the leak.",
      'westfall pest.',
    ]) {
      expect(cf.findBusinessMentions(text)).toEqual([]);
    }
    expect(cf.isOwnerApprovedForAutopublish('Westfall')).toBe(false);
    expect(cf.isOwnerApprovedForAutopublish("Westfall's")).toBe(false);
  });

  test('the newly approved companies are detected by name and approved (owner 2026-11-05)', () => {
    const pairs = [
      ['Prodigy Pest Solutions', 'Prodigy Pest Solutions'],
      ['Greenhouse Termite & Pest Control', 'Greenhouse Termite & Pest Control'],
      ['Good News Pest Solutions', 'Good News Pest Solutions'],
      ["Keller's Pest Control", "Keller's Pest Control"],
      ['Arrow Environmental', 'Arrow Environmental'],
      ['Hughes Exterminators', 'Hughes Exterminators'],
      ['Farrow Pest Services', 'Farrow Pest Services'],
    ];
    for (const [text, canonical] of pairs) {
      expect(cf.findBusinessMentions(`${text} offers recurring plans.`)).toEqual([{ name: canonical, inAllowlist: true }]);
      expect(cf.isOwnerApprovedForAutopublish(canonical)).toBe(true);
    }
    // Approval did not widen detection: bare surnames and generic phrases stay prose.
    expect(cf.findBusinessMentions('The Hughes family called today.')).toEqual([]);
    expect(cf.findBusinessMentions('Compare greenhouse pest control options.')).toEqual([]);
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
