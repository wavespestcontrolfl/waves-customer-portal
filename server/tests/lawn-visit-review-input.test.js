const { validateReview, mergedReviewInputs, technicianFindingIds, storedTechnicianHighWater } = require('../services/lawn-visit-review-input');

const run = {
  findings: JSON.stringify([{ finding_id: 'F1' }, { finding_id: 'F2' }]),
  reviewed_findings: JSON.stringify([
    { finding_id: 'F1', name: 'Raw edge symptom', label: 'thinning turf', keep: true, renamed: false },
    { finding_id: 'F2', name: 'weed pressure', label: 'weed pressure', keep: false, renamed: true, tech_note: 'not enough evidence' },
  ]),
  added_details: JSON.stringify([{ finding_id: 'T1', name: 'Dog run', zone: 'back' }]),
  reconciliation: JSON.stringify({ products: [{ product_name: 'Bifen I/T', addresses_findings: ['T1'] }], technician_finding_high_water: 1 }),
};
const review = (body, source = run) => {
  const parsed = validateReview(body, source);
  expect(parsed.errors).toEqual([]);
  return mergedReviewInputs(source, parsed.review);
};

test('a score-only confirm is not a review; explicit empty lists still represent review intent', () => {
  expect(validateReview({ adjustedScores: { turf_density: 80 } }, run).review)
    .toEqual({ provided: false, sent: { reviewedFindings: false, addedDetails: false, appliedProducts: false }, reviewedFindings: [], addedDetails: [], appliedProducts: [] });
  expect(validateReview(undefined, run).review.provided).toBe(false);
  expect(validateReview({ appliedProducts: [] }, run).review.provided).toBe(true);
  expect(validateReview({ reviewedFindings: [] }, run).review.provided).toBe(true);
});

test('partial lists preserve prior decisions, details, products and genuine rename intent', () => {
  const merged = review({ appliedProducts: [{ product_name: ' Celsius ', addresses_findings: [' F1 ', 'F1'] }] });
  expect(merged.reviewedFindings).toEqual([
    { finding_id: 'F1', keep: true, name: null, tech_note: null },
    { finding_id: 'F2', keep: false, name: 'weed pressure', tech_note: 'not enough evidence' },
  ]);
  expect(merged.addedDetails).toEqual([{ finding_id: 'T1', text: 'Dog run', zone: 'back' }]);
  expect(merged.appliedProducts).toEqual([{ product_id: null, product_name: 'Celsius', addresses_findings: ['F1'], role: null }]);
  expect(review({}).appliedProducts[0].product_name).toBe('Bifen I/T');
  expect(review({ addedDetails: [] }).addedDetails).toEqual([]);
  expect(review({ appliedProducts: [] }).appliedProducts).toEqual([]);
  expect(review({ reviewedFindings: [] }).reviewedFindings[1].keep).toBe(false);
});

test('changing one field of a rejected/renamed finding preserves the other decisions; explicit clears work', () => {
  const noteOnly = review({ reviewedFindings: [{ finding_id: 'F2', tech_note: 'follow up next visit' }] });
  expect(noteOnly.reviewedFindings[1]).toEqual({ finding_id: 'F2', keep: false, name: 'weed pressure', tech_note: 'follow up next visit' });
  expect(noteOnly.reviewedFindings[0]).toEqual({ finding_id: 'F1', keep: true, name: null, tech_note: null });
  const keepOnly = review({ reviewedFindings: [{ finding_id: 'F2', keep: true }] });
  expect(keepOnly.reviewedFindings[1]).toMatchObject({ keep: true, name: 'weed pressure', tech_note: 'not enough evidence' });
  expect(review({ reviewedFindings: [{ finding_id: 'F2', name: null, tech_note: '' }] }).reviewedFindings[1])
    .toEqual({ finding_id: 'F2', keep: false, name: null, tech_note: null });
});

