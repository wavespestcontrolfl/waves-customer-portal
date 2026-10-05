// "From your technician" on the lawn LEAD (GATE_LAWN_TECH_PARAGRAPH): the frozen
// text rides a non-enumerable hand-off (reportV2.techParagraph) and reaches the
// customer only as reportV2.lead.techParagraph. It is additive: no key without
// it, first in the budget drop order, never displacing a fixed sentence.
// Synthetic payloads only.

const { deriveLawnLead, leadWords, FIELD_WORD_CAPS } = require('../services/service-report/lawn-report-lead');
const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');

const TEXT = 'Our technician saw chinch bugs at the trouble spot, which explains the damaged turf in the photo. Arena 50 WDG went on the front and side yards to treat them.';
const words = (n) => Array.from({ length: n }, () => 'word').join(' ');

const reportOf = (overrides = {}) => ({
  snapshot: {
    statusHeadline: 'Looking great',
    scoreExplanation: 'The score is high across the lawn.',
    rootCause: null,
    treatmentSummary: 'Today we applied an insect control and a fertilizer.',
    customerAction: 'Keep the mower at 4 inches.',
    wavesNext: null,
  },
  insights: [],
  followUp: null,
  water: {},
  ...overrides,
});

describe('deriveLawnLead', () => {
  test('carries the paragraph as given; without it the lead has no such key (gate off is byte-identical)', () => {
    const lead = deriveLawnLead(reportOf(), { techParagraph: TEXT });
    expect(lead.techParagraph).toBe(TEXT);
    const plain = deriveLawnLead(reportOf());
    expect(plain).not.toHaveProperty('techParagraph');
    expect(deriveLawnLead(reportOf(), { techParagraph: '   ' })).toEqual(plain);
    expect(deriveLawnLead(reportOf(), { techParagraph: null })).toEqual(plain);
    const { techParagraph, ...rest } = lead; // eslint-disable-line no-unused-vars
    expect(rest).toEqual(plain);
  });

  test('a text over the word cap is left out whole, never cut', () => {
    expect(FIELD_WORD_CAPS.techParagraph).toBe(70);
    expect(deriveLawnLead(reportOf(), { techParagraph: words(71) })).not.toHaveProperty('techParagraph');
    expect(deriveLawnLead(reportOf(), { techParagraph: words(70) }).techParagraph).toBe(words(70));
  });

  test('the words count against the 250-word region, and the paragraph goes first under pressure', () => {
    const banner = { state: 'hold', lines: [words(150)] };
    const r = reportOf({ banner });
    const base = deriveLawnLead(r);
    const withTech = deriveLawnLead(r, { techParagraph: words(70) });
    // Every fixed field survives exactly as without the paragraph; only the paragraph gives way.
    expect(withTech).toEqual(base);
    expect(leadWords({ ...r, lead: withTech })).toBeLessThanOrEqual(250);
    // Room to spare: the paragraph stays, and is counted with its label.
    const roomy = reportOf();
    const lead = deriveLawnLead(roomy, { techParagraph: words(70) });
    expect(lead.techParagraph).toBeDefined();
    expect(leadWords({ ...roomy, lead })).toBe(leadWords({ ...roomy, lead: deriveLawnLead(roomy) }) + 70 + 3);
    expect(leadWords({ ...roomy, lead })).toBeLessThanOrEqual(250);
  });
});

describe('the hand-off never reaches the payload', () => {
  const ENV = 'GATE_LAWN_REPORT_LEAD';
  const saved = process.env[ENV];
  afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });
  const dynamic = () => ({ reentry: { targets: [{ statusAtGeneratedAt: 'ready' }], petAdvisory: 'Keep pets off treated turf until dry.' } });
  const payload = (techParagraph) => {
    const reportV2 = reportOf();
    if (techParagraph) Object.defineProperty(reportV2, 'techParagraph', { value: techParagraph, enumerable: false, writable: true, configurable: true });
    return { serviceLine: 'lawn', reportV2 };
  };

  test('the lead carries the text; reportV2 has no techParagraph key of its own', () => {
    process.env[ENV] = 'true';
    const out = applyLawnReportReconciliation(payload(TEXT), dynamic());
    expect(out.reportV2.lead.techParagraph).toBe(TEXT);
    expect(Object.prototype.hasOwnProperty.call(out.reportV2, 'techParagraph')).toBe(false);
    expect(JSON.stringify(out).split(TEXT).length - 1).toBe(1);
  });

  test('no hand-off, or the lead gate off: nothing appears', () => {
    process.env[ENV] = 'true';
    expect(applyLawnReportReconciliation(payload(null), dynamic()).reportV2.lead).not.toHaveProperty('techParagraph');
    delete process.env[ENV];
    expect(JSON.stringify(applyLawnReportReconciliation(payload(TEXT), dynamic()))).not.toContain(TEXT);
  });
});
