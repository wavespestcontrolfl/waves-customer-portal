'use strict';

const { CHECK_NAMES } = require('../services/content/editorial-review-contracts');
const { validatePlanJson, validateReviewJson } = require('../services/content/editorial-review-validation');

function validateClaim(passage, claim, sources = []) {
  const analysis = { claims: [{ id: 'C1', passage }], sections: [], passages: [] };
  const response = {
    claimInventoryComplete: true,
    checks: CHECK_NAMES.map((name) => ({ name, status: 'pass', findings: [] })),
    claims: [{ claimId: 'C1', passage, action: '', ...claim }],
    sectionCoverage: [],
    passageCoverage: [],
  };
  return validateReviewJson(response, analysis, passage, '', sources);
}

describe('editorial review coverage validation', () => {
  test.each([undefined, 'unknown'])('rejects a coverage status of %s', (status) => {
    const sections = [{ sectionIndex: 0, answer: 'Give a direct answer.' }];
    const response = { pass: true, findings: [], sectionCoverage: [{ sectionIndex: 0, status }] };
    expect(validatePlanJson(response, sections)).toBe('plan_coverage');
  });

  test('requires a finding for every failed plan section', () => {
    const sections = [{ sectionIndex: 0, answer: 'First answer.' }, { sectionIndex: 1, answer: 'Second answer.' }];
    const response = {
      pass: false,
      findings: [{ sectionIndex: 0, passage: 'First answer.', detail: 'Too vague.', action: 'Be specific.' }],
      sectionCoverage: [{ sectionIndex: 0, status: 'fail' }, { sectionIndex: 1, status: 'fail' }],
    };
    expect(validatePlanJson(response, sections)).toBe('plan_finding_missing');
  });

  test('allows numeric instructions to be classified as non-external', () => {
    const passage = 'Check 2 containers near your door.';
    expect(validateClaim(passage, { verdict: 'non_external', claimKind: 'non_external', sourceSuitability: 'not_applicable', sourceIndex: -1, sourceQuote: '' })).toBeNull();
  });

  test.each([
    'Dr. Example said, “Termites spread disease.”',
    'Termites cause $5 billion in property damage every year.',
  ])('rejects a deterministically external claim labeled non-external: %s', (passage) => {
    expect(validateClaim(passage, { verdict: 'non_external', claimKind: 'non_external', sourceSuitability: 'not_applicable', sourceIndex: -1, sourceQuote: '' }))
      .toBe('claim_kind_mismatch:C1');
  });

  const NON_EXTERNAL = { verdict: 'non_external', claimKind: 'non_external', sourceSuitability: 'not_applicable', sourceIndex: -1, sourceQuote: '' };

  // Every brief asks for a visible "Last updated: Month Year" line (content-brief-builder), so a review that
  // could not label it failed on every post (Mac test 2026-11-19: claim_kind_mismatch on C1).
  test.each([
    '*Last updated: November 2026.*',
    'Last updated: November 2026',
    '_Updated: March 2027._',
    '**Last updated:** November 2026',
    '**Last updated**: November 2026',
  ])('allows the date-stamp line as non-external: %s', (passage) => {
    expect(validateClaim(passage, NON_EXTERNAL)).toBeNull();
  });

  test.each([
    'Here is what EENY-514 says about the spray:',
    'UF/IFAS fact sheets ENH5 and LH010 cover St. Augustine grass.',
  ])('allows a UF/IFAS publication number that names a source: %s', (passage) => {
    expect(validateClaim(passage, NON_EXTERNAL)).toBeNull();
  });

  test.each([
    'Last updated: November 2026, when 40% of homes had roaches.',
    // Link text is held too: a linked figure can be the claim itself (pre-push audit on this PR).
    'Our [guide to the 8 cockroach types in Florida](/pest-control/cockroach-types/) covers the rest.',
    'Termites cause [$5 billion in damage](/termite-control/) annually.',
    'Read the [8 Florida species](//example.org/species) list.',
    'EENY-514 says the roach is 1.5 inches long.',
    '**Last updated:** November 2026. Most homes have roaches.',
    'Homes need a MERV-13 filter.',
    'Look for larvae that hatch in 3 days.',
    'Remove 2 ounces of bait from each station.',
    'Check 3 days later for new droppings.',
    'Check 2 traps, since 40% of roaches hide there.',
  ])('still rejects a figure outside those cases as non-external: %s', (passage) => {
    expect(validateClaim(passage, NON_EXTERNAL)).toBe('claim_kind_mismatch:C1');
  });

  test('does not reject an unsupported numeric claim over its kind label', () => {
    const passage = 'A [2023 UF/IFAS article](https://blogs.ifas.ufl.edu/news/2023/x/) gives one reason.';
    const analysis = { claims: [{ id: 'C1', passage }], sections: [], passages: [] };
    const response = {
      claimInventoryComplete: true,
      checks: CHECK_NAMES.map((name) => (name === 'source_support'
        ? { name, status: 'fail', findings: [{ passage, detail: 'No fetched source.', action: 'Add the source.', sourceIndexes: [], sourceQuote: '' }] }
        : { name, status: 'pass', findings: [] })),
      claims: [{ claimId: 'C1', passage, verdict: 'unsupported', claimKind: 'general', sourceSuitability: 'unsuitable', sourceIndex: -1, sourceQuote: '', action: 'Add the source.' }],
      sectionCoverage: [],
      passageCoverage: [],
    };
    expect(validateReviewJson(response, analysis, passage, '', [])).toBeNull();
  });

  test('holds a supported numeric claim labeled general to the primary-source rule', () => {
    const passage = 'Termites cause $5 billion in property damage every year.';
    const sources = [{ excerpt: 'Termites cause $5 billion in property damage every year in the US.' }];
    expect(validateClaim(passage, { verdict: 'supported', claimKind: 'general', sourceSuitability: 'suitable_secondary', sourceIndex: 0, sourceQuote: 'Termites cause $5 billion in property damage' }, sources))
      .toBe('claim_primary_source_required:C1');
  });

  const QUOTE = 'Adults spray a foul fluid, which the UF/IFAS gallery says is where the nickname "stinking cockroach" comes from.';
  test('accepts a supported attributed quote labeled general when it meets the quote rules', () => {
    const sources = [{ excerpt: 'It is often called the "stinking cockroach" because it produces a foul-smelling fluid.' }];
    expect(validateClaim(QUOTE, { verdict: 'supported', claimKind: 'general', sourceSuitability: 'primary_authoritative', sourceIndex: 0, sourceQuote: 'often called the "stinking cockroach" because' }, sources))
      .toBeNull();
  });

  test('holds a supported attributed quote labeled general to the word-for-word rule', () => {
    const sources = [{ excerpt: 'It is often called the stink roach because it produces a foul-smelling fluid.' }];
    expect(validateClaim(QUOTE, { verdict: 'supported', claimKind: 'general', sourceSuitability: 'primary_authoritative', sourceIndex: 0, sourceQuote: 'produces a foul-smelling fluid' }, sources))
      .toBe('claim_attribution_quote:C1');
  });

  test('detects an attributed quote of a document code before codes are set aside', () => {
    const passage = 'The bulletin called it “EENY-514”.';
    const sources = [{ excerpt: 'The bulletin covers the Florida woods cockroach in detail.' }];
    expect(validateClaim(passage, { verdict: 'supported', claimKind: 'general', sourceSuitability: 'primary_authoritative', sourceIndex: 0, sourceQuote: 'The bulletin covers the Florida woods' }, sources))
      .toBe('claim_attribution_quote:C1');
  });

  test('holds a supported claim to the rules of its own label too', () => {
    const passage = 'Roach bait in Florida homes works best in kitchens.';
    const sources = [{ excerpt: 'Roach bait in Florida homes works best in kitchens and baths.' }];
    expect(validateClaim(passage, { verdict: 'supported', claimKind: 'named_example', sourceSuitability: 'suitable_secondary', sourceIndex: 0, sourceQuote: 'Roach bait in Florida homes works best' }, sources))
      .toBe('claim_primary_source_required:C1');
  });

  test('rejects a trivial substring as a supporting source quote', () => {
    const passage = 'Termites cause $5 billion in property damage every year.';
    const sources = [{ excerpt: 'An unrelated sentence. Another unrelated sentence.' }];
    expect(validateClaim(passage, { verdict: 'supported', claimKind: 'quantitative', sourceSuitability: 'primary_authoritative', sourceIndex: 0, sourceQuote: '.' }, sources))
      .toBe('claim_quote:C1');
  });
});
