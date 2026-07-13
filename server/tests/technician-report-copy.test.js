/**
 * Tech-reviewed AI report copy → customer report summary.
 *
 * The completion form's "Generate AI report" writes a fixed two-section
 * customer-facing draft (WHAT WE DID / WHAT WE FOUND) into the notes box for
 * the tech to review. These tests pin the trust boundary:
 *  - only notes carrying that exact shape parse as customer copy — free-form
 *    notes, prefixed/appended internal text, extra paragraphs, or
 *    half-shapes never do;
 *  - banned customer wording (hand edits) drops the copy, including the
 *    summary pipeline's forbidden-language list;
 *  - the typed snapshot uses the copy ONLY in the generic non-gauge default
 *    composition (the one-time pest family from the owner's report) —
 *    zero states and owner-specified story branches keep approved wording;
 *  - template-only output is byte-identical to before (no bodySource key).
 */

const {
  technicianReportCustomerCopy,
  MAX_REPORT_CHARS,
} = require('../services/service-report/technician-report-copy');
const {
  buildTodaysResult,
  buildTypedReportSnapshot,
  NEXT_STEP_CHIPS,
} = require('../services/service-report/activity-indicators');

const AI_REPORT = [
  'WHAT WE DID',
  '',
  'A full exterior perimeter application targeted the foundation line, door thresholds, and garage entry where ant trailing was documented. A non-repellent residual was applied to the plumbing penetrations under the kitchen sink.',
  '',
  'WHAT WE FOUND',
  '',
  'Ant activity was concentrated along the front walkway expansion joint, with light trailing near the garage. Activity typically tapers over the next one to two weeks as the product transfers through the colony.',
].join('\n');

const AI_BODY = 'A full exterior perimeter application targeted the foundation line, door thresholds, and garage entry where ant trailing was documented. A non-repellent residual was applied to the plumbing penetrations under the kitchen sink. Ant activity was concentrated along the front walkway expansion joint, with light trailing near the garage. Activity typically tapers over the next one to two weeks as the product transfers through the colony.';

describe('technicianReportCustomerCopy — shape parsing', () => {
  test('parses the generate-report two-section shape into a single customer body', () => {
    const parsed = technicianReportCustomerCopy(AI_REPORT);
    expect(parsed).not.toBeNull();
    expect(parsed.whatWeDid).toMatch(/^A full exterior perimeter application/);
    expect(parsed.whatWeFound).toMatch(/^Ant activity was concentrated/);
    expect(parsed.body).toBe(AI_BODY);
    expect(parsed.violations).toEqual([]);
  });

  test('tolerates trailing colons on the headers', () => {
    const parsed = technicianReportCustomerCopy(
      'WHAT WE DID:\nTreated the exterior perimeter.\nWHAT WE FOUND:\nLight activity near the lanai.'
    );
    expect(parsed?.body).toBe('Treated the exterior perimeter. Light activity near the lanai.');
  });

  test('free-form notes (no headers) parse to null', () => {
    expect(technicianReportCustomerCopy('Treated perimeter, wiped webs, customer happy.')).toBeNull();
  });

  test('one header alone is not the report shape', () => {
    expect(technicianReportCustomerCopy('WHAT WE DID\nTreated the perimeter.')).toBeNull();
  });

  test('out-of-order headers parse to null', () => {
    expect(technicianReportCustomerCopy(
      'WHAT WE FOUND\nSome activity.\nWHAT WE DID\nTreated it.'
    )).toBeNull();
  });

  test('internal text ABOVE the report keeps the whole blob off the customer surface', () => {
    expect(technicianReportCustomerCopy(
      `gate code 4411, dog in yard\n${AI_REPORT}`
    )).toBeNull();
  });

  test('an internal note appended AFTER the report keeps the whole blob off the customer surface', () => {
    expect(technicianReportCustomerCopy(
      `${AI_REPORT}\n\ngate code 4411 — bill the property manager, office to follow up`
    )).toBeNull();
  });

  test('a second paragraph inside a section is unreviewed free text — parses to null', () => {
    expect(technicianReportCustomerCopy(
      'WHAT WE DID\n\nTreated the perimeter.\n\nAlso replaced the bait stations.\n\nWHAT WE FOUND\n\nLight activity near the lanai.'
    )).toBeNull();
  });

  test('soft line wraps inside a section paragraph still parse as one paragraph', () => {
    const parsed = technicianReportCustomerCopy(
      'WHAT WE DID\n\nTreated the exterior perimeter\nand the garage entry.\n\nWHAT WE FOUND\n\nLight activity near the lanai.'
    );
    expect(parsed?.body).toBe('Treated the exterior perimeter and the garage entry. Light activity near the lanai.');
  });

  test('an empty section parses to null', () => {
    expect(technicianReportCustomerCopy('WHAT WE DID\n\nWHAT WE FOUND\nActivity noted.')).toBeNull();
    expect(technicianReportCustomerCopy('WHAT WE DID\nTreated.\nWHAT WE FOUND\n\n')).toBeNull();
  });

  test('over-length text is not treated as the drafted report', () => {
    const padded = AI_REPORT.replace(
      'Activity typically tapers',
      `${'Detail sentence repeated. '.repeat(80)}Activity typically tapers`
    );
    expect(padded.length).toBeGreaterThan(MAX_REPORT_CHARS);
    expect(technicianReportCustomerCopy(padded)).toBeNull();
  });

  test('empty / null notes parse to null', () => {
    expect(technicianReportCustomerCopy('')).toBeNull();
    expect(technicianReportCustomerCopy(null)).toBeNull();
    expect(technicianReportCustomerCopy(undefined)).toBeNull();
  });

  test('banned customer wording nulls the body and reports the violations', () => {
    const parsed = technicianReportCustomerCopy(
      'WHAT WE DID\nWe eliminated the ant colony.\nWHAT WE FOUND\nYour home is now guaranteed pest-free.'
    );
    expect(parsed).not.toBeNull();
    expect(parsed.body).toBeNull();
    expect(parsed.violations.length).toBeGreaterThan(0);
  });

  test('the summary pipeline forbidden-language list applies too (bare "infestation")', () => {
    const parsed = technicianReportCustomerCopy(
      'WHAT WE DID\nTreated the kitchen for the active roach infestation.\nWHAT WE FOUND\nActivity should taper over the next week.'
    );
    expect(parsed).not.toBeNull();
    expect(parsed.body).toBeNull();
    expect(parsed.violations).toContain('forbidden_language');
  });
});

