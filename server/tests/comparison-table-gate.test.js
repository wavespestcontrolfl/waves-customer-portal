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

  test('a web-search-style business name (industry suffix, not allowlisted) used as a column fails closed', () => {
    const t = CATEGORY_TABLE.replace('National chain', 'Acme Pest Control');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION')).toBe(true);
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
