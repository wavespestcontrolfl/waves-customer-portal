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

test('products may only address IDs this run issued, so invented ids cannot poison the high-water mark', () => {
  // Model findings (F1/F2) and persisted technician details (T1) are addressable.
  expect(validateReview({ appliedProducts: [{ product_name: 'Celsius', addresses_findings: ['F2', 'T1'] }] }, run).errors).toEqual([]);

  // A typo or client-invented id is rejected outright rather than silently
  // dropped by buildTreatmentRationale as an unmapped treatment.
  const invented = validateReview({ appliedProducts: [{ product_name: 'Celsius', addresses_findings: ['F1', 'T999'] }] }, run);
  expect(invented.errors).toEqual(['appliedProducts[0].addresses_findings is not a finding of this run: T999']);
  expect(invented.review.appliedProducts).toEqual([]);

  // The exhaustion case: T<MAX_SAFE_INTEGER> is a safe integer, so before this
  // guard it raised the high-water mark to the ceiling and every later detail
  // threw 'Technician finding IDs exhausted'.
  const ceiling = `T${Number.MAX_SAFE_INTEGER}`;
  expect(validateReview({ appliedProducts: [{ product_name: 'Bifen', addresses_findings: [ceiling] }] }, run).errors)
    .toEqual([`appliedProducts[0].addresses_findings is not a finding of this run: ${ceiling}`]);
  expect(storedTechnicianHighWater({ products: [{ addresses_findings: [ceiling] }] })).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => technicianFindingIds([{ text: 'New detail', zone: null }], [], Number.MAX_SAFE_INTEGER))
    .toThrow('Technician finding IDs exhausted');

  // A run with no persisted details has no addressable technician ids at all.
  expect(validateReview({ appliedProducts: [{ product_name: 'Celsius', addresses_findings: ['T1'] }] }, { findings: run.findings }).errors)
    .toEqual(['appliedProducts[0].addresses_findings is not a finding of this run: T1']);
});

test('a product may map to a detail added in the same review, but a poisoned reference cannot widen the range that accepts it', () => {
  const fresh = { findings: JSON.stringify([{ finding_id: 'F1' }]) };

  // The IDs are assigned server-side during this same call, so mapping a product
  // onto T1/T2 while sending two details is the ordinary technician flow.
  expect(validateReview({
    addedDetails: [{ text: 'Chinch confirmed' }, { text: 'Dog run' }],
    appliedProducts: [{ product_name: 'Bifen', addresses_findings: ['F1', 'T1', 'T2'] }],
  }, fresh).errors).toEqual([]);

  // One detail can only issue one ID, so T2 is past what this review can reach.
  expect(validateReview({
    addedDetails: [{ text: 'Chinch confirmed' }],
    appliedProducts: [{ product_name: 'Bifen', addresses_findings: ['T2'] }],
  }, fresh).errors).toEqual(['appliedProducts[0].addresses_findings is not a finding of this run: T2']);

  // The ceiling is read from the persisted mark and stored detail IDs only. A
  // stored product already carrying an invented reference must not raise it.
  const poisoned = {
    findings: JSON.stringify([{ finding_id: 'F1' }]),
    added_details: JSON.stringify([{ finding_id: 'T1', name: 'Dog run' }]),
    reconciliation: JSON.stringify({ products: [{ addresses_findings: ['T900'] }], technician_finding_high_water: 1 }),
  };
  expect(validateReview({ appliedProducts: [{ product_name: 'Bifen', addresses_findings: ['T900'] }] }, poisoned).errors)
    .toEqual(['appliedProducts[0].addresses_findings is not a finding of this run: T900']);
  expect(validateReview({ appliedProducts: [{ product_name: 'Bifen', addresses_findings: ['T1'] }] }, poisoned).errors).toEqual([]);
});

test('references are checked against the IDs the allocator actually assigns, not an upper bound', () => {
  const stored = {
    findings: JSON.stringify([{ finding_id: 'F1' }]),
    added_details: JSON.stringify([{ finding_id: 'T1', name: 'Grubs found' }]),
    reconciliation: JSON.stringify({ products: [], technician_finding_high_water: 1 }),
  };
  // Resubmitting an unchanged detail keeps its stored T1, so T2 is never
  // assigned: an upper bound of "one new ID per detail sent" would have let a
  // product point at a detail that does not exist and report it as untreated.
  expect(validateReview({
    addedDetails: [{ text: 'Grubs found' }],
    appliedProducts: [{ product_name: 'Bifen', addresses_findings: ['T2'] }],
  }, stored).errors).toEqual(['appliedProducts[0].addresses_findings is not a finding of this run: T2']);

  expect(validateReview({
    addedDetails: [{ text: 'Grubs found' }],
    appliedProducts: [{ product_name: 'Bifen', addresses_findings: ['T1'] }],
  }, stored).errors).toEqual([]);

  // A genuinely new detail does allocate the next ID, so T2 is addressable.
  expect(validateReview({
    addedDetails: [{ text: 'Grubs found' }, { text: 'Dog run' }],
    appliedProducts: [{ product_name: 'Bifen', addresses_findings: ['T1', 'T2'] }],
  }, stored).errors).toEqual([]);
});
