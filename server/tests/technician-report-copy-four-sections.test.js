// The four-section report (GATE_REPORT_WRITER_RULES): parsed with its
// titles, screened like the paragraph; the two-section shape is unchanged.
const { technicianReportCustomerCopy } = require('../services/service-report/technician-report-copy');

const REPORT = [
  'WHAT WE FOUND', '', 'You mentioned ants by the dishwasher. Ghost ants were trailing along the counter.', '',
  'WHAT WE DID AND WHY', '', 'We placed bait along the counter, because ants carry it back to the colony.', '', 'Outside, we treated the foundation.', '',
  'WHAT TO EXPECT', '', 'You may see a few more ants for a few days.', '',
  "WHAT'S NEXT", '', 'If the ants are still trailing after about 1–2 weeks, let us know.',
].join('\n');

describe('four-section report', () => {
  test('parses the sections in order with their paragraphs', () => {
    const parsed = technicianReportCustomerCopy(REPORT);
    expect(parsed.sections.map((section) => [section.key, section.title, section.paragraphs.length])).toEqual([
      ['whatWeFound', 'What we found', 1],
      ['whatWeDid', 'What we did and why', 2],
      ['whatToExpect', 'What to expect', 1],
      ['whatsNext', 'What’s next', 1],
    ]);
    expect(parsed.body).toBe('You mentioned ants by the dishwasher. Ghost ants were trailing along the counter. We placed bait along the counter, because ants carry it back to the colony. Outside, we treated the foundation. You may see a few more ants for a few days. If the ants are still trailing after about 1–2 weeks, let us know.');
    expect(parsed.whatWeDid).toBe('We placed bait along the counter, because ants carry it back to the colony. Outside, we treated the foundation.');
    expect(parsed.violations).toEqual([]);
  });

  test('takes a curly apostrophe in the last title', () => {
    expect(technicianReportCustomerCopy(REPORT.replace("WHAT'S NEXT", 'WHAT’S NEXT'))?.sections).toHaveLength(4);
  });

  test.each([
    ['sections out of order', REPORT.replace('WHAT TO EXPECT', 'TMP').replace("WHAT'S NEXT", 'WHAT TO EXPECT').replace('TMP', "WHAT'S NEXT")],
    ['a section missing', REPORT.replace('WHAT TO EXPECT\n\nYou may see a few more ants for a few days.\n\n', '')],
    ['an empty section', REPORT.replace('You may see a few more ants for a few days.', '')],
    ['free text above the report', `Note to self: call the office.\n${REPORT}`],
    ['five paragraphs in a section', REPORT.replace('Outside, we treated the foundation.', 'One.\nTwo.\nThree.\nFour.')],
    ['a repeated title inside a section', REPORT.replace('Outside, we treated the foundation.', 'WHAT WE FOUND')],
    ['a report over the cap', REPORT.replace('Outside, we treated the foundation.', 'Outside, we treated the foundation. '.repeat(100))],
  ])('rejects %s', (label, text) => {
    expect(technicianReportCustomerCopy(text)).toBeNull();
  });

  test('banned wording withholds the body and the sections', () => {
    const parsed = technicianReportCustomerCopy(REPORT.replace('Ghost ants were trailing', 'The infestation was trailing'));
    expect(parsed.body).toBeNull();
    expect(parsed.sections).toBeNull();
    expect(parsed.violations.length).toBeGreaterThan(0);
  });

  test('the two-section paragraph parses exactly as before', () => {
    expect(technicianReportCustomerCopy('WHAT WE DID\nWe treated.\nWHAT WE FOUND\nLight activity.')).toEqual({
      whatWeDid: 'We treated.', whatWeFound: 'Light activity.', body: 'We treated. Light activity.', violations: [],
    });
    expect(technicianReportCustomerCopy('WHAT WE DID\nWe treated.\nSecond line.\nWHAT WE FOUND\nLight activity.')).toBeNull();
  });
});
