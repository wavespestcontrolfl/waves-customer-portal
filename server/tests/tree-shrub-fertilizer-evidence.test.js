// Tree & Shrub fertilizer evidence rules. Synthetic inputs only: the tests pin
// the NutriRoot 2-2-3 seasonal/jurisdiction decisions, the truthful
// already-applied exception, manual picker flags, and the protocol/outline
// version stamp.
const protocols = require('../config/protocols.json');
const { treeShrubProductFlags } = require('../services/tree-shrub-fast-context');
const {
  NUTRIROOT_SOIL_TEST_BASIS,
  NUTRIROOT_ALREADY_APPLIED_BASIS,
  NUTRIROOT_FIELD,
  NUTRIROOT_SOIL_TEST_REFERENCE_FIELD,
  nutriRootDecision,
  nutriRootHoldReason,
  validateNutriRootEvidence,
  nutriRootReviewFinding,
} = require('../services/tree-shrub-fertilizer-evidence');

const NUTRIROOT = 'Arborjet NUTRIROOT 1 gal';
const values = (basis, reference = '') => ({
  [NUTRIROOT_FIELD]: basis,
  ...(reference ? { [NUTRIROOT_SOIL_TEST_REFERENCE_FIELD]: reference } : {}),
});
const validate = (zone, serviceDate, basis, reference = '') => validateNutriRootEvidence(
  values(basis, reference),
  { zone, serviceDate, productNames: [NUTRIROOT] },
);

describe('NutriRoot jurisdiction and season policy', () => {
  test('August never becomes an ordinary Sarasota/Venice or Manatee application', () => {
    for (const zone of ['sarasota_venice', 'manatee_parrish']) {
      const decision = nutriRootDecision({ zone, serviceDate: '2026-08-15', basis: NUTRIROOT_SOIL_TEST_BASIS });
      expect(decision.state).toBe('held');
    }
    expect(nutriRootHoldReason({ zone: 'manatee_parrish', serviceDate: '2026-08-15' })).toMatch(/not allowed June 1 through September 30/);
  });

  test('ordinary November use stays held in Sarasota/Venice and North Port because all N is soluble', () => {
    for (const zone of ['sarasota_venice', 'north_port']) {
      const decision = nutriRootDecision({ zone, serviceDate: '2026-11-18', basis: NUTRIROOT_SOIL_TEST_BASIS });
      expect(decision.state).toBe('held');
      expect(decision.reason).toMatch(/all-soluble nitrogen.*50% slow-release/i);
    }
  });

  test('November Manatee needs both a documented P deficiency and a locatable report reference', () => {
    expect(validate('manatee_parrish', '2026-11-18', '', '').blocks[0].code)
      .toBe('tree_shrub_nutriroot_evidence_required');
    expect(validate('manatee_parrish', '2026-11-18', NUTRIROOT_SOIL_TEST_BASIS, '').blocks[0].code)
      .toBe('tree_shrub_nutriroot_soil_test_reference_required');
    expect(validate('manatee_parrish', '2026-11-18', NUTRIROOT_SOIL_TEST_BASIS, 'UF report 2026-10-14, customer file'))
      .toMatchObject({ blocks: [], warnings: [], decision: { state: 'eligible', soilTestReference: 'UF report 2026-10-14, customer file' } });
  });

  test('missing or invalid Manatee dates fail closed because the blackout cannot be decided', () => {
    for (const serviceDate of [null, '', 'not-a-date', '2026-02-30']) {
      expect(nutriRootDecision({ zone: 'manatee_parrish', serviceDate, basis: NUTRIROOT_SOIL_TEST_BASIS }).state).toBe('held');
      expect(nutriRootHoldReason({ zone: 'manatee_parrish', serviceDate })).toMatch(/Confirm the visit date/);
    }
  });

  test('unknown and restricted sites can preserve a truthful already-applied record only with office review', () => {
    for (const zone of ['other_unknown', 'sarasota_venice', 'north_port', 'manatee_parrish']) {
      const result = validate(zone, zone === 'manatee_parrish' ? '2026-08-15' : '2026-11-18', NUTRIROOT_ALREADY_APPLIED_BASIS);
      expect(result.blocks).toEqual([]);
      expect(result.warnings[0].code).toBe('tree_shrub_nutriroot_already_applied_review');
      const finding = nutriRootReviewFinding({ productName: NUTRIROOT, zone, serviceDate: '2026-11-18', basis: NUTRIROOT_ALREADY_APPLIED_BASIS });
      expect(finding.message).toMatch(/^Recorded\. The office will review:/);
    }
  });
});

describe('recommendation and picker coverage', () => {
  test('no month card recommends NutriRoot; the protocol records its real 2-2-3 all-soluble analysis and has a fresh version stamp', () => {
    expect(JSON.stringify(protocols.tree_shrub.visits)).not.toMatch(/nutriroot/i);
    expect(protocols.tree_shrub.notes.join('\n')).toMatch(/NutriRoot is a 2-2-3 liquid fertilizer.*nitrogen is all water-soluble/i);
    expect(protocols.tree_shrub.version).toBe('2026.11-tree-shrub-protocol-audit');
  });

  test('the manual picker exposes a hold instead of a disabled blackout tile, plus the one eligible Manatee path', () => {
    const row = { name: NUTRIROOT, category: 'fertilizer' };
    const august = treeShrubProductFlags(row, { serviceDate: '2026-08-15', zone: 'manatee_parrish' });
    expect(august).toMatchObject({ nutriRoot: true, npBlackout: false, nutriRootSoilTestEligible: false });
    expect(august.nutriRootHoldReason).toMatch(/not allowed/);
    const november = treeShrubProductFlags(row, { serviceDate: '2026-11-18', zone: 'manatee_parrish' });
    expect(november).toMatchObject({ nutriRoot: true, npBlackout: false, nutriRootSoilTestEligible: true });
    expect(november.nutriRootHoldReason).toMatch(/soil test documenting phosphorus-deficient soil/);
  });
});
