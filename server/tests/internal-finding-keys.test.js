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

  test('redacts fee cues inside free-text finding VALUES (WDO comments path)', () => {
    expect(stripInternalFindingKeys({
      comments: 'Buyer to pay at closing. Inspection fee $250 collected on site.',
      wdo_finding: 'No visible signs of WDO observed',
    })).toEqual({
      comments: 'Buyer to pay at closing. Inspection fee [fee removed] collected on site.',
      wdo_finding: 'No visible signs of WDO observed',
    });
  });

  test('walks nested values so structure cannot smuggle the fee through', () => {
    expect(stripInternalFindingKeys({
      areas: ['Attic clear', 'Inspection fee $95 noted'],
      details: { note: 'inspection fee due: $250' },
    })).toEqual({
      areas: ['Attic clear', 'Inspection fee [fee removed] noted'],
      details: { note: 'inspection fee due: [fee removed]' },
    });
  });
});

describe('redactInspectionFeeCues', () => {
  test('removes inspection-fee language + amount, keeps a legitimate estimate', () => {
    expect(redactInspectionFeeCues('Inspection fee $250. Repair cost $1,250 for the sill plate.'))
      .toBe('Inspection fee [fee removed]. Repair cost $1,250 for the sill plate.');
  });
  test('requires the literal "inspection fee" phrase — never a bare or generic fee', () => {
    expect(redactInspectionFeeCues('The inspection fee is $250 today.')).toBe('The inspection fee is [fee removed] today.');
    expect(redactInspectionFeeCues('The fee is $250 today.')).toBe('The fee is $250 today.');
    expect(redactInspectionFeeCues('Repair fee $1,250.')).toBe('Repair fee $1,250.');
    expect(redactInspectionFeeCues('Permit fee is $125.')).toBe('Permit fee is $125.');
    expect(redactInspectionFeeCues('Treatment fee for the follow-up is $90.')).toBe('Treatment fee for the follow-up is $90.');
    expect(redactInspectionFeeCues('Repair cost $1,250.')).toBe('Repair cost $1,250.');
  });
  test('catches a stale fee via language, regardless of the current value', () => {
    expect(redactInspectionFeeCues('Inspection fee $250 quoted earlier.')).toContain('[fee removed]');
  });
  test('reaches across a long bridging clause — no fixed character window', () => {
    expect(redactInspectionFeeCues('The inspection fee is due at time of service: $250'))
      .toBe('The inspection fee is due at time of service: [fee removed]');
  });
  test('a waived/paid fee never swallows a later unrelated amount', () => {
    expect(redactInspectionFeeCues('Inspection fee waived; repair $1,250.'))
      .toBe('Inspection fee waived; repair $1,250.');
    expect(redactInspectionFeeCues('Inspection fee waived, repair estimate $1,250.'))
      .toBe('Inspection fee waived, repair estimate $1,250.');
    expect(redactInspectionFeeCues('Inspection fee paid, balance $400 due at close.'))
      .toBe('Inspection fee paid, balance $400 due at close.');
  });
  test('a new money subject ends the cue reach', () => {
    expect(redactInspectionFeeCues('Inspection fee noted, treatment estimate $900.'))
      .toBe('Inspection fee noted, treatment estimate $900.');
    expect(redactInspectionFeeCues('Inspection fee applies; permit $125 billed separately.'))
      .toBe('Inspection fee applies; permit $125 billed separately.');
  });
  test('leaves fee-free prose and preserves line breaks', () => {
    expect(redactInspectionFeeCues('Monitor bait stations quarterly.')).toBe('Monitor bait stations quarterly.');
    const out = redactInspectionFeeCues('WHAT WE DID\n\nInspection fee $250.\n\nWHAT WE FOUND');
    expect((out.match(/\n/g) || []).length).toBe(4);
  });
});
