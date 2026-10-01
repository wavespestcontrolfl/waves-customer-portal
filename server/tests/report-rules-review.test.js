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

  test('an edit that adds a word the report refuses is named, not silently dropped', () => {
    const block = reportRulesReviewBlockPayload(args({ technicianNotes: DRAFT.replace('Let us know if they keep trailing.', 'It is safe for pets. Let us know if they keep trailing.') }));
    expect(block.payload.findings.map((finding) => finding.reason)).toEqual(expect.arrayContaining(['refused_words', 'safe_word']));
    expect(block.payload.error).toContain("Words the report can't publish");
  });

  test('the untouched draft, an approved timeframe it carries, and a confirmed resubmit all pass', () => {
    expect(reportRulesReviewBlockPayload(args({ technicianNotes: DRAFT }))).toBeNull();
    expect(reportRulesReviewBlockPayload(args({ reportRulesConfirmed: true }))).toBeNull();
    expect(reportRulesReviewBlockPayload(args({ isIncompleteVisit: true }))).toBeNull();
  });

  test('an edit that keeps the draft\'s approved timeframe and date is no finding', () => {
    const base = DRAFT.replace("Let us know if they keep trailing.", 'If ants are still trailing by Wednesday, October 14, let us know.');
    const kept = base
      .replace('You may see a few more ants for about 1–2 weeks.', 'You might notice more ants near the bait for about 1–2 weeks.')
      .replace('If ants are still trailing by Wednesday, October 14, let us know.', 'If you still see ants by Wednesday, October 14, text us.');
    expect(reportRulesReviewBlockPayload(args({ technicianNotes: kept, reportDraftBase: base }))).toBeNull();
  });

  test("this visit's own active ingredients are screened, as at generation", () => {
    const edited = DRAFT.replace('We placed bait along the counter, because ants carry it back to the colony.', 'We placed bait with azadirachtin.');
    const block = reportRulesReviewBlockPayload(args({ technicianNotes: edited, activeIngredients: ['Azadirachtin'] }));
    expect(block.payload.findings.map((finding) => finding.reason)).toEqual(['active_ingredient']);
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