describe('typed snapshot — technician report body in the generic tail compositions', () => {
  const chips = ['Monitor activity'];
  const chipSentence = NEXT_STEP_CHIPS['Monitor activity'];

  test('one-time pest default branch: body is the reviewed report + next step, headline stays deterministic', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'one_time_pest_treatment',
      values: { activity_level: 'Moderate' },
      nextStepChips: chips,
      serviceLabel: 'Pest Control Re-Service',
      technicianReportBody: AI_BODY,
    });
    expect(snapshot.todaysResult.headline).toBe('Pest Control Re-Service completed today.');
    expect(snapshot.todaysResult.body).toBe(`${AI_BODY} ${chipSentence}`);
    expect(snapshot.todaysResult.bodySource).toBe('technician_report');
    expect(snapshot.summaryTemplateVersion).toBe(3);
  });

  test('one-time pest zero state keeps the template body — a body drafted pre-zero-flip must not contradict the headline (Codex P2)', () => {
    const result = buildTodaysResult({
      projectType: 'one_time_pest_treatment',
      reportTypeLabel: 'Pest Control Re-Service Summary',
      values: { activity_level: 'None observed' },
      chips,
      technicianReportBody: AI_BODY,
    });
    expect(result.headline).toBe('No active signs of pest activity observed today.');
    expect(result.body).toBe('We completed the scheduled service. Continue monitoring and contact us if activity returns.');
    expect(result).not.toHaveProperty('bodySource');
  });

  test('without a technician report the template output is unchanged and unstamped', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'one_time_pest_treatment',
      values: { activity_level: 'Moderate' },
      nextStepChips: chips,
      serviceLabel: 'Pest Control Re-Service',
    });
    expect(snapshot.todaysResult.body).toBe(`We completed the scheduled service. ${chipSentence}`);
    expect(snapshot.todaysResult).not.toHaveProperty('bodySource');
  });

  test('the reviewed report also beats a typed-field first sentence in the tail branch', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'one_time_pest_treatment',
      values: { activity_level: 'Moderate', treatment_performed: 'Spot treated the kitchen.' },
      nextStepChips: chips,
      technicianReportBody: AI_BODY,
    });
    expect(snapshot.todaysResult.body.startsWith(AI_BODY)).toBe(true);
  });

  test('owner-story branches ignore the technician report (rodent exclusion keeps its approved story)', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_exclusion',
      reportTypeLabel: 'Rodent Exclusion Summary',
      values: {
        exclusion_work_completed: 'Sealed gaps',
        exclusion_areas: 'Garage',
        remaining_concerns: 'No remaining concerns observed',
      },
      chips: [],
      technicianReportBody: AI_BODY,
    });
    expect(result.headline).toBe('Exclusion repairs were completed to reduce rodent access and help prevent re-entry.');
    expect(result.body).not.toContain('non-repellent residual');
    expect(result).not.toHaveProperty('bodySource');
  });
});
