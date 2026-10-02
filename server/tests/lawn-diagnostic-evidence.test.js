// Prospect lawn report evidence (GATE_LAWN_DIAGNOSTIC_EVIDENCE): the fixed
// "why we think so" copy and its place on the public lawn-diagnostic payload.
// Synthetic data only.
//
// Pins: every label the egress can publish has copy; the copy is selected only
// by the allowlisted label and clamped confidence, so stored free text can
// never reach it; the naming gate still decides what is named; gate off the
// payload is key for key what it was; the funnel teaser never carries it.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  publicFindingEvidence, publicBasis, EVIDENCE_BY_LABEL, CERTAINTY,
} = require('../services/lawn-diagnostic-evidence');
const { CONDITION_LABEL_VALUES, scrubCustomerText, residualDefinitiveClaim } = require('../services/lawn-diagnostic-report');
const { buildPublicLawnReport } = require('../routes/public-lawn-diagnostic')._test;

const row = (findings, { photoQuality = 'adequate', diagnosis = {} } = {}) => ({
  id: 'diag-1',
  overall_score: 60,
  created_at: '2026-09-15T15:00:00Z',
  contact_snapshot: JSON.stringify({ first_name: 'Dana' }),
  address_snapshot: JSON.stringify({ city: 'Venice' }),
  report_contract: JSON.stringify({
    input_assessment: { photo_quality: photoQuality, photo_limitations: ['blurry close-up of the gate keypad'], missing_inputs: [] },
    diagnosis: { primary_finding: findings[0] ? findings[0].name : null, confidence: findings[0] ? findings[0].confidence : 'unknown', findings, ...diagnosis },
    customer_summary: 'We looked over the lawn photos.',
  }),
});
const CHINCH = {
  name: 'Chinch bug pressure', confidence: 'moderate', severity: 'moderate',
  observed_evidence: ['SECRET-OBSERVED sunny edge browning near gate code 4821'],
  inferred_context: ['SECRET-INFERRED neighbor irrigates daily'],
  negative_evidence: ['SECRET-NEGATIVE no lesions'],
  confirmation_step: 'SECRET-CONFIRM float test with Talstar on hand',
  customer_wording: 'SECRET-WORDING',
};

const withGate = (value, fn) => {
  const previous = process.env.GATE_LAWN_DIAGNOSTIC_EVIDENCE;
  if (value === undefined) delete process.env.GATE_LAWN_DIAGNOSTIC_EVIDENCE; else process.env.GATE_LAWN_DIAGNOSTIC_EVIDENCE = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.GATE_LAWN_DIAGNOSTIC_EVIDENCE; else process.env.GATE_LAWN_DIAGNOSTIC_EVIDENCE = previous;
  }
};

describe('the evidence catalog', () => {
  const strings = [
    ...Object.values(EVIDENCE_BY_LABEL).flatMap((entry) => [entry.why, entry.confirm]),
    ...Object.values(CERTAINTY.cause), ...Object.values(CERTAINTY.symptom), CERTAINTY.generic,
    publicBasis({ photoCount: 3, photoQuality: 'limited' }),
  ].filter(Boolean);

  test('covers exactly the labels the egress can publish', () => {
    expect(Object.keys(EVIDENCE_BY_LABEL).sort()).toEqual([...CONDITION_LABEL_VALUES].sort());
  });

  test('every string survives the customer-text scrub unchanged and makes no confirmed-cause claim', () => {
    for (const text of strings) {
      expect({ text, scrubbed: scrubCustomerText(text) }).toEqual({ text, scrubbed: text });
      expect({ text, definitive: Boolean(residualDefinitiveClaim(text)) }).toEqual({ text, definitive: false });
    }
  });

  test('house wording rules: no product or brand, no rate, no "certified", no em dash', () => {
    for (const text of strings) expect(text).not.toMatch(/talstar|celsius|bifenthrin|certified|organic|\boz\b|per 1,?000|—/i);
  });

  test('an unknown label, or none, has no evidence', () => {
    expect(publicFindingEvidence('made-up condition', 'high')).toBeNull();
    expect(publicFindingEvidence(null, 'high')).toBeNull();
    expect(publicFindingEvidence('toString', 'high')).toBeNull();
  });

  test('a high-confidence finding needs no on-site check; anything lower names one when the condition has one', () => {
    expect(publicFindingEvidence('chinch bug activity', 'high').confirm).toBeNull();
    expect(publicFindingEvidence('chinch bug activity', 'moderate').confirm).toMatch(/float test/);
    expect(publicFindingEvidence('weed pressure', 'low').confirm).toBeNull();
  });

  test('certainty follows the clamped confidence, and a clean lawn carries none', () => {
    expect(publicFindingEvidence('chinch bug activity', 'high').certainty).toBe(CERTAINTY.cause.high);
    expect(publicFindingEvidence('chinch bug activity', 'moderate').certainty).toBe(CERTAINTY.cause.moderate);
    // A cause label below moderate cannot reach the table through the egress; if
    // it ever did it reads as the generic low line, never a cause-level claim.
    expect(publicFindingEvidence('chinch bug activity', 'low').certainty).toBe(CERTAINTY.generic);
    expect(publicFindingEvidence('thinning turf', null).certainty).toBe(CERTAINTY.symptom.low);
    expect(publicFindingEvidence('thinning turf', 'unknown').certainty).toBe(CERTAINTY.symptom.low);
    expect(publicFindingEvidence('general lawn stress', 'high').certainty).toBe(CERTAINTY.generic);
    expect(publicFindingEvidence('no major visible stress', 'high')).toEqual({ why: EVIDENCE_BY_LABEL['no major visible stress'].why, certainty: null, confirm: null });
  });
});

