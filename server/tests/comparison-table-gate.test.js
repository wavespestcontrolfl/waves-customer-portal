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

  test('finding B: a non-comparison draft mentioning a competitor/IPM passes untouched', () => {
    const r = gate.evaluate({ body: 'Integrated Pest Management works. Orkin is a national brand. No table here.' }, { namedCompetitorEnabled: true });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
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

  test('finding C: a known competitor with feature ENABLED + sourced caption PASSES (flows to the trust-build approval ramp)', () => {
    const r = gate.evaluate(wrap(NAMED_TABLE('Attributes as of June 2026, per each company public website.')), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(0);
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
});