test('a first review retains only supplied intent and normalizes technician text and zones', () => {
  const first = review({
    reviewedFindings: [{ finding_id: 'F1', name: 'weed pressure', tech_note: ' sedge along the walk ' }],
    addedDetails: [{ text: ' Float test confirmed insects ', zone: 'Front', finding_id: 'T99' }],
  }, { findings: run.findings });
  expect(first.reviewedFindings).toEqual([{ finding_id: 'F1', name: 'weed pressure', tech_note: 'sedge along the walk' }]);
  expect(first.addedDetails).toEqual([{ text: 'Float test confirmed insects', zone: 'front' }]);
  expect(first.appliedProducts).toEqual([]);
});

test('rejects unknown/duplicate IDs, free-text renames, oversized notes and malformed product references', () => {
  const { errors } = validateReview({
    reviewedFindings: [{ finding_id: 'F9' }, { finding_id: 'F1', name: 'Definitely chinch bugs', keep: 'yes', tech_note: 'x'.repeat(501) }, { finding_id: 'F1' }],
    addedDetails: [{ text: '' }, { text: 'valid', zone: 'roof' }],
    appliedProducts: [{ product_name: '' }, { product_name: 'Celsius', addresses_findings: 'F1' }, { product_name: 'Bifen', addresses_findings: [1] }],
  }, run);
  for (const field of ['reviewedFindings[0].finding_id', 'reviewedFindings[1].name', 'reviewedFindings[1].keep', 'reviewedFindings[1].tech_note', 'reviewedFindings[2].finding_id', 'addedDetails[0].text', 'addedDetails[1].zone', 'appliedProducts[0].product_name', 'appliedProducts[1].addresses_findings', 'appliedProducts[2].addresses_findings']) {
    expect(errors.some((error) => error.startsWith(field))).toBe(true);
  }
});

test.each(['reviewedFindings', 'addedDetails', 'appliedProducts'])('enforces the %s container and size bound', (field) => {
  const limit = { reviewedFindings: 50, addedDetails: 10, appliedProducts: 25 }[field];
  expect(validateReview({ [field]: 'wrong' }, run).errors[0]).toMatch(/must be an array/);
  expect(validateReview({ [field]: Array.from({ length: limit + 1 }, () => ({})) }, run).errors[0]).toContain(`at most ${limit}`);
  expect(validateReview({ [field]: [null, []] }, run).errors).toHaveLength(2);
});

test('keeps technician IDs when identical details reorder by zone, then matches text without a zone', () => {
  const stored = [{ finding_id: 'T1', name: 'Dog run', zone: 'front' }, { finding_id: 'T2', name: 'Dog run', zone: 'back' }];
  expect(technicianFindingIds([{ text: 'dog run', zone: 'back' }, { text: 'Dog run', zone: 'front' }], stored, 2)).toEqual({ ids: ['T2', 'T1'], highWater: 2 });
  expect(technicianFindingIds([{ text: 'DOG RUN' }], stored, 2)).toEqual({ ids: ['T1'], highWater: 2 });
  expect(technicianFindingIds([{ text: 'Dog run' }, { text: 'Dog run' }, { text: 'Dog run' }], stored, 2)).toEqual({ ids: ['T1', 'T2', 'T3'], highWater: 3 });
});

test('clearing all details never reuses an ID still referenced by a retained product', () => {
  const stored = { technician_finding_high_water: 7, products: [{ addresses_findings: ['T2', 'F1'] }] };
  const cleared = technicianFindingIds([], [], storedTechnicianHighWater(stored));
  expect(cleared).toEqual({ ids: [], highWater: 7 });
  expect(technicianFindingIds([{ text: 'A new unrelated detail' }], [], cleared.highWater)).toEqual({ ids: ['T8'], highWater: 8 });
  expect(storedTechnicianHighWater({ products: [{ addresses_findings: ['T12', 'F3'] }] })).toBe(12);
});

test('unsafe numeric references cannot produce duplicate or nonnumeric technician IDs', () => {
  expect(storedTechnicianHighWater({ technician_finding_high_water: Infinity, products: [{ addresses_findings: ['T99999999999999999999', 'T3'] }] })).toBe(3);
  expect(technicianFindingIds([{ text: 'one' }, { text: 'two' }], [], 3)).toEqual({ ids: ['T4', 'T5'], highWater: 5 });
  expect(() => technicianFindingIds([{ text: 'new' }], [], Number.MAX_SAFE_INTEGER)).toThrow(/exhausted/);
});
