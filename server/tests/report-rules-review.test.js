// Edit heads-up on the four-section report at completion (owner
// 2026-10-01: rerun the rules when someone edits, never block; Codex
// #5500): the writer rules run again on every sentence that differs from
// the installed generated draft.
const { reportRulesReviewBlockPayload } = require('../services/complete-scheduled-service');

const ORIGINAL_GATE = process.env.GATE_REPORT_WRITER_RULES;
beforeEach(() => { process.env.GATE_REPORT_WRITER_RULES = 'true'; });
afterEach(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_REPORT_WRITER_RULES;
  else process.env.GATE_REPORT_WRITER_RULES = ORIGINAL_GATE;
});

const DRAFT = [
  'WHAT WE FOUND', 'Ghost ants were trailing along the slider track.',
  'WHAT WE DID AND WHY', 'We placed bait along the counter, because ants carry it back to the colony.',
  'WHAT TO EXPECT', 'You may see a few more ants for about 1–2 weeks.',
  "WHAT'S NEXT", 'Let us know if they keep trailing.',
].join('\n');
const EDITED = DRAFT.replace(
  'We placed bait along the counter, because ants carry it back to the colony.',
  'We placed bait along the counter. We applied 2 gallons outside. Waves Lawn & Pest thanks you.',
);
const args = (overrides = {}) => ({
  isIncompleteVisit: false, reportRulesConfirmed: false, technicianNotes: EDITED, reportDraftBase: DRAFT, ...overrides,
});

describe('edit heads-up', () => {
  test('an edit that adds what reports leave out returns one confirmable 409 naming each sentence', () => {
    const block = reportRulesReviewBlockPayload(args());
    expect(block.status).toBe(409);
    expect(block.payload).toEqual(expect.objectContaining({ code: 'report_rules_review', confirmable: true }));
    expect(block.payload.findings.map((finding) => finding.reason)).toEqual(['amount', 'company_name']);
    expect(block.payload.error).toContain('An amount or measurement: "We applied 2 gallons outside."');
  });

  test('the untouched draft, an approved timeframe it carries, and a confirmed resubmit all pass', () => {
    expect(reportRulesReviewBlockPayload(args({ technicianNotes: DRAFT }))).toBeNull();
    expect(reportRulesReviewBlockPayload(args({ reportRulesConfirmed: true }))).toBeNull();
    expect(reportRulesReviewBlockPayload(args({ isIncompleteVisit: true }))).toBeNull();
  });

  test('with no draft to compare, every sentence is checked', () => {
    const block = reportRulesReviewBlockPayload(args({ technicianNotes: DRAFT, reportDraftBase: null }));
    expect(block.payload.findings.map((finding) => finding.reason)).toEqual(['timeframe']);
  });

  test('the two-section paragraph, and any report while the switch is off, are left alone', () => {
    expect(reportRulesReviewBlockPayload(args({ technicianNotes: 'WHAT WE DID\nWe applied 2 gallons.\nWHAT WE FOUND\nAnts.' }))).toBeNull();
    delete process.env.GATE_REPORT_WRITER_RULES;
    expect(reportRulesReviewBlockPayload(args())).toBeNull();
  });
});
