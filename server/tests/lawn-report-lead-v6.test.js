// The v6 copy writer's fields (P14, GATE_LAWN_REPORT_COPY_V6) on the lawn LEAD:
// headline replaces the lead's headline when present and whatWeDid is the ONLY
// applied source, whatToExpect and watching are new lead fields, every field keeps
// the lead's own caps and watering-wording rule, the word budget has a drop
// order for them, and the carrier (reportV2.copyV6) never reaches the payload.
// Gate off (no copyV6) is byte-identical to the lead before this PR.
// Synthetic payloads only.

const { deriveLawnLead, leadWords, FIELD_WORD_CAPS } = require('../services/service-report/lawn-report-lead');
const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');

const words = (n) => Array.from({ length: n }, () => 'word').join(' ');
const HOLD_BANNER = { state: 'hold', lines: ['Skip your turf watering until Thu 3 PM.', 'That gives today’s treatment time to work.'] };

const reportOf = (overrides = {}) => ({
  snapshot: {
    statusHeadline: 'Stable — watching weeds',
    scoreExplanation: 'The score is mainly pulled down by weed pressure.',
    rootCause: null,
    treatmentSummary: 'Today we applied a broadleaf herbicide to the edge weeds.',
    customerAction: 'Raise your mower to 4 inches this week.',
    wavesNext: 'We will recheck the edge.',
  },
  insights: [{
    category: 'weeds', status: 'watch', priority: 1, headline: 'Weeds along the edge',
    customerAction: 'Raise your mower to 4 inches this week.', nextVisitPlan: 'Spot-treat the edge weeds.',
  }],
  followUp: null,
  water: {},
  ...overrides,
});

const V6 = {
  headline: 'Healthy overall, with a few spots to watch',
  whatWeDid: 'We spot-treated the broadleaf weeds with a selective weed control.',
  whatToExpect: 'By your next visit, most treated weeds should be yellowing, browning or both.',
  watching: 'Thin areas along the driveway edge, which may be signs of heat stress.',
};

