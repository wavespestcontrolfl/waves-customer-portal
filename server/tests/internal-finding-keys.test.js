// The internal-key strip is the single guarantee behind three egress points
// (public /data payload, narrative prompt, report assistant) — codex P2 #2807
// flagged that filtering only the payload lets the narrative echo the fee, so
// the strip is centralized in project-types and applied at every boundary.
const {
  INTERNAL_FINDING_KEYS,
  stripInternalFindingKeys,
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
