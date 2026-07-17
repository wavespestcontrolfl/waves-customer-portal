// The internal-key strip is the single guarantee behind three egress points
// (public /data payload, narrative prompt, report assistant) — codex P2 #2807
// flagged that filtering only the payload lets the narrative echo the fee, so
// the strip is centralized in project-types and applied at every boundary.
const {
  INTERNAL_FINDING_KEYS,
  stripInternalFindingKeys,
  redactInspectionFeeCues,
} = require('../services/project-types');

describe('stripInternalFindingKeys', () => {
  test('inspection_fee is an internal key', () => {
    expect(INTERNAL_FINDING_KEYS).toContain('inspection_fee');
  });

  test('drops internal keys, keeps customer-facing ones', () => {
    expect(stripInternalFindingKeys({
      wdo_finding: 'No visible signs of WDO observed',
      inspection_fee: 'Tier 2 — $250',
    })).toEqual({ wdo_finding: 'No visible signs of WDO observed' });
  });

  test('parses a JSON string and strips', () => {
    expect(stripInternalFindingKeys('{"a":"1","inspection_fee":"$250"}')).toEqual({ a: '1' });
  });

  test('null / non-object inputs pass through without throwing', () => {
    expect(stripInternalFindingKeys(null)).toBeNull();
    expect(stripInternalFindingKeys(undefined)).toBeUndefined();
    expect(stripInternalFindingKeys('not json')).toEqual({});
  });
});

describe('redactInspectionFeeCues', () => {
  test('removes inspection-fee language + amount, keeps a legitimate estimate', () => {
    expect(redactInspectionFeeCues('Inspection fee $250. Repair cost $1,250 for the sill plate.'))
      .toBe('Inspection fee [fee removed]. Repair cost $1,250 for the sill plate.');
  });
  test('matches "the fee is $250" but never a generic cost/price/charge', () => {
    expect(redactInspectionFeeCues('The fee is $250 today.')).toBe('The fee is [fee removed] today.');
    expect(redactInspectionFeeCues('Repair cost $1,250.')).toBe('Repair cost $1,250.');
    expect(redactInspectionFeeCues('Estimated charge $900.')).toBe('Estimated charge $900.');
  });
  test('catches a stale fee via language, regardless of the current value', () => {
    expect(redactInspectionFeeCues('Inspection fee $250 quoted earlier.')).toContain('[fee removed]');
  });
  test('leaves fee-free prose and preserves line breaks', () => {
    expect(redactInspectionFeeCues('Monitor bait stations quarterly.')).toBe('Monitor bait stations quarterly.');
    const out = redactInspectionFeeCues('WHAT WE DID\n\nInspection fee $250.\n\nWHAT WE FOUND');
    expect((out.match(/\n/g) || []).length).toBe(4);
  });
});