describe('deriveLawnLead with the v6 writer fields', () => {
  test('with the since-last block too: both keep their keys, and the budget gives writer fields up before sinceLast', () => {
    const SINCE = { priorDate: '2026-08-01', lines: ['Last visit we treated the edge weeds.'] };
    const lead = deriveLawnLead(reportOf(), { copyV6: V6, sinceLast: SINCE });
    expect(lead.sinceLast).toEqual(SINCE);
    expect(lead.whatToExpect).toBe(V6.whatToExpect);
    expect(lead.watching).toBe(V6.watching);
    // A long banner forces drops: why, watching, applied and whatToExpect go
    // before the since-last block does.
    const banner = { state: 'hold', lines: [words(165)] };
    const tight = deriveLawnLead(reportOf({ banner }), { copyV6: V6, sinceLast: SINCE });
    expect(tight.why).toBeNull();
    expect(tight).not.toHaveProperty('watching');
    expect(tight.sinceLast).toEqual(SINCE);
    expect(leadWords({ ...reportOf({ banner }), lead: tight })).toBeLessThanOrEqual(250);
  });

  test('no copyV6: the lead is exactly what it was, with no new keys (gate off is byte-identical)', () => {
    const lead = deriveLawnLead(reportOf());
    expect(lead).toEqual({
      headline: 'Stable — watching weeds',
      why: 'The score is mainly pulled down by weed pressure.',
      applied: 'Today we applied a broadleaf herbicide to the edge weeds.',
      yourPart: ['Raise your mower to 4 inches this week.'],
      next: 'Spot-treat the edge weeds.',
    });
    expect(Object.keys(lead)).not.toContain('whatToExpect');
    expect(Object.keys(lead)).not.toContain('watching');
    // An empty or non-object carrier is ignored the same way.
    for (const junk of [null, undefined, [], 'x', 0]) expect(Object.keys(deriveLawnLead(reportOf(), { copyV6: junk }))).toEqual(Object.keys(lead));
  });

  test('headline and whatWeDid replace the lead sources; whatToExpect and watching are new lead fields', () => {
    const lead = deriveLawnLead(reportOf(), { copyV6: V6 });
    expect(lead).toEqual({
      headline: V6.headline,
      why: 'The score is mainly pulled down by weed pressure.',
      applied: V6.whatWeDid,
      yourPart: ['Raise your mower to 4 inches this week.'],
      next: 'Spot-treat the edge weeds.',
      whatToExpect: V6.whatToExpect,
      watching: V6.watching,
    });
  });

  test('a null headline falls to the snapshot; a null whatWeDid leaves applied EMPTY (never the AI narrative in treatmentSummary)', () => {
    const lead = deriveLawnLead(reportOf(), { copyV6: { headline: null, whatWeDid: null, whatToExpect: null, watching: null } });
    expect(lead.headline).toBe('Stable — watching weeds');
    expect(lead.applied).toBeNull();
    // The two optional keys are absent, not null, when they have nothing to say.
    expect(Object.keys(lead).sort()).toEqual(['applied', 'headline', 'next', 'why', 'yourPart']);
  });

  test('under a watering banner the lead\'s own wording rule still applies to the new fields', () => {
    const lead = deriveLawnLead(reportOf({ banner: HOLD_BANNER }), {
      copyV6: {
        headline: 'Weeds are the focus, not the water', whatWeDid: V6.whatWeDid, whatToExpect: 'Color holds up while the soil stays moist.', watching: V6.watching,
      },
    });
    expect(lead.headline).toBe('Stable — watching weeds'); // fell to its next source
    expect(Object.keys(lead)).not.toContain('whatToExpect');
    expect(lead.watching).toBe(V6.watching);
    expect(lead.applied).toBe(V6.whatWeDid);
  });

  test('each new field keeps its own word cap: over the cap it is left out, never cut', () => {
    expect(FIELD_WORD_CAPS.whatToExpect).toBe(42);
    expect(FIELD_WORD_CAPS.watching).toBe(20);
    const atCap = deriveLawnLead(reportOf(), { copyV6: { ...V6, whatToExpect: words(42), watching: words(20) } });
    expect(atCap.whatToExpect).toBe(words(42));
    expect(atCap.watching).toBe(words(20));
    const over = deriveLawnLead(reportOf(), { copyV6: { ...V6, whatToExpect: words(43), watching: words(21) } });
    expect(Object.keys(over)).not.toContain('whatToExpect');
    expect(Object.keys(over)).not.toContain('watching');
  });
});

