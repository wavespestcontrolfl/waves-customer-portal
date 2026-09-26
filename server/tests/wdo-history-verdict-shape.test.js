// Codex r11 on #4884: an answer without the contract's verdict fields (e.g. {})
// used to normalize into an all-unknown "resolved" history that was cached and
// left the wdo_history ledger row successful. It must be a failed lookup.
const { _private: { normalizeHistory, parseJson } } = require('../services/property-lookup/wdo-history-lookup');

describe('wdo history — verdict fields are required', () => {
  test.each([
    ['{}', {}],
    ['missing confidence', { previousTreatment: 'unknown' }],
    ['missing previousTreatment', { confidence: 'low' }],
    ['off-contract previousTreatment', { previousTreatment: 'maybe', confidence: 'low' }],
    ['off-contract confidence', { previousTreatment: 'no', confidence: 'certain' }],
  ])('%s is not a usable history', (_label, parsed) => {
    expect(normalizeHistory(parsed)).toBeNull();
  });

  test('null stays null', () => {
    expect(normalizeHistory(parseJson('not json'))).toBeNull();
  });

  test('a contract answer — including an honest "unknown / low" — normalizes', () => {
    expect(normalizeHistory({ previousTreatment: 'unknown', confidence: 'low' })).toMatchObject({ previousTreatment: 'unknown', confidence: 'low', permits: [], sources: [] });
    expect(normalizeHistory({ previousTreatment: ' Yes ', confidence: 'HIGH', sources: ['https://example.com'] })).toMatchObject({ previousTreatment: 'yes', confidence: 'high' });
  });
});

// The prompt allows "yes" ONLY with a concrete source; an uncited "yes" would
// pre-fill a legal FDACS-13645 filing.
describe('wdo history — a "yes" verdict needs a cited source', () => {
  test('"yes" with no http(s) source is not a usable history', () => {
    expect(normalizeHistory({ previousTreatment: 'yes', confidence: 'high' })).toBeNull();
    expect(normalizeHistory({ previousTreatment: 'yes', confidence: 'high', sources: [] })).toBeNull();
    expect(normalizeHistory({ previousTreatment: 'yes', confidence: 'high', sources: ['county permit #123', 'javascript:alert(1)'] })).toBeNull();
  });

  test('"yes" with a cited URL, and "no"/"unknown" without one, normalize', () => {
    expect(normalizeHistory({ previousTreatment: 'yes', confidence: 'medium', sources: ['https://www.manateepao.gov/permit/123'] }))
      .toMatchObject({ previousTreatment: 'yes', sources: ['https://www.manateepao.gov/permit/123'] });
    expect(normalizeHistory({ previousTreatment: 'unknown', confidence: 'low', sources: [] })).toMatchObject({ previousTreatment: 'unknown' });
  });
});

// Codex r20 on #4884: "no" is only allowed when a source affirmatively shows
// no prior treatment — an uncited "no" pre-filled the FDACS form as "No".
describe('wdo history — a "no" verdict needs a cited source too', () => {
  test('"no" without an http(s) source is not a usable history; with one it is', () => {
    expect(normalizeHistory({ previousTreatment: 'no', confidence: 'high', sources: [] })).toBeNull();
    expect(normalizeHistory({ previousTreatment: 'no', confidence: 'high' })).toBeNull();
    expect(normalizeHistory({ previousTreatment: 'no', confidence: 'high', sources: ['https://www.sc-pa.com/permit/9'] })).toMatchObject({ previousTreatment: 'no' });
  });
});

// Codex r21 on #4884: nested evidence is copied into FDACS Section 4 — an
// object there became "[object Object]" on the legal form.
describe('wdo history — nested evidence must be text as given', () => {
  const CITED = { previousTreatment: 'yes', confidence: 'high', sources: ['https://www.manateepao.gov/permit/1'] };
  test.each([
    ['object treatmentNotes', { treatmentNotes: {} }],
    ['object fumigation date', { fumigation: { date: {} } }],
    ['a non-object fumigation', { fumigation: 'tented 2019' }],
    ['an object permit field', { permits: [{ type: { t: 1 }, date: '2019' }] }],
    ['a non-array permits', { permits: 'reroof 2019' }],
    ['an implausible roof permit year', { roofPermitYear: 1850 }],
    ['a fractional roof permit year', { roofPermitYear: 2019.5 }],
  ])('%s fails the lookup', (_label, extra) => {
    expect(normalizeHistory({ ...CITED, ...extra })).toBeNull();
  });

  test('text evidence, a numeric-string year and nulls are read', () => {
    const out = normalizeHistory({ ...CITED, treatmentNotes: 'Tented 2019', fumigation: { date: '2019-05-01', fumigant: 'Vikane', company: 'Acme', notes: null }, permits: [{ type: 'reroof', date: '2021', description: 'shingle' }], roofPermitYear: '2021' });
    expect(out).toMatchObject({ treatmentNotes: 'Tented 2019', roofPermitYear: 2021, fumigation: { fumigant: 'Vikane' } });
  });
});
