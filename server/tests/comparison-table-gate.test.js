const gate = require('../services/content/comparison-table-gate');

const wrap = (component) => ({ body: `# A buyer's guide\n\nSome intro prose.\n\n${component}\n\nClosing prose.` });

const CATEGORY_TABLE = `<ComparisonTable
  columns={["What to weigh","National chain","Local SWFL company","DIY"]}
  rows={[
    { label: "Licensed & insured", values: ["Usually","Verify each","N/A"] },
    { label: "Knows SWFL pests & soil", values: ["Generic playbook","Yes","No"] },
    { label: "Re-treat guarantee", values: ["Varies","Common","None"] },
    { label: "Cost", values: ["$$","Quote-based","Lowest upfront"] }
  ]}
  highlight={1}
  caption="Trade-offs to weigh when choosing pest control in Venice." />`;

describe('comparison-table-gate', () => {
  test('a draft with no comparison table passes untouched', () => {
    const r = gate.evaluate({ body: '# Just a blog\n\nNo tables here, just prose about ghost ants.' }, {});
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  test('a neutral CATEGORY comparison passes', () => {
    const r = gate.evaluate(wrap(CATEGORY_TABLE), { namedCompetitorEnabled: false });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  test('disparaging language is a P0 block', () => {
    const t = CATEGORY_TABLE.replace('Generic playbook', 'Overpriced and unreliable');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('a self-declared ranking ("the best") is a P1 block', () => {
    const t = CATEGORY_TABLE.replace('Trade-offs to weigh when choosing pest control in Venice.', 'Why we are the best choice in Venice.');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING' && f.severity === 'P1')).toBe(true);
  });

  test('legitimate pest vocab ("garbage") does NOT trip disparagement', () => {
    const t = CATEGORY_TABLE.replace('Generic playbook', 'Store garbage in sealed bins');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('a negative reliability claim about an option in a table routes to review (P1)', () => {
    const t = CATEGORY_TABLE.replace('Generic playbook', 'Unreliable follow-ups');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY' && f.severity === 'P1')).toBe(true);
    expect(r.findings.some((f) => f.severity === 'P0')).toBe(false);
  });

  test('the same "unreliable" used as efficacy PROSE (no table) is NOT flagged', () => {
    const r = gate.evaluate({ body: 'DIY sprays are unreliable on subterranean termites; a pro re-treats.' }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  test('a recognized competitor named in PROSE (outside the table) is caught', () => {
    const body = `Homeowners often compare us with Hulett before choosing.\n\n${CATEGORY_TABLE}`;
    const r = gate.evaluate({ body }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNKNOWN_COMPETITOR' && f.severity === 'P0')).toBe(true);
  });

  test('educational species-comparison headers are NOT phantom businesses (prod 2026-07 false positives)', () => {
    const t = `<ComparisonTable
  columns={["Feature","Real Brown Recluse","Southern House Spider (common SWFL lookalike)"]}
  rows={[
    { label: "Violin marking", values: ["Distinct","Faint or absent"] },
    { label: "Eye pattern", values: ["6 eyes in pairs","8 eyes"] }
  ]}
  caption="How to tell a brown recluse from its most common SWFL lookalike." />`;
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: false });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('generic attribute/question headers ("Type", "Typical protection", "Kid-safe?") are not businesses', () => {
    const t = `<ComparisonTable
  columns={["Bait station","Type","Typical protection","Kid-safe?"]}
  rows={[
    { label: "Placement", values: ["Indoor","Perimeter","Locked housing"] }
  ]}
  caption="Choosing a bait station." />`;
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: false });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('a DIY-method header ("Bleach + Google") is not a business; a business-shaped one in the same table still is', () => {
    const clean = `<ComparisonTable
  columns={["Approach","Bleach + Google","Professional treatment"]}
  rows={[{ label: "Cost", values: ["Low upfront","Quote-based"] }]}
  caption="DIY vs professional German-roach control." />`;
    const r1 = gate.evaluate(wrap(clean), { namedCompetitorEnabled: false });
    expect(r1.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(false);
    expect(r1.pass).toBe(true);

    const withBiz = clean.replace('Professional treatment', 'Gulf Coast Bug Busters');
    const r2 = gate.evaluate(wrap(withBiz), { namedCompetitorEnabled: false });
    expect(r2.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(true);
    expect(r2.pass).toBe(false);
  });

  test('a web-search-style business name (industry suffix, not allowlisted) used as a column fails closed', () => {
    const t = CATEGORY_TABLE.replace('National chain', 'Acme Pest Control');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(true);
  });

  test('generic lawn-care CATEGORY headers are not phantom businesses (Codex round-2 P2)', () => {
    for (const header of ['DIY lawn care', 'Professional lawn care', 'quarterly pest control']) {
      const t = CATEGORY_TABLE.replace('National chain', header);
      const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
      expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(false);
      expect(r.pass).toBe(true);
    }
  });

  test('Title-Cased modifier-led service names read as NAMES and fail closed (Codex round-8 P1)', () => {
    // "National Pest Control" / "May Pest Control" are company-name shapes;
    // the category exemption requires sentence/lower casing. A Title-Cased
    // "DIY Lawn Care" column routes to review too — cheap, reversible.
    for (const header of ['National Pest Control', 'May Pest Control', 'DIY Lawn Care', 'Acme Rodent Removal', 'Acme Pest Treatment']) {
      const t = CATEGORY_TABLE.replace('National chain', header);
      const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
      expect(r.pass).toBe(false);
      expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(true);
    }
  });

  test('suffix-less franchise brands are recognized via the curated signal list (Codex round-2 P1)', () => {
    // Unambiguous brand tokens only. English-word brands ("Lawn Doctor",
    // "Bug Out") are deliberately NOT signals in any casing — see the
    // competitor-facts comment; they false-block title-cased headings.
    for (const brand of ['TruGreen', 'Mosquito Joe', 'Greenix']) {
      const t = CATEGORY_TABLE.replace('National chain', brand);
      const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
      expect(r.pass).toBe(false);
      expect(r.findings.some((f) => f.code === 'COMPARISON_UNKNOWN_COMPETITOR')).toBe(true);
    }
  });

  test('title-cased English phrases containing brand-like words stay clean (Codex round-5 P2)', () => {
    for (const body of [
      'Why Ants Bug Out After Rain. Palmetto bugs scatter when the barrier is fresh. No table.',
      'When to Call a Lawn Doctor: signs your turf needs a pro diagnosis. No table.',
    ]) {
      const r = gate.evaluate({ body }, { namedCompetitorEnabled: true });
      expect(r.pass).toBe(true);
      expect(r.findings).toHaveLength(0);
    }
  });

  test('digit-led provider headers fail closed (Codex round-5 P2)', () => {
    for (const header of ['360 Pest Control', '911 pest control']) {
      const t = CATEGORY_TABLE.replace('National chain', header);
      const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
      expect(r.pass).toBe(false);
      expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(true);
    }
  });

  test('quality-adjective service names fail closed — real companies are named that way (Codex round-7 P1)', () => {
    for (const header of ['Quality Pest Control', 'Affordable Pest Control', 'Eco Pest Control', 'Local Pest Control']) {
      const t = CATEGORY_TABLE.replace('National chain', header);
      const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
      expect(r.pass).toBe(false);
      expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(true);
    }
  });

  test('punctuated, excluded-word-led, and bare-suffix provider headers fail closed (Codex round-6 P1s)', () => {
    for (const header of ['A+ Pest Control', 'Acme-Pest Control', 'Spring Green Lawn Care', 'Mosquito Squad', 'Bug Busters', 'Termite Specialists']) {
      const t = CATEGORY_TABLE.replace('National chain', header);
      const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
      expect(r.pass).toBe(false);
      expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(true);
    }
  });

  test('lowercase business-shaped headers still fail closed (Codex round-3 P1)', () => {
    for (const header of ['acme pest control', 'acme lawn care']) {
      const t = CATEGORY_TABLE.replace('National chain', header);
      const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
      expect(r.pass).toBe(false);
      expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(true);
    }
  });

  test('seasonal lawn-care copy is not a phantom business — headers or prose (Codex round-3 P2)', () => {
    const t = CATEGORY_TABLE.replace('National chain', 'Spring lawn care');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(false);
    expect(r.pass).toBe(true);

    const prose = gate.evaluate({ body: 'Spring lawn care is unreliable without irrigation tuned first. No table here.' }, { namedCompetitorEnabled: true });
    expect(prose.pass).toBe(true);
    expect(prose.findings).toHaveLength(0);
  });

  test('lowercase generic phrases never match the case-sensitive brand signals (Codex round-3 P2)', () => {
    const prose = gate.evaluate({ body: 'If turf keeps thinning, ask a lawn doctor to diagnose it, or bug out the crawl space screens. No table.' }, { namedCompetitorEnabled: true });
    expect(prose.pass).toBe(true);
    expect(prose.findings).toHaveLength(0);
  });

  test('geo lawn-care education in prose is not a disparaged business (Codex round-4 P2)', () => {
    const prose = gate.evaluate({ body: 'Sarasota lawn care is unreliable without irrigation tuned first. No table here.' }, { namedCompetitorEnabled: true });
    expect(prose.pass).toBe(true);
    expect(prose.findings).toHaveLength(0);
  });

  test('month-led PROVIDER names in prose stay detectable (Codex round-4 P1)', () => {
    const r = gate.evaluate({ body: 'May Pest Control is dishonest. No table here.' }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('lowercase legal-entity headers fail closed (Codex round-4 P2)', () => {
    const t = CATEGORY_TABLE.replace('National chain', "bob's bugs llc");
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(true);
  });

  test('ALL-CAPS styling of a curated case-sensitive alias is still recognized (Codex round-4 P2)', () => {
    // "Rodent Solutions" is an allowlisted competitor detected via aliasesCS;
    // an uppercased table heading is the same brand.
    const t = CATEGORY_TABLE.replace('National chain', 'RODENT SOLUTIONS');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
  });

  test('an unallowlisted LAWN CARE company header stays fail-closed (Codex P1)', () => {
    const t = CATEGORY_TABLE.replace('National chain', 'Acme Lawn Care');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION' && /Acme Lawn Care/.test(f.message))).toBe(true);
  });

  test('finding D: a service-named business option is not swallowed by the category regex', () => {
    for (const name of ['National Pest Control', 'Bug Off Pest Service', "Bob's Bug Service"]) {
      const t = CATEGORY_TABLE.replace('National chain', name);
      const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
      expect(r.pass).toBe(false);
      expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(true);
    }
  });

  test('an option that is neither category nor Waves nor allowlisted fails closed (P1)', () => {
    const t = CATEGORY_TABLE.replace('National chain', "Bob's Bugs LLC");
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION' && f.severity === 'P1')).toBe(true);
  });

  test('finding B: a generic phrase in prose ("Integrated Pest Management" / "Professional Pest Control") is NOT misread as a business', () => {
    const body = `We practice Integrated Pest Management (IPM). Professional pest control beats DIY.\n\n${CATEGORY_TABLE}`;
    const r = gate.evaluate({ body }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNKNOWN_COMPETITOR' || f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('finding B (superseded): a non-comparison draft naming a competitor now routes to review', () => {
    // Previously this passed untouched — the no-table early return skipped
    // ALL scanning, so prose competitor claims (and defamation) were never
    // checked. Policy: a competitor may be named ONLY inside a
    // <ComparisonTable>, where every cell is validated. IPM/category prose
    // without the competitor name still passes (see the table-less suite).
    const r = gate.evaluate({ body: 'Integrated Pest Management works. Orkin is a national brand. No table here.' }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_IN_PROSE' && f.severity === 'P1')).toBe(true);
    const clean = gate.evaluate({ body: 'Integrated Pest Management works. No table here.' }, { namedCompetitorEnabled: true });
    expect(clean.pass).toBe(true);
    expect(clean.findings).toHaveLength(0);
  });

  test('finding E: a self-declared ranking in PROSE (outside the table) is caught', () => {
    const body = `Waves is the best pest control choice in Venice.\n\n${CATEGORY_TABLE}`;
    const r = gate.evaluate({ body }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('finding E: prose "the best time to treat" does NOT trip the ranking check', () => {
    const body = `The best time to treat for chinch bugs is late spring.\n\n${CATEGORY_TABLE}`;
    const r = gate.evaluate({ body }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('an apostrophe inside a double-quoted caption does not truncate attribution detection', () => {
    const caption = "Attributes as of June 2026, per each company's public website.";
    const block = `<ComparisonTable columns={["A","Orkin"]} rows={[{ label: "Reach", values: ["x","National"] }]} caption="${caption}" />`;
    expect(gate.extractCaption(block)).toBe(caption);
    expect(gate.hasAttribution(gate.extractCaption(block))).toBe(true);
  });

  test('"#1" ranking framing is caught', () => {
    const t = CATEGORY_TABLE.replace('Local SWFL company', '#1 in Venice');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('bare "best" (not "the best" / not a ranking claim) does NOT trip the ranking check', () => {
    const t = CATEGORY_TABLE.replace('Trade-offs to weigh when choosing pest control in Venice.', 'Choose the option that fits your home best.');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('naming a detectable-but-UNLISTED business (Hulett) is a P0 block', () => {
    // "Hulett" is a recognized pest-control brand signal but is NOT on the
    // curated allowlist (no sourced facts), so it cannot be named.
    const t = CATEGORY_TABLE.replace('National chain', 'Hulett');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNKNOWN_COMPETITOR' && f.severity === 'P0')).toBe(true);
  });

  const NAMED_TABLE = (caption) => `<ComparisonTable
  columns={["What to weigh","Orkin","Local SWFL company"]}
  rows={[
    { label: "Reach", values: ["National (US)","Local to Manatee/Sarasota/Charlotte"] },
    { label: "Recurring residential plans", values: ["Yes","Yes"] }
  ]}
  caption="${caption}" />`;

  test('a known competitor with feature DISABLED routes to review (P1, no P0)', () => {
    const r = gate.evaluate(wrap(NAMED_TABLE('Attributes as of June 2026, per each company public website (orkin.com).')), { namedCompetitorEnabled: false });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_NAMED_COMPETITOR_DISABLED' && f.severity === 'P1')).toBe(true);
    expect(r.findings.some((f) => f.severity === 'P0')).toBe(false);
  });

  test('a known competitor with feature ENABLED but UNSOURCED caption is flagged (P1, routes to review)', () => {
    const r = gate.evaluate(wrap(NAMED_TABLE('A quick look at your options.')), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_UNSOURCED' && f.severity === 'P1')).toBe(true);
  });

  test('finding C: a known competitor with feature ENABLED + sourced caption PASSES but requiresHumanReview', () => {
    const r = gate.evaluate(wrap(NAMED_TABLE('Attributes as of June 2026, per each company public website.')), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
    expect(r.requiresHumanReview).toBe(true); // never auto-publishes
  });

  test('requiresHumanReview is false for a category-only comparison', () => {
    const r = gate.evaluate(wrap(CATEGORY_TABLE), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(true);
    expect(r.requiresHumanReview).toBe(false);
  });

  test('extractCaption handles caption="..." and caption={\'...\'}', () => {
    expect(gate.extractCaption('<ComparisonTable caption="hello" />')).toBe('hello');
    expect(gate.extractCaption("<ComparisonTable caption={'world'} />")).toBe('world');
  });

  test('hasAttribution requires as-of + date + source together', () => {
    expect(gate.hasAttribution('Attributes as of June 2026, per company websites.')).toBe(true);
    expect(gate.hasAttribution('As of 2026, source: orkin.com')).toBe(true);
    expect(gate.hasAttribution('As of last week.')).toBe(false); // no date, no source
    expect(gate.hasAttribution('Per their website.')).toBe(false); // no as-of/date
    expect(gate.hasAttribution('')).toBe(false);
  });

  // ── Round-3 findings ──

  test('R3-1: an option literally named "Waves Pest Control" is recognized as our brand, not parked', () => {
    expect(gate.classifyOption('Waves Pest Control')).toBe('own');
    const t = CATEGORY_TABLE.replace('Local SWFL company', 'Waves Pest Control');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: false });
    expect(r.pass).toBe(true);
  });

  test('R3-2: a table-scoped "worst" claim is caught (while prose "worst infestation" is not)', () => {
    const t = CATEGORY_TABLE.replace('Generic playbook', 'Worst follow-up');
    expect(gate.evaluate(wrap(t), { namedCompetitorEnabled: true }).findings
      .some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(true);
    const prose = gate.evaluate({ body: `The worst infestation we saw was termites.\n\n${CATEGORY_TABLE}` }, {});
    expect(prose.pass).toBe(true);
  });

  test('R3-3: in a multi-table guide, attribution must be on the table that names the competitor', () => {
    const sourcedCategory = CATEGORY_TABLE.replace(
      'Trade-offs to weigh when choosing pest control in Venice.',
      'Trade-offs as of June 2026, per public sources.');
    const unsourcedNamed = NAMED_TABLE('A quick look at your options.');
    const r = gate.evaluate({ body: `${sourcedCategory}\n\n${unsourcedNamed}` }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_UNSOURCED' && /Orkin/.test(f.message))).toBe(true);
  });

  test('R3-4: bare "best/top <service>" rankings are caught; generic "best pest control method" is not', () => {
    for (const phrase of ['Waves is best pest control in Venice', 'We are the top pest control company']) {
      const r = gate.evaluate({ body: `${phrase}.\n\n${CATEGORY_TABLE}` }, { namedCompetitorEnabled: true });
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
    const ok = gate.evaluate({ body: `The best pest control method for ants is bait.\n\n${CATEGORY_TABLE}` }, {});
    expect(ok.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(ok.pass).toBe(true);
  });

  test('R3-6: a competitor named in the title/meta (not the body) is caught', () => {
    const r = gate.evaluate(
      { body: CATEGORY_TABLE, frontmatter: { title: 'Hulett vs Waves in Venice', meta_description: 'A neutral guide.' } },
      { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNKNOWN_COMPETITOR' && /Hulett/.test(f.message))).toBe(true);
  });

  test('R3-7: a named competitor cell stating a non-curated fact is routed to review', () => {
    const fabricated = `<ComparisonTable
      columns={["What to weigh","Orkin","Local SWFL company"]}
      rows={[
        { label: "Guarantee", values: ["90-day money-back guarantee","Re-treat between visits"] },
        { label: "Reach", values: ["National (US)","Local"] }
      ]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: fabricated }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT' && /Orkin/.test(f.message))).toBe(true);
  });

  // ── Round-4 findings ──

  test('R4-1: a curated value with appended uncurated text is rejected', () => {
    const t = `<ComparisonTable
      columns={["What to weigh","Orkin","Local SWFL company"]}
      rows={[{ label: "Reach", values: ["National (US); free termite inspections","Local"] }]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT')).toBe(true);
  });

  test('R4-3: a later UNsourced table naming the same competitor is flagged even if an earlier one is sourced', () => {
    const sourced = NAMED_TABLE('Attributes as of June 2026, per each company public website.');
    const unsourced = NAMED_TABLE('A second quick look.');
    const r = gate.evaluate({ body: `${sourced}\n\n${unsourced}` }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_UNSOURCED' && /Orkin/.test(f.message))).toBe(true);
  });

  test('R4-4: an uncurated fact in the ROW LABEL with an affirmative cell is rejected', () => {
    const t = `<ComparisonTable
      columns={["What to weigh","Orkin","Local SWFL company"]}
      rows={[{ label: "90-day money-back guarantee", values: ["Yes","No"] }]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT')).toBe(true);
  });

  test('R4-5: standalone self-ranking ("Waves is the best.") is caught', () => {
    for (const phrase of ['Waves is the best.', 'Waves is the top choice for your home']) {
      const r = gate.evaluate({ body: `${phrase}\n\n${CATEGORY_TABLE}` }, { namedCompetitorEnabled: true });
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
    // "the best time to treat" is still safe.
    expect(gate.evaluate({ body: `The best time to treat is spring.\n\n${CATEGORY_TABLE}` }, {})
      .findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
  });

  test('R4-6: a legal-entity business name in a cell or title is caught', () => {
    const cell = `<ComparisonTable
      columns={["What to weigh","Provider","Local SWFL company"]}
      rows={[{ label: "Who", values: ["Bob's Bugs LLC","Waves"] }]}
      caption="A guide." />`;
    expect(gate.evaluate({ body: cell }, { namedCompetitorEnabled: true })
      .findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION' && /Bob's Bugs LLC/.test(f.message))).toBe(true);
    const titled = gate.evaluate(
      { body: CATEGORY_TABLE, frontmatter: { title: "Acme Exterminators Inc vs Waves" } },
      { namedCompetitorEnabled: true });
    expect(titled.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION' && /Acme Exterminators Inc/.test(f.message))).toBe(true);
  });

  test('R4-7: a negative reliability claim about a named competitor in PROSE is caught', () => {
    const r = gate.evaluate({ body: `Orkin never answers the phone when you call.\n\n${CATEGORY_TABLE}` }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY')).toBe(true);
    // The same reliability word with no nearby competitor (DIY efficacy) is NOT flagged.
    expect(gate.evaluate({ body: `DIY sprays are unreliable on termites.\n\n${CATEGORY_TABLE}` }, {})
      .findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY')).toBe(false);
  });

  test('does/doesn\'t reliability forms are caught like never/won\'t (Codex round 17)', () => {
    // Named-competitor proximity path.
    const named = gate.evaluate({ body: `Orkin does not answer the phone when you call.\n\n${CATEGORY_TABLE}` }, { namedCompetitorEnabled: true });
    expect(named.findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY')).toBe(true);
    // Generic business-shaped name as subject (table-less prose path).
    const generic = gate.evaluate({ body: "Acme Pest Solutions doesn't call back after you leave a message." });
    expect(generic.findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY')).toBe(true);
    // The require-idiom "call for" stays clean even next to a provider name.
    expect(gate.evaluate({ body: `Orkin agrees light infestations do not call for fumigation.\n\n${CATEGORY_TABLE}` }, { namedCompetitorEnabled: true })
      .findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY')).toBe(false);
  });

  // ── Round-5 findings ──

  test('R5-2a: an uncurated fact behind a "Free" cell (treated as affirmative) is rejected', () => {
    const t = `<ComparisonTable
      columns={["What to weigh","Orkin","Local SWFL company"]}
      rows={[{ label: "Free termite inspections", values: ["Free","Quote-based"] }]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT')).toBe(true);
  });

  test('R5-3: provider-directed disparagement in the title/prose is caught (P0)', () => {
    const titled = gate.evaluate(
      { body: CATEGORY_TABLE, frontmatter: { title: 'Worst pest control companies in Venice' } },
      { namedCompetitorEnabled: true });
    expect(titled.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);

    const prose = gate.evaluate({ body: `National chains are unreliable and overpromise.\n\n${CATEGORY_TABLE}` }, {});
    expect(prose.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(true);

    // "worst infestation" (not provider-directed) is still safe.
    expect(gate.evaluate({ body: `The worst infestation we saw was termites.\n\n${CATEGORY_TABLE}` }, {})
      .findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  // ── Round-6 finding ──

  test('R6-3: a location-prefixed business name in prose/title is caught (not waved through)', () => {
    const prose = gate.evaluate({ body: `Sarasota Pest Control offers free inspections.\n\n${CATEGORY_TABLE}` }, { namedCompetitorEnabled: true });
    expect(prose.pass).toBe(false);
    expect(prose.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION' && /Sarasota Pest Control/.test(f.message))).toBe(true);

    const titled = gate.evaluate(
      { body: CATEGORY_TABLE, frontmatter: { title: 'Florida Pest Control vs Waves in Venice' } },
      { namedCompetitorEnabled: true });
    expect(titled.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION' && /Florida Pest Control/.test(f.message))).toBe(true);
  });

  // ── Round-7 findings ──

  test('R7-F2: an uncurated fact is caught even when row props are written values-before-label', () => {
    const t = `<ComparisonTable
      columns={["What to weigh","Orkin","Local SWFL company"]}
      rows={[{ values: ["90-day money-back guarantee","Re-treat between visits"], label: "Guarantee" }]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT')).toBe(true);
  });

  test('R7-F2: extractRows parses label/values in either order', () => {
    expect(gate.extractRows('rows={[{ label: "A", values: ["1","2"] }]}')[0]).toEqual({ label: 'A', values: ['1', '2'] });
    expect(gate.extractRows('rows={[{ values: ["1","2"], label: "A" }]}')[0]).toEqual({ label: 'A', values: ['1', '2'] });
  });

  test('R7-F3: a NEGATED competitor fact is not treated as supported', () => {
    const t = `<ComparisonTable
      columns={["What to weigh","Orkin","Local SWFL company"]}
      rows={[{ label: "Reach", values: ["Not national","Local"] }]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT')).toBe(true);
    // claimSupported unit: negation rejected even though "national" is curated.
    expect(gate.claimSupported('Not national', ['National (US)'])).toBe(false);
    expect(gate.claimSupported('National (US)', ['National (US)'])).toBe(true);
  });

  test('R7-F5: disparaging a competitor by brand name (no provider noun) is caught (P0)', () => {
    const r = gate.evaluate({ body: `Honestly, Orkin is the worst.\n\n${CATEGORY_TABLE}` }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  // ── Round-8 findings ──

  test('R8-A2: an allowlisted competitor named in PROSE (outside the table) is flagged', () => {
    const body = `Orkin offers free same-day service in Sarasota.\n\n${NAMED_TABLE('Attributes as of June 2026, per each company public website.')}`;
    const r = gate.evaluate({ body }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_IN_PROSE' && /Orkin/.test(f.message))).toBe(true);
  });

  test('R8-A4: quoted-key rows are parsed and validated (not silently skipped)', () => {
    expect(gate.extractRows('rows={[{ "label": "A", "values": ["1","2"] }]}')[0]).toEqual({ label: 'A', values: ['1', '2'] });
    const t = `<ComparisonTable
      columns={["What to weigh","Orkin","Local SWFL company"]}
      rows={[{ "label": "Free termite inspections", "values": ["Yes","No"] }]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT')).toBe(true);
  });

  // ── Round-9 findings ──

  test('R9-B1: a short/numeric uncurated competitor fact ("24/7") is rejected', () => {
    expect(gate.claimSupported('24/7', ['National (US)'])).toBe(false);
    expect(gate.claimSupported('24/7', ['24/7 phone support'])).toBe(true); // curated → ok
    const t = `<ComparisonTable
      columns={["What to weigh","Orkin","DIY"]}
      rows={[{ label: "Availability", values: ["24/7","No"] }]}
      caption="Attributes as of June 2026, per company website." />`;
    expect(gate.evaluate({ body: t }, { namedCompetitorEnabled: true })
      .findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT')).toBe(true);
  });

  test('R9-B3: an allowlisted competitor named in a CELL (not the header) is flagged', () => {
    const t = `<ComparisonTable
      columns={["What to weigh","National chain","DIY"]}
      rows={[{ label: "Example", values: ["Orkin offers same-day service","No"] }]}
      caption="As of June 2026, per company website." />`;
    expect(gate.evaluate({ body: t }, { namedCompetitorEnabled: true })
      .findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT' && /cell\/row/.test(f.message))).toBe(true);
  });

  test('curation: the generic phrase "rodent solutions" (lower-case) is NOT treated as a named competitor', () => {
    const r = gate.evaluate({ body: `Compare rodent solutions before choosing a plan.\n\n${CATEGORY_TABLE}` }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => /COMPETITOR/.test(f.code))).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('R9-B5: an UNallowlisted business with a less-common suffix ("Pest Defense") is recognized', () => {
    // Uses a name NOT on the curated allowlist so it still exercises the
    // suffix recognizer → fail-closed (allowlisted ones now route via the
    // competitor-in-prose / known-competitor paths instead).
    const r = gate.evaluate({ body: `Compared with Coastline Pest Defense in Venice.\n\n${CATEGORY_TABLE}` }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION' && /Coastline Pest Defense/.test(f.message))).toBe(true);
  });

  // ── Round-10 findings (Codex review of the round-9 commit) ──

  test('R10-1: a "Waves vs Orkin" column is validated as a competitor column (own-brand co-mention no longer skips cell checks)', () => {
    expect(gate.classifyOption('Waves vs Orkin')).toBe('known_competitor');
    expect(gate.classifyOption('Waves Pest Control')).toBe('own'); // pure brand still own
    const t = `<ComparisonTable
      columns={["What to weigh","Waves vs Orkin","Local SWFL company"]}
      rows={[{ label: "Guarantee", values: ["90-day money-back guarantee","Re-treat between visits"] }]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT' && /Orkin/.test(f.message))).toBe(true);
  });

  test('R10-2: one column naming MULTIPLE competitors fails closed (each needs its own column)', () => {
    const t = `<ComparisonTable
      columns={["What to weigh","Orkin / Massey Services","Local SWFL company"]}
      rows={[{ label: "Reach", values: ["Regional (Southeast US)","Local"] }]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT'
      && /Orkin/.test(f.message) && /Massey/.test(f.message))).toBe(true);
  });

  test('R10-3: a NEGATIVE cell on a reliability row for a named competitor routes to review', () => {
    const t = `<ComparisonTable
      columns={["What to weigh","Orkin","Local SWFL company"]}
      rows={[
        { label: "Answers the phone", values: ["Never","Yes"] },
        { label: "Reach", values: ["National (US)","Local"] }
      ]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY' && /Orkin/.test(f.message))).toBe(true);
    expect(r.findings.some((f) => f.severity === 'P0')).toBe(false);
  });

  test('R10-3b: a NEGATIVE cell on a NEUTRAL feature row for a named competitor is NOT a reliability claim', () => {
    const t = `<ComparisonTable
      columns={["What to weigh","Orkin","Local SWFL company"]}
      rows={[
        { label: "Free re-inspection visits", values: ["No","Yes"] },
        { label: "Reach", values: ["National (US)","Local"] }
      ]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('R10-4: short/numeric claims need a whole-token curated match, not a substring', () => {
    // "A+" → "a" must NOT be "supported" by "National (US)" → "national us" (stray "a" in "national").
    expect(gate.claimSupported('A+', ['National (US)'])).toBe(false);
    expect(gate.claimSupported('A+', ['A+ rating'])).toBe(true);
    expect(gate.claimSupported('24/7', ['24/7 support'])).toBe(true);
    expect(gate.claimSupported('24/7', ['Available 24 hours'])).toBe(false);
  });

  test('R10-4b: a named competitor "A+" rating cell with no curated A+ attribute is rejected', () => {
    const t = `<ComparisonTable
      columns={["What to weigh","Orkin","Local SWFL company"]}
      rows={[{ label: "BBB rating", values: ["A+","A"] }]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT' && /Orkin/.test(f.message))).toBe(true);
  });

  // ── Curation round: escaped-quote parsing + embedded-quote brand names ──
  // A real allowlisted competitor — "All \"U\" Need Pest Control" — carries
  // literal quotes around the "U" in its brand. The JSX a draft emits escapes
  // them as \"U\", so the parser must read the quoted literal in full (not
  // truncate at the inner quote) and name-detection must read it as one name
  // rather than the fragment "Need Pest Control".

  test('escaped-quote parsing: a JSX-escaped quote in a caption is read in full, not truncated', () => {
    const block = `<ComparisonTable caption="All \\"U\\" Need is national; as of June 2026 per alluneedpest.com." />`;
    expect(gate.extractCaption(block)).toBe('All "U" Need is national; as of June 2026 per alluneedpest.com.');
  });

  test('escaped-quote parsing: an escaped apostrophe in a single-quoted row label is read in full', () => {
    const block = `rows={[{ label: 'Keller\\'s Pest Control', values: ["Yes","No"] }]}`;
    expect(gate.extractRows(block)[0]).toEqual({ label: "Keller's Pest Control", values: ['Yes', 'No'] });
  });

  test('escaped-quote parsing: an embedded-quote brand stays ONE column value, not split in two', () => {
    const block = `columns={["What to weigh","All \\"U\\" Need Pest Control","Local"]}`;
    expect(gate.extractColumns(block)).toEqual(['What to weigh', 'All "U" Need Pest Control', 'Local']);
  });

  test('embedded-quote brand: All "U" Need Pest Control is recognized as the allowlisted competitor (one name, not the "Need Pest Control" fragment)', () => {
    expect(gate.classifyOption('All "U" Need Pest Control')).toBe('known_competitor');
    const t = `<ComparisonTable
      columns={["What to weigh","All \\"U\\" Need Pest Control","Local SWFL company"]}
      rows={[{ label: "Reach", values: ["Local","Local"] }]}
      caption="Trade-offs as of June 2026, per public sources." />`;
    const r = gate.evaluate({ body: t }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT' && /All U Need Pest Control/.test(f.message))).toBe(true);
  });

  test('embedded-quote brand: a negative prose claim about All "U" Need (escaped form) still trips the prose/proximity checks, not just name detection', () => {
    // Round-5 (Codex): name detection runs on a quote-stripped copy, but the
    // proximity + prose-only checks must too — else an escaped brand can make a
    // negative claim OUTSIDE a sourced table and escape both findings.
    const sourced = `<ComparisonTable
      columns={["What to weigh","All \\"U\\" Need Pest Control","Local SWFL company"]}
      rows={[{ label: "Recurring residential plans", values: ["Yes","Yes"] }]}
      caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: `All \\"U\\" Need Pest Control never answers the phone when you call.\n\n${sourced}` }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY')).toBe(true);
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_IN_PROSE')).toBe(true);
  });
});

describe('table-less drafts: named-target legal scan (regression — these previously passed untouched)', () => {
  test('disparaging an arbitrary business-shaped name in plain prose is P0', () => {
    const r = gate.evaluate({ body: 'Acme Pest Solutions is dishonest and will overcharge you for everything they do.' });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });
  test('a negative service-reliability claim near a business name is P1', () => {
    const r = gate.evaluate({ body: 'Gulf Coast Termite Specialists never answers the phone when customers call about warranty work.' });
    expect(r.findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY' && f.severity === 'P1')).toBe(true);
  });
  test('an allowlisted competitor named in prose with no table is P1 (table cells only)', () => {
    const r = gate.evaluate({ body: 'Orkin offers free same-day service in Sarasota, which many homeowners like.' }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_IN_PROSE' && f.severity === 'P1')).toBe(true);
  });
  test('title/meta are part of the scanned legal surface', () => {
    const r = gate.evaluate({
      body: 'Ordinary body copy about ants.',
      frontmatter: { meta_description: 'Why Terminix is unreliable and what to do instead.' },
    });
    expect(r.pass).toBe(false);
  });
  test('a clean normal blog post passes', () => {
    const r = gate.evaluate({ body: 'Centipedes eat roaches, silverfish, and other small insects around Southwest Florida homes.' });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
  test('a business-shaped phrase with NO nearby negativity does not block (unlike the table path)', () => {
    const r = gate.evaluate({
      body: 'Here is how to keep ants out of your kitchen this summer.',
      frontmatter: { title: 'Sarasota Pest Control Guide: Kitchen Ants' },
    });
    expect(r.pass).toBe(true);
  });
  test('consumer-protection prose with no named target stays allowed', () => {
    const r = gate.evaluate({ body: 'Avoid pest control scams by checking licenses. Watch out for hidden fees when comparing quotes.' });
    expect(r.pass).toBe(true);
  });
  test('empty body still passes', () => {
    expect(gate.evaluate({ body: '' }).pass).toBe(true);
  });
});

describe('table-less drafts: negativity must be DIRECTED at generic business names (Codex round 1)', () => {
  test('problem-framing negativity near a business-shaped phrase does NOT block', () => {
    // "Worst" describes the roach problem, not a provider — bare proximity
    // previously P0\'d this exact title shape.
    const r = gate.evaluate({
      body: 'How to handle roaches in your kitchen this summer.',
      frontmatter: { title: 'Sarasota Pest Control Guide: Worst Roach Problems' },
    });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
  test('name-as-subject disparagement still blocks', () => {
    const r = gate.evaluate({ body: 'Acme Pest Solutions is dishonest and will overcharge you.' });
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });
  test('negative adjective immediately modifying the name still blocks', () => {
    const r = gate.evaluate({ body: 'Avoid the dishonest Acme Pest Solutions crew at all costs.' });
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });
  test('curated competitor names keep the stricter proximity scan', () => {
    const r = gate.evaluate({ body: 'Many say the worst experience around here has been Terminix in recent years.' }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });
});

describe('table-less drafts: directed-scan tightening (Codex round 2)', () => {
  test('ACTIVE-verb disparagement with the name as subject is P0 (no linking verb needed)', () => {
    for (const body of [
      'Acme Pest Solutions scams customers in Venice.',
      'Acme Pest Solutions charges hidden fees on every renewal.',
      'Gulf Coast Termite Specialists routinely rips off homeowners.',
    ]) {
      const r = gate.evaluate({ body });
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });
  test('title-case noun use of "scams" with no victim object does not trip the active-verb pattern', () => {
    const r = gate.evaluate({
      body: 'Check licenses before you sign anything.',
      frontmatter: { title: 'How to Avoid Pest Control Scams in Sarasota' },
    });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
  test('a reliability negative aimed at DIY sprays near a business-shaped title phrase does NOT block', () => {
    // Bare 60-char proximity previously P1\'d this exact title shape.
    const r = gate.evaluate({
      body: 'Store-bought products lose potency fast in Florida humidity.',
      frontmatter: { title: 'Sarasota Pest Control Guide: Why DIY Sprays Are Unreliable' },
    });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
  test('reliability negatives as the direct predicate or verb-linked still flag P1', () => {
    for (const body of [
      'Acme Pest Solutions never answers the phone.',
      'Acme Pest Solutions is unresponsive during termite swarming season.',
    ]) {
      const r = gate.evaluate({ body });
      expect(r.findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY' || f.code === 'COMPARISON_DISPARAGEMENT')).toBe(true);
    }
  });
});

describe('table-less drafts: operator-authorized competitor naming (Codex round 3)', () => {
  // The Aptive intercept brief's own text — the operator personally named
  // the competitor, so the draft routes to the APPROVABLE named-competitor
  // review path instead of a hard UNKNOWN_COMPETITOR block.
  const BRIEF_TEXT = [
    "Aptive's Cancellation Fee, Explained",
    'aptive cancellation fee',
    "What Aptive's contract actually costs and how the cancellation fee works",
    'how to cancel aptive',
  ].join('\n');

  test('an operator-named recognized competitor passes with requiresHumanReview', () => {
    const r = gate.evaluate({
      body: 'Aptive charges a $199 early-cancel fee per its published contract terms; here is the dispute path.',
      frontmatter: { title: "Aptive's Cancellation Fee, Explained" },
    }, { operatorBriefText: BRIEF_TEXT });
    expect(r.pass).toBe(true);
    expect(r.requiresHumanReview).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
  test('the same draft with NO operator brief text stays hard-blocked (mined lane unchanged)', () => {
    const r = gate.evaluate({ body: 'Aptive charges a $199 early-cancel fee per its contract terms.' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNKNOWN_COMPETITOR' && f.severity === 'P0')).toBe(true);
  });
  test('a competitor the operator did NOT name still flags', () => {
    const r = gate.evaluate({
      body: 'Aptive charges a cancellation fee, and Terminix has similar terms in its contracts.',
    }, { operatorBriefText: BRIEF_TEXT });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_IN_PROSE')).toBe(true);
  });
  test('disparaging the operator-authorized name still blocks (full curated strictness)', () => {
    const r = gate.evaluate({
      body: 'Aptive is dishonest and scams customers out of hundreds every year.',
    }, { operatorBriefText: BRIEF_TEXT });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });
  test('non-titlecase provider names still get the negativity scan (Codex round 8)', () => {
    const r = gate.evaluate({ body: 'acme pest solutions is dishonest and overpriced.' });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    // lowercase category prose stays excluded, exactly like its Title Case form
    const clean = gate.evaluate({ body: 'a local pest control company can quote you same-day in most cases.' });
    expect(clean.pass).toBe(true);
    expect(clean.findings).toHaveLength(0);
  });
  test('prose fragments ending in an industry suffix are NOT names (Codex round 9)', () => {
    // The CI pass excludes common prose words from every token position —
    // "compared with professional pest control" must not become a
    // genericName that nearby negativity ("useless") gets directed at.
    const r = gate.evaluate({ body: 'Store-bought sprays are useless compared with professional pest control.' });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
  test('a detection-only alias in the brief authorizes the FULLER surface form (word-boundary containment, Codex round 7)', () => {
    // "Aptive" (brief) and "Aptive Environmental" (draft) canonicalize to
    // DIFFERENT unknown names — exact-string matching sent the operator's
    // own Aptive draft to the hard UNKNOWN_COMPETITOR block.
    const r = gate.evaluate({
      body: 'Aptive Environmental charges a $199 early-cancel fee per its published contract.',
    }, { operatorBriefText: 'aptive cancellation fee explained\nhow to cancel aptive' });
    expect(r.pass).toBe(true);
    expect(r.requiresHumanReview).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
  test('an ALIAS in the brief authorizes the canonical name in the draft (Codex round 4)', () => {
    // Authorization runs findBusinessMentions over the brief text, so both
    // sides canonicalize identically — a raw substring compare missed every
    // alias↔canonical pair ("Massey" in the brief vs "Massey Services" in
    // the draft) and hard-blocked legitimate operator intercepts.
    const r = gate.evaluate({
      body: 'Massey Services publishes its termite bond terms; here is what the contract covers.',
    }, { operatorBriefText: 'why massey termite bonds confuse homeowners\nmassey bond explained' });
    expect(r.pass).toBe(true);
    expect(r.requiresHumanReview).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
});

describe('educational-prose tone-scan false positives (prod 2026-07-11)', () => {
  // Three real drafts hard-blocked that day: "shady" meaning literal shade
  // (millipede/mosquito resting sites) and the "#1 <noun>" educational idiom
  // ("#1 entry point / hidden source / breeding site"). In PROSE these now
  // need a provider target; inside a table block they still block bare.

  test('"shady" meaning literal shade in educational prose does NOT trip disparagement', () => {
    for (const prose of [
      'Rake up leaf litter and pine straw against the house, under downspout splash zones, and in shady corners of the lanai.',
      'Your slab, garage threshold, and lanai are the shady, humid microclimates they hit first.',
      'Adult female mosquitoes hide in cool, humid, shady foliage between blood meals.',
    ]) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
      expect(r.pass).toBe(true);
    }
  });

  test('"#1 <noun>" educational idiom in prose does NOT trip rigged-ranking', () => {
    for (const prose of [
      'Pull the drip pan, clean and dry it — this is the #1 hidden source.',
      'Old rubber sweeps flatten out: the garage door threshold is the #1 entry point for millipedes.',
      'Clogged gutters — the #1 hidden breeding site in SWFL homes.',
      'The number one mistake homeowners make is overwatering the lawn.',
    ]) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
      expect(r.pass).toBe(true);
    }
  });

  test('"shady" DIRECTED at a provider noun still blocks (P0)', () => {
    const r = gate.evaluate({ body: `Some shady pest control companies quote one price and bill another.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('a disparagement term near a detected business name still blocks (P0)', () => {
    const r = gate.evaluate({ body: `Coastline Pest Defense has some shady billing practices.\n\n${CATEGORY_TABLE}` }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('numeric self-ranking near the own brand or a provider noun still blocks', () => {
    for (const prose of [
      'Waves is #1 in Venice for a reason.',
      'We are the #1 pest control company in Venice.',
    ]) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('numeric self-ranking in the title/meta still blocks', () => {
    const r = gate.evaluate(
      { body: `Intro prose.\n\n${CATEGORY_TABLE}`, frontmatter: { title: '#1 Pest Control in Venice' } },
      {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('bare disparagement vocabulary INSIDE a table block still blocks (table strictness unchanged)', () => {
    const t = CATEGORY_TABLE.replace('Generic playbook', 'Shady billing');
    const r = gate.evaluate(wrap(t), {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('consumer-protection prose with no target passes on the table path too', () => {
    const r = gate.evaluate({ body: `Watch out for hidden fees when comparing quotes.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(r.pass).toBe(true);
  });

  // ── Codex round-1 findings on the target-scoped scans (#2633) ──

  test('Codex r1: lowercase provider disparagement stays blocked on the table path', () => {
    const r = gate.evaluate({ body: `acme pest solutions is dishonest about pricing.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r1: self-referential numeric ranking needs no nearby brand token', () => {
    for (const prose of [
      'We are #1 in Venice for a reason.',
      "We're #1!",
      'Rated #1 by local homeowners.',
    ]) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r1: active disparaging predicates after provider nouns stay blocked', () => {
    for (const prose of [
      'Some pest control companies scam customers in Venice.',
      'Pest control providers charge hidden fees.',
    ]) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r1: header-shaped business names in prose are disparagement targets', () => {
    const r = gate.evaluate({ body: `Bug Busters is shady about billing.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r1: Title-case category headings near pest vocabulary stay clean', () => {
    const body = `Professional Mosquito Control\n\nAdult mosquitoes rest in shady foliage between blood meals, and Termite Prevention starts at the slab.\n\n${CATEGORY_TABLE}`;
    const r = gate.evaluate({ body }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(r.pass).toBe(true);
  });

  // ── Codex round-2 findings (#2633) ──

  test('Codex r2: punctuation-separated disparagement of a personified name blocks', () => {
    for (const prose of ['Bug Busters: shady billing practices.', 'Mosquito Squad — shady billing.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r2: "We\'re the #1!" self-ranking blocks with no nearby brand token', () => {
    for (const prose of ["We're the #1!", 'We are the #1!']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r2: possessive/usage fee accusations at provider nouns block', () => {
    for (const prose of ['Pest control companies have hidden fees.', 'National chains use shady billing.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r2: lowercase header-shaped names stay disparagement targets', () => {
    for (const prose of ['bug busters scams customers in Venice.', 'acme rodent removal is shady about pricing.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r2: descriptive personified idiom with no negativity stays clean', () => {
    const r = gate.evaluate({ body: `Dry rock borders and tight door sweeps are the real bug busters here.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(r.pass).toBe(true);
  });

  // ── Codex round-3 findings (pre-push audit on e698f999a0) ──

  test('Codex r3: comma/parenthetical adverbs cannot defeat the directed arms', () => {
    const r = gate.evaluate({ body: `Pest control companies, frankly, are dishonest.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r3: usage verbs with a literal-shade object stay clean (the original FP class)', () => {
    const r = gate.evaluate({ body: `Pest control companies use shady foliage to locate mosquito resting sites at dusk.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('Codex r3: own-brand possession accusations block', () => {
    const r = gate.evaluate({ body: `Waves has hidden fees.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r3: typographic apostrophe and determiner forms of numeric self-ranking block', () => {
    for (const prose of ['We’re #1!', 'Rated the #1 choice by local homeowners.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r3: lowercase legal-entity names are disparagement targets', () => {
    const r = gate.evaluate({ body: `acme holdings llc is dishonest about pricing.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r3: "#1" near a bare provider noun without ranking syntax stays clean', () => {
    const r = gate.evaluate({ body: `During your next service, check the #1 hidden breeding site: clogged gutters.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(r.pass).toBe(true);
  });

  // ── Codex round-36 findings (#2633) ──

  test('Codex r36: reported self-accusations and pronoun/possessive variants block', () => {
    for (const prose of ['Waves says it has hidden fees.', 'Waves notes its billing includes hidden fees.', 'A pest control company is not cheap because it has hidden fees.', 'A provider is not cheap because its billing includes hidden fees.', 'Our estimates include hidden fees.', 'We have been winning #1 awards.', 'Our team earned #1.', 'Our technicians won the #1 spot.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => (f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0') || f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r36: denial promises, negated superlatives, and trailing brand denials stay clean', () => {
    for (const body of [`No hidden fees because Waves keeps pricing transparent.\n\n${CATEGORY_TABLE}`, `No hidden fees while choosing Waves.\n\n${CATEGORY_TABLE}`, 'For pest control, gel bait is the best option.', 'We are not the best choice for every home, and we say so.', `Hidden fees from Waves are not real.\n\n${CATEGORY_TABLE}`]) {
      const r = gate.evaluate({ body }, {});
      expect(r.findings.some((f) => (f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0') || f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    }
  });

  // ── Codex round-35 findings (#2633) ──

  test('Codex r35: list-scope denials and educational advice stay clean', () => {
    for (const body of [`No hidden fees and transparent billing from Waves.\n\n${CATEGORY_TABLE}`, 'Our guide includes hidden fees to watch for when comparing quotes.', 'For roaches, gel bait is the best option.', `Waves explains that hidden fees frustrate homeowners.\n\n${CATEGORY_TABLE}`, `Waves has been tracking the #1 breeding site all summer.\n\n${CATEGORY_TABLE}`, 'Pest control is the #1 way to prevent termite damage.', 'Lawn care is the number one thing homeowners forget.']) {
      const r = gate.evaluate({ body }, {});
      expect(r.findings.some((f) => (f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0') || f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    }
  });

  test('Codex r35: causal-marker accusations and pronoun-possessive variants block', () => {
    for (const prose of ['Waves is not cheap although Waves has hidden fees.', 'Pest control companies are not cheap since they have hidden fees.', 'Pest control companies are not cheap because their billing includes hidden fees.', 'Pest control companies are not cheap because they are known for hidden fees.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  // ── Codex round-34 findings (#2633) ──

  test('Codex r34: conjunction-separated accusations keep the P0; denials stay denials', () => {
    for (const prose of ['Pest control companies are not cheap because they have hidden fees.', 'Waves is not cheap, and Waves has hidden fees.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const denial = gate.evaluate({ body: `There are no reports of hidden fees from Acme Pest Solutions.\n\n${CATEGORY_TABLE}` }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r34: auxiliary brand rankings block', () => {
    for (const prose of ['Waves has been ranked #1.', 'Waves has been the #1 choice.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r34: inclusion-verb fee accusations block', () => {
    for (const prose of ['Waves includes hidden fees.', 'Waves billing includes hidden fees.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  // ── Codex round-33 findings (#2633) ──

  test('Codex r33: table-less trailing separator denials stay clean', () => {
    for (const body of ['Bug Busters: hidden fees are not present.', 'Acme Pest Solutions: shady billing is not present.']) {
      const r = gate.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(false);
    }
  });

  test('Codex r33: table-less non-numeric self-rankings block', () => {
    for (const body of ['We are the best choice in Venice.', 'Waves is the clear winner.']) {
      const r = gate.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r33: whether/if clauses stay educational', () => {
    const r = gate.evaluate({ body: `Waves explains whether the garage threshold is the #1 entry point.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
  });

  // ── Codex round-32 findings (#2633) ──

  test('Codex r32: auxiliary self-rankings block', () => {
    for (const prose of ['We have been the #1 choice.', "We've been ranked #1.", 'We have been ranked #1 for years.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r32: branded educational clauses and negated reliability stay clean', () => {
    for (const prose of ['Waves teaches that the garage threshold is the #1 entry point.', 'Orkin is not unreliable.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING' || f.code === 'COMPARISON_NEGATIVE_RELIABILITY')).toBe(false);
    }
  });

  test('Codex r32: trailing separator denials stay clean; separator accusations still block', () => {
    const denial = gate.evaluate({ body: `Bug Busters: hidden fees are not present.\n\n${CATEGORY_TABLE}` }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(false);
    const accusation = gate.evaluate({ body: `Bug Busters: hidden fees at every renewal.\n\n${CATEGORY_TABLE}` }, {});
    expect(accusation.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r32: negated #1-before-brand claims stay clean', () => {
    for (const prose of ['No #1 choice is Waves, and that is fine.', 'No number one option is Waves.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    }
  });

  test('Codex r32: provider practice denials with "use" stay clean; name recommendations keep the P0', () => {
    const denial = gate.evaluate({ body: `Acme Pest Solutions does not use shady billing.\n\n${CATEGORY_TABLE}` }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(false);
    const rec = gate.evaluate({ body: `Do not use Bug Busters because of hidden fees.\n\n${CATEGORY_TABLE}` }, {});
    expect(rec.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  // ── Codex round-31 findings (#2633) ──

  test('Codex r31: auxiliary statistical rankings and negated brand rankings stay clean', () => {
    for (const prose of ['Florida has been ranked #1 for termite pressure.', 'Florida remains ranked #1 for termite pressure.', 'Waves does not rank #1 and says so.', 'Waves never markets itself as #1.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    }
  });

  test('Codex r31: buyer guidance with weak service nouns stays clean', () => {
    const r = gate.evaluate({ body: `Watch out for hidden fees when comparing service plans.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(false);
  });

  test('Codex r31: clause-boundary denials do not shadow live accusations', () => {
    for (const prose of ['No hidden fees here; Waves charges hidden fees.', 'No scams to avoid here; pest control companies are dishonest.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r31: reverse-arm denials and title-cased weather stay clean', () => {
    for (const body of ['No hidden fees from Waves.', `Lousy Heat Waves stress St. Augustinegrass.\n\n${CATEGORY_TABLE}`]) {
      const r = gate.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(false);
    }
  });

  test('Codex r31: brand tip-spot headings stay educational; market spot claims still block', () => {
    const tip = gate.evaluate({ body: `Waves: #1 hiding spot is cardboard.\n\n${CATEGORY_TABLE}` }, {});
    expect(tip.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    const market = gate.evaluate({ body: `The #1 spot belongs to Bug Busters.\n\n${CATEGORY_TABLE}` }, {});
    expect(market.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  // ── Codex round-30 findings (#2633) ──

  test('Codex r30: location-possessive #1 and plain-insult separator claims block', () => {
    for (const prose of ["Waves: Venice's #1 choice.", "Waves Pest Control: Sarasota's No. 1 pick.", 'Waves: dishonest.', 'Waves Review: overpriced.', 'Pest control companies: dishonest.', 'Providers — overpriced.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING' || (f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0'))).toBe(true);
    }
    const education = gate.evaluate({ body: `Pest control: scams to avoid this summer.\n\n${CATEGORY_TABLE}` }, {});
    expect(education.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(false);
  });

  test('Codex r30: overpriced-quote accusations block', () => {
    for (const prose of ['Customers report overpriced quotes after choosing Bug Busters.', 'Waves uses overpriced quotes.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r30: linking-verb-negated reliability stays clean', () => {
    const r = gate.evaluate({ body: `Bug Busters is not unreliable.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY')).toBe(false);
  });

  // ── Codex round-29 findings (#2633) ──

  test('Codex r29: header-shaped reliability claims route to review beside a table', () => {
    const r = gate.evaluate({ body: `Bug Busters never answers the phone.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_NEGATIVE_RELIABILITY')).toBe(true);
  });

  test('Codex r29: brand-prefixed educational #1 stays clean; winner claims still block', () => {
    for (const prose of ['Waves Pest Control: #1 entry point for ants is the garage door sweep.', "Waves' #1 mosquito tip is dumping standing water."]) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    }
    const winner = gate.evaluate({ body: `Waves — the #1 choice.\n\n${CATEGORY_TABLE}` }, {});
    expect(winner.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('Codex r29: subject-negated object-position denials stay clean beside a table', () => {
    const r = gate.evaluate({ body: `No one calls Bug Busters a scam.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(false);
  });

  test('Codex r29: denied association matches do not shadow later live ones', () => {
    const r = gate.evaluate({ body: `Customers do not report hidden fees after choosing Bug Busters. Customers report hidden fees after choosing Bug Busters.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r29: negated contextual #1 stays clean beside a table', () => {
    for (const prose of ['We are not the #1 pest control company in Venice, and we like it that way.', 'No #1 pest control company exists.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    }
  });

  test('Codex r29 REBUTTAL evidence: CI captures must not feed unclassified review (phantom-business flood)', () => {
    // Deliberate design (see classifyOption comment): the fail-closed
    // default was removed because it parked 2-3 educational drafts/day as
    // phantom businesses. Routing CI captures to review re-creates that:
    for (const body of ['During peak season, professional pest control keeps mosquitoes down. No table here.', `Dry rock borders and tight door sweeps are the real bug busters here.\n\n${CATEGORY_TABLE}`]) {
      const r = gate.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(false);
    }
  });

  // ── Codex round-28 findings (#2633) ──

  test('Codex r28: denied early matches do not shadow later accusations', () => {
    const r = gate.evaluate({ body: `No chains are shady. Providers are incompetent.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r28: subject-negated insult and ranking denials stay clean', () => {
    for (const body of ['No one calls Waves a scam.', `No one calls Waves a scam.\n\n${CATEGORY_TABLE}`, 'No one rated us #1.', 'No reviewers call us #1.']) {
      const r = gate.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' || f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    }
  });

  test('Codex r28: meteorology wave compounds stay educational', () => {
    for (const prose of ['Easterly Waves Are the #1 Rain Trigger.', 'Rossby Waves are lousy for forecasts.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING' || (f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0'))).toBe(false);
    }
  });

  test('Codex r28: emphatic gaps before accusation verbs keep the P0', () => {
    for (const prose of ['Waves not only charges hidden fees, it hides them.', 'Waves no doubt charges hidden fees.', 'Providers without question charge hidden fees.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  // ── Codex round-27 findings (#2633) ──

  test('Codex r27: denial-lead provider copy stays clean beside a table; accusations still block', () => {
    for (const prose of ['Not all pest control companies charge hidden fees.', 'No pest control companies are dishonest.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    }
    const accusation = gate.evaluate({ body: `Not only that, pest control companies scam customers.\n\n${CATEGORY_TABLE}` }, {});
    expect(accusation.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r27: first-person evaluative negatives block; hyphen idiom stays clean', () => {
    for (const prose of ['We are unreliable.', 'Our team is unreliable.', 'We seem sketchy.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const idiom = gate.evaluate({ body: `We are the worst-kept secret in Sarasota pest control.\n\n${CATEGORY_TABLE}` }, {});
    expect(idiom.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r27: our-subject #1 claims block', () => {
    for (const body of ['Our team is #1.', 'Our technicians are the #1 choice.', `Our team is #1.\n\n${CATEGORY_TABLE}`]) {
      const r = gate.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r27: emphatic idiom leads keep the accusation', () => {
    for (const prose of ['Without a doubt, hidden fees from Bug Busters are common.', 'No doubt, hidden fees after choosing Waves are common.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r27: tropical-wave weather copy stays educational', () => {
    for (const prose of ['Tropical Waves Are the #1 Rain Trigger.', 'Tropical Waves are lousy for mosquito forecasts.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING' || (f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0'))).toBe(false);
    }
  });

  // ── Codex round-26 findings (#2633) ──

  test('Codex r26: title-cased heat-wave copy stays educational; brand claims still block', () => {
    for (const prose of ['Heat Waves Are the #1 Stressor.', 'Heat Waves are lousy for turf.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING' || (f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0'))).toBe(false);
    }
    const brand = gate.evaluate({ body: `Waves is the worst.\n\n${CATEGORY_TABLE}` }, {});
    expect(brand.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r26: instructional we-are gerunds stay educational; adverbed claims still block', () => {
    for (const body of ['Below, we are listing the #1 breeding site: standing water.', 'We are ranking the #1 breeding sites by risk.']) {
      const r = gate.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    }
    const claim = gate.evaluate({ body: `We are currently the #1!\n\n${CATEGORY_TABLE}` }, {});
    expect(claim.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('Codex r26: "Not all" category denials are not fake business names', () => {
    const r = gate.evaluate({ body: 'Not all pest control companies charge hidden fees.' }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r26: article and singular hidden-fee accusations block', () => {
    for (const prose of ['Waves charges a hidden fee.', 'Bug Busters tacks on a hidden fee at renewal.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  // ── Codex round-25 findings (#2633) ──

  test('Codex r25: own-brand scans run table-less', () => {
    const disp = gate.evaluate({ body: 'Waves Pest Control charges hidden fees.' }, {});
    expect(disp.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    const rank = gate.evaluate({ body: 'We are #1 in Venice.' }, {});
    expect(rank.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('Codex r25: negated provider-category denials are not fake business names', () => {
    const r = gate.evaluate({ body: 'No pest control companies charge hidden fees like the bad old days.' }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r25: future-tense service copy with literal pest words stays clean table-less', () => {
    // Beside a comparison table the bare-token PROXIMITY arm still applies
    // by design (detected business name within 90 chars) — this guard
    // covers the prose path's subject-verb arm only.
    const r = gate.evaluate({ body: 'Acme Pest Solutions will treat shady corners around the lanai.' }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r25: sentence-initial "Waves of" stays educational', () => {
    for (const prose of ['Waves of summer heat are the #1 stressor.', 'Waves of heat can be lousy for turf.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING' || (f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0'))).toBe(false);
    }
  });

  test('Codex r25: own-brand evaluative negatives block', () => {
    for (const prose of ['Waves is unreliable.', 'Waves is the worst.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  // ── Codex round-24 findings (#2633) ──

  test('Codex r24: present-tense and call/name reflexive #1 claims block', () => {
    for (const prose of ['We claim #1.', 'We claim the #1 spot.', 'We call ourselves #1.', 'We name ourselves No. 1.', 'Bug Busters calls itself #1.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r24: subjectless accolade #1 verbs block', () => {
    for (const prose of ['Awarded #1 for customer service.', 'Chosen #1 by homeowners.', 'Selected #1 by homeowners.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r24: provider-noun separator and possessive accusations block; denials stay clean', () => {
    for (const prose of ['Pest control companies: hidden fees are common.', "Providers' scams are common."]) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const denial = gate.evaluate({ body: `Pest control companies: no hidden fees here.\n\n${CATEGORY_TABLE}` }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r24: competitor nouns are provider targets', () => {
    for (const prose of ['Our competitors are dishonest.', 'The competition has hidden fees.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r24: warning negators keep the accusation', () => {
    for (const prose of ['No one should ignore hidden fees after choosing Bug Busters.', 'No homeowner should overlook hidden fees after choosing Bug Busters.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  // ── Codex round-23 findings (#2633) ──

  test('Codex r23: table-less association accusations block; denials stay clean', () => {
    for (const prose of ['Customers report hidden fees after choosing Bug Busters.', "Acme Pest Solutions' hidden fees are common.", 'Customers report scams after choosing Acme Pest Solutions.']) {
      const r = gate.evaluate({ body: prose }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const denial = gate.evaluate({ body: 'Customers do not report hidden fees after choosing Bug Busters.' }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r23: negated recommendations with intervening words keep the accusation', () => {
    for (const prose of ['No one should choose Bug Busters because of hidden fees.', 'We advise homeowners not to choose Bug Busters because of hidden fees.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r23: scam-class own-brand association objects block', () => {
    for (const prose of ['Waves gets complaints about scams.', "Waves' ripoffs are common."]) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  // ── Codex round-22 findings (#2633) ──

  test('Codex r22: negated Waves complaint/insult claims are denials', () => {
    for (const prose of ['Waves does not get complaints about hidden fees.', 'Waves never gets complaints about hidden fees.', 'Customers do not call Waves a scam.', 'Customers never describe Waves as dishonest.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    }
  });

  test('Codex r22: list-framed "#1 in" stays educational; place-winner "#1 in" blocks', () => {
    const list = gate.evaluate({ body: `The #1 in every mosquito checklist is standing water.\n\n${CATEGORY_TABLE}` }, {});
    expect(list.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    const winner = gate.evaluate({ body: `We are #1 in Venice.\n\n${CATEGORY_TABLE}` }, {});
    expect(winner.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('Codex r22: contrastive "not just" lead-ins keep the Waves association accusation', () => {
    const r = gate.evaluate({ body: `Not just a rumor, hidden fees after choosing Waves are common.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r22: unambiguous scam-class association objects block', () => {
    for (const prose of ['Customers report scams after choosing Bug Busters.', 'Homeowners describe ripoffs from Acme Pest Solutions.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  // ── Codex round-21 findings (#2633) ──

  test('Codex r21: reputation accusations block; negated reputation stays a denial', () => {
    for (const prose of ['Avoid pest control providers known for hidden fees.', 'Companies accused of hidden fees keep showing up here.', 'Waves is known for hidden fees.', 'Bug Busters is notorious for shady billing.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const denial = gate.evaluate({ body: `Bug Busters is not known for hidden fees.\n\n${CATEGORY_TABLE}` }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r21: achievement-verb #1 claims block across subjects', () => {
    for (const prose of ['We earned the #1 spot in Venice.', "We've won the #1 spot.", 'Waves earned the #1 spot.', 'Bug Busters claimed the #1 spot.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r21: hyphenated provider nouns are disparagement targets', () => {
    for (const prose of ['Some shady pest-control companies cut corners.', 'Overpriced pest-control services are everywhere.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r21: phrasal fee verbs block', () => {
    for (const prose of ['Pest control companies add on hidden fees.', 'Some providers sneak hidden fees into contracts.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r21: own-brand headings with descriptors block', () => {
    for (const prose of ['Waves Review: Hidden fees.', 'Waves billing: hidden fees.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const rank = gate.evaluate({ body: `Waves review - the #1 choice.\n\n${CATEGORY_TABLE}` }, {});
    expect(rank.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('Codex r21: victimless bait-and-switch predicates block', () => {
    for (const prose of ['Pest control companies bait-and-switch with teaser prices.', 'Some providers run bait-and-switch pricing.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r21: own-brand association accusations block; lowercase noun stays clean', () => {
    for (const prose of ['Customers report hidden fees after choosing Waves.', 'Waves gets complaints about hidden fees.', "Waves' hidden fees are common."]) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const literal = gate.evaluate({ body: `Hidden fees are rare, and summer heat waves are the bigger story.\n\n${CATEGORY_TABLE}` }, {});
    expect(literal.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r21: #1-before-name winner framing blocks; educational threat framing stays clean', () => {
    for (const prose of ['The #1 spot belongs to Bug Busters.', 'The #1 overall is Waves.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
    const educational = gate.evaluate({ body: `The #1 threat in summer is the German roach, not your provider.\n\n${CATEGORY_TABLE}` }, {});
    expect(educational.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
  });

  // ── Codex round-20 findings (#2633) ──

  test('Codex r20: negators inside business names are not denials', () => {
    for (const body of ['No Bugs Pest Control is dishonest.', 'Zero Bugs LLC is dishonest.', `No Bugs Pest Control is dishonest.\n\n${CATEGORY_TABLE}`]) {
      const r = gate.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r20: negated recommendations keep the fee accusation; denied reports stay clean', () => {
    const rec = gate.evaluate({ body: `Do not choose Bug Busters because of hidden fees.\n\n${CATEGORY_TABLE}` }, {});
    expect(rec.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    const denial = gate.evaluate({ body: `Customers do not report hidden fees after choosing Bug Busters.\n\n${CATEGORY_TABLE}` }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r20: hyphenated provider phrases still declare a winner', () => {
    const r = gate.evaluate({ body: `Choose the #1-rated pest-control company in Venice.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('Codex r20: category consumer-protection copy stays clean beside a table', () => {
    const r = gate.evaluate({ body: `How to avoid hidden fees in pest control.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r20: directional geo leads stay educational table-less', () => {
    const r = gate.evaluate({ body: 'South Sarasota lawn care is unreliable without irrigation tuned first.' }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' || f.code === 'COMPARISON_NEGATIVE_RELIABILITY')).toBe(false);
  });

  test('Codex r20: object-association covers lowercase CI-detected names', () => {
    const r = gate.evaluate({ body: `Customers report hidden fees after choosing acme pest solutions.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  // ── Codex round-19 findings (#2633) ──

  test('Codex r19: header-shaped names are table-less targets', () => {
    for (const prose of ['Bug Busters scams customers.', 'Mosquito Squad charges hidden fees.', 'Acme Rodent Removal scams customers.']) {
      const r = gate.evaluate({ body: prose }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r19: lowercase heat-waves #1 and reverse-disparagement copy stay clean; capitalized forms block', () => {
    for (const prose of ['Summer heat waves are #1 on the list of turf stressors.', 'Lousy heat waves stress St. Augustinegrass.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING' || (f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0'))).toBe(false);
    }
    const rank = gate.evaluate({ body: `Waves, after years of serving Sarasota, is #1.\n\n${CATEGORY_TABLE}` }, {});
    expect(rank.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    const marketing = gate.evaluate({ body: `Waves advertises itself as #1.\n\n${CATEGORY_TABLE}` }, {});
    expect(marketing.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    const rev = gate.evaluate({ body: `Steer clear of dishonest Waves.\n\n${CATEGORY_TABLE}` }, {});
    expect(rev.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r19: negated subject-verb claims are denials in both paths', () => {
    for (const body of ["Acme Pest Solutions isn't dishonest.", 'Acme Pest Solutions is not dishonest.', 'Acme Pest Solutions never scams customers.', `Bug Busters isn't dishonest.\n\n${CATEGORY_TABLE}`]) {
      const r = gate.evaluate({ body }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    }
  });

  test('Codex r19: compound service-area geography stays clean', () => {
    const r = gate.evaluate({ body: `Pest control service areas are shady in summer.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('Codex r19: contrastive "not only" lead-ins stay accusations', () => {
    for (const prose of ['Not only that, hidden fees from Acme Pest Solutions are common.', 'Not only that, dishonest pricing from Acme Pest Solutions is common.']) {
      const r = gate.evaluate({ body: prose }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r19: "in pest control" is not a business name', () => {
    const r = gate.evaluate({ body: 'How to avoid hidden fees in pest control.' }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  // ── Codex round-18 findings (#2633) ──

  test('Codex r18: table-less modal and possession accusations block; denials stay clean', () => {
    for (const prose of ['Acme Pest Solutions may charge hidden fees.', 'Acme Pest Solutions uses scam pricing.', 'Avoid dishonest pricing from Acme Pest Solutions.']) {
      const r = gate.evaluate({ body: prose }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    // ("never" stays in SUBJECT_VERBS by prior design — the r15 denial
    // guards use "doesn't" for the same reason.)
    for (const prose of ["Acme Pest Solutions doesn't charge hidden fees.", 'There are no reports of hidden fees from Acme Pest Solutions.']) {
      const r = gate.evaluate({ body: prose }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    }
  });

  test('Codex r18: adjective-first service-area geography stays clean', () => {
    const r = gate.evaluate({ body: `Shady service areas around the lanai stay humid longest.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(r.pass).toBe(true);
  });

  test('Codex r18: statistical is-ranked #1 stays clean; heading-form Rated #1 still blocks', () => {
    const stat = gate.evaluate({ body: `Florida is ranked #1 for termite pressure.\n\n${CATEGORY_TABLE}` }, {});
    expect(stat.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(stat.pass).toBe(true);
    for (const prose of ['Rated the #1 choice by local homeowners.', 'We are ranked #1.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r18: negated competitor-adjective proximity is not a hard block', () => {
    const r = gate.evaluate({ body: `No shady billing from Orkin.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(false);
  });

  test('Codex r18: lowercase heat-waves linking copy stays clean; capitalized Waves subject blocks', () => {
    const literal = gate.evaluate({ body: `Summer heat waves can be lousy for St. Augustinegrass.\n\n${CATEGORY_TABLE}` }, {});
    expect(literal.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(literal.pass).toBe(true);
    const brand = gate.evaluate({ body: `Waves can be lousy at explaining fees.\n\n${CATEGORY_TABLE}` }, {});
    expect(brand.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r18: sentence-level denials of sourced accusations stay clean', () => {
    const r = gate.evaluate({ body: `There are no reports of hidden fees from acme pest solutions.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
  });

  test('Codex r18: without/zero separator denials stay clean', () => {
    for (const prose of ['Waves: zero hidden fees.', 'Bug Busters: without hidden fees or surprises.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    }
  });

  // ── Codex round-17 findings (#2633) ──

  test('Codex r17: bait-and-switch as a verb with a victim object blocks', () => {
    for (const prose of ['Pest control companies bait-and-switch homeowners with teaser prices.', 'Bug Busters bait-and-switched customers last spring.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r17: fee-adding verb variants block', () => {
    for (const prose of ['Waves adds hidden fees.', 'Pest control companies tack on hidden fees.', 'Bug Busters sneaks in hidden fees at renewal.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r17: scam/ripoff practice modifiers block', () => {
    for (const prose of ['Pest control companies use scam pricing.', 'Waves has ripoff pricing.', 'Bug Busters uses rip-off billing.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r17: accusation-phrase sourced at an extra name blocks; denials stay clean', () => {
    const r = gate.evaluate({ body: `Avoid dishonest pricing from acme pest solutions.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    // Still routes to review as an unclassified business name (fail-closed,
    // by design) — the guard is only that the denial is not DISPARAGEMENT.
    const denial = gate.evaluate({ body: `No hidden fees from Acme Pest Solutions, ever.\n\n${CATEGORY_TABLE}` }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(denial.findings.every((f) => f.severity !== 'P0')).toBe(true);
  });

  test('Codex r17: modal own-brand disparagement blocks', () => {
    for (const prose of ['Waves may be dishonest.', 'Waves could be dishonest about coverage.', 'We may be dishonest.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r17: first-person people-noun insults block; literal shade stays clean', () => {
    for (const prose of ['Our team is dishonest.', 'Our team is a scam.', 'Our technicians are clueless.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const literal = gate.evaluate({ body: `Our service area is shady and humid through September.\n\n${CATEGORY_TABLE}` }, {});
    expect(literal.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(literal.pass).toBe(true);
  });

  test('Codex r17: marketing-verb reflexive #1 claims block; product mentions stay clean', () => {
    for (const prose of ['Waves advertises itself as #1.', 'Waves markets itself as the #1 choice.', 'We market ourselves as the #1 choice.', 'Bug Busters advertises itself as #1.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
    const product = gate.evaluate({ body: `We advertise the #1-rated mosquito trap on the market.\n\n${CATEGORY_TABLE}` }, {});
    expect(product.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
  });

  // ── Codex round-16 findings (#2633) ──

  test('Codex r16: standalone appear copulas block across subject classes', () => {
    for (const prose of ['Pest control companies appear dishonest.', 'Bug Busters appears dishonest.', 'Waves appears dishonest.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r16: prepositional fee accusations block; denials stay clean', () => {
    for (const prose of ['Pest control companies with hidden fees should be avoided.', 'Providers with shady billing should be avoided.', 'Acme Rodent Removal with hidden fees should be avoided.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const denial = gate.evaluate({ body: `Providers with no hidden fees are worth keeping.\n\n${CATEGORY_TABLE}` }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(denial.pass).toBe(true);
  });

  test('Codex r16: appositive possession insults on extra prose names block', () => {
    for (const prose of ['Acme Rodent Removal, frankly, comes with hidden fees.', 'Bug Busters, a local option, uses shady billing.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r16: adverbed first-person and subject #1 claims block; denials stay clean', () => {
    for (const prose of ["We're currently #1!", 'We are currently the #1!', 'Pest control companies are currently #1.', 'Bug Busters is currently #1.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
    const denial = gate.evaluate({ body: `We are not #1 yet, and that keeps us honest about pricing reviews.\n\n${CATEGORY_TABLE}` }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
  });

  test('Codex r16: customer-choice #1 claims block in us-object and name-object forms', () => {
    for (const prose of ['Homeowners choose us as #1.', 'Customers make us their #1 choice.', 'Customers make Bug Busters their #1 choice.', 'Homeowners choose Acme Rodent Removal as #1.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  // ── Codex round-15 findings (#2633) ──

  test('Codex r15: appositive active insults against extra prose names block; denials stay clean', () => {
    for (const prose of ['Bug Busters, frankly, scams customers.', 'Acme Rodent Removal, frankly, overcharges for callbacks.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    // NOUN_VERB_GAP words are negator-excluded — the appositive gap must not
    // swallow a denial's negator ("never" itself routes through directedP0's
    // SUBJECT_VERBS by prior design, so the guard uses "doesn't").
    const denial = gate.evaluate({ body: `Bug Busters doesn't scam customers.\n\n${CATEGORY_TABLE}` }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(denial.pass).toBe(true);
  });

  test('Codex r15: hedged linking-verb insults on extra prose names block', () => {
    for (const prose of ['Bug Busters may be dishonest.', 'Acme Rodent Removal appears to be dishonest.', 'A+ Pest Control could be overpriced for what you get.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r15: comma-separated unambiguous insults on non-personified extra names block', () => {
    for (const prose of ['A+ Pest Control, dishonest.', 'Acme Rodent Removal, dishonest.', 'Acme Pest Solutions, hidden fees on every renewal.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r15: separator #1 winner claims on non-personified extra names block; non-winner tails stay clean', () => {
    for (const prose of ['A+ Pest Control — the #1 choice.', '360 Pest Control: the #1 provider in the county.', 'Acme Rodent Removal, the #1 rated company around.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
    const educational = gate.evaluate({ body: `Acme Rodent Removal — the #1 mistake homeowners make is sealing vents too late.\n\n${CATEGORY_TABLE}` }, {});
    expect(educational.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(educational.pass).toBe(true);
  });

  // ── Codex round-14 findings (#2633) ──

  test('Codex r14: sentence-case full brand before separators blocks; lowercase common noun stays clean', () => {
    const disp = gate.evaluate({ body: `Waves pest control: hidden fees.\n\n${CATEGORY_TABLE}` }, {});
    expect(disp.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    const rank = gate.evaluate({ body: `Choose Waves pest control, the #1 choice.\n\n${CATEGORY_TABLE}` }, {});
    expect(rank.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    const literal = gate.evaluate({ body: `During summer heat waves pest control matters even more.\n\n${CATEGORY_TABLE}` }, {});
    expect(literal.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(literal.pass).toBe(true);
  });

  test('Codex r14: own-brand object-position insults block; literal noun stays clean', () => {
    for (const prose of ['Homeowners call Waves a scam.', 'Customers describe Waves as dishonest.', 'Some reviews called us a ripoff.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const literal = gate.evaluate({ body: `Experts call heat waves a serious lawn stressor.\n\n${CATEGORY_TABLE}` }, {});
    expect(literal.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(literal.pass).toBe(true);
  });

  test('Codex r14: "as #1" object-position ranking on extra prose names blocks', () => {
    const r = gate.evaluate({ body: `Reviews rated Bug Busters as #1.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('Codex r14: bare and typographic possessives on extra prose names block', () => {
    for (const prose of ["Bug Busters' billing is dishonest.", 'Bug Busters’ practices are shady.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r14: first-person ranking variants block; transitive educational "rank the #1" stays clean', () => {
    for (const prose of ['We rank #1 for a reason.', 'We remain #1.', 'Customers rated us #1 again this year.', 'Local homeowners voted us the #1 choice.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
    const educational = gate.evaluate({ body: `Below, we rank the #1 breeding sites around your yard.\n\n${CATEGORY_TABLE}` }, {});
    expect(educational.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(educational.pass).toBe(true);
  });

  test('Codex r14: first-person possessive own-brand claims block; literal shade stays clean', () => {
    for (const prose of ['Our billing is shady.', 'Our pricing is dishonest.', 'Our team charges hidden fees.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const literal = gate.evaluate({ body: `Our lanais are shady and humid in August.\n\n${CATEGORY_TABLE}` }, {});
    expect(literal.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(literal.pass).toBe(true);
  });

  // ── Codex round-13 findings (#2633): 2 fixed, 3 rebutted with the guard tests below ──

  test('Codex r13: full brand name before separators blocks', () => {
    const disp = gate.evaluate({ body: `Waves Pest Control: hidden fees.\n\n${CATEGORY_TABLE}` }, {});
    expect(disp.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    const rank = gate.evaluate({ body: `Waves Pest Control — the #1 choice.\n\n${CATEGORY_TABLE}` }, {});
    expect(rank.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('Codex r13: verb-anchored object-position insults block', () => {
    for (const prose of ['Homeowners call Bug Busters a scam.', 'Customers describe A+ Pest Control as dishonest.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r13 REBUTTAL evidence: the requested broader shapes would false-positive on real copy', () => {
    // Comma appositive for own-brand disparagement: marketing denial copy.
    const denial = gate.evaluate({ body: `With Waves, hidden fees are a thing of the past.\n\n${CATEGORY_TABLE}` }, {});
    expect(denial.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(denial.pass).toBe(true);
    // Separator-#1 on noisy CI captures: educational method framing.
    const method = gate.evaluate({ body: `Start with baiting and termite prevention, the #1 defense is a pre-slab barrier.\n\n${CATEGORY_TABLE}` }, {});
    expect(method.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(method.pass).toBe(true);
  });

  // ── Codex round-12 findings (#2633) ──

  test('Codex r12: own-brand separator #1 blocks; negated separator claims stay clean', () => {
    for (const prose of ['Waves — the #1 choice for mosquito control.', 'Waves: the #1 choice.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
    for (const prose of ['Waves: no hidden fees, ever.', 'Waves — not a ripoff, just flat quoted pricing.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
      expect(r.pass).toBe(true);
    }
  });

  test('Codex r12: extra-name separator #1 and separator insults block', () => {
    for (const prose of ['Bug Busters, the #1 choice.', 'Bug Busters — the #1 choice.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
    for (const prose of ['A+ Pest Control: overpriced.', 'acme pest solutions: dishonest.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r12: negated object reports stay clean', () => {
    const r = gate.evaluate({ body: `Customers do not report hidden fees after choosing Bug Busters.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(r.pass).toBe(true);
  });

  // ── Codex round-11 findings (#2633) ──

  test('Codex r11: a benign earlier own-brand mention does not shadow a later accusation', () => {
    const disp = gate.evaluate({ body: `Waves — shady foliage guide for damp yards.\n\nWaves: hidden fees on renewals.\n\n${CATEGORY_TABLE}` }, {});
    expect(disp.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    const rank = gate.evaluate({ body: `Waves — seasonal mosquito guide.\n\nChoose Waves, the #1 choice for mosquito control.\n\n${CATEGORY_TABLE}` }, {});
    expect(rank.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('Codex r11: sensory linking verbs at provider nouns block', () => {
    for (const prose of ['Pest control companies look dishonest to most homeowners.', 'Some providers sound shady on the phone.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r11: provider-noun subjects ranked #1 block', () => {
    for (const prose of ['Pest control companies are #1.', 'Pest control providers rank #1 in our book.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r11: object-position extra-name shapes block; denials stay clean', () => {
    const rank = gate.evaluate({ body: `Local reviews call Bug Busters the #1 choice.\n\n${CATEGORY_TABLE}` }, {});
    expect(rank.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    const disp = gate.evaluate({ body: `Customers report hidden fees after choosing Bug Busters.\n\n${CATEGORY_TABLE}` }, {});
    expect(disp.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    const ok = gate.evaluate({ body: `Bug Busters quotes flat pricing with no hidden fees.\n\n${CATEGORY_TABLE}` }, {});
    expect(ok.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(ok.pass).toBe(true);
  });

  // ── Codex round-9 tail + round-10 findings (#2633) ──

  test('Codex r10: heading-cased own-brand separator accusations block; literal-shade headings stay clean', () => {
    for (const prose of ['Waves: Hidden fees on renewals.', 'Waves — Shady billing.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const ok = gate.evaluate({ body: `Waves — shady foliage on the north side stays damp the longest.\n\n${CATEGORY_TABLE}` }, {});
    expect(ok.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(ok.pass).toBe(true);
  });

  test('Codex r10: heading-cased own-brand appositive #1 blocks', () => {
    for (const prose of ['Choose WAVES, the #1 choice for mosquito control.', 'Choose Waves, The #1 Choice for Mosquito Control.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  test('Codex r10: appositive and modal forms for extra names block', () => {
    for (const prose of ['Bug Busters, frankly, is #1.', 'Acme Rodent Removal, frankly, is #1.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
    for (const prose of ['Bug Busters sometimes scams customers.', 'Acme Rodent Removal may charge hidden fees.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r10: modal provider-noun disparagement blocks', () => {
    const r = gate.evaluate({ body: `Pest control companies may be dishonest about what a quote covers.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r10: geo-scoped "#1 option" blocks; method "#1 option for" stays clean', () => {
    const r = gate.evaluate({ body: `The #1 option in Venice for pest control.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  // ── Codex round-9 finding (#2633) ──

  test('Codex r9: service-line "#1 … choice" winner claims block; method rankings stay clean', () => {
    for (const prose of ['The #1 mosquito control choice in Venice.', 'The #1 termite control option for your home.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
    const ok = gate.evaluate({ body: `The #1 option for standing water is a Bti dunk, refreshed monthly.\n\n${CATEGORY_TABLE}` }, {});
    expect(ok.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(ok.pass).toBe(true);
  });

  // ── Codex round-8 finding (#2633) ──

  test('Codex r8: "#10" / "No. 10" ordinals do not match the "#1" prefix', () => {
    for (const prose of ['We are #10 on the callback list for the county.', 'Rated No. 10 in the region for call volume.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
      expect(r.pass).toBe(true);
    }
  });

  // ── Codex round-7 findings (#2633) ──

  test('Codex r7: own-brand appositive and separator forms block; lowercase common noun stays clean', () => {
    for (const prose of [
      'Choose Waves, the #1 choice for mosquito control.',
      'Waves: hidden fees on renewals.',
      'Waves — shady billing.',
      'Waves, frankly, charges hidden fees.',
    ]) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING' || (f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0'))).toBe(true);
    }
    const ok = gate.evaluate({ body: `Summer heat waves — shady, damp corners hold the moisture mosquitoes need.\n\n${CATEGORY_TABLE}` }, {});
    expect(ok.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' || f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(ok.pass).toBe(true);
  });

  test('Codex r7: appositive active accusations at provider nouns block', () => {
    for (const prose of ['Pest control companies, frankly, charge hidden fees.', 'Pest control companies, a local option, scam customers.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r7: hyphenated "#1-rated" provider claims block', () => {
    for (const prose of ['The #1-rated pest control company in Venice.', 'The No. 1-rated pest control company.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    }
  });

  // ── Codex round-6 findings (#2633) ──

  test('Codex r6: digit/punctuated provider names are tone-scan targets', () => {
    const rank = gate.evaluate({ body: `360 Pest Control is #1.\n\n${CATEGORY_TABLE}` }, {});
    expect(rank.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    const disp = gate.evaluate({ body: `A+ Pest Control: shady billing.\n\n${CATEGORY_TABLE}` }, {});
    expect(disp.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
  });

  test('Codex r6: punctuation-separated lowercase accusations block via the accusation object', () => {
    for (const prose of ['acme pest solutions: shady billing.', 'bob bugs llc: hidden fees on every renewal.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r6: own-brand usage accusations and first-person forms block', () => {
    for (const prose of ['Waves uses shady billing.', 'We charge hidden fees.', 'We are dishonest.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r6: "We are your #1 choice" blocks', () => {
    const r = gate.evaluate({ body: `We are your #1 choice in Venice.\n\n${CATEGORY_TABLE}` }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
  });

  test('Codex r6: negated accusations and first-person relative clauses stay clean', () => {
    for (const prose of [
      'Waves never overcharges — flat quoted pricing, every time.',
      'We never charge hidden fees.',
      'The zones we treat are shady, damp corners of the lanai.',
    ]) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
      expect(r.pass).toBe(true);
    }
  });

  test('Codex r5: own-brand appositive/linking-verb disparagement and long-distance #1 block', () => {
    for (const prose of ['Waves, frankly, is dishonest.', 'Waves stays dishonest.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const rank = gate.evaluate({ body: `Waves, after years of serving Sarasota homeowners with recurring pest plans, is #1.\n\n${CATEGORY_TABLE}` }, {});
    expect(rank.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    // Reversed structure stays clean: the verb is not adjacent to the number.
    const ok = gate.evaluate({ body: `In summer heat waves, the #1 hidden breeding site is the clogged gutter.\n\n${CATEGORY_TABLE}` }, {});
    expect(ok.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(ok.pass).toBe(true);
  });

  test('Codex r5: appositive gaps in extra-name disparagement block', () => {
    for (const prose of ['bug busters, a local option, is dishonest.', 'acme pest solutions, a local option, is dishonest.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
  });

  test('Codex r4 (P2): extra-name self-ranking and possession accusations block; CI-capture proximity does not', () => {
    const selfRank = gate.evaluate({ body: `Bug Busters is #1.\n\n${CATEGORY_TABLE}` }, {});
    expect(selfRank.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(true);
    for (const prose of ['Bug Busters uses shady billing.', 'Acme Rodent Removal comes with hidden fees.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    // A noisy CI capture ("in termite prevention") must not lend ranking
    // context by proximity — directed subject-verb ties only.
    const ok = gate.evaluate({ body: `The #1 mistake in termite prevention is skipping the pre-slab treatment.\n\n${CATEGORY_TABLE}` }, {});
    expect(ok.findings.some((f) => f.code === 'COMPARISON_RIGGED_RANKING')).toBe(false);
    expect(ok.pass).toBe(true);
  });

  test('Codex r4 (P2): literal-shade prose adjacent to a sourced competitor table stays clean', () => {
    const sourced = `<ComparisonTable
  columns={["What to weigh","Orkin","Local SWFL company"]}
  rows={[
    { label: "Reach", values: ["National (US)","Local to Manatee/Sarasota/Charlotte"] }
  ]}
  caption="Attributes as of June 2026, per each company public website." />`;
    const r = gate.evaluate({ body: `Adult mosquitoes rest in shady foliage between blood meals.\n${sourced}` }, { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(r.pass).toBe(true);
    expect(r.requiresHumanReview).toBe(true); // named competitor still never auto-publishes
  });

  test('Codex r1 (P2): own-brand disparagement blocks; own brand near pest vocabulary does not', () => {
    for (const prose of ['Waves is dishonest.', 'Waves charges hidden fees on renewals.']) {
      const r = gate.evaluate({ body: `${prose}\n\n${CATEGORY_TABLE}` }, {});
      expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT' && f.severity === 'P0')).toBe(true);
    }
    const ok = gate.evaluate({ body: `Waves keeps shady, damp corners of the lanai treated year-round.\n\n${CATEGORY_TABLE}` }, {});
    expect(ok.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
    expect(ok.pass).toBe(true);
  });
});

describe('top-level title/meta in comparison scans (Codex round 10)', () => {
  test('a disparaging TOP-LEVEL title is scanned even though frontmatter is empty', () => {
    // The runner and sibling gates accept the metadata-at-top-level draft
    // shape; draftScanTexts only read frontmatter, so a disparaging title
    // there escaped the legal scan entirely.
    const r = gate.evaluate({ body: 'Clean prose about seasonal pests.', title: 'Orkin is dishonest about pricing' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(true);
  });
  test('a metadata-only draft (no body) still gets its title scanned', () => {
    const r = gate.evaluate({ title: 'Orkin overcharges everyone' }, {});
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_IN_PROSE')).toBe(true);
  });
  test('clean top-level title passes', () => {
    const r = gate.evaluate({ body: 'Clean prose.', title: 'Seasonal Pest Guide for Bradenton' }, {});
    expect(r.pass).toBe(true);
  });
});

describe('top-level title/meta on the TABLE path (Codex round 11)', () => {
  test('a top-level competitor title alongside a sourced table raises the prose finding, not just review', () => {
    // The table path rebuilt metaText from frontmatter only, so a TOP-LEVEL
    // "Orkin vs Waves" title rode along with requiresHumanReview alone.
    const body = [
      'Intro prose.',
      '<ComparisonTable competitor="Orkin" sources={["https://www.orkin.com/plans"]}>',
      '| Feature | Waves | Orkin |',
      '</ComparisonTable>',
    ].join('\n');
    const r = gate.evaluate({ body, title: 'Orkin vs Waves in Sarasota' }, {});
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_IN_PROSE')).toBe(true);
  });
});
