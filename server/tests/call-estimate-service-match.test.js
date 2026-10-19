// Service-line match for send_estimate association proofs (audit 2026-10-19,
// calls 5f7d3fc9 + 8d1e8e2c: a LAWN quote was asked, a Pest Control estimate
// went out days later and closed the promise). Pure helper; no database.
const { askedServiceLines, estimateServiceLines, serviceLinesConflict } = require('../services/call-estimate-service-match');

const v2 = (primary, extra = {}) => ({ service_request: { primary_service_category: primary, ...extra } });

describe('askedServiceLines (the call side, V2 extraction)', () => {
  test.each([
    ['pest_general', ['pest']], ['stinging_insect', ['pest']], ['bed_bug', ['pest']],
    ['lawn_care', ['lawn']], ['mosquito', ['mosquito']], ['palm_injection', ['tree_shrub']],
    ['rodent', ['rodent']], ['exclusion', ['rodent']], ['termite', ['termite']], ['wdo', ['termite']],
  ])('%s -> %j', (category, lines) => {
    expect(askedServiceLines(v2(category))).toEqual(lines);
  });

  test('a bundle, an inspection, "other", junk and a missing extraction name no line (no catalog name)', () => {
    for (const c of ['bundled_waveguard', 'inspection_only', 'other', 'nonsense', null, undefined]) expect(askedServiceLines(v2(c))).toEqual([]);
    expect(askedServiceLines(null)).toEqual([]);
    expect(askedServiceLines({})).toEqual([]);
    expect(askedServiceLines('not an object')).toEqual([]);
  });

  test('the PRIMARY category alone decides: secondary categories never widen the ask (call 5f7d3fc9 shape)', () => {
    expect(askedServiceLines(v2('lawn_care', { secondary_categories: ['pest_general'] }))).toEqual(['lawn']);
    expect(askedServiceLines(v2('lawn_care', { secondary_categories: ['pest_general'], specific_service_name: 'Pest Control' }))).toEqual(['lawn']);
    expect(askedServiceLines(v2('lawn_care'))).toEqual(['lawn']); // call 8d1e8e2c shape
  });

  test('a primary with no line falls back to the catalog name, only when it reads as exactly one line', () => {
    for (const c of ['bundled_waveguard', 'inspection_only', 'other', 'nonsense', null, undefined]) {
      expect(askedServiceLines(v2(c, { specific_service_name: 'Lawn Insect Control' }))).toEqual(['lawn']);
      expect(askedServiceLines(v2(c, { specific_service_name: 'Pest Control + Lawn Care' }))).toEqual([]); // two lines: unknown
      expect(askedServiceLines(v2(c, { specific_service_name: 'Custom thing' }))).toEqual([]); // no line
      expect(askedServiceLines(v2(c, { specific_service_name: '  ', secondary_categories: ['lawn_care'] }))).toEqual([]); // secondary never used
    }
  });
});

describe('estimateServiceLines (the estimate side)', () => {
  test('reads the service_interest text', () => {
    expect(estimateServiceLines({ service_interest: 'Pest Control' })).toEqual(['pest']);
    expect(estimateServiceLines({ service_interest: 'Lawn Care' })).toEqual(['lawn']);
    expect(estimateServiceLines({ service_interest: 'Mosquito' })).toEqual(['mosquito']);
    expect(estimateServiceLines({ service_interest: 'Pest Control + Lawn Care' }).sort()).toEqual(['lawn', 'pest']);
  });

  test('prefers the structured lines in estimate_data, string or object', () => {
    const data = { result: { recurring: { services: [{ service: 'Lawn Care', mo: 55 }] } } };
    expect(estimateServiceLines({ estimate_data: data, service_interest: 'Pest Control' })).toEqual(['lawn']);
    expect(estimateServiceLines({ estimate_data: JSON.stringify(data) })).toEqual(['lawn']);
  });

  test('commercial and palm lines collapse to their coarse line', () => {
    expect(estimateServiceLines({ service_interest: 'Commercial Pest Control' })).toEqual(['pest']);
    expect(estimateServiceLines({ service_interest: 'Palm Injection' })).toEqual(['tree_shrub']);
  });

  test('nothing classifiable, a partly unclassifiable estimate and garbage are unknown (empty)', () => {
    expect(estimateServiceLines({})).toEqual([]);
    expect(estimateServiceLines({ service_interest: 'Custom proposal' })).toEqual([]);
    expect(estimateServiceLines({ service_interest: '', estimate_data: '{not json' })).toEqual([]);
    expect(estimateServiceLines(null)).toEqual([]);
  });
});

describe('serviceLinesConflict', () => {
  test('the audit cases: lawn asked, pest estimate (and the reverse) conflict', () => {
    expect(serviceLinesConflict(['lawn'], ['pest'])).toBe(true);
    expect(serviceLinesConflict(['pest'], ['lawn'])).toBe(true);
    expect(serviceLinesConflict(['termite'], ['pest', 'mosquito'])).toBe(true);
  });

  test('a shared line is a match, even inside a multi-line estimate or ask', () => {
    expect(serviceLinesConflict(['lawn'], ['pest', 'lawn'])).toBe(false);
    expect(serviceLinesConflict(['pest', 'lawn'], ['lawn'])).toBe(false);
    expect(serviceLinesConflict(['lawn'], ['lawn'])).toBe(false);
  });

  test('fail-safe: either side unknown never conflicts', () => {
    expect(serviceLinesConflict([], ['pest'])).toBe(false);
    expect(serviceLinesConflict(['lawn'], [])).toBe(false);
    expect(serviceLinesConflict(undefined, undefined)).toBe(false);
  });

  test('end to end: the exact 5f7d3fc9 shape (primary lawn_care, secondary pest_general)', () => {
    const asked = askedServiceLines(v2('lawn_care', { secondary_categories: ['pest_general'], specific_service_name: 'Lawn Insect Control' }));
    const conflicts = (service_interest) => serviceLinesConflict(asked, estimateServiceLines({ service_interest }));
    expect(conflicts('Pest Control')).toBe(true); // rejected: the lawn quote is still owed
    expect(conflicts('Lawn Care')).toBe(false);
    expect(conflicts('Pest + Lawn')).toBe(false);
    expect(conflicts('Custom proposal')).toBe(false); // unclassifiable estimate: old behavior
  });
});

describe('askedServiceLines stored as a JSON string', () => {
  const { askedServiceLines } = require('../services/call-estimate-service-match');
  test('parses a JSON string extraction', () => {
    expect(askedServiceLines(JSON.stringify({ service_request: { primary_service_category: 'lawn_care' } }))).toEqual(['lawn']);
  });
  test('an unparseable string is unknown', () => {
    expect(askedServiceLines('{not json')).toEqual([]);
  });
});
