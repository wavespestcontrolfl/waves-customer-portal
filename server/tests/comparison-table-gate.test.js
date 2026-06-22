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

  test('legitimate pest/efficacy vocab ("garbage", "unreliable") does NOT trip disparagement', () => {
    const t = CATEGORY_TABLE
      .replace('Generic playbook', 'Store garbage in sealed bins')
      .replace('Lowest upfront', 'DIY sprays are unreliable on termites');
    const r = gate.evaluate(wrap(t), { namedCompetitorEnabled: true });
    expect(r.findings.some((f) => f.code === 'COMPARISON_DISPARAGEMENT')).toBe(false);
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

  test('a known competitor with feature ENABLED but UNSOURCED caption is flagged + still routes to review', () => {
    const r = gate.evaluate(wrap(NAMED_TABLE('A quick look at your options.')), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_UNSOURCED' && f.severity === 'P1')).toBe(true);
    expect(r.findings.some((f) => f.code === 'COMPARISON_NAMED_COMPETITOR_REVIEW')).toBe(true);
  });

  test('a known competitor with feature ENABLED + sourced caption still ALWAYS routes to review (never auto-publishes)', () => {
    const r = gate.evaluate(wrap(NAMED_TABLE('Attributes as of June 2026, per each company public website.')), { namedCompetitorEnabled: true });
    expect(r.pass).toBe(false);
    // No hard P0 and no "unsourced" finding — the only thing holding it is the mandatory human review.
    expect(r.findings.some((f) => f.severity === 'P0')).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_COMPETITOR_UNSOURCED')).toBe(false);
    expect(r.findings.some((f) => f.code === 'COMPARISON_NAMED_COMPETITOR_REVIEW' && f.severity === 'P1')).toBe(true);
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
