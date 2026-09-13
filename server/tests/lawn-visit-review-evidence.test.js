const { buildReview } = require('../services/lawn-visit-review-evidence');
const { validateReview } = require('../services/lawn-visit-review-input');
const { NO_STRESS_LABEL } = require('../services/lawn-visit-result');

const finding = (overrides = {}) => ({
  finding_id: 'F1', name: 'Chinch damage', label: 'chinch bug activity',
  confidence: 'high', severity: 'moderate', urgency: 'follow_up',
  confirmation_step: 'Check the advancing edge', source: 'model', ...overrides,
});
const run = (overrides = {}) => ({ findings: [finding()], ...overrides });
function review(stored, body = {}) {
  const validated = validateReview(body, stored);
  expect(validated.errors).toEqual([]);
  return buildReview(stored, validated.review);
}

describe('technician lawn evidence and reconciliation', () => {
  test.each([
    ['Checked for chinch bugs; none found', NO_STRESS_LABEL],
    ['Float test negative for chinch at the drive', NO_STRESS_LABEL],
    ['No dollar spot seen', NO_STRESS_LABEL],
    ['No signs of drought; chinch bugs confirmed by float test', 'chinch bug activity'],
    ['Checked for grubs, none found, but dollar spot is active in the shade', 'dollar spot'],
    ['Chinch ruled out and no drought either', NO_STRESS_LABEL],
    ['Drought ruled out and chinch bugs confirmed by float test', 'chinch bug activity'],
    ['Drought ruled out, chinch bugs confirmed by float test', 'chinch bug activity'],
    // Oxford comma: adjacent separators leave an empty segment between them,
    // which must not disable splitting and let "ruled out" reach the next cause.
    ['Drought ruled out, and chinch bugs confirmed by float test', 'chinch bug activity'],
    ['Grubs found, drought ruled out', 'grub activity'],
    ['No chinch bugs, grubs found', 'grub activity'],
    ['Chinch bugs and grubs ruled out', NO_STRESS_LABEL],
    ['Chinch bugs and grubs not found', NO_STRESS_LABEL],
    ['Chinch bugs, grubs, and sod webworms ruled out', NO_STRESS_LABEL],
    ['No signs of chinch or grubs', NO_STRESS_LABEL],
    ['Checked for chinch bugs and grubs; none found', NO_STRESS_LABEL],
    ['Grubs found and drought ruled out', 'grub activity'],
    ['Chinch bugs confirmed by float test', 'chinch bug activity'],
    // An unrelated negative observation after a confirmed cause must not negate
    // it, and ruling one cause out must not erase another observed condition.
    ['Chinch bugs confirmed by float test; no irrigation today', 'chinch bug activity'],
    ['No chinch bugs but weeds present', 'weed pressure'],
    ['Dollar spot confirmed. No pets on site today', 'dollar spot'],
    ['Checked for chinch bugs; none found, weeds present', 'weed pressure'],
    // Comma-joined segments: a generic condition is not a governed cause, so the
    // clause has to split on condition-bearing segments, not cause mentions.
    ['Chinch bugs confirmed, no weeds present', 'chinch bug activity'],
    ['No chinch bugs, weeds present', 'weed pressure'],
    // An answer-shaped clause that rules out a SECOND cause is not an answer to
    // the first; it has to stay independently scoped.
    ['Chinch bugs confirmed by float test; no signs of drought', 'chinch bug activity'],
    // A leading negation carries across or/nor but stops at a comma or "and".
    ['No chinch bugs or weeds present', NO_STRESS_LABEL],
    ['Checked for chinch bugs; none found and weeds present', 'weed pressure'],
    // "not confirmed" strips to nothing, so it names no condition and still
    // answers the clause before it rather than leaving that cause positive.
    ['Checked for chinch bugs; not confirmed', NO_STRESS_LABEL],
  ])('resolves cause polarity: %s', (text, label) => {
    const built = review(run({ findings: [] }), { addedDetails: [{ text }] });
    expect(built.added_details[0]).toMatchObject({
      finding_id: 'T1', name: text, label, confidence: 'moderate',
      source: 'technician', negated: label === NO_STRESS_LABEL,
    });
    if (label === NO_STRESS_LABEL) {
      expect(built.reconciliation.flags).toEqual([]);
      expect(built.reconciliation.watch_items).toEqual([]);
    } else {
      expect(built.reconciliation.flags[0]).toMatchObject({ finding_id: 'T1', finding: label });
      expect(built.reconciliation.watch_items[0]).toBe(`${label}: monitor response`);
    }
  });

  test('a note-only follow-up preserves rejection, rename and confirmed product mapping', () => {
    const initial = run({ findings: [finding(), finding({ finding_id: 'F2', name: 'Weeds', label: 'weed pressure' })] });
    const first = review(initial, {
      reviewedFindings: [{ finding_id: 'F1', keep: false }, { finding_id: 'F2', name: 'general lawn stress' }],
      appliedProducts: [{ product_name: 'Fixture application', addresses_findings: ['F2'] }],
    });
    const next = review({ ...initial, ...first }, { reviewedFindings: [{ finding_id: 'F1', tech_note: 'Rechecked' }] });
    expect(next.reviewed_findings[0]).toMatchObject({ keep: false, tech_note: 'Rechecked' });
    expect(next.reviewed_findings[1]).toMatchObject({ name: 'general lawn stress', label: 'general lawn stress', renamed: true, confidence: 'moderate' });
    expect(next.reconciliation.treatment_rationale[0]).toMatchObject({ addresses_findings: ['F2'] });
    expect(next.reconciliation.flags.every((flag) => flag.finding_id !== 'F1')).toBe(true);
  });

  test('a rename uses technician confidence; clearing it restores the stored model decision', () => {
    const initial = run({ findings: [finding({ confidence: 'low', label: 'general lawn stress' })] });
    const renamed = review(initial, { reviewedFindings: [{ finding_id: 'F1', name: 'grub activity' }] });
    expect(renamed.reviewed_findings[0]).toMatchObject({ confidence: 'moderate', label: 'grub activity', renamed: true });
    const cleared = review({ ...initial, ...renamed }, { reviewedFindings: [{ finding_id: 'F1', name: null }] });
    expect(cleared.reviewed_findings[0]).toMatchObject({ confidence: 'low', name: 'Chinch damage', label: 'general lawn stress', renamed: false });
    expect(cleared.reconciliation.watch_items.join(' ')).not.toMatch(/chinch|grub/i);
  });

  test('keeps raw evidence internal while public reconciliation uses labels and screened steps', () => {
    const initial = run({ findings: [finding({ name: 'Chinch near the gate code 4471', confirmation_step: 'Check the gate code 4471' })] });
    const built = review(initial, {
      addedDetails: [{ text: 'Chinch confirmed near the gate code 4471' }],
      appliedProducts: [{ product_name: 'Fixture application', addresses_findings: ['F1', 'T1'] }],
    });
    expect(built.reviewed_findings[0].name).toContain('4471');
    expect(built.added_details[0].name).toContain('4471');
    expect(JSON.stringify(built.reconciliation)).not.toMatch(/4471|gate code/i);
    expect(built.reconciliation.treatment_rationale[0].customer_explanation).toContain('chinch bug activity');
    expect(built.reconciliation.watch_items[0]).toBe('chinch bug activity: monitor response');
  });

  test.each(['Apply a pet-safe product', 'Check the treated area after it dries in 15 minutes', 'Confirm suspected chinch pressure'])(
    'withholds unsafe or unsupported confirmation instructions: %s', (confirmation_step) => {
      const built = review(run({ findings: [finding({ name: 'Unclear edge stress', label: 'general lawn stress', confidence: 'low', confirmation_step })] }));
      expect(built.reconciliation.watch_items[0]).toBe('general lawn stress: monitor response');
      expect(built.reviewed_findings[0].confirmation_step).toBe(confirmation_step);
    },
  );

  test('clearing technician details never reassigns their old product mappings to new evidence', () => {
    const initial = run({ findings: [] });
    const first = review(initial, {
      addedDetails: [{ text: 'Chinch confirmed' }],
      appliedProducts: [{ product_name: 'Fixture application', addresses_findings: ['T1'] }],
    });
    const cleared = review({ ...initial, ...first }, { addedDetails: [] });
    const next = review({ ...initial, ...cleared }, { addedDetails: [{ text: 'Grubs found' }] });
    expect(next.added_details[0].finding_id).toBe('T2');
    expect(next.reconciliation.technician_finding_high_water).toBe(2);
    expect(next.reconciliation.treatment_rationale[0].addresses_findings).toEqual([]);
    expect(next.reconciliation.flags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'untreated_condition', finding_id: 'T2' })]));
  });

  test('clean-lawn findings are retained for review and excluded from treatment claims', () => {
    const built = review(run({ findings: [finding({ name: 'Healthy turf', label: NO_STRESS_LABEL })] }), {
      appliedProducts: [{ product_name: 'Fixture preventive application', role: 'preventive', addresses_findings: ['F1'] }],
    });
    expect(built.reviewed_findings).toHaveLength(1);
    expect(built.reconciliation.treatment_rationale[0]).toMatchObject({ addresses_findings: [], application_class: 'preventive' });
    expect(built.reconciliation.flags.some((flag) => flag.finding_id === 'F1')).toBe(false);
    expect(built.reconciliation.watch_items.join(' ')).not.toContain(NO_STRESS_LABEL);
  });
});