describe('publicBasis', () => {
  test('counts photos, singular and plural, capped', () => {
    expect(publicBasis({ photoCount: 1, photoQuality: 'adequate' })).toBe('Based on 1 photo.');
    expect(publicBasis({ photoCount: 4, photoQuality: 'adequate' })).toBe('Based on 4 photos.');
    expect(publicBasis({ photoCount: 400, photoQuality: 'adequate' })).toBe('Based on 12 photos.');
  });

  test('a limited or poor set adds the fixed caution; no count and no limit is null', () => {
    expect(publicBasis({ photoCount: 2, photoQuality: 'limited' })).toBe('Based on 2 photos. Some photos limited what we could see, so we kept our wording cautious.');
    expect(publicBasis({ photoCount: null, photoQuality: 'poor' })).toBe('Some photos limited what we could see, so we kept our wording cautious.');
    for (const photoCount of [null, 0, -1, 2.5, '3', NaN]) expect(publicBasis({ photoCount, photoQuality: 'adequate' })).toBeNull();
    expect(publicBasis()).toBeNull();
  });
});

describe('buildPublicLawnReport with GATE_LAWN_DIAGNOSTIC_EVIDENCE', () => {
  test('gate off: the payload is key for key what it was, whatever photo count is passed', () => {
    const off = withGate(undefined, () => buildPublicLawnReport(row([CHINCH]), { photoCount: 4 }));
    expect(Object.prototype.hasOwnProperty.call(off, 'basis')).toBe(false);
    expect(Object.keys(off.findings[0]).sort()).toEqual(['confidence', 'customer_note', 'name', 'severity']);
    expect(off).toEqual(withGate(undefined, () => buildPublicLawnReport(row([CHINCH]))));
  });

  test('gate on: the payload differs from gate off by basis and findings[].evidence alone', () => {
    const off = withGate(undefined, () => buildPublicLawnReport(row([CHINCH]), { photoCount: 4 }));
    const on = withGate('true', () => buildPublicLawnReport(row([CHINCH]), { photoCount: 4 }));
    expect(on.basis).toBe('Based on 4 photos.');
    expect(on.findings[0].evidence).toEqual(publicFindingEvidence('chinch bug activity', 'moderate'));
    const stripped = { ...on, findings: on.findings.map(({ evidence, ...rest }) => rest) };
    delete stripped.basis;
    expect(stripped).toEqual(off);
  });

  test('none of the stored evidence, context, confirmation step, wording or photo limitations is published', () => {
    const serialized = JSON.stringify(withGate('true', () => buildPublicLawnReport(row([CHINCH], { photoQuality: 'limited' }), { photoCount: 4 })));
    expect(serialized).not.toMatch(/SECRET|4821|Talstar|keypad|observed_evidence|inferred_context|negative_evidence|confirmation_step|photo_quality|photo_limitations/);
  });

  test('the naming gate still decides: a low-confidence chinch finding gets the generic evidence, never the chinch copy', () => {
    const report = withGate('true', () => buildPublicLawnReport(row([{ ...CHINCH, confidence: 'low' }])));
    expect(report.findings[0].name).toBe('general lawn stress');
    expect(report.findings[0].evidence).toEqual(publicFindingEvidence('general lawn stress', 'low'));
    expect(JSON.stringify(report.findings)).not.toMatch(/chinch|float test/i);
  });

  test('a limited photo set says so in the basis line even without a count', () => {
    const report = withGate('true', () => buildPublicLawnReport(row([CHINCH], { photoQuality: 'limited' })));
    expect(report.basis).toBe('Some photos limited what we could see, so we kept our wording cautious.');
    expect(withGate('true', () => buildPublicLawnReport(row([CHINCH]))).basis).toBeNull();
  });

  test('a report with no findings carries a basis and no evidence', () => {
    const report = withGate('true', () => buildPublicLawnReport(row([]), { photoCount: 2 }));
    expect(report.findings).toEqual([]);
    expect(report.basis).toBe('Based on 2 photos.');
  });
});

describe('the lawn-assessment teaser', () => {
  const { buildTeaser } = require('../routes/public-lawn-assessment');

  test('its one finding never carries evidence, and the teaser is the same payload gate on or off', () => {
    const off = withGate(undefined, () => buildTeaser(row([CHINCH])));
    const on = withGate('true', () => buildTeaser(row([CHINCH])));
    expect(Object.keys(on.first_finding).sort()).toEqual(['confidence', 'customer_note', 'name', 'severity']);
    expect(on).toEqual(off);
    expect(JSON.stringify(on)).not.toMatch(/evidence|basis|float test/);
  });

  test('a teaser with no findings still reports none', () => {
    expect(withGate('true', () => buildTeaser(row([]))).first_finding).toBeNull();
  });
});
