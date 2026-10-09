// GATE_LAWN_REPORT_FACTS: when a frozen tie says a product treated a finding, that product's "What to expect"
// line is the curative one, not "a protective treatment, so nothing changes visibly". Only where a tie exists.
// Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildLawnExpectations } = require('../services/service-report/lawn-expectations');
const { buildLawnCopyV6 } = require('../services/service-report/lawn-copy-v6');

const PROTECTIVE = 'This is a protective treatment, so nothing changes visibly. It helps protect the turf through wet, humid stretches.';
const CURATIVE = 'This treatment helps control disease spread. Damaged areas recover as the lawn produces new growth.';
const INSECT_CURATIVE = 'This treatment works to stop the insects causing the damage.';
const visible = (built) => built.rows.flatMap((row) => row.sentences).filter((s) => s.key === 'visibleChange').map((s) => s.text);

describe('the expectation engine', () => {
  const fungicide = [{ name: 'Headway G' }];

  test('no tie: an untagged fungicide stays the protective line', () => {
    expect(visible(buildLawnExpectations({ applications: fungicide }))).toEqual([PROTECTIVE]);
    expect(visible(buildLawnExpectations({ applications: fungicide, tiedFamilies: [] }))).toEqual([PROTECTIVE]);
  });

  test('a tie to the fungicide makes its line the curative one', () => {
    expect(visible(buildLawnExpectations({ applications: fungicide, tiedFamilies: ['fungicide'] }))).toEqual([CURATIVE]);
  });

  test('a tie to the insecticide makes the insecticide curative, and only it', () => {
    const both = [{ name: 'Headway G' }, { name: 'Arena 50 WDG' }];
    const lines = visible(buildLawnExpectations({ applications: both, tiedFamilies: ['insecticide'] }));
    expect(lines).toContain(INSECT_CURATIVE);
    expect(lines).toContain(PROTECTIVE);
  });

  test('a family with no tie is not touched by another family\'s tie', () => {
    expect(visible(buildLawnExpectations({ applications: [{ name: 'Arena 50 WDG' }], tiedFamilies: ['fungicide'] })))
      .toEqual(visible(buildLawnExpectations({ applications: [{ name: 'Arena 50 WDG' }] })));
  });

  test('a mode-locked preventive product stays preventive whatever the tie says', () => {
    const locked = [{ name: 'Acelepryn Xtra' }];
    expect(visible(buildLawnExpectations({ applications: locked, tiedFamilies: ['insecticide'] })))
      .toEqual(visible(buildLawnExpectations({ applications: locked })));
  });

  test('a malformed tiedFamilies is ignored', () => {
    expect(visible(buildLawnExpectations({ applications: fungicide, tiedFamilies: 'fungicide' }))).toEqual([PROTECTIVE]);
    expect(visible(buildLawnExpectations({ applications: fungicide, tiedFamilies: null }))).toEqual([PROTECTIVE]);
  });
});

describe('the v6 copy that freezes the "What to expect" paragraph', () => {
  const reportV2 = { treatment: { products: [{ name: 'Headway G', targets: [] }] }, snapshot: { statusHeadline: 'h' }, insights: [] };

  test('no tie in the context: the protective line', () => {
    expect(buildLawnCopyV6(reportV2, {}).fields.whatToExpect).toContain('protective treatment');
  });

  test('a frozen tie in the context: the curative line, and not the protective one', () => {
    const { fields } = buildLawnCopyV6(reportV2, { tiedFamilies: ['fungicide'] });
    expect(fields.whatToExpect).toContain(CURATIVE);
    expect(fields.whatToExpect).not.toContain('protective treatment');
  });
});
