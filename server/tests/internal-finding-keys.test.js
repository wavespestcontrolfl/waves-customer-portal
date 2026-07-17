// The internal-key strip is the single guarantee behind three egress points
// (public /data payload, narrative prompt, report assistant) — codex P2 #2807
// flagged that filtering only the payload lets the narrative echo the fee, so
// the strip is centralized in project-types and applied at every boundary.
const {
  INTERNAL_FINDING_KEYS,
  stripInternalFindingKeys,
  redactFeeFromText,
  redactFeeCues,
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

describe('redactFeeFromText', () => {
  test('removes a currency-marked fee, keeps the rest of the narrative', () => {
    expect(redactFeeFromText('Inspection fee $250. Keep mulch back.', '$250'))
      .toBe('Inspection fee [fee removed]. Keep mulch back.');
  });
  test('extracts the amount past a label prefix', () => {
    expect(redactFeeFromText('The fee is $250 total.', 'Tier 2 — $250')).toContain('[fee removed]');
  });
  test('leaves an unrelated number that is not the fee alone', () => {
    expect(redactFeeFromText('Re-inspect within 175 days.', '250')).toBe('Re-inspect within 175 days.');
  });
  test('empty fee or clean text passes through', () => {
    expect(redactFeeFromText('Monitor stations quarterly.', '')).toBe('Monitor stations quarterly.');
    expect(redactFeeFromText('', '250')).toBe('');
  });
  test('does not corrupt a larger amount that only shares a prefix (250 vs 2500)', () => {
    expect(redactFeeFromText('Replacement treatment is $2500.', '$250')).toBe('Replacement treatment is $2500.');
    expect(redactFeeFromText('total 2500 today', '250')).toBe('total 2500 today');
  });
  test('parses a comma-grouped fee as one amount ($1,250 and bare 1,250)', () => {
    expect(redactFeeFromText('The fee is $1,250 total.', '1,250')).toContain('[fee removed]');
    expect(redactFeeFromText('Charge $1,250 applied.', '1250')).toContain('[fee removed]');
  });
  test('preserves narrative line breaks (sectioned reports keep their structure)', () => {
    const out = redactFeeFromText('WHAT WE DID\n\nInspection fee $250.\n\nWHAT WE FOUND\n\nClear.', '250');
    expect((out.match(/\n/g) || []).length).toBe(6);
    expect(out).toContain('[fee removed]');
  });
  test('redacts every value when several fees are given (live + archived differ)', () => {
    expect(redactFeeFromText('Old $250 and new $300 both.', ['$250', '$300']))
      .toBe('Old [fee removed] and new [fee removed] both.');
  });
});

describe('redactFeeFromText — round-4 edge cases', () => {
  test('removes a one-digit-cents fee whole ($250.5), not just the dollars', () => {
    expect(redactFeeFromText('Inspection fee $250.5 today.', '$250.5')).toBe('Inspection fee [fee removed] today.');
    expect(redactFeeFromText('Inspection fee $250.50 today.', '$250.50')).toBe('Inspection fee [fee removed] today.');
  });
  test('a smaller fee does not corrupt a larger comma-grouped amount', () => {
    expect(redactFeeFromText('Repair cost $1,250 estimate.', '250')).toBe('Repair cost $1,250 estimate.');
    expect(redactFeeFromText('Repair cost $1,250 estimate.', '$250')).toBe('Repair cost $1,250 estimate.');
  });
  test('the exact comma-grouped fee is still redacted', () => {
    expect(redactFeeFromText('Fee $1,250 charged.', '1,250')).toContain('[fee removed]');
  });
});

describe('redactFeeCues (value-independent; migration-only, gated to fee-bearing projects)', () => {
  test('removes a fee-cued currency amount regardless of value', () => {
    expect(redactFeeCues('Inspection fee $250. Keep mulch back.')).toBe('Inspection fee [fee removed]. Keep mulch back.');
    expect(redactFeeCues('Prior charge was $300.')).toContain('[fee removed]');
  });
  test('leaves prose with no fee-cued currency untouched', () => {
    expect(redactFeeCues('Monitor bait stations quarterly.')).toBe('Monitor bait stations quarterly.');
  });
  test('preserves line breaks', () => {
    const out = redactFeeCues('WHAT WE DID\n\nInspection fee $250.\n\nWHAT WE FOUND');
    expect((out.match(/\n/g) || []).length).toBe(4);
  });
});