describe('lead word budget with the v6 fields', () => {
  const build = (bannerWords, copy = { ...V6, whatToExpect: words(42), watching: words(20), whatWeDid: words(32), headline: words(8) }) => {
    const banner = { state: 'hold', lines: bannerWords.map(words), mowHold: null };
    const r = reportOf({ banner, insights: [{ category: 'weeds', status: 'watch', priority: 1, customerAction: words(30), nextVisitPlan: words(30) }] });
    Object.assign(r.snapshot, { rootCause: words(40), nextVisit: { label: 'Tuesday, October 13', source: 'estimated', cadenceWeeks: 4 } });
    return { r, lead: deriveLawnLead(r, { copyV6: copy }) };
  };

  test('leadWords counts whatToExpect and watching', () => {
    const r = reportOf();
    const base = leadWords({ ...r, lead: deriveLawnLead(r) });
    const withV6 = leadWords({ ...r, lead: deriveLawnLead(r, { copyV6: V6 }) });
    expect(withV6).toBeGreaterThan(base);
    const lead = { headline: null, why: null, applied: null, yourPart: [], next: null, whatToExpect: words(10), watching: words(5) };
    // 15 words of text, the 3 + 1 label words, and the 24 static label words.
    expect(leadWords({ snapshot: {}, lead })).toBe(15 + 3 + 1 + 24);
  });

  test('inside the budget nothing is dropped', () => {
    const { r, lead } = build([2, 2]);
    expect(leadWords({ ...r, lead })).toBeLessThanOrEqual(250);
    expect(lead.whatToExpect).toBe(words(42));
    expect(lead.watching).toBe(words(20));
    expect(lead.why).toBe(words(40));
  });

  test('over the budget fields go in a stated order: why, watching, applied, and whatToExpect LAST', () => {
    // headline 8 + why 40 + applied 32 + yourPart 30 + next 30 + date + 42 + 20 + labels leaves room for a banner of ~14 words.
    const order = [];
    for (const bannerWords of [[20, 20, 20], [30, 25, 25], [40, 30, 30], [48, 48, 48]]) {
      const { r, lead } = build(bannerWords);
      order.push(['why', 'watching', 'applied', 'whatToExpect'].filter((f) => lead[f] === null || !(f in lead)));
      expect(leadWords({ ...r, lead })).toBeLessThanOrEqual(250);
    }
    // Each step drops a prefix of the order, never a later field before an earlier one.
    const prefixes = [[], ['why'], ['why', 'watching'], ['why', 'watching', 'applied'], ['why', 'watching', 'applied', 'whatToExpect']];
    for (const dropped of order) expect(prefixes).toContainEqual(dropped);
    expect(order[order.length - 1]).toEqual(expect.arrayContaining(['why', 'watching']));
    // whatToExpect is only ever given up after applied.
    for (const dropped of order) if (dropped.includes('whatToExpect')) expect(dropped).toContain('applied');
  });

  test('a lead with no writer fields never grows a key under budget pressure', () => {
    const banner = { state: 'hold', lines: [words(48), words(48), words(48)], mowHold: null };
    const r = reportOf({ banner, insights: [{ category: 'weeds', status: 'watch', priority: 1, customerAction: words(30), nextVisitPlan: words(30) }] });
    Object.assign(r.snapshot, { rootCause: words(40), treatmentSummary: words(60), statusHeadline: words(12) });
    const lead = deriveLawnLead(r);
    expect(Object.keys(lead).sort()).toEqual(['applied', 'headline', 'next', 'why', 'yourPart']);
    expect(lead.why).toBeNull();
  });
});

describe('the hand-off never reaches the payload', () => {
  const ENV = 'GATE_LAWN_REPORT_LEAD';
  const saved = process.env[ENV];
  afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });
  const dynamic = () => ({ reentry: { targets: [{ statusAtGeneratedAt: 'ready' }], petAdvisory: 'Keep pets off treated turf until dry.' } });
  // The hand-off is non-enumerable, exactly as report-data.js attaches it (and
  // as reportV2.progress is): the reconcile pass's spread would drop an enumerable-less copy,
  // so it is read first.
  const payload = (copyV6) => {
    const reportV2 = reportOf();
    if (copyV6) Object.defineProperty(reportV2, 'copyV6', { value: copyV6, enumerable: false, writable: true, configurable: true });
    return { serviceLine: 'lawn', reportV2 };
  };

  test('the lead carries the fields, and no copyV6 key ever appears in the payload', () => {
    process.env[ENV] = 'true';
    const out = applyLawnReportReconciliation(payload(V6), dynamic());
    expect(out.reportV2.lead).toMatchObject({ headline: V6.headline, applied: V6.whatWeDid, whatToExpect: V6.whatToExpect, watching: V6.watching });
    expect(Object.prototype.hasOwnProperty.call(out.reportV2, 'copyV6')).toBe(false);
    expect(JSON.stringify(out)).not.toContain('copyV6');
  });

  test('lead gate off: no lead, no copyV6 key, and the writer fields appear nowhere', () => {
    delete process.env[ENV];
    const off = applyLawnReportReconciliation(payload(V6), dynamic());
    expect(Object.prototype.hasOwnProperty.call(off.reportV2, 'lead')).toBe(false);
    expect(JSON.stringify(off)).not.toContain(V6.headline);
  });

  test('no hand-off: the payload is exactly what it was', () => {
    process.env[ENV] = 'true';
    const out = applyLawnReportReconciliation(payload(null), dynamic());
    expect(Object.keys(out.reportV2.lead).sort()).toEqual(['applied', 'headline', 'next', 'why', 'yourPart']);
  });
});
